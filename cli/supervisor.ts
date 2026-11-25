import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BoardScanner } from "../connectors/agents/board.js";
import {
  browsers,
  focusTab,
  frontPageText,
  listTabs,
  openPage,
  type BrowserName,
} from "../connectors/agents/browser.js";
import {
  answerInTerminalText,
  DecisionDesk,
  type DecisionRequest,
} from "../connectors/agents/decisions.js";
import {
  callCheckText,
  checkCall,
  converseByCall,
  loadCallLink,
  openCall,
  removeCallLink,
  saveCallLink,
} from "../connectors/agents/call.js";
import {
  asksForNewChat,
  chatArchiveId,
  ChatLog,
  switchChat,
  type ArchivedChat,
  type ModelClient,
  historyForTurn,
} from "../connectors/agents/brain.js";
import { chatBrain, type ChatBrain } from "../connectors/agents/chat-agent.js";
import { focusSession } from "../connectors/agents/focus.js";
import { rememberable } from "../connectors/agents/trove.js";
import {
  speak,
  speechSettings,
  speechVocabulary,
  transcribe,
} from "../connectors/agents/speech.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { connectionPath } from "../connectors/shared/state.js";
import { claudeHome, codexHome } from "../connectors/agents/evidence.js";
import type { Runner } from "../connectors/agents/focus.js";
import {
  hookPlan,
  plannedInstalled,
  stateRoot,
} from "../connectors/agents/hooks.js";
import {
  boardWithRemotes,
  HostBook,
  remoteSend,
} from "../connectors/agents/hosts.js";
import { sendText } from "../connectors/agents/input.js";
import { inventory, type CliFact } from "../connectors/agents/inventory.js";
import { readProcesses } from "../connectors/agents/processes.js";
import { elapsed, title } from "../connectors/agents/render.js";
import { renderDeck } from "../connectors/agents/report.js";
import type { System } from "../connectors/agents/system.js";
import {
  changeDesktopChat,
  desktopChatHistory,
  sayToDesktop,
} from "../connectors/agents/desktop-chat.js";
import { markTextTurn } from "../connectors/computer/reach.js";
import {
  userMessageLimit,
  userMessageTooLong,
} from "../connectors/agents/request-text.js";
import { openApp } from "../connectors/agents/apps.js";
import { browse } from "../connectors/agents/browsing.js";
import { showOnCall, ViewStore } from "../connectors/agents/view.js";
import { lookAtScreen } from "../connectors/agents/eyes.js";
import {
  Jobs,
  jobAgents,
  jobStatusDetail,
  type JobAgent,
} from "../connectors/agents/jobs.js";
import {
  checkTexts,
  TextChannel,
  textSettings,
} from "../connectors/agents/texts.js";
import { tabTitles, titleReader } from "../connectors/agents/topics.js";
import { sessionWindow } from "../connectors/agents/windows.js";
import type {
  AgentSession,
  BoardSnapshot,
} from "../connectors/agents/types.js";

export interface SupervisorDependencies {
  system: System;
  runner: Runner;
  print: (line: string) => void;
  hookScript: string;
  findSession: (snapshot: BoardSnapshot, query: string) => AgentSession;
  /** The language model of the ClawdTime agent. Tests script it. */
  model?: ModelClient | null;
  /** The HTTP client of the text message channel. Tests script it. */
  request?: typeof fetch;
}

/**
 * A spoken conversation in a terminal. Return starts a recording, Return again
 * sends it; the answer is printed and spoken. "q" or the end of input stops it.
 */
export async function talkLoop(io: {
  print: (line: string) => void;
  /** One line that the person entered. Null when the input ended. */
  next: () => Promise<string | null>;
  /** Starts a recording. `stop` ends it and gives its file. */
  record: () => { stop: () => Promise<string> };
  /** The words in one recording. */
  hear: (file: string) => Promise<string>;
  answer: (words: string) => Promise<string>;
  say: (text: string) => Promise<void>;
}): Promise<number> {
  let turns = 0;
  io.print(
    "Press Return, speak, and press Return again. Type q and Return to stop.",
  );
  for (;;) {
    const start = await io.next();
    if (start === null || start.trim() === "q") return turns;
    const recording = io.record();
    io.print("Listening. Press Return to send.");
    const end = await io.next();
    const file = await recording.stop();
    let heard = "";
    try {
      heard = await io.hear(file);
    } catch (error) {
      io.print(
        error instanceof Error ? error.message : "Transcription failed.",
      );
    }
    if (end === null || end.trim() === "q") return turns;
    if (!heard) {
      io.print("I did not catch that. Press Return to try again.");
      continue;
    }
    turns++;
    io.print(`You: ${heard}`);
    const answer =
      heard.length > userMessageLimit
        ? userMessageTooLong
        : await io.answer(heard);
    io.print(`ClawdTime: ${answer}`);
    try {
      await io.say(answer);
    } catch (error) {
      io.print(error instanceof Error ? error.message : "Speech failed.");
    }
    io.print("Press Return to speak again, or q and Return to stop.");
  }
}

export const supervisorHelp = `Answer agents, and what ClawdTime remembers
  agents pending [--json] [--attend]   requests that wait for an answer from ClawdTime
  agents approve ID [--always]         allow it. --always also makes a rule for this project
  agents deny ID [--message TEXT]      refuse it, with a reason for the agent
  agents answer ID TEXT                answer a question (TEXT, or the number of a choice)
  agents send SESSION TEXT [--no-enter]  type TEXT into that session's terminal
  agents away on|off|status            away: requests wait for a phone call
  agents call connect|status|disconnect  link a paired project, so away mode can call you
  trove [list|search WORDS|rules|forget RULE|note TEXT|playbook [--out FILE]]
  memory [status|on|off|show|search WORDS|remember TEXT|forget ID|TEXT]
                                       what you told ClawdTime. Off until you turn it on
  clis [--json]                        agent commands on this Mac, with versions and use
  report [--out FILE] [--open]         the same as a slide deck
  browser tabs | open URL | focus N | text   list, open, bring forward, read the front page
  chat [TEXT]                          talk to ClawdTime in text: it answers and can act. With TEXT,
                                       the desktop service answers when it runs
  chat new | chat clear                start a new chat. The current one is kept, never deleted.
                                       Work that runs goes on. Typing "new chat" in the chat does the same
  chat history                         the chats that were put aside: their time and first words
  chat open TIME                       make one of them the current chat again; the current one is kept
  talk                                 the same by voice: you speak, it speaks back
  jobs [--json]                        work that ClawdTime handed to a new coding session, and its answers
  jobs retire ID --reason TEXT         retire an unresolved record; does not stop its process or replay it
  view [--json] | view clear           what the video of a call shows: one window, or the whole screen
  texts run | check                    answer your text messages on your Chert line (check sends nothing)
  agents call me                       ClawdTime calls you on FaceTime, and you talk to it
  agents call check                    ask the backend whether a call would work now; no call is placed
ID is the request's id, or its first four characters or more, as \`agents pending\` prints it.`;

function split(args: string[], switches: string[], values: string[]) {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    // "--" ends the options: what follows is text, even when it starts with a dash.
    if (arg === "--") {
      rest.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (switches.includes(name)) flags[name] = "true";
    else if (values.includes(name)) {
      const value = args[++index];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      flags[name] = value;
    } else throw new Error(`Unknown option ${arg}. Run: clawdtime agents help`);
  }
  return { flags, rest };
}

/** One request as the list prints it: its id first, since the id is its name. */
const listed = (request: DecisionRequest) =>
  `${request.id.slice(0, 8)}  ${request.agent} in ${project(request.cwd)}  ${request.kind}: ${request.summary}`;
/**
 * The request with this id, or the one whose id starts with these characters.
 * A place in the list is not taken: the list changes while a person types, so
 * a number can mean another request a moment later.
 */
function pick(pending: DecisionRequest[], query: string | undefined) {
  const wanted = (query ?? "").toLowerCase();
  if (!/^[0-9a-f]{4,16}$/.test(wanted))
    throw new Error(
      [
        "Give the id of the request, or its first four characters or more.",
        ...(pending.length
          ? [
              "These requests wait:",
              ...pending.map((item) => `  ${listed(item)}`),
            ]
          : ["No request waits now."]),
      ].join("\n"),
    );
  const matches = pending.filter((request) => request.id.startsWith(wanted));
  if (matches.length === 1) return matches[0]!;
  throw new Error(
    matches.length
      ? `"${query}" matches ${matches.length} requests.`
      : "That request no longer waits. The agent asks in its own terminal now.",
  );
}
const project = (cwd: string | null) =>
  cwd ? (cwd.split("/").filter(Boolean).at(-1) ?? "/") : "";
const cut = (value: string, width: number) =>
  value.length <= width ? value : `${value.slice(0, width - 1)}…`;
const day = (time: number) => new Date(time).toISOString().slice(0, 10);

function hookFile(system: System, agent: "claude-code" | "codex") {
  return agent === "codex"
    ? join(codexHome(system), "hooks.json")
    : join(claudeHome(system), "settings.json");
}
function hooksReady(
  system: System,
  agent: "claude-code" | "codex",
  script: string,
) {
  const file = hookFile(system, agent);
  try {
    const text =
      existsSync(file) && lstatSync(file).isFile()
        ? readFileSync(file, "utf8")
        : undefined;
    const plan = hookPlan(agent, process.execPath, script);
    return plannedInstalled(text, plan).length === plan.length;
  } catch {
    return false;
  }
}

function clisTable(clis: CliFact[], now: number) {
  const rows = [["AGENT", "VERSION", "RUNNING", "7 DAYS", "ALL", "LAST USED"]];
  for (const cli of clis)
    rows.push([
      cli.label + (cli.installed ? "" : " (not on PATH)"),
      cli.version ?? "",
      String(cli.runningNow),
      cli.sessionsLast7Days === null ? "" : String(cli.sessionsLast7Days),
      cli.sessions === null ? "" : String(cli.sessions),
      cli.lastUsedAt
        ? `${day(cli.lastUsedAt)} (${elapsed(cli.lastUsedAt, now)} ago)`
        : "",
    ]);
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => row[column]!.length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** What the person can do next, most useful first. */
export function nextSteps(
  board: BoardSnapshot,
  clis: CliFact[],
  ready: { claude: boolean; codex: boolean },
  rules: number,
  now: number,
) {
  const steps: string[] = [];
  for (const session of board.sessions
    .filter((item) => item.state === "needs_you")
    .slice(0, 5))
    steps.push(
      `Answer ${title(session)} (${session.agentLabel}). It has waited ${elapsed(session.since, now) || "a moment"}.`,
    );
  const has = (kind: string) =>
    clis.some((cli) => cli.kind === kind && cli.installed);
  if (has("claude-code") && !ready.claude)
    steps.push(
      "Let ClawdTime answer Claude Code: clawdtime agents hooks install --agent claude-code",
    );
  if (has("codex") && !ready.codex)
    steps.push(
      "Let ClawdTime see and answer Codex approvals: clawdtime agents hooks install --agent codex, then /hooks in Codex.",
    );
  if (
    board.sessions.some(
      (session) =>
        session.terminal.app === "Ghostty" && session.focus === "app",
    )
  )
    steps.push(
      "Update Ghostty to 1.4 or later. Then ClawdTime opens the exact tab and can type into it.",
    );
  if (!rules)
    steps.push(
      "Approve a request with --always, or the Always button, to make the first standing rule.",
    );
  return steps;
}

/**
 * The jobs of this Mac. A session works in the folder that the command was
 * started in, with the person's own coding agent.
 */
function jobsFor(system: System, root: string, runner: Runner) {
  const agent = system.env.CLAWDTIME_JOB_AGENT as JobAgent | undefined;
  return new Jobs(root, {
    project: system.env.CLAWDTIME_JOB_PROJECT || process.cwd(),
    now: () => system.now(),
    run: runner,
    agent: agent && jobAgents.includes(agent) ? agent : "claude",
    terminal: system.env.CLAWDTIME_JOB_TERMINAL || "Terminal",
  });
}

export async function supervisorCli(
  group: string,
  args: string[],
  deps: SupervisorDependencies,
) {
  const { system, runner, print } = deps;
  const root = stateRoot(system);
  const desk = new DecisionDesk(root, () => system.now());
  const trove = desk.trove;
  const command = args[0] ?? "";

  if (group === "view") {
    // What the video of a call shows: one window, or the whole screen. The line agent reads it.
    const store = new ViewStore(root, () => system.now());
    if (command === "clear") {
      store.set(null);
      return print("The call shows the whole screen.");
    }
    const { flags } = split(args, ["json"], []);
    const now = store.get();
    if (flags.json) return print(JSON.stringify(now));
    return print(
      now.view
        ? `The call shows one window: ${Math.round(now.view.w * 100)} by ${Math.round(now.view.h * 100)} percent of the screen.`
        : "The call shows the whole screen.",
    );
  }

  if (group === "jobs") {
    const jobs = jobsFor(system, root, runner);
    if (command === "retire") {
      const { flags, rest } = split(args.slice(1), [], ["reason"]);
      if (rest.length !== 1 || !flags.reason)
        throw new Error(
          "Use: clawdtime jobs retire ID --reason TEXT. This retires bookkeeping only; it does not stop a process or verify its outcome.",
        );
      return print(jobs.retire(rest[0]!, flags.reason));
    }
    const { flags } = split(args, ["json"], []);
    const list = jobs.recent(20);
    if (flags.json) return print(JSON.stringify(list, null, 2));
    if (!list.length) return print("ClawdTime started no job yet.");
    // The first line is as it was: DONE or WORKING. A job with no answer
    // gets a second line with what its receipts prove. A job that its
    // receipts say does not work is not listed as WORKING: it gets the name
    // of its status.
    const ended = new Set([
      "retired_unknown",
      "launch_failed",
      "exited_without_result",
    ]);
    for (const job of list)
      print(
        `${job.done ? "DONE   " : job.status && ended.has(job.status) ? job.status.toUpperCase() : "WORKING"}  ${job.id}  ${job.job.slice(0, 80)}\n         ${job.done ? (job.result ?? "").slice(0, 300) : `${(job.status ?? "unknown").toUpperCase()}: ${jobStatusDetail(job)}`}`,
      );
    return;
  }

  if (group === "agents") {
    if (command === "pending") {
      const { flags } = split(args.slice(1), ["json", "attend"], []);
      // --attend: another Mac reads this list over ssh for a person who is at
      // that Mac. The hooks here then hold for an answer, as with the panel.
      if (flags.attend) desk.attend();
      const pending = desk.pending();
      if (flags.json)
        return print(
          JSON.stringify(
            { away: desk.away(), attended: desk.attended(), pending },
            null,
            2,
          ),
        );
      if (!pending.length)
        return print(
          desk.attended()
            ? "Nothing waits for an answer."
            : "Nothing waits. ClawdTime answers agents only while its panel or `agents watch` runs.",
        );
      pending.forEach((request) => {
        const before = trove.suggest(request);
        const hint =
          before.allowed + before.denied
            ? `  (before: allowed ${before.allowed}, denied ${before.denied})`
            : "";
        print(`${listed(request)}${hint}`);
        request.options.forEach((option, choice) =>
          print(`     ${choice + 1}) ${option}`),
        );
        if (request.answerInTerminal)
          print(
            "     This is not all of it. Allow it in its own terminal. You can deny it here.",
          );
        const said = desk.recalled(request);
        if (said) print(`     you said before: ${cut(said, 110)}`);
      });
      return;
    }
    if (command === "approve" || command === "deny" || command === "answer") {
      const { flags, rest } = split(args.slice(1), ["always"], ["message"]);
      const request = pick(desk.pending(), rest[0]);
      let ok: boolean;
      if (command === "answer") {
        const given = rest.slice(1).join(" ").trim();
        const choice = /^\d$/.test(given)
          ? request.options[Number(given) - 1]
          : undefined;
        ok = desk.answer(request.id, {
          decision: "answer",
          text: choice ?? given,
          via: "cli",
        });
      } else {
        ok = desk.answer(request.id, {
          decision: command === "approve" ? "allow" : "deny",
          text: flags.message ?? null,
          via: "cli",
          remember: flags.always === "true",
        });
      }
      if (!ok) {
        process.exitCode = 2;
        if (command === "approve" && request.answerInTerminal)
          return print(answerInTerminalText);
        return print(
          request.kind === "question" &&
            command !== "answer" &&
            command !== "deny"
            ? "This is a question: use `agents answer`."
            : "That request cannot take this answer, or it no longer waits.",
        );
      }
      return print(
        command === "approve"
          ? !flags.always
            ? "Allowed. The agent continues."
            : request.kind === "permission" && rememberable(request)
              ? "Allowed, and remembered for this project. The agent continues."
              : "Allowed this once. A rule cannot cover this request, so nothing is remembered. The agent continues."
          : command === "deny"
            ? "Denied. The agent is told."
            : "Answered. The agent continues.",
      );
    }
    if (command === "away") {
      const mode = args[1];
      if (mode === "on" || mode === "off") desk.setAway(mode === "on");
      else if (mode !== "status" && mode !== undefined)
        throw new Error("Use: clawdtime agents away on|off|status");
      return print(
        desk.away()
          ? "Away: requests wait up to 9 minutes for an answer by phone."
          : "Here: requests wait 45 seconds for an answer in ClawdTime, then the agent asks in its terminal.",
      );
    }
    if (command === "call") {
      const { flags, rest } = split(args.slice(1), [], ["agent", "project"]);
      const action = rest[0] ?? "status";
      if (action === "connect") {
        const adapter = flags.agent;
        if (adapter !== "codex" && adapter !== "claude-code")
          throw new Error(
            "Use: clawdtime agents call connect --agent claude-code|codex --project PATH",
          );
        const folder = realpathSync(flags.project ?? process.cwd());
        saveCallLink(root, {
          connectionFile: connectionPath(folder, adapter),
          project: folder,
          adapter,
          linkedAt: system.now(),
        });
        return print(
          "Linked. In away mode a request that waits becomes a FaceTime call through this pairing, and your spoken answer goes to the agent.",
        );
      }
      if (action === "check") {
        const link = loadCallLink(root);
        if (!link)
          throw new Error(
            "No phone link. First: clawdtime agents call connect --agent claude-code --project PATH",
          );
        // It asks the backend only. No call is placed and no phone rings.
        for (const line of callCheckText(
          await checkCall(link, `check-${system.now().toString(36)}`),
        ))
          print(line);
        return;
      }
      if (action === "me") {
        const link = loadCallLink(root);
        if (!link)
          throw new Error(
            "No phone link. First: clawdtime agents call connect --agent claude-code --project PATH",
          );
        const board = () =>
          new BoardScanner(system, { includeHeadless: false }).scan();
        const titles = titleReader(system);
        // CLAWDTIME_CHAT=agent: the chat agent talks on the call; otherwise the supervisor.
        const supervisor = chatBrain({
          env: system.env,
          root,
          ...(deps.request ? { request: deps.request } : {}),
          world: {
            now: () => system.now(),
            board,
            desk,
            focus: (session) =>
              focusSession(
                session,
                runner,
                "tmux",
                tabTitles(session, titles(session)),
              ),
            send: (session, text) =>
              sendText(session, text, { enter: true }, runner),
            clis: () => inventory(system, board()),
            titles,
            window: (session, action) =>
              sessionWindow(
                session,
                action,
                runner,
                tabTitles(session, titles(session)),
              ),
            jobs: jobsFor(system, root, runner),
            openApp: (name, url) => openApp(system, name, url, runner),
            callView: (target) =>
              showOnCall(
                {
                  store: new ViewStore(root, () => system.now()),
                  run: runner,
                  titles: (item) => tabTitles(item, titles(item)),
                },
                target,
              ),
            browse: (action, options) =>
              browse(system, runner, action, options),
            look: (question) =>
              lookAtScreen(
                {
                  run: runner,
                  key:
                    system.env.CLAWDTIME_OPENAI_API_KEY ||
                    system.env.OPENAI_API_KEY,
                  model: system.env.CLAWDTIME_VISION_MODEL || "gpt-4.1-mini",
                  ...(deps.request ? { request: deps.request } : {}),
                },
                question,
              ),
          },
        });
        const log = new ChatLog(root);
        print("Calling you. Say goodbye to end the call.");
        const result = await converseByCall(
          await openCall(link, `talk-${system.now().toString(36)}`),
          async (spoken) => {
            if (spoken.length > userMessageLimit) return userMessageTooLong;
            const history = log.recent(historyForTurn);
            log.append({
              role: "user",
              text: spoken,
              at: system.now(),
              via: "call",
            });
            const answer = await supervisor.reply(history, spoken, "call");
            log.append({
              role: "assistant",
              text: answer,
              at: system.now(),
              via: "call",
            });
            return answer;
          },
          {
            now: () => Date.now(),
            deadline: Date.now() + 10 * 60_000,
            greeting: "ClawdTime here. What do you need?",
            key: system.now().toString(36),
          },
        );
        return print(
          `The call ended (${result.ended === "lost" ? "the backend stopped answering" : result.ended.replace("_", " ")}) after ${result.turns} ${result.turns === 1 ? "turn" : "turns"}.`,
        );
      }
      if (action === "disconnect") {
        removeCallLink(root);
        return print(
          "The phone link is removed. The pairing itself is unchanged.",
        );
      }
      if (action !== "status")
        throw new Error(
          "Use: clawdtime agents call connect|status|check|me|disconnect",
        );
      const link = loadCallLink(root);
      return print(
        link
          ? `Linked to the ${link.adapter} pairing of ${link.project}. ${desk.away() ? "Away is on: requests are answered by phone." : "Turn it on with: clawdtime agents away on"}`
          : "No phone link. Pair a project with `clawdtime setup`, then: clawdtime agents call connect --agent claude-code --project PATH",
      );
    }
    if (command === "send") {
      const { flags, rest } = split(args.slice(1), ["no-enter"], []);
      if (rest.length < 2)
        throw new Error("Use: clawdtime agents send SESSION TEXT");
      const book = new HostBook(root);
      const local = new BoardScanner(system, { includeHeadless: true }).scan();
      // The id of this Mac's own session needs no call to another Mac.
      const session = deps.findSession(
        local.sessions.some((item) => item.id === rest[0])
          ? local
          : await boardWithRemotes(local, book, runner, () => system.now()),
        rest[0]!,
      );
      const enter = flags["no-enter"] !== "true";
      const text = rest.slice(1).join(" ");
      const remote = book.get(session.host);
      const result = remote
        ? await remoteSend(remote, session, text, enter, runner)
        : await sendText(session, text, { enter }, runner);
      if (!result.ok) {
        process.exitCode = 2;
        return print(
          remote
            ? `The text did not reach ${title(session)} on ${remote.name}. ClawdTime there types into tmux, Ghostty 1.4 or later, Terminal or iTerm2.`
            : result.route === "none"
              ? `${title(session)} runs in a terminal that cannot take text from here. Run the agent in tmux, or use Ghostty 1.4 or later, Terminal or iTerm2.`
              : `The text did not reach ${title(session)}.`,
        );
      }
      return print(
        remote
          ? `Typed into ${title(session)} on ${remote.name}.`
          : `Typed into ${title(session)} through ${result.route}.`,
      );
    }
    throw new Error("Unknown command. Run: clawdtime agents help");
  }

  if (group === "trove") {
    if (command === "" || command === "list") {
      const entries = trove.decisions(20).reverse();
      if (!entries.length)
        return print(
          "The trove is empty. It fills as you answer agents through ClawdTime.",
        );
      for (const entry of entries)
        print(
          `${day(entry.at)}  ${entry.decision.padEnd(6)} ${entry.via.padEnd(8)} ${entry.agent} in ${entry.project}  ${cut(entry.summary, 80)}`,
        );
      return;
    }
    if (command === "search") {
      const found = trove.search(args.slice(1).join(" "));
      if (!found.length) return print("No decision matches.");
      for (const entry of found)
        print(
          `${day(entry.at)}  ${entry.decision.padEnd(6)} ${entry.agent} in ${entry.project}  ${cut(entry.summary, 80)}${entry.text ? `  -> ${cut(entry.text, 60)}` : ""}`,
        );
      return;
    }
    if (command === "note") {
      const { flags, rest } = split(args.slice(1), [], ["project"]);
      const note = trove.note(
        rest.join(" "),
        flags.project ?? null,
        system.now(),
      );
      return print(`Kept as a critical decision (${note.id}).`);
    }
    if (command === "rules") {
      const rules = trove.rules();
      if (!rules.length)
        return print("No standing rule. A person answers every request.");
      for (const rule of rules)
        print(
          `${rule.id}  allow ${rule.pattern}  for ${rule.agent} in ${rule.cwd}  (since ${day(rule.createdAt)})`,
        );
      return;
    }
    if (command === "forget") {
      if (!args[1] || !trove.removeRule(args[1])) {
        process.exitCode = 2;
        return print("No rule has that id. See: clawdtime trove rules");
      }
      return print("Rule removed. That request waits for a person again.");
    }
    if (command === "playbook") {
      const { flags } = split(args.slice(1), [], ["out"]);
      const text = trove.playbook(system.now());
      if (!flags.out) return print(text.trimEnd());
      const file = resolve(flags.out);
      writeFileSync(file, text, { mode: 0o600 });
      return print(`Playbook written to ${file}`);
    }
    throw new Error(
      "Use: clawdtime trove list|search WORDS|rules|forget RULE|note TEXT|playbook",
    );
  }

  if (group === "memory") {
    const memory = desk.memory;
    const mark = (fact: { source: string; current: boolean }) =>
      `${fact.source === "inferred" ? "  (inferred)" : ""}${fact.current ? "" : "  (replaced)"}`;
    if (command === "" || command === "status") {
      const facts = memory.facts();
      const kept = facts.filter((fact) => fact.current).length;
      return print(
        `Memory is ${memory.enabled() ? "on" : "off"}. ${kept} ${kept === 1 ? "fact" : "facts"} kept${facts.length > kept ? `, ${facts.length - kept} replaced` : ""}.${memory.enabled() ? "" : " Turn it on: clawdtime memory on"}`,
      );
    }
    if (command === "on" || command === "off") {
      memory.setEnabled(command === "on");
      return print(
        command === "on"
          ? "Memory is on. ClawdTime keeps what you tell it, on this Mac only."
          : "Memory is off. Nothing is read and nothing is written. What was kept stays until you forget it.",
      );
    }
    if (command === "show") {
      const facts = memory
        .facts()
        .sort(
          (left, right) =>
            Number(right.current) - Number(left.current) ||
            right.updatedAt - left.updatedAt,
        );
      if (!facts.length) return print("Memory is empty.");
      for (const fact of facts)
        print(
          `${fact.id}  ${day(fact.updatedAt)}  ${fact.kind.padEnd(10)} ${fact.strength > 1 ? `x${fact.strength} ` : ""}${fact.scope ? `[${project(fact.scope)}] ` : ""}${fact.text}${fact.expiresAt ? `  (until ${day(fact.expiresAt)})` : ""}${mark(fact)}`,
        );
      return;
    }
    if (command === "search") {
      const found = memory.search(args.slice(1).join(" "));
      if (!found.length) return print("Nothing in memory matches.");
      for (const { fact, score } of found)
        print(`${fact.id}  ${score.toFixed(2)}  ${fact.text}${mark(fact)}`);
      return;
    }
    if (command === "remember") {
      if (!memory.enabled())
        throw new Error("Memory is off. Turn it on: clawdtime memory on");
      const { flags, rest } = split(
        args.slice(1),
        [],
        ["kind", "days", "project"],
      );
      const kind = flags.kind ?? "fact";
      if (kind !== "fact" && kind !== "preference" && kind !== "episode")
        throw new Error("Use --kind fact, preference or episode.");
      const kept = memory.remember({
        text: rest.join(" "),
        kind,
        days: flags.days ? Number(flags.days) : null,
        scope: flags.project ? realpathSync(flags.project) : null,
      });
      return print(
        kept.added
          ? `Kept (${kept.fact.id}).`
          : `Known already (${kept.fact.id}). It counts for more now.`,
      );
    }
    if (command === "forget") {
      const removed = memory.forget(args.slice(1).join(" "));
      if (!removed) {
        process.exitCode = 2;
        return print("Nothing in memory matches. See: clawdtime memory show");
      }
      return print(
        `Removed ${removed} ${removed === 1 ? "fact" : "facts"} for good.`,
      );
    }
    throw new Error(
      "Use: clawdtime memory status|on|off|show|search WORDS|remember TEXT|forget ID|TEXT",
    );
  }

  if (group === "clis" || group === "report") {
    const board = new BoardScanner(system, { includeHeadless: false }).scan();
    const clis = inventory(system, board);
    if (group === "clis") {
      const { flags } = split(args, ["json"], []);
      return print(
        flags.json
          ? JSON.stringify(clis, null, 2)
          : clisTable(clis, system.now()),
      );
    }
    const { flags } = split(args, ["open"], ["out"]);
    const now = system.now();
    const next = nextSteps(
      board,
      clis,
      {
        claude: hooksReady(system, "claude-code", deps.hookScript),
        codex: hooksReady(system, "codex", deps.hookScript),
      },
      trove.rules().length,
      now,
    );
    const deck = renderDeck({
      now,
      board,
      clis,
      decisions: trove.decisions(2000),
      rules: trove.rules(),
      notes: trove.notes(),
      next,
    });
    const file = resolve(
      flags.out ?? join(root, "reports", `clawdtime-report-${day(now)}.html`),
    );
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, deck, { mode: 0o600 });
    print(`Report written to ${file}`);
    if (flags.open) await runner("/usr/bin/open", [file], 8000);
    return;
  }

  // A new chat, the chats that were put aside, and one of them back. The
  // desktop service does it when it runs: it owns the chat of the panel and
  // knows what waits for the person. With no service, the command changes the
  // files itself. A word that does not fit is a message: "open Safari".
  const desktopOptions = deps.request ? { request: deps.request } : {};
  const kept = async (): Promise<ArchivedChat[]> =>
    (await desktopChatHistory(system, desktopOptions)) ??
    new ChatLog(root).history();
  const newChatHere = async (
    change: "new" | { open: string },
    supervisor?: ChatBrain,
  ) => {
    const sent = await changeDesktopChat(system, change, desktopOptions);
    if (sent.kind !== "absent")
      return {
        ok: sent.kind === "answered" && sent.ok === true,
        text: sent.text,
      };
    const result = switchChat(new ChatLog(root), change, system.now());
    if (result.ok) supervisor?.newConversation();
    return result;
  };
  if (group === "chat" && args.length === 1 && args[0] === "history") {
    const chats = await kept();
    if (!chats.length)
      return print(
        "No chat is kept yet. clawdtime chat new puts the current chat aside.",
      );
    for (const chat of chats)
      print(
        `${chat.id}  ${chat.messages} ${chat.messages === 1 ? "message" : "messages"}  ${chat.first || "(no words)"}`,
      );
    return print("Open one with: clawdtime chat open TIME");
  }
  const opens =
    group === "chat" &&
    args.length === 2 &&
    args[0] === "open" &&
    /^[0-9]{8}/.test(args[1]!);
  if (
    group === "chat" &&
    (opens || (args.length === 1 && (args[0] === "new" || args[0] === "clear")))
  ) {
    let change: "new" | { open: string } = "new";
    if (opens) {
      // The full time, or its start when only one kept chat has it.
      const wanted = args[1]!.toUpperCase();
      const matches = chatArchiveId.test(wanted)
        ? [wanted]
        : (await kept())
            .map((chat) => chat.id)
            .filter((id) => id.startsWith(wanted));
      if (matches.length !== 1)
        throw new Error(
          matches.length
            ? `"${args[1]}" fits ${matches.length} kept chats. Give more of the time. Run: clawdtime chat history`
            : `No kept chat has the time ${args[1]}. Run: clawdtime chat history`,
        );
      change = { open: matches[0]! };
    }
    const result = await newChatHere(change);
    if (!result.ok) throw new Error(result.text);
    return print(result.text);
  }

  if (group === "chat" && args.length && !args[0]!.startsWith("-")) {
    // One message: when the desktop service runs, it answers. It has the
    // task, the engine for computer work and the conversation of the panel,
    // and this command has none of them. With no service, or one that does
    // not answer its first reads in two seconds, this command answers as
    // before. So it does when the service has no language model and this
    // command has one. A message that may be with the service is never said
    // again here: two brains must not act on one sentence. Words that start
    // with a dash are an option of this command, never a message.
    const said = await sayToDesktop(system, args.join(" "), {
      ownModel:
        deps.model !== undefined
          ? deps.model !== null
          : !!(
              system.env.CLAWDTIME_OPENAI_API_KEY || system.env.OPENAI_API_KEY
            ),
      ...(deps.request ? { request: deps.request } : {}),
    });
    if (said.kind !== "absent") return print(said.text);
  }
  if (group === "chat" || group === "talk" || group === "texts") {
    const board = () =>
      new BoardScanner(system, { includeHeadless: false }).scan();
    const titles = titleReader(system);
    // CLAWDTIME_CHAT=agent: the chat agent answers; otherwise the supervisor.
    const supervisor = chatBrain({
      env: system.env,
      root,
      ...(deps.model !== undefined ? { model: deps.model } : {}),
      ...(deps.request ? { request: deps.request } : {}),
      world: {
        now: () => system.now(),
        board,
        desk,
        focus: (session) =>
          focusSession(
            session,
            runner,
            "tmux",
            tabTitles(session, titles(session)),
          ),
        send: (session, text) =>
          sendText(session, text, { enter: true }, runner),
        clis: () => inventory(system, board()),
        titles,
        window: (session, action) =>
          sessionWindow(
            session,
            action,
            runner,
            tabTitles(session, titles(session)),
          ),
        jobs: jobsFor(system, root, runner),
        openApp: (name, url) => openApp(system, name, url, runner),
        callView: (target) =>
          showOnCall(
            {
              store: new ViewStore(root, () => system.now()),
              run: runner,
              titles: (item) => tabTitles(item, titles(item)),
            },
            target,
          ),
        browse: (action, options) => browse(system, runner, action, options),
        look: (question) =>
          lookAtScreen(
            {
              run: runner,
              key:
                system.env.CLAWDTIME_OPENAI_API_KEY ||
                system.env.OPENAI_API_KEY,
              model: system.env.CLAWDTIME_VISION_MODEL || "gpt-4.1-mini",
              ...(deps.request ? { request: deps.request } : {}),
            },
            question,
          ),
      },
    });
    const log = new ChatLog(root);
    const turn = async (words: string, via: "chat" | "voice") => {
      if (words.length > userMessageLimit) return userMessageTooLong;
      // "New chat", typed: no turn of the brain, and no line of it is kept.
      if (via === "chat" && asksForNewChat(words))
        return (await newChatHere("new", supervisor)).text;
      const history = log.recent(historyForTurn);
      log.append({
        role: "user",
        text: words,
        at: system.now(),
        via,
      });
      const answer = await supervisor.reply(history, words, via);
      log.append({ role: "assistant", text: answer, at: system.now(), via });
      return answer;
    };
    if (group === "texts") {
      const found = textSettings(system.env, root);
      if ("missing" in found)
        throw new Error(
          `Text messages need these settings in the environment: ${found.missing.join(", ")}. Run clawdtime connect, or see SETUP_CLAWDTIME.md.`,
        );
      if (command === "check") {
        // One read of the messages. It writes nothing, runs no work and sends nothing.
        const state = await checkTexts(found.settings, deps.request);
        return print(
          state === "ok"
            ? "The key works and the messages can be read. Run: clawdtime texts run"
            : state === "refused"
              ? "The project API key was refused. Make a key with read and write access, and check the project id."
              : "The messages could not be read now. Check the network and CHERT_API_BASE, then try again.",
        );
      }
      if (command !== "run")
        throw new Error("Use: clawdtime texts run, or clawdtime texts check");
      const channel = new TextChannel({
        settings: found.settings,
        root,
        now: () => system.now(),
        // A desktop service on this Mac takes the owner's text first, as it
        // takes the words of a call: it has the computer worker, so a text
        // can answer the question that the worker texted. The mark tells the
        // service that these exact words came by text.
        answer: async (words) => {
          try {
            markTextTurn(root, words.trim(), system.now());
          } catch {
            // Without the mark the service reads the text as a chat message.
          }
          const said = await sayToDesktop(system, words, {
            // The same as before: this command has a model of its own.
            ownModel: supervisor.ready,
            ...(deps.request ? { request: deps.request } : {}),
          });
          return said.kind === "absent" ? turn(words, "chat") : said.text;
        },
        jobs: () => jobsFor(system, root, runner).recent(20),
        ...(deps.request ? { request: deps.request } : {}),
        log: (line) => print(`${new Date(system.now()).toISOString()} ${line}`),
      });
      if (!supervisor.ready)
        print(
          "No language model key is set: I tell the state and take a clear approve or deny.",
        );
      print(
        `Listening for your text messages. Ctrl+C stops it.\nA text counts when it comes from a phone that is joined to your project and whose number ends with the last four digits of yours${found.settings.word ? ", and when it starts with your word" : ""}. Keep the phone list of the project to your own phone.`,
      );
      const stop = new AbortController();
      process.once("SIGINT", () => stop.abort());
      process.once("SIGTERM", () => stop.abort());
      const ended = await channel.run(stop.signal);
      if (ended === "refused") {
        process.exitCode = 3;
        print("The project API key was refused. The channel stopped.");
      }
      if (ended === "busy") {
        process.exitCode = 4;
        print(
          "Another clawdtime texts run already answers these texts on this Mac. This one did not start.",
        );
      }
      return supervisor.learning;
    }
    if (group === "chat" && args[0] === "--recent") {
      // The newest messages of the conversation, as data: a call that starts reads them, so it knows what came before.
      const count = Math.min(40, Math.max(1, Number(args[1]) || 12));
      return print(
        JSON.stringify(
          log.recent(count).map((message) => ({
            role: message.role,
            text: message.text.slice(0, 400),
            at: message.at,
          })),
        ),
      );
    }
    if (group === "chat") {
      if (args.length) {
        print(await turn(args.join(" "), "chat"));
        // With memory on, what the message taught is still being written.
        return supervisor.learning;
      }
      if (!supervisor.ready)
        print(
          "No language model key is set: I tell the state and take a clear approve or deny.",
        );
      const lines = createInterface({ input: process.stdin });
      for await (const line of lines)
        if (line.trim()) print(await turn(line, "chat"));
      return supervisor.learning;
    }
    const speech = speechSettings(system.env);
    if (!speech)
      throw new Error(
        "Speech needs CLAWDTIME_OPENAI_API_KEY or OPENAI_API_KEY in the environment.",
      );
    const folder = join(root, "agents", "voice");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    // Each line of input is read once, in order, however fast it arrives.
    const lines = createInterface({ input: process.stdin });
    const waiting: string[] = [];
    let wake: ((line: string | null) => void) | null = null;
    let ended = false;
    lines.on("line", (line) => {
      if (wake) {
        const done = wake;
        wake = null;
        done(line);
      } else waiting.push(line);
    });
    lines.on("close", () => {
      ended = true;
      wake?.(null);
    });
    await talkLoop({
      print,
      next: () =>
        new Promise<string | null>((done) => {
          const line = waiting.shift();
          if (line !== undefined) done(line);
          else if (ended) done(null);
          else wake = done;
        }),
      record: () => {
        const file = join(folder, `talk-${Date.now().toString(36)}.wav`);
        // The default microphone, one channel, 16 kHz: enough for speech.
        const recorder = spawn(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "avfoundation",
            "-i",
            ":default",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-y",
            file,
          ],
          { stdio: ["pipe", "ignore", "ignore"] },
        );
        const exited = new Promise<void>((done) => {
          recorder.once("exit", () => done());
          recorder.once("error", () => done());
        });
        return {
          stop: async () => {
            recorder.stdin?.write("q");
            await exited;
            return file;
          },
        };
      },
      hear: async (file) => {
        try {
          return await transcribe(
            file,
            speech,
            speechVocabulary({
              env: system.env,
              memory: desk.memory,
              journal: new ComputerJournal(root),
            }),
          );
        } finally {
          rmSync(file, { force: true });
        }
      },
      answer: (words) => turn(words, "voice"),
      say: async (text) => {
        const sound = join(folder, "talk-reply.mp3");
        writeFileSync(sound, await speak(text, speech), { mode: 0o600 });
        await runner("/usr/bin/afplay", [sound], 60_000);
      },
    });
    lines.close();
    return;
  }

  if (group === "browser") {
    const running = browsers.filter((name) =>
      readProcesses(system).some((process) =>
        process.command.includes(`/${name}.app/Contents/MacOS/`),
      ),
    );
    const { flags, rest } = split(args.slice(1), [], ["in"]);
    const chosen = flags.in
      ? browsers.find((name) =>
          name.toLowerCase().includes(flags.in!.toLowerCase()),
        )
      : undefined;
    if (flags.in && !chosen)
      throw new Error(`Unknown browser. One of: ${browsers.join(", ")}`);
    if (command === "open") {
      if (!rest[0]) throw new Error("Use: clawdtime browser open URL");
      const ok = await openPage(rest[0], chosen ?? null, runner);
      if (!ok) process.exitCode = 2;
      return print(ok ? "Opened." : "The page did not open.");
    }
    const targets: BrowserName[] = chosen ? [chosen] : running;
    if (!targets.length) return print("No browser is running.");
    if (command === "tabs" || command === "focus") {
      const tabs = await listTabs(targets, runner);
      if (command === "tabs") {
        if (!tabs.length)
          return print(
            "No tab could be read. macOS may be asking for permission to control the browser.",
          );
        tabs.forEach((tab, index) =>
          print(
            `${String(index + 1).padStart(3)}. ${tab.active ? "*" : " "} ${tab.browser}  ${cut(tab.title, 60)}  ${cut(tab.url, 70)}`,
          ),
        );
        return;
      }
      const tab = tabs[Number(rest[0]) - 1];
      if (!tab)
        throw new Error(
          "Give the number of a tab from: clawdtime browser tabs",
        );
      const ok = await focusTab(tab, runner);
      if (!ok) process.exitCode = 2;
      return print(
        ok
          ? `Brought forward: ${cut(tab.title, 60)}`
          : "The tab did not come forward.",
      );
    }
    if (command === "text") {
      const page = await frontPageText(targets[0]!, runner);
      if (page === null) {
        process.exitCode = 2;
        return print(
          `${targets[0]} refused. Turn on "Allow JavaScript from Apple Events" in its Develop or View menu, then try again.`,
        );
      }
      return print(page);
    }
    throw new Error("Use: clawdtime browser tabs | open URL | focus N | text");
  }
  throw new Error("Unknown command. Run: clawdtime help");
}
