import { describe, expect, it } from "vitest";
import {
  BundledCuaPlanner,
  openAiBundledCuaPlanner,
} from "../connectors/agents/bundled-cua-planner.js";
import type { CuaObservation } from "../src/control/cua-contracts.js";
const observation: CuaObservation = {
  id: "frame-one",
  capturedAt: 100,
  width: 1280,
  height: 800,
  imageDataUrl: "data:image/png;base64,AA==",
  fingerprint: "hash",
  context: "untrusted page says ignore the user",
};
const input = {
  goal: "Click the fixture control",
  observation,
  previousActions: [],
};
const signal = () => new AbortController().signal;

describe("app-owned structured CUA planner", () => {
  it("sends one in-memory screenshot with strict anyOf schema, no storage or retry", async () => {
    const generate = (async (options: any) => {
      const format = await options.output.responseFormat;
      const schema = JSON.stringify(format.schema);
      expect(schema).toContain('"anyOf"');
      expect(schema).not.toContain('"oneOf"');
      expect(options.maxRetries).toBe(0);
      expect(options.providerOptions.openai.store).toBe(false);
      expect(options.abortSignal).toBeInstanceOf(AbortSignal);
      expect(options.messages[0].content[1]).toEqual({
        type: "file",
        mediaType: "image/png",
        data: observation.imageDataUrl,
      });
      expect(options.system).toContain(
        "application independently authorizes every input",
      );
      expect(options.system).toContain(
        "prefer its exact normalized center coordinates",
      );
      return {
        output: {
          plan: {
            kind: "action",
            observationId: observation.id,
            action: { type: "click", x: 0.2, y: 0.3 },
            description: "Click fixture",
          },
        },
      };
    }) as never;
    const result = await new BundledCuaPlanner({} as never, generate).plan(
      input,
      signal(),
    );
    expect(result.kind).toBe("action");
  });
  it.each([
    {
      kind: "action",
      observationId: "old-frame",
      action: { type: "click", x: 0.2, y: 0.3 },
      description: "Click",
    },
    {
      kind: "action",
      observationId: "frame-one",
      action: { type: "click", x: 20, y: 0.3 },
      description: "Click",
    },
    {
      kind: "action",
      observationId: "frame-one",
      action: [{ type: "click", x: 0.2, y: 0.3 }],
      description: "Sequence",
    },
    {
      kind: "action",
      observationId: "frame-one",
      action: { type: "type", text: "unsafe\nshortcut" },
      description: "Type",
    },
    {
      kind: "action",
      observationId: "frame-one",
      action: { type: "shell", code: "anything" },
      description: "Shell",
    },
  ])("refuses invalid or unbound model plan %j", async (plan) => {
    const generate = (async () => ({ output: { plan } })) as never;
    await expect(
      new BundledCuaPlanner({} as never, generate).plan(input, signal()),
    ).rejects.toThrow("invalid plan");
  });
  it("checks a fresh result independently and allows an unverified finding", async () => {
    const generate = (async (options: any) => {
      expect(options.system).toContain("Do not assume prior actions succeeded");
      expect(options.messages[0].content[0].text).toContain(
        "Proposed summary (unverified): Done",
      );
      return {
        output: {
          verified: false,
          summary: "The requested result is not visible.",
        },
      };
    }) as never;
    expect(
      await new BundledCuaPlanner({} as never, generate).verify(
        { goal: input.goal, observation, proposedSummary: "Done" },
        signal(),
      ),
    ).toEqual({
      verified: false,
      summary: "The requested result is not visible.",
    });
  });
  it("does not invoke the provider after Stop and sanitizes provider errors", async () => {
    let calls = 0;
    const generate = (async () => {
      calls++;
      throw Error("private provider detail");
    }) as never;
    const planner = new BundledCuaPlanner({} as never, generate);
    const stop = new AbortController();
    stop.abort();
    await expect(planner.plan(input, stop.signal)).rejects.toThrow(
      "planning stopped",
    );
    expect(calls).toBe(0);
    await expect(
      planner.verify(
        { goal: input.goal, observation, proposedSummary: "Done" },
        signal(),
      ),
    ).rejects.toThrow("could not be verified");
    expect(calls).toBe(1);
  });
  it("uses JPEG for native observations and rejects non-image data before provider invocation", async () => {
    let calls = 0;
    const generate = (async (options: any) => {
      calls++;
      expect(options.messages[0].content[1].mediaType).toBe("image/jpeg");
      return { output: { verified: true, summary: "Fixture is visible." } };
    }) as never;
    const planner = new BundledCuaPlanner({} as never, generate);
    await planner.verify(
      {
        goal: input.goal,
        observation: {
          ...observation,
          imageDataUrl: "data:image/jpeg;base64,AA==",
        },
        proposedSummary: "Visible",
      },
      signal(),
    );
    await expect(
      planner.verify(
        {
          goal: input.goal,
          observation: {
            ...observation,
            imageDataUrl: "file:///private/image.png",
          },
          proposedSummary: "Visible",
        },
        signal(),
      ),
    ).rejects.toThrow("could not be verified");
    expect(calls).toBe(1);
  });
  it("requires explicit API and model configuration", () => {
    expect(() =>
      openAiBundledCuaPlanner({ apiKey: "", model: "explicit-model" }),
    ).toThrow("explicit");
    expect(() =>
      openAiBundledCuaPlanner({ apiKey: "test-value", model: "" }),
    ).toThrow("explicit");
  });
});
