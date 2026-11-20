import { execFile } from "node:child_process";
import type { CommandResult } from "./system.js";
import type { AgentSession, FocusPrecision } from "./types.js";

export type Runner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<CommandResult>;

export const realRunner: Runner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) =>
        resolve({
          status: error
            ? typeof error.code === "number"
              ? error.code
              : null
            : 0,
          stdout: typeof stdout === "string" ? stdout : "",
        }),
    );
  });

/**
 * Each script takes the TTY as an argument and prints "ok" when it selected
 * that tab. The TTY is never placed inside the script text.
 */
const scripts: Record<string, string> = {
  Terminal: `on run argv
  set target to "/dev/" & item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is target then
          set selected of t to true
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`,
  iTerm2: `on run argv
  set target to "/dev/" & item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is target then
            select w
            tell t to select
            tell s to select
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`,
  Ghostty: `on run argv
  set target to "/dev/" & item 1 of argv
  tell application "Ghostty"
    set matches to every terminal whose tty is target
    if (count of matches) is 0 then return "missing"
    focus (item 1 of matches)
    return "ok"
  end tell
end run`,
};
scripts.iTerm = scripts.iTerm2!;

export interface FocusResult {
  ok: boolean;
  /**
   * How exactly focus landed: the pane, the tab, only the application, or
   * nothing. For a session of a remote Mac: a new window on its tmux pane
   * (remote_pane), or a new window with a shell on that Mac (remote_mac).
   */
  precision: FocusPrecision | "remote_pane" | "remote_mac";
}

/**
 * Brings the session's terminal to the front. It sends no keys and no text to
 * the session. tmux needs no permission. Selecting a tab asks macOS for
 * Automation permission once; without it the application still comes forward.
 */
export async function focusSession(
  session: AgentSession,
  run: Runner = realRunner,
  tmuxBinary = "tmux",
): Promise<FocusResult> {
  const { terminal } = session;
  // A session of a remote Mac has no window here: see focusRemote in hosts.ts.
  if (session.focus === "none" || terminal.remote || session.host)
    return { ok: false, precision: "none" };
  let pane = false;
  let hostTty = terminal.tty;
  if (terminal.tmux) {
    const { socketArgs, paneId, clientTty } = terminal.tmux;
    const tmux = (...args: string[]) =>
      run(tmuxBinary, [...socketArgs, ...args], 3000);
    const window = await tmux("select-window", "-t", paneId);
    const selected = await tmux("select-pane", "-t", paneId);
    pane = window.status === 0 && selected.status === 0;
    // A pane in another tmux session needs the attached client moved to it.
    if (pane) await tmux("switch-client", "-t", paneId);
    hostTty = clientTty;
  }
  let tab = false;
  const script = terminal.app ? scripts[terminal.app] : undefined;
  // Outside tmux the board already checked that this terminal can select a
  // tab by TTY. Inside tmux the script is tried; a failure only loses the tab.
  if (script && hostTty && (session.focus === "tab" || terminal.tmux)) {
    const result = await run(
      "/usr/bin/osascript",
      ["-e", script, hostTty],
      5000,
    );
    tab = result.status === 0 && result.stdout.trim() === "ok";
  }
  let app = tab;
  if (!tab && terminal.appPath)
    app =
      (await run("/usr/bin/open", ["-a", terminal.appPath], 5000)).status === 0;
  const precision: FocusResult["precision"] = pane
    ? "pane"
    : tab
      ? "tab"
      : app
        ? "app"
        : "none";
  return { ok: precision !== "none", precision };
}
