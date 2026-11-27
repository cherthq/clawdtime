import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { desktopCli } from "../cli/task-desktop.js";
import { processLockHolder } from "../src/process-lock.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskService } from "../src/control/task-service.js";

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Synthetic port unavailable");
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}
async function closeOwned(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  let timeout: NodeJS.Timeout | undefined;
  const killed = new Promise<void>((done) => {
    timeout = setTimeout(() => {
      child.kill("SIGKILL");
      done();
    }, 5000);
  });
  await Promise.race([exited, killed]);
  if (timeout) clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) await exited;
}

it("real isolated simulation service survives panel exit and reattach with one owner and no duplicate task", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const temporary = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-desktop-process-")),
  );
  const project = join(temporary, "project"),
    state = join(temporary, "private"),
    panel = join(temporary, "fake-panel");
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  // This tiny test executable exits immediately. It opens no native UI.
  writeFileSync(panel, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const services: ChildProcess[] = [],
    panels: ChildProcess[] = [];
  const spawnOwned = ((command: string, args: string[], options: object) => {
    const child = spawn(command, args, options);
    (command === process.execPath ? services : panels).push(child);
    return child;
  }) as typeof spawn;
  const port = await unusedPort();
  const args = [
    "--state",
    state,
    "--project",
    project,
    "--port",
    String(port),
    "--panel-binary",
    panel,
  ];
  const open = () =>
    desktopCli(args, {
      root,
      spawn: spawnOwned,
      print: () => {},
      startupMs: 10000,
      pollMs: 50,
    });
  try {
    await open();
    expect(services).toHaveLength(1);
    expect(panels).toHaveLength(1);
    const owner = JSON.parse(readFileSync(join(state, "owner.lock"), "utf8"));
    expect(owner.pid).toBe(services[0]!.pid);
    const configuration = JSON.parse(
      readFileSync(join(state, "desktop-panel.json"), "utf8"),
    );
    const headers = {
      authorization: `Bearer ${configuration.token}`,
      "content-type": "application/json",
    };
    const origin = `http://127.0.0.1:${port}`;
    const read = async () => {
      const response = await fetch(`${origin}/desktop/state`, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(2000),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const initial = await read();
    expect(initial.worker).toBe("simulation");
    expect(initial.mode).toBe("simulation");
    expect(initial.task).toBeNull();
    expect(initial.controls).toMatchObject({
      sharingActive: false,
      callActive: false,
    });
    const submitted = await fetch(`${origin}/desktop/operations`, {
      method: "POST",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(2000),
      body: JSON.stringify({
        eventId: "synthetic_goal_once",
        action: "submit",
        goal: "Synthetic queued desktop task.",
      }),
    });
    expect(submitted.status).toBe(200);
    const task = (await read()).task;
    expect(task.state).toBe("queued");
    await open();
    expect(services).toHaveLength(1);
    expect(panels).toHaveLength(2);
    expect((await read()).task).toEqual(task);
    expect(
      JSON.parse(readFileSync(join(state, "owner.lock"), "utf8")).pid,
    ).toBe(owner.pid);
    expect(services[0]!.exitCode).toBeNull();
    expect(processLockHolder(join(state, "desktop-launch.lock"))).toBeNull();
    // Only this test's known child is stopped; closing either fake UI did not do so.
    await closeOwned(services[0]!);
    expect(existsSync(join(state, "owner.lock"))).toBe(false);
    await open();
    expect(services).toHaveLength(2);
    const restarted = await read();
    expect(restarted.desktopId).toBe(initial.desktopId);
    expect(restarted.instanceId).not.toBe(initial.instanceId);
    expect(restarted.task).toEqual(task); // No automatic run or submit on service restart.

    // Exercise the existing simulation lifecycle to model a service crash with
    // an admitted run. These credentials belong only to this disposable test.
    const binding = JSON.parse(
      readFileSync(join(state, "desktop-binding.json"), "utf8"),
    );
    const operator = JSON.parse(
      readFileSync(join(state, "operator.json"), "utf8"),
    );
    const registration = await fetch(`${origin}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${operator.token}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(2000),
      body: JSON.stringify({
        eventId: binding.registrationId,
        pairingId: "local-demo-pairing",
        hostId: "local-desktop",
        projectRoot: project,
        voice: false,
      }),
    });
    expect(registration.status).toBe(200);
    const session = await registration.json();
    const claimed = await fetch(`${origin}/tasks/${task.id}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.token}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(2000),
      body: JSON.stringify({
        eventId: "synthetic_claim_once",
        action: "claim_run",
        runId: task.runId,
        expectedRevision: task.revision,
      }),
    });
    expect(claimed.status).toBe(200);
    expect((await read()).task.state).toBe("running");
    await closeOwned(services[1]!);
    await open();
    expect(services).toHaveLength(3);
    const interrupted = await read();
    expect(interrupted.task.id).toBe(task.id);
    expect(interrupted.task.runId).toBe(task.runId);
    expect(interrupted.task.state).toBe("unknown");
    expect(interrupted.canSubmit).toBe(false);
  } finally {
    await Promise.all(services.map(closeOwned));
    await Promise.all(panels.map(closeOwned));
    rmSync(temporary, { recursive: true, force: true });
  }
}, 25000);

it("attaches a real isolated desktop service to an existing session without registration or renewal", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const temporary = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-desktop-attach-")),
  );
  const project = join(temporary, "project"),
    state = join(temporary, "private"),
    panel = join(temporary, "fake-panel");
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(panel, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const key = "ab".repeat(32),
    store = new Store(join(state, "tasks.sqlite")),
    vault = new Vault(key);
  store.put("pairing", {
    id: "synthetic-pair",
    memberId: "member",
    deviceId: "device",
    recipient: "synthetic",
    conversationId: "synthetic",
    lineId: "synthetic",
    displayId: "none",
    allowView: false,
    allowControl: false,
    createdAt: Date.now(),
  });
  const service = new TaskService(store, vault, new TaskLedger(store, vault), {
    projectRoots: [project],
    simulation: true,
  });
  const registered = service.register({
    eventId: "existing-session",
    pairingId: "synthetic-pair",
    hostId: "existing-host",
    projectRoot: project,
    voice: true,
  });
  const existingTask = service.create(registered.token, {
    eventId: "existing-task",
    goal: "Synthetic task from the existing session.",
  }).task;
  const expiry = registered.session.expiresAt;
  store.close();
  writeFileSync(
    join(state, "local-config.json"),
    JSON.stringify({
      key,
      operatorToken: "synthetic_operator_".repeat(4),
      projectRoot: project,
    }),
    { mode: 0o600 },
  );
  const sessionFile = join(state, "session.json");
  writeFileSync(
    sessionFile,
    JSON.stringify({
      version: 1,
      origin: "http://127.0.0.1:13320",
      sessionId: registered.session.id,
      token: registered.token,
    }),
    { mode: 0o600 },
  );
  const services: ChildProcess[] = [],
    panels: ChildProcess[] = [];
  const spawnOwned = ((command: string, args: string[], options: object) => {
    const child = spawn(command, args, options);
    (command === process.execPath ? services : panels).push(child);
    return child;
  }) as typeof spawn;
  const port = await unusedPort();
  const args = [
    "--state",
    state,
    "--project",
    project,
    "--port",
    String(port),
    "--panel-binary",
    panel,
    "--session-file",
    sessionFile,
  ];
  try {
    await desktopCli(args, {
      root,
      spawn: spawnOwned,
      print: () => {},
      startupMs: 10000,
      pollMs: 50,
    });
    const configuration = JSON.parse(
      readFileSync(join(state, "desktop-panel.json"), "utf8"),
    );
    expect(configuration.token).not.toBe(registered.token);
    const response = await fetch(`http://127.0.0.1:${port}/desktop/state`, {
      headers: { authorization: `Bearer ${configuration.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(200);
    const snapshot = await response.json();
    expect(snapshot.task.id).toBe(existingTask.id);
    expect(snapshot.task.runId).toBe(existingTask.runs[0]!.id);
    expect(snapshot.task.state).toBe("queued");
    expect(snapshot.sessionExpiresAt).toBe(expiry);
    await desktopCli(args, { root, spawn: spawnOwned, print: () => {} });
    expect(services).toHaveLength(1);
    await closeOwned(services[0]!);
    const finalStore = new Store(join(state, "tasks.sqlite"));
    try {
      expect(finalStore.all("task-session")).toHaveLength(1);
      const final = new TaskService(
        finalStore,
        vault,
        new TaskLedger(finalStore, vault),
        { projectRoots: [project], simulation: true },
      );
      expect(final.authenticate(registered.token)).toEqual(registered.session);
      expect(final.ledger.list(registered.session.id)).toHaveLength(1);
    } finally {
      finalStore.close();
    }
  } finally {
    await Promise.all(services.map(closeOwned));
    await Promise.all(panels.map(closeOwned));
    rmSync(temporary, { recursive: true, force: true });
  }
}, 20000);
