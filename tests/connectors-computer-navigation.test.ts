import { describe, expect, it } from "vitest";
import { OpenAIModel } from "../connectors/agents/brain.js";
import { OpenAIPlanner } from "../connectors/computer/planner.js";
import { navigationRules } from "../connectors/computer/navigation.js";
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
