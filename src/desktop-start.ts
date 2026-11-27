/**
 * What the desktop launcher knows about a start before and after it spawns
 * the service: who holds the port, the owner-only startup log of the state
 * folder, and the plain reason of a service that stopped as it started.
 * Nothing here starts, stops or signals a process.
 */
import { execFile } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import {
  readDesktopPrivateJSON,
  writeDesktopPrivateJSON,
} from "./control/task-desktop-config.js";
import { errorMarker, redactOutput, refusedMarker } from "./service-output.js";

export const defaultDesktopPort = 13326;
export const startLogName = "desktop-start.log";
/** The startup log moves to `.1` at the next start once it is this large. */
export const startLogRotateAt = 256 * 1024;
const readLimit = 16 * 1024;

/** A ClawdTime desktop of another install that holds the port. */
export interface OtherInstall {
  port: number;
  pid: number | null;
  /** Its state folder, only when its own files confirm the process. */
  state: string | null;
  /** Its process, its owner lock and its descriptor agree. */
  verified: boolean;
}

export type DesktopStartKind =
  | "other_install"
  | "port_in_use"
  | "session_open_work"
  | "session_revoked"
  | "configuration"
  | "stopped";

/**
 * Why the desktop did not start. `reason` is plain words with no path, for a
 * setup screen. `details` are the lines that a screen shows on request: the
 * folder, the log and any command. The message joins both for Terminal.
 */
export class DesktopStartError extends Error {
  constructor(
    readonly kind: DesktopStartKind,
    readonly reason: string,
    readonly details: string[] = [],
    readonly other?: OtherInstall,
  ) {
    super([reason, ...details].join(" "));
  }
}

/**
 * Opens the startup log of a state folder for one start, after moving a
 * large one to `.1`. It is a regular owner-only file, never a link.
 */
export function openStartLog(state: string): {
  fd: number;
  offset: number;
  path: string;
} {
  const path = join(state, startLogName);
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && stat.size > startLogRotateAt)
      renameSync(path, `${path}.1`);
  } catch {
    // No log yet.
  }
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600,
  );
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) {
    closeSync(fd);
    throw Error(
      "The desktop startup log is not a private file of this user. Nothing was started.",
    );
  }
  return { fd, offset: stat.size, path };
}

/** What one start wrote to the log, masked, at most its last 16 KiB. */
export function readStartOutput(path: string, offset: number): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(offset, size - readLimit);
    const buffer = Buffer.alloc(Math.max(0, size - from));
    readSync(fd, buffer, 0, buffer.length, from);
    return redactOutput(buffer.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

const lastMatch = (lines: string[], pattern: RegExp) => {
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = pattern.exec(lines[i]!);
    if (found) return found;
  }
  return null;
};

/** Paths stay in the details: a setup screen names no file path. */
const withoutPaths = (text: string) =>
  text
    .replace(/'?(?:~|\.{0,2})?\/[^\s'",)]+'?/g, "a file")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

/**
 * The plain reason of a service that stopped during startup, from what it
 * wrote. A refusal of the service says it in its own words; a known error
 * gets its words here; any other error is named as it is, without paths.
 */
export function startFailure(
  output: string,
  context: {
    port: number;
    state: string;
    log: string;
    code?: number | null;
    signal?: string | null;
  },
): DesktopStartError {
  const logLine = `The service log is ${context.log}.`;
  const lines = output.split("\n").map((line) => line.trim());
  const refused = lastMatch(
    lines,
    new RegExp(`^${refusedMarker} ([a-z_]+): (.+)$`),
  );
  if (refused?.[1] === "session_open_work")
    return new DesktopStartError("session_open_work", refused[2]!, [
      `To keep that task's record and start a new desktop, move this desktop's folder aside: mv "${context.state}" "${context.state}-kept"`,
      "Then start ClawdTime again.",
      logLine,
    ]);
  if (refused?.[1] === "session_revoked")
    return new DesktopStartError("session_revoked", refused[2]!, [
      `To start a new desktop and keep this record, move this desktop's folder aside: mv "${context.state}" "${context.state}-kept"`,
      "Then start ClawdTime again.",
      logLine,
    ]);
  const said =
    lastMatch(lines, new RegExp(`^${errorMarker}: (.+)$`))?.[1] ??
    lastMatch(lines, /^(?:[A-Za-z]*Error|Error \[[A-Z_]+\]): (.+)$/)?.[1] ??
    (lines.some((line) => line.includes("EADDRINUSE")) ? "EADDRINUSE" : null);
  if (said?.includes("EADDRINUSE"))
    return new DesktopStartError(
      "port_in_use",
      `Port ${context.port} is in use by another program, so the desktop could not start. Quit that program, then try again.`,
      [logLine],
    );
  if (said?.includes("Task session expired or revoked"))
    return new DesktopStartError(
      "session_revoked",
      "The task session of this desktop expired or was revoked, and this desktop could not renew it. Nothing was changed.",
      [logLine],
    );
  if (said?.includes("State is bound to a different selected project"))
    return new DesktopStartError(
      "configuration",
      "This desktop's folder belongs to another project, so the desktop did not start. Start it with the project it was made for.",
      [logLine],
    );
  if (said?.includes("Desktop configuration differs from this workspace"))
    return new DesktopStartError(
      "configuration",
      "The saved setup of this desktop does not match this start: its project, worker or port changed. Nothing was replaced.",
      [`The desktop folder is ${context.state}.`, logLine],
    );
  if (said && /owner-only|Unsafe local configuration/.test(said))
    return new DesktopStartError(
      "configuration",
      "A file in the desktop's folder is not private to you, so the desktop did not start. Make the folder yours alone (chmod 700) and its files too (chmod 600), then try again.",
      [`The desktop folder is ${context.state}.`, logLine],
    );
  if (said)
    return new DesktopStartError(
      "stopped",
      `The desktop service stopped as it started: ${withoutPaths(said)}`,
      [`It said: ${said.slice(0, 400)}`, logLine],
    );
  return new DesktopStartError(
    "stopped",
    `The desktop service stopped as it started and said nothing${context.signal ? ` (signal ${context.signal})` : context.code != null ? ` (exit code ${context.code})` : ""}.`,
    [logLine],
  );
}

/** Who holds a loopback port. */
export type PortOwner =
  | { state: "free" }
  | { state: "clawdtime"; other: OtherInstall }
  | { state: "other"; pid: number | null; name: string | null };

/** What a port check reads of this Mac. Tests replace each one. */
export interface PortTools {
  /** A listener of this process could take the port now. */
  bindable(port: number): Promise<boolean>;
  /** The answer of GET /health on the port, or null. */
  health(port: number): Promise<unknown>;
  /** The process that listens on the port, as lsof says. */
  listener(port: number): Promise<{ pid: number; name: string } | null>;
  /** The whole command line of a process, as ps says. */
  command(pid: number): Promise<string | null>;
}

const run = (binary: string, args: string[]) =>
  new Promise<string | null>((done) =>
    execFile(
      binary,
      args,
      {
        timeout: 5000,
        maxBuffer: 64 * 1024,
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin" },
      },
      (error, stdout) => done(error ? null : stdout),
    ),
  );

export const portTools: PortTools = {
  bindable: (port) =>
    new Promise((done) => {
      const server = createServer();
      server.once("error", () => done(false));
      server.listen({ port, host: "127.0.0.1", exclusive: true }, () =>
        server.close(() => done(true)),
      );
    }),
  health: async (port) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(1500),
      });
      const text = await response.text();
      return response.ok && text.length <= 4096 ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  },
  listener: async (port) => {
    const out = await run("/usr/sbin/lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fpc",
    ]);
    const pid = out && /^p(\d+)$/m.exec(out);
    const name = out && /^c(.+)$/m.exec(out);
    return pid ? { pid: Number(pid[1]), name: name?.[1] ?? "" } : null;
  },
  command: async (pid) =>
    (await run("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)]))
      ?.trim()
      .split("\n")[0] || null,
};

/** The answer of /health of a ClawdTime task service. */
const healthSchema = z
  .object({
    mode: z.enum(["simulation", "standby"]),
    liveDispatch: z.literal(false),
    control: z.literal(false),
  })
  .passthrough();
const pidFile = z.object({ pid: z.number().int().positive() }).passthrough();
const descriptorFile = z
  .object({ pid: z.number().int().positive(), origin: z.string() })
  .passthrough();

/** The state folder of a desktop service, from its command line. */
export function serviceStateFolder(command: string): string | null {
  if (!/ --desktop true(?:\s|$)/.test(command)) return null;
  return (
    / [^ ]*task-server\.(?:ts|js) --state (.+?) --project /.exec(
      command,
    )?.[1] ?? null
  );
}

/**
 * Who holds the port. A ClawdTime desktop says so by its health answer or by
 * its command line. Its state folder counts only when its owner lock and its
 * descriptor name the same process and this port.
 */
export async function checkPort(
  port: number,
  tools: PortTools = portTools,
): Promise<PortOwner> {
  if (await tools.bindable(port)) return { state: "free" };
  const listener = await tools.listener(port);
  const command = listener ? await tools.command(listener.pid) : null;
  const folder = command ? serviceStateFolder(command) : null;
  const healthy = healthSchema.safeParse(await tools.health(port)).success;
  if (!folder && !healthy)
    return {
      state: "other",
      pid: listener?.pid ?? null,
      name: listener?.name || null,
    };
  let verified = false;
  if (folder && listener)
    try {
      const owner = pidFile.parse(
        readDesktopPrivateJSON(join(folder, "owner.lock")),
      );
      const descriptor = descriptorFile.parse(
        readDesktopPrivateJSON(join(folder, "desktop-service.json")),
      );
      verified =
        owner.pid === listener.pid &&
        descriptor.pid === listener.pid &&
        descriptor.origin === `http://127.0.0.1:${port}`;
    } catch {
      verified = false;
    }
  return {
    state: "clawdtime",
    other: {
      port,
      pid: listener?.pid ?? null,
      state: verified ? folder : null,
      verified,
    },
  };
}

/** The first port after `from` that this process could take now. */
export async function nextFreePort(
  from: number,
  tools: Pick<PortTools, "bindable"> = portTools,
) {
  for (let port = from + 1; port <= Math.min(from + 100, 65535); port++)
    if (await tools.bindable(port)) return port;
  return null;
}

const portRecordName = "desktop-port.json";
const portRecord = z
  .object({
    version: z.literal(1),
    port: z.number().int().min(1024).max(65535),
  })
  .strict();

/** The port that an earlier start chose for this desktop, or null. */
export function readPortRecord(state: string): number | null {
  try {
    return portRecord.parse(readDesktopPrivateJSON(join(state, portRecordName)))
      .port;
  } catch {
    return null;
  }
}

export function writePortRecord(state: string, port: number) {
  writeDesktopPrivateJSON(join(state, portRecordName), { version: 1, port });
}

/** The port of the running service of a state folder, from its descriptor. */
export function descriptorPort(state: string): number | null {
  try {
    const origin = descriptorFile.parse(
      readDesktopPrivateJSON(join(state, "desktop-service.json")),
    ).origin;
    const found = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(origin);
    return found ? Number(found[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Moves the saved binding of a desktop to another port. It changes only the
 * fingerprint, and only when the binding was made for the same setup on the
 * old port: the desktop keeps its identity, credential and registration.
 */
export function moveBindingPort(
  state: string,
  from: string,
  to: string,
): boolean {
  const path = join(state, "desktop-binding.json");
  let binding: Record<string, unknown>;
  try {
    binding = readDesktopPrivateJSON(path) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (binding.configurationFingerprint !== from) return false;
  writeDesktopPrivateJSON(path, { ...binding, configurationFingerprint: to });
  return true;
}
