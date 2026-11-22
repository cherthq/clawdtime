/** Presentation only. No desktop capture, input, or retained screen content. */
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const positive = (n) => finite(n) && n > 0;
const token = (s) => typeof s === "string" && s.length > 0 && s.length <= 256;
const keys = [
  "callId",
  "taskId",
  "driverGeneration",
  "processIdentity",
  "windowId",
  "geometryGeneration",
];
const same = (a, b) => keys.every((k) => a?.[k] === b?.[k]);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const mix = (a, b, t) =>
  Object.fromEntries(
    ["x", "y", "width", "height"].map((k) => [k, a[k] + (b[k] - a[k]) * t]),
  );
const rectValid = (r) =>
  r && finite(r.x) && finite(r.y) && positive(r.width) && positive(r.height);
const inside = (r, w, h) =>
  rectValid(r) &&
  r.x >= 0 &&
  r.y >= 0 &&
  r.x + r.width <= w &&
  r.y + r.height <= h;

export class WindowPresentation {
  constructor({ zoom = 1.6, transitionMs = 400, maxFrameAgeMs = 1000 } = {}) {
    if (
      !finite(zoom) ||
      zoom < 1 ||
      zoom > 2 ||
      !finite(transitionMs) ||
      transitionMs < 0 ||
      transitionMs > 2000 ||
      !positive(maxFrameAgeMs) ||
      maxFrameAgeMs > 5000
    )
      throw new Error("Invalid presentation limits");
    this.options = { zoom, transitionMs, maxFrameAgeMs };
    this.revoke();
  }
  bind(binding) {
    if (
      !binding ||
      !keys.every((k) => token(binding[k])) ||
      !finite(binding.expiresAt)
    )
      throw new Error("Invalid window authority");
    this.revoke();
    this.binding = Object.fromEntries(
      [...keys, "expiresAt"].map((k) => [k, binding[k]]),
    );
  }
  revoke() {
    this.binding = this.frame = this.action = this.transition = null;
    this.geometry = this.lastFrame = null;
    this.override = false;
    this.reason = "not_authorized";
  }
  observe(frame, now) {
    if (!this.binding || !finite(now) || now >= this.binding.expiresAt)
      return this.hide("authority_expired");
    if (!same(frame, this.binding)) return this.hide("source_changed");
    if (
      !frame ||
      !token(frame.id) ||
      !finite(frame.capturedAt) ||
      frame.capturedAt > now ||
      now - frame.capturedAt > this.options.maxFrameAgeMs ||
      !positive(frame.pixelWidth) ||
      !positive(frame.pixelHeight) ||
      !positive(frame.windowWidth) ||
      !positive(frame.windowHeight) ||
      !["included", "excluded", "unknown"].includes(frame.overlay)
    )
      return this.hide("invalid_or_stale_frame");
    if (
      this.lastFrame &&
      (frame.capturedAt < this.lastFrame.capturedAt ||
        (frame.id === this.lastFrame.id &&
          frame.capturedAt !== this.lastFrame.capturedAt))
    )
      return this.hide("out_of_order_frame");
    if (
      this.geometry &&
      ["pixelWidth", "pixelHeight", "windowWidth", "windowHeight"].some(
        (k) => this.geometry[k] !== frame[k],
      )
    )
      return this.hide("geometry_changed");
    this.frame = Object.fromEntries(
      [
        ...keys,
        "id",
        "capturedAt",
        "pixelWidth",
        "pixelHeight",
        "windowWidth",
        "windowHeight",
        "overlay",
      ].map((k) => [k, frame[k]]),
    );
    this.geometry = {
      pixelWidth: frame.pixelWidth,
      pixelHeight: frame.pixelHeight,
      windowWidth: frame.windowWidth,
      windowHeight: frame.windowHeight,
    };
    this.lastFrame = { id: frame.id, capturedAt: frame.capturedAt };
    this.reason = null;
    if (!this.transition)
      this.transition = { from: this.full(), to: this.full(), at: now };
    return true;
  }
  hide(reason) {
    // A source/capture failure retires action positions. Recovery needs a fresh
    // frame; a changed authority identity additionally needs an explicit bind.
    this.frame = this.action = this.transition = null;
    this.reason = reason;
    if (
      ["source_changed", "geometry_changed", "authority_expired"].includes(
        reason,
      )
    )
      this.binding = null;
    return false;
  }
  full() {
    return {
      x: 0,
      y: 0,
      width: this.frame.pixelWidth,
      height: this.frame.pixelHeight,
    };
  }
  fresh(now) {
    return (
      finite(now) &&
      this.binding &&
      this.frame &&
      now < this.binding.expiresAt &&
      now >= this.frame.capturedAt &&
      now - this.frame.capturedAt <= this.options.maxFrameAgeMs
    );
  }
  crop(now) {
    const { from, to, at } = this.transition;
    const t =
      this.options.transitionMs === 0
        ? 1
        : clamp((now - at) / this.options.transitionMs, 0, 1);
    return mix(from, to, t * t * (3 - 2 * t));
  }
  change(to, now) {
    this.transition = { from: this.crop(now), to, at: now };
  }
  rejectFocus(now) {
    this.action = null;
    if (this.fresh(now)) this.change(this.full(), now);
    else this.hide("stale_frame");
    return false;
  }
  focus(action, now) {
    if (
      !this.fresh(now) ||
      !same(action, this.binding) ||
      action.observationId !== this.frame.id ||
      !finite(action.expiresAt) ||
      action.expiresAt <= now ||
      action.expiresAt > this.binding.expiresAt ||
      !["action", "typing"].includes(action.phase) ||
      !["points", "pixels"].includes(action.coordinates)
    )
      return this.rejectFocus(now);
    const sx =
      action.coordinates === "points"
        ? this.frame.pixelWidth / this.frame.windowWidth
        : 1;
    const sy =
      action.coordinates === "points"
        ? this.frame.pixelHeight / this.frame.windowHeight
        : 1;
    if (
      !rectValid(action.bounds) ||
      !action.cursor ||
      !finite(action.cursor.x) ||
      !finite(action.cursor.y)
    )
      return this.rejectFocus(now);
    const r = {
      x: action.bounds.x * sx,
      y: action.bounds.y * sy,
      width: action.bounds.width * sx,
      height: action.bounds.height * sy,
    };
    const cursor = { x: action.cursor.x * sx, y: action.cursor.y * sy };
    if (
      !inside(r, this.frame.pixelWidth, this.frame.pixelHeight) ||
      cursor.x < 0 ||
      cursor.y < 0 ||
      cursor.x > this.frame.pixelWidth ||
      cursor.y > this.frame.pixelHeight
    )
      return this.rejectFocus(now);
    const hold =
      this.action?.phase === "typing" &&
      action.phase === "typing" &&
      now < this.action.expiresAt &&
      ["x", "y", "width", "height"].every(
        (k) => this.action.bounds[k] === r[k],
      );
    this.action = {
      phase: action.phase,
      bounds: r,
      cursor,
      expiresAt: Math.min(action.expiresAt, now + 1500),
    };
    if (!hold && !this.override) {
      const z = Math.min(
        this.options.zoom,
        this.frame.pixelWidth / (r.width * 1.4),
        this.frame.pixelHeight / (r.height * 1.4),
      );
      const width = this.frame.pixelWidth / Math.max(1, z),
        height = this.frame.pixelHeight / Math.max(1, z);
      this.change(
        {
          x: clamp(
            r.x + r.width / 2 - width / 2,
            0,
            this.frame.pixelWidth - width,
          ),
          y: clamp(
            r.y + r.height / 2 - height / 2,
            0,
            this.frame.pixelHeight - height,
          ),
          width,
          height,
        },
        now,
      );
    }
    return true;
  }
  overview(enabled = true, now) {
    this.override = enabled === true;
    if (this.fresh(now) && enabled) this.change(this.full(), now);
  }
  complete(now) {
    this.action = null;
    if (this.fresh(now)) this.change(this.full(), now);
  }
  layout(now, output) {
    if (!output || !positive(output.width) || !positive(output.height))
      throw new Error("Invalid video dimensions");
    if (!this.fresh(now)) {
      const reason =
        this.reason ??
        (this.binding && now >= this.binding.expiresAt
          ? "authority_expired"
          : "stale_frame");
      this.hide(reason);
      return { visible: false, reason, cursor: null };
    }
    if (this.action && now >= this.action.expiresAt) this.complete(now);
    const crop = this.crop(now);
    const scale = Math.min(
      output.width / crop.width,
      output.height / crop.height,
    );
    const contentRect = {
      x: (output.width - crop.width * scale) / 2,
      y: (output.height - crop.height * scale) / 2,
      width: crop.width * scale,
      height: crop.height * scale,
    };
    let cursor = null;
    if (this.action && this.frame.overlay === "excluded") {
      const p = this.action.cursor;
      if (
        p.x >= crop.x &&
        p.x <= crop.x + crop.width &&
        p.y >= crop.y &&
        p.y <= crop.y + crop.height
      )
        cursor = {
          x: contentRect.x + (p.x - crop.x) * scale,
          y: contentRect.y + (p.y - crop.y) * scale,
          label: "ClawdTime",
        };
    }
    return {
      visible: true,
      validUntil: Math.min(
        this.binding.expiresAt,
        this.frame.capturedAt + this.options.maxFrameAgeMs,
        this.action?.expiresAt ?? Infinity,
      ),
      frameId: this.frame.id,
      crop,
      contentRect,
      cursor,
      cursorStatus:
        this.frame.overlay === "unknown"
          ? "capture_overlay_unqualified"
          : this.frame.overlay,
    };
  }
}
