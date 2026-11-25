const { test, afterEach } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  presentationService,
  requestView,
  startPresentation,
  validPresentationEvent,
} from "./presentation-source.mjs";

const cleanup = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

const event = (at = 10000) => ({
  version: 1,
  producerId: "fixture-panel",
  sequence: 1,
  commandSeq: 41,
  at,
  expiresAt: at + 1500,
  kind: "typing",
  reducedMotion: false,
  surface: {
    displayId: "1",
    width: 1440,
    height: 900,
    scale: 2,
    appId: "fixture.app",
    windowId: "12",
    window: { x: 10, y: 20, w: 1000, h: 800 },
  },
  target: { x: 100, y: 100, w: 600, h: 30 },
});
const reply = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

test("wire validator rejects text, outside geometry, missing identity, old calls, and excessive lifetime", () => {
  const good = event();
  assert.equal(validPresentationEvent(good, { now: 10000, since: 9000 }), true);
  for (const value of [
    { ...good, label: "not metadata" },
    { ...good, image: "not metadata" },
    { ...good, expiresAt: 12001 },
    { ...good, at: 10101 },
    { ...good, surface: { ...good.surface, appId: "" } },
    { ...good, surface: { ...good.surface, scale: 0 } },
    { ...good, target: { x: 1439, y: 0, w: 2, h: 1 } },
    { ...good, kind: "context" },
    { ...good, kind: "transition" },
  ])
    assert.equal(
      validPresentationEvent(value, { now: 10000, since: 9000 }),
      false,
    );
  assert.equal(
    validPresentationEvent(good, { now: 10000, since: 10001 }),
    false,
  );
  assert.equal(
    validPresentationEvent(good, { now: 11500, since: 9000 }),
    false,
  );
});

test("poller authenticates read-only requests, de-duplicates frames, expires and rejects delayed data", async () => {
  let now = 10000;
  let current = event();
  const calls = [],
    shown = [];
  const source = startPresentation({
    since: 9000,
    now: () => now,
    onEvent: (value) => shown.push(value),
    automatic: false,
    discover: () => ({
      origin: "http://127.0.0.1:1234",
      token: "fixture",
      instanceId: "fixture",
    }),
    request: async (url, options) => {
      calls.push({ url, options });
      return reply(
        url.endsWith("/state")
          ? { instanceId: "fixture" }
          : { version: 1, event: current },
      );
    },
  });
  await source.check();
  await source.check();
  assert.equal(shown.length, 1);
  assert.equal(calls.length, 3);
  for (const { url, options } of calls) {
    assert.match(
      url,
      /^http:\/\/127\.0\.0\.1:1234\/desktop\/(state|presentation)$/,
    );
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, "Bearer fixture");
  }
  now = 11500;
  await source.check();
  assert.equal(shown.at(-1), null);
  current = { ...event(now), sequence: 2 };
  await source.check();
  assert.equal(shown.at(-1)?.sequence, 2);
  current = { ...event(now), sequence: 1 };
  await source.check();
  assert.equal(shown.at(-1), null);
  current = { ...event(now), producerId: "retired", sequence: 100 };
  await source.check();
  assert.equal(shown.at(-1), null);
  source.stop();
  const count = calls.length;
  await source.check();
  assert.equal(calls.length, count);
});

test("poller holds one request, cancels on stop, and never publishes a late answer", async () => {
  let resolve;
  let signal;
  let calls = 0;
  const shown = [];
  const source = startPresentation({
    since: 9000,
    now: () => 10000,
    onEvent: (value) => shown.push(value),
    automatic: false,
    discover: () => ({
      origin: "http://127.0.0.1:1234",
      token: "fixture",
      instanceId: "fixture",
    }),
    request: async (url, options) => {
      calls++;
      if (url.endsWith("/state")) return reply({ instanceId: "fixture" });
      signal = options.signal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const pending = source.check();
  for (let i = 0; i < 10 && !resolve; i++)
    await new Promise((done) => setImmediate(done));
  assert.equal(source.check(), pending);
  assert.equal(calls, 2);
  source.stop();
  assert.equal(signal.aborted, true);
  resolve(reply({ version: 1, event: event() }));
  await pending;
  assert.deepEqual(shown, []);
});

test("a lost request clears presentation but does not replay the old event after reconnection", async () => {
  let failed = false;
  let current = event();
  const shown = [];
  const source = startPresentation({
    since: 9000,
    now: () => 10000,
    automatic: false,
    onEvent: (value) => shown.push(value),
    discover: () => ({
      origin: "http://127.0.0.1:1234",
      token: "fixture",
      instanceId: "fixture",
    }),
    request: async (url) => {
      if (failed) throw Error("fixture disconnected");
      return reply(
        url.endsWith("/state")
          ? { instanceId: "fixture" }
          : { version: 1, event: current },
      );
    },
  });
  await source.check();
  failed = true;
  await source.check();
  assert.deepEqual(
    shown.map((e) => e?.sequence ?? null),
    [1, null],
  );
  failed = false;
  await source.check();
  assert.deepEqual(
    shown.map((e) => e?.sequence ?? null),
    [1, null],
  );
  current = { ...event(), sequence: 2 };
  await source.check();
  assert.deepEqual(
    shown.map((e) => e?.sequence ?? null),
    [1, null, 2],
  );
  source.stop();
});

test("private discovery and real loopback polling refuse mismatches, redirects and non-private files", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-presentation-"));
  let mode = "good",
    remoteRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === "/unexpected") {
      remoteRequests++;
      res.end("{}");
      return;
    }
    assert.equal(req.headers.authorization, `Bearer ${"p".repeat(40)}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/desktop/state")
      res.end(
        JSON.stringify({
          instanceId: mode === "wrong-instance" ? "other" : "fixture",
        }),
      );
    else if (mode === "redirect") {
      res.writeHead(302, { location: "/unexpected" });
      res.end();
    } else if (mode === "oversize")
      res.end(JSON.stringify({ junk: "x".repeat(9000) }));
    else res.end(JSON.stringify({ version: 1, event: event() }));
  });
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const service = {
    version: 1,
    instanceId: "fixture",
    pid: process.pid,
    origin,
    configurationFingerprint: "a".repeat(64),
  };
  const panel = {
    version: 1,
    origin,
    token: "p".repeat(40),
    configurationFingerprint: "a".repeat(64),
  };
  const write = (name, value) =>
    writeFileSync(join(root, name), JSON.stringify(value), { mode: 0o600 });
  write("desktop-service.json", service);
  write("desktop-panel.json", panel);
  write("owner.lock", { pid: process.pid });
  const env = { CLAWDTIME_DESKTOP_STATE: root };
  assert.equal(presentationService({ env }).origin, origin);
  write("desktop-panel.json", { ...panel, origin: "http://example.com" });
  assert.equal(presentationService({ env }), null);
  write("desktop-panel.json", panel);
  chmodSync(join(root, "desktop-panel.json"), 0o644);
  assert.equal(presentationService({ env }), null);
  chmodSync(join(root, "desktop-panel.json"), 0o600);
  write("owner.lock", { pid: process.pid + 1 });
  assert.equal(presentationService({ env }), null);
  write("owner.lock", { pid: process.pid });
  unlinkSync(join(root, "desktop-panel.json"));
  write("panel-copy.json", panel);
  symlinkSync(join(root, "panel-copy.json"), join(root, "desktop-panel.json"));
  assert.equal(presentationService({ env }), null);
  unlinkSync(join(root, "desktop-panel.json"));
  write("desktop-panel.json", panel);
  for (mode of ["good", "redirect", "oversize", "wrong-instance"]) {
    const shown = [];
    const source = startPresentation({
      since: 9000,
      now: () => 10000,
      env,
      onEvent: (value) => shown.push(value),
      automatic: false,
    });
    await source.check();
    assert.equal(shown.length, mode === "good" ? 1 : 0);
    source.stop();
  }
  assert.equal(remoteRequests, 0);
});

test("poller preserves hold on clean completion and retires immediately on retired: true including mid-hold", async () => {
  let now = 10000;
  let snapshot = { version: 1, event: event(now) };
  const received = [];
  const source = startPresentation({
    since: 9000,
    now: () => now,
    onEvent: (value, options) => received.push({ value, options }),
    automatic: false,
    discover: () => ({
      origin: "http://127.0.0.1:1234",
      token: "fixture",
      instanceId: "fixture",
    }),
    request: async (url) =>
      reply(url.endsWith("/state") ? { instanceId: "fixture" } : snapshot),
  });
  await source.check();
  assert.equal(received.length, 1);
  assert.equal(received[0].value.sequence, 1);

  // Clean completion / expiry: event becomes null without retired: true.
  snapshot = { version: 1, event: null };
  await source.check();
  assert.deepEqual(received.at(-1), { value: null, options: undefined });

  // Repeated clean null does not re-emit.
  await source.check();
  assert.equal(received.length, 2);

  // Mid-hold Stop or takeover after clean expiry: retired: true emits immediate retire once.
  snapshot = { version: 1, event: null, retired: true };
  await source.check();
  assert.deepEqual(received.at(-1), {
    value: null,
    options: { immediate: true },
  });

  // Repeated retired: true does not spam onEvent once activeHold is cleared.
  await source.check();
  assert.equal(received.length, 3);

  // Active event followed directly by retired: true emits immediate retire.
  now += 200;
  snapshot = { version: 1, event: { ...event(now), sequence: 2 } };
  await source.check();
  assert.equal(received.at(-1).value.sequence, 2);
  snapshot = { version: 1, event: null, retired: true };
  await source.check();
  assert.deepEqual(received.at(-1), {
    value: null,
    options: { immediate: true },
  });

  // Malformed retired field or retired: true with an event fails closed immediately.
  now += 200;
  snapshot = { version: 1, event: { ...event(now), sequence: 3 } };
  await source.check();
  assert.equal(received.at(-1).value.sequence, 3);
  snapshot = { version: 1, event: null, retired: "yes" };
  await source.check();
  assert.deepEqual(received.at(-1), {
    value: null,
    options: { immediate: true },
  });

  now += 200;
  snapshot = { version: 1, event: { ...event(now), sequence: 4 } };
  await source.check();
  snapshot = {
    version: 1,
    event: { ...event(now), sequence: 5 },
    retired: true,
  };
  await source.check();
  assert.deepEqual(received.at(-1), {
    value: null,
    options: { immediate: true },
  });

  // Stop during activeHold after clean expiry emits immediate retire.
  now += 200;
  snapshot = { version: 1, event: { ...event(now), sequence: 6 } };
  await source.check();
  snapshot = { version: 1, event: null };
  await source.check();
  assert.deepEqual(received.at(-1), { value: null, options: undefined });
  source.stop();
  assert.deepEqual(received.at(-1), {
    value: null,
    options: { immediate: true },
  });
});

test("requestView authenticates against /desktop/state and validates /desktop/view replies", async () => {
  let stateBody = { instanceId: "fixture" };
  let viewBody = { view: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, at: 12345 };
  const calls = [];
  const discover = () => ({
    origin: "http://127.0.0.1:4321",
    token: "panel-secret",
    instanceId: "fixture",
  });
  const request = async (url, options) => {
    calls.push({ url, options });
    return reply(url.endsWith("/state") ? stateBody : viewBody);
  };
  assert.deepEqual(await requestView({ discover, request }), {
    view: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 },
    at: 12345,
  });
  assert.equal(calls[0].options.headers.authorization, "Bearer panel-secret");
  assert.equal(calls[1].url, "http://127.0.0.1:4321/desktop/view");

  viewBody = { view: null, at: 12346 };
  assert.deepEqual(await requestView({ discover, request }), {
    view: null,
    at: 12346,
  });

  // Malformed view bounds or mismatched instanceId fail closed to null.
  viewBody = { view: { x: 0.9, y: 0, w: 0.5, h: 0.5 }, at: 12347 };
  assert.equal(await requestView({ discover, request }), null);

  viewBody = { view: null, at: 12348 };
  stateBody = { instanceId: "other" };
  assert.equal(await requestView({ discover, request }), null);

  assert.equal(await requestView({ discover: () => null, request }), null);
});
