/**
 * The evals hold the process open while a model call waits to try again.
 *
 * The retry wait of a model call runs on an unreferenced timer
 * (`realSleep` in model-call.ts), so that it never keeps the desktop service
 * alive on its own. An eval is a plain script with nothing else open while
 * it waits for the model. A 429 or 503 with a retry-after then ended the
 * run at once, with an unsettled top-level await (exit code 13), in the
 * middle of the cases (26 and 28 Nov 2026, two Gemini models).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Runs a short module in a new Node process with tsx: its exit code and output. */
const run = (code: string) =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );

describe("the evals hold the process open during a retry wait", () => {
  it("without a hold, the retry wait alone ends the process with exit code 13", () => {
    const done = run(
      `import { realSleep } from "./connectors/computer/model-call.ts";
       await realSleep(50);
       console.log("settled");`,
    );
    expect(done.status).toBe(13);
    expect(done.stdout).not.toContain("settled");
  });

  it("with holdOpen, the wait ends and the process goes on", () => {
    const done = run(
      `import { realSleep } from "./connectors/computer/model-call.ts";
       import { holdOpen } from "./tests/computer-eval-report.ts";
       const release = holdOpen();
       await realSleep(50);
       release();
       console.log("settled");`,
    );
    expect(done.status).toBe(0);
    expect(done.stdout).toContain("settled");
  });

  it("after release, nothing more holds the process", () => {
    const done = run(
      `import { holdOpen } from "./tests/computer-eval-report.ts";
       holdOpen()();
       console.log("released");`,
    );
    expect(done.status).toBe(0);
    expect(done.stdout).toContain("released");
  });
});
