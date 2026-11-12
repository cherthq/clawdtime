import { describe, expect, it } from "vitest";
import { createOpenAI } from "@ai-sdk/openai";
import jpeg from "jpeg-js";
import {
  ScreenConversationAgent,
  type ConversationTurn,
} from "../src/control/conversation.js";

// Synthetic pixels only. Intercepted adapters make no network or device requests.
function image(id: string, red: number) {
  const pixels = Buffer.alloc(16 * 12 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = red;
    pixels[index + 3] = 255;
  }
  return {
    frame: { id, capturedAt: Date.now(), width: 16, height: 12 },
    dataUrl: `data:image/jpeg;base64,${jpeg.encode({ data: pixels, width: 16, height: 12 }).data.toString("base64")}`,
  };
}

type Surface = "chat" | "responses";
function reply(
  surface: Surface,
  index: number,
  text = "I inspected the new image.",
) {
  const call =
    index === 0
      ? { id: "observe_fixture", name: "observe", arguments: "{}" }
      : index === 1
        ? {
            id: "click_fixture",
            name: "click",
            arguments: JSON.stringify({
              frameId: "before_fixture",
              action: { kind: "click", x: 4, y: 6 },
            }),
          }
        : undefined;
  if (surface === "chat")
    return {
      id: `fixture_${index}`,
      object: "chat.completion",
      created: 1,
      model: "fixture-model",
      choices: [
        {
          index: 0,
          finish_reason: call ? "tool_calls" : "stop",
          message: {
            role: "assistant",
            content: call ? null : text,
            ...(call
              ? {
                  tool_calls: [
                    {
                      id: call.id,
                      type: "function",
                      function: { name: call.name, arguments: call.arguments },
                    },
                  ],
                }
              : {}),
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  return {
    id: `fixture_${index}`,
    created_at: 1,
    model: "fixture-model",
    output: call
      ? [
          {
            type: "function_call",
            id: `item_${index}`,
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
            status: "completed",
          },
        ]
      : [
          {
            type: "message",
            id: `message_${index}`,
            role: "assistant",
            content: [
              {
                type: "output_text",
                text,
                annotations: [],
              },
            ],
          },
        ],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function wireImages(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(wireImages);
  if (!value || typeof value !== "object") return [];
  const part = value as Record<string, unknown>;
  if (part.type === "input_image" && typeof part.image_url === "string")
    return [part.image_url];
  if (
    part.type === "image_url" &&
    part.image_url &&
    typeof part.image_url === "object"
  ) {
    return [String((part.image_url as { url: string }).url)];
  }
  return Object.values(part).flatMap(wireImages);
}

describe("actual provider image wire", () => {
  it.each(["chat", "responses"] as const)(
    "preserves observe and action pixels as %s image input without serializing them into tool text",
    async (surface) => {
      const requests: any[] = [];
      const before = image("before_fixture", 40),
        after = image("after_fixture", 180);
      let observations = 0,
        actions = 0;
      const provider = createOpenAI({
        apiKey: "synthetic-fixture-not-a-credential",
        fetch: async (_url, init) => {
          const index = requests.length;
          requests.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify(reply(surface, index)), {
            headers: { "content-type": "application/json" },
          });
        },
      });
      const turn: ConversationTurn = {
        text: "Click the marked box.",
        question: "Help with this screen.",
        history: [],
        signal: new AbortController().signal,
        capabilities: { control: true },
        tools: {
          observe: async () => {
            observations++;
            return before;
          },
          act: async (frameId, action) => {
            actions++;
            expect(frameId).toBe(before.frame.id);
            expect(action).toEqual({ kind: "click", x: 4 / 15, y: 6 / 11 });
            return after;
          },
          feedback: async () => ({ responseId: "fixture" }),
          screenFeedback: async () => ({ recorded: true }),
          stop: async () => ({ stopped: true }),
        },
      };
      const model =
        surface === "chat"
          ? provider.chat("fixture-model")
          : provider.responses("fixture-model");
      expect(
        await new ScreenConversationAgent(
          { frameImage: async () => before },
          model,
        ).run(turn),
      ).toEqual({ reply: "I inspected the new image." });
      expect(requests).toHaveLength(3);
      expect(observations).toBe(1);
      expect(actions).toBe(1);
      expect(wireImages(requests[0])).toEqual([]);
      expect(wireImages(requests[1])).toContain(before.dataUrl);
      expect(wireImages(requests[2])).toContain(after.dataUrl);
      expect(
        wireImages(requests[1]).filter((url) => url === before.dataUrl),
      ).toHaveLength(1);
      expect(
        wireImages(requests[2]).filter((url) => url === after.dataUrl),
      ).toHaveLength(1);
      expect(
        wireImages(requests[2]).filter((url) => url === before.dataUrl).length,
      ).toBeLessThanOrEqual(1);
      for (const [index, screenshot] of [
        [1, before],
        [2, after],
      ] as const) {
        const wire = requests[index];
        const messages = surface === "chat" ? wire.messages : wire.input;
        const tools = messages.filter(
          (message: any) =>
            message.role === "tool" || message.type === "function_call_output",
        );
        expect(JSON.stringify(tools)).toContain(screenshot.frame.id);
        const toolText = tools
          .map((message: any) => {
            const content = message.content ?? message.output;
            return typeof content === "string"
              ? content
              : content.map((part: any) => part.text ?? "").join("");
          })
          .join("");
        expect(toolText).not.toContain(screenshot.dataUrl.split(",")[1]);
        expect(wire.parallel_tool_calls).toBe(false);
      }
    },
  );

  it.each(["chat", "responses"] as const)(
    "does not capture or attach pixels for ordinary %s conversation",
    async (surface) => {
      let requests = 0;
      const provider = createOpenAI({
        apiKey: "synthetic-fixture-not-a-credential",
        fetch: async (_url, init) => {
          requests++;
          expect(wireImages(JSON.parse(String(init?.body)))).toEqual([]);
          return new Response(JSON.stringify(reply(surface, 2, "Hello.")), {
            headers: { "content-type": "application/json" },
          });
        },
      });
      const forbidden = async (): Promise<never> => {
        throw new Error(
          "Ordinary conversation must not implicitly capture or act.",
        );
      };
      const turn: ConversationTurn = {
        text: "Hello.",
        question: "Help with this screen.",
        history: [],
        signal: new AbortController().signal,
        capabilities: { control: true },
        tools: {
          observe: forbidden,
          act: forbidden,
          feedback: forbidden,
          screenFeedback: forbidden,
          stop: forbidden,
        },
      };
      const model =
        surface === "chat"
          ? provider.chat("fixture-model")
          : provider.responses("fixture-model");
      await expect(
        new ScreenConversationAgent({ frameImage: forbidden }, model).run(turn),
      ).resolves.toEqual({ reply: "Hello." });
      expect(requests).toBe(1);
    },
  );
});
