import { z } from "zod";
import type {
  AgentSession,
  AttentionRequest,
  CallSession,
} from "../contracts.js";
import type { Store } from "../storage/store.js";

export const terminationSourceSchema = z.enum([
  "media_failure",
  "session_heartbeat_expired",
  "setup_canceled",
  "setup_expired",
  "request_completed",
  "pairing_revoked",
  "request_expired",
  "allocation_terminal",
  "worker_terminal",
  "standby",
  "integration_failure",
  "cleanup_only",
  "media_unavailable",
  "failure_unspecified",
]);
export type TerminationSource = z.infer<typeof terminationSourceSchema>;

/** First locally observed termination intent, not proof of an upstream root cause.
 * Do not attribute historical effects to a later cleanup callback. No effect or
 * receipt is changed here; the caller keeps its existing transaction boundary. */
export function recordTerminationIntent(
  store: Store,
  request: AttentionRequest,
  call: CallSession,
  source: TerminationSource,
  at: number,
  effectId: string | null = `${request.id}:end`,
) {
  try {
    const key = `call-termination:${request.id}`;
    if (
      store.state(key) ||
      (effectId !== null && store.effect(effectId)) ||
      store.effect(`${request.id}:end`) ||
      store.effect(`${request.id}:media-failure-end`) ||
      store.state(`cleanup:${call.id}`)
    )
      return;
    const session = store.get<AgentSession>("session", request.sessionId);
    const parsed = terminationSourceSchema.safeParse(source);
    const lastSeenAt = session?.lastSeenAt ?? session?.createdAt;
    store.saveState(key, {
      version: 1,
      source: parsed.success ? parsed.data : "failure_unspecified",
      at,
      requestId: request.id,
      callId: call.id,
      sessionId: request.sessionId,
      ...(effectId !== null ? { effectId } : {}),
      requestState: request.state,
      ...(session
        ? { sessionState: session.state, controlEpoch: session.controlEpoch }
        : {}),
      ...(lastSeenAt !== undefined
        ? {
            lastSeenAt,
            heartbeatAgeMs: Math.min(86400000, Math.max(0, at - lastSeenAt)),
          }
        : {}),
    });
  } catch {
    // Diagnostic persistence must not prevent the original cleanup attempt.
  }
}
