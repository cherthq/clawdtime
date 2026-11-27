import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { macPorts } from "../src/onboard/system.js";

const folders: string[] = [];
afterEach(() => {
  while (folders.length)
    rmSync(folders.pop()!, { recursive: true, force: true });
});

/** One release runtime in the folder of versions, as the installer makes it. */
function install(runtimes: string, version: string) {
  const native = join(runtimes, version, "app", "native");
  mkdirSync(native, { recursive: true });
  writeFileSync(join(runtimes, version, "manifest.json"), "{}");
  for (const name of ["ClawdTimeTaskPanel", "ClawdTimeTaskCapture"]) {
    writeFileSync(join(native, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(native, name), 0o755);
  }
  symlinkSync(version, join(runtimes, ".current.next"));
  renameSync(join(runtimes, ".current.next"), join(runtimes, "current"));
}

it("pairing saves the capture helper through the current link, so the pairing outlives two updates", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-runtime-")));
  folders.push(base);
  const runtimes = join(base, "ClawdTime", "runtime");
  install(runtimes, "0.4.0");
  // The command runs from the real folder of its version, as Node resolves it.
  const ports = macPorts({
    env: {},
    home: base,
    root: realpathSync(join(runtimes, "current", "app")),
    command: { executable: process.execPath, args: [] },
    startDesktop: async () => {},
  });
  const saved = ports.displays.capture();
  expect(saved).toBe(
    join(runtimes, "current", "app", "native", "ClawdTimeTaskCapture"),
  );
  // Two updates: the second one removes the version that pairing ran from.
  install(runtimes, "0.4.1");
  install(runtimes, "0.4.2");
  rmSync(join(runtimes, "0.4.0"), { recursive: true });
  expect(existsSync(saved!)).toBe(true);
});

it("keeps the path of a helper outside a release runtime", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-runtime-")));
  folders.push(base);
  const native = join(base, "checkout", "native");
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, "ClawdTimeTaskCapture"), "#!/bin/sh\n");
  chmodSync(join(native, "ClawdTimeTaskCapture"), 0o755);
  // A link named current that does not point at this folder changes nothing.
  symlinkSync(join(base, "elsewhere"), join(base, "current"));
  const ports = macPorts({
    env: {},
    home: base,
    root: join(base, "checkout"),
    command: { executable: process.execPath, args: [] },
    startDesktop: async () => {},
  });
  expect(ports.displays.capture()).toBe(join(native, "ClawdTimeTaskCapture"));
});
