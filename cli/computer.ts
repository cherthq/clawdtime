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
import { defaultComputerModel } from "../connectors/computer/planner.js";
import type { BrowserPort } from "../connectors/computer/ports.js";

export const computerHelp = `clawdtime computer: ClawdTime does a task on this Mac by itself, one checked action at a time
  computer status   on or off, and the last request
  computer on       turn it on. Start the ClawdTime desktop service again after this
  computer off      turn it off. A request that runs stops before its next action
  computer doctor   what is ready and what is missing
  computer clear    you looked at the result of a request with an unknown result: new work can start
  computer timing   the time of the newest steps: the look, the plan and the action of each
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
  if (args.length > 1) throw new Error(usage);
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
    const row = (name: string, text: string) =>
      print(`  ${name.padEnd(15)} ${text}`);
    print("Computer use on this Mac");
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
      `${env.CLAWDTIME_COMPUTER_MODEL || defaultComputerModel}. CLAWDTIME_COMPUTER_MODEL changes it.`,
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
      "off. The worker uses the screen for web pages. To read and operate the page itself, start the desktop service with CLAWDTIME_COMPUTER_BROWSER=on.";
    if (dependencies.browser)
      try {
        const answer = await dependencies.browser.doctor();
        browser = answer.ok
          ? `${answer.browser ?? "a browser"} can be driven`
          : `cannot be driven. ${answer.reason}`;
      } catch {
        browser = "cannot be driven. It did not answer.";
      }
    return row("browser", browser);
  }
  throw new Error(usage);
}
