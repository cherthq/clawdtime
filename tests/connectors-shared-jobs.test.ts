import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, type JobFacts } from "../connectors/agents/jobs.js";
import { phoneTurn } from "../connectors/agents/phone-turn.js";
import { sharedJobCompletions } from "../connectors/shared/shared-job-completions.js";
const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0))
    rmSync(d, { recursive: true, force: true });
});
it("persists the shared task before launch and excludes the dedicated-owner enrollment hook", async () => {
  const root = mkdtempSync(join(tmpdir(), "shared-job-"));
  directories.push(root);
  const beforeLaunch = vi.fn();
  const binding = {
    taskId: "task-a",
    callId: "call-a",
    desktopInstanceId: "instance-a",
  };
  let jobs!: Jobs;
  jobs = new Jobs(root, {
    project: "/work/sample",
    beforeLaunch,
    run: async () => {
      expect(jobs.recent(1)[0]?.provenance?.sharedTask).toEqual(binding);
      return { status: 0, stdout: "" };
    },
  });
  await phoneTurn.run({ sharedTask: binding }, () =>
    jobs.start("Build a sample page"),
  );
  expect(beforeLaunch).not.toHaveBeenCalled();
  const id = jobs.recent(1)[0]!.id;
  const folder = join(root, "agents", "jobs", id);
  writeFileSync(
    join(folder, "launched.json"),
    JSON.stringify({ version: 1, pid: 123 }),
  );
  writeFileSync(join(folder, "result.md"), "The sample page is ready.");
  expect(sharedJobCompletions(jobs.recent(10), "instance-a")).toEqual([]);
  writeFileSync(
    join(folder, "exited.json"),
    JSON.stringify({ version: 1, exitCode: 0 }),
  );
  const completed = sharedJobCompletions(jobs.recent(10), "instance-a");
  expect(completed).toHaveLength(1);
  expect(completed[0]!.taskId).toBe("task-a");
  expect(sharedJobCompletions(jobs.recent(10), "replacement")).toEqual([]);
  expect(JSON.stringify(completed)).not.toContain("sample page");
});
it("groups exact launches and excludes an unfinished sibling or changed result", () => {
  const make = (id: string): JobFacts => ({
    id,
    job: "sample",
    startedAt: 1,
    done: true,
    status: "completed",
    result: "done",
    provenance: {
      version: 1,
      runId: id,
      launchId: id,
      projectRoot: "/work/sample",
      agent: "claude",
      launcherPid: 123,
      exitCode: 0,
      resultDigest: id,
      sharedTask: {
        taskId: "task",
        callId: "call",
        desktopInstanceId: "instance",
      },
    },
  });
  const a = make("a"),
    b = make("b");
  const expected = sharedJobCompletions([a, b], "instance");
  expect(sharedJobCompletions([b, a], "instance")).toEqual(expected);
  expect(sharedJobCompletions([a, { ...b, done: false }], "instance")).toEqual(
    [],
  );
  expect(
    sharedJobCompletions(
      [a, { ...b, provenance: { ...b.provenance!, resultDigest: "changed" } }],
      "instance",
    ),
  ).not.toEqual(expected);
});

it("opens only the exact completed result as inert text under a live lease", async () => {
  const { sharedWalkthrough } =
    await import("../connectors/shared/shared-walkthrough.js");
  const { readFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "shared-report-"));
  directories.push(root);
  const job: JobFacts = {
    id: "job",
    job: "sample",
    startedAt: 1,
    done: true,
    status: "completed",
    text: '<script>fetch("https://evil.example")</script>',
    result: "completed",
    provenance: {
      version: 1,
      runId: "run",
      launchId: "launch",
      projectRoot: "/work/sample",
      agent: "claude",
      launcherPid: 123,
      exitCode: 0,
      resultDigest: "digest",
      sharedTask: {
        taskId: "task",
        callId: "original",
        desktopInstanceId: "instance",
      },
    },
  };
  const binding = sharedJobCompletions([job], "instance")[0]!;
  const command = {
    id: "command",
    callId: "callback",
    connectionId: "connection",
    instanceId: "instance",
    deviceId: "device",
    expiresAt: Date.now() + 30000,
    operation: { action: "walkthrough" as const },
    walkthrough: binding,
  };
  const open = vi.fn(async (path: string) => {
    const html = readFileSync(path, "utf8");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("default-src 'none'");
  });
  const options = {
    command,
    instanceId: "instance",
    jobs: [job],
    directory: root,
    allowOpen: true,
    signal: new AbortController().signal,
    inspect: async () => ({ ok: true, expiresAt: Date.now() + 30000 }),
    open,
  };
  expect(
    (await sharedWalkthrough({ ...options, allowOpen: false })).walkthrough
      ?.opened,
  ).toBe(false);
  expect(open).not.toHaveBeenCalled();
  expect(
    (
      await sharedWalkthrough({
        ...options,
        command: { ...command, walkthrough: { ...binding, resultId: "wrong" } },
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await sharedWalkthrough({
        ...options,
        inspect: async () => ({ ok: false }),
      })
    ).ok,
  ).toBe(false);
  expect(open).not.toHaveBeenCalled();
  expect((await sharedWalkthrough(options)).walkthrough?.opened).toBe(true);
  expect((await sharedWalkthrough(options)).ok).toBe(false);
  expect(open).toHaveBeenCalledOnce();
});
