import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/storage/store.js";
import { NativeReservationStore } from "../src/storage/native-reservations.js";
import { hash } from "../src/storage/security.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { assertAudioQualificationIdle } from "../src/attention/audio-qualification.js";
import type { ProductionNativeEnvelope } from "../src/production-native-contracts.js";
import {
  nativePresentationOperationSchema,
  type NativePresentationHostResult,
} from "../src/native-presentation-contracts.js";
import type { SessionRegistration } from "../src/contracts.js";

const open: Store[] = [],
  directories: string[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const d of directories.splice(0))
    rmSync(d, { recursive: true, force: true });
});
const now = 100000;
function store(path?: string) {
  const s = new Store(path);
  open.push(s);
  return s;
}
function envelope(
  operationId = "native-operation",
  overrides: Partial<ProductionNativeEnvelope["binding"]> = {},
): ProductionNativeEnvelope {
  const operation = {
    version: 1 as const,
    operationId,
    sceneId: "scene",
    generation: 1,
    action: "activate_app" as const,
    window: {
      appId: "com.apple.finder",
      windowId: "42",
      ownerPid: 123,
      displayId: 1,
    },
    expected: {
      requestId: "request",
      sessionId: "session",
      leaseId: "lease",
      epoch: 1,
      cursor: 0,
      policyRevision: 1,
      displayId: 1,
    },
  };
  return {
    version: 1,
    operation,
    fingerprint: hash(
      JSON.stringify(nativePresentationOperationSchema.parse(operation)),
    ),
    binding: {
      mediaSessionId: "media",
      pairingId: "pair",
      deviceId: "mac",
      memberId: "member",
      expiresAt: now + 20000,
      ...overrides,
    },
  };
}
const observation = {
  window: envelope().operation.window,
  observedAt: now,
  processIdentity: "process-lifetime",
  windowBounds: { x: 0, y: 0, width: 800, height: 600 },
  appActive: false,
  windowFocused: false,
  windowOnScreen: true,
};
function dispatch(journal: NativeReservationStore, e = envelope()) {
  journal.reserve(e);
  journal.setPreparedObservation(e.operation.operationId, observation);
  return journal.beginDispatch(
    e.operation.operationId,
    now + 2000,
    observation,
  );
}
function returned(e = envelope()): NativePresentationHostResult {
  return {
    operationId: e.operation.operationId,
    state: "returned",
    reason: "host_returned",
    terminalEvidence: {
      receiptId: "receipt",
      operationId: e.operation.operationId,
      fingerprint: e.fingerprint,
      hostId: "helper",
      completedAt: now + 20,
    },
  };
}

describe("durable native device reservation", () => {
  it("preserves an interrupted dispatch across database restart and never expires its fence", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawdtime-native-"));
    directories.push(dir);
    const path = join(dir, "state.sqlite"),
      first = store(path);
    dispatch(new NativeReservationStore(first, () => now));
    first.close();
    open.splice(open.indexOf(first), 1);
    const restarted = new NativeReservationStore(
      store(path),
      () => now + 100000,
    );
    expect(restarted.get("native-operation")?.phase).toBe("uncertain");
    expect(restarted.get("native-operation")?.envelope.nativeExpiresAt).toBe(
      now + 2000,
    );
    expect(restarted.hasUnresolvedDevice("mac")).toBe(true);
    expect(() =>
      restarted.reserve(envelope("replacement", { expiresAt: now + 110000 })),
    ).toThrow("reserves this device");
    expect(() =>
      restarted.beginDispatch("native-operation", now + 102000, observation),
    ).toThrow("left preparation");
    expect(() => restarted.cancelPrepared("native-operation")).toThrow(
      "undispatched",
    );
    restarted.finish("native-operation", returned());
    expect(restarted.hasUnresolvedDevice("mac")).toBe(false);
    expect(restarted.get("native-operation")?.envelope.nativeExpiresAt).toBe(
      now + 2000,
    );
  });
  it("binds global IDs, original expiry and target; a repeat cannot reacquire dispatch", () => {
    const j = new NativeReservationStore(store(), () => now),
      e = envelope();
    const first = j.reserve(e);
    expect(j.reserve(e)).toEqual(first);
    expect(() =>
      j.reserve(envelope("native-operation", { expiresAt: now + 19000 })),
    ).toThrow("already bound");
    expect(() =>
      j.reserve(envelope("other", { mediaSessionId: "other-media" })),
    ).toThrow("reserves this device");
    expect(() =>
      j.reserve({ ...envelope("bad"), fingerprint: "b".repeat(64) }),
    ).toThrow("fingerprint differs");
    j.setPreparedObservation(e.operation.operationId, observation);
    expect(() =>
      j.setPreparedObservation(e.operation.operationId, {
        ...observation,
        processIdentity: "restarted",
      }),
    ).toThrow("already bound");
    expect(() =>
      j.beginDispatch(e.operation.operationId, now + 2000, {
        ...observation,
        processIdentity: "restarted",
      }),
    ).toThrow("original prepared observation");
    j.beginDispatch(e.operation.operationId, now + 2000, observation);
    expect(j.reserve(e).phase).toBe("dispatching");
    expect(() =>
      j.beginDispatch(e.operation.operationId, now + 2000, observation),
    ).toThrow("left preparation");
  });
  it("allows expiry/cancel only before dispatch and does not extend either deadline", () => {
    let time = now;
    const j = new NativeReservationStore(store(), () => time);
    j.reserve(envelope());
    j.setPreparedObservation("native-operation", observation);
    expect(() =>
      j.beginDispatch("native-operation", now + 2001, observation),
    ).toThrow("deadline");
    time = now + 20001;
    expect(j.hasUnresolvedDevice("mac")).toBe(false);
    expect(() =>
      j.beginDispatch("native-operation", time + 100, observation),
    ).toThrow("deadline");
    expect(j.cancelPrepared("native-operation").phase).toBe("rejected");
    expect(j.reserve(envelope()).phase).toBe("rejected");
  });
  it("requires exact terminal evidence, keeps uncertainty on a failed receipt commit, and releases no effect on a failed dispatch commit", () => {
    const s = store(),
      j = new NativeReservationStore(s, () => now);
    j.reserve(envelope());
    j.setPreparedObservation("native-operation", observation);
    const put = vi.spyOn(s, "put").mockImplementationOnce(() => {
      throw new Error("synthetic persistence failure");
    });
    expect(() =>
      j.beginDispatch("native-operation", now + 2000, observation),
    ).toThrow("persistence failure");
    expect(j.get("native-operation")?.phase).toBe("prepared");
    put.mockRestore();
    j.beginDispatch("native-operation", now + 2000, observation);
    expect(() =>
      j.finish("native-operation", {
        operationId: "native-operation",
        state: "rejected",
        reason: "denied",
      }),
    ).toThrow("terminal evidence");
    const result = returned();
    expect(() =>
      j.finish("native-operation", {
        ...result,
        terminalEvidence: {
          ...result.terminalEvidence!,
          fingerprint: "b".repeat(64),
        },
      }),
    ).toThrow("binding differs");
    const failed = vi.spyOn(s, "put").mockImplementationOnce(() => {
      throw new Error("synthetic persistence failure");
    });
    expect(() => j.finish("native-operation", result)).toThrow(
      "persistence failure",
    );
    failed.mockRestore();
    expect(j.hasUnresolvedDevice("mac")).toBe(true);
    j.finish("native-operation", result);
    expect(j.finish("native-operation", result).phase).toBe("returned");
    expect(() =>
      j.finish("native-operation", { ...result, state: "uncertain" }),
    ).toThrow("already terminal");
  });
  it("refuses malformed or future retained ledger states instead of silently declaring the device idle", () => {
    const s = store(),
      j = new NativeReservationStore(s, () => now);
    const record = j.reserve(envelope());
    s.put("native-activation", { ...record, phase: "future-input-state" });
    expect(() => new NativeReservationStore(s, () => now)).toThrow();
    expect(
      s.get<{ phase: string }>("native-activation", record.id)?.phase,
    ).toBe("future-input-state");
  });
  it("serializes independent store clients and fences all displays on the same device", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawdtime-native-clients-"));
    directories.push(dir);
    const path = join(dir, "state.sqlite"),
      a = new NativeReservationStore(store(path), () => now),
      b = new NativeReservationStore(store(path), () => now);
    a.reserve(envelope());
    const other = envelope("other");
    other.operation.window.displayId = 2;
    other.operation.expected.displayId = 2;
    other.fingerprint = hash(JSON.stringify(other.operation));
    expect(() => b.reserve(other)).toThrow("reserves this device");
    expect(
      b.reserve(envelope("independent", { deviceId: "another-mac" })).phase,
    ).toBe("prepared");
  });
});

const registration: SessionRegistration = {
  adapter: "codex",
  adapterVersion: "synthetic",
  projectRoot: "/disposable",
  externalSessionId: "external",
  hostId: "host",
  protocolVersion: 2,
  screenCamera: {
    version: 1,
    surface: { kind: "display", id: "1", displayId: 1 },
  },
  capabilities: {
    cooperativePause: true,
    polling: true,
    screenCameraVersion: 1,
    livePresentationVersion: 1,
    nativeActivationVersion: 1,
    nativeControl: "desktop",
    sharedSurface: true,
  },
};
function serviceFixture() {
  const s = store(),
    transport = new SimulationTransport(),
    service = new ClawdTime(s, transport, { clock: () => now });
  const invite = service.createPairingInvite({
    memberId: "member",
    recipient: "synthetic-recipient",
    conversationId: "conversation",
    lineId: "line",
    deviceId: "mac",
    displayId: "1",
  });
  const pair = service.claimPairing({
    token: invite.token,
    deviceId: "mac",
    displayId: "1",
    allowView: true,
    allowControl: true,
  });
  return { s, transport, service, pair };
}
describe("native activation admission", () => {
  it("negotiates only a new exact original-chat desktop session and refuses an old-session upgrade", () => {
    const f = serviceFixture(),
      legacy = {
        ...registration,
        capabilities: {
          ...registration.capabilities,
          nativeActivationVersion: undefined,
        },
      };
    f.service.registerSession(f.pair.token, legacy);
    expect(() => f.service.registerSession(f.pair.token, registration)).toThrow(
      "binding differs",
    );
    for (const changes of [
      { nativeControl: "browser" },
      { sharedSurface: false },
      { livePresentationVersion: undefined },
    ])
      expect(() =>
        f.service.registerSession(f.pair.token, {
          ...registration,
          externalSessionId: "new",
          capabilities: { ...registration.capabilities, ...changes },
        } as SessionRegistration),
      ).toThrow("Native activation requires");
    expect(
      f.service.registerSession(f.pair.token, {
        ...registration,
        externalSessionId: "new",
      }).session.capabilities.nativeActivationVersion,
    ).toBe(1);
    expect(f.transport.calls).toHaveLength(0);
  });
  it("allows exact reconnect/read-only recovery but blocks replacement session, fresh request, doctor and audio qualification", () => {
    const f = serviceFixture(),
      agent = f.service.registerSession(f.pair.token, registration);
    const attention = {
      taskId: "task",
      idempotencyKey: "once",
      reason: "review" as const,
      question: "Synthetic request",
    };
    const request = f.service.requestAttention(agent.token, attention);
    dispatch(f.service.nativeReservations);
    const reconnected = f.service.registerSession(f.pair.token, registration);
    expect(reconnected.session.id).toBe(agent.session.id);
    expect(f.service.requestAttention(reconnected.token, attention).id).toBe(
      request.id,
    );
    expect(() =>
      f.service.registerSession(f.pair.token, {
        ...registration,
        externalSessionId: "replacement",
      }),
    ).toThrow("replacement session");
    expect(() =>
      f.service.requestAttention(reconnected.token, {
        ...attention,
        idempotencyKey: "new",
      }),
    ).toThrow("new attention request");
    expect(f.service.doctor(reconnected.token).unresolvedNativeCount).toBe(1);
    expect(() =>
      assertAudioQualificationIdle(f.s, f.pair.pairing, now),
    ).toThrow("Unresolved native input");
    expect(f.transport.calls).toHaveLength(0);
  });
});
