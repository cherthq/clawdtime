import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { ProactivePolicyAuthority } from "../src/attention/proactive-policy.js";
import { ProactiveCallCoordinator } from "../src/attention/proactive-coordinator.js";
import type {
  CallSource,
  CallTrigger,
  ProactiveCallIntent,
} from "../src/attention/proactive-contracts.js";
import { ProactiveLineSessions } from "../src/control/proactive-line.js";
import type { ProactiveReviewPacket } from "../src/control/proactive-preparation.js";
import {
  walkthroughComputer,
  walkthroughScreenGuard,
} from "../src/control/proactive-setup.js";
import { PhoneDesktop } from "../src/control/phone-desktop.js";
import type {
  DesktopExecutionAuthority,
  DesktopExecutionSnapshot,
} from "../src/control/desktop-executor.js";

// Every name, number and path here is made up for the tests.
const stores: Store[] = [];
const adapters: PhoneDesktop[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const adapter of adapters.splice(0)) adapter.shutdown();
});
const fingerprint = "ab".repeat(32),
  sourceFingerprint = "cd".repeat(32);
const jobSource: CallSource = {
  kind: "job",
  sessionId: "session",
  runId: "run",
  jobId: "job",
  launchId: "launch",
};
const decisionSource: CallSource = {
  kind: "decision",
  sessionId: "session",
  runId: "run",
  decisionId: "decision",
};

/** One reserved walkthrough call of a calling policy, and its line session. */
function callFixture(
  options: {
    allowComputerControl?: boolean;
    source?: CallSource;
    trigger?: CallTrigger;
    viewScope?: string[];
  } = {},
) {
  const store = new Store(":memory:");
  stores.push(store);
  const vault = new Vault("ef".repeat(32));
  let now = Date.now();
  const clock = () => now;
  const authority = new ProactivePolicyAuthority(store, vault, clock);
  const coordinator = new ProactiveCallCoordinator(
    store,
    vault,
    authority,
    clock,
  );
  const policy = authority.register({
    version: 2,
    id: "policy",
    scope: { personId: "person", deviceId: "device", projectRoot: "/fixture" },
    triggers: ["decision", "completion"],
    channels: ["phone_walkthrough"],
    expiresAt: now + 100000,
    maxAttempts: 5,
    minIntervalMs: 0,
    attemptLifetimeMs: 60000,
    viewScope: options.viewScope ?? ["selected-display"],
    ...(options.allowComputerControl === false
      ? {}
      : { allowComputerControl: true }),
    alertFallback: false,
    consent: {
      actorId: "person",
      recordedAt: now,
      source: "operator",
      statement: "Call about this fixture.",
    },
  });
  const source = options.source ?? jobSource;
  const intent = coordinator.enqueue({
    source,
    scope: { ...policy.scope, sessionId: "session" },
    policyId: policy.id,
    trigger: options.trigger ?? "completion",
    channel: "phone_walkthrough",
    expiresAt: now + 90000,
    brief: "The fixture job finished.",
  }).record;
  const packet: ProactiveReviewPacket = {
    version: 1,
    id: "packet",
    intentId: intent.id,
    source: intent.source,
    sourceFingerprint,
    policyId: policy.id,
    policyRevision: 1,
    channel: "phone_walkthrough",
    goal: "Review the fixture",
    status: "verified",
    summary: "The fixture page is ready.",
    choices: [],
    checks: [],
    artifacts: [],
    narration: "The fixture page is ready.",
    views: [],
    walkthroughOrder: ["selected-display"],
    createdAt: now,
    expiresAt: now + 30000,
    fingerprint,
  };
  coordinator.prepare(intent.id);
  coordinator.ready(intent.id, fingerprint);
  const reserved = coordinator.reserve(intent.id, {
    sourceCurrent: true,
    lineAvailable: true,
    packetFingerprint: fingerprint,
  });
  const port = {
    submit: vi.fn(
      async (_intent: ProactiveCallIntent, _words: string, _turnId: string) =>
        "Requested on the Mac; not verified.",
    ),
    renew: vi.fn((_intent: ProactiveCallIntent) => {}),
    stop: vi.fn(
      (_intent: ProactiveCallIntent) =>
        "Stop requested for this call's computer work.",
    ),
    close: vi.fn((_intent: ProactiveCallIntent) => {}),
  };
  const answer = vi.fn(
    async (_intent: ProactiveCallIntent, _words: string, _turnId: string) =>
      "Applied to the exact pending request.",
  );
  const stopSharing = vi.fn(async (_intent: ProactiveCallIntent) => ({
    confirmed: true,
  }));
  const line = new ProactiveLineSessions(
    authority,
    {
      sourceCurrent: () => true,
      answer,
      stopSharing,
      computer: port,
    },
    clock,
  );
  const capability = line.open(reserved.record, reserved.grant!, packet, {
    roomName: "fixture-room",
    agentIdentity: "fixture-agent",
  });
  const { token, version: _v, expiresAt: _e, ...binding } = capability;
  const command = (action: string, extra: object = {}) =>
    line.command(binding.attemptId, token, { action, binding, ...extra });
  const prepare = async () => {
    line.bindCaller(binding.attemptId, "paired-caller");
    return command("prepared", {
      media: { audioReady: true, videoReady: true },
    });
  };
  const say = (action: "answer" | "computer", text: string, turnId: string) =>
    command(action, { text, turnId, callerIdentity: "paired-caller" });
  return {
    authority,
    grant: reserved.grant!,
    attemptId: binding.attemptId,
    line,
    port,
    answer,
    stopSharing,
    command,
    prepare,
    say,
    advance: (ms: number) => (now += ms),
  };
}

describe("computer control of a walkthrough call", () => {
  it("is granted only by a policy that enables it, and only after the call is prepared for its caller", async () => {
    const plain = callFixture({ allowComputerControl: false });
    expect(plain.grant.inputAllowed).toBe(false);
    await plain.prepare();
    expect(plain.line.permitsComputer(plain.attemptId)).toBe(false);
    expect(await plain.say("computer", "Click Save", "turn-1")).toMatchObject({
      computerAllowed: false,
      message:
        "Computer control is not enabled for this walkthrough. No action was sent.",
    });
    expect(plain.port.submit).not.toHaveBeenCalled();

    const f = callFixture();
    expect(f.grant.inputAllowed).toBe(true);
    expect(f.line.permitsComputer(f.attemptId)).toBe(false);
    // A bound caller alone is not enough: the media must be prepared too.
    f.line.bindCaller(f.attemptId, "paired-caller");
    expect(f.line.permitsComputer(f.attemptId)).toBe(false);
    expect(await f.prepare()).toMatchObject({ computerAllowed: true });
    expect(f.line.permitsComputer(f.attemptId)).toBe(true);
    expect(f.line.permitsComputer("another-attempt")).toBe(false);
  });

  it("is never granted to a call about a decision, so a spoken yes there has one place to go", async () => {
    for (const [source, trigger] of [
      [decisionSource, "decision"],
      [{ ...jobSource, decisionId: "decision" }, "decision"],
      [
        {
          kind: "computer",
          sessionId: "session",
          runId: "run",
          decisionId: "question",
        },
        "decision",
      ],
    ] as const) {
      const f = callFixture({ source, trigger });
      expect(f.grant.inputAllowed, source.kind).toBe(false);
      await f.prepare();
      expect(f.line.permitsComputer(f.attemptId), source.kind).toBe(false);
      expect(
        await f.say("computer", "Click Save", "turn-1"),
        source.kind,
      ).toMatchObject({ computerAllowed: false });
      expect(f.port.submit).not.toHaveBeenCalled();
    }
  });

  it("ends with revoked consent, the grant's expiry and a hidden screen", async () => {
    const revoked = callFixture();
    await revoked.prepare();
    revoked.authority.revoke("policy");
    expect(revoked.line.permitsComputer(revoked.attemptId)).toBe(false);

    const expired = callFixture();
    await expired.prepare();
    expired.advance(61000);
    expect(expired.line.permitsComputer(expired.attemptId)).toBe(false);

    const hidden = callFixture();
    await hidden.prepare();
    expect(await hidden.command("stop_sharing")).toMatchObject({
      sharingAllowed: false,
      computerAllowed: false,
    });
    expect(hidden.port.close).toHaveBeenCalledOnce();
    expect(await hidden.say("computer", "Click Save", "turn-1")).toMatchObject({
      message:
        "Computer control is not enabled for this walkthrough. No action was sent.",
    });
    expect(hidden.port.submit).not.toHaveBeenCalled();
  });

  it("forwards the caller's exact words once per speech turn, and bounds their length", async () => {
    const f = callFixture();
    await f.prepare();
    const words = "Open the fixture page and click Save.";
    await Promise.all([
      f.say("computer", words, "turn-1"),
      f.say("computer", words, "turn-1"),
    ]);
    expect(f.port.submit).toHaveBeenCalledOnce();
    expect(f.port.submit.mock.calls[0]![1]).toBe(words);
    expect(f.port.submit.mock.calls[0]![2]).toBe("turn-1");
    await expect(f.say("answer", words, "turn-1")).rejects.toThrow("conflicts");
    expect(await f.say("computer", "x".repeat(2001), "turn-2")).toMatchObject({
      message: "Please give a shorter computer request. No action was sent.",
    });
    expect(f.port.submit).toHaveBeenCalledOnce();
    await expect(
      f.command("computer", {
        text: words,
        turnId: "turn-3",
        callerIdentity: "someone-else",
      }),
    ).rejects.toThrow("caller");
  });

  it("Stop stops only the call's computer work and leaves sharing on; hiding sharing also stops it", async () => {
    const f = callFixture();
    await f.prepare();
    expect(await f.command("stop_computer")).toMatchObject({
      message: "Stop requested for this call's computer work.",
      sharingAllowed: true,
      computerAllowed: true,
    });
    expect(f.port.stop).toHaveBeenCalledOnce();
    expect(f.port.close).not.toHaveBeenCalled();
    expect(f.stopSharing).not.toHaveBeenCalled();
    await f.command("stop_sharing");
    expect(f.port.close).toHaveBeenCalledOnce();
    expect(f.stopSharing).toHaveBeenCalledOnce();
  });

  it("renews the computer lease with each status heartbeat while control lasts", async () => {
    const f = callFixture();
    await f.prepare();
    await f.command("status");
    expect(f.port.renew).toHaveBeenCalledOnce();
    f.authority.revoke("policy");
    await expect(f.command("status")).rejects.toThrow("authority ended");
    expect(f.port.close).toHaveBeenCalled();
  });
});

const running = (requestId: string): DesktopExecutionSnapshot => ({
  configured: true,
  mode: "native",
  state: "running",
  canStop: true,
  requestId,
  message: "Working on it.",
});
const idle = (): DesktopExecutionSnapshot => ({
  configured: true,
  mode: "native",
  state: "idle",
  canStop: false,
  message: "Ready.",
});

/** The port over a real phone adapter and a scripted native worker. */
function portFixture(options: { owns?: () => boolean } = {}) {
  let current = idle();
  const authorities: (DesktopExecutionAuthority | undefined)[] = [];
  const runtime = {
    snapshot: vi.fn(() => ({ ...current })),
    submit: vi.fn(
      async (
        id: string,
        _text: string,
        authority?: DesktopExecutionAuthority,
      ) => {
        authorities.push(authority);
        current = running(id);
        return { message: "" };
      },
    ),
    stop: vi.fn(() => {
      current = { ...current, state: "stopping", canStop: false };
      return { ...current };
    }),
    answer: vi.fn(async (_text: string) => ({
      message: "Thank you. I go on.",
    })),
  };
  const phone = new PhoneDesktop(runtime);
  adapters.push(phone);
  const port = walkthroughComputer({
    phone,
    owns: options.owns ?? (() => true),
    waitMs: 50,
    pollMs: 1,
  });
  const intent = { id: "intent", attemptId: "attempt" } as ProactiveCallIntent;
  return {
    runtime,
    phone,
    port,
    intent,
    authorities,
    set: (value: DesktopExecutionSnapshot) => (current = value),
    get: () => current,
  };
}

describe("the walkthrough's computer port", () => {
  it("sends nothing when the call no longer owns the shared display", async () => {
    const f = portFixture({ owns: () => false });
    expect(await f.port.submit(f.intent, "Click Save", "turn-1")).toBe(
      "This call no longer owns the shared display. No action was sent.",
    );
    expect(f.runtime.submit).not.toHaveBeenCalled();
    expect(f.phone.hasOpenCall()).toBe(false);
  });

  it("runs the exact words under the call's own lease and reports the observed end", async () => {
    const f = portFixture();
    f.runtime.submit.mockImplementationOnce(async (id, _text, authority) => {
      f.authorities.push(authority);
      f.set(running(id));
      setTimeout(
        () =>
          f.set({
            ...f.get(),
            state: "completed",
            canStop: false,
            message: "The page shows Saved.",
          }),
        5,
      );
      return { message: "" };
    });
    expect(await f.port.submit(f.intent, "Click Save", "turn-1")).toBe(
      "The page shows Saved.",
    );
    expect(f.runtime.submit).toHaveBeenCalledOnce();
    expect(f.runtime.submit.mock.calls[0]![1]).toBe("Click Save");
    expect(f.authorities[0]).toMatchObject({ callId: "attempt" });
    expect(f.authorities[0]!.isLive()).toBe(true);
  });

  it("says that a long request is still running, without sending it again", async () => {
    const f = portFixture();
    expect(
      await f.port.submit(f.intent, "Search the fixture shop", "turn-1"),
    ).toBe("Working on it.");
    expect(f.runtime.submit).toHaveBeenCalledOnce();
  });

  it("returns the worker's question, and Stop and close stop only the call's own work", async () => {
    const f = portFixture();
    f.runtime.submit.mockImplementationOnce(async (id) => {
      f.set({
        ...running(id),
        state: "waiting_for_person",
        waiting: "approval",
        message: "Send the note to Riverchat? Say yes or no.",
      });
      return { message: "" };
    });
    expect(await f.port.submit(f.intent, "Send the note", "turn-1")).toBe(
      "Send the note to Riverchat? Say yes or no.",
    );
    expect(f.port.stop(f.intent)).toBe(
      "Stop requested for this call's computer work. Coding jobs may continue.",
    );
    expect(f.runtime.stop).toHaveBeenCalledOnce();
    // Local work that started later is not this call's work.
    f.set(running("local-later"));
    f.port.close(f.intent);
    expect(f.runtime.stop).toHaveBeenCalledOnce();
    expect(f.phone.hasOpenCall()).toBe(false);
  });

  it("a Stop after the call's computer lease ended says that nothing runs, and does not fail", async () => {
    const f = portFixture();
    await f.port.submit(f.intent, "Search the fixture shop", "turn-1");
    f.port.close(f.intent);
    expect(f.runtime.stop).toHaveBeenCalledOnce();
    expect(f.port.stop(f.intent)).toBe(
      "No computer work owned by this call is running. Coding jobs may continue.",
    );
    expect(f.runtime.stop).toHaveBeenCalledOnce();
  });

  it("a stop of a call that never used the computer touches no work", () => {
    const f = portFixture();
    f.set(running("local"));
    expect(f.port.stop(f.intent)).toBe(
      "No computer work is owned by this call.",
    );
    f.port.close(f.intent);
    f.port.renew(f.intent);
    expect(f.runtime.stop).not.toHaveBeenCalled();
  });
});

describe("a spoken yes in a walkthrough call", () => {
  const ask = (f: ReturnType<typeof portFixture>, message: string) =>
    f.set({
      ...f.get(),
      state: "waiting_for_person",
      canStop: true,
      waiting: "approval",
      message,
    });
  const first = "Send the note to Riverchat? Say yes or no.";
  const second = "Delete the draft in Stonepad? Say yes or no.";
  const unheard = (question: string) =>
    `This question came after your last words, so they did not answer it: ${question}`;

  it("answers the question that this call told the caller", async () => {
    const f = portFixture();
    f.runtime.submit.mockImplementationOnce(async (id) => {
      f.set(running(id));
      ask(f, first);
      return { message: "" };
    });
    expect(await f.port.submit(f.intent, "Send the note", "turn-1")).toBe(
      first,
    );
    f.runtime.answer.mockImplementationOnce(async () => {
      f.set({ ...f.get(), state: "running", waiting: undefined });
      return { message: "Thank you. I go on." };
    });
    expect(await f.port.submit(f.intent, "yes", "turn-2")).toBe(
      "Thank you. I go on.",
    );
    expect(f.runtime.answer).toHaveBeenCalledOnce();
    expect(f.runtime.answer).toHaveBeenCalledWith("yes");
  });

  it("does not answer a newer question that the caller has not heard: it tells it first", async () => {
    const f = portFixture();
    f.runtime.submit.mockImplementationOnce(async (id) => {
      f.set(running(id));
      ask(f, first);
      return { message: "" };
    });
    expect(await f.port.submit(f.intent, "Send the note", "turn-1")).toBe(
      first,
    );
    // The task moved on to another question before the caller spoke again.
    ask(f, second);
    expect(await f.port.submit(f.intent, "yes", "turn-2")).toBe(
      unheard(second),
    );
    expect(f.runtime.answer).not.toHaveBeenCalled();
    // Now the caller heard it: their next yes answers it.
    expect(await f.port.submit(f.intent, "yes", "turn-3")).toBe(
      "Thank you. I go on.",
    );
    expect(f.runtime.answer).toHaveBeenCalledOnce();
  });

  it("does not answer a question that came after a request was still running", async () => {
    const f = portFixture();
    expect(await f.port.submit(f.intent, "Send the note", "turn-1")).toBe(
      "Working on it.",
    );
    ask(f, first);
    expect(await f.port.submit(f.intent, "ok", "turn-2")).toBe(unheard(first));
    expect(f.runtime.answer).not.toHaveBeenCalled();
    expect(f.runtime.submit).toHaveBeenCalledOnce();
  });

  it("keeps a told question answerable after words that did not answer it", async () => {
    const f = portFixture();
    f.runtime.submit.mockImplementationOnce(async (id) => {
      f.set(running(id));
      ask(f, first);
      return { message: "" };
    });
    await f.port.submit(f.intent, "Send the note", "turn-1");
    f.runtime.answer.mockImplementationOnce(async () => ({
      message: `Please say yes or no. ${first}`,
    }));
    expect(await f.port.submit(f.intent, "hmm", "turn-2")).toBe(
      `Please say yes or no. ${first}`,
    );
    expect(await f.port.submit(f.intent, "yes", "turn-3")).toBe(
      "Thank you. I go on.",
    );
    expect(f.runtime.answer).toHaveBeenCalledTimes(2);
  });

  it("asks again before a yes for the same words once the first question was answered", async () => {
    const f = portFixture();
    f.runtime.submit.mockImplementationOnce(async (id) => {
      f.set(running(id));
      ask(f, first);
      return { message: "" };
    });
    await f.port.submit(f.intent, "Send the note", "turn-1");
    f.runtime.answer.mockImplementationOnce(async () => {
      f.set({ ...f.get(), state: "running", waiting: undefined });
      return { message: "Thank you. I go on." };
    });
    await f.port.submit(f.intent, "yes", "turn-2");
    // The task asks the same words again for a second send.
    ask(f, first);
    expect(await f.port.submit(f.intent, "yes", "turn-3")).toBe(unheard(first));
    expect(f.runtime.answer).toHaveBeenCalledOnce();
  });
});

describe("the screen guard of the native worker", () => {
  const intent = (
    state: ProactiveCallIntent["state"],
    kind: "job" | "computer" = "job",
    channel: "phone_walkthrough" | "phone_alert" = "phone_walkthrough",
  ) =>
    ({
      id: `intent-${state}`,
      attemptId: "attempt",
      state,
      channel,
      source: { kind },
    }) as unknown as ProactiveCallIntent;
  const authority = (callId: string): DesktopExecutionAuthority => ({
    callId,
    toolCallId: "turn",
    isLive: () => true,
  });
  function guard(options: {
    owns?: boolean;
    permits?: boolean;
    occupied?: boolean;
    intents?: ProactiveCallIntent[];
  }) {
    return walkthroughScreenGuard({
      phone: { ownsExecution: () => options.owns ?? false },
      permitsComputer: (id) => (options.permits ?? false) && id === "attempt",
      viewOccupied: () => options.occupied ?? false,
      intents: () => options.intents ?? [],
      voiceOnly: (i) =>
        i.source.kind === "computer" && i.channel === "phone_alert",
    });
  }

  it("lets local work use the screen only while no call shares it", () => {
    expect(guard({})()).toBe(true);
    expect(guard({ occupied: true })()).toBe(false);
    for (const state of ["dispatching", "connected", "unknown"] as const)
      expect(guard({ intents: [intent(state)] })()).toBe(false);
    expect(guard({ intents: [intent("ended")] })()).toBe(true);
    // A call of the reach only talks: the worker keeps the screen.
    expect(
      guard({ intents: [intent("connected", "computer", "phone_alert")] })(),
    ).toBe(true);
  });

  it("lets a walkthrough use the shared screen only through its own reserved request", () => {
    const busy = { occupied: true, intents: [intent("connected")] };
    expect(
      guard({ ...busy, owns: true, permits: true })(authority("attempt")),
    ).toBe(true);
    // Another call, a call without control, or a request it did not reserve.
    expect(
      guard({ ...busy, owns: true, permits: true })(authority("other")),
    ).toBe(false);
    expect(
      guard({ ...busy, owns: true, permits: false })(authority("attempt")),
    ).toBe(false);
    expect(
      guard({ ...busy, owns: false, permits: true })(authority("attempt")),
    ).toBe(false);
    expect(guard({ ...busy, owns: true, permits: true })()).toBe(false);
  });
});
