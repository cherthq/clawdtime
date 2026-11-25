/**
 * A small client for the Chrome DevTools Protocol.
 *
 * A browser of the Chromium family that starts with a remote debugging port
 * takes commands as JSON messages over one WebSocket. Each command carries a
 * number, and the answer carries the same number. Events carry a method name
 * and no number. A command for one page carries the session of that page, so
 * every page travels over the one connection to the browser itself.
 *
 * Where it connects. Only to 127.0.0.1, only by WebSocket, and only to the
 * browser endpoint, `/devtools/browser/<id>`. The port and the id come from
 * the browser's own `DevToolsActivePort` file; this module never asks the
 * HTTP side of the port for an address, so no answer can send it elsewhere.
 */

/** One message pipe to the browser. */
export interface DevToolsPipe {
  send(text: string): void;
  close(): void;
}
export interface DevToolsPipeHandlers {
  message(text: string): void;
  /** The pipe closed: the browser ended, or the connection broke. */
  closed(): void;
}
/** Opens one pipe. It rejects when the connection does not open in time. */
export type DevToolsDial = (
  url: string,
  handlers: DevToolsPipeHandlers,
  timeoutMs: number,
) => Promise<DevToolsPipe>;

/** A command that the browser refused, with its words. */
export class DevToolsError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}
/**
 * The connection closed before the answer came. `sent` says whether the
 * command had gone out: then the browser may have done it.
 */
export class DevToolsClosed extends Error {
  constructor(
    message: string,
    readonly sent: boolean,
  ) {
    super(message);
  }
}
/** The command went out and no answer came in time. */
export class DevToolsTimeout extends Error {}

const loopback = "127.0.0.1";
const browserPath = /^\/devtools\/browser\/[A-Za-z0-9-]{1,100}$/;

/** The address of the browser endpoint on this computer. */
export function browserEndpoint(port: number, path: string) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error("The DevTools port is not a port number.");
  if (!browserPath.test(path))
    throw new Error("The DevTools path is not the path of a browser.");
  return `ws://${loopback}:${port}${path}`;
}

/**
 * The address again, when it is exactly a browser endpoint on 127.0.0.1.
 * Anything else throws: another host, a name that could lead elsewhere, a
 * user, a query or another path.
 */
export function checkedEndpoint(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The DevTools address is not an address.");
  }
  if (
    parsed.protocol !== "ws:" ||
    parsed.hostname !== loopback ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !parsed.port
  )
    throw new Error(
      "ClawdTime connects to a browser on 127.0.0.1 only, through its own DevTools port.",
    );
  const built = browserEndpoint(Number(parsed.port), parsed.pathname);
  if (built !== url)
    throw new Error("The DevTools address is not in its plain form.");
  return built;
}

/**
 * The port and the path in the text of a `DevToolsActivePort` file: the port
 * on the first line, the path of the browser endpoint on the second. Null
 * when the text is anything else.
 */
export function readActivePort(
  text: string,
): { port: number; path: string } | null {
  const lines = text.split("\n").map((line) => line.trim());
  if (lines.length < 2 || lines.slice(2).some((line) => line !== ""))
    return null;
  const [portText, path] = lines as [string, string];
  if (!/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65_535 || !browserPath.test(path)) return null;
  return { port, path };
}

/** The WebSocket of Node itself. */
export const dialWebSocket: DevToolsDial = (url, handlers, timeoutMs) =>
  new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(checkedEndpoint(url));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let open = false;
    let ended = false;
    const timer = setTimeout(() => {
      if (open) return;
      ended = true;
      try {
        socket.close();
      } catch {
        // It closes on its own.
      }
      reject(new Error("The browser's DevTools port did not answer in time."));
    }, timeoutMs);
    socket.onopen = () => {
      if (ended) return;
      open = true;
      clearTimeout(timer);
      resolve({
        send: (text) => socket.send(text),
        close: () => socket.close(),
      });
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") handlers.message(event.data);
    };
    socket.onerror = () => {
      // A close event follows. Before the open, it is the failure.
    };
    socket.onclose = () => {
      clearTimeout(timer);
      if (open) return handlers.closed();
      if (ended) return;
      ended = true;
      reject(new Error("The browser's DevTools port refused the connection."));
    };
  });

type Listener = (params: Record<string, unknown>, session?: string) => void;
interface Waiting {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
const oneLine = (value: unknown, max: number) =>
  String(value ?? "")
    .replace(/[\p{C}\s]+/gu, " ")
    .trim()
    .slice(0, max);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One connection to one browser. */
export class DevToolsConnection {
  private next = 1;
  private pipe: DevToolsPipe | null = null;
  private ended = false;
  private readonly waiting = new Map<number, Waiting>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly closers = new Set<() => void>();

  private constructor() {}

  /** Connects to a browser endpoint on 127.0.0.1. Any other address is refused before a byte goes out. */
  static async open(
    url: string,
    dial: DevToolsDial = dialWebSocket,
    timeoutMs = 5000,
  ): Promise<DevToolsConnection> {
    const endpoint = checkedEndpoint(url);
    const connection = new DevToolsConnection();
    connection.pipe = await dial(
      endpoint,
      {
        message: (text) => connection.receive(text),
        closed: () => connection.end(),
      },
      timeoutMs,
    );
    return connection;
  }

  get closed() {
    return this.ended;
  }

  /** Sends one command. `session` names the page; without it the browser itself answers. */
  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    options: { session?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.ended || !this.pipe)
      return Promise.reject(
        new DevToolsClosed("The browser connection is closed.", false),
      );
    const id = this.next++;
    const message = JSON.stringify({
      id,
      method,
      params,
      ...(options.session ? { sessionId: options.session } : {}),
    });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(
          new DevToolsTimeout(`The browser did not answer ${method} in time.`),
        );
      }, options.timeoutMs ?? 8000);
      this.waiting.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.pipe!.send(message);
      } catch {
        clearTimeout(timer);
        this.waiting.delete(id);
        reject(new DevToolsClosed("The browser connection is closed.", false));
        this.end();
      }
    });
  }

  /** Listens to one event. The answer stops listening. */
  on(method: string, listener: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closers.add(listener);
    return () => this.closers.delete(listener);
  }

  close() {
    if (this.ended) return;
    try {
      this.pipe?.close();
    } catch {
      // Closing is best effort; the state below is what counts.
    }
    this.end();
  }

  private receive(text: string) {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message.id === "number") {
      const waiting = this.waiting.get(message.id);
      if (!waiting) return;
      this.waiting.delete(message.id);
      clearTimeout(waiting.timer);
      if (isRecord(message.error)) {
        const code =
          typeof message.error.code === "number"
            ? message.error.code
            : undefined;
        waiting.reject(
          new DevToolsError(
            oneLine(message.error.message, 200) || "The browser refused.",
            code,
          ),
        );
        return;
      }
      waiting.resolve(isRecord(message.result) ? message.result : {});
      return;
    }
    if (typeof message.method !== "string") return;
    const params = isRecord(message.params) ? message.params : {};
    const session =
      typeof message.sessionId === "string" ? message.sessionId : undefined;
    for (const listener of [...(this.listeners.get(message.method) ?? [])])
      try {
        listener(params, session);
      } catch {
        // One listener does not stop the others.
      }
  }

  private end() {
    if (this.ended) return;
    this.ended = true;
    for (const [id, waiting] of this.waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(
        new DevToolsClosed("The browser connection closed.", true),
      );
      this.waiting.delete(id);
    }
    for (const closer of [...this.closers])
      try {
        closer();
      } catch {
        // The connection is closed in any case.
      }
  }
}
