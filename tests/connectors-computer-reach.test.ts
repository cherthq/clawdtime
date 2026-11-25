import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerJournal } from "../connectors/computer/journal.js";
import type { Action, Observation } from "../connectors/computer/ports.js";
import {
  OwnerReach,
  isTextTurn,
  markTextTurn,
  ownerTextPort,
  proactiveReachCall,
  reachKind,
  reachPlace,
  reachReplies,
  reachSession,
  reachWords,
  readReach,
  voiceOnlyCall,
  withOwnerWords,
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
import { ProactiveCallCoordinator } from "../src/attention/proactive-coordinator.js";
import {
  ProactivePolicyAuthority,
  type ProactivePolicyInput,
} from "../src/attention/proactive-policy.js";
import { ProactivePreparationService } from "../src/control/proactive-preparation.js";
import { Vault } from "../src/storage/security.js";
import { Store } from "../src/storage/store.js";
import {
  element,
  FakeHands,
  observation,
  ScriptedPlanner,
  until,
} from "./connectors-computer-fixture.js";

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.close();
    } catch {
      // Closed already.
    }
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

/** The call side, as a list. Nothing here dials. */
class FakeCall implements ReachCallPort {
  ready = { ready: true, reason: "ready" };
  readonly placed: ReachAsk[] = [];
  readonly canceled: string[] = [];
  readonly ended: string[] = [];
  private readonly phases = new Map<string, CallPhase>();
  readiness() {
    return this.ready;
  }
  place(ask: ReachAsk) {
    const id = `call-${this.placed.length + 1}`;
    this.placed.push(ask);
    this.phases.set(id, { phase: "unsent" });
    return { id };
  }
  phase(id: string) {
    return this.phases.get(id)!;
  }
  set(id: string, phase: CallPhase) {
    this.phases.set(id, phase);
  }
  cancel(id: string) {
    if (this.phases.get(id)?.phase !== "unsent") return false;
    this.canceled.push(id);
    this.phases.set(id, { phase: "over", result: "failed" });
    return true;
  }
  end(id: string) {
    this.ended.push(id);
  }
}
/** The text side, as a list. Nothing here sends. */
class FakeText implements ReachTextPort {
  ready = { ready: true, reason: "ready" };
  outcome: TextOutcome = "sent";
  readonly sent: { key: string; text: string }[] = [];
  readiness() {
    return this.ready;
  }
  async send(key: string, text: string) {
    this.sent.push({ key, text });
    return this.outcome;
  }
}
/** A worker whose state the test sets, for the edges that the real one reaches slowly. */
class FakeWorker implements ReachWorker {
  now: DesktopExecutionSnapshot = {
    configured: true,
    mode: "native",
    state: "idle",
    canStop: false,
    message: "Computer use is on.",
  };
  readonly answers: string[] = [];
  stops = 0;
  snapshot() {
    return this.now;
  }
  ask(
    requestId: string,
    message: string,
    waiting: "approval" | "question" = "approval",
  ) {
    this.now = {
      requestId,
      configured: true,
      mode: "native",
      state: "waiting_for_person",
      canStop: true,
      message,
      goal: "Finish the draft",
      waiting,
    };
  }
  end(state: string, message: string) {
    this.now = {
      ...(this.now.requestId ? { requestId: this.now.requestId } : {}),
      configured: true,
      mode: "native",
      state,
      canStop: false,
      message,
    };
  }
  async answer(text: string) {
    this.answers.push(text);
    this.end("running", "Working.");
    return { message: "Continuing." };
  }
  stop() {
    this.stops++;
    this.end("canceled", "Stopped.");
    return this.now;
  }
}

const send = observation([element(1, { title: "Send" })]);
const click: Action = { kind: "click_element", element: 1 };
const done: Action = { kind: "done", summary: "The mail is sent." };
const sendQuestion =
  'Click "Send" in Notes? It sends as you to other people. Say yes or no.';

function home() {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-reach-"));
  roots.push(path);
  return path;
}

/** The real worker with made-up hands and a scripted planner, and a reach over it. */
function setup(
  script: ConstructorParameters<typeof ScriptedPlanner>[0] = [click, done],
  options: {
    screens?: Observation[];
    call?: FakeCall | null;
    text?: FakeText | null;
    delayMs?: number;
    root?: string;
  } = {},
) {
  const root = options.root ?? home();
  const clock = { now: 1_000_000 };
  const hands = new FakeHands(options.screens ?? [send]);
  const planner = new ScriptedPlanner(script);
  const said: string[] = [];
  const journal = new ComputerJournal(root, () => clock.now);
  const worker = new ComputerWorker({
    hands,
    planner,
    journal,
    now: () => clock.now,
    notify: (text) => said.push(text),
  });
  const call =
    options.call === null ? undefined : (options.call ?? new FakeCall());
  const text =
    options.text === null ? undefined : (options.text ?? new FakeText());
  const reach = new OwnerReach({
    root,
    worker,
    journal,
    call,
    text,
    now: () => clock.now,
    notify: (line) => said.push(line),
    ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
  });
  const waiting = () =>
    until(() => worker.snapshot().state === "waiting_for_person");
  const after = async (ms: number) => {
    clock.now += ms;
    await reach.tick();
  };
  return {
    root,
    clock,
    hands,
    planner,
    said,
    journal,
    worker,
    call: call!,
    text: text!,
    reach,
    waiting,
    after,
  };
}

/** An intent of the line about one question, as the proactive path hands it over. */
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
  state: "dispatching",
  createdAt: 0,
  updatedAt: 0,
  history: [],
});

describe("the reach waits for the chat first", () => {
  it("makes no call when the question is answered in the chat in time", async () => {
    const { worker, reach, call, text, waiting, after, hands } = setup();
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    expect(reach.current()).toMatchObject({
      kind: "approval",
      requestId: "r1",
    });
    await after(30_000);
    expect(call.placed).toEqual([]);
    // The owner answers in the chat: the chat hands the words to `answer`.
    expect((await worker.answer("yes")).message).toBe("Continuing.");
    await worker.idle();
    await after(60_000);
    await after(60_000);
    expect(call.placed).toEqual([]);
    expect(text.sent).toEqual([]);
    expect(hands.sent).toHaveLength(1);
    expect(reach.records()[0]!.events.map((event) => event.what)).toEqual([
      "asked",
      "ended",
    ]);
  });

  it("places exactly one call for an unanswered question, with the question said plainly", async () => {
    const { worker, reach, call, text, waiting, after } = setup();
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(44_000);
    expect(call.placed).toHaveLength(0);
    await after(1_000);
    expect(call.placed).toHaveLength(1);
    expect(call.placed[0]).toMatchObject({ requestId: "r1", kind: "approval" });
    expect(call.placed[0]!.spoken).toBe(
      `ClawdTime on your Mac needs your yes. ${sendQuestion}`,
    );
    call.set("call-1", { phase: "live", connected: true });
    for (let index = 0; index < 20; index++) await after(5_000);
    call.set("call-1", { phase: "over", result: "answered" });
    for (let index = 0; index < 20; index++) await after(5_000);
    expect(call.placed).toHaveLength(1);
    expect(text.sent).toEqual([]);
  });

  it("can wait another time, set by the service", async () => {
    const { worker, reach, call, waiting, after } = setup(undefined, {
      delayMs: 10_000,
    });
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(10_000);
    expect(call.placed).toHaveLength(1);
  });
});

describe("the answer on the call", () => {
  it("goes to the worker's own answer, and the worker decides", async () => {
    const { worker, reach, call, waiting, after, hands } = setup();
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(45_000);
    const ask = call.placed[0]!;
    call.set("call-1", { phase: "live", connected: true });
    await after(1_000);
    const line = reach.proactiveSource();
    // Words that are no clear yes approve nothing: the worker says so.
    expect(await line.answer(intentFor(ask), "maybe later")).toBe(
      `I did not get a clear answer. ${sendQuestion}`,
    );
    expect(worker.snapshot().state).toBe("waiting_for_person");
    expect(hands.sent).toEqual([]);
    expect(await line.answer(intentFor(ask), "yes, go ahead")).toBe(
      "Continuing.",
    );
    await worker.idle();
    expect(hands.sent).toEqual([
      { kind: "click", x: 150, y: 212, button: "left", count: 1 },
    ]);
    expect(worker.snapshot().state).toBe("completed");
    // The call that took the answer is not cut off.
    await after(1_000);
    expect(call.ended).toEqual([]);
    expect(reach.records()[0]!.events.map((event) => event.what)).toEqual([
      "asked",
      "call_placed",
      "call_connected",
      "unclear_call",
      "answered_by_call",
    ]);
  });

  it("takes a no as a no: the request ends", async () => {
    const { worker, reach, call, waiting, after, hands } = setup();
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(45_000);
    expect(
      await reach.proactiveSource().answer(intentFor(call.placed[0]!), "no"),
    ).toMatch(/^Canceled\./);
    expect(worker.snapshot().state).toBe("canceled");
    expect(hands.sent).toEqual([]);
  });

  it("stops the request at a spoken stop", async () => {
    const { worker, reach, call, waiting, after, hands } = setup();
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(45_000);
    await reach.reply("please stop", "call", call.placed[0]!.key);
    expect(worker.snapshot().state).toBe("canceled");
    expect(hands.sent).toEqual([]);
  });

  it("stops the request when the line's own stop tool is used on the call", async () => {
    const { worker, reach, call, waiting, after, hands } = setup();
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(45_000);
    call.set("call-1", { phase: "live", connected: true });
    reach.proactiveSource().stop(intentFor(call.placed[0]!));
    expect(worker.snapshot().state).toBe("canceled");
    expect(hands.sent).toEqual([]);
    await after(1_000);
    expect(call.ended).toEqual([]);
    expect(reach.records()[0]!.events.at(-1)!.what).toBe("stopped_by_call");
  });

  it("passes nothing for a question that no longer waits, or for another question", async () => {
    const { worker, reach, call, waiting, after } = setup();
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(45_000);
    const ask = call.placed[0]!;
    expect(
      await reach
        .proactiveSource()
        .answer(intentFor({ ...ask, key: "0".repeat(24) }), "yes"),
    ).toBe(reachReplies.gone);
    expect(worker.snapshot().state).toBe("waiting_for_person");
    await worker.answer("yes");
    await worker.idle();
    expect(await reach.proactiveSource().answer(intentFor(ask), "yes")).toBe(
      reachReplies.gone,
    );
  });

  it("lets the line read the exact question while it waits, and no longer after", async () => {
    const { worker, reach, call, waiting, after } = setup();
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(45_000);
    const intent = intentFor(call.placed[0]!);
    const evidence = reach.proactiveSource().evidence(intent);
    expect(evidence).toMatchObject({
      current: true,
      status: "decision",
      question: call.placed[0]!.spoken,
      views: [],
    });
    // The same reading twice is the same: preparation compares them.
    expect(reach.proactiveSource().evidence(intent)).toEqual(evidence);
    worker.stop();
    expect(reach.proactiveSource().evidence(intent).current).toBe(false);
  });
});

describe("the text after the call", () => {
  it.each([
    ["not answered", { phase: "over", result: "not_answered" }],
    ["failed", { phase: "over", result: "failed", reason: "refused" }],
    ["unknown", { phase: "over", result: "unknown" }],
  ] as const)(
    "goes once when the call is %s, and nothing is sent again",
    async (_name, phase) => {
      const { worker, reach, call, text, waiting, after } = setup();
      await worker.submit("r1", "Finish the draft");
      await waiting();
      await reach.tick();
      await after(45_000);
      call.set("call-1", phase);
      await after(1_000);
      expect(text.sent).toHaveLength(1);
      expect(text.sent[0]!.key).toBe(`clawdtime-reach:${reach.current()!.id}`);
      expect(text.sent[0]!.text).toBe(
        `ClawdTime on your Mac needs your yes for "Finish the draft". ${sendQuestion}`,
      );
      for (let index = 0; index < 30; index++) await after(10_000);
      expect(call.placed).toHaveLength(1);
      expect(text.sent).toHaveLength(1);
    },
  );

  it("goes at once when the line is not set up for calls", async () => {
    const { worker, reach, call, text, waiting, after } = setup();
    call.ready = { ready: false, reason: "outbound_setup_missing" };
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(45_000);
    expect(call.placed).toEqual([]);
    expect(text.sent).toHaveLength(1);
    expect(reach.records()[0]!.events).toContainEqual(
      expect.objectContaining({
        what: "call_not_set_up",
        detail: "outbound_setup_missing",
      }),
    );
  });

  it("goes when a call was never dialed in a minute, and the call is taken back", async () => {
    const { worker, reach, call, text, waiting, after } = setup();
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(45_000);
    await after(59_000);
    expect(text.sent).toEqual([]);
    await after(1_000);
    expect(call.canceled).toEqual(["call-1"]);
    expect(text.sent).toHaveLength(1);
  });

  it("does not go after a call that was answered, also with no clear answer on it", async () => {
    const { worker, reach, call, text, waiting, after } = setup();
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(45_000);
    call.set("call-1", { phase: "live", connected: true });
    await after(1_000);
    call.set("call-1", { phase: "over", result: "not_answered" });
    await after(1_000);
    expect(text.sent).toEqual([]);
  });

  it("says in the chat that nobody could be reached when neither side is set up", async () => {
    const { worker, reach, said, waiting, after } = setup(undefined, {
      call: null,
      text: null,
    });
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(45_000);
    expect(said.at(-1)).toBe(
      "I could not reach you by phone or by text about the question above. It still waits here.",
    );
    expect(worker.snapshot().state).toBe("waiting_for_person");
  });

  it("passes a text reply to the worker's own answer", async () => {
    const { worker, reach, call, waiting, after, hands } = setup();
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(45_000);
    call.set("call-1", { phase: "over", result: "not_answered" });
    await after(1_000);
    expect(reach.awaitsText()).toBe(true);
    const brain: string[] = [];
    const say = withOwnerWords(
      async (words: string) => {
        brain.push(words);
        return `brain: ${words}`;
      },
      {
        reach,
        fromText: () => true,
        answered: (_words, reply) => reply,
      },
    );
    expect(await say("Yes")).toBe("Continuing.");
    expect(brain).toEqual([]);
    await worker.idle();
    expect(hands.sent).toHaveLength(1);
    expect(reach.records()[0]!.events.at(-1)!.what).toBe("answered_by_text");
    // Words of the panel go on to the chat as before.
    const panel = withOwnerWords(async (words: string) => `brain: ${words}`, {
      reach,
      fromText: () => false,
      answered: (_words, reply) => reply,
    });
    expect(await panel("hello")).toBe("brain: hello");
  });

  it("reads the mark of the text channel for these exact words only, for a short time", () => {
    const root = home();
    markTextTurn(root, "yes", 10_000);
    expect(isTextTurn(root, "yes", 20_000)).toBe(true);
    expect(isTextTurn(root, "no", 20_000)).toBe(false);
    expect(isTextTurn(root, "yes", 10_000 + 121_000)).toBe(false);
    expect(
      statSync(join(root, "computer", "text-turn.json")).mode & 0o777,
    ).toBe(0o600);
    expect(
      readFileSync(join(root, "computer", "text-turn.json"), "utf8"),
    ).not.toContain('"yes"');
  });
});

describe("one call and one text for one question", () => {
  it("never calls again, also after a restart of the service", async () => {
    const first = setup();
    await first.worker.submit("r1", "Finish the draft");
    await first.waiting();
    await first.reach.tick();
    await first.after(45_000);
    first.call.set("call-1", { phase: "over", result: "not_answered" });
    await first.after(1_000);
    expect(first.text.sent).toHaveLength(1);
    // A second reach on the same record: the question was reached already.
    const call = new FakeCall();
    const text = new FakeText();
    const again = new OwnerReach({
      root: first.root,
      worker: first.worker,
      journal: first.journal,
      call,
      text,
      now: () => first.clock.now,
    });
    for (let index = 0; index < 10; index++) {
      first.clock.now += 60_000;
      await again.tick();
    }
    expect(call.placed).toEqual([]);
    expect(text.sent).toEqual([]);
  });

  it("lets a newer question replace an older one: the older call is taken back", async () => {
    const worker = new FakeWorker();
    const call = new FakeCall();
    const text = new FakeText();
    let now = 0;
    const reach = new OwnerReach({
      root: home(),
      worker,
      call,
      text,
      now: () => now,
    });
    worker.ask("r1", sendQuestion);
    await reach.tick();
    now += 45_000;
    await reach.tick();
    expect(call.placed).toHaveLength(1);
    worker.ask(
      "r1",
      "The task asks: Which mail: the first or the second?",
      "question",
    );
    now += 1_000;
    await reach.tick();
    expect(call.canceled).toEqual(["call-1"]);
    expect(reach.current()).toMatchObject({ kind: "question" });
    now += 45_000;
    await reach.tick();
    expect(call.placed).toHaveLength(2);
    expect(call.placed[1]!.key).not.toBe(call.placed[0]!.key);
    expect(call.placed[1]!.spoken).toBe(
      "ClawdTime on your Mac asks: Which mail: the first or the second? Say your answer.",
    );
    // An answer meant for the older question goes nowhere.
    expect(await reach.reply("yes", "call", call.placed[0]!.key)).toBe(
      reachReplies.gone,
    );
    expect(worker.answers).toEqual([]);
  });

  it("ends a ringing call when the question goes away, and takes back one that was not dialed", async () => {
    const worker = new FakeWorker();
    const call = new FakeCall();
    let now = 0;
    const reach = new OwnerReach({
      root: home(),
      worker,
      call,
      now: () => now,
    });
    worker.ask("r1", sendQuestion);
    await reach.tick();
    now += 45_000;
    await reach.tick();
    call.set("call-1", { phase: "live", connected: false });
    worker.end("running", "Working.");
    now += 1_000;
    await reach.tick();
    expect(call.ended).toEqual(["call-1"]);
  });
});

describe("Stop of the request", () => {
  it("takes back a call that was not dialed and sends no text", async () => {
    const { worker, reach, call, text, waiting, after } = setup();
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(45_000);
    expect(call.placed).toHaveLength(1);
    worker.stop();
    await after(1_000);
    expect(call.canceled).toEqual(["call-1"]);
    for (let index = 0; index < 10; index++) await after(30_000);
    expect(text.sent).toEqual([]);
    expect(reach.current()).toBeNull();
    expect(reach.records()[0]!.events.map((event) => event.what)).toEqual([
      "asked",
      "call_placed",
      "call_taken_back",
      "stopped",
    ]);
  });

  it("before the wait is over places nothing", async () => {
    const { worker, reach, call, text, waiting, after } = setup();
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(20_000);
    worker.stop();
    await after(60_000);
    expect(call.placed).toEqual([]);
    expect(text.sent).toEqual([]);
  });
});

describe("a sign-in or a code", () => {
  const login = observation([
    element(1, { role: "AXTextField", title: "Name" }),
    element(2, { role: "AXSecureTextField", title: "Password", secure: true }),
  ]);

  it("says what is needed and where, and never asks for a secret", async () => {
    const { worker, reach, call, text, waiting, after, planner } = setup(
      [{ kind: "type", text: "hunter2", element: 2 }, done],
      { screens: [login] },
    );
    await worker.submit("r1", "Log in to example.com and read my messages");
    await waiting();
    await reach.tick();
    expect(reach.current()!.kind).toBe("signin");
    await after(45_000);
    const spoken = call.placed[0]!.spoken;
    expect(spoken).toBe(
      "ClawdTime on your Mac needs you to sign in to example.com: sign in on the Mac, or once in ClawdTime's own browser profile, then say yes. Never say a password or a code on this call.",
    );
    call.set("call-1", { phase: "over", result: "not_answered" });
    await after(1_000);
    const sent = text.sent[0]!.text;
    expect(sent).toContain(
      "Sign in on the Mac, or once in ClawdTime's own browser profile.",
    );
    expect(sent).toContain("Never send a password or a code in a text.");
    for (const words of [spoken, sent])
      expect(words).not.toMatch(
        /\b(?:tell|send|say|give)\s+(?:me\s+)?(?:your|the)\s+(?:password|code)\b|what is (?:your|the) (?:password|code)/i,
      );
    // A password or a code in the reply goes nowhere.
    for (const reply of ["my password is hunter22x", "482913", "4 8 2 9 1 3"])
      expect(await reach.reply(reply, "text")).toBe(reachReplies.secret);
    expect(worker.snapshot().state).toBe("waiting_for_person");
    expect(await reach.reply("yes", "text")).toBe("Continuing.");
    await worker.idle();
    expect(JSON.stringify(planner.inputs)).not.toContain("482913");
    expect(JSON.stringify(planner.inputs)).not.toContain("hunter22x");
  });

  it("takes done, and never a code, for a code that the task asks for", async () => {
    const { worker, reach, call, waiting, after, planner } = setup(
      [
        {
          kind: "ask",
          question: "What is the verification code from the SMS?",
        },
        (input) => {
          expect(input.history.at(-1)!.outcome).toBe(
            "the person answered: done",
          );
          return done;
        },
      ],
      { screens: [send] },
    );
    await worker.submit("r1", "Sign in to my bank");
    await waiting();
    await reach.tick();
    expect(reach.current()!.kind).toBe("code");
    await after(45_000);
    expect(call.placed[0]!.spoken).toBe(
      "ClawdTime on your Mac needs a code: type it on the Mac yourself, then say done. Never say a code on this call.",
    );
    expect(await reach.reply("it is 123456", "call", call.placed[0]!.key)).toBe(
      reachReplies.secret,
    );
    expect(await reach.reply("done", "call", call.placed[0]!.key)).toBe(
      "Thank you. I go on.",
    );
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    expect(JSON.stringify(planner.inputs)).not.toContain("123456");
  });

  it("reads the kind and the place from the worker's own words", () => {
    expect(reachKind(sendQuestion, "yes_no")).toBe("approval");
    expect(
      reachKind(
        'Type in "Password": that is a password field, and I never type there. Type it yourself, then say yes to go on, or no to stop.',
        "yes_no",
      ),
    ).toBe("signin");
    expect(
      reachKind("The task asks: Please sign in to Google first.", "free"),
    ).toBe("signin");
    expect(reachKind("The task asks: Enter the 2FA code.", "free")).toBe(
      "code",
    );
    expect(reachKind("The task asks: Which note?", "free")).toBe("question");
    expect(reachPlace("Please sign in to Google first.")).toBe("Google");
    expect(reachPlace("x", "Follow up on my posts on x.com")).toBe("x.com");
    expect(reachPlace("Type it yourself, then say yes.")).toBeNull();
    const words = reachWords({
      kind: "signin",
      mode: "free",
      question: "The task asks: Please sign in to X first.",
      goal: "Follow up on my latest posts",
    });
    expect(words.spoken).toBe(
      "ClawdTime on your Mac needs you to sign in to X: sign in on the Mac, or once in ClawdTime's own browser profile, then say done. Never say a password or a code on this call.",
    );
    for (const value of Object.values(words))
      expect(value).not.toMatch(new RegExp("[\\u2013\\u2014]"));
  });
});

describe("where the request came from", () => {
  it("reaches at once for a request that came from a call", async () => {
    const worker = new FakeWorker();
    const call = new FakeCall();
    const reach = new OwnerReach({ root: home(), worker, call, now: () => 0 });
    worker.ask("phone_0123456789abcdef", sendQuestion);
    await reach.tick();
    expect(call.placed).toHaveLength(1);
    expect(reach.records()[0]!.origin).toBe("call");
  });

  it("reaches at once for a routine, and for a request that came by text", async () => {
    const worker = new FakeWorker();
    const call = new FakeCall();
    const reach = new OwnerReach({ root: home(), worker, call, now: () => 0 });
    worker.ask("routine_0123abcd_k", sendQuestion);
    await reach.tick();
    expect(call.placed).toHaveLength(1);
    const texted = setup();
    texted.reach.textTurn(texted.clock.now);
    await texted.worker.submit("r1", "Finish the draft");
    texted.reach.textTurnEnded(texted.clock.now, texted.clock.now + 2_000);
    await texted.waiting();
    await texted.reach.tick();
    expect(texted.call.placed).toHaveLength(1);
    expect(texted.reach.records()[0]!.origin).toBe("text");
  });
});

describe("a request that ended blocked", () => {
  it("is told once by call, then by text, and nothing runs from the answer", async () => {
    const worker = new FakeWorker();
    const call = new FakeCall();
    const text = new FakeText();
    let now = 0;
    const reach = new OwnerReach({
      root: home(),
      worker,
      call,
      text,
      now: () => now,
    });
    worker.ask("r1", sendQuestion);
    worker.end(
      "blocked",
      "I stopped at the limit of 40 steps. The task is not finished.",
    );
    await reach.tick();
    now += 45_000;
    await reach.tick();
    expect(call.placed[0]!.spoken).toBe(
      "ClawdTime could not finish the task on your Mac. I stopped at the limit of 40 steps. The task is not finished.",
    );
    expect(await reach.reply("yes", "call", call.placed[0]!.key)).toBe(
      reachReplies.ended,
    );
    expect(worker.answers).toEqual([]);
    call.set("call-1", { phase: "over", result: "failed" });
    now += 1_000;
    await reach.tick();
    expect(text.sent).toHaveLength(1);
    expect(reach.awaitsText()).toBe(false);
  });

  it("is not told for a routine, which reports its own end", async () => {
    const worker = new FakeWorker();
    const call = new FakeCall();
    const reach = new OwnerReach({ root: home(), worker, call, now: () => 0 });
    worker.ask("routine_0123abcd_k", sendQuestion);
    worker.end("blocked", "I could not finish.");
    await reach.tick();
    expect(reach.current()).toBeNull();
    expect(call.placed).toEqual([]);
  });
});

describe("the record of the reach", () => {
  it("is for its owner only and holds no question, no answer and no typed text", async () => {
    const { worker, reach, call, waiting, after, root } = setup();
    await worker.submit("r1", "Finish the draft");
    await waiting();
    await reach.tick();
    await after(45_000);
    await reach.reply("yes", "call", call.placed[0]!.key);
    await worker.idle();
    await after(1_000);
    const file = join(root, "computer", "reach.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "computer")).mode & 0o777).toBe(0o700);
    const kept = readFileSync(file, "utf8");
    expect(kept).not.toContain("Send");
    expect(kept).not.toContain("yes");
    expect(readReach(root)!.items[0]).toMatchObject({
      requestId: "r1",
      kind: "approval",
      origin: "chat",
    });
    expect(readReach(root)!.readiness).toMatchObject({
      calls: { ready: true },
      texts: { ready: true },
    });
  });
});

describe("a record that cannot be read", () => {
  it("is set aside under a new name and not written over", async () => {
    const root = home();
    const file = join(root, "computer", "reach.json");
    markTextTurn(root, "make the folder", 0);
    writeFileSync(file, "not json", { mode: 0o600 });
    const worker = new FakeWorker();
    const reach = new OwnerReach({ root, worker, now: () => 5 });
    worker.ask("r1", sendQuestion);
    await reach.tick();
    expect(readFileSync(`${file}.unreadable-5`, "utf8")).toBe("not json");
    expect(readReach(root)!.items).toHaveLength(1);
  });
});

describe("the proactive call path of the line", () => {
  const policy: ProactivePolicyInput = {
    version: 2,
    id: "policy",
    scope: { personId: "owner", deviceId: "mac", projectRoot: "/project" },
    triggers: ["decision", "failure"],
    channels: ["phone_alert"],
    expiresAt: 10_000_000,
    maxAttempts: 10,
    minIntervalMs: 0,
    attemptLifetimeMs: 60_000,
    viewScope: [],
    alertFallback: false,
    consent: {
      actorId: "owner",
      recordedAt: 1000,
      source: "human_request",
      statement: "Call me when the computer task needs me.",
    },
  };
  function line(register = true) {
    const store = new Store(":memory:");
    stores.push(store);
    const vault = new Vault("cd".repeat(32));
    let now = 2000;
    const clock = () => now;
    const authority = new ProactivePolicyAuthority(store, vault, clock);
    const coordinator = new ProactiveCallCoordinator(
      store,
      vault,
      authority,
      clock,
    );
    if (register) authority.register(policy);
    let pumped = 0;
    const stopped: string[] = [];
    const port = proactiveReachCall({
      coordinator,
      configured: () => true,
      projectRoot: "/project",
      pump: () => pumped++,
      stop: (id) => stopped.push(id),
      now: clock,
    });
    return {
      store,
      vault,
      authority,
      coordinator,
      port,
      stopped,
      pumped: () => pumped,
      tick: (ms: number) => (now += ms),
    };
  }
  const ask: ReachAsk = {
    key: "a".repeat(24),
    requestId: "r1",
    kind: "approval",
    spoken: `ClawdTime on your Mac needs your yes. ${sendQuestion}`,
  };

  it("queues one spoken alert for one question, and never a second one", () => {
    const { port, coordinator, pumped } = line();
    expect(port.readiness()).toEqual({ ready: true, reason: "ready" });
    const placed = port.place(ask) as { id: string };
    const again = port.place(ask) as { id: string };
    expect(again.id).toBe(placed.id);
    expect(coordinator.list()).toHaveLength(1);
    const intent = coordinator.get(placed.id);
    expect(intent).toMatchObject({
      source: {
        kind: "computer",
        sessionId: reachSession,
        runId: "r1",
        decisionId: ask.key,
      },
      trigger: "decision",
      channel: "phone_alert",
      state: "queued",
    });
    expect(voiceOnlyCall(intent)).toBe(true);
    expect(pumped()).toBe(2);
    expect(port.phase(placed.id)).toEqual({ phase: "unsent" });
    expect(port.cancel(placed.id)).toBe(true);
    expect(port.phase(placed.id)).toMatchObject({
      phase: "over",
      result: "failed",
    });
  });

  it("tells an answered call from one that rang out", () => {
    for (const connected of [true, false]) {
      const { port, coordinator } = line();
      const { id } = port.place(ask) as { id: string };
      coordinator.prepare(id);
      coordinator.ready(id, "ab".repeat(32));
      const { grant } = coordinator.reserve(id, {
        sourceCurrent: true,
        lineAvailable: true,
        packetFingerprint: "ab".repeat(32),
      });
      expect(port.phase(id)).toEqual({ phase: "live", connected: false });
      if (connected) coordinator.outcome(id, grant!.attemptId, "connected");
      coordinator.outcome(id, grant!.attemptId, "ended", {
        cleanupConfirmed: true,
      });
      expect(port.phase(id)).toEqual({
        phase: "over",
        result: connected ? "answered" : "not_answered",
      });
    }
  });

  it("is not ready without a policy, with a call of unknown outcome, or during a call", () => {
    expect(line(false).port.readiness()).toEqual({
      ready: false,
      reason: "no_policy",
    });
    const unknown = line();
    const { id } = unknown.port.place(ask) as { id: string };
    unknown.coordinator.prepare(id);
    unknown.coordinator.ready(id, "ab".repeat(32));
    const { grant } = unknown.coordinator.reserve(id, {
      sourceCurrent: true,
      lineAvailable: true,
      packetFingerprint: "ab".repeat(32),
    });
    unknown.coordinator.outcome(id, grant!.attemptId, "unknown");
    expect(unknown.port.readiness()).toEqual({
      ready: false,
      reason: "earlier_call_unknown",
    });
    const busy = line();
    const port = proactiveReachCall({
      coordinator: busy.coordinator,
      configured: () => true,
      projectRoot: "/project",
      liveCall: () => true,
      now: () => 2000,
    });
    expect(port.readiness()).toEqual({
      ready: false,
      reason: "line_in_a_call",
    });
    const off = proactiveReachCall({
      coordinator: busy.coordinator,
      configured: () => false,
      projectRoot: "/project",
    });
    expect(off.readiness()).toEqual({
      ready: false,
      reason: "outbound_setup_missing",
    });
  });

  it("prepares the spoken alert from the reach's own reading of the question", async () => {
    const { store, vault, coordinator, port } = line();
    const worker = new FakeWorker();
    const reach = new OwnerReach({
      root: home(),
      worker,
      call: port,
      now: () => 0,
      delayMs: 0,
    });
    worker.ask("r1", sendQuestion);
    await reach.tick();
    const intent = coordinator.list()[0]!;
    const source = reach.proactiveSource();
    const preparation = new ProactivePreparationService(
      store,
      vault,
      coordinator,
      {
        inspectSource: (value) => source.evidence(value),
        resolveViews: async () => {
          throw new Error("A spoken alert has no views.");
        },
        releaseViews: async () => ({ confirmed: true }),
      },
      () => 2000,
    );
    const packet = await preparation.prepare(intent.id);
    expect(packet.narration).toBe(
      `Your input is needed. ClawdTime on your Mac needs your yes. ${sendQuestion}`,
    );
    expect(packet.views).toEqual([]);
    expect(coordinator.get(intent.id).state).toBe("ready");
  });
});

describe("the text side over the text settings", () => {
  const env = {
    CHERT_API_KEY: "test-key",
    CHERT_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
    CLAWDTIME_OWNER_PHONE: "+15550000000",
    CHERT_LINE_ID: "22222222-2222-4222-8222-222222222222",
  };

  it("says what is missing, and sends one text with one key", async () => {
    expect(ownerTextPort({}, home()).readiness()).toEqual({
      ready: false,
      reason: "missing:CHERT_API_KEY,CHERT_PROJECT_ID,CLAWDTIME_OWNER_PHONE",
    });
    const requests: { url: string; init: RequestInit }[] = [];
    let status = 500;
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ data: { state: "queued" } }), {
        status,
      });
    }) as unknown as typeof fetch;
    const port = ownerTextPort(env, home(), fetcher);
    expect(port.readiness()).toEqual({ ready: true, reason: "ready" });
    // A failure is not sent again: its outcome is not known.
    expect(await port.send("clawdtime-reach:abc", "Hello")).toBe("unknown");
    expect(requests).toHaveLength(1);
    status = 200;
    expect(await port.send("clawdtime-reach:abc", "Hello")).toBe("sent");
    const headers = requests[1]!.init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("clawdtime-reach:abc");
    expect(JSON.parse(requests[1]!.init.body as string)).toEqual({
      line_id: env.CHERT_LINE_ID,
      recipient: env.CLAWDTIME_OWNER_PHONE,
      text: "Hello",
    });
  });
});
