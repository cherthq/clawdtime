import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appName,
  findApp,
  openApp,
  webAddress,
} from "../connectors/agents/apps.js";
import {
  Supervisor,
  type ModelClient,
  type SupervisorWorld,
  type ToolCall,
  type ToolSpec,
} from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import type { Runner } from "../connectors/agents/focus.js";
import type { TaskPort } from "../connectors/agents/tasks.js";
import type { BoardSnapshot } from "../connectors/agents/types.js";
import { fakeSystem } from "./connectors-agents-fixture.js";

const now = Date.UTC(2026, 10, 21, 2, 0, 0);
const installed = (...paths: string[]) =>
  fakeSystem({
    now,
    home: "/Users/tester",
    files: Object.fromEntries(
      paths.map((path) => [`${path}/Contents/Info.plist`, { text: "" }]),
    ),
  });
const mac = () =>
  installed(
    "/Applications/Google Chrome.app",
    "/Applications/Chrome Remote Desktop.app",
    "/Applications/Slack.app",
    "/Applications/Visual Studio Code.app",
    "/Applications/Zoom.app",
    "/Users/tester/Applications/Zoom.app",
    "/Applications/Notes Plus.app",
    "/Applications/Notes Pro.app",
    "/System/Applications/Notes.app",
    "/System/Applications/Utilities/Terminal.app",
  );
function recorder(status = 0) {
  const calls: string[][] = [];
  const run: Runner = async (command, args) => {
    calls.push([command, ...args]);
    return { status, stdout: "" };
  };
  return { calls, run };
}

describe("finding an application", () => {
  it("finds it by its full name, by the word a person says, and in any case of letters", () => {
    const system = mac();
    expect(findApp(system, "Google Chrome")).toBe(
      "/Applications/Google Chrome.app",
    );
    expect(findApp(system, "google chrome")).toBe(
      "/Applications/Google Chrome.app",
    );
    // "Chrome" is Google Chrome, not Chrome Remote Desktop: the fewest other words win.
    expect(findApp(system, "chrome")).toBe("/Applications/Google Chrome.app");
    expect(findApp(system, "code")).toBe(
      "/Applications/Visual Studio Code.app",
    );
    expect(findApp(system, "terminal")).toBe(
      "/System/Applications/Utilities/Terminal.app",
    );
    expect(findApp(system, "Notes")).toBe("/System/Applications/Notes.app");
    // The same application in two folders is one application.
    expect(findApp(system, "zoom")).toBe("/Applications/Zoom.app");
  });

  it("opens nothing for a name that fits no application or two", () => {
    const system = mac();
    expect(findApp(system, "Figma")).toBeNull();
    expect(findApp(system, "notes p")).toBeNull();
    expect(findApp(system, "plus pro")).toBeNull();
    expect(
      findApp(
        installed(
          "/Applications/Notes Plus.app",
          "/Applications/Notes Pro.app",
        ),
        "notes",
      ),
    ).toBeNull();
    expect(findApp(system, "")).toBeNull();
  });

  it("takes a name of words only: no path, no option, no control character", () => {
    expect(appName("Google Chrome")).toBe("Google Chrome");
    expect(appName("  Slack.app ")).toBe("Slack");
    for (const bad of [
      "../../bin/sh",
      "/Applications/Slack.app",
      "-a Terminal",
      "",
      "x".repeat(80),
    ])
      expect(appName(bad)).toBeNull();
  });
});

describe("a web address to open", () => {
  it("is http or https with a real host, and a bare site gets https", () => {
    expect(webAddress("news.ycombinator.com")!.href).toBe(
      "https://news.ycombinator.com/",
    );
    expect(webAddress("https://example.com/a?b=1")!.href).toBe(
      "https://example.com/a?b=1",
    );
    expect(webAddress("localhost:3000")!.href).toBe("http://localhost:3000/");
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:secret@example.com",
      "ftp://example.com",
      "chrome",
      "https://exa mple.com",
      `https://example.com/${"a".repeat(2100)}`,
    ])
      expect(webAddress(bad)).toBeNull();
  });
});

describe("opening", () => {
  it("runs the system's open with arguments: the application, the address, or both", async () => {
    const system = mac();
    let made = recorder();
    expect(await openApp(system, "chrome", null, made.run)).toEqual({
      ok: true,
      said: "Opened Google Chrome.",
    });
    expect(made.calls).toEqual([
      ["/usr/bin/open", "-a", "/Applications/Google Chrome.app"],
    ]);
    made = recorder();
    expect(
      await openApp(
        system,
        "Google Chrome",
        webAddress("example.com"),
        made.run,
      ),
    ).toEqual({ ok: true, said: "Opened example.com in Google Chrome." });
    expect(made.calls).toEqual([
      [
        "/usr/bin/open",
        "-a",
        "/Applications/Google Chrome.app",
        "https://example.com/",
      ],
    ]);
    made = recorder();
    expect(
      (await openApp(system, null, webAddress("example.com"), made.run)).said,
    ).toBe("Opened example.com in the browser.");
    expect(made.calls).toEqual([["/usr/bin/open", "https://example.com/"]]);
  });

  it("says so when the application is not there, and when open fails; it runs nothing for no application", async () => {
    const system = mac();
    const made = recorder();
    expect(await openApp(system, "Figma", null, made.run)).toEqual({
      ok: false,
      said: "I could not find one application named Figma on this Mac.",
    });
    expect(made.calls).toEqual([]);
    expect((await openApp(system, "Slack", null, recorder(1).run)).ok).toBe(
      false,
    );
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
function world() {
  const opened: string[] = [];
  const started: string[] = [];
  const value: SupervisorWorld = {
    now: () => now,
    board: () => board,
    desk: new DecisionDesk(
      mkdtempSync(join(tmpdir(), "clawdtime-apps-")),
      () => now,
    ),
    focus: async () => ({ ok: true }),
    send: async () => ({ ok: true, route: "tty" }),
    clis: () => [],
    openApp: async (name, url) => {
      opened.push(`${name ?? "-"} ${url?.href ?? "-"}`);
      return { ok: true, said: `Opened ${name ?? url?.hostname}.` };
    },
    jobs: {
      start: async (job) => {
        started.push(job);
        return { ok: true, said: "I started a new session for that job." };
      },
      recent: () => [],
    },
  };
  return { value, opened, started };
}

describe("the brain opens an application", () => {
  it("opens Chrome for the two words that the person typed in the panel, and is told that it can", async () => {
    const { value, opened } = world();
    const run = scripted([
      [call("open_app", { name: "Google Chrome" })],
      "Chrome is open.",
    ]);
    const said = await new Supervisor(value, run.model).reply(
      [],
      "open chrome",
      "chat",
    );
    expect(opened).toEqual(["Google Chrome -"]);
    expect(run.results).toEqual(["Opened Google Chrome."]);
    expect(said).toBe("Chrome is open.");
    expect(run.offered[0]!.map((tool) => tool.name)).toContain("open_app");
    expect(run.systems[0]).toContain(
      "Do not answer that you cannot open an application",
    );
  });

  it("opens an address only when the person gave its site, also said with dots as words", async () => {
    for (const [words, url] of [
      [
        "Open Chrome and go to news.ycombinator.com",
        "https://news.ycombinator.com",
      ],
      ["go to news dot ycombinator dot com in chrome", "news.ycombinator.com"],
    ] as const) {
      const { value, opened } = world();
      const run = scripted([
        [call("open_app", { name: "Google Chrome", url })],
        "Done.",
      ]);
      await new Supervisor(value, run.model).reply([], words, "call");
      expect(opened).toEqual(["Google Chrome https://news.ycombinator.com/"]);
    }
    // A site that the person did not say, from a page or a title that swayed the model.
    const { value, opened } = world();
    const run = scripted([
      [
        call("open_app", {
          name: "Google Chrome",
          url: "https://evil.example.com/login",
        }),
      ],
      "No.",
    ]);
    await new Supervisor(value, run.model).reply([], "open chrome", "chat");
    expect(opened).toEqual([]);
    expect(run.results[0]).toContain("did not give that address");
  });

  it("opens nothing that the person did not ask for or did not name", async () => {
    for (const [words, args, why] of [
      ["is chrome open?", { name: "Google Chrome" }, "did not ask to open"],
      ["what is every agent doing", { name: "Slack" }, "did not ask to open"],
      ["do not open chrome", { name: "Google Chrome" }, "did not ask to open"],
      ["open chrome", { name: "Slack" }, "did not name that application"],
      ["open chrome", { name: "../../bin/sh" }, "not a name of an application"],
      [
        "open chrome",
        { name: "Google Chrome", url: "javascript:alert(1)" },
        "not a web address",
      ],
      ["open it", {}, "Say which application"],
    ] as const) {
      const { value, opened } = world();
      const run = scripted([[call("open_app", args)], "No."]);
      await new Supervisor(value, run.model).reply([], words, "chat");
      expect(opened).toEqual([]);
      expect(run.results[0]).toContain(why);
    }
  });

  it("offers no such tool where no application can open", async () => {
    const { value } = world();
    delete value.openApp;
    const run = scripted([
      [call("open_app", { name: "Google Chrome" })],
      "No.",
    ]);
    await new Supervisor(value, run.model).reply([], "open chrome", "chat");
    expect(run.offered[0]!.map((tool) => tool.name)).not.toContain("open_app");
    expect(run.results[0]).toBe("I cannot open an application from here.");
  });

  it("takes two words as a request for work", async () => {
    const { value, started } = world();
    const run = scripted([[call("start_job")], "Started."]);
    await new Supervisor(value, run.model).reply([], "run tests", "chat");
    expect(started).toEqual(["run tests"]);
  });
});

describe("work where the task service has no coding worker", () => {
  const tasks = (simulated: boolean) => {
    const calls: string[] = [];
    const port: TaskPort = {
      current: () => null,
      canStart: () => true,
      start: async (goal) => {
        calls.push(goal);
        return { ok: true, message: "Coding run admitted." };
      },
      answer: async () => ({ ok: true, message: "" }),
      accept: async () => ({ ok: true, message: "" }),
      cancel: async () => ({ ok: true, message: "" }),
      simulated: () => simulated,
    };
    return { port, calls };
  };

  it("goes to a new coding session only when the person turned that on, and stays a task where a worker runs", async () => {
    // Off by default: a task in a service with no worker stays a task, as the service says.
    const untouched = tasks(true);
    const zero = world();
    zero.value.tasks = untouched.port;
    await new Supervisor(zero.value, scripted(["Okay."]).model).reply(
      [],
      "Build a landing page for the demo",
      "chat",
    );
    expect(zero.started).toEqual([]);
    expect(untouched.calls).toEqual(["Build a landing page for the demo"]);
    // The person turned it on.
    const none = tasks(true);
    const first = world();
    first.value.tasks = none.port;
    first.value.jobsForTasks = true;
    const said = await new Supervisor(
      first.value,
      scripted(["Okay."]).model,
    ).reply([], "Build a landing page for the demo", "chat");
    expect(first.started).toEqual(["Build a landing page for the demo"]);
    expect(none.calls).toEqual([]);
    expect(said).toBe("I started a new session for that job.");
    const real = tasks(false);
    const second = world();
    second.value.tasks = real.port;
    second.value.jobsForTasks = true;
    await new Supervisor(second.value, scripted(["Okay."]).model).reply(
      [],
      "Build a landing page for the demo",
      "chat",
    );
    expect(second.started).toEqual([]);
    expect(real.calls).toEqual(["Build a landing page for the demo"]);
  });
});

describe("the desktop service", () => {
  it("gives the panel's chat the application tool and the job tools when it knows the project folder", async () => {
    const seen: string[][] = [];
    const model: ModelClient = {
      async complete(input) {
        seen.push(input.tools.map((tool) => tool.name));
        return { text: "Okay.", toolCalls: [] };
      },
    };
    const run: Runner = async () => ({ status: 0, stdout: "" });
    const withProject = new BoardFeed({
      root: mkdtempSync(join(tmpdir(), "clawdtime-feed-")),
      model,
      speech: null,
      runner: run,
      system: mac(),
      project: "/work/app",
    });
    await withProject.say("open chrome");
    expect(seen[0]).toEqual(
      expect.arrayContaining([
        "open_app",
        "start_job",
        "job_result",
        "session_window",
      ]),
    );
    const without = new BoardFeed({
      root: mkdtempSync(join(tmpdir(), "clawdtime-feed-")),
      model,
      speech: null,
      runner: run,
      system: mac(),
    });
    await without.say("open chrome");
    expect(seen[1]).not.toContain("open_app");
    expect(seen[1]).not.toContain("start_job");
  });
});
