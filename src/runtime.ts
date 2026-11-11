import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { Store } from "./storage/store.js";
import { Vault, hash } from "./storage/security.js";
import { ClawdTime } from "./attention/service.js";
import {
  NativeTransport,
  type NativeTransportConfig,
} from "./transport/native.js";
import type { NativeMessage } from "./transport/native-messages.js";
import { SimulationTransport } from "./transport/simulation.js";
import { ControlCoordinator, SimulatedDevice } from "./control/coordinator.js";
import { HumanRouter } from "./control/human-router.js";
import { Viewing } from "./control/viewing.js";
import { MediaDevicePort } from "../media/device-port.js";
import { configuredPlanner } from "./control/planner.js";
import { createApp } from "./app.js";
import type { AttentionRequest, Pairing } from "./contracts.js";

interface Tester {
  memberId: string;
  recipient: string;
  deviceId: string;
  displayId: string;
}
interface LiveConfig extends NativeTransportConfig {
  testers: Tester[];
}
interface Inbound {
  id: string;
  sealed: string;
  state: "pending" | "running" | "done" | "unknown";
}
interface Notice {
  id: string;
  pairing: Pairing;
  sealed: string;
  state: "pending" | "running" | "done" | "unknown";
}
function privateJSON<T>(path: string): T {
  const st = statSync(path);
  if (!st.isFile() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.())
    throw new Error("Live configuration must be an owner-only regular file.");
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
export function createRuntime(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.CLAWDTIME_MODE ?? "simulation";
  if (!["simulation", "standby", "live"].includes(mode))
    throw new Error("Unknown CLAWDTIME_MODE.");
  const live = mode === "live";
  if (
    live &&
    (env.CLAWDTIME_LIVE_TRAFFIC !== "true" || !env.CLAWDTIME_LIVE_CONFIG)
  )
    throw new Error(
      "Live mode requires an explicit handoff configuration and live traffic gate.",
    );
  const origin = env.CLAWDTIME_ORIGIN ?? "http://127.0.0.1:3310";
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    !(url.protocol === "https:" || (!live && url.hostname === "127.0.0.1"))
  )
    throw new Error(
      "Use a fixed HTTPS origin for live or loopback for simulation.",
    );
  if (
    live &&
    (!env.CLAWDTIME_OPERATOR_TOKEN ||
      !env.CLAWDTIME_MEDIA_TOKEN ||
      env.CLAWDTIME_OPERATOR_TOKEN === env.CLAWDTIME_MEDIA_TOKEN)
  )
    throw new Error("Independent operator and media credentials required.");
  const store = new Store(env.CLAWDTIME_DATABASE ?? ".data/clawdtime.sqlite");
  const config =
    mode !== "simulation" && env.CLAWDTIME_LIVE_CONFIG
      ? privateJSON<LiveConfig>(env.CLAWDTIME_LIVE_CONFIG)
      : undefined;
  if (
    !config &&
    store.all<{ state: string }>("media").some((m) => m.state !== "closed")
  )
    throw new Error(
      "Owned live calls require their protected configuration for standby cleanup.",
    );
  if (config) {
    z.array(
      z.object({
        memberId: z.string().min(1),
        recipient: z.string().regex(/^\+[1-9]\d{7,14}$/),
        deviceId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
        displayId: z.string().regex(/^\d+$/),
      }),
    )
      .min(1)
      .parse(config.testers);
    if (
      config.testers.some((t) => !config.testerAllowlist.includes(t.recipient))
    )
      throw new Error("Every tester must be explicitly allowlisted.");
  }
  const transport = config
    ? new NativeTransport(store, config)
    : new SimulationTransport();
  const service = new ClawdTime(store, transport);
  const device = config
    ? new MediaDevicePort(config.mediaOrigin, config.mediaKey)
    : new SimulatedDevice();
  const control = new ControlCoordinator(store, device),
    viewing = new Viewing(store, device);
  const human = new HumanRouter(
    service,
    control,
    device instanceof MediaDevicePort
      ? configuredPlanner(device, env)
      : undefined,
  );
  const app = createApp(service, control, human, {
    origin,
    operatorToken: env.CLAWDTIME_OPERATOR_TOKEN,
    mediaToken: env.CLAWDTIME_MEDIA_TOKEN,
    simulation: mode === "simulation",
    dispatchEnabled: mode !== "standby",
  });
  const vault = config ? new Vault(config.encryptionKey) : undefined;
  for (const n of store.all<Notice>("notice"))
    if (n.state === "running") store.put("notice", { ...n, state: "unknown" });
  for (const n of store.all<Inbound>("inbound"))
    if (n.state === "running") store.put("inbound", { ...n, state: "unknown" });
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      service.expireSessions();
      if (live && transport instanceof NativeTransport && config && vault) {
        if (!transport.messages.cursor())
          await transport.messages.baseline(
            config.handoff.baseline.sequence,
            config.handoff.baseline.eventId,
          );
        // Commit encrypted inbound and cursor atomically. Async effects run afterward.
        await transport.messages.poll((event) => {
          if (!config.testers.some((t) => t.recipient === event.sender)) return;
          if (!store.get("inbound", event.id))
            store.put<Inbound>("inbound", {
              id: event.id,
              sealed: vault.seal(event),
              state: "pending",
            });
        });
        for (const item of store
          .all<Inbound>("inbound")
          .filter((i) => i.state === "pending")) {
          const event = vault.open<NativeMessage>(item.sealed),
            tester = config.testers.find((t) => t.recipient === event.sender)!;
          store.put("inbound", { ...item, state: "running" });
          let reply: string;
          try {
            const pairing = store
              .all<Pairing>("pairing")
              .find(
                (p) =>
                  p.memberId === tester.memberId &&
                  p.recipient === event.sender &&
                  p.conversationId === event.conversationId &&
                  p.lineId === event.lineId &&
                  p.revokedAt === undefined,
              );
            if (!pairing || /^pair$/i.test(event.text.trim())) {
              const invite = service.createPairingInvite({
                ...tester,
                lineId: event.lineId,
                conversationId: event.conversationId,
              });
              reply = `Install and pair your Mac: ${origin}/pair#token=${encodeURIComponent(invite.token)}&device=${encodeURIComponent(tester.deviceId)}&display=${encodeURIComponent(tester.displayId)} . This private link expires in 10 minutes.`;
            } else {
              const pending = store
                .all<AttentionRequest>("attention")
                .filter(
                  (r) =>
                    r.pairingId === pairing.id &&
                    ["ringing", "connected", "awaiting_input"].includes(
                      r.state,
                    ),
                );
              if (pending.length !== 1)
                reply =
                  "There is no single pending agent request. Start an attention request from your connected coding agent. Starting general work from Messages is planned.";
              else {
                const result = (await human.receive({
                  eventId: event.id,
                  requestId: pending[0]!.id,
                  memberId: pairing.memberId,
                  lineId: event.lineId,
                  conversationId: event.conversationId,
                  channel: "text",
                  text: event.text,
                })) as {
                  accepted?: boolean;
                  clarification?: string;
                  stopped?: boolean;
                  receipt?: unknown;
                };
                reply = result.accepted
                  ? result.stopped
                    ? "Screen control stopped."
                    : result.receipt
                      ? "Input submitted; a subsequent screen frame was observed. Send answer: when ready for the agent to continue."
                      : "Your response is available to the exact waiting agent session."
                  : (result.clarification ?? "Please clarify your response.");
              }
            }
            const destination: Pairing = pairing ?? {
              id: `onboarding_${hash(tester.memberId).slice(0, 24)}`,
              ...tester,
              conversationId: event.conversationId,
              lineId: event.lineId,
              createdAt: Date.now(),
              allowView: false,
              allowControl: false,
            };
            store.transaction(() => {
              store.put<Notice>("notice", {
                id: `${event.id}:notice`,
                pairing: destination,
                sealed: vault.seal(reply),
                state: "pending",
              });
              store.put("inbound", { ...item, state: "done" });
            });
          } catch {
            store.put("inbound", { ...item, state: "unknown" });
          }
        }
        for (const n of store
          .all<Notice>("notice")
          .filter((n) => n.state === "pending")) {
          store.put("notice", { ...n, state: "running" });
          try {
            await transport.message(
              n.pairing,
              vault.open<string>(n.sealed),
              n.id,
            );
            store.put("notice", { ...n, state: "done" });
          } catch {
            store.put("notice", { ...n, state: "unknown" });
          }
        }
      }
      if (mode === "standby") {
        for (const r of store.all<AttentionRequest>("attention"))
          if (
            ![
              "completed",
              "declined",
              "unanswered",
              "canceled",
              "expired",
              "disconnected",
              "failed",
              "unknown",
            ].includes(r.state)
          )
            service.failCall(r.id);
        await service.drain({ cleanupOnly: true });
      } else await service.drain();
      if (transport instanceof NativeTransport)
        await transport.pollCalls((id, state, qualified) =>
          service.observeCall(id, state, qualified),
        );
      await viewing.tick();
      store.saveState("heartbeat", { ok: true, at: Date.now() });
    } catch {
      // A broken inbound feed must never prevent expiration or owned-call cleanup.
      try {
        await service.drain({ cleanupOnly: true });
      } catch {
        /* retained unknown effect */
      }
      if (transport instanceof NativeTransport)
        try {
          await transport.pollCalls((id, state, qualified) =>
            service.observeCall(id, state, qualified),
          );
        } catch {
          /* retain native reservation */
        }
      try {
        await viewing.tick();
      } catch {
        /* helper expiry remains authoritative */
      }
      store.saveState("heartbeat", {
        ok: false,
        at: Date.now(),
        reason:
          "Integration failed; inspect private scoped state. No unknown effect was retried.",
      });
    } finally {
      ticking = false;
    }
  }
  return { app, store, service, control, human, transport, tick };
}
