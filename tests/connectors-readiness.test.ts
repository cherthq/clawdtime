import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectInstallation } from "../cli/doctor.js";
import { installConfiguration } from "../cli/install.js";
import { acceptancePlan } from "../cli/live-plan.js";
import {
  canonicalProject,
  type Connection,
} from "../connectors/shared/state.js";
import {
  summarizeReadiness,
  requireAttentionReadiness,
} from "../connectors/shared/readiness.js";
const roots: string[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-readiness-"));
  roots.push(path);
  return canonicalProject(path);
}
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const now = 1_000_000;
const live = {
  mode: "live",
  pairing: { id: "fixture" },
  readiness: {
    mode: "live",
    checkedAt: now,
    liveReady: true,
    checks: [
      { id: "line_identity", status: "pass", message: "Exact line verified" },
      {
        id: "helper",
        status: "pass",
        message: "Paired helper and selected display ready",
      },
    ],
  },
};
it("does not convert pairing or legacy ready:true into live readiness", () => {
  const result = summarizeReadiness(
    { mode: "live", pairing: { id: "fixture" }, ready: true },
    [],
    now,
  );
  expect(result.liveReady).toBe(false);
  expect(result.status).toBe("blocked");
  expect(result.nextActions.join(" ")).toContain("preflight");
  expect(() =>
    requireAttentionReadiness(
      { mode: "live", pairing: { id: "fixture" }, ready: true },
      now,
    ),
  ).toThrow("no call was requested");
});
it("requires fresh complete backend evidence and no failed local checks", () => {
  expect(summarizeReadiness(live, [], now).liveReady).toBe(true);
  expect(summarizeReadiness(live, [], now + 30_001).liveReady).toBe(false);
  expect(
    summarizeReadiness(
      { ...live, readiness: { ...live.readiness, checkedAt: now + 6_000 } },
      [],
      now,
    ).liveReady,
  ).toBe(false);
  expect(
    summarizeReadiness(
      live,
      [{ id: "config", status: "fail", message: "Missing" }],
      now,
    ).liveReady,
  ).toBe(false);
  expect(
    summarizeReadiness(
      { ...live, readiness: { ...live.readiness, checks: [] } },
      [],
      now,
    ).liveReady,
  ).toBe(false);
  expect(
    summarizeReadiness(
      {
        ...live,
        readiness: {
          ...live.readiness,
          checks: [
            {
              id: "helper",
              status: "unknown",
              message: "No live helper observation",
              nextAction: "Enable the companion locally.",
            },
          ],
        },
      },
      [],
      now,
    ).nextActions,
  ).toContain("Enable the companion locally.");
});
it("labels simulation explicitly and never treats technical readiness as physical acceptance", () => {
  const value = { mode: "simulation", pairing: { id: "fixture" }, ready: true };
  expect(requireAttentionReadiness(value, now).status).toBe("simulation_only");
  expect(summarizeReadiness(value, [], now).liveReady).toBe(false);
  expect(
    summarizeReadiness({ ...live, physicalAcceptance: true }, [], now)
      .physicalAcceptance,
  ).toBe(false);
});
it("detects changed local MCP configuration even when its file still exists", () => {
  const project = root(),
    connectionFile = join(root(), "connection.json");
  const connection = {
    schemaVersion: 1,
    baseUrl: "http://127.0.0.1:3310",
    pairing: { id: "fixture" },
    token: "test-only-token",
    adapter: "codex",
    adapterVersion: "codex test",
    projectRoot: project,
    hostId: "fixture",
  } as Connection;
  const executable = join(root(), "clawdtime.js");
  writeFileSync(executable, "// test fixture\n");
  const installed = installConfiguration(
    connection,
    connectionFile,
    executable,
    "reviewed skill",
  );
  expect(
    inspectInstallation(installed, "codex test").every(
      (c) => c.status === "pass",
    ),
  ).toBe(true);
  writeFileSync(
    installed.installed!.configPath,
    "# retained unrelated configuration\n",
  );
  expect(
    inspectInstallation(installed, "codex test").find(
      (c) => c.id === "mcp_configuration",
    )?.status,
  ).toBe("fail");
  expect(
    inspectInstallation(installed, "new version").find(
      (c) => c.id === "agent_client_version",
    )?.status,
  ).toBe("unknown");
  expect(readFileSync(installed.installed!.configPath, "utf8")).toBe(
    "# retained unrelated configuration\n",
  );
});
it("prepares a stable inert acceptance case without credentials or native approval overrides", () => {
  const project = root(),
    output = join(root(), "case.json"),
    options = {
      caseId: "screen-feedback",
      adapter: "codex" as const,
      projectRoot: project,
      executable: "/build/cli.js",
      output,
      readiness: summarizeReadiness(
        { mode: "simulation", pairing: { id: "fixture" } },
        [],
        now,
      ),
    };
  const first = acceptancePlan(options),
    second = acceptancePlan(options);
  expect(second.runId).toBe(first.runId);
  expect(second.idempotencyKey).toBe(first.idempotencyKey);
  expect(first.automaticEffects).toBe(false);
  expect(first.launch.args).toContain("run");
  expect(first.launch.args).not.toContain(
    "--dangerously-bypass-approvals-and-sandbox",
  );
  expect(first.prompt).toContain("readiness.liveReady is true");
  expect(first.prompt).toContain(first.runId);
  expect(first.prompt).toContain("resume_agent");
  expect(readFileSync(`${output}.prompt.txt`, "utf8")).toContain(
    "native approval",
  );
  expect(() => acceptancePlan({ ...options, adapter: "claude-code" })).toThrow(
    "another case",
  );
});
