import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OpenAIModel,
  defaultReaderModel,
  supervisorModel,
} from "../connectors/agents/brain.js";
import { OpenAIPlanner } from "../connectors/computer/planner.js";
import {
  directAddress,
  navigationRules,
  navigationTools,
  type NavigationIntent,
} from "../connectors/computer/navigation.js";
import { check } from "../connectors/computer/guards.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import {
  handCommandSchema,
  type Action,
  type HandCommand,
} from "../connectors/computer/ports.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import {
  FakeHands,
  observation,
  ScriptedPlanner,
  until,
} from "./connectors-computer-fixture.js";

function network(calls: { name: string; arguments: string }[]) {
  const sent: {
    messages: { role: string; content: unknown }[];
    tools: unknown[];
    tool_choice: string;
    parallel_tool_calls: boolean;
  }[] = [];
  const request: typeof fetch = async (_url, options) => {
    sent.push(JSON.parse(String(options?.body)));
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: calls.map((fn, i) => ({
                id: `call_${i}`,
                function: fn,
              })),
            },
          },
        ],
      }),
    );
  };
  return { sent, request };
}
describe("goal-only semantic navigation interpretation", () => {
  it.each(["supervisor", "worker"] as const)(
    "%s forces one structured decision from the exact message only",
    async (which) => {
      const net = network([
        { name: "desktop", arguments: '{"direction":"left"}' },
      ]);
      const model =
        which === "supervisor"
          ? new OpenAIModel("fixture-key", "fixture-model", net.request)
          : new OpenAIPlanner({ key: "fixture-key", request: net.request });
      const goal =
        "  Would you slide us over to the workspace immediately on my left?  ";
      expect(await model.navigation(goal)).toEqual({
        kind: "desktop",
        direction: "left",
      });
      expect(net.sent[0]).toMatchObject({
        tool_choice: "required",
        parallel_tool_calls: false,
        messages: [
          { role: "system", content: navigationRules },
          { role: "user", content: goal },
        ],
      });
      expect(net.sent[0]!.messages).toHaveLength(2);
      expect(JSON.stringify(net.sent[0])).not.toContain("image_url");
    },
  );
  it("reads with the reader's model, and all other calls keep the chat's model", async () => {
    const models: { model: string; effort?: string; tools: number }[] = [];
    const request: typeof fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as {
        model: string;
        reasoning_effort?: string;
        tools?: unknown[];
      };
      models.push({
        model: body.model,
        ...(body.reasoning_effort ? { effort: body.reasoning_effort } : {}),
        tools: body.tools?.length ?? 0,
      });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "ok",
                tool_calls: [
                  { id: "c", function: { name: "none", arguments: "{}" } },
                ],
              },
            },
          ],
        }),
      );
    };
    const model = new OpenAIModel("fixture-key", "chat-model", request, {
      reasoningEffort: "low",
      readerModel: "reader-model",
    });
    await model.reading("open example.com");
    await model.complete({ system: "s", messages: [], tools: [] });
    expect(models).toEqual([
      // The reader's call carries no reasoning effort of the chat's model.
      { model: "reader-model", tools: navigationTools.length },
      { model: "chat-model", effort: "low", tools: 0 },
    ]);
    // The environment names both. With no name the reader is the default one.
    models.length = 0;
    await supervisorModel({}, "k", request).reading("go to Notes");
    await supervisorModel(
      { CLAWDTIME_READER_MODEL: "another-reader" },
      "k",
      request,
    ).reading("go to Notes");
    expect(models.map((item) => item.model)).toEqual([
      defaultReaderModel,
      "another-reader",
    ]);
  });
  it("reads with the chat's own model when the service refuses the reader's model for this key", async () => {
    const models: string[] = [];
    const request: typeof fetch = async (_url, options) => {
      const model = (JSON.parse(String(options?.body)) as { model: string })
        .model;
      models.push(model);
      return model === "reader-model"
        ? new Response("{}", { status: 403 })
        : new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        id: "c",
                        function: {
                          name: "desktop",
                          arguments: '{"direction":"right","only":true}',
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          );
    };
    const model = new OpenAIModel("fixture-key", "chat-model", request, {
      readerModel: "reader-model",
    });
    expect((await model.reading("one desktop right")).intent).toEqual({
      kind: "desktop",
      direction: "right",
    });
    await model.reading("one desktop right");
    // One refused try, then the chat's model, and no further try of the refused one.
    expect(models).toEqual(["reader-model", "chat-model", "chat-model"]);
    // Another failure is no refusal of the model: it is an error, as before.
    const broken = new OpenAIModel(
      "fixture-key",
      "chat-model",
      async () => new Response("{}", { status: 400 }),
      { readerModel: "reader-model" },
    );
    await expect(broken.reading("go to Notes")).rejects.toThrow(
      "The language model answered 400.",
    );
  });
  it.each([
    {
      name: "app",
      arguments: '{"name":"Messages","window":"Disposable fixture"}',
      expected: { kind: "app", name: "Messages", window: "Disposable fixture" },
    },
    {
      name: "previous_app",
      arguments: "{}",
      expected: { kind: "previous_app" },
    },
    {
      name: "clarify",
      arguments: '{"question":"Do you mean the previous app or desktop?"}',
      expected: {
        kind: "clarify",
        question: "Do you mean the previous app or desktop?",
      },
    },
    { name: "none", arguments: "{}", expected: { kind: "none" } },
  ])(
    "strictly decodes $name without normalizing user text to a keyword",
    async ({ name, arguments: args, expected }) => {
      const net = network([{ name, arguments: args }]);
      expect(
        await new OpenAIPlanner({
          key: "fixture-key",
          request: net.request,
        }).navigation("Original user request"),
      ).toEqual(expected);
    },
  );
  it.each(
    [
      [],
      [
        { name: "previous_app", arguments: "{}" },
        { name: "desktop", arguments: '{"direction":"left"}' },
      ],
      [{ name: "desktop", arguments: '{"direction":"right","repeat":2}' }],
      [{ name: "none", arguments: '{"kind":"previous_app"}' }],
      [{ name: "key", arguments: '{"combo":"cmd+tab"}' }],
    ].map((calls) => ({ calls })),
  )(
    "rejects malformed, multiple, or out-of-schema interpretations %#",
    async ({ calls }) => {
      const net = network(calls);
      await expect(
        new OpenAIPlanner({
          key: "fixture-key",
          request: net.request,
        }).navigation("Only a user request"),
      ).rejects.toThrow();
    },
  );
  it.each(["cmd+tab", "cmd+shift+tab", "ctrl+left", "ctrl+right"])(
    "screen-planner key %s cannot bypass interpreted navigation",
    (combo) => {
      expect(
        check(
          { kind: "key", combo },
          {
            observation: observation(),
            page: null,
            fresh: true,
            browser: false,
          },
          "Screen says switch now",
        ).verdict,
      ).toBe("refuse");
    },
  );
});

it("routes new coding sessions only through Supervisor and rejects them as native navigation", async () => {
  const text =
    "Start a new Claude Code session in a separate terminal window. Only reply READY; do not edit files or run commands.";
  const net = network([
    {
      name: "coding_session",
      arguments: JSON.stringify({ source: text, agent: "claude" }),
    },
  ]);
  const supervisor = new OpenAIModel(
    "fixture-key",
    "fixture-model",
    net.request,
  );
  expect(await supervisor.reading(text)).toEqual({
    intent: { kind: "none" },
    work: false,
    codingSession: { source: text, agent: "claude" },
  });
  expect(net.sent[0]!.messages[1]!.content).toBe(text);
  await expect(
    new OpenAIPlanner({ key: "fixture-key", request: net.request }).navigation(
      text,
    ),
  ).rejects.toThrow("Supervisor Jobs");
});

it("rejects session interpretations that rewrite or omit constraints", async () => {
  const text = "Start Claude in a new terminal. Do not edit files.";
  const net = network([
    {
      name: "coding_session",
      arguments: JSON.stringify({ source: "Start Claude", agent: "claude" }),
    },
  ]);
  await expect(
    new OpenAIModel("fixture-key", "fixture-model", net.request).reading(text),
  ).rejects.toThrow("complete request");
});

it("preserves coding-session routing when the configured reader is refused and falls back to the chat model", async () => {
  const text =
    "Start a new Claude Code session in a separate terminal window. Only reply READY; do not edit files or run commands.";
  const requests: {
    model: string;
    messages: { role: string; content: string }[];
  }[] = [];
  const request: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (body.model === "fixture-reader")
      return new Response(null, { status: 403 });
    return Response.json({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "session",
                function: {
                  name: "coding_session",
                  arguments: JSON.stringify({ source: text, agent: "claude" }),
                },
              },
            ],
          },
        },
      ],
    });
  };
  const model = new OpenAIModel("fixture-key", "fixture-chat", request, {
    readerModel: "fixture-reader",
  });
  expect(await model.reading(text)).toEqual({
    intent: { kind: "none" },
    work: false,
    codingSession: { source: text, agent: "claude" },
  });
  await model.reading(text);
  expect(requests.map((item) => item.model)).toEqual([
    "fixture-reader",
    "fixture-chat",
    "fixture-chat",
  ]);
  expect(requests.every((item) => item.messages.at(-1)?.content === text)).toBe(
    true,
  );
});

describe("a request that only opens one web address, read by grammar", () => {
  const site = "https://app.example.com/";
  it.each([
    ["open example.com", { url: "https://example.com/" }],
    ["Open app.example.com", { url: site }],
    ["just open app.example.com", { url: site }],
    ["OPEN EXAMPLE.COM", { url: "https://example.com/" }],
    // The sentence of the session: fillers, the address, a browser by its name.
    [
      "Bro, just open app.example.com on Fixture Browser.",
      { url: site, browser: "Fixture Browser" },
    ],
    [
      "ok can you open app.example.com in Fixture Browser?",
      { url: site, browser: "Fixture Browser" },
    ],
    ["open app.example.com with Fixture", { url: site, browser: "Fixture" }],
    [
      "open app.example.com in the Fixture browser",
      { url: site, browser: "Fixture browser" },
    ],
    [
      "Hey, could you please open https://app.example.com/board?view=all using Fixture Browser",
      {
        url: "https://app.example.com/board?view=all",
        browser: "Fixture Browser",
      },
    ],
    [
      "yo open app.example.com on Fixture Browser now please",
      { url: site, browser: "Fixture Browser" },
    ],
    // Other plain words for the same request.
    ["go to www.example.org", { url: "https://www.example.org/" }],
    ["please visit example.com/docs now", { url: "https://example.com/docs" }],
    ["pull up example.com for me", { url: "https://example.com/" }],
    ["navigate to example.com, thanks", { url: "https://example.com/" }],
    ["open up example.com", { url: "https://example.com/" }],
    ["open the site example.com", { url: "https://example.com/" }],
    [
      "open the link https://example.com/a/b#top",
      { url: "https://example.com/a/b#top" },
    ],
    // Words that name no browser: the usual one opens it.
    ["open example.com in the browser", { url: "https://example.com/" }],
    [
      "open example.com in my default browser please",
      { url: "https://example.com/" },
    ],
    ["open example.com on this Mac", { url: "https://example.com/" }],
    // The address alone.
    ["example.com", { url: "https://example.com/" }],
    ["https://example.com/path", { url: "https://example.com/path" }],
    [
      "example.com in Fixture Browser",
      { url: "https://example.com/", browser: "Fixture Browser" },
    ],
    // An ending that files have too: with a browser, "www." or a scheme it is a site.
    [
      "open example-shop.in in Fixture Browser",
      { url: "https://example-shop.in/", browser: "Fixture Browser" },
    ],
    ["open www.example-shop.in", { url: "https://www.example-shop.in/" }],
    ["open https://example-shop.in", { url: "https://example-shop.in/" }],
    // A server of this Mac has no https.
    ["open localhost:3000", { url: "http://localhost:3000/" }],
    [
      "open http://127.0.0.1:8080/health",
      { url: "http://127.0.0.1:8080/health" },
    ],
  ] as const)("takes: %s", (message, expected) => {
    expect(directAddress(message)).toEqual(expected);
    // The address is the person's own, so the checks ask nothing before it opens.
    expect(
      check(
        { kind: "open_url", ...expected },
        {
          observation: observation(),
          page: null,
          fresh: true,
          browser: false,
          goal: message,
        },
        "",
      ),
    ).toMatchObject({
      verdict: "run",
      risk: null,
      send: { via: "hands", command: { kind: "open_url", ...expected } },
    });
  });

  it.each([
    // The address is a part of a longer task: the planner does all of it.
    "open example.com and log in",
    "open example.com in Fixture Browser and log in",
    "open example.com then close the other tab",
    "open the settings of example.com",
    "search example.com for shoes",
    "open example.com and example.org",
    "open example.com example.org",
    "open example.com tomorrow",
    "open example.com in a new tab",
    "open example.com in a private window",
    "open example.com on my phone",
    "open example.com on desktop 2",
    "open example.com on the left side",
    // A file, and a word with a dot that is no address.
    "open ~/Documents/example.com.txt",
    "open /Users/me/site/index.html",
    "open file:///etc/hosts",
    "open notes.txt",
    "open README.md",
    // A bare name with an ending that files have too: the planner reads it.
    "open MANIFEST.in",
    "open requirements.in",
    "open setup.info",
    "open score.ly",
    "open example-shop.in",
    "open Notes.app",
    "open v1.2.3",
    "open section 4.b",
    "open example",
    // Not a web address that may be opened.
    "open mailto:someone@example.com",
    "open https://user:secret@example.com/",
    "open javascript:alert(1)",
    "open ftp://example.com",
    "open https://b\u00fccher.example.com/",
    // A sentence that only speaks about an address.
    "example.com is down",
    "what is example.com?",
    "is example.com open?",
    "did you open example.com?",
    "open example.com?",
    "don't open example.com",
    "do not open example.com",
    "never open example.com",
    "I opened example.com yesterday",
    "the page says open example.com",
    "hey example.com",
    // Another request: the reader's business, as before.
    "open the browser",
    "go to Notes",
    "",
    "   ",
  ])("leaves to the planner: %s", (message) => {
    expect(directAddress(message)).toBeNull();
  });
});

describe("a direct request for a web address in the worker", () => {
  const roots: string[] = [];
  afterEach(() =>
    roots
      .splice(0)
      .forEach((path) => rmSync(path, { recursive: true, force: true })),
  );
  const before = observation([], { surfaceEpoch: 7 });
  const shown = observation([], {
    surfaceEpoch: 8,
    app: {
      name: "Fixture Browser",
      bundleId: "com.example.fixture-browser",
      window: "Example Domain",
    },
  });
  const said = "Bro, just open app.example.com on Fixture Browser.";
  const opened: HandCommand = {
    kind: "open_url",
    url: "https://app.example.com/",
    browser: "Fixture Browser",
  };
  const done: Action = {
    kind: "done",
    summary: "The page Example Domain is in front in Fixture Browser.",
  };
  type Script = ConstructorParameters<typeof ScriptedPlanner>[0];
  function setup(script: Script, reader?: NavigationIntent) {
    const root = mkdtempSync(join(tmpdir(), "clawdtime-direct-address-"));
    roots.push(root);
    const hands = new FakeHands([before, shown]);
    const read: string[] = [];
    const scripted = new ScriptedPlanner(script);
    const planner = reader
      ? Object.assign(scripted, {
          navigation: async (goal: string) => {
            read.push(goal);
            return reader;
          },
        })
      : scripted;
    const told: string[] = [];
    const worker = new ComputerWorker({
      hands,
      planner,
      journal: new ComputerJournal(root),
      notify: (text) => told.push(text),
    });
    return { hands, planner: scripted, worker, read, told };
  }
  const kinds = (commands: HandCommand[]) =>
    commands.map((command) => command.kind);
  /** Nothing of a pointer and nothing of a keyboard. */
  const pointerOrKeys = (commands: HandCommand[]) =>
    commands.filter((command) =>
      ["move", "click", "drag", "scroll", "type", "key"].includes(command.kind),
    );

  it("opens the address in the named browser with no pointer and no key, then looks, and the planner says what the screen shows", async () => {
    const f = setup([done]);
    // The supervisor's reader said: work for the planner.
    await f.worker.submitRead("one", said, { kind: "none" });
    await f.worker.idle();
    expect(f.hands.sent).toEqual([opened]);
    expect(pointerOrKeys(f.hands.commands)).toEqual([]);
    // A look, the address, and a new look before anything is said.
    expect(kinds(f.hands.commands)).toEqual(["observe", "open_url", "observe"]);
    expect(f.hands.labels[1]).toBe("Open app.example.com in Fixture Browser");
    // The model was not asked for the opening. It was asked once, after it,
    // with the step and the screen that came after the address went out.
    expect(f.planner.inputs).toHaveLength(1);
    expect(f.planner.inputs[0]!.history).toEqual([
      {
        step: 1,
        action: opened,
        why: "The person asked to open this address.",
        outcome: "ok",
      },
    ]);
    expect(f.planner.inputs[0]!.observation?.app.window).toBe("Example Domain");
    expect(f.worker.status()).toMatchObject({
      state: "completed",
      message: "Done. The page Example Domain is in front in Fixture Browser.",
    });
    expect(handCommandSchema.parse(opened)).toEqual(opened);
  });

  it("opens it in the usual browser when the person names none", async () => {
    const f = setup([done]);
    await f.worker.submitRead("one", "ok can you open app.example.com?", {
      kind: "none",
    });
    await f.worker.idle();
    expect(f.hands.sent).toEqual([
      { kind: "open_url", url: "https://app.example.com/" },
    ]);
    expect(f.hands.labels[1]).toBe("Open app.example.com");
    expect(f.worker.status().state).toBe("completed");
  });

  it("opens the address also when the reading took the browser for an app to bring forward", async () => {
    const f = setup([done]);
    await f.worker.submitRead("one", said, {
      kind: "app",
      name: "Fixture Browser",
    });
    await f.worker.idle();
    // No move to the app alone, which would drop the address.
    expect(f.hands.sent).toEqual([opened]);
    expect(f.worker.status().state).toBe("completed");
  });

  it("asks no model what the request means when it comes with no reading", async () => {
    const f = setup([done], { kind: "app", name: "Fixture Browser" });
    await f.worker.submit("one", said);
    await f.worker.idle();
    expect(f.read).toEqual([]);
    expect(f.hands.sent).toEqual([opened]);
  });

  it("does not say done from the sent address alone: with no look after it, done is refused", async () => {
    const f = setup([done, done, done]);
    // Every look after the address fails.
    let sent = false;
    f.hands.answer = (command) => {
      if (command.kind === "open_url") sent = true;
      return sent && command.kind === "observe"
        ? { ok: false, error: "failed" }
        : undefined;
    };
    await f.worker.submitRead("one", said, { kind: "none" });
    await f.worker.idle();
    expect(f.hands.sent).toEqual([opened]);
    expect(f.planner.inputs[1]!.history.at(-1)!.outcome).toBe(
      "refused: Done needs a view of the screen that is newer than the last action.",
    );
    expect(f.worker.status().state).toBe("blocked");
    expect(f.told.join(" ")).not.toMatch(/^Done\./);
  });

  it("sends nothing while the person uses the Mac, as for an app, and opens the address after continue", async () => {
    const f = setup([done]);
    // The person types in another window while the worker looks.
    let left = 1;
    f.hands.answer = (command) =>
      command.kind === "observe" && command.image && left-- > 0
        ? { interrupted: true }
        : undefined;
    await f.worker.submitRead("one", said, { kind: "none" });
    await until(() => f.worker.snapshot().state === "waiting_for_person");
    expect(f.hands.sent).toEqual([]);
    expect(f.worker.snapshot().message).toBe(
      "You are using the Mac, so I hold. Next I wanted to open app.example.com in Fixture Browser. Say continue when your hands are off, or stop.",
    );
    // The model is not asked in between either.
    expect(f.planner.inputs).toHaveLength(0);
    expect((await f.worker.answer("continue")).message).toBe("Continuing.");
    await f.worker.idle();
    expect(f.hands.sent).toEqual([opened]);
    expect(pointerOrKeys(f.hands.commands)).toEqual([]);
    expect(f.worker.status().state).toBe("completed");
  });

  it("pauses when the hands held the address back for the person, and opens it after continue", async () => {
    // The hands sent nothing: after continue the direct step opens the address, and then the planner decides.
    const f = setup([done]);
    let first = true;
    f.hands.answer = (command) => {
      if (command.kind !== "open_url" || !first) return undefined;
      first = false;
      // The person pressed a key just before the address went out.
      return { ok: false, error: "refused", interrupted: true };
    };
    await f.worker.submitRead("one", said, { kind: "none" });
    await until(() => f.worker.snapshot().state === "waiting_for_person");
    expect(f.worker.snapshot().message).toMatch(
      /^You are using the Mac, so I hold/,
    );
    expect(f.hands.commands.filter((c) => c.kind === "open_url")).toHaveLength(
      1,
    );
    expect(f.planner.inputs).toHaveLength(0);
    await f.worker.answer("continue");
    await f.worker.idle();
    expect(f.planner.inputs).toHaveLength(1);
    expect(f.planner.inputs[0]!.history).toMatchObject([
      { action: opened, outcome: "not sent: The person took over." },
      { action: opened, outcome: "ok" },
    ]);
    expect(f.hands.sent).toEqual([opened, opened]);
    expect(f.worker.status().state).toBe("completed");
  });

  it("tells the planner when no app of that name opens web addresses, and opens nothing else by itself", async () => {
    const f = setup([
      { kind: "give_up", reason: "No browser named Fixture Browser is here." },
    ]);
    f.hands.answer = (command) =>
      command.kind === "open_url"
        ? { ok: false, error: "not_found" }
        : undefined;
    await f.worker.submitRead("one", said, { kind: "none" });
    await f.worker.idle();
    expect(f.hands.sent).toEqual([opened]);
    expect(f.planner.inputs[0]!.history).toEqual([
      {
        step: 1,
        action: opened,
        why: "The person asked to open this address.",
        outcome: expect.stringMatching(
          /^refused: No app with that name opens web addresses on this Mac\. Nothing was opened\./,
        ),
      },
    ]);
    expect(f.worker.status()).toMatchObject({
      state: "blocked",
      message: "I could not finish. No browser named Fixture Browser is here.",
    });
  });

  describe("an address that the planner opens in the middle of a task", () => {
    const board: HandCommand = {
      kind: "open_url",
      url: "https://board.example.com/",
      browser: "Fixture Browser",
    };
    const asks = (f: ReturnType<typeof setup>, words: string) =>
      until(() => f.worker.status().question?.includes(words) === true);
    // The app is not on this Mac, and the person says: open it in the browser.
    const begin = async () => {
      const f = setup([
        { kind: "open_app", name: "Fixture Board" },
        { kind: "ask", question: "Should I open it in the browser?" },
        board,
        done,
      ]);
      f.hands.answer = (command) =>
        command.kind === "open_app"
          ? { ok: false, error: "not_found" }
          : undefined;
      await f.worker.submitRead(
        "one",
        "open Fixture Board for me and find the board",
        { kind: "none" },
      );
      await asks(f, "Should I open it in the browser?");
      await f.worker.answer("just open it in Fixture Browser");
      // The planner chose the address: the person did not say it.
      await asks(f, "is not in your request");
      return f;
    };
    it("needs the person's yes when they did not name it, and then opens with no pointer and no key", async () => {
      const f = await begin();
      expect(f.worker.status().question).toBe(
        "Open board.example.com in Fixture Browser? The address board.example.com is not in your request. Say yes to allow it, or no to stop.",
      );
      expect(f.hands.sent).toEqual([
        { kind: "open_app", name: "Fixture Board" },
      ]);
      await f.worker.answer("yes");
      await f.worker.idle();
      expect(f.hands.sent).toEqual([
        { kind: "open_app", name: "Fixture Board" },
        board,
      ]);
      expect(pointerOrKeys(f.hands.commands)).toEqual([]);
      // Done came after a look that is newer than the address.
      expect(kinds(f.hands.commands).slice(-2)).toEqual([
        "open_url",
        "observe",
      ]);
      expect(f.worker.status().state).toBe("completed");
    });
    it("opens nothing after a no", async () => {
      const f = await begin();
      expect((await f.worker.answer("no")).message).toBe(
        "Canceled. I did not do it: Open board.example.com in Fixture Browser.",
      );
      await f.worker.idle();
      expect(f.hands.sent).toEqual([
        { kind: "open_app", name: "Fixture Board" },
      ]);
      expect(f.worker.status().state).toBe("canceled");
    });
  });

  it("gives a longer task with an address to the planner, as before", async () => {
    const f = setup([{ kind: "give_up", reason: "The script ended." }]);
    await f.worker.submitRead("one", "open app.example.com and log in", {
      kind: "none",
    });
    await f.worker.idle();
    expect(f.planner.inputs).toHaveLength(1);
    expect(f.planner.inputs[0]!.history).toEqual([]);
    expect(f.hands.sent).toEqual([]);
  });
});
