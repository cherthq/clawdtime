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

/** The hands did not answer in time. */
export class HandsTimeout extends Error {
  constructor(
    /** The panel had fetched the command, so it may have run. */
    readonly delivered: boolean,
  ) {
    super("The hands did not answer in time.");
  }
}

interface Waiting {
  seq: number;
  command: HandCommand;
  label: string;
  /** The panel has read this command at least once. */
  served: boolean;
  resolve: (result: HandResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class PanelHands implements Hands {
  private seq: number;
  private waiting: Waiting | undefined;
  private readonly timeoutMs: number;
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
    } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.seq = options.first ?? Date.now();
  }

  run(command: HandCommand, label: string): Promise<HandResult> {
    // A command that cannot be queued did not run: it resolves, it does not reject.
    const valid = handCommandSchema.safeParse(command);
    if (!valid.success)
      return Promise.resolve({ seq: this.seq, ok: false, error: "refused" });
    if (this.waiting)
      return Promise.resolve({ seq: this.seq, ok: false, error: "failed" });
    const seq = this.seq++;
    return new Promise<HandResult>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const waiting = this.waiting;
          if (waiting?.seq !== seq) return;
          this.waiting = undefined;
          waiting.reject(new HandsTimeout(waiting.served));
        },
        this.timeoutMs + (valid.data.kind === "wait" ? valid.data.ms : 0),
      );
      timer.unref();
      this.waiting = {
        seq,
        command: valid.data,
        label: label.slice(0, 120),
        served: false,
        resolve,
        reject,
        timer,
      };
    });
  }

  /** The command that waits, when its number is above the last one that the panel ran. */
  next(after: number): HandsNext["command"] {
    const waiting = this.waiting;
    if (!waiting || waiting.seq <= after) return null;
    waiting.served = true;
    return {
      seq: waiting.seq,
      command: waiting.command,
      label: waiting.label,
    };
  }

  /**
   * Takes what the panel posts. False when no command waits for that number:
   * a result that comes after the time limit changes nothing. It throws when
   * the body does not have the shape of a result.
   */
  result(raw: unknown): boolean {
    const result = handResultSchema.parse(raw);
    const waiting = this.waiting;
    if (!waiting || waiting.seq !== result.seq) return false;
    this.waiting = undefined;
    clearTimeout(waiting.timer);
    waiting.resolve(result);
    return true;
  }

  /**
   * Stop: takes back a command that the panel has not fetched, so that it
   * never runs. A command that the panel already has stays: the panel may be
   * in the middle of it, and its result is still awaited.
   */
  withdraw(): boolean {
    const waiting = this.waiting;
    if (!waiting || waiting.served) return false;
    this.waiting = undefined;
    clearTimeout(waiting.timer);
    waiting.resolve({
      seq: waiting.seq,
      ok: false,
      error: "stopped_by_person",
    });
    return true;
  }
}
