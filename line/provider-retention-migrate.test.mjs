import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateRetention } from "./provider-retention-migrate.mjs";
import { RETENTION_PIN } from "./provider-retention.mjs";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

const pid = 4242;
const expected = {
  pid,
  startedAt: "Thu Nov 26 10:00:00 2026",
  execPath: "/fixture/node",
  commandHash: "command-fixture",
  providerRoot: "/fixture/provider",
  configHash: "config-fixture",
};

/**
 * The process of chert dev, as the migration sees it: SIGUSR1 opens its
 * debugger on the port, and the deferred inspector.close() of an evaluation
 * closes it. Nothing here signals or connects to a real process.
 */
function target(options = {}) {
  const state = { open: false, connects: 0, closes: 0 };
  let closeFailures = options.closeFailures ?? 0;
  let lateReads = options.lateReads ?? 0;
  const parts = {
    describe: () => expected,
    signal: (to) => {
      assert.equal(to, pid);
      state.open = true;
    },
    listeners: () =>
      state.open ? [options.otherListener ? pid + 1 : pid] : [],
    unusedPort: async () => {
      if (state.open) throw Error("retention_inspector_port_occupied");
    },
    // The debugger may answer late: the first reads of its targets fail.
    targets: async () => {
      if (lateReads-- > 0) throw Error("fetch failed");
      return [{ webSocketDebuggerUrl: "ws://127.0.0.1:9229/0f0e-ab12" }];
    },
    connect: async () => {
      state.connects++;
      return {
        evaluate: async (expression) => {
          if (expression.includes("m.close()")) {
            if (closeFailures > 0) {
              closeFailures--;
              throw Error("retention_inspector_timeout");
            }
            state.closes++;
            state.open = false;
            return { closing: true };
          }
          if (expression.startsWith("({pid:process.pid")) {
            if (options.firstAnswer === "timeout")
              throw Error("retention_inspector_timeout");
            return {
              pid,
              execPath: expected.execPath,
              version: RETENTION_PIN.nodeVersion,
              argv: ["node", "/fixture/provider/dist/src/cli/main.js", "dev"],
              debugPort: 9229,
            };
          }
          if (options.installFails)
            throw Error("retention_inspector_evaluation_failed");
          return { pid, capability: "clawdtime-retention-v1" };
        },
        close: () => {},
      };
    },
    identity: () => ({ pid, startedAt: expected.startedAt }),
    config: () => ({ providerRoot: expected.providerRoot }),
    evidence: () => ({}),
    realpath: (path) => path,
    pause: async () => {},
  };
  return { state, parts };
}

function withExpected(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-migrate-")));
  chmodSync(root, 0o700);
  const file = join(root, "expected.json");
  writeFileSync(file, JSON.stringify(expected), { mode: 0o600 });
  return run(file).finally(() =>
    rmSync(root, { recursive: true, force: true }),
  );
}

test("migrate installs the guard and closes the debugger it opened", () =>
  withExpected(async (file) => {
    const t = target();
    assert.deepEqual(
      await migrateRetention("/fixture/config.json", file, t.parts),
      {
        installed: true,
        inspectorClosed: true,
        pid,
      },
    );
    assert.equal(t.state.open, false);
  }));

for (const [name, options, failure] of [
  [
    "its debugger answers too late",
    { lateReads: 30 },
    /retention_inspector_not_ready/,
  ],
  [
    "the first evaluation gets no answer",
    { firstAnswer: "timeout" },
    /retention_inspector_timeout/,
  ],
  [
    "the close gets no answer once",
    { installFails: true, closeFailures: 1 },
    /retention_inspector_evaluation_failed/,
  ],
])
  test(`migrate closes the debugger it opened when ${name}`, () =>
    withExpected(async (file) => {
      const t = target(options);
      await assert.rejects(
        migrateRetention("/fixture/config.json", file, t.parts),
        failure,
      );
      assert.equal(t.state.open, false);
    }));

test("migrate never closes a debugger of another process", () =>
  withExpected(async (file) => {
    const t = target({ otherListener: true });
    await assert.rejects(
      migrateRetention("/fixture/config.json", file, t.parts),
      /retention_inspector_close_unconfirmed/,
    );
    assert.equal(t.state.connects, 0);
    assert.equal(t.state.closes, 0);
  }));
