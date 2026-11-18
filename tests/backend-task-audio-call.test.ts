import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { Vault, hash } from "../src/storage/security.js";
import {
  TaskAudioCallCoordinator,
  unresolvedTaskAudioCalls,
} from "../src/attention/task-audio-call.js";
import {
  taskAudioFingerprint,
  type TaskAudioPlan,
  type TaskAudioAuthorization,
  type TaskAudioPorts,
  type TaskAudioMediaObservation,
  type TaskAudioNativeObservation,
} from "../src/transport/task-audio.js";

const stores: Store[] = [];
afterEach(() => {
  stores.forEach((store) => store.close());
  stores.length = 0;
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const callId = "11111111-1111-4111-8111-111111111111";
function fixture(enabled = true) {
  let now = 1_000_000,
    allowed = true;
  const store = new Store();
  stores.push(store);
  const vault = new Vault("ab".repeat(32));
  const plan: TaskAudioPlan = {
    id: "one_call",
    taskSessionId: "task_session",
    taskId: "task",
    runId: "run",
    revision: 4,
    voiceSessionId: "voice",
    pairingId: "pair",
    memberId: "member",
    deviceId: "mac",
    lineId: "22222222-2222-4222-8222-222222222222",
    recipientHash: hash("+15550000001"),
    mediaSessionId: "media",
    workerIdentity: "incoming_worker",
    agentIdentity: "outgoing_agent",
    expiresAt: now + 240_000,
    audio: true,
    video: false,
    screen: false,
    presentation: false,
    control: false,
    maxCalls: 1,
  };
  const auth: TaskAudioAuthorization = {
    id: "one_authorization",
    planFingerprint: taskAudioFingerprint(plan),
    authorizedAt: now,
    expiresAt: now + 240_000,
    oneCallAuthorized: true,
  };
  let mediaState: TaskAudioMediaObservation["state"] = "absent";
  let nativeState: TaskAudioNativeObservation["state"] = "allocated",
    cleaned = false;
  const observation = (): TaskAudioMediaObservation => ({
    callAttemptId: plan.id,
    mediaSessionId: plan.mediaSessionId,
    state: mediaState,
    audio: true,
    video: false,
    screen: false,
    presentation: false,
    control: false,
    ...(mediaState === "active" ? { providerCallId: callId } : {}),
  });
  const credentials = {
    livekit_url: "wss://livekit.example.invalid",
    participant_token: "synthetic-private-token-".repeat(4),
    remote_participant_identity: plan.agentIdentity,
  };
  let coordinator!: TaskAudioCallCoordinator;
  const ports: TaskAudioPorts = {
    authorize: vi.fn(async () => {
      if (!allowed) throw new Error("authority revoked");
    }),
    readiness: vi.fn(async () => ({
      source: "synthetic" as const,
      checkedAt: now,
      planFingerprint: taskAudioFingerprint(plan),
      lineId: plan.lineId,
      pairingId: plan.pairingId,
      memberId: plan.memberId,
      deviceId: plan.deviceId,
      recipientHash: plan.recipientHash,
      idle: true,
      exclusiveOwner: true,
      identityVerified: true,
      cursorPreserved: true,
      cleanupClear: true,
      audioReady: true,
    })),
    media: {
      prepare: vi.fn(async () => {
        expect(coordinator.status(plan.id).receipts.media_prepare!.state).toBe(
          "running",
        );
        mediaState = "prepared";
        return {
          ...observation(),
          credentials,
          silentPublisherReady: true as const,
        };
      }),
      activate: vi.fn(async () => {
        expect(coordinator.status(plan.id).receipts.media_activate!.state).toBe(
          "running",
        );
        mediaState = "active";
        return observation();
      }),
      inspect: vi.fn(async () => observation()),
      close: vi.fn(async () => {
        expect(coordinator.status(plan.id).receipts.media_close!.state).toBe(
          "running",
        );
        mediaState = "closed";
        return observation();
      }),
    },
    calls: {
      create: vi.fn(async () => {
        expect(coordinator.status(plan.id).receipts.native_dial!.state).toBe(
          "running",
        );
        return { providerCallId: callId, lineId: plan.lineId };
      }),
      inspect: vi.fn(async () => ({
        providerCallId: callId,
        state: nativeState,
        cleanupComplete: cleaned,
      })),
      end: vi.fn(async () => {
        expect(coordinator.status(plan.id).receipts.native_end!.state).toBe(
          "running",
        );
        return { accepted: true as const, providerCallId: callId };
      }),
    },
  };
  coordinator = new TaskAudioCallCoordinator(store, vault, ports, {
    dispatchEnabled: enabled,
    clock: () => now,
  });
  const reserve = () => coordinator.reserve(plan, auth);
  return {
    store,
    vault,
    plan,
    auth,
    credentials,
    ports,
    coordinator,
    reserve,
    observation,
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      allowed = false;
    },
    connect: () => {
      nativeState = "connected";
    },
    cleanupNative: () => {
      nativeState = "terminal";
      cleaned = true;
    },
    mediaState: (state: TaskAudioMediaObservation["state"]) => {
      mediaState = state;
    },
  };
}

describe("one authorized handset audio call coordinator", () => {
  it("is disabled by default and preflight cannot allocate or dial", async () => {
    const f = fixture(false);
    f.reserve();
    expect(await f.coordinator.preflight(f.plan, f.auth)).toMatchObject({
      ready: true,
      dispatchEnabled: false,
      productionQualified: false,
      physicalAcceptance: false,
    });
    await expect(f.coordinator.prepare(f.plan.id)).rejects.toThrow(/disabled/);
    expect(f.ports.media.prepare).not.toHaveBeenCalled();
    expect(f.ports.calls.create).not.toHaveBeenCalled();
  });

  it("binds exact fresh authorization and reserves one global call, including unknowns", () => {
    const f = fixture();
    const admitted = f.reserve();
    expect(f.reserve()).toEqual(admitted);
    const changed = { ...f.plan, id: "another_call" };
    expect(() =>
      f.coordinator.reserve(changed, {
        ...f.auth,
        planFingerprint: taskAudioFingerprint(changed),
      }),
    ).toThrow(/reserves/);
    expect(() =>
      f.coordinator.reserve(f.plan, { ...f.auth, planFingerprint: "bad" }),
    ).toThrow(/authorization/);
    expect(() =>
      f.coordinator.reserve(
        { ...f.plan, video: true } as unknown as TaskAudioPlan,
        f.auth,
      ),
    ).toThrow();
    expect(unresolvedTaskAudioCalls(f.store, f.vault)).toEqual([
      {
        id: f.plan.id,
        state: "authorized",
        taskSessionId: f.plan.taskSessionId,
        taskId: f.plan.taskId,
      },
    ]);
    f.advance(240_001);
    expect(() => f.reserve()).toThrow(/authorization/);
  });

  it("commits each phase before effect, requires native connection, and separates cleanup evidence", async () => {
    const f = fixture();
    f.reserve();
    expect((await f.coordinator.prepare(f.plan.id)).state).toBe("prepared");
    await f.coordinator.prepare(f.plan.id);
    expect(f.ports.media.prepare).toHaveBeenCalledTimes(1);
    expect((await f.coordinator.dial(f.plan.id)).state).toBe("ringing");
    await f.coordinator.dial(f.plan.id);
    expect(f.ports.calls.create).toHaveBeenCalledTimes(1);
    await expect(f.coordinator.activate(f.plan.id)).rejects.toThrow(
      /connection/,
    );
    expect(f.ports.media.activate).not.toHaveBeenCalled();
    f.connect();
    expect((await f.coordinator.activate(f.plan.id)).state).toBe("connected");
    const stopped = await f.coordinator.stop(f.plan.id);
    expect(stopped.mediaClosed).toBe(true);
    expect(stopped.nativeCleanupComplete).toBe(false);
    expect(stopped.cleanupConfirmed).toBe(false);
    await f.coordinator.stop(f.plan.id);
    expect(f.ports.media.close).toHaveBeenCalledTimes(1);
    expect(f.ports.calls.end).toHaveBeenCalledTimes(1);
    f.cleanupNative();
    expect((await f.coordinator.inspect(f.plan.id)).cleanupConfirmed).toBe(
      true,
    );
    expect(unresolvedTaskAudioCalls(f.store, f.vault)).toEqual([]);
  });

  it("does not redial an unknown allocation or invent its missing provider identity", async () => {
    const f = fixture();
    f.reserve();
    await f.coordinator.prepare(f.plan.id);
    f.ports.calls.create = vi.fn(async () => {
      throw new Error("synthetic lost dial acknowledgment");
    });
    expect((await f.coordinator.dial(f.plan.id)).state).toBe("unknown");
    await f.coordinator.dial(f.plan.id);
    expect(f.ports.calls.create).toHaveBeenCalledTimes(1);
    await f.coordinator.stop(f.plan.id);
    f.cleanupNative();
    const status = await f.coordinator.inspect(f.plan.id);
    expect(status.cleanupConfirmed).toBe(false);
    expect(status.providerCallId).toBeUndefined();
    expect(f.ports.calls.end).not.toHaveBeenCalled();
    expect(f.ports.calls.inspect).not.toHaveBeenCalled();
    expect(unresolvedTaskAudioCalls(f.store, f.vault)).toHaveLength(1);
  });

  it("revalidates authority before dial and after native connection observation", async () => {
    const f = fixture();
    f.reserve();
    await f.coordinator.prepare(f.plan.id);
    f.revoke();
    await expect(f.coordinator.dial(f.plan.id)).rejects.toThrow(/revoked/);
    expect(f.ports.calls.create).not.toHaveBeenCalled();
    const g = fixture();
    g.reserve();
    await g.coordinator.prepare(g.plan.id);
    await g.coordinator.dial(g.plan.id);
    g.connect();
    g.ports.calls.inspect = vi.fn(async () => {
      g.revoke();
      return {
        providerCallId: callId,
        state: "connected" as const,
        cleanupComplete: false,
      };
    });
    await expect(g.coordinator.activate(g.plan.id)).rejects.toThrow(/revoked/);
    expect(g.ports.media.activate).not.toHaveBeenCalled();
  });

  it("refuses stale or nonexclusive readiness and contradictory audio preparation", async () => {
    const f = fixture();
    f.reserve();
    const readiness = await f.ports.readiness(f.plan, f.auth);
    f.ports.readiness = vi.fn(async () => ({
      ...readiness,
      exclusiveOwner: false,
    }));
    await expect(f.coordinator.prepare(f.plan.id)).rejects.toThrow(/exclusive/);
    f.ports.readiness = vi.fn(async () => ({
      ...readiness,
      checkedAt: f.clock() - 10001,
    }));
    await expect(f.coordinator.prepare(f.plan.id)).rejects.toThrow(/readiness/);
    expect(f.ports.media.prepare).not.toHaveBeenCalled();
    f.ports.readiness = vi.fn(async () => readiness);
    f.ports.media.prepare = vi.fn(async () => ({
      ...f.observation(),
      state: "prepared",
      video: true,
      credentials: f.credentials,
      silentPublisherReady: true,
    })) as TaskAudioPorts["media"]["prepare"];
    expect((await f.coordinator.prepare(f.plan.id)).state).toBe("unknown");
    await expect(f.coordinator.dial(f.plan.id)).rejects.toThrow(/preparation/);
  });

  it("retains encryption and does not dispatch on restart; standby can clean exact owned effects", async () => {
    const f = fixture();
    f.reserve();
    await f.coordinator.prepare(f.plan.id);
    await f.coordinator.dial(f.plan.id);
    const stored = JSON.stringify(f.store.query("SELECT * FROM entities"));
    expect(stored).not.toContain(f.credentials.participant_token);
    expect(JSON.stringify(f.coordinator.status(f.plan.id))).not.toContain(
      "participant_token",
    );
    const restarted = new TaskAudioCallCoordinator(f.store, f.vault, f.ports, {
      clock: f.clock,
    });
    expect(restarted.status(f.plan.id).state).toBe("unknown");
    expect(f.ports.calls.create).toHaveBeenCalledTimes(1);
    await expect(restarted.activate(f.plan.id)).rejects.toThrow();
    const stopped = await restarted.stop(f.plan.id);
    expect(stopped.mediaClosed).toBe(true);
    expect(f.ports.calls.end).toHaveBeenCalledTimes(1);
    f.cleanupNative();
    expect((await restarted.inspect(f.plan.id)).cleanupConfirmed).toBe(true);
    expect(f.ports.calls.create).toHaveBeenCalledTimes(1);
  });

  it("does not release reservation while a delayed preparation can still create media", async () => {
    const f = fixture();
    f.reserve();
    const pending =
      deferred<Awaited<ReturnType<TaskAudioPorts["media"]["prepare"]>>>();
    f.ports.media.prepare = vi.fn(() => pending.promise);
    const preparing = f.coordinator.prepare(f.plan.id);
    await vi.waitFor(() =>
      expect(f.ports.media.prepare).toHaveBeenCalledTimes(1),
    );
    await f.coordinator.stop(f.plan.id);
    expect(f.coordinator.status(f.plan.id).cleanupConfirmed).toBe(false);
    expect(() =>
      f.coordinator.reserve(
        { ...f.plan, id: "new" },
        {
          ...f.auth,
          planFingerprint: taskAudioFingerprint({ ...f.plan, id: "new" }),
        },
      ),
    ).toThrow(/reserves/);
    f.mediaState("prepared");
    pending.resolve({
      ...f.observation(),
      credentials: f.credentials,
      silentPublisherReady: true,
    });
    await preparing;
    expect(f.coordinator.status(f.plan.id).mediaClosed).toBe(false);
    expect(f.coordinator.status(f.plan.id).cleanupConfirmed).toBe(false);
    await f.coordinator.inspect(f.plan.id);
    expect(f.coordinator.status(f.plan.id).cleanupConfirmed).toBe(false);
    expect(f.ports.media.close).toHaveBeenCalledTimes(1);
    f.mediaState("closed");
    expect((await f.coordinator.inspect(f.plan.id)).cleanupConfirmed).toBe(
      true,
    );
  });

  it("retains the line through delayed activation and only trusts a post-completion cleanup read", async () => {
    const f = fixture();
    f.reserve();
    await f.coordinator.prepare(f.plan.id);
    await f.coordinator.dial(f.plan.id);
    f.connect();
    const pending = deferred<TaskAudioMediaObservation>();
    f.ports.media.activate = vi.fn(() => pending.promise);
    const activating = f.coordinator.activate(f.plan.id);
    await vi.waitFor(() =>
      expect(f.ports.media.activate).toHaveBeenCalledTimes(1),
    );
    await f.coordinator.stop(f.plan.id);
    f.cleanupNative();
    expect((await f.coordinator.inspect(f.plan.id)).cleanupConfirmed).toBe(
      false,
    );
    f.mediaState("active");
    pending.resolve(f.observation());
    await activating;
    expect(f.coordinator.status(f.plan.id).mediaClosed).toBe(false);
    expect(unresolvedTaskAudioCalls(f.store, f.vault)).toHaveLength(1);
    f.mediaState("closed");
    expect((await f.coordinator.inspect(f.plan.id)).cleanupConfirmed).toBe(
      true,
    );
    expect(f.ports.media.close).toHaveBeenCalledTimes(1);
    expect(f.ports.calls.end).toHaveBeenCalledTimes(1);
  });

  it("retains late native allocation and uses its first cleanup only after the exact ID is known", async () => {
    const f = fixture();
    f.reserve();
    await f.coordinator.prepare(f.plan.id);
    const pending = deferred<{ providerCallId: string; lineId: string }>();
    f.ports.calls.create = vi.fn(() => pending.promise);
    const dialing = f.coordinator.dial(f.plan.id);
    await vi.waitFor(() =>
      expect(f.ports.calls.create).toHaveBeenCalledTimes(1),
    );
    await f.coordinator.stop(f.plan.id);
    expect(f.ports.calls.end).not.toHaveBeenCalled();
    expect(f.coordinator.status(f.plan.id).cleanupConfirmed).toBe(false);
    pending.resolve({ providerCallId: callId, lineId: f.plan.lineId });
    await dialing;
    expect(f.coordinator.status(f.plan.id).providerCallId).toBe(callId);
    await f.coordinator.stop(f.plan.id);
    expect(f.ports.calls.end).toHaveBeenCalledTimes(1);
    f.cleanupNative();
    expect((await f.coordinator.inspect(f.plan.id)).cleanupConfirmed).toBe(
      true,
    );
  });

  it("never repeats uncertain cleanup even when asked to stop again", async () => {
    const f = fixture();
    f.reserve();
    await f.coordinator.prepare(f.plan.id);
    await f.coordinator.dial(f.plan.id);
    f.ports.calls.end = vi.fn(async () => {
      throw new Error("end acknowledgment lost");
    });
    f.ports.media.close = vi.fn(async () => {
      throw new Error("media close acknowledgment lost");
    });
    await f.coordinator.stop(f.plan.id);
    await f.coordinator.stop(f.plan.id);
    expect(f.ports.calls.end).toHaveBeenCalledTimes(1);
    expect(f.ports.media.close).toHaveBeenCalledTimes(1);
    expect(f.coordinator.status(f.plan.id).cleanupConfirmed).toBe(false);
    f.cleanupNative();
    f.mediaState("closed");
    const reconciled = await f.coordinator.inspect(f.plan.id);
    expect(reconciled.cleanupConfirmed).toBe(true);
    expect(reconciled.receipts.native_end!.state).toBe("unknown");
    expect(reconciled.receipts.media_close!.state).toBe("unknown");
  });
});
