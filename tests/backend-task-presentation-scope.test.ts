import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { ProtectedTaskStore } from "../src/storage/task-store.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskPresentationLedger } from "../src/attention/task-presentation-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { TaskPresentationService } from "../src/control/task-presentation-service.js";
import { createTaskApp } from "../src/control/task-app.js";
import {
  taskPresentationFingerprint,
  type TaskPresentationManifest,
  type TaskPresentationGrant,
  type TaskPresentationRecord,
  type TaskPresentationHost,
} from "../src/task-presentation-contracts.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
function fixture() {
  const project = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-presentation-scope-")),
  );
  const store = new Store(),
    vault = new Vault("ab".repeat(32));
  cleanup.push(() => {
    store.close();
    rmSync(project, { recursive: true, force: true });
  });
  const tasks = new TaskLedger(store, vault);
  store.put("pairing", {
    id: "pair",
    memberId: "member",
    deviceId: "device",
    recipient: "synthetic",
    conversationId: "synthetic",
    lineId: "synthetic",
    displayId: "none",
    allowView: false,
    allowControl: false,
    createdAt: Date.now(),
  });
  const service = new TaskService(store, vault, tasks, {
    projectRoots: [project],
    simulation: true,
  });
  const session = service.register({
    eventId: "register",
    pairingId: "pair",
    hostId: "host",
    projectRoot: project,
    voice: false,
  });
  const task = service.create(session.token, {
    eventId: "create",
    goal: "Synthetic changed task",
  }).task;
  const manifest: TaskPresentationManifest = {
    version: 1,
    id: "owned_presentation",
    sessionId: session.session.id,
    taskId: task.id,
    runId: task.runs[0]!.id,
    taskRevision: task.revision,
    verificationId: "prior_verification",
    kind: "review",
    opening: "Synthetic prior result.",
    fps: 15,
    scenes: [
      {
        id: "scene",
        kind: "preview",
        title: "Prepared preview",
        narration: "Synthetic prior result.",
        expectedOutcome: "Prepared content",
        target: {
          appId: "com.example.Preview",
          windowId: "42",
          ownerPid: 123,
          processIdentity: "ab".repeat(32),
          displayId: 1,
          titleHash: "cd".repeat(32),
        },
        focus: { x: 0, y: 0, width: 1, height: 1 },
        transitionMs: 550,
      },
    ],
  };
  const grant: TaskPresentationGrant = {
    version: 1,
    id: "owned_grant",
    manifestFingerprint: taskPresentationFingerprint(manifest),
    sessionId: session.session.id,
    taskId: task.id,
    runId: manifest.runId,
    taskRevision: task.revision,
    hostId: "host",
    authorizedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    localOnly: true,
    capture: true,
    presentation: true,
    control: false,
    nativeActivation: false,
    calls: false,
  };
  const ledger = new TaskPresentationLedger(store, vault, tasks);
  const records = new ProtectedTaskStore<TaskPresentationRecord>(
    store,
    vault,
    "coding-task-presentation-v1",
  );
  // Simulate separately owned unresolved historical receipts after task progression.
  const own: TaskPresentationRecord = {
    id: manifest.id,
    manifest,
    grant,
    fingerprint: grant.manifestFingerprint,
    generation: 0,
    state: "unknown",
    effects: [],
    createdAt: Date.now(),
  };
  const otherManifest = {
    ...structuredClone(manifest),
    id: "other_presentation",
  };
  const other: TaskPresentationRecord = {
    ...structuredClone(own),
    id: otherManifest.id,
    manifest: otherManifest,
    fingerprint: taskPresentationFingerprint(otherManifest),
    grant: {
      ...grant,
      id: "other_grant",
      manifestFingerprint: taskPresentationFingerprint(otherManifest),
    },
  };
  records.put(own);
  records.put(other);
  const host: TaskPresentationHost = {
    prepare: vi.fn<TaskPresentationHost["prepare"]>(async () => ({
      ready: true,
    })),
    show: vi.fn(async () => {
      throw Error("Unexpected capture");
    }),
    observe: vi.fn(async () => {
      throw Error("Unexpected capture");
    }),
    narrate: vi.fn(async () => {
      throw Error("Unexpected speech");
    }),
    stop: vi.fn<TaskPresentationHost["stop"]>(async () => ({
      captureStopped: true,
      narrationStopped: true,
      outputCleared: true,
      childrenJoined: true,
    })),
  };
  const presentation = new TaskPresentationService(service, ledger, host, {
    manifest,
    grant,
  });
  const app = createTaskApp(
    service,
    "synthetic-operator-".repeat(4),
    undefined,
    undefined,
    presentation,
  );
  return {
    store,
    records,
    own,
    other,
    session,
    task,
    ledger,
    host,
    presentation,
    app,
  };
}

describe("presentation cleanup ownership scope", () => {
  it("rejects direct cross-record API access before claiming effects or disclosing other presentation metadata", async () => {
    const f = fixture();
    const base = `/tasks/${f.task.id}/presentations/${f.other.id}`;
    for (const [suffix, body] of [
      ["", undefined],
      ["/authority", undefined],
      [
        "/scenes",
        { eventId: "foreign_show", expectedGeneration: 0, sceneId: "scene" },
      ],
      [
        "/narrate",
        { eventId: "foreign_narrate", expectedGeneration: 0, sceneId: "scene" },
      ],
      ["/stop", { eventId: "foreign_stop" }],
    ] as const) {
      const response = await f.app.request(base + suffix, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${f.session.token}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(f.other.manifest.opening);
    }
    expect(f.records.get(f.other.id)).toEqual(f.other);
    expect(f.host.stop).not.toHaveBeenCalled();
    expect(f.host.show).not.toHaveBeenCalled();
    expect(f.host.narrate).not.toHaveBeenCalled();
  });

  it.each(["close", "reconcile"] as const)(
    "%s settles only its configured manifest and preserves another owner's unknown receipts",
    async (method) => {
      const f = fixture();
      await f.presentation[method]();
      expect(f.host.stop).toHaveBeenCalledExactlyOnceWith(f.own.id);
      expect(f.records.get(f.other.id)).toEqual(f.other);
      expect(f.ledger.get(f.session.session.id, f.own.id)).toMatchObject({
        state: "stopped",
        cleanup: {
          captureStopped: true,
          narrationStopped: true,
          outputCleared: true,
          childrenJoined: true,
        },
      });
      await f.presentation[method]();
      expect(f.host.stop).toHaveBeenCalledTimes(1);
      expect(f.host.show).not.toHaveBeenCalled();
      expect(f.host.narrate).not.toHaveBeenCalled();
    },
  );

  it("a failed owned cleanup stays unknown without attempting another manifest's cleanup", async () => {
    const f = fixture();
    vi.mocked(f.host.stop).mockRejectedValueOnce(
      Error("Synthetic cleanup unavailable"),
    );
    await f.presentation.close();
    expect(f.records.get(f.own.id)?.state).toBe("unknown");
    expect(f.records.get(f.own.id)?.cleanup).toBeUndefined();
    expect(f.records.get(f.other.id)).toEqual(f.other);
    expect(f.host.stop).toHaveBeenCalledExactlyOnceWith(f.own.id);
  });
});
