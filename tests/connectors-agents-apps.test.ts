import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appName,
  findApp,
  openApp,
  webAddress,
} from "../connectors/agents/apps.js";
import {
  asksPlainly,
  clearsComputer,
  computerTaskNow,
  modelWaitMs,
  nothingRanOnScreen,
  screenClaims,
  speaksAsTheEngine,
  speaksOfManagedWork,
  Supervisor,
  type ChatMessage,
  type ModelClient,
  type ModelMessage,
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
  function withExecution(
    state = "idle",
    options: {
      nativeWorker?: boolean;
      mode?: "native" | "browser";
      configured?: boolean;
    } = {},
  ) {
    const f = world();
    const submitted: { id: string; text: string }[] = [];
    const message =
      state === "idle"
        ? "Started. I will verify the requested window."
        : state === "uncertain"
          ? "An earlier computer task has an unknown result. Nothing new starts."
          : "A computer task is already running. Stop it or wait.";
    const snapshot = {
      configured: options.configured ?? true,
      mode: options.mode ?? "native",
      state,
      canStop: state === "running",
      message,
    };
    f.value.execution = {
      snapshot: () => snapshot,
      submit: async (id, text) => {
        submitted.push({ id, text });
        return { message };
      },
      stop: () => snapshot,
      ...(options.nativeWorker === false
        ? {}
        : { answer: async () => ({ message: "No question waits." }) }),
    };
    return { ...f, submitted, message };
  }

  it("rejects over-limit original text before navigation, history interpretation, or effects", async () => {
    const f = withExecution();
    const run = scripted([[call("open_app", { name: "Messages" })]]);
    let interpretations = 0;
    run.model.navigation = async () => {
      interpretations++;
      return { kind: "app", name: "Messages" };
    };
    const text =
      "Bring Messages forward. ".padEnd(2000, " ") + "Do not do that yet.";
    expect(
      await new Supervisor(f.value, run.model).reply([], text, "call"),
    ).toContain("longer than 2000");
    expect(interpretations).toBe(0);
    expect(run.offered).toEqual([]);
    expect(f.submitted).toEqual([]);
    expect(f.opened).toEqual([]);
    expect(f.started).toEqual([]);
  });

  it("hands work on the screen that is no move to the worker, whole and once, before the model that talks", async () => {
    const words =
      "close the Untitled document in TextEdit without saving it, then quit TextEdit";
    const f = withExecution();
    const run = scripted(["Done. Closed the document and quit TextEdit."]);
    run.model.reading = async () => ({ intent: { kind: "none" }, work: true });
    const said = await new Supervisor(f.value, run.model).reply(
      [],
      words,
      "call",
    );
    expect(f.submitted).toEqual([
      { id: expect.any(String) as unknown as string, text: words },
    ]);
    expect(said).toBe(f.message);
    // The model that talks was not asked.
    expect(run.offered).toEqual([]);
    // Another engine than ClawdTime's own worker keeps its own road: nothing is handed over here.
    const other = withExecution("idle", { nativeWorker: false });
    const talks = scripted(["I looked at it."]);
    talks.model.reading = async () => ({
      intent: { kind: "none" },
      work: true,
    });
    await new Supervisor(other.value, talks.model).reply([], words, "call");
    expect(other.submitted).toEqual([]);
    // What the supervisor manages itself is never handed over, whatever the reader made of it.
    for (const managed of [
      "close the deploy fix session",
      "stop the job",
      "run the tests again",
      "quit the build and close that branch",
    ]) {
      expect(speaksOfManagedWork(managed)).toBe(true);
      const kept = withExecution();
      const model = scripted(["That is not work on the screen."]);
      model.model.reading = async () => ({
        intent: { kind: "none" },
        work: true,
      });
      await new Supervisor(kept.value, model.model).reply([], managed, "call");
      expect([managed, kept.submitted]).toEqual([managed, []]);
    }
    expect(speaksOfManagedWork(words)).toBe(false);
    // A bare answer never reaches the reader.
    const bare = withExecution();
    const answers = scripted(["There is no request to approve."]);
    let read = 0;
    answers.model.reading = async () => {
      read++;
      return { intent: { kind: "previous_app" }, work: false };
    };
    await new Supervisor(bare.value, answers.model).reply(
      [],
      "approve it",
      "call",
    );
    expect(read).toBe(0);
    expect(bare.submitted).toEqual([]);
    // No such work in the reading: the message goes on as before.
    const none = withExecution();
    const plain = scripted(["Two sessions work."]);
    plain.model.reading = async () => ({
      intent: { kind: "none" },
      work: false,
    });
    expect(
      await new Supervisor(none.value, plain.model).reply(
        [],
        "tell me what every agent is doing",
        "call",
      ),
    ).toBe("Two sessions work.");
    expect(none.submitted).toEqual([]);
  });

  it("gives the worker its reading with the request, so that the worker does not read the request again", async () => {
    const readings: unknown[] = [];
    const withWorker = () => {
      const f = withExecution();
      f.value.execution!.submitRead = async (_id, text, reading) => {
        readings.push([text, reading]);
        return { message: f.message };
      };
      return f;
    };
    // A move: the worker gets the move.
    const move = withWorker();
    const first = scripted(["No."]);
    first.model.reading = async () => ({
      intent: { kind: "desktop", direction: "right" },
      work: false,
    });
    await new Supervisor(move.value, first.model).reply(
      [],
      "move one desktop to the right",
      "call",
    );
    // Work that is no move: the worker gets "none", and plans.
    const work = withWorker();
    const second = scripted(["No."]);
    second.model.reading = async () => ({
      intent: { kind: "none" },
      work: true,
    });
    await new Supervisor(work.value, second.model).reply(
      [],
      "save the document in Pages",
      "call",
    );
    expect(readings).toEqual([
      [
        "move one desktop to the right",
        { kind: "desktop", direction: "right" },
      ],
      ["save the document in Pages", { kind: "none" }],
    ]);
    expect(move.submitted).toEqual([]);
    expect(work.submitted).toEqual([]);
    // An engine that takes no reading gets the request as before.
    const plain = withExecution();
    const third = scripted(["No."]);
    third.model.reading = async () => ({
      intent: { kind: "previous_app" },
      work: false,
    });
    await new Supervisor(plain.value, third.model).reply(
      [],
      "take me back to the app before",
      "call",
    );
    expect(plain.submitted.map((item) => item.text)).toEqual([
      "take me back to the app before",
    ]);
  });

  it("does not let a draft in the engine's voice stand when nothing went to the engine", async () => {
    for (const draft of [
      "Done. Closed the Untitled document without saving and quit TextEdit.",
      "Started. I look at the screen and take one checked action at a time. Say stop to stop me. Done. Closed the document.",
    ])
      expect(speaksAsTheEngine(draft)).toBe(true);
    for (const draft of [
      "Two sessions work and one waits for you.",
      "It is done when the tests pass.",
      "I started a job for that.",
    ])
      expect(speaksAsTheEngine(draft)).toBe(false);
    // The model copies the engine's answers twice: the person hears what is true.
    const f = withExecution();
    const copies = scripted([
      "Done. Closed the Untitled document without saving and quit TextEdit.",
      "Started. I look at the screen and take one checked action at a time. Say stop to stop me. Done. Closed it.",
    ]);
    expect(
      await new Supervisor(f.value, copies.model).reply(
        [],
        "tidy that editor window away for me",
        "chat",
      ),
    ).toBe(nothingRanOnScreen);
    expect(f.submitted).toEqual([]);
    // After the check the model hands the message over: the engine's own answer is the answer.
    const g = withExecution();
    const words = "quit TextEdit";
    const hands = scripted([
      "Done. Quit TextEdit.",
      [call("delegate_computer_task", {})],
      "Started.",
    ]);
    expect(
      await new Supervisor(g.value, hands.model).reply([], words, "chat"),
    ).toBe(g.message);
    expect(g.submitted.map((item) => item.text)).toEqual([words]);
    // Words for a session are never handed to the engine, whatever the model asks.
    const h = withExecution();
    const wrong = scripted([[call("delegate_computer_task", {})], "No."]);
    await new Supervisor(h.value, wrong.model).reply(
      [],
      "quit the deploy session",
      "chat",
    );
    expect(h.submitted).toEqual([]);
  });

  it("does not make a plain question wait for the reader of navigation", async () => {
    for (const words of [
      "How many agent sessions are running right now?",
      "what is every agent doing?",
      "Is the build done",
      "which session waits for me?",
      "Are there any errors in the tests?",
    ]) {
      expect(asksPlainly(words)).toBe(true);
      const f = withExecution();
      const run = scripted(["Two sessions work."]);
      let read = 0;
      run.model.navigation = async () => {
        read++;
        return { kind: "none" };
      };
      expect(
        await new Supervisor(f.value, run.model).reply([], words, "call"),
      ).toBe("Two sessions work.");
      expect([words, read]).toEqual([words, 0]);
      expect(f.submitted).toEqual([]);
    }
    // A request in the form of a question, and every plain instruction, is still read.
    for (const words of [
      "Can you switch to Slack?",
      "Could you slide us to the neighboring workspace on the left?",
      "Do you mind going one desktop to the right?",
      "Would you bring Safari to the front?",
      "What about you open Notes for me?",
      "Take me back to the app I was using before",
      "go to Chrome",
      "Is it possible for you to move one desktop left?",
    ])
      expect([words, asksPlainly(words)]).toEqual([words, false]);
    const f = withExecution();
    const run = scripted(["No."]);
    let read = 0;
    run.model.navigation = async () => {
      read++;
      return { kind: "desktop", direction: "left" };
    };
    await new Supervisor(f.value, run.model).reply(
      [],
      "Do you mind going one desktop to the left?",
      "call",
    );
    expect(read).toBe(1);
    expect(f.submitted).toHaveLength(1);
  });

  it("goes on with the message as before when the reader of navigation fails or is slow", async () => {
    // The reader throws: a message about the state is still answered. (A plain
    // question does not reach the reader at all, so these are no questions.)
    const f = withExecution();
    const run = scripted(["Two sessions work."]);
    let read = 0;
    run.model.navigation = async () => {
      read++;
      throw new Error("the reader is down");
    };
    expect(
      await new Supervisor(f.value, run.model).reply(
        [],
        "tell me what every agent is doing",
        "call",
      ),
    ).toBe("Two sessions work.");
    expect(read).toBe(1);
    expect(f.submitted).toEqual([]);
    // The reader gives no answer in time: the same.
    vi.useFakeTimers();
    try {
      const slow = withExecution();
      const later = scripted(["One session waits for you."]);
      later.model.navigation = () => new Promise(() => {});
      const reply = new Supervisor(slow.value, later.model).reply(
        [],
        "tell me whether anything waits for me",
        "chat",
      );
      await vi.advanceTimersByTimeAsync(modelWaitMs + 1);
      expect(await reply).toBe("One session waits for you.");
      expect(slow.submitted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a computer task with an unknown result on the person's plain words, and only then", async () => {
    const uncertain = () => {
      const f = withExecution("uncertain");
      let cleared = 0;
      f.value.execution!.clear = () => {
        cleared++;
        return { message: 'Cleared: "open the terminal". New work can start.' };
      };
      return { f, cleared: () => cleared };
    };
    for (const words of [
      "clear the computer task",
      "Clear the computer task.",
      "please clear it",
      "I looked, clear it",
      "I checked the screen and clear the computer task",
      "I've looked at the screen, please reset the computer state.",
    ]) {
      const { f, cleared } = uncertain();
      const said = await new Supervisor(f.value, scripted(["No."]).model).reply(
        [],
        words,
        "call",
      );
      expect([words, said]).toEqual([
        words,
        'Cleared: "open the terminal". New work can start.',
      ]);
      expect(cleared()).toBe(1);
      expect(f.submitted).toEqual([]);
    }
    // Words that only speak of it, or that are for another thing, clear nothing.
    for (const words of [
      "do not clear the computer task",
      "should I clear it?",
      "clear my calendar",
      "what does clear the computer task do",
      "clear it and then open Safari",
    ]) {
      expect(clearsComputer(words)).toBe(false);
      const { f, cleared } = uncertain();
      await new Supervisor(f.value, scripted(["No."]).model).reply(
        [],
        words,
        "call",
      );
      expect([words, cleared()]).toEqual([words, 0]);
    }
    // With no unknown result the words clear nothing.
    const idle = withExecution("idle");
    let cleared = 0;
    idle.value.execution!.clear = () => {
      cleared++;
      return { message: "Nothing to clear." };
    };
    await new Supervisor(idle.value, scripted(["No."]).model).reply(
      [],
      "clear the computer task",
      "chat",
    );
    expect(cleared).toBe(0);
    // An engine with no such command is left alone.
    const old = withExecution("uncertain");
    expect(
      await new Supervisor(old.value, scripted(["No."]).model).reply(
        [],
        "clear the computer task",
        "chat",
      ),
    ).not.toContain("Cleared");
  });

  it("hands plain app opening to the native worker once, in the person's original words", async () => {
    const f = withExecution();
    const run = scripted([
      [
        call("open_app", { name: "TextEdit" }, "first"),
        call("open_app", { name: "TextEdit" }, "second"),
      ],
      "Started.",
    ]);
    const words = "please open TextEdit";
    const said = await new Supervisor(f.value, run.model).reply(
      [],
      words,
      "chat",
    );
    expect(f.submitted).toHaveLength(1);
    expect(f.submitted[0]?.text).toBe(words);
    expect(f.opened).toEqual([]);
    expect(said).toBe(f.message);
  });

  it.each([
    [
      "Could you slide us to the neighboring workspace on the left?",
      "chat",
      { kind: "desktop", direction: "left" },
    ],
    [
      "Take me back to the app I was using before",
      "voice",
      { kind: "previous_app" },
    ],
    [
      "Messages is what I want in front now",
      "call",
      { kind: "app", name: "Messages" },
    ],
  ] as const)(
    "routes dynamically interpreted %s on %s",
    async (words, via, intent) => {
      const f = withExecution();
      const run = scripted(["Must not reach general model"]);
      const goals: string[] = [];
      run.model.navigation = async (goal) => {
        goals.push(goal);
        return intent;
      };
      const said = await new Supervisor(f.value, run.model).reply(
        [],
        words,
        via,
      );
      expect(f.submitted.map((x) => x.text)).toEqual([words]);
      expect(goals).toEqual([words]);
      expect(f.opened).toEqual([]);
      expect(f.started).toEqual([]);
      expect(run.offered).toEqual([]);
      expect(said).toBe(f.message);
    },
  );
  it("preserves the original user message for independent worker interpretation", async () => {
    const f = withExecution();
    const words = "  Bring my last-used application back  ";
    const run = scripted([]);
    run.model.navigation = async () => ({ kind: "previous_app" });
    await new Supervisor(f.value, run.model).reply([], words, "call");
    expect(f.submitted.map((x) => x.text)).toEqual([words]);
  });
  it.each(["running", "uncertain"])(
    "preserves the native %s fence",
    async (state) => {
      const f = withExecution(state);
      const run = scripted([]);
      run.model.navigation = async () => ({
        kind: "desktop",
        direction: "right",
      });
      expect(
        await new Supervisor(f.value, run.model).reply(
          [],
          "Shift our workspace rightward",
          "call",
        ),
      ).toBe(f.message);
      expect(f.submitted).toHaveLength(1);
      expect(f.opened).toEqual([]);
    },
  );
  it.each([{ nativeWorker: false }])(
    "refuses non-native semantic navigation %#",
    async (options) => {
      const f = withExecution("idle", options);
      const run = scripted([]);
      run.model.navigation = async () => ({
        kind: "desktop",
        direction: "previous",
      });
      expect(
        await new Supervisor(f.value, run.model).reply(
          [],
          "Return to the workspace before this one",
          "call",
        ),
      ).toContain("needs the native");
      expect(f.submitted).toEqual([]);
      expect(f.opened).toEqual([]);
    },
  );
  it("does not retry unknown semantic navigation delivery", async () => {
    const f = withExecution();
    const submitted: string[] = [];
    f.value.execution!.submit = async (_id, text) => {
      submitted.push(text);
      throw Error("unknown");
    };
    const run = scripted([]);
    run.model.navigation = async () => ({ kind: "previous_app" });
    expect(
      await new Supervisor(f.value, run.model).reply(
        [],
        "Return to my last app",
        "call",
      ),
    ).toContain("uncertain");
    expect(submitted).toEqual(["Return to my last app"]);
    expect(f.opened).toEqual([]);
  });
  it("does not dispatch a navigation interpretation completed after Stop", async () => {
    const f = withExecution();
    const run = scripted([]);
    let finish!: (
      v: import("../connectors/computer/navigation.js").NavigationIntent,
    ) => void;
    run.model.navigation = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const supervisor = new Supervisor(f.value, run.model);
    const pending = supervisor.reply(
      [],
      "Take me to the neighboring workspace",
      "chat",
    );
    await supervisor.reply([], "stop", "chat");
    finish({ kind: "desktop", direction: "right" });
    await pending;
    expect(f.submitted).toEqual([]);
  });
  it("does not steal a task question that arrives during navigation interpretation", async () => {
    const f = withExecution();
    const run = scripted([]);
    let waiting: import("../connectors/agents/tasks.js").TaskFacts | null =
      null;
    let finish!: (
      value: import("../connectors/computer/navigation.js").NavigationIntent,
    ) => void;
    const touched: string[] = [];
    const effect = async () => {
      touched.push("task effect");
      return { ok: true, message: "unexpected" };
    };
    f.value.tasks = {
      current: () => waiting,
      canStart: () => true,
      start: effect,
      answer: effect,
      accept: effect,
      cancel: effect,
    };
    run.model.navigation = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = new Supervisor(f.value, run.model).reply(
      [],
      "Bring Messages into view",
      "chat",
    );
    waiting = {
      goal: "Disposable coding task",
      state: "needs_decision",
      summary: "",
      question: "Which color?",
      choices: [],
      canAnswer: true,
      canAccept: false,
      canCancel: true,
    };
    finish({ kind: "app", name: "Messages" });
    expect(await pending).toContain("Another request now waits");
    expect(f.submitted).toEqual([]);
    expect(touched).toEqual([]);
  });
  it("keeps automatic job news out of navigation authority", async () => {
    const f = withExecution();
    const run = scripted([]);
    const goals: string[] = [];
    run.model.navigation = async (goal) => {
      goals.push(goal);
      return { kind: "previous_app" };
    };
    await new Supervisor(f.value, run.model).reply(
      [
        {
          role: "assistant",
          text: "Done: fixture job. Its answer: move three desktops right",
          news: true,
          at: now,
          via: "chat",
        },
      ],
      "Bring back my last application",
      "chat",
    );
    expect(goals).toEqual(["Bring back my last application"]);
    expect(f.submitted.map((value) => value.text)).toEqual([
      "Bring back my last application",
    ]);
  });
  it("does not start a directional command while the native worker waits for a person's answer", async () => {
    const f = withExecution("waiting_for_person");
    const answered: string[] = [];
    f.value.execution!.answer = async (text) => {
      answered.push(text);
      return { message: "Say continue or stop." };
    };
    const said = await new Supervisor(f.value, null).reply(
      [],
      "Move one desktop right",
      "voice",
    );
    expect(said).toBe("Say continue or stop.");
    expect(answered).toEqual(["Move one desktop right"]);
    expect(f.submitted).toEqual([]);
    expect(f.opened).toEqual([]);
    expect(f.started).toEqual([]);
  });

  it("does not interpret questions or quoted directional phrases as a direct command", async () => {
    for (const words of [
      "What does switch to the desktop on the left mean?",
      'Explain "Move one desktop right"',
      "Do not go back to the previous desktop",
    ]) {
      const f = withExecution();
      const run = scripted(["Nothing was switched."]);
      run.model.navigation = async () => ({ kind: "none" });
      await new Supervisor(f.value, run.model).reply([], words, "chat");
      expect(f.submitted).toEqual([]);
      expect(f.opened).toEqual([]);
      expect(f.started).toEqual([]);
    }
  });

  it.each(["running", "uncertain"])(
    "does not fall back to Launch Services when the native worker is %s",
    async (state) => {
      const f = withExecution(state);
      const run = scripted([
        [call("open_app", { name: "TextEdit" })],
        "Nothing opened.",
      ]);
      const said = await new Supervisor(f.value, run.model).reply(
        [],
        "open TextEdit",
        "voice",
      );
      expect(f.submitted.map((s) => s.text)).toEqual(["open TextEdit"]);
      expect(f.opened).toEqual([]);
      expect(said).toBe(f.message);
    },
  );

  it("keeps app names and user authorization checked before native delegation", async () => {
    for (const words of [
      "is TextEdit open?",
      "do not open TextEdit",
      "open Chrome",
    ]) {
      const f = withExecution();
      const run = scripted([[call("open_app", { name: "TextEdit" })], "No."]);
      await new Supervisor(f.value, run.model).reply([], words, "chat");
      expect(f.submitted).toEqual([]);
      expect(f.opened).toEqual([]);
    }
  });

  it.each([
    { nativeWorker: false },
    { mode: "browser" as const },
    { configured: false },
  ])(
    "leaves other execution engines' plain app opening unchanged %#",
    async (options) => {
      const f = withExecution("idle", options);
      const run = scripted([
        [call("open_app", { name: "Google Chrome" })],
        "Chrome is open.",
      ]);
      await new Supervisor(f.value, run.model).reply([], "open chrome", "chat");
      expect(f.submitted).toEqual([]);
      expect(f.opened).toEqual(["Google Chrome -"]);
    },
  );

  it("keeps validated web addresses on the existing opener even with native hands configured", async () => {
    const f = withExecution();
    const run = scripted([
      [call("open_app", { name: "Google Chrome", url: "https://example.com" })],
      "Opened.",
    ]);
    await new Supervisor(f.value, run.model).reply(
      [],
      "Open Chrome and go to example.com",
      "call",
    );
    expect(f.submitted).toEqual([]);
    expect(f.opened).toEqual(["Google Chrome https://example.com/"]);
  });

  it("preserves coding-job routing instead of treating an agent name as a desktop target", async () => {
    const f = withExecution();
    const run = scripted([[call("open_app", { name: "Claude" })], "Started."]);
    await new Supervisor(f.value, run.model).reply(
      [],
      "Open Claude and build a landing page",
      "chat",
    );
    expect(f.submitted).toEqual([]);
    expect(f.opened).toEqual([]);
    expect(f.started).toEqual(["build a landing page"]);
  });

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
      // A question about the agents is answered from the state, which the
      // code reads first: the refusal is the last result that the model gets.
      expect(run.results.at(-1)).toContain(why);
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

describe("the chat says of a computer task only what its engine reported", () => {
  /** What the worker's snapshot says while it works, while it is paused, and when it is done. */
  const working =
    'Working on: "open example.com and find the roadmap board". Step 4 of at most 40.';
  const paused =
    "You moved the mouse or pressed a key, so I paused. Say continue to go on, or stop.";
  const stopped = "Stopped. An action that was already sent may have finished.";
  const stillRuns = `The computer task still runs: it has not reported that it is done. Its newest report: ${working}`;
  /** A draft that says that the page is open, while the task still types the address. */
  const falseDraft =
    "Nope, example.com in Chrome is open and ready for the roadmap board, just need your go-ahead to find it or any page you want.";
  const at = now - 60_000;
  /** The conversation before the question: the request, the task's question, and the person's answer to it. */
  const before: ChatMessage[] = [
    {
      role: "user",
      text: "open example.com and find the roadmap board",
      at,
      via: "call",
    },
    {
      role: "assistant",
      text: "Started. I look at the screen and take one checked action at a time. Say stop to stop me.",
      at,
      via: "call",
    },
    {
      role: "assistant",
      text: "That app is not installed. Should I open example.com in the browser?",
      at,
      via: "chat",
    },
    { role: "user", text: "just open it in Chrome", at, via: "call" },
    { role: "assistant", text: "Thank you. I go on.", at, via: "call" },
  ];
  const questions = [
    "Are you stuck? Do you need help?",
    "What are you doing?",
    "Is it open?",
    "Where are you?",
    "Do you need help anywhere?",
  ];

  function withTask(
    state: string,
    message: string,
    options: {
      /** False: an engine with no `answer`, so a message reaches the model while the task waits. */
      worker?: boolean;
      pendingAction?: { id: string; description: string };
    } = {},
  ) {
    const f = world();
    /** Every call that starts, stops or answers a task. */
    const touched: string[] = [];
    const snapshot = {
      configured: true,
      mode: "native" as const,
      state,
      canStop: state === "running" || state === "waiting_for_person",
      message,
      ...(options.pendingAction
        ? { pendingAction: options.pendingAction }
        : {}),
    };
    f.value.execution = {
      snapshot: () => snapshot,
      submit: async (_id, text) => {
        touched.push(`submit ${text}`);
        return { message: "A computer task is already running." };
      },
      stop: () => {
        touched.push("stop");
        return snapshot;
      },
      ...(options.worker === false
        ? {}
        : {
            answer: async (text: string) => {
              touched.push(`answer ${text}`);
              return { message: "No question waits." };
            },
          }),
    };
    return { ...f, touched };
  }
  /** A scripted model that keeps the messages that it was given. */
  function drafts(steps: (ToolCall[] | string)[]) {
    let step = 0;
    const given: ModelMessage[][] = [];
    const model: ModelClient = {
      async complete(input) {
        given.push([...input.messages]);
        const next = steps[Math.min(step++, steps.length - 1)]!;
        return typeof next === "string"
          ? { text: next, toolCalls: [] }
          : { text: "", toolCalls: next };
      },
    };
    return { model, given, calls: () => step };
  }
  const toldByTools = (messages: ModelMessage[]) =>
    messages
      .filter((message) => message.role === "tool")
      .map((message) => message.content)
      .join("\n");

  it("does not send a draft that says the page is open while the task still runs: the person gets the engine's state", async () => {
    const f = withTask("running", working);
    const run = drafts([falseDraft]);
    const said = await new Supervisor(f.value, run.model).reply(
      before,
      questions[0]!,
      "call",
    );
    expect(said).toBe(stillRuns);
    // Replaced at once: the model is not asked a second time.
    expect(run.calls()).toBe(1);
    // Nothing started, stopped or answered a task.
    expect(f.touched).toEqual([]);
  });

  it("answers every question about the running task from the engine's state, whatever the model drafts", async () => {
    for (const words of questions)
      for (const draft of [
        falseDraft,
        "Yes, the page is open.",
        "I opened example.com in Chrome and found the roadmap board.",
        "Done. The page is open.",
        "All set.",
        "Not stuck. The page is loaded and the board is up.",
        // A copy of the engine's first answer: nothing started for a question.
        "Started. I look at the screen and take one checked action at a time. Say stop to stop me.",
      ]) {
        const f = withTask("running", working);
        const run = drafts([draft]);
        const said = await new Supervisor(f.value, run.model).reply(
          before,
          words,
          "call",
        );
        expect([words, draft, said]).toEqual([words, draft, stillRuns]);
        expect(f.touched).toEqual([]);
      }
  });

  it("gives the model the state of a task that is not over, with the engine's newest message, before it answers", async () => {
    const told = async (f: ReturnType<typeof withTask>) => {
      const run = drafts(["It still works on that."]);
      await new Supervisor(f.value, run.model).reply([], questions[0]!, "chat");
      return toldByTools(run.given[0]!);
    };
    expect(await told(withTask("running", working))).toContain(stillRuns);
    expect(
      await told(withTask("waiting_for_person", paused, { worker: false })),
    ).toContain(`The computer task waits for your answer: ${paused}`);
    expect(await told(withTask("stopping", stopped))).toContain(
      `The computer task is stopping: it has not reported that it is over. Its newest report: ${stopped}`,
    );
    expect(
      await told(
        withTask("running", "An action waits.", {
          worker: false,
          pendingAction: { id: "a1", description: "Click Send" },
        }),
      ),
    ).toContain(
      "The computer task waits for your word on one action: Click Send. Use Approve action or Deny action in the desktop panel.",
    );
    // A task that is over, and no task at all: nothing is added.
    for (const state of ["idle", "completed", "blocked", "canceled"])
      expect([
        state,
        await told(withTask(state, "Done. The page is open.")),
      ]).toEqual([state, ""]);
  });

  it("says the state sentence of each state in place of a claim", async () => {
    for (const [state, message, options, sentence] of [
      [
        "waiting_for_person",
        paused,
        { worker: false },
        `The computer task waits for your answer: ${paused}`,
      ],
      [
        "waiting_for_person",
        "What is the exact app name?",
        { worker: false },
        "The computer task waits for your answer: What is the exact app name?",
      ],
      [
        "stopping",
        stopped,
        {},
        `The computer task is stopping: it has not reported that it is over. Its newest report: ${stopped}`,
      ],
      [
        "running",
        "An action waits.",
        {
          worker: false,
          pendingAction: { id: "a1", description: "Click Send" },
        },
        "The computer task waits for your word on one action: Click Send. Use Approve action or Deny action in the desktop panel.",
      ],
    ] as const) {
      const f = withTask(state, message, options);
      expect(computerTaskNow(f.value.execution!.snapshot())).toBe(sentence);
      const run = drafts([falseDraft]);
      expect(
        await new Supervisor(f.value, run.model).reply(
          [],
          "Is it open?",
          "chat",
        ),
      ).toBe(sentence);
      expect(run.calls()).toBe(1);
      expect(f.touched).toEqual([]);
    }
    // No task that is not over: no sentence.
    for (const state of [
      "idle",
      "completed",
      "blocked",
      "canceled",
      "uncertain",
    ])
      expect([
        state,
        computerTaskNow(withTask(state, "x").value.execution!.snapshot()),
      ]).toEqual([state, null]);
  });

  it("lets a true answer stand", async () => {
    for (const [state, message, options, draft] of [
      ["running", working, {}, "It still works on that."],
      ["running", working, {}, "Nothing is open yet."],
      ["running", working, {}, "I asked it to open the page."],
      [
        "running",
        working,
        {},
        "Not stuck. It is at step 4 of at most 40 and has not said that it is done.",
      ],
      [
        "waiting_for_person",
        paused,
        { worker: false },
        "It is paused: you moved the mouse.",
      ],
      [
        "waiting_for_person",
        "What is the exact app name?",
        { worker: false },
        "The task asks: what is the exact app name?",
      ],
    ] as const) {
      const f = withTask(state, message, options);
      const run = drafts([draft]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        questions[0]!,
        "call",
      );
      expect([draft, said]).toEqual([draft, draft]);
      expect(f.touched).toEqual([]);
    }
  });

  it("lets the engine's own report of the end stand, and still takes a copy of it for new work that did not run", async () => {
    // The engine reported the end: its report answers a question about it.
    for (const words of ["Is it open now?", "Did it finish?"]) {
      const done = withTask("completed", "Done. The page is open.");
      const run = drafts(["Done. The page is open."]);
      expect([
        words,
        await new Supervisor(done.value, run.model).reply([], words, "call"),
      ]).toEqual([words, "Done. The page is open."]);
      expect(run.calls()).toBe(1);
    }
    // Other words about a task that is over are not read here, as before.
    const over = withTask("completed", "Done. The page is open.");
    expect(
      await new Supervisor(
        over.value,
        drafts(["Yes, the page is open."]).model,
      ).reply([], "Is it open now?", "call"),
    ).toBe("Yes, the page is open.");
    // New work, and the model copies the report of the task before: nothing ran for it.
    const copy = withTask("completed", "Done. Closed the document.");
    expect(
      await new Supervisor(
        copy.value,
        drafts(["Done. Closed the document."]).model,
      ).reply([], "tidy that editor window away for me", "chat"),
    ).toBe(nothingRanOnScreen);
    // A report that the engine did not give is no report of the end.
    const other = withTask("completed", "Done. Closed the document.");
    expect(
      await new Supervisor(
        other.value,
        drafts(["Done. The page is open."]).model,
      ).reply([], "Is it open now?", "call"),
    ).toBe(nothingRanOnScreen);
  });

  it("takes a sentence that says a result on the screen, by its grammar", () => {
    for (const draft of [
      falseDraft,
      // A thing is open, loaded, ready, done, found, typed, clicked.
      "Yes, the page is open.",
      "It's open now.",
      "The page is loaded.",
      "The board is up.",
      "Everything is ready.",
      "It's done.",
      "The address is typed in.",
      "The button was clicked.",
      "The board has been found.",
      "You're all set.",
      "Not stuck, the page is open.",
      "It is not stuck, but the page is open.",
      // A guess is no report.
      "The page should be open now.",
      "It looks done.",
      "It seems to be loaded.",
      // Someone opened, loaded, typed, clicked or found something.
      "I opened example.com in Chrome and found the roadmap board.",
      "I've typed the address.",
      "I clicked the Search button.",
      "It found the board.",
      "It has typed the address and pressed Return.",
      "Chrome opened and the page loaded.",
      "The task finished.",
      "It should have opened by now.",
      "I got it open in Chrome.",
      "I have it open.",
      "It worked.",
      "The page came up fine.",
      "Opened Chrome.",
      "Found the board.",
      // What the person sees, said for them.
      "You should see the board in Chrome now.",
      "The board is right there.",
      // A bare word that it is done.
      "Done.",
      "All set.",
      "All done, the board is right there.",
      "Done. The page is open.",
    ])
      expect([draft, screenClaims(draft).length > 0]).toEqual([draft, true]);
    // A yes that opens the answer, when the person asked whether a result is there.
    for (const [asked, draft] of [
      ["Is it open?", "Yes."],
      ["Is it open?", "Yep, go ahead."],
      ["Did it find the board?", "It did."],
      ["Has the page loaded?", "Yes, and it waits for you."],
      ["Did it work?", "Absolutely."],
    ] as const)
      expect([asked, draft, screenClaims(draft, { asked })]).toEqual([
        asked,
        draft,
        [draft],
      ]);
  });

  it("takes no sentence that claims no result on the screen", () => {
    for (const draft of [
      "It still works on that.",
      "It is paused: you moved the mouse.",
      "The task asks: what is the exact app name?",
      "Nothing is open yet.",
      "I asked it to open the page.",
      "It is not done yet.",
      "It has not reported that it is done.",
      "The page isn't open yet.",
      "It hasn't found the board.",
      "It found nothing yet.",
      "I don't know if the page is open.",
      "I cannot see whether the page is open.",
      "It tells you when it is done.",
      "Once the page is open, it looks for the board.",
      "It is done when the board shows.",
      "It will be done soon.",
      "It may have finished one more action.",
      "An action that was already sent may have finished.",
      "I sent it your answer.",
      "It worked on that for a minute.",
      "You should see it when it is done.",
      "It is at step 4 of at most 40.",
      "Not stuck. It's still working on that: step 4 of at most 40.",
      "No, I'm not stuck. It still runs, and it has not said it's done.",
      'It says: Working on "open example.com and find the roadmap board", step 4 of at most 40.',
      "It is still opening the page.",
      "It is typing the address now.",
      "It waits for your answer.",
      "You moved the mouse or pressed a key, so it paused.",
      "It paused because you clicked something.",
      "You said it's open, but the task has not reported that.",
      "Say stop and it stops.",
      "Is the page open on your side?",
      "It asks whether it should open the page in Chrome.",
      "I'm ready to help with that.",
      "That is up to you.",
      "It is open to question whether that works.",
      "Got it.",
      "No, I am not stuck.",
      'Its newest report: Working on: "check that the page is open". Step 2 of at most 40.',
      stillRuns,
      `The computer task waits for your answer: ${paused}`,
    ])
      expect([draft, screenClaims(draft)]).toEqual([draft, []]);
    // A yes is no claim after another question, with a "not" in it, or about a session.
    for (const [asked, draft] of [
      ["Are you still there?", "Yes."],
      ["Is it open?", "Yeah, not yet."],
      ["Is it open?", "No."],
      ["Is the docs session done?", "Yes."],
      ["Are the tests done?", "Yes."],
    ] as const)
      expect([
        asked,
        draft,
        screenClaims(draft, { asked, sessions: ["docs"] }),
      ]).toEqual([asked, draft, []]);
  });

  it("takes no sentence about a session or a job, none that a tool of the turn backs, and none in the engine's own words", () => {
    // A session by its name, and work that the supervisor manages.
    for (const draft of [
      "Docs is done.",
      "Docs opened a pull request.",
      "Two sessions are done and one waits for you.",
      "The job is done.",
      "The tests are finished.",
      "The pull request is open.",
    ])
      expect([draft, screenClaims(draft, { sessions: ["docs"] })]).toEqual([
        draft,
        [],
      ]);
    // A name that no session of the board has is no such name.
    expect(screenClaims("Docs is open.")).toHaveLength(1);
    // A name or a word that the task's own request holds can be the thing on
    // the screen: it makes no sentence a sentence about a session.
    const request =
      'Working on: "open the docs page and the deploy page". Step 2 of at most 40.';
    for (const draft of ["Docs is open.", "The deploy page is open."])
      expect([
        draft,
        screenClaims(draft, { sessions: ["docs"], report: request }),
      ]).toEqual([draft, [draft]]);
    // With no such word in the request, the sentence is read as one about a
    // deploy: the list of words decides, and it cannot tell a page from a
    // deploy.
    expect(
      screenClaims("The deploy page is open.", { report: working }),
    ).toEqual([]);
    // What a tool of this turn said: half of the naming words of the
    // sentence, or more, are in it.
    const told =
      'Job "find the biggest files in Downloads" is done. Its answer: Found three big files in Downloads.';
    for (const draft of [
      "It found three big files in Downloads.",
      "It found three large ones in Downloads.",
    ])
      expect([draft, screenClaims(draft, { told })]).toEqual([draft, []]);
    // The person asks about a job or a session: the answer is about that.
    for (const draft of ["Yes, it's done.", "It found them all."])
      expect([
        draft,
        screenClaims(draft, { asked: "did the job find the big files?" }),
      ]).toEqual([draft, []]);
    expect(screenClaims("It found the roadmap board.", { told })).toHaveLength(
      1,
    );
    // A sentence with no naming word has nothing that a tool could back.
    expect(screenClaims("It's done.", { told })).toHaveLength(1);
    expect(screenClaims("Typed it in.", { told })).toHaveLength(1);
    // The engine's own words, as its newest message has them, word for word:
    // a question of the task that says what it sees.
    const asks = "The page is open. Which board do you want?";
    expect(screenClaims("The page is open.", { report: asks })).toEqual([]);
    expect(screenClaims("The board is open.", { report: asks })).toHaveLength(
      1,
    );
    // Words of the request, which the worker quotes in its message, are no
    // report of a result.
    expect(
      screenClaims("example.com is open.", { report: working }),
    ).toHaveLength(1);
    expect(
      screenClaims("The page is open.", {
        report:
          'Working on: "make sure that the page is open". Step 2 of at most 40.',
      }),
    ).toHaveLength(1);
  });

  it("does not read the answer of a turn that did something through a gate, and reads it after a refused call", async () => {
    // Another engine than the worker: the tool for applications opens Chrome
    // in this turn, and its result stands behind the answer.
    const opens = withTask("running", working, { worker: false });
    expect(
      await new Supervisor(
        opens.value,
        drafts([
          [call("open_app", { name: "Google Chrome" })],
          "Chrome is open.",
        ]).model,
      ).reply([], "open chrome", "chat"),
    ).toBe("Chrome is open.");
    expect(opens.opened).toEqual(["Google Chrome -"]);
    // The gate refused the call (a question opens nothing): nothing stands
    // behind the same answer.
    const refused = withTask("running", working, { worker: false });
    expect(
      await new Supervisor(
        refused.value,
        drafts([
          [call("open_app", { name: "Google Chrome" })],
          "Chrome is open.",
        ]).model,
      ).reply([], "is chrome open?", "chat"),
    ).toBe(stillRuns);
    expect(refused.opened).toEqual([]);
    // The model asks to hand a question to the engine: the gate refuses, and
    // the claim after it is not sent.
    const asked = withTask("running", working);
    expect(
      await new Supervisor(
        asked.value,
        drafts([[call("delegate_computer_task")], "Yes, it is open."]).model,
      ).reply(before, "Is it open?", "call"),
    ).toBe(stillRuns);
    expect(asked.touched).toEqual([]);
  });

  it("lets an answer about a job stand while a computer task runs, and holds a claim about the screen beside it", async () => {
    const withJob = () => {
      const f = withTask("running", working);
      f.value.jobs = {
        start: async () => ({ ok: true, said: "started" }),
        recent: () => [
          {
            id: "job-1",
            job: "find the biggest files in Downloads",
            startedAt: now - 5 * 60_000,
            done: true,
            result: "Found three big files in Downloads.",
          },
        ],
      };
      return f;
    };
    const first = withJob();
    expect(
      await new Supervisor(
        first.value,
        drafts(["It found three big files in Downloads."]).model,
      ).reply([], "what did it find?", "chat"),
    ).toBe("It found three big files in Downloads.");
    // The job's answer does not back a claim about the screen.
    const second = withJob();
    expect(
      await new Supervisor(
        second.value,
        drafts(["It found the roadmap board."]).model,
      ).reply([], "what did it find?", "chat"),
    ).toBe(stillRuns);
    // The state that the code read holds the engine's own message with the
    // words of the request: they back no claim.
    const third = withJob();
    const run = drafts(["example.com is open."]);
    expect(
      await new Supervisor(third.value, run.model).reply(
        [],
        "what is everyone doing?",
        "chat",
      ),
    ).toBe(stillRuns);
    expect(toldByTools(run.given[0]!)).toContain(working);
  });

  it("leaves a message to the worker that waits for an answer, as before", async () => {
    // The worker asked something: the message is its answer, and the
    // worker's own sentence is the reply. No model is asked.
    const f = withTask("waiting_for_person", paused);
    const run = drafts([falseDraft]);
    expect(
      await new Supervisor(f.value, run.model).reply(
        before,
        "Are you stuck?",
        "call",
      ),
    ).toBe("No question waits.");
    expect(f.touched).toEqual(["answer Are you stuck?"]);
    expect(run.calls()).toBe(0);
  });

  it("says why the model gave no answer as before, also while a computer task runs", async () => {
    const silent: ModelClient = {
      async complete() {
        throw new Error("the model is down");
      },
    };
    const idle = withTask("idle", "Computer use is on.");
    const live = withTask("running", working);
    const words = "tell me a joke about the weather";
    const said = await new Supervisor(live.value, silent).reply(
      [],
      words,
      "chat",
    );
    expect(said).toBe(
      await new Supervisor(idle.value, silent).reply([], words, "chat"),
    );
    expect(said).toContain("language model");
    expect(live.touched).toEqual([]);
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
