/**
 * Computer use: how the task service builds it and what the panel routes use.
 *
 * Computer use is off until the person turns it on with
 * `clawdtime computer on`. The worker is built only when no other engine does
 * the computer work in the service, the switch is on, a key for the language
 * model is in the environment of the service, and no test started the
 * service. In every other case the routes still answer, with `enabled` false
 * and the reason, so the panel always knows where it stands.
 */
import type {
  DesktopExecutionSnapshot,
  DesktopExecutorPort,
} from "../../src/control/desktop-executor.js";
import { ComputerJournal, readComputerSwitch } from "./journal.js";
import { PanelHands } from "./panel-hands.js";
import {
  PresentationEvents,
  presentationEventSchema,
  type PresentationEvent,
} from "./presentation.js";
import { plannerFromEnvironment } from "./planner.js";
import { browserMethods } from "./guards.js";
import { recordTiming } from "./timing.js";
import {
  OwnerReach,
  ownerTextPort,
  proactiveReachCall,
  type ProactiveReachDeps,
} from "./reach.js";
import { Routines } from "./routines.js";
import {
  handResultSchema,
  handsNextSchema,
  type BrowserPort,
  type HandsNext,
  type Planner,
} from "./ports.js";
import {
  ComputerWorker,
  type StepTiming,
  computerStatusSchema,
  offText,
  type ComputerStatus,
} from "./worker.js";

/** What the panel routes need from computer use. */
export interface ComputerPort {
  /** `GET /desktop/hands/next`: the command that waits, and what runs. */
  next(after: number): HandsNext;
  /**
   * `GET /desktop/hands/next?wait=MS`: the same answer, held until a command
   * waits, what runs changes, or the time passes. Absent where no worker runs.
   */
  waitNext?(
    after: number,
    ms: number,
    signal?: AbortSignal,
  ): Promise<HandsNext>;
  /**
   * `POST /desktop/hands/result`. False when no command waits for that result.
   * `cost` is the panel's cost header, for the timing of the step.
   */
  result(raw: unknown, cost?: string | null): boolean;
  /** `GET /desktop/computer`. */
  status(): ComputerStatus;
  present(raw: unknown): boolean;
  presentation(): { version: 1; event: PresentationEvent | null };
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
  const events = new PresentationEvents();
  const active = () => {
    const status = worker.status();
    return (
      status.enabled &&
      status.state === "running" &&
      hands.presentationCommand() > 0
    );
  };
  const next = (after: number) =>
    handsNextSchema.parse({
      version: 1,
      command: hands.next(after),
      run: worker.run(),
    });
  return {
    next,
    waitNext: async (after, ms, signal) => {
      // What runs now. A change of it answers the held read too.
      const seen = JSON.stringify(worker.run());
      await hands.wait(after, ms, {
        ...(signal ? { signal } : {}),
        changed: () => JSON.stringify(worker.run()) !== seen,
      });
      return next(after);
    },
    result: (raw, cost) => hands.result(raw, cost),
    status: () => computerStatusSchema.parse(worker.status()),
    present: (raw) => events.accept(raw, hands.presentationCommand(), active()),
    presentation: () => ({ version: 1, event: events.latest(active()) }),
    stop: () => {
      events.clear();
      return worker.stop();
    },
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
    present: (raw) => {
      presentationEventSchema.parse(raw);
      return false;
    },
    presentation: () => ({ version: 1, event: null }),
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
export const chatEngineText =
  "An existing chat connection does the computer work in this service.";
export const backgroundEngineText =
  "The background runtime does the computer work in this service.";
export const bundledEngineText =
  "The bundled runtime does the computer work in this service.";
export const actorsText =
  "Computer use does not run in a service with phone or presentation actors.";
export const noBoardText =
  "Computer use needs the agent board of this service, and it is turned off.";
export const testServiceText =
  "Computer use does not run in a service that a test started.";

export interface ComputerOptions {
  /** The state folder: the switch and the journal live in its `computer` folder. */
  root: string;
  /**
   * The environment of the service: the key and the model of the planner.
   * `VITEST` in it says that a test started the service: no worker is built
   * then, so no command for the hands can come out of a test.
   */
  env: Record<string, string | undefined>;
  /** Says something to the person in the chat: a question, the result. */
  notify?: (text: string) => void;
  /** The browser, when one is connected. */
  browser?: BrowserPort;
  /**
   * The planner, when the caller has one. The default is the language model
   * that the environment names. The key is needed in both cases.
   */
  planner?: Planner;
  /** Why no worker may run in this service. With it, none is built. */
  unavailable?: string;
}

export function buildComputer(options: ComputerOptions): {
  worker: ComputerWorker | null;
  port: ComputerPort;
} {
  const off = (message: string) => ({
    worker: null,
    port: offComputerPort(message),
  });
  if (options.unavailable) return off(options.unavailable);
  // Before the switch is read: a service of a test does not look at it.
  if (options.env.VITEST) return off(testServiceText);
  const chosen = readComputerSwitch(options.root);
  if (!chosen.enabled) return off(chosen.problem ?? offText);
  const planner = plannerFromEnvironment(options.env, {
    browser: options.browser !== undefined,
    // A browser function is offered only when this driver has its method.
    browserMethods: browserMethods(options.browser),
  });
  if (!planner) return off(noKeyText);
  const hands = new PanelHands();
  const worker = new ComputerWorker({
    hands,
    planner: options.planner ?? planner,
    journal: new ComputerJournal(options.root),
    // Read before every action: turning it off stops a request with no restart.
    enabled: () => readComputerSwitch(options.root).enabled,
    ...(options.browser ? { browser: options.browser } : {}),
    ...(options.notify ? { notify: options.notify } : {}),
    // The time of each step goes to a file in the state folder: the service
    // runs with no terminal, so a printed line would reach nobody.
    // What the hands spent on the step goes with it: the capture, the walk,
    // the encode, the glide and the wait for the panel.
    ...(options.env.CLAWDTIME_COMPUTER_TIMING === "on"
      ? {
          timing: (entry: StepTiming) =>
            recordTiming(options.root, { ...entry, ...hands.takeCost() }),
        }
      : {}),
  });
  return { worker, port: computerPort(worker, hands) };
}

/** The engines that can do computer work in one desktop service. */
export type ExecutionEngine =
  "chat" | "background" | "bundled" | "worker" | "none";

/**
 * Picks the one engine that does the computer work in a desktop service. The
 * order is fixed:
 *
 * 1. The connection to an existing chat, when `desktop-executor.json` is in
 *    the state folder of the service.
 * 2. The background runtime, when `background-cua.json` is there.
 * 3. The bundled runtime, when `bundled-cua.json` is there.
 * 4. The computer worker, when its switch is on, a key for the language model
 *    is in the environment, and no test started the service.
 *
 * The routes of the hands answer in every case. Only with the worker do they
 * ever hold a command.
 */
export function chooseExecution<
  Chat extends DesktopExecutorPort,
  Bundled extends DesktopExecutorPort,
  Background extends DesktopExecutorPort = never,
>(
  options: Omit<ComputerOptions, "unavailable"> & {
    /** The connection to an existing chat, when the service has one. */
    chat?: Chat | undefined;
    /** The background runtime, when the service has one. */
    background?: Background | undefined;
    /** The bundled runtime, when the service has one. */
    bundled?: Bundled | undefined;
    /** Phone or presentation actors run in this service. */
    actors: boolean;
    /** The agent board of this service is on: its chat takes the requests. */
    board: boolean;
  },
): {
  engine: ExecutionEngine;
  /** The engine that a file of the service configured: it owns the stop route. */
  configured: Chat | Background | Bundled | undefined;
  /** What the person's words are handed to. Undefined when nothing does computer work. */
  execution: Chat | Background | Bundled | ComputerWorker | undefined;
  /** The worker, and what the routes of the hands use. */
  computer: { worker: ComputerWorker | null; port: ComputerPort };
} {
  const { chat, background, bundled, actors, board, ...rest } = options;
  const configured = chat ?? background ?? bundled;
  const unavailable = chat
    ? chatEngineText
    : background
      ? backgroundEngineText
      : bundled
        ? bundledEngineText
        : actors
          ? actorsText
          : !board
            ? noBoardText
            : undefined;
  const computer = buildComputer({
    ...rest,
    ...(unavailable ? { unavailable } : {}),
  });
  return {
    engine: chat
      ? "chat"
      : background
        ? "background"
        : bundled
          ? "bundled"
          : computer.worker
            ? "worker"
            : "none",
    configured,
    execution: configured ?? computer.worker ?? undefined,
    computer,
  };
}

/** What the reach and the routines need of the proactive calls of the service. */
export interface ReachProactive {
  coordinator: ProactiveReachDeps["coordinator"];
  configured: () => boolean;
  pump: () => void;
  stop: (intentId: string) => void;
}

/**
 * The reach and the routines of a worker. The reach is on when the worker is,
 * unless `CLAWDTIME_COMPUTER_REACH=off`. It calls when the line is set up for
 * proactive calls, and texts when the text settings are in the environment of
 * the service. `CLAWDTIME_COMPUTER_REACH_SECONDS` is the time that the owner
 * has to answer in the chat first, 45 by default.
 */
export function buildOwnerReach(options: {
  worker: ComputerWorker;
  root: string;
  env: Record<string, string | undefined>;
  projectRoot: string;
  proactive?: ReachProactive | undefined;
  /** The line is in a call now. */
  liveCall: () => boolean;
  notify?: (text: string) => void;
  request?: typeof fetch;
}): { reach: OwnerReach | null; routines: Routines } {
  const journal = new ComputerJournal(options.root);
  const text = ownerTextPort(options.env, options.root, options.request);
  const routines = new Routines({
    root: options.root,
    worker: options.worker,
    journal,
    text,
    liveCall: options.liveCall,
    ...(options.notify ? { notify: options.notify } : {}),
  });
  if (options.env.CLAWDTIME_COMPUTER_REACH === "off")
    return { reach: null, routines };
  const seconds = Number(options.env.CLAWDTIME_COMPUTER_REACH_SECONDS);
  const proactive = options.proactive;
  const reach = new OwnerReach({
    root: options.root,
    worker: options.worker,
    journal,
    text,
    ...(Number.isFinite(seconds) && seconds >= 0 && seconds <= 600
      ? { delayMs: Math.round(seconds * 1000) }
      : {}),
    ...(proactive
      ? {
          call: proactiveReachCall({
            coordinator: proactive.coordinator,
            configured: proactive.configured,
            projectRoot: options.projectRoot,
            pump: proactive.pump,
            stop: proactive.stop,
            liveCall: options.liveCall,
          }),
        }
      : {}),
    ...(options.notify ? { notify: options.notify } : {}),
  });
  return { reach, routines };
}
