/**
 * Bounded reporting for unexpected failures. A record carries the error class,
 * a provider HTTP status when the message is exactly that fixed form, and stack
 * frames. Error messages are never written: validators and providers can echo
 * configuration, human text, phone numbers or credentials.
 */
export type ReportError = (
  event: "request_failed" | "loop_failed" | "startup_refused",
  error: unknown,
  fields?: { requestId?: string; method?: string; route?: string },
) => void;

const providerStatus = /^Provider returned HTTP (\d{3})\.$/;

function frames(error: Error) {
  const stack = error.stack ?? "",
    head = `${error.name}: ${error.message}`;
  return (stack.startsWith(head) ? stack.slice(head.length) : stack)
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .slice(0, 5)
    .map((line) => line.trim().slice(0, 300));
}

export function createErrorReporter(
  options: {
    write?: (line: string) => void;
    clock?: () => number;
    /** A repeating failure without a request ID is written once per interval. */
    intervalMs?: number;
  } = {},
): ReportError {
  const write =
      options.write ??
      ((line: string) => void process.stderr.write(`${line}\n`)),
    clock = options.clock ?? Date.now,
    intervalMs = options.intervalMs ?? 60_000,
    seen = new Map<string, { at: number; repeats: number }>();
  return (event, error, fields = {}) => {
    const known = error instanceof Error,
      name = known ? error.name.slice(0, 80) : "NonError",
      stack = known ? frames(error) : [],
      status = known ? providerStatus.exec(error.message) : null,
      now = clock();
    let repeats = 0;
    if (!fields.requestId) {
      const key = `${event}|${name}|${stack[0] ?? ""}`,
        previous = seen.get(key);
      if (previous && now - previous.at < intervalMs) {
        previous.repeats += 1;
        return;
      }
      repeats = previous?.repeats ?? 0;
      if (seen.size >= 100) seen.clear();
      seen.set(key, { at: now, repeats: 0 });
    }
    write(
      JSON.stringify({
        at: new Date(now).toISOString(),
        level: "error",
        event,
        ...fields,
        name,
        ...(status ? { providerStatus: Number(status[1]) } : {}),
        ...(repeats ? { repeats } : {}),
        frames: stack,
      }),
    );
  };
}

export const reportError = createErrorReporter();
