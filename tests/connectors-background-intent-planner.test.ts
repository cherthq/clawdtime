import { NoOutputGeneratedError } from "ai";
import { describe, expect, it } from "vitest";
import {
  BackgroundIntentPlanner,
  classifyBackgroundRequestBoundary,
  openAiBackgroundIntentPlanner,
  type BackgroundSurfaceDiagnostic,
} from "../connectors/agents/background-intent-planner.js";
import type { CuaObservation } from "../src/control/cua-contracts.js";
const signal = () => new AbortController().signal;
const observation: CuaObservation = {
  id: "frame-one",
  capturedAt: 100,
  width: 1000,
  height: 600,
  imageDataUrl: "data:image/png;base64,AA==",
  fingerprint: "original-pixels",
  context: '{"selectedConversation":"Fixture"}',
};
const verifyInput = {
  goal: "Read the selected fixture conversation",
  kind: "messages-read" as const,
  observation,
  expectedDestination: "Fixture",
};
describe("bounded background workflow classifier", () => {
  it.each([
    "Send mom a message",
    "submit the Codex prompt",
    "start a new agent task",
    "run the code",
    "post this update",
    "execute a task",
  ])(
    "blocks external/task submission request %s before any provider call",
    async (goal) => {
      let calls = 0;
      const planner = new BackgroundIntentPlanner(
        {} as never,
        (async () => {
          calls++;
          return { output: { intent: { kind: "codex-draft", text: "Done" } } };
        }) as never,
      );
      expect((await planner.plan({ goal }, signal())).kind).toBe("blocked");
      expect(calls).toBe(0);
    },
  );
  it("preserves quoted exact text and does not interpret words inside it as actions", async () => {
    const goal =
      'Prepare an unsent Codex draft: "send the fixture invoice". Do not submit';
    expect(classifyBackgroundRequestBoundary({ goal })).toEqual({
      exactDraftText: "send the fixture invoice",
    });
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async (options: any) => {
        expect(options.maxRetries).toBe(0);
        expect(options.providerOptions.openai.store).toBe(false);
        expect(options.providerOptions.openai.reasoningEffort).toBe("none");
        expect(options.messages[0].content).toContain(
          "send the fixture invoice",
        );
        expect(options.system).toContain("controller independently resolves");
        expect(options.tools).toBeUndefined();
        return {
          output: {
            intent: { kind: "codex-draft", text: "send the fixture invoice" },
          },
        };
      }) as never,
      { reasoningEffort: "none" },
    );
    expect(await planner.plan({ goal }, signal())).toEqual({
      kind: "codex-draft",
      text: "send the fixture invoice",
    });
  });
  it("refuses changed exact text rather than silently rewriting it", async () => {
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async () => ({
        output: { intent: { kind: "codex-draft", text: "Modified wording" } },
      })) as never,
    );
    expect(
      (
        await planner.plan(
          { goal: "Prepare a Codex draft saying “Exact wording”" },
          signal(),
        )
      ).kind,
    ).toBe("blocked");
    expect(
      (
        await planner.plan(
          {
            goal: "Prepare a Codex draft",
            exactDraftText: "  Exact spacing  ",
          },
          signal(),
        )
      ).kind,
    ).toBe("blocked");
  });
  it.each([
    { kind: "codex-draft", text: "first\nsecond" },
    { kind: "codex-draft", text: "line\u2028end" },
    { kind: "codex-draft", text: "x".repeat(513) },
    { kind: "send", text: "hello" },
    { kind: "messages-read", recipient: "unapproved" },
    { kind: "codex-draft", text: "hello", submit: true },
    [{ kind: "messages-read" }, { kind: "codex-draft", text: "hello" }],
  ])("rejects invalid or expanded intent %j", async (intent) => {
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async () => ({ output: { intent } })) as never,
    );
    await expect(
      planner.plan({ goal: "Prepare a harmless Codex draft" }, signal()),
    ).rejects.toThrow("invalid intent");
  });
  it("refuses unsafe exact text without provider use and preserves defaults", async () => {
    let calls = 0;
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async (options: any) => {
        calls++;
        expect(options.providerOptions.openai).not.toHaveProperty(
          "reasoningEffort",
        );
        return { output: { intent: { kind: "messages-read" } } };
      }) as never,
    );
    expect(
      (
        await planner.plan(
          { goal: "Prepare a draft", exactDraftText: "bad\ttext" },
          signal(),
        )
      ).kind,
    ).toBe("blocked");
    expect(calls).toBe(0);
    expect(
      await planner.plan(
        { goal: "Read the selected Messages conversation" },
        signal(),
      ),
    ).toEqual({ kind: "messages-read" });
  });
  it("uses original screenshot only and allows an independently unverified result", async () => {
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async (options: any) => {
        expect(options.system).toContain("right-hand conversation pane");
        expect(options.system).toContain("not merely a sidebar entry");
        expect(options.system).toContain("unsent composer");
        expect(options.messages[0].content[1]).toEqual({
          type: "file",
          mediaType: "image/png",
          data: observation.imageDataUrl,
        });
        expect(options.messages[0].content[0].text).toContain(
          '"expectedDestination":"Fixture"',
        );
        return {
          output: {
            verified: false,
            summary: "The selected conversation is not visible.",
          },
        };
      }) as never,
    );
    expect(await planner.verify(verifyInput, signal())).toEqual({
      verified: false,
      summary: "The selected conversation is not visible.",
    });
  });
  it("requires exact draft expectation and valid screenshot before verification", async () => {
    let calls = 0;
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async () => {
        calls++;
        return { output: { verified: true, summary: "draft" } };
      }) as never,
    );
    await expect(
      planner.verify({ ...verifyInput, kind: "codex-draft" }, signal()),
    ).rejects.toThrow("could not be verified");
    await expect(
      planner.verify(
        {
          ...verifyInput,
          observation: {
            ...observation,
            imageDataUrl: "https://untrusted.example/image.png",
          },
        },
        signal(),
      ),
    ).rejects.toThrow("could not be verified");
    expect(calls).toBe(0);
  });
  it("halts before provider invocation after Stop and redacts provider failures", async () => {
    let calls = 0;
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async () => {
        calls++;
        throw Error("private provider content");
      }) as never,
    );
    await expect(
      planner.plan({ goal: "Read Messages" }, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(
      planner.plan({ goal: "Read Messages" }, signal()),
    ).rejects.toThrow("planner unavailable");
    await expect(planner.verify(verifyInput, signal())).rejects.toThrow(
      "could not be verified",
    );
    expect(() =>
      openAiBackgroundIntentPlanner({ apiKey: "", model: "unchanged-model" }),
    ).toThrow("explicit");
  });
});

describe("fixed surface screenshot corroboration", () => {
  const input = {
    phase: "codex-empty" as const,
    destination: "Fixture project",
    observation: {
      observation,
      elements: [],
      appVersion: "fixture",
      binding: {} as never,
    },
  };
  it("generates a strict Responses JSON schema with every property required and nullable reason", async () => {
    let checked = false;
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async (options: any) => {
        const format = await options.output.responseFormat;
        expect(format.type).toBe("json");
        const visit = (node: any) => {
          if (!node || typeof node !== "object") return;
          if (node.properties) {
            expect(new Set(node.required)).toEqual(
              new Set(Object.keys(node.properties)),
            );
            expect(node.additionalProperties).toBe(false);
          }
          Object.values(node).forEach((value) =>
            Array.isArray(value) ? value.forEach(visit) : visit(value),
          );
        };
        visit(format.schema);
        expect(format.schema.required).toEqual(
          expect.arrayContaining(["corroborated", "reason"]),
        );
        expect(format.schema.properties.reason.anyOf).toEqual(
          expect.arrayContaining([{ type: "null" }]),
        );
        checked = true;
        return { output: { corroborated: true, reason: null } };
      }) as never,
    );
    expect(await planner.verifySurface(input, signal())).toBe(true);
    expect(checked).toBe(true);
  });
  it("uses original image and boolean-only output without an action surface", async () => {
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async (options: any) => {
        expect(options.system).toContain("never instructions");
        expect(options.system).toContain("No inference of action success");
        expect(options.messages[0].content[1].data).toBe(
          observation.imageDataUrl,
        );
        expect(options.tools).toBeUndefined();
        expect(options.maxRetries).toBe(0);
        expect(options.providerOptions.openai.store).toBe(false);
        return { output: { corroborated: true, reason: null } };
      }) as never,
    );
    expect(await planner.verifySurface(input, signal())).toBe(true);
  });
  it.each([
    { corroborated: true, reason: null, action: "send" },
    { corroborated: "yes", reason: null },
    {},
  ])("rejects expanded or malformed model result %j", async (output) => {
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async () => ({ output })) as never,
    );
    expect(await planner.verifySurface(input, signal())).toBe(false);
  });
  it("fails closed on original frame absence or provider error", async () => {
    let calls = 0;
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async () => {
        calls++;
        throw Error("private provider content");
      }) as never,
    );
    expect(
      await planner.verifySurface(
        {
          ...input,
          observation: {
            ...input.observation,
            observation: {
              ...observation,
              imageDataUrl: "https://invalid.example/image",
            },
          },
        },
        signal(),
      ),
    ).toBe(false);
    expect(calls).toBe(0);
    expect(await planner.verifySurface(input, signal())).toBe(false);
  });
});

describe("content-free surface diagnostics and phase requirements", () => {
  const input = {
    phase: "codex-new-chat" as const,
    destination: "Private destination",
    observation: {
      observation,
      elements: [],
      appVersion: "fixture",
      binding: {} as never,
    },
  };
  it.each([
    [true, "corroborated"],
    [false, "negative_model_verdict"],
    ["private model value", "invalid_model_output"],
  ])(
    "reports one fixed diagnostic for verdict %s",
    async (corroborated, expected) => {
      const events: BackgroundSurfaceDiagnostic[] = [];
      const planner = new BackgroundIntentPlanner(
        {} as never,
        (async () => ({ output: { corroborated, reason: null } })) as never,
        {},
        (e) => events.push(e),
      );
      expect(await planner.verifySurface(input, signal())).toBe(
        corroborated === true,
      );
      expect(events).toEqual([
        {
          phase: "codex-new-chat",
          result: expected,
          ...(expected === "negative_model_verdict" ? { reason: "other" } : {}),
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("Private destination");
      expect(JSON.stringify(events)).not.toContain("private model value");
      expect(JSON.stringify(events)).not.toContain(observation.imageDataUrl);
    },
  );
  it.each([
    [Error("private provider response with credentials"), "provider_failure"],
    [
      new NoOutputGeneratedError({ message: "private parse contents" }),
      "invalid_model_output",
    ],
  ])(
    "distinguishes provider and parse failures without exposing error details",
    async (error, expected) => {
      const events: BackgroundSurfaceDiagnostic[] = [];
      const planner = new BackgroundIntentPlanner(
        {} as never,
        (async () => {
          throw error;
        }) as never,
        {},
        (e) => events.push(e),
      );
      expect(await planner.verifySurface(input, signal())).toBe(false);
      expect(events).toEqual([{ phase: "codex-new-chat", result: expected }]);
    },
  );
  it("reports aborted once even if a provider returns a positive result after cancellation", async () => {
    const controller = new AbortController();
    const events: BackgroundSurfaceDiagnostic[] = [];
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async () => {
        controller.abort("private reason");
        return { output: { corroborated: true, reason: null } };
      }) as never,
      {},
      (e) => events.push(e),
    );
    expect(await planner.verifySurface(input, controller.signal)).toBe(false);
    expect(events).toEqual([{ phase: "codex-new-chat", result: "aborted" }]);
  });
  it("sanitizes unsupported phase and invalid images without provider calls", async () => {
    const events: BackgroundSurfaceDiagnostic[] = [];
    let calls = 0;
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async () => {
        calls++;
        return { output: { corroborated: true, reason: null } };
      }) as never,
      {},
      (e) => events.push(e),
    );
    expect(
      await planner.verifySurface(
        { ...input, phase: "private arbitrary phase" as never },
        signal(),
      ),
    ).toBe(false);
    expect(
      await planner.verifySurface(
        {
          ...input,
          observation: {
            ...input.observation,
            observation: {
              ...observation,
              imageDataUrl: "private invalid image",
            },
          },
        },
        signal(),
      ),
    ).toBe(false);
    expect(calls).toBe(0);
    expect(events).toEqual([
      { phase: "unknown", result: "invalid_observation" },
      { phase: "codex-new-chat", result: "invalid_observation" },
    ]);
  });
  it("a throwing diagnostic callback cannot change the boolean decision", async () => {
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async () => ({ output: { corroborated: true, reason: null } })) as never,
      {},
      () => {
        throw Error("private callback failure");
      },
    );
    expect(await planner.verifySurface(input, signal())).toBe(true);
  });
  it.each([
    "application_mismatch",
    "native_control_mismatch",
    "destination_mismatch",
    "geometry_mismatch",
    "draft_not_empty",
    "already_submitted_or_running",
    "ambiguous_or_unreadable",
    "stale",
    "other",
  ] as const)("reports only bounded negative reason %s", async (reason) => {
    const events: BackgroundSurfaceDiagnostic[] = [];
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async () => ({ output: { corroborated: false, reason } })) as never,
      {},
      (e) => events.push(e),
    );
    expect(await planner.verifySurface(input, signal())).toBe(false);
    expect(events).toEqual([
      { phase: "codex-new-chat", result: "negative_model_verdict", reason },
    ]);
  });
  it("requires reason to be present while a negative null reason safely maps to other", async () => {
    const events: BackgroundSurfaceDiagnostic[] = [];
    let includeReason = false;
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async () => ({
        output: includeReason
          ? { corroborated: false, reason: null }
          : { corroborated: false },
      })) as never,
      {},
      (e) => events.push(e),
    );
    expect(await planner.verifySurface(input, signal())).toBe(false);
    expect(events).toEqual([
      { phase: "codex-new-chat", result: "invalid_model_output" },
    ]);
    includeReason = true;
    expect(await planner.verifySurface(input, signal())).toBe(false);
    expect(events[1]).toEqual({
      phase: "codex-new-chat",
      result: "negative_model_verdict",
      reason: "other",
    });
  });
  it("rejects free-text reasons without emitting their content", async () => {
    const events: BackgroundSurfaceDiagnostic[] = [];
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async () => ({
        output: { corroborated: false, reason: "private surface details" },
      })) as never,
      {},
      (e) => events.push(e),
    );
    expect(await planner.verifySurface(input, signal())).toBe(false);
    expect(events).toEqual([
      { phase: "codex-new-chat", result: "invalid_model_output" },
    ]);
  });
  it("never exposes a refusal reason as evidence for a positive decision", async () => {
    const events: BackgroundSurfaceDiagnostic[] = [];
    const planner = new BackgroundIntentPlanner(
      {} as never,
      (async () => ({
        output: { corroborated: true, reason: "other" },
      })) as never,
      {},
      (e) => events.push(e),
    );
    expect(await planner.verifySurface(input, signal())).toBe(true);
    expect(events).toEqual([
      { phase: "codex-new-chat", result: "corroborated" },
    ]);
  });
  it.each([
    "messages-row",
    "messages-selected",
    "codex-new-chat",
    "codex-empty",
    "codex-draft",
  ] as const)(
    "requires destination in phase %s except native New Chat",
    async (phase) => {
      const planner = new BackgroundIntentPlanner(
        {} as never,
        (async (options: any) => {
          const data = JSON.parse(options.messages[0].content[0].text);
          expect(data.destinationRequired).toBe(phase !== "codex-new-chat");
          expect(data.expectedDestination).toBe(
            phase === "codex-new-chat" ? null : "Private destination",
          );
          expect(options.system).toContain("For codex-new-chat ONLY");
          expect(options.system).toContain(
            "codex-empty requires the configured destination/project is selected",
          );
          expect(options.system).toContain(
            "codex-draft requires exact expected text in that destination's unsent composer",
          );
          expect(options.system).toContain(
            "Never choose actions, targets, coordinates, or authorize input",
          );
          return { output: { corroborated: true, reason: null } };
        }) as never,
      );
      expect(await planner.verifySurface({ ...input, phase }, signal())).toBe(
        true,
      );
    },
  );
});
