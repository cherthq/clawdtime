import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodingTask,
  IndependentTaskSession,
  TaskCommand,
} from "../src/contracts.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskReviewCallbackLedger } from "../src/attention/task-review-callback-ledger.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";

const session: IndependentTaskSession = {
  version: 1,
  id: "callback-session",
  pairingId: "pairing",
  memberId: "member",
  deviceId: "device",
  hostId: "host",
  projectRoot: "/disposable-project",
  createdAt: 0,
  expiresAt: 1_000_000,
  permissions: {
    execute: true,
    voice: false,
    presentation: false,
    control: false,
  },
};
const stores: Store[] = [],
  directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture(path = ":memory:") {
  const store = new Store(path),
    vault = new Vault("ad".repeat(32));
  stores.push(store);
  const tasks = new TaskLedger(store, vault, () => 1000);
  const callbacks = new TaskReviewCallbackLedger(
    store,
    vault,
    tasks,
    () => 1000,
  );
  let sequence = 0;
  const change = (task: CodingTask, command: Record<string, unknown>) =>
    tasks.transition(session.id, task.id, {
      eventId: `event-${sequence++}`,
      expectedRevision: task.revision,
      ...command,
    } as TaskCommand).task;
  const create = () =>
    tasks.create(session, {
      eventId: `create-${sequence++}`,
      goal: "Make a draft landing page. Call when ready; don't deploy or send messages.",
    }).task;
  const complete = (
    task: CodingTask,
    outcome = "completed",
    verified = "passed",
  ) => {
    let current = change(task, {
      action: "claim_run",
      runId: task.runs.at(-1)!.id,
    });
    current = change(current, {
      action: "run_result",
      runId: current.runs.at(-1)!.id,
      dispatchId: current.runs.at(-1)!.dispatchId,
      outcome,
      summary: "The draft is ready.",
    });
    return change(current, {
      action: "verify_result",
      verification: {
        id: `verification-${sequence++}`,
        runId: current.runs.at(-1)!.id,
        state: verified,
        completedAt: 1000,
        checks: [
          {
            name: "fixture",
            command: ["node", "--test"],
            state: verified,
            exitCode: verified === "passed" ? 0 : 1,
            summary: "Fixture checked.",
          },
        ],
      },
    });
  };
  const prepare = (task: CodingTask) => {
    const { record } = callbacks.schedule(session.id, task.id);
    return callbacks.prepared(session.id, record.id, {
      manifestFingerprint: "ab".repeat(32),
      opening: record.opening,
    });
  };
  return { store, vault, tasks, callbacks, change, create, complete, prepare };
}

describe("durable supervisor review callbacks", () => {
  it("fences unknown submission even when a crash lost the call attempt identity", () => {
    const f = fixture(),
      task = f.complete(f.create()),
      record = f.prepare(task);
    const unknown = f.callbacks.markUnknown(session.id, record.id);
    expect(unknown).toMatchObject({
      state: "unknown",
      reason: "delivery_reservation_unconfirmed",
    });
    expect(unknown.attemptId).toBeUndefined();
    expect(f.callbacks.markUnknown(session.id, record.id)).toEqual(unknown);
    expect(f.callbacks.cancel(session.id, task.id)[0]).toEqual(unknown);
    expect(() =>
      f.callbacks.reserve(session.id, record.id, "replacement"),
    ).toThrow(/not prepared/);
    const next = f.prepare(f.complete(f.create()));
    expect(() => f.callbacks.reserve(session.id, next.id, "another")).toThrow(
      /unresolved/,
    );
  });

  it("deduplicates one callback for each exact independently checked result and preserves constraints", () => {
    const f = fixture();
    const task = f.complete(f.create());
    const first = f.callbacks.schedule(session.id, task.id);
    expect(first.replayed).toBe(false);
    expect(first.record).toMatchObject({
      taskId: task.id,
      runId: task.runs[0]!.id,
      verificationId: task.verification!.id,
      reviewRevision: task.revision,
      kind: "review",
      state: "preparing",
      goal: task.goal,
    });
    expect(first.record.opening).toContain("configured checks passed");
    expect(f.callbacks.schedule(session.id, task.id)).toEqual({
      record: first.record,
      replayed: true,
    });
    expect(f.callbacks.list(session.id)).toHaveLength(1);
    expect(
      JSON.stringify(f.store.query("SELECT * FROM entities")),
    ).not.toContain("draft landing page");
    expect(f.callbacks.list("foreign-session")).toEqual([]);
    expect(() => f.callbacks.get("foreign-session", first.record.id)).toThrow(
      /unavailable/,
    );
  });

  it.each(["failed", "blocked"])(
    "prepares honest attention for a %s run even when checks pass",
    (outcome) => {
      const f = fixture(),
        task = f.complete(f.create(), outcome);
      const record = f.callbacks.schedule(session.id, task.id).record;
      expect(record.kind).toBe("decision");
      expect(record.opening).not.toContain("checks passed");
      expect(record.opening).toContain(outcome);
    },
  );

  it("never describes failed verification as a verified result", () => {
    const f = fixture(),
      task = f.complete(f.create(), "completed", "failed");
    const record = f.callbacks.schedule(session.id, task.id).record;
    expect(record.kind).toBe("decision");
    expect(record.opening).toContain("Independent verification failed");
    expect(() =>
      f.callbacks.prepared(session.id, record.id, {
        opening: "Everything passed!",
        manifestFingerprint: "ab".repeat(32),
      }),
    ).toThrow(/authoritative brief/);
  });

  it("does not schedule unfinished, uncertain, or stopped work", () => {
    const f = fixture();
    let task = f.create();
    expect(() => f.callbacks.schedule(session.id, task.id)).toThrow(
      /checked result/,
    );
    task = f.change(task, { action: "cancel" });
    expect(() => f.callbacks.schedule(session.id, task.id)).toThrow(
      /checked result/,
    );
    const ready = f.complete(f.create());
    f.change(ready, { action: "cancel" });
    expect(() => f.callbacks.schedule(session.id, ready.id)).toThrow(
      /checked result/,
    );
  });

  it("requires preparation, exact attempt binding and one reserved dispatch", () => {
    const f = fixture(),
      task = f.complete(f.create());
    const record = f.callbacks.schedule(session.id, task.id).record;
    expect(() =>
      f.callbacks.reserve(session.id, record.id, "attempt-1"),
    ).toThrow(/not prepared/);
    f.prepare(task);
    const reserved = f.callbacks.reserve(session.id, record.id, "attempt-1");
    expect(reserved.replayed).toBe(false);
    expect(
      f.callbacks.reserve(session.id, record.id, "attempt-1").replayed,
    ).toBe(true);
    expect(() =>
      f.callbacks.reserve(session.id, record.id, "attempt-2"),
    ).toThrow(/do not redial/);
    expect(() =>
      f.callbacks.outcome(session.id, record.id, "wrong-attempt", "in_review"),
    ).toThrow(/original attempt/);
    f.callbacks.outcome(session.id, record.id, "attempt-1", "in_review");
    f.callbacks.outcome(session.id, record.id, "attempt-1", "delivered");
    expect(f.tasks.get(session.id, task.id).state).toBe("review_ready"); // Delivery is never acceptance.
    expect(
      f.callbacks.reserve(session.id, record.id, "attempt-1").replayed,
    ).toBe(true);
    expect(() =>
      f.callbacks.reserve(session.id, record.id, "attempt-2"),
    ).toThrow(/do not redial/);
  });

  it("persists awaiting-call intent and never retries uncertain delivery after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawdtime-callback-test-"));
    directories.push(dir);
    const path = join(dir, "test.sqlite"),
      f = fixture(path);
    const first = f.prepare(f.complete(f.create()));
    f.store.close();
    const g = fixture(path);
    expect(g.callbacks.get(session.id, first.id).state).toBe("awaiting_call");
    g.callbacks.reserve(session.id, first.id, "original-attempt");
    g.store.close();
    const h = fixture(path),
      recovered = h.callbacks.get(session.id, first.id);
    expect(recovered.state).toBe("unknown");
    expect(recovered.attemptId).toBe("original-attempt");
    expect(recovered.history.map((entry) => entry.state)).toEqual([
      "preparing",
      "awaiting_call",
      "dispatching",
      "unknown",
    ]);
    expect(
      h.callbacks.reserve(session.id, first.id, "original-attempt").replayed,
    ).toBe(true);
    expect(() =>
      h.callbacks.reserve(session.id, first.id, "new-attempt"),
    ).toThrow(/do not redial/);
    expect(() =>
      h.callbacks.outcome(
        session.id,
        first.id,
        "original-attempt",
        "delivered",
      ),
    ).toThrow(/reviewed reconciliation/);
    expect(h.callbacks.cancel(session.id, first.taskId)[0]!.state).toBe(
      "unknown",
    );
  });

  it("blocks another callback while an original delivery is uncertain", () => {
    const f = fixture(),
      first = f.prepare(f.complete(f.create()));
    f.callbacks.reserve(session.id, first.id, "attempt-a");
    f.callbacks.outcome(session.id, first.id, "attempt-a", "unknown");
    const next = f.prepare(f.complete(f.create()));
    expect(() => f.callbacks.reserve(session.id, next.id, "attempt-b")).toThrow(
      /unresolved/,
    );
  });

  it("retains stopped callback intent without later rescheduling or dispatch", () => {
    const f = fixture(),
      task = f.complete(f.create()),
      record = f.prepare(task);
    f.callbacks.cancel(session.id, task.id);
    expect(f.callbacks.schedule(session.id, task.id).record.state).toBe(
      "canceled",
    );
    expect(() => f.callbacks.reserve(session.id, record.id, "attempt")).toThrow(
      /not prepared/,
    );
    expect(() =>
      f.callbacks.prepared(session.id, record.id, {
        manifestFingerprint: "ab".repeat(32),
        opening: record.opening,
      }),
    ).toThrow(/retired/);
  });

  it("retires stale unsubmitted reviews and creates a fresh callback for revisions of the same task", () => {
    const f = fixture();
    let task = f.complete(f.create());
    const first = f.prepare(task);
    task = f.change(task, {
      action: "decide",
      runId: task.runs[0]!.id,
      instruction: "Make the page blue.",
    });
    expect(() =>
      f.callbacks.reserve(session.id, first.id, "stale-attempt"),
    ).toThrow(/stale/);
    expect(f.callbacks.reconcile(session.id, task.id)[0]!.state).toBe(
      "canceled",
    );
    task = f.complete(task);
    const second = f.prepare(task);
    expect(second.id).not.toBe(first.id);
    expect(second.taskId).toBe(first.taskId);
    expect(second.goal).toBe(first.goal);
    expect(second.humanInstructions).toEqual([
      first.goal,
      "Make the page blue.",
    ]);
    expect(second.reviewRevision).toBeGreaterThan(first.reviewRevision);
    expect(f.callbacks.list(session.id, task.id)).toHaveLength(2);
    f.callbacks.reserve(session.id, second.id, "new-review-attempt");
  });

  it("can expose and clear an unsent phone setup blocker without changing a prepared result", () => {
    const f = fixture(),
      task = f.complete(f.create());
    const record = f.callbacks.schedule(session.id, task.id).record;
    f.callbacks.block(session.id, record.id, "phone_not_configured");
    expect(f.callbacks.get(session.id, record.id)).toMatchObject({
      state: "blocked",
      reason: "phone_not_configured",
    });
    const ready = f.prepare(task);
    expect(ready.state).toBe("awaiting_call");
    expect(ready.reason).toBeUndefined();
    f.callbacks.reserve(session.id, ready.id, "attempt");
    expect(() =>
      f.callbacks.block(session.id, ready.id, "phone_not_configured"),
    ).toThrow(/Submitted/);
  });

  it("atomically retains reservation when encrypted persistence fails", () => {
    const f = fixture(),
      record = f.prepare(f.complete(f.create()));
    const put = f.store.put.bind(f.store);
    f.store.put = ((kind: string, value: { id: string }) => {
      if (kind === "coding-review-callback-v1")
        throw new Error("storage unavailable");
      return put(kind, value);
    }) as Store["put"];
    expect(() => f.callbacks.reserve(session.id, record.id, "attempt")).toThrow(
      /storage unavailable/,
    );
    expect(f.callbacks.get(session.id, record.id)).toEqual(record);
  });
});
