/**
 * `clawdtime onboard`: the guided setup of this Mac. The steps live in the
 * setup engine (src/onboard/); this file is the terminal wizard and the JSON
 * protocol over standard input and output. See docs/ONBOARDING.md.
 */
import { execFile } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
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

export const onboardHelp = `clawdtime onboard: set up ClawdTime on this Mac, step by step
  clawdtime onboard [--local] [--coordinator HTTPS_ORIGIN] [--json] [--app]
  --local          set up this Mac alone: no phone, pairing or shared connection
  --coordinator    the https origin of the shared number's coordinator. Without it,
                   CLAWDTIME_COORDINATOR, then the coordinator of this release
  --json           speak the setup protocol on standard input and output (docs/ONBOARDING.md)
  --app            the ClawdTime app drives setup and owns the desktop and the connection:
                   setup opens no panel and starts no background connection
It checks this Mac, stores your model key, starts the desktop, asks for computer use,
checks the permissions, verifies your phone, pairs this Mac and connects it. Run it
again to continue where it stopped: a step that is ready is checked, not repeated.
A sign-in text goes out only after you say yes. Keys, numbers and codes are never shown.`;
const usage =
  "Use: clawdtime onboard [--local] [--coordinator HTTPS_ORIGIN] [--json] [--app]";
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
  allowLoopback?: boolean;
  desktopWaitMs?: number;
  pollMs?: number;
  now?: () => number;
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
  /** Quit, Ctrl+C or the end of the terminal's input at a question. */
  private stopped = false;
  constructor(
    private terminal: Terminal,
    private openUrl: (url: string) => Promise<void> = openSettings,
  ) {}

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
      for (const row of event.report)
        if (row.id !== "ready")
          this.write(`  ${row.id.padEnd(12)} ${row.state.replace("_", " ")}`);
      return;
    }
    if (event.state === "pending") return;
    // Each detail is shown once; a question shows it when it changes.
    const key = `${event.id}:${event.state}:${event.detail ?? ""}`;
    const said = this.shown.get(event.id) !== key;
    this.shown.set(event.id, key);
    if (event.state === "needs_input" || event.state === "failed") {
      if (said && event.detail) this.write(`${event.title}: ${event.detail}`);
      // Only a question is answered: a failure that waits for nothing is not.
      if (event.question) this.pending = event;
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
    const skip = skippableSteps.has(id);
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
          `Press Enter to ${(event.recovery?.label ?? "try again").toLowerCase()}${skip ? ", type skip to skip this step" : ""}, or type quit to stop: `,
        )
      )
        .trim()
        .toLowerCase();
      if (reply === "quit") return { type: "cancel" };
      return action(skip && reply === "skip" ? "skip" : "retry");
    }
    const asked = event.input!;
    if (event.recovery?.action === "open_settings" && event.recovery.url) {
      const first = (
        await this.line(
          "Press Enter to open System Settings, or type quit to stop: ",
        )
      ).trim();
      if (first === "quit") return { type: "cancel" };
      await this.openUrl(event.recovery.url).catch(() =>
        this.write(
          "  System Settings did not open. Open it yourself: Privacy & Security.",
        ),
      );
      const second = (
        await this.line("Press Enter when you are done, to check again: ")
      ).trim();
      if (second === "quit") return { type: "cancel" };
      return action("recheck");
    }
    if (asked.kind === "secret")
      return input(await this.hidden(`${asked.prompt} (it is not shown): `));
    if (asked.kind === "confirm")
      for (;;) {
        const reply = (
          await this.line(
            `${asked.prompt} Type yes or no${skip ? ", or skip" : ""}: `,
          )
        )
          .trim()
          .toLowerCase();
        if (reply === "yes" || reply === "y") return input(true);
        if (reply === "no" || reply === "n") return input(false);
        if (skip && reply === "skip") return action("skip");
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
      for (;;) {
        const reply = (
          await this.line(`Type a number${skip ? ", or skip" : ""}: `)
        ).trim();
        const option = options[Number(reply) - 1];
        if (option && /^\d+$/.test(reply)) return input(option.id);
        if (skip && reply === "skip") return action("skip");
        if (reply === "quit") return { type: "cancel" };
      }
    }
    const reply = (
      await this.line(`${asked.prompt}${skip ? " (or skip)" : ""}: `)
    ).trim();
    if (skip && reply === "skip") return action("skip");
    return input(reply);
  }

  /** One line from the terminal. Ctrl+C stops. */
  private line(prompt: string) {
    return new Promise<string>((done, fail) => {
      const lines = createInterface({
        input: this.terminal.input,
        output: this.terminal.output,
        terminal: this.terminal.input.isTTY === true,
      });
      let answered = false;
      lines.on("SIGINT", () => lines.close());
      lines.on("close", () => {
        if (!answered) fail(new Interrupted());
      });
      lines.question(prompt, (answer) => {
        answered = true;
        lines.close();
        done(answer);
      });
    });
  }

  /** A secret from the terminal, with no echo. Ctrl+C stops. */
  private hidden(prompt: string) {
    const input = this.terminal.input;
    if (!input.setRawMode || input.isTTY !== true) return this.line(prompt);
    this.terminal.output.write(prompt);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    return new Promise<string>((done, fail) => {
      let value = "";
      const finish = (error?: Error) => {
        input.off("data", take);
        input.setRawMode!(false);
        input.pause();
        this.terminal.output.write("\n");
        if (error) fail(error);
        else done(value);
      };
      const take = (chunk: string | Buffer) => {
        for (const char of String(chunk)) {
          if (char === "\r" || char === "\n" || char === "\u0004")
            return finish();
          if (char === "\u0003") return finish(new Interrupted());
          if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
          else value += char;
        }
      };
      input.on("data", take);
    });
  }
}

function parse(args: string[]) {
  const options = { local: false, json: false, help: false, app: false } as {
    local: boolean;
    json: boolean;
    help: boolean;
    app: boolean;
    coordinator?: string;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "help" || arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--local" && !options.local) options.local = true;
    else if (arg === "--json" && !options.json) options.json = true;
    else if (arg === "--app" && !options.app) options.app = true;
    else if (arg === "--coordinator" && options.coordinator === undefined) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw Error(usage);
      options.coordinator = value;
    } else throw Error(usage);
  }
  if (options.local && options.coordinator !== undefined)
    throw Error("Use --local or --coordinator, not both.");
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
  let log: (message: string) => void;
  if (options.json) {
    const lines = jsonLinesIO(stdin, (line) => stdout.write(`${line}\n`));
    io = lines;
    close = () => lines.close();
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
    io = new TerminalWizard(terminal, dependencies.openUrl);
    close = () => terminal.close();
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
      command,
      startDesktop: desktopStarter(options.app, { env, home, root }),
    });
  const engine = new OnboardEngine(
    io,
    {
      version: packageVersion(root),
      local: options.local,
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
  try {
    const result = await engine.run();
    return result.cancelled ? 1 : result.ready ? 0 : 2;
  } finally {
    console.log = original;
    close();
  }
}
