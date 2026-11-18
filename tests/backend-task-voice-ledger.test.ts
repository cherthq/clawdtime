import { afterEach, describe, expect, it } from "vitest";
import type {
  CodingTask,
  IndependentTaskSession,
  TaskCommand,
} from "../src/contracts.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskVoiceLedger } from "../src/attention/task-voice-ledger.js";
import { ProtectedTaskStore } from "../src/storage/task-store.js";

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
