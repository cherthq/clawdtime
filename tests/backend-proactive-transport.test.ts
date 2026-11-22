import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { ProactivePolicyAuthority } from "../src/attention/proactive-policy.js";
import { ProactiveCallCoordinator } from "../src/attention/proactive-coordinator.js";
import {
  ProactiveTransport,
  type ProactiveMediaAttempt,
} from "../src/control/proactive-transport.js";
import {
  ProactiveLineSessions,
  type ProactiveLineBinding,
} from "../src/control/proactive-line.js";
import type { ProactiveReviewPacket } from "../src/control/proactive-preparation.js";
import type {
  NativeTaskAudioCalls,
  TaskAudioNativeObservation,
} from "../src/transport/task-audio.js";
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const digest = "ab".repeat(32),
  lineId = "00000000-0000-4000-8000-000000000001",
  providerCallId = "00000000-0000-4000-8000-000000000002";
function fixture(
  channel: "phone_alert" | "phone_walkthrough" = "phone_walkthrough",
) {
  let now = 1000,
    sourceCurrent = true;
  const clock = () => now,
    store = new Store(),
    vault = new Vault("cd".repeat(32));
  stores.push(store);
  const authority = new ProactivePolicyAuthority(store, vault, clock),
    coordinator = new ProactiveCallCoordinator(store, vault, authority, clock);
  authority.register({
    version: 2,
    id: "policy",
    scope: { personId: "human", deviceId: "mac", projectRoot: "/fixture" },
    triggers: ["completion"],
    channels: [channel],
    expiresAt: 300000,
    maxAttempts: 1,
    minIntervalMs: 0,
    attemptLifetimeMs: 60000,
    viewScope: channel === "phone_walkthrough" ? ["prepared-review"] : [],
    alertFallback: false,
    consent: {
      actorId: "human",
      recordedAt: now,
      source: "human_request",
      statement: "Call with this checked result.",
    },
  });
  let intent = coordinator.enqueue({
    source: {
      kind: "session",
      sessionId: "session",
      runId: "run",
      enrollmentId: "enrolled",
      terminalEventId: "terminal",
    },
    scope: {
      personId: "human",
      deviceId: "mac",
      projectRoot: "/fixture",
      sessionId: "session",
    },
    policyId: "policy",
    trigger: "completion",
    channel,
    expiresAt: 300000,
    brief: "Fixture review.",
  }).record;
  coordinator.prepare(intent.id);
  coordinator.ready(intent.id, digest);
  const reservation = coordinator.reserve(intent.id, {
    sourceCurrent: true,
    lineAvailable: true,
    packetFingerprint: digest,
  });
  intent = reservation.record;
  const grant = reservation.grant!;
  const packet: ProactiveReviewPacket = {
    id: intent.id,
    version: 1,
    intentId: intent.id,
    source: intent.source,
    sourceFingerprint: digest,
    policyId: "policy",
    policyRevision: 1,
    channel,
    goal: "Fixture",
    status: "verified",
    summary: "Checked fixture.",
    choices: [],
    checks: [],
    artifacts: [],
    narration: "Checked fixture.",
    views: [],
    walkthroughOrder: [],
    createdAt: now,
    expiresAt: now + 1000,
    fingerprint: digest,
  };
  const sessions = new ProactiveLineSessions(
    authority,
    {
      sourceCurrent: () => sourceCurrent,
      answer: async () => "answered",
      stopSharing: async () => ({ confirmed: true }),
    },
    clock,
  );
  const line = {
    readiness: vi.fn(async () => ({ ready: true })),
    acquire: vi.fn(async () => {
      expect(coordinator.transport.get(grant.attemptId, "handoff")?.state).toBe(
        "running",
      );
      return { exclusive: true as const };
    }),
    verify: vi.fn(async () => true),
    restore: vi.fn(async () => {
      expect(coordinator.transport.get(grant.attemptId, "restore")?.state).toBe(
        "running",
      );
      return { confirmed: true };
    }),
  };
  let config: ReturnType<ProactiveLineSessions["open"]> | undefined;
  const binding = (): ProactiveLineBinding => ({
    attemptId: config!.attemptId,
    roomName: config!.roomName,
    agentIdentity: config!.agentIdentity,
    sourceFingerprint: config!.sourceFingerprint,
    packetFingerprint: config!.packetFingerprint,
  });
  const handle = {
    inspect: vi.fn(async () => ({ ready: true })),
    prepare: vi.fn(async () => {
      expect(
        coordinator.transport.get(grant.attemptId, "media_prepare")?.state,
      ).toBe("running");
      await sessions.command(grant.attemptId, config!.token, {
        action: "prepared",
        binding: binding(),
        media: { audioReady: true, videoReady: true },
      });
      return {
        credentials: {
          livekit_url: "wss://fixture.invalid",
          participant_token: "synthetic".repeat(10),
          remote_participant_identity: `agent_${grant.attemptId}`,
        },
      };
    }),
    close: vi.fn(async () => ({ closed: true })),
  };
  const media = vi.fn(
    async (input: {
      config: ReturnType<ProactiveLineSessions["open"]> & {
        providerCallerIdentity: string;
      };
      agentName: string;
    }): Promise<ProactiveMediaAttempt> => {
      expect(
        coordinator.transport.get(grant.attemptId, "media_allocate")?.state,
      ).toBe("running");
      config = input.config;
      return handle;
    },
  );
  const calls = {
    createProactive: vi.fn<NativeTaskAudioCalls["createProactive"]>(
      async () => {
        expect(coordinator.get(intent.id).state).toBe("dispatching");
        expect(coordinator.transport.get(grant.attemptId, "dial")?.state).toBe(
          "running",
        );
        return { providerCallId, lineId };
      },
    ),
    inspectProactive: vi.fn<NativeTaskAudioCalls["inspectProactive"]>(
      async () => ({
        providerCallId,
        state: "terminal",
        cleanupComplete: true,
        remoteVideoReady: true,
      }),
    ),
    endProactive: vi.fn<NativeTaskAudioCalls["endProactive"]>(async () => ({
      accepted: true,
      providerCallId,
    })),
  };
  const cleanupViews = vi.fn(async () => ({ confirmed: true })),
    freshFrame = vi.fn(async () => ({
      capturedAt: now,
      sourceFingerprint: digest,
    }));
  const transport = new ProactiveTransport({
    coordinator,
    line,
    calls,
    sessions,
    packet: () => packet,
    current: () => sourceCurrent,
    sourceFingerprint: () => digest,
    destination: {
      lineId,
      recipientHash: digest,
      personId: "human",
      deviceId: "mac",
      projectRoot: "/fixture",
    },
    media,
    cleanupViews,
    freshFrame,
    now: clock,
    pause: async (ms) => {
      now += Math.max(ms, 1000);
    },
  });
  return {
    store,
    vault,
    authority,
    coordinator,
    intent,
    grant,
    packet,
    sessions,
    line,
    handle,
    media,
    calls,
    cleanupViews,
    freshFrame,
    transport,
    clock,
    time: (t: number) => {
      now = t;
    },
    source: (current: boolean) => {
      sourceCurrent = current;
    },
    binding,
    config: () => config!,
  };
}
const terminal = (cleanupComplete = true): TaskAudioNativeObservation => ({
  providerCallId,
  state: "terminal",
  cleanupComplete,
});
const connected: TaskAudioNativeObservation = {
  providerCallId,
  state: "connected",
  cleanupComplete: false,
};

describe("durable generic proactive transport", () => {
  it("reserves handoff/media/dial before effects and restores incoming only after exact cleanup", async () => {
    const f = fixture();
    const result = await f.transport.deliver(f.intent, f.grant);
    expect(result).toEqual({ state: "ended", cleanupConfirmed: true });
    expect(f.calls.createProactive).toHaveBeenCalledTimes(1);
    expect(f.line.restore).toHaveBeenCalledTimes(1);
    expect(f.sessions.status(f.grant.attemptId)).toBeNull();
    expect(
      f.coordinator.transport
        .list(f.grant.attemptId)
        .every((r) => r.state === "done"),
    ).toBe(true);
    expect(f.authority.get("policy")?.attempts).toBe(1);
    expect(await f.transport.deliver(f.intent, f.grant)).toMatchObject({
      state: "unknown",
      cleanupConfirmed: false,
    });
    expect(f.calls.createProactive).toHaveBeenCalledTimes(1);
  });
  it("preserves a lost handoff response without restoring or treating idle as unowned", async () => {
    const f = fixture();
    f.line.acquire.mockRejectedValue(
      Error("lost response after owner changed"),
    );
    expect(await f.transport.deliver(f.intent, f.grant)).toMatchObject({
      state: "unknown",
      cleanupConfirmed: false,
    });
    expect(
      f.coordinator.transport.get(f.grant.attemptId, "handoff")?.state,
    ).toBe("unknown");
    expect(f.line.restore).not.toHaveBeenCalled();
    expect(f.media).not.toHaveBeenCalled();
    expect(await f.transport.readiness(f.intent)).toMatchObject({
      ready: false,
    });
  });
  it("preserves unknown room allocation when no owned cleanup handle returned", async () => {
    const f = fixture();
    f.media.mockRejectedValue(Error("room spawned then response lost"));
    expect(await f.transport.deliver(f.intent, f.grant)).toMatchObject({
      state: "unknown",
      cleanupConfirmed: false,
    });
    expect(f.line.restore).not.toHaveBeenCalled();
    expect(f.calls.createProactive).not.toHaveBeenCalled();
    expect(
      f.coordinator.transport.get(f.grant.attemptId, "media_allocate")?.state,
    ).toBe("unknown");
  });
  it("can reconcile failed preparation with positive owned media cleanup before restoring", async () => {
    const f = fixture();
    f.handle.prepare.mockRejectedValue(Error("publication unknown"));
    expect(await f.transport.deliver(f.intent, f.grant)).toEqual({
      state: "refused",
      cleanupConfirmed: true,
    });
    expect(f.handle.close).toHaveBeenCalledTimes(1);
    expect(f.line.restore).toHaveBeenCalledTimes(1);
    expect(
      f.coordinator.transport.get(f.grant.attemptId, "media_prepare")?.evidence,
    ).toBe("media_cleanup_reconciled");
  });
  it("never redials or restores incoming after a lost dial response", async () => {
    const f = fixture();
    f.calls.createProactive.mockRejectedValue(Error("lost dial response"));
    expect(await f.transport.deliver(f.intent, f.grant)).toMatchObject({
      state: "unknown",
      cleanupConfirmed: false,
    });
    expect(f.calls.createProactive).toHaveBeenCalledTimes(1);
    expect(f.calls.endProactive).not.toHaveBeenCalled();
    expect(f.line.restore).not.toHaveBeenCalled();
    expect(f.coordinator.transport.get(f.grant.attemptId, "dial")?.state).toBe(
      "unknown",
    );
  });
  it("reconciles lost end by observing the original call; never sends end twice", async () => {
    const f = fixture();
    let seen = 0;
    f.calls.inspectProactive.mockImplementation(async () => {
      if (seen++ === 0) {
        await f.transport.stop(f.intent);
        return connected;
      }
      return terminal();
    });
    f.calls.endProactive.mockRejectedValue(Error("lost end"));
    expect(await f.transport.deliver(f.intent, f.grant)).toEqual({
      state: "ended",
      cleanupConfirmed: true,
    });
    expect(f.calls.endProactive).toHaveBeenCalledTimes(1);
    expect(
      f.coordinator.transport.get(f.grant.attemptId, "end")?.evidence,
    ).toBe("provider_cleanup_observed");
  });
  it("keeps unknown end fenced if exact provider cleanup never arrives", async () => {
    const f = fixture();
    f.calls.inspectProactive.mockImplementation(async () => {
      await f.transport.stop(f.intent);
      return connected;
    });
    f.calls.endProactive.mockRejectedValue(Error("lost end"));
    expect(await f.transport.deliver(f.intent, f.grant)).toMatchObject({
      state: "unknown",
      cleanupConfirmed: false,
    });
    expect(f.calls.endProactive).toHaveBeenCalledTimes(1);
    expect(f.line.restore).not.toHaveBeenCalled();
  });
  it("defers an incoming call without handoff or dial, cleaning only its preparation", async () => {
    const f = fixture();
    f.line.readiness.mockResolvedValue({ ready: false });
    expect(await f.transport.deliver(f.intent, f.grant)).toEqual({
      state: "refused",
      cleanupConfirmed: true,
    });
    expect(f.line.acquire).not.toHaveBeenCalled();
    expect(f.calls.createProactive).not.toHaveBeenCalled();
    expect(f.cleanupViews).toHaveBeenCalledTimes(1);
  });
  it.each(["revoked", "source_changed", "stopped"])(
    "rechecks %s after media allocation before doing more effects",
    async (reason) => {
      const f = fixture(),
        allocate = f.media.getMockImplementation()!;
      f.media.mockImplementation(async (input) => {
        const handle = await allocate(input);
        if (reason === "revoked") f.authority.revoke("policy");
        if (reason === "source_changed") f.source(false);
        if (reason === "stopped") await f.transport.stop(f.intent);
        return handle;
      });
      expect(await f.transport.deliver(f.intent, f.grant)).toEqual({
        state: "refused",
        cleanupConfirmed: true,
      });
      expect(f.calls.createProactive).not.toHaveBeenCalled();
      expect(f.handle.prepare).not.toHaveBeenCalled();
    },
  );
  it("checks source and Stop again after the last async owner verification", async () => {
    const f = fixture();
    f.line.verify.mockImplementation(async () => {
      f.source(false);
      return true;
    });
    expect(await f.transport.deliver(f.intent, f.grant)).toEqual({
      state: "refused",
      cleanupConfirmed: true,
    });
    expect(f.calls.createProactive).not.toHaveBeenCalled();
  });
  it.each(["capture", "media", "restore", "capability"])(
    "retains uncertainty on failed %s cleanup",
    async (component) => {
      const f = fixture();
      if (component === "capture")
        f.cleanupViews.mockResolvedValue({ confirmed: false });
      if (component === "media")
        f.handle.close.mockResolvedValue({ closed: false });
      if (component === "restore")
        f.line.restore.mockRejectedValue(Error("lost restore"));
      if (component === "capability")
        vi.spyOn(f.sessions, "confirmClosed").mockImplementation(() => {
          throw Error("capability not retired");
        });
      expect(await f.transport.deliver(f.intent, f.grant)).toMatchObject({
        state: "unknown",
        cleanupConfirmed: false,
      });
      if (["capture", "media"].includes(component))
        expect(f.line.restore).not.toHaveBeenCalled();
      expect(await f.transport.readiness(f.intent)).toMatchObject({
        ready: false,
      });
    },
  );
  it("admits a fresh packet before slow handoff and requires a fresh actual frame before dialing", async () => {
    const f = fixture(),
      acquire = f.line.acquire.getMockImplementation()!;
    f.line.acquire.mockImplementation(async () => {
      expect(f.sessions.status(f.grant.attemptId)).toMatchObject({
        prepared: false,
        closed: false,
      });
      const result = await acquire();
      f.time(10000);
      return result;
    });
    expect(await f.transport.deliver(f.intent, f.grant)).toEqual({
      state: "ended",
      cleanupConfirmed: true,
    });
    expect(f.freshFrame).toHaveBeenCalledTimes(1);
    expect(f.calls.createProactive).toHaveBeenCalledTimes(1);
    expect(f.sessions.status(f.grant.attemptId)).toBeNull();
  });
  it.each(["revoked", "changed_source", "stopped"])(
    "cleans the admitted capability if %s during slow handoff",
    async (reason) => {
      const f = fixture(),
        acquire = f.line.acquire.getMockImplementation()!;
      f.line.acquire.mockImplementation(async () => {
        const result = await acquire();
        f.time(10000);
        if (reason === "revoked") f.authority.revoke("policy");
        if (reason === "changed_source") f.source(false);
        if (reason === "stopped") await f.transport.stop(f.intent);
        return result;
      });
      expect(await f.transport.deliver(f.intent, f.grant)).toEqual({
        state: "refused",
        cleanupConfirmed: true,
      });
      expect(f.media).not.toHaveBeenCalled();
      expect(f.calls.createProactive).not.toHaveBeenCalled();
      expect(f.line.restore).toHaveBeenCalledTimes(1);
      expect(f.sessions.status(f.grant.attemptId)).toBeNull();
    },
  );
  it("refreshes actual frames after slow room startup and refuses stale frame evidence", async () => {
    const f = fixture(),
      prepare = f.handle.prepare.getMockImplementation()!;
    f.handle.prepare.mockImplementation(async () => {
      f.time(8000);
      return prepare();
    });
    expect(await f.transport.deliver(f.intent, f.grant)).toEqual({
      state: "ended",
      cleanupConfirmed: true,
    });
    expect(f.freshFrame).toHaveBeenCalledTimes(1);
    const g = fixture();
    g.freshFrame.mockResolvedValue({
      capturedAt: 0,
      sourceFingerprint: digest,
    });
    g.time(1500);
    expect(await g.transport.deliver(g.intent, g.grant)).toEqual({
      state: "refused",
      cleanupConfirmed: true,
    });
    expect(g.calls.createProactive).not.toHaveBeenCalled();
  });
  it("captures after a slow final owner verification and rejects publication loss before dial", async () => {
    const f = fixture();
    f.line.verify.mockImplementation(async () => {
      f.time(8000);
      return true;
    });
    f.freshFrame.mockImplementation(async () => {
      expect(f.clock()).toBe(8000);
      return { capturedAt: f.clock(), sourceFingerprint: digest };
    });
    expect(await f.transport.deliver(f.intent, f.grant)).toEqual({
      state: "ended",
      cleanupConfirmed: true,
    });
    expect(f.calls.createProactive).toHaveBeenCalledTimes(1);
    const g = fixture();
    g.handle.inspect.mockResolvedValue({ ready: false });
    expect(await g.transport.deliver(g.intent, g.grant)).toEqual({
      state: "refused",
      cleanupConfirmed: true,
    });
    expect(g.calls.createProactive).not.toHaveBeenCalled();
    expect(g.line.restore).toHaveBeenCalledTimes(1);
  });
  it("ends the owned call once if media disappears after preparation", async () => {
    const f = fixture();
    f.handle.inspect
      .mockResolvedValueOnce({ ready: true })
      .mockResolvedValue({ ready: false });
    f.calls.inspectProactive
      .mockResolvedValueOnce(connected)
      .mockResolvedValue(terminal());
    expect(await f.transport.deliver(f.intent, f.grant)).toEqual({
      state: "ended",
      cleanupConfirmed: true,
    });
    expect(f.calls.endProactive).toHaveBeenCalledTimes(1);
    expect(f.line.restore).toHaveBeenCalledTimes(1);
  });
  it("does not require viewing permission or frames for a spoken alert", async () => {
    const f = fixture("phone_alert");
    expect(await f.transport.deliver(f.intent, f.grant)).toEqual({
      state: "ended",
      cleanupConfirmed: true,
    });
    expect(f.freshFrame).not.toHaveBeenCalled();
    expect(f.grant.viewScope).toEqual([]);
  });
  it("retains connected calls on result revision for neutral continuous sharing but stops on policy loss", async () => {
    const f = fixture();
    let seen = 0;
    f.calls.inspectProactive.mockImplementation(async () => {
      if (seen++ === 0) {
        f.source(false);
        return connected;
      }
      return terminal();
    });
    expect(await f.transport.deliver(f.intent, f.grant)).toEqual({
      state: "ended",
      cleanupConfirmed: true,
    });
    expect(f.calls.endProactive).not.toHaveBeenCalled();
    const g = fixture();
    let second = 0;
    g.calls.inspectProactive.mockImplementation(async () => {
      if (second++ === 0) {
        g.authority.revoke("policy");
        return connected;
      }
      return terminal();
    });
    expect(await g.transport.deliver(g.intent, g.grant)).toEqual({
      state: "ended",
      cleanupConfirmed: true,
    });
    expect(g.calls.endProactive).toHaveBeenCalledTimes(1);
  });
  it("retires a retained in-process owner only after exact durable reconciliation", async () => {
    const f = fixture();
    f.line.acquire.mockRejectedValue(Error("lost handoff"));
    await f.transport.deliver(f.intent, f.grant);
    expect(() => f.transport.retireReconciled(f.grant.attemptId)).toThrow();
    f.coordinator.outcome(f.intent.id, f.grant.attemptId, "unknown");
    f.coordinator.reconcileOutcome(f.intent.id, {
      attemptId: f.grant.attemptId,
      providerReceiptId: "verified-no-call",
      cleanupReceiptId: "original-owner-confirmed",
      outcome: "refused",
    });
    expect(() => f.transport.retireReconciled(f.grant.attemptId)).toThrow();
    f.coordinator.transport.settle(f.grant.attemptId, "handoff", {
      evidence: "original_owner_retained_verified",
    });
    expect(() => f.transport.retireReconciled(f.grant.attemptId)).toThrow();
    f.sessions.confirmClosed(f.grant.attemptId, {
      captureCleanupConfirmed: true,
      mediaClosed: true,
      providerEnded: true,
    });
    f.transport.retireReconciled(f.grant.attemptId);
    expect(await f.transport.readiness(f.intent)).toMatchObject({
      ready: true,
    });
    expect(f.line.restore).not.toHaveBeenCalled();
  });
  it("recovers running media receipts as unknown on restart without changing baseline storage", () => {
    const f = fixture();
    f.coordinator.transport.reserve(
      f.intent.id,
      f.grant.attemptId,
      "room_create",
    );
    const restarted = new ProactiveCallCoordinator(
      f.store,
      f.vault,
      f.authority,
      f.clock,
    );
    expect(
      restarted.transport.get(f.grant.attemptId, "room_create")?.state,
    ).toBe("unknown");
    expect(restarted.get(f.intent.id).state).toBe("unknown");
    expect(() =>
      restarted.transport.reserve(
        f.intent.id,
        f.grant.attemptId,
        "room_create",
      ),
    ).toThrow(/never blindly retry/);
    expect(f.store.query("PRAGMA user_version")).toEqual([{ user_version: 1 }]);
  });
});
