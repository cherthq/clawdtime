import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { ProtectedTaskStore } from "../src/storage/task-store.js";
import type { CodingTask } from "../src/contracts.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskPresentationLedger } from "../src/attention/task-presentation-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { TaskPresentationService } from "../src/control/task-presentation-service.js";
import { createTaskApp } from "../src/control/task-app.js";
import {
  taskPresentationFingerprint,
  type TaskPresentationManifest,
  type TaskPresentationGrant,
  type TaskSceneFrame,
} from "../src/task-presentation-contracts.js";
import type { TaskCommand } from "../src/contracts.js";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
function fixture() {
  const project = realpathSync(
      mkdtempSync(join(tmpdir(), "clawdtime-presentation-service-")),
    ),
    store = new Store(),
    vault = new Vault("ab".repeat(32));
  cleanups.push(() => {
    store.close();
    rmSync(project, { recursive: true, force: true });
  });
  let now = Date.now();
  const clock = () => now,
    tasks = new TaskLedger(store, vault, clock);
  store.put("pairing", {
    id: "pair",
    memberId: "member",
    deviceId: "device",
    recipient: "fixture",
    conversationId: "fixture",
    lineId: "fixture",
    displayId: "none",
    allowView: false,
    allowControl: false,
    createdAt: now,
  });
  const service = new TaskService(store, vault, tasks, {
    projectRoots: [project],
    simulation: false,
    clock,
  });
  const reg = service.register({
    eventId: "register",
    pairingId: "pair",
    hostId: "host",
    projectRoot: project,
    voice: false,
  });
  const taskId = service.create(reg.token, {
    eventId: "create",
    goal: "Add a filter.",
  }).task.id;
  const get = () => tasks.get(reg.session.id, taskId);
  let seq = 0;
  const change = (c: Record<string, unknown>) =>
    tasks.transition(reg.session.id, taskId, {
      eventId: "e" + seq++,
      expectedRevision: get().revision,
      ...c,
    } as TaskCommand);
  const run = get().runs[0]!;
  change({ action: "claim_run", runId: run.id });
  change({
    action: "run_result",
    runId: run.id,
    dispatchId: run.dispatchId,
    outcome: "completed",
    summary: "The filter works.",
  });
  change({
    action: "verify_result",
    verification: {
      id: "verification",
      runId: run.id,
      state: "passed",
      completedAt: now,
      checks: [
        {
          name: "fixture",
          command: ["synthetic"],
          state: "passed",
          exitCode: 0,
          summary: "Passed.",
        },
      ],
    },
  });
  const target = {
    appId: "com.example.Editor",
    windowId: "42",
    ownerPid: 123,
    processIdentity: "a".repeat(64),
    displayId: 1,
    titleHash: "b".repeat(64),
  };
  writeFileSync(join(project, "app.js"), "export const filter = true;");
  const manifest: TaskPresentationManifest = {
    version: 1,
    id: "presentation",
    sessionId: reg.session.id,
    taskId,
    runId: run.id,
    taskRevision: get().revision,
    verificationId: "verification",
    kind: "review",
    opening: get().brief!.opening,
    fps: 15,
    scenes: [
      {
        id: "code",
        kind: "code",
        title: "Filter",
        narration: get().brief!.opening,
        expectedOutcome: "Filter implementation visible.",
        target,
        focus: { x: 0, y: 0, width: 1, height: 1 },
        transitionMs: 550,
        artifact: {
          relativePath: "app.js",
          sha256: createHash("sha256")
            .update("export const filter = true;")
            .digest("hex"),
        },
      },
    ],
  };
  const grant: TaskPresentationGrant = {
    version: 1,
    id: "grant",
    manifestFingerprint: taskPresentationFingerprint(manifest),
    sessionId: reg.session.id,
    taskId,
    runId: run.id,
    taskRevision: get().revision,
    hostId: "host",
    authorizedAt: now,
    expiresAt: now + 300000,
    localOnly: true,
    capture: true,
    presentation: true,
    control: false,
    nativeActivation: false,
    calls: false,
  };
  const ledger = new TaskPresentationLedger(store, vault, tasks, clock);
  let frame: TaskSceneFrame;
  const host = {
    prepare: vi.fn(async () => ({ ready: true as const })),
    show: vi.fn(async (input: any) => {
      frame = {
        ...input,
        target,
        sourceFrameId: "frame",
        geometryGeneration: "geometry",
        contentRevision: "c".repeat(64),
        capturedAt: now,
        renderedAt: now,
        transitionCompletedAt: now,
        evidence: "local_frame_rendered_not_human_seen",
      };
      return frame;
    }),
    observe: vi.fn(async () => ({
      ...frame,
      capturedAt: now,
      renderedAt: now,
    })),
    narrate: vi.fn(async () => ({
      completed: true as const,
      evidence: "playback_completed_not_audibility" as const,
    })),
    stop: vi.fn(async () => ({
      captureStopped: true as const,
      narrationStopped: true as const,
      outputCleared: true as const,
      childrenJoined: true as const,
    })),
  };
  const p = new TaskPresentationService(
      service,
      ledger,
      host,
      { manifest, grant },
      clock,
    ),
    app = createTaskApp(service, "operator".repeat(8), undefined, undefined, p);
  const prepare = () =>
    p.prepare(reg.token, taskId, { eventId: "prepare", manifest, grant });
  const show = () =>
    p.show(reg.token, taskId, manifest.id, {
      eventId: "show",
      expectedGeneration: 0,
      sceneId: "code",
    });
  const narrate = () =>
    p.narrate(reg.token, taskId, manifest.id, {
      eventId: "narrate",
      expectedGeneration: 1,
      sceneId: "code",
    });
  return {
    project,
    service,
    store,
    vault,
    reg,
    taskId,
    get,
    change,
    manifest,
    grant,
    ledger,
    host,
    p,
    app,
    prepare,
    show,
    narrate,
    advance: (n: number) => {
      now += n;
    },
  };
}
it("prepares without capture and refuses a task-token self-grant", async () => {
  const f = fixture();
  await expect(
    f.p.prepare(f.reg.token, f.taskId, {
      eventId: "other",
      manifest: f.manifest,
      grant: { ...f.grant, id: "forged" },
    }),
  ).rejects.toThrow("operator-installed");
  await f.prepare();
  expect(f.host.prepare).toHaveBeenCalledOnce();
  expect(f.host.show).not.toHaveBeenCalled();
  expect(f.host.narrate).not.toHaveBeenCalled();
  expect(f.reg.session.permissions.presentation).toBe(false);
});
it("requires real host evidence before narration and never replays duplicate speech", async () => {
  const f = fixture();
  await f.prepare();
  await f.show();
  await f.narrate();
  await f.narrate();
  expect(f.host.narrate).toHaveBeenCalledOnce();
  expect(f.host.observe).toHaveBeenCalledOnce();
  expect(
    f.ledger.get(f.reg.session.id, f.manifest.id).effects.map((e) => e.state),
  ).toEqual(["done", "done"]);
});
it("invalidates stale task scenes while allowing the task decision to proceed", async () => {
  const f = fixture();
  await f.prepare();
  await f.show();
  f.change({
    action: "decide",
    runId: f.get().runs.at(-1)!.id,
    instruction: "Change the empty state.",
  });
  expect(f.get().state).toBe("queued");
  await f.p.reconcile();
  expect(f.host.stop).toHaveBeenCalledOnce();
  expect(
    f.ledger.get(f.reg.session.id, f.manifest.id).cleanup?.captureStopped,
  ).toBe(true);
  await expect(f.narrate()).rejects.toThrow();
  expect(f.host.narrate).not.toHaveBeenCalled();
});
it("stops on stale frame and preserves no narration effect", async () => {
  const f = fixture();
  await f.prepare();
  await f.show();
  f.host.observe.mockImplementationOnce(async () => ({
    ...f.ledger.get(f.reg.session.id, f.manifest.id).frame!,
    capturedAt: 0,
  }));
  await expect(f.narrate()).rejects.toThrow("unavailable");
  expect(f.host.narrate).not.toHaveBeenCalled();
  expect(f.host.stop).toHaveBeenCalledOnce();
});
it("refuses changed project artifacts before any scene effect", async () => {
  const f = fixture();
  await f.prepare();
  writeFileSync(join(f.project, "app.js"), "changed");
  await expect(f.show()).rejects.toThrow("artifact changed");
  expect(f.host.show).not.toHaveBeenCalled();
});
it("retains a failed scene outcome and joins cleanup instead of advancing", async () => {
  const f = fixture();
  await f.prepare();
  f.host.show.mockRejectedValueOnce(Error("synthetic"));
  await expect(f.show()).rejects.toThrow("outcome unavailable");
  const r = f.ledger.get(f.reg.session.id, f.manifest.id);
  expect(r.effects.find((e) => e.id === "show")?.state).toBe("unknown");
  expect(r.cleanup?.childrenJoined).toBe(true);
  expect(f.host.narrate).not.toHaveBeenCalled();
});
it("local Stop overtakes in-flight scene output and blocks late narration", async () => {
  const f = fixture();
  await f.prepare();
  let resolve!: () => void;
  const gate = new Promise<void>((r) => (resolve = r));
  const original = f.host.show.getMockImplementation()!;
  f.host.show.mockImplementationOnce(async (v) => {
    await gate;
    return original(v);
  });
  const showing = f.show();
  await Promise.resolve();
  await f.p.stop(f.reg.token, f.taskId, f.manifest.id, { eventId: "stop" });
  resolve();
  await expect(showing).rejects.toThrow();
  expect(
    f.ledger.get(f.reg.session.id, f.manifest.id).cleanup?.outputCleared,
  ).toBe(true);
  expect(f.host.narrate).not.toHaveBeenCalled();
});
it("cleanup remains possible after session expiry while authority is refused", async () => {
  const f = fixture();
  await f.prepare();
  await f.show();
  f.advance(25 * 60 * 60 * 1000);
  expect(() => f.p.authority(f.reg.token, f.taskId, f.manifest.id)).toThrow();
  await f.p.stop(f.reg.token, f.taskId, f.manifest.id, { eventId: "stop" });
  expect(f.host.stop).toHaveBeenCalledOnce();
});
it("HTTP routes reject browser origins and other task credentials", async () => {
  const f = fixture();
  await f.prepare();
  const path = `/tasks/${f.taskId}/presentations/${f.manifest.id}`;
  expect(
    (await f.app.request(path, { headers: { authorization: "Bearer wrong" } }))
      .status,
  ).toBe(401);
  expect(
    (
      await f.app.request(path, {
        headers: {
          authorization: "Bearer " + f.reg.token,
          origin: "http://localhost:3323",
        },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.app.request(path, {
        headers: { authorization: "Bearer " + f.reg.token },
      })
    ).status,
  ).toBe(200);
});

it("expired credentials expose no presentation prose but may stop their exact owned capture", async () => {
  const f = fixture();
  await f.prepare();
  await f.show();
  f.advance(25 * 60 * 60 * 1000);
  expect(() => f.p.status(f.reg.token, f.taskId, f.manifest.id)).toThrow();
  const result = await f.p.stop(f.reg.token, f.taskId, f.manifest.id, {
    eventId: "cleanup_expired",
  });
  expect(result.cleanup?.captureStopped).toBe(true);
  expect(result).not.toHaveProperty("manifest");
  expect(result).not.toHaveProperty("grant");
});
it("copies the operator binding so later caller mutation cannot rewrite admitted scenes", async () => {
  const f = fixture();
  f.manifest.scenes[0]!.title = "Injected replacement";
  f.grant.manifestFingerprint = taskPresentationFingerprint(f.manifest);
  await expect(f.prepare()).rejects.toThrow("operator-installed");
  expect(f.host.prepare).not.toHaveBeenCalled();
});

it("active or unresolved presentation blocks task reauthorization without blocking coding decisions", async () => {
  const f = fixture();
  await f.prepare();
  expect(f.service.readiness(f.reg.token, f.taskId).blockedReasons).toContain(
    "presentation_cleanup_required",
  );
  await f.p.stop(f.reg.token, f.taskId, f.manifest.id, { eventId: "stop" });
  expect(
    f.service.readiness(f.reg.token, f.taskId).blockedReasons,
  ).not.toContain("presentation_cleanup_required");
});

it("projects openings from current verification instead of an obsolete stored worker brief", async () => {
  const f = fixture(),
    original = f.get();
  original.brief!.opening = "Worker says verification pending.";
  new ProtectedTaskStore<CodingTask>(f.store, f.vault, "coding-task-v1").put(
    original,
  );
  const response = await f.app.request(`/tasks/${f.taskId}/brief`, {
    headers: { authorization: "Bearer " + f.reg.token },
  });
  expect(response.status).toBe(200);
  expect((await response.json()).opening).toBe(f.manifest.opening);
  await f.prepare();
  expect(f.get().brief!.opening).toBe("Worker says verification pending.");
});
