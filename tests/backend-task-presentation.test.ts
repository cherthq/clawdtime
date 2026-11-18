import { afterEach, describe, expect, it } from "vitest";
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
