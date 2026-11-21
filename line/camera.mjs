// Presentation only. Every rectangle is a share of the ORIGINAL display; none
// of these coordinates may be returned to the hands or planner.
import { cleanView } from "./layout.mjs";

export const OVERVIEW = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });
export const CAMERA = Object.freeze({
  magnification: 1.8,
  duration: 400,
  hold: 2800,
});
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const same = (a, b) =>
  ["x", "y", "w", "h"].every((k) => Math.abs(a[k] - b[k]) < 0.00001);
const surfaceKey = (s) =>
  JSON.stringify([
    s.displayId,
    s.width,
    s.height,
    s.scale,
    s.appId,
    s.windowId,
    s.window,
  ]);
const inside = (r, c, margin = 0) =>
  r.x >= c.x + c.w * margin &&
  r.y >= c.y + c.h * margin &&
  r.x + r.w <= c.x + c.w * (1 - margin) &&
  r.y + r.h <= c.y + c.h * (1 - margin);

export function normalizedTarget(target, surface) {
  if (
    !target ||
    !surface ||
    ![surface.width, surface.height, surface.scale].every(
      (n) => Number.isFinite(n) && n > 0,
    )
  )
    return null;
  const r = {
    x: target.x / surface.width,
    y: target.y / surface.height,
    w: target.w / surface.width,
    h: target.h / surface.height,
  };
  if (
    !Object.values(r).every(Number.isFinite) ||
    r.w <= 0 ||
    r.h <= 0 ||
    !inside(r, OVERVIEW)
  )
    return null;
  return r;
}

export function frameTarget(target, magnification = CAMERA.magnification) {
  // Reserve context for the captured guided cursor/pill as well as the field.
  const size = Math.min(
    1,
    Math.max(
      1 / clamp(magnification, 1.5, 2),
      target.w + 0.18,
      target.h + 0.18,
    ),
  );
  return {
    x: clamp(target.x + target.w / 2 - size / 2, 0, 1 - size),
    y: clamp(target.y + target.h / 2 - size / 2, 0, 1 - size),
    w: size,
    h: size,
  };
}

export function interpolate(from, to, fraction) {
  const t = clamp(fraction, 0, 1),
    eased = t * t * (3 - 2 * t);
  return Object.fromEntries(
    ["x", "y", "w", "h"].map((k) => [k, from[k] + (to[k] - from[k]) * eased]),
  );
}

/** One camera per call. Overview persists through events, hiding, and Stop;
 * only resume releases it. Manual window views take precedence over auto. */
export function makeCamera({
  since = Date.now(),
  now = Date.now,
  enabled = true,
  reducedMotion = false,
  magnification = CAMERA.magnification,
} = {}) {
  let from = { ...OVERVIEW },
    to = { ...OVERVIEW },
    began = now();
  let overview = false,
    manual = null,
    surface = null,
    identity = null;
  let producer = null,
    sequence = 0,
    expires = 0,
    holdUntil = 0,
    barrier = 0,
    pending = null;
  let still = reducedMotion,
    acceptedAt = since;
  const value = (at) =>
    interpolate(from, to, still ? 1 : (at - began) / CAMERA.duration);
  const aim = (crop, at) => {
    if (!same(to, crop)) {
      from = value(at);
      to = crop;
      began = at;
    }
  };
  const retire = (at, clearManual = false) => {
    if (clearManual) manual = null;
    surface = null;
    identity = null;
    expires = 0;
    holdUntil = 0;
    pending = null;
    aim(OVERVIEW, at);
  };
  const wantsAuto = () => enabled && !overview && !manual;
  const follow = (target, at) => {
    holdUntil = at + CAMERA.hold;
    if (!wantsAuto()) return;
    if (!same(to, OVERVIEW) && inside(target, to, 0.12)) return; // spatial hysteresis
    const next = frameTarget(target, magnification);
    const distance = Math.hypot(
      next.x + next.w / 2 - (to.x + to.w / 2),
      next.y + next.h / 2 - (to.y + to.h / 2),
    );
    if (distance > 0.42 && !same(to, OVERVIEW)) {
      aim(OVERVIEW, at);
      barrier = at + CAMERA.duration;
      pending = next;
    } else if (at < barrier) pending = next;
    else aim(next, at);
  };
  return {
    event(event) {
      const at = now();
      if (!event) {
        retire(at, true);
        return false;
      }
      if (
        event.version !== 1 ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence < 1 ||
        typeof event.producerId !== "string" ||
        !event.producerId ||
        !Number.isFinite(event.at) ||
        !Number.isFinite(event.expiresAt) ||
        event.at < since ||
        event.at < acceptedAt ||
        event.at > at + 100 ||
        event.expiresAt <= at ||
        event.expiresAt <= event.at ||
        event.expiresAt - event.at > 2000
      ) {
        retire(at, true);
        return false;
      }
      if (producer === event.producerId && event.sequence <= sequence)
        return false;
      const changedProducer =
        producer !== null && producer !== event.producerId;
      producer = event.producerId;
      sequence = event.sequence;
      acceptedAt = event.at;
      still = reducedMotion || event.reducedMotion === true;
      if (event.kind === "reset" || event.kind === "transition") {
        retire(at, true);
        barrier = at + CAMERA.duration;
        return true;
      }
      const s = event.surface;
      if (
        !s ||
        !normalizedTarget(s.window, s) ||
        !s.displayId ||
        !s.appId ||
        !s.windowId
      ) {
        retire(at, true);
        return false;
      }
      const nextIdentity = surfaceKey(s);
      if (changedProducer || (identity && identity !== nextIdentity)) {
        retire(at, true);
        barrier = at + CAMERA.duration;
        // A fixed manual crop cannot follow a different/moved window safely.
        manual = null;
      }
      surface = s;
      identity = nextIdentity;
      expires = event.expiresAt;
      if (event.kind === "context") return true;
      const target = normalizedTarget(event.target, s);
      if (!target || !["target", "typing"].includes(event.kind)) {
        retire(at, true);
        return false;
      }
      follow(target, at);
      return true;
    },
    crop(frame = null) {
      const at = now();
      if (expires && at >= expires) retire(at, true);
      if (
        surface &&
        frame &&
        Math.abs(
          frame.width / frame.height / (surface.width / surface.height) - 1,
        ) > 0.01
      ) {
        manual = null;
        retire(at, true);
      }
      if ((overview || !enabled) && !manual) aim(OVERVIEW, at);
      else if (manual) aim(manual, at);
      else if (pending && at >= barrier && at < holdUntil && expires > at) {
        aim(pending, at);
        pending = null;
      } else if (holdUntil && at >= holdUntil) {
        pending = null;
        aim(OVERVIEW, at);
      }
      return value(at);
    },
    control(action) {
      const at = now();
      if (action === "overview") {
        overview = true;
        manual = null;
      } else if (action === "resume") {
        enabled = true;
        overview = false;
        manual = null;
      } else if (action === "enable") enabled = true;
      else if (action === "disable") enabled = false;
      else return false;
      retire(at);
      return true;
    },
    manual(view) {
      if (!view) {
        this.control("overview");
        return;
      }
      // Explicit window zoom replaces overview, but never turns automatic zoom on.
      manual = cleanView(view);
      pending = null;
      aim(manual ?? OVERVIEW, now());
    },
    reset() {
      manual = null;
      retire(now());
    },
    status: () => ({
      enabled,
      overview,
      manual: manual !== null,
      reducedMotion: still,
    }),
  };
}
