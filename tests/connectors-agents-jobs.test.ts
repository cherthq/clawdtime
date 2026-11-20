import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsCli } from "../cli/agents.js";
import {
  Supervisor,
  type ModelClient,
  type SupervisorWorld,
  type ToolCall,
  type ToolSpec,
} from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import type { Runner } from "../connectors/agents/focus.js";
import {
  Jobs,
  type JobFacts,
  type JobPort,
} from "../connectors/agents/jobs.js";
import type { BoardSnapshot } from "../connectors/agents/types.js";
import { fakeSystem } from "./connectors-agents-fixture.js";

const now = Date.UTC(2026, 10, 21, 1, 0, 0);
const root = () => mkdtempSync(join(tmpdir(), "clawdtime-jobs-"));
function recorder(status = 0) {
  const calls: string[][] = [];
  const run: Runner = async (command, args) => {
    calls.push([command, ...args]);
    return { status, stdout: "" };
  };
  return { calls, run };
}
const mode = (file: string) => statSync(file).mode & 0o777;

describe("a job for a coding session", () => {
  it("puts the job in a file, opens a terminal on a script that holds only paths, and keeps both for the owner", async () => {
    const directory = root();
    const { calls, run } = recorder();
    const jobs = new Jobs(directory, {
      project: "/work/app",
      now: () => now,
      run,
    });
    const job =
      "Open a tunnel for port 3000 and give me the link; $(rm -rf ~) `whoami` 'x'";
    expect(await jobs.start(job)).toEqual({
      ok: true,
      said: "On it. Claude Code is working on that in a new terminal window, and I will tell you its answer when it is done.",
    });
    const folder = join(directory, "agents", "jobs");
    const [id] = readdirSync(folder);
    expect(id).toMatch(/^20261121T010000-[0-9a-z]{4}$/);
    const prompt = readFileSync(join(folder, id!, "prompt.txt"), "utf8");
    expect(
      prompt.startsWith(`${job}\n\nWhen you are done, write your answer`),
    ).toBe(true);
    expect(prompt).toContain(join(folder, id!, "result.md"));
    const script = readFileSync(join(folder, id!, "start.command"), "utf8");
    expect(script).toBe(
      `#!/bin/zsh\ncd '/work/app' || exit 1\ncommand -v claude >/dev/null 2>&1 || { print -r -- 'The coding agent claude is not installed on this Mac, so the job did not start.' > '${join(folder, id!, "result.md")}'; exit 1; }\nexec claude "$(cat '${join(folder, id!, "prompt.txt")}')"\n`,
    );
    // No word of the job is in the script: nothing spoken can become a command.
    for (const word of ["tunnel", "rm -rf", "whoami"])
      expect(script).not.toContain(word);
    expect(calls).toEqual([
      ["/usr/bin/open", "-a", "Terminal", join(folder, id!, "start.command")],
    ]);
    expect(mode(folder)).toBe(0o700);
    expect(mode(join(folder, id!))).toBe(0o700);
    expect(mode(join(folder, id!, "prompt.txt"))).toBe(0o600);
    expect(mode(join(folder, id!, "start.command"))).toBe(0o700);
  });

  it("quotes a folder whose name holds a quote, and starts the agent that was chosen", async () => {
    const directory = root();
    const { run } = recorder();
    const jobs = new Jobs(directory, {
      project: "/work/it's here",
      now: () => now,
      run,
      agent: "codex",
      terminal: "iTerm",
    });
    await jobs.start("Run the tests of the app and say what fails");
    const folder = join(directory, "agents", "jobs");
    const script = readFileSync(
      join(folder, readdirSync(folder)[0]!, "start.command"),
      "utf8",
    );
    expect(script).toContain(`cd '/work/it'\\''s here' || exit 1`);
    expect(script).toContain("exec codex ");
  });

  it("starts nothing for an unclear job, for a credential, when the window does not open, and past the limit", async () => {
    const directory = root();
    const { calls, run } = recorder();
    const jobs = new Jobs(directory, {
      project: "/work/app",
      now: () => now,
      run,
      limit: 2,
    });
    expect((await jobs.start("fix")).ok).toBe(false);
    expect(
      (
        await jobs.start(
          "Deploy with the key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
        )
      ).ok,
    ).toBe(false);
    expect(calls).toEqual([]);
    expect(existsSync(join(directory, "agents", "jobs"))).toBe(false);
    const failing = recorder(1);
    expect(
      (
        await new Jobs(root(), {
          project: "/work/app",
          now: () => now,
          run: failing.run,
        }).start("Build the landing page of the app")
      ).said,
    ).toBe("The terminal window for the job did not open on this Mac.");
    let clock = now;
    const limited = new Jobs(directory, {
      project: "/work/app",
      now: () => clock,
      run,
      limit: 2,
    });
    expect((await limited.start("Build the landing page of the app")).ok).toBe(
      true,
    );
    clock += 1000;
    expect((await limited.start("Run the tests of the app again")).ok).toBe(
      true,
    );
    clock += 1000;
    const third = await limited.start("Open a tunnel for port 3000");
    expect(third).toEqual({
      ok: false,
      said: "2 jobs still run. Ask for a result, or wait for one to finish.",
    });
    // A job with no answer after two hours no longer counts as running.
    clock += 3 * 60 * 60 * 1000;
    expect((await limited.start("Open a tunnel for port 3000")).ok).toBe(true);
  });

  it("lists the newest job first, with the answer that the session wrote, as plain text", async () => {
    const directory = root();
    let clock = now;
    const { run } = recorder();
    const jobs = new Jobs(directory, {
      project: "/work/app",
      now: () => clock,
      run,
    });
    await jobs.start("Build the landing page of the app");
    clock += 60_000;
    await jobs.start("Open a tunnel for port 3000 and give me the link");
    const folder = join(directory, "agents", "jobs");
    const [first, second] = readdirSync(folder).sort();
    writeFileSync(
      join(folder, first!, "result.md"),
      "\u001b[32mThe page is built.\u001b[0m\n\nOpen it:\u0007\nhttps://example.test/page\n",
    );
    // A folder with another name, and an answer that is a link to another file, are not read.
    mkdirSync(join(folder, "notes"));
    writeFileSync(join(folder, "notes", "prompt.txt"), "not a job");
    writeFileSync(join(directory, "secret.txt"), "a private file");
    symlinkSync(
      join(directory, "secret.txt"),
      join(folder, second!, "result.md"),
    );
    const list = jobs.recent();
    expect(list.map((job) => job.id)).toEqual([second, first]);
    expect(list[0]).toMatchObject({
      job: "Open a tunnel for port 3000 and give me the link",
      startedAt: now + 60_000,
      done: false,
      result: null,
    });
    expect(list[1]).toMatchObject({
      job: "Build the landing page of the app",
      startedAt: now,
      done: true,
      result: "The page is built. Open it: https://example.test/page",
    });
    writeFileSync(join(folder, first!, "result.md"), "x".repeat(5000));
    expect(jobs.recent()[1]!.result!.endsWith(" ... (cut)")).toBe(true);
    expect(jobs.recent()[1]!.result!.length).toBeLessThan(1300);
  });

  it("prints the jobs with clawdtime jobs, as text and as data", async () => {
    const directory = root();
    const project = root();
    const system = fakeSystem({
      now,
      home: directory,
      env: { CLAWDTIME_CONFIG_HOME: directory, CLAWDTIME_JOB_PROJECT: project },
    });
    const lines: string[] = [];
    const cli = (args: string[]) =>
      agentsCli(["--supervisor", "jobs", ...args], {
        system,
        runner: recorder().run,
        print: (line: string) => lines.push(line),
      });
    await cli([]);
    expect(lines).toEqual(["ClawdTime started no job yet."]);
    await new Jobs(directory, {
      project,
      now: () => now,
      run: recorder().run,
    }).start("Build the landing page of the app");
    lines.length = 0;
    await cli(["--json"]);
    const data = JSON.parse(lines.join("\n")) as JobFacts[];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      job: "Build the landing page of the app",
      done: false,
      result: null,
    });
    lines.length = 0;
    await cli([]);
    expect(lines[0]).toContain("WORKING");
    expect(lines[0]).toContain("Build the landing page of the app");
  });
});

const board: BoardSnapshot = {
  version: 1,
  generatedAt: now,
  intervalMs: 3000,
  counts: { needs_you: 0, working: 0, idle: 0, unknown: 0 },
  sessions: [],
};
function scripted(steps: (ToolCall[] | string)[]) {
  let step = 0;
  const results: string[] = [];
  const offered: ToolSpec[][] = [];
  const systems: string[] = [];
  const model: ModelClient = {
    async complete(input) {
      offered.push(input.tools);
      systems.push(input.system);
      const last = input.messages.at(-1);
      if (last?.role === "tool") results.push(last.content);
      const next = steps[Math.min(step++, steps.length - 1)]!;
      return typeof next === "string"
        ? { text: next, toolCalls: [] }
        : { text: "", toolCalls: next };
    },
  };
  return { model, results, offered, systems };
}
const call = (
  name: string,
  args: unknown = {},
  id = `c-${name}`,
): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});
function world(list: JobFacts[] = []) {
  const started: string[] = [];
  const jobs: JobPort = {
    start: async (job) => {
      started.push(job);
      return { ok: true, said: "I started a new session for that job." };
    },
    recent: (limit = 10) => list.slice(0, limit),
  };
  const value: SupervisorWorld = {
    now: () => now,
    board: () => board,
    desk: new DecisionDesk(root(), () => now),
    focus: async () => ({ ok: true }),
    send: async () => ({ ok: true, route: "tty" }),
    clis: () => [],
    jobs,
  };
  return { value, started };
}

describe("the brain hands work to a job", () => {
  it("starts a job with the person's own sentence, whatever the model would have written", async () => {
    const { value, started } = world();
    const run = scripted([[call("start_job")], "It started."]);
    const said = await new Supervisor(value, run.model).reply(
      [],
      "Open a tunnel for port 3000 and give me the link",
      "call",
    );
    expect(started).toEqual([
      "Open a tunnel for port 3000 and give me the link",
    ]);
    // The turn ends with the sentence of the job. The model is not asked again:
    // it would only wait for an answer that cannot be there yet.
    expect(said).toBe("I started a new session for that job.");
    expect(run.results).toEqual([]);
    expect(run.systems).toHaveLength(1);
    // The model is told that work can always be handed over, and gets the two tools.
    expect(run.systems[0]).toContain("Do not answer that you cannot do it");
    expect(run.offered[0]!.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["start_job", "job_result"]),
    );
  });

  it("starts no job for a question, for a bare yes, and for one or two words; and one job for one message", async () => {
    for (const words of [
      "What is every agent doing right now?",
      "is the build done",
      "yes",
      "do it",
    ]) {
      const { value, started } = world();
      const run = scripted([[call("start_job")], "Nothing started."]);
      await new Supervisor(value, run.model).reply([], words, "chat");
      expect(started).toEqual([]);
    }
    const { value, started } = world();
    const run = scripted([
      [call("start_job"), call("start_job", {}, "c-2")],
      "It started.",
    ]);
    await new Supervisor(value, run.model).reply(
      [],
      "Build the landing page and run its tests",
      "chat",
    );
    expect(started).toEqual(["Build the landing page and run its tests"]);
  });

  it("says the answer of the newest job, or that it still works", async () => {
    const working: JobFacts = {
      id: "20261121T005500-ab12",
      job: "Open a tunnel for port 3000 and give me the link",
      startedAt: now - 300_000,
      done: false,
      result: null,
    };
    let { value } = world([working]);
    let run = scripted([[call("job_result")], "Still working."]);
    await new Supervisor(value, run.model).reply(
      [],
      "is the tunnel up?",
      "call",
    );
    expect(run.results[0]).toBe(
      'Job "Open a tunnel for port 3000 and give me the link", started 5m ago, still works.',
    );
    ({ value } = world([
      {
        ...working,
        done: true,
        result: "The tunnel is up: https://x.example.test",
      },
    ]));
    run = scripted([[call("job_result")], "Here it is."]);
    await new Supervisor(value, run.model).reply(
      [],
      "is the tunnel up?",
      "call",
    );
    expect(run.results[0]).toBe(
      'Job "Open a tunnel for port 3000 and give me the link", started 5m ago, is done. Its answer: The tunnel is up: https://x.example.test',
    );
    expect(new Supervisor(value, null).status()).toContain(
      "is done. Its answer: The tunnel is up: https://x.example.test",
    );
    ({ value } = world());
    run = scripted([[call("job_result")], "None."]);
    await new Supervisor(value, run.model).reply(
      [],
      "what did it find",
      "call",
    );
    expect(run.results[0]).toBe("ClawdTime started no job yet.");
  });

  it("sends a task to a job where no task service runs, instead of a refusal", async () => {
    const { value, started } = world();
    const run = scripted([
      [call("start_task", { goal: "build the landing page" })],
      "Started.",
    ]);
    const said = await new Supervisor(value, run.model).reply(
      [],
      "Start a task: build the landing page for the demo",
      "call",
    );
    expect(started).toEqual([
      "Start a task: build the landing page for the demo",
    ]);
    expect(said).toBe("I started a new session for that job.");
  });

  it("offers no job tool and adds no instruction where no terminal window can open", async () => {
    const { value } = world();
    delete value.jobs;
    const run = scripted([[call("start_job")], "No."]);
    await new Supervisor(value, run.model).reply(
      [],
      "Open a tunnel for port 3000 and give me the link",
      "chat",
    );
    expect(run.offered[0]!.map((tool) => tool.name)).not.toContain("start_job");
    expect(run.systems[0]).not.toContain("start_job");
    expect(run.results[0]).toBe("I cannot open a terminal window from here.");
  });
});

describe("the gate of a job, after an independent review", () => {
  it.each([
    "Thanks for the update",
    "Do not build the landing page yet",
    "Never mind, forget that",
    "Should we delete the production database?",
    "Tell me the status",
    "Is the build done yet",
    "Build the page? no, wait",
  ])("starts no job for %j, whatever the model asks", async (words) => {
    const { value, started } = world();
    const run = scripted([[call("start_job")], "Nothing started."]);
    await new Supervisor(value, run.model).reply([], words, "call");
    expect(started).toEqual([]);
  });

  it.each([
    "Can you open a tunnel for port 3000 and give me the link?",
    "Okay, restart the dev server",
    "Open Chrome, go to the docs and tell me the top heading",
  ])("still starts a job for %j", async (words) => {
    const { value, started } = world();
    const run = scripted([[call("start_job")], "Started."]);
    await new Supervisor(value, run.model).reply([], words, "call");
    expect(started).toEqual([words]);
  });

  it("starts no job from a sentence that answers a waiting agent request", async () => {
    const { value, started } = world();
    const request = value.desk.open({
      agent: "claude-code",
      sessionId: "s",
      cwd: "/work/app",
      pids: [],
      described: {
        kind: "permission",
        tool: "Bash",
        summary: "git push origin main",
        options: [],
      },
      holdSeconds: 45,
    });
    const run = scripted([
      [
        call("decide", { request: request.id, decision: "allow" }),
        call("start_job", {}, "c-2"),
      ],
      "Done.",
    ]);
    await new Supervisor(value, run.model).reply(
      [],
      "Yes, update the config",
      "call",
    );
    expect(value.desk.pending()).toHaveLength(0);
    expect(started).toEqual([]);
  });

  it("leaves a job of an earlier day out of the status, and still gives it when asked", async () => {
    const old: JobFacts = {
      id: "20261119T010000-ab12",
      job: "Open a tunnel for port 3000",
      startedAt: now - 2 * 24 * 60 * 60 * 1000,
      done: true,
      result: "The tunnel was up.",
    };
    const { value } = world([old]);
    expect(new Supervisor(value, null).status()).not.toContain("tunnel");
    const run = scripted([[call("job_result")], "Here."]);
    await new Supervisor(value, run.model).reply(
      [],
      "what did it find",
      "call",
    );
    expect(run.results[0]).toContain("The tunnel was up.");
  });
});

describe("the files of a job, after an independent review", () => {
  const setup = () => {
    const directory = root();
    const folder = join(directory, "agents", "jobs");
    const jobs = new Jobs(directory, {
      project: "/work/app",
      now: () => now,
      run: recorder().run,
    });
    return { directory, folder, jobs };
  };

  it("does not follow a job folder that is a link, and takes no job from the future", async () => {
    const { directory, folder, jobs } = setup();
    await jobs.start("Build the landing page of the app");
    // A folder outside the jobs folder, linked in under an id that sorts first.
    const outside = join(directory, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "prompt.txt"), "a planted job\n");
    writeFileSync(join(outside, "result.md"), "a planted answer\n");
    symlinkSync(outside, join(folder, "20261121T010001-zzzz"));
    mkdirSync(join(folder, "20991231T235959-aaaa"));
    writeFileSync(
      join(folder, "20991231T235959-aaaa", "prompt.txt"),
      "from the future\n",
    );
    expect(jobs.recent().map((job) => job.job)).toEqual([
      "Build the landing page of the app",
    ]);
  });

  it("reads only the start of a very large answer", async () => {
    const { folder, jobs } = setup();
    await jobs.start("Build the landing page of the app");
    const [id] = readdirSync(folder);
    writeFileSync(join(folder, id!, "result.md"), "y".repeat(3_000_000));
    const [job] = jobs.recent();
    expect(job!.result!.length).toBeLessThan(1300);
    expect(job!.text!.length).toBeLessThan(3600);
  });

  it("does not say or text a key that the session wrote into its answer", async () => {
    const { folder, jobs } = setup();
    await jobs.start("Deploy the app to the staging server");
    const [id] = readdirSync(folder);
    writeFileSync(
      join(folder, id!, "result.md"),
      "Deployed. The key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\n",
    );
    const [job] = jobs.recent();
    expect(job!.result).toContain("holds a password or a key");
    expect(job!.text).toContain("holds a password or a key");
    expect(JSON.stringify(job)).not.toContain("sk-proj");
  });

  it("takes the dash off the start of a job, so the agent does not read it as an option", async () => {
    const { folder, jobs } = setup();
    await jobs.start(
      "--dangerously-skip everything and build the landing page",
    );
    const [id] = readdirSync(folder);
    expect(
      readFileSync(join(folder, id!, "prompt.txt"), "utf8").startsWith(
        "dangerously-skip everything and build the landing page\n",
      ),
    ).toBe(true);
  });

  it("ends the job with a true sentence when the coding agent is not installed", async () => {
    const { folder, jobs } = setup();
    await jobs.start("Build the landing page of the app");
    const [id] = readdirSync(folder);
    const script = readFileSync(join(folder, id!, "start.command"), "utf8");
    // The check stands before the agent starts, and writes the answer file of this job.
    const check = script.split("\n")[2]!;
    expect(check.startsWith("command -v claude >/dev/null 2>&1 || {")).toBe(
      true,
    );
    expect(check).toContain(`> '${join(folder, id!, "result.md")}'`);
    expect(check).toContain("is not installed on this Mac");
  });
});
