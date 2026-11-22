import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { ProactivePolicyAuthority } from "../src/attention/proactive-policy.js";
import { ProactiveCallCoordinator } from "../src/attention/proactive-coordinator.js";

// This reads executable modules from the trusted saved baseline. It never opens,
// copies or restores a production database; both versions use a new fixture DB.
const baseline = process.argv[2];
if (!baseline)
  throw Error("Pass the trusted saved baseline runtime directory.");
const load = (file: string) =>
  import(pathToFileURL(join(resolve(baseline), "dist", file)).href);
const [
  { Store: BaselineStore },
  { Vault: BaselineVault },
  { TaskLedger: BaselineLedger },
  { TaskService: BaselineTasks },
] = await Promise.all([
  load("src/storage/store.js"),
  load("src/storage/security.js"),
  load("src/attention/task-ledger.js"),
  load("src/control/task-service.js"),
]);
const directory = realpathSync(
  mkdtempSync(join(tmpdir(), "clawdtime-compatibility-")),
);
const database = join(directory, "synthetic.sqlite");
const key = "ab".repeat(32),
  clock = () => 1000;
let store: Store | undefined;
try {
  store = new Store(database);
  const vault = new Vault(key);
  store.put("pairing", {
    id: "fixture",
    memberId: "person",
    deviceId: "device",
    recipient: "fixture",
    lineId: "fixture",
    conversationId: "fixture",
    displayId: "none",
    allowView: false,
    allowControl: false,
    createdAt: 1000,
  });
  const taskOptions = { projectRoots: [directory], simulation: true };
  const tasks = new TaskService(
    store,
    vault,
    new TaskLedger(store, vault),
    taskOptions,
  );
  const session = tasks.register({
    eventId: "registration",
    pairingId: "fixture",
    hostId: "host",
    projectRoot: directory,
    voice: false,
  });
  const authority = new ProactivePolicyAuthority(store, vault, clock);
  authority.register({
    version: 2,
    id: "policy",
    scope: { personId: "person", deviceId: "device", projectRoot: directory },
    triggers: ["failure"],
    channels: ["phone_alert"],
    expiresAt: 100000,
    maxAttempts: 2,
    minIntervalMs: 0,
    attemptLifetimeMs: 10000,
    viewScope: [],
    alertFallback: false,
    consent: {
      actorId: "person",
      recordedAt: 1000,
      source: "operator",
      statement: "Synthetic phone permission.",
    },
  });
  const coordinator = new ProactiveCallCoordinator(
    store,
    vault,
    authority,
    clock,
  );
  const { record } = coordinator.enqueue({
    source: {
      kind: "session",
      sessionId: "session",
      runId: "run",
      enrollmentId: "enrollment",
    },
    scope: {
      personId: "person",
      deviceId: "device",
      projectRoot: directory,
      sessionId: "session",
    },
    policyId: "policy",
    trigger: "failure",
    channel: "phone_alert",
    expiresAt: 100000,
    brief: "Synthetic failure.",
  });
  coordinator.prepare(record.id);
  coordinator.ready(record.id, "cd".repeat(32));
  const { grant } = coordinator.reserve(record.id, {
    sourceCurrent: true,
    lineAvailable: true,
    packetFingerprint: "cd".repeat(32),
  });
  assert(grant);
  coordinator.transport.reserve(record.id, grant.attemptId, "dial");
  coordinator.transport.unknown(grant.attemptId, "dial");
  coordinator.outcome(record.id, grant.attemptId, "unknown", {
    reason: "synthetic_response_lost",
  });
  store.saveState("synthetic-cursor", { cursor: 42 });
  const snapshot = () =>
    store!.query("SELECT kind,id,body FROM entities ORDER BY kind,id");
  const before = snapshot();
  store.close();
  store = undefined;
  const old = new BaselineStore(database);
  try {
    const oldVault = new BaselineVault(key);
    const oldTasks = new BaselineTasks(
      old,
      oldVault,
      new BaselineLedger(old, oldVault),
      taskOptions,
    );
    assert.equal(oldTasks.authenticate(session.token).projectRoot, directory);
    assert.deepEqual(old.state("synthetic-cursor"), { cursor: 42 });
    assert.deepEqual(
      old.query("SELECT kind,id,body FROM entities ORDER BY kind,id"),
      before,
    );
    assert.deepEqual(old.effects(), []);
  } finally {
    old.close();
  }
  store = new Store(database);
  const reopened = new ProactiveCallCoordinator(
    store,
    vault,
    new ProactivePolicyAuthority(store, vault, clock),
    clock,
  );
  assert.equal(reopened.get(record.id).state, "unknown");
  assert.equal(reopened.transport.list(grant.attemptId)[0]?.state, "unknown");
  assert.deepEqual(store.state("synthetic-cursor"), { cursor: 42 });
  assert.deepEqual(snapshot(), before);
  console.log(
    "PASS: saved baseline reads the synthetic upgraded store; encrypted records, unknown dispatch, transport receipt and cursor survive baseline/current reopen unchanged.",
  );
} finally {
  store?.close();
  rmSync(directory, { recursive: true, force: true });
}
