/**
 * The output of the desktop service when its launcher gives it the startup
 * log of its state folder (CLAWDTIME_SERVICE_OUTPUT=log). Every write is
 * masked first: keys, tokens, phone numbers and email addresses never reach
 * the file. One run writes at most `serviceOutputLimit` bytes. An error that
 * stops the service becomes one marked line, so the launcher can say why the
 * service stopped. The service imports this module first, so the masking is
 * in place before any other module runs.
 */

/** The most bytes that one run of the service writes to its log. */
export const serviceOutputLimit = 1024 * 1024;
/** The line of a startup that the service refused, with its kind. */
export const refusedMarker = "desktop-start-refused";
/** The line of any other error that stopped the service. */
export const errorMarker = "desktop-service-error";

export type RefusalKind = "session_open_work" | "session_revoked";

/** A startup that the service refuses on purpose, with words for the person. */
export class DesktopRefusal extends Error {
  constructor(
    readonly kind: RefusalKind,
    message: string,
  ) {
    super(message);
  }
}

const opaque = /[A-Za-z0-9_-]{24,}/g;
/** A longer write is cut: the patterns below stay linear on any input. */
const writeLimit = 64 * 1024;

/**
 * Masks keys, tokens, phone numbers and email addresses in service output.
 * Every pattern starts at a fixed character or has bounded repeats, so a
 * long line costs linear time.
 */
export function redactOutput(text: string): string {
  return (
    text
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
      .replace(
        /\b([A-Za-z_]{0,40}(?:key|token|secret|password|credential)[A-Za-z_]{0,40})("?\s{0,4}[:=]\s{0,4}"?)([^\s",}']+)/gi,
        "$1$2[redacted]",
      )
      .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
      // A long run of letters and digits is a token, a key or an id.
      .replace(opaque, (run) =>
        /\d/.test(run) && /[A-Za-z]/.test(run) ? "[redacted]" : run,
      )
      .replace(
        /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g,
        "[email]",
      )
      .replace(/\+\d[\d ().-]{6,18}\d/g, "[phone]")
      .replace(/\(\d{3}\)\s?\d{3}[-.\s]\d{4}/g, "[phone]")
      .replace(/\b\d{3}[-.]\d{3}[-.]\d{4}\b/g, "[phone]")
  );
}

/** The one marked line of an error that stops the service. */
export function failureLine(error: unknown): string {
  const text =
    error instanceof DesktopRefusal
      ? `${refusedMarker} ${error.kind}: ${error.message}`
      : `${errorMarker}: ${error instanceof Error ? error.message : String(error)}`;
  return redactOutput(text.replace(/\s*\n\s*/g, " "));
}

type Write = (
  chunk: string | Uint8Array,
  encoding?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void,
) => boolean;

/** Masks and bounds the output of this process, and marks a fatal error. */
export function installServiceOutput(
  env: Record<string, string | undefined> = process.env,
  streams: Array<Pick<NodeJS.WriteStream, "write">> = [
    process.stdout,
    process.stderr,
  ],
  exit: (code: number) => void = (code) => process.exit(code),
  events: Pick<NodeJS.EventEmitter, "on"> = process,
) {
  if (env.CLAWDTIME_SERVICE_OUTPUT !== "log") return false;
  let written = 0;
  let full = false;
  for (const stream of streams) {
    const original = stream.write.bind(stream) as Write;
    (stream as { write: Write }).write = (chunk, encoding, callback) => {
      const done = typeof encoding === "function" ? encoding : callback;
      if (full) {
        if (done) queueMicrotask(() => done());
        return true;
      }
      let raw =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      if (raw.length > writeLimit)
        raw = `${raw.slice(0, writeLimit)} [the rest of this write is cut]\n`;
      let text = redactOutput(raw);
      if (written + Buffer.byteLength(text) > serviceOutputLimit) {
        full = true;
        text = "The service output stops here: its log reached its limit.\n";
      }
      written += Buffer.byteLength(text);
      return done ? original(text, done) : original(text);
    };
  }
  const fail = (error: unknown) => {
    streams[streams.length - 1]!.write(`${failureLine(error)}\n`);
    if (!(error instanceof DesktopRefusal) && error instanceof Error)
      streams[streams.length - 1]!.write(`${error.stack ?? ""}\n`);
    exit(1);
  };
  events.on("uncaughtException", fail);
  events.on("unhandledRejection", fail);
  return true;
}

installServiceOutput();
