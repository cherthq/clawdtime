import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewLivePresentationBroker } from "../scripts/preview-live-presentation.js";

const cleanup: { broker: PreviewLivePresentationBroker; directory: string }[] =
  [];
afterEach(async () => {
  for (const { broker, directory } of cleanup.splice(0)) {
    await broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const window = {
    appId: "com.apple.finder",
    windowId: "12",
    ownerPid: 71,
    displayId: 2,
  };
  const focus = {
    rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    durationMs: 450,
  };
  const annotation = { kind: "label", text: "Review this area" };
  const intent = {
    commandId: "command",
    planId: "plan",
    sceneId: "scene",
    generation: 1,
    window,
    focus,
    annotation,
  };
  const scene = {
    generation: 1,
    phase: "presenting",
    plan: { id: "plan" },
    scene: { id: "scene", window, focus, annotation },
  };
  const owner = {
    requestId: "request",
    sessionId: "session",
    executor: "none",
    state: "idle",
    epoch: 4,
    cursor: 2,
    acknowledgedCursor: 2,
    policyRevision: 1,
    pendingDelivery: false,
    viewingStopped: false,
    hold: { active: false },
    actions: [],
    leases: [
      {
        id: "lease",
        sessionId: "session",
        requestId: "request",
        state: "active",
        mode: "view",
        executor: "none",
        executorEpoch: 4,
        policyRevision: 1,
        displayId: 2,
        expiresAt: now + 60_000,
      },
    ],
  };
  const camera = {
    leaseId: "lease",
    sourceFrameId: "old-frame",
    contentRevision: "old-content",
  };
  const cameraStatus = vi.fn(async () => structuredClone(camera));
  const directory = mkdtempSync(join(tmpdir(), "clawdtime-test-live-"));
  const app = new Hono();
  const broker = new PreviewLivePresentationBroker({
    app,
    token: "bridge-token",
    hostToken: "synthetic-host-token-32-characters-minimum",
    mediaSessionId: "media",
    requestId: "request",
    sessionId: "session",
    displayId: 2,
    directory,
    scenes: () => ({ status: () => structuredClone(scene) }) as any,
    executionStatus: async () => structuredClone(owner),
    cameraStatus,
    mediaOrigin: () => "http://synthetic.invalid",
    processIdentity: () => "process-start-1",
    shuttingDown: () => false,
  });
  cleanup.push({ broker, directory });
  let hostHook: ((result: any, presentation: any) => Promise<void>) | undefined;
  let hostPresentation: any;
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      expect(String(input)).toBe(
        "http://synthetic.invalid/sessions/media/native/present",
      );
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer synthetic-host-token-32-characters-minimum",
      );
      const { presentation, fingerprint } = JSON.parse(String(init?.body));
      hostPresentation = presentation;
      expect(
        JSON.parse(readFileSync(broker.journalPath, "utf8")).receipts.find(
          (record: any) =>
            record.presentation.commandId === presentation.commandId,
        ).phase,
      ).toBe("dispatching");
      const result = {
        version: 1,
        commandId: presentation.commandId,
        state: "accepted",
        reason: "geometric_presentation_applied",
        fingerprint,
        receiptId: "receipt",
        observation: {
          window,
          observedAt: now,
          processIdentity: "process-start-1",
          windowBounds: { x: 100, y: 100, width: 500, height: 400 },
          appActive: true,
          windowFocused: true,
          windowOnScreen: true,
        },
        camera: {
          revision: 3,
          sourceFrameId: "current-frame",
          geometryGeneration: "geometry",
          contentRevision: "current-content",
          capturedAt: now,
        },
      };
      await hostHook?.(result, presentation);
      return Response.json(result);
    });
  const authority = (
    presentation: unknown = hostPresentation,
    headers: Record<string, string> = {},
  ) =>
    app.request("/local-native/media/presentation-authority", {
      method: "POST",
      headers: {
        Authorization: "Bearer bridge-token",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ presentation }),
    });
  return {
    broker,
    intent,
    owner,
    scene,
    cameraStatus,
    fetchMock,
    authority,
    hostHook: (hook: (result: any, presentation: any) => Promise<void>) => {
      hostHook = hook;
    },
  };
}

describe("atomic geometric live presentation broker with synthetic host", () => {
  it("reserves intent before dispatch and permits a new current frame without replaying", async () => {
    const f = fixture();
    const result = await f.broker.present(f.intent);
    expect(result.state).toBe("accepted");
    expect(result.camera?.sourceFrameId).toBe("current-frame");
    expect(result.camera?.contentRevision).toBe("current-content");
    expect(await f.broker.present(f.intent)).toEqual(result);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    await expect(
      f.broker.present({
        ...f.intent,
        focus: { ...f.intent.focus, durationMs: 0 },
      }),
    ).rejects.toThrow("already bound");
    expect(f.broker.hasUnresolved()).toBe(false);
  });

  it("authenticates the exact callback and never fetches camera status under the media lock", async () => {
    const f = fixture();
    f.hostHook(async (_result, p) => {
      f.cameraStatus.mockRejectedValue(new Error("camera lock is held"));
      expect(
        (await f.authority(p, { Authorization: "Bearer foreign" })).status,
      ).toBe(401);
      expect(
        (await f.authority(p, { Origin: "http://localhost" })).status,
      ).toBe(403);
      expect(
        (await f.authority({ ...p, generation: p.generation + 1 })).status,
      ).toBe(409);
      expect((await f.authority(p)).status).toBe(200);
    });
    expect((await f.broker.present(f.intent)).state).toBe("accepted");
    expect(f.cameraStatus).toHaveBeenCalledTimes(1);
  });

  it("returns only the durable bound fingerprint and monitors an accepted presented scene", async () => {
    const f = fixture();
    const result = await f.broker.present(f.intent);
    f.scene.phase = "presented";
    const response = await f.authority();
    expect(response.status).toBe(200);
    expect((await response.json()).fingerprint).toBe(result.fingerprint);
    expect(f.broker.status().operations[0]!.fingerprint).toBe(
      result.fingerprint,
    );
    const presentation = f.broker.status().operations[0]!.presentation;
    expect(
      (
        await f.authority({
          ...presentation,
          processIdentity: "forged-process",
        })
      ).status,
    ).toBe(409);
    f.scene.generation++;
    expect((await f.authority()).status).toBe(409);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not grant a presented-scene monitor before this command is accepted", async () => {
    const f = fixture();
    f.hostHook(async (_result, p) => {
      f.scene.phase = "presented";
      expect((await f.authority(p)).status).toBe(409);
    });
    expect((await f.broker.present(f.intent)).state).toBe("uncertain");
    expect((await f.authority()).status).toBe(409);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "generation", "cursor", "lease", "native_owner"])(
    "retains a host outcome but refuses authority changed during await: %s",
    async (change) => {
      const f = fixture();
      f.hostHook(async (_result, p) => {
        if (change === "stop") f.owner.viewingStopped = true;
        if (change === "generation") f.scene.generation++;
        if (change === "cursor") f.owner.cursor++;
        if (change === "lease") f.owner.leases[0]!.state = "released";
        if (change === "native_owner") f.owner.executor = "native";
        expect((await f.authority(p)).status).toBe(409);
      });
      const result = await f.broker.present(f.intent);
      expect(result.state).toBe("uncertain");
      expect(f.broker.status().operations[0]!.hostResult?.state).toBe(
        "accepted",
      );
      expect(f.broker.hasUnresolved()).toBe(true);
      expect(await f.broker.present(f.intent)).toEqual(result);
      expect(f.fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "window",
    "process",
    "focus",
    "stale",
    "frame_after_observation",
    "fingerprint",
  ])("refuses mismatched accepted evidence: %s", async (change) => {
    const f = fixture();
    f.hostHook(async (result) => {
      if (change === "window")
        result.observation.window = {
          ...result.observation.window,
          windowId: "13",
        };
      if (change === "process")
        result.observation.processIdentity = "process-reused";
      if (change === "focus") result.observation.windowFocused = false;
      if (change === "stale") result.observation.observedAt -= 2001;
      if (change === "frame_after_observation") result.camera.capturedAt++;
      if (change === "fingerprint") result.fingerprint = "0".repeat(64);
    });
    expect((await f.broker.present(f.intent)).state).toBe("uncertain");
    expect(f.broker.hasUnresolved()).toBe(true);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves lost-response uncertainty and prevents a replacement command", async () => {
    const f = fixture();
    f.hostHook(async () => {
      throw new Error("synthetic lost response");
    });
    const result = await f.broker.present(f.intent);
    expect(result.state).toBe("uncertain");
    await expect(
      f.broker.present({ ...f.intent, commandId: "replacement" }),
    ).rejects.toThrow("unresolved");
    await f.broker.close();
    const saved = JSON.parse(readFileSync(f.broker.journalPath, "utf8"));
    expect(saved.receipts[0].phase).toBe("uncertain");
    expect(saved.receipts[0].result).toEqual(result);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unreleased authority before dispatch and drains an in-flight request on close", async () => {
    const f = fixture();
    f.owner.executor = "native";
    expect((await f.broker.present(f.intent)).state).toBe("rejected");
    expect(f.fetchMock).not.toHaveBeenCalled();
    f.owner.executor = "none";
    const entered = deferred(),
      release = deferred();
    f.hostHook(async () => {
      entered.resolve();
      await release.promise;
    });
    const work = f.broker.present({ ...f.intent, commandId: "fresh" });
    await entered.promise;
    let closed = false;
    const closing = f.broker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    expect((await work).state).toBe("uncertain");
    await closing;
    expect(
      JSON.parse(readFileSync(f.broker.journalPath, "utf8")).receipts[1].phase,
    ).toBe("uncertain");
  });
});
