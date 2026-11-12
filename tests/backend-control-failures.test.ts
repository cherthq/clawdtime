import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { HumanRouter, isImmediateStop } from "../src/control/human-router.js";
import {
  ControlPreflightError,
  sanitizeControlPreflightDiagnostics,
  type ControlPreflightDiagnostics,
  type ControlPreflightCode,
} from "../src/control/errors.js";
import { Viewing } from "../src/control/viewing.js";
import type { ActionReceipt, ControlLease } from "../src/contracts.js";
import type { ConversationTurn } from "../src/control/conversation.js";
import { ScriptedConversationAgent } from "./backend-conversation-fixture.js";
async function fixture(
  script?: (turn: ConversationTurn) => Promise<{ reply: string }>,
  allowControl = true,
) {
  const store = new Store(),
    service = new ClawdTime(store, new SimulationTransport()),
    device = new SimulatedDevice(),
    control = new ControlCoordinator(store, device),
    viewing = new Viewing(store, device);
  const conversation = new ScriptedConversationAgent(device, script);
  const human = new HumanRouter(service, control, conversation);
  const binding = {
    memberId: "member",
    recipient: "+15550000001",
    conversationId: "iMessage;-;+15550000001",
    lineId: "line",
    deviceId: "mac",
    displayId: "1",
  };
  const invite = service.createPairingInvite(binding),
    paired = service.claimPairing({
      token: invite.token,
      deviceId: "mac",
      displayId: "1",
      allowView: true,
      allowControl,
    });
  const agent = service.registerSession(paired.token, {
    adapter: "codex",
    adapterVersion: "fixture",
    projectRoot: "/fixture",
    externalSessionId: "one",
    hostId: "host.local",
    capabilities: { cooperativePause: true, polling: true },
  });
  service.yieldSession(agent.token);
  const request = service.requestAttention(agent.token, {
    taskId: "task",
    idempotencyKey: "one",
    reason: "decision",
    question: "What should the title be?",
  });
  await service.drain();
  service.observeCall(request.id, "connected", true);
  const input = (eventId: string, text: string) => ({
    eventId,
    text,
    requestId: request.id,
    memberId: binding.memberId,
    lineId: binding.lineId,
    conversationId: binding.conversationId,
    channel: "text" as const,
  });
  const send = (eventId: string, text: string) =>
    human.receive(input(eventId, text));
  const command = (id: string) => store.state<any>(`human-command:${id}`);
  return {
    store,
    service,
    device,
    control,
    human,
    viewing,
    conversation,
    agent,
    request,
    binding,
    send,
    command,
    input,
  };
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const click = async (t: ConversationTurn) => {
  const view = await t.tools.observe();
  await t.tools.act(view.frame.id, { kind: "click", x: 0.5, y: 0.5 });
  return { reply: "The button now appears selected." };
};
const focus = `focus-unverified:${createHash("sha256")
  .update(JSON.stringify(["mac", "1"]))
  .digest("hex")}`;

describe("one conversational agent with bounded screen tools", () => {
  it.each([false, true])(
    "passes actual pairing control permission %s to the conversational model",
    async (allowControl) => {
      const seen: ConversationTurn[] = [];
      const f = await fixture(async (turn) => {
        seen.push(turn);
        return { reply: "I can explain the current call permissions." };
      }, allowControl);
      try {
        await f.send("capability_fixture", "Click the title and type Hello.");
        expect(seen).toHaveLength(1);
        expect(seen[0]!.capabilities).toEqual({ control: allowControl });
        expect(f.store.all("action")).toHaveLength(0);
      } finally {
        f.store.close();
      }
    },
  );
  it("executes compound natural request with one continuous lease and fresh observation between each action", async () => {
    const f = await fixture(async (t) => {
      expect(t.text).toBe(
        "Click the title field and type Hello, then scroll down a little.",
      );
      let view = await t.tools.observe();
      view = await t.tools.act(view.frame.id, {
        kind: "click",
        x: 0.5,
        y: 0.4,
      });
      view = await t.tools.act(view.frame.id, { kind: "type", text: "Hello" });
      await t.tools.act(view.frame.id, {
        kind: "scroll",
        x: 0.5,
        y: 0.5,
        deltaY: 100,
      });
      return {
        reply: "The title now reads Hello, and the next section is visible.",
      };
    });
    await f.viewing.tick();
    const before = f.store.all<ControlLease>("lease")[0]!;
    const result = await f.send(
      "compound",
      "Click the title field and type Hello, then scroll down a little.",
    );
    expect(result.accepted).toBe(true);
    expect(f.device.inputs).toHaveLength(3);
    expect(f.store.all<ControlLease>("lease")).toHaveLength(1);
    expect(f.store.get<ControlLease>("lease", before.id)?.state).toBe("active");
    expect(
      f.store.all<ActionReceipt>("action").every((a) => a.state === "observed"),
    ).toBe(true);
    expect(
      JSON.stringify(f.store.query("SELECT body FROM operational_state")),
    ).not.toContain("Hello");
    await f.send(
      "compound",
      "Click the title field and type Hello, then scroll down a little.",
    );
    expect(f.device.inputs).toHaveLength(3);
    f.store.close();
  });
  it("provides a changed screen to the same agent without input or stale-plan rebinding", async () => {
    let first = true;
    const f = await fixture(async (t) => {
      const initial = await t.tools.observe();
      const changed = await t.tools.act(initial.frame.id, {
        kind: "click",
        x: 0.2,
        y: 0.3,
      });
      expect(changed.changed).toBe(true);
      expect(changed.receipt).toBeUndefined();
      expect(f.device.inputs).toHaveLength(0);
      await t.tools.act(changed.frame.id, { kind: "click", x: 0.7, y: 0.6 });
      return {
        reply: "I used the updated screen and observed the new selection.",
      };
    });
    const observe = f.conversation.observe.bind(f.conversation);
    f.conversation.observe = async (l) => ({
      ...(await observe(l)),
      dataUrl: first
        ? ((first = false), "data:image/jpeg;base64,AQ==")
        : "data:image/jpeg;base64,Ag==",
    });
    await f.send("changed", "Select the visible result.");
    expect(f.device.inputs).toHaveLength(1);
    f.store.close();
  });
  it("clarifies conversationally without returning coding control or interrupting viewing", async () => {
    const f = await fixture(async (t) => ({
      reply: t.history.length
        ? "The left field you mentioned?"
        : "Which of the two title fields do you mean?",
    }));
    await f.viewing.tick();
    const leases = f.store.all("lease");
    expect((await f.send("q1", "Change the title.")).reply).toContain("Which");
    expect((await f.send("q2", "The left one.")).reply).toContain("left");
    expect(f.store.all("lease")).toEqual(leases);
    expect(f.store.all("response")).toHaveLength(0);
    f.store.close();
  });
  it("commits original authenticated feedback, structured visibility and confirmed release", async () => {
    const f = await fixture(async (t) => {
      await t.tools.feedback({ screenVisible: true });
      return { reply: "I passed your answer to the coding agent." };
    });
    await f.viewing.tick();
    const result = await f.send(
      "answer",
      "I can see it. Use Hello for the title, and continue.",
    );
    expect(result.response?.text).toBe(
      "I can see it. Use Hello for the title, and continue.",
    );
    expect(f.store.state(`screen-feedback:${f.request.id}`)).toMatchObject({
      eventId: "answer",
      requestId: f.request.id,
      sessionId: f.request.sessionId,
      pairingId: f.request.pairingId,
      visible: true,
    });
    expect(
      f.store.all<ControlLease>("lease").every((l) => l.state === "released"),
    ).toBe(true);
    f.store.close();
  });
  it("does not invent a visibility attestation for ordinary feedback", async () => {
    const f = await fixture(async (t) => {
      await t.tools.feedback({});
      return { reply: "Passed on." };
    });
    await f.send("answer", "Use the left version.");
    expect(f.store.state(`screen-feedback:${f.request.id}`)).toBeUndefined();
    f.store.close();
  });
  it("authenticates exact sender and qualified voice before invoking the model", async () => {
    let calls = 0;
    const f = await fixture(async () => {
      calls++;
      return { reply: "Hello" };
    });
    await expect(
      f.human.receive({ ...f.input("bad", "hello"), memberId: "other" }),
    ).rejects.toThrow("binding");
    await expect(
      f.human.receive({
        ...f.input("voice", "hello"),
        channel: "voice",
        callId: f.request.callId,
        qualifiedRemoteAudio: false,
      }),
    ).rejects.toThrow("Unqualified");
    expect(calls).toBe(0);
    f.store.close();
  });
  it("fails closed without a model while literal Stop remains available", async () => {
    const f = await fixture();
    const h = new HumanRouter(f.service, f.control);
    expect(
      (await h.receive(f.input("no-model", "Click the title."))).code,
    ).toBe("planner_unavailable");
    await f.viewing.tick();
    expect((await h.receive(f.input("stop", "Stop"))).stopped).toBe(true);
    expect(f.device.inputs).toHaveLength(0);
    expect(f.device.leases.size).toBe(0);
    f.store.close();
  });
  it.each([
    "planning_refused",
    "planner_unavailable",
    "planning_timeout",
    "frame_unavailable",
    "screen_changed",
    "invalid_plan",
    "context_expired",
  ] as ControlPreflightCode[])(
    "retains continuous viewing after proven %s, without re-running a duplicate",
    async (code) => {
      let runs = 0;
      const f = await fixture(async (t) => {
        runs++;
        await t.tools.observe();
        throw new ControlPreflightError(code);
      });
      await f.viewing.tick();
      expect((await f.send("fail", "Focus the title.")).state).toBe(
        "not_started",
      );
      expect(f.store.all<ControlLease>("lease")[0]?.state).toBe("active");
      expect(f.device.inputs).toHaveLength(0);
      await f.send("fail", "Focus the title.");
      expect(runs).toBe(1);
      await expect(f.send("fail", "Different content.")).rejects.toThrow(
        "changed",
      );
      f.store.close();
    },
  );
  it("blocks typing after failed planning until an observed explicit click", async () => {
    const f = await fixture(async (t) => {
      if (t.text === "Focus it.")
        throw new ControlPreflightError("planning_refused");
      const v = await t.tools.observe();
      await t.tools.act(
        v.frame.id,
        t.text === "Click the title."
          ? { kind: "click", x: 0.5, y: 0.5 }
          : { kind: "type", text: "Hello" },
      );
      return { reply: "I observed the result." };
    });
    await f.viewing.tick();
    await f.send("failed", "Focus it.");
    expect((await f.send("type1", "Type Hello.")).state).toBe("not_started");
    expect(f.device.inputs).toHaveLength(0);
    await f.send("click", "Click the title.");
    expect(f.store.state(focus)).toBe(false);
    await f.send("type2", "Type Hello.");
    expect(f.device.inputs).toHaveLength(2);
    f.store.close();
  });
  it("unknown dispatch permanently blocks further tools even when the agent catches the error", async () => {
    const f = await fixture(async (t) => {
      const v = await t.tools.observe();
      await t.tools
        .act(v.frame.id, { kind: "click", x: 0.5, y: 0.5 })
        .catch(() => {});
      await t.tools
        .act(v.frame.id, { kind: "click", x: 0.2, y: 0.3 })
        .catch(() => {});
      return { reply: "untrusted success" };
    });
    f.device.action = async (_l, _f, _a, id) => {
      f.device.inputs.push(id);
      throw new ControlPreflightError("screen_changed");
    };
    expect((await f.send("unknown", "Click twice.")).state).toBe("unknown");
    expect(f.device.inputs).toHaveLength(1);
    expect(f.store.all<ActionReceipt>("action")[0]?.state).toBe("unknown");
    await f.send("unknown", "Click twice.");
    expect(f.device.inputs).toHaveLength(1);
    f.store.close();
  });
  it("submitted without a post-input frame remains uncertain", async () => {
    const f = await fixture(click),
      frame = f.device.frame.bind(f.device);
    let frames = 0;
    f.device.frame = async (l) => {
      if (++frames === 3) throw new Error("PRIVATE_FRAME");
      return frame(l);
    };
    expect((await f.send("submitted", "Click the field.")).state).toBe(
      "unknown",
    );
    expect(f.store.all<ActionReceipt>("action")[0]?.state).toBe("submitted");
    await expect(
      f.control.acquire(f.request.id, f.binding.memberId),
    ).rejects.toThrow("reconciled");
    f.store.close();
  });
  it("refuses feedback until every release is confirmed", async () => {
    const f = await fixture(async (t) => {
      await t.tools.feedback({});
      return { reply: "Done" };
    });
    await f.viewing.tick();
    f.device.release = async () => {
      throw new Error("PRIVATE_RELEASE");
    };
    expect((await f.send("feedback", "Continue.")).state).toBe("unknown");
    expect(f.store.all("response")).toHaveLength(0);
    f.store.close();
  });
  it("Stop interrupts an in-flight model turn and prevents its later input", async () => {
    const began = barrier(),
      finish = barrier();
    const f = await fixture(async (t) => {
      const v = await t.tools.observe();
      began.resolve();
      await finish.promise;
      await t.tools.act(v.frame.id, { kind: "click", x: 0.5, y: 0.5 });
      return { reply: "Done" };
    });
    await f.viewing.tick();
    const pending = f.send("pending", "Click the title.");
    await began.promise;
    await f.send("stop", "Stop");
    finish.resolve();
    expect((await pending).code).toBe("stopped");
    expect(f.device.inputs).toHaveLength(0);
    expect(f.device.leases.size).toBe(0);
    await f.viewing.tick();
    expect(f.device.leases.size).toBe(0);
    f.store.close();
  });
  it("late callbacks cannot act or return feedback after a completed turn", async () => {
    let captured!: ConversationTurn;
    const f = await fixture(async (t) => {
      captured = t;
      await t.tools.observe();
      return { reply: "Which field?" };
    });
    await f.viewing.tick();
    await f.send("done", "Change the title.");
    await expect(captured.tools.observe()).rejects.toMatchObject({
      code: "stopped",
    });
    await expect(captured.tools.feedback({})).rejects.toMatchObject({
      code: "stopped",
    });
    expect(f.device.inputs).toHaveLength(0);
    expect(f.store.all("response")).toHaveLength(0);
    f.store.close();
  });
  it("parallel tool rejection latches the entire turn", async () => {
    const began = barrier(),
      finish = barrier();
    const f = await fixture(async (t) => {
      const first = t.tools.observe();
      await began.promise;
      await t.tools.observe().catch(() => {});
      finish.resolve();
      await first.catch(() => {});
      await t.tools.feedback({}).catch(() => {});
      return { reply: "Untrusted success" };
    });
    const original = f.conversation.observe.bind(f.conversation);
    f.conversation.observe = async (l) => {
      began.resolve();
      await finish.promise;
      return original(l);
    };
    expect((await f.send("parallel", "Change it.")).code).toBe("invalid_plan");
    expect(f.device.inputs).toHaveLength(0);
    expect(f.store.all("response")).toHaveLength(0);
    f.store.close();
  });
  it("maintains viewing while a model turn awaits, without blocking Stop", async () => {
    vi.useFakeTimers();
    const began = barrier(),
      finish = barrier();
    const f = await fixture(async () => {
      began.resolve();
      await finish.promise;
      return { reply: "Which field?" };
    });
    const ticks = vi.fn(async () => {});
    const h = new HumanRouter(f.service, f.control, f.conversation, ticks);
    const pending = h.receive(f.input("wait", "Change the title."));
    await began.promise;
    await vi.advanceTimersByTimeAsync(2100);
    expect(ticks).toHaveBeenCalledTimes(3);
    finish.resolve();
    await pending;
    await vi.advanceTimersByTimeAsync(2000);
    expect(ticks).toHaveBeenCalledTimes(3);
    f.store.close();
    vi.useRealTimers();
  });
  it("sanitizes pre-input diagnostics without persisting model text or arbitrary fields", async () => {
    const dirty = {
      phase: "planning",
      elapsedMs: 100,
      frameAgeMs: 10,
      private: "PRIVATE",
      comparison: {
        kind: "pixels_changed",
        changedPixels: 2,
        changedTiles: [1],
        raw: "PRIVATE",
      },
    };
    const f = await fixture(async () => {
      throw new ControlPreflightError(
        "screen_changed",
        dirty as ControlPreflightDiagnostics,
      );
    });
    await f.send("diagnostics", "PRIVATE_USER_PROMPT");
    const saved = f.store.state<any>(`control-preflight:${f.request.id}`);
    expect(saved.diagnostics.comparison.changedPixels).toBe(2);
    expect(
      JSON.stringify(f.store.query("SELECT body FROM operational_state")),
    ).not.toContain("PRIVATE");
    f.store.close();
  });
  it.each([
    { phase: "other" },
    { elapsedMs: -1 },
    { elapsedMs: 60_001 },
    { elapsedMs: Infinity },
    { frameAgeMs: -501 },
    { frameAgeMs: 60_001 },
    { frameAgeMs: NaN },
    { comparison: { kind: "raw_error" } },
    { comparison: { kind: "pixels_changed", changedPixels: 921601 } },
    { comparison: { kind: "pixels_changed", changedPixels: -1 } },
    { comparison: { kind: "pixels_changed", changedPixels: 1.5 } },
    { comparison: { kind: "pixels_changed", changedTiles: [12] } },
    { comparison: { kind: "pixels_changed", changedTiles: [-1] } },
    { comparison: { kind: "pixels_changed", changedTiles: [1, 1] } },
    { comparison: { kind: "pixels_changed", changedTiles: Array(13).fill(1) } },
    { comparison: { kind: "geometry_changed", width: 1281, height: 720 } },
    { comparison: { kind: "geometry_changed", width: 1280, height: 721 } },
    { comparison: { kind: "geometry_changed", width: 0, height: 720 } },
    {
      comparison: {
        kind: "pixels_changed",
        width: 10,
        height: 10,
        changedPixels: 101,
      },
    },
  ])(
    "drops invalid diagnostic fields %# without exposing their contents",
    (invalid) => {
      const error = new ControlPreflightError("screen_changed", {
        phase: "settling",
        elapsedMs: 0,
        frameAgeMs: 0,
        ...invalid,
      } as ControlPreflightDiagnostics);
      expect(error.diagnostics).toBeUndefined();
      expect(error.code).toBe("screen_changed");
      expect(error.message).toBe("The screen changed while planning.");
    },
  );

  it("keeps fixed metadata bounds and safely discards throwing getters", () => {
    expect(
      sanitizeControlPreflightDiagnostics({
        phase: "settling",
        elapsedMs: 60_000,
        frameAgeMs: -500,
        comparison: {
          kind: "pixels_changed",
          width: 1280,
          height: 720,
          changedPixels: 921600,
          changedTiles: Array.from({ length: 12 }, (_, i) => i),
        },
      }),
    ).toBeDefined();
    expect(
      sanitizeControlPreflightDiagnostics({
        get phase() {
          throw new Error("PRIVATE_GETTER");
        },
      }),
    ).toBeUndefined();
  });
});

describe("conversation lifecycle edges", () => {
  it("retains an explicit visibility report through compound CUA and later continuation", async () => {
    const f = await fixture(async (t) => {
      if (t.text === "I can see the screen.") {
        await t.tools.screenFeedback({ visible: true });
        return { reply: "What would you like to do on it?" };
      }
      if (t.text === "Continue coding.") {
        await t.tools.feedback({});
        return { reply: "Back to your coding agent." };
      }
      return click(t);
    });
    await f.viewing.tick();
    await f.send("visible", "I can see the screen.");
    const evidence = f.store.state(`screen-feedback:${f.request.id}`);
    expect(f.store.all("response")).toHaveLength(0);
    expect(f.device.leases.size).toBe(1);
    await f.send("click", "Click the title.");
    const result = await f.send("continue", "Continue coding.");
    expect(result.response?.text).toBe("Continue coding.");
    expect(f.store.state(`screen-feedback:${f.request.id}`)).toEqual(evidence);
    expect(f.device.leases.size).toBe(0);
    f.store.close();
  });
  it("a later explicit invisible report replaces earlier visible evidence without ending the conversation", async () => {
    const f = await fixture(async (t) => {
      await t.tools.screenFeedback({ visible: t.text === "I see it." });
      return { reply: "Let's look at that." };
    });
    await f.send("yes", "I see it.");
    await f.send("no", "Now I cannot see it.");
    expect(f.store.state<any>(`screen-feedback:${f.request.id}`).visible).toBe(
      false,
    );
    expect(f.store.all("response")).toHaveLength(0);
    f.store.close();
  });
  it("view-only consent permits existing screen observations but never input", async () => {
    const f = await fixture(async (t) => {
      const v = await t.tools.observe();
      expect(v.frame.id).toBeTruthy();
      if (t.text === "Click the title.")
        await t.tools.act(v.frame.id, { kind: "click", x: 0.5, y: 0.5 });
      return { reply: "The title field is visible." };
    });
    f.store.put("pairing", {
      ...f.service.pairing(f.request.pairingId),
      allowControl: false,
    });
    await f.viewing.tick();
    expect((await f.send("view", "What can you see?")).accepted).toBe(true);
    expect((await f.send("click", "Click the title.")).code).toBe(
      "planning_refused",
    );
    expect(f.device.inputs).toHaveLength(0);
    expect(f.store.all<ControlLease>("lease")[0]?.mode).toBe("view");
    expect(f.device.leases.size).toBe(1);
    f.store.close();
  });
  it("busy turns are durable no-input events rather than deferred commands", async () => {
    const began = barrier(),
      finish = barrier();
    let runs = 0;
    const f = await fixture(async () => {
      runs++;
      began.resolve();
      await finish.promise;
      return { reply: "Which title?" };
    });
    const first = f.send("first", "Change it.");
    await began.promise;
    expect((await f.send("busy", "Click it.")).state).toBe("busy");
    finish.resolve();
    await first;
    expect((await f.send("busy", "Click it.")).state).toBe("busy");
    expect(runs).toBe(1);
    f.store.close();
  });
  it("replay of an ordinary reply never claims feedback was delivered", async () => {
    const f = await fixture(async () => ({ reply: "Which title?" }));
    await f.send("reply", "Change it.");
    const repeated = await f.send("reply", "Change it.");
    expect(repeated.reply).not.toContain("waiting coding agent");
    expect(f.store.all("response")).toHaveLength(0);
    f.store.close();
  });
  it("ignoring an aborted model cannot supersede Stop with a success reply", async () => {
    const began = barrier(),
      finish = barrier();
    const f = await fixture(async () => {
      began.resolve();
      await finish.promise;
      return { reply: "Everything succeeded!" };
    });
    const pending = f.send("first", "Change the title.");
    await began.promise;
    await f.send("stop", "Stop");
    finish.resolve();
    const result = await pending;
    expect(result.accepted).toBe(false);
    expect(result.reply).not.toContain("succeeded");
    f.store.close();
  });
  it("enforces the input budget even when the agent asks for a fifth action", async () => {
    const f = await fixture(async (t) => {
      let v = await t.tools.observe();
      for (let i = 0; i < 5; i++)
        v = await t.tools.act(v.frame.id, { kind: "click", x: 0.5, y: 0.5 });
      return { reply: "Done" };
    });
    expect((await f.send("budget", "Select the five fields.")).state).toBe(
      "partial",
    );
    expect(f.device.inputs).toHaveLength(4);
    f.store.close();
  });
});

describe("screen report evidence timing", () => {
  it("uses authenticated utterance admission time, never later model execution time", async () => {
    vi.useFakeTimers();
    const admitted = Date.now();
    const f = await fixture(async (t) => {
      await vi.advanceTimersByTimeAsync(1000);
      f.store.saveState(`setup-view:${f.request.id}`, {
        observedAt: Date.now(),
      });
      await t.tools.screenFeedback({ visible: true });
      return { reply: "What next?" };
    });
    await f.send("early", "I see it.");
    expect(
      f.store.state<any>(`screen-feedback:${f.request.id}`).reportedAt,
    ).toBe(admitted);
    expect(
      f.store.state<any>(`screen-feedback:${f.request.id}`).reportedAt,
    ).toBeLessThan(f.store.state<any>(`setup-view:${f.request.id}`).observedAt);
    f.store.close();
    vi.useRealTimers();
  });
});

describe("literal emergency stop without conversational inference", () => {
  it.each([
    "Stop listening",
    "ClawdTime, stop sharing.",
    "Hey ClawdTime stop!",
  ])("interrupts %s without any model", async (text) => {
    const f = await fixture(async () => {
      throw new Error("Model must not interpret emergency Stop");
    });
    await f.viewing.tick();
    expect((await f.send("emergency", text)).stopped).toBe(true);
    expect(f.device.leases.size).toBe(0);
    f.store.close();
  });
});

describe("cross-channel emergency stop grammar", () => {
  it.each([
    "Stop",
    "stop   sharing",
    "STOP\tcontrol!",
    "Hey   ClawdTime, stop  listening.",
    "ClawdTime: stop sharing",
  ])("accepts media priority phrase %s", (text) => {
    expect(isImmediateStop(text)).toBe(true);
  });
  it.each([
    "stop by the shop",
    "don't stop",
    "type stop",
    "please stop and click",
  ])("does not parse ordinary intent %s", (text) => {
    expect(isImmediateStop(text)).toBe(false);
  });
});
