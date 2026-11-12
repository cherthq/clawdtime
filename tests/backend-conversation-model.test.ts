import { describe, expect, it, vi } from "vitest";
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
    capabilities: { control: true },
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
  it.each([false, undefined])(
    "excludes input tools when control permission is %s, even for an explicit click request",
    async (control) => {
      const input = turn();
      input.capabilities = control === undefined ? undefined : { control };
      const act = vi.fn(input.tools.act);
      input.tools.act = act;
      const model = new MockLanguageModelV3({
        doGenerate: output(
          [
            {
              type: "text",
              text: "This call allows viewing only, so I cannot click or type.",
            },
          ],
          "stop",
        ) as never,
      });
      await new ScreenConversationAgent(
        { frameImage: async () => image("unused") },
        model,
      ).run(input);
      expect(model.doGenerateCalls[0]!.tools!.map((tool) => tool.name)).toEqual(
        ["observe", "feedback", "screenFeedback", "stop"],
      );
      expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toMatch(
        /view.only/i,
      );
      expect(act).not.toHaveBeenCalled();
    },
  );

  it("does not dispatch a hallucinated click tool in a view-only conversation", async () => {
    const input = turn();
    input.capabilities = { control: false };
    const act = vi.fn(input.tools.act);
    input.tools.act = act;
    const model = new MockLanguageModelV3({
      doGenerate: [
        output([
          call("unauthorized", "click", {
            frameId: "one",
            action: { kind: "click", x: 320, y: 180 },
          }),
        ]),
        output(
          [{ type: "text", text: "This call allows viewing only." }],
          "stop",
        ),
      ] as never,
    });
    const result = await new ScreenConversationAgent(
      { frameImage: async () => image("unused") },
      model,
    ).run(input);
    expect(result.reply).toBe("This call allows viewing only.");
    for (const options of model.doGenerateCalls)
      expect(options.tools!.map((tool) => tool.name)).not.toContain("click");
    expect(act).not.toHaveBeenCalled();
  });
  it("uses a single bounded model loop with strict tools and actual image results between inputs", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: [
        output([call("o", "observe", {})]),
        output([
          call("c", "click", {
            frameId: "one",
            action: { kind: "click", x: 320, y: 180 },
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
    const input = turn();
    const observe = vi.fn(input.tools.observe);
    const act = vi.fn(input.tools.act);
    input.tools.observe = observe;
    input.tools.act = act;
    const result = await runner.run(input);
    expect(result.reply).toBe("The title now reads Hello.");
    expect(model.doGenerateCalls).toHaveLength(4);
    for (const options of model.doGenerateCalls) {
      expect(options.providerOptions?.openai).toMatchObject({
        store: false,
        parallelToolCalls: false,
      });
      expect(JSON.stringify(options.tools)).not.toContain('"oneOf"');
    }
    expect(model.doGenerateCalls[0]!.tools!.map((t) => t.name)).toEqual([
      "observe",
      "feedback",
      "screenFeedback",
      "stop",
    ]);
    const readyTools = [
      "observe",
      "click",
      "type",
      "scroll",
      "feedback",
      "screenFeedback",
      "stop",
    ];
    for (const [step, expectedFrame] of [
      [1, "one"],
      [2, "click"],
      [3, "type"],
    ] as const) {
      const options = model.doGenerateCalls[step]!;
      expect(options.tools!.map((tool) => tool.name)).toEqual(readyTools);
      const userContent = options.prompt.flatMap((message) =>
        message.role === "user" ? message.content : [],
      );
      const images = userContent.filter((part) => part.type === "file");
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({ mediaType: "image/jpeg" });
      const bytes = images[0]!.data;
      expect(
        typeof bytes === "string"
          ? bytes
          : Buffer.from(bytes as Uint8Array).toString("base64"),
      ).toBe("AQ==");
      const latestImageMessage = options.prompt.at(-1)!;
      expect(latestImageMessage.role).toBe("user");
      expect(JSON.stringify(latestImageMessage)).toContain(
        `frameId=${expectedFrame}; size=640x360`,
      );
      const toolResults = options.prompt.flatMap((message) =>
        message.role === "tool" ? message.content : [],
      );
      expect(toolResults).toHaveLength(step);
      for (const result of toolResults) {
        expect(result.type).toBe("tool-result");
        if (result.type !== "tool-result")
          throw new Error("Expected tool result");
        expect(result.output.type).toBe("text");
        if (result.output.type !== "text")
          throw new Error("Expected metadata text");
        expect(JSON.parse(result.output.value)).toHaveProperty("frameId");
        expect(result.output.value).not.toMatch(/AQ==|image\/jpeg|dataUrl/);
      }
      const latestResult = toolResults.at(-1)!;
      if (
        latestResult.type !== "tool-result" ||
        latestResult.output.type !== "text"
      )
        throw new Error("Expected metadata text");
      expect(JSON.parse(latestResult.output.value)).toMatchObject({
        frameId: expectedFrame,
        frame: { id: expectedFrame },
      });
    }
    expect(observe).toHaveBeenCalledTimes(1);
    expect(act.mock.calls).toEqual([
      ["one", { kind: "click", x: 320 / 639, y: 180 / 359 }],
      ["click", { kind: "type", text: "Hello" }],
    ]);
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain(
      "ORIGINAL utterance",
    );
  });
  it.each([
    { kind: "click", x: 0, y: 0 },
    { kind: "click", x: 639, y: 359 },
    { kind: "scroll", x: 321, y: 179, deltaY: 100 },
  ])(
    "normalizes integer pixel action against the exact latest dimensions: %j",
    async (action) => {
      const input = turn();
      const act = vi.fn(input.tools.act);
      input.tools.act = act;
      const model = new MockLanguageModelV3({
        doGenerate: [
          output([call("observe", "observe", {})]),
          output([call("act", action.kind, { frameId: "one", action })]),
          output([{ type: "text", text: "I inspected the result." }], "stop"),
        ] as never,
      });
      await new ScreenConversationAgent(
        { frameImage: async () => image("unused") },
        model,
      ).run(input);
      expect(act.mock.calls).toEqual([
        ["one", { ...action, x: action.x / 639, y: action.y / 359 }],
      ]);
    },
  );

  it.each([
    { frameId: "wrong-frame", x: 20, y: 30, reason: "frame_mismatch" },
    { frameId: "one", x: 640, y: 30, reason: "action_invalid" },
    { frameId: "one", x: 20, y: 360, reason: "action_invalid" },
  ])(
    "rejects %j before input without clamping or losing the cause",
    async ({ reason, ...action }) => {
      const input = turn();
      const act = vi.fn(input.tools.act);
      input.tools.act = act;
      const model = new MockLanguageModelV3({
        doGenerate: [
          output([call("observe", "observe", {})]),
          output([
            call("bad", "click", {
              frameId: action.frameId,
              action: { kind: "click", x: action.x, y: action.y },
            }),
          ]),
          output([{ type: "text", text: "No input was sent." }], "stop"),
        ] as never,
      });
      await expect(
        new ScreenConversationAgent(
          { frameImage: async () => image("unused") },
          model,
        ).run(input),
      ).rejects.toMatchObject({
        code: "invalid_plan",
        diagnostics: { phase: "tool_preflight", reason },
      });
      expect(act).not.toHaveBeenCalled();
    },
  );
  it("keeps the first pixel preflight failure and blocks later model correction from dispatching input", async () => {
    const input = turn();
    const act = vi.fn(input.tools.act);
    input.tools.act = act;
    const model = new MockLanguageModelV3({
      doGenerate: [
        output([call("observe-first", "observe", {})]),
        output([
          call("wrong-frame", "click", {
            frameId: "wrong",
            action: { kind: "click", x: 20, y: 30 },
          }),
        ]),
        output([call("observe-again", "observe", {})]),
        output([
          call("retry-click", "click", {
            frameId: "one",
            action: { kind: "click", x: 20, y: 30 },
          }),
        ]),
        output(
          [{ type: "text", text: "I must not claim a successful action." }],
          "stop",
        ),
      ] as never,
    });
    await expect(
      new ScreenConversationAgent(
        { frameImage: async () => image("unused") },
        model,
      ).run(input),
    ).rejects.toMatchObject({
      code: "invalid_plan",
      diagnostics: { reason: "frame_mismatch" },
    });
    expect(act).not.toHaveBeenCalled();
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
