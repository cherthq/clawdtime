import type {
  TaskAudioCallCoordinator,
  TaskAudioCallStatus,
} from "../attention/task-audio-call.js";
import type {
  TaskHandsetCallsPort,
  TaskHandsetPlan,
} from "../transport/task-audio.js";

/** One operator owns this monitor. Polling only repeats GETs, never a forward effect. */
export class TaskAudioMonitor {
  private stopping = false;
  private activationAttempted = false;
  private busy = false;
  constructor(
    private readonly coordinator: TaskAudioCallCoordinator,
    private readonly calls: TaskHandsetCallsPort,
    private readonly plan: TaskHandsetPlan,
    private readonly voiceActive: () => boolean,
    private readonly clock: () => number = Date.now,
    private readonly observe: (reason: string) => void = () => {},
  ) {}
  async stop(reason = "operator_stop") {
    if (!this.stopping) {
      try {
        this.observe(reason);
      } catch {
        /* Diagnostics never prevent Stop. */
      }
    }
    this.stopping = true;
    return this.coordinator.stop(this.plan.id);
  }
  async tick(): Promise<TaskAudioCallStatus> {
    if (this.busy) return this.coordinator.status(this.plan.id);
    this.busy = true;
    try {
      let status = await this.coordinator.inspect(this.plan.id);
      if (status.cleanupConfirmed) return status;
      const stopReason = this.stopping
        ? "already_stopping"
        : !this.voiceActive()
          ? "voice_end"
          : this.clock() >= this.plan.expiresAt
            ? "expiry"
            : status.mediaClosed
              ? "media_closed"
              : status.nativeCleanupComplete
                ? "native_cleanup"
                : status.state === "unknown"
                  ? "unknown_outcome"
                  : undefined;
      if (stopReason) return await this.stop(stopReason);
      if (status.providerCallId) {
        const native = await this.calls.inspect(
          this.plan,
          status.providerCallId,
        );
        if (native.state === "terminal")
          return await this.stop("native_terminal");
        if (
          status.state === "ringing" &&
          !this.activationAttempted &&
          native.state === "connected"
        ) {
          this.activationAttempted = true;
          try {
            status = await this.coordinator.activate(this.plan.id);
          } catch {
            return await this.stop("activation_refused");
          }
        }
      }
      return status;
    } finally {
      this.busy = false;
    }
  }
}
