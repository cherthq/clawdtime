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
function parseProtectedJSON<T>(value: string): T {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Configuration must be an object.");
    return parsed as T;
  } catch {
    throw new Error(
      "Protected configuration must be a valid JSON object; its contents were withheld.",
    );
  }
}
function privateJSON<T>(path: string): T {
  const st = statSync(path);
  if (!st.isFile() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.())
    throw new Error("Live configuration must be an owner-only regular file.");
  return parseProtectedJSON<T>(readFileSync(path, "utf8"));
}
export function createRuntime(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.CLAWDTIME_MODE ?? "simulation";
  if (!["simulation", "standby", "live"].includes(mode))
    throw new Error("Unknown CLAWDTIME_MODE.");
  const live = mode === "live";
  if (env.CLAWDTIME_LIVE_CONFIG && env.CLAWDTIME_LIVE_CONFIG_JSON)
    throw new Error("Choose one protected live configuration source.");
  const hasConfig = !!(
    env.CLAWDTIME_LIVE_CONFIG || env.CLAWDTIME_LIVE_CONFIG_JSON
  );
  if (live && (env.CLAWDTIME_LIVE_TRAFFIC !== "true" || !hasConfig))
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
    mode !== "simulation" && hasConfig
      ? env.CLAWDTIME_LIVE_CONFIG
        ? privateJSON<LiveConfig>(env.CLAWDTIME_LIVE_CONFIG)
        : parseProtectedJSON<LiveConfig>(env.CLAWDTIME_LIVE_CONFIG_JSON!)
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
  store.saveState("runtime:mode", mode);
  if (transport instanceof NativeTransport)
    store.saveState(
      "native-binding-fingerprint",
      transport.bindingFingerprint(),
    );
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
  let stopping = false;
  let finishTick: (() => void) | undefined;
  let checkedReadinessAt = 0;
  async function tick() {
    if (ticking || stopping) return;
    ticking = true;
    try {
      service.expireSessions();
      if (live && transport instanceof NativeTransport && config && vault) {
        if (!transport.messages.cursor())
          await transport.messages.baseline(
            config.handoff.baseline.sequence,
            config.handoff.baseline.eventId,
          );
        if (Date.now() - checkedReadinessAt >= 10_000) {
          await transport.preflight();
          for (const pairing of store.all<Pairing>("pairing"))
            if (pairing.revokedAt === undefined)
              await transport.preflightDevice(pairing);
          checkedReadinessAt = Date.now();
        }
        const report = store.state<{
          checks: { id: string; status: string }[];
        }>("native-preflight");
        const ownershipChecks = [
          "live_gate",
          "native_configuration",
          "service_configuration",
          "line_handoff",
          "handoff_boundary",
          "native_identity",
          "native_cursor",
          "logical_identity",
          "line_occupancy",
        ];
        if (
          !report ||
          ownershipChecks.some(
            (id) =>
              !report.checks.some((c) => c.id === id && c.status === "pass"),
          )
        )
          throw new Error(
            "Inbound polling requires verified exclusive ownership and an exact retained boundary.",
          );
        if (stopping) return;
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
        if (stopping) return;
        for (const item of store
          .all<Inbound>("inbound")
          .filter((i) => i.state === "pending")) {
          if (stopping) break;
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
      if (stopping) return;
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
        await service.drain({ cleanupOnly: true, shouldStop: () => stopping });
      } else await service.drain({ shouldStop: () => stopping });
      if (transport instanceof NativeTransport)
        await transport.pollCalls(
          (id, state, qualified) => service.observeCall(id, state, qualified),
          { cleanupOnly: mode === "standby" || stopping },
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
          await transport.pollCalls(
            (id, state, qualified) => service.observeCall(id, state, qualified),
            { cleanupOnly: true },
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
      finishTick?.();
    }
  }
  async function stop() {
    stopping = true;
    if (ticking)
      await new Promise<void>((resolve) => {
        finishTick = resolve;
      });
  }
  return { app, store, service, control, human, transport, tick, stop };
}
