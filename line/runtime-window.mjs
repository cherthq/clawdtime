import { composeWindow } from "./window-video.mjs";

/** Transient exact-window client. No desktop capture fallback or input channel. */
export function startRuntimeWindow({
  runtime,
  width,
  height,
  now = Date.now,
  everyMs = 250,
}) {
  let stopped = false,
    current = null,
    timer,
    flight;
  const valid = () =>
    current &&
    !stopped &&
    now() >= current.capturedAt &&
    now() < current.expiresAt &&
    now() - current.capturedAt < 1000;
  const poll = () => {
    if (stopped || flight) return;
    flight = runtime
      .windowFrame()
      .then((frame) => {
        if (!stopped) current = frame;
      })
      .catch(() => {
        current = null;
      })
      .finally(() => {
        flight = null;
        if (!stopped) {
          timer = setTimeout(poll, everyMs);
          timer.unref?.();
        }
      });
  };
  poll();
  return {
    started: async () => !stopped,
    latest() {
      if (!valid()) {
        current = null;
        return null;
      }
      const frame = current;
      const composed = composeWindow(
        {
          id: frame.frameId,
          pixelWidth: frame.width,
          pixelHeight: frame.height,
          pixels: frame.rgba,
        },
        frame.layout,
        width,
        height,
      );
      return valid() && current === frame ? composed : null;
    },
    stop() {
      stopped = true;
      current = null;
      clearTimeout(timer);
    },
  };
}
