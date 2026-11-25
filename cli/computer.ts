import { homedir } from "node:os";
import { stateRoot } from "../connectors/agents/hooks.js";
import {
  ComputerJournal,
  computerDirectory,
  computerFolderPrivate,
  readComputerSwitch,
  setComputerSwitch,
  type JournalRequest,
} from "../connectors/computer/journal.js";
import { readTimings, timingLine } from "../connectors/computer/timing.js";
import {
  defaultComputerModel,
  fallbackComputerModel,
} from "../connectors/computer/planner.js";
import type { BrowserPort } from "../connectors/computer/ports.js";
import { browserSwitch } from "../connectors/computer/browser.js";
import { inspectDesktopReadiness } from "../connectors/agents/desktop-readiness.js";
import { readReach } from "../connectors/computer/reach.js";
import { Routines } from "../connectors/computer/routines.js";

export const computerHelp = `clawdtime computer: ClawdTime does a task on this Mac by itself, one checked action at a time
  computer status   on or off, and the last request
  computer on       turn it on. Start the ClawdTime desktop service again after this
  computer off      turn it off. A request that runs stops before its next action
  computer doctor [--json]   configured service, capabilities and missing checks
  computer clear    you looked at the result of a request with an unknown result: new work can start
  computer timing   the time of the newest steps: the look, the plan and the action of each
When a question waits and you do not answer in the chat, ClawdTime calls you on
the line, or texts you when the call does not get through. doctor says whether
it can. Routines: clawdtime routine help.
It is off until you turn it on. Every action is checked in code, and a click that
cannot be undone needs your yes. See docs/COMPUTER_USE.md.`;
const usage = "Use: clawdtime computer status|on|off|doctor|clear|timing";

export interface ComputerCliDependencies {
  /** The environment. It says where the state folder is and whether a key is there. */
  env?: Record<string, string | undefined>;
  home?: string;
  now?: () => number;
  print?: (line: string) => void;
  /** The browser, when one is connected: doctor asks it whether it can be driven. */
  browser?: BrowserPort;
  /** Read-only desktop readiness probe; injectable for isolated tests. */
  request?: typeof fetch;
}

/** Why the reach cannot call or text, in plain words. Only fixed codes come in. */
const reachReason = (reason: string) => {
  if (reason.startsWith("missing:"))
    return `these settings are missing in the environment of the desktop service: ${reason.slice(8).split(",").join(", ")}. See SETUP_CLAWDTIME.md`;
  const plain: Record<string, string> = {
    outbound_setup_missing:
      "the line is not set up for proactive calls: proactive.json of the desktop service has no outbound line",
    not_set_up:
      "the line is not set up for proactive calls in this desktop service",
    no_policy:
      "no active calling policy lets ClawdTime call you about a question in this project",
    calling_policy_ambiguous:
      "more than one calling policy fits this project. Keep one",
    earlier_call_unknown:
      "an earlier call has an unknown outcome. Reconcile it with clawdtime proactive doctor first",
    line_in_a_call: "the line is in a call now",
    no_line:
      "no line is known yet. Set CHERT_LINE_ID, or text the line once while clawdtime texts run listens",
    readiness_failed: "its check failed",
  };
  return plain[reason] ?? reason.replace(/_/g, " ");
};
/** What the reach of the running desktop service last said, and the routines. */
function reachRows(
  root: string,
  env: Record<string, string | undefined>,
  now: number,
) {
  const found = readReach(root);
  const said = found?.readiness;
  const fresh = said && now - said.at < 5 * 60_000;
  const off = env.CLAWDTIME_COMPUTER_REACH === "off";
  const side = (value: { ready: boolean; reason: string } | undefined) =>
    off
      ? "off: CLAWDTIME_COMPUTER_REACH=off"
      : !found
        ? "unknown: computer/reach.json cannot be read"
        : !value || !fresh
          ? "not reported: start the desktop service with the computer worker on. It says this within a minute"
          : value.ready
            ? "ready. When a question waits, ClawdTime reaches you this way"
            : `not ready: ${reachReason(value.reason)}`;
  let routines: string;
  try {
    const all = new Routines({ root }).list();
    const paused = all.filter((routine) => routine.paused).length;
    routines = all.length
      ? `${all.length - paused} active, ${paused} paused. See: clawdtime routine list`
      : "none. Add one: clawdtime routine add every morning at 9, follow up on my latest posts";
  } catch {
    routines = "computer/routines.json cannot be read";
  }
  return { calls: side(said?.calls), texts: side(said?.texts), routines };
}

const steps = (count: number) => `${count} ${count === 1 ? "step" : "steps"}`;
/** The last request in one or two sentences. */
function lastLine(request: JournalRequest) {
  if (request.state === "uncertain" && request.clearedAt !== undefined)
    return `Last request: "${request.goal}" had an unknown result. You cleared it.`;
  const head = `Last request: "${request.goal}" is ${request.state.replaceAll("_", " ")}, after ${steps(request.steps.length)}.`;
  return request.state === "uncertain"
    ? `${head} Its result is not known. It is not run again, and no new work starts. Look at the screen, then run: clawdtime computer clear`
    : head;
}
const unreadable =
  "The record of computer requests cannot be read, so no new work starts. Run: clawdtime computer clear";

/**
 * The switch and the record of computer use. Nothing here sees the screen or
 * sends input: that is the worker in the desktop service, through the panel.
 */
export async function computerCli(
  args: string[],
  dependencies: ComputerCliDependencies = {},
) {
  const env = dependencies.env ?? process.env;
  const print = dependencies.print ?? console.log;
  const now = dependencies.now ?? Date.now;
  const root = stateRoot({ env, home: dependencies.home ?? homedir() });
  const command = args[0] ?? "status";
  const json = command === "doctor" && args[1] === "--json";
  if (args.length > (json ? 2 : 1)) throw new Error(usage);
  if (command === "help" || command === "--help") return print(computerHelp);
  const journal = new ComputerJournal(root, now);
  const keyName = env.CLAWDTIME_OPENAI_API_KEY
    ? "CLAWDTIME_OPENAI_API_KEY"
    : env.OPENAI_API_KEY
      ? "OPENAI_API_KEY"
      : null;
  if (command === "status") {
    const chosen = readComputerSwitch(root);
    print(
      chosen.enabled
        ? `Computer use is on, since ${new Date(chosen.since ?? 0).toISOString().slice(0, 10)}.`
        : (chosen.problem ??
            "Computer use is off. Turn it on: clawdtime computer on"),
    );
    if (env[browserSwitch] === "own")
      print(
        "Browser: ClawdTime's own browser, with its own profile. It starts at the first browser step. Check it: clawdtime computer doctor",
      );
    else if (env[browserSwitch] === "on")
      print(
        "Browser: the browser in front, through its own scripting. Check it: clawdtime computer doctor",
      );
    if (!journal.readable()) return print(unreadable);
    const last = journal.latest();
    return print(last ? lastLine(last) : "No request yet.");
  }
  if (command === "on") {
    setComputerSwitch(root, true, now());
    print(
      "Computer use is on. Start the ClawdTime desktop service again, so that it builds the worker.",
    );
    if (!keyName)
      print(
        "No key for the language model is in this environment. The service needs CLAWDTIME_OPENAI_API_KEY or OPENAI_API_KEY.",
      );
    print(
      "Every action is checked in code. A click that cannot be undone, or that speaks for you, needs your yes. It never types into a password field.",
    );
    return print(
      "To stop it: say stop, press Stop work in the panel, or run: clawdtime computer off",
    );
  }
  if (command === "off") {
    setComputerSwitch(root, false, now());
    return print(
      "Computer use is off. A request that runs now stops before its next action. An action that was already sent may have finished.",
    );
  }
  if (command === "clear") {
    const { cleared, setAside } = journal.clear();
    if (setAside)
      return print(
        `The record of computer requests could not be read. It was set aside as ${setAside} and is not removed. New work can start.`,
      );
    if (!cleared.length) return print("Nothing to clear.");
    for (const request of cleared)
      print(
        `Cleared: "${request.goal}". Its record stays in the journal. New work can start.`,
      );
    return;
  }
  if (command === "timing") {
    const timed = readTimings(root).slice(-20);
    if (!timed.length)
      return print(
        "No step was timed yet. Start the desktop service with CLAWDTIME_COMPUTER_TIMING=on, then ask for something.",
      );
    for (const step of timed) print(timingLine(step));
    return;
  }
  if (command === "doctor") {
    const chosen = readComputerSwitch(root);
    const checks: { name: string; detail: string }[] = [];
    const row = (name: string, text: string) =>
      checks.push({ name, detail: text });
    const desktop = await inspectDesktopReadiness(
      { env, home: dependencies.home ?? homedir() },
      dependencies.request ? { request: dependencies.request } : {},
    );
    row(
      "desktop service",
      {
        absent:
          "missing at the configured desktop destination. Start the desktop service and set CLAWDTIME_DESKTOP_STATE to its private state folder. Standalone chat is not a desktop executor.",
        unavailable:
          "did not answer the authenticated readiness check. No work was submitted.",
        identity_mismatch:
          "does not match the installed service identity. No work was submitted.",
        connected: "connected to the configured instance",
      }[desktop.service],
    );
    row(
      "desktop chat",
      {
        unknown: "not checked; no verified desktop connection",
        unavailable: "unavailable; the chat route did not answer",
        no_model:
          "service has no language model; configure its environment before using phone requests",
        connected: "service has a language model",
      }[desktop.chat],
    );
    row(
      "task session",
      `${desktop.taskSession}; coding-task admission: ${desktop.taskAdmission}. This is separate from computer-worker availability.`,
    );
    row(
      "executor",
      desktop.computer === "configured"
        ? `${desktop.computerMode} configured. Panel connection, macOS permissions and visible action results still need verification.`
        : desktop.computer === "uncertain"
          ? "an earlier computer outcome is uncertain. Preserve its receipt; do not replay it or reset the journal to continue."
          : desktop.computer === "not_configured"
            ? "not configured in the service. Phone chat cannot perform desktop computer work."
            : "not verified; no computer readiness claim",
    );
    row(
      "switch",
      chosen.enabled
        ? "on"
        : (chosen.problem ?? "off. Turn it on: clawdtime computer on"),
    );
    // Only the name of the variable is printed, never its value.
    row(
      "model key",
      keyName
        ? `found in ${keyName}, in this environment. The service reads its own environment when it starts.`
        : "missing. The service needs CLAWDTIME_OPENAI_API_KEY or OPENAI_API_KEY in its environment.",
    );
    row(
      "model",
      env.CLAWDTIME_COMPUTER_MODEL
        ? `${env.CLAWDTIME_COMPUTER_MODEL}. CLAWDTIME_COMPUTER_MODEL chose it.`
        : `${defaultComputerModel}. CLAWDTIME_COMPUTER_MODEL changes it. A key that may not use it falls back to ${fallbackComputerModel}.`,
    );
    const folder = computerDirectory(root);
    row(
      "state folder",
      computerFolderPrivate(root)
        ? `${folder}, for its owner only`
        : `${folder} is open to other users. Run: chmod 700 ${folder}`,
    );
    const kept = journal.all().length;
    row(
      "journal",
      !journal.readable()
        ? "cannot be read. Run: clawdtime computer clear"
        : kept
          ? `${kept} ${kept === 1 ? "request" : "requests"} kept: the request, its state, and each step as kind and name`
          : "no request yet",
    );
    const unknown = journal.readable() ? journal.unresolved() : null;
    row(
      "unknown result",
      unknown
        ? `"${unknown.goal}". Look at the screen, then run: clawdtime computer clear`
        : "none",
    );
    row(
      "hands",
      "in the ClawdTime panel. A task that starts says so when the panel lacks Accessibility or Screen & System Audio Recording in System Settings, Privacy & Security.",
    );
    let browser =
      "off. The worker uses the screen for web pages. To read and operate the page itself, start the desktop service with CLAWDTIME_COMPUTER_BROWSER=on. For ClawdTime's own browser, with its own profile, use CLAWDTIME_COMPUTER_BROWSER=own.";
    const own = env[browserSwitch] === "own";
    if (dependencies.browser)
      try {
        const answer = await dependencies.browser.doctor();
        browser = !answer.ok
          ? `cannot be driven. ${answer.reason}`
          : own
            ? `ClawdTime's own browser, ${answer.browser ?? "a browser"}, can be driven. ${answer.reason}`
            : `${answer.browser ?? "a browser"} can be driven`;
      } catch {
        browser = "cannot be driven. It did not answer.";
      }
    row("browser", browser);
    const reach = reachRows(root, env, now());
    row("calls to you", reach.calls);
    row("texts to you", reach.texts);
    row("routines", reach.routines);
    if (json) return print(JSON.stringify({ version: 1, desktop, checks }));
    print("Computer use on this Mac");
    for (const { name, detail } of checks)
      print(`  ${name.padEnd(15)} ${detail}`);
    return;
  }
  throw new Error(usage);
}
