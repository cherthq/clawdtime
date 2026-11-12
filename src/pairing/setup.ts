import { setupInvitationReplacementAllowed } from "./retired-setup.js";
import type {
  AgentSession,
  AttentionRequest,
  HumanResponse,
  Pairing,
  SetupTest,
} from "../contracts.js";
import { ClawdTime } from "../attention/service.js";
import { DomainError, hash, id } from "../storage/security.js";
import type { NativeMessage } from "../transport/native-messages.js";

const invitation =
  "ClawdTime setup is ready. Your coding agent can place one FaceTime video test once you authorize it in your setup chat. You can speak naturally during the call.";
const open = new Set<SetupTest["state"]>([
  "awaiting_approval",
  "approved",
  "call_requested",
]);

/** A single human-approved test belongs to one authenticated agent session. */
export class SetupService {
  constructor(readonly service: ClawdTime) {}
  private get store() {
    return this.service.store;
  }
  private current(raw: string) {
    const session = this.service.authenticateSession(raw);
    this.expire();
    const test =
      this.store
        .all<SetupTest>("setup_test")
        .filter((t) => t.sessionId === session.id)
        .sort(
          (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
        )[0] ?? null;
    return { session, test };
  }
  get(raw: string) {
    return { test: this.current(raw).test };
  }
  invite(raw: string) {
    const { session, test } = this.current(raw);
    if (test) return { test };
    return this.create(session, undefined, raw);
  }
  retry(raw: string, previousTestId: string) {
    const { session, test } = this.current(raw);
    const effect = test
      ? this.store.effect(test.invitationEffectId)
      : undefined;
    if (
      this.service.transport.mode !== "live" ||
      !test ||
      test.id !== previousTestId ||
      !effect ||
      session.state !== "active" ||
      !Number.isFinite(session.lastSeenAt) ||
      this.service.clock() - session.lastSeenAt! > 20_000 ||
      session.lastSeenAt! > this.service.clock() + 1000 ||
      !setupInvitationReplacementAllowed(
        this.store,
        effect,
        this.service.clock(),
      )
    )
      throw new DomainError(
        409,
        "An exact retired expired invitation in this live session is required before a new attempt.",
      );
    return this.create(session, previousTestId, raw);
  }
  private create(session: AgentSession, previousTestId?: string, raw?: string) {
    if (
      this.service.transport.mode === "live" &&
      !this.service.doctor(raw!).readiness.liveReady
    )
      throw new DomainError(
        409,
        "Resolve the live doctor readiness checks before inviting a setup test.",
      );
    const pairing = this.service.pairing(session.pairingId);
    if (!pairing.allowView || !session.capabilities.cooperativePause)
      throw new DomainError(
        409,
        "Setup testing requires screen permission and cooperative agent yielding.",
      );
    return this.store.transaction(() => {
      if (
        this.store.all<SetupTest>("setup_test").some((t) => {
          const p = this.store.get<Pairing>("pairing", t.pairingId);
          return (
            open.has(t.state) &&
            p?.lineId === pairing.lineId &&
            p.recipient === pairing.recipient &&
            p.conversationId === pairing.conversationId
          );
        })
      )
        throw new DomainError(
          409,
          "Another session already owns the setup test for this conversation.",
        );
      const testId = id("setup"),
        createdAt = Math.max(
          this.service.clock(),
          ...this.store
            .all<SetupTest>("setup_test")
            .filter((t) => t.sessionId === session.id)
            .map((t) => t.createdAt + 1),
        );
      const next: SetupTest = {
        id: testId,
        sessionId: session.id,
        pairingId: pairing.id,
        createdAt,
        expiresAt: createdAt + 600_000,
        state: "awaiting_approval",
        approvalMode: "native_session",
        ...(previousTestId ? { previousTestId } : {}),
        invitationEffectId: `${testId}:invite`,
      };
      this.store.put("setup_test", next);
      this.store.putEffect({
        id: next.invitationEffectId,
        kind: "message",
        state: "pending",
        createdAt,
        payload: {
          setupTestId: next.id,
          pairingId: pairing.id,
          text: invitation,
        },
      });
      return { test: next };
    });
  }
  authorize(raw: string, testId: string, userAuthorizedCall: true) {
    const { session, test } = this.current(raw);
    const now = this.service.clock();
    if (
      userAuthorizedCall !== true ||
      !test ||
      test.id !== testId ||
      test.approvalMode !== "native_session" ||
      !["awaiting_approval", "approved"].includes(test.state) ||
      test.requestId ||
      !["active", "yielded"].includes(session.state) ||
      now - (session.lastSeenAt ?? session.createdAt) > 20_000 ||
      (session.lastSeenAt ?? session.createdAt) > now + 1000
    )
      throw new DomainError(
        409,
        "A current unexpired test in this originating session and explicit one-call authorization are required.",
      );
    this.service.pairing(session.pairingId);
    if (test.state === "approved") return { test };
    const eventId = `native-setup-consent:${test.id}`;
    return this.store.transaction(() => {
      const approved = this.store.put<SetupTest>("setup_test", {
        ...test,
        state: "approved",
        approvalSource: "native_session",
        approvedAt: now,
        approvalEventId: eventId,
        expiresAt: now + 600_000,
      });
      this.store.recordEvent(
        eventId,
        hash(
          JSON.stringify({ testId, sessionId: session.id, userAuthorizedCall }),
        ),
        {
          testId,
          sessionId: session.id,
          source: "native_session",
          approvedAt: now,
        },
      );
      return { test: approved };
    });
  }
  start(raw: string) {
    const { session, test } = this.current(raw);
    if (!test)
      throw new DomainError(404, "Invite the human to a setup test first.");
    if (test.requestId) {
      if (!["call_requested", "verified"].includes(test.state))
        throw new DomainError(409, "Setup test is closed.");
      return { test, request: this.service.status(raw, test.requestId) };
    }
    if (
      test.state !== "approved" ||
      !test.approvalEventId ||
      test.approvedAt === undefined
    )
      throw new DomainError(
        409,
        "Record explicit authorization for this one test from the originating chat before starting.",
      );
    if (
      test.approvalMode === "native_session" &&
      this.store.effect(test.invitationEffectId)?.state !== "done"
    )
      throw new DomainError(
        409,
        "Wait for the setup notice delivery receipt; do not resend an uncertain notice.",
      );
    if (session.protocolVersion !== 2 && session.state !== "yielded")
      throw new DomainError(
        409,
        "Yield the agent session before starting the test.",
      );
    return this.store.transaction(() => {
      const request = this.service.requestAttention(raw, {
        taskId: `setup:${test.id}`,
        idempotencyKey: `setup:${test.id}`,
        reason: "review",
        question: "Continue the paired conversation.",
      });
      return {
        test: this.store.put<SetupTest>("setup_test", {
          ...test,
          state: "call_requested",
          requestId: request.id,
          expiresAt: request.deadline,
        }),
        request,
      };
    });
  }
  verify(raw: string) {
    const { session, test } = this.current(raw);
    if (!test || !test.requestId)
      throw new DomainError(409, "A setup call has not been requested.");
    if (session.protocolVersion === 2)
      throw new DomainError(
        409,
        "Agent-owned setup requires separately recorded physical acceptance; legacy verification does not qualify this protocol.",
      );
    if (test.state === "verified") return { test };
    if (test.state !== "call_requested")
      throw new DomainError(409, "Setup test is closed.");
    const request = this.service.status(raw, test.requestId);
    const connected = this.store.state<{ callId: string; live: boolean }>(
      `call-connected:${request.id}`,
    );
    const view = this.store.state<{
      requestId: string;
      callId: string;
      sessionId: string;
      pairingId: string;
      frameId: string;
      capturedAt: number;
      observedAt: number;
      live: boolean;
    }>(`setup-view:${request.id}`);
    const response = request.responseId
      ? this.store.get<HumanResponse>("response", request.responseId)
      : undefined;
    const screenFeedback = this.store.state<{
      eventId: string;
      requestId: string;
      sessionId: string;
      pairingId: string;
      callId: string;
      visible: boolean;
      reportedAt: number;
    }>(`screen-feedback:${request.id}`);
    const result = this.store.effect(`${request.id}:result`);
    if (
      this.service.transport.mode !== "live" ||
      !connected?.live ||
      !view?.live ||
      view.callId !== connected.callId ||
      view.requestId !== request.id ||
      view.sessionId !== session.id ||
      view.pairingId !== session.pairingId ||
      !view.frameId ||
      !Number.isFinite(view.capturedAt) ||
      !Number.isFinite(view.observedAt) ||
      view.capturedAt < request.createdAt ||
      view.observedAt - view.capturedAt > 2000 ||
      view.capturedAt > view.observedAt + 250 ||
      !response ||
      response.requestId !== request.id ||
      response.acknowledgedSessionId !== session.id ||
      response.acknowledgedAt === undefined ||
      (test.approvalMode === "native_session"
        ? !(
            screenFeedback?.visible === true &&
            !!screenFeedback.eventId &&
            screenFeedback.requestId === request.id &&
            screenFeedback.sessionId === session.id &&
            screenFeedback.pairingId === session.pairingId &&
            screenFeedback.callId === connected.callId &&
            Number.isFinite(screenFeedback.reportedAt) &&
            screenFeedback.reportedAt >= view.observedAt &&
            screenFeedback.reportedAt <= response.createdAt
          )
        : response.text
            .trim()
            .toLowerCase()
            .replace(/[.!?]+$/, "")
            .trim()
            .replace(/\s+/g, " ") !== "i can see my screen") ||
      response.createdAt < view.observedAt ||
      request.state !== "completed" ||
      result?.state !== "done" ||
      result.result?.accepted !== true ||
      result.result?.simulated === true ||
      result.result?.status !== "acknowledged" ||
      typeof result.result?.receiptId !== "string" ||
      !result.result.receiptId
    )
      throw new DomainError(
        409,
        "Verification requires a real qualified call, observed screen, acknowledged human feedback, agent continuation, and a Messages result receipt.",
      );
    return {
      test: this.store.put<SetupTest>("setup_test", {
        ...test,
        state: "verified",
        verifiedAt: this.service.clock(),
      }),
    };
  }
  private close(test: SetupTest, state: "canceled" | "expired") {
    if (!open.has(test.state)) return test;
    if (test.requestId) {
      this.service.failCall(
        test.requestId,
        state === "canceled" ? "setup_canceled" : "setup_expired",
      );
      const request = this.store.get<AttentionRequest>(
        "attention",
        test.requestId,
      )!;
      if (request.state !== "completed")
        this.store.put("attention", { ...request, state });
    }
    const effect = this.store.effect(test.invitationEffectId);
    if (effect?.state === "pending")
      this.store.putEffect({
        ...effect,
        state: "failed",
        result: { reason: "Setup approval window closed before dispatch." },
      });
    return this.store.put<SetupTest>("setup_test", { ...test, state });
  }
  cancel(raw: string) {
    const { test } = this.current(raw);
    return {
      test: test
        ? this.store.transaction(() => this.close(test, "canceled"))
        : null,
    };
  }
  expire() {
    for (const test of this.store.all<SetupTest>("setup_test")) {
      if (!open.has(test.state)) continue;
      const session = this.store.get<AgentSession>("session", test.sessionId),
        pairing = this.store.get<Pairing>("pairing", test.pairingId);
      if (
        test.expiresAt <= this.service.clock() ||
        !session ||
        session.state === "stopped" ||
        !pairing ||
        pairing.revokedAt !== undefined
      )
        this.store.transaction(() =>
          this.close(
            test,
            test.expiresAt <= this.service.clock() ? "expired" : "canceled",
          ),
        );
    }
  }
  /** Accept only already authenticated native DMs; never call this with client input. */
  receive(event: NativeMessage): boolean {
    this.expire();
    const command = event.text.trim().toUpperCase();
    if (
      !["YES", "NO", "CANCEL"].includes(command) &&
      !/^YES [A-F0-9]{8}$/.test(command)
    )
      return false;
    return this.store.transaction(() => {
      const key = `setup-approval:${event.id}`,
        fingerprint = hash(JSON.stringify(event));
      const previous = this.store.event<boolean>(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new DomainError(409, "Setup approval event changed.");
        return previous.result;
      }
      const candidates = this.store.all<SetupTest>("setup_test").filter((t) => {
        const p = this.store.get<Pairing>("pairing", t.pairingId);
        return (
          t.approvalMode !== "native_session" &&
          open.has(t.state) &&
          p?.revokedAt === undefined &&
          p?.recipient === event.sender &&
          p.lineId === event.lineId &&
          p.conversationId === event.conversationId
        );
      });
      let handled = false;
      if (candidates.length === 1) {
        const test = candidates[0]!;
        const yes = test.approvalCode
          ? command === `YES ${test.approvalCode}`
          : command === "YES";
        if (command === "NO" || command === "CANCEL") {
          this.close(test, "canceled");
          handled = true;
        } else if (
          yes &&
          test.state === "awaiting_approval" &&
          this.store.effect(test.invitationEffectId)?.state === "done"
        ) {
          const approvedAt = this.service.clock();
          this.store.put<SetupTest>("setup_test", {
            ...test,
            state: "approved",
            approvedAt,
            expiresAt: approvedAt + 600_000,
            approvalEventId: event.id,
          });
          handled = true;
        } else if (yes && test.state === "approved") handled = true;
      }
      this.store.recordEvent(key, fingerprint, handled);
      return handled;
    });
  }
}
