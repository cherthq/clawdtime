import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundRecovery } from "../src/control/background-recovery.js";
import {
  BackgroundRuntime,
  type BackgroundTaskRecord,
  type BackgroundTaskWorker,
} from "../src/control/background-runtime.js";
import { Store } from "../src/storage/store.js";
import { hash, Vault } from "../src/storage/security.js";
import { ProtectedTaskStore } from "../src/storage/task-store.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const authority = {
  callId: "fixture-call",
  toolCallId: "fixture-tool",
  isLive: () => true,
};
const goal = "Prepare fixture unsent draft";
function fixture() {
  const store = new Store(),
    vault = new Vault("8".repeat(64));
  cleanup.push(async () => store.close());
  return {
    store,
    vault,
    recovery: new BackgroundRecovery(store, vault),
    records: new ProtectedTaskStore<BackgroundTaskRecord>(
      store,
      vault,
      "background-cua-task-v1",
    ),
  };
}
function original(): BackgroundTaskRecord {
  return {
    id: "fixture-task",
    sessionId: "fixture-session",
    fingerprint: hash(
      JSON.stringify([goal, authority.callId, authority.toolCallId]),
    ),
    goal,
    state: "uncertain",
    expiresAt: Date.now() + 30_000,
    message: "Unknown native navigation",
    actions: [
      {
        id: "launch",
        operation: "qualified_launch",
        applicationBundleId: "com.openai.codex",
        fingerprint: "1".repeat(64),
        state: "verified",
      },
      {
        id: "navigation",
        operation: "codex_new_chat_navigation",
        applicationBundleId: "com.openai.codex",
        fingerprint: "2".repeat(64),
        state: "unknown",
      },
    ],
  };
}
function helper(record: BackgroundTaskRecord) {
  const binding = {
    fingerprint: "3".repeat(64),
    driverGeneration: "fixture-generation",
    driverPid: 77,
    driverProcessStart: "4".repeat(64),
  };
  const action = record.actions.find(
    (a) => a.operation === "codex_new_chat_navigation",
  )!;
  return {
    state: "retired_unknown_navigation",
    reservation: { id: "fixture-controller", ...binding },
    lease: { taskId: record.id, sessionId: record.sessionId },
    resolution: null,
    retirement: {
      ...binding,
      driverQuiescent: true,
      observationId: "fixture-quiescence",
      observedAt: new Date().toISOString(),
      evidence: {
        kind: "codex_new_chat_navigation",
        taskId: record.id,
        sessionId: record.sessionId,
        actionReceiptId: action.id,
        actionFingerprint: action.fingerprint,
        originalOutcome: "unknown",
        noReplay: true,
        noTextOrSubmissionDispatched: true,
      },
    },
  };
}
describe("operator-directed unknown navigation retirement", () => {
  it("persists trusted action classes before dispatch and can retire the actual final runtime receipt", async () => {
    const f = fixture();
    const runtime = new BackgroundRuntime(f.store, f.vault, () => ({
      run: async (_goal, context) => {
        const launch = context.reserve({
          workflow: "codex-draft",
          operation: "launch_app",
          bundleId: "com.openai.codex",
        });
        expect(f.records.get(context.taskId)?.actions[0]?.operation).toBe(
          "qualified_launch",
        );
        context.returned(launch, "returned");
        context.verified(launch);
        const nav = context.reserve({
          workflow: "codex-draft",
          operation: "codex_new_chat_navigation",
          binding: { bundleId: "com.openai.codex" },
          action: { type: "click-element", elementToken: "fixture-new-chat" },
        });
        expect(f.records.get(context.taskId)?.actions[1]?.operation).toBe(
          "codex_new_chat_navigation",
        );
        context.returned(nav, "returned");
        throw Error("Post-navigation observation did not verify");
      },
      stop() {},
      close: async () => ({ quiescence: "unknown" }),
    }));
    cleanup.push(() => runtime.close());
    await runtime.submit("actual-task", goal, authority);
    await runtime.waitForIdle();
    const record = f.records.get("actual-task")!;
    expect(record.state).toBe("uncertain");
    expect(
      record.actions.map((a) => [a.operation, a.applicationBundleId, a.state]),
    ).toEqual([
      ["qualified_launch", "com.openai.codex", "verified"],
      ["codex_new_chat_navigation", "com.openai.codex", "unknown"],
    ]);
    f.recovery.record(record, helper(record));
    expect(f.recovery.retired(record)).toBe(true);
    expect(f.records.get(record.id)).toEqual(record);
  });
  it("links the exact helper retirement without rewriting the original unknown record or exposing content", () => {
    const f = fixture(),
      record = original(),
      receipt = helper(record),
      before = JSON.stringify(record);
    f.records.put(record);
    f.recovery.record(record, receipt);
    f.recovery.record(record, receipt);
    expect(f.recovery.retired(record)).toBe(true);
    expect(JSON.stringify(record)).toBe(before);
    expect(f.records.get(record.id)).toEqual(record);
    expect(
      JSON.stringify(f.store.all("background-navigation-retirement-v1")),
    ).not.toContain("codex_new_chat_navigation");
  });
  it.each([
    "missing",
    "other",
    "text",
    "unclassified",
    "extra_launch",
    "reordered",
    "launch_unverified",
    "navigation_returned",
    "duplicate_id",
    "wrong_app",
    "missing_app",
  ])("refuses an incomplete or broader action manifest: %s", (kind) => {
    const f = fixture(),
      record = original(),
      receipt = helper(record);
    if (kind === "missing") record.actions.shift();
    if (kind === "other" || kind === "text")
      record.actions.push({
        id: kind,
        operation: "other",
        fingerprint: "5".repeat(64),
        state: "unknown",
      });
    if (kind === "unclassified") delete record.actions[1]!.operation;
    if (kind === "extra_launch")
      record.actions.unshift({ ...record.actions[0]!, id: "another-launch" });
    if (kind === "reordered") record.actions.reverse();
    if (kind === "launch_unverified") record.actions[0]!.state = "returned";
    if (kind === "navigation_returned") record.actions[1]!.state = "returned";
    if (kind === "duplicate_id") record.actions[0]!.id = record.actions[1]!.id;
    if (kind === "wrong_app")
      record.actions[0]!.applicationBundleId = "com.apple.MobileSMS";
    if (kind === "missing_app") delete record.actions[1]!.applicationBundleId;
    expect(() => f.recovery.record(record, receipt)).toThrow();
    expect(f.recovery.retired(record)).toBe(false);
  });
  it.each([
    "task",
    "session",
    "action",
    "fingerprint",
    "driver",
    "quiescence",
    "replay",
    "text",
    "outcome",
    "resolution",
  ])("rejects mismatched or insufficient helper evidence: %s", (field) => {
    const f = fixture(),
      record = original(),
      receipt: any = helper(record);
    if (field === "task") receipt.lease.taskId = "other-task";
    if (field === "session")
      receipt.retirement.evidence.sessionId = "other-session";
    if (field === "action")
      receipt.retirement.evidence.actionReceiptId = "other-action";
    if (field === "fingerprint")
      receipt.retirement.evidence.actionFingerprint = "6".repeat(64);
    if (field === "driver")
      receipt.retirement.driverGeneration = "other-generation";
    if (field === "quiescence") receipt.retirement.driverQuiescent = false;
    if (field === "replay") receipt.retirement.evidence.noReplay = false;
    if (field === "text")
      receipt.retirement.evidence.noTextOrSubmissionDispatched = false;
    if (field === "outcome")
      receipt.retirement.evidence.originalOutcome = "verified";
    if (field === "resolution")
      receipt.resolution = { outcome: "not_dispatched" };
    expect(() => f.recovery.record(record, receipt)).toThrow();
  });
  it("refuses changed originals and conflicting replacement evidence", () => {
    const f = fixture(),
      record = original(),
      receipt = helper(record);
    f.recovery.record(record, receipt);
    for (const changed of [
      { ...record, message: "Changed" },
      { ...record, sessionId: "changed-session" },
      {
        ...record,
        actions: [
          ...record.actions,
          {
            id: "later",
            fingerprint: "7".repeat(64),
            operation: "other" as const,
            state: "unknown" as const,
          },
        ],
      },
    ])
      expect(f.recovery.retired(changed)).toBe(false);
    receipt.retirement.observationId = "different-evidence";
    expect(() => f.recovery.record(record, receipt)).toThrow("conflicts");
  });
  it("preserves original replay refusal while allowing fresh work after retirement, including restart", async () => {
    const f = fixture(),
      record = original();
    f.records.put(record);
    const create = vi.fn((): BackgroundTaskWorker => ({
      run: async () => ({
        verified: true,
        summary: "Read-only fixture verified",
      }),
      stop() {},
      close: async () => ({ quiescence: "known" }),
    }));
    const runtime = new BackgroundRuntime(f.store, f.vault, create);
    cleanup.push(() => runtime.close());
    await runtime.submit("blocked-before", "Read fixture", authority);
    expect(runtime.snapshot("blocked-before").state).toBe("blocked");
    f.recovery.record(record, helper(record));
    await runtime.submit(record.id, goal, authority);
    expect(create).not.toHaveBeenCalled();
    expect(runtime.snapshot(record.id).state).toBe("uncertain");
    expect(runtime.snapshot(record.id).message).toContain("unknown");
    await runtime.submit("fresh-task", "Read fixture", authority);
    await runtime.waitForIdle();
    expect(runtime.snapshot("fresh-task").state).toBe("completed");
    await runtime.close();
    const restarted = new BackgroundRuntime(f.store, f.vault, create);
    cleanup.push(() => restarted.close());
    expect(f.records.get(record.id)).toEqual(record);
    await restarted.submit(record.id, goal, authority);
    expect(create).toHaveBeenCalledTimes(1);
    await restarted.submit("after-restart", "Read fixture", authority);
    await restarted.waitForIdle();
    expect(restarted.snapshot("after-restart").state).toBe("completed");
    expect(create).toHaveBeenCalledTimes(2);
  });
});
