import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodingTask,
  IndependentTaskSession,
  TaskCommand,
  TaskVerification,
} from "../src/contracts.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";

const session: IndependentTaskSession = {
  id: "session-test",
  version: 1,
  pairingId: "pairing-test",
  memberId: "member-test",
  deviceId: "mac-test",
  hostId: "host-test",
  projectRoot: "/disposable-demo",
  createdAt: 10,
  expiresAt: 100000,
  permissions: {
    execute: true,
    voice: false,
    presentation: false,
    control: false,
  },
};
const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  stores.forEach((s) => {
    try {
      s.close();
    } catch {}
  });
  stores.length = 0;
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  dirs.length = 0;
});
function fixture(path = ":memory:") {
  const store = new Store(path);
  stores.push(store);
  const vault = new Vault("ab".repeat(32));
  const ledger = new TaskLedger(store, vault, () => 1000);
  let count = 0;
  const create = (goal = "Add a task filter.", binding = session) =>
    ledger.create(binding, { eventId: `create-${count++}`, goal }).task;
  const change = (
    task: CodingTask,
    command:
      | Omit<TaskCommand, "eventId" | "expectedRevision">
      | Record<string, unknown>,
  ) =>
    ledger.transition(task.sessionId, task.id, {
      eventId: `change-${count++}`,
      expectedRevision: task.revision,
      ...command,
    } as TaskCommand).task;
  const claim = (task: CodingTask) =>
    change(task, { action: "claim_run", runId: task.runs.at(-1)!.id });
  const result = (task: CodingTask, extra = {}) =>
    change(task, {
      action: "run_result",
      runId: task.runs.at(-1)!.id,
      dispatchId: task.runs.at(-1)!.dispatchId,
      outcome: "completed",
      summary: "Changed the fixture.",
      ...extra,
    });
  const verify = (
    task: CodingTask,
    state: TaskVerification["state"] = "passed",
  ) =>
    change(task, {
      action: "verify_result",
      verification: {
        id: `verification-${count++}`,
        runId: task.runs.at(-1)!.id,
        state,
        completedAt: 1000,
        checks: [
          {
            name: "fixture test",
            command: ["node", "--test"],
            state,
            exitCode: state === "passed" ? 0 : 1,
            summary: "Independent check result.",
          },
        ],
      },
    });
  return { store, vault, ledger, create, change, claim, result, verify };
}

describe("independent task ledger", () => {
  it("keeps one task across two distinct scoped runs and verifies before review", () => {
    const f = fixture();
    let task = f.create();
    const original = task.id;
    task = f.claim(task);
    task = f.result(task, { decision: "What should an empty filter show?" });
    expect(task.state).toBe("verifying");
    task = f.verify(task);
    expect(task.state).toBe("needs_decision");
    task = f.change(task, {
      action: "prepare_call",
      callId: "call-1",
      opening: "The filter works; choose an empty state.",
      simulated: true,
    });
    task = f.change(task, {
      action: "call_state",
      callId: "call-1",
      state: "connected",
    });
    task = f.change(task, {
      action: "decide",
      runId: task.runs[0]!.id,
      instruction: "Add a Clear filters button.",
    });
    expect(task.id).toBe(original);
    expect(task.runs).toHaveLength(2);
    expect(task.runs[1]!.id).not.toBe(task.runs[0]!.id);
    expect(task.runs[1]!.dispatchId).not.toBe(task.runs[0]!.dispatchId);
    task = f.claim(task);
    task = f.change(task, {
      action: "call_state",
      callId: "call-1",
      state: "ended",
    });
    expect(task.state).toBe("running");
    task = f.verify(f.result(task));
    expect(task.state).toBe("review_ready");
    task = f.change(task, {
      action: "prepare_call",
      callId: "call-2",
      opening: "The empty state is implemented and checked.",
      simulated: true,
    });
    task = f.change(task, {
      action: "call_state",
      callId: "call-2",
      state: "connected",
    });
    task = f.change(task, { action: "accept", runId: task.runs[1]!.id });
    expect(task.state).toBe("accepted");
    expect(task.verifications).toHaveLength(2);
    expect(task.calls).toHaveLength(2);
  });

  it("deduplicates create, claim and instruction events without granting a second dispatch", () => {
    const f = fixture();
    const input = { eventId: "create", goal: "Add a filter." };
    const task = f.ledger.create(session, input).task;
    expect(f.ledger.create(session, input)).toEqual({ task, replayed: true });
    const claim: TaskCommand = {
      eventId: "claim",
      expectedRevision: 0,
      action: "claim_run",
      runId: task.runs[0]!.id,
    };
    expect(f.ledger.transition(session.id, task.id, claim).replayed).toBe(
      false,
    );
    expect(f.ledger.transition(session.id, task.id, claim).replayed).toBe(true);
    let waiting = f.verify(
      f.result(f.ledger.get(session.id, task.id), {
        decision: "Choose empty state.",
      }),
    );
    const decide: TaskCommand = {
      eventId: "spoken-1",
      expectedRevision: waiting.revision,
      action: "decide",
      runId: waiting.runs[0]!.id,
      instruction: "Clear filters button.",
    };
    waiting = f.ledger.transition(session.id, task.id, decide).task;
    expect(f.ledger.transition(session.id, task.id, decide)).toEqual({
      task: waiting,
      replayed: true,
    });
    expect(waiting.runs).toHaveLength(2);
    expect(() =>
      f.ledger.transition(session.id, task.id, {
        ...decide,
        instruction: "Different answer.",
      }),
    ).toThrow(/conflicting/);
  });

  it("rejects stale revisions, wrong sessions and wrong dispatch identities", () => {
    const f = fixture();
    const task = f.create();
    const running = f.claim(task);
    expect(() => f.change(task, { action: "cancel" })).toThrow(/stale/);
    expect(() => f.ledger.get("another-session", task.id)).toThrow(
      /unavailable/,
    );
    expect(f.ledger.list("another-session")).toEqual([]);
    expect(() => f.result(running, { dispatchId: "foreign" })).toThrow(
      /unresolved dispatch/,
    );
    expect(() => f.result(running, { runId: "foreign" })).toThrow(
      /unresolved dispatch/,
    );
    expect(() =>
      f.change(running, {
        action: "decide",
        runId: running.runs[0]!.id,
        instruction: "Approve.",
      }),
    ).toThrow(/terminal run/);
  });

  it("serializes runs globally across sessions and blocks unknown outcomes", () => {
    const f = fixture();
    const a = f.claim(f.create());
    const b = f.create("Other task", { ...session, id: "session-2" });
    expect(() => f.claim(b)).toThrow(/unresolved/);
    f.result(a, { outcome: "unknown" });
    expect(() => f.claim(b)).toThrow(/unresolved/);
    expect(() =>
      f.change(f.ledger.get(session.id, a.id), {
        action: "decide",
        runId: a.runs[0]!.id,
        instruction: "Try again.",
      }),
    ).toThrow(/terminal run/);
  });

  it("reloads encrypted queued context and fences in-flight work after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawdtime-ledger-"));
    dirs.push(dir);
    const path = join(dir, "tasks.sqlite");
    const f = fixture(path);
    const queued = f.create("Sensitive synthetic pending goal.");
    const running = f.claim(f.create("Sensitive synthetic running goal."));
    const rows = JSON.stringify(f.store.query("SELECT * FROM entities"));
    expect(rows).not.toContain("Sensitive");
    expect(rows).not.toContain(session.projectRoot);
    f.store.close();
    const g = fixture(path);
    expect(g.ledger.get(session.id, queued.id).goal).toBe(queued.goal);
    const recovered = g.ledger.get(session.id, running.id);
    expect(recovered.state).toBe("unknown");
    expect(recovered.runs[0]!.state).toBe("unknown");
    expect(recovered.runs[0]!.dispatchId).toBe(running.runs[0]!.dispatchId);
    expect(() => g.claim(g.ledger.get(session.id, queued.id))).toThrow(
      /unresolved/,
    );
    expect(readFileSync(path).includes(Buffer.from("Sensitive"))).toBe(false);
  });

  it("does not replay a verification whose child outcome was lost at restart", () => {
    const f = fixture();
    const verifying = f.result(f.claim(f.create()));
    const restarted = new TaskLedger(f.store, f.vault, () => 1001);
    expect(restarted.get(session.id, verifying.id).state).toBe("unknown");
    expect(restarted.get(session.id, verifying.id).runs[0]!.state).toBe(
      "completed",
    );
    expect(() =>
      restarted.transition(session.id, verifying.id, {
        eventId: "new-claim",
        expectedRevision: verifying.revision + 1,
        action: "claim_run",
        runId: verifying.runs[0]!.id,
      }),
    ).toThrow();
  });

  it("can reconcile an exact original worker result after restart without re-executing", () => {
    const f = fixture();
    const running = f.claim(f.create());
    const restarted = new TaskLedger(f.store, f.vault, () => 1001);
    const task = restarted.get(session.id, running.id);
    const result = restarted.transition(session.id, task.id, {
      eventId: "original-result",
      expectedRevision: task.revision,
      action: "run_result",
      runId: task.runs[0]!.id,
      dispatchId: task.runs[0]!.dispatchId,
      outcome: "completed",
      summary: "Original receipt read.",
    });
    expect(result.task.state).toBe("verifying");
    expect(result.task.runs).toHaveLength(1);
  });

  it("requires nonempty consistent independent verification before acceptance", () => {
    const f = fixture();
    let task = f.result(f.claim(f.create()));
    expect(() =>
      f.change(task, { action: "accept", runId: task.runs[0]!.id }),
    ).toThrow(/independently/);
    expect(() =>
      f.change(task, {
        action: "verify_result",
        verification: {
          id: "v",
          runId: task.runs[0]!.id,
          state: "passed",
          completedAt: 1000,
          checks: [],
        },
      }),
    ).toThrow(/verification/);
    expect(() =>
      f.change(task, {
        action: "verify_result",
        verification: {
          id: "v",
          runId: task.runs[0]!.id,
          state: "passed",
          completedAt: 1000,
          checks: [
            {
              name: "test",
              command: ["node"],
              state: "blocked",
              exitCode: null,
              summary: "Unavailable.",
            },
          ],
        },
      }),
    ).toThrow(/aggregate/);
    task = f.verify(task, "blocked");
    expect(task.state).toBe("needs_decision");
    expect(task.verification!.state).toBe("blocked");
  });

  it("escalates a failed worker even if tests pass", () => {
    const f = fixture();
    const task = f.verify(
      f.result(f.claim(f.create()), {
        outcome: "blocked",
        summary: "Native approval declined.",
      }),
    );
    expect(task.state).toBe("needs_decision");
  });

  it("retains bounded original Codex identities for reconciliation", () => {
    const f = fixture();
    const task = f.claim(f.create());
    expect(() => f.result(task, { threadId: "x".repeat(201) })).toThrow(
      /thread identity/,
    );
    const completed = f.result(task, {
      threadId: "thread-fixture",
      turnId: "turn-fixture",
    });
    expect(completed.runs[0]).toMatchObject({
      threadId: "thread-fixture",
      turnId: "turn-fixture",
    });
    expect(f.ledger.get(session.id, task.id).runs[0]).toMatchObject({
      threadId: "thread-fixture",
      turnId: "turn-fixture",
    });
  });

  it("prepares task-bound briefs from independent verification and clears obsolete ones", () => {
    const f = fixture();
    let task = f.verify(f.result(f.claim(f.create())), "failed");
    expect(task.brief).toMatchObject({
      kind: "decision",
      runId: task.runs[0]!.id,
      verificationId: task.verification!.id,
    });
    expect(task.brief!.opening).toContain("Independent verification failed");
    expect(task.brief!.opening).not.toContain("checks passed");
    expect(task.brief!.opening).toContain("fixture test");
    task = f.change(task, {
      action: "decide",
      runId: task.runs[0]!.id,
      instruction: "Fix the failing fixture.",
    });
    expect(task.brief).toBeUndefined();
    task = f.verify(f.result(f.claim(task)));
    expect(task.brief).toMatchObject({
      kind: "review",
      runId: task.runs[1]!.id,
      verificationId: task.verification!.id,
    });
    expect(task.brief!.opening).toContain(
      "The configured checks passed. Please review the result.",
    );
  });

  it("does not claim running cancellation succeeded before terminal evidence", () => {
    const f = fixture();
    let task = f.claim(f.create());
    task = f.change(task, { action: "cancel" });
    expect(task.state).toBe("running");
    expect(task.runs[0]!.cancelRequested).toBe(true);
    expect(() => f.claim(f.create("Other task"))).toThrow(/unresolved/);
    task = f.result(task);
    expect(task.state).toBe("canceled");
    expect(task.runs[0]!.state).toBe("completed");
  });

  it("cancels queued work without dispatch and preserves uncertain work", () => {
    const f = fixture();
    const canceled = f.change(f.create(), { action: "cancel" });
    expect(canceled.state).toBe("canceled");
    expect(canceled.runs[0]!.state).toBe("canceled");
    let uncertain = f.result(f.claim(f.create()), { outcome: "unknown" });
    uncertain = f.change(uncertain, { action: "cancel" });
    expect(uncertain.state).toBe("unknown");
  });

  it("keeps live dialing disabled and an unanswered call awaiting input", () => {
    const f = fixture();
    let task = f.verify(
      f.result(f.claim(f.create()), { decision: "Choose empty state." }),
    );
    expect(() =>
      f.change(task, {
        action: "prepare_call",
        callId: "live",
        opening: "Choose empty state.",
        simulated: false,
      }),
    ).toThrow(/disabled/);
    task = f.change(task, {
      action: "prepare_call",
      callId: "sim",
      opening: "Choose empty state.",
      simulated: true,
    });
    task = f.change(task, {
      action: "call_state",
      callId: "sim",
      state: "unanswered",
    });
    expect(task.state).toBe("needs_decision");
    expect(task.runs).toHaveLength(1);
    expect(() =>
      f.change(task, {
        action: "prepare_call",
        callId: "sim",
        opening: "Again.",
        simulated: true,
      }),
    ).toThrow(/already exists/);
  });

  it("rolls back task mutation if its receipt cannot commit", () => {
    const f = fixture();
    const task = f.create();
    const put = f.store.put.bind(f.store);
    f.store.put = ((kind: string, value: { id: string }) => {
      if (kind === "coding-task-event-v1")
        throw new Error("synthetic storage failure");
      return put(kind, value);
    }) as Store["put"];
    expect(() => f.claim(task)).toThrow(/storage failure/);
    expect(f.ledger.get(session.id, task.id)).toEqual(task);
  });

  it("does not let a prior call connection overwrite a new active run", () => {
    const f = fixture();
    let task = f.verify(
      f.result(f.claim(f.create()), { decision: "Choose empty state." }),
    );
    task = f.change(task, {
      action: "prepare_call",
      callId: "late-call",
      opening: "Choose empty state.",
      simulated: true,
    });
    task = f.change(task, {
      action: "decide",
      runId: task.runs[0]!.id,
      instruction: "Clear filters.",
    });
    task = f.claim(task);
    task = f.change(task, {
      action: "call_state",
      callId: "late-call",
      state: "connected",
    });
    expect(task.state).toBe("running");
    expect(() => f.claim(f.create("Another task"))).toThrow(/unresolved/);
    expect(f.result(task).state).toBe("verifying");
  });

  it("retains an unknown call fence after reconciling a worker outcome", () => {
    const f = fixture();
    let task = f.verify(
      f.result(f.claim(f.create()), { decision: "Choose empty state." }),
    );
    task = f.change(task, {
      action: "prepare_call",
      callId: "lost-call",
      opening: "Choose empty state.",
      simulated: true,
    });
    task = f.change(task, {
      action: "call_state",
      callId: "lost-call",
      state: "connected",
    });
    task = f.change(task, {
      action: "decide",
      runId: task.runs[0]!.id,
      instruction: "Clear filters.",
    });
    task = f.claim(task);
    new TaskLedger(f.store, f.vault, () => 1000);
    task = f.ledger.get(session.id, task.id);
    expect(task.call!.state).toBe("unknown");
    task = f.verify(f.result(task));
    expect(task.state).toBe("review_ready");
    expect(() =>
      f.change(task, { action: "accept", runId: task.runs.at(-1)!.id }),
    ).toThrow(/independently/);
    expect(() => f.claim(f.create("Another task"))).toThrow(/unresolved/);
    expect(() =>
      f.change(task, {
        action: "decide",
        runId: task.runs.at(-1)!.id,
        instruction: "Another change",
      }),
    ).toThrow(/unknown/);
    task = f.change(task, { action: "cancel" });
    expect(task.state).toBe("canceled");
    expect(task.calls.some((call) => call.state === "unknown")).toBe(true);
    expect(() => f.claim(f.create("After cancellation"))).toThrow(/unresolved/);
  });

  it("rejects expired or revoked session creation", () => {
    const f = fixture();
    expect(() => f.create("Task", { ...session, expiresAt: 999 })).toThrow(
      /unavailable/,
    );
    expect(() => f.create("Task", { ...session, revokedAt: 500 })).toThrow(
      /unavailable/,
    );
  });
});
