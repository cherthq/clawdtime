import { afterEach, describe, expect, it, vi } from "vitest";
import type { IndependentTaskSession, TaskCommand } from "../src/contracts.js";
import { Store } from "../src/storage/store.js";
import { Vault, hash } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import {
  TaskPresentationLedger,
  taskPresentationFingerprint,
  unresolvedTaskPresentations,
} from "../src/attention/task-presentation-ledger.js";
import type {
  TaskPresentationManifest,
  TaskSceneFrame,
  TaskPresentationRecord,
  TaskPresentationCaptureBinding,
} from "../src/task-presentation-contracts.js";
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
});
const cleanup = {
  captureStopped: true,
  narrationStopped: true,
  outputCleared: true,
  childrenJoined: true,
} as const;
function fixture() {
  let now = 10000;
  const clock = () => now,
    store = new Store();
  stores.push(store);
  const vault = new Vault("ab".repeat(32)),
    tasks = new TaskLedger(store, vault, clock),
    ledger = new TaskPresentationLedger(store, vault, tasks, clock);
  const session: IndependentTaskSession = {
    id: "session",
    version: 1,
    pairingId: "pair",
    memberId: "member",
    deviceId: "device",
    hostId: "host",
    projectRoot: "/fixture",
    createdAt: now,
    expiresAt: now + 100000,
    permissions: {
      execute: true,
      voice: true,
      presentation: false,
      control: false,
    },
  };
  let task = tasks.create(session, {
      eventId: "create",
      goal: "Add filter",
    }).task,
    seq = 0;
  const change = (command: Record<string, unknown>) =>
    (task = tasks.transition(session.id, task.id, {
      eventId: `event_${seq++}`,
      expectedRevision: task.revision,
      ...command,
    } as TaskCommand).task);
  change({ action: "claim_run", runId: task.runs[0]!.id });
  change({
    action: "run_result",
    runId: task.runs[0]!.id,
    dispatchId: task.runs[0]!.dispatchId,
    outcome: "completed",
    summary: "The filter works.",
  });
  change({
    action: "verify_result",
    verification: {
      id: "verification",
      runId: task.runs[0]!.id,
      state: "passed",
      completedAt: now,
      checks: [
        {
          name: "tests",
          command: ["node", "--test"],
          state: "passed",
          exitCode: 0,
          summary: "passed",
        },
      ],
    },
  });
  const manifest: TaskPresentationManifest = {
    version: 1,
    id: "presentation",
    sessionId: session.id,
    taskId: task.id,
    runId: task.runs[0]!.id,
    taskRevision: task.revision,
    verificationId: task.verification!.id,
    kind: "review",
    opening: task.brief!.opening,
    fps: 15,
    scenes: [
      {
        id: "code",
        kind: "code",
        title: "Filter code",
        narration: task.brief!.opening,
        expectedOutcome: "The filter implementation is visible.",
        target: {
          appId: "com.example.editor",
          windowId: "42",
          ownerPid: 123,
          processIdentity: hash("process"),
          displayId: 1,
          titleHash: hash("private title"),
        },
        focus: { x: 0, y: 0, width: 1, height: 1 },
        transitionMs: 550,
      },
    ],
  };
  const grant = {
    version: 1 as const,
    id: "grant",
    manifestFingerprint: taskPresentationFingerprint(manifest),
    sessionId: session.id,
    taskId: task.id,
    runId: manifest.runId,
    taskRevision: task.revision,
    hostId: session.hostId,
    authorizedAt: now,
    expiresAt: now + 90000,
    localOnly: true as const,
    capture: true as const,
    presentation: true as const,
    control: false as const,
    nativeActivation: false as const,
    calls: false as const,
  };
  const prepare = () =>
    ledger.prepare(session, { eventId: "prepare", manifest, grant });
  const claim = (record: TaskPresentationRecord, eventId = "show") =>
    ledger.claim(record.id, {
      eventId,
      action: "show_scene",
      sceneId: "code",
      expectedGeneration: record.generation,
    });
  const frame = (
    record: TaskPresentationRecord,
    operationId = "show",
  ): TaskSceneFrame => ({
    presentationId: record.id,
    manifestFingerprint: record.fingerprint,
    operationId,
    sceneId: "code",
    generation: record.generation,
    target: manifest.scenes[0]!.target,
    sourceFrameId: `frame_${now}`,
    geometryGeneration: "geometry",
    contentRevision: hash("pixels"),
    capturedAt: now,
    renderedAt: now,
    transitionCompletedAt: now,
    evidence: "local_frame_rendered_not_human_seen",
  });
  const visible = () => {
    const p = claim(prepare().presentation).presentation;
    return ledger.settle(p.id, "show", { state: "done", frame: frame(p) });
  };
  return {
    store,
    vault,
    tasks,
    ledger,
    session,
    manifest,
    grant,
    clock,
    prepare,
    claim,
    frame,
    visible,
    change,
    task: () => task,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe("independent task presentation ledger", () => {
  function continuousFixture() {
    const f = fixture();
    f.manifest.scenes.push({
      ...structuredClone(f.manifest.scenes[0]!),
      id: "preview",
      kind: "preview",
      target: { ...f.manifest.scenes[0]!.target, windowId: "43" },
    });
    const grant = {
      ...f.grant,
      continuity: "call" as const,
      manifestFingerprint: taskPresentationFingerprint(f.manifest),
    };
    const binding: TaskPresentationCaptureBinding = {
      callAttemptId: "call_attempt",
      voiceSessionId: "voice",
      exportGrantId: "export",
      planFingerprint: hash("exact_call_plan"),
      expiresAt: grant.expiresAt,
    };
    let allowed = true;
    const authorize = vi.fn(
      (
        record: TaskPresentationRecord,
        current: TaskPresentationCaptureBinding,
      ) => {
        expect(record.id).toBe(f.manifest.id);
        expect(current).toEqual(binding);
        if (!allowed) throw Error("Exact ongoing capture authority revoked");
      },
    );
    const ledger = new TaskPresentationLedger(
      f.store,
      f.vault,
      f.tasks,
      f.clock,
      authorize,
    );
    const input = { eventId: "prepare", manifest: f.manifest, grant };
    const prepare = () => ledger.prepare(f.session, input, binding);
    const show = (
      record: TaskPresentationRecord,
      eventId: string,
      sceneId = "code",
    ) => {
      const claimed = ledger.claim(record.id, {
        eventId,
        action: "show_scene",
        sceneId,
        expectedGeneration: record.generation,
      }).presentation;
      return ledger.settle(record.id, eventId, {
        state: "done",
        frame: {
          ...f.frame(claimed, eventId),
          sceneId,
          target: f.manifest.scenes.find((scene) => scene.id === sceneId)!
            .target,
        },
      });
    };
    return {
      ...f,
      ledger,
      grant,
      binding,
      input,
      prepare,
      show,
      authorize,
      revoke: () => {
        allowed = false;
      },
    };
  }

  it("retains explicit same-call live capture across new runs and switches only prepared targets", () => {
    const f = continuousFixture();
    const originalTask = f.task();
    let record = f.show(f.prepare().presentation, "initial");
    const originalFingerprint = record.fingerprint;
    f.change({
      action: "decide",
      runId: originalTask.runs[0]!.id,
      instruction: "Update the filter copy",
    });
    f.change({ action: "claim_run", runId: f.task().runs.at(-1)!.id });
    record = f.show(record, "live_preview", "preview");
    expect(record.state).toBe("visible");
    expect(record.generation).toBe(2);
    expect(record.activeSceneId).toBe("preview");
    expect(record.fingerprint).toBe(originalFingerprint);
    expect(record.manifest.taskRevision).toBe(originalTask.revision);
    expect(record.captureBinding).toEqual(f.binding);
    expect(f.task().state).toBe("running");
    expect(() =>
      f.ledger.claim(record.id, {
        eventId: "unknown_scene",
        expectedGeneration: record.generation,
        action: "show_scene",
        sceneId: "unprepared_window",
      }),
    ).toThrow(/Unknown exact/);
    expect(() =>
      f.ledger.claim(record.id, {
        eventId: "old_narration",
        expectedGeneration: record.generation,
        action: "narrate",
        sceneId: "preview",
        frame: record.frame,
      }),
    ).toThrow(/current verified/);
  });

  it("settles and keeps live capture after acceptance without treating historical narration as current", () => {
    const f = continuousFixture();
    const prepared = f.prepare().presentation;
    const claimed = f.ledger.claim(prepared.id, {
      eventId: "show",
      action: "show_scene",
      sceneId: "code",
      expectedGeneration: 0,
    }).presentation;
    f.change({ action: "accept", runId: f.task().runs[0]!.id });
    const visible = f.ledger.settle(prepared.id, "show", {
      state: "done",
      frame: f.frame(claimed),
    });
    expect(visible.state).toBe("visible");
    expect(f.show(visible, "accepted_preview", "preview").state).toBe(
      "visible",
    );
    expect(f.task().state).toBe("accepted");
    expect(f.task().runs).toHaveLength(1);
    expect(() =>
      f.ledger.claim(visible.id, {
        eventId: "old_narration",
        expectedGeneration: 2,
        action: "narrate",
        sceneId: "preview",
        frame: visible.frame,
      }),
    ).toThrow(/current verified/);
  });

  it("requires explicit continuity and trusted binding and still prepares only the exact current result", () => {
    const f = continuousFixture();
    expect(() => f.ledger.prepare(f.session, f.input)).toThrow(/call-scoped/);
    expect(() =>
      f.ledger.prepare(
        f.session,
        { ...f.input, grant: f.grant },
        { ...f.binding, planFingerprint: "invalid" },
      ),
    ).toThrow();
    expect(() =>
      f.ledger.prepare(
        f.session,
        { ...f.input, grant: { ...f.grant, continuity: undefined } },
        f.binding,
      ),
    ).toThrow(/call-scoped/);
    const originalRun = f.task().runs[0]!.id;
    f.change({ action: "accept", runId: originalRun });
    expect(() => f.prepare()).toThrow(/current verified/);
  });

  it("binds continuity to the original prepare receipt and refuses replay upgrades", () => {
    const f = continuousFixture(),
      record = f.prepare().presentation;
    expect(f.prepare().replayed).toBe(true);
    expect(() =>
      f.ledger.prepare(f.session, f.input, {
        ...f.binding,
        callAttemptId: "another_call",
      }),
    ).toThrow(/conflicts/);
    expect(f.ledger.get(f.session.id, record.id).captureBinding).toEqual(
      f.binding,
    );
  });

  it("uses persisted capture authority and expires it without caller override", () => {
    const f = continuousFixture();
    f.binding.expiresAt = f.clock() + 10;
    const record = f.prepare().presentation;
    expect(() => f.ledger.assertCapture(record)).not.toThrow();
    f.advance(11);
    expect(() =>
      f.ledger.assertCapture({
        ...record,
        captureBinding: { ...f.binding, expiresAt: f.grant.expiresAt },
      }),
    ).toThrow(/expired/);
    expect(() => f.show(record, "expired_show")).toThrow(/expired/);
    expect(f.ledger.get(f.session.id, record.id).effects).toHaveLength(0);
  });

  it("cannot continue persisted call capture without the same runtime's trusted authorizer", () => {
    const f = continuousFixture(),
      record = f.prepare().presentation;
    const unconfigured = new TaskPresentationLedger(
      f.store,
      f.vault,
      f.tasks,
      f.clock,
    );
    expect(() => unconfigured.assertCapture(record)).toThrow(
      /authority is unavailable/,
    );
    expect(() =>
      unconfigured.claim(record.id, {
        eventId: "unconfigured_show",
        expectedGeneration: 0,
        sceneId: "code",
        action: "show_scene",
      }),
    ).toThrow(/authority is unavailable/);
  });

  it("revalidates ongoing authority on show settlement and retains explicit Stop and restart fences", () => {
    const f = continuousFixture(),
      prepared = f.prepare().presentation;
    const claimed = f.ledger.claim(prepared.id, {
      eventId: "show",
      action: "show_scene",
      sceneId: "code",
      expectedGeneration: 0,
    }).presentation;
    f.revoke();
    expect(() =>
      f.ledger.settle(prepared.id, "show", {
        state: "done",
        frame: f.frame(claimed),
      }),
    ).toThrow(/revoked/);
    expect(f.ledger.get(f.session.id, prepared.id).effects[0]!.state).toBe(
      "running",
    );
    const restarted = new TaskPresentationLedger(
      f.store,
      f.vault,
      f.tasks,
      f.clock,
      () => {},
    );
    expect(restarted.get(f.session.id, prepared.id).state).toBe("unknown");
    expect(() =>
      restarted.claim(prepared.id, {
        eventId: "retry",
        action: "show_scene",
        sceneId: "code",
        expectedGeneration: 1,
      }),
    ).toThrow(/unresolved/);
    restarted.stop(prepared.id, "explicit_stop");
    const stop = restarted.claim(prepared.id, {
      eventId: "cleanup",
      action: "stop",
      expectedGeneration: 2,
    });
    restarted.settle(prepared.id, stop.receipt.id, { state: "done", cleanup });
    expect(() =>
      restarted.claim(prepared.id, {
        eventId: "after_stop",
        action: "show_scene",
        sceneId: "code",
        expectedGeneration: 2,
      }),
    ).toThrow(/stopped/);
  });

  it("binds immutable verified task manifests and encrypts narration/targets", () => {
    const f = fixture(),
      p = f.prepare();
    expect(p.presentation.id).toBe(f.manifest.id);
    expect(f.prepare().replayed).toBe(true);
    expect(() => f.ledger.get("other", p.presentation.id)).toThrow();
    expect(() =>
      f.ledger.prepare(f.session, {
        eventId: "prepare",
        manifest: {
          ...f.manifest,
          opening: "different",
          scenes: f.manifest.scenes.map((scene, i) =>
            i === 0 ? { ...scene, narration: "different" } : scene,
          ),
        },
        grant: f.grant,
      }),
    ).toThrow(/conflicts/);
    const stored = JSON.stringify(f.store.query("SELECT * FROM entities"));
    expect(stored).not.toContain(f.manifest.opening);
    expect(stored).not.toContain("com.example.editor");
  });
  it("binds a bounded overview crop into the immutable presentation grant", () => {
    const f = fixture(),
      scene = f.manifest.scenes[0]!;
    const original = taskPresentationFingerprint(f.manifest);
    scene.overview = { x: 0.125, y: 0.25, width: 0.75, height: 0.5 };
    scene.focus = { x: 0.25, y: 0.375, width: 0.5, height: 0.25 };
    const cropped = taskPresentationFingerprint(f.manifest);
    expect(cropped).not.toBe(original);
    expect(() => f.prepare()).toThrow(/grant/);
    f.grant.manifestFingerprint = cropped;
    expect(f.prepare().presentation.manifest.scenes[0]!.overview).toEqual(
      scene.overview,
    );
    scene.overview = { x: 0, y: 0.25, width: 1, height: 0.5 };
    expect(() => f.prepare()).toThrow(/conflicts/);
  });
  it.each([
    { x: 0, y: 0.25, width: 0.5, height: 0.5 },
    { x: 0.25, y: 0, width: 0.5, height: 0.5 },
    { x: 0.25, y: 0.25, width: 0.75, height: 0.5 },
    { x: 0.25, y: 0.25, width: 0.5, height: 0.75 },
  ])("rejects a focus region escaping its prepared overview %j", (focus) => {
    const f = fixture();
    f.manifest.scenes[0]!.overview = {
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    };
    f.manifest.scenes[0]!.focus = focus;
    expect(() => f.prepare()).toThrow(/inside its prepared overview/);
    expect(f.ledger.unresolved()).toHaveLength(0);
  });

  it("binds annotation geometry and label without changing an omitted-annotation fingerprint", () => {
    const f = fixture(),
      scene = f.manifest.scenes[0]!;
    const original = taskPresentationFingerprint(f.manifest);
    scene.annotation = {
      rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      label: "Filter matches",
    };
    const annotated = taskPresentationFingerprint(f.manifest);
    expect(annotated).not.toBe(original);
    delete scene.annotation;
    expect(taskPresentationFingerprint(f.manifest)).toBe(original);
    scene.annotation = {
      rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      label: "Filter matches",
    };
    expect(() => f.prepare()).toThrow(/grant/);
    f.grant.manifestFingerprint = annotated;
    expect(f.prepare().presentation.manifest.scenes[0]!.annotation).toEqual(
      scene.annotation,
    );
    scene.annotation.label = "Changed label";
    expect(taskPresentationFingerprint(f.manifest)).not.toBe(annotated);
    expect(() => f.prepare()).toThrow(/conflicts/);
  });
  it.each([
    { x: 0.125, y: 0.25, width: 0.25, height: 0.25 },
    { x: 0.25, y: 0.125, width: 0.25, height: 0.25 },
    { x: 0.625, y: 0.25, width: 0.25, height: 0.25 },
    { x: 0.25, y: 0.625, width: 0.25, height: 0.25 },
  ])("refuses an annotation escaping its focus region %j", (rect) => {
    const f = fixture(),
      scene = f.manifest.scenes[0]!;
    scene.focus = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    scene.annotation = { rect, label: "Relevant code" };
    expect(() => f.prepare()).toThrow(/annotation.*focus/i);
    expect(f.ledger.unresolved()).toHaveLength(0);
  });
  it.each([
    "",
    "   ",
    "x".repeat(101),
    "private\u0000label",
    "private\u001flabel",
  ])("rejects invalid annotation label %j", (label) => {
    const f = fixture();
    f.manifest.scenes[0]!.annotation = {
      rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      label,
    };
    expect(() => f.prepare()).toThrow();
    expect(f.ledger.unresolved()).toHaveLength(0);
  });
  it.each(["annotation", "rect"])(
    "refuses unrecognized %s fields before admission",
    (level) => {
      const f = fixture(),
        annotation = {
          rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
          label: "Matches",
        };
      Object.assign(level === "annotation" ? annotation : annotation.rect, {
        untrustedExtra: "not authorized",
      });
      f.manifest.scenes[0]!.annotation = annotation;
      expect(() => f.prepare()).toThrow();
      expect(f.ledger.unresolved()).toHaveLength(0);
    },
  );

  it("refuses setup chatter before the exact prepared task opening", () => {
    const f = fixture();
    f.manifest.scenes[0]!.narration = "Let me set up the windows.";
    expect(() => f.prepare()).toThrow(/first scene/);
    expect(f.ledger.unresolved()).toHaveLength(0);
  });

  it("rejects stale task, forged opening, mismatched host and grant fingerprint", () => {
    for (const kind of ["task", "opening", "host", "fingerprint"]) {
      const f = fixture();
      if (kind === "task")
        f.change({
          action: "decide",
          runId: f.manifest.runId,
          instruction: "Change result",
        });
      if (kind === "opening") {
        f.manifest.opening = "Forged claim";
        f.manifest.scenes[0]!.narration = f.manifest.opening;
        f.grant.manifestFingerprint = taskPresentationFingerprint(f.manifest);
      }
      if (kind === "host") f.grant.hostId = "other";
      if (kind === "fingerprint") f.grant.manifestFingerprint = hash("wrong");
      expect(() => f.prepare()).toThrow();
    }
  });
  it("claims before external work, rejects conflicting duplicates and stale generations", () => {
    const f = fixture(),
      prepared = f.prepare().presentation,
      claim = f.claim(prepared);
    expect(claim.receipt.state).toBe("running");
    expect(claim.presentation.generation).toBe(1);
    expect(f.claim(prepared).replayed).toBe(true);
    expect(() =>
      f.ledger.claim(prepared.id, {
        eventId: "show",
        expectedGeneration: 0,
        action: "show_scene",
        sceneId: "other",
      }),
    ).toThrow(/conflicts/);
    expect(() => f.claim(prepared, "another")).toThrow(/stale/);
    expect(() => f.claim(claim.presentation, "parallel")).toThrow(/unresolved/);
  });
  it("narrates only a fresh frame of the verified visible scene, including dynamic pixels", () => {
    const f = fixture();
    const p = f.visible();
    f.advance(3000);
    const refreshed = {
      ...f.frame(p),
      contentRevision: hash("updated dynamic pixels"),
      transitionCompletedAt: 10000,
    };
    const result = f.ledger.claim(p.id, {
      eventId: "speech",
      expectedGeneration: p.generation,
      action: "narrate",
      sceneId: "code",
      frame: refreshed,
    });
    expect(result.receipt.generation).toBe(p.generation);
    expect(f.ledger.settle(p.id, "speech", { state: "done" }).state).toBe(
      "visible",
    );
    expect(f.ledger.settle(p.id, "speech", { state: "done" }).state).toBe(
      "visible",
    );
  });
  it.each(["stale", "target", "operation", "geometry", "before_transition"])(
    "refuses %s narration evidence",
    (kind) => {
      const f = fixture(),
        p = f.visible(),
        frame = f.frame(p);
      if (kind === "stale") f.advance(2001);
      if (kind === "target") frame.target = { ...frame.target, ownerPid: 124 };
      if (kind === "operation") frame.operationId = "foreign";
      if (kind === "geometry") frame.geometryGeneration = "changed";
      if (kind === "before_transition") frame.transitionCompletedAt++;
      expect(() =>
        f.ledger.claim(p.id, {
          eventId: "speech",
          expectedGeneration: p.generation,
          action: "narrate",
          sceneId: "code",
          frame,
        }),
      ).toThrow();
    },
  );
  it("does not block a new scoped coding run but refuses stale presentation admission", () => {
    const f = fixture(),
      p = f.visible();
    f.change({
      action: "decide",
      runId: f.manifest.runId,
      instruction: "Revise filter",
    });
    f.change({ action: "claim_run", runId: f.task().runs.at(-1)!.id });
    expect(f.task().state).toBe("running");
    expect(() =>
      f.ledger.claim(p.id, {
        eventId: "speech",
        expectedGeneration: p.generation,
        action: "narrate",
        sceneId: "code",
        frame: f.frame(p),
      }),
    ).toThrow(/current verified/);
  });
  it("makes Stop sticky and requires a separate joined cleanup receipt", () => {
    const f = fixture(),
      p = f.visible(),
      stopped = f.ledger.stop(p.id, "stop");
    expect(stopped.state).toBe("unknown");
    expect(f.ledger.unresolved()).toHaveLength(1);
    expect(() => f.claim(stopped, "afterstop")).toThrow(/stopped/);
    const claim = f.ledger.claim(p.id, {
      eventId: "stop",
      expectedGeneration: stopped.generation,
      action: "stop",
    });
    expect(claim.receipt.state).toBe("running");
    expect(
      f.ledger.claim(p.id, {
        eventId: "stop",
        expectedGeneration: stopped.generation,
        action: "stop",
      }).replayed,
    ).toBe(true);
    expect(
      f.ledger.settle(p.id, "stop", { state: "done", cleanup }).state,
    ).toBe("stopped");
    expect(f.ledger.unresolved()).toHaveLength(0);
    expect(() =>
      f.ledger.claim(p.id, {
        eventId: "repeatstop",
        expectedGeneration: stopped.generation,
        action: "stop",
      }),
    ).toThrow(/cannot be retried/);
  });
  it("preserves late original receipts without resuming a stopped presentation", () => {
    const f = fixture(),
      show = f.claim(f.prepare().presentation).presentation,
      frame = f.frame(show),
      stopped = f.ledger.stop(show.id, "stop");
    f.ledger.claim(show.id, {
      eventId: "close",
      expectedGeneration: stopped.generation,
      action: "stop",
    });
    expect(
      f.ledger.settle(show.id, "close", { state: "done", cleanup }).state,
    ).toBe("unknown");
    const result = f.ledger.settle(show.id, "show", { state: "done", frame });
    expect(result.state).toBe("stopped");
    expect(result.frame).toBeUndefined();
    expect(result.effects[0]!.state).toBe("done");
  });
  it("reads the global capture fence without reconciling or exposing manifest prose", () => {
    const f = fixture(),
      p = f.claim(f.prepare().presentation).presentation;
    const before = f.store.query("SELECT * FROM entities");
    expect(unresolvedTaskPresentations(f.store, f.vault)).toEqual([
      {
        id: p.id,
        state: "presenting",
        taskId: f.manifest.taskId,
        sessionId: f.session.id,
      },
    ]);
    expect(f.store.query("SELECT * FROM entities")).toEqual(before);
    expect(f.ledger.get(f.session.id, p.id).effects[0]!.state).toBe("running");
  });

  it("restarts running effects as unknown without replay and retains a global capture fence", () => {
    const f = fixture(),
      p = f.claim(f.prepare().presentation).presentation,
      restarted = new TaskPresentationLedger(
        f.store,
        f.vault,
        f.tasks,
        f.clock,
      );
    expect(restarted.get(f.session.id, p.id).effects[0]!.state).toBe("unknown");
    expect(restarted.unresolved()).toHaveLength(1);
    expect(() =>
      restarted.settle(p.id, "show", { state: "done", frame: f.frame(p) }),
    ).toThrow(/original in-flight/);
    expect(() =>
      restarted.prepare(f.session, {
        eventId: "other",
        manifest: { ...f.manifest, id: "other" },
        grant: {
          ...f.grant,
          id: "othergrant",
          manifestFingerprint: taskPresentationFingerprint({
            ...f.manifest,
            id: "other",
          }),
        },
      }),
    ).toThrow(/reserves capture/);
    const stopped = restarted.stop(p.id, "stop");
    restarted.claim(p.id, {
      eventId: "close",
      expectedGeneration: stopped.generation,
      action: "stop",
    });
    const closed = restarted.settle(p.id, "close", { state: "done", cleanup });
    expect(closed.state).toBe("stopped");
    expect(closed.effects[0]!.state).toBe("unknown");
  });
  it("does not relabel an unknown cleanup or dispatch another cleanup attempt", () => {
    const f = fixture(),
      p = f.prepare().presentation,
      stopped = f.ledger.stop(p.id, "stop");
    f.ledger.claim(p.id, {
      eventId: "close",
      action: "stop",
      expectedGeneration: stopped.generation,
    });
    f.ledger.settle(p.id, "close", { state: "unknown" });
    expect(() =>
      f.ledger.settle(p.id, "close", { state: "done", cleanup }),
    ).toThrow(/conflicts/);
    expect(() =>
      f.ledger.claim(p.id, {
        eventId: "closeagain",
        action: "stop",
        expectedGeneration: stopped.generation,
      }),
    ).toThrow(/cannot be retried/);
  });
});
