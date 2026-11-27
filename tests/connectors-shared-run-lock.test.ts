import { spawn } from "node:child_process";
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
import { takeProcessLock } from "../src/process-lock.js";

const folders: string[] = [];
afterEach(() => {
  while (folders.length)
    rmSync(folders.pop()!, { recursive: true, force: true });
});

/** A made-up paired Mac with a desktop whose process is this test. */
function pairedMac() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-run-lock-")));
  folders.push(home);
  const { directory, file } = sharedPairingPaths(home);
  saveSharedPairing(directory, file, {
    // A closed port on this Mac: nothing is reached.
    origin: "http://127.0.0.1:9",
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

function sharedRun(home: string, state: string) {
  return new Promise<{ code: number | null; stderr: string }>((done) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("cli/main.ts"), "shared", "run"],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CLAWDTIME_DESKTOP_STATE: state,
          VITEST: "true",
        },
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      done({ code, stderr });
    });
  });
}

it("refuses a second shared run while one connection holds this Mac", async () => {
  const { home, state } = pairedMac();
  const first = takeProcessLock(sharedConnectionLock(home), {
    version: 1,
    pid: process.pid,
    instanceId: "instance_madeup",
  });
  expect(first).not.toBeNull();
  try {
    const second = await sharedRun(home, state);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain(
      "Another clawdtime shared run connects this Mac already. Only one connection runs at a time.",
    );
  } finally {
    first!.release();
  }
}, 30_000);
