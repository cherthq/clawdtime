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
  "ClawdTime is configured. Ready for one FaceTime video test showing this Mac’s selected screen? Reply YES when ready.";
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
        .find((t) => t.sessionId === session.id) ?? null;
    return { session, test };
  }
  get(raw: string) {
    return { test: this.current(raw).test };
  }
  invite(raw: string) {
    const { session, test } = this.current(raw);
    if (test) return { test };
    if (
      this.service.transport.mode === "live" &&
      !this.service.doctor(raw).readiness.liveReady
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
        createdAt = this.service.clock();
      const next: SetupTest = {
        id: testId,
        sessionId: session.id,
        pairingId: pairing.id,
        createdAt,
        expiresAt: createdAt + 600_000,
        state: "awaiting_approval",
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
        "Wait for the exact human YES before starting the test.",
      );
    if (session.state !== "yielded")
      throw new DomainError(
        409,
        "Yield the agent session before starting the test.",
      );
    return this.store.transaction(() => {
      const request = this.service.requestAttention(raw, {
        taskId: `setup:${test.id}`,
        idempotencyKey: `setup:${test.id}`,
        reason: "review",
        timeoutSeconds: 300,
        question:
          "ClawdTime setup test: if you can see this Mac’s selected screen, say ClawdTime answer I can see my screen, or text answer: I can see my screen. Otherwise tell us what failed.",
      });
      return {
        test: this.store.put<SetupTest>("setup_test", {
          ...test,
          state: "call_requested",
          requestId: request.id,
        }),
        request,
      };
    });
  }
  verify(raw: string) {
    const { session, test } = this.current(raw);
    if (!test || !test.requestId)
      throw new DomainError(409, "A setup call has not been requested.");
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
      response.text
        .trim()
        .toLowerCase()
        .replace(/[.!?]+$/, "")
        .trim()
        .replace(/\s+/g, " ") !== "i can see my screen" ||
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
      this.service.failCall(test.requestId);
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
    if (!["YES", "NO", "CANCEL"].includes(command)) return false;
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
        if (command !== "YES") {
          this.close(test, "canceled");
          handled = true;
        } else if (
          test.state === "awaiting_approval" &&
          this.store.effect(test.invitationEffectId)?.state === "done"
        ) {
          this.store.put<SetupTest>("setup_test", {
            ...test,
            state: "approved",
            approvedAt: this.service.clock(),
            approvalEventId: event.id,
          });
          handled = true;
        } else if (test.state === "approved") handled = true;
      }
      this.store.recordEvent(key, fingerprint, handled);
      return handled;
    });
  }
}
