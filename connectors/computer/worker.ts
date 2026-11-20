/**
 * Computer use: the worker.
 *
 * The person says what to do on this Mac. The worker then works by itself,
 * one request at a time and one action at a time:
 *
 *   look at the screen, ask the planner for ONE action, check that action in
 *   code, look again just before it goes out, send it through the hands or the
 *   browser, look again, repeat.
 *
 * The planner is a language model, so its output is an untrusted
 * single-action plan. The promises below hold whatever it says:
 *
 * - Every action is checked against what the worker last saw (`guards.ts`),
 *   and again against a look that is taken just before the input goes out.
 * - A secure field is never typed into. The person types it.
 * - A name or a key that cannot be undone, or that speaks for the person,
 *   needs the person's yes. So does typing in a terminal. The yes is read by
 *   the same conservative reader that reads a yes on a phone call.
 * - Stop is checked before and after every action. Stop is cooperative: an
 *   action that was already sent may finish, and nothing follows it.
 * - Done counts only after an observation that came after the last action.
 * - A request whose result is not known is never repeated. It is `uncertain`
 *   and blocks new work until the person clears it.
 */
import { z } from "zod";
import type {
  DesktopExecutionSnapshot,
  DesktopExecutorPort,
} from "../../src/control/desktop-executor.js";
import { interpret } from "../agents/call.js";
import { looksSecret } from "../agents/memory.js";
import {
  actionSchema,
  check,
  clean,
  focusedSecure,
  retarget,
  samePageElement,
  type BrowserCall,
  type Checked,
  type View,
} from "./guards.js";
import type {
  ComputerJournal,
  JournalRequest,
  RequestState,
} from "./journal.js";
import { HandsTimeout } from "./panel-hands.js";
import type {
  Action,
  BrowserPage,
  BrowserPort,
  HandCommand,
  HandResult,
  Hands,
  HandsNext,
  Observation,
  Planner,
  StepRecord,
} from "./ports.js";

/** What every way to stop says. It never claims that an action was undone. */
export const stoppedText =
  "Stopped. An action that was already sent may have finished.";
const offStoppedText =
  "Computer use was turned off, so I stopped. An action that was already sent may have finished.";
const startedText =
  "Started. I look at the screen and take one checked action at a time. Say stop to stop me.";
const busyText =
  "A computer task is already running. Stop it, or wait for it to end, before a new one.";
const idleText =
  "Computer use is on. Ask me to do something on this Mac, and I take one checked action at a time.";
export const offText =
  "Computer use is off. Turn it on with: clawdtime computer on";
const takeoverText =
  "You moved the mouse or pressed a key, so I paused. Say continue to go on, or stop.";
const silentText =
  "The ClawdTime panel did not answer, so nothing was sent. Open the panel and ask again.";
const plannerText =
  "The planner did not answer, so I stopped. Nothing more was sent.";
const refusalsText =
  "The planner chose 3 actions in a row that the checks refused, so I stopped.";
const faultText =
  "Something failed inside the worker, so I stopped. An action may have been sent. Look at the screen, then run: clawdtime computer clear";
const secretText =
  "I do not take a password or a key in the chat. Type it into the field on the Mac yourself, then tell me to go on.";
const unwrittenText =
  "The record of computer tasks could not be written, so nothing was started.";
const grantText = {
  no_accessibility:
    "ClawdTime may not control this Mac yet. Open System Settings, Privacy & Security, Accessibility, and turn on the ClawdTime panel. Then ask again.",
  no_screen_recording:
    "ClawdTime may not see the screen yet. Open System Settings, Privacy & Security, Screen & System Audio Recording, and turn on the ClawdTime panel. Then ask again.",
} as const;
const lostText = (label: string) =>
  `I sent this and its result never came back: ${label}. It may have happened or not. I do not send it again. Look at the screen, then run: clawdtime computer clear`;
const uncertainText = (request: JournalRequest) =>
  request.reason === "unreadable_journal"
    ? "The record of computer tasks cannot be read, so I cannot tell whether an earlier task has an unknown result. Nothing new starts until you run: clawdtime computer clear"
    : `An earlier computer task has an unknown result: "${request.goal}". It is not run again. Look at the screen to see what happened, then run: clawdtime computer clear`;

/** What `GET /desktop/computer` answers. */
export const computerStatusSchema = z
  .object({
    version: z.literal(1),
    /** Computer use is on, and a worker runs in this service. */
    enabled: z.boolean(),
    /** idle, running, waiting_for_person, stopping, completed, blocked, canceled, uncertain. */
    state: z.string().max(40),
    message: z.string().max(2000),
    step: z.number().int().nonnegative(),
    goal: z.string().max(300),
    /** What the worker asks the person now. Null when it asks nothing. */
    question: z.string().max(2000).nullable(),
  })
  .strict();
export type ComputerStatus = z.infer<typeof computerStatusSchema>;

export interface ComputerWorkerOptions {
  hands: Hands;
  planner: Planner;
  journal: ComputerJournal;
  /** The browser, when one is connected. Without it the browser actions are refused. */
  browser?: BrowserPort;
  /** Whether computer use is still on. It is read before every action, so turning it off stops a request. */
  enabled?: () => boolean;
  /** Says something to the person when no message of theirs waits for an answer: a question, the result. */
  notify?: (text: string) => void;
  now?: () => number;
  /** The most actions that the planner may choose for one request. */
  maxSteps?: number;
  /** The most time for one request, with the time it waits for the person. */
  maxMs?: number;
  /** How long one call to the browser may take. */
  browserMs?: number;
}

type Reply =
  | { kind: "yes" }
  | { kind: "text"; text: string }
  /** The request ended while it waited: Stop, a no, the time limit. */
  | { kind: "over" };
interface Question {
  text: string;
  /** How the answer is read: a yes or no, continue or stop, or any words. */
  mode: "yes_no" | "continue" | "free";
  /** What the person is told when their answer ends the request. */
  refusal: string;
  settle: (reply: Reply) => void;
}
interface Run {
  id: string;
  /** The person's words, for the planner. */
  goal: string;
  /** The same as the journal keeps them, for the panel. */
  shown: string;
  deadline: number;
  step: number;
  state: "running" | "waiting_for_person" | "stopping";
  history: StepRecord[];
  /** The last full look at the screen. */
  observation: Observation | null;
  /** The last reading of the page. Null after an action on the screen. */
  page: BrowserPage | null;
  /** The observation came after the last action that was sent. */
  fresh: boolean;
  /** The last action that was sent, and how many times in a row. */
  streak: { signature: string; count: number } | null;
  refusals: number;
  plannerFailures: number;
  question: Question | null;
  stop: boolean;
  /** The hands said that the person moved the mouse or pressed a key. */
  takeover: boolean;
  halt: () => void;
  halted: Promise<null>;
}
/** What came of one command to the hands. */
interface Handed {
  /** The command went to the hands. False: it certainly did not run. */
  sent: boolean;
  /** The request ended on the way. */
  over: boolean;
  /** Null when no result came back. */
  result: HandResult | null;
}
type Ready = Extract<Checked, { verdict: "run" }>;

class BrowserSilent extends Error {}
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new BrowserSilent("The browser did not answer in time.")),
      ms,
    );
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
const tidy = (page: BrowserPage): BrowserPage => ({
  ...page,
  text: page.text.slice(0, 6000),
  elements: page.elements.slice(0, 200),
});
const clip = (text: string) => text.slice(0, 1900);
const identity = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
const sameFront = (before: Observation, after: Observation) =>
  before.app.bundleId === after.app.bundleId &&
  before.app.window === after.app.window;
/** How a step ended, in words for the planner and in one word for the journal. */
const outcome = (handed: Handed): [string, string] =>
  !handed.result
    ? ["no result came back", "lost"]
    : handed.result.ok
      ? ["ok", "ok"]
      : [
          `did not run: ${handed.result.error ?? "failed"}`,
          handed.result.error ?? "failed",
        ];

/** A clear yes, a clear no, or null. The reader is the one that reads a yes on a call. */
function readYes(words: string): boolean | null {
  const said = interpret(words, { kind: "permission", options: [] });
  return said?.decision === "allow"
    ? true
    : said?.decision === "deny"
      ? false
      : null;
}
/** Continue or stop. A yes or a no counts too. */
function readContinue(words: string): boolean | null {
  const plain = readYes(words);
  if (plain !== null) return plain;
  const said = interpret(words, {
    kind: "question",
    options: ["Continue", "Stop"],
  });
  if (said?.decision === "deny") return false;
  return said?.decision === "answer" ? said.text === "Continue" : null;
}

export class ComputerWorker implements DesktopExecutorPort {
  private current: Run | null = null;
  private last: {
    state: RequestState;
    message: string;
    goal: string;
    step: number;
  } | null = null;
  private ended: Promise<void> = Promise.resolve();
  private readonly hands: Hands;
  private readonly planner: Planner;
  private readonly journal: ComputerJournal;
  private readonly browser: BrowserPort | undefined;
  private readonly enabled: () => boolean;
  private readonly now: () => number;
  private readonly maxSteps: number;
  private readonly maxMs: number;
  private readonly browserMs: number;

  constructor(private readonly options: ComputerWorkerOptions) {
    this.hands = options.hands;
    this.planner = options.planner;
    this.journal = options.journal;
    this.browser = options.browser;
    this.enabled = options.enabled ?? (() => true);
    this.now = options.now ?? Date.now;
    this.maxSteps = options.maxSteps ?? 40;
    this.maxMs = options.maxMs ?? 15 * 60_000;
    this.browserMs = options.browserMs ?? 30_000;
    // A request that was running when the service stopped has an unknown
    // result. It becomes uncertain here, and nothing runs it again.
    this.journal.recover();
  }

  /** Resolves when the request that runs now has ended. At once when none runs. */
  idle() {
    return this.ended;
  }

  private say(text: string) {
    try {
      this.options.notify?.(clip(text));
    } catch {
      // A message that could not be shown changes nothing of the work.
    }
  }
  private get timeText() {
    return `I stopped at the time limit of ${Math.round(this.maxMs / 60_000)} minutes. The task is not finished.`;
  }

  /** Ends the request. Everything after this sees that it is over. */
  private finish(
    run: Run,
    state: RequestState,
    reason: string,
    message: string,
    tell = true,
  ) {
    if (this.current !== run) return;
    this.current = null;
    this.last = {
      state,
      message: clip(message),
      goal: run.shown,
      step: run.step,
    };
    try {
      this.journal.set(run.id, state, reason);
    } catch {
      // The journal still says running. The next start reads that as uncertain.
    }
    const question = run.question;
    run.question = null;
    question?.settle({ kind: "over" });
    run.halt();
    if (tell) this.say(message);
  }

  /**
   * The check before and after every action: Stop, the switch and the time
   * limit. True when the request is over.
   */
  private halted(run: Run): boolean {
    if (this.current !== run) return true;
    if (run.stop) this.finish(run, "canceled", "stopped", stoppedText, false);
    else if (!this.enabled())
      this.finish(run, "canceled", "turned_off", offStoppedText);
    else if (this.now() >= run.deadline)
      this.finish(run, "blocked", "time_limit", this.timeText);
    return this.current !== run;
  }
  /** A request that waits for the person ends when the switch goes off or its time runs out. */
  private expire() {
    const run = this.current;
    if (run?.question) this.halted(run);
  }

  status(): ComputerStatus {
    this.expire();
    const enabled = this.enabled();
    const run = this.current;
    if (run)
      return {
        version: 1,
        enabled,
        state: run.state,
        message:
          run.question?.text ??
          (run.state === "stopping"
            ? stoppedText
            : `Working on: "${clean(run.shown, 120)}". Step ${run.step} of at most ${this.maxSteps}.`),
        step: run.step,
        goal: clean(run.shown, 200),
        question: run.question?.text ?? null,
      };
    const unresolved = this.journal.unresolved();
    if (unresolved)
      return {
        version: 1,
        enabled,
        state: "uncertain",
        message:
          this.last?.state === "uncertain"
            ? this.last.message
            : uncertainText(unresolved),
        step: this.last?.step ?? unresolved.steps.length,
        goal: clean(unresolved.goal, 200),
        question: null,
      };
    // An uncertain request that the person cleared is in the past.
    if (this.last && this.last.state !== "uncertain")
      return {
        version: 1,
        enabled,
        state: this.last.state,
        message: this.last.message,
        step: this.last.step,
        goal: clean(this.last.goal, 200),
        question: null,
      };
    return {
      version: 1,
      enabled,
      state: "idle",
      message: enabled ? idleText : offText,
      step: 0,
      goal: "",
      question: null,
    };
  }
  snapshot(): DesktopExecutionSnapshot {
    const status = this.status();
    return {
      configured: status.enabled,
      state: status.state,
      canStop:
        status.enabled &&
        (status.state === "running" || status.state === "waiting_for_person"),
      message: status.message,
    };
  }
  /** What the panel shows while it serves the hands. */
  run(): HandsNext["run"] {
    const run = this.current;
    return {
      active: run !== null,
      goal: run ? clean(run.shown, 200) : "",
      step: run?.step ?? 0,
      state: run?.state ?? "idle",
    };
  }

  /**
   * Starts one request and answers at once. The work goes on after the
   * answer. The same id never starts a second time, and nothing starts while
   * another request runs or while one has an unknown result.
   */
  async submit(eventId: string, text: string): Promise<{ message: string }> {
    const id = identity.parse(eventId);
    const goal = z.string().trim().min(1).max(2000).parse(text);
    if (this.journal.get(id)) return { message: this.snapshot().message };
    if (!this.enabled()) return { message: offText };
    if (this.current) return { message: busyText };
    const unresolved = this.journal.unresolved();
    if (unresolved) return { message: uncertainText(unresolved) };
    let shown: string;
    try {
      // The record comes first: no work without it.
      shown = this.journal.open(id, goal).goal;
    } catch {
      return { message: unwrittenText };
    }
    let halt = () => {};
    const halted = new Promise<null>((resolve) => (halt = () => resolve(null)));
    const run: Run = {
      id,
      goal,
      shown,
      deadline: this.now() + this.maxMs,
      step: 0,
      state: "running",
      history: [],
      observation: null,
      page: null,
      fresh: false,
      streak: null,
      refusals: 0,
      plannerFailures: 0,
      question: null,
      stop: false,
      takeover: false,
      halt,
      halted,
    };
    this.current = run;
    this.last = null;
    this.ended = this.loop(run);
    return { message: startedText };
  }

  /**
   * Stop. A command that the hands have not fetched is taken back. An action
   * that is already with the hands may finish: the request ends when its
   * result arrives, and nothing follows it.
   */
  stop(): DesktopExecutionSnapshot {
    const run = this.current;
    if (run && !run.stop) {
      run.stop = true;
      if (run.question)
        this.finish(run, "canceled", "stopped", stoppedText, false);
      else {
        run.state = "stopping";
        (this.hands as { withdraw?: () => unknown }).withdraw?.();
        run.halt();
      }
    }
    return this.snapshot();
  }

  /** The person's reply to what the worker asks. Words that are not clear change nothing. */
  async answer(text: string): Promise<{ message: string }> {
    this.expire();
    const run = this.current;
    const question = run?.question;
    if (!run || !question) return { message: this.snapshot().message };
    const words = clean(text, 600);
    if (question.mode === "free") {
      if (!words) return { message: question.text };
      // The answer goes to the planner. A credential never does.
      if (looksSecret(text)) return { message: secretText };
      run.question = null;
      question.settle({ kind: "text", text: words });
      return { message: "Thank you. I go on." };
    }
    const said =
      question.mode === "continue" ? readContinue(words) : readYes(words);
    if (said === null)
      return { message: `I did not get a clear answer. ${question.text}` };
    if (said) {
      run.question = null;
      question.settle({ kind: "yes" });
      return { message: "Continuing." };
    }
    this.finish(
      run,
      "canceled",
      question.mode === "continue" ? "stopped" : "refused_by_person",
      question.refusal,
      false,
    );
    return { message: question.refusal };
  }

  /** Asks the person and waits. The request ends at Stop, at a no and at the time limit. */
  private ask(
    run: Run,
    mode: Question["mode"],
    text: string,
    refusal: string,
  ): Promise<Reply> {
    if (this.halted(run)) return Promise.resolve({ kind: "over" });
    let timer: NodeJS.Timeout | undefined;
    return new Promise<Reply>((settle) => {
      run.question = { text: clip(text), mode, refusal, settle };
      run.state = "waiting_for_person";
      this.journal.set(run.id, "waiting_for_person", "question");
      timer = setTimeout(
        () => this.expire(),
        Math.max(0, run.deadline - this.now()) + 50,
      );
      timer.unref();
      this.say(run.question.text);
    }).then((reply) => {
      clearTimeout(timer);
      if (this.current === run && reply.kind !== "over") {
        run.state = "running";
        // The person took time to answer: the last look is old now.
        run.fresh = false;
        this.journal.set(run.id, "running", "answered");
      }
      return reply;
    });
  }

  /** One finished step: for the planner in words, for the journal as kind, name and one word. */
  private note(
    run: Run,
    action: Action,
    why: string,
    target: string,
    said: string,
    kept: string,
    kind: string = action.kind,
  ) {
    run.history.push({ step: run.step, action, why, outcome: said });
    this.journal.step(run.id, { kind, target, outcome: kept });
  }

  /**
   * One command to the hands, with Stop checked before and after it. A
   * command with an effect whose result never comes back makes the request
   * uncertain: it is not sent again.
   */
  private async hand(
    run: Run,
    command: HandCommand,
    label: string,
  ): Promise<Handed> {
    if (this.halted(run)) return { sent: false, over: true, result: null };
    const effect = command.kind !== "observe" && command.kind !== "wait";
    // After anything but a look, the screen and the page may be other ones.
    // That holds for a wait too: it waits for the screen to change.
    if (command.kind !== "observe") {
      run.fresh = false;
      run.page = null;
    }
    let result: HandResult;
    try {
      result = await this.hands.run(command, label);
    } catch (error) {
      // The hands say whether the command was fetched. With no such word it may have run.
      const delivered = !(error instanceof HandsTimeout) || error.delivered;
      if (effect && delivered) {
        this.finish(run, "uncertain", "lost_result", lostText(label));
        return { sent: true, over: true, result: null };
      }
      this.finish(run, "blocked", "hands_silent", silentText);
      return { sent: false, over: true, result: null };
    }
    if (
      !result.ok &&
      (result.error === "no_accessibility" ||
        result.error === "no_screen_recording")
    )
      this.finish(run, "blocked", result.error, grantText[result.error]);
    else if (!result.ok && result.error === "stopped_by_person")
      // The person stopped it at the hands. After Stop here, they know already.
      this.finish(run, "canceled", "stopped", stoppedText, !run.stop);
    if (this.halted(run)) return { sent: true, over: true, result };
    if (result.interrupted) run.takeover = true;
    return { sent: true, over: false, result };
  }
  /** A look with no image, just before an input. Null when the screen could not be read. */
  private async look(run: Run): Promise<Observation | null | "over"> {
    const handed = await this.hand(
      run,
      { kind: "observe", image: false, elements: true },
      "Check the screen",
    );
    if (handed.over) return "over";
    return handed.result?.ok ? (handed.result.observation ?? null) : null;
  }

  private async loop(run: Run) {
    try {
      for (;;) {
        if (this.halted(run)) return;
        if (run.step >= this.maxSteps)
          return this.finish(
            run,
            "blocked",
            "step_limit",
            `I stopped at the limit of ${this.maxSteps} steps. The task is not finished.`,
          );
        if (run.takeover) {
          run.takeover = false;
          const reply = await this.ask(
            run,
            "continue",
            takeoverText,
            stoppedText,
          );
          if (reply.kind !== "yes") return;
          continue;
        }
        if (!run.fresh || !run.observation) {
          const handed = await this.hand(
            run,
            { kind: "observe", image: true, elements: true },
            "Look at the screen",
          );
          if (handed.over) return;
          if (run.takeover) continue;
          run.observation = handed.result?.ok
            ? (handed.result.observation ?? null)
            : null;
          run.fresh = run.observation !== null;
        }
        let planned: Awaited<ReturnType<Planner["next"]>> | null;
        try {
          // Stop does not wait for the planner.
          planned = await Promise.race([
            this.planner.next({
              goal: run.goal,
              history: run.history.slice(-12),
              observation: run.observation,
              page: run.page,
            }),
            run.halted,
          ]);
        } catch {
          // What the planner threw can hold what was sent to it: it is not passed on.
          if (this.halted(run)) return;
          if (++run.plannerFailures >= 2)
            return this.finish(run, "blocked", "planner_failed", plannerText);
          continue;
        }
        if (this.halted(run) || !planned) return;
        run.plannerFailures = 0;
        run.step++;
        await this.act(
          run,
          (planned as { action?: unknown }).action,
          clean(String((planned as { why?: unknown }).why ?? ""), 200),
        );
      }
    } catch {
      // A fault here is not proof that nothing was sent.
      this.finish(run, "uncertain", "fault", faultText);
    }
  }

  /** Checks one planned action and, when it may run, sends it. */
  private async act(run: Run, raw: unknown, why: string) {
    const before = run.observation;
    const view: View = {
      observation: before,
      page: run.page,
      fresh: run.fresh,
      browser: this.browser !== undefined,
    };
    const parsed = actionSchema.safeParse(raw);
    // The history needs an action even for output that was none.
    const action: Action = parsed.success
      ? parsed.data
      : { kind: "wait", ms: 0 };
    const checked = check(raw, view, why);
    if (checked.verdict === "refuse") {
      this.note(
        run,
        action,
        why,
        "",
        `refused: ${checked.reason}`,
        "refused",
        parsed.success ? parsed.data.kind : "invalid",
      );
      if (++run.refusals >= 3)
        this.finish(run, "blocked", "too_many_refusals", refusalsText);
      return;
    }
    run.refusals = 0;
    switch (checked.verdict) {
      case "done":
        this.note(run, action, why, "", "ok", "ok");
        return this.finish(
          run,
          "completed",
          "done",
          `Done. ${clean(checked.summary, 900)}`.trim(),
        );
      case "give_up":
        this.note(run, action, why, "", "gave up", "gave_up");
        return this.finish(
          run,
          "blocked",
          "gave_up",
          `I could not finish. ${clean(checked.reason, 900)}`.trim(),
        );
      case "ask": {
        const reply = await this.ask(
          run,
          "free",
          clean(checked.question, 900) || "I need an answer from you to go on.",
          "",
        );
        if (reply.kind !== "text") return;
        return this.note(
          run,
          action,
          why,
          "",
          `the person answered: ${reply.text}`,
          "answered",
        );
      }
      case "person_types":
        return this.personTypes(run, action, why, checked);
    }
    // The same action with the same arguments does not go out a third time in a row.
    if (
      checked.signature !== null &&
      run.streak?.signature === checked.signature &&
      run.streak.count >= 2
    ) {
      const reply = await this.ask(
        run,
        "yes_no",
        `I already did this twice in a row: ${checked.label}. Say yes to do it a third time, or no to stop.`,
        `Canceled. I did not do it a third time: ${checked.label}.`,
      );
      if (reply.kind !== "yes") return;
    }
    if (checked.risk) {
      const reply = await this.ask(
        run,
        "yes_no",
        `${checked.label}? ${checked.risk} Say yes to allow it, or no to stop.`,
        `Canceled. I did not do it: ${checked.label}.`,
      );
      if (reply.kind !== "yes") return;
    }
    if (checked.send.via === "browser")
      return this.viaBrowser(run, action, why, checked);
    return this.viaHands(run, action, why, checked, before);
  }

  /** Text for a secure field: the person types it, and the worker goes on after their yes. */
  private async personTypes(
    run: Run,
    action: Action,
    why: string,
    field: { label: string; target: string },
  ) {
    const reply = await this.ask(
      run,
      "yes_no",
      `${field.label}: that is a password field, and I never type there. Type it yourself, then say yes to go on, or no to stop.`,
      "Canceled. Nothing was typed.",
    );
    if (reply.kind !== "yes") return;
    this.note(
      run,
      action,
      why,
      field.target,
      "not typed: that is a password field. The person typed it.",
      "person_typed",
    );
  }
  private count(run: Run, signature: string | null) {
    // A scroll, a wait or a reading has no signature: it does not end the row.
    if (signature === null) return;
    run.streak =
      run.streak?.signature === signature
        ? { signature, count: run.streak.count + 1 }
        : { signature, count: 1 };
  }
  /** The action was not sent because the screen is not what the planner saw. The planner gets a new look. */
  private changed(
    run: Run,
    action: Action,
    why: string,
    target: string,
    reason: string,
  ) {
    run.fresh = false;
    this.note(run, action, why, target, `not sent: ${reason}`, "changed");
  }

  private async viaHands(
    run: Run,
    action: Action,
    why: string,
    first: Ready,
    before: Observation | null,
  ) {
    let ready = first;
    if (first.send.via !== "hands") return;
    if (first.send.look) {
      // Just before the input: look again, and check the same action against
      // that look. The planner took seconds to choose, and the person may
      // have taken minutes to say yes. The screen can be another one now.
      const seen = await this.look(run);
      if (seen === "over") return;
      if (run.takeover)
        return this.changed(
          run,
          action,
          why,
          first.target,
          "The person took over.",
        );
      if (!seen || !before)
        return this.changed(
          run,
          action,
          why,
          first.target,
          "The screen could not be read just before the action.",
        );
      const moved = retarget(action, before, seen);
      if (!moved.ok)
        return this.changed(run, action, why, first.target, moved.reason);
      const again = check(
        moved.action,
        {
          observation: moved.observation,
          page: null,
          fresh: true,
          browser: this.browser !== undefined,
        },
        why,
      );
      // A secure field took the focus since the planner looked.
      if (again.verdict === "person_types")
        return this.personTypes(run, action, why, again);
      // A yes was for what the person was asked. It does not cover another risk.
      if (
        again.verdict !== "run" ||
        again.send.via !== "hands" ||
        again.risk !== first.risk
      )
        return this.changed(
          run,
          action,
          why,
          first.target,
          "The screen changed since the planner looked.",
        );
      ready = again;
    }
    const send = ready.send;
    if (send.via !== "hands") return;
    if (send.focus) {
      const focus = await this.hand(run, send.focus, ready.label);
      if (!focus.sent) return;
      if (focus.over || !focus.result?.ok || run.takeover)
        return this.note(run, action, why, ready.target, ...outcome(focus));
      // Where did the focus land? Text never goes into a secure field.
      const seen = await this.look(run);
      if (seen === "over" || run.takeover)
        return this.note(
          run,
          action,
          why,
          ready.target,
          "clicked the field. The text was not typed.",
          "clicked",
        );
      if (!seen || !before || !sameFront(before, seen))
        return this.note(
          run,
          action,
          why,
          ready.target,
          "clicked the field. The text was not typed: the screen changed.",
          "clicked",
        );
      if (focusedSecure(seen)) return this.personTypes(run, action, why, ready);
    }
    this.count(run, ready.signature);
    const handed = await this.hand(run, send.command, ready.label);
    if (!handed.sent) return;
    this.note(run, action, why, ready.target, ...outcome(handed));
  }

  private call(browser: BrowserPort, call: BrowserCall): Promise<BrowserPage> {
    switch (call.name) {
      case "read":
        return browser.read();
      case "open":
        return browser.open(call.url);
      case "click":
        return browser.click(call.index);
      case "type":
        return browser.type(call.index, call.text, call.submit);
      case "scroll":
        return browser.scroll(call.direction);
      case "back":
        return browser.back();
    }
  }
  private async viaBrowser(
    run: Run,
    action: Action,
    why: string,
    first: Ready,
  ) {
    const browser = this.browser;
    if (!browser || first.send.via !== "browser") return;
    let call = first.send.call;
    if (call.name === "click" || call.name === "type") {
      // Just before the input: read the page again and find the same element.
      // Its number names it inside one reading only.
      if (this.halted(run)) return;
      let now: BrowserPage;
      try {
        now = tidy(await within(browser.read(), this.browserMs));
      } catch {
        run.page = null;
        this.note(
          run,
          action,
          why,
          first.target,
          "not sent: the page could not be read just before the action",
          "changed",
        );
        this.halted(run);
        return;
      }
      if (this.halted(run)) return;
      run.page = now;
      const same = samePageElement(call.element, now);
      const again = same
        ? check(
            { ...action, index: same.index },
            {
              observation: run.observation,
              page: now,
              fresh: run.fresh,
              browser: true,
            },
            why,
          )
        : null;
      if (
        !again ||
        again.verdict !== "run" ||
        again.send.via !== "browser" ||
        again.risk !== first.risk
      )
        return this.note(
          run,
          action,
          why,
          first.target,
          "not sent: the page changed since it was read",
          "changed",
        );
      call = again.send.call;
    }
    if (this.halted(run)) return;
    // A scroll changes what the screen shows, but silence after it loses nothing.
    const effect = call.name !== "read" && call.name !== "scroll";
    if (call.name !== "read") run.fresh = false;
    this.count(run, first.signature);
    try {
      run.page = tidy(await within(this.call(browser, call), this.browserMs));
    } catch (error) {
      run.page = null;
      // Silence after an action is not proof that it did not happen.
      if (error instanceof BrowserSilent && effect) {
        this.note(
          run,
          action,
          why,
          first.target,
          "no result came back",
          "lost",
        );
        return this.finish(
          run,
          "uncertain",
          "lost_result",
          lostText(first.label),
        );
      }
      this.note(
        run,
        action,
        why,
        first.target,
        "did not run: the browser failed",
        "failed",
      );
      this.halted(run);
      return;
    }
    this.note(run, action, why, first.target, "ok", "ok");
    this.halted(run);
  }
}
