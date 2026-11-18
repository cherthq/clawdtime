import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndependentTaskSession, TaskCommand } from "../src/contracts.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import {
  TaskDesktopCallLedger,
  unresolvedDesktopCallAdmissions,
} from "../src/attention/task-desktop-call-ledger.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
function fixture(persist = false) {
  const directory = mkdtempSync(join(tmpdir(), "clawdtime-call-admission-"));
  const path = join(directory, "state.sqlite");
  const store = new Store(persist ? path : ":memory:"),
    vault = new Vault("ab".repeat(32));
  let now = 100_000,
    sequence = 0;
  const clock = () => now;
  const tasks = new TaskLedger(store, vault, clock);
  const session: IndependentTaskSession = {
    id: "session",
    version: 1,
    pairingId: "pair",
    memberId: "member",
    deviceId: "device",
    hostId: "host",
    projectRoot: "/synthetic-project",
    createdAt: 1,
    expiresAt: 1_000_000,
    permissions: {
      execute: true,
      voice: true,
      presentation: false,
      control: false,
    },
  };
  const calls = new TaskDesktopCallLedger(store, vault, tasks, clock);
  function task(decision = false, sessionId = session.id) {
    let value = tasks.create(
      { ...session, id: sessionId },
      { eventId: `create_${sequence++}`, goal: "Synthetic private result" },
    ).task;
    const change = (command: Record<string, unknown>) => {
      value = tasks.transition(sessionId, value.id, {
        eventId: `change_${sequence++}`,
        expectedRevision: value.revision,
        ...command,
      } as TaskCommand).task;
    };
    const run = value.runs[0]!;
    change({ action: "claim_run", runId: run.id });
    change({
      action: "run_result",
      runId: run.id,
      dispatchId: run.dispatchId,
      outcome: "completed",
      summary: "Synthetic result ready.",
      ...(decision ? { decision: "Which empty state should appear?" } : {}),
    });
    change({
      action: "verify_result",
      verification: {
        id: `verify_${sequence++}`,
        runId: run.id,
        state: "passed",
        completedAt: now,
        checks: [
          {
            name: "Synthetic check",
            command: ["synthetic"],
            state: "passed",
            exitCode: 0,
            summary: "Observed synthetic pass",
          },
        ],
      },
    });
    return value;
  }
  const ready = task();
  const input = {
    eventId: "request",
    taskId: ready.id,
    runId: ready.runs[0]!.id,
    expectedRevision: ready.revision,
    manifestFingerprint: "ab".repeat(32),
    requestFingerprint: "ef".repeat(32),
    authorizationId: "one_call_auth",
    authorizedAt: now,
    expiresAt: now + 300_000,
  };
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    vault,
    tasks,
    calls,
    session,
    ready,
    input,
    clock,
    task,
    path,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("durable desktop call admission", () => {
  it("projects unresolved metadata without restarting or mutating a live owner's receipts", () => {
    const f = fixture(),
      record = f.calls.claim(f.session.id, f.input).record;
    expect(unresolvedDesktopCallAdmissions(f.store, f.vault)).toEqual([
      {
        id: record.id,
        sessionId: record.sessionId,
        taskId: record.taskId,
        attemptId: record.attemptId,
        state: "starting",
      },
    ]);
    expect(f.calls.get(f.session.id, record.id)).toEqual(record);
    f.calls.markActive(record.id);
    expect(unresolvedDesktopCallAdmissions(f.store, f.vault)[0]?.state).toBe(
      "active",
    );
    f.calls.complete(record.id, { cleanupConfirmed: true, outcome: "closed" });
    expect(unresolvedDesktopCallAdmissions(f.store, f.vault)).toEqual([]);
  });

  it("claims the exact prepared review without changing task state and retains one stable attempt", () => {
    const f = fixture();
    const first = f.calls.claim(f.session.id, f.input);
    expect(first.replayed).toBe(false);
    expect(first.record).toMatchObject({
      state: "starting",
      callKind: "review",
      verificationId: f.ready.verification!.id,
      cleanupConfirmed: false,
    });
    expect(first.record.attemptId).toBeTruthy();
    expect(f.tasks.get(f.session.id, f.ready.id)).toEqual(f.ready);
    expect(f.calls.claim(f.session.id, f.input)).toEqual({
      record: first.record,
      replayed: true,
    });
    expect(f.calls.active()).toHaveLength(1);
    expect(f.calls.markActive(first.record.id).state).toBe("active");
    expect(
      f.calls.complete(first.record.id, {
        cleanupConfirmed: true,
        outcome: "closed",
      }).cleanupConfirmed,
    ).toBe(true);
    f.setNow(f.input.expiresAt + 1);
    const replay = f.calls.claim(f.session.id, f.input);
    expect(replay).toMatchObject({
      replayed: true,
      record: { state: "closed", attemptId: first.record.attemptId },
    });
    expect(f.calls.active()).toEqual([]);
    expect(f.calls.unresolved()).toEqual([]);
  });

  it("admits a known verified decision without inventing a review or selecting an answer", () => {
    const f = fixture(),
      task = f.task(true);
    const record = f.calls.claim(f.session.id, {
      ...f.input,
      taskId: task.id,
      runId: task.runs[0]!.id,
      expectedRevision: task.revision,
    }).record;
    expect(record.callKind).toBe("decision");
    expect(f.tasks.get(f.session.id, task.id).decision?.answer).toBeUndefined();
    expect(f.tasks.get(f.session.id, task.id).runs).toHaveLength(1);
  });

  it.each(["starting", "active"] as const)(
    "turns restarted %s into unknown and blocks late owner settlement or fresh admission",
    (state) => {
      const f = fixture(),
        original = f.calls.claim(f.session.id, f.input).record;
      if (state === "active") f.calls.markActive(original.id);
      const restarted = new TaskDesktopCallLedger(
        f.store,
        f.vault,
        f.tasks,
        f.clock,
      );
      expect(restarted.active()).toEqual([]);
      expect(restarted.unresolved()).toMatchObject([
        { id: original.id, state: "unknown", attemptId: original.attemptId },
      ]);
      expect(restarted.claim(f.session.id, f.input)).toMatchObject({
        replayed: true,
        record: { state: "unknown" },
      });
      for (const ledger of [f.calls, restarted]) {
        expect(() => ledger.markActive(original.id)).toThrow();
        expect(() =>
          ledger.complete(original.id, {
            cleanupConfirmed: true,
            outcome: "closed",
          }),
        ).toThrow();
        expect(() =>
          ledger.claim(f.session.id, {
            ...f.input,
            eventId: "new",
            authorizationId: "new_auth",
          }),
        ).toThrow(/unresolved/);
      }
    },
  );

  it("retains uncertain cleanup and never silently retries or clears it", () => {
    const f = fixture(),
      record = f.calls.claim(f.session.id, f.input).record;
    expect(() =>
      f.calls.complete(record.id, {
        cleanupConfirmed: false,
        outcome: "failed",
      } as never),
    ).toThrow(/cleanup/);
    expect(f.calls.markUnknown(record.id)).toMatchObject({
      state: "unknown",
      cleanupConfirmed: false,
    });
    expect(() =>
      f.calls.complete(record.id, {
        cleanupConfirmed: true,
        outcome: "failed",
      }),
    ).toThrow(/reconciliation/);
    expect(f.calls.claim(f.session.id, f.input).replayed).toBe(true);
  });

  it("keeps authorization IDs globally consumed after confirmed failure and rejects event conflicts", () => {
    const f = fixture(),
      record = f.calls.claim(f.session.id, f.input).record;
    expect(() =>
      f.calls.claim(f.session.id, {
        ...f.input,
        manifestFingerprint: "cd".repeat(32),
      }),
    ).toThrow(/conflicts/);
    expect(() =>
      f.calls.claim(f.session.id, {
        ...f.input,
        requestFingerprint: "12".repeat(32),
      }),
    ).toThrow(/conflicts/);
    f.calls.complete(record.id, { cleanupConfirmed: true, outcome: "failed" });
    expect(() =>
      f.calls.claim(f.session.id, { ...f.input, eventId: "different" }),
    ).toThrow(/consumed/);
    const other = f.task(false, "other_session");
    expect(() =>
      f.calls.claim("other_session", {
        ...f.input,
        taskId: other.id,
        runId: other.runs[0]!.id,
        expectedRevision: other.revision,
      }),
    ).toThrow(/consumed/);
    const next = f.calls.claim(f.session.id, {
      ...f.input,
      eventId: "explicit_new_attempt",
      authorizationId: "fresh_authorization",
    });
    expect(next.record.attemptId).not.toBe(record.attemptId);
  });

  it("enforces session isolation and a single global unresolved admission", () => {
    const f = fixture(),
      record = f.calls.claim(f.session.id, f.input).record;
    expect(f.calls.list("foreign")).toEqual([]);
    expect(() => f.calls.get("foreign", record.id)).toThrow(/unavailable/);
    expect(() =>
      f.calls.claim("foreign", { ...f.input, authorizationId: "foreign_auth" }),
    ).toThrow(/unresolved/);
    f.calls.complete(record.id, { cleanupConfirmed: true, outcome: "closed" });
    expect(() =>
      f.calls.claim("foreign", { ...f.input, authorizationId: "foreign_auth" }),
    ).toThrow();
  });

  it.each([
    { expectedRevision: 0 },
    { runId: "old_run" },
    { authorizedAt: 100_001 },
    { expiresAt: 100_000 },
    { expiresAt: 400_001 },
    { authorizedAt: NaN },
    { manifestFingerprint: "invalid" },
    { requestFingerprint: "invalid" },
  ])(
    "refuses stale or malformed admission %j before creating a receipt",
    (override) => {
      const f = fixture();
      expect(() =>
        f.calls.claim(f.session.id, { ...f.input, ...override }),
      ).toThrow();
      expect(f.calls.list(f.session.id)).toEqual([]);
    },
  );

  it.each(["accept", "cancel", "decide"] as const)(
    "refuses preparation after task %s changes the exact result",
    (action) => {
      const f = fixture();
      const task = f.tasks.transition(f.session.id, f.ready.id, {
        eventId: "change_after_prepare",
        expectedRevision: f.ready.revision,
        runId: f.input.runId,
        action,
        ...(action === "decide" ? { instruction: "Make another change" } : {}),
      } as TaskCommand).task;
      expect(() => f.calls.claim(f.session.id, f.input)).toThrow();
      expect(() =>
        f.calls.claim(f.session.id, {
          ...f.input,
          expectedRevision: task.revision,
          runId: task.runs.at(-1)!.id,
        }),
      ).toThrow();
      expect(f.calls.unresolved()).toEqual([]);
    },
  );

  it("stores admission binding only inside encrypted envelopes", () => {
    const f = fixture(true);
    f.calls.claim(f.session.id, {
      ...f.input,
      eventId: "private_event_marker",
      authorizationId: "private_authorization_marker",
    });
    const rows = JSON.stringify(f.store.all("coding-desktop-call-v1"));
    expect(rows).toContain("ciphertext");
    expect(rows).not.toContain("private_event_marker");
    expect(rows).not.toContain(f.ready.id);
    const bytes = readFileSync(f.path).toString("utf8");
    expect(bytes).not.toContain("private_authorization_marker");
    expect(bytes).not.toContain("Synthetic private result");
  });
});
