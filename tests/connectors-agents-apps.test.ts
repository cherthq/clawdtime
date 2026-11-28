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
  guidesComputerTask,
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
import { interpret } from "../connectors/agents/call.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import type { Runner } from "../connectors/agents/focus.js";
import type { TaskPort } from "../connectors/agents/tasks.js";
import type { BoardSnapshot } from "../connectors/agents/types.js";
import { readMidTask, readWords } from "../connectors/computer/orders.js";
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
      waiting?: "takeover" | "approval" | "question";
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
      ...(options.waiting !== undefined ? { waiting: options.waiting } : {}),
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
    // The engine's own line, as it came through the chat by itself.
    const engineLine = "Opening TextEdit to close the Untitled document.";
    const said: ChatMessage[] = [
      { role: "user", text: "close the document", at: now, via: "chat" },
      {
        role: "assistant",
        text: engineLine,
        at: now,
        via: "chat",
        engine: true,
      },
    ];
    for (const draft of [
      "Done. Closed the Untitled document without saving and quit TextEdit.",
      // An older engine opened with this word.
      "Started. Done. Closed the document.",
    ])
      expect(speaksAsTheEngine(draft)).toBe(true);
    // A copy of a line that the engine said, known by the way it came.
    expect(speaksAsTheEngine(`Sure. ${engineLine}`, said)).toBe(true);
    expect(speaksAsTheEngine(engineLine)).toBe(false);
    expect(
      speaksAsTheEngine(engineLine, [{ ...said[1]!, engine: undefined }]),
    ).toBe(false);
    for (const draft of [
      "Two sessions work and one waits for you.",
      "It is done when the tests pass.",
      "I started a job for that.",
    ])
      expect(speaksAsTheEngine(draft, said)).toBe(false);
    // The model copies the engine's answers twice: the person hears what is true.
    const f = withExecution();
    const copies = scripted([
      "Done. Closed the Untitled document without saving and quit TextEdit.",
      engineLine,
    ]);
    expect(
      await new Supervisor(f.value, copies.model).reply(
        said,
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
    const f = withExecution("waiting_for_person", { waiting: "question" });
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
      text: "Opening example.com in Chrome to find the roadmap board.",
      at,
      via: "call",
      engine: true,
    },
    {
      role: "assistant",
      text: "That app is not installed. Should I open example.com in the browser?",
      at,
      via: "chat",
    },
    { role: "user", text: "just open it in Chrome", at, via: "call" },
    {
      role: "assistant",
      text: "Thank you. The task continues.",
      at,
      via: "call",
    },
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
      waiting?: "takeover" | "approval" | "question";
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
      ...(options.waiting !== undefined ? { waiting: options.waiting } : {}),
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
    // Answered directly by code without calling the model.
    expect(run.calls()).toBe(0);
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
        // A copy of the engine's first line: nothing started for a question.
        "Opening example.com in Chrome to find the roadmap board.",
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
    // A question: while a task runs, a remark would steer it, and a
    // question gets its answer from the state.
    const told = async (
      f: ReturnType<typeof withTask>,
      words = "does the page look right?",
    ) => {
      const run = drafts(["It still works on that."]);
      await new Supervisor(f.value, run.model).reply([], words, "chat");
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
    // A task that is idle or completed: nothing is added. Canceled has a true stopped sentence.
    for (const state of ["idle", "completed"])
      expect([
        state,
        await told(
          withTask(state, "Done. The page is open."),
          "the page looks weird",
        ),
      ]).toEqual([state, ""]);
    expect(
      await told(withTask("canceled", stopped), "the page looks weird"),
    ).toContain(
      `The computer task was stopped: it did not report that it is done. Its newest report: ${stopped}`,
    );
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
          "does the page look right?",
          "chat",
        ),
      ).toBe(sentence);
      expect(run.calls()).toBe(1);
      expect(f.touched).toEqual([]);
    }
    // Idle and completed have no state sentence; canceled has a true stopped sentence.
    for (const state of ["idle", "completed"])
      expect([
        state,
        computerTaskNow(withTask(state, "x").value.execution!.snapshot()),
      ]).toEqual([state, null]);
    expect(
      computerTaskNow(
        withTask("canceled", stopped).value.execution!.snapshot(),
      ),
    ).toBe(
      `The computer task was stopped: it did not report that it is done. Its newest report: ${stopped}`,
    );
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
        "does the page look right?",
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
      "I am waiting for your answer.",
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
    // A sentence with an explicit screen noun ("page") is still caught even if
    // it contains a coding word ("deploy").
    expect(
      screenClaims("The deploy page is open.", { report: working }),
    ).toEqual(["The deploy page is open."]);
    // What a tool of this turn said: half of the naming words of the
    // sentence, or more, are in it.
    const told =
      'Job "find the biggest files in Downloads" is done. Its answer: Found three big files in Downloads.';
    for (const draft of [
      "It found three big files in Downloads.",
      "It found three large ones in Downloads.",
    ])
      expect([draft, screenClaims(draft, { told })]).toEqual([draft, []]);
    // A bare "Yes." to a question about a job is not a screen claim; a draft
    // with an unbacked screen claim is still caught even when the question
    // mentioned a job or a session.
    expect(
      screenClaims("Yes.", { asked: "did the job find the big files?" }),
    ).toEqual([]);
    expect(
      screenClaims("The page is open.", {
        asked: "did the job find the big files?",
      }),
    ).toEqual(["The page is open."]);
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
    // The worker asked a planner question: the message is its answer, and the
    // worker's own sentence is the reply. No model is asked.
    const f = withTask("waiting_for_person", "Which workspace should I open?", {
      waiting: "question",
    });
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
    const words = "can you tell me a joke about the weather?";
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

describe("words for a running computer task reach its engine", () => {
  const goal = "open example.com and find the roadmap board";
  const working = `Working on: "${goal}". Step 19 of at most 40.`;
  const paused =
    "You moved the mouse or pressed a key, so I paused. Say continue to go on, or stop.";
  const approval =
    'Click "Send"? "Send" may be something that cannot be undone, or that speaks for you. Say yes to allow it, or no to stop.';
  const question = "Which workspace should I open?";
  const stopped = "Stopped. An action that was already sent may have finished.";
  const guided = "Got it. I added that to the task.";
  const resumed = "Got it. I added that, and the task continues.";
  const stillRuns = `The computer task still runs: it has not reported that it is done. Its newest report: ${working}`;
  const at = now - 60_000;
  const before: ChatMessage[] = [
    {
      role: "user",
      text: "Can you sort of open Slack for me and find the roadmap board?",
      at,
      via: "call",
    },
    {
      role: "assistant",
      text: "Opening the chat app to find the roadmap board.",
      at,
      via: "call",
      engine: true,
    },
  ];
  const deploySession: BoardSnapshot = {
    version: 1,
    generatedAt: now,
    intervalMs: 3000,
    counts: { needs_you: 0, working: 1, idle: 0, unknown: 0 },
    sessions: [
      {
        id: "1001_1",
        pid: 1001,
        agent: "claude-code",
        agentLabel: "Claude Code",
        agentVersion: "1.0.0",
        name: "deploy fix",
        project: "app",
        cwd: "/work/app",
        mode: "interactive",
        state: "working",
        detail: "turn_running",
        since: now - 120_000,
        source: "hook",
        startedAt: now - 300_000,
        spawnedBy: null,
        terminal: {
          tty: "ttys001",
          app: "Terminal",
          appPath: "/System/Applications/Utilities/Terminal.app",
          tmux: null,
          remote: false,
        },
        focus: "tab",
      },
    ],
  };

  function withWorker(
    state: string,
    message: string,
    options: {
      goal?: string;
      waiting?: "takeover" | "approval" | "question";
      pendingAction?: { id: string; description: string };
      board?: BoardSnapshot;
    } = {},
  ) {
    const f = world();
    const submitted: string[] = [];
    const answered: string[] = [];
    const typed: { session: string; text: string }[] = [];
    const focused: string[] = [];
    let stops = 0;
    if (options.board) f.value.board = () => options.board!;
    f.value.send = async (session, text) => {
      typed.push({ session: session.name ?? session.id, text });
      return { ok: true, route: "tty" };
    };
    f.value.focus = async (session) => {
      focused.push(session.name ?? session.id);
      return { ok: true };
    };
    const snapshot = {
      configured: true,
      mode: "native" as const,
      state,
      canStop: state === "running" || state === "waiting_for_person",
      message,
      ...(options.goal !== undefined ? { goal: options.goal } : {}),
      ...(options.waiting !== undefined ? { waiting: options.waiting } : {}),
      ...(options.pendingAction
        ? { pendingAction: options.pendingAction }
        : {}),
    };
    f.value.execution = {
      snapshot: () => snapshot,
      submit: async (_id, text) => {
        submitted.push(text);
        return {
          message: options.waiting === "takeover" ? resumed : guided,
        };
      },
      stop: () => {
        stops++;
        return {
          ...snapshot,
          state: "canceled",
          canStop: false,
          message: stopped,
        };
      },
      answer: async (text: string) => {
        answered.push(text);
        return {
          message:
            options.waiting === "question"
              ? "Thank you. The task continues."
              : "Continuing.",
        };
      },
    };
    return { ...f, submitted, answered, typed, focused, stops: () => stops };
  }

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

  it("takes orders and polite requests via the shared readWords reader", () => {
    for (const words of [
      "open it in the browser",
      "just hit enter",
      "Can you just hit enter?",
      "press return",
      "can you open it on the browser?",
      "I don't see it open. Can you open it on the browser?",
      "I don't still see Slack to be open. Can you open Slack on Chrome?",
      "Uh just open it in Chrome, bro.",
      "Bro, just open app.example.com on Google Chrome.",
      "scroll down",
      "click the first one",
      "try the search box",
      "use Chrome instead",
      "go back",
      "switch to the other tab",
    ])
      expect([words, guidesComputerTask(words)]).toEqual([words, true]);
    for (const words of ["no, the other tab", "in the browser instead"])
      expect([words, guidesComputerTask(words)]).toEqual([words, false]);
  });

  it("takes no stop, state question, thanks, bare word, greeting, session message or coding work", () => {
    for (const words of [
      "stop",
      "stop it",
      "stop the task",
      "cancel",
      "abort",
      "are you stuck?",
      "Are you stuck somewhere? Do you want help anywhere?",
      "what are you doing?",
      "is it open?",
      "do you need help?",
      "how is it going?",
      "did it work?",
      "computer status",
      "can you tell me if it's open?",
      "can you check the status?",
      "thanks",
      "thank you",
      "awesome, thanks",
      "nice work",
      "yes",
      "no",
      "ok",
      "okay",
      "sure",
      "continue",
      "approve",
      "deny",
      "hi",
      "hey",
      "hello",
      "good morning",
      "tell me a joke about the weather",
      "what is everyone doing?",
      "is deploy fix done?",
      "what did the job find?",
      "tell deploy fix to push",
      "watch deploy fix and tell me when it's done",
      "also build a landing page for the bakery",
      "find out why the build is slow",
      "find out why the login is slow",
      "fix the flaky test",
      "write a script to clean the logs",
      "open Claude and build a landing page",
      "use Codex to fix the tests",
      "run the tests again",
      "don't hit enter",
      "do not open it",
      "never mind",
      "clear the computer task",
      "remember to use dark mode",
      "what does the blue Send button do?",
      '"click the button"',
      "I clicked the button",
      "the search box is empty",
    ])
      expect([words, guidesComputerTask(words)]).toEqual([words, false]);
  });

  it("hands follow-up screen requests to the engine even when the model would offer, ask back or falsely claim", async () => {
    for (const words of [
      "I don't still see Slack to be open. Can you open Slack on Chrome?",
      "I don't see it open. Can you open it on the browser?",
      "Uh just open it in Chrome, bro.",
      "Bro, just open app.example.com on Google Chrome.",
      "open it in the browser",
      "scroll down",
      "click the first one",
      "try the search box",
    ])
      for (const draft of [
        "You want me to open it on the browser now?",
        "Should I go ahead and open it now?",
        "so I opened Chrome with example.com",
      ]) {
        const f = withWorker("running", working, { goal });
        const run = drafts([draft]);
        run.model.reading = async () => ({
          intent: { kind: "clarify", question: "Which app did you mean?" },
          work: false,
        });
        const said = await new Supervisor(f.value, run.model).reply(
          before,
          words,
          "call",
        );
        expect([words, draft, said]).toEqual([words, draft, guided]);
        expect(f.submitted).toEqual([words]);
        expect(f.answered).toEqual([]);
      }
  });

  it("hands 'Can you just hit enter?' to the engine even when the model would answer with the state or refuse", async () => {
    for (const draft of [
      "The task is still running, currently on step 19, not done yet. Want me to keep waiting or do something else?",
      "The task is still running, so I can't hit Enter in it right now.",
      stillRuns,
    ]) {
      const f = withWorker("running", working, { goal });
      const run = drafts([draft]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        "Can you just hit enter?",
        "call",
      );
      expect([draft, said]).toEqual([draft, guided]);
      expect(f.submitted).toEqual(["Can you just hit enter?"]);
      expect(f.answered).toEqual([]);
    }
  });

  it("hands words outside the screen grammar to the running task, with no offer and no question back", async () => {
    const words = "put hello into the right-hand input";
    // The strict reader of orders still reads no order here.
    expect(guidesComputerTask(words)).toBe(false);
    for (const draft of [
      "You want me to put hello into the right-hand input now?",
      "Should I go ahead and put hello into the right-hand input?",
      "The task is still running, so I can't put that in right now.",
      "The task is still running, currently on step 19, not done yet. Want me to keep waiting or do something else?",
    ]) {
      const f = withWorker("running", working, { goal });
      const run = drafts([draft]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([draft, said]).toEqual([draft, guided]);
      expect(f.submitted).toEqual([words]);
      expect(f.answered).toEqual([]);
      expect(f.started).toEqual([]);
      expect(run.calls()).toBe(0);
    }
  });

  it("steers a task paused by takeover through submit, keeps continue on answer, and reports paused with its goal", async () => {
    const pausedSentence = `The computer task ("${goal}") is paused: it has not reported that it is done. Its newest report: ${paused}`;
    expect(
      computerTaskNow({
        configured: true,
        mode: "native",
        state: "waiting_for_person",
        waiting: "takeover",
        canStop: true,
        goal,
        message: paused,
      }),
    ).toBe(pausedSentence);
    expect(screenClaims(pausedSentence)).toEqual([]);
    expect(
      computerTaskNow({
        configured: true,
        mode: "native",
        state: "running",
        canStop: true,
        goal,
        message: "Step 4 of at most 40.",
      }),
    ).toBe(
      `The computer task ("${goal}") still runs: it has not reported that it is done. Its newest report: Step 4 of at most 40.`,
    );

    // Screen instruction while paused on takeover goes to submit, not answer.
    for (const words of [
      "Can you just hit enter?",
      "I don't see it open. Can you open it on the browser?",
    ]) {
      const f = withWorker("waiting_for_person", paused, {
        goal,
        waiting: "takeover",
      });
      const run = drafts(["Should I go ahead and do that?"]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect(said).toBe(resumed);
      expect(f.submitted).toEqual([words]);
      expect(f.answered).toEqual([]);
    }

    // "continue" while paused on takeover still goes to answer.
    const cont = withWorker("waiting_for_person", paused, {
      goal,
      waiting: "takeover",
    });
    expect(
      await new Supervisor(cont.value, drafts(["Continuing."]).model).reply(
        before,
        "continue",
        "call",
      ),
    ).toBe("Continuing.");
    expect(cont.answered).toEqual(["continue"]);
    expect(cont.submitted).toEqual([]);

    // Non-order, non-stop, non-continue words at takeover take origin/main's answer path.
    const ask = withWorker("waiting_for_person", paused, {
      goal,
      waiting: "takeover",
    });
    const run = drafts(["Yes, the page is open."]);
    expect(
      await new Supervisor(ask.value, run.model).reply(
        before,
        "Are you stuck?",
        "call",
      ),
    ).toBe("Continuing.");
    expect(ask.submitted).toEqual([]);
    expect(ask.answered).toEqual(["Are you stuck?"]);
  });

  it("answers a state question from the engine state with no submit, and gives the model a true note on remarks", async () => {
    for (const words of [
      "Are you stuck somewhere? Do you want help anywhere?",
      "what are you doing?",
      "is it open?",
      "do you need help?",
    ]) {
      const f = withWorker("running", working, { goal });
      const run = drafts(["Yes, the page is open and ready."]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, said]).toEqual([words, stillRuns]);
      expect(f.submitted).toEqual([]);
      expect(f.answered).toEqual([]);
      expect(run.calls()).toBe(0);
    }
    // A remark steers the task now. A question that is no state question
    // goes to the model, with the note.
    const remark = withWorker("running", working, { goal });
    const remarkRun = drafts(["It still runs."]);
    await new Supervisor(remark.value, remarkRun.model).reply(
      before,
      "does the page look right?",
      "call",
    );
    const note = remarkRun.given[0]!.filter(
      (message) => message.role === "tool",
    )
      .map((message) => message.content)
      .join("\n");
    expect(note).toContain("delegate_computer_task");
    expect(note).toContain("no offer and no question back");
    expect(note).not.toContain("replaced by handing them to the engine");
  });

  it("starts coding work beside a running screen task with no submit", async () => {
    const direct = withWorker("running", working, { goal });
    const saidDirect = await new Supervisor(
      direct.value,
      drafts(["Should I start a job?"]).model,
    ).reply(before, "also build a landing page for the bakery", "call");
    expect(saidDirect).toBe("I started a new session for that job.");
    expect(direct.started).toEqual([
      "also build a landing page for the bakery",
    ]);
    expect(direct.submitted).toEqual([]);

    const slow = withWorker("running", working, { goal });
    const slowModel = drafts([
      "Should I start a job to look into why the build is slow?",
      [call("start_job", { job: "find out why the build is slow" })],
      "Started.",
    ]);
    const saidSlow = await new Supervisor(slow.value, slowModel.model).reply(
      before,
      "find out why the build is slow",
      "call",
    );
    expect(saidSlow).toBe("I started a new session for that job.");
    expect(slow.started).toEqual(["find out why the build is slow"]);
    expect(slow.submitted).toEqual([]);
  });

  it("routes words for a coding session to that session, with no submit", async () => {
    const tell = withWorker("running", working, {
      goal,
      board: deploySession,
    });
    const said = await new Supervisor(
      tell.value,
      drafts(["I told deploy fix to push."]).model,
    ).reply(before, "tell deploy fix to push", "call");
    expect(said).toBe("I told deploy fix to push.");
    expect(tell.typed).toEqual([{ session: "deploy fix", text: "push" }]);
    expect(tell.submitted).toEqual([]);

    const open = withWorker("running", working, {
      goal,
      board: deploySession,
    });
    await new Supervisor(
      open.value,
      drafts(["Brought deploy fix to the front."]).model,
    ).reply(before, "open deploy fix", "call");
    expect(open.focused).toEqual(["deploy fix"]);
    expect(open.submitted).toEqual([]);
  });

  it("leaves thanks, greetings and bare yes/no off submit, and keeps stop on the stop path", async () => {
    for (const [words, draft] of [
      ["thanks", "Any time."],
      ["hey", "Hey, what can I help with?"],
    ] as const) {
      const f = withWorker("running", working, { goal });
      const run = drafts([draft]);
      expect(
        await new Supervisor(f.value, run.model).reply(before, words, "call"),
      ).toBe(draft);
      expect(f.submitted).toEqual([]);
      expect(f.stops()).toBe(0);
    }

    const bare = withWorker("running", working, { goal });
    await new Supervisor(bare.value, drafts(["Okay."]).model).reply(
      before,
      "yes",
      "call",
    );
    expect(bare.submitted).toEqual([]);

    for (const stopWord of ["stop", "stop it", "cancel"]) {
      const f = withWorker("running", working, { goal });
      const run = drafts(["Should I stop it?"]);
      expect(
        await new Supervisor(f.value, run.model).reply(
          before,
          stopWord,
          "call",
        ),
      ).toBe(stopped);
      expect(f.stops()).toBe(1);
      expect(f.submitted).toEqual([]);
      expect(run.calls()).toBe(0);
    }
  });

  it("routes approval bare decisions to answer and other words to submit, question to answer, and refuses submit on panel approval", async () => {
    for (const words of [
      "Can you just hit enter?",
      "open it in the browser",
      "yes",
    ]) {
      const q = withWorker("waiting_for_person", question, {
        goal,
        waiting: "question",
      });
      const qRun = drafts(["Should I do that?"]);
      const qSaid = await new Supervisor(q.value, qRun.model).reply(
        before,
        words,
        "call",
      );
      expect(["question", words, q.answered, q.submitted]).toEqual([
        "question",
        words,
        [words],
        [],
      ]);
      expect(qSaid).toBe("Thank you. The task continues.");
      expect(qRun.calls()).toBe(0);
    }

    const aYes = withWorker("waiting_for_person", approval, {
      goal,
      waiting: "approval",
    });
    const beforeApproval: ChatMessage[] = [
      ...before,
      { role: "assistant", text: approval, at: at + 10_000, via: "call" },
    ];
    expect(
      await new Supervisor(
        aYes.value,
        drafts(["Should I do that?"]).model,
      ).reply(beforeApproval, "yes", "call"),
    ).toBe("Continuing.");
    expect(aYes.answered).toEqual(["yes"]);
    expect(aYes.submitted).toEqual([]);

    for (const words of ["Can you just hit enter?", "open it in the browser"]) {
      const aOther = withWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
      });
      await new Supervisor(
        aOther.value,
        drafts(["Should I do that?"]).model,
      ).reply(before, words, "call");
      expect(aOther.answered).toEqual([]);
      expect(aOther.submitted).toEqual([words]);
    }

    const pending = withWorker("running", "An action waits.", {
      goal,
      pendingAction: { id: "a1", description: "Click Send" },
    });
    const saidYes = await new Supervisor(
      pending.value,
      drafts(["Approved."]).model,
    ).reply(before, "yes", "call");
    expect(saidYes).toContain("Use Approve action or Deny action");
    expect(pending.submitted).toEqual([]);
    expect(pending.answered).toEqual([]);

    const pendingGuide = withWorker("running", "An action waits.", {
      goal,
      pendingAction: { id: "a1", description: "Click Send" },
    });
    await new Supervisor(
      pendingGuide.value,
      drafts(["It waits for your approval in the panel."]).model,
    ).reply(before, "Can you just hit enter?", "call");
    expect(pendingGuide.submitted).toEqual([]);
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

describe("chat routing safety and truth for computer tasks", () => {
  const goal = "open example.com and find the roadmap board";
  const working = `Working on: "${goal}". Step 19 of at most 40.`;
  const paused =
    "You moved the mouse or pressed a key, so I paused. Say continue to go on, or stop.";
  const approval =
    'Click "Send"? "Send" may be something that cannot be undone, or that speaks for you. Say yes to allow it, or no to stop.';
  const question = "Which workspace should I open?";
  const startedText = "Opening the chat app to find the roadmap board.";
  const stoppedText =
    "Stopped. An action that was already sent may have finished.";
  const guidedText = "Got it. I added that to the task.";
  const resumedText = "Got it. I added that, and the task continues.";
  const asideApprovalText =
    "Got it. That was not a yes, so I did not do that step. I added your words and will choose the next step again.";
  const stillRuns = `The computer task still runs: it has not reported that it is done. Its newest report: ${working}`;
  const deflectionDraft =
    "The task is still running, currently on step 19, not done yet. Want me to keep waiting or do something else?";
  const at = now - 60_000;
  const before: ChatMessage[] = [
    {
      role: "user",
      text: "Can you sort of open Slack for me and find the roadmap board?",
      at,
      via: "call",
    },
    {
      role: "assistant",
      text: startedText,
      at,
      via: "call",
      engine: true,
    },
  ];
  const sessionBoard = (name: string): BoardSnapshot => ({
    version: 1,
    generatedAt: now,
    intervalMs: 3000,
    counts: { needs_you: 0, working: 1, idle: 0, unknown: 0 },
    sessions: [
      {
        id: "1001_1",
        pid: 1001,
        agent: "claude-code",
        agentLabel: "Claude Code",
        agentVersion: "1.0.0",
        name,
        project: "app",
        cwd: "/work/app",
        mode: "interactive",
        state: "working",
        detail: "turn_running",
        since: now - 120_000,
        source: "hook",
        startedAt: now - 300_000,
        spawnedBy: null,
        terminal: {
          tty: "ttys001",
          app: "Terminal",
          appPath: "/System/Applications/Utilities/Terminal.app",
          tmux: null,
          remote: false,
        },
        focus: "tab",
      },
    ],
  });

  function withFakeWorker(
    state: string,
    message: string,
    options: {
      mode?: "native" | "browser";
      worker?: boolean;
      goal?: string;
      waiting?: "takeover" | "approval" | "question";
      pendingAction?: { id: string; description: string };
      board?: BoardSnapshot;
      codingTaskRunning?: boolean;
      pendingDesk?: boolean;
    } = {},
  ) {
    const f = world();
    const submitted: string[] = [];
    const answered: string[] = [];
    let execStops = 0;
    let taskCancels = 0;
    if (options.board) f.value.board = () => options.board!;
    if (options.pendingDesk) {
      f.value.desk.pending = () => [
        {
          version: 1,
          id: "0123456789abcdef",
          agent: "claude-code",
          sessionKey: "0123456789abcdef0123456789abcdef",
          cwd: "/work/app",
          pids: [1001],
          kind: "permission",
          tool: "Bash",
          summary: "npm test",
          pattern: "npm test",
          options: [],
          createdAt: now - 10_000,
          holdUntil: now + 60_000,
        },
      ];
    }
    if (options.codingTaskRunning) {
      f.value.tasks = {
        current: () => ({
          goal: "fix the login tests",
          state: "running",
          summary: "Running login tests.",
          question: null,
          choices: [],
          canAnswer: false,
          canAccept: false,
          canCancel: true,
        }),
        canStart: () => false,
        start: async () => ({ ok: false, message: "Busy." }),
        answer: async () => ({ ok: false, message: "" }),
        accept: async () => ({ ok: false, message: "" }),
        cancel: async () => {
          taskCancels++;
          return { ok: true, message: "Coding task canceled." };
        },
      };
    }
    const snapshot = {
      configured: true,
      mode: options.mode ?? ("native" as const),
      state,
      canStop: state === "running" || state === "waiting_for_person",
      message,
      ...(options.goal !== undefined ? { goal: options.goal } : {}),
      ...(options.waiting !== undefined ? { waiting: options.waiting } : {}),
      ...(options.pendingAction
        ? { pendingAction: options.pendingAction }
        : {}),
    };
    const submitReply = () => {
      if (state === "idle") return startedText;
      if (options.waiting === "takeover") return resumedText;
      if (options.waiting === "approval") return asideApprovalText;
      return guidedText;
    };
    f.value.execution = {
      snapshot: () => snapshot,
      submit: async (_id, text) => {
        submitted.push(text);
        return { message: submitReply() };
      },
      submitRead: async (_id, text) => {
        submitted.push(text);
        return { message: submitReply() };
      },
      stop: () => {
        execStops++;
        return {
          ...snapshot,
          state: "canceled",
          canStop: false,
          message: stoppedText,
        };
      },
      ...(options.worker === false
        ? {}
        : {
            answer: async (text: string) => {
              answered.push(text);
              return {
                message:
                  options.waiting === "question"
                    ? "Thank you. The task continues."
                    : "Continuing.",
              };
            },
          }),
    };
    return {
      ...f,
      submitted,
      answered,
      execStops: () => execStops,
      taskCancels: () => taskCancels,
    };
  }

  function scriptedChat(steps: (ToolCall[] | string)[]) {
    let step = 0;
    const inputs: {
      system: string;
      messages: ModelMessage[];
      tools: { name: string; description: string }[];
    }[] = [];
    const model: ModelClient = {
      async complete(input) {
        inputs.push({
          system: input.system,
          messages: [...input.messages],
          tools: input.tools.map((t) => ({
            name: t.name,
            description: t.description,
          })),
        });
        const next = steps[Math.min(step++, steps.length - 1)]!;
        return typeof next === "string"
          ? { text: next, toolCalls: [] }
          : { text: "", toolCalls: next };
      },
    };
    return { model, inputs, calls: () => step };
  }

  it("blocker 1, now: remarks, waits, negations and dictation go to the running task, whatever the model would offer or deflect", async () => {
    const cases: [string, string][] = [
      ["the page looks weird", "Should I refresh the page?"],
      ["the page looks weird", deflectionDraft],
      ["I opened it myself", "Want me to switch to that window?"],
      ["I opened it myself", deflectionDraft],
      ["wait for me", deflectionDraft],
      ["hold on a second", deflectionDraft],
      ["pause it", deflectionDraft],
      ["tell me what you see", deflectionDraft],
      ["don't open it. Wait for me.", deflectionDraft],
      ["never open that", "Should I open it?"],
      ["hey mom I'm on my way grab dinner", deflectionDraft],
      [
        "put hello into the right-hand input",
        "Should I go ahead and put hello into the right-hand input?",
      ],
    ];
    for (const [words, draft] of cases) {
      const f = withFakeWorker("running", working, { goal });
      const run = scriptedChat([draft]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      // The worker reads the words: a wait pauses, everything else steers.
      expect([words, f.submitted, said, run.calls()]).toEqual([
        words,
        [words],
        guidedText,
        0,
      ]);
      expect(f.answered).toEqual([]);
      expect(f.execStops()).toBe(0);
    }
    // A question gets its answer from the state, and goes to no worker.
    for (const words of ["is it open?", "what do you see on the page?"]) {
      const f = withFakeWorker("running", working, { goal });
      await new Supervisor(
        f.value,
        scriptedChat([deflectionDraft]).model,
      ).reply(before, words, "call");
      expect([words, f.submitted]).toEqual([words, []]);
    }
  });

  it("blocker 2: natural stops call execution.stop() before anything else while a screen task can stop", async () => {
    for (const words of [
      "ok stop",
      "hey stop",
      "wait stop",
      "stop please",
      "stop now",
      "stop the computer",
      "pls stop",
    ]) {
      const f = withFakeWorker("running", working, { goal });
      const run = scriptedChat([deflectionDraft]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, f.execStops(), f.submitted, run.calls(), said]).toEqual([
        words,
        1,
        [],
        0,
        stoppedText,
      ]);
    }
  });

  it("blocker 2: when a coding task and a screen task both run, an unqualified stop stops the screen task and says which one stopped", async () => {
    for (const words of ["stop", "ok stop", "stop it", "stop the task"]) {
      const f = withFakeWorker("running", working, {
        goal,
        codingTaskRunning: true,
      });
      const run = scriptedChat([deflectionDraft]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, f.execStops(), f.taskCancels(), run.calls()]).toEqual([
        words,
        1,
        0,
        0,
      ]);
      expect(said).toContain("computer task");
      expect(said).toContain("coding task");
      expect(said).toContain(stoppedText);
    }
    const named = withFakeWorker("running", working, {
      goal,
      codingTaskRunning: true,
    });
    const saidNamed = await new Supervisor(
      named.value,
      scriptedChat([deflectionDraft]).model,
    ).reply(before, "stop the computer", "call");
    expect(named.execStops()).toBe(1);
    expect(named.taskCancels()).toBe(0);
    expect(saidNamed).toBe(stoppedText);

    const buildStop = withFakeWorker("running", working, { goal });
    await new Supervisor(
      buildStop.value,
      scriptedChat(["I cannot stop the build."]).model,
    ).reply(before, "stop the build", "call");
    expect(buildStop.execStops()).toBe(0);
    expect(buildStop.submitted).toEqual([]);
  });

  it("blocker 3, now: coding work and full session names never go to submit; speech and later times steer the running task", async () => {
    const codingMessages = [
      "open the settings file and fix the typo",
      "open package.json and bump the version",
      "push it to origin",
      "search for TODO in the project",
      "find out why the login is slow",
      "tell Claude to run the tests",
    ];
    for (const words of codingMessages) {
      expect([words, guidesComputerTask(words)]).toEqual([words, false]);
      const f = withFakeWorker("running", working, { goal });
      const run = scriptedChat([
        [call("start_job", { job: words })],
        "Started.",
      ]);
      await new Supervisor(f.value, run.model).reply(before, words, "call");
      expect([words, f.submitted]).toEqual([words, []]);
      expect(run.calls()).toBeGreaterThan(0);
    }

    for (const words of [
      "I'm at the gate. Open the door please.",
      "I'm stuck in traffic. Go to the restaurant without me.",
      "hey mom grab dinner",
      "open it later",
      "open it when I get back",
      "don't open it. Open it when I get back.",
      "look at the screen and tell me what it says",
    ]) {
      // No order for the strict reader, and words for the task all the same.
      expect([words, guidesComputerTask(words)]).toEqual([words, false]);
      const f = withFakeWorker("running", working, { goal });
      const run = scriptedChat(["Okay."]);
      await new Supervisor(f.value, run.model).reply(before, words, "call");
      expect([words, f.submitted]).toEqual([words, [words]]);
    }

    for (const words of [
      "open payments api",
      "switch to payments api",
      "type yes in payments api",
    ]) {
      const f = withFakeWorker("running", working, {
        goal,
        board: sessionBoard("payments api"),
      });
      const run = scriptedChat(["Okay."]);
      await new Supervisor(f.value, run.model).reply(before, words, "call");
      expect([words, f.submitted, run.calls() > 0]).toEqual([words, [], true]);
    }
  });

  it("rest 7 and owner flow: casual fillers, question-then-order, and the four owner messages work", async () => {
    for (const words of [
      "bro just hit enter",
      "bro can u open it in chrome?",
      "yeah hit enter",
      "alright press return",
      "yo click the first one",
      "dude scroll down",
      "yep open it in the browser",
      "Uh just open it in Chrome, bro.",
      "Bro, just open app.example.com on Google Chrome.",
    ]) {
      expect([words, guidesComputerTask(words)]).toEqual([words, true]);
      const f = withFakeWorker("running", working, { goal });
      const run = scriptedChat([deflectionDraft]);
      run.model.reading = async () => ({
        intent: { kind: "clarify", question: "Which app did you mean?" },
        work: false,
      });
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, f.submitted, said]).toEqual([words, [words], guidedText]);
    }

    // Owner message 1: start the task when idle.
    const startF = withFakeWorker("idle", "Computer use is on.");
    const startRun = scriptedChat(["Okay."]);
    startRun.model.reading = async () => ({
      intent: { kind: "none" },
      work: true,
    });
    const owner1 =
      "Can you sort of open Slack for me and find the roadmap board?";
    expect(
      await new Supervisor(startF.value, startRun.model).reply(
        [],
        owner1,
        "call",
      ),
    ).toBe(startedText);
    expect(startF.submitted).toEqual([owner1]);

    // Owner message 2: state question gets true state without calling model.
    const askF = withFakeWorker("running", working, { goal });
    const askRun = scriptedChat(["Yes, it is open."]);
    expect(
      await new Supervisor(askF.value, askRun.model).reply(
        before,
        "Are you stuck somewhere? Do you want help anywhere?",
        "call",
      ),
    ).toBe(stillRuns);
    expect(askRun.calls()).toBe(0);
    expect(askF.submitted).toEqual([]);

    // Owner messages 3 and 4: steering orders reach the engine.
    for (const words of [
      "I don't still see Slack to be open. Can you open Slack on Chrome?",
      "Can you just hit enter?",
    ]) {
      const f = withFakeWorker("running", working, { goal });
      const run = scriptedChat([deflectionDraft]);
      expect(
        await new Supervisor(f.value, run.model).reply(before, words, "call"),
      ).toBe(guidedText);
      expect(f.submitted).toEqual([words]);
    }
  });

  it("blocker 4: delegate refuses submit while pendingAction or waiting_for_person waits across all shortcuts and tool calls", async () => {
    for (const mode of ["native", "browser"] as const) {
      for (const words of ["open it in the browser", "check my inbox"]) {
        const f = withFakeWorker("running", "An action waits.", {
          mode,
          worker: mode === "native",
          goal,
          pendingAction: { id: "a1", description: "Click Send" },
        });
        const said = await new Supervisor(
          f.value,
          scriptedChat(["Okay."]).model,
        ).reply(before, words, "call");
        expect([mode, words, f.submitted]).toEqual([mode, words, []]);
        expect(said).toContain("Click Send");
        expect(said).toContain("Approve action or Deny action");
      }
    }

    const viaTool = withFakeWorker("running", "An action waits.", {
      goal,
      pendingAction: { id: "a1", description: "Click Send" },
    });
    const toolRun = scriptedChat([
      [call("delegate_computer_task")],
      "The task waits for your approval of Click Send in the desktop panel.",
    ]);
    const saidTool = await new Supervisor(viaTool.value, toolRun.model).reply(
      before,
      "press return",
      "call",
    );
    expect(viaTool.submitted).toEqual([]);
    expect(saidTool).toContain("Click Send");

    const nonWorkerWaiting = withFakeWorker("waiting_for_person", approval, {
      worker: false,
      goal,
      waiting: "approval",
    });
    const saidWaiting = await new Supervisor(
      nonWorkerWaiting.value,
      scriptedChat(["Okay."]).model,
    ).reply(before, "open it in the browser", "call");
    expect(nonWorkerWaiting.submitted).toEqual([]);
    expect(saidWaiting).toContain("waits for your answer");
    expect(saidWaiting).toContain(approval);
  });

  it("blocker 5: approval takes only seen explicit yes or explicit no to answer and orders to submit; question takes answers; takeover goes on with any message", async () => {
    const beforeApproval: ChatMessage[] = [
      ...before,
      { role: "assistant", text: approval, at: at + 10_000, via: "call" },
    ];
    // waiting === "approval": seen explicit yes and explicit no -> answer (nah/nope mapped to "no"); orders -> submit (set aside).
    for (const [words, sent] of [
      ["yes", "yes"],
      ["no", "no"],
      ["nope", "no"],
      ["nah", "no"],
    ] as const) {
      const f = withFakeWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
      });
      const said = await new Supervisor(
        f.value,
        scriptedChat(["Okay."]).model,
      ).reply(beforeApproval, words, "call");
      expect([words, f.answered, f.submitted, said]).toEqual([
        words,
        [sent],
        [],
        "Continuing.",
      ]);
    }
    for (const words of [
      "ok, open it in the browser",
      "Can you just hit enter?",
    ]) {
      const f = withFakeWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
      });
      const said = await new Supervisor(
        f.value,
        scriptedChat(["Okay."]).model,
      ).reply(beforeApproval, words, "call");
      expect([words, f.answered, f.submitted, said]).toEqual([
        words,
        [],
        [words],
        asideApprovalText,
      ]);
    }

    // waiting === "question": words go to answer.
    const qF = withFakeWorker("waiting_for_person", question, {
      goal,
      waiting: "question",
    });
    expect(
      await new Supervisor(qF.value, scriptedChat(["Okay."]).model).reply(
        before,
        "open the engineering workspace",
        "call",
      ),
    ).toBe("Thank you. The task continues.");
    expect(qF.answered).toEqual(["open the engineering workspace"]);
    expect(qF.submitted).toEqual([]);

    // waiting === "takeover": continue -> answer; stop -> stop; order -> submit; bare decision -> paused state without resuming; other -> normal path.
    for (const words of [
      "continue",
      "go on",
      "resume",
      "carry on",
      "keep going",
      "go ahead",
    ]) {
      const f = withFakeWorker("waiting_for_person", paused, {
        goal,
        waiting: "takeover",
      });
      const said = await new Supervisor(
        f.value,
        scriptedChat(["Okay."]).model,
      ).reply(before, words, "call");
      expect([words, f.answered, f.submitted, f.execStops(), said]).toEqual([
        words,
        [words],
        [],
        0,
        "Continuing.",
      ]);
    }
    for (const words of ["stop", "ok stop"]) {
      const f = withFakeWorker("waiting_for_person", paused, {
        goal,
        waiting: "takeover",
      });
      const said = await new Supervisor(
        f.value,
        scriptedChat(["Okay."]).model,
      ).reply(before, words, "call");
      expect([words, f.answered, f.submitted, f.execStops(), said]).toEqual([
        words,
        [],
        [],
        1,
        stoppedText,
      ]);
    }
    // A bare ok or yes at takeover carries nothing to steer with: it goes to
    // the worker as the answer, and the worker goes on.
    for (const words of ["ok", "okay", "sure", "yes"]) {
      const f = withFakeWorker("waiting_for_person", paused, {
        goal,
        waiting: "takeover",
      });
      const run = scriptedChat(["Okay."]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, f.answered, f.submitted, f.execStops(), said]).toEqual([
        words,
        [words],
        [],
        0,
        "Continuing.",
      ]);
    }
    // Any other words at takeover steer: they go into the task, and it goes on.
    for (const words of ["approve", "hmm", "no, the other tab"]) {
      const f = withFakeWorker("waiting_for_person", paused, {
        goal,
        waiting: "takeover",
      });
      const run = scriptedChat(["Okay."]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, f.answered, f.submitted, f.execStops(), said]).toEqual([
        words,
        [],
        [words],
        0,
        resumedText,
      ]);
    }
  });

  it("blocker 6: screen-task questions get computerTaskNow without calling the model, widened screenClaims catches hallucinations, and uncertain/blocked have true state sentences", async () => {
    for (const words of [
      "are you stuck?",
      "is it open?",
      "is it loaded?",
      "where are you?",
      "what are you doing?",
      "is it done?",
      "do you need help?",
    ]) {
      const f = withFakeWorker("running", working, { goal });
      const run = scriptedChat(["I hit enter for you."]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, run.calls(), f.submitted, said]).toEqual([
        words,
        0,
        [],
        stillRuns,
      ]);
    }
    for (const words of ["did you hit enter?", "did it send?"]) {
      const f = withFakeWorker("running", working, { goal });
      const run = scriptedChat(["I hit enter for you."]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, f.submitted, said]).toEqual([words, [], stillRuns]);
    }

    for (const draft of [
      "I hit enter for you.",
      "I scrolled down to the roadmap section.",
      "I refreshed the page.",
      "I reloaded the page.",
      "I dismissed the popup.",
      "I pasted the address into the bar.",
      "I downloaded the report.",
      "I copied the link.",
      "I cleared the search box.",
      "I picked the second option.",
      "I chose the first tab.",
      "I dragged the window over.",
      "The message was sent.",
      "The form was submitted.",
      "The form was filled out.",
      "You're signed in and on the roadmap page now.",
      "You're logged in.",
      "I'm not stuck and example.com is open.",
      "No worries I opened example.com in Chrome.",
      "We're on example.com now and Chrome displays the roadmap board.",
      "I can see the roadmap board in Chrome.",
      "Chrome is showing the roadmap board.",
      "The agent opened example.com in Chrome.",
      "I clicked the deploy button and the page is loaded.",
    ]) {
      expect([draft, screenClaims(draft).length > 0]).toEqual([draft, true]);
    }

    // Do not exempt a whole draft because the message named a session or coding word.
    const mixedSession = withFakeWorker("running", working, {
      goal,
      board: sessionBoard("deploy fix"),
    });
    expect(
      await new Supervisor(
        mixedSession.value,
        scriptedChat([
          "Deploy fix is working. Example.com is open and ready in Chrome.",
        ]).model,
      ).reply(before, "How is deploy fix, and is example.com open?", "call"),
    ).toBe(stillRuns);

    const mixedRepo = withFakeWorker("running", working, { goal });
    expect(
      await new Supervisor(
        mixedRepo.value,
        scriptedChat(["Yes, example.com is open and ready in Chrome."]).model,
      ).reply(before, "Is the repo page open in Chrome?", "call"),
    ).toBe(stillRuns);

    // uncertain and blocked have true state sentences and catch false claims.
    const uncertainMsg =
      'An earlier computer task has an unknown result: "open example.com". It is not run again.';
    const uncertainState = computerTaskNow({
      configured: true,
      mode: "native",
      state: "uncertain",
      canStop: false,
      message: uncertainMsg,
    });
    expect(uncertainState).toContain("unknown result");
    expect(uncertainState).toContain(uncertainMsg);
    expect(screenClaims(uncertainState!)).toEqual([]);

    const uncertainF = withFakeWorker("uncertain", uncertainMsg);
    expect(
      await new Supervisor(
        uncertainF.value,
        scriptedChat(["Yes, the page is open."]).model,
      ).reply(before, "Is it open?", "call"),
    ).toBe(uncertainState);

    const blockedMsg =
      "I stopped at the limit of 40 steps. The task is not finished.";
    const blockedState = computerTaskNow({
      configured: true,
      mode: "native",
      state: "blocked",
      canStop: false,
      message: blockedMsg,
    });
    expect(blockedState).toContain("blocked");
    expect(blockedState).toContain(blockedMsg);
    expect(screenClaims(blockedState!)).toEqual([]);
  });

  it("rest 8: offers guidance wording in tool description and note only for native worker with no desk request waiting", async () => {
    const browserF = withFakeWorker("running", working, {
      mode: "browser",
      worker: false,
      goal,
    });
    const browserRun = scriptedChat(["It still runs."]);
    await new Supervisor(browserF.value, browserRun.model).reply(
      before,
      "the page looks weird",
      "call",
    );
    const browserTool = browserRun.inputs[0]!.tools.find(
      (t) => t.name === "delegate_computer_task",
    );
    expect(browserTool?.description).not.toContain(
      "next words for a running computer task",
    );

    const deskF = withFakeWorker("running", working, {
      goal,
      pendingDesk: true,
    });
    const deskRun = scriptedChat(["It still runs."]);
    await new Supervisor(deskF.value, deskRun.model).reply(
      before,
      "the page looks weird",
      "call",
    );
    const deskTool = deskRun.inputs[0]!.tools.find(
      (t) => t.name === "delegate_computer_task",
    );
    expect(deskTool?.description).not.toContain(
      "next words for a running computer task",
    );
    const deskNote = deskRun.inputs[0]!.messages.filter(
      (m) => m.role === "tool",
    )
      .map((m) => m.content)
      .join("\n");
    expect(deskNote).not.toContain("replaced by handing them to the engine");
    expect(deskNote).not.toContain("delegate_computer_task");

    // A remark goes straight to the native worker; a question reaches the model.
    const nativeF = withFakeWorker("running", working, { goal });
    const nativeRun = scriptedChat(["It still runs."]);
    await new Supervisor(nativeF.value, nativeRun.model).reply(
      before,
      "does the page look right?",
      "call",
    );
    const nativeTool = nativeRun.inputs[0]!.tools.find(
      (t) => t.name === "delegate_computer_task",
    );
    expect(nativeTool?.description).toContain(
      "next words for a running computer task",
    );
    const nativeNote = nativeRun.inputs[0]!.messages.filter(
      (m) => m.role === "tool",
    )
      .map((m) => m.content)
      .join("\n");
    expect(nativeNote).toContain("delegate_computer_task");
    expect(nativeNote).not.toContain("replaced by handing them to the engine");
  });
});

describe("shared readWords routing, approval safety, stop handling, and screen truth", () => {
  const goal = "open example.com and find the roadmap board";
  const working = `Working on: "${goal}". Step 19 of at most 40.`;
  const paused =
    "You moved the mouse or pressed a key, so I paused. Say continue to go on, or stop.";
  const approval =
    'Click "Send"? "Send" may be something that cannot be undone, or that speaks for you. Say yes to allow it, or no to stop.';
  const question = "Which workspace should I open?";
  const startedText = "Opening the chat app to find the roadmap board.";
  const stoppedText =
    "Stopped. An action that was already sent may have finished.";
  const guidedText = "Got it. I added that to the task.";
  const resumedText = "Got it. I added that, and the task continues.";
  const goingOnText = "The task continues.";
  const pausedText = "Paused. Your next message continues the task.";
  const stillPausedText = "Still paused. Your next message continues the task.";
  const asideApprovalText =
    "Got it. That was not a yes, so I did not do that step. I added your words and will choose the next step again.";
  const asidePausedApprovalText =
    "Paused. I did not do the step that needed your yes. Your next message continues the task.";
  const refusedApprovalText = 'Canceled. I did not do it: Click "Send".';
  const stillRuns = `The computer task still runs: it has not reported that it is done. Its newest report: ${working}`;
  const deflectionDraft =
    "The task is still running, currently on step 19, not done yet. Want me to keep waiting or do something else?";
  const at = now - 60_000;
  const before: ChatMessage[] = [
    {
      role: "user",
      text: "Can you sort of open Slack for me and find the roadmap board?",
      at,
      via: "call",
    },
    {
      role: "assistant",
      text: startedText,
      at,
      via: "call",
      engine: true,
    },
  ];
  const beforeWithApproval: ChatMessage[] = [
    ...before,
    { role: "assistant", text: approval, at: at + 10_000, via: "call" },
  ];
  const beforeWithUnrelatedQuestion: ChatMessage[] = [
    ...before,
    {
      role: "assistant",
      text: "Should I keep an eye on the tests?",
      at: at + 10_000,
      via: "call",
    },
  ];
  const boardWith = (name: string): BoardSnapshot => ({
    version: 1,
    generatedAt: now,
    intervalMs: 3000,
    counts: { needs_you: 0, working: 1, idle: 0, unknown: 0 },
    sessions: [
      {
        id: "1001_1",
        pid: 1001,
        agent: "claude-code",
        agentLabel: "Claude Code",
        agentVersion: "1.0.0",
        name,
        project: "app",
        cwd: "/work/app",
        mode: "interactive",
        state: "working",
        detail: "turn_running",
        since: now - 120_000,
        source: "hook",
        startedAt: now - 300_000,
        spawnedBy: null,
        terminal: {
          tty: "ttys001",
          app: "Terminal",
          appPath: "/System/Applications/Utilities/Terminal.app",
          tmux: null,
          remote: false,
        },
        focus: "tab",
      },
    ],
  });

  /** Fake execution port that answers as the real ComputerWorker does (using readMidTask and interpret). */
  function withRealishWorker(
    state: string,
    message: string,
    options: {
      mode?: "native" | "browser";
      worker?: boolean;
      goal?: string;
      waiting?: "takeover" | "approval" | "question";
      pendingAction?: { id: string; description: string };
      board?: BoardSnapshot;
      codingTaskRunning?: boolean;
      codingTaskWaiting?: string;
      codingTaskCanAccept?: boolean;
      recentJob?: { job: string; result: string; done?: boolean };
    } = {},
  ) {
    const f = world();
    const submitted: string[] = [];
    const answered: string[] = [];
    const taskAnswers: string[] = [];
    let execStops = 0;
    let taskCancels = 0;
    let taskAccepts = 0;
    if (options.board) f.value.board = () => options.board!;
    if (options.recentJob) {
      f.value.jobs = {
        start: async (job) => {
          f.started.push(job);
          return { ok: true, said: "I started a new session for that job." };
        },
        recent: () => [
          {
            id: "job-1",
            job: options.recentJob!.job,
            startedAt: now - 5 * 60_000,
            done: options.recentJob!.done ?? true,
            result: options.recentJob!.result,
          },
        ],
      };
    }
    if (
      options.codingTaskRunning ||
      options.codingTaskWaiting ||
      options.codingTaskCanAccept
    ) {
      f.value.tasks = {
        current: () => ({
          goal: "fix the login tests",
          state: options.codingTaskWaiting
            ? "waiting_for_person"
            : options.codingTaskCanAccept
              ? "awaiting_review"
              : "running",
          summary: options.codingTaskWaiting
            ? "Waiting for your word."
            : options.codingTaskCanAccept
              ? "Ready to accept the fix for login tests."
              : "Running login tests.",
          question: options.codingTaskWaiting ?? null,
          choices: [],
          canAnswer: !!options.codingTaskWaiting,
          canAccept: !!options.codingTaskCanAccept,
          canCancel: true,
        }),
        canStart: () => false,
        start: async () => ({ ok: false, message: "Busy." }),
        answer: async (text) => {
          taskAnswers.push(text);
          return { ok: true, message: `Answered coding task: ${text}` };
        },
        accept: async () => {
          taskAccepts++;
          return { ok: true, message: "Accepted coding task." };
        },
        cancel: async () => {
          taskCancels++;
          return { ok: true, message: "Coding task canceled." };
        },
      };
    }
    const snapshot = {
      configured: true,
      mode: options.mode ?? ("native" as const),
      state,
      canStop: state === "running" || state === "waiting_for_person",
      message,
      ...(options.goal !== undefined ? { goal: options.goal } : {}),
      ...(options.waiting !== undefined ? { waiting: options.waiting } : {}),
      ...(options.pendingAction
        ? { pendingAction: options.pendingAction }
        : {}),
    };
    const guideReply = (text: string): string => {
      if (state === "idle") return startedText;
      const kind = readMidTask(text);
      if (kind === "stop") {
        execStops++;
        return stoppedText;
      }
      // A pause takes any message: a wait keeps it, everything else goes on.
      if (options.waiting === "takeover") {
        if (kind === "pause") return stillPausedText;
        if (kind === "go") return "Continuing.";
        return resumedText;
      }
      if (options.waiting === "approval") {
        if (kind === "pause") return asidePausedApprovalText;
        if (kind === "go" || kind === "status")
          return `That was not a yes, so I am still waiting. ${message}`;
        return asideApprovalText;
      }
      if (kind === "pause") return pausedText;
      if (kind === "go") return goingOnText;
      if (kind === "status")
        return `Still working on "${goal}", at step 19. It is not done yet.`;
      return guidedText;
    };
    f.value.execution = {
      snapshot: () => snapshot,
      submit: async (_id, text) => {
        submitted.push(text);
        return { message: guideReply(text) };
      },
      submitRead: async (_id, text) => {
        submitted.push(text);
        return { message: guideReply(text) };
      },
      stop: () => {
        execStops++;
        return {
          ...snapshot,
          state: "canceled",
          canStop: false,
          message: stoppedText,
        };
      },
      ...(options.worker === false
        ? {}
        : {
            answer: async (text: string) => {
              answered.push(text);
              if (options.waiting === "question")
                return { message: "Thank you. The task continues." };
              // A pause takes the chat's answer as words for the task.
              if (options.waiting === "takeover")
                return { message: guideReply(text) };
              const said = interpret(text, { kind: "permission", options: [] });
              if (said?.decision === "allow") return { message: "Continuing." };
              if (said?.decision === "deny")
                return { message: refusedApprovalText };
              return { message: `I did not get a clear answer. ${message}` };
            },
          }),
    };
    return {
      ...f,
      submitted,
      answered,
      taskAnswers,
      execStops: () => execStops,
      taskCancels: () => taskCancels,
      taskAccepts: () => taskAccepts,
    };
  }

  function scriptedChat(steps: (ToolCall[] | string)[]) {
    let step = 0;
    const inputs: {
      system: string;
      messages: ModelMessage[];
      tools: { name: string; description: string }[];
    }[] = [];
    const model: ModelClient = {
      async complete(input) {
        inputs.push({
          system: input.system,
          messages: [...input.messages],
          tools: input.tools.map((t) => ({
            name: t.name,
            description: t.description,
          })),
        });
        const next = steps[Math.min(step++, steps.length - 1)]!;
        return typeof next === "string"
          ? { text: next, toolCalls: [] }
          : { text: "", toolCalls: next };
      },
    };
    return { model, inputs, calls: () => step };
  }

  it("round2 blocker 1: never approves on unseen prompt, unrelated question, bare ok/sure/yeah/yep, waiting coding task, or waiting: undefined", async () => {
    const waitingState = `The computer task ("${goal}") waits for your answer: ${approval}`;
    // Unseen approval prompt: even explicit yes must not approve.
    for (const words of [
      "ok",
      "okay",
      "sure",
      "yes",
      "yeah",
      "yep",
      "yes do it",
      "approve",
      "go ahead",
      "do it",
      "allow it",
    ]) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
      });
      const said = await new Supervisor(
        f.value,
        scriptedChat(["Okay."]).model,
      ).reply(before, words, "call");
      expect([words, f.answered, f.submitted, said]).toEqual([
        words,
        [],
        [],
        waitingState,
      ]);
    }

    // Unrelated last assistant question: never approves.
    for (const words of ["yes", "ok", "sure"]) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
      });
      const said = await new Supervisor(
        f.value,
        scriptedChat(["I'll keep an eye on them."]).model,
      ).reply(beforeWithUnrelatedQuestion, words, "call");
      expect([words, f.answered, f.submitted, said]).toEqual([
        words,
        [],
        [],
        waitingState,
      ]);
    }

    // Seen approval prompt: only explicit yes approves; bare ok/okay/sure/yeah/yep never approve.
    for (const words of [
      "yes",
      "yes do it",
      "approve",
      "go ahead",
      "do it",
      "allow it",
    ]) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
      });
      const said = await new Supervisor(
        f.value,
        scriptedChat(["Okay."]).model,
      ).reply(beforeWithApproval, words, "call");
      expect([words, f.answered, f.submitted, said]).toEqual([
        words,
        [words],
        [],
        "Continuing.",
      ]);
    }
    for (const words of ["ok", "okay", "sure", "yeah", "yep"]) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
      });
      const said = await new Supervisor(
        f.value,
        scriptedChat(["Okay."]).model,
      ).reply(beforeWithApproval, words, "call");
      expect([words, f.answered, f.submitted, said]).toEqual([
        words,
        [],
        [],
        waitingState,
      ]);
    }

    // Coding task also waiting for an answer keeps its own path.
    for (const words of ["yes", "ok", "no"]) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
        codingTaskWaiting: "Should I push the fix?",
      });
      const run = scriptedChat([
        [call("answer_task", { text: words })],
        "Answered.",
      ]);
      await new Supervisor(f.value, run.model).reply(
        beforeWithApproval,
        words,
        "call",
      );
      expect([words, f.answered, f.submitted, f.taskAnswers]).toEqual([
        words,
        [],
        [],
        [words],
      ]);
    }

    // waiting_for_person with waiting: undefined must never forward to answer.
    const undefF = withRealishWorker("waiting_for_person", approval, { goal });
    await new Supervisor(undefF.value, scriptedChat(["Okay."]).model).reply(
      before,
      "ok, open it in the browser",
      "call",
    );
    expect(undefF.answered).toEqual([]);
  });

  it("round2 blocker 2: at approval, hesitations and questions repeat state without answer/submit, refusals deny, orders set aside, coding/session take normal path", async () => {
    const waitingState = `The computer task ("${goal}") waits for your answer: ${approval}`;
    for (const words of [
      "sure, why not",
      "sure, why not?",
      "are you sure?",
      "I'm not sure",
      "not sure about that",
      "is it okay?",
      "ok, thanks",
      "ok, wait",
      "ok, tell me what you're sending",
      "why do you need to confirm?",
      "I didn't say yes",
    ]) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
        board: boardWith("deploy fix"),
      });
      const run = scriptedChat(["Okay."]);
      const said = await new Supervisor(f.value, run.model).reply(
        beforeWithApproval,
        words,
        "call",
      );
      expect([words, f.answered, f.submitted, said]).toEqual([
        words,
        [],
        [],
        waitingState,
      ]);
    }

    // Explicit refusals go to answer (never submit) and cancel cleanly.
    for (const words of ["no", "don't", "deny", "don't approve that"]) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
        board: boardWith("deploy fix"),
      });
      const said = await new Supervisor(
        f.value,
        scriptedChat(["Okay."]).model,
      ).reply(beforeWithApproval, words, "call");
      expect([words, f.answered.length, f.submitted, said]).toEqual([
        words,
        1,
        [],
        refusedApprovalText,
      ]);
    }

    // Coding work and session messages take the chat's normal path (never answer, never submit).
    for (const words of [
      "yes, what is deploy fix doing?",
      "tell deploy fix yes",
      "tell deploy fix to approve it",
      "what is deploy fix doing?",
      "find out why the build is slow",
      "open the settings file and fix the typo",
    ]) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
        board: boardWith("deploy fix"),
      });
      const run = scriptedChat(["Normal path reply."]);
      await new Supervisor(f.value, run.model).reply(
        beforeWithApproval,
        words,
        "call",
      );
      expect([words, f.answered, f.submitted, run.calls() > 0]).toEqual([
        words,
        [],
        [],
        true,
      ]);
    }

    // Planner question: non-stop messages take origin/main's execution.answer path.
    for (const words of [
      "the engineering workspace",
      "open the settings file and fix the typo",
    ]) {
      const f = withRealishWorker("waiting_for_person", question, {
        goal,
        waiting: "question",
        board: boardWith("deploy fix"),
      });
      const run = scriptedChat(["Normal path reply."]);
      await new Supervisor(f.value, run.model).reply(before, words, "call");
      expect([words, f.answered, f.submitted]).toEqual([words, [words], []]);
    }
  });

  it("round2 blocker 3: owner's four messages and spoken hesitations reach submit even with a 'google auth' session on the board", async () => {
    for (const words of [
      "Can you just hit enter?",
      "I don't still see Slack to be open. Can you open Slack on Chrome?",
      "Uh just open it in Chrome, bro.",
      "Bro, just open app.example.com on Google Chrome.",
      "um can you hit enter?",
      "uhh press return",
    ]) {
      const f = withRealishWorker("running", working, {
        goal,
        board: boardWith("google auth"),
      });
      const run = scriptedChat([deflectionDraft]);
      run.model.reading = async () => ({
        intent: { kind: "clarify", question: "Which app did you mean?" },
        work: false,
      });
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, f.submitted, run.calls(), said]).toEqual([
        words,
        [words],
        0,
        guidedText,
      ]);
    }
  });

  it("round2 blocker 4: panic stops with don't or repeats stop the screen task; idle executor never steals stop from a running coding task", async () => {
    for (const words of [
      "stop, don't click that",
      "stop, don't send it",
      "don't do that, stop",
      "no, don't, stop",
      "stop, I don't want that",
      "stop stop",
      "stop, stop",
      "stop! stop!",
      "cancel cancel",
      "stop, wait",
      "never mind, stop",
      "stop clicking",
      "stop typing",
    ]) {
      const f = withRealishWorker("running", working, { goal });
      const run = scriptedChat([deflectionDraft]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, f.execStops(), f.submitted, run.calls(), said]).toEqual([
        words,
        1,
        [],
        0,
        stoppedText,
      ]);
    }

    // Idle executor + running coding task: stop/cancel never hits execution.stop().
    const cancelF = withRealishWorker("idle", "Computer use is on.", {
      codingTaskRunning: true,
    });
    const cancelRun = scriptedChat([[call("cancel_task")], "Canceled."]);
    await new Supervisor(cancelF.value, cancelRun.model).reply(
      [],
      "cancel",
      "call",
    );
    expect([cancelF.execStops(), cancelF.taskCancels()]).toEqual([0, 1]);

    const stopIdleF = withRealishWorker("idle", "Computer use is on.", {
      codingTaskRunning: true,
    });
    const stopIdleRun = scriptedChat([
      "Do you want to cancel the coding task?",
    ]);
    const stopIdleSaid = await new Supervisor(
      stopIdleF.value,
      stopIdleRun.model,
    ).reply([], "stop", "call");
    expect(stopIdleF.execStops()).toBe(0);
    expect(stopIdleRun.calls()).toBe(1);
    expect(stopIdleSaid).toBe("Do you want to cancel the coding task?");
  });

  it("round2 blocker 5: one delegate gate keeps coding work off submit across shortcuts, tool calls, and takeover pause", async () => {
    const runningCoding = [
      "open the browser config file and fix the typo",
      "open the app settings file and fix the typo",
      "open the app.tsx file and fix the typo",
      "open package.json in the desktop folder and bump the version",
      "open the button component and fix the hover state",
      "switch to the browser repo and fix the test",
      "open the login page and add a forgot password link",
      "open the app and add dark mode",
      "open the settings panel and add a toggle",
      "open the workspace and write a README",
      "pull up the pricing page and change the copy",
      "type a helper function in it",
      "switch to the main panel and write a header",
    ];
    for (const words of runningCoding) {
      const f = withRealishWorker("running", working, { goal });
      const run = scriptedChat([
        [call("start_job", { job: words })],
        "Started.",
      ]);
      await new Supervisor(f.value, run.model).reply(before, words, "call");
      expect([words, f.submitted, f.started]).toEqual([words, [], [words]]);
    }

    // Even when a model tries to call delegate_computer_task on coding work, delegate blocks submit.
    const coding = withRealishWorker("running", working, { goal });
    await new Supervisor(
      coding.value,
      scriptedChat([
        [call("delegate_computer_task")],
        "Okay, leaving the running task alone.",
      ]).model,
    ).reply(before, "open the settings file and fix the typo", "call");
    expect(coding.submitted).toEqual([]);
    // A remark and words outside the screen grammar are guidance: they reach
    // the task with no model at all.
    for (const words of [
      "the page looks weird",
      "put hello into the right-hand input",
    ]) {
      const f = withRealishWorker("running", working, { goal });
      const run = scriptedChat([
        [call("delegate_computer_task")],
        "Okay, leaving the running task alone.",
      ]);
      await new Supervisor(f.value, run.model).reply(before, words, "call");
      expect([words, f.submitted, run.calls()]).toEqual([words, [words], 0]);
    }

    // While paused on takeover, coding work never goes to the screen task:
    // it keeps its own road, and the model starts the job.
    for (const words of [
      "open the settings file and fix the typo",
      "open package.json and bump the version",
      "find out why the login is slow",
      "push it to origin",
    ]) {
      const f = withRealishWorker("waiting_for_person", paused, {
        goal,
        waiting: "takeover",
      });
      const run = scriptedChat([
        [call("start_job", { job: words })],
        "Started.",
      ]);
      await new Supervisor(f.value, run.model).reply(before, words, "call");
      expect([words, f.submitted, f.answered, f.started]).toEqual([
        words,
        [],
        [],
        [words],
      ]);
    }
  });

  it("round2 blocker 6: catches comma-question claims, widened result phrases, because/so/since clauses, 'The agent ...', board-backed claims, canceled state, and blocked note", async () => {
    for (const draft of [
      "Example.com is open now, anything else?",
      "I hit enter, do you see it now?",
      "I tapped the Send button.",
      "I got example.com open in Chrome.",
      "I have Slack open now.",
      "I've got the roadmap board open.",
      "The email went through.",
      "It went through.",
      "It got done.",
      "The roadmap board is currently displayed.",
      "It's displaying the roadmap board.",
      "We're in Chrome now.",
      "I'm in Slack now.",
      "I see Slack.",
      "I can see Slack.",
      "I toggled the switch.",
      "I checked the box.",
      "I posted the comment.",
      "I already took care of that.",
      "That's handled.",
      "No need to wait because example.com is open.",
      "You asked me to open it so example.com is open now.",
      "Since you wanted Slack I opened Slack in Chrome.",
      "The agent opened Slack.",
      "The agent hit enter.",
      "The agent found the roadmap board.",
      "The agent sent the message.",
      "The agent signed you in.",
      "The agent filled out the form.",
    ]) {
      const f = withRealishWorker("running", working, { goal });
      const said = await new Supervisor(
        f.value,
        scriptedChat([draft]).model,
      ).reply(before, "does the page look right?", "call");
      expect([draft, said]).toEqual([draft, stillRuns]);
    }

    // Board session named "roadmap" + model calls status -> must not back "The roadmap board is open."
    const boardF = withRealishWorker("running", working, {
      goal,
      board: boardWith("roadmap"),
    });
    const boardRun = scriptedChat([
      [call("status")],
      "The roadmap board is open.",
    ]);
    expect(
      await new Supervisor(boardF.value, boardRun.model).reply(
        before,
        "does the page look right?",
        "call",
      ),
    ).toBe(stillRuns);

    // Canceled state has a true sentence and catches false screen claims.
    const canceledState = computerTaskNow({
      configured: true,
      mode: "native",
      state: "canceled",
      canStop: false,
      message: stoppedText,
    });
    expect(canceledState).toContain(
      "The computer task was stopped: it did not report that it is done.",
    );
    expect(screenClaims(canceledState!)).toEqual([]);
    const canceledF = withRealishWorker("canceled", stoppedText);
    expect(
      await new Supervisor(
        canceledF.value,
        scriptedChat(["Yes, example.com is open in Chrome."]).model,
      ).reply(before, "Is it open?", "call"),
    ).toBe(canceledState);

    // Blocked state must not seed "The engine has not reported that the task is over."
    const blockedF = withRealishWorker(
      "blocked",
      "I stopped at the limit of 40 steps. The task is not finished.",
    );
    const blockedRun = scriptedChat(["The task stopped at the step limit."]);
    await new Supervisor(blockedF.value, blockedRun.model).reply(
      before,
      "what happened?",
      "call",
    );
    const blockedNote = blockedRun.inputs[0]!.messages.filter(
      (m) => m.role === "tool",
    )
      .map((m) => m.content)
      .join("\n");
    expect(blockedNote).not.toContain(
      "The engine has not reported that the task is over.",
    );
  });

  it("round2 blocker 7: asksAboutComputerTask never hijacks ordinary non-screen questions, uncertain tasks, or recent-job questions with empty history", async () => {
    for (const words of [
      "is it open source?",
      "what are you doing tonight?",
      "are you stuck on the login bug?",
      "where is that file?",
      "where are we going for dinner?",
      "what's the status of my flight?",
      "what's the progress on the migration?",
      "did you find the bug in package.json?",
      "did you save the file?",
      "did you close the database connection?",
      "how is it going?",
      "are you okay?",
      "are you working tomorrow?",
      "what are you working on in this project?",
      "do you need anything from the store?",
      "is example.com up?",
      "is the app working on mobile?",
      "was it working yesterday?",
    ]) {
      const f = withRealishWorker("running", working, {
        goal,
        board: boardWith("deploy fix"),
      });
      const run = scriptedChat(["Normal answer."]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, run.calls(), said]).toEqual([words, 1, "Normal answer."]);
    }

    // Uncertain task (not running or waiting): never hijacked by asksAboutComputerTask.
    for (const words of [
      "is it open source?",
      "what are you doing tonight?",
      "where is that file?",
      "is it open?",
    ]) {
      const f = withRealishWorker(
        "uncertain",
        'An earlier computer task has an unknown result: "open example.com".',
      );
      const run = scriptedChat(["Normal answer."]);
      const said = await new Supervisor(f.value, run.model).reply(
        [],
        words,
        "call",
      );
      expect([words, run.calls(), said]).toEqual([words, 1, "Normal answer."]);
    }

    // Running computer task + completed recent job + empty history: "is it done?" goes to the model.
    const jobF = withRealishWorker("running", working, {
      goal,
      recentJob: {
        job: "find the biggest files in Downloads",
        result: "Found three big files in Downloads.",
        done: true,
      },
    });
    const jobRun = scriptedChat([
      "The job found three big files in Downloads.",
    ]);
    const jobSaid = await new Supervisor(jobF.value, jobRun.model).reply(
      [],
      "is it done?",
      "call",
    );
    expect(jobRun.calls()).toBe(1);
    expect(jobSaid).toBe("The job found three big files in Downloads.");
  });

  it("round2 rests 8, 9, 10: takeover non-orders steer the task through submit, 'open the task tab' reaches submit, and contradictory approval phrases never call answer while 'sure, stop' stops", async () => {
    // Rest 8, now: takeover non-orders ("no, the other tab", "in the browser instead") steer the task and it goes on.
    for (const words of ["no, the other tab", "in the browser instead"]) {
      const f = withRealishWorker("waiting_for_person", paused, {
        goal,
        waiting: "takeover",
      });
      const run = scriptedChat(["It is paused right now."]);
      await new Supervisor(f.value, run.model).reply(before, words, "call");
      expect([words, f.submitted, f.answered, f.execStops()]).toEqual([
        words,
        [words],
        [],
        0,
      ]);
    }

    // Rest 9: "open the task tab" and "open the tasks tab" reach submit.
    for (const words of ["open the task tab", "open the tasks tab"]) {
      const f = withRealishWorker("running", working, { goal });
      const run = scriptedChat([deflectionDraft]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, f.submitted, said]).toEqual([words, [words], guidedText]);
    }

    // Rest 10: contradictory phrases at approval never call answer/submit; "sure, stop" stops.
    const waitingState = `The computer task ("${goal}") waits for your answer: ${approval}`;
    for (const words of ["ok, no", "yes, no"]) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
      });
      const said = await new Supervisor(
        f.value,
        scriptedChat(["Okay."]).model,
      ).reply(beforeWithApproval, words, "call");
      expect([words, f.answered, f.submitted, said]).toEqual([
        words,
        [],
        [],
        waitingState,
      ]);
    }
    const stopF = withRealishWorker("waiting_for_person", approval, {
      goal,
      waiting: "approval",
    });
    const stopSaid = await new Supervisor(
      stopF.value,
      scriptedChat(["Okay."]).model,
    ).reply(beforeWithApproval, "sure, stop", "call");
    expect(stopF.execStops()).toBe(1);
    expect(stopF.answered).toEqual([]);
    expect(stopF.submitted).toEqual([]);
    expect(stopSaid).toBe(stoppedText);
  });

  it("final review blocker 1: after a screen task ended, or for coding and job questions, the model's answer stands", async () => {
    for (const state of ["canceled", "blocked", "uncertain"]) {
      for (const [words, draft] of [
        [
          "is the login fix done?",
          "Yes. The login fix is done and the tests pass.",
        ],
        ["did claude finish?", "Yes, it finished."],
        ["thanks!", "You're welcome. All set."],
        ["is it done?", "Yes, it's done."],
        ["is the server up?", "Yes, it's up on port 3000."],
      ] as const) {
        const f = withRealishWorker(state, stoppedText, { goal });
        const run = scriptedChat([draft]);
        const reply = await new Supervisor(f.value, run.model).reply(
          before,
          words,
          "call",
        );
        expect([state, words, reply]).toEqual([state, words, draft]);
      }
    }
    // While a screen task runs, a question about a session or coding work
    // keeps the model's answer too.
    const f = withRealishWorker("running", working, {
      goal,
      board: boardWith("deploy fix"),
    });
    const run = scriptedChat(["Yes, it's done."]);
    const reply = await new Supervisor(f.value, run.model).reply(
      before,
      "is the deploy fix session done?",
      "call",
    );
    expect(reply).toBe("Yes, it's done.");
  });

  it("final review blocker 2: a stop word as a noun in coding work starts the job and stops nothing", async () => {
    for (const words of [
      "make the stop button red",
      "make the cancel button bigger",
      "the cancel flow is broken, can you look at it",
      "make the abort message clearer",
      "let's make the stop sound quieter",
    ]) {
      const f = withRealishWorker("running", working, { goal });
      const run = scriptedChat([
        [call("start_job", { job: words })],
        "Started job.",
      ]);
      await new Supervisor(f.value, run.model).reply(before, words, "call");
      expect([words, f.execStops(), f.submitted, f.started]).toEqual([
        words,
        0,
        [],
        [words],
      ]);
    }
    // A stop that opens a clause still stops the screen task.
    for (const words of [
      "stop, don't click that",
      "no stop",
      "never mind, stop",
      "ok cancel",
    ]) {
      const f = withRealishWorker("running", working, { goal });
      const run = scriptedChat(["Okay."]);
      await new Supervisor(f.value, run.model).reply(before, words, "call");
      expect([words, f.execStops()]).toEqual([words, 1]);
    }
  });

  it("final review round 2: coding work that opens with stop or cancel starts its job and stops nothing", async () => {
    for (const words of [
      "stop polling when the tab is hidden",
      "stop retrying on 404s",
      "stop logging passwords",
      "stop sending the welcome email twice",
      "stop caching the user list",
      "stop using lodash in the app",
      "stop showing the banner on mobile",
      "stop the spinner after the request fails",
      "cancel the old subscription when they upgrade",
      "cancel button should be blue",
      "stop button should be red",
      "cancel flow needs a confirm dialog",
    ]) {
      const f = withRealishWorker("running", working, { goal });
      const run = scriptedChat([
        [call("start_job", { job: words })],
        "Started job.",
      ]);
      await new Supervisor(f.value, run.model).reply(before, words, "call");
      expect([words, f.execStops(), f.submitted, f.started]).toEqual([
        words,
        0,
        [],
        [words],
      ]);
    }
    // Stops of the screen task, with words of stopping behind the stop word.
    for (const words of [
      "stop",
      "stop it",
      "stop now",
      "stop clicking",
      "please stop",
      "cancel the task",
      "stop, don't click that",
      "i said stop",
      "stop the computer task",
    ]) {
      const f = withRealishWorker("running", working, { goal });
      const run = scriptedChat(["Okay."]);
      await new Supervisor(f.value, run.model).reply(before, words, "call");
      expect([words, f.execStops()]).toEqual([words, 1]);
    }
  });

  it("final review round 2 rests: agent and server questions keep the model's answer while a task runs; no screen task starts with the goal stop", async () => {
    for (const [words, draft] of [
      ["did claude finish?", "Yes, it finished."],
      ["is codex done?", "Yes, it's done."],
      ["is the dev server running?", "Yes, on port 3000."],
    ] as const) {
      const f = withRealishWorker("running", working, { goal });
      const run = scriptedChat([draft]);
      const reply = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, reply]).toEqual([words, draft]);
    }
    for (const words of ["stop", "abort", "please stop"]) {
      const f = withRealishWorker("idle", "Computer use is on.", {
        goal,
        codingTaskRunning: true,
      });
      const run = scriptedChat([
        [call("delegate_computer_task", { task: words })],
        "Started.",
      ]);
      await new Supervisor(f.value, run.model).reply(before, words, "call");
      expect([words, f.submitted]).toEqual([words, []]);
    }
  });

  it("final review round 3: a screen request with a stop word starts when no screen task runs", async () => {
    for (const state of ["idle", "completed", "canceled", "blocked"]) {
      for (const words of [
        "open Calendar and cancel the 3pm meeting",
        "cancel my 3pm meeting in Calendar",
        "open the video site in Chrome and cancel my subscription",
        "click the Cancel button",
        "click Stop on the timer",
        "stop the music in the player app",
        "cancel the order on example.com",
        "abort the upload in Chrome",
      ]) {
        const f = withRealishWorker(state, "Done.", { goal });
        const run = scriptedChat([
          [call("delegate_computer_task", { task: words })],
          "Started.",
        ]);
        await new Supervisor(f.value, run.model).reply(before, words, "call");
        expect([state, words, f.submitted]).toEqual([state, words, [words]]);
      }
    }
  });

  it("final review blocker 4: a bare stop with no screen task running goes to the engine's stop, never to the model", async () => {
    for (const state of ["idle", "completed", "blocked"]) {
      for (const words of ["stop", "stop!", "cancel", "please stop"]) {
        const f = withRealishWorker(state, "Done.", { goal });
        const run = scriptedChat([
          [call("delegate_computer_task", { task: words })],
          "Started.",
        ]);
        await new Supervisor(f.value, run.model).reply(before, words, "call");
        expect([state, words, f.submitted, run.calls()]).toEqual([
          state,
          words,
          [],
          0,
        ]);
      }
    }
  });

  it("round3 blocker 1: stops ignore questions, coding work, and non-screen targets while allowing genuine stops and click Cancel", async () => {
    // Coding instructions with stop words never stop the screen task and start their job.
    for (const words of [
      "fix the cancel button in the checkout form",
      "fix the abort controller bug",
      "add enough tests for the parser",
      "implement a cancel endpoint",
      "build a stop button for the player",
    ]) {
      const f = withRealishWorker("running", working, {
        goal,
        board: boardWith("deploy fix"),
      });
      const run = scriptedChat([
        [call("start_job", { job: words })],
        "Started job.",
      ]);
      await new Supervisor(f.value, run.model).reply(before, words, "call");
      expect([words, f.execStops(), f.submitted, f.started]).toEqual([
        words,
        0,
        [],
        [words],
      ]);
    }

    // A remark never stops the screen task: it steers it.
    const enough = withRealishWorker("running", working, {
      goal,
      board: boardWith("deploy fix"),
      codingTaskRunning: true,
    });
    expect(
      await new Supervisor(
        enough.value,
        scriptedChat(["Normal reply."]).model,
      ).reply(before, "that's good enough", "call"),
    ).toBe(guidedText);
    expect([enough.execStops(), enough.submitted]).toEqual([
      0,
      ["that's good enough"],
    ]);
    // Questions and non-screen stops never stop the screen task.
    for (const words of [
      "is that enough?",
      "did it stop?",
      "why did it stop?",
      "did it cancel?",
      "can you stop it?",
      "will it stop",
      "never stop trying",
      "stop my build",
      "cancel my job",
      "stop my deploy",
      "cancel my tests",
      "stop the builds",
      "cancel the jobs",
      "stop the server",
      "stop the dev server",
      "abort the rebase",
      "cancel the migration",
      "stop that job",
      "cancel this build",
      "stop watching deploy fix",
      "stop the coding task",
      "stop the test run",
    ]) {
      const f = withRealishWorker("running", working, {
        goal,
        board: boardWith("deploy fix"),
        codingTaskRunning: true,
      });
      const run = scriptedChat(["Normal reply."]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, f.execStops(), f.submitted, said]).toEqual([
        words,
        0,
        [],
        "Normal reply.",
      ]);
    }
    // "close enough" never calls execution.stop() (readWords in orders.ts is out of scope).
    const closeEnoughF = withRealishWorker("running", working, {
      goal,
      board: boardWith("deploy fix"),
      codingTaskRunning: true,
    });
    await new Supervisor(
      closeEnoughF.value,
      scriptedChat(["Normal reply."]).model,
    ).reply(before, "close enough", "call");
    expect(closeEnoughF.execStops()).toBe(0);

    // "click Cancel" while a screen task runs: the stop word does not open
    // the message, so it is no stop of the screen task; the model answers,
    // as on main.
    const clickCancel = withRealishWorker("running", working, { goal });
    const clickCancelSaid = await new Supervisor(
      clickCancel.value,
      scriptedChat(["Normal reply."]).model,
    ).reply(before, "click Cancel", "call");
    expect(clickCancel.execStops()).toBe(0);
    expect(clickCancelSaid).toBe("Normal reply.");
  });

  it("round3 blocker 2 and rests 7-8: strict approval yes/no binding, nah/nope mapping, canAccept coding task, and main-path takeover/question", async () => {
    const waitingState = `The computer task ("${goal}") waits for your answer: ${approval}`;

    // Cross-channel approval works when the newest message in history is the approval prompt.
    const crossChannelHistory: ChatMessage[] = [
      ...before,
      { role: "assistant", text: approval, at: at + 10_000, via: "chat" },
    ];
    const crossF = withRealishWorker("waiting_for_person", approval, {
      goal,
      waiting: "approval",
    });
    expect(
      await new Supervisor(crossF.value, scriptedChat(["Okay."]).model).reply(
        crossChannelHistory,
        "yes",
        "call",
      ),
    ).toBe("Continuing.");
    expect(crossF.answered).toEqual(["yes"]);

    // A user message after the approval prompt invalidates both yes and no.
    const staleAfterUser: ChatMessage[] = [
      ...beforeWithApproval,
      {
        role: "user",
        text: "wait, what is deploy fix doing?",
        at: at + 20_000,
        via: "call",
      },
    ];
    for (const words of [
      "yes",
      "approve",
      "no",
      "nah",
      "nope",
      "deny",
      "cancel",
    ]) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
      });
      const said = await new Supervisor(
        f.value,
        scriptedChat(["Okay."]).model,
      ).reply(staleAfterUser, words, "call");
      expect([words, f.answered, f.execStops(), f.submitted, said]).toEqual([
        words,
        [],
        0,
        [],
        waitingState,
      ]);
    }

    // Trailing "?" never reaches execution.answer.
    for (const words of ["yes?", "no?", "approve?", "do it?", "go ahead?"]) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
      });
      const said = await new Supervisor(
        f.value,
        scriptedChat(["Okay."]).model,
      ).reply(beforeWithApproval, words, "call");
      expect([words, f.answered, f.execStops(), said]).toEqual([
        words,
        [],
        0,
        waitingState,
      ]);
    }

    // Rest 7: explicit nos after seen prompt cancel cleanly, mapping nah/nope to "no".
    for (const [words, expectedSent] of [
      ["no", "no"],
      ["nah", "no"],
      ["nope", "no"],
      ["don't", "don't"],
      ["deny", "deny"],
      ["cancel", "cancel"],
    ] as const) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
      });
      const said = await new Supervisor(
        f.value,
        scriptedChat(["Okay."]).model,
      ).reply(beforeWithApproval, words, "call");
      expect([words, f.answered, f.execStops(), said]).toEqual([
        words,
        [expectedSent],
        0,
        refusedApprovalText,
      ]);
    }

    // Unseen prompt: explicit nos do not cancel.
    for (const words of ["no", "nah", "nope", "don't", "deny", "cancel"]) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
      });
      const said = await new Supervisor(
        f.value,
        scriptedChat(["Okay."]).model,
      ).reply(before, words, "call");
      expect([words, f.answered, f.execStops(), said]).toEqual([
        words,
        [],
        0,
        waitingState,
      ]);
    }

    // Rest 8: clear explicit yes variants after seen prompt approve.
    for (const words of [
      "yes",
      "yes do it",
      "yes please",
      "approve",
      "go ahead",
      "do it",
      "allow it",
      "yes, send it",
      "yes, approve that",
      "approve that",
      "I approve",
      "go ahead and do it",
      "yes, proceed",
      "yes please, go ahead",
      "confirm",
    ]) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
      });
      const said = await new Supervisor(
        f.value,
        scriptedChat(["Okay."]).model,
      ).reply(beforeWithApproval, words, "call");
      expect([words, f.answered, f.submitted, said]).toEqual([
        words,
        [words],
        [],
        "Continuing.",
      ]);
    }

    // Coding task waiting for acceptance (canAccept: true) gets bare yes/no/approve.
    const acceptPromptHistory: ChatMessage[] = [
      ...before,
      {
        role: "assistant",
        text: "Ready to accept the fix for login tests?",
        at: at + 10_000,
        via: "call",
      },
    ];
    for (const [hist, words] of [
      [acceptPromptHistory, "yes"],
      [acceptPromptHistory, "approve"],
      [beforeWithApproval, "yes"],
    ] as const) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
        codingTaskCanAccept: true,
      });
      const run = scriptedChat(["Please say accept to accept the task."]);
      await new Supervisor(f.value, run.model).reply([...hist], words, "call");
      expect([words, f.answered, f.execStops(), run.calls() > 0]).toEqual([
        words,
        [],
        0,
        true,
      ]);
    }
    const acceptF = withRealishWorker("waiting_for_person", approval, {
      goal,
      waiting: "approval",
      codingTaskCanAccept: true,
    });
    const acceptRun = scriptedChat([[call("accept_task", {})], "Accepted."]);
    await new Supervisor(acceptF.value, acceptRun.model).reply(
      acceptPromptHistory,
      "accept it",
      "call",
    );
    expect([acceptF.answered, acceptF.taskAccepts()]).toEqual([[], 1]);
    const noAcceptF = withRealishWorker("waiting_for_person", approval, {
      goal,
      waiting: "approval",
      codingTaskCanAccept: true,
    });
    const noAcceptRun = scriptedChat(["Not accepted."]);
    const noAcceptSaid = await new Supervisor(
      noAcceptF.value,
      noAcceptRun.model,
    ).reply(acceptPromptHistory, "no", "call");
    expect([noAcceptF.answered, noAcceptF.execStops(), noAcceptSaid]).toEqual([
      [],
      0,
      "Not accepted.",
    ]);

    // Takeover pause: any words go on with the task, here through submit.
    // Planner question: the words are its answer.
    const takeF = withRealishWorker("waiting_for_person", paused, {
      goal,
      waiting: "takeover",
    });
    await new Supervisor(takeF.value, scriptedChat(["Okay."]).model).reply(
      before,
      "hmm",
      "call",
    );
    expect(takeF.answered).toEqual([]);
    expect(takeF.submitted).toEqual(["hmm"]);

    const qF = withRealishWorker("waiting_for_person", question, {
      goal,
      waiting: "question",
    });
    expect(
      await new Supervisor(qF.value, scriptedChat(["Okay."]).model).reply(
        before,
        "the main workspace",
        "call",
      ),
    ).toBe("Thank you. The task continues.");
    expect(qF.answered).toEqual(["the main workspace"]);
  });

  it("round3 blockers 3 and 6: UI-label orders reach engine without hasCodingWork, coding holds start jobs across clarify/pendingAction/approval", async () => {
    // Quoted UI labels that readWords reads as "order" are no longer blocked by hasCodingWork.
    for (const words of [
      'click the "Edit" button',
      'open the "File" menu',
      'click the "Create" button',
      'click "Delete"',
    ]) {
      expect([words, guidesComputerTask(words)]).toEqual([words, true]);
      const f = withRealishWorker("running", working, { goal });
      const run = scriptedChat([deflectionDraft]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, f.submitted, said]).toEqual([words, [words], guidedText]);
    }

    // Coding holds start jobs even when model.reading returns clarify.
    const clarifyF = withRealishWorker("running", working, {
      goal,
      board: boardWith("deploy fix"),
    });
    const clarifyRun = scriptedChat([
      [call("start_job", { job: "open the settings file and fix the typo" })],
      "Started job.",
    ]);
    clarifyRun.model.reading = async () => ({
      intent: { kind: "clarify", question: "Which app did you mean?" },
      work: false,
    });
    const clarifySaid = await new Supervisor(
      clarifyF.value,
      clarifyRun.model,
    ).reply(before, "open the settings file and fix the typo", "call");
    expect([clarifyF.submitted, clarifyF.started]).toEqual([
      [],
      ["open the settings file and fix the typo"],
    ]);
    expect(clarifySaid).not.toBe("Which app did you mean?");

    // While pendingAction waits, coding holds containing browser/button take origin/main's path.
    for (const words of [
      "open the browser config file and fix the typo",
      "open the button component and fix the hover state",
    ]) {
      const f = withRealishWorker("running", "An action waits.", {
        goal,
        pendingAction: { id: "a1", description: "Click Send" },
      });
      const run = scriptedChat([
        [call("start_job", { job: words })],
        "Started job.",
      ]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, f.submitted, f.started]).toEqual([words, [], [words]]);
      expect(said).not.toContain("Approve action or Deny action");
    }

    // While waiting === "approval", job queries and coding commands are not swallowed.
    for (const words of [
      "is the job done?",
      "what jobs are running?",
      "check the logs",
      "run the linter",
      "revert the last patch",
    ]) {
      const f = withRealishWorker("waiting_for_person", approval, {
        goal,
        waiting: "approval",
        board: boardWith("deploy fix"),
      });
      const run = scriptedChat(["Normal reply."]);
      const said = await new Supervisor(f.value, run.model).reply(
        beforeWithApproval,
        words,
        "call",
      );
      expect([words, f.answered, f.submitted, run.calls(), said]).toEqual([
        words,
        [],
        [],
        1,
        "Normal reply.",
      ]);
    }
  });

  it("round3 blocker 5: state questions only fire for the exact 7 questions alone after a screen turn or empty history", async () => {
    // Exact 7 questions + owner's combined question get state directly after a screen turn.
    for (const words of [
      "are you stuck?",
      "is it open?",
      "is it loaded?",
      "where are you?",
      "what are you doing?",
      "is it done?",
      "do you need help?",
      "Are you stuck somewhere? Do you want help anywhere?",
    ]) {
      const f = withRealishWorker("running", working, {
        goal,
        board: boardWith("deploy fix"),
      });
      const run = scriptedChat(["Yes, it is open."]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, run.calls(), said]).toEqual([words, 0, stillRuns]);
    }

    // Follow-up after a session question goes to the model, never hijacked with stillRuns.
    const afterSession: ChatMessage[] = [
      ...before,
      {
        role: "user",
        text: "How is deploy fix doing?",
        at: at + 10_000,
        via: "call",
      },
      {
        role: "assistant",
        text: "Deploy fix is running the checkout suite.",
        at: at + 11_000,
        via: "call",
      },
    ];
    for (const words of [
      "is it done?",
      "is it finished yet?",
      "is it open?",
      "did it work?",
    ]) {
      const f = withRealishWorker("running", working, {
        goal,
        board: boardWith("deploy fix"),
      });
      const run = scriptedChat(["Deploy fix is still running."]);
      const said = await new Supervisor(f.value, run.model).reply(
        afterSession,
        words,
        "call",
      );
      expect([words, run.calls(), said]).toEqual([
        words,
        1,
        "Deploy fix is still running.",
      ]);
    }

    // Two-sentence mixed questions, "on staging", and did-you/did-it questions take origin/main's path.
    for (const words of [
      "How is payments doing? Is it done?",
      "did you type yes in payments?",
      "did you open payments?",
      "did it work on staging?",
      "is it done on staging?",
      "did that work yesterday?",
      "did you open a ticket?",
    ]) {
      const f = withRealishWorker("running", working, {
        goal,
        board: boardWith("payments api"),
      });
      const run = scriptedChat(["Normal session answer."]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, run.calls() > 0, said]).toEqual([
        words,
        true,
        "Normal session answer.",
      ]);
    }
  });

  it("round3 blocker 4: cheap screenClaims fixes (bare Yes across states, popup is gone, I'm in <App> now, We're at <address> now) and paused/uncertain state truth", async () => {
    // Bare "Yes." / "Yep." caught across running, canceled, blocked, and uncertain.
    for (const [state, msg] of [
      ["running", working],
      ["canceled", "Stopped."],
      ["blocked", "Could not finish."],
      ["uncertain", "Unknown result."],
    ] as const) {
      for (const [asked, draft] of [
        ["Did it send?", "Yes."],
        ["Did you hit enter?", "Yes."],
        ["Did the page load?", "Yes."],
        ["Did the form submit?", "Yes."],
        ["Are we signed in?", "Yes."],
        ["Did the email send?", "Yes."],
        ["Did the file download?", "Yep."],
      ] as const) {
        const f = withRealishWorker(state, msg, { goal });
        const expected = computerTaskNow(f.value.execution!.snapshot())!;
        const run = scriptedChat([draft]);
        const said = await new Supervisor(f.value, run.model).reply(
          before,
          asked,
          "call",
        );
        expect([state, asked, draft, said]).toEqual([
          state,
          asked,
          draft,
          expected,
        ]);
      }
    }

    // Cheap phrase patterns caught by screenClaims and replaced while running.
    for (const draft of [
      "The popup is gone.",
      "I'm in Notes Plus now.",
      "I'm in Google Chrome now.",
      "We're at example.com now.",
      "We're at app.example.com now.",
    ]) {
      expect([draft, screenClaims(draft).length > 0]).toEqual([draft, true]);
      const f = withRealishWorker("running", working, { goal });
      const run = scriptedChat([draft]);
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        "does the page look right?",
        "call",
      );
      expect([draft, said]).toEqual([draft, stillRuns]);
    }

    // state === "paused" without waiting === "takeover" reports paused (not "still runs" or null).
    expect(
      computerTaskNow({
        configured: true,
        mode: "native",
        state: "paused",
        canStop: true,
        goal,
        message: "Paused.",
      }),
    ).toBe(
      `The computer task ("${goal}") is paused: it has not reported that it is done. Its newest report: Paused.`,
    );
    expect(
      computerTaskNow({
        configured: true,
        mode: "native",
        state: "paused",
        canStop: false,
        goal,
        message: "Paused.",
      }),
    ).toBe(
      `The computer task ("${goal}") is paused: it has not reported that it is done. Its newest report: Paused.`,
    );

    // state === "uncertain" seeds ended-unfinished note (not "has not reported that the task is over").
    const uncF = withRealishWorker("uncertain", "Unknown result.", { goal });
    const uncRun = scriptedChat(["Still unknown."]);
    await new Supervisor(uncF.value, uncRun.model).reply(
      before,
      "what happened?",
      "call",
    );
    const uncNote = uncRun.inputs[0]!.messages.filter((m) => m.role === "tool")
      .map((m) => m.content)
      .join("\n");
    expect(uncNote).not.toContain(
      "The engine has not reported that the task is over.",
    );
  });

  it("round3 rest 9 and owner flow: guidance tool description absent at approval/question, and all four owner orders plus stuck question work", async () => {
    // Rest 9: guidance wording is not offered when waiting === "approval" (or "question").
    const appF = withRealishWorker("waiting_for_person", approval, {
      goal,
      waiting: "approval",
      board: boardWith("deploy fix"),
    });
    const appRun = scriptedChat(["Deploy fix is running."]);
    await new Supervisor(appF.value, appRun.model).reply(
      beforeWithApproval,
      "what is deploy fix doing?",
      "call",
    );
    const appTool = appRun.inputs[0]!.tools.find(
      (t) => t.name === "delegate_computer_task",
    );
    expect(appTool?.description).not.toContain(
      "next words for a running computer task",
    );

    // Owner's four screen orders reach execution.submit even with clarify reading.
    for (const words of [
      "Can you just hit enter?",
      "I don't still see Slack to be open. Can you open Slack on Chrome?",
      "Uh just open it in Chrome, bro.",
      "Bro, just open app.example.com on Google Chrome.",
    ]) {
      const f = withRealishWorker("running", working, {
        goal,
        board: boardWith("google auth"),
      });
      const run = scriptedChat([deflectionDraft]);
      run.model.reading = async () => ({
        intent: { kind: "clarify", question: "Which app did you mean?" },
        work: false,
      });
      const said = await new Supervisor(f.value, run.model).reply(
        before,
        words,
        "call",
      );
      expect([words, f.submitted, run.calls(), said]).toEqual([
        words,
        [words],
        0,
        guidedText,
      ]);
    }
  });
});
