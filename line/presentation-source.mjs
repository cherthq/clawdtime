// Read-only, ephemeral native presentation metadata. No screenshots, action text, or input APIs.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const identity = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const positive = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;
const integer = (n) => Number.isSafeInteger(n) && n > 0;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, required, optional = []) =>
  object(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );
const rect = (value) =>
  keys(value, ["x", "y", "w", "h"]) &&
  [value.x, value.y].every(
    (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
  ) &&
  positive(value.w) &&
  positive(value.h);

/** Same v1 wire boundary as connectors/computer/presentation.ts; independent of the root build. */
export function validPresentationEvent(
  event,
  { now = Date.now(), since = 0 } = {},
) {
  if (
    !keys(
      event,
      [
        "version",
        "producerId",
        "sequence",
        "commandSeq",
        "at",
        "expiresAt",
        "kind",
        "reducedMotion",
      ],
      ["surface", "target"],
    ) ||
    event.version !== 1 ||
    !identity(event.producerId) ||
    !integer(event.sequence) ||
    !integer(event.commandSeq) ||
    !positive(event.at) ||
    !positive(event.expiresAt) ||
    event.at < since ||
    event.at > now + 100 ||
    event.expiresAt <= now ||
    event.expiresAt <= event.at ||
    event.expiresAt - event.at > 2000 ||
    now - event.at > 2000 ||
    typeof event.reducedMotion !== "boolean" ||
    !["target", "typing", "context", "transition", "reset"].includes(event.kind)
  )
    return false;
  const spatial = event.kind !== "transition" && event.kind !== "reset";
  const targeted = event.kind === "target" || event.kind === "typing";
  if (
    spatial !== Object.hasOwn(event, "surface") ||
    targeted !== Object.hasOwn(event, "target")
  )
    return false;
  if (spatial) {
    const s = event.surface;
    if (
      !keys(s, [
        "displayId",
        "width",
        "height",
        "scale",
        "appId",
        "windowId",
        "window",
      ]) ||
      ![s.displayId, s.appId, s.windowId].every(identity) ||
      !positive(s.width) ||
      s.width > 32768 ||
      !positive(s.height) ||
      s.height > 32768 ||
      !positive(s.scale) ||
      s.scale > 8
    )
      return false;
    for (const r of [s.window, ...(targeted ? [event.target] : [])]) {
      if (!rect(r) || r.x + r.w > s.width + 0.01 || r.y + r.h > s.height + 0.01)
        return false;
    }
  }
  return true;
}

function privateJSON(path) {
  const parent = lstatSync(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    parent.mode & 0o077
  )
    throw Error("Private configuration required.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size > 65536
    )
      throw Error("Private configuration required.");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length !== stat.size) throw Error("Configuration changed.");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

/** Uses the same private desktop discovery files as the supervisor CLI. Never prints their contents. */
export function presentationService({
  env = process.env,
  home = homedir(),
  exists = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
} = {}) {
  const root =
    env.CLAWDTIME_DESKTOP_STATE ||
    join(
      env.CLAWDTIME_CONFIG_HOME || join(home, ".local", "share", "clawdtime"),
      "desktop",
    );
  if (!isAbsolute(root) || (env.VITEST && !env.CLAWDTIME_DESKTOP_STATE))
    return null;
  try {
    const service = privateJSON(join(root, "desktop-service.json"));
    const panel = privateJSON(join(root, "desktop-panel.json"));
    const owner = privateJSON(join(root, "owner.lock"));
    if (
      service.version !== 1 ||
      panel.version !== 1 ||
      !identity(service.instanceId) ||
      !integer(service.pid) ||
      service.pid !== owner.pid ||
      !exists(service.pid) ||
      typeof service.origin !== "string" ||
      !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(service.origin) ||
      new URL(service.origin).port === "0" ||
      service.origin !== panel.origin ||
      !/^[a-f0-9]{64}$/.test(service.configurationFingerprint) ||
      service.configurationFingerprint !== panel.configurationFingerprint ||
      typeof panel.token !== "string" ||
      panel.token.length < 32 ||
      panel.token.length > 4096 ||
      /[\r\n]/.test(panel.token)
    )
      return null;
    return {
      origin: service.origin,
      instanceId: service.instanceId,
      token: panel.token,
    };
  } catch {
    return null;
  }
}

async function boundedJSON(response, maximum = 8192) {
  if (!response.ok || response.redirected || !response.body)
    throw Error("Presentation unavailable.");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximum) throw Error("Presentation unavailable.");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Start only while the caller is sharing. One in-flight read and one current event; stop cancels both.
 * `since` is the call/share start time, so a newly joined caller cannot inherit a previous target.
 * `check()` coalesces reads and is exposed for deterministic fixture tests.
 */
export function startPresentation({
  since,
  onEvent,
  env = process.env,
  home = homedir(),
  pollMs = 150,
  timeoutMs = 800,
  now = Date.now,
  request = fetch,
  discover = () => presentationService({ env, home }),
  automatic = true,
} = {}) {
  if (!Number.isFinite(since) || typeof onEvent !== "function")
    throw Error("Presentation needs a call lifetime.");
  let stopped = false,
    pending = null,
    controller = null,
    verified = null,
    boundConnection = null,
    shown = null,
    activeHold = false;
  let producer = null,
    sequence = 0,
    command = 0;
  const clear = (immediate = false) => {
    if (immediate) {
      if (shown !== null || activeHold) {
        shown = null;
        activeHold = false;
        onEvent(null, { immediate: true });
      }
      return;
    }
    if (shown !== null) {
      shown = null;
      onEvent(null);
    }
  };
  const check = () => {
    if (stopped) return Promise.resolve();
    if (shown && shown.expiresAt <= now()) clear(false);
    if (pending) return pending;
    pending = (async () => {
      const service = discover();
      if (!service) {
        verified = null;
        clear(true);
        return;
      }
      const connection = `${service.origin}|${service.instanceId}|${service.token}`;
      controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), timeoutMs);
      const get = async (path, maximum) => {
        const response = await request(service.origin + path, {
          method: "GET",
          headers: {
            authorization: `Bearer ${service.token}`,
            "cache-control": "no-store",
          },
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        });
        return boundedJSON(response, maximum);
      };
      try {
        if (verified !== connection) {
          clear(true);
          const state = await get("/desktop/state", 262144);
          if (state.instanceId !== service.instanceId)
            throw Error("Presentation unavailable.");
          // A failed read retires pixels, not replay fences. Only a verified new service resets them.
          if (boundConnection !== connection) {
            producer = null;
            sequence = 0;
            command = 0;
            boundConnection = connection;
          }
          verified = connection;
        }
        const snapshot = await get("/desktop/presentation", 8192);
        if (stopped) return;
        if (
          !keys(snapshot, ["version", "event"], ["retired"]) ||
          snapshot.version !== 1 ||
          (Object.hasOwn(snapshot, "retired") &&
            typeof snapshot.retired !== "boolean") ||
          (snapshot.retired === true && snapshot.event !== null)
        )
          throw Error("Presentation unavailable.");
        const event = snapshot.event;
        if (event === null) {
          clear(snapshot.retired === true);
          return;
        }
        if (!validPresentationEvent(event, { now: now(), since })) {
          clear(true);
          return;
        }
        if (
          event.commandSeq < command ||
          (event.producerId === producer && event.sequence < sequence) ||
          (producer !== null &&
            event.producerId !== producer &&
            event.commandSeq <= command)
        ) {
          clear(true);
          return;
        }
        if (event.producerId === producer && event.sequence === sequence)
          return;
        producer = event.producerId;
        sequence = event.sequence;
        command = event.commandSeq;
        shown = event;
        activeHold = event.kind !== "reset" && event.kind !== "transition";
        onEvent(event);
      } catch {
        verified = null;
        if (!stopped) clear(true);
      } finally {
        clearTimeout(timer);
        controller = null;
      }
    })()
      .catch(() => {
        if (!stopped) clear(true);
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  const timer = automatic
    ? setInterval(() => void check(), Math.max(50, pollMs))
    : null;
  timer?.unref();
  if (automatic) void check();
  return {
    check,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      controller?.abort();
      clear(true);
    },
  };
}

const share = (r) =>
  keys(r, ["x", "y", "w", "h"]) &&
  [r.x, r.y, r.w, r.h].every(
    (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
  ) &&
  r.w > 0 &&
  r.h > 0 &&
  r.x + r.w <= 1.0001 &&
  r.y + r.h <= 1.0001;

/** The answer of `POST /desktop/presentation/region`, or null for anything else. */
export function validRegionAnswer(answer) {
  if (
    !keys(answer, ["version", "code", "match", "region"]) ||
    answer.version !== 1
  )
    return null;
  if (answer.code === "found")
    return ["element", "window"].includes(answer.match) && share(answer.region)
      ? {
          code: "found",
          match: answer.match,
          region: {
            x: answer.region.x,
            y: answer.region.y,
            w: answer.region.w,
            h: answer.region.h,
          },
        }
      : null;
  return ["no_look", "no_match"].includes(answer.code) &&
    answer.match === null &&
    answer.region === null
    ? { code: answer.code }
    : null;
}

/**
 * Where a thing that the caller names is on the main display, from the desktop service: its hands' last look
 * and the window list. The service only reads; it sends no input and takes no picture. The answer has no
 * label of the screen. Any failure is `unavailable`, never a guess.
 */
export async function requestRegion(
  name,
  {
    env = process.env,
    home = homedir(),
    timeoutMs = 3000,
    request = fetch,
    discover = () => presentationService({ env, home }),
  } = {},
) {
  if (typeof name !== "string" || !name.trim() || name.length > 120)
    return { code: "unavailable" };
  const service = discover();
  if (!service) return { code: "unavailable" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const call = (path, body) =>
    request(service.origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${service.token}`,
        "cache-control": "no-store",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
  try {
    const state = await boundedJSON(await call("/desktop/state"), 262144);
    if (state?.instanceId !== service.instanceId)
      return { code: "unavailable" };
    const answer = await boundedJSON(
      await call("/desktop/presentation/region", { name }),
      4096,
    );
    return validRegionAnswer(answer) ?? { code: "unavailable" };
  } catch {
    return { code: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the active call video view from the desktop service (`GET /desktop/view`).
 * Returns null when the desktop service is unavailable or the reply is malformed.
 */
export async function requestView({
  env = process.env,
  home = homedir(),
  timeoutMs = 2000,
  request = fetch,
  discover = () => presentationService({ env, home }),
} = {}) {
  const service = discover();
  if (!service) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const get = (path, maximum) =>
    request(service.origin + path, {
      method: "GET",
      headers: {
        authorization: `Bearer ${service.token}`,
        "cache-control": "no-store",
      },
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    }).then((response) => boundedJSON(response, maximum));
  try {
    const state = await get("/desktop/state", 262144);
    if (state?.instanceId !== service.instanceId) return null;
    const value = await get("/desktop/view", 4096);
    if (
      !keys(value, ["view", "at"]) ||
      typeof value.at !== "number" ||
      !Number.isFinite(value.at) ||
      value.at < 0
    )
      return null;
    if (value.view === null) return { view: null, at: value.at };
    if (!share(value.view)) return null;
    return {
      view: {
        x: value.view.x,
        y: value.view.y,
        w: value.view.w,
        h: value.view.h,
      },
      at: value.at,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
