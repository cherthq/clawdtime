import { describe, expect, it, vi } from "vitest";
import { APICallError, createGateway, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  ScreenConversationAgent,
  configuredConversationAgent,
  type ConversationTurn,
} from "../src/control/conversation.js";
import { MediaDevicePort } from "../media/device-port.js";
import {
  ControlPreflightError,
  sanitizeControlPreflightDiagnostics,
} from "../src/control/errors.js";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { HumanRouter } from "../src/control/human-router.js";
import type { CallSession } from "../src/contracts.js";

const image = () => ({
  frame: { id: "fixture", capturedAt: Date.now(), width: 640, height: 360 },
  dataUrl: "data:image/jpeg;base64,AQ==",
});
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
function turn(signal = new AbortController().signal): ConversationTurn {
  return {
    text: "Tell me what you see.",
    question: "Help with this screen.",
    history: [],
    signal,
    tools: {
      observe: async () => image(),
      act: async () => image(),
      feedback: async () => ({ responseId: "fixture" }),
      screenFeedback: async () => ({ recorded: true }),
      stop: async () => ({ stopped: true }),
    },
  };
}
function response(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage,
    warnings: [],
  };
}
async function failure(model: LanguageModel, input = turn()) {
  try {
    await new ScreenConversationAgent(
      { frameImage: async () => image() },
      model,
    ).run(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ControlPreflightError);
    return error as ControlPreflightError;
  }
  throw new Error("Expected a safe conversation failure.");
}
const details = (error: ControlPreflightError) => {
  expect(error.diagnostics).toMatchObject({
    phase: "conversation",
    elapsedMs: expect.any(Number),
  });
  expect(error.diagnostics!.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(error.diagnostics!.elapsedMs).toBeLessThanOrEqual(60000);
  return (error.diagnostics as { conversation: Record<string, unknown> })
    .conversation;
};

describe("validated conversation generation configuration", () => {
  const device = new MediaDevicePort(
    "http://127.0.0.1:1",
    "synthetic-fixture-key-not-a-credential",
    async () => {
      throw new Error("No media access in configuration tests.");
    },
  );
  const configured = (
    overrides: NodeJS.ProcessEnv = {},
  ): NodeJS.ProcessEnv => ({
    CLAWDTIME_AI_ACTIONS: "true",
    CLAWDTIME_AI_PROVIDER: "gateway",
    CLAWDTIME_AI_MODEL: "openai/gpt-6.1-sol",
    CLAWDTIME_AI_GATEWAY_KEY: "synthetic-fixture-not-a-credential",
    ...overrides,
  });
  it.each([
    { name: "unset defaults", env: {}, tokens: 800, reasoning: undefined },
    {
      name: "reasoning alone",
      env: { CLAWDTIME_AI_REASONING: "low" },
      tokens: 800,
      reasoning: "low",
    },
    {
      name: "explicit minimum",
      env: { CLAWDTIME_AI_MAX_OUTPUT_TOKENS: "800" },
      tokens: 800,
      reasoning: undefined,
    },
    {
      name: "selected candidate",
      env: {
        CLAWDTIME_AI_REASONING: "low",
        CLAWDTIME_AI_MAX_OUTPUT_TOKENS: "4096",
      },
      tokens: 4096,
      reasoning: "low",
    },
    {
      name: "Astra medium candidate",
      env: {
        CLAWDTIME_AI_MODEL: "openai/gpt-6-astra",
        CLAWDTIME_AI_REASONING: "medium",
        CLAWDTIME_AI_MAX_OUTPUT_TOKENS: "4096",
      },
      tokens: 4096,
      reasoning: "medium",
    },
  ])(
    "sends $name through the configured agent",
    async ({ env, tokens, reasoning }) => {
      const requests: Record<string, unknown>[] = [];
      const request = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify(response("I can help.")), {
            headers: { "content-type": "application/json" },
          });
        });
      try {
        const agent = configuredConversationAgent(device, configured(env));
        await expect(agent!.run(turn())).resolves.toEqual({
          reply: "I can help.",
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]!.maxOutputTokens).toBe(tokens);
        if (reasoning) expect(requests[0]!.reasoning).toBe(reasoning);
        else expect(requests[0]).not.toHaveProperty("reasoning");
        expect(requests[0]!.providerOptions).toEqual({
          openai: { store: false, parallelToolCalls: false },
        });
      } finally {
        request.mockRestore();
      }
    },
  );

  it("forwards selected generation settings to the existing OpenAI Responses path", async () => {
    const requests: Record<string, unknown>[] = [];
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            error: {
              message: "synthetic unavailable",
              type: "server_error",
              code: null,
              param: null,
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      });
    try {
      const agent = configuredConversationAgent(
        device,
        configured({
          CLAWDTIME_AI_PROVIDER: "openai",
          CLAWDTIME_AI_MODEL: "gpt-5.4",
          CLAWDTIME_OPENAI_API_KEY: "synthetic-fixture-not-a-credential",
          CLAWDTIME_AI_REASONING: "low",
          CLAWDTIME_AI_MAX_OUTPUT_TOKENS: "4096",
        }),
      );
      await expect(agent!.run(turn())).rejects.toMatchObject({
        code: "planner_unavailable",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: "gpt-5.4",
        max_output_tokens: 4096,
        reasoning: { effort: "low" },
        store: false,
        parallel_tool_calls: false,
      });
    } finally {
      request.mockRestore();
    }
  });

  it("keeps disabled AI disabled even when optional generation variables are invalid", () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Provider must not be contacted."));
    try {
      expect(
        configuredConversationAgent(device, {
          CLAWDTIME_AI_ACTIONS: "false",
          CLAWDTIME_AI_REASONING: "invalid",
          CLAWDTIME_AI_MAX_OUTPUT_TOKENS: "",
        }),
      ).toBeUndefined();
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  });

  it.each([
    ["CLAWDTIME_AI_REASONING", ""],
    ["CLAWDTIME_AI_REASONING", "none"],
    ["CLAWDTIME_AI_REASONING", "high"],
    ["CLAWDTIME_AI_REASONING", " low "],
    ["CLAWDTIME_AI_MAX_OUTPUT_TOKENS", ""],
    ["CLAWDTIME_AI_MAX_OUTPUT_TOKENS", "799"],
    ["CLAWDTIME_AI_MAX_OUTPUT_TOKENS", "4097"],
    ["CLAWDTIME_AI_MAX_OUTPUT_TOKENS", "800.5"],
    ["CLAWDTIME_AI_MAX_OUTPUT_TOKENS", "NaN"],
    ["CLAWDTIME_AI_MAX_OUTPUT_TOKENS", "Infinity"],
    ["CLAWDTIME_AI_MAX_OUTPUT_TOKENS", "8e2"],
    ["CLAWDTIME_AI_MAX_OUTPUT_TOKENS", " 800 "],
    ["CLAWDTIME_AI_MAX_OUTPUT_TOKENS", "+800"],
  ])("rejects %s=%j before any provider request", (key, value) => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Provider must not be contacted."));
    try {
      for (const provider of ["gateway", "openai"]) {
        expect(() =>
          configuredConversationAgent(
            device,
            configured({
              CLAWDTIME_AI_PROVIDER: provider,
              CLAWDTIME_OPENAI_API_KEY: "synthetic-fixture-not-a-credential",
              [key]: value,
            }),
          ),
        ).toThrow(new RegExp(key));
      }
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  });

  it.each([
    { CLAWDTIME_AI_MODEL: undefined },
    { CLAWDTIME_AI_GATEWAY_KEY: undefined },
    { CLAWDTIME_AI_MODEL: "unqualified-model" },
    { CLAWDTIME_AI_PROVIDER: "openai", CLAWDTIME_OPENAI_API_KEY: undefined },
    { CLAWDTIME_AI_PROVIDER: undefined },
  ])(
    "retains required provider/model/credential checks with generation settings %j",
    (missing) => {
      const request = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Provider must not be contacted."));
      try {
        expect(() =>
          configuredConversationAgent(
            device,
            configured({
              CLAWDTIME_AI_REASONING: "low",
              CLAWDTIME_AI_MAX_OUTPUT_TOKENS: "4096",
              ...missing,
            }),
          ),
        ).toThrow();
        expect(request).not.toHaveBeenCalled();
      } finally {
        request.mockRestore();
      }
    },
  );
});

describe("bounded conversation failure diagnostics", () => {
  it.each([
    {
      name: "unchanged defaults",
      generation: undefined,
      tokens: 800,
      control: true,
      modelId: "openai/gpt-6.1-sol",
    },
    {
      name: "optional low-reasoning candidate",
      generation: { reasoning: "low" as const, maxOutputTokens: 4096 },
      tokens: 4096,
      control: true,
      modelId: "openai/gpt-6.1-sol",
    },
    {
      name: "optional low-reasoning candidate in a view-only session",
      generation: { reasoning: "low" as const, maxOutputTokens: 4096 },
      tokens: 4096,
      control: false,
      modelId: "openai/gpt-5.4",
    },
    {
      name: "Astra medium candidate",
      generation: { reasoning: "medium" as const, maxOutputTokens: 4096 },
      tokens: 4096,
      control: true,
      modelId: "openai/gpt-6-astra",
    },
  ])(
    "preserves $name across the real Gateway tool-loop wire",
    async ({ generation, tokens, control, modelId }) => {
      const requests: {
        model: string | null;
        body: {
          maxOutputTokens: number;
          reasoning?: string;
          providerOptions: unknown;
          tools: { name: string }[];
          prompt: {
            role: string;
            content:
              { type: string; mediaType?: string; data?: unknown }[] | string;
          }[];
        };
      }[] = [];
      const gateway = createGateway({
        apiKey: "synthetic-fixture-not-a-credential",
        fetch: async (_url, init) => {
          requests.push({
            model: new Headers(init?.headers).get("ai-language-model-id"),
            body: JSON.parse(String(init?.body)),
          });
          return new Response(
            JSON.stringify(
              requests.length === 1
                ? {
                    content: [
                      {
                        type: "tool-call",
                        toolCallId: "observe_fixture",
                        toolName: "observe",
                        input: "{}",
                      },
                    ],
                    finishReason: { unified: "tool-calls", raw: "tool-calls" },
                    usage,
                    warnings: [],
                  }
                : response("I can see the screen."),
            ),
            {
              headers: { "content-type": "application/json" },
            },
          );
        },
      });
      const input = turn();
      input.capabilities = { control };
      input.tools.observe = vi.fn(async () => image());
      input.tools.act = vi.fn(async () => {
        throw new Error("Input must not be submitted by this fixture.");
      });
      await expect(
        new ScreenConversationAgent(
          { frameImage: async () => image() },
          gateway(modelId),
          generation,
        ).run(input),
      ).resolves.toEqual({ reply: "I can see the screen." });
      expect(requests).toHaveLength(2);
      expect(input.tools.observe).toHaveBeenCalledOnce();
      expect(input.tools.act).not.toHaveBeenCalled();
      for (const request of requests) {
        expect(request.model).toBe(modelId);
        expect(request.body.maxOutputTokens).toBe(tokens);
        if (generation)
          expect(request.body.reasoning).toBe(generation.reasoning);
        else expect(request.body).not.toHaveProperty("reasoning");
        expect(request.body.providerOptions).toEqual({
          openai: { store: false, parallelToolCalls: false },
        });
      }
      expect(requests[0]!.body.tools.map((tool) => tool.name)).toEqual([
        "observe",
        "feedback",
        "screenFeedback",
        "stop",
      ]);
      const nextTools = requests[1]!.body.tools.map((tool) => tool.name);
      if (control)
        expect(nextTools).toEqual(
          expect.arrayContaining(["click", "type", "scroll"]),
        );
      else
        expect(nextTools).toEqual([
          "observe",
          "feedback",
          "screenFeedback",
          "stop",
        ]);
      const files = (request: (typeof requests)[number]) =>
        request.body.prompt.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.filter((part) => part.type === "file")
            : [],
        );
      expect(files(requests[0]!)).toEqual([]);
      expect(files(requests[1]!)).toEqual([
        expect.objectContaining({
          mediaType: "image/jpeg",
          data: { type: "data", data: "AQ==" },
        }),
      ]);
    },
  );

  it("contains a reasoning-only token-limited Gateway reply as a bounded empty-reply failure", async () => {
    let requests = 0;
    const gateway = createGateway({
      apiKey: "synthetic-fixture-not-a-credential",
      fetch: async () => {
        requests++;
        return new Response(
          JSON.stringify({
            content: [{ type: "reasoning", text: "PRIVATE_REASONING_CONTENT" }],
            finishReason: { unified: "length", raw: "max_output_tokens" },
            usage: {
              ...usage,
              outputTokens: { total: 4096, text: 0, reasoning: 4096 },
            },
            warnings: [],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const input = turn();
    input.tools.act = vi.fn(async () => image());
    let caught: unknown;
    try {
      await new ScreenConversationAgent(
        { frameImage: async () => image() },
        gateway("openai/gpt-6.1-sol"),
        { reasoning: "low", maxOutputTokens: 4096 },
      ).run(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ControlPreflightError);
    const error = caught as ControlPreflightError;
    expect(error.code).toBe("planner_unavailable");
    expect(details(error)).toEqual({
      phase: "reply_validation",
      errorKind: "invalid_reply",
      completedSteps: 1,
      finishReason: "length",
      replyLength: 0,
    });
    expect(requests).toBe(1);
    expect(input.tools.act).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_|synthetic-fixture/);
  });

  it.each([
    [400, "invalid_request_error"],
    [401, "authentication_error"],
    [429, "rate_limit_exceeded"],
    [503, "internal_server_error"],
  ] as const)(
    "classifies actual Gateway-wrapped HTTP %i without retaining its private response or retrying",
    async (statusCode, type) => {
      let requests = 0;
      const gateway = createGateway({
        apiKey: "synthetic-fixture-not-a-credential",
        fetch: async () => {
          requests++;
          return new Response(
            JSON.stringify({
              error: { type, message: "PRIVATE_GATEWAY_BODY" },
            }),
            {
              status: statusCode,
              headers: { "content-type": "application/json" },
            },
          );
        },
      });
      const error = await failure(gateway("openai/gpt-4o-mini"));
      expect(error.code).toBe("planner_unavailable");
      expect(details(error)).toEqual({
        phase: "generate",
        errorKind: "api",
        statusCode,
        completedSteps: 0,
      });
      expect(requests).toBe(1);
      expect(JSON.stringify(error)).not.toMatch(/PRIVATE_|synthetic-fixture/);
    },
  );

  it("retains actual Gateway authentication status through the production SDK error wrapper", async () => {
    vi.stubEnv("NODE_ENV", "production");
    let requests = 0;
    try {
      const gateway = createGateway({
        apiKey: "synthetic-fixture-not-a-credential",
        fetch: async () => {
          requests++;
          return new Response(
            JSON.stringify({
              error: {
                type: "authentication_error",
                message: "PRIVATE_AUTH_BODY",
              },
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        },
      });
      const error = await failure(gateway("openai/gpt-4o-mini"));
      expect(details(error)).toMatchObject({
        errorKind: "api",
        statusCode: 401,
        completedSteps: 0,
      });
      expect(JSON.stringify(error)).not.toContain("PRIVATE_");
      expect(requests).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not infer an HTTP failure from an arbitrary error name and status", async () => {
    const error = await failure(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw Object.assign(new Error("PRIVATE_LOCAL_ERROR"), {
            name: "GatewayError",
            statusCode: 401,
          });
        },
      }),
    );
    expect(details(error)).toMatchObject({ errorKind: "other" });
    expect(details(error)).not.toHaveProperty("statusCode");
  });

  it("finds a wrapped API failure through a bounded cyclic cause chain", async () => {
    const apiError = new APICallError({
      message: "PRIVATE_API_ERROR",
      url: "https://private.invalid",
      requestBodyValues: { prompt: "PRIVATE_PROMPT" },
      statusCode: 429,
    });
    const wrapper = new Error("PRIVATE_WRAPPER", { cause: apiError });
    Object.defineProperty(apiError, "cause", { value: wrapper });
    const error = await failure(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw wrapper;
        },
      }),
    );
    expect(details(error)).toMatchObject({ errorKind: "api", statusCode: 429 });
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_|private\.invalid/);
  });

  it("does not expose a throwing cause getter", async () => {
    const outer = new Error("PRIVATE_WRAPPER");
    Object.defineProperty(outer, "cause", {
      get() {
        throw new Error("PRIVATE_CAUSE_GETTER");
      },
    });
    const error = await failure(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw outer;
        },
      }),
    );
    expect(details(error)).toMatchObject({
      errorKind: "other",
      completedSteps: 0,
    });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_");
  });

  it("does not traverse an unbounded provider cause chain", async () => {
    let deepestRead = false;
    const deep = new Error("PRIVATE_DEEP");
    Object.defineProperty(deep, "cause", {
      get() {
        deepestRead = true;
        throw new Error("PRIVATE_DEEP_GETTER");
      },
    });
    let outer = deep;
    for (let i = 0; i < 10; i++)
      outer = new Error("PRIVATE_WRAPPER", { cause: outer });
    const error = await failure(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw outer;
        },
      }),
    );
    expect(deepestRead).toBe(false);
    expect(details(error)).toMatchObject({
      errorKind: "other",
      completedSteps: 0,
    });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_");
  });

  it("contains hostile wrapped API status getters without losing safe failure handling", async () => {
    const apiError = new APICallError({
      message: "PRIVATE_API_ERROR",
      url: "https://private.invalid",
      requestBodyValues: {},
    });
    Object.defineProperty(apiError, "statusCode", {
      get() {
        throw new Error("PRIVATE_STATUS_GETTER");
      },
    });
    const error = await failure(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw new Error("PRIVATE_WRAPPER", { cause: apiError });
        },
      }),
    );
    expect(error.code).toBe("planner_unavailable");
    expect(details(error)).not.toHaveProperty("statusCode");
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_|private\.invalid/);
  });

  it("persists only bounded diagnostics for qualified voice, with truthful fallback and no replay", async () => {
    const store = new Store();
    try {
      const service = new ClawdTime(store, new SimulationTransport());
      const device = new SimulatedDevice();
      const invite = service.createPairingInvite({
        memberId: "member",
        recipient: "+15550000001",
        conversationId: "iMessage;-;+15550000001",
        lineId: "line",
        deviceId: "mac",
        displayId: "1",
      });
      const pairing = service.claimPairing({
        token: invite.token,
        deviceId: "mac",
        displayId: "1",
        allowView: true,
        allowControl: true,
      });
      const session = service.registerSession(pairing.token, {
        adapter: "codex",
        adapterVersion: "fixture",
        projectRoot: "/fixture",
        externalSessionId: "fixture",
        hostId: "host.local",
        capabilities: { cooperativePause: true, polling: true },
      });
      service.yieldSession(session.token);
      const request = service.requestAttention(session.token, {
        taskId: "fixture",
        idempotencyKey: "fixture",
        reason: "decision",
        question: "Help with this screen.",
      });
      await service.drain();
      service.observeCall(request.id, "connected", true);
      const call = store
        .all<CallSession>("call")
        .find((item) => item.requestId === request.id)!;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          throw new APICallError({
            message: "PRIVATE_ERROR",
            url: "https://private.invalid",
            requestBodyValues: { text: "PRIVATE_UTTERANCE" },
            responseBody: "PRIVATE_BODY",
            statusCode: 400,
          });
        },
      });
      const human = new HumanRouter(
        service,
        new ControlCoordinator(store, device),
        new ScreenConversationAgent({ frameImage: async () => image() }, model),
      );
      const input = {
        requestId: request.id,
        memberId: "member",
        lineId: "line",
        conversationId: "iMessage;-;+15550000001",
        eventId: "voice_fixture",
        channel: "voice" as const,
        callId: call.id,
        qualifiedRemoteAudio: true,
        text: "PRIVATE_UTTERANCE",
      };
      const result = await human.receive(input);
      expect(result.reply).toContain("conversation service failed");
      expect(result.reply).not.toContain("couldn't safely act");
      expect(store.state(`control-preflight:${request.id}`)).toMatchObject({
        code: "planner_unavailable",
        diagnostics: {
          phase: "conversation",
          conversation: {
            errorKind: "api",
            statusCode: 400,
            completedSteps: 0,
          },
        },
      });
      const command = store.state(`human-command:${input.eventId}`);
      expect(command).toMatchObject({
        phase: "not_started",
        result: { code: "planner_unavailable", state: "not_started" },
      });
      expect(
        JSON.stringify([
          command,
          store.state(`control-preflight:${request.id}`),
        ]),
      ).not.toMatch(/PRIVATE_|private\.invalid/);
      expect(store.all("action")).toHaveLength(0);
      await human.receive(input);
      expect(model.doGenerateCalls).toHaveLength(1);
    } finally {
      store.close();
    }
  });
  it.each([400, 401, 429, 503])(
    "retains HTTP %i only, never provider request/response data, without retry",
    async (statusCode) => {
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          throw new APICallError({
            message: "PRIVATE_ERROR",
            url: "https://private.invalid/secret",
            requestBodyValues: { prompt: "PRIVATE_PROMPT" },
            statusCode,
            responseHeaders: { authorization: "PRIVATE_KEY" },
            responseBody: "PRIVATE_BODY",
            data: { private: "PRIVATE_DATA" },
          });
        },
      });
      const error = await failure(model);
      expect(error.code).toBe("planner_unavailable");
      expect(details(error)).toEqual({
        phase: "generate",
        errorKind: "api",
        statusCode,
        completedSteps: 0,
      });
      expect(JSON.stringify(error)).not.toMatch(/PRIVATE_|private\.invalid/);
      expect(model.doGenerateCalls).toHaveLength(1);
    },
  );

  it("recognizes an SDK TimeoutError even when the outer turn signal is not aborted", async () => {
    const input = turn();
    const error = await failure(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw new DOMException("PRIVATE_TIMEOUT", "TimeoutError");
        },
      }),
      input,
    );
    expect(input.signal.aborted).toBe(false);
    expect(error.code).toBe("planning_timeout");
    expect(details(error)).toMatchObject({
      phase: "generate",
      errorKind: "timeout",
      completedSteps: 0,
    });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_TIMEOUT");
  });

  it("classifies an externally aborted turn without preserving its reason", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        controller.abort(new Error("PRIVATE_ABORT"));
        throw controller.signal.reason;
      },
    });
    const error = await failure(model, turn(controller.signal));
    expect(error.code).toBe("planning_timeout");
    expect(details(error)).toMatchObject({ errorKind: "timeout" });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_ABORT");
  });

  it("recognizes a provider-wrapped SDK timeout while the outer signal remains active", async () => {
    const input = turn();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: "PRIVATE_WRAPPER",
          url: "https://private.invalid",
          requestBodyValues: {},
          cause: new DOMException("PRIVATE_TIMEOUT", "TimeoutError"),
        });
      },
    });
    const error = await failure(model, input);
    expect(input.signal.aborted).toBe(false);
    expect(error.code).toBe("planning_timeout");
    expect(details(error)).toMatchObject({
      phase: "generate",
      errorKind: "timeout",
      completedSteps: 0,
    });
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_|private\.invalid/);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("does not let a hostile API status getter escape safe error classification", async () => {
    const providerError = new APICallError({
      message: "PRIVATE_ERROR",
      url: "https://private.invalid",
      requestBodyValues: {},
    });
    Object.defineProperty(providerError, "statusCode", {
      get() {
        throw new Error("PRIVATE_GETTER");
      },
    });
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw providerError;
      },
    });
    const error = await failure(model);
    expect(error.code).toBe("planner_unavailable");
    expect(details(error)).toMatchObject({
      phase: "generate",
      completedSteps: 0,
    });
    expect(details(error)).not.toHaveProperty("statusCode");
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_|private\.invalid/);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("safely classifies the real SDK result when the provider returns no text content", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      }),
    });
    const error = await failure(model);
    expect(details(error)).toMatchObject({
      phase: "reply_validation",
      errorKind: "invalid_reply",
      completedSteps: 1,
      replyLength: 0,
    });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("contains a throwing SDK error marker without persisting its exception", async () => {
    const providerError = new Error("PRIVATE_ERROR");
    Object.defineProperty(
      providerError,
      Symbol.for("vercel.ai.error.AI_APICallError"),
      {
        get() {
          throw new Error("PRIVATE_MARKER");
        },
      },
    );
    const error = await failure(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw providerError;
        },
      }),
    );
    expect(error.code).toBe("planner_unavailable");
    expect(details(error)).toMatchObject({
      phase: "generate",
      errorKind: "other",
      completedSteps: 0,
    });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_");
  });

  it("bounds inspection of a cyclic provider cause chain", async () => {
    const providerError = new Error("PRIVATE_ERROR");
    providerError.cause = providerError;
    const error = await failure(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw providerError;
        },
      }),
    );
    expect(details(error)).toMatchObject({
      phase: "generate",
      errorKind: "other",
      completedSteps: 0,
    });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_");
  });

  it.each(["", "x".repeat(901)])(
    "distinguishes invalid final reply from provider failure (length %s)",
    async (text) => {
      const model = new MockLanguageModelV4({
        doGenerate: async () => response(text),
      });
      const error = await failure(model);
      expect(details(error)).toMatchObject({
        phase: "reply_validation",
        errorKind: "invalid_reply",
        completedSteps: 1,
        finishReason: "stop",
        replyLength: text.length,
      });
      expect(details(error)).not.toHaveProperty("statusCode");
      expect(model.doGenerateCalls).toHaveLength(1);
    },
  );

  it("retains completed tool-step count when a later provider call fails", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        if (++calls === 1)
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "observe_fixture",
                toolName: "observe",
                input: "{}",
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage,
            warnings: [],
          };
        throw new Error("PRIVATE_FAILURE");
      },
    });
    const error = await failure(model);
    expect(details(error)).toMatchObject({
      phase: "generate",
      errorKind: "other",
      completedSteps: 1,
    });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(error)).not.toContain("PRIVATE_FAILURE");
  });

  it("does not turn a successful concise reply into a failure", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => response("I can help with that screen."),
    });
    await expect(
      new ScreenConversationAgent(
        { frameImage: async () => image() },
        model,
      ).run(turn()),
    ).resolves.toEqual({ reply: "I can help with that screen." });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("identifies an empty final reply after seven tools without inventing a provider failure", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        calls++;
        if (calls === 8) {
          expect(options.toolChoice).toEqual({ type: "none" });
          return response("");
        }
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `observe_${calls}`,
              toolName: "observe",
              input: "{}",
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage,
          warnings: [],
        };
      },
    });
    const error = await failure(model);
    expect(details(error)).toEqual({
      phase: "reply_validation",
      errorKind: "invalid_reply",
      completedSteps: 8,
      finishReason: "stop",
      replyLength: 0,
    });
    expect(model.doGenerateCalls).toHaveLength(8);
    expect(details(error)).not.toHaveProperty("statusCode");
  });

  it("refuses malformed diagnostic getters without exposing their exception", () => {
    const value = {
      phase: "conversation",
      elapsedMs: 1,
      get conversation() {
        throw new Error("PRIVATE_GETTER");
      },
    };
    expect(sanitizeControlPreflightDiagnostics(value)).toBeUndefined();
  });

  it("strips arbitrary fields at both diagnostic levels", () => {
    expect(
      sanitizeControlPreflightDiagnostics({
        phase: "conversation",
        elapsedMs: 5,
        prompt: "PRIVATE_PROMPT",
        conversation: {
          phase: "generate",
          errorKind: "api",
          statusCode: 400,
          completedSteps: 0,
          headers: { authorization: "PRIVATE_KEY" },
          responseBody: "PRIVATE_BODY",
        },
      }),
    ).toEqual({
      phase: "conversation",
      elapsedMs: 5,
      conversation: {
        phase: "generate",
        errorKind: "api",
        statusCode: 400,
        completedSteps: 0,
      },
    });
  });

  it("strips tool arguments from preflight diagnostics and rejects arbitrary reason strings", () => {
    expect(
      sanitizeControlPreflightDiagnostics({
        phase: "tool_preflight",
        elapsedMs: 1,
        reason: "frame_mismatch",
        frameId: "PRIVATE_FRAME",
        action: { text: "PRIVATE_TYPED_TEXT" },
      }),
    ).toEqual({
      phase: "tool_preflight",
      elapsedMs: 1,
      reason: "frame_mismatch",
    });
    for (const invalid of [
      { reason: "PRIVATE_REASON" },
      { elapsedMs: Infinity },
      { elapsedMs: -1 },
      { elapsedMs: 60_001 },
    ]) {
      expect(
        sanitizeControlPreflightDiagnostics({
          phase: "tool_preflight",
          elapsedMs: 1,
          reason: "frame_mismatch",
          ...invalid,
        }),
      ).toBeUndefined();
    }
  });

  it.each([
    { statusCode: 99 },
    { statusCode: 600 },
    { completedSteps: 9 },
    { completedSteps: -1 },
    { completedSteps: 0.5 },
    { replyLength: 1000001 },
    { finishReason: "PRIVATE_REASON" },
    { errorKind: "PRIVATE_ERROR" },
  ])("rejects unbounded or arbitrary metadata %j", (invalid) => {
    expect(
      sanitizeControlPreflightDiagnostics({
        phase: "conversation",
        elapsedMs: 5,
        conversation: {
          phase: "generate",
          errorKind: "other",
          completedSteps: 0,
          ...invalid,
        },
      }),
    ).toBeUndefined();
  });
});
