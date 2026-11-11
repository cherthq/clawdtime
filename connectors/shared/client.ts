import type {
  AgentSession,
  AttentionRequest,
  HumanResponse,
  SessionRegistration,
  RequestAttentionInput,
  SetupTest,
} from "../../src/contracts.js";

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
  constructor(
    origin: string,
    private token: string,
    private request: typeof fetch = fetch,
  ) {
    this.origin = validateOrigin(origin);
  }
  async api<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.request(`${this.origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      // Do not echo arbitrary provider response bodies or bearer credentials to an agent.
      throw new ApiError(
        response.status,
        response.status === 401
          ? "ClawdTime credential is invalid or revoked (401). Obtain a fresh authorized pairing; preserve pending request IDs and never redial to recover them."
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
  diagnostics(id: string) {
    return this.api<Record<string, unknown>>(
      `/api/attention/${encodeURIComponent(id)}/diagnostics`,
    );
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
