import { isDeepStrictEqual } from "node:util";
import type {
  CallAttemptGrant,
  ProactiveCallIntent,
} from "../attention/proactive-contracts.js";
import type { ProactiveCallCoordinator } from "../attention/proactive-coordinator.js";
import type { ProactiveTransportEffect } from "../attention/proactive-transport-ledger.js";
import type { ProactiveDeliveryPort } from "./proactive-service.js";
import type { ProactiveReviewPacket } from "./proactive-preparation.js";
import type { ProactiveLineSessions } from "./proactive-line.js";
import type {
  NativeTaskAudioCalls,
  NativeProactiveCallBinding,
  TaskAudioCredentials,
} from "../transport/task-audio.js";

export interface ProactiveLineOwnerPort {
  /** Read-only preflight. Unsupported receipt retention must be reported before stopping the host. */
  readiness(): Promise<{ ready: boolean; reason?: string }>;
  /** Reversible supported handoff preserving original receipts/cursors in place.
   * Rejects with the message `owner_release_not_sent` only when nothing reached
   * the line and the owner holds no lock for the attempt. Any other rejection is unknown. */
  acquire(attemptId: string): Promise<{ exclusive: true }>;
  verify(attemptId: string): Promise<boolean>;
  restore(attemptId: string): Promise<{ confirmed: boolean }>;
}
export interface ProactiveMediaAttempt {
  prepare(): Promise<{ credentials: TaskAudioCredentials }>;
  close(): Promise<{ closed: boolean }>;
  inspect?(): Promise<{ ready: boolean }>;
}

/** Generic source delivery uses the native Calls API and existing warm-media
 * implementation. A durable effect reservation precedes every external await.
 * Unknown allocation, handoff, dial or cleanup retains ownership for reconciliation. */
export class ProactiveTransport implements ProactiveDeliveryPort {
  private active?: { intent: ProactiveCallIntent; stopped: boolean };
  constructor(
    private readonly ports: {
      coordinator: ProactiveCallCoordinator;
      line: ProactiveLineOwnerPort;
      calls: Pick<
        NativeTaskAudioCalls,
        "createProactive" | "inspectProactive" | "endProactive"
      >;
      sessions: ProactiveLineSessions;
      packet(intentId: string): ProactiveReviewPacket | undefined;
      current(intent: ProactiveCallIntent): boolean;
      sourceFingerprint(intent: ProactiveCallIntent): string;
      freshFrame?(
        intent: ProactiveCallIntent,
      ): Promise<{ capturedAt: number; sourceFingerprint: string } | null>;
      destination: {
        lineId: string;
        recipientHash: string;
        personId: string;
        deviceId: string;
        projectRoot: string;
      };
      media(input: {
        config: ReturnType<ProactiveLineSessions["open"]> & {
          providerCallerIdentity: string;
        };
        agentName: string;
      }): Promise<ProactiveMediaAttempt>;
      cleanupViews(intentId: string): Promise<{ confirmed: boolean }>;
      now?: () => number;
      pause?: (ms: number) => Promise<void>;
    },
  ) {}
  async readiness(intent: ProactiveCallIntent) {
    const d = this.ports.destination;
    if (this.active) return { ready: false, reason: "line_busy_or_unresolved" };
    if (
      intent.scope.personId !== d.personId ||
      intent.scope.deviceId !== d.deviceId ||
      intent.scope.projectRoot !== d.projectRoot
    )
      return { ready: false, reason: "outbound_destination_scope_mismatch" };
    if (
      this.ports.coordinator
        .list()
        .some(
          (other) =>
            other.id !== intent.id &&
            ["dispatching", "connected", "unknown"].includes(other.state),
        )
    )
      return { ready: false, reason: "line_busy_or_unresolved" };
    return this.ports.line.readiness();
  }
  async deliver(intent: ProactiveCallIntent, grant: CallAttemptGrant) {
    const now = this.ports.now ?? Date.now;
    const pause =
      this.ports.pause ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const coordinator = this.ports.coordinator,
      journal = coordinator.transport;
    const stored = coordinator.get(intent.id),
      savedGrant = coordinator.authority.grant(grant.id);
    // This transport accepts only the exact persisted common reservation. A replay
    // cannot report cleanup or take over a previous process's effects.
    if (
      this.active ||
      stored.state !== "dispatching" ||
      stored.attemptId !== grant.attemptId ||
      stored.grantId !== grant.id ||
      !isDeepStrictEqual(stored.source, intent.source) ||
      !isDeepStrictEqual(savedGrant, grant) ||
      journal.list(grant.attemptId).length
    )
      return {
        state: "unknown" as const,
        cleanupConfirmed: false,
        reason: "original_delivery_requires_reconciliation",
      };
    const active = { intent: stored, stopped: false };
    this.active = active;
    const packet = this.ports.packet(intent.id);
    const current = () => {
      const d = this.ports.destination;
      return (
        !!packet &&
        coordinator.authority.validateGrant(grant) &&
        stored.scope.personId === d.personId &&
        stored.scope.deviceId === d.deviceId &&
        stored.scope.projectRoot === d.projectRoot &&
        this.ports.current(stored) &&
        this.ports.sourceFingerprint(stored) === packet.sourceFingerprint &&
        packet.fingerprint === grant.packetFingerprint &&
        packet.intentId === stored.id &&
        isDeepStrictEqual(packet.source, stored.source) &&
        !active.stopped
      );
    };
    const effect = async <T>(
      name: ProactiveTransportEffect,
      operation: () => Promise<T>,
      evidence: string,
      providerId?: (value: T) => string,
    ): Promise<T> => {
      journal.reserve(intent.id, grant.attemptId, name);
      try {
        const value = await operation();
        journal.settle(grant.attemptId, name, {
          evidence,
          ...(providerId ? { providerCallId: providerId(value) } : {}),
        });
        return value;
      } catch (error) {
        journal.unknown(grant.attemptId, name);
        throw error;
      }
    };
    let handoff: "untouched" | "unknown" | "acquired" = "untouched";
    let mediaAllocationStarted = false,
      media: ProactiveMediaAttempt | undefined,
      providerCallId: string | undefined;
    let submissionStarted = false,
      endSubmitted = false,
      providerClean = false;
    let outcome: "ended" | "refused" | "unknown" = "refused";
    let refusalReason: string | undefined;
    const binding: NativeProactiveCallBinding = {
      attemptId: grant.attemptId,
      lineId: this.ports.destination.lineId,
      recipientHash: this.ports.destination.recipientHash,
      agentIdentity: `agent_${grant.attemptId}`,
      channel: grant.channel,
    };
    try {
      if (!current() || !packet || packet.expiresAt <= now())
        throw Error("fresh_exact_delivery_required");
      // Admit only the ephemeral service capability while the reserved packet's
      // initial frame is fresh. This allocates no room and performs no capture,
      // handoff or call. Supported handoff may outlast that frame; every subsequent
      // effect still rechecks authority/source, and dialing requires a new <=1s frame.
      const config = this.ports.sessions.open(stored, grant, packet!, {
        roomName: `review_${grant.attemptId}`,
        agentIdentity: binding.agentIdentity,
      });
      const providerCallerIdentity = `caller_${grant.attemptId}`;
      this.ports.sessions.bindCaller(grant.attemptId, providerCallerIdentity);
      const readiness = await this.ports.line.readiness();
      if (!readiness.ready || !current())
        throw Error("line_or_authority_changed");
      handoff = "unknown"; // Set BEFORE await: a lost response may have moved ownership.
      try {
        await effect(
          "handoff",
          async () => {
            const result = await this.ports.line.acquire(grant.attemptId);
            if (result.exclusive !== true)
              throw Error("exclusive_handoff_unconfirmed");
            return result;
          },
          "exclusive_handoff_confirmed",
        );
      } catch (error) {
        // Only the owner's own refusal before any effect is not sent. It freed its
        // lock, so this attempt frees the line too. Every other failure stays unknown.
        if (
          error instanceof Error &&
          error.message === "owner_release_not_sent"
        ) {
          journal.settle(grant.attemptId, "handoff", {
            evidence: "release_not_sent",
          });
          handoff = "untouched";
        }
        throw error;
      }
      handoff = "acquired";
      if (!current()) throw Error("authority_changed");
      mediaAllocationStarted = true;
      media = await effect(
        "media_allocate",
        () =>
          this.ports.media({
            config: { ...config, providerCallerIdentity },
            agentName: `review_${grant.attemptId}`,
          }),
        "owned_media_handle_received",
      );
      if (!current()) throw Error("authority_changed_during_media_allocation");
      const prepared = await effect(
        "media_prepare",
        () => media!.prepare(),
        "media_preparation_acknowledged",
      );
      if (
        !current() ||
        this.ports.sessions.status(grant.attemptId)?.prepared !== true
      )
        throw Error("authority_or_media_changed_during_prepare");
      const exclusive = await this.ports.line.verify(grant.attemptId);
      const mediaReady = !media.inspect || (await media.inspect()).ready;
      const frame =
        grant.channel === "phone_walkthrough"
          ? await this.ports.freshFrame?.(stored)
          : undefined;
      if (
        !exclusive ||
        !mediaReady ||
        !current() ||
        (grant.channel === "phone_walkthrough" &&
          (!frame ||
            frame.sourceFingerprint !== packet!.sourceFingerprint ||
            frame.capturedAt > now() ||
            now() - frame.capturedAt > 1000))
      )
        throw Error("dispatch_revalidation_failed");
      submissionStarted = true;
      const call = await effect(
        "dial",
        () =>
          this.ports.calls.createProactive(
            binding,
            prepared.credentials,
            `dial_${grant.attemptId}`,
          ),
        "provider_call_identity_received",
        (value) => value.providerCallId,
      );
      providerCallId = call.providerCallId;
      if (call.lineId !== binding.lineId)
        throw Error("provider_line_binding_mismatch");
      let cleanupDeadline = grant.expiresAt + 15000;
      while (now() < cleanupDeadline) {
        let terminal = false,
          inspectFailed = false;
        try {
          const observation = await this.ports.calls.inspectProactive(
            binding,
            providerCallId,
          );
          if (observation.providerCallId !== providerCallId)
            throw Error("provider_call_identity_mismatch");
          if (
            observation.state === "connected" &&
            coordinator.get(intent.id).state === "dispatching"
          )
            coordinator.outcome(intent.id, grant.attemptId, "connected");
          if (observation.cleanupComplete) {
            providerClean = true;
            outcome = "ended";
            if (journal.get(grant.attemptId, "end")?.state === "unknown")
              journal.settle(grant.attemptId, "end", {
                evidence: "provider_cleanup_observed",
                providerCallId,
              });
            break;
          }
          terminal = observation.state === "terminal";
        } catch {
          inspectFailed = true;
        }
        if (media?.inspect) {
          try {
            if (!(await media.inspect()).ready) inspectFailed = true;
          } catch {
            inspectFailed = true;
          }
        }
        const closed = this.ports.sessions.status(grant.attemptId)?.closed;
        if (
          (active.stopped ||
            closed ||
            !coordinator.authority.validateGrant(grant) ||
            now() >= grant.expiresAt ||
            terminal ||
            inspectFailed) &&
          !endSubmitted
        ) {
          endSubmitted = true;
          cleanupDeadline = Math.min(cleanupDeadline, now() + 15000);
          // A lost end response is not retried. Read-only observation of this exact
          // known call may still establish its eventual terminal cleanup.
          try {
            await effect(
              "end",
              () =>
                this.ports.calls.endProactive(
                  binding,
                  providerCallId!,
                  `end_${grant.attemptId}`,
                ),
              "end_submission_acknowledged",
            );
          } catch {}
        }
        await pause(250);
      }
      if (!providerClean) outcome = "unknown";
    } catch (error) {
      // Only fixed diagnostic codes may escape the transport. Provider errors
      // can contain credentials or task prose and must never be persisted.
      const safeReasons = new Set([
        "fresh_exact_delivery_required",
        "line_or_authority_changed",
        "owner_release_not_sent",
        "authority_changed",
        "authority_changed_during_media_allocation",
        "authority_or_media_changed_during_prepare",
        "dispatch_revalidation_failed",
        "production_worker_retired_during_prepare",
        "production_worker_prepare_timeout",
        "proactive_publications_not_ready",
        "proactive_publisher_identity_mismatch",
        "proactive_duplicate_publication",
      ]);
      refusalReason =
        error instanceof Error && safeReasons.has(error.message)
          ? error.message
          : "delivery_preparation_failed";
      outcome =
        submissionStarted ||
        handoff === "unknown" ||
        (mediaAllocationStarted && !media)
          ? "unknown"
          : "refused";
    }
    let viewsClean = false,
      roomClean = !mediaAllocationStarted;
    try {
      await effect(
        "views_close",
        async () => {
          const value = await this.ports.cleanupViews(intent.id);
          if (!value.confirmed) throw Error("capture_cleanup_unknown");
          return value;
        },
        "capture_cleanup_confirmed",
      );
      viewsClean = true;
    } catch {}
    if (media) {
      try {
        await effect(
          "media_close",
          async () => {
            const value = await media!.close();
            if (!value.closed) throw Error("media_cleanup_unknown");
            return value;
          },
          "media_cleanup_confirmed",
        );
        roomClean = true;
        if (journal.get(grant.attemptId, "media_prepare")?.state === "unknown")
          journal.settle(grant.attemptId, "media_prepare", {
            evidence: "media_cleanup_reconciled",
          });
      } catch {}
    }
    const clean =
      viewsClean && roomClean && (!submissionStarted || providerClean);
    let restored = handoff === "untouched";
    if (handoff === "acquired" && clean) {
      try {
        await effect(
          "restore",
          async () => {
            const value = await this.ports.line.restore(grant.attemptId);
            if (!value.confirmed) throw Error("incoming_restore_unknown");
            return value;
          },
          "incoming_owner_restored",
        );
        restored = true;
      } catch {}
    }
    let released = false;
    if (clean && restored) {
      try {
        await effect(
          "session_release",
          async () => {
            this.ports.sessions.confirmClosed(grant.attemptId, {
              captureCleanupConfirmed: true,
              mediaClosed: true,
              providerEnded: true,
            });
          },
          "ephemeral_capability_retired",
        );
        released = true;
      } catch {}
    }
    const cleanupConfirmed = clean && restored && released;
    if (cleanupConfirmed) this.active = undefined;
    else outcome = "unknown";
    return {
      state: outcome,
      cleanupConfirmed,
      ...(outcome === "unknown"
        ? { reason: "provider_or_cleanup_outcome_unknown" }
        : outcome === "refused" && refusalReason
          ? { reason: refusalReason }
          : {}),
    };
  }
  /** Retire only an already reconciled in-process fence. This performs no provider
   * action, restoration, receipt rewriting, or inference from idle processes. */
  retireReconciled(attemptId: string) {
    if (!this.active) return;
    const intent = this.ports.coordinator.get(this.active.intent.id);
    if (
      intent.attemptId !== attemptId ||
      !["ended", "refused"].includes(intent.state) ||
      this.ports.coordinator.transport
        .list(attemptId)
        .some((receipt) => receipt.state !== "done") ||
      this.ports.sessions.status(attemptId) !== null
    )
      throw Error(
        "Exact settled call, transport receipts and retired capability required.",
      );
    this.active = undefined;
  }
  async stop(intent: ProactiveCallIntent) {
    if (this.active?.intent.id === intent.id) this.active.stopped = true;
  }
}
