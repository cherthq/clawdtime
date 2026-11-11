import { z } from "zod";
import type {
  AttentionRequest,
  Pairing,
  Transport,
  CallSession,
} from "../contracts.js";
import { Store } from "../storage/store.js";
import { DomainError, hash, Vault } from "../storage/security.js";
import {
  NativeMessages,
  jsonRequest,
  type MessageBinding,
  type EventAnchor,
} from "./native-messages.js";
export interface LineHandoff {
  owner: "clawdtime";
  sourceOwnerPaused: true;
  lineId: string;
  providerLineId: string;
  instanceId: string;
  baseline: EventAnchor;
  checkedAt: number;
  rollbackRecord: string;
}
export interface NativeTransportConfig {
  enabled: boolean;
  binding: MessageBinding;
  callsOrigin: string;
  projectId: string;
  projectKey: string;
  mediaOrigin: string;
  mediaKey: string;
  encryptionKey: string;
  testerAllowlist: string[];
  handoff: LineHandoff;
}
interface MediaRecord {
  id: string;
  requestId: string;
  state:
    | "preparing"
    | "prepared"
    | "dialing"
    | "allocated"
    | "active"
    | "closing"
    | "closed"
    | "unknown";
  credentials?: string;
  providerCallId?: string;
  outcome?: "declined" | "unanswered" | "disconnected" | "failed";
}
interface QuestionSpeech {
  id: string;
  sessionId: string;
  requestId: string;
  state:
    | "dispatching"
    | "accepted"
    | "playing"
    | "completed"
    | "cancelled"
    | "failed"
    | "unknown";
  fingerprint: string;
  updatedAt?: string;
}
const speechReceiptSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  state: z.enum([
    "accepted",
    "playing",
    "completed",
    "cancelled",
    "failed",
    "unknown",
  ]),
  updatedAt: z.string().nullable().optional(),
});
const credentialsSchema = z.object({
  livekit_url: z.string().startsWith("wss://"),
  participant_token: z.string().min(40),
  remote_participant_identity: z.string().min(1),
});
export const mediaSessionId = (requestId: string) =>
  `ct_${hash(requestId).slice(0, 40)}`;
export class NativeTransport implements Transport {
  readonly mode = "live" as const;
  readonly messages: NativeMessages;
  readonly vault: Vault;
  private polling = false;
  constructor(
    readonly store: Store,
    readonly config: NativeTransportConfig,
    readonly request: typeof fetch = fetch,
  ) {
    for (const origin of [config.callsOrigin, config.mediaOrigin]) {
      const u = new URL(origin);
      if (
        u.protocol !== "https:" ||
        u.origin !== origin ||
        u.username ||
        u.password
      )
        throw new Error("Live service origins must be bare HTTPS.");
    }
    this.messages = new NativeMessages(store, config.binding, request);
    this.vault = new Vault(config.encryptionKey);
    this.guard();
  }
  private guard(pairing?: Pairing) {
    const c = this.config,
      h = c.handoff;
    if (
      !c.enabled ||
      !h ||
      h.owner !== "clawdtime" ||
      h.sourceOwnerPaused !== true ||
      h.lineId !== c.binding.lineId ||
      h.providerLineId !== c.binding.providerLineId ||
      h.instanceId !== c.binding.instanceId ||
      !h.rollbackRecord ||
      !Number.isSafeInteger(h.baseline.sequence) ||
      h.baseline.sequence < 1 ||
      !h.baseline.eventId
    )
      throw new DomainError(
        503,
        "Live traffic requires verified exclusive line handoff and rollback record.",
      );
    if (
      pairing &&
      (pairing.lineId !== c.binding.lineId ||
        !c.testerAllowlist.includes(pairing.recipient) ||
        pairing.revokedAt !== undefined)
    )
      throw new DomainError(
        403,
        "Pairing is not authorized for the test line.",
      );
  }
  async calls(path: string, body?: unknown, key?: string) {
    return jsonRequest(
      this.config.callsOrigin + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.config.projectKey}`,
          "X-Chert-Project-Id": this.config.projectId,
          "content-type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      this.request,
    );
  }
  async media(path: string, body?: unknown) {
    return jsonRequest(
      this.config.mediaOrigin + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.config.mediaKey}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      this.request,
    );
  }
  async call(attention: AttentionRequest, pairing: Pairing, effectId: string) {
    this.guard(pairing);
    await this.messages.verify();
    if (!this.messages.cursor())
      throw new DomainError(
        409,
        "Verified native event boundary is required before dialing.",
      );
    const id = mediaSessionId(attention.id),
      old = this.store.get<MediaRecord>("media", id);
    if (old) {
      if (old.requestId === attention.id && old.providerCallId)
        return { callId: old.providerCallId, accepted: true };
      throw new DomainError(
        409,
        "Existing media/call outcome requires reconciliation.",
      );
    }
    const record: MediaRecord = {
      id,
      requestId: attention.id,
      state: "preparing",
    };
    this.store.put("media", record);
    try {
      const media = await this.media("/sessions", {
        id,
        meetingId: attention.id,
        lineId: pairing.lineId,
        captions: true,
        screen: true,
      });
      if (
        media.id !== id ||
        media.silentPublisherReady !== true ||
        media.videoPublisherReady !== true
      )
        throw new Error("Media readiness not confirmed.");
      const credentials = credentialsSchema.parse(media.credentials);
      this.store.put("media", {
        ...record,
        state: "prepared",
        credentials: this.vault.seal(credentials),
      });
      const currentPairing = this.store.get<Pairing>("pairing", pairing.id);
      if (!currentPairing)
        throw new DomainError(403, "Pairing no longer exists.");
      this.guard(currentPairing);
      const current = this.store.get<AttentionRequest>(
        "attention",
        attention.id,
      );
      if (
        !current ||
        current.state !== "queued" ||
        current.deadline <= Date.now()
      )
        throw new DomainError(409, "Attention expired before dialing.");
      this.store.put("media", {
        ...record,
        state: "dialing",
        credentials: this.vault.seal(credentials),
      });
      const response = await this.calls(
        "/api/v1/calls",
        {
          direction: "outbound",
          mode: "customer_managed",
          line_id: pairing.lineId,
          media: { audio: true, video: true },
          destination: pairing.recipient,
          destination_type: "phone",
          ...credentials,
        },
        effectId,
      );
      const call = z
        .object({ id: z.string().uuid(), line_id: z.string() })
        .parse(response.data);
      if (call.line_id !== pairing.lineId)
        throw new Error("Allocated call line mismatch.");
      this.store.put("media", {
        ...record,
        state: "allocated",
        credentials: this.vault.seal(credentials),
        providerCallId: call.id,
      });
      return { callId: call.id, accepted: true };
    } catch (e) {
      const current = this.store.get<MediaRecord>("media", id)!;
      this.store.put("media", { ...current, state: "unknown" });
      throw e;
    }
  }
  async message(pairing: Pairing, text: string, effectId: string) {
    this.guard(pairing);
    return this.messages.send(pairing, text, effectId);
  }
  async endCall(callId: string, effectId: string) {
    const owned = this.store
      .all<MediaRecord>("media")
      .find((s) => s.providerCallId === callId);
    if (!owned) throw new DomainError(403, "Cannot end an unowned call.");
    this.store.put("media", { ...owned, state: "closing" });
    let mediaClosed = false;
    try {
      await this.media(`/sessions/${owned.id}/close`, {});
      mediaClosed = true;
    } catch {
      /* Native hangup must still be attempted when media is unavailable. */
    }
    await this.calls(
      `/api/v1/calls/${encodeURIComponent(callId)}/end`,
      { reason: "ClawdTime attention ended" },
      effectId,
    );
    this.store.saveState(`cleanup:${owned.id}`, {
      nativeEndRequested: true,
      mediaClosed,
      cleanupPending: true,
    });
    return {
      accepted: true,
      actionId: effectId,
      mediaClosed,
      cleanupPending: true,
    };
  }
  private async question(session: MediaRecord) {
    const attention = this.store.get<AttentionRequest>(
      "attention",
      session.requestId,
    );
    const pairing =
      attention && this.store.get<Pairing>("pairing", attention.pairingId);
    if (
      !attention ||
      !pairing ||
      pairing.revokedAt !== undefined ||
      attention.responseId ||
      attention.deadline <= Date.now() ||
      !["ringing", "connected", "awaiting_input"].includes(attention.state)
    )
      return;
    const utteranceId = `${attention.id}:question`;
    const previous = this.store.get<QuestionSpeech>("speech", utteranceId);
    if (
      previous &&
      ["completed", "cancelled", "failed"].includes(previous.state)
    )
      return;
    const text = `Your agent asks: ${attention.question}`
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 36)
      .join(" ")
      .slice(0, 280);
    const record: QuestionSpeech = previous ?? {
      id: utteranceId,
      sessionId: session.id,
      requestId: attention.id,
      state: "dispatching",
      fingerprint: hash(text),
    };
    // Commit before network dispatch. A crash/timeout can only trigger GET lookup,
    // even if no receipt can be found; it never grants permission to speak again.
    if (!previous) this.store.put("speech", record);
    try {
      const raw = previous
        ? await this.media(
            `/sessions/${session.id}/speech/${encodeURIComponent(utteranceId)}`,
          )
        : await this.media(`/sessions/${session.id}/speak`, {
            id: utteranceId,
            callId: session.id,
            text,
          });
      const receipt = speechReceiptSchema.parse(raw);
      if (receipt.id !== utteranceId || receipt.sessionId !== session.id)
        throw new Error("Speech receipt belongs to another request.");
      this.store.put<QuestionSpeech>("speech", {
        ...record,
        state: receipt.state,
        ...(receipt.updatedAt ? { updatedAt: receipt.updatedAt } : {}),
      });
    } catch {
      this.store.put<QuestionSpeech>("speech", { ...record, state: "unknown" });
      // Playback is supplementary: a provider outage must not terminate screen
      // viewing, native call cleanup or authenticated text feedback.
    }
  }
  async pollCalls(
    observe: (
      requestId: string,
      state:
        | "connected"
        | "declined"
        | "unanswered"
        | "disconnected"
        | "failed"
        | "ended",
      qualified?: boolean,
    ) => unknown,
  ) {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const session of this.store
        .all<MediaRecord>("media")
        .filter((s) => !!s.providerCallId && s.state !== "closed")) {
        const response = await this.calls(
          `/api/v1/calls/${encodeURIComponent(session.providerCallId!)}/events`,
        );
        const data = z
          .object({
            call_id: z.string(),
            events: z.array(
              z.object({
                id: z.string(),
                type: z.string(),
                source: z.string(),
              }),
            ),
          })
          .parse(response.data);
        if (data.call_id !== session.providerCallId)
          throw new Error("Call events belong to another call.");
        // Recover only a provider ID already committed from an exact allocation receipt.
        // A lost allocation response without an ID remains unknown; never dial again.
        const effect = this.store.effect(`${session.requestId}:call`);
        if (
          effect?.state === "unknown" &&
          ["allocated", "active", "closing"].includes(session.state)
        ) {
          const attention = this.store.get<AttentionRequest>(
            "attention",
            session.requestId,
          );
          const call = this.store.get<CallSession>("call", session.id);
          if (
            attention &&
            call &&
            call.requestId === attention.id &&
            effect.payload.localCallId === session.id
          ) {
            this.store.transaction(() => {
              this.store.putEffect({
                ...effect,
                state: "done",
                result: {
                  accepted: true,
                  callId: session.providerCallId!,
                  recovered: true,
                },
              });
              this.store.put("call", {
                ...call,
                providerCallId: session.providerCallId,
                state: session.state === "active" ? "connected" : "ringing",
              });
              const pairing = this.store.get<Pairing>(
                "pairing",
                attention.pairingId,
              );
              const closed =
                !pairing ||
                pairing.revokedAt !== undefined ||
                attention.deadline <= Date.now();
              this.store.put("attention", {
                ...attention,
                callId: call.id,
                state:
                  attention.state === "unknown"
                    ? closed
                      ? "expired"
                      : "ringing"
                    : attention.state,
              });
              if (closed && !this.store.effect(`${attention.id}:end`))
                this.store.putEffect({
                  id: `${attention.id}:end`,
                  kind: "end_call",
                  state: "pending",
                  payload: {
                    requestId: attention.id,
                    pairingId: attention.pairingId,
                    callId: session.providerCallId,
                  },
                  createdAt: Date.now(),
                });
            });
          }
        }
        const types = data.events
          .filter((e) => e.source === "worker")
          .map((e) => e.type);
        if (
          types.some((t) =>
            ["ended", "failed", "rejected", "cleanup_complete"].includes(t),
          )
        ) {
          await this.media(`/sessions/${session.id}/close`, {});
          const outcome = types.includes("rejected")
            ? "declined"
            : types.includes("failed")
              ? "failed"
              : (session.outcome ?? "disconnected");
          this.store.put("media", { ...session, state: "closing", outcome });
          if (types.includes("cleanup_complete")) {
            observe(session.requestId, outcome);
            this.store.put("media", {
              id: session.id,
              requestId: session.requestId,
              state: "closed",
              providerCallId: session.providerCallId,
              outcome,
            });
          }
          continue;
        }
        const domain = this.store.get<CallSession>("call", session.id);
        if (!domain || domain.providerCallId !== session.providerCallId)
          continue; // receipt must commit first
        if (types.includes("bridge_ready") && session.state === "allocated") {
          const attention = this.store.get<AttentionRequest>(
            "attention",
            session.requestId,
          );
          const pairing = attention
            ? this.store.get<Pairing>("pairing", attention.pairingId)
            : undefined;
          if (
            !attention ||
            !pairing ||
            pairing.revokedAt !== undefined ||
            attention.deadline <= Date.now() ||
            !["ringing", "queued", "connected", "awaiting_input"].includes(
              attention.state,
            )
          )
            continue;
          this.guard(pairing);
          observe(session.requestId, "connected", true);
          await this.media(`/sessions/${session.id}/activate`, {
            callId: session.id,
          });
          this.store.put("media", { ...session, state: "active" });
          await this.question(session);
        }
        if (session.state === "active") {
          await this.question(session);
          const health = await this.media(`/sessions/${session.id}`);
          if (health.id !== session.id || health.alive !== true) {
            this.store.put("media", {
              ...session,
              state: "closing",
              outcome: "failed",
            });
            await this.endCall(
              session.providerCallId!,
              `${session.requestId}:media-failure-end`,
            );
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }
}
