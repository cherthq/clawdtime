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
  modelChoiceFile,
  plannerSetup,
  readModelChoice,
  storeModelChoice,
} from "../connectors/computer/keys.js";
import { looksSecret, Memory } from "../connectors/agents/memory.js";
import {
  chatEndpoint,
  defaultComputerModel,
  fallbackComputerModel,
  modelName,
  parseModel,
  refusalFallback,
  sentEffort,
  sentFast,
  type PlannerSettings,
  type Selection,
} from "../connectors/computer/providers.js";
import type { BrowserPort } from "../connectors/computer/ports.js";
import { browserSwitch } from "../connectors/computer/browser.js";
import { inspectDesktopReadiness } from "../connectors/agents/desktop-readiness.js";
import { readReach } from "../connectors/computer/reach.js";
import { callsSettings } from "../connectors/computer/calls-api.js";
import { Routines } from "../connectors/computer/routines.js";

export const computerHelp = `clawdtime computer: ClawdTime does a task on this Mac by itself
  computer status   on or off, and the last request
  computer on       turn it on. Start the ClawdTime desktop service again after this
  computer off      turn it off. A request that runs stops before its next action
  computer doctor [--json]   configured service, capabilities and missing checks
  computer clear    you looked at the result of a request with an unknown result: new work can start
  computer timing   the time of the newest steps: the look, the plan and the action of each
  computer model [PROVIDER/MODEL] [--base-url URL]   show or choose the model of the planner.
                    "auto" goes back to the first provider with a key. Keys: clawdtime keys
When a question waits and you do not answer in the chat, ClawdTime calls you on
the line, or texts you when the call does not get through. doctor says whether
it can. Routines: clawdtime routine help.
It is off until you turn it on. Every action is checked in code, and a click that
cannot be undone needs your yes. See docs/COMPUTER_USE.md.`;
const usage =
  "Use: clawdtime computer status|on|off|doctor|clear|timing|model [PROVIDER/MODEL] [--base-url URL]";

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

/** The missing piece of the Calls API path, in plain words. */
const callsPiece: Record<string, string> = {
  project_api_key:
    "the project API key of Chert. Run clawdtime connect (step 8)",
  line_of_this_project:
    "a line of the project of the stored key: calls.json names a line of another project. Run clawdtime connect",
  line_id: "the line of the project. Run clawdtime connect (step 9)",
  owner_number: "your number. Run clawdtime connect (step 6)",
  consent: "your yes to calls and texts. Run clawdtime connect --consent yes",
  line_directory:
    "the folder of the line agent. Run clawdtime connect (step 9)",
  livekit_settings:
    "the LiveKit keys in line/.env.local. Run chert livekit in line/, or clawdtime connect (step 5)",
  model_key:
    "OPENAI_API_KEY in line/.env.local: the line agent speaks with it. Put your key there yourself",
  agent_name:
    "a valid AGENT_NAME in line/.env.local: letters, digits, - and _ only",
  line_settings_unreadable:
    "line/.env.local is not an owner-only file of this user. Run: chmod 600 line/.env.local",
  calls_api_base: "CHERT_CALLS_API_BASE must be an https address",
  calls_file_unreadable:
    "calls.json in the state folder cannot be used. Look at it, then run clawdtime connect",
  settings_unreadable: "its settings could not be read",
};
/** Why the reach cannot call or text, in plain words. Only fixed codes come in. */
const reachReason = (reason: string) => {
  if (reason.startsWith("calls_api_missing:")) {
    const piece = reason.slice("calls_api_missing:".length);
    return `the Chert Calls API path needs ${callsPiece[piece] ?? piece.replace(/_/g, " ")}`;
  }
  if (reason.startsWith("missing:"))
    return `these settings are missing in the environment of the desktop service: ${reason.slice(8).split(",").join(", ")}. Run clawdtime connect, or see SETUP_CLAWDTIME.md`;
  const plain: Record<string, string> = {
    no_consent:
      "you did not allow ClawdTime to call and text your number. To allow it: clawdtime connect --consent yes",
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
    calls_api_record_unreadable:
      "computer/reach-calls.json cannot be read, so no call is placed. Look at it, and move it away to start again",
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
  const side = (
    value: { ready: boolean; reason: string } | undefined,
    later = "",
  ) =>
    off
      ? "off: CLAWDTIME_COMPUTER_REACH=off"
      : !found
        ? "unknown: computer/reach.json cannot be read"
        : !value || !fresh
          ? `not reported: start the desktop service with the computer worker on. It says this within a minute${later}`
          : value.ready
            ? value.reason === "ready_chert_calls_api"
              ? "ready (Chert Calls API). When a question waits, ClawdTime reaches you this way"
              : "ready. When a question waits, ClawdTime reaches you this way"
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
  // Without a report, this Mac's own files say what the Calls API path lacks.
  const local = (() => {
    try {
      const settings = callsSettings(env, root);
      return "missing" in settings
        ? `. Without a retained provider it calls through the Chert Calls API, which needs ${callsPiece[settings.missing] ?? settings.missing.replace(/_/g, " ")}`
        : ". Without a retained provider it calls through the Chert Calls API, which has what it needs here";
    } catch {
      return "";
    }
  })();
  return {
    calls: side(said?.calls, local),
    texts: side(said?.texts),
    routines,
  };
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
  if (command === "model") return modelCommand(args.slice(1), env, root, print);
  const json = command === "doctor" && args[1] === "--json";
  if (args.length > (json ? 2 : 1)) throw new Error(usage);
  if (command === "help" || command === "--help") return print(computerHelp);
  const journal = new ComputerJournal(root, now);
  const setup = plannerSetup(env, root);
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
    if (!setup.ok && setup.reason === "no_key")
      print(
        "No key for the language model is in this environment. The service needs CLAWDTIME_OPENAI_API_KEY or OPENAI_API_KEY. Or store a key of any provider: clawdtime keys set PROVIDER",
      );
    else if (!setup.ok) print(setup.problem);
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
    // Only the name of a variable or of the store is printed, never a key.
    row("model key", keyLine(setup));
    row("model", modelLine(setup, root));
    if (setup.ok) {
      row("effort", effortLine(setup.settings));
      row("speed", speedLine(setup.settings));
    }
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
    // Memory has its own switch: computer use reads it and keeps notes in it only while it is on.
    row(
      "memory",
      new Memory(root).enabled()
        ? "on, so it feeds computer use. Before a request the planner gets up to 5 notes that fit the goal, as data. After it, what you taught is kept as up to 3 notes. See them: clawdtime memory show"
        : "off, so computer use reads nothing from it and keeps nothing in it. Turn it on when you need it: clawdtime memory on",
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

/** Where the key of the planner comes from. It never holds the key. */
function keyLine(setup: Selection) {
  if (!setup.ok)
    return setup.reason === "no_key"
      ? "missing. The service needs CLAWDTIME_OPENAI_API_KEY or OPENAI_API_KEY in its environment. Or store a key of any provider: clawdtime keys set PROVIDER, and see clawdtime keys list"
      : setup.reason === "missing_key" && setup.provider
        ? `missing for ${setup.provider.name}. Run: clawdtime keys set ${setup.provider.id}, or set ${setup.provider.keys.join(" or ")} in the environment of the service.`
        : setup.reason === "no_model" && setup.provider
          ? `found for ${setup.provider.name}. See the model line.`
          : "not checked: see the model line.";
  const { provider, keyFrom } = setup.settings;
  if (!keyFrom)
    return `none, for ${provider.name}: the custom service gets no key.`;
  return keyFrom.kind === "environment"
    ? `found in ${keyFrom.name}, in this environment, for ${provider.name}. The service reads its own environment when it starts.`
    : `found in the key store, for ${provider.name}. The service reads it when it starts. A variable of its environment wins over it.`;
}

/** The model of the planner and what chose it. */
function modelLine(setup: Selection, root: string) {
  if (!setup.ok)
    return setup.reason === "no_key"
      ? `${defaultComputerModel}. CLAWDTIME_COMPUTER_MODEL changes it. A key that may not use it falls back to ${fallbackComputerModel}. Another provider: clawdtime computer model PROVIDER/MODEL`
      : `none. ${setup.problem}`;
  const { provider, model, modelFrom } = setup.settings;
  const name = modelName(provider, model);
  const test = `Run the planner test before you rely on a new model: npm run eval:computer:planner -- ${name}`;
  if (modelFrom === "environment")
    return `${name}. CLAWDTIME_COMPUTER_MODEL chose it.${provider.id === "openai" ? "" : ` ${test}`}`;
  if (modelFrom === "store")
    return `${name}. clawdtime computer model chose it, in ${modelChoiceFile(root)}. CLAWDTIME_COMPUTER_MODEL in the environment of the service wins over it.${provider.id === "openai" ? "" : ` ${test}`}`;
  return provider.id === "openai"
    ? `${defaultComputerModel}. CLAWDTIME_COMPUTER_MODEL changes it. A key that may not use it falls back to ${fallbackComputerModel}. Another provider: clawdtime computer model PROVIDER/MODEL`
    : `${name}, the default of ${provider.name}, the first provider with a key. clawdtime computer model changes it.`;
}

function effortLine(settings: PlannerSettings) {
  const { provider, model, effort } = settings;
  const sent = sentEffort(provider.id, model, effort);
  if (sent)
    return `${sent}${effort ? ", set by CLAWDTIME_COMPUTER_EFFORT" : ", the default of the planner. CLAWDTIME_COMPUTER_EFFORT (low, medium, high) changes it"}.`;
  if (provider.id === "openai")
    return effort
      ? `not sent: ${model} takes no reasoning effort.`
      : "the default of the model. CLAWDTIME_COMPUTER_EFFORT (low, medium, high) sets reasoning_effort on the models that take it.";
  return provider.id === "anthropic"
    ? `not sent: ${model} takes no effort.`
    : `not sent: ${provider.name} gets no effort setting.`;
}

function speedLine(settings: PlannerSettings) {
  const { provider, model, speed } = settings;
  const fallback = refusalFallback(provider.id, model)
    ? " A refusal goes to the default fallback model of the service, in the same call."
    : "";
  if (sentFast(provider.id, model, speed))
    return `fast, set by CLAWDTIME_COMPUTER_SPEED. It costs more for each token.${fallback}`;
  return speed === "fast"
    ? `standard: fast mode is not there for ${modelName(provider, model)}.${fallback}`
    : `standard.${provider.id === "anthropic" ? " CLAWDTIME_COMPUTER_SPEED=fast turns on fast mode on the models that take it." : ""}${fallback}`;
}

/** `clawdtime computer model`: show the model of the planner, or choose one. */
function modelCommand(
  args: string[],
  env: Record<string, string | undefined>,
  root: string,
  print: (line: string) => void,
) {
  const [value, flag, base, ...rest] = args;
  if (rest.length || (flag !== undefined && (flag !== "--base-url" || !base)))
    throw new Error(usage);
  const shadow = env.CLAWDTIME_COMPUTER_MODEL?.trim()
    ? "CLAWDTIME_COMPUTER_MODEL is set in this environment, and it wins over the stored choice."
    : null;
  if (value === undefined) {
    const setup = plannerSetup(env, root);
    print(`Model of the planner: ${modelLine(setup, root)}`);
    if (setup.ok) print(`Key: ${keyLine(setup)}`);
    return;
  }
  if (value === "auto") {
    if (flag) throw new Error(usage);
    storeModelChoice(root, null);
    print(
      "No model is chosen now: the planner takes the first provider with a key, with its default model. Start the desktop service again.",
    );
    if (shadow) print(shadow);
    return;
  }
  const parsed = parseModel(value, looksSecret);
  if (!parsed.ok) throw new Error(parsed.problem);
  if (base !== undefined && parsed.provider.id !== "custom")
    throw new Error("Only the custom provider takes --base-url.");
  if (base !== undefined && !chatEndpoint(base))
    throw new Error(
      "The base address cannot be used. Give an https address, or http only to this Mac, with no name, password or query in it.",
    );
  // A custom service keeps the address that it had, unless a new one comes.
  const baseUrl =
    parsed.provider.id === "custom"
      ? (base ?? readModelChoice(root).choice?.baseUrl)
      : undefined;
  storeModelChoice(root, {
    model: value.trim(),
    ...(baseUrl ? { baseUrl } : {}),
  });
  const name = modelName(parsed.provider, parsed.model);
  print(
    `The planner model is now ${name}. Start the ClawdTime desktop service again, so that it uses it.`,
  );
  if (shadow) print(shadow);
  const setup = plannerSetup(
    { ...env, CLAWDTIME_COMPUTER_MODEL: undefined },
    root,
  );
  if (!setup.ok) print(setup.problem);
  print(
    `Run the planner test before you rely on a new model: npm run eval:computer:planner -- ${name}`,
  );
}
