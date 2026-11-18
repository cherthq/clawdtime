import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTaskVerification } from "../src/control/task-verification.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "clawdtime-check-test-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function nodeCheck(code: string, timeoutMs = 2000) {
  return {
    name: "Synthetic check",
    command: [process.execPath, "-e", code],
    timeoutMs,
  };
}

describe("independent verifier subprocess boundary", () => {
  it("observes exit status, discards raw output and retains bounded evidence", async () => {
    const directory = fixture();
    const report = await runTaskVerification(
      directory,
      "run-one",
      [
        nodeCheck("console.log('synthetic-private-output'); process.exit(0)"),
        nodeCheck("console.error('synthetic-private-error'); process.exit(7)"),
      ],
      new AbortController().signal,
    );
    expect(report.state).toBe("failed");
    expect(report.checks.map((check) => [check.state, check.exitCode])).toEqual(
      [
        ["passed", 0],
        ["failed", 7],
      ],
    );
    // Commands are operator-approved plan metadata; their literal code is not output redaction evidence.
    expect(report.checks.map((check) => check.summary).join(" ")).not.toContain(
      "synthetic-private",
    );
    expect(report.checks[0]!.summary).toMatch(/SHA-256=[a-f0-9]{64}/);
  });

  it("uses selected cwd, isolated HOME and no inherited secret variables", async () => {
    const directory = fixture();
    const key = "CLAWDTIME_VERIFICATION_SYNTHETIC_SECRET";
    const old = process.env[key];
    process.env[key] = "synthetic-not-a-credential";
    cleanup.push(() => {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    });
    const code = `const fs = require('node:fs'); fs.writeFileSync('environment.json', JSON.stringify({cwd: process.cwd(), home: process.env.HOME, secret: process.env.${key}, ci: process.env.CI}));`;
    const report = await runTaskVerification(
      directory,
      "run-one",
      [nodeCheck(code)],
      new AbortController().signal,
    );
    expect(report.state).toBe("passed");
    const observed = JSON.parse(
      readFileSync(join(directory, "environment.json"), "utf8"),
    );
    expect(observed).toMatchObject({ cwd: realpathSync(directory), ci: "1" });
    expect(observed.secret).toBeUndefined();
    expect(observed.home).not.toBe(process.env.HOME);
    expect(existsSync(observed.home)).toBe(false);
  });

  it("does not interpret shell operators in argv", async () => {
    const directory = fixture();
    const code =
      "require('node:fs').writeFileSync('argument.json', JSON.stringify(process.argv[1]));";
    const argument = "; touch must-not-exist; $(echo injected)";
    const report = await runTaskVerification(
      directory,
      "run-one",
      [
        {
          name: "Literal argv",
          command: [process.execPath, "-e", code, argument],
        },
      ],
      new AbortController().signal,
    );
    expect(report.state).toBe("passed");
    expect(
      JSON.parse(readFileSync(join(directory, "argument.json"), "utf8")),
    ).toBe(argument);
    expect(existsSync(join(directory, "must-not-exist"))).toBe(false);
  });

  it("marks missing executable and missing working directory blocked", async () => {
    const directory = fixture();
    for (const [cwd, command] of [
      [directory, [join(directory, "missing-executable")]],
      [
        join(directory, "missing-directory"),
        [process.execPath, "-e", "process.exit(0)"],
      ],
    ] as const) {
      const report = await runTaskVerification(
        cwd,
        "run-one",
        [{ name: "Unavailable check", command: [...command] }],
        new AbortController().signal,
      );
      expect(report.state).toBe("blocked");
      expect(report.checks[0]!.exitCode).toBeNull();
    }
  });

  it("never dispatches after cancellation or failed authority", async () => {
    const directory = fixture();
    const plan = [
      nodeCheck("require('node:fs').writeFileSync('must-not-exist', 'effect')"),
    ];
    const controller = new AbortController();
    controller.abort();
    expect(
      (await runTaskVerification(directory, "run-one", plan, controller.signal))
        .state,
    ).toBe("blocked");
    expect(
      (
        await runTaskVerification(
          directory,
          "run-one",
          plan,
          new AbortController().signal,
          () => {
            throw new Error("revoked");
          },
        )
      ).state,
    ).toBe("blocked");
    expect(existsSync(join(directory, "must-not-exist"))).toBe(false);
  });

  it("kills a timeout process group without allowing delayed child writes", async () => {
    const directory = fixture();
    const descendant =
      "setTimeout(() => require('node:fs').writeFileSync('must-not-exist', 'effect'), 550); setInterval(() => {}, 1000);";
    const code = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'ignore'}); setInterval(() => {}, 1000);`;
    const report = await runTaskVerification(
      directory,
      "run-one",
      [nodeCheck(code, 100)],
      new AbortController().signal,
    );
    expect(["blocked", "unknown"]).toContain(report.state);
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(existsSync(join(directory, "must-not-exist"))).toBe(false);
  });

  it("does not claim a zero-exit parent proves its remaining child group stopped", async () => {
    const directory = fixture();
    const descendant =
      "setTimeout(() => require('node:fs').writeFileSync('must-not-exist', 'effect'), 550); setInterval(() => {}, 1000);";
    const code = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'ignore'}); setTimeout(() => process.exit(0), 80);`;
    const report = await runTaskVerification(
      directory,
      "run-one",
      [nodeCheck(code)],
      new AbortController().signal,
    );
    expect(report.state).toBe("unknown");
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(existsSync(join(directory, "must-not-exist"))).toBe(false);
  });

  it("treats output overflow as blocked even when the command would exit zero", async () => {
    const directory = fixture();
    const report = await runTaskVerification(
      directory,
      "run-one",
      [
        nodeCheck(
          "process.stdout.write('x'.repeat(2*1024*1024)); setTimeout(() => process.exit(0), 300)",
        ),
      ],
      new AbortController().signal,
    );
    expect(report.state).toBe("blocked");
    expect(report.checks[0]!.summary).toContain("output limit exceeded");
    expect(report.checks[0]!.summary.length).toBeLessThan(250);
  });

  it("requires a nonempty valid complete plan before dispatching any check", async () => {
    const directory = fixture();
    await expect(
      runTaskVerification(
        directory,
        "run-one",
        [],
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    await expect(
      runTaskVerification(
        directory,
        "run-one",
        [
          nodeCheck(
            "require('node:fs').writeFileSync('must-not-exist', 'effect')",
          ),
          { name: "Invalid later check", command: [] },
        ],
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(existsSync(join(directory, "must-not-exist"))).toBe(false);
  });
});
