import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerJournal } from "../connectors/computer/journal.js";
import type { Action } from "../connectors/computer/ports.js";
import {
  OwnerReach,
  reachSession,
  type CallPhase,
  type ReachAsk,
  type ReachCallPort,
  type ReachTextPort,
  type ReachWorker,
  type TextOutcome,
} from "../connectors/computer/reach.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import type { DesktopExecutionSnapshot } from "../src/control/desktop-executor.js";
import type { ProactiveCallIntent } from "../src/attention/proactive-contracts.js";
import {
  element,
  FakeHands,
  observation,
  ScriptedPlanner,
  until,
} from "./connectors-computer-fixture.js";

// Review 2: the reach takes a yes that is no yes, and asks for and passes on
// card and identity numbers. Each test is red on 461f812.

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const home = () => {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-review-2-"));
  roots.push(path);
  return path;
};

/** The call side, as a list. Nothing here dials. */
class FakeCall implements ReachCallPort {
  readonly placed: ReachAsk[] = [];
  private readonly phases = new Map<string, CallPhase>();
  readiness() {
    return { ready: true, reason: "ready" };
  }
  place(ask: ReachAsk) {
    const id = `call-${this.placed.length + 1}`;
    this.placed.push(ask);
    this.phases.set(id, { phase: "live", connected: true });
    return { id };
  }
  phase(id: string) {
    return this.phases.get(id)!;
  }
  cancel() {
    return false;
  }
  end() {}
}
/** The text side, as a list. Nothing here sends. */
class FakeText implements ReachTextPort {
  readonly sent: { key: string; text: string }[] = [];
  readiness() {
    return { ready: true, reason: "ready" };
  }
  async send(key: string, text: string): Promise<TextOutcome> {
    this.sent.push({ key, text });
    return "sent";
  }
}
/** A worker that waits on one question, and keeps what it was handed. */
class FakeWorker implements ReachWorker {
  readonly answers: string[] = [];
  now: DesktopExecutionSnapshot;
  constructor(question: string) {
    this.now = {
      requestId: "r1",
      configured: true,
      mode: "native",
      state: "waiting_for_person",
      canStop: true,
      message: question,
      goal: "Buy the blue mug",
      waiting: "question",
    };
  }
  snapshot() {
    return this.now;
  }
  async answer(text: string) {
    this.answers.push(text);
    this.now = { ...this.now, state: "running", message: "Working." };
    delete this.now.waiting;
    return { message: "Thank you. I go on." };
  }
  stop() {
    return this.now;
  }
}
const intentFor = (ask: ReachAsk): ProactiveCallIntent => ({
  id: "intent",
  version: 1,
  source: {
    kind: "computer",
    sessionId: reachSession,
    runId: ask.requestId,
    decisionId: ask.key,
  },
  observations: [],
  scope: {
    personId: "owner",
    deviceId: "mac",
    projectRoot: "/project",
    sessionId: reachSession,
  },
  policyId: "policy",
  trigger: "decision",
  channel: "phone_alert",
  expiresAt: Number.MAX_SAFE_INTEGER,
  brief: ask.spoken,
  state: "connected",
  createdAt: 0,
  updatedAt: 0,
  history: [],
});

/** A checkout whose Place order asks for a yes, the real worker, and a reach over it. */
function checkout(via: "call" | "text") {
  const root = home();
  const clock = { now: 1_000_000 };
  const hands = new FakeHands([
    observation([
      element(1, { title: "Place order" }),
      element(2, { role: "AXStaticText", title: "Order total: $48.00" }),
    ]),
  ]);
  const click: Action = { kind: "click_element", element: 1 };
  const planner = new ScriptedPlanner([
    click,
    { kind: "done", summary: "Ordered." },
  ]);
  const journal = new ComputerJournal(root, () => clock.now);
  const worker = new ComputerWorker({
    hands,
    planner,
    journal,
    now: () => clock.now,
    notify: () => {},
  });
  const call = new FakeCall();
  const text = new FakeText();
  const reach = new OwnerReach({
    root,
    worker,
    journal,
    ...(via === "call" ? { call } : { text }),
    now: () => clock.now,
  });
  return { clock, hands, worker, reach, call, text };
}

describe("review 2: a reach answer that means no is taken as a yes", () => {
  // Each of these is a no, a wait or a condition that the screen does not
  // meet. In the chat none of them approves (explicitApprovalYes in brain.ts).
  const notYes = [
    "okay, forget it",
    "ok, scratch that",
    "ok, hold off",
    "yes, but later",
    "yes, only if it is under 20 dollars",
    "ok I'll do it myself",
    "ok thanks",
  ];
  for (const via of ["text", "call"] as const)
    it.each(notYes)(
      `places no order on the reply %j by ${via}`,
      async (words) => {
        const { clock, hands, worker, reach, call, text } = checkout(via);
        await worker.submit("r1", "Buy the blue mug");
        await until(() => worker.snapshot().state === "waiting_for_person");
        expect(worker.snapshot().message).toMatch(/Place order.*48 dollars/);
        await reach.tick();
        clock.now += 45_000;
        await reach.tick();
        if (via === "call") {
          expect(call.placed).toHaveLength(1);
          await reach
            .proactiveSource()
            .answer(intentFor(call.placed[0]!), words);
        } else {
          expect(text.sent).toHaveLength(1);
          await reach.reply(words, "text");
        }
        // The words approve nothing, as in the chat: the question waits.
        await new Promise((done) => setTimeout(done, 20));
        expect(worker.snapshot()).toMatchObject({
          state: "waiting_for_person",
          waiting: "approval",
        });
        expect(hands.sent).toEqual([]);
        worker.stop();
        await worker.idle();
        expect(hands.sent).toEqual([]);
      },
    );
});

describe("review 2: the reach asks for and passes on card and identity numbers", () => {
  const secrets: [string, string][] = [
    ["The task asks: What is the CVV on your card?", "123"],
    ["The task asks: What is your social security number?", "078-05-1120"],
    [
      "The task asks: What is your bank account and routing number?",
      "routing 021000021 account 123456789",
    ],
  ];
  it.each(secrets)(
    "never says %j on a call, and never hands %j to the worker",
    async (question, answer) => {
      const root = home();
      const clock = { now: 1_000_000 };
      const worker = new FakeWorker(question);
      const call = new FakeCall();
      const reach = new OwnerReach({
        root,
        worker,
        call,
        now: () => clock.now,
      });
      await reach.tick();
      clock.now += 45_000;
      await reach.tick();
      expect(call.placed).toHaveLength(1);
      // The call asks the owner to say the number aloud.
      expect
        .soft(call.placed[0]!.spoken)
        .not.toMatch(/CVV|social security|routing number/i);
      await reach.proactiveSource().answer(intentFor(call.placed[0]!), answer);
      expect(worker.answers).toEqual([]);
    },
  );
});
