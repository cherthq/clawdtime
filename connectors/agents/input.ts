import { realRunner, type Runner } from "./focus.js";
import type { AgentSession } from "./types.js";

/**
 * Types text into a session's terminal, as the person would. It runs only on
 * the person's explicit request: a command, a reply in the panel, or an answer
 * given on a call. tmux needs no permission; a terminal application asks macOS
 * for Automation permission once.
 */
export type InputRoute = "tmux" | "ghostty" | "terminal" | "iterm" | "none";

const scripts = {
  ghostty: `on run argv
  tell application "Ghostty"
    set t to first terminal whose tty is ("/dev/" & item 1 of argv)
    input text (item 2 of argv) to t
    if item 3 of argv is "enter" then send key "enter" to t
  end tell
  return "ok"
end run`,
  terminal: `on run argv
  set target to "/dev/" & item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is target then
          do script (item 2 of argv) in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`,
  iterm: `on run argv
  set target to "/dev/" & item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is target then
            if item 3 of argv is "enter" then
              tell s to write text (item 2 of argv)
            else
              tell s to write text (item 2 of argv) newline no
            end if
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`,
};

/** Text for a terminal: no control characters, so it cannot carry an escape sequence. */
export function cleanInput(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .slice(0, 4000);
}

export function inputRoute(session: AgentSession): InputRoute {
  const { terminal } = session;
  if (session.mode !== "interactive" || terminal.remote) return "none";
  if (terminal.tmux) return "tmux";
  if (!terminal.tty) return "none";
  if (terminal.app === "Terminal") return "terminal";
  if (terminal.app === "iTerm" || terminal.app === "iTerm2") return "iterm";
  // The board marks tab precision for a Ghostty that can address a terminal by TTY.
  if (terminal.app === "Ghostty" && session.focus === "tab") return "ghostty";
  return "none";
}

export async function sendText(
  session: AgentSession,
  value: string,
  options: { enter: boolean },
  run: Runner = realRunner,
  tmuxBinary = "tmux",
): Promise<{ ok: boolean; route: InputRoute }> {
  const route = inputRoute(session);
  const text = cleanInput(value);
  if (route === "none" || !text.trim()) return { ok: false, route };
  const { terminal } = session;
  if (route === "tmux" && terminal.tmux) {
    const { socketArgs, paneId } = terminal.tmux;
    // -l sends the text as keys, never as key names. -- ends the options.
    const typed = await run(
      tmuxBinary,
      [...socketArgs, "send-keys", "-t", paneId, "-l", "--", text],
      3000,
    );
    if (typed.status !== 0) return { ok: false, route };
    if (!options.enter) return { ok: true, route };
    const entered = await run(
      tmuxBinary,
      [...socketArgs, "send-keys", "-t", paneId, "Enter"],
      3000,
    );
    return { ok: entered.status === 0, route };
  }
  // Terminal types the text and Return as one step: it cannot leave the line open.
  if (route === "terminal" && !options.enter) return { ok: false, route };
  const script = scripts[route as "ghostty" | "terminal" | "iterm"];
  const result = await run(
    "/usr/bin/osascript",
    ["-e", script, terminal.tty!, text, options.enter ? "enter" : "stay"],
    6000,
  );
  return { ok: result.status === 0 && result.stdout.trim() === "ok", route };
}
