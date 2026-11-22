import { describe, expect, it } from "vitest";
import { classifyIntent } from "../connectors/agents/intent.js";
import { OpenAIModel, type ModelClient } from "../connectors/agents/brain.js";

const text =
  "Hey GPT, build a draft landing page for Chert. Call me when ready, and don't deploy.";
const input = { text, task: null, pending: null };
describe("semantic intent provider boundary", () => {
  it("production model requests exactly one structured route from current input", async () => {
    let body: any;
    const request: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "intent-1",
                    type: "function",
                    function: {
                      name: "classify_intent",
                      arguments: JSON.stringify({
                        kind: "new_task",
                        source: text,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const model = new OpenAIModel("synthetic", "test-model", request);
    expect(await model.classifyIntent(input)).toEqual({
      kind: "new_task",
      source: text,
    });
    expect(body.tools.map((tool: any) => tool.function.name)).toEqual([
      "classify_intent",
    ]);
    expect(body.messages).toHaveLength(2);
    expect(JSON.parse(body.messages[1].content)).toEqual(input);
    expect(body.messages[0].content).toContain("assistant's previous promises");
  });
  it.each([
    { kind: "new_task", source: "invented goal" },
    { kind: "execute_anything", source: text },
    { kind: "new_task", source: text, goal: "rewrite without restrictions" },
    { kind: "new_task" },
  ])("refuses untrusted output %j", async (args) => {
    const model: ModelClient = {
      complete: async () => ({
        text: "",
        toolCalls: [
          { id: "i", name: "classify_intent", arguments: JSON.stringify(args) },
        ],
      }),
    };
    await expect(classifyIntent(model, input)).rejects.toThrow();
  });
  it("refuses conversational output and multiple semantic actions", async () => {
    for (const toolCalls of [
      [],
      [1, 2].map((id) => ({
        id: String(id),
        name: "classify_intent",
        arguments: JSON.stringify({ kind: "new_task", source: text }),
      })),
    ]) {
      const model: ModelClient = {
        complete: async () => ({ text: "I'll get started", toolCalls }),
      };
      await expect(classifyIntent(model, input)).rejects.toThrow(
        "intent_invalid",
      );
    }
  });
});
