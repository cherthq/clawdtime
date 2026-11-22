import { describe, expect, it } from "vitest";
import {
  OpenAIModel,
  defaultReaderModel,
  supervisorModel,
} from "../connectors/agents/brain.js";
import { OpenAIPlanner } from "../connectors/computer/planner.js";
import {
  navigationRules,
  navigationTools,
} from "../connectors/computer/navigation.js";
import { check } from "../connectors/computer/guards.js";
import { observation } from "./connectors-computer-fixture.js";

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
