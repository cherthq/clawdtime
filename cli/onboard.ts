/**
 * `clawdtime onboard`: the guided setup of this Mac. The steps live in the
 * setup engine (src/onboard/); this file is the terminal wizard and the JSON
 * protocol over standard input and output. See docs/ONBOARDING.md.
 */
import { execFile } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { homedir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { isatty, ReadStream, WriteStream } from "node:tty";
import { OnboardEngine, type OnboardPorts } from "../src/onboard/engine.js";
import {
  jsonLinesIO,
  skippableSteps,
  type OnboardCommand,
  type OnboardEvent,
  type OnboardIO,
  type StepEvent,
} from "../src/onboard/protocol.js";
import { macPorts, packageVersion } from "../src/onboard/system.js";
import { checkoutRoot, startCli } from "./start.js";

export const onboardHelp = `clawdtime onboard: set up ClawdTime on this Mac, then talk to it
  clawdtime onboard [--phone] [--local] [--coordinator HTTPS_ORIGIN] [--json] [--app]
  --phone          get calls on your phone: verify your phone, pair this Mac and connect it
  --local          set up this Mac alone, also on a Mac that is paired already
  --coordinator    the https origin of the shared number's coordinator. Without it,
                   CLAWDTIME_COORDINATOR, then the coordinator of this release
  --json           speak the setup protocol on standard input and output (docs/ONBOARDING.md)
  --app            the ClawdTime app drives setup and owns the desktop and the connection:
                   setup opens no panel and starts no background connection
It checks this Mac, finds or asks for your model key, starts ClawdTime, asks for computer
use and checks the permissions. Then it opens the chat. Your phone is a later step:
clawdtime onboard --phone. Run setup again to continue where it stopped: a step that
is ready is checked, not repeated. A sign-in text goes out only after you say yes.
Keys, numbers and codes are never shown.`;
const usage =
  "Use: clawdtime onboard [--phone] [--local] [--coordinator HTTPS_ORIGIN] [--json] [--app]";
export const noTerminalLine =
  "Run clawdtime onboard in Terminal to finish setup.";

/** A terminal to talk to: its input and output. */
export interface Terminal {
  input: Readable & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean };
  output: Writable;
  close(): void;
}

export interface OnboardCliDependencies {
  env?: Record<string, string | undefined>;
  home?: string;
  root?: string;
  stdin?: Readable & { isTTY?: boolean };
  stdout?: Writable;
  stderr?: Writable;
  /** Opens /dev/tty when standard input is no terminal. Null: no terminal. */
  openTerminal?: () => Terminal | null;
  /** Tests replace the Mac and the network. */
  ports?: OnboardPorts;
  /** Opens a System Settings pane for the terminal wizard. */
  openUrl?: (url: string) => Promise<void>;
  /** How often the permissions step checks again by itself, with --json. 0: never. */
  permissionPollMs?: number;
  allowLoopback?: boolean;
  desktopWaitMs?: number;
  pollMs?: number;
  now?: () => number;
  /** Where SIGTERM, SIGINT and SIGHUP come from. Tests replace it. */
  signals?: Pick<NodeJS.EventEmitter, "on" | "off">;
}

/** Opens the controlling terminal, or null when there is none. */
export function openControllingTerminal(): Terminal | null {
  let input: number | undefined;
  let output: number | undefined;
  try {
    input = openSync("/dev/tty", "r");
    output = openSync("/dev/tty", "w");
    if (!isatty(input) || !isatty(output)) throw Error("not_a_terminal");
  } catch {
    if (input !== undefined) closeSync(input);
    if (output !== undefined) closeSync(output);
    return null;
  }
  const reader = new ReadStream(input);
  const writer = new WriteStream(output);
  return {
    input: reader,
    output: writer,
    close: () => {
      reader.destroy();
      writer.destroy();
    },
  };
}

const openSettings = (url: string) =>
  new Promise<void>((done, fail) => {
    if (!url.startsWith("x-apple.systempreferences:"))
      return fail(Error("not_settings"));
    execFile("/usr/bin/open", [url], { timeout: 5000 }, (error) =>
      error ? fail(error) : done(),
    );
  });

class Interrupted extends Error {}

/**
 * The terminal wizard: it shows each event in plain short sentences and
 * answers each question from the terminal. A secret is read with no echo.
 */
export class TerminalWizard implements OnboardIO {
  private pending: StepEvent | null = null;
  private shown = new Map<string, string>();
  /** The title of each step, as its events say it, for the report. */
  private titles = new Map<string, string>();
  /** Quit, Ctrl+C or the end of the terminal's input at a question. */
  private stopped = false;
  /** Ends the line that is being read now, if any. */
  private interrupt: (() => void) | null = null;
  /** Wakes a `next` that waits for the next question. */
  private wake: (() => void) | null = null;
  /**
   * @param settleMs Before each question the wizard drops what was typed so
   * far, then waits this long and drops what comes in meanwhile: a second
   * yes typed by mistake never answers the next question.
   */
  constructor(
    private terminal: Terminal,
    private openUrl: (url: string) => Promise<void> = openSettings,
    private settleMs = 250,
  ) {}

  /** Stops setup from outside a question, as Ctrl+C or SIGTERM does. */
  stop() {
    this.stopped = true;
    this.interrupt?.();
    this.wake?.();
  }

  private write(line: string) {
    this.terminal.output.write(`${line}\n`);
  }

  emit(event: OnboardEvent) {
    if (event.type === "hello")
      return this.write(
        "ClawdTime setup. Press Ctrl+C to stop. Run clawdtime onboard again to continue where you stopped.",
      );
    if (event.type === "log")
      return this.write(
        `  ${event.level === "warn" ? "Note: " : ""}${event.message}`,
      );
    if (event.type === "done") {
      this.write("");
      this.write(
        event.ready
          ? "Setup is done."
          : "Setup is not finished. Run clawdtime onboard again to continue.",
      );
      // A skipped or failed step says what does not work and how to finish it.
      for (const row of event.report)
        if (row.id !== "ready")
          this.write(
            `  ${`${this.titles.get(row.id) ?? row.id}:`.padEnd(18)} ${row.state.replace("_", " ")}${(row.state === "skipped" || row.state === "failed") && row.detail ? `. ${row.detail}` : ""}`,
          );
      const ready = event.report.find((row) => row.id === "ready");
      if (ready?.detail) this.write(ready.detail);
      return;
    }
    this.titles.set(event.id, event.title);
    if (event.state === "pending") return;
    // Each detail is shown once; a question shows it when it changes.
    const key = `${event.id}:${event.state}:${event.detail ?? ""}`;
    const said = this.shown.get(event.id) !== key;
    this.shown.set(event.id, key);
    if (event.state === "needs_input" || event.state === "failed") {
      if (said && event.detail) {
        this.write(`${event.title}: ${event.detail}`);
        // Commands for the person to run, one per line. Setup never runs them.
        for (const command of event.permissions?.reset ?? [])
          this.write(`    ${command}`);
        // A terminal has no disclosure: the details follow on their own lines.
        if (event.details?.length) {
          this.write("  Details:");
          for (const line of event.details) this.write(`    ${line}`);
        }
        // A page to open, such as where to get a key: the terminal shows its address.
        if (event.recovery?.action === "open_url" && event.recovery.url)
          this.write(`  ${event.recovery.label}: ${event.recovery.url}`);
      }
      // Only a question is answered: a failure that waits for nothing is not.
      if (event.question) {
        this.pending = event;
        this.wake?.();
      }
      return;
    }
    if (!said) return;
    const state = {
      in_progress: "",
      ready: "done. ",
      skipped: "skipped. ",
    }[event.state];
    this.write(`${event.title}: ${state}${event.detail ?? ""}`.trimEnd());
  }

  cancelled() {
    return this.stopped;
  }

  async next(): Promise<OnboardCommand> {
    // Setup may wait for a command while a step runs (a skip, in the app):
    // here the next command answers the next question.
    while (!this.pending && !this.stopped)
      await new Promise<void>((done) => (this.wake = done));
    this.wake = null;
    const event = this.pending;
    this.pending = null;
    let command: OnboardCommand;
    if (!event || this.stopped) command = { type: "cancel" };
    else
      try {
        command = await this.answer(event);
      } catch (error) {
        if (!(error instanceof Interrupted)) throw error;
        this.write("");
        command = { type: "cancel" };
      }
    if (command.type === "cancel") this.stopped = true;
    return command;
  }

  /** The answer to one question. Each command names that question. */
  private async answer(event: StepEvent): Promise<OnboardCommand> {
    const id = event.id;
    const question = event.question!;
    // Every step but ready can be skipped: skip, or s, at any prompt.
    const skip = skippableSteps.has(id);
    const later = skip ? " Type skip to do this later" : "";
    const skips = (reply: string) =>
      skip && ["skip", "s"].includes(reply.trim().toLowerCase());
    const action = (value: "retry" | "recheck" | "skip"): OnboardCommand => ({
      type: "action",
      id,
      question,
      action: value,
    });
    const input = (value: string | boolean): OnboardCommand => ({
      type: "input",
      id,
      question,
      value,
    });
    if (event.state === "failed") {
      const reply = (
        await this.line(
          `Press Enter to ${(event.recovery?.label ?? "try again").toLowerCase()}${skip ? ", type skip to do this later" : ""}, or type quit to stop: `,
        )
      )
        .trim()
        .toLowerCase();
      if (reply === "quit") return { type: "cancel" };
      return action(skips(reply) ? "skip" : "retry");
    }
    const asked = event.input!;
    if (event.recovery?.action === "open_settings" && event.recovery.url) {
      const first = (
        await this.line(
          `Press Enter to open System Settings${skip ? ", type skip to do this later" : ""}, or type quit to stop: `,
        )
      ).trim();
      if (first === "quit") return { type: "cancel" };
      if (skips(first)) return action("skip");
      await this.openUrl(event.recovery.url).catch(() =>
        this.write(
          "  System Settings did not open. Open it yourself: Privacy & Security.",
        ),
      );
      const second = (
        await this.line(
          `Press Enter when you are done, to check again${skip ? ", or type skip to do this later" : ""}: `,
        )
      ).trim();
      if (second === "quit") return { type: "cancel" };
      if (skips(second)) return action("skip");
      return action("recheck");
    }
    if (asked.kind === "secret") {
      const secret = await this.hidden(
        `${asked.prompt} (it is not shown).${later}: `,
      );
      return skips(secret) ? action("skip") : input(secret);
    }
    if (asked.kind === "confirm")
      for (;;) {
        const reply = (
          await this.line(`${asked.prompt} Type yes or no.${later}: `)
        )
          .trim()
          .toLowerCase();
        if (reply === "yes" || reply === "y") return input(true);
        // Enter alone gives no consent. A skip is never a yes.
        if (reply === "no" || reply === "n" || (asked.consent && reply === ""))
          return input(false);
        if (skips(reply)) return action("skip");
        if (reply === "quit") return { type: "cancel" };
      }
    if (asked.kind === "choice") {
      const options = asked.options ?? [];
      this.write(asked.prompt);
      options.forEach((option, index) =>
        this.write(
          `  ${index + 1}. ${option.label}${option.detail ? `. ${option.detail}` : ""}`,
        ),
      );
      // Return takes the default of a choice. A consent choice has none.
      const fallback = asked.consent
        ? -1
        : options.findIndex((option) => option.id === asked.default);
      for (;;) {
        const reply = (
          await this.line(
            `Type a number${fallback >= 0 ? `, or press Enter for ${fallback + 1}` : ""}.${later}: `,
          )
        ).trim();
        if (reply === "" && fallback >= 0) return input(options[fallback]!.id);
        const option = options[Number(reply) - 1];
        if (option && /^\d+$/.test(reply)) return input(option.id);
        if (skips(reply)) return action("skip");
        if (reply === "quit") return { type: "cancel" };
      }
    }
    const reply = (await this.line(`${asked.prompt}.${later}: `)).trim();
    if (skips(reply)) return action("skip");
    return input(reply);
  }

  /** One line from the terminal. Ctrl+C stops. */
  private line(prompt: string) {
    return this.read(prompt, false);
  }

  /** A secret from the terminal, with no echo. Ctrl+C stops. */
  private hidden(prompt: string) {
    return this.read(prompt, true);
  }

  /**
   * Reads one answer. A terminal is read in raw mode, character by
   * character, only while a question is open: before the prompt shows, all
   * input that came in earlier is dropped (also a line typed ahead, which raw
   * mode hands over at once), and the answer ends at its Return. What follows
   * the Return in the same input is dropped too.
   */
  private async read(prompt: string, secret: boolean): Promise<string> {
    const input = this.terminal.input;
    const raw = input.isTTY === true && typeof input.setRawMode === "function";
    const output = this.terminal.output;
    if (raw) input.setRawMode!(true);
    input.setEncoding("utf8");
    try {
      await this.settle();
      if (this.stopped || input.readableEnded || input.destroyed)
        throw new Interrupted();
      output.write(prompt);
      return await new Promise<string>((done, fail) => {
        let value = "";
        const finish = (error?: Error) => {
          input.off("data", take);
          input.off("end", ended);
          input.off("close", ended);
          this.interrupt = null;
          input.pause();
          if (raw || secret) output.write("\n");
          if (error) fail(error);
          else done(value);
        };
        const ended = () => finish(new Interrupted());
        const take = (chunk: string | Buffer) => {
          // Arrow keys and other escape sequences are not part of an answer.
          const text = String(chunk).replace(
            // eslint-disable-next-line no-control-regex
            /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/g,
            "",
          );
          for (const char of text) {
            if (char === "\r" || char === "\n") return finish();
            if (char === "\u0003") return finish(new Interrupted());
            if (char === "\u0004") {
              if (!value) return finish(new Interrupted());
              continue;
            }
            if (char === "\u007f" || char === "\b") {
              if (!value) continue;
              value = Array.from(value).slice(0, -1).join("");
              if (raw && !secret) output.write("\b \b");
              continue;
            }
            if (char < " ") continue;
            value += char;
            if (raw && !secret) output.write(char);
          }
        };
        this.interrupt = ended;
        input.on("data", take);
        input.once("end", ended);
        input.once("close", ended);
        input.resume();
      });
    } finally {
      if (raw) input.setRawMode!(false);
    }
  }

  /** Drops what was typed before a question: what is buffered now, and what comes in for a moment. */
  private settle() {
    const input = this.terminal.input;
    while (input.read() !== null);
    return new Promise<void>((done) => {
      const drop = () => {};
      const end = () => {
        clearTimeout(timer);
        input.off("data", drop);
        this.interrupt = null;
        input.pause();
        while (input.read() !== null);
        done();
      };
      const timer = setTimeout(end, this.settleMs);
      this.interrupt = end;
      input.on("data", drop);
      input.resume();
    });
  }
}

function parse(args: string[]) {
  const options = {
    local: false,
    json: false,
    help: false,
    app: false,
    phone: false,
  } as {
    local: boolean;
    json: boolean;
    help: boolean;
    app: boolean;
    phone: boolean;
    coordinator?: string;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "help" || arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--local" && !options.local) options.local = true;
    else if (arg === "--json" && !options.json) options.json = true;
    else if (arg === "--app" && !options.app) options.app = true;
    else if (arg === "--phone" && !options.phone) options.phone = true;
    else if (arg === "--coordinator" && options.coordinator === undefined) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw Error(usage);
      options.coordinator = value;
    } else throw Error(usage);
  }
  if (options.local && options.coordinator !== undefined)
    throw Error("Use --local or --coordinator, not both.");
  if (options.local && options.phone)
    throw Error(
      "Use --local or --phone, not both: calls on your phone need pairing.",
    );
  if (options.app && !options.json)
    throw Error("--app goes with --json: the app speaks the setup protocol.");
  return options;
}

/**
 * How setup starts the desktop. In Terminal it is `clawdtime start`, panel
 * and all. For the app it is the service alone: the app opens the panel with
 * `clawdtime start --foreground` when setup ends, and owns it from then on.
 */
export function desktopStarter(
  app: boolean,
  base: { env: Record<string, string | undefined>; home: string; root: string },
  start: typeof startCli = startCli,
) {
  return (say: (line: string) => void, options: { tucked?: boolean } = {}) =>
    start(options.tucked ? ["--tucked", "true"] : [], {
      ...base,
      print: (line) => say(line),
      ...(app ? { panel: false } : {}),
    });
}

/** Runs setup. The exit code: 0 ready, 2 not finished, 1 stopped, 3 no terminal. */
export async function onboardCli(
  args: string[],
  dependencies: OnboardCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const options = parse(args);
  if (options.help) {
    stdout.write(`${onboardHelp}\n`);
    return 0;
  }
  const env = dependencies.env ?? process.env;
  const home = dependencies.home ?? homedir();
  const root = dependencies.root ?? checkoutRoot();
  const stdin = dependencies.stdin ?? process.stdin;

  let io: OnboardIO;
  let close = () => {};
  let stop = () => {};
  let log: (message: string) => void;
  if (options.json) {
    // The app may be gone while setup ends what it started: a write to a
    // closed pipe then fails quietly and never ends setup early.
    stdout.on("error", () => {});
    stderr.on("error", () => {});
    const lines = jsonLinesIO(stdin, (line) => stdout.write(`${line}\n`));
    io = lines;
    close = () => lines.close();
    stop = () => lines.cancel();
    log = (message) => stderr.write(`${message}\n`);
  } else {
    // A key is never read from a pipe: only from a terminal.
    const terminal: Terminal | null = stdin.isTTY
      ? { input: stdin, output: stdout, close: () => {} }
      : (dependencies.openTerminal ?? openControllingTerminal)();
    if (!terminal) {
      stdout.write(`${noTerminalLine}\n`);
      return 3;
    }
    const wizard = new TerminalWizard(terminal, dependencies.openUrl);
    io = wizard;
    close = () => terminal.close();
    stop = () => wizard.stop();
    log = (message) => terminal.output.write(`  ${message}\n`);
  }

  const command = {
    executable: process.execPath,
    args: [...process.execArgv, process.argv[1] ?? ""],
  };
  const ports =
    dependencies.ports ??
    macPorts({
      env,
      home,
      root,
      app: options.app,
      command,
      startDesktop: desktopStarter(options.app, { env, home, root }),
      // Terminal setup opens the chat when it ends. The app opens it itself.
      ...(options.app
        ? {}
        : {
            openChat: (say: (line: string) => void) =>
              startCli(["--chat"], { env, home, root, print: say }),
          }),
    });
  const engine = new OnboardEngine(
    io,
    {
      version: packageVersion(root),
      local: options.local,
      ...(options.phone ? { route: "phone" as const } : {}),
      // With the protocol, setup checks the permissions again by itself.
      ...(options.json && (dependencies.permissionPollMs ?? 2000) > 0
        ? { permissionPollMs: dependencies.permissionPollMs ?? 2000 }
        : {}),
      ...(options.app ? { appOwned: true } : {}),
      ...(options.coordinator !== undefined
        ? { coordinator: options.coordinator }
        : {}),
      env,
      home,
      root,
      ...(dependencies.now ? { now: dependencies.now } : {}),
      ...(dependencies.allowLoopback ? { allowLoopback: true } : {}),
      ...(dependencies.desktopWaitMs !== undefined
        ? { desktopWaitMs: dependencies.desktopWaitMs }
        : {}),
      ...(dependencies.pollMs !== undefined
        ? { pollMs: dependencies.pollMs }
        : {}),
    },
    ports,
  );
  // In JSON mode standard output carries the protocol only: a stray line of
  // any library goes to standard error instead.
  const original = console.log;
  if (options.json) console.log = (...parts: unknown[]) => log(parts.join(" "));
  // SIGTERM (the app's Stop after its grace time), Ctrl+C outside a question
  // and a closed terminal stop setup as a cancel does: setup then ends what
  // it was starting before it leaves. Later signals wait for that.
  const signals = dependencies.signals ?? process;
  const names = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  let signalled = false;
  const onSignal = () => {
    if (!signalled) log("Stopping setup. It ends what it was starting first.");
    signalled = true;
    stop();
  };
  for (const name of names) signals.on(name, onSignal);
  try {
    const result = await engine.run();
    return result.cancelled ? 1 : result.ready ? 0 : 2;
  } finally {
    for (const name of names) signals.off(name, onSignal);
    console.log = original;
    close();
  }
}
