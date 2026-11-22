const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalLineReadiness, transportReadiness } from "./local-readiness.mjs";
import { hostLogBoundary, hostStopReceipt } from "./host-receipts.mjs";

const now = 1_800_000_000_000;
const lineId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const bindingId = "33333333-3333-4333-8333-333333333333";
const workerId = "44444444-4444-4444-8444-444444444444";
const stamp = new Date(now - 1000).toISOString();
const prerequisites = [
  "accessibility",
  "facetime_signed_in",
  "audio_devices",
  "facetime_selections",
  "playback_renderer",
  "configuration",
  "control_plane_poll",
];
function fixture() {
  const automatic = {
    version: 1,
    worker_id: workerId,
    runtime_id: "55555555-5555-4555-8555-555555555555",
    build: "a".repeat(64),
    device_binding: "b".repeat(64),
    config_binding: "c".repeat(64),
    profile: "audio_video",
    runtime_started_at: stamp,
    started_at: stamp,
    completed_at: stamp,
    checks: [
      ...prerequisites,
      "system_audio_capture",
      "video_resources",
      "screen_capture",
    ].map((id) => ({ id, outcome: "passed", completed_at: stamp })),
  };
  const readiness = {
    automatic,
    runtime_id: automatic.runtime_id,
    build: automatic.build,
    device_binding: automatic.device_binding,
    config_binding: automatic.config_binding,
    control_ready: true,
    facetime_signed_in: true,
    accessibility_ready: true,
    audio_ready: true,
  };
  const worker = {
    id: workerId,
    enabled: true,
    status: "accepting",
    current_call_id: null,
    automatic_readiness_enabled: true,
    last_heartbeat_at: stamp,
    readiness,
    capabilities: {
      video: true,
      outbound_audio_protocol: 1,
      outbound_video_protocol: 1,
    },
  };
  const line = {
    id: lineId,
    worker_id: workerId,
    supports_audio: true,
    supports_video: true,
    status: "available",
    current_call_id: null,
    worker_occupied: false,
    session_health: {
      line_id: lineId,
      identity_confirmed: true,
      status: "accepting",
      last_heartbeat_at: stamp,
      capabilities: worker.capabilities,
      readiness,
    },
  };
  const bindings = [
    {
      state: "revoked",
      connected: false,
      scope: { line_id: lineId, project_id: projectId, binding_id: bindingId },
    },
  ];
  const local = {
    version: 1,
    attemptId: "attempt-one",
    lineId,
    incomingBindingId: bindingId,
    phase: "outbound_reserved",
    release: { state: "released", retained: 0, offset: 123 },
    cursorBefore: { sequence: 10, eventId: "event-10" },
    cursorAfter: { sequence: 10, eventId: "event-10" },
    unresolvedEffects: 0,
    activeCalls: 0,
    activeCaptures: 0,
    localStop: false,
    checkedAt: now,
  };
  const requests = [];
  const request = async (url, init) => {
    requests.push({ url, init });
    const data = url.includes("/lines?")
      ? { items: [line], limit: 100, offset: 0, total: 1 }
      : url.includes("/workers?")
        ? { items: [worker], limit: 100, offset: 0, total: 1 }
        : bindings;
    return new Response(JSON.stringify({ data }));
  };
  const inspect = (extra = {}) =>
    new LocalLineReadiness(
      {
        callsOrigin: "https://calls.example.test",
        projectId,
        projectKey: "synthetic-fixture-key",
        lineId,
      },
      {
        readLocalEvidence: () => structuredClone(local),
        request,
        clock: () => now,
        ...extra,
      },
    ).inspect("attempt-one");
  return { line, worker, bindings, local, requests, inspect, request };
}

test("fresh exact released owner and native media evidence permit read-only admission", async () => {
  const f = fixture(),
    result = await f.inspect();
  assert.equal(result.exclusiveOwner, true);
  assert.equal(result.audioReady, true);
  assert.equal(result.videoReady, true);
  assert.equal(f.requests.length, 3);
  for (const r of f.requests) {
    assert.equal(r.init.method, "GET");
    assert.equal(r.init.redirect, "error");
    assert.equal(r.init.body, undefined);
  }
});
for (const [name, mutate] of [
  ["wrong attempt", (f) => (f.local.attemptId = "other")],
  ["wrong line", (f) => (f.local.lineId = workerId)],
  ["changed cursor identity", (f) => (f.local.cursorAfter.eventId = "other")],
  ["rewound cursor", (f) => (f.local.cursorAfter.sequence = 9)],
  ["unknown effect", (f) => (f.local.unresolvedEffects = 1)],
  ["retained host work", (f) => (f.local.release.retained = 1)],
  ["active capture", (f) => (f.local.activeCaptures = 1)],
  ["Stop", (f) => (f.local.localStop = true)],
  ["stale local proof", (f) => (f.local.checkedAt = now - 10_001)],
  ["future local proof", (f) => (f.local.checkedAt = now + 1)],
  ["incoming busy", (f) => (f.line.current_call_id = "incoming")],
  ["worker busy", (f) => (f.line.worker_occupied = true)],
  ["incoming still registered", (f) => (f.bindings[0].state = "active")],
  ["incoming still connected", (f) => (f.bindings[0].connected = true)],
  ["unknown release", (f) => (f.bindings.length = 0)],
  [
    "other owner",
    (f) =>
      f.bindings.push({
        state: "active",
        connected: true,
        scope: { line_id: lineId, binding_id: workerId },
      }),
  ],
  ["wrong release project", (f) => (f.bindings[0].scope.project_id = workerId)],
  ["wrong worker", (f) => (f.line.worker_id = lineId)],
  [
    "stale native heartbeat",
    (f) =>
      (f.line.session_health.last_heartbeat_at = new Date(
        now - 90_000,
      ).toISOString()),
  ],
  [
    "unconfirmed identity",
    (f) => (f.line.session_health.identity_confirmed = false),
  ],
  [
    "missing independent audio check",
    (f) => f.line.session_health.readiness.automatic.checks.shift(),
  ],
])
  test(`refuses ${name}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.inspect());
  });

test("scope change during provider reads invalidates result", async () => {
  const f = fixture();
  let reads = 0;
  await assert.rejects(
    f.inspect({
      readLocalEvidence: () => ({
        ...structuredClone(f.local),
        checkedAt: now - (reads++ ? 1 : 0),
      }),
    }),
    /ownership_changed/,
  );
});
test("lost response makes no retry or write", async () => {
  const f = fixture();
  let count = 0;
  await assert.rejects(
    f.inspect({
      request: async () => {
        count++;
        throw Error("lost");
      },
    }),
  );
  assert.equal(count, 3);
});
test("bad native video binding cannot qualify walkthrough", () => {
  const f = fixture();
  f.worker.readiness.automatic.device_binding = "d".repeat(64);
  assert.equal(transportReadiness(f.line, f.worker, now).audioReady, true);
  assert.equal(transportReadiness(f.line, f.worker, now).videoReady, false);
});
test("late system audio capture is distinct from observed playback", () => {
  const f = fixture();
  f.line.session_health.readiness.audio_ready = false;
  Object.assign(
    f.line.session_health.readiness.automatic.checks.find(
      (c) => c.id === "system_audio_capture",
    ),
    { outcome: "at_call_start", completed_at: null },
  );
  assert.equal(transportReadiness(f.line, f.worker, now).audioReady, true);
});

function hostFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "clawdtime-host-receipt-")),
    path = join(dir, "dev.jsonl");
  try {
    writeFileSync(
      path,
      JSON.stringify({ code: "dev_stopped", retained: 0 }) + "\n",
    );
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("historical release never proves current shutdown", () =>
  hostFixture((path) => {
    const b = hostLogBoundary(path);
    assert.equal(hostStopReceipt(path, b).state, "waiting");
    appendFileSync(
      path,
      JSON.stringify({ code: "dev_stopped", retained: 0 }) + "\n",
    );
    assert.equal(hostStopReceipt(path, b).state, "released");
  }));
for (const row of [
  { code: "dev_stopped", retained: 1 },
  { code: "dev_stopped" },
  { code: "release_failed" },
  { code: "cleanup_pending" },
])
  test(`retains unknown for ${JSON.stringify(row)}`, () =>
    hostFixture((path) => {
      const b = hostLogBoundary(path);
      appendFileSync(path, JSON.stringify(row) + "\n");
      assert.equal(hostStopReceipt(path, b).state, "unknown");
    }));
test("partial final release record remains waiting", () =>
  hostFixture((path) => {
    const b = hostLogBoundary(path);
    appendFileSync(path, JSON.stringify({ code: "dev_stopped", retained: 0 }));
    assert.equal(hostStopReceipt(path, b).state, "waiting");
  }));
test("log rotation and truncation never reset the boundary", () =>
  hostFixture((path) => {
    const b = hostLogBoundary(path);
    renameSync(path, path + ".old");
    writeFileSync(
      path,
      JSON.stringify({ code: "dev_stopped", retained: 0 }) + "\n",
    );
    assert.equal(hostStopReceipt(path, b).state, "unknown");
  }));
test("restart following a clean release refuses ownership", () =>
  hostFixture((path) => {
    const b = hostLogBoundary(path);
    appendFileSync(
      path,
      '{"code":"dev_stopped","retained":0}\n{"code":"dev_connected"}\n',
    );
    assert.equal(hostStopReceipt(path, b).state, "unknown");
  }));

test("installed and latest chert dev cannot release while preserving the original journal", async () => {
  const { assertIncomingReleaseSupported } =
    await import("./local-readiness.mjs");
  for (const version of ["0.1.0-beta.19", "0.1.0-beta.22", "unknown-future"])
    assert.throws(
      () => assertIncomingReleaseSupported({ program: "chert-dev", version }),
      /deletes_original_journal/,
    );
});
test("BYOR witness reads original receipts in place, permits append and refuses deletion", async () => {
  const { createByorReceiptWitness } = await import("./local-readiness.mjs");
  const directory = mkdtempSync(join(tmpdir(), "clawdtime-byor-witness-")),
    path = join(directory, "journal.json");
  const scope = {
    project_id: projectId,
    line_id: lineId,
    binding_id: bindingId,
    binding_epoch: 1,
    instance_id: "fixture-instance",
    connection_generation: 1,
    session_mode: "byor",
  };
  const data = {
    schema_version: 2,
    mode: "byor",
    scope,
    handler: { id: "fixture", module: "fixture" },
    entries: {
      entry: {
        owner: { ...scope, call_id: "call-one", request_id: "request-one" },
        call: {
          call_id: "call-one",
          request_id: "request-one",
          project_id: projectId,
          line_id: lineId,
        },
        digest: "a".repeat(64),
        authoritative_terminal: true,
        settled: true,
        cleanup: "clean",
        events: [],
      },
    },
    receipts: { "event-one": "receipt-one" },
  };
  try {
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
    const witness = createByorReceiptWitness(path, scope);
    const before = readFileSync(path, "utf8");
    assert.equal(witness.inspect().beforeReceiptCount, 1);
    assert.equal(readFileSync(path, "utf8"), before);
    data.receipts["event-two"] = "receipt-two";
    writeFileSync(path, JSON.stringify(data));
    assert.equal(witness.inspect().afterReceiptCount, 2);
    delete data.receipts["event-one"];
    writeFileSync(path, JSON.stringify(data));
    assert.throws(() => witness.inspect(), /not_preserved/);
    rmSync(path);
    assert.throws(() => witness.inspect());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
