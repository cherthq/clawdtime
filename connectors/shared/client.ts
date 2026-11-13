import type {
  AgentSession,
  AttentionRequest,
  HumanResponse,
  SessionRegistration,
  RequestAttentionInput,
  SetupTest,
} from "../../src/contracts.js";
import { ConnectorTiming, type ConnectorOperation } from "./timing.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function validateOrigin(raw: string): string {
  const u = new URL(raw);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.pathname !== "/" && u.pathname !== "")
  )
    throw new Error("Use a bare backend origin.");
  if (
    u.protocol !== "https:" &&
    !(
      u.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
    )
  )
    throw new Error("Backend requires HTTPS or loopback HTTP.");
  return u.origin;
}
export class ClawdTimeClient {
  readonly origin: string;
  private presentationSupport = new Map<string, boolean>();
  private interactionSupport = new Map<string, boolean>();
  private readonly timing = new ConnectorTiming();
  constructor(
    origin: string,
    private token: string,
    private request: typeof fetch = fetch,
  ) {
    this.origin = validateOrigin(origin);
  }
  async api<T>(path: string, body?: unknown, timeoutMs = 12_000): Promise<T> {
    const response = await this.request(`${this.origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.min(12_000, timeoutMs))),
    });
    if (!response.ok) {
      let reason: string | undefined;
      if (response.status === 409) {
        try {
          const body = (await response.json()) as { errorCode?: unknown };
          const messages: Record<string, string> = {
            setup_reserved:
              "This conversation has an unresolved setup reservation (409). Reconcile its call, media and input cleanup; no new call was requested.",
            reply_context_stale:
              "Newer input arrived (409). Poll and acknowledge all queued turns, reconsider the reply, then use the latest expectedCursor. No reply was submitted.",
            reply_exists:
              "This turn already has a reply (409). Reconcile the original receipt; do not replace its ID or repeat speech or messaging.",
            interaction_stale:
              "Newer input or an interruption holds computer control (409). Poll and acknowledge current turns, inspect execution status, and reconsider the action. Do not blindly replay input.",
            input_context_stale:
              "Newer input must be read and acknowledged before computer control (409). Poll current turns, inspect execution status, and reconsider the action. No automatic retry is permitted.",
            input_held:
              "Incoming speech temporarily holds new computer input (409). Keep polling for finalized instructions; an already-running native action may still finish.",
          };
          if (
            typeof body.errorCode === "string" &&
            Object.hasOwn(messages, body.errorCode)
          )
            reason = messages[body.errorCode];
        } catch {
          /* Unknown responses remain redacted. */
        }
      }
      // Do not echo arbitrary provider response bodies or bearer credentials to an agent.
      throw new ApiError(
        response.status,
        response.status === 401
          ? "ClawdTime credential is invalid or revoked (401). Obtain a fresh authorized pairing; preserve pending request IDs and never redial to recover them."
          : reason
            ? reason
            : response.status === 403
              ? "ClawdTime session or pairing is stopped or unauthorized (403). Inspect scoped status and reconcile pending work before reconnecting; native permissions are unchanged."
              : `ClawdTime request rejected (${response.status}); inspect doctor or the exact request status before retrying effects.`,
      );
    }
    return response.json() as Promise<T>;
  }
  register(input: SessionRegistration) {
    return this.api<{ session: AgentSession; token: string }>(
      "/api/sessions",
      input,
    );
  }
  requestAttention(input: RequestAttentionInput) {
    return this.api<{ request: AttentionRequest }>("/api/attention", input);
  }
  status(id: string) {
    return this.api<{ request: AttentionRequest }>(
      `/api/attention/${encodeURIComponent(id)}`,
    );
  }
  async diagnostics(id: string) {
    const result = await this.api<Record<string, unknown>>(
      `/api/attention/${encodeURIComponent(id)}/diagnostics`,
    );
    return { ...result, ...this.conversationTiming(id) };
  }
  result(id: string) {
    return this.api<{
      request: AttentionRequest;
      response?: HumanResponse;
      session?: AgentSession;
    }>(`/api/attention/${encodeURIComponent(id)}/result`);
  }
  ack(id: string, responseId: string) {
    return this.api(`/api/attention/${encodeURIComponent(id)}/ack`, {
      responseId,
    });
  }
  heartbeat() {
    return this.api<{ session: AgentSession }>("/api/sessions/heartbeat", {});
  }
  yield() {
    return this.api<{ session: AgentSession }>("/api/sessions/yield", {});
  }
  resume(id: string, controlEpoch: number) {
    return this.api<{ session: AgentSession; request: AttentionRequest }>(
      `/api/attention/${encodeURIComponent(id)}/resume`,
      { controlEpoch },
    );
  }
  acknowledgeTerminal(id: string, controlEpoch: number) {
    return this.api<{
      session: AgentSession;
      request: AttentionRequest;
      acknowledgement: {
        humanApproval: false;
        requestId: string;
        sessionId: string;
        controlEpoch: number;
        acknowledgedAt: number;
      };
    }>(`/api/attention/${encodeURIComponent(id)}/terminal-ack`, {
      controlEpoch,
    });
  }
  complete(id: string, text: string) {
    return this.api(`/api/attention/${encodeURIComponent(id)}/complete`, {
      text,
    });
  }
  async conversationTurns(id: string, after = 0, timeoutMs = 12_000) {
    const result = await this.timed(id, "poll", () =>
      this.api<{
        turns: unknown[];
        request?: { state: string };
        conversation?: { state: string };
        [key: string]: unknown;
      }>(
        `/api/attention/${encodeURIComponent(id)}/conversation/turns?after=${after}`,
        undefined,
        timeoutMs,
      ),
    );
    const capabilities = result.capabilities as
      | { presentationVersion?: unknown; interactionVersion?: unknown }
      | undefined;
    if (
      this.presentationSupport.size >= 100 &&
      !this.presentationSupport.has(id)
    )
      this.presentationSupport.delete(
        this.presentationSupport.keys().next().value!,
      );
    this.presentationSupport.set(id, capabilities?.presentationVersion === 1);
    if (this.interactionSupport.size >= 100 && !this.interactionSupport.has(id))
      this.interactionSupport.delete(
        this.interactionSupport.keys().next().value!,
      );
    this.interactionSupport.set(id, capabilities?.interactionVersion === 1);
    return result;
  }
  conversationInbox() {
    return this.api<{
      requests: Array<{
        id: string;
        sessionId: string;
        [key: string]: unknown;
      }>;
    }>("/api/conversation/inbox");
  }
  conversationExecution(id: string) {
    return this.timed(id, "execution_status", () =>
      this.api(
        `/api/attention/${encodeURIComponent(id)}/conversation/execution`,
      ),
    );
  }
  conversationTiming(id: string) {
    return { connectorTiming: this.timing.snapshot(id) };
  }
  private async timed<T>(
    id: string,
    operation: ConnectorOperation,
    run: () => Promise<T>,
  ): Promise<T> {
    const finish = this.timing.begin(id, operation);
    try {
      const value = await run();
      finish("completed");
      return value;
    } catch (error) {
      finish("failed");
      throw error;
    }
  }
  async conversationOperation(
    id: string,
    operation:
      | "ack"
      | "progress"
      | "reply"
      | "cancel"
      | "end"
      | "execution"
      | "observe"
      | "act",
    body: unknown,
  ) {
    if (
      body &&
      typeof body === "object" &&
      ((operation === "reply" && "channel" in body) ||
        ((operation === "execution" || operation === "act") &&
          "expectedCursor" in body))
    ) {
      if (!this.interactionSupport.has(id)) await this.conversationTurns(id);
      if (!this.interactionSupport.get(id))
        throw new Error(
          "This request has not negotiated iMessage-first interaction controls. No effect was submitted; preserve this session and its receipts.",
        );
    }
    if (
      operation === "progress" &&
      body &&
      typeof body === "object" &&
      "presentation" in body
    ) {
      // Negotiate with this exact request. Never retry an effect after a failed write.
      if (!this.presentationSupport.has(id)) await this.conversationTurns(id);
      if (!this.presentationSupport.get(id)) {
        const { presentation: _omitted, ...legacy } = body;
        body = legacy;
      }
    }
    return this.timed(id, operation, () =>
      this.api(
        `/api/attention/${encodeURIComponent(id)}/conversation/${operation}`,
        body,
      ),
    );
  }
  doctor() {
    return this.api<Record<string, unknown>>("/api/doctor");
  }
  disconnect() {
    return this.api("/api/disconnect", {});
  }
  setupStatus() {
    return this.api<{ test: SetupTest | null }>("/api/setup/test");
  }
  setupInvite() {
    return this.api<{ test: SetupTest }>("/api/setup/test", {});
  }
  setupAuthorize(testId: string, userAuthorizedCall: true) {
    return this.api<{ test: SetupTest }>("/api/setup/test/authorize", {
      testId,
      userAuthorizedCall,
    });
  }
  setupRetry(previousTestId: string) {
    return this.api<{ test: SetupTest }>("/api/setup/test/retry", {
      previousTestId,
    });
  }
  setupStart() {
    return this.api<{ test: SetupTest; request: AttentionRequest }>(
      "/api/setup/test/start",
      {},
    );
  }
  setupVerify() {
    return this.api<{ test: SetupTest }>("/api/setup/test/verify", {});
  }
  setupCancel() {
    return this.api<{ test: SetupTest | null }>("/api/setup/test/cancel", {});
  }
}
