import { basename } from "node:path";
import { ancestors, type ProcessFact, type ProcessTree } from "./processes.js";
import type { System } from "./system.js";
import type { FocusPrecision, TerminalLocation } from "./types.js";

interface Pane {
  tty: string;
  paneId: string;
  session: string;
  window: number;
  pane: number;
  socketArgs: string[];
}
interface Client {
  pid: number;
  tty: string | null;
  session: string;
  socketArgs: string[];
}
export interface TmuxView {
  panes: Pane[];
  clients: Client[];
}

const tmuxPath = (system: System) => {
  for (const directory of [
    ...(system.env.PATH ?? "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ]) {
    if (!directory.startsWith("/")) continue;
    const candidate = `${directory}/tmux`;
    if (system.stat(candidate)?.isFile) return candidate;
  }
  return null;
};

const isTmuxServer = (process: ProcessFact) =>
  /^tmux(:|$)/.test(basename(process.exe)) ||
  /(^|\/)tmux(:| |$)/.test(process.command);

/** The socket a tmux server was started with: -S path, -L name, or the default. */
export function tmuxSocket(process: ProcessFact): string[] {
  const tokens = process.command.split(/\s+/);
  for (let index = 1; index < tokens.length - 1; index++) {
    const token = tokens[index]!;
    if (token === "-S" || token === "-L") return [token, tokens[index + 1]!];
    if (!token.startsWith("-")) break;
  }
  return [];
}

/** Asks each tmux server that hosts a session for its panes and clients. */
export function readTmux(system: System, servers: ProcessFact[]): TmuxView {
  const view: TmuxView = { panes: [], clients: [] };
  const binary = servers.length ? tmuxPath(system) : null;
  if (!binary) return view;
  const seen = new Set<string>();
  for (const server of servers) {
    const socket = tmuxSocket(server);
    const key = socket.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    const panes = system.run(binary, [
      ...socket,
      "list-panes",
      "-a",
      "-F",
      // A colon separates the fields: tmux allows no colon in a session name,
      // and in a non-UTF-8 locale it prints an underscore for a tab.
      "#{pane_tty}:#{pane_id}:#{window_index}:#{pane_index}:#{session_name}",
    ]);
    if (panes.status !== 0) continue;
    for (const line of panes.stdout.split("\n")) {
      const [tty, paneId, window, pane, ...session] = line.split(":");
      if (!tty || !paneId || !/^%\d{1,9}$/.test(paneId)) continue;
      view.panes.push({
        tty: tty.replace(/^\/dev\//, ""),
        paneId,
        window: Number(window) || 0,
        pane: Number(pane) || 0,
        session: session.join(":").slice(0, 200),
        socketArgs: socket,
      });
    }
    const clients = system.run(binary, [
      ...socket,
      "list-clients",
      "-F",
      "#{client_pid}:#{client_tty}:#{session_name}",
    ]);
    if (clients.status !== 0) continue;
    for (const line of clients.stdout.split("\n")) {
      const [pid, tty, ...session] = line.split(":");
      if (!pid || !/^\d+$/.test(pid)) continue;
      const name = (tty ?? "").replace(/^\/dev\//, "");
      view.clients.push({
        pid: Number(pid),
        tty: /^[A-Za-z0-9]{1,24}$/.test(name) ? name : null,
        session: session.join(":").slice(0, 200),
        socketArgs: socket,
      });
    }
  }
  return view;
}

/** The application bundle that owns a process: the outermost .app in its path. */
function bundle(process: ProcessFact) {
  const match = /^(\/.*?\.app)\/Contents\//.exec(process.command);
  if (!match) return null;
  return { app: basename(match[1]!, ".app").slice(0, 120), appPath: match[1]! };
}

function hostApp(tree: ProcessTree, pid: number) {
  let remote = false;
  for (const process of ancestors(tree, pid)) {
    if (/^sshd(-session)?(:|$)/.test(basename(process.exe))) remote = true;
    const found = bundle(process);
    if (found) return { ...found, remote };
  }
  return { app: null, appPath: null, remote };
}

export function tmuxServers(tree: ProcessTree, pids: number[]) {
  const servers = new Map<number, ProcessFact>();
  for (const pid of pids)
    for (const process of ancestors(tree, pid))
      if (isTmuxServer(process)) {
        servers.set(process.pid, process);
        break;
      }
  return [...servers.values()];
}

export function locate(
  tree: ProcessTree,
  tmux: TmuxView,
  process: ProcessFact,
): TerminalLocation {
  const pane = process.tty
    ? tmux.panes.find((entry) => entry.tty === process.tty)
    : undefined;
  if (pane) {
    // The pane's own ancestors end at the tmux server, so the window on screen
    // is the terminal of a client attached to the same session.
    const client = tmux.clients.find(
      (entry) =>
        entry.session === pane.session &&
        entry.socketArgs.join("\0") === pane.socketArgs.join("\0"),
    );
    const host = client
      ? hostApp(tree, client.pid)
      : { app: null, appPath: null, remote: false };
    return {
      tty: process.tty,
      ...host,
      tmux: {
        session: pane.session,
        window: pane.window,
        pane: pane.pane,
        paneId: pane.paneId,
        socketArgs: pane.socketArgs,
        clientTty: client?.tty ?? null,
      },
    };
  }
  return { tty: process.tty, ...hostApp(tree, process.pid), tmux: null };
}

const versionAtLeast = (
  version: string | null,
  major: number,
  minor: number,
) => {
  const match = /^(\d+)\.(\d+)/.exec(version ?? "");
  if (!match) return false;
  const [high, low] = [Number(match[1]), Number(match[2])];
  return high > major || (high === major && low >= minor);
};

/** The version in an application's Info.plist, when the file is plain text. */
export function appVersion(system: System, appPath: string) {
  const plist = system.readText(`${appPath}/Contents/Info.plist`, 65_536);
  return (
    /<key>CFBundleShortVersionString<\/key>\s*<string>([0-9A-Za-z.+-]{1,40})<\/string>/.exec(
      plist ?? "",
    )?.[1] ?? null
  );
}

/**
 * Terminals whose scripting support can select the tab of one TTY.
 * Ghostty gained the terminal tty property in release 1.4.
 */
export function tabAddressable(app: string | null, version: string | null) {
  if (app === "Terminal" || app === "iTerm" || app === "iTerm2") return true;
  return app === "Ghostty" && versionAtLeast(version, 1, 4);
}

/** How exactly focus can land, decided from the location alone. */
export function focusPrecision(
  location: TerminalLocation,
  version: string | null,
): FocusPrecision {
  if (location.remote) return "none";
  if (location.tmux) return "pane";
  if (!location.tty || !location.app) return "none";
  return tabAddressable(location.app, version) ? "tab" : "app";
}
