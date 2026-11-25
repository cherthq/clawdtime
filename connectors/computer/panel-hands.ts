/**
 * Computer use: the hands, as the service holds them for the panel.
 *
 * macOS gives the right to see the screen and to send input to the panel, so
 * the panel runs each command. The service holds the one command that waits.
 * The panel reads it with `GET /desktop/hands/next` and posts what happened
 * with `POST /desktop/hands/result`. The same command is served until its
 * result arrives, with the same number, so the panel can tell a command that
 * it already ran from a new one.
 *
 * A read of the panel can be held (`wait`): it is answered as soon as a
 * command waits, so no command waits for the next read. A held read never
 * serves a command by itself and never runs one: the answer is the same
 * `next` as an ordinary read.
 *
 * A command whose result does not come in time is never sent again. The
 * rejection says whether the panel had fetched it. If it had not, the command
 * certainly did not run. If it had, nobody knows, and the worker treats the
 * request as uncertain.
 */
import {
  handCommandSchema,
  handResultSchema,
  type HandCommand,
  type HandResult,
  type Hands,
  type HandsNext,
} from "./ports.js";
import { LastLook } from "./zoom-region.js";

/** The hands did not answer in time. */
export class HandsTimeout extends Error {
  constructor(
    /** The panel had fetched the command, so it may have run. */
    readonly delivered: boolean,
  ) {
    super("The hands did not answer in time.");
  }
}

/** The clock of the hands. Tests replace it, so that no test waits. */
export interface HandsClock {
  /** Milliseconds, only ever compared with each other. */
  now(): number;
  /** Calls `fire` once after `ms` milliseconds. It never keeps the process alive. */
  later(fire: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
}

export const systemHandsClock: HandsClock = {
  now: () => performance.now(),
  later: (fire, ms) => {
    const timer = setTimeout(fire, ms);
    timer.unref();
    return timer;
  },
  cancel: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

/**
 * What the commands of one step cost the hands: whole milliseconds and bytes,
 * never anything of the screen. A part is present only when a command had it.
 */
export interface HandsCost {
  /** Taking the picture of the screen. */
  captureMs?: number;
  /** Writing the picture as a JPEG, with its base64. */
  encodeMs?: number;
  /** The bytes of the JPEG. */
  imageBytes?: number;
  /** The walk of the Accessibility tree. */
  walkMs?: number;
  /** The guided cursor on its way to the place of an input, and its wait there. */
  glideMs?: number;
  /** The time that commands waited before the panel read them. */
  pollWaitMs?: number;
}

/** The header in which the panel says what one command cost. */
export const handsCostHeader = "x-clawdtime-hands-cost";
/** The header with which the service says that it held a read. */
export const handsHeldHeader = "x-clawdtime-hands-wait";
/** The longest time that one read of the panel is held. */
export const handsWaitLimitMs = 2000;
/** How often a held read looks whether what runs changed. */
export const handsChangeCheckMs = 100;

const costParts = new Map<string, keyof HandsCost>([
  ["capture", "captureMs"],
  ["encode", "encodeMs"],
  ["bytes", "imageBytes"],
  ["walk", "walkMs"],
  ["glide", "glideMs"],
]);
const costLimit = 86_400_000;

/**
 * The parts of the cost header, for example `capture=93;walk=412`. Null for a
 * header that is not one: the result itself is taken all the same.
 */
export function parseHandsCost(raw: string | null | undefined) {
  if (!raw || raw.length > 200) return null;
  const cost: HandsCost = {};
  for (const part of raw.split(";")) {
    const match = /^([a-z]{1,12})=([0-9]{1,9})$/.exec(part.trim());
    if (!match) return null;
    const field = costParts.get(match[1]!);
    const value = Number(match[2]);
    if (value > costLimit) return null;
    // A part that this service does not know is left out.
    if (field) cost[field] = value;
  }
  return cost;
}

interface Waiting {
  seq: number;
  command: HandCommand;
  label: string;
  /** The panel has read this command at least once. */
  served: boolean;
  /** When the command was queued, on the clock of the hands. */
  queued: number;
  resolve: (result: HandResult) => void;
  reject: (error: Error) => void;
  timer: unknown;
}

export class PanelHands implements Hands {
  private seq: number;
  private waiting: Waiting | undefined;
  private presentedCommand = 0;
  private readonly timeoutMs: number;
  private readonly clock: HandsClock;
  /** Held reads of the panel, woken when a command is queued. */
  private readonly sleepers = new Set<() => void>();
  private spent: HandsCost = {};
  /**
   * What the hands saw last, for the call video only (zoom-region.ts). In
   * memory, with no picture: it is never journaled and never an input.
   */
  readonly look: LastLook;
  constructor(
    options: {
      /** How long one command may take, from the moment it is queued. */
      timeoutMs?: number;
      /**
       * The number of the first command. The default is the time of start, so
       * the numbers of this run are above those of every earlier run and a
       * panel that outlived a restart of the service does not skip a command.
       */
      first?: number;
      clock?: HandsClock;
      look?: LastLook;
    } = {},
  ) {
    this.look = options.look ?? new LastLook();
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.seq = options.first ?? Date.now();
    this.clock = options.clock ?? systemHandsClock;
  }

  run(command: HandCommand, label: string): Promise<HandResult> {
    // A command that cannot be queued did not run: it resolves, it does not reject.
    const valid = handCommandSchema.safeParse(command);
    if (!valid.success)
      return Promise.resolve({ seq: this.seq, ok: false, error: "refused" });
    if (this.waiting)
      return Promise.resolve({ seq: this.seq, ok: false, error: "failed" });
    const seq = this.seq++;
    // A wait takes its own time, and keys go out one after the other: a long
    // text gets 25 ms more for each character.
    const own =
      valid.data.kind === "wait"
        ? valid.data.ms
        : valid.data.kind === "type"
          ? valid.data.text.length * 25
          : 0;
    const running = new Promise<HandResult>((resolve, reject) => {
      const timer = this.clock.later(() => {
        const waiting = this.waiting;
        if (waiting?.seq !== seq) return;
        this.waiting = undefined;
        this.presentedCommand = 0;
        waiting.reject(new HandsTimeout(waiting.served));
      }, this.timeoutMs + own);
      this.waiting = {
        seq,
        command: valid.data,
        label: label.slice(0, 120),
        served: false,
        queued: this.clock.now(),
        resolve,
        reject,
        timer,
      };
    });
    // A held read answers now: the panel gets the command with no wait.
    for (const wake of [...this.sleepers]) wake();
    return running;
  }

  /** A command waits whose number is above `after`. */
  private ready(after: number) {
    return this.waiting !== undefined && this.waiting.seq > after;
  }

  /**
   * Holds a read of the panel until a command waits above `after`, `changed`
   * says that what runs changed, `signal` ends the read, or `ms` pass. It
   * never rejects and serves nothing: the caller then reads `next(after)`.
   * `changed` is asked every `handsChangeCheckMs`, so a run that ends or waits
   * for the person shows on the panel at once too.
   */
  wait(
    after: number,
    ms: number,
    options: { signal?: AbortSignal; changed?: () => boolean } = {},
  ): Promise<void> {
    const limit = Number.isFinite(ms)
      ? Math.min(handsWaitLimitMs, Math.max(0, ms))
      : 0;
    if (limit === 0 || this.ready(after) || options.signal?.aborted)
      return Promise.resolve();
    return new Promise<void>((resolve) => {
      let over = false;
      let check: unknown;
      const done = () => {
        if (over) return;
        over = true;
        this.sleepers.delete(wake);
        this.clock.cancel(timer);
        if (check !== undefined) this.clock.cancel(check);
        options.signal?.removeEventListener("abort", done);
        resolve();
      };
      const wake = () => {
        if (this.ready(after)) done();
      };
      const look = () => {
        if (over) return;
        if (options.changed?.()) return done();
        check = this.clock.later(look, handsChangeCheckMs);
      };
      this.sleepers.add(wake);
      const timer = this.clock.later(done, limit);
      if (options.changed) check = this.clock.later(look, handsChangeCheckMs);
      options.signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** The command that waits, when its number is above the last one that the panel ran. */
  next(after: number): HandsNext["command"] {
    const waiting = this.waiting;
    if (!waiting || waiting.seq <= after) return null;
    // The first read of a command ends its wait for the panel.
    if (!waiting.served)
      this.spend({
        pollWaitMs: Math.max(0, this.clock.now() - waiting.queued),
      });
    waiting.served = true;
    this.presentedCommand = waiting.seq;
    return {
      seq: waiting.seq,
      command: waiting.command,
      label: waiting.label,
    };
  }

  /**
   * Takes what the panel posts. False when no command waits for that number:
   * a result that comes after the time limit changes nothing. It throws when
   * the body does not have the shape of a result. `cost` is the cost header
   * of the panel: numbers only, for the timing of the step. A header that is
   * not one changes nothing.
   */
  result(raw: unknown, cost?: string | null): boolean {
    const result = handResultSchema.parse(raw);
    const waiting = this.waiting;
    if (!waiting || waiting.seq !== result.seq) return false;
    this.waiting = undefined;
    this.clock.cancel(waiting.timer);
    const spent = parseHandsCost(cost);
    if (spent) this.spend(spent);
    if (result.observation) this.look.take(result.observation);
    if (!result.ok || result.interrupted) this.presentedCommand = 0;
    waiting.resolve(result);
    return true;
  }

  /**
   * Stop: takes back a command that the panel has not fetched, so that it
   * never runs. A command that the panel already has stays: the panel may be
   * in the middle of it, and its result is still awaited.
   */
  withdraw(): boolean {
    this.presentedCommand = 0;
    const waiting = this.waiting;
    if (!waiting || waiting.served) return false;
    this.waiting = undefined;
    this.clock.cancel(waiting.timer);
    waiting.resolve({
      seq: waiting.seq,
      ok: false,
      error: "stopped_by_person",
    });
    return true;
  }

  /** Presentation only: the last command actually fetched by the panel, never an input grant. */
  presentationCommand(): number {
    return this.presentedCommand;
  }

  /**
   * What the commands since the last call cost, and a new count from zero.
   * The worker's timing takes it once for each step.
   */
  takeCost(): HandsCost {
    const spent = this.spent;
    this.spent = {};
    return spent;
  }

  private spend(cost: HandsCost) {
    for (const [field, value] of Object.entries(cost) as [
      keyof HandsCost,
      number,
    ][])
      this.spent[field] = Math.min(
        costLimit,
        Math.round((this.spent[field] ?? 0) + value),
      );
  }
}
