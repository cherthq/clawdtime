import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  findNativeHelper,
  nativeHelperCandidates,
} from "../src/native-helpers.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clawdtime-native-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const executable = (path: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
};

it("looks in the named folder, the release runtime, then the debug and release builds", () => {
  expect(
    nativeHelperCandidates("ClawdTimeTaskPanel", {
      root,
      env: { CLAWDTIME_NATIVE_DIR: "/opt/helpers" },
    }),
  ).toEqual([
    "/opt/helpers/ClawdTimeTaskPanel",
    join(root, "native/ClawdTimeTaskPanel"),
    join(root, "mac/.build/debug/ClawdTimeTaskPanel"),
    join(root, "mac/.build/release/ClawdTimeTaskPanel"),
  ]);
});

it("ignores a named folder that is not absolute", () => {
  expect(
    nativeHelperCandidates("ClawdTimeTaskCapture", {
      root,
      env: { CLAWDTIME_NATIVE_DIR: "helpers" },
    })[0],
  ).toBe(join(root, "native/ClawdTimeTaskCapture"));
});

it("finds a release runtime's helper before a source build", () => {
  executable(join(root, "mac/.build/debug/ClawdTimeTaskPanel"));
  const runtime = executable(join(root, "native/ClawdTimeTaskPanel"));
  expect(findNativeHelper("ClawdTimeTaskPanel", { root, env: {} })).toBe(
    runtime,
  );
});

it("finds a source build, and skips a file that cannot run", () => {
  writeFileSync(
    join(
      mkdirSync(join(root, "native"), { recursive: true })!,
      "ClawdTimeTaskCapture",
    ),
    "x",
  );
  const debug = executable(join(root, "mac/.build/debug/ClawdTimeTaskCapture"));
  expect(findNativeHelper("ClawdTimeTaskCapture", { root, env: {} })).toBe(
    debug,
  );
});

it("finds nothing when no helper is built", () => {
  expect(
    findNativeHelper("ClawdTimeTaskPanel", { root, env: {} }),
  ).toBeUndefined();
});
