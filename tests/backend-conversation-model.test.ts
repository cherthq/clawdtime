import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  ScreenConversationAgent,
  configuredConversationAgent,
  type ConversationTurn,
} from "../src/control/conversation.js";
import type { MediaDevicePort } from "../media/device-port.js";
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const output = (
  content: any[],
  reason: "tool-calls" | "stop" = "tool-calls",
) => ({
  content,
  finishReason: { unified: reason, raw: reason },
  usage,
  warnings: [],
});
const call = (id: string, name: string, input: unknown) => ({
  type: "tool-call",
  toolCallId: id,
  toolName: name,
  input: JSON.stringify(input),
});
const image = (id: string) => ({
  frame: { id, capturedAt: Date.now(), width: 640, height: 360 },
  dataUrl: "data:image/jpeg;base64,AQ==",
});
function turn(): ConversationTurn {
  return {
    text: "Click the title and type Hello.",
    question: "Choose a title.",
    history: [],
    signal: new AbortController().signal,
    tools: {
      observe: async () => image("one"),
      act: async (_frame, action) => ({
        ...image(action.kind),
        receipt: {
          id: action.kind,
          leaseId: "lease",
          frameId: _frame,
          state: "observed",
          createdAt: Date.now(),
        },
      }),
      feedback: async () => ({ responseId: "response" }),
      screenFeedback: async () => ({ recorded: true }),
      stop: async () => ({ stopped: true }),
    },
  };
}
describe("conversation SDK contract", () => {
  it("uses a single bounded model loop with strict tools and actual image results between inputs", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: [
        output([call("o", "observe", {})]),
        output([
          call("c", "click", {
            frameId: "one",
            action: { kind: "click", x: 0.5, y: 0.5 },
          }),
        ]),
        output([
          call("t", "type", {
            frameId: "click",
            action: { kind: "type", text: "Hello" },
          }),
        ]),
        output([{ type: "text", text: "The title now reads Hello." }], "stop"),
      ] as never,
    });
    const runner = new ScreenConversationAgent(
      { frameImage: async () => image("unused") },
      model,
    );
    const result = await runner.run(turn());
    expect(result.reply).toBe("The title now reads Hello.");
    expect(model.doGenerateCalls).toHaveLength(4);
    for (const options of model.doGenerateCalls) {
      expect(options.providerOptions?.openai).toMatchObject({
        store: false,
        parallelToolCalls: false,
      });
      expect(JSON.stringify(options.tools)).not.toContain('"oneOf"');
    }
    const tools = model.doGenerateCalls[0]!.tools!;
    expect(tools.map((t) => t.name)).toEqual([
      "observe",
      "click",
      "type",
      "scroll",
      "feedback",
      "screenFeedback",
      "stop",
    ]);
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain(
      "image/jpeg",
    );
    expect(JSON.stringify(model.doGenerateCalls[2]!.prompt)).toContain(
      '"frameId":"one"',
    );
    expect(JSON.stringify(model.doGenerateCalls[3]!.prompt)).toContain(
      "image/jpeg",
    );
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain(
      "ORIGINAL utterance",
    );
  });
  it("bounds runaway model tool loops", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        output([call(`o${++calls}`, "observe", {})]) as never,
    });
    await expect(
      new ScreenConversationAgent(
        { frameImage: async () => image("unused") },
        model,
      ).run(turn()),
    ).rejects.toMatchObject({ code: "planner_unavailable" });
    expect(calls).toBe(8);
  });
  it("does not select an implicit provider or accept an unconfigured model", () => {
    const device = {} as MediaDevicePort;
    expect(configuredConversationAgent(device, {})).toBeUndefined();
    expect(() =>
      configuredConversationAgent(device, { CLAWDTIME_AI_ACTIONS: "true" }),
    ).toThrow("Explicit");
    expect(() =>
      configuredConversationAgent(device, {
        CLAWDTIME_AI_ACTIONS: "true",
        CLAWDTIME_AI_MODEL: "fixture",
      }),
    ).toThrow("independent");
  });
  it("sanitizes provider failures before they enter the durable router", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("PRIVATE_PROVIDER_URL");
      },
    });
    await expect(
      new ScreenConversationAgent(
        { frameImage: async () => image("unused") },
        model,
      ).run(turn()),
    ).rejects.toMatchObject({
      code: "planner_unavailable",
      message: "The screen action planner is unavailable.",
    });
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});
