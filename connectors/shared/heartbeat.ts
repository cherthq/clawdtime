/** Liveness only: retrying this never retries calls, input, messages, or registration. */
export function startHeartbeat(
  send: () => Promise<unknown>,
  intervalMs = 5_000,
) {
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await send();
    } catch {
      /* Missing heartbeats expire the backend session; never revive it here. */
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
