import { describe, expect, it } from "vitest";
import { VisionPlanner } from "../src/control/planner.js";
import type { ControlLease } from "../src/contracts.js";

describe("live vision provider contract", () => {
  let sequence = 0;
  const device = {
    async frameImage() {
      return {
        dataUrl: "data:image/jpeg;base64,AA==",
        frame: {
          id: `fresh-${++sequence}`,
          capturedAt: Date.now(),
          width: 640,
          height: 360,
        },
      };
    },
  };
  it("sends provider-supported anyOf while retaining local action validation", async () => {
    const generate = (async (options: any) => {
      const format = await options.output.responseFormat;
      // The actual gateway rejected nested oneOf before any model inference.
      expect(JSON.stringify(format.schema)).not.toContain('"oneOf"');
      expect(JSON.stringify(format.schema)).toContain('"anyOf"');
      return {
        output: {
          action: { kind: "click", x: 0.5, y: 0.5 },
          clarification: "",
        },
      };
    }) as never;
    const result = await new VisionPlanner(
      device,
      {} as never,
      generate,
      async () => {},
    ).plan("Click the fixture", {
      expiresAt: Date.now() + 20_000,
    } as ControlLease);
    expect(result.action).toEqual({ kind: "click", x: 0.5, y: 0.5 });
  });
  it.each(["throwing", "missing"])(
    "classifies %s structured output as a pre-input failure",
    async (mode) => {
      let frames = 0;
      const counted = {
        frameImage: async () => {
          frames++;
          return device.frameImage();
        },
      };
      const generate = (async () => ({
        get output() {
          if (mode === "throwing") throw new Error("private provider detail");
          return undefined;
        },
      })) as never;
      await expect(
        new VisionPlanner(counted, {} as never, generate, async () => {}).plan(
          "Act",
          { expiresAt: Date.now() + 20_000 } as ControlLease,
        ),
      ).rejects.toMatchObject({
        name: "ControlPreflightError",
        code: mode === "throwing" ? "planner_unavailable" : "planning_refused",
      });
      expect(frames).toBe(2);
    },
  );
  it.each([
    { kind: "click", x: 2, y: 0 },
    { kind: "type", text: "unsafe\ninput" },
    { kind: "scroll", x: 0.5, y: 0.5, deltaY: 0 },
    { kind: "click", x: 0.5, y: 0.5, extra: "untrusted" },
  ])(
    "rejects invalid model action %# before reobserving or input",
    async (action) => {
      let frames = 0;
      const counted = {
        frameImage: async () => {
          frames++;
          return device.frameImage();
        },
      };
      const generate = (async () => ({
        output: { action, clarification: "" },
      })) as never;
      await expect(
        new VisionPlanner(counted, {} as never, generate, async () => {}).plan(
          "Act",
          { expiresAt: Date.now() + 20_000 } as ControlLease,
        ),
      ).rejects.toThrow();
      expect(frames).toBe(2);
    },
  );
});
