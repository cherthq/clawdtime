import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BoardScanner } from "../connectors/agents/board.js";
import { catalog } from "../connectors/agents/catalog.js";
import { codexHome } from "../connectors/agents/evidence.js";
import {
  focusSession,
  realRunner,
  type Runner,
} from "../connectors/agents/focus.js";
import {
  codexHookEvents,
  hookCommand,
  installHooks,
  installedHookEvents,
  uninstallHooks,
} from "../connectors/agents/hooks.js";
import { renderBoard, title } from "../connectors/agents/render.js";
import { realSystem, type System } from "../connectors/agents/system.js";
import type {
  AgentKind,
  AgentSession,
  BoardSnapshot,
} from "../connectors/agents/types.js";

const help = `clawdtime agents: every coding-agent session on this Mac
  agents [--json] [--all]            list sessions: needs you, working, idle
  agents watch [--interval SECONDS]  live board; arrows or j/k, Enter focuses, q quits
  agents focus ID|NAME               bring that session's terminal to the front
  agents doctor                      how exactly each agent's state is known here
  agents hooks status|install|uninstall --agent codex
--all also lists one-shot runs that have no person at a terminal.
The board reads state only. It never sends keys or text to a session.`;

export interface AgentsDependencies {
  system?: System;
  runner?: Runner;
  print?: (line: string) => void;
  /** The built hook entry point. Tests pass a fixed path. */
  hookScript?: string;
  isTTY?: boolean;
  columns?: number;
}

function flags(args: string[], known: Record<string, "value" | "switch">) {
  const values: Record<string, string> = {};
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (!key.startsWith("--")) {
      positional.push(key);
      continue;
    }
    const kind = known[key.slice(2)];
    if (!kind)
      throw new Error(`Unknown option ${key}. Run: clawdtime agents help`);
    if (kind === "switch") values[key.slice(2)] = "true";
    else {
      const value = args[++index];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`${key} needs a value.`);
      values[key.slice(2)] = value;
    }
  }
  return { values, positional };
}

/** A session by its id, its pid, or a name that only one session has. */
export function findSession(snapshot: BoardSnapshot, query: string) {
  const exact = snapshot.sessions.filter(
    (session) => session.id === query || String(session.pid) === query,
  );
  if (exact.length === 1) return exact[0]!;
  const wanted = query.toLowerCase();
  const named = snapshot.sessions.filter(
    (session) => title(session).toLowerCase() === wanted,
  );
  const partial = named.length
    ? named
    : snapshot.sessions.filter((session) =>
        title(session).toLowerCase().includes(wanted),
      );
  if (partial.length === 1) return partial[0]!;
  throw new Error(
    partial.length
      ? `"${query}" matches ${partial.length} sessions. Use the id from: clawdtime agents --json`
      : `No session matches "${query}".`,
  );
}

const precisionText = {
  pane: "its tmux pane",
  tab: "its terminal tab",
  app: "its terminal application; choose the tab there",
  none: "nothing",
} as const;

function hookScriptPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith("/dist/cli")
    ? resolve(here, "agent-hook.js")
    : resolve(here, "../dist/cli/agent-hook.js");
}

function codexHooksFile(system: System) {
  return join(codexHome(system), "hooks.json");
}
function readRegular(file: string) {
  if (!existsSync(file)) return undefined;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("The hooks file is not a regular file. It is unchanged.");
  return readFileSync(file, "utf8");
}
function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const mode = existsSync(file) ? lstatSync(file).mode & 0o777 : 0o600;
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { mode, flag: "wx" });
  renameSync(temp, file);
  chmodSync(file, mode);
}

const stateSources: Partial<Record<AgentKind, string>> = {
  "claude-code":
    "exact. Claude Code reports its own status: working, permission prompt, question, idle.",
  pi: "turn state, read from the session file: working or idle.",
  dexter: "turn state, read from the session file: working or idle.",
};

function doctor(
  system: System,
  hookScript: string,
  print: (line: string) => void,
) {
  const snapshot = new BoardScanner(system, { includeHeadless: true }).scan();
  const running = new Set(snapshot.sessions.map((session) => session.agent));
  print("How each agent's state is known on this Mac");
  for (const entry of catalog) {
    const installed =
      system.run("/usr/bin/which", [entry.names[0]!]).status === 0;
    if (!installed && !running.has(entry.kind)) continue;
    let source = stateSources[entry.kind];
    if (entry.kind === "codex") {
      const command = hookCommand(process.execPath, hookScript, "codex");
      let events: readonly string[] = [];
      try {
        events = installedHookEvents(
          readRegular(codexHooksFile(system)),
          command,
        );
      } catch {
        // An unreadable hooks file counts as no hook.
      }
      source =
        events.length === codexHookEvents.length
          ? "exact with the hook: working, approval prompt, idle. Codex runs a hook only after you trust it with /hooks."
          : "turn state, read from the session file. An approval prompt shows as working until the hook is added: clawdtime agents hooks install --agent codex";
    }
    print(
      `  ${entry.label.padEnd(13)} ${source ?? "found and focused. No state reader yet, so the state shows as unknown."}`,
    );
  }
  const terminals = new Map<string, string>();
  for (const session of snapshot.sessions)
    if (session.mode === "interactive")
      terminals.set(
        session.terminal.tmux
          ? `tmux in ${session.terminal.app ?? "an unknown terminal"}`
          : (session.terminal.app ?? "an unknown terminal"),
        precisionText[session.focus],
      );
  if (terminals.size) print("Where focus lands");
  for (const [terminal, precision] of terminals)
    print(`  ${terminal.padEnd(13)} ${precision}`);
  if ([...terminals.keys()].includes("Ghostty"))
    print(
      "  Ghostty selects the exact tab from release 1.4. Before that, only the application comes forward.",
    );
}

async function watch(
  scanner: BoardScanner,
  intervalMs: number,
  runner: Runner,
) {
  const output = process.stdout;
  const input = process.stdin;
  if (!output.isTTY || !input.isTTY)
    throw new Error(
      "watch needs a terminal. In a script use: clawdtime agents --json",
    );
  let snapshot = scanner.scan(intervalMs);
  let selectedId = snapshot.sessions[0]?.id;
  let message = "";
  const index = () =>
    Math.max(
      0,
      snapshot.sessions.findIndex((session) => session.id === selectedId),
    );
  const draw = () => {
    const board = renderBoard(snapshot, {
      color: true,
      width: output.columns ?? 100,
      now: Date.now(),
      selected: index(),
    });
    output.write(
      `\u001b[H\u001b[2J${board}\n\n\u001b[2m↑↓ or j/k move · Enter focuses · q quits\u001b[0m${message ? `\n${message}` : ""}\n`,
    );
  };
  const move = (step: number) => {
    const next = snapshot.sessions[index() + step];
    if (next) selectedId = next.id;
    draw();
  };
  await new Promise<void>((done) => {
    const timer = setInterval(() => {
      snapshot = scanner.scan(intervalMs);
      draw();
    }, intervalMs);
    const finish = () => {
      clearInterval(timer);
      input.setRawMode(false);
      input.pause();
      output.write("\u001b[?25h\u001b[?1049l");
      done();
    };
    output.write("\u001b[?1049h\u001b[?25l");
    input.setRawMode(true);
    input.resume();
    input.on("data", (key: Buffer) => {
      const value = key.toString("utf8");
      if (value === "q" || value === "\u0003") return finish();
      if (value === "k" || value === "\u001b[A") return move(-1);
      if (value === "j" || value === "\u001b[B") return move(1);
      if (value === "\r" || value === "\n") {
        const session = snapshot.sessions[index()];
        if (!session) return;
        void focusSession(session, runner).then((result) => {
          message = result.ok
            ? `Focused ${precisionText[result.precision]}.`
            : "That session has no terminal on this Mac to focus.";
          draw();
        });
      }
    });
    process.once("SIGTERM", finish);
    output.on("resize", draw);
    draw();
  });
}

export async function agentsCli(
  args: string[],
  dependencies: AgentsDependencies = {},
) {
  const system = dependencies.system ?? realSystem();
  const runner = dependencies.runner ?? realRunner;
  const print = dependencies.print ?? console.log;
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "list";
  const rest = command === args[0] ? args.slice(1) : args;
  if (command === "help") return print(help);
  if (command === "list") {
    const { values, positional } = flags(rest, {
      json: "switch",
      all: "switch",
    });
    if (positional.length)
      throw new Error("Unknown command. Run: clawdtime agents help");
    const snapshot = new BoardScanner(system, {
      includeHeadless: values.all === "true",
    }).scan();
    if (values.json === "true") return print(JSON.stringify(snapshot, null, 2));
    return print(
      renderBoard(snapshot, {
        color: dependencies.isTTY ?? !!process.stdout.isTTY,
        width: dependencies.columns ?? process.stdout.columns ?? 100,
        now: system.now(),
      }),
    );
  }
  if (command === "watch") {
    const { values } = flags(rest, { interval: "value", all: "switch" });
    const seconds = Number(values.interval ?? 2);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60)
      throw new Error("--interval is a number of seconds from 1 to 60.");
    return watch(
      new BoardScanner(system, { includeHeadless: values.all === "true" }),
      Math.round(seconds * 1000),
      runner,
    );
  }
  if (command === "focus") {
    const { positional } = flags(rest, {});
    if (positional.length !== 1)
      throw new Error("Give one session: clawdtime agents focus ID|NAME");
    const session: AgentSession = findSession(
      new BoardScanner(system, { includeHeadless: true }).scan(),
      positional[0]!,
    );
    const result = await focusSession(session, runner);
    if (!result.ok) {
      process.exitCode = 2;
      return print(`${title(session)} has no terminal on this Mac to focus.`);
    }
    return print(
      `Focused ${title(session)}: ${precisionText[result.precision]}.`,
    );
  }
  const hookScript = dependencies.hookScript ?? hookScriptPath();
  if (command === "doctor") return doctor(system, hookScript, print);
  if (command === "hooks") {
    const { values, positional } = flags(rest, { agent: "value" });
    const action = positional[0];
    if (
      positional.length !== 1 ||
      !["status", "install", "uninstall"].includes(action!)
    )
      throw new Error(
        "Use: clawdtime agents hooks status|install|uninstall --agent codex",
      );
    if (values.agent !== "codex")
      throw new Error(
        "Only Codex needs a hook: --agent codex. Claude Code reports its own state.",
      );
    const file = codexHooksFile(system);
    const command = hookCommand(process.execPath, hookScript, "codex");
    const current = readRegular(file);
    if (action === "status") {
      const events = installedHookEvents(current, command);
      return print(
        events.length === codexHookEvents.length
          ? `Installed in ${file}. Codex runs it after you trust it: open Codex and run /hooks.`
          : events.length
            ? `Partly installed in ${file} (${events.length} of ${codexHookEvents.length} events). Run install again.`
            : `Not installed. An approval prompt in Codex shows as working.`,
      );
    }
    if (action === "install") {
      if (!existsSync(hookScript))
        throw new Error(
          "Run npm run build first: the hook runs the built file.",
        );
      writeAtomic(file, installHooks(current, command));
      return print(
        `Added ${codexHookEvents.length} hook events to ${file}. Other hooks are unchanged.\nNext: open Codex and run /hooks once to review and trust them. Codex skips them until then.`,
      );
    }
    if (current === undefined)
      return print("No hooks file. Nothing to remove.");
    writeAtomic(file, uninstallHooks(current, command));
    return print(
      `Removed the ClawdTime hook from ${file}. Other hooks are unchanged.`,
    );
  }
  throw new Error("Unknown command. Run: clawdtime agents help");
}
