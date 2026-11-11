import type {
  AgentSession,
  AttentionRequest,
  HumanResponse,
  SessionRegistration,
  RequestAttentionInput,
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
        `ClawdTime request rejected (${response.status}); inspect doctor or the exact request status before retrying effects.`,
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
}
