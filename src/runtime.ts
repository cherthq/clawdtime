import { retireObsoleteNotice as retireNotice } from "./control/obsolete-notice.js";
import { SetupService } from "./pairing/setup.js";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { Store } from "./storage/store.js";
import { Vault, hash } from "./storage/security.js";
import { ClawdTime } from "./attention/service.js";
import { PreflightBlocked } from "./transport/readiness.js";
import {
  NativeTransport,
  type NativeTransportConfig,
} from "./transport/native.js";
import type { NativeMessage } from "./transport/native-messages.js";
import { SimulationTransport } from "./transport/simulation.js";
import { ControlCoordinator, SimulatedDevice } from "./control/coordinator.js";
import { HumanRouter, isImmediateStop } from "./control/human-router.js";
import { Viewing } from "./control/viewing.js";
import { MediaDevicePort } from "../media/device-port.js";
import { configuredConversationAgent } from "./control/conversation.js";
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
  dispatch?: { startedAt: number; operationOrigin: string };
  receipt?: {
    accepted: true;
    receiptId: string;
    status: "acknowledged";
    operationOrigin: string;
    acknowledgedAt: number;
  };
  failure?: {
    phase:
      | "payload_decryption"
      | "transport_dispatch"
      | "acknowledgement_validation"
      | "receipt_persistence"
      | "process_interrupted";
    code: string;
    at: number;
    httpStatus?: number;
  };
}
function noticeFailure(
  error: unknown,
  phase: NonNullable<Notice["failure"]>["phase"],
): NonNullable<Notice["failure"]> {
  const status =
    error instanceof Error
      ? /^Provider returned HTTP (\d{3})\.$/.exec(error.message)
      : null;
  const code =
    error instanceof PreflightBlocked
      ? "preflight_blocked"
      : phase === "payload_decryption"
        ? "payload_unavailable"
        : phase === "acknowledgement_validation"
          ? "acknowledgement_unavailable"
          : phase === "receipt_persistence"
            ? "receipt_persistence_failed"
            : "transport_outcome_unknown";
  return {
    phase,
    code,
    at: Date.now(),
    ...(status ? { httpStatus: Number(status[1]) } : {}),
  };
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
  const validateOrigin = (value: string) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(
        "Use exact HTTPS origins, or HTTP loopback origins outside live mode.",
      );
    }
    if (
      url.origin !== value ||
      url.username ||
      url.password ||
      !(
        url.protocol === "https:" ||
        (!live && url.protocol === "http:" && url.hostname === "127.0.0.1")
      )
    )
      throw new Error(
        "Use exact HTTPS origins, or HTTP loopback origins outside live mode.",
      );
    return value;
  };
  validateOrigin(origin);
  const compatibleOrigins = env.CLAWDTIME_COMPATIBLE_ORIGINS
    ? [
        ...new Set(
          env.CLAWDTIME_COMPATIBLE_ORIGINS.split(",").map((value) =>
            validateOrigin(value.trim()),
          ),
        ),
      ]
    : [];
  if (compatibleOrigins.length > 8)
    throw new Error("At most eight exact compatible origins are allowed.");
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
    config.testers = z
      .array(
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
  const setup = new SetupService(service);
  const device = config
    ? new MediaDevicePort(config.mediaOrigin, config.mediaKey)
    : new SimulatedDevice();
  const control = new ControlCoordinator(store, device),
    viewing = new Viewing(store, device, Date.now, transport.mode === "live");
  const human = new HumanRouter(
    service,
    control,
    device instanceof MediaDevicePort
      ? configuredConversationAgent(device, env)
      : undefined,
    maintainConversation,
  );
  const vault = config ? new Vault(config.encryptionKey) : undefined;
  const app = createApp(service, control, human, {
    origin,
    compatibleOrigins,
    retireSetupInvitation:
      transport instanceof NativeTransport
        ? (input) => transport.retireSetupInvitation(input)
        : undefined,
    callDiagnostics:
      transport instanceof NativeTransport
        ? (requestId) => transport.mediaStatus(requestId)
        : undefined,
    retireObsoleteNotice: vault
      ? (input) =>
          retireNotice(store, vault, {
            ...input,
            allowedOrigins: [origin, ...compatibleOrigins],
          })
      : undefined,
    operatorToken: env.CLAWDTIME_OPERATOR_TOKEN,
    mediaToken: env.CLAWDTIME_MEDIA_TOKEN,
    simulation: mode === "simulation",
    dispatchEnabled: mode !== "standby",
  });
  for (const n of store.all<Notice>("notice"))
    if (n.state === "running")
      store.put<Notice>("notice", {
        ...n,
        state: "unknown",
        failure: {
          phase: "process_interrupted",
          code: "process_interrupted",
          at: Date.now(),
        },
      });
  for (const n of store.all<Inbound>("inbound"))
    if (n.state === "running") store.put("inbound", { ...n, state: "unknown" });
  let ticking = false;
  let stopping = false;
  let finishTick: (() => void) | undefined;
  let checkedReadinessAt = 0;
  let inboxPoll: Promise<void> | undefined;
  let maintenance: Promise<void> | undefined;
  function requireOwnership() {
    const report = store.state<{ checks: { id: string; status: string }[] }>(
      "native-preflight",
    );
    const required = [
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
      required.some(
        (id) => !report.checks.some((c) => c.id === id && c.status === "pass"),
      )
    )
      throw new Error(
        "Inbound polling requires verified exclusive ownership and an exact retained boundary.",
      );
  }
  async function pollInbox() {
    if (
      stopping ||
      !live ||
      !(transport instanceof NativeTransport) ||
      !config ||
      !vault
    )
      return;
    if (inboxPoll) return inboxPoll;
    requireOwnership();
    inboxPoll = transport.messages
      .poll((event) => {
        if (!config.testers.some((t) => t.recipient === event.sender)) return;
        if (!store.get("inbound", event.id))
          store.put<Inbound>("inbound", {
            id: event.id,
            sealed: vault.seal(event),
            state: "pending",
          });
      })
      .then(() => {})
      .finally(() => {
        inboxPoll = undefined;
      });
    return inboxPoll;
  }
  async function maintainConversation() {
    if (stopping) return;
    // Renew/release the existing display independently of the ordinary inbox worker.
    await viewing.tick();
    if (maintenance) return maintenance;
    maintenance = (async () => {
      service.expireSessions();
      setup.expire();
      if (!live || !(transport instanceof NativeTransport) || !config || !vault)
        return;
      try {
        await pollInbox();
        for (const item of store
          .all<Inbound>("inbound")
          .filter((i) => i.state === "pending")) {
          if (stopping) return;
          const event = vault.open<NativeMessage>(item.sealed);
          if (!isImmediateStop(event.text)) continue;
          const tester = config.testers.find(
            (t) => t.recipient === event.sender,
          );
          const pairing =
            tester &&
            store
              .all<Pairing>("pairing")
              .find(
                (p) =>
                  p.revokedAt === undefined &&
                  p.memberId === tester.memberId &&
                  p.recipient === event.sender &&
                  p.lineId === event.lineId &&
                  p.conversationId === event.conversationId,
              );
          const requests = pairing
            ? store
                .all<AttentionRequest>("attention")
                .filter(
                  (r) =>
                    r.pairingId === pairing.id &&
                    ["ringing", "connected", "awaiting_input"].includes(
                      r.state,
                    ),
                )
            : [];
          if (
            !pairing ||
            requests.length !== 1 ||
            store.get<Inbound>("inbound", item.id)?.state !== "pending"
          )
            continue;
          store.put("inbound", { ...item, state: "running" });
          try {
            await human.receive({
              eventId: event.id,
              requestId: requests[0]!.id,
              memberId: pairing.memberId,
              lineId: event.lineId,
              conversationId: event.conversationId,
              channel: "text",
              text: event.text,
            });
            store.transaction(() => {
              store.put<Notice>("notice", {
                id: `${event.id}:notice`,
                pairing,
                sealed: vault.seal("Screen sharing and control stopped."),
                state: "pending",
              });
              store.put("inbound", { ...item, state: "done" });
            });
          } catch {
            store.put("inbound", { ...item, state: "unknown" });
          }
        }
      } finally {
        // Read-only call observations keep remote hangup authoritative during model work.
        // An inbox failure must not prevent expiry or release of owned control.
        if (!stopping) {
          await transport.pollCalls(
            (id, state, qualified) => service.observeCall(id, state, qualified),
            {
              observeOnly: true,
              onTerminalPending: (id) => {
                service.failCall(id);
              },
            },
          );
          await service.drain({
            cleanupOnly: true,
            shouldStop: () => stopping,
          });
          await viewing.tick();
        }
      }
    })().finally(() => {
      maintenance = undefined;
    });
    return maintenance;
  }
  async function tick() {
    if (ticking || stopping) return;
    ticking = true;
    try {
      service.expireSessions();
      setup.expire();
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
        requireOwnership();
        if (stopping) return;
        await pollInbox();
        if (stopping) return;
        for (const item of store
          .all<Inbound>("inbound")
          .filter((i) => i.state === "pending")) {
          if (stopping) break;
          if (store.get<Inbound>("inbound", item.id)?.state !== "pending")
            continue;
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
            if (setup.receive(event)) {
              store.put("inbound", { ...item, state: "done" });
              continue;
            }
            if (!pairing || /^pair$/i.test(event.text.trim())) {
              const invite = service.createPairingInvite({
                ...tester,
                lineId: event.lineId,
                conversationId: event.conversationId,
              });
              reply = `Set up ClawdTime for this project. Follow ${origin}/agents using my setup link: ${origin}/setup#token=${encodeURIComponent(invite.token)}&device=${encodeURIComponent(tester.deviceId)}&display=${encodeURIComponent(tester.displayId)}`;
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
                  reply?: string;
                  clarification?: string;
                  stopped?: boolean;
                  receipt?: unknown;
                };
                reply =
                  result.reply ??
                  result.clarification ??
                  (result.stopped
                    ? "Screen sharing and control stopped."
                    : result.accepted
                      ? "Your response is available to the waiting coding agent."
                      : "I couldn't finish that request safely.");
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
          const dispatch = {
            startedAt: Date.now(),
            operationOrigin: `text_${hash(n.id).slice(0, 32)}`,
          };
          store.put<Notice>("notice", { ...n, dispatch, state: "running" });
          let phase: NonNullable<Notice["failure"]>["phase"] =
            "payload_decryption";
          let receipt: Notice["receipt"];
          try {
            const text = vault.open<string>(n.sealed);
            phase = "transport_dispatch";
            const result = await transport.message(n.pairing, text, n.id);
            phase = "acknowledgement_validation";
            const acknowledgement = z
              .object({
                accepted: z.literal(true),
                receiptId: z.string().regex(/^[a-f0-9-]{36}$/i),
                status: z.literal("acknowledged"),
                operationOrigin: z.literal(dispatch.operationOrigin),
              })
              .parse(result);
            receipt = { ...acknowledgement, acknowledgedAt: Date.now() };
            phase = "receipt_persistence";
            store.put<Notice>("notice", {
              ...n,
              dispatch,
              receipt,
              state: "done",
            });
          } catch (error) {
            // No unknown notice is requeued. A provider error or absent lookup
            // cannot prove whether the native once-only operation was applied.
            store.put<Notice>("notice", {
              ...n,
              dispatch,
              ...(receipt ? { receipt } : {}),
              failure: noticeFailure(error, phase),
              state: "unknown",
            });
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
    if (maintenance) await maintenance.catch(() => {});
    if (inboxPoll) await inboxPoll.catch(() => {});
    if (ticking)
      await new Promise<void>((resolve) => {
        finishTick = resolve;
      });
  }
  return { app, store, service, control, human, transport, tick, stop };
}
