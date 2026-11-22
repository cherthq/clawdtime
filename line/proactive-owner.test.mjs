const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  statSync,
  rmSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  RetainedProactiveLineOwner,
  hasProcessAncestor,
} from "./proactive-owner.mjs";

const lineId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const bindingId = "33333333-3333-4333-8333-333333333333";
const workerId = "44444444-4444-4444-8444-444444444444";
const restoredBindingId = "55555555-5555-4555-8555-555555555555";
const now = 1_800_000_000_000;
const stamp = new Date(now - 1000).toISOString();

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-retained-owner-"));
  const hostStateDirectory = join(root, "host"),
    providerStateDirectory = join(root, "provider");
  mkdirSync(hostStateDirectory, { mode: 0o700 });
  mkdirSync(providerStateDirectory, { mode: 0o700 });
  const scope = {
    project_id: projectId,
    line_id: lineId,
    binding_id: bindingId,
    binding_epoch: 1,
    instance_id: "fixture-instance",
    connection_generation: 1,
    session_mode: "byor",
  };
  const journal = {
    schema_version: 2,
    mode: "byor",
    scope,
    entries: {},
    receipts: { "prior-event": "prior-receipt" },
  };
  const writeJournal = (binding, value) => {
    const directory = join(providerStateDirectory, binding);
    mkdirSync(directory, { mode: 0o700, recursive: true });
    const path = join(directory, "journal.json");
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  const initialJournal = writeJournal(bindingId, journal),
    logPath = join(hostStateDirectory, "dev.jsonl");
  writeFileSync(
    logPath,
    JSON.stringify({
      code: "dev_ready",
      agent: "fixture-agent",
      binding_id: bindingId,
      state_dir: join(providerStateDirectory, bindingId),
    }) +
      "\n" +
      JSON.stringify({ code: "dev_connected" }) +
      "\n",
    { mode: 0o600 },
  );
  const automatic = {
    version: 1,
    worker_id: workerId,
    runtime_id: "66666666-6666-4666-8666-666666666666",
    build: "a".repeat(64),
    device_binding: "b".repeat(64),
    config_binding: "c".repeat(64),
    profile: "audio_video",
    runtime_started_at: stamp,
    started_at: stamp,
    completed_at: stamp,
    checks: [
      "accessibility",
      "facetime_signed_in",
      "audio_devices",
      "facetime_selections",
      "playback_renderer",
      "configuration",
      "control_plane_poll",
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
      state: "active",
      connected: true,
      name: "fixture-agent",
      scope: { ...scope },
    },
  ];
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    const data = req.url.startsWith("/api/v1/lines?")
      ? { items: [line], offset: 0, limit: 100, total: 1 }
      : req.url.startsWith("/api/v1/workers?")
        ? { items: [worker], offset: 0, limit: 100, total: 1 }
        : req.url === "/api/v1/connectors"
          ? bindings
          : null;
    res.writeHead(data === null ? 404 : 200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify({ data }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const request = (url, init) => {
    if (flags.lostInspection) throw Error("synthetic_lost_provider_read");
    return fetch(
      `http://127.0.0.1:${port}${new URL(url).pathname}${new URL(url).search}`,
      init,
    );
  };
  let running = true,
    pid = 10101,
    stops = 0,
    starts = 0;
  const flags = {
    lostStop: false,
    lostStart: false,
    lostInspection: false,
    retained: 0,
    afterStop: undefined,
    beforeStart: undefined,
    afterStart: undefined,
  };
  const host = {
    inspect: async () => ({ running, ...(running ? { pid } : {}) }),
    stop: async () => {
      stops++;
      running = false;
      bindings[0].state = "revoked";
      bindings[0].connected = false;
      appendFileSync(
        logPath,
        JSON.stringify({ code: "dev_stopped", retained: flags.retained }) +
          "\n",
      );
      flags.afterStop?.();
      if (flags.lostStop) throw Error("synthetic_lost_stop_response");
    },
    start: async () => {
      starts++;
      flags.beforeStart?.();
      running = true;
      pid = 20202;
      const restoredScope = {
        ...scope,
        binding_id: restoredBindingId,
        binding_epoch: 2,
        instance_id: "restored-fixture-instance",
      };
      bindings.push({
        state: "active",
        connected: true,
        name: "fixture-agent",
        scope: restoredScope,
      });
      const restoredJournal = writeJournal(restoredBindingId, {
        ...journal,
        scope: restoredScope,
        receipts: {},
      });
      appendFileSync(
        logPath,
        JSON.stringify({
          code: "dev_ready",
          agent: "fixture-agent",
          binding_id: restoredBindingId,
          state_dir: join(restoredJournal, ".."),
        }) +
          "\n" +
          JSON.stringify({ code: "dev_connected" }) +
          "\n",
      );
      flags.afterStart?.(restoredJournal, restoredScope);
      if (flags.lostStart) throw Error("synthetic_lost_start_response");
    },
  };
  const config = {
    callsOrigin: "https://calls.example.test",
    projectId,
    projectKey: "synthetic-fixture-project-key",
    connectorToken: "synthetic-fixture-connector-token",
    lineId,
    hostScript: join(root, "host.sh"),
    hostStateDirectory,
    hostSession: "fixture-host",
    agentName: "fixture-agent",
    retentionConfigFile: join(root, "retention.json"),
    providerStateDirectory,
    initialJournal,
    stateFile: join(root, "owner.json"),
  };
  const make = () =>
    new RetainedProactiveLineOwner(config, {
      request,
      clock: () => now,
      host,
      retention: async (retentionPid) => ({
        capability: "clawdtime-retention-v1",
        pid: retentionPid,
      }),
    });
  return {
    root,
    config,
    initialJournal,
    journal,
    logPath,
    line,
    worker,
    bindings,
    requests,
    flags,
    make,
    stops: () => stops,
    starts: () => starts,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("concrete owner releases and reacquires while the original journal and receipts remain in place", async () => {
  const f = await fixture();
  try {
    const owner = f.make(),
      original = readFileSync(f.initialJournal),
      inode = statSync(f.initialJournal).ino;
    assert.equal((await owner.readiness()).ready, true);
    assert.deepEqual(await owner.acquire("attempt-one"), { exclusive: true });
    assert.equal(f.stops(), 1);
    assert.equal(await owner.verify("attempt-one"), true);
    assert.equal(await owner.verify("different-attempt"), false);
    assert.deepEqual(readFileSync(f.initialJournal), original);
    assert.equal(statSync(f.initialJournal).ino, inode);
    assert.deepEqual(await owner.restore("attempt-one"), { confirmed: true });
    assert.equal(f.starts(), 1);
    assert.equal((await owner.readiness()).ready, true);
    assert.deepEqual(readFileSync(f.initialJournal), original);
    assert.equal(statSync(f.initialJournal).ino, inode);
    const state = JSON.parse(readFileSync(f.config.stateFile, "utf8"));
    assert.equal(state.retained.length, 1);
    assert.equal(state.retained[0].receiptCount, 1);
    assert.notEqual(state.currentJournal, f.initialJournal);
    const reopened = f.make();
    assert.equal((await reopened.readiness()).ready, true);
    assert.equal(
      f.requests.every((r) => r.method === "GET"),
      true,
    );
  } finally {
    await f.close();
  }
});

test("duplicate admission never releases an already reserved line twice", async () => {
  const f = await fixture();
  try {
    const owner = f.make();
    await owner.acquire("attempt-one");
    await assert.rejects(owner.acquire("attempt-one"));
    await assert.rejects(owner.acquire("attempt-two"));
    assert.equal(f.stops(), 1);
    assert.equal(f.starts(), 0);
    const reopened = f.make();
    assert.equal((await reopened.readiness()).ready, false);
    assert.equal(await reopened.verify("attempt-one"), true);
    await reopened.restore("attempt-one");
    assert.equal(f.starts(), 1);
  } finally {
    await f.close();
  }
});

test("busy incoming calls and ambiguous owners prevent host release", async () => {
  const f = await fixture();
  try {
    const owner = f.make();
    f.line.current_call_id = "incoming-call";
    assert.equal((await owner.readiness()).ready, false);
    await assert.rejects(owner.acquire("attempt-one"));
    f.line.current_call_id = null;
    f.bindings.push({
      state: "active",
      connected: true,
      scope: {
        project_id: projectId,
        line_id: lineId,
        binding_id: restoredBindingId,
      },
    });
    assert.equal((await owner.readiness()).ready, false);
    assert.equal(f.stops(), 0);
  } finally {
    await f.close();
  }
});

for (const failure of [
  "lostStop",
  "retained",
  "incomingArrival",
  "deletedJournal",
  "changedReceipt",
  "lostInspection",
  "replacedJournal",
])
  test(`release ${failure} retains uncertainty without automatic restart or retry`, async () => {
    const f = await fixture();
    try {
      const owner = f.make();
      if (failure === "lostStop") f.flags.lostStop = true;
      if (failure === "retained") f.flags.retained = 1;
      if (failure === "incomingArrival")
        f.flags.afterStop = () => {
          f.line.current_call_id = "late-incoming";
        };
      if (failure === "deletedJournal")
        f.flags.afterStop = () => rmSync(f.initialJournal);
      if (failure === "changedReceipt")
        f.flags.afterStop = () =>
          writeFileSync(
            f.initialJournal,
            JSON.stringify({ ...f.journal, receipts: {} }),
          );
      if (failure === "lostInspection")
        f.flags.afterStop = () => {
          f.flags.lostInspection = true;
        };
      if (failure === "replacedJournal")
        f.flags.afterStop = () => {
          const bytes = readFileSync(f.initialJournal);
          renameSync(f.initialJournal, f.initialJournal + ".old");
          writeFileSync(f.initialJournal, bytes, { mode: 0o600 });
        };
      await assert.rejects(owner.acquire("attempt-one"));
      assert.equal(owner.diagnostics().phase, "unknown");
      assert.equal((await owner.readiness()).ready, false);
      await assert.rejects(owner.acquire("attempt-one"));
      await assert.rejects(owner.restore("attempt-one"));
      assert.equal(f.stops(), 1);
      assert.equal(f.starts(), 0);
      const reopened = f.make();
      assert.equal(reopened.diagnostics().phase, "unknown");
      assert.equal((await reopened.readiness()).ready, false);
    } finally {
      await f.close();
    }
  });

test("concurrent acquire observations share the filesystem owner fence", async () => {
  const f = await fixture();
  try {
    const first = f.make(),
      second = f.make();
    const outcomes = await Promise.allSettled([
      first.acquire("attempt-one"),
      second.acquire("attempt-two"),
    ]);
    assert.equal(
      outcomes.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(f.stops(), 1);
    assert.equal(f.starts(), 0);
    assert.equal(f.make().diagnostics().phase, "outbound");
  } finally {
    await f.close();
  }
});

test("lost reacquisition response is retained despite an apparently connected replacement host", async () => {
  const f = await fixture();
  try {
    const owner = f.make();
    await owner.acquire("attempt-one");
    f.flags.lostStart = true;
    await assert.rejects(owner.restore("attempt-one"));
    assert.equal(f.starts(), 1);
    assert.equal(f.bindings.at(-1).connected, true);
    assert.equal(owner.diagnostics().phase, "unknown");
    await assert.rejects(owner.restore("attempt-one"));
    assert.equal(f.starts(), 1);
    const reopened = f.make();
    assert.equal((await reopened.readiness()).ready, false);
  } finally {
    await f.close();
  }
});

test("provider call arrival after outbound cleanup prevents incoming reacquisition", async () => {
  const f = await fixture();
  try {
    const owner = f.make();
    await owner.acquire("attempt-one");
    f.line.current_call_id = "incoming-during-gap";
    assert.equal(await owner.verify("attempt-one"), false);
    await assert.rejects(owner.restore("attempt-one"));
    assert.equal(f.starts(), 0);
    assert.equal(owner.diagnostics().phase, "unknown");
  } finally {
    await f.close();
  }
});

for (const phase of ["releasing", "restoring"])
  test(`restart during ${phase} does not replay the effect`, async () => {
    const f = await fixture();
    try {
      const owner = f.make();
      await owner.acquire("attempt-one");
      const receipt = JSON.parse(readFileSync(f.config.stateFile, "utf8"));
      receipt.phase = phase;
      writeFileSync(f.config.stateFile, JSON.stringify(receipt));
      const reopened = f.make();
      assert.equal(reopened.diagnostics().phase, "unknown");
      assert.equal((await reopened.readiness()).ready, false);
      await assert.rejects(reopened.acquire("attempt-one"));
      assert.equal(f.stops(), 1);
      assert.equal(f.starts(), 0);
    } finally {
      await f.close();
    }
  });

test("receipt loss after a clean release cannot qualify outbound verification or restoration", async () => {
  const f = await fixture();
  try {
    const owner = f.make();
    await owner.acquire("attempt-one");
    writeFileSync(
      f.initialJournal,
      JSON.stringify({ ...f.journal, receipts: {} }),
    );
    assert.equal(await owner.verify("attempt-one"), false);
    await assert.rejects(owner.restore("attempt-one"));
    assert.equal(f.starts(), 0);
  } finally {
    await f.close();
  }
});

test("restoration confirms the exact new incoming owner even if it immediately accepts a call", async () => {
  const f = await fixture();
  try {
    const owner = f.make(),
      original = readFileSync(f.initialJournal),
      inode = statSync(f.initialJournal).ino;
    await owner.acquire("attempt-one");
    f.flags.afterStart = (path, scope) => {
      const value = JSON.parse(readFileSync(path, "utf8"));
      value.entries.active = {
        owner: { ...scope, call_id: "new-incoming", request_id: "request-new" },
        call: {
          call_id: "new-incoming",
          request_id: "request-new",
          project_id: projectId,
          line_id: lineId,
        },
        events: [],
        authoritative_terminal: false,
        settled: false,
        cleanup: "pending",
      };
      writeFileSync(path, JSON.stringify(value));
      f.line.current_call_id = "new-incoming";
      f.line.worker_occupied = true;
      f.line.status = "busy";
    };
    assert.deepEqual(await owner.restore("attempt-one"), { confirmed: true });
    assert.equal(owner.diagnostics().phase, "incoming");
    assert.equal((await owner.readiness()).ready, false);
    assert.equal(f.starts(), 1);
    assert.deepEqual(readFileSync(f.initialJournal), original);
    assert.equal(statSync(f.initialJournal).ino, inode);
  } finally {
    await f.close();
  }
});

test("provider binding UUID alone cannot replace exact journal epoch and instance provenance", async () => {
  const f = await fixture();
  try {
    const owner = f.make();
    f.bindings[0].scope.instance_id = "different-current-instance";
    assert.equal((await owner.readiness()).ready, false);
    await assert.rejects(owner.acquire("attempt-one"));
    assert.equal(f.stops(), 0);
  } finally {
    await f.close();
  }
});

test("host process proof requires exact pane ancestry and rejects cycles or unrelated processes", async () => {
  const parents = new Map([
    [50, 40],
    [40, 30],
    [30, 20],
    [20, 1],
    [80, 90],
    [90, 80],
  ]);
  const parent = async (pid) => parents.get(pid) ?? 1;
  assert.equal(await hasProcessAncestor(50, 30, parent), true);
  assert.equal(await hasProcessAncestor(50, 80, parent), false);
  assert.equal(await hasProcessAncestor(80, 30, parent), false);
  assert.equal(await hasProcessAncestor(50, 1, parent), false);
});

test("probe retains restart uncertainty without writing the original owner record", async () => {
  const f = await fixture();
  try {
    const state = {
      version: 1,
      projectId,
      lineId,
      phase: "releasing",
      currentJournal: f.initialJournal,
      history: [],
    };
    writeFileSync(f.config.stateFile, JSON.stringify(state), { mode: 0o600 });
    const before = readFileSync(f.config.stateFile);
    const owner = f.make();
    assert.equal((await owner.readiness()).ready, false);
    assert.equal(owner.diagnostics().phase, "unknown");
    assert.deepEqual(readFileSync(f.config.stateFile), before);
    assert.equal(f.stops(), 0);
    assert.equal(f.starts(), 0);
  } finally {
    await f.close();
  }
});
