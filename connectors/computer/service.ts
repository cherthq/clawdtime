/**
 * Computer use: how the task service builds it and what the panel routes use.
 *
 * Computer use is off until the person turns it on with
 * `clawdtime computer on`. The worker is built only when the switch is on and
 * a key for the language model is in the environment of the service. In every
 * other case the routes still answer, with `enabled` false and the reason, so
 * the panel always knows where it stands.
 */
import type { DesktopExecutionSnapshot } from "../../src/control/desktop-executor.js";
import { ComputerJournal, readComputerSwitch } from "./journal.js";
import { PanelHands } from "./panel-hands.js";
import { plannerFromEnvironment } from "./planner.js";
import {
  handResultSchema,
  handsNextSchema,
  type BrowserPort,
  type HandsNext,
} from "./ports.js";
import {
  ComputerWorker,
  computerStatusSchema,
  offText,
  type ComputerStatus,
} from "./worker.js";

/** What the panel routes need from computer use. */
export interface ComputerPort {
  /** `GET /desktop/hands/next`: the command that waits, and what runs. */
  next(after: number): HandsNext;
  /** `POST /desktop/hands/result`. False when no command waits for that result. */
  result(raw: unknown): boolean;
  /** `GET /desktop/computer`. */
  status(): ComputerStatus;
  /** Stop, for the existing stop route. Absent when no worker runs here. */
  stop?(): DesktopExecutionSnapshot;
}

const nothingRuns: HandsNext["run"] = {
  active: false,
  goal: "",
  step: 0,
  state: "idle",
};

/** The routes over a worker and the hands that the panel serves. */
export function computerPort(
  worker: ComputerWorker,
  hands: PanelHands,
): ComputerPort {
  return {
    next: (after) =>
      handsNextSchema.parse({
        version: 1,
        command: hands.next(after),
        run: worker.run(),
      }),
    result: (raw) => hands.result(raw),
    status: () => computerStatusSchema.parse(worker.status()),
    stop: () => worker.stop(),
  };
}

/** The routes where no worker runs: nothing to do, and the reason. */
export function offComputerPort(message: string): ComputerPort {
  return {
    next: () => ({ version: 1, command: null, run: nothingRuns }),
    result: (raw) => {
      handResultSchema.parse(raw);
      return false;
    },
    status: () => ({
      version: 1,
      enabled: false,
      state: "idle",
      message,
      step: 0,
      goal: "",
      question: null,
    }),
  };
}

export const noKeyText =
  "Computer use is on, but the service has no key for the language model. Put CLAWDTIME_OPENAI_API_KEY or OPENAI_API_KEY in its environment and start it again.";

export function buildComputer(options: {
  /** The state folder: the switch and the journal live in its `computer` folder. */
  root: string;
  env: Record<string, string | undefined>;
  /** Says something to the person in the chat: a question, the result. */
  notify?: (text: string) => void;
  /** The browser, when one is connected. */
  browser?: BrowserPort;
  /** Why no worker may run in this service. With it, none is built. */
  unavailable?: string;
}): { worker: ComputerWorker | null; port: ComputerPort } {
  const off = (message: string) => ({
    worker: null,
    port: offComputerPort(message),
  });
  if (options.unavailable) return off(options.unavailable);
  const chosen = readComputerSwitch(options.root);
  if (!chosen.enabled) return off(chosen.problem ?? offText);
  const planner = plannerFromEnvironment(options.env, {
    browser: options.browser !== undefined,
  });
  if (!planner) return off(noKeyText);
  const hands = new PanelHands();
  const worker = new ComputerWorker({
    hands,
    planner,
    journal: new ComputerJournal(options.root),
    // Read before every action: turning it off stops a request with no restart.
    enabled: () => readComputerSwitch(options.root).enabled,
    ...(options.browser ? { browser: options.browser } : {}),
    ...(options.notify ? { notify: options.notify } : {}),
  });
  return { worker, port: computerPort(worker, hands) };
}
