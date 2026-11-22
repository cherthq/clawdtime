import { makeCamera } from "./camera.mjs";
import { startContinuousScreen, videoFPS } from "./continuous-screen.mjs";
import { makeVideoRenderer } from "./video-transform.mjs";
import { startPresentation } from "./presentation-source.mjs";

/** Call-scoped capture/presentation lifetime, usable without LiveKit in tests.
 * It owns no input executor. One stream, one latest frame, no animation queue. */
export function makeCallVideo({
  since,
  now = Date.now,
  layout = "wide",
  fps = 20,
  enabled = true,
  overview = false,
  revision,
  reducedMotion = false,
  device,
  capture = startContinuousScreen,
  presentation = startPresentation,
  onExit = () => {},
} = {}) {
  const camera = makeCamera({ since, now, enabled, reducedMotion });
  if (overview) camera.control("overview");
  const renderer = makeVideoRenderer();
  let screen = null,
    source = null,
    closed = false,
    generation = 0,
    display = null,
    hadFrame = false;
  let settings = { enabled, overview, revision };
  const hide = () => {
    generation++;
    source?.stop();
    source = null;
    screen?.stop();
    screen = null;
    display = null;
    hadFrame = false;
    camera.reset();
  };
  return {
    async show() {
      if (closed) return false;
      if (!screen) {
        const ownGeneration = ++generation;
        screen = capture({
          fps: videoFPS(fps),
          ...(device ? { device } : {}),
          now,
          onExit: (code) => {
            if (generation !== ownGeneration) return;
            hide();
            onExit(code);
          },
        });
        if (screen.supportsAutomaticZoom)
          source = presentation({
            since: Math.max(since ?? 0, now()),
            onEvent: (event) => {
              if (generation !== ownGeneration || closed) return;
              if (event?.surface) {
                const next = JSON.stringify([
                  event.surface.displayId,
                  event.surface.width,
                  event.surface.height,
                  event.surface.scale,
                ]);
                // An existing avfoundation input stays bound to its original display.
                // Require an explicit show after display reconfiguration, not auto restart.
                if (display && display !== next) {
                  hide();
                  onExit(null);
                  return;
                }
                display = next;
              }
              camera.event(event);
            },
          });
      }
      const own = screen;
      const ready = await own.started();
      if (!ready && screen === own) hide();
      return ready && screen === own && !closed;
    },
    hide,
    close() {
      closed = true;
      hide();
    },
    layout(value) {
      layout = value;
    },
    manual(view) {
      camera.manual(view);
    },
    control(action) {
      return camera.control(action);
    },
    settings(next) {
      // Invalid/unreadable settings deliberately have no command revision.
      // Their safe-wide fallback must also retire a temporary manual view.
      if (!next.revision && !next.enabled && next.overview)
        camera.control("overview");
      if (next.enabled !== settings.enabled)
        camera.control(next.enabled ? "enable" : "disable");
      if (next.overview !== settings.overview) {
        if (next.overview) camera.control("overview");
        else {
          camera.control("resume");
          if (!next.enabled) camera.control("disable");
        }
      }
      // Every explicit command has a revision, including overview requested a
      // second time after a temporary manual crop. Identical booleans are not
      // enough to tell a new command from an unchanged settings poll.
      if (next.revision && next.revision !== settings.revision && next.action)
        camera.control(next.action);
      settings = { ...next };
    },
    frame() {
      const frame = screen?.latest();
      if (!frame) {
        if (hadFrame) camera.reset();
        hadFrame = false;
        return null;
      }
      hadFrame = true;
      return renderer.render(frame, camera.crop(frame), layout);
    },
    status: () => ({ ...camera.status(), sharing: screen !== null }),
  };
}
