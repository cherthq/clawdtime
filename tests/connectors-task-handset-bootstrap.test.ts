import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CodingTask,
  TaskCommand,
  TaskVoiceSession,
} from "../src/contracts.js";
import { Store } from "../src/storage/store.js";
import { Vault, hash } from "../src/storage/security.js";
import { ProtectedTaskStore } from "../src/storage/task-store.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskService } from "../src/control/task-service.js";

const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function fixture() {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-bootstrap-test-")),
  );
  directories.push(directory);
  const project = join(directory, "project"),
    state = join(directory, "state");
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  const put = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  const key = "ab".repeat(32),
    vault = new Vault(key);
  const database = join(state, "tasks.sqlite"),
    store = new Store(database);
  store.put("pairing", {
    id: "fixture-pair",
    memberId: "fixture-member",
    deviceId: "fixture-device",
    recipient: "fixture",
    conversationId: "fixture",
    lineId: "fixture",
    displayId: "none",
    allowView: false,
    allowControl: false,
    createdAt: Date.now(),
  });
  const ledger = new TaskLedger(store, vault);
  const tasks = new TaskService(store, vault, ledger, {
    projectRoots: [project],
    simulation: false,
  });
  const registered = tasks.register({
    eventId: "registration",
    pairingId: "fixture-pair",
    hostId: "fixture-host",
    projectRoot: project,
    voice: true,
  });
  const taskId = tasks.create(registered.token, {
    eventId: "submission",
    goal: "Synthetic bootstrap fixture.",
  }).task.id;
  const get = () => ledger.get(registered.session.id, taskId);
  let sequence = 0;
  const transition = (command: Record<string, unknown>) =>
    ledger.transition(registered.session.id, taskId, {
      eventId: `event-${++sequence}`,
      expectedRevision: get().revision,
      ...command,
    } as TaskCommand);
  const run = get().runs[0]!;
  transition({ action: "claim_run", runId: run.id });
  transition({
    action: "run_result",
    runId: run.id,
    dispatchId: run.dispatchId,
    outcome: "completed",
    summary: "Synthetic fixture prepared.",
  });
  transition({
    action: "verify_result",
    verification: {
      id: "verification",
      runId: run.id,
      completedAt: Date.now(),
      state: "passed",
      checks: [
        {
          name: "Synthetic bootstrap assertion",
          command: ["synthetic"],
          state: "passed",
          exitCode: 0,
          summary: "Fixture checked.",
        },
      ],
    },
  });
  const before = get();
  store.close();
  const savedPath = join(state, "local-config.json"),
    sessionFile = join(directory, "session.json");
  put(savedPath, {
    key,
    projectRoot: project,
    operatorToken: "synthetic-operator-token-12345678901234567890",
  });
  put(sessionFile, {
    version: 1,
    origin: "http://127.0.0.1:13323",
    sessionId: registered.session.id,
    token: registered.token,
  });
  const inspector = join(directory, "inspector.js");
  writeFileSync(
    inspector,
    "// Synthetic bundle; /usr/bin/false never executes it.\n",
    { mode: 0o600 },
  );
  const guard = join(directory, "no-network.mjs"),
    violation = join(directory, "network-violation");
  writeFileSync(
    guard,
    `import net from 'node:net';import fs from 'node:fs';
const refuse=()=>{fs.writeFileSync(${JSON.stringify(violation)},'attempted');throw Error('Network forbidden in bootstrap test');};
net.Socket.prototype.connect=refuse;net.Server.prototype.listen=refuse;globalThis.fetch=refuse;\n`,
    { mode: 0o600 },
  );
  const configPath = join(directory, "config.json");
  put(configPath, {
    stateDirectory: state,
    sessionFile,
    taskId,
    projectRoot: project,
    attemptDirectory: join(directory, "attempt"),
    providerFile: join(directory, "unused-provider.json"),
    livekitFile: join(directory, "unused-livekit.json"),
    inspectorBundle: inspector,
    python: "/usr/bin/false",
    native: {
      callsOrigin: "https://calls.invalid",
      projectId: "synthetic-project",
      projectKey: "synthetic-key-12345678901234567890",
      recipient: "+15550000001",
      lineId: "11111111-1111-4111-8111-111111111111",
    },
    destination: {
      pairingId: "synthetic-destination",
      memberId: "synthetic-member",
      deviceId: "synthetic-device",
      lineId: "11111111-1111-4111-8111-111111111111",
      recipientHash: hash("+15550000001"),
    },
    railway: {
      binary: "/usr/bin/false",
      projectId: "22222222-2222-4222-8222-222222222222",
      environmentId: "33333333-3333-4333-8333-333333333333",
      backendServiceId: "44444444-4444-4444-8444-444444444444",
      deploymentId: "55555555-5555-4555-8555-555555555555",
      restoreRecord: "synthetic-no-live-deployment",
    },
    authorization: {
      id: "synthetic-bootstrap-only",
      userAuthorizedOneCall: true,
    },
  });
  return {
    directory,
    state,
    savedPath,
    put,
    database,
    vault,
    before,
    configPath,
    guard,
    violation,
    registered,
  };
}
async function run(f: ReturnType<typeof fixture>) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      f.guard,
      resolve("scripts/task-handset.ts"),
      f.configPath,
    ],
    {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: f.directory,
        TMPDIR: f.directory,
        LANG: "C",
      },
    },
  );
  let output = "";
  child.stdout.on("data", (value) => {
    output += value;
  });
  child.stderr.on("data", (value) => {
    output += value;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform !== "win32" && child.pid)
      process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  }, 10000);
  const code = await new Promise<number | null>((done, reject) => {
    child.on("error", reject);
    child.on("close", done);
  }).finally(() => clearTimeout(timer));
  expect(timedOut).toBe(false);
  expect(code).toBe(1);
  expect(existsSync(f.violation)).toBe(false);
  expect(existsSync(join(f.state, "owner.lock"))).toBe(false);
  expect(output).toContain('"event":"setup_failed_before_call"');
  expect(output).toContain('"cleanupConfirmed":true');
  expect(output).not.toContain(f.registered.token);
  expect(output).not.toContain("synthetic-key-");
  return output;
}
function inspect(f: ReturnType<typeof fixture>) {
  const store = new Store(f.database);
  try {
    expect(
      new ProtectedTaskStore<CodingTask>(store, f.vault, "coding-task-v1").get(
        f.before.id,
      ),
    ).toEqual(f.before);
    expect(store.effects()).toEqual([]);
    expect(store.all("coding-task-audio-call-v1")).toEqual([]);
    return new ProtectedTaskStore<TaskVoiceSession>(
      store,
      f.vault,
      "coding-task-voice-v1",
    ).all();
  } finally {
    store.close();
  }
}

describe("handset runner provably undialed bootstrap cleanup", () => {
  it("ends the unused voice and releases ownership when the persistent inspector cannot start", async () => {
    const f = fixture();
    await run(f);
    const voices = inspect(f);
    expect(voices).toHaveLength(1);
    expect(voices[0]!.mode).toBe("handset_audio_smoke");
    expect(voices[0]!.endedAt).toEqual(expect.any(Number));
    expect(voices[0]!.providerConversationId).toBeUndefined();
  }, 15000);
  it("releases a newly owned lock when selected project validation fails", async () => {
    const f = fixture();
    const saved = JSON.parse(readFileSync(f.savedPath, "utf8"));
    f.put(f.savedPath, { ...saved, projectRoot: "/synthetic-wrong-project" });
    await run(f);
    expect(inspect(f)).toEqual([]);
  }, 15000);
});
