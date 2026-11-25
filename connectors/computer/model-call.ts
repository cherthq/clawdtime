/**
 * Computer use: one call to the language model that lives through ordinary
 * trouble.
 *
 * A call to the language model has no effect on the Mac. So it is the one
 * thing here that may go out again after a failure: a busy service, a reset
 * connection or a slow answer is asked again after a short wait, inside a
 * fixed time for the whole call. An answer that only the person can fix (no
 * quota, a refused key, a bad request) goes back at once.
 *
 * A planner that fails again and again across calls stops asking for a short
 * cool-down, then lets one call through to see whether the service is back.
 *
 * Nothing in an error from here holds the request, the image, the key or the
 * body of an answer. Only a status, an error code of the service or a code of
 * the network is named.
 */

/** Why a call to the language model did not give an action. */
export type PlannerTrouble =
  /** 408, 409, 425, 429, 500, 502, 503, 504, a reset connection, a timeout. */
  | "transient"
  /** 429 with insufficient_quota, or a billing error: a retry will not help. */
  | "quota"
  /** 401, or 403 after the model fallback. */
  | "auth"
  /** No tool call, bad JSON, an unknown function or invalid arguments, after one repair. */
  | "malformed"
  /** The model refused: a content filter, or refusal text with no tool call. */
  | "refused"
  | "other";

/** A failure of the planner. The message holds no request text, no image and no key. */
export class PlannerError extends Error {
  constructor(
    readonly trouble: PlannerTrouble,
    message: string,
    /** How long to wait before the next call, when that is known. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PlannerError";
  }
}

/** The numbers of one call. `docs/COMPUTER_USE.md` lists them under Limits. */
export interface RetryPolicy {
  /** The most requests for one answer, the first one included. */
  attempts: number;
  /** The first wait before a retry. Each wait after it can be twice as long. */
  baseMs: number;
  /** The longest wait that the doubling reaches. */
  capMs: number;
  /** The time for one request, from its start to the end of its answer. */
  attemptTimeoutMs: number;
  /** The time for the whole call: every request, every wait and the repair. */
  budgetMs: number;
  /** The longest wait that the service may ask for with Retry-After. */
  retryAfterCapMs: number;
  /** A retry starts only when this much of the budget is left after its wait. */
  minAttemptMs: number;
  /** Transient failures in a row, across calls, that open the breaker. */
  breakerThreshold: number;
  /** How long an open breaker fails every call at once. */
  breakerCooldownMs: number;
}

export const defaultRetryPolicy: RetryPolicy = {
  attempts: 4,
  baseMs: 400,
  capMs: 8_000,
  attemptTimeoutMs: 45_000,
  budgetMs: 75_000,
  retryAfterCapMs: 20_000,
  minAttemptMs: 2_000,
  breakerThreshold: 8,
  breakerCooldownMs: 30_000,
};

/** Time for the call. Tests replace all three, so that no test waits. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
}

/** A wait on a real timer. It ends early, with the reason, when the signal aborts. */
export const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: realSleep,
  random: () => Math.random(),
};

/**
 * Called after each request that failed, with the number of that request,
 * the trouble, and the wait before the next request. The wait is null when no
 * request follows. A repair of a malformed answer comes with a wait of 0.
 */
export type AttemptReport = (
  attempt: number,
  trouble: PlannerTrouble,
  delayMs: number | null,
) => void;

/** Codes of the service that say the money or the quota of the key is gone. */
const quotaCodes = new Set([
  "insufficient_quota",
  "billing_hard_limit_reached",
  "billing_not_active",
]);
/** Statuses that a later request can pass. */
const transientStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
/** Codes of the network that a later request can pass. */
const networkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
]);
/** A code of the network is named in a message only in this plain shape. */
const plainCode = /^[A-Z0-9_]{1,64}$/;
/** An error code of the service is named only in this shape: a key never has it. */
const serviceCode = /^[a-z][a-z0-9_]{0,63}$/;
/** No Retry-After counts for more than a day. */
const longestHint = 86_400_000;

/** What a status says, with the error code of the service when it sent one. */
export function statusTrouble(
  status: number,
  code: string | null,
): PlannerTrouble {
  if (status === 402) return "quota";
  if (status === 429 && code !== null && quotaCodes.has(code)) return "quota";
  if (transientStatuses.has(status)) return "transient";
  if (status === 401 || status === 403) return "auth";
  return "other";
}

/**
 * The error code in the body of a failed answer, or null. Only `error.code`
 * or `error.type` is read, and only a short plain word is kept: the rest of
 * the body can echo the request.
 */
export function errorCode(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const error =
    parsed && typeof parsed === "object"
      ? (parsed as { error?: unknown }).error
      : undefined;
  if (!error || typeof error !== "object") return null;
  const { code, type } = error as { code?: unknown; type?: unknown };
  for (const value of [code, type])
    if (typeof value === "string" && serviceCode.test(value)) return value;
  return null;
}

/**
 * The wait that the service asks for, in milliseconds: `retry-after-ms`
 * first, then `retry-after` in seconds or as an HTTP date. Undefined when it
 * asks for none or the value cannot be read.
 */
export function retryAfterMs(
  headers: Headers,
  now: number,
): number | undefined {
  const exact = headers.get("retry-after-ms")?.trim();
  if (exact && /^\d+(?:\.\d+)?$/.test(exact))
    return Math.min(longestHint, Math.ceil(Number(exact)));
  const after = headers.get("retry-after")?.trim();
  if (!after) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(after))
    return Math.min(longestHint, Math.ceil(Number(after) * 1000));
  const date = Date.parse(after);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(longestHint, Math.max(0, date - now));
}

/** The wait before retry `attempt` (1 for the first retry): full jitter on a doubling, up to the cap. */
export function backoffMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number,
) {
  const ceiling = Math.min(
    policy.capMs,
    policy.baseMs * 2 ** Math.max(0, attempt - 1),
  );
  return Math.floor(Math.min(1, Math.max(0, random())) * ceiling);
}

/**
 * The trouble of a request that threw. A timeout of the request and every
 * error of the network is transient. What the caller aborted is not judged
 * here: the caller's own reason goes back.
 */
export function thrownTrouble(error: unknown, timer: AbortSignal) {
  const timeout = () =>
    new PlannerError("transient", "The language model did not answer in time.");
  if (error instanceof PlannerError) return error;
  if (timer.aborted) return timeout();
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return timeout();
  const code = networkCode(error);
  if (code !== null || error instanceof TypeError)
    return new PlannerError(
      "transient",
      `The language model could not be reached${code ? ` (${code})` : ""}.`,
    );
  return new PlannerError("other", "The request to the language model failed.");
}

/** The code of a network error, on the error or on its cause. Null when it has none of the known ones. */
function networkCode(error: unknown): string | null {
  for (let at = error, depth = 0; at && depth < 4; depth++) {
    const code = (at as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      (networkCodes.has(code) || code.startsWith("UND_ERR_")) &&
      plainCode.test(code)
    )
      return code;
    at = (at as { cause?: unknown }).cause;
  }
  return null;
}

/** The promise, or the reason of the signal as soon as it aborts. */
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const openText =
  "The language model failed too often in a row. The planner waits before it asks again.";

/**
 * A breaker for one planner. Transient failures in a row, across calls, open
 * it. While it is open every call fails at once with the time that is left.
 * After the cool-down one request goes through as a probe: an answer closes
 * the breaker, and a transient failure opens it again.
 */
export class CircuitBreaker {
  private failures = 0;
  private openUntil: number | null = null;
  private probing = false;
  constructor(
    private readonly policy: RetryPolicy,
    private readonly now: () => number,
  ) {}

  /** Throws while the breaker is open. True when this request is the probe. */
  admit(): boolean {
    if (this.openUntil === null) return false;
    const left = this.openUntil - this.now();
    if (left > 0) throw new PlannerError("transient", openText, left);
    // One probe at a time. Another call waits for its result.
    if (this.probing)
      throw new PlannerError("transient", openText, this.policy.baseMs);
    this.probing = true;
    return true;
  }

  /** The service answered: whatever the answer says, it is reachable. */
  success() {
    this.failures = 0;
    this.openUntil = null;
    this.probing = false;
  }

  /** One more transient failure. The cool-down when the breaker opens now, else null. */
  failure(probe: boolean): number | null {
    this.failures++;
    if (probe || this.failures >= this.policy.breakerThreshold) {
      this.openUntil = this.now() + this.policy.breakerCooldownMs;
      this.probing = false;
      return this.policy.breakerCooldownMs;
    }
    return null;
  }

  /** The probe ended with no result, because the caller aborted it. */
  release(probe: boolean) {
    if (probe) this.probing = false;
  }
}

/** What one request gave: a value, or a failure with its trouble. */
export type Attempt<T> =
  | { ok: true; value: T }
  | { ok: false; error: PlannerError; retryAfterMs?: number };

/**
 * One answer of the language model, with retries. `send` makes one request
 * with the signal that it gets. It ends at the caller's abort, at the time of
 * one request, or at the budget, whichever comes first.
 *
 * Only transient trouble is asked again. Any other answer of the service goes
 * back at once, and it also tells the breaker that the service is there.
 * The caller's abort ends every wait and every request at once, with the
 * caller's own reason.
 */
export async function callWithRetries<T>(
  send: (signal: AbortSignal) => Promise<Attempt<T>>,
  options: {
    signal?: AbortSignal | undefined;
    /** The time, on the clock, at which the whole call ends. */
    deadline: number;
    policy: RetryPolicy;
    clock: Clock;
    breaker: CircuitBreaker;
    onAttempt?: AttemptReport | undefined;
  },
): Promise<T> {
  const { signal, deadline, policy, clock, breaker } = options;
  const report = (
    attempt: number,
    trouble: PlannerTrouble,
    delay: number | null,
  ) => {
    try {
      options.onAttempt?.(attempt, trouble, delay);
    } catch {
      // A report that fails changes nothing.
    }
  };
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw signal.reason;
    const probe = breaker.admit();
    const left = deadline - clock.now();
    const timer = AbortSignal.timeout(
      Math.max(1, Math.min(policy.attemptTimeoutMs, left)),
    );
    const both = signal ? AbortSignal.any([signal, timer]) : timer;
    let result: Attempt<T>;
    try {
      result = await abortable(send(both), both);
    } catch (error) {
      if (signal?.aborted) {
        breaker.release(probe);
        throw signal.reason;
      }
      result = { ok: false, error: thrownTrouble(error, timer) };
    }
    if (result.ok) {
      breaker.success();
      return result.value;
    }
    const { error } = result;
    if (error.trouble !== "transient") {
      breaker.success();
      report(attempt, error.trouble, null);
      throw error;
    }
    const opened = breaker.failure(probe);
    if (opened !== null) {
      report(attempt, "transient", null);
      throw new PlannerError("transient", openText, opened);
    }
    const asked = result.retryAfterMs;
    const fail = (wait?: number) => {
      report(attempt, "transient", null);
      return wait === undefined
        ? error
        : new PlannerError("transient", error.message, wait);
    };
    // The service asks for a longer wait than one call may take: the caller
    // hears how long, and decides.
    if (asked !== undefined && asked > policy.retryAfterCapMs)
      throw fail(asked);
    if (attempt >= policy.attempts) throw fail(asked);
    const delay =
      asked !== undefined && asked > 0
        ? asked
        : backoffMs(attempt, policy, clock.random);
    if (clock.now() + delay + policy.minAttemptMs > deadline)
      throw fail(asked ?? delay);
    report(attempt, "transient", delay);
    try {
      await abortable(clock.sleep(delay, signal), signal);
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new PlannerError("other", "The wait before a retry failed.");
    }
  }
}
