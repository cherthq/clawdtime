import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { taskCli } from "../cli/tasks.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskPresentationLedger } from "../src/attention/task-presentation-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { TaskPresentationService } from "../src/control/task-presentation-service.js";
import { createTaskApp } from "../src/control/task-app.js";
import type { TaskCommand } from "../src/contracts.js";
import {
  taskPresentationFingerprint,
  type TaskPresentationManifest,
  type TaskPresentationRecord,
  type TaskSceneFrame,
} from "../src/task-presentation-contracts.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const token = "synthetic-task-token-01234567890123456789";
async function fixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "clawdtime-walkthrough-")),
  );
  const files = Object.fromEntries(
    ["session", "plan", "grant", "saved"].map((name) => [
      name,
      join(directory, `${name}.json`),
    ]),
  ) as Record<"session" | "plan" | "grant" | "saved", string>;
  const target = {
    appId: "com.example.Editor",
    windowId: "123",
    ownerPid: 42,
    processIdentity: hash("process"),
    displayId: 1,
    titleHash: hash("title"),
  };
  const manifest: TaskPresentationManifest = {
    version: 1,
    id: "presentation-one",
    sessionId: "session-one",
    taskId: "task-one",
    runId: "run-one",
    taskRevision: 9,
    verificationId: "verify-one",
    kind: "review",
    opening: "The filter is ready for review.",
    fps: 15,
    scenes: ["code", "preview"].map((kind) => ({
      id: kind,
      kind: kind as "code" | "preview",
      title: kind,
      narration:
        kind === "code"
          ? "The filter is ready for review."
          : "The filter is ready.",
      expectedOutcome: "A Clear filters button is visible.",
      target,
      focus: { x: 0, y: 0, width: 1, height: 1 },
      transitionMs: 550,
      artifact: { relativePath: "app.js", sha256: hash("fixture-code") },
    })),
  };
  const grant = {
    version: 1 as const,
    id: "grant-one",
    manifestFingerprint: taskPresentationFingerprint(manifest),
    sessionId: manifest.sessionId,
    taskId: manifest.taskId,
    runId: manifest.runId,
    taskRevision: manifest.taskRevision,
    hostId: "host-one",
    authorizedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    localOnly: true as const,
    capture: true as const,
    presentation: true as const,
    control: false as const,
    nativeActivation: false as const,
    calls: false as const,
  };
  const write = async (file: string, value: unknown) =>
    writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await write(files.session, {
    version: 1,
    origin: "http://127.0.0.1:3320",
    sessionId: manifest.sessionId,
    token,
  });
  await write(files.plan, manifest);
  await write(files.grant, grant);
  await writeFile(join(directory, "app.js"), "fixture-code");
  let record: TaskPresentationRecord = {
    id: manifest.id,
    manifest,
    grant,
    fingerprint: grant.manifestFingerprint,
    generation: 0,
    state: "prepared",
    effects: [],
    createdAt: Date.now(),
  };
  const calls: Array<{ path: string; body?: any }> = [];
  const request = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname,
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${token}` });
      calls.push({ path, body });
      if (path === "/tasks/task-one")
        return Response.json({
          id: manifest.taskId,
          sessionId: manifest.sessionId,
          projectRoot: directory,
          revision: manifest.taskRevision,
        });
      if (path.endsWith("/presentations")) return Response.json(record);
      if (path.endsWith("/scenes")) {
        expect(
          JSON.parse(await readFile(files.saved, "utf8")).startClaimed,
        ).toBe(true);
        expect(body.expectedGeneration).toBe(record.generation);
        record.generation++;
        record.state = "visible";
        record.activeSceneId = body.sceneId;
        record.frame = {
          presentationId: record.id,
          manifestFingerprint: record.fingerprint,
          operationId: body.eventId,
          sceneId: body.sceneId,
          generation: record.generation,
          target,
          sourceFrameId: "frame-one",
          geometryGeneration: "geometry-one",
          contentRevision: hash("pixels"),
          capturedAt: Date.now(),
          renderedAt: Date.now(),
          transitionCompletedAt: Date.now(),
          evidence: "local_frame_rendered_not_human_seen",
        };
        record.effects.push({
          id: body.eventId,
          action: "show_scene",
          sceneId: body.sceneId,
          generation: record.generation,
          state: "done",
          startedAt: Date.now(),
          completedAt: Date.now(),
          frame: record.frame,
        });
      } else if (path.endsWith("/narrate")) {
        record.effects.push({
          id: body.eventId,
          action: "narrate",
          sceneId: body.sceneId,
          generation: record.generation,
          state: "done",
          startedAt: Date.now(),
          completedAt: Date.now(),
        });
      } else if (path.endsWith("/stop")) {
        expect(
          JSON.parse(await readFile(files.saved, "utf8")).stopClaimed,
        ).toBe(true);
        record.generation++;
        record.state = "stopped";
        record.cleanup = {
          captureStopped: true,
          narrationStopped: true,
          outputCleared: true,
          childrenJoined: true,
        };
        return Response.json({
          id: record.id,
          state: record.state,
          generation: record.generation,
          cleanup: record.cleanup,
        });
      }
      return Response.json(record);
    },
  ) as unknown as ReturnType<typeof vi.fn<typeof fetch>>;
  const prepareArgs = [
    "walkthrough-prepare",
    "--id",
    manifest.taskId,
    "--plan-file",
    files.plan,
    "--grant-file",
    files.grant,
    "--project",
    directory,
    "--session-file",
    files.session,
    "--event-id",
    "prepare-once",
    "--save",
    files.saved,
  ];
  const args = (command: string) => [
    `walkthrough-${command}`,
    "--walkthrough-file",
    files.saved,
    "--session-file",
    files.session,
  ];
  const print = vi.fn();
  const run = (command: string, customRequest: typeof fetch = request) =>
    taskCli(args(command), { request: customRequest, print, env: {} });
  const prepare = (customRequest: typeof fetch = request) =>
    taskCli(prepareArgs, { request: customRequest, print, env: {} });
  return {
    directory,
    files,
    manifest,
    grant,
    write,
    request,
    calls,
    print,
    record,
    run,
    prepare,
    prepareArgs,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

describe("independent task walkthrough CLI", () => {
  it("prepares metadata only and protects deterministic recovery state without credentials", async () => {
    const f = await fixture();
    try {
      await f.prepare();
      expect(f.calls.map((call) => call.path)).toEqual([
        "/tasks/task-one",
        "/tasks/task-one/presentations",
      ]);
      const text = await readFile(f.files.saved, "utf8"),
        saved = JSON.parse(text);
      expect(saved.manifest.id).toBe("presentation-one");
      expect(saved.startClaimed).toBe(false);
      expect(
        new Set(
          saved.sceneEvents.flatMap((item: any) => [item.show, item.narrate]),
        ).size,
      ).toBe(4);
      expect(text + JSON.stringify(f.print.mock.calls)).not.toContain(token);
      await expect(f.prepare()).rejects.toThrow("already exists");
      expect(
        f.calls.filter((call) => call.path.endsWith("/presentations")),
      ).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  it("shows each scene, reads its render proof, then narrates with durable IDs exactly once", async () => {
    const f = await fixture();
    try {
      await f.prepare();
      f.calls.length = 0;
      await f.run("start");
      const base = "/tasks/task-one/presentations/presentation-one";
      expect(f.calls.map((call) => call.path)).toEqual([
        base,
        `${base}/scenes`,
        base,
        `${base}/narrate`,
        `${base}/scenes`,
        base,
        `${base}/narrate`,
      ]);
      const saved = JSON.parse(await readFile(f.files.saved, "utf8"));
      expect(
        f.calls.filter((call) => call.body).map((call) => call.body.eventId),
      ).toEqual(
        saved.sceneEvents.flatMap((item: any) => [item.show, item.narrate]),
      );
      const effects = f.calls.filter((call) => call.body).length;
      await expect(f.run("start")).rejects.toThrow("fresh prepared");
      expect(f.calls.filter((call) => call.body)).toHaveLength(effects);
    } finally {
      await f.cleanup();
    }
  });

  it("preserves a lost prepare response and reconciles only the original deterministic ID", async () => {
    const f = await fixture();
    try {
      await expect(
        f.prepare(async (url, init) => {
          const response = await f.request(url, init);
          if (String(url).endsWith("/presentations")) throw Error("lost");
          return response;
        }),
      ).rejects.toThrow("No retry");
      await f.run("status");
      expect(f.calls.at(-1)?.path).toBe(
        "/tasks/task-one/presentations/presentation-one",
      );
      expect(
        f.calls.filter((call) => call.path.endsWith("/presentations")),
      ).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  it("never retries a lost show, narrates after uncertainty, or starts its saved plan again", async () => {
    const f = await fixture();
    try {
      await f.prepare();
      const request: typeof fetch = async (url, init) => {
        if (String(url).endsWith("/scenes"))
          throw Error("private endpoint failure");
        return f.request(url, init);
      };
      await expect(f.run("start", request)).rejects.toThrow("No retry");
      await expect(f.run("start")).rejects.toThrow("already claimed");
      expect(f.calls.some((call) => call.path.endsWith("/narrate"))).toBe(
        false,
      );
      expect(JSON.stringify(f.print.mock.calls)).not.toContain(
        "private endpoint failure",
      );
    } finally {
      await f.cleanup();
    }
  });

  it("rejects changed project artifacts both before preparation and before start", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.directory, "app.js"), "changed");
      await expect(f.prepare()).rejects.toThrow("artifact changed");
      expect(f.request).not.toHaveBeenCalled();
      await writeFile(join(f.directory, "app.js"), "fixture-code");
      await f.prepare();
      await writeFile(join(f.directory, "app.js"), "changed");
      await expect(f.run("start")).rejects.toThrow("artifact changed");
      expect(f.calls.some((call) => call.path.endsWith("/scenes"))).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it("rejects traversal and symbolic-link artifacts without any request", async () => {
    for (const name of ["../outside", "/absolute/path", "linked.js"]) {
      const f = await fixture();
      try {
        if (name === "linked.js")
          await symlink(join(f.directory, "app.js"), join(f.directory, name));
        f.manifest.scenes[0]!.artifact!.relativePath = name;
        if (name === "linked.js")
          f.grant.manifestFingerprint = taskPresentationFingerprint(f.manifest);
        await f.write(f.files.plan, f.manifest);
        await f.write(f.files.grant, f.grant);
        await expect(f.prepare()).rejects.toThrow(/artifact/);
        expect(f.request).not.toHaveBeenCalled();
      } finally {
        await f.cleanup();
      }
    }
  });

  it("does not narrate mismatched targets, unknown scene outcomes, or changed readback proof", async () => {
    for (const failure of ["target", "unknown", "readback"]) {
      const f = await fixture();
      try {
        await f.prepare();
        await expect(
          f.run("start", async (url, init) => {
            const response = await f.request(url, init);
            if (
              String(url).endsWith("/scenes") ||
              (failure === "readback" && !init?.body && f.record.generation > 0)
            ) {
              const value = await response.json();
              if (failure === "target") value.frame.target.ownerPid++;
              else if (failure === "unknown") value.state = "unknown";
              else if (!init?.body) value.frame.operationId = "other-operation";
              return Response.json(value);
            }
            return response;
          }),
        ).rejects.toThrow("render proof");
        expect(f.calls.some((call) => call.path.endsWith("/narrate"))).toBe(
          false,
        );
      } finally {
        await f.cleanup();
      }
    }
  });

  it("keeps status read-only, stops once, and refuses start after Stop", async () => {
    const f = await fixture();
    try {
      await f.prepare();
      const before = await readFile(f.files.saved, "utf8");
      await f.run("status");
      expect(await readFile(f.files.saved, "utf8")).toBe(before);
      await f.run("stop");
      await expect(f.run("stop")).rejects.toThrow("already claimed");
      await expect(f.run("start")).rejects.toThrow("fresh prepared");
      expect(
        f.calls.filter((call) => call.path.endsWith("/stop")),
      ).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  it("refuses grant identity mismatches, service origin overrides and credential-bearing records", async () => {
    const f = await fixture();
    try {
      f.grant.runId = "wrong-run";
      await f.write(f.files.grant, f.grant);
      await expect(f.prepare()).rejects.toThrow("identity");
      await expect(
        taskCli(f.prepareArgs, {
          request: f.request,
          env: { CLAWDTIME_TASK_URL: "http://localhost:9999" },
        }),
      ).rejects.toThrow("another task service");
      expect(f.request).not.toHaveBeenCalled();
      f.grant.runId = f.manifest.runId;
      await f.write(f.files.grant, f.grant);
      await f.prepare();
      f.print.mockClear();
      await expect(
        f.run("status", async () => Response.json({ ...f.record, token })),
      ).rejects.toThrow();
      expect(f.print).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it("stops with an expired credential without reading protected status first", async () => {
    const f = await fixture();
    try {
      await f.prepare();
      f.calls.length = 0;
      f.print.mockClear();
      await f.run("stop", async (url, init) => {
        if (!init?.body)
          return Response.json({ error: "expired" }, { status: 403 });
        return f.request(url, init);
      });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]!.path).toMatch(/\/stop$/);
      const output = JSON.parse(f.print.mock.calls[0]![0]);
      expect(Object.keys(output).sort()).toEqual([
        "cleanup",
        "generation",
        "id",
        "state",
      ]);
    } finally {
      await f.cleanup();
    }
  });

  it("concurrent starts admit only one durable claimant", async () => {
    const f = await fixture();
    try {
      await f.prepare();
      const results = await Promise.allSettled([
        f.run("start"),
        f.run("start"),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        f.calls.filter((call) => call.path.endsWith("/scenes")),
      ).toHaveLength(2);
    } finally {
      await f.cleanup();
    }
  });

  it("allows bounded narration completion without shortening the host deadline", async () => {
    const f = await fixture();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await f.prepare();
      timeout.mockClear();
      await f.run("start");
      expect(timeout.mock.calls.map(([duration]) => duration)).toEqual([
        30_000, 30_000, 30_000, 125_000, 30_000, 30_000, 125_000,
      ]);
    } finally {
      timeout.mockRestore();
      await f.cleanup();
    }
  });

  it("runs the CLI through the real task HTTP service and preserves the coding task on Stop", async () => {
    const f = await fixture(),
      store = new Store(),
      vault = new Vault("ac".repeat(32));
    try {
      const clock = () => Date.now(),
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
        createdAt: clock(),
      });
      const service = new TaskService(store, vault, tasks, {
        projectRoots: [f.directory],
        simulation: false,
        clock,
      });
      const reg = service.register({
        eventId: "register",
        pairingId: "pair",
        hostId: "host-one",
        projectRoot: f.directory,
        voice: false,
      });
      let task = service.create(reg.token, {
        eventId: "create",
        goal: "Add a filter.",
      }).task;
      let index = 0;
      const change = (command: Record<string, unknown>) => {
        tasks.transition(reg.session.id, task.id, {
          ...command,
          eventId: `event-${index++}`,
          expectedRevision: task.revision,
        } as TaskCommand);
        task = tasks.get(reg.session.id, task.id);
      };
      const run = task.runs[0]!;
      change({ action: "claim_run", runId: run.id });
      change({
        action: "run_result",
        runId: run.id,
        dispatchId: run.dispatchId,
        outcome: "completed",
        summary: "Filter implemented.",
      });
      change({
        action: "verify_result",
        verification: {
          id: "verification",
          runId: run.id,
          state: "passed",
          completedAt: clock(),
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
      Object.assign(f.manifest, {
        sessionId: reg.session.id,
        taskId: task.id,
        runId: run.id,
        taskRevision: task.revision,
        verificationId: task.verification!.id,
        opening: task.brief!.opening,
      });
      f.manifest.scenes[0]!.narration = task.brief!.opening;
      Object.assign(f.grant, {
        sessionId: reg.session.id,
        taskId: task.id,
        runId: run.id,
        taskRevision: task.revision,
        manifestFingerprint: taskPresentationFingerprint(f.manifest),
      });
      await f.write(f.files.session, {
        version: 1,
        origin: "http://127.0.0.1:3320",
        sessionId: reg.session.id,
        token: reg.token,
      });
      await f.write(f.files.plan, f.manifest);
      await f.write(f.files.grant, f.grant);
      f.prepareArgs[f.prepareArgs.indexOf("--id") + 1] = task.id;
      let frame: TaskSceneFrame;
      const host = {
        prepare: vi.fn(async () => ({ ready: true as const })),
        show: vi.fn(async (input: any): Promise<TaskSceneFrame> => {
          const now = clock();
          frame = {
            ...input,
            target: f.manifest.scenes[0]!.target,
            sourceFrameId: "actual-fixture-frame",
            geometryGeneration: "geometry",
            contentRevision: hash("synthetic pixels"),
            capturedAt: now,
            renderedAt: now,
            transitionCompletedAt: now,
            evidence: "local_frame_rendered_not_human_seen",
          };
          return frame;
        }),
        observe: vi.fn(async () => ({
          ...frame,
          capturedAt: clock(),
          renderedAt: clock(),
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
      const ledger = new TaskPresentationLedger(store, vault, tasks, clock);
      const presentations = new TaskPresentationService(
        service,
        ledger,
        host,
        { manifest: f.manifest, grant: f.grant },
        clock,
      );
      const app = createTaskApp(
        service,
        "synthetic-operator".repeat(3),
        undefined,
        undefined,
        presentations,
      );
      const request: typeof fetch = async (url, init) =>
        app.fetch(new Request(url, init));
      await f.prepare(request);
      expect(host.show).not.toHaveBeenCalled();
      await f.run("start", request);
      expect(host.show).toHaveBeenCalledTimes(2);
      expect(host.observe).toHaveBeenCalledTimes(2);
      expect(host.narrate).toHaveBeenCalledTimes(2);
      await f.run("stop", request);
      expect(host.stop).toHaveBeenCalledTimes(1);
      expect(tasks.get(reg.session.id, task.id)).toEqual(task);
      expect(ledger.unresolved()).toHaveLength(0);
    } finally {
      store.close();
      await f.cleanup();
    }
  });
});
