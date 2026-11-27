import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  saveSharedPairing,
  sharedConnectionLock,
  sharedPairingPaths,
} from "../src/onboard/pairing.js";
import { processLockHolder } from "../src/process-lock.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A coordinator origin on 127.0.0.1 that takes each connection and never
 * answers it: the connection waits, as on a slow network.
 */
async function silentCoordinator() {
  let connects = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    connects++;
    sockets.add(socket);
    socket.on("error", () => {});
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  return {
    origin: `https://127.0.0.1:${address.port}`,
    connects: () => connects,
  };
}

/** A made-up paired Mac with a desktop whose process is this test. */
function pairedMac(origin: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-owner-")));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const { directory, file } = sharedPairingPaths(home);
  saveSharedPairing(directory, file, {
    origin,
    credential: "made-up-device-credential-".repeat(3),
    deviceId: "device_madeup",
    displayId: "1",
    allowView: false,
    allowControl: false,
    walkthroughReports: false,
  });
  const state = join(home, "desktop");
  mkdirSync(state, { mode: 0o700 });
  const write = (name: string, value: unknown) =>
    writeFileSync(join(state, name), JSON.stringify(value), { mode: 0o600 });
  const fingerprint = "a".repeat(64);
  write("owner.lock", { pid: process.pid });
  write("desktop-service.json", {
    version: 1,
    instanceId: "instance_madeup",
    pid: process.pid,
    origin: "http://127.0.0.1:9",
    configurationFingerprint: fingerprint,
  });
  write("desktop-panel.json", {
    version: 1,
    origin: "http://127.0.0.1:9",
    token: "made-up-panel-token-".repeat(3),
    configurationFingerprint: fingerprint,
  });
  return { home, state };
}

/**
 * An owner process (as the app is) that starts `shared run` and prints its
 * process id. The test then kills the owner, as a crash of the app does.
 */
async function ownedRun(home: string, state: string, args: string[]) {
  const owner = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const run = spawn(process.execPath, ["--import", "tsx", ${JSON.stringify(resolve("cli/main.ts"))}, "shared", "run", ...${JSON.stringify(args)}], { stdio: "ignore", cwd: ${JSON.stringify(resolve("."))} });
       console.log("RUN " + run.pid);
       setInterval(() => {}, 1000);`,
    ],
    {
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CLAWDTIME_DESKTOP_STATE: state,
        VITEST: "true",
      },
    },
  );
  cleanup.push(() => {
    owner.kill("SIGKILL");
  });
  const run = await new Promise<number>((done) =>
    owner.stdout.on("data", (chunk: Buffer) => {
      const found = /RUN (\d+)/.exec(chunk.toString());
      if (found) done(Number(found[1]));
    }),
  );
  cleanup.push(() => {
    if (alive(run)) process.kill(run, "SIGKILL");
  });
  return { owner, run };
}

const until = async (check: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 50));
  return check();
};

it("a shared run under an owner disconnects and frees the lock when the owner is gone", async () => {
  const coordinator = await silentCoordinator();
  const { home, state } = pairedMac(coordinator.origin);
  const { owner, run } = await ownedRun(home, state, ["--owned"]);
  expect(await until(() => coordinator.connects() > 0, 20_000)).toBe(true);
  expect(processLockHolder(sharedConnectionLock(home))).not.toBeNull();
  // The app crashes.
  owner.kill("SIGKILL");
  expect(await until(() => !alive(run), 5000)).toBe(true);
  expect(processLockHolder(sharedConnectionLock(home))).toBeNull();
}, 40_000);

it("a shared run with no owner keeps its connection when the program that started it ends", async () => {
  const coordinator = await silentCoordinator();
  const { home, state } = pairedMac(coordinator.origin);
  const { owner, run } = await ownedRun(home, state, []);
  expect(await until(() => coordinator.connects() > 0, 20_000)).toBe(true);
  // Terminal setup starts its background connection and leaves.
  owner.kill("SIGKILL");
  await new Promise((done) => setTimeout(done, 2000));
  expect(alive(run)).toBe(true);
  expect(processLockHolder(sharedConnectionLock(home))).not.toBeNull();
}, 40_000);
