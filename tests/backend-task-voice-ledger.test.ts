import { afterEach, describe, expect, it } from "vitest";
import type {
  CodingTask,
  IndependentTaskSession,
  TaskCommand,
} from "../src/contracts.js";
import { Store } from "../src/storage/store.js";
import { Vault, hash } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskVoiceLedger } from "../src/attention/task-voice-ledger.js";
import { ProtectedTaskStore } from "../src/storage/task-store.js";

import { taskHandsetFingerprint } from "../src/transport/task-audio.js";
import type { TaskWalkthroughPlan } from "../src/task-walkthrough-contracts.js";

const stores: Store[] = [];
afterEach(() => {
  stores.forEach((store) => store.close());
  stores.length = 0;
});

function fixture() {
  const store = new Store();
  stores.push(store);
  const vault = new Vault("ab".repeat(32));
  let now = 1000;
  const clock = () => now;
  const tasks = new TaskLedger(store, vault, clock);
  const voices = new TaskVoiceLedger(store, vault, tasks, clock);
  const session: IndependentTaskSession = {
    id: "session",
    version: 1,
    pairingId: "pair",
    memberId: "member",
    deviceId: "mac",
    hostId: "host",
    projectRoot: "/fixture",
    createdAt: 1000,
    expiresAt: 100000,
    permissions: {
      execute: true,
      voice: true,
      presentation: false,
      control: false,
    },
  };
  let sequence = 0;
  const create = () =>
    tasks.create(session, {
      eventId: `create-${sequence++}`,
      goal: "Add a filter.",
    }).task;
  const change = (task: CodingTask, command: Record<string, unknown>) =>
    tasks.transition(session.id, task.id, {
      eventId: `event-${sequence++}`,
      expectedRevision: task.revision,
      ...command,
    } as TaskCommand).task;
  const claim = (task: CodingTask) =>
    change(task, { action: "claim_run", runId: task.runs.at(-1)!.id });
  const result = (task: CodingTask, outcome = "completed") =>
    change(task, {
      action: "run_result",
      runId: task.runs.at(-1)!.id,
      dispatchId: task.runs.at(-1)!.dispatchId,
      outcome,
      summary: "Fixture changed.",
      decision: "Choose empty state.",
    });
  const verify = (task: CodingTask) =>
    change(task, {
      action: "verify_result",
      verification: {
        id: `verify-${sequence++}`,
        runId: task.runs.at(-1)!.id,
        state: "passed",
        completedAt: now,
        checks: [
          {
            name: "fixture",
            command: ["node", "--test"],
            state: "passed",
            exitCode: 0,
            summary: "Passed.",
          },
        ],
      },
    });
  const ready = () => verify(result(claim(create())));
  const open = (task: CodingTask, eventId = `open-${sequence++}`) =>
    voices.open(session, {
      eventId,
      taskId: task.id,
      runId: task.runs.at(-1)!.id,
      expectedRevision: task.revision,
    });
  const input = (
    task: CodingTask,
    utteranceId = `utterance-${sequence++}`,
  ) => ({
    eventId: `tool-${sequence++}`,
    providerConversationId: "provider-fixture",
    utteranceId,
    taskId: task.id,
    runId: task.runs.at(-1)!.id,
    expectedRevision: task.revision,
    instruction: "Show a Clear filters button.",
  });
  return {
    store,
    vault,
    clock,
    tasks,
    voices,
    session,
    create,
    change,
    claim,
    result,
    verify,
    ready,
    open,
    input,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("task-bound voice ledger", () => {
  it("binds an internal handset smoke session without coding authority or replay upgrades", () => {
    const f = fixture();
    const task = f.ready();
    const input = {
      eventId: "handset-open",
      taskId: task.id,
      runId: task.runs.at(-1)!.id,
      expectedRevision: task.revision,
    };
    const opened = f.voices.open(f.session, input, {
      callAttemptId: "one_call_attempt",
    });
    expect(opened.voice).toMatchObject({
      mode: "handset_audio_smoke",
      instructionsAllowed: false,
      callAttemptId: "one_call_attempt",
    });
    expect(
      f.voices.open(f.session, input, { callAttemptId: "one_call_attempt" })
        .replayed,
    ).toBe(true);
    expect(() => f.voices.open(f.session, input)).toThrow(/conflicts/);
    expect(() =>
      f.voices.open(f.session, input, { callAttemptId: "different_attempt" }),
    ).toThrow(/conflicts/);
    f.voices.bindProvider(opened.voice.id, "provider-fixture");
    expect(() => f.voices.finalize(opened.voice.id, f.input(task))).toThrow(
      /cannot start coding/,
    );
    expect(f.tasks.get(f.session.id, task.id).runs).toHaveLength(1);
    f.voices.end(opened.voice.id, "end-smoke");
    expect(f.tasks.get(f.session.id, task.id)).toEqual(task);
  });

  it("projects polished wording for an existing bound brief without rewriting task evidence", () => {
    const f = fixture();
    const task = f.ready();
    task.brief!.opening = "Old developer diagnostic wording.";
    new ProtectedTaskStore<CodingTask>(f.store, f.vault, "coding-task-v1").put(
      task,
    );
    const before = f.tasks.get(f.session.id, task.id);
    const voice = f.open(task).voice;
    expect(voice.opening).toBe("Choose empty state.");
    expect(f.tasks.get(f.session.id, task.id)).toEqual(before);
    expect(voice.openedRunId).toBe(task.runs.at(-1)!.id);
    expect(voice.openedRevision).toBe(task.revision);
  });

  it("opens only the prepared current brief with explicit task voice permission", () => {
    const f = fixture();
    const queued = f.create();
    expect(() => f.open(queued)).toThrow(/prepared/);
    const ready = f.verify(f.result(f.claim(queued)));
    expect(() =>
      f.voices.open(
        {
          ...f.session,
          permissions: { ...f.session.permissions, voice: false },
        },
        {
          eventId: "denied",
          taskId: ready.id,
          runId: ready.runs[0]!.id,
          expectedRevision: ready.revision,
        },
      ),
    ).toThrow(/authority/);
    const admitted = f.open(ready, "stable-open");
    expect(admitted.voice.opening).toBe(ready.brief!.opening);
    expect(admitted.voice.permissions).toEqual({
      presentation: false,
      control: false,
      screen: false,
    });
    expect(f.open(ready, "stable-open")).toEqual({
      voice: admitted.voice,
      replayed: true,
    });
    expect(() => f.voices.get("wrong-session", admitted.voice.id)).toThrow(
      /unavailable/,
    );
    expect(() => f.open(ready)).toThrow(/has not ended/);
  });

  it("requires an immutable distinct provider conversation before finalization", () => {
    const f = fixture();
    const task = f.ready(),
      voice = f.open(task).voice;
    expect(() => f.voices.finalize(voice.id, f.input(task))).toThrow(/match/);
    const bound = f.voices.bindProvider(voice.id, "provider-fixture");
    expect(f.voices.bindProvider(voice.id, "provider-fixture")).toEqual(bound);
    expect(() => f.voices.bindProvider(voice.id, "another-provider")).toThrow(
      /binding/,
    );
    f.voices.end(voice.id, "end");
    const next = f.open(task).voice;
    expect(() => f.voices.bindProvider(next.id, "provider-fixture")).toThrow(
      /reused/,
    );
  });

  it("rejects a stale initial provider opening but preserves an existing binding during work", () => {
    const f = fixture();
    let task = f.ready();
    const voice = f.open(task).voice;
    task = f.change(task, {
      action: "decide",
      runId: task.runs[0]!.id,
      instruction: "A typed change before audio startup.",
    });
    expect(() => f.voices.bindProvider(voice.id, "provider-fixture")).toThrow(
      /no longer current/,
    );
    f.voices.end(voice.id, "cancel-stale-opening");
    task = f.verify(f.result(f.claim(task)));
    const next = f.open(task).voice;
    f.voices.bindProvider(next.id, "provider-fixture");
    task = f.voices.finalize(next.id, f.input(task)).task;
    expect(task.state).toBe("queued");
    expect(
      f.voices.bindProvider(next.id, "provider-fixture").providerConversationId,
    ).toBe("provider-fixture");
  });

  it("deduplicates finalized utterances even under a new model tool event", () => {
    const f = fixture();
    const task = f.ready(),
      voice = f.open(task).voice;
    f.voices.bindProvider(voice.id, "provider-fixture");
    const input = f.input(task, "spoken-1");
    const first = f.voices.finalize(voice.id, input);
    expect(first.receipt.state).toBe("applied");
    expect(first.task.runs).toHaveLength(2);
    expect(f.voices.finalize(voice.id, input).replayed).toBe(true);
    expect(
      f.voices.finalize(voice.id, { ...input, eventId: "different-tool" })
        .replayed,
    ).toBe(true);
    expect(f.tasks.get(f.session.id, task.id).runs).toHaveLength(2);
    expect(() =>
      f.voices.finalize(voice.id, {
        ...input,
        instruction: "A different change.",
      }),
    ).toThrow(/conflicts/);
    expect(() =>
      f.voices.finalize(voice.id, {
        ...input,
        eventId: "different-tool",
        utteranceId: "different-utterance",
      }),
    ).toThrow(/conflicts/);
  });

  it("rejects stale or cross-task, cross-provider and cross-run instructions", () => {
    const f = fixture();
    const task = f.ready(),
      voice = f.open(task).voice;
    f.voices.bindProvider(voice.id, "provider-fixture");
    const input = f.input(task);
    expect(() =>
      f.voices.finalize(voice.id, { ...input, taskId: "foreign" }),
    ).toThrow(/match/);
    expect(() =>
      f.voices.finalize(voice.id, {
        ...input,
        providerConversationId: "foreign",
      }),
    ).toThrow(/match/);
    expect(() =>
      f.voices.finalize(voice.id, { ...input, runId: "foreign" }),
    ).toThrow(/stale/);
    expect(() =>
      f.voices.finalize(voice.id, {
        ...input,
        expectedRevision: task.revision - 1,
      }),
    ).toThrow(/stale/);
  });

  it("holds one revision during a run and releases only after terminal verification", () => {
    const f = fixture();
    let task = f.ready();
    const voice = f.open(task).voice;
    f.voices.bindProvider(voice.id, "provider-fixture");
    task = f.voices.finalize(voice.id, f.input(task)).task;
    task = f.claim(task);
    const held = f.voices.finalize(voice.id, {
      ...f.input(task),
      instruction: "Also add a count.",
    });
    expect(held.receipt.state).toBe("held");
    expect(held.task.runs).toHaveLength(2);
    expect(f.voices.heldForTask(task.id)).toEqual([held.receipt]);
    expect(() => f.voices.finalize(voice.id, f.input(task))).toThrow(
      /already waiting/,
    );
    expect(() => f.voices.releaseHeld(voice.id, held.receipt.id)).toThrow(
      /terminal run/,
    );
    task = f.result(task);
    expect(() => f.voices.releaseHeld(voice.id, held.receipt.id)).toThrow(
      /terminal run/,
    );
    task = f.verify(task);
    const released = f.voices.releaseHeld(voice.id, held.receipt.id);
    expect(released.receipt.state).toBe("applied");
    expect(released.task.runs).toHaveLength(3);
    expect(released.receipt.appliedRunId).toBe(released.task.runs.at(-1)!.id);
    expect(f.voices.releaseHeld(voice.id, held.receipt.id).replayed).toBe(true);
    expect(f.voices.heldForTask(task.id)).toEqual([]);
  });

  it("reconciles trusted finalized speech across same-run progress without retargeting a newer run", () => {
    const f = fixture();
    let task = f.ready();
    const voice = f.open(task).voice;
    f.voices.bindProvider(voice.id, "provider-fixture");
    task = f.claim(f.voices.finalize(voice.id, f.input(task)).task);
    const original = f.input(task, "finalized-during-run");
    task = f.verify(f.result(task));
    expect(() => f.voices.finalize(voice.id, original)).toThrow(/stale/);
    const accepted = f.voices.finalize(voice.id, {
      ...original,
      currentRevision: task.revision,
    });
    expect(accepted.receipt.expectedRevision).toBe(original.expectedRevision);
    expect(accepted.receipt.runId).toBe(original.runId);
    expect(accepted.task.runs).toHaveLength(3);
    expect(
      f.voices.finalize(voice.id, {
        ...original,
        currentRevision: accepted.task.revision,
      }).replayed,
    ).toBe(true);
    expect(() =>
      f.voices.finalize(voice.id, {
        ...original,
        eventId: "later-tool",
        utteranceId: "later-utterance",
        currentRevision: accepted.task.revision,
      }),
    ).toThrow(/stale/);
  });

  it("persists accepted instructions through voice end without canceling the task", () => {
    const f = fixture();
    let task = f.ready();
    const voice = f.open(task).voice;
    f.voices.bindProvider(voice.id, "provider-fixture");
    task = f.claim(f.voices.finalize(voice.id, f.input(task)).task);
    const held = f.voices.finalize(voice.id, f.input(task));
    f.voices.end(voice.id, "local-stop");
    expect(f.tasks.get(f.session.id, task.id).state).toBe("running");
    expect(() => f.voices.finalize(voice.id, f.input(task))).toThrow(/ended/);
    task = f.verify(f.result(task));
    expect(
      f.voices.releaseHeld(voice.id, held.receipt.id).task.runs,
    ).toHaveLength(3);
  });

  it("does not replay held instructions after restart or unknown execution", () => {
    const f = fixture();
    let task = f.ready();
    const voice = f.open(task).voice;
    f.voices.bindProvider(voice.id, "provider-fixture");
    task = f.claim(f.voices.finalize(voice.id, f.input(task)).task);
    const held = f.voices.finalize(voice.id, f.input(task));
    const restartedTasks = new TaskLedger(f.store, f.vault, f.clock);
    const restartedVoice = new TaskVoiceLedger(
      f.store,
      f.vault,
      restartedTasks,
      f.clock,
    );
    expect(restartedTasks.get(f.session.id, task.id).state).toBe("unknown");
    expect(restartedVoice.heldForTask(task.id)).toEqual([held.receipt]);
    expect(() => restartedVoice.releaseHeld(voice.id, held.receipt.id)).toThrow(
      /terminal run/,
    );
    expect(restartedTasks.get(f.session.id, task.id).runs).toHaveLength(2);
  });

  it("refuses held work after task cancellation", () => {
    const f = fixture();
    let task = f.ready();
    const voice = f.open(task).voice;
    f.voices.bindProvider(voice.id, "provider-fixture");
    task = f.claim(f.voices.finalize(voice.id, f.input(task)).task);
    const held = f.voices.finalize(voice.id, f.input(task));
    task = f.change(task, { action: "cancel" });
    task = f.result(task, "canceled");
    expect(task.state).toBe("canceled");
    expect(() => f.voices.releaseHeld(voice.id, held.receipt.id)).toThrow(
      /terminal run/,
    );
    expect(f.voices.heldForTask(task.id)).toEqual([held.receipt]);
  });

  it("encrypts transcript instruction, opening and provider identity at rest", () => {
    const f = fixture();
    const task = f.ready(),
      voice = f.open(task).voice;
    f.voices.bindProvider(voice.id, "provider-fixture");
    f.voices.finalize(voice.id, f.input(task));
    const stored = JSON.stringify(f.store.query("SELECT * FROM entities"));
    expect(stored).not.toContain("Clear filters");
    expect(stored).not.toContain("provider-fixture");
    expect(stored).not.toContain(task.brief!.opening);
  });

  it("commits task and utterance receipts atomically", () => {
    const f = fixture();
    const task = f.ready(),
      voice = f.open(task).voice;
    f.voices.bindProvider(voice.id, "provider-fixture");
    const put = f.store.put.bind(f.store);
    f.store.put = ((kind: string, value: { id: string }) => {
      if (kind === "coding-task-voice-instruction-v1")
        throw new Error("synthetic storage failure");
      return put(kind, value);
    }) as Store["put"];
    expect(() => f.voices.finalize(voice.id, f.input(task))).toThrow(
      /storage failure/,
    );
    expect(f.tasks.get(f.session.id, task.id)).toEqual(task);
    expect(f.voices.heldForTask(task.id)).toEqual([]);
  });

  it("keeps fresh voice admissions fenced after voice end while native cleanup is unresolved", () => {
    const f = fixture(),
      task = f.ready();
    const voice = f.open(task, "original").voice;
    f.voices.end(voice.id, "stop");
    new ProtectedTaskStore<{
      id: string;
      state: string;
      plan: { taskSessionId: string; taskId: string };
    }>(f.store, f.vault, "coding-task-audio-call-v1").put({
      id: "attempt",
      state: "unknown",
      plan: { taskSessionId: f.session.id, taskId: task.id },
    });
    expect(f.open(task, "original").replayed).toBe(true);
    expect(() => f.open(task, "new-local")).toThrow(/unresolved/);
  });

  it("does not treat expiry as proof the previous audio runtime ended", () => {
    const f = fixture();
    const task = f.ready(),
      voice = f.open(task).voice;
    f.advance(100001);
    expect(() => f.voices.bindProvider(voice.id, "provider-fixture")).toThrow(
      /expired/,
    );
    expect(() =>
      f.voices.open(
        { ...f.session, expiresAt: 999999 },
        {
          eventId: "after-expiry",
          taskId: task.id,
          runId: task.runs[0]!.id,
          expectedRevision: task.revision,
        },
      ),
    ).toThrow(/has not ended/);
  });
});

function walkthroughVoice(f: ReturnType<typeof fixture>, task: CodingTask) {
  const voice = f.voices.open(
    f.session,
    {
      eventId: "walkthrough-open",
      taskId: task.id,
      runId: task.runs.at(-1)!.id,
      expectedRevision: task.revision,
    },
    {
      mode: "handset_walkthrough",
      callAttemptId: "walkthrough-call",
      exportGrantId: "export",
      presentationId: "presentation",
      manifestFingerprint: hash("manifest"),
    },
  ).voice;
  f.voices.bindProvider(voice.id, "provider-fixture");
  const plan: TaskWalkthroughPlan = {
    version: 1,
    mode: "handset_walkthrough",
    id: "walkthrough-call",
    taskSessionId: f.session.id,
    taskId: task.id,
    runId: task.runs.at(-1)!.id,
    revision: task.revision,
    voiceSessionId: voice.id,
    pairingId: "destination",
    memberId: "member",
    deviceId: "mac",
    lineId: "22222222-2222-4222-8222-222222222222",
    recipientHash: hash("synthetic"),
    mediaSessionId: "media",
    workerIdentity: "worker",
    agentIdentity: "agent",
    exportGrantId: "export",
    callKind: "review",
    presentationBinding: {
      presentationId: "presentation",
      manifestFingerprint: hash("manifest"),
      presentationGrantId: "local",
      verificationId: task.verification!.id,
      hostId: "host",
      captureDeviceId: "mac",
    },
    dispatchExpiresAt: 100000,
    expiresAt: 100000,
    audio: true,
    video: true,
    screen: true,
    presentation: true,
    instructions: true,
    control: false,
    nativeActivation: false,
    maxCalls: 1,
  };
  const calls = new ProtectedTaskStore<{ id: string; [key: string]: unknown }>(
    f.store,
    f.vault,
    "coding-task-audio-call-v1",
  );
  const connect = () =>
    calls.put({
      id: plan.id,
      plan,
      fingerprint: taskHandsetFingerprint(plan),
      state: "connected",
      stopRequested: false,
      mediaClosed: false,
      nativeCleanupComplete: false,
      providerCallId: "11111111-1111-4111-8111-111111111111",
      receipts: {
        native_dial: { state: "done" },
        media_activate: { state: "done" },
      },
      nativeObservation: {
        providerCallId: "11111111-1111-4111-8111-111111111111",
        state: "connected",
        cleanupComplete: false,
        observedAt: f.clock(),
      },
    });
  return { voice, plan, calls, connect };
}
describe("walkthrough finalized voice authority", () => {
  it("requires connected proof for new instructions but preserves original replay after hangup", () => {
    const f = fixture(),
      task = f.ready(),
      w = walkthroughVoice(f, task),
      input = f.input(task);
    expect(() => f.voices.finalize(w.voice.id, input)).toThrow(/connected/);
    w.connect();
    const applied = f.voices.finalize(w.voice.id, input);
    expect(applied.receipt.state).toBe("applied");
    w.calls.put({ ...w.calls.get(w.plan.id)!, state: "unknown" });
    f.voices.end(w.voice.id, "end");
    expect(f.voices.finalize(w.voice.id, input).replayed).toBe(true);
    expect(() => f.voices.acceptFinalized(w.voice.id, input)).toThrow(
      /conflicts|coding instruction/,
    );
  });
  it("holds another correction during work and releases it after known verification even after hangup", () => {
    const f = fixture(),
      task = f.ready(),
      w = walkthroughVoice(f, task);
    w.connect();
    const next = f.voices.finalize(w.voice.id, f.input(task)).task;
    const running = f.claim(next),
      held = f.voices.finalize(w.voice.id, f.input(running));
    expect(held.receipt.state).toBe("held");
    f.voices.end(w.voice.id, "end");
    w.calls.put({ ...w.calls.get(w.plan.id)!, state: "closed" });
    expect(() => f.voices.releaseHeld(w.voice.id, held.receipt.id)).toThrow();
    const verified = f.verify(f.result(running));
    const released = f.voices.releaseHeld(w.voice.id, held.receipt.id);
    expect(released.task.runs).toHaveLength(verified.runs.length + 1);
    expect(released.receipt.state).toBe("applied");
  });
  it("accepts only independently passed review without a new run and shares the utterance use fence", () => {
    const f = fixture();
    let task = f.claim(f.create());
    task = f.change(task, {
      action: "run_result",
      runId: task.runs.at(-1)!.id,
      dispatchId: task.runs.at(-1)!.dispatchId,
      outcome: "completed",
      summary: "Added the filter.",
    });
    task = f.verify(task);
    expect(task.state).toBe("review_ready");
    const w = walkthroughVoice(f, task),
      input = { ...f.input(task), instruction: "I accept this result." };
    expect(() => f.voices.acceptFinalized(w.voice.id, input)).toThrow(
      /connected/,
    );
    w.connect();
    const accepted = f.voices.acceptFinalized(w.voice.id, input);
    expect(accepted.task.state).toBe("accepted");
    expect(accepted.task.runs).toHaveLength(task.runs.length);
    w.calls.put({ ...w.calls.get(w.plan.id)!, state: "closed" });
    f.voices.end(w.voice.id, "end");
    expect(f.voices.acceptFinalized(w.voice.id, input).replayed).toBe(true);
    expect(() => f.voices.finalize(w.voice.id, input)).toThrow(
      /conflicts|acceptance/,
    );
  });
  it("rejects acceptance for decision results and stale or mismatched connected evidence", () => {
    const f = fixture(),
      task = f.ready(),
      w = walkthroughVoice(f, task);
    w.connect();
    expect(() => f.voices.acceptFinalized(w.voice.id, f.input(task))).toThrow(
      /verified current review/,
    );
    f.advance(5001);
    expect(() => f.voices.finalize(w.voice.id, f.input(task))).toThrow(
      /connected/,
    );
    w.connect();
    w.calls.put({
      ...w.calls.get(w.plan.id)!,
      plan: { ...w.plan, exportGrantId: "other" },
    });
    expect(() => f.voices.finalize(w.voice.id, f.input(task))).toThrow(
      /connected/,
    );
  });
});

describe("final review acceptance provenance", () => {
  const reviewed = (
    f: ReturnType<typeof fixture>,
    task = f.claim(f.create()),
  ) =>
    f.verify(
      f.change(task, {
        action: "run_result",
        runId: task.runs.at(-1)!.id,
        dispatchId: task.runs.at(-1)!.dispatchId,
        outcome: "completed",
        summary: "The filter works.",
      }),
    );
  it.each(["decision_call", "different_verification"])(
    "refuses %s even with an exact connected conversation",
    (kind) => {
      const f = fixture(),
        task = reviewed(f),
        w = walkthroughVoice(f, task);
      w.connect();
      const changed =
        kind === "decision_call"
          ? { ...w.plan, callKind: "decision" as const }
          : {
              ...w.plan,
              presentationBinding: {
                ...w.plan.presentationBinding,
                verificationId: "different",
              },
            };
      w.calls.put({
        ...w.calls.get(w.plan.id)!,
        plan: changed,
        fingerprint: taskHandsetFingerprint(changed),
      });
      expect(() =>
        f.voices.acceptFinalized(w.voice.id, {
          ...f.input(task),
          instruction: "I accept this result.",
        }),
      ).toThrow(/fresh final review call/);
      expect(f.tasks.get(f.session.id, task.id).state).toBe("review_ready");
    },
  );
  it("requires another final review call for a newer verified run while retaining correction admission", () => {
    const f = fixture(),
      task = reviewed(f),
      w = walkthroughVoice(f, task);
    w.connect();
    const next = f.voices.finalize(w.voice.id, f.input(task)).task;
    const complete = reviewed(f, f.claim(next));
    expect(() =>
      f.voices.acceptFinalized(w.voice.id, {
        ...f.input(complete),
        instruction: "I accept this result.",
      }),
    ).toThrow(/fresh final review call/);
    expect(f.voices.finalize(w.voice.id, f.input(complete)).receipt.state).toBe(
      "applied",
    );
  });
  it("never reconciles an acceptance spoken before the verified review revision", () => {
    const f = fixture(),
      task = reviewed(f),
      w = walkthroughVoice(f, task);
    w.connect();
    expect(() =>
      f.voices.acceptFinalized(w.voice.id, {
        ...f.input(task),
        expectedRevision: task.revision - 1,
        currentRevision: task.revision,
        instruction: "I accept this result.",
      }),
    ).toThrow(/verified current review/);
    expect(f.tasks.get(f.session.id, task.id).state).toBe("review_ready");
  });
});
