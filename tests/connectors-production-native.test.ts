import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { secureWrite } from "../connectors/shared/state.js";
import { startProductionWalkthroughSession } from "../connectors/shared/production-walkthrough-session.js";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ClawdTimeClient } from "../connectors/shared/client.js";
import {
  ProductionNativeClient,
  ProductionWalkthroughController,
} from "../connectors/shared/production-native.js";
import { startProductionNativeTrigger } from "../connectors/shared/production-native-trigger.js";
import {
  conversationCommands,
  executeConversationCommand,
} from "../connectors/shared/conversation.js";
import {
  protocolOptions,
  sessionCapabilities,
} from "../connectors/shared/protocol.js";
import type { NativePresentationOperation } from "../src/native-presentation-contracts.js";
import type { ProductionNativeRecord } from "../src/production-native-contracts.js";

const operation: NativePresentationOperation = {
  version: 1,
  operationId: "operation",
  sceneId: "finder",
  generation: 1,
  action: "activate_app",
  window: {
    appId: "com.apple.finder",
    windowId: "12",
    ownerPid: 71,
    displayId: 2,
  },
  expected: {
    requestId: "request",
    sessionId: "session",
    leaseId: "lease",
    epoch: 1,
    cursor: 0,
    policyRevision: 1,
    displayId: 2,
  },
};
const hash = (op: NativePresentationOperation) =>
  createHash("sha256").update(JSON.stringify(op)).digest("hex");
const observation = {
  window: operation.window,
  observedAt: 10000,
  processIdentity: "process",
  windowBounds: { x: 0, y: 0, width: 500, height: 400 },
  appActive: true,
  windowFocused: true,
  windowOnScreen: true,
};
function record(op = operation): ProductionNativeRecord {
  return {
    id: op.operationId,
    envelope: {
      version: 1,
      operation: op,
      fingerprint: hash(op),
      binding: {
        mediaSessionId: "media-session",
        pairingId: "pair",
        deviceId: "device",
        memberId: "member",
        expiresAt: 20000,
      },
      preparedObservation: {
        ...observation,
        window: op.window,
        appActive: false,
      },
    },
    phase: "prepared",
    createdAt: 10000,
    updatedAt: 10000,
  };
}
const flags = {
  "screen-camera": "true",
  "camera-display": "2",
  "live-presentation": "true",
  "native-activation": "true",
  "native-control": "desktop",
  "shared-surface": "true",
};

describe("production native connector authority", () => {
  it("negotiates a separate immutable default-off capability", () => {
    expect(sessionCapabilities(protocolOptions({}))).not.toHaveProperty(
      "nativeActivationVersion",
    );
    expect(sessionCapabilities(protocolOptions(flags))).toMatchObject({
      nativeActivationVersion: 1,
      livePresentationVersion: 1,
    });
    for (const change of [
      { "native-control": "none" },
      { "native-control": "browser" },
      { "shared-surface": "false" },
      { "live-presentation": "false" },
      { "protocol-version": "1" },
      { "native-activation": "maybe" },
    ])
      expect(() =>
        protocolOptions({ ...flags, ...change } as Record<string, string>),
      ).toThrow();
    expect(
      Object.keys(conversationCommands).some((k) =>
        /dispatch.*native|execute.*native/.test(k),
      ),
    ).toBe(false);
  });
  it("prepares once with explicit capability, verifies identity and uses read-only receipts", async () => {
    const calls: string[] = [];
    const client = new ClawdTimeClient(
      "https://fixture.invalid",
      "synthetic",
      vi.fn(async (url, init) => {
        calls.push(`${init?.method} ${new URL(String(url)).pathname}`);
        return new Response(
          JSON.stringify(
            String(url).endsWith("native-activation")
              ? { enabled: true, operations: [] }
              : record(),
          ),
        );
      }) as typeof fetch,
    );
    await executeConversationCommand(client, "prepare_native_activation", {
      requestId: "request",
      operation,
    });
    await executeConversationCommand(client, "native_activation_receipt", {
      requestId: "request",
      operationId: operation.operationId,
    });
    expect(calls.map((v) => v.split(" ")[0])).toEqual(["GET", "POST", "GET"]);
    expect(
      calls.every((v) => v.includes("/conversation/native-activation")),
    ).toBe(true);
  });
  it.each(["unsupported", "foreign", "fingerprint"])(
    "refuses %s receipts",
    async (kind) => {
      const value = record();
      if (kind === "foreign")
        value.envelope.operation = {
          ...operation,
          expected: { ...operation.expected, requestId: "other" },
        };
      if (kind === "fingerprint") value.envelope.fingerprint = "b".repeat(64);
      const client = new ProductionNativeClient(
        new ClawdTimeClient(
          "https://fixture.invalid",
          "synthetic",
          vi.fn(
            async () =>
              new Response(
                JSON.stringify(
                  kind === "unsupported"
                    ? {}
                    : { enabled: true, operations: [value] },
                ),
              ),
          ) as typeof fetch,
        ),
        "request",
      );
      await expect(client.status()).rejects.toThrow();
    },
  );
  it("retains unknown mutations and never retries or falls back", async () => {
    const request = vi.fn(async () => new Response("{}", { status: 503 }));
    const client = new ProductionNativeClient(
      new ClawdTimeClient(
        "https://fixture.invalid",
        "synthetic",
        request as typeof fetch,
      ),
      "request",
    );
    await expect(
      client.dispatch({
        operationId: "operation",
        fingerprint: hash(operation),
      }),
    ).rejects.toThrow("unknown");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

function fixture() {
  const events: string[] = [];
  const lease = {
    id: "lease",
    state: "active",
    expiresAt: 20000,
    requestId: "request",
    sessionId: "session",
    executor: "none",
    executorEpoch: 0,
    policyRevision: 1,
    displayId: "2",
  };
  const owner = {
    requestId: "request",
    sessionId: "session",
    executor: "none",
    state: "idle",
    epoch: 0,
    policyRevision: undefined as number | undefined,
    cursor: 0,
    acknowledgedCursor: 0,
    pendingDelivery: false,
    hold: { active: false },
    leases: [lease],
    actions: [],
  };
  const camera = {
    version: 1,
    sessionId: "session",
    deviceId: "device",
    leaseId: "lease",
    revision: 0,
    state: "live",
    surface: { kind: "display", id: "2", displayId: 2 },
    sourceFrameId: "frame",
    capturedAt: 10000,
    geometryGeneration: "geometry",
    contentRevision: "content",
    crop: { x: 0, y: 0, width: 1, height: 1 },
    source: {
      width: 1000,
      height: 800,
      originX: 0,
      originY: 0,
      pointWidth: 1000,
      pointHeight: 800,
      displayOriginX: 0,
      displayOriginY: 0,
      displayPointWidth: 1000,
      displayPointHeight: 800,
    },
    output: {
      width: 1280,
      height: 720,
      viewport: { x: 0, y: 0, width: 1280, height: 720 },
    },
    pinned: false,
    moving: false,
    annotations: [],
    context: null,
  };
  const plan = {
    version: 1,
    id: "walkthrough",
    scenes: [
      {
        id: "finder",
        title: "Disposable folder",
        window: operation.window,
        intent: "Show fixture",
        expectedOutcome: "Fixture visible",
        focus: {
          rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
          durationMs: 450,
        },
        annotation: { kind: "label", text: "Fixture" },
      },
    ],
  };
  let saved = record();
  const receipts = new Map<string, ProductionNativeRecord>();
  let observed = observation;
  let dispatchState = "verified";
  let dispatchHook: (() => void) | undefined;
  const client = new ClawdTimeClient("https://fixture.invalid", "synthetic");
  vi.spyOn(client, "conversationExecution").mockImplementation(async () =>
    structuredClone(owner),
  );
  vi.spyOn(client, "conversationOperation").mockImplementation(
    async (_id, _operation, raw) => {
      const body = raw as { executor: string };
      events.push(`owner:${body.executor}`);
      owner.executor = body.executor;
      owner.state = body.executor === "none" ? "idle" : "working";
      owner.epoch++;
      owner.policyRevision = 1;
      lease.executor = body.executor;
      lease.executorEpoch = owner.epoch;
      return structuredClone(owner);
    },
  );
  vi.spyOn(client, "screenCamera").mockImplementation(async (_id, raw) => {
    if (!raw) return structuredClone(camera);
    const command = raw as { commandId: string; op: string };
    events.push(command.op);
    return {
      version: 1,
      commandId: command.commandId,
      revision: ++camera.revision,
      state: "accepted",
    };
  });
  vi.spyOn(client, "presentPreparedScene").mockImplementation(
    async (_id, raw) => {
      const intent = raw as {
        commandId: string;
        window: typeof operation.window;
      };
      events.push("present");
      return {
        version: 1,
        commandId: intent.commandId,
        state: "accepted",
        reason: "target_presentation_applied",
        fingerprint: "c".repeat(64),
        receiptId: "camera-receipt",
        observation: { ...observation, window: intent.window },
        camera: {
          revision: ++camera.revision,
          sourceFrameId: "frame",
          geometryGeneration: "geometry",
          contentRevision: "content",
          capturedAt: 10000,
        },
      };
    },
  );
  vi.spyOn(client, "api").mockImplementation(async (path, body) => {
    if (path.endsWith("native-activation"))
      return { enabled: true, operations: [...receipts.values()] } as never;
    if (path.includes("/receipts/"))
      return structuredClone(receipts.get(path.split("/").at(-1)!)) as never;
    if (path.endsWith("prepare")) {
      events.push("prepare");
      saved = record(body as NativePresentationOperation);
      saved.envelope.binding.expiresAt = Math.min(lease.expiresAt, now + 10000);
    }
    if (path.endsWith("dispatch")) {
      events.push("dispatch");
      dispatchHook?.();
      if (dispatchState === "timeout") throw new Error("synthetic timeout");
      saved.phase = dispatchState as ProductionNativeRecord["phase"];
      saved.result = {
        operationId: saved.id,
        state: dispatchState as "verified",
        reason:
          dispatchState === "returned"
            ? "host_returned_target_unverified"
            : "exact_window_observed",
        terminalEvidence: {
          receiptId: "native-receipt",
          operationId: saved.id,
          fingerprint: saved.envelope.fingerprint,
          hostId: "helper",
          completedAt: 10000,
        },
        observation: {
          ...observed,
          window: saved.envelope.operation.window,
        },
      };
    }
    if (path.endsWith("cancel")) {
      events.push("cancel");
      saved.phase = "rejected";
    }
    receipts.set(saved.id, structuredClone(saved));
    return structuredClone(saved) as never;
  });
  let actorsStopped = true;
  let now = 10000;
  const controller = new ProductionWalkthroughController({
    client,
    requestId: "request",
    sessionId: "session",
    plan,
    clock: () => now,
    backgroundActorsStopped: () => actorsStopped,
  });
  const reference = () => ({
    operationId: saved.id,
    fingerprint: saved.envelope.fingerprint,
  });
  return {
    controller,
    events,
    client,
    owner,
    camera,
    receipts,
    plan,
    reference,
    setTime: (value: number) => {
      now = value;
    },
    setState: (v: string) => {
      dispatchState = v;
    },
    setObservation: (v: Partial<typeof observation>) => {
      observed = { ...observation, ...v };
    },
    setHook: (v: () => void) => {
      dispatchHook = v;
    },
    actorsRunning: () => {
      actorsStopped = false;
    },
  };
}

describe("production walkthrough lifecycle", () => {
  async function returnedActivation(leaseExpiresAt = 20000) {
    const f = fixture();
    f.owner.leases[0]!.expiresAt = leaseExpiresAt;
    await f.controller.prepare("finder", "operation");
    f.setState("returned");
    f.setObservation({
      appActive: true,
      windowFocused: false,
      windowOnScreen: false,
    });
    await expect(f.controller.executePrepared(f.reference())).rejects.toThrow(
      "not verified",
    );
    return f;
  }

  it("separately prepares a fresh raise when activation selected another window, preserving the original receipt and owner", async () => {
    const f = await returnedActivation();
    const originalReference = f.reference();
    const originalReceipt = structuredClone(f.receipts.get("operation"));
    const before = f.controller.status();
    const result = await f.controller.prepare(
      "finder",
      "raise",
      "raise_window",
    );
    expect(result.prepared?.operation).toEqual({
      ...before.prepared!.operation,
      operationId: "raise",
      action: "raise_window",
    });
    expect(result.scene).toEqual(before.scene);
    expect(result.activationReceipt).toEqual(originalReceipt);
    expect(
      await f.controller.native.receipt(
        "operation",
        originalReference.fingerprint,
      ),
    ).toEqual(originalReceipt);
    expect(f.events).toEqual([
      "clear",
      "overview",
      "owner:native",
      "prepare",
      "dispatch",
      "prepare",
    ]);
    expect(result.dispatchAttempted).toBe(false);
    await expect(
      f.controller.executePrepared(originalReference),
    ).rejects.toThrow("current fixed");
    expect(f.events.filter((event) => event === "dispatch")).toHaveLength(1);
    f.setState("verified");
    f.setObservation({});
    await f.controller.executePrepared(f.reference());
    expect(f.events.slice(-3)).toEqual(["dispatch", "owner:none", "present"]);
    expect(f.events.filter((event) => event === "dispatch")).toHaveLength(2);
    expect(f.controller.status().activationReceipt).toEqual(originalReceipt);
  });

  it.each([
    "scene",
    "operation",
    "action",
    "generation",
    "window",
    "receipt",
    "terminal",
    "uncertain",
    "submitted",
  ])("refuses follow-up raise with changed %s", async (change) => {
    const f = await returnedActivation();
    let sceneId = "finder",
      operationId = "raise";
    let action: NativePresentationOperation["action"] = "raise_window";
    if (change === "scene") sceneId = "other";
    if (change === "operation") operationId = "operation";
    if (change === "action") action = "activate_app";
    if (change === "generation" || change === "window") {
      const status = f.controller.scenes.status.bind(f.controller.scenes);
      vi.spyOn(f.controller.scenes, "status").mockImplementation(() => {
        const value = status();
        if (change === "generation") value.generation++;
        else value.scene!.window.windowId = "different-window";
        return value;
      });
    }
    const receipt = f.receipts.get("operation")!;
    if (change === "receipt")
      receipt.envelope.binding.deviceId = "other-device";
    if (change === "terminal") delete receipt.result!.terminalEvidence;
    if (change === "uncertain" || change === "submitted")
      receipt.phase = change;
    await expect(
      f.controller.prepare(sceneId, operationId, action),
    ).rejects.toThrow();
    expect(f.events.filter((event) => event === "prepare")).toHaveLength(1);
    expect(f.events.filter((event) => event === "dispatch")).toHaveLength(1);
    expect(f.events).not.toContain("owner:none");
    expect(f.controller.status().prepared?.operation.operationId).toBe(
      "operation",
    );
  });

  it.each(["epoch", "cursor", "hold", "camera", "lease", "actors", "stop"])(
    "requires fresh original authority for raise after %s changes",
    async (change) => {
      const f = await returnedActivation();
      if (change === "epoch") f.owner.epoch++;
      if (change === "cursor") {
        f.owner.cursor++;
        f.owner.acknowledgedCursor++;
      }
      if (change === "hold") f.owner.hold.active = true;
      if (change === "camera") f.camera.capturedAt = 1;
      if (change === "lease") f.camera.leaseId = "replacement";
      if (change === "actors") f.actorsRunning();
      if (change === "stop") {
        const receipt = f.controller.native.receipt.bind(f.controller.native);
        vi.spyOn(f.controller.native, "receipt").mockImplementation(
          async (...args) => {
            const result = await receipt(...args);
            f.controller.stop();
            return result;
          },
        );
      }
      await expect(
        f.controller.prepare("finder", "raise", "raise_window"),
      ).rejects.toThrow();
      expect(f.events.filter((event) => event === "prepare")).toHaveLength(1);
      expect(f.events.filter((event) => event === "dispatch")).toHaveLength(1);
      expect(f.events).not.toContain("owner:none");
    },
  );

  it("never chains another raise after an unverified raise returns", async () => {
    const f = await returnedActivation();
    await f.controller.prepare("finder", "raise", "raise_window");
    await expect(f.controller.executePrepared(f.reference())).rejects.toThrow(
      "not verified",
    );
    await expect(
      f.controller.prepare("finder", "raise-again", "raise_window"),
    ).rejects.toThrow("terminal returned activation");
    expect(f.events.filter((event) => event === "prepare")).toHaveLength(2);
    expect(f.events.filter((event) => event === "dispatch")).toHaveLength(2);
  });

  it("retains both operation identities after an unknown raise reservation and refuses dispatch or replacement", async () => {
    const f = await returnedActivation();
    const originalReceipt = structuredClone(f.receipts.get("operation"));
    const api = vi.mocked(f.client.api);
    const original = api.getMockImplementation()!;
    api.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0].endsWith("prepare"))
        throw new Error("synthetic lost prepare response");
      return result;
    });
    await expect(
      f.controller.prepare("finder", "raise", "raise_window"),
    ).rejects.toThrow("unknown");
    expect(f.controller.status().prepared?.operation.operationId).toBe("raise");
    expect(f.controller.status().activationReceipt).toEqual(originalReceipt);
    await expect(f.controller.executePrepared(f.reference())).rejects.toThrow(
      "current fixed",
    );
    await expect(
      f.controller.prepare("finder", "replacement", "raise_window"),
    ).rejects.toThrow("terminal returned activation");
    expect(f.events.filter((event) => event === "prepare")).toHaveLength(2);
    expect(f.events.filter((event) => event === "dispatch")).toHaveLength(1);
  });

  it("allows a distinct fresh raise after the activation's planning expiry without extending its original receipt", async () => {
    const f = await returnedActivation(40000);
    const originalReceipt = structuredClone(f.receipts.get("operation"));
    f.camera.capturedAt = 21000;
    f.setTime(21000);
    const status = await f.controller.prepare(
      "finder",
      "raise",
      "raise_window",
    );
    expect(status.preparedExpiresAt).toBe(31000);
    expect(status.activationReceipt).toEqual(originalReceipt);
    expect(status.activationReceipt?.envelope.binding.expiresAt).toBe(20000);
    expect(f.receipts.get("operation")).toEqual(originalReceipt);
    expect(f.events.filter((event) => event === "dispatch")).toHaveLength(1);
  });

  it("reports the original preparation expiry without renewing or redispatching it", async () => {
    const f = fixture();
    await f.controller.prepare("finder", "operation");
    expect(f.controller.status()).toMatchObject({
      preparedExpiresAt: 20000,
      preparedExpired: false,
    });
    f.setTime(19999);
    expect(f.controller.status()).toMatchObject({
      preparedExpiresAt: 20000,
      preparedExpired: false,
    });
    f.setTime(20000);
    expect(f.controller.status()).toMatchObject({
      preparedExpiresAt: 20000,
      preparedExpired: true,
    });
    expect(f.events).not.toContain("dispatch");
    expect(f.events.filter((v) => v === "prepare")).toHaveLength(1);
  });

  it("does not prepare under a replacement native claim after its own claim acknowledgement", async () => {
    const f = fixture();
    const transfer = vi.mocked(f.client.conversationOperation);
    const original = transfer.getMockImplementation()!;
    transfer.mockImplementation(async (...args) => {
      const receipt = await original(...args);
      f.owner.epoch += 2;
      return receipt;
    });
    await expect(f.controller.prepare("finder", "operation")).rejects.toThrow(
      "Claimed native ownership changed",
    );
    expect(f.events).not.toContain("prepare");
  });

  it.each(["epoch", "policyRevision", "cursor"])(
    "does not release a different native %s after its operation finishes",
    async (field) => {
      const f = fixture();
      await f.controller.prepare("finder", "operation");
      f.setHook(() => {
        if (field === "epoch") f.owner.epoch += 2;
        if (field === "policyRevision") f.owner.policyRevision = 2;
        if (field === "cursor") {
          f.owner.cursor++;
          f.owner.acknowledgedCursor++;
        }
      });
      await expect(f.controller.executePrepared(f.reference())).rejects.toThrow(
        "ownership changed",
      );
      expect(f.events.filter((v) => v === "dispatch")).toHaveLength(1);
      expect(f.events).not.toContain("owner:none");
      expect(f.events).not.toContain("present");
      expect(f.owner.executor).toBe("native");
    },
  );

  it("claims an initial idle epoch-zero owner without a policy revision", async () => {
    const f = fixture();
    expect(f.owner).toMatchObject({
      executor: "none",
      state: "idle",
      epoch: 0,
    });
    expect(f.owner.policyRevision).toBeUndefined();
    await f.controller.prepare("finder", "operation");
    expect(
      f.controller.status().prepared?.operation.expected.policyRevision,
    ).toBe(1);
    expect(f.owner).toMatchObject({
      executor: "native",
      epoch: 1,
      policyRevision: 1,
    });
  });

  it("refuses a claimed owner whose policy revision is missing", async () => {
    const f = fixture();
    const transfer = vi.mocked(f.client.conversationOperation);
    const original = transfer.getMockImplementation()!;
    transfer.mockImplementation(async (...args) => {
      const result = await original(...args);
      f.owner.policyRevision = undefined;
      return result;
    });
    await expect(f.controller.prepare("finder", "operation")).rejects.toThrow(
      "concrete policy revision",
    );
    expect(f.events).not.toContain("prepare");
  });

  it("reserves before the fixed CUA trigger, verifies, releases and presents then replans", async () => {
    const f = fixture();
    await f.controller.prepare("finder", "operation");
    expect(f.events).toEqual(["clear", "overview", "owner:native", "prepare"]);
    await f.controller.executePrepared(f.reference());
    expect(f.events.slice(-3)).toEqual(["dispatch", "owner:none", "present"]);
    expect(f.controller.status().scene.phase).toBe("presented");
    f.controller.scenes.complete();
    await f.controller.replan(
      { ...f.plan, id: "followup" },
      f.controller.status().scene.generation,
    );
    expect(f.controller.status().scene).toMatchObject({
      phase: "idle",
      planCount: 2,
    });
  });
  it.each(["returned", "uncertain", "timeout"])(
    "retains ownership and refuses retry for %s",
    async (state) => {
      const f = fixture();
      f.setState(state);
      await f.controller.prepare("finder", "operation");
      await expect(
        f.controller.executePrepared(f.reference()),
      ).rejects.toThrow();
      await expect(f.controller.executePrepared(f.reference())).rejects.toThrow(
        "already attempted",
      );
      expect(f.events.filter((v) => v === "dispatch")).toHaveLength(1);
      expect(f.owner.executor).toBe("native");
      expect(f.events).not.toContain("present");
      await expect(
        f.controller.replan({ ...f.plan, id: "followup" }, 1),
      ).rejects.toThrow("Reconcile");
    },
  );
  it("blocks Stop at the awaited dispatch boundary from releasing or presenting", async () => {
    const f = fixture();
    await f.controller.prepare("finder", "operation");
    f.setHook(() => f.controller.stop());
    await expect(f.controller.executePrepared(f.reference())).rejects.toThrow(
      "stopped",
    );
    expect(f.owner.executor).toBe("native");
    expect(f.events).not.toContain("present");
  });
  it("preserves the native receipt when ownership release returns an unknown outcome", async () => {
    const f = fixture();
    await f.controller.prepare("finder", "operation");
    const transfer = vi.mocked(f.client.conversationOperation);
    const original = transfer.getMockImplementation()!;
    transfer.mockImplementation(async (...args) => {
      const result = await original(...args);
      if ((args[2] as { executor?: string }).executor === "none")
        throw new Error("synthetic release acknowledgement lost");
      return result;
    });
    await expect(f.controller.executePrepared(f.reference())).rejects.toThrow(
      "acknowledgement lost",
    );
    expect(f.owner.executor).toBe("none");
    expect(f.controller.status().receipt?.phase).toBe("verified");
    expect(f.events).not.toContain("present");
    await expect(f.controller.executePrepared(f.reference())).rejects.toThrow(
      "already attempted",
    );
    await expect(
      f.controller.replan({ ...f.plan, id: "followup" }, 1),
    ).rejects.toThrow("Reconcile");
    expect(f.events.filter((v) => v === "dispatch")).toHaveLength(1);
  });
  it("never repeats activation or presentation after a post-release presentation failure", async () => {
    const f = fixture();
    await f.controller.prepare("finder", "operation");
    vi.mocked(f.client.presentPreparedScene).mockRejectedValue(
      new Error("synthetic media failure"),
    );
    await expect(f.controller.executePrepared(f.reference())).rejects.toThrow(
      "unknown",
    );
    expect(f.owner.executor).toBe("none");
    expect(f.controller.status().receipt?.phase).toBe("verified");
    expect(f.controller.status().scene.unknownCommandId).not.toBeNull();
    await expect(f.controller.prepare("finder", "replacement")).rejects.toThrow(
      "unknown",
    );
    await expect(
      f.controller.replan({ ...f.plan, id: "followup" }, 1),
    ).rejects.toThrow("unknown");
    expect(f.events.filter((v) => v === "dispatch")).toHaveLength(1);
    expect(f.client.presentPreparedScene).toHaveBeenCalledTimes(1);
  });
  it("invalidates queued camera work when stopped during scene reset", async () => {
    const f = fixture();
    const camera = vi.mocked(f.client.screenCamera);
    const original = camera.getMockImplementation()!;
    camera.mockImplementation(async (id, command) => {
      const result = await original(id, command);
      if ((command as { op?: string } | undefined)?.op === "clear")
        f.controller.stop();
      return result;
    });
    await expect(f.controller.prepare("finder", "operation")).rejects.toThrow(
      "stopped",
    );
    expect(f.events).toEqual(["clear"]);
  });

  it("requires a current stopped-actors attestation", async () => {
    const f = fixture();
    f.actorsRunning();
    await expect(f.controller.prepare("finder", "operation")).rejects.toThrow(
      "Stop and join",
    );
    expect(f.events).not.toContain("prepare");
  });
  it("cancels nondispatched preparation and invalidates follow-up generation", async () => {
    const f = fixture();
    await f.controller.prepare("finder", "operation");
    await expect(
      f.controller.replan({ ...f.plan, id: "followup" }, 0),
    ).rejects.toThrow("generation");
    expect(f.events).not.toContain("cancel");
    await f.controller.replan({ ...f.plan, id: "followup" }, 1);
    expect(f.events.slice(4)).toEqual([
      "cancel",
      "owner:none",
      "clear",
      "overview",
      "clear",
      "overview",
    ]);
    expect(f.owner.executor).toBe("none");
    await expect(f.controller.executePrepared(f.reference())).rejects.toThrow(
      "current fixed",
    );
  });
  it("releases native ownership after the server rejects the preparation, so a new operation and a new plan can start", async () => {
    const f = fixture();
    const api = vi.mocked(f.client.api);
    const original = api.getMockImplementation()!;
    api.mockImplementation(async (path: string, body?: unknown) => {
      const record = (await original(path, body)) as ProductionNativeRecord;
      if (path.endsWith("prepare")) {
        // The server proves that no native input happened.
        record.phase = "rejected";
        record.result = {
          operationId: record.id,
          state: "rejected",
          reason: "local_policy_changed",
        };
        f.receipts.set(record.id, structuredClone(record));
      }
      return record as never;
    });
    await expect(f.controller.prepare("finder", "operation")).rejects.toThrow(
      "did not prepare",
    );
    expect(f.owner.executor).toBe("none");
    expect(f.controller.status()).toMatchObject({
      prepared: null,
      dispatchAttempted: false,
    });
    api.mockImplementation(original);
    await f.controller.prepare("finder", "operation-2");
    expect(f.owner.executor).toBe("native");
    await f.controller.replan(
      { ...f.plan, id: "followup" },
      f.controller.status().scene.generation,
    );
    expect(f.owner.executor).toBe("none");
    expect(f.events.filter((v) => v === "dispatch")).toHaveLength(0);
  });
  it("releases native ownership after the server rejects the dispatch before any input, and never dispatches it again", async () => {
    const f = fixture();
    await f.controller.prepare("finder", "operation");
    const api = vi.mocked(f.client.api);
    const original = api.getMockImplementation()!;
    api.mockImplementation(async (path: string, body?: unknown) => {
      if (path.endsWith("dispatch")) {
        const record = structuredClone(f.receipts.get("operation")!);
        record.phase = "rejected";
        record.result = {
          operationId: record.id,
          state: "rejected",
          reason: "incoming_speech",
        };
        f.receipts.set(record.id, structuredClone(record));
        f.events.push("dispatch");
        return record as never;
      }
      return original(path, body);
    });
    const reference = f.reference();
    await expect(f.controller.executePrepared(reference)).rejects.toThrow(
      "before any input",
    );
    expect(f.owner.executor).toBe("none");
    expect(f.events).not.toContain("present");
    await expect(f.controller.executePrepared(reference)).rejects.toThrow(
      "current fixed",
    );
    expect(f.events.filter((v) => v === "dispatch")).toHaveLength(1);
    api.mockImplementation(original);
    await f.controller.prepare("finder", "operation-2");
    expect(f.owner.executor).toBe("native");
    await f.controller.replan(
      { ...f.plan, id: "followup" },
      f.controller.status().scene.generation,
    );
    expect(f.owner.executor).toBe("none");
  });
  it("releases a rejected operation on the next plan when the first release could not run", async () => {
    const f = fixture();
    await f.controller.prepare("finder", "operation");
    const api = vi.mocked(f.client.api);
    const original = api.getMockImplementation()!;
    api.mockImplementation(async (path: string, body?: unknown) => {
      if (path.endsWith("dispatch")) {
        const record = structuredClone(f.receipts.get("operation")!);
        record.phase = "rejected";
        record.result = {
          operationId: record.id,
          state: "rejected",
          reason: "incoming_speech",
        };
        f.receipts.set(record.id, structuredClone(record));
        return record as never;
      }
      return original(path, body);
    });
    f.actorsRunning();
    await expect(f.controller.executePrepared(f.reference())).rejects.toThrow(
      "Stop and join",
    );
    expect(f.owner.executor).toBe("native");
    const stopped = vi.fn(() => true);
    Object.assign(f.controller.options, { backgroundActorsStopped: stopped });
    await f.controller.replan(
      { ...f.plan, id: "followup" },
      f.controller.status().scene.generation,
    );
    expect(f.owner.executor).toBe("none");
    expect(f.events).not.toContain("cancel");
  });
  it("authenticates loopback CUA trigger and refuses foreign origin or arbitrary operations", async () => {
    const f = fixture();
    await f.controller.prepare("finder", "operation");
    const trigger = await startProductionNativeTrigger(f.controller);
    try {
      const url = new URL(trigger.url);
      const headers = {
        authorization: `Bearer ${url.hash.slice(1)}`,
        "content-type": "application/json",
      };
      expect((await fetch(`${url.origin}/status`)).status).toBe(401);
      expect(
        (
          await fetch(`${url.origin}/execute`, {
            method: "POST",
            headers: { ...headers, origin: "https://foreign.invalid" },
            body: JSON.stringify(f.reference()),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${url.origin}/execute`, {
            method: "POST",
            headers,
            body: JSON.stringify({ ...f.reference(), action: "type" }),
          })
        ).status,
      ).toBe(409);
      expect(f.events).not.toContain("dispatch");
      expect(
        (
          await fetch(`${url.origin}/execute`, {
            method: "POST",
            headers,
            body: JSON.stringify(f.reference()),
          })
        ).status,
      ).toBe(200);
      expect(f.events.filter((v) => v === "dispatch")).toHaveLength(1);
    } finally {
      await trigger.close();
    }
  });
});

describe("foreground production walkthrough attachment", () => {
  it("attaches only to an existing exact session and retains a metadata-only no-replay journal", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "clawdtime-production-walkthrough-test-")),
    );
    const runFile = join(root, "runs", "run.json"),
      planFile = join(root, "plan.json"),
      connectionFile = join(root, "connection.json");
    const f = fixture();
    const session = {
      id: "session",
      externalSessionId: "original-chat",
      projectRoot: root,
      adapter: "codex",
      pairingId: "pair",
      hostId: "host",
      state: "active",
      protocolVersion: 2,
      capabilities: {
        nativeActivationVersion: 1,
        livePresentationVersion: 1,
        sharedSurface: true,
        nativeControl: "desktop",
      },
      screenCamera: {
        version: 1,
        surface: { kind: "display", id: "2", displayId: 2 },
      },
    };
    secureWrite(runFile, {
      schemaVersion: 1,
      runId: "original-chat",
      projectRoot: root,
      adapter: "codex",
      session,
      token: "synthetic-session",
    });
    secureWrite(connectionFile, {
      schemaVersion: 1,
      projectRoot: root,
      adapter: "codex",
      hostId: "host",
      pairing: { id: "pair" },
      baseUrl: "https://fixture.invalid",
      token: "synthetic-pairing",
    });
    secureWrite(planFile, f.plan);
    const input = new PassThrough(),
      output = new PassThrough(),
      messages: any[] = [];
    let buffer = "";
    output.on("data", (chunk) => {
      buffer += String(chunk);
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        messages.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
      }
    });
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        return new Response(
          JSON.stringify(
            path.endsWith("execution")
              ? { sessionId: "session" }
              : { enabled: true, operations: [] },
          ),
        );
      }),
    );
    const options = {
      runFile,
      connectionFile,
      planFile,
      requestId: "request",
      backgroundActorsStopped: true as const,
      input,
      output,
    };
    try {
      const running = startProductionWalkthroughSession(options);
      await vi.waitFor(() => expect(messages[0]?.event).toBe("ready"));
      expect(messages[0].sessionId).toBe("session");
      expect(messages[0].triggerUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
      input.write(JSON.stringify({ id: "stop-1", command: "stop" }) + "\n");
      await running;
      const saved = readFileSync(runFile + ".walkthrough.json", "utf8");
      expect(saved).not.toContain("Disposable folder");
      expect(saved).not.toContain("synthetic-session");
      expect(saved).not.toContain("triggerUrl");
      expect(paths).toEqual([
        "/api/attention/request/conversation/execution",
        "/api/attention/request/conversation/native-activation",
      ]);
      await expect(startProductionWalkthroughSession(options)).rejects.toThrow(
        "prior walkthrough journal",
      );
      session.capabilities.nativeActivationVersion = 0;
      secureWrite(runFile, {
        schemaVersion: 1,
        runId: "original-chat",
        projectRoot: root,
        adapter: "codex",
        session,
        token: "synthetic-session",
      });
      await expect(startProductionWalkthroughSession(options)).rejects.toThrow(
        "existing exact active",
      );
    } finally {
      vi.unstubAllGlobals();
      input.destroy();
      output.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
