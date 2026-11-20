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
import { claudeHome, codexHome } from "../connectors/agents/evidence.js";
import {
  focusSession,
  realRunner,
  type Runner,
} from "../connectors/agents/focus.js";
import {
  applyHookPlan,
  hookPlan,
  plannedInstalled,
  removeHookPlan,
} from "../connectors/agents/hooks.js";
import { supervisorCli, supervisorHelp } from "./supervisor.js";
import { hostsCli } from "./hosts.js";
import {
  boardWithRemotes,
  focusRemote,
  HostBook,
} from "../connectors/agents/hosts.js";
import type { ModelClient } from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { stateRoot } from "../connectors/agents/hooks.js";
import { renderBoard, title } from "../connectors/agents/render.js";
import { realSystem, type System } from "../connectors/agents/system.js";
import type {
  AgentKind,
  AgentSession,
  BoardSnapshot,
} from "../connectors/agents/types.js";

const help = `clawdtime agents: every coding-agent session on this Mac, and on the Macs in: clawdtime hosts
  agents [--json] [--all]            list sessions: needs you, working, idle
  agents --local | --host NAME       this Mac only, or one remote Mac only
  agents watch [--interval SECONDS]  live board; arrows or j/k, Enter focuses, q quits
  agents focus ID|NAME               bring that session's terminal to the front
  agents doctor                      how exactly each agent's state is known here
  agents hooks status|install|uninstall --agent claude-code|codex
--all also lists one-shot runs that have no person at a terminal.
Listing and focus only read. Nothing is sent to a session unless you ask for it below.

${supervisorHelp}`;

export interface AgentsDependencies {
  /** The language model of the ClawdTime agent. Tests script it. */
  model?: ModelClient | null;
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
  remote_pane: "its tmux pane on that Mac, in a new window",
  remote_mac:
    "a shell on that Mac, in a new window; the session is not in tmux, so its own terminal cannot be opened from here",
  none: "nothing",
} as const;

/** This Mac's board, with the board of each remote Mac in the host book. */
async function fullBoard(
  system: System,
  runner: Runner,
  options: { includeHeadless: boolean; local?: boolean; host?: string },
) {
  const local = new BoardScanner(system, {
    includeHeadless: options.includeHeadless,
  }).scan();
  if (options.local) return local;
  const book = new HostBook(stateRoot(system));
  if (options.host !== undefined && !book.get(options.host))
    throw new Error(
      `No remote Mac is named "${options.host}". See: clawdtime hosts list`,
    );
  return boardWithRemotes(
    local,
    book,
    runner,
    () => system.now(),
    options.host,
  );
}

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
    if (entry.kind === "codex" || entry.kind === "claude-code") {
      const plan = hookPlan(entry.kind, process.execPath, hookScript);
      let ready = false;
      try {
        const file =
          entry.kind === "codex"
            ? codexHooksFile(system)
            : join(claudeHome(system), "settings.json");
        ready =
          plannedInstalled(readRegular(file), plan).length === plan.length;
      } catch {
        // A hooks file that cannot be read counts as no hook.
      }
      if (entry.kind === "codex")
        source = ready
          ? "exact with the hooks: working, approval prompt, idle. ClawdTime can answer an approval. Codex runs a hook only after you trust it with /hooks."
          : "turn state, read from the session file. An approval prompt shows as working until the hooks are added: clawdtime agents hooks install --agent codex";
      else
        source += ready
          ? " ClawdTime can answer its permission prompts, questions and plans."
          : " To answer its prompts from ClawdTime: clawdtime agents hooks install --agent claude-code";
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
  desk: DecisionDesk,
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
  // While this view runs, someone attends: agents' hooks wait here for an answer.
  desk.attend();
  let waiting = desk.pending();
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
    const asks = waiting
      .slice(0, 5)
      .map(
        (request, index) =>
          `\u001b[33;1m${index + 1}. ${request.agent} asks ${request.kind === "question" ? "" : "to run "}${request.summary.replace(/\p{C}/gu, " ").slice(0, 90)}\u001b[0m`,
      )
      .join("\n");
    const keys = waiting.length ? "a approves the first · d denies it · " : "";
    output.write(
      `\u001b[H\u001b[2J${board}\n${asks ? `\n${asks}\n` : ""}\n\u001b[2m${keys}↑↓ or j/k move · Enter focuses · q quits\u001b[0m${message ? `\n${message}` : ""}\n`,
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
      desk.attend();
      waiting = desk.pending();
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
      if ((value === "a" || value === "d") && waiting[0]) {
        const ok = desk.answer(waiting[0].id, {
          decision: value === "a" ? "allow" : "deny",
          via: "cli",
        });
        message = ok
          ? value === "a"
            ? "Allowed. The agent continues."
            : "Denied. The agent is told."
          : "That request no longer waits.";
        waiting = desk.pending();
        return draw();
      }
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
  if (args[0] === "--hosts")
    return hostsCli(args.slice(1), { system, runner, print });
  if (args[0] === "--supervisor")
    return supervisorCli(args[1] ?? "", args.slice(2), {
      system,
      runner,
      print,
      hookScript: dependencies.hookScript ?? hookScriptPath(),
      findSession,
      model: dependencies.model,
    });
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "list";
  const rest = command === args[0] ? args.slice(1) : args;
  if (command === "help") return print(help);
  if (command === "list") {
    const { values, positional } = flags(rest, {
      json: "switch",
      all: "switch",
      local: "switch",
      host: "value",
    });
    if (positional.length)
      throw new Error("Unknown command. Run: clawdtime agents help");
    const snapshot = await fullBoard(system, runner, {
      includeHeadless: values.all === "true",
      local: values.local === "true",
      host: values.host,
    });
    if (values.json === "true") return print(JSON.stringify(snapshot, null, 2));
    print(
      renderBoard(snapshot, {
        color: dependencies.isTTY ?? !!process.stdout.isTTY,
        width: dependencies.columns ?? process.stdout.columns ?? 100,
        now: system.now(),
      }),
    );
    // A remote Mac that does not answer is named, so its silence is not read as "no agents".
    for (const host of snapshot.hosts ?? [])
      if (!host.ok) print(`${host.name} did not answer. ${host.message}`);
    return;
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
      new DecisionDesk(stateRoot(system), () => system.now()),
    );
  }
  if (command === "focus") {
    const { positional } = flags(rest, {});
    if (positional.length !== 1)
      throw new Error("Give one session: clawdtime agents focus ID|NAME");
    const session: AgentSession = findSession(
      await fullBoard(system, runner, { includeHeadless: true }),
      positional[0]!,
    );
    const remote = new HostBook(stateRoot(system)).get(session.host);
    const result = remote
      ? await focusRemote(remote, session, runner, stateRoot(system))
      : await focusSession(session, runner);
    if (!result.ok) {
      process.exitCode = 2;
      return print(
        session.host
          ? `${title(session)} on ${session.host} has no terminal to open from here.`
          : `${title(session)} has no terminal on this Mac to focus.`,
      );
    }
    return print(
      `Focused ${title(session)}: ${precisionText[result.precision]}.`,
    );
  }
  const hookScript = dependencies.hookScript ?? hookScriptPath();
  if (
    ["pending", "approve", "deny", "answer", "send", "away", "call"].includes(
      command,
    )
  )
    return supervisorCli("agents", [command, ...rest], {
      system,
      runner,
      print,
      hookScript,
      findSession,
    });
  if (command === "doctor") return doctor(system, hookScript, print);
  if (command === "hooks") {
    const { values, positional } = flags(rest, { agent: "value" });
    const action = positional[0];
    if (
      positional.length !== 1 ||
      !["status", "install", "uninstall"].includes(action!)
    )
      throw new Error(
        "Use: clawdtime agents hooks status|install|uninstall --agent claude-code|codex",
      );
    const agent = values.agent;
    if (agent !== "codex" && agent !== "claude-code")
      throw new Error(
        "Hooks exist for two agents: --agent claude-code or --agent codex.",
      );
    const file =
      agent === "codex"
        ? codexHooksFile(system)
        : join(claudeHome(system), "settings.json");
    const plan = hookPlan(agent, process.execPath, hookScript);
    const current = readRegular(file);
    const trust =
      agent === "codex"
        ? "Codex runs a new hook only after you trust it: open Codex and run /hooks once."
        : "Claude Code reads the change at once, in sessions that already run too.";
    if (action === "status") {
      const installed = plannedInstalled(current, plan).length;
      return print(
        installed === plan.length
          ? `Installed in ${file}. ${trust}`
          : installed
            ? `Partly installed in ${file} (${installed} of ${plan.length} hooks). Run install again.`
            : agent === "codex"
              ? "Not installed. A Codex approval prompt shows as working, and ClawdTime cannot answer it."
              : "Not installed. ClawdTime sees Claude Code but cannot answer its prompts.",
      );
    }
    if (action === "install") {
      if (!existsSync(hookScript))
        throw new Error(
          "Run npm run build first: the hook runs the built file.",
        );
      writeAtomic(file, applyHookPlan(current, plan));
      return print(
        `Added ${plan.length} hooks to ${file}. Everything else in it is unchanged.\n${trust}\nA hook only acts while ClawdTime runs. With no answer in time the agent asks in its own terminal, as before.`,
      );
    }
    if (current === undefined)
      return print("No hooks file. Nothing to remove.");
    writeAtomic(file, removeHookPlan(current, plan));
    return print(
      `Removed the ClawdTime hooks from ${file}. Everything else in it is unchanged.`,
    );
  }
  throw new Error("Unknown command. Run: clawdtime agents help");
}
