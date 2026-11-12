import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import jpeg from "jpeg-js";
import {
  runTargetingProbe,
  targetingEvaluationCases,
} from "./media-targeting-fixture.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
function response(content: unknown[], reason = "tool-calls") {
  return {
    content,
    finishReason: { unified: reason, raw: reason },
    usage,
    warnings: [],
  };
}
function call(name: string, input: unknown, sequence: number) {
  return response([
    {
      type: "tool-call",
      toolCallId: `fixture-tool-${sequence}`,
      toolName: name,
      input: JSON.stringify(input),
    },
  ]);
}
/** Read what actually reaches the SDK model boundary, never page/DOM geometry. */
function screenshot(prompt: unknown) {
  let bytes: Buffer | undefined;
  let frame: { id: string; width: number; height: number } | undefined;
  const unpack = (value: unknown): Buffer | undefined => {
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === "string")
      return Buffer.from(
        value.replace(/^data:image\/jpeg;base64,/, ""),
        "base64",
      );
    if (value && typeof value === "object" && "data" in value)
      return unpack(value.data);
  };
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || value instanceof Uint8Array)
      return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const item = value as Record<string, unknown>;
    if (item.frame && typeof item.frame === "object" && "id" in item.frame)
      frame = item.frame as typeof frame;
    if (
      (item.type === "file" && item.mediaType === "image/jpeg") ||
      item.type === "image" ||
      item.type === "image-data"
    ) {
      const image = unpack(item.data ?? item.image);
      if (image) bytes = image;
    }
    const contentText =
      typeof item.text === "string"
        ? item.text
        : typeof item.value === "string"
          ? item.value
          : undefined;
    if (contentText) {
      const bound = /frameId=([A-Za-z0-9_-]+); size=(\d+)x(\d+)/.exec(
        contentText,
      );
      if (bound)
        frame = {
          id: bound[1]!,
          width: Number(bound[2]),
          height: Number(bound[3]),
        };
      try {
        const parsed = JSON.parse(contentText);
        if (parsed.frame?.id) frame = parsed.frame;
      } catch {
        /* Instructions and prose do not contain trusted frame metadata. */
      }
    }
    for (const [key, entry] of Object.entries(item))
      if (key !== "data" && key !== "image") visit(entry);
  };
  visit(prompt);
  expect(bytes, "model must receive actual JPEG bytes").toBeDefined();
  expect(
    frame,
    "model must receive bound frame dimensions/identity",
  ).toBeDefined();
  const decoded = jpeg.decode(bytes!, { useTArray: true });
  expect(decoded.width).toBe(frame!.width);
  expect(decoded.height).toBe(frame!.height);
  return { frame: frame!, decoded };
}
function colorCenter(
  image: ReturnType<typeof screenshot>["decoded"],
  focused: boolean,
) {
  let count = 0,
    xTotal = 0,
    yTotal = 0;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const at = (y * image.width + x) * 4;
      const r = image.data[at]!,
        g = image.data[at + 1]!,
        b = image.data[at + 2]!;
      const matches = focused
        ? g > 180 && r < 110 && b < 130
        : r > 190 && g < 70 && b > 120;
      if (matches) {
        count++;
        xTotal += x;
        yTotal += y;
      }
    }
  expect(
    count,
    "visible fixture target must be grounded from JPEG pixels",
  ).toBeGreaterThan(1000);
  return {
    x: Math.round(xTotal / count),
    y: Math.round(yTotal / count),
  };
}

describe("synthetic screenshot-to-textbox SDK targeting", () => {
  it("does not accept confident model narration when the click missed the textbox", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: [
        call("observe", {}, 1),
        call(
          "click",
          {
            frameId: "fixture-frame-1",
            action: { kind: "click", x: 830, y: 252 },
          },
          2,
        ),
        call(
          "type",
          {
            frameId: "fixture-frame-2",
            action: { kind: "type", text: "Hello ClawdTime" },
          },
          3,
        ),
        response(
          [
            {
              type: "text",
              text: "I successfully entered Hello ClawdTime in Title.",
            },
          ],
          "stop",
        ),
      ] as never,
    });
    const result = await runTargetingProbe(model);
    expect(result.error).toBeUndefined();
    expect(result.reply).toContain("successfully");
    expect(result.passed).toBe(false);
    expect(result.grading.typingFocusVerified).toBe(false);
    expect(result.targetValue).toBe("");
    expect(result.otherValue).toBe("");
    expect(result.events).toEqual([]);
    expect(result.afterActions.map((action) => action.focusedField)).toEqual([
      "",
      "",
    ]);
  }, 20_000);
  it("rejects correct final text obtained beyond the four-action budget", async () => {
    const steps = [call("observe", {}, 1)];
    for (let index = 1; index <= 5; index++)
      steps.push(
        call(
          "click",
          {
            frameId: `fixture-frame-${index}`,
            action: { kind: "click", x: 958, y: 272 },
          },
          index + 1,
        ),
      );
    steps.push(
      call(
        "type",
        {
          frameId: "fixture-frame-6",
          action: { kind: "type", text: "Hello ClawdTime" },
        },
        7,
      ),
    );
    steps.push(
      response(
        [{ type: "text", text: "The Title field shows Hello ClawdTime." }],
        "stop",
      ),
    );
    const model = new MockLanguageModelV3({ doGenerate: steps as never });
    const result = await runTargetingProbe(model);
    expect(result.error).toBeUndefined();
    expect(result.targetValue).toBe("Hello ClawdTime");
    expect(result.actions).toHaveLength(6);
    expect(model.doGenerateCalls).toHaveLength(8);
    expect(result.grading).toEqual({
      withinActionBudget: false,
      withinTimeBudget: true,
      completeActionObservations: true,
      notesUntouched: true,
      typingFocusVerified: true,
    });
    expect(result.passed).toBe(false);
  }, 20_000);
  it("rejects a completed DOM write when the actual router retains an unknown outcome", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: [
        call("observe", {}, 1),
        call(
          "click",
          {
            frameId: "fixture-frame-1",
            action: { kind: "click", x: 958, y: 272 },
          },
          2,
        ),
        call(
          "type",
          {
            frameId: "fixture-frame-4",
            action: { kind: "type", text: "Hello ClawdTime" },
          },
          3,
        ),
        response([{ type: "text", text: "The Title is now filled." }], "stop"),
      ] as never,
    });
    const result = await runTargetingProbe(model, {
      throughHumanRouter: true,
      changingBackground: true,
      failPostTypeObservation: true,
    });
    expect(result.targetValue).toBe("Hello ClawdTime");
    expect(result.actions).toHaveLength(2);
    expect(Object.values(result.grading).every(Boolean)).toBe(true);
    expect(result.routerOutcome).toEqual({ accepted: false, state: "unknown" });
    expect(result.error).toBe("router_not_completed");
    expect(result.passed).toBe(false);
  }, 20_000);
  it.each([
    ...targetingEvaluationCases,
    {
      name: "dynamic background through actual voice router and coordinator",
      options: {
        throughHumanRouter: true,
        changingBackground: true,
        generation: { reasoning: "medium" as const },
      },
    },
  ])(
    "uses full screenshot coordinates and verifies the intended textbox: $name",
    async ({ options }) => {
      const expectedText = options.text ?? "Hello ClawdTime";
      let step = 0;
      let modelFailure: unknown;
      const model = new MockLanguageModelV3({
        doGenerate: async ({ prompt }) => {
          try {
            step++;
            if (step === 1) return call("observe", {}, step) as never;
            const { frame, decoded } = screenshot(prompt);
            if (step === 2) {
              const point = colorCenter(decoded, false);
              return call(
                "click",
                { frameId: frame.id, action: { kind: "click", ...point } },
                step,
              ) as never;
            }
            colorCenter(decoded, true); // Post-click screenshot visibly proves focus in this fixture.
            if (step === 3)
              return call(
                "type",
                {
                  frameId: frame.id,
                  action: { kind: "type", text: expectedText },
                },
                step,
              ) as never;
            return response(
              [
                {
                  type: "text",
                  text: "The synthetic Title field now shows the requested text.",
                },
              ],
              "stop",
            ) as never;
          } catch (failure) {
            modelFailure = failure;
            throw failure;
          }
        },
      });
      const result = await runTargetingProbe(model, options);
      expect(modelFailure).toBeUndefined();
      expect(result.error).toBeUndefined();
      expect(result.passed).toBe(true);
      expect(Object.values(result.grading).every(Boolean)).toBe(true);
      expect(result.elapsedMs).toBeGreaterThan(0);
      expect(result.elapsedMs).toBeLessThan(45_000);
      expect(result.targetValue).toBe(expectedText);
      expect(result.otherValue).toBe("");
      expect(result.events).toEqual([
        { target: "title", event: "click" },
        { target: "title", event: "input" },
      ]);
      expect(result.actions.map((action) => action.kind)).toEqual([
        "click",
        "type",
      ]);
      if (options.throughHumanRouter) {
        expect(result.throughHumanRouter).toBe(true);
        expect(result.routerOutcome).toEqual({ accepted: true });
        expect(result.observations).toBe(7);
        expect(result.changedCaptures).toBe(6);
        // The native-style dispatch receives the fresh predispatch stamp,
        // while the model selected each action from its preceding screenshot.
        expect(result.dispatchFrameIds).toEqual([
          "fixture-frame-2",
          "fixture-frame-5",
        ]);
      } else expect(result.observations).toBe(3);
      if (options.captureScale) {
        expect(result.captureWidth).toBe(1108);
        expect(result.captureHeight).toBe(720);
        expect(result.width).toBe(1477);
      }
      expect(step).toBe(4);
      expect(result.evidence).toBe("synthetic_headless_browser_only");
    },
    20_000,
  );
});
