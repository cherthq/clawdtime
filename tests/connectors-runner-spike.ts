/** Opt-in real model execution. No calls/UI, only a disposable synthetic fixture. */
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { CodexAppServerRunner } from "../connectors/codex/runner.js";
import type { RunnerRequest } from "../src/contracts.js";

const project = await mkdtemp(join(tmpdir(), "clawdtime-managed-runner-"));
const version = spawnSync("codex", ["--version"], {
  encoding: "utf8",
}).stdout.trim();
const runner = new CodexAppServerRunner({
  enabled: true,
  projectRoots: [project],
  version,
  timeoutMs: 90_000,
});
const at = performance.now();
const events: Array<{ type: string; stage?: string; elapsedMs: number }> = [];
try {
  await writeFile(
    join(project, "input.json"),
    JSON.stringify({ values: [17, 25, 8] }),
  );
  const input: RunnerRequest = {
    projectRoot: project,
    externalSessionId: "synthetic-managed-proof",
    job: {
      version: 1,
      id: "proof",
      sessionId: "proof-session",
      pairingId: "proof-pairing",
      memberId: "proof-member",
      source: { channel: "text", eventId: "proof-event" },
      runnerId: "codex-app-server",
      revision: 1,
      instructionSequence: 1,
      kind: "file",
      preference: "auto",
      state: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dispatchId: "proof-dispatch",
    },
    intent: {
      kind: "file",
      preference: "auto",
      instruction:
        "Read input.json, sum the values, and write result.txt containing exactly the decimal sum followed by a newline. Use only local file/shell tools inside this disposable fixture; no networks, MCP, apps, desktop, background processes, or other files. This is an execution qualification, not a phone call.",
      verification: {
        kind: "file_contains",
        path: "result.txt",
        expected: "50\n",
      },
    },
  };
  const result = await runner.run(
    input,
    (e) => events.push({ ...e, elapsedMs: Math.round(performance.now() - at) }),
    new AbortController().signal,
  );
  const exactFile = await readFile(join(project, "result.txt"), "utf8").catch(
    () => "",
  );
  const verified = result.outcome === "succeeded" && exactFile === "50\n";
  console.log(
    JSON.stringify(
      {
        version,
        host: "codex_app_server",
        session: "explicit_api_managed",
        nativeControl: "none",
        verification: "independent_exact_fixture_file",
        verified,
        outcome: result.outcome,
        events,
        elapsedMs: Math.round(performance.now() - at),
      },
      null,
      2,
    ),
  );
  process.exitCode = verified ? 0 : 1;
} finally {
  runner.close();
  await rm(project, { recursive: true, force: true });
}
