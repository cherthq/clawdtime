// Transient exact-window preview transport. No planner observation, input,
// foreground fallback, file output, screenshot logging, or stored frame queue.
import jpeg from "jpeg-js";
import { randomUUID } from "node:crypto";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 4_000_000;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
export class WindowCaptureError extends Error {
  constructor(code) {
    super(code);
    this.name = "WindowCaptureError";
    this.code = code;
  }
}
const refuse = (code) => {
  throw new WindowCaptureError(code);
};

/** Decode the official SDK ToolResult; never fall back to another image/window. */
export function decodeWindowPreview(result, { pid, windowId }) {
  if (!result || result.isError !== false || result.degraded === true)
    refuse("capture_refused");
  if (
    typeof result.structuredJson !== "string" ||
    result.structuredJson.length > 64 * 1024
  )
    refuse("invalid_capture_metadata");
  let meta;
  try {
    meta = JSON.parse(result.structuredJson);
  } catch {
    refuse("invalid_capture_metadata");
  }
  if (
    !meta ||
    meta.pid !== pid ||
    String(meta.window_id) !== windowId ||
    !positive(meta.window_id)
  )
    refuse("capture_target_changed");
  if (
    meta.degraded === true ||
    meta.screenshot_frame_valid !== true ||
    meta.screenshot_error
  )
    refuse("capture_invalid");
  // A newly encoded frame on another Space may still show a frozen app backing
  // store. This release does not present that route as fresh/live.
  if (meta.on_current_space === false || meta.off_space_staleness)
    refuse("off_space_unqualified");
  const width = meta.screenshot_width,
    height = meta.screenshot_height,
    bounds = meta.window_bounds;
  if (
    !positive(width) ||
    !positive(height) ||
    width * height > MAX_PIXELS ||
    width > 8192 ||
    height > 8192 ||
    !bounds ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    !Number.isFinite(meta.screenshot_scale) ||
    meta.screenshot_scale <= 0
  )
    refuse("invalid_capture_dimensions");
  if (!Array.isArray(result.images) || result.images.length !== 1)
    refuse("capture_image_count");
  const image = result.images[0];
  if (
    meta.screenshot_mime_type !== "image/jpeg" ||
    image?.mimeType !== "image/jpeg"
  )
    refuse("unsupported_capture_format");
  if (
    typeof image.dataBase64 !== "string" ||
    image.dataBase64.length === 0 ||
    image.dataBase64.length > Math.ceil(MAX_BYTES / 3) * 4 ||
    image.dataBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(image.dataBase64)
  )
    refuse("invalid_capture_encoding");
  const bytes = Buffer.from(image.dataBase64, "base64");
  if (bytes.length > MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    refuse("invalid_capture_encoding");
  let decoded;
  try {
    decoded = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: false,
      maxResolutionInMP: MAX_PIXELS / 1_000_000,
      maxMemoryUsageInMB: 64,
    });
  } catch {
    refuse("capture_decode_failed");
  }
  if (
    decoded.width !== width ||
    decoded.height !== height ||
    decoded.data.length !== width * height * 4
  )
    refuse("capture_dimensions_mismatch");
  return {
    rgba: decoded.data,
    width,
    height,
    windowWidth: bounds.width,
    windowHeight: bounds.height,
    overlay: "unknown",
  };
}

/** Serial, rate-bounded capture source; each consumer receives only a new frame. */
// Only the trusted host may supply this evidence after physical qualification.
// Provider result fields cannot promote their own overlay claim.
const QUALIFIED_ARCHIVE =
  "faf11948f8f9b410a76750e65ae14cb1d95cc321aa61fc158f70de8a68c270b1";
function copyOverlayQualification(q) {
  if (q == null) return null;
  const tokens = ["driverGeneration", "osBuild", "qualificationId"];
  if (
    q.driverVersion !== "0.55.0" ||
    q.artifactSha256 !== QUALIFIED_ARCHIVE ||
    q.capturePipeline !== "get_window_state/jpeg/display_only" ||
    q.result !== "excluded" ||
    !tokens.every(
      (k) => typeof q[k] === "string" && q[k].length > 0 && q[k].length <= 256,
    ) ||
    !Number.isFinite(q.qualifiedAt) ||
    !Number.isFinite(q.expiresAt) ||
    q.expiresAt <= q.qualifiedAt
  )
    throw new Error("Invalid overlay qualification");
  return Object.freeze(
    Object.fromEntries(
      [
        ...tokens,
        "driverVersion",
        "artifactSha256",
        "capturePipeline",
        "result",
        "qualifiedAt",
        "expiresAt",
      ].map((k) => [k, q[k]]),
    ),
  );
}

export class DriverWindowSource {
  constructor({
    callTool,
    verifyBinding,
    clock = () => Date.now(),
    monotonicClock = () => performance.now(),
    fps = 4,
    maxFrameAgeMs = 1000,
    overlayQualification,
  }) {
    if (
      typeof callTool !== "function" ||
      typeof verifyBinding !== "function" ||
      typeof clock !== "function" ||
      typeof monotonicClock !== "function" ||
      !Number.isFinite(fps) ||
      fps < 1 ||
      fps > 10 ||
      !Number.isFinite(maxFrameAgeMs) ||
      maxFrameAgeMs < 50 ||
      maxFrameAgeMs > 5000
    )
      throw new Error("Invalid capture source options");
    this.overlayQualification = copyOverlayQualification(overlayQualification);
    this.callTool = callTool;
    this.verifyBinding = verifyBinding;
    this.clock = clock;
    this.monotonicClock = monotonicClock;
    this.interval = 1000 / fps;
    this.maxFrameAgeMs = maxFrameAgeMs;
    this.epoch = 0;
    this.binding = null;
    this.inFlight = false;
    this.nextAt = 0;
  }
  bind(binding) {
    const identities = [
      "callId",
      "taskId",
      "driverGeneration",
      "processIdentity",
      "windowId",
      "geometryGeneration",
      "session",
    ];
    if (
      !binding ||
      !identities.every(
        (k) =>
          typeof binding[k] === "string" &&
          binding[k].length > 0 &&
          binding[k].length <= 256,
      ) ||
      !positive(binding.pid) ||
      !/^[1-9][0-9]{0,9}$/.test(binding.windowId) ||
      Number(binding.windowId) > 0xffffffff ||
      !Number.isFinite(binding.expiresAt)
    )
      throw new Error("Invalid capture binding");
    this.revoke();
    this.binding = Object.fromEntries(
      [...identities, "pid", "expiresAt"].map((k) => [k, binding[k]]),
    );
  }
  revoke() {
    this.epoch++;
    this.binding = null;
    this.nextAt = 0;
  }
  async next() {
    const binding = this.binding,
      epoch = this.epoch,
      startedAt = this.clock(),
      monotonicStartedAt = this.monotonicClock();
    if (
      !binding ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(monotonicStartedAt) ||
      startedAt >= binding.expiresAt
    )
      return { status: "not_authorized" };
    if (this.inFlight) return { status: "capture_in_progress" };
    if (startedAt < this.nextAt) return { status: "rate_limited" };
    this.inFlight = true;
    this.nextAt = startedAt + this.interval;
    const current = () =>
      this.epoch === epoch &&
      this.binding === binding &&
      this.clock() >= startedAt &&
      this.clock() < binding.expiresAt;
    const validWitness = async () => {
      const witness = await this.verifyBinding({ ...binding });
      return witness?.valid === true && witness?.onCurrentSpace === true;
    };
    const operation = (async () => {
      try {
        if (!(await validWitness()) || !current())
          return { status: "target_unavailable" };
        const result = await this.callTool(
          "get_window_state",
          JSON.stringify({
            session: binding.session,
            pid: binding.pid,
            window_id: Number(binding.windowId),
            include_accessibility_tree: false,
            include_screenshot: true,
            display_only: true,
            screenshot_format: "jpeg",
            screenshot_quality: 85,
            max_dimension: 1280,
            timeout_ms: 1000,
          }),
        );
        if (!current() || !(await validWitness()) || !current())
          return { status: "target_unavailable" };
        const decoded = decodeWindowPreview(result, binding);
        const completedAt = this.clock(),
          durationMs = this.monotonicClock() - monotonicStartedAt;
        if (
          !current() ||
          !Number.isFinite(durationMs) ||
          durationMs < 0 ||
          durationMs > this.maxFrameAgeMs ||
          completedAt - startedAt > this.maxFrameAgeMs
        )
          return { status: "stale_capture" };
        const { rgba, width, height, windowWidth, windowHeight } = decoded;
        const q = this.overlayQualification;
        // Require evidence to remain valid for the entire possible frame lifetime.
        const overlay =
          q &&
          q.driverGeneration === binding.driverGeneration &&
          q.qualifiedAt <= startedAt &&
          q.expiresAt > startedAt + this.maxFrameAgeMs
            ? "excluded"
            : "unknown";
        return {
          status: "frame",
          rgba,
          durationMs,
          frame: {
            callId: binding.callId,
            taskId: binding.taskId,
            driverGeneration: binding.driverGeneration,
            processIdentity: binding.processIdentity,
            windowId: binding.windowId,
            geometryGeneration: binding.geometryGeneration,
            id: randomUUID(),
            capturedAt: startedAt,
            pixelWidth: width,
            pixelHeight: height,
            windowWidth,
            windowHeight,
            overlay,
          },
        };
      } catch (error) {
        return {
          status: "capture_error",
          code:
            error instanceof WindowCaptureError ? error.code : "capture_failed",
        };
      } finally {
        this.inFlight = false;
      }
    })();
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            if (this.epoch === epoch && this.binding === binding) this.revoke();
            resolve({ status: "capture_timeout" });
          }, this.maxFrameAgeMs + 50);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
