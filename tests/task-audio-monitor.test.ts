import { describe, it, expect, vi } from "vitest";
import { TaskAudioMonitor } from "../src/control/task-audio-monitor.js";
import type {
  TaskAudioCallCoordinator,
  TaskAudioCallStatus,
} from "../src/attention/task-audio-call.js";
import type {
  TaskAudioCallsPort,
  TaskAudioPlan,
} from "../src/transport/task-audio.js";

function fixture() {
  const status = {
    id: "attempt",
    state: "ringing",
    providerCallId: "call",
    cleanupConfirmed: false,
    mediaClosed: false,
    nativeCleanupComplete: false,
  } as TaskAudioCallStatus;
  const coordinator = {
    inspect: vi.fn(async () => status),
    status: vi.fn(() => status),
    stop: vi.fn(async () => ({ ...status, state: "stopping" })),
    activate: vi.fn(async () => ({ ...status, state: "connected" })),
  };
  const calls = {
    inspect: vi.fn(async () => ({
      providerCallId: "call",
      state: "connected",
      cleanupComplete: false,
    })),
  };
  const active = { value: true };
  const monitor = new TaskAudioMonitor(
    coordinator as unknown as TaskAudioCallCoordinator,
    calls as unknown as TaskAudioCallsPort,
    { id: "attempt", expiresAt: 2000 } as TaskAudioPlan,
    () => active.value,
    () => 1000,
  );
  return { status, coordinator, calls, monitor, active };
}
describe("operator audio cleanup", () => {
  it("activates once only after native connection", async () => {
    const f = fixture();
    await f.monitor.tick();
    await f.monitor.tick();
    expect(f.coordinator.activate).toHaveBeenCalledTimes(1);
  });
  it("leaves ringing silent until connected", async () => {
    const f = fixture();
    f.calls.inspect.mockResolvedValue({
      providerCallId: "call",
      state: "allocated",
      cleanupComplete: false,
    });
    await f.monitor.tick();
    expect(f.coordinator.activate).not.toHaveBeenCalled();
  });
  it.each(["voice", "media", "native", "unknown"])(
    "stops native call for %s closure",
    async (reason) => {
      const f = fixture();
      if (reason === "voice") f.active.value = false;
      if (reason === "media") f.status.mediaClosed = true;
      if (reason === "native") f.status.nativeCleanupComplete = true;
      if (reason === "unknown") f.status.state = "unknown";
      await f.monitor.tick();
      expect(f.coordinator.stop).toHaveBeenCalledTimes(1);
      expect(f.coordinator.activate).not.toHaveBeenCalled();
    },
  );
  it("does not retry failed activation", async () => {
    const f = fixture();
    f.coordinator.activate.mockRejectedValue(Error("uncertain"));
    await f.monitor.tick();
    await f.monitor.tick();
    expect(f.coordinator.activate).toHaveBeenCalledTimes(1);
    expect(f.coordinator.stop).toHaveBeenCalled();
  });
  it("local Stop prevents later activation", async () => {
    const f = fixture();
    await f.monitor.stop();
    await f.monitor.tick();
    expect(f.coordinator.activate).not.toHaveBeenCalled();
  });
  it("closes connected audio on native hangup before cleanup acknowledgment", async () => {
    const f = fixture();
    f.status.state = "connected";
    f.calls.inspect.mockResolvedValue({
      providerCallId: "call",
      state: "terminal",
      cleanupComplete: false,
    });
    await f.monitor.tick();
    expect(f.coordinator.stop).toHaveBeenCalledTimes(1);
  });
  it("confirmed cleanup ends polling without another stop", async () => {
    const f = fixture();
    f.status.cleanupConfirmed = true;
    await f.monitor.tick();
    expect(f.coordinator.stop).not.toHaveBeenCalled();
  });
});
