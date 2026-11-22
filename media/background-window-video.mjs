// In-memory bridge from a fixed, authorized window capture to phone rendering.
// This API has no input actions, arbitrary driver calls, or screen persistence.
import { DriverWindowSource } from "./driver-window-source.mjs";
import { WindowPresentation } from "./window-presentation.mjs";

export class BackgroundWindowVideo {
  constructor({
    captureWindow,
    verifyBinding,
    clock = () => Date.now(),
    monotonicClock = () => performance.now(),
    fps = 4,
    maxFrameAgeMs = 1000,
    zoom = 1.6,
    transitionMs = 400,
    overlayQualification,
  }) {
    if (typeof captureWindow !== "function")
      throw new Error("A fixed window capture provider is required");
    this.clock = clock;
    this.source = new DriverWindowSource({
      callTool: (_name, json) => captureWindow(Object.freeze(JSON.parse(json))),
      verifyBinding,
      clock,
      monotonicClock,
      fps,
      maxFrameAgeMs,
      overlayQualification,
    });
    this.presentation = new WindowPresentation({
      zoom,
      transitionMs,
      maxFrameAgeMs,
    });
    this.epoch = 0;
    this.revision = 0;
    this.current = null;
    this.issued = new WeakMap();
    this.lastStatus = "not_authorized";
  }
  bind(binding) {
    this.revoke();
    this.source.bind(binding);
    this.presentation.bind(binding);
    this.lastStatus = "waiting_for_frame";
  }
  revoke() {
    this.epoch++;
    this.revision++;
    this.current = null;
    this.issued = new WeakMap();
    this.source.revoke();
    this.presentation.revoke();
    this.lastStatus = "not_authorized";
  }
  clearPixels(status) {
    this.current = null;
    this.issued = new WeakMap();
    this.revision++;
    this.lastStatus = status;
    // A failed read retires the action location even if a later fresh frame
    // recovers under the same still-authorized binding.
    this.presentation.hide(status);
  }
  async tick() {
    const epoch = this.epoch;
    const result = await this.source.next();
    if (epoch !== this.epoch) return { status: "superseded" };
    if (result.status === "frame") {
      if (!this.presentation.observe(result.frame, this.clock())) {
        this.revoke();
        this.lastStatus = "source_changed";
        return { status: "source_changed" };
      }
      this.current = result;
      this.issued = new WeakMap();
      this.lastStatus = "frame";
      return {
        status: "frame",
        frameId: result.frame.id,
        capturedAt: result.frame.capturedAt,
        durationMs: result.durationMs,
      };
    }
    if (["rate_limited", "capture_in_progress"].includes(result.status))
      return result;
    if (
      ["not_authorized", "target_unavailable", "capture_timeout"].includes(
        result.status,
      )
    ) {
      this.revoke();
      this.lastStatus = result.status;
    } else this.clearPixels(result.status);
    return result;
  }
  focus(action) {
    this.revision++;
    return this.presentation.focus(action, this.clock());
  }
  overview(enabled = true) {
    this.revision++;
    this.presentation.overview(enabled, this.clock());
  }
  complete() {
    this.revision++;
    this.presentation.complete(this.clock());
  }
  status() {
    return this.lastStatus;
  }
  /** RGBA is the original capture, not the cropped phone image. Treat it read-only.
   * Serialize the small layout into headers and RGBA into a binary response body.
   * Recheck isCurrent(view) immediately before writing a composed/queued response.
   */
  latest(output) {
    if (!this.current) return null;
    const layout = this.presentation.layout(this.clock(), output);
    if (!layout.visible) {
      this.clearPixels(layout.reason);
      return null;
    }
    const frame = this.current.frame;
    const view = {
      frameId: frame.id,
      capturedAt: frame.capturedAt,
      width: frame.pixelWidth,
      height: frame.pixelHeight,
      rgba: this.current.rgba,
      layout,
    };
    this.issued.set(view, {
      epoch: this.epoch,
      revision: this.revision,
      frameId: frame.id,
      output: { width: output.width, height: output.height },
      validUntil: layout.validUntil,
    });
    return view;
  }
  isCurrent(view) {
    if (!view || typeof view !== "object") return false;
    const issued = this.issued.get(view);
    if (
      !issued ||
      issued.epoch !== this.epoch ||
      issued.revision !== this.revision ||
      !this.current ||
      issued.frameId !== this.current.frame.id ||
      view.rgba !== this.current.rgba
    )
      return false;
    const layout = this.presentation.layout(this.clock(), issued.output);
    if (!layout.visible) {
      this.clearPixels(layout.reason);
      return false;
    }
    return this.clock() < issued.validUntil;
  }
}
