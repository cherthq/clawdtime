import { describe, expect, it } from "vitest";
import {
  ModelPlanner,
  OpenAIPlanner,
  PlannerError,
  plannerFromEnvironment,
  type PlannerOptions,
} from "../connectors/computer/planner.js";
import {
  chatEndpoint,
  defaultAnthropicModel,
  defaultComputerModel,
  messagesTools,
  parseModel,
  plannerVariables,
  providerById,
  providers,
  selectPlanner,
  strictLimits,
  strictSchema,
  type FunctionTool,
  type KeyFound,
  type PlannerUsage,
  type Provider,
} from "../connectors/computer/providers.js";
import { TaskPlan } from "../connectors/computer/plan.js";
import type { Closer } from "../connectors/computer/ports.js";
import { element, observation } from "./connectors-computer-fixture.js";

const key = "fixture-provider-key-0123456789";
const goal = "Open the shopping note";

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown> & {
    model: string;
    messages: { role: string; content: unknown }[];
    tools: unknown[];
  };
}
/** A scripted service: each request takes the next reply, and the last one repeats. No network. */
function service(...replies: (() => Response)[]) {
  const sent: Sent[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: new Headers(init?.headers as HeadersInit),
      body: JSON.parse(String(init?.body)) as Sent["body"],
    });
    const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
    return reply();
  }) as typeof fetch;
  return { sent, request };
}
const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

/** A chat completions answer with one tool call. */
const chatCall = (name: string, args: unknown, usage?: unknown) => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  ...(usage ? { usage } : {}),
});
/** A Messages answer of Anthropic. */
const message = (
  content: unknown[],
  stop_reason = "tool_use",
  usage: Record<string, number> = { input_tokens: 40, output_tokens: 12 },
) => ({
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  model: defaultAnthropicModel,
  content,
  stop_reason,
  stop_sequence: null,
  usage,
});
const toolUse = (name: string, input: unknown, id = "toolu_1") => ({
  type: "tool_use",
  id,
  name,
  input,
});
const anthropicError = (status: number, type: string, extra = {}) =>
  json(
    {
      type: "error",
      error: { type, message: `echo of ${key} and the goal ${goal}`, ...extra },
    },
    status,
  );

/** A clock that only moves when the planner waits. */
function clock() {
  let at = Date.parse("2026-11-25T10:00:00.000Z");
  const waits: number[] = [];
  return {
    waits,
    now: () => at,
    sleep: async (ms: number) => {
      waits.push(ms);
      at += ms;
    },
    random: () => 0.5,
  };
}
const planner = (
  request: typeof fetch,
  options: Partial<PlannerOptions> = {},
) => {
  const time = clock();
  return new ModelPlanner({
    key,
    request,
    now: time.now,
    sleep: time.sleep,
    random: time.random,
    ...options,
  });
};
const input = (screen = "Shopping") => ({
  goal,
  history: [],
  observation: observation([
    element(1, { title: screen, x: 144, y: 90, w: 72, h: 18 }),
  ]),
  page: null,
});
async function failed(promise: Promise<unknown>): Promise<PlannerError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PlannerError);
    return error as PlannerError;
  }
  throw new Error("The call did not fail.");
}

const chatProviders = providers.filter(
  (provider) => provider.wire === "chat" && provider.id !== "custom",
);
const otherChat = chatProviders.filter((provider) => provider.id !== "openai");

describe("the providers", () => {
  it("each has an id, a name, key variables, an address, and a default only where it is known", () => {
    expect(providers.map((provider) => provider.id)).toEqual([
      "openai",
      "anthropic",
      "together",
      "openrouter",
      "groq",
      "fireworks",
      "xai",
      "gemini",
      "mistral",
      "deepseek",
      "custom",
    ]);
    const table = Object.fromEntries(
      providers.map((provider) => [
        provider.id,
        [provider.keys, provider.endpoint, provider.defaultModel],
      ]),
    );
    expect(table).toEqual({
      openai: [
        ["CLAWDTIME_OPENAI_API_KEY", "OPENAI_API_KEY"],
        "https://api.openai.com/v1/chat/completions",
        "gpt-5.4",
      ],
      anthropic: [
        ["CLAWDTIME_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
        null,
        "claude-opus-5-5",
      ],
      together: [
        ["CLAWDTIME_TOGETHER_API_KEY", "TOGETHER_API_KEY"],
        "https://api.together.xyz/v1/chat/completions",
        null,
      ],
      openrouter: [
        ["CLAWDTIME_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"],
        "https://openrouter.ai/api/v1/chat/completions",
        null,
      ],
      groq: [
        ["CLAWDTIME_GROQ_API_KEY", "GROQ_API_KEY"],
        "https://api.groq.com/openai/v1/chat/completions",
        null,
      ],
      fireworks: [
        ["CLAWDTIME_FIREWORKS_API_KEY", "FIREWORKS_API_KEY"],
        "https://api.fireworks.ai/inference/v1/chat/completions",
        null,
      ],
      xai: [
        ["CLAWDTIME_XAI_API_KEY", "XAI_API_KEY"],
        "https://api.x.ai/v1/chat/completions",
        null,
      ],
      gemini: [
        ["CLAWDTIME_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        null,
      ],
      mistral: [
        ["CLAWDTIME_MISTRAL_API_KEY", "MISTRAL_API_KEY"],
        "https://api.mistral.ai/v1/chat/completions",
        null,
      ],
      deepseek: [
        ["CLAWDTIME_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"],
        "https://api.deepseek.com/chat/completions",
        null,
      ],
      custom: [["CLAWDTIME_CUSTOM_API_KEY"], null, null],
    });
    // The desktop service is given every one of these, and the settings of the planner.
    for (const provider of providers)
      for (const name of provider.keys)
        expect(plannerVariables).toContain(name);
    expect(plannerVariables).toEqual(
      expect.arrayContaining([
        "CLAWDTIME_COMPUTER_MODEL",
        "CLAWDTIME_COMPUTER_EFFORT",
        "CLAWDTIME_COMPUTER_SPEED",
        "CLAWDTIME_CUSTOM_BASE_URL",
      ]),
    );
  });

  it("reads provider/model, and a bare model keeps meaning OpenAI", () => {
    const read = (text: string) => {
      const parsed = parseModel(text);
      return parsed.ok ? [parsed.provider.id, parsed.model] : parsed.problem;
    };
    expect(read("gpt-4.1-mini")).toEqual(["openai", "gpt-4.1-mini"]);
    expect(read(" openai/gpt-5.4 ")).toEqual(["openai", "gpt-5.4"]);
    expect(read("anthropic/claude-opus-5-5")).toEqual([
      "anthropic",
      "claude-opus-5-5",
    ]);
    // The rest after the provider is the model, slashes and all.
    expect(read("openrouter/qwen/qwen2.5-vl-72b-instruct:free")).toEqual([
      "openrouter",
      "qwen/qwen2.5-vl-72b-instruct:free",
    ]);
    expect(read("together/meta-llama/Llama-Vision")).toEqual([
      "together",
      "meta-llama/Llama-Vision",
    ]);
    expect(read("nowhere/model")).toMatch(/names no known provider/);
    expect(read("anthropic/")).toMatch(/names Anthropic but no model/);
    expect(read("gpt 4")).toMatch(/is not a model name/);
    // A key pasted as the model is refused and never shown.
    const pasted = read(`sk-proj-${key}`) as string;
    expect(pasted).toMatch(/looks like a key/);
    expect(pasted).not.toContain(key);
  });

  it("takes a base address of a custom service only over https, or http to this Mac", () => {
    expect(chatEndpoint("https://models.example.test/v1/")).toBe(
      "https://models.example.test/v1/chat/completions",
    );
    expect(chatEndpoint("http://127.0.0.1:8080/v1")).toBe(
      "http://127.0.0.1:8080/v1/chat/completions",
    );
    expect(chatEndpoint("http://localhost:1234/v1/chat/completions")).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
    for (const bad of [
      "http://models.example.test/v1",
      "https://name:secret@models.example.test/v1",
      "https://models.example.test/v1?key=1",
      "file:///etc/hosts",
      "not an address",
    ])
      expect(chatEndpoint(bad)).toBeNull();
  });
});

describe("a reasoning effort that the model refuses", () => {
  it("goes out once more with no effort, and no effort is sent after that", async () => {
    const chat = service(
      json({ error: { type: "invalid_request_error" } }, 400),
      json(chatCall("wait", { ms: 1, why: "w" })),
    );
    const made = planner(chat.request, { model: "gpt-5.4", effort: "low" });
    const first = await made.next(input());
    expect(first).toMatchObject({ action: { kind: "wait" } });
    await made.next(input("Groceries"));
    expect(chat.sent).toHaveLength(3);
    expect(chat.sent[0]!.body.reasoning_effort).toBe("low");
    expect(chat.sent[1]!.body.reasoning_effort).toBeUndefined();
    expect(chat.sent[2]!.body.reasoning_effort).toBeUndefined();
  });
});

describe("the choice of the provider", () => {
  const keyed =
    (...ids: string[]) =>
    (provider: Provider): KeyFound | null =>
      ids.includes(provider.id)
        ? { key: `${provider.id}-key`, from: { kind: "store" } }
        : null;
  const choose = (
    ids: string[],
    setting: string | null = null,
    extra: Partial<Parameters<typeof selectPlanner>[0]> = {},
  ) =>
    selectPlanner({
      setting: setting ? { text: setting, from: "environment" } : null,
      findKey: keyed(...ids),
      ...extra,
    });

  it("takes the first provider with a key, in a fixed order, with its default model", () => {
    const openai = choose(["deepseek", "anthropic", "openai"]);
    expect(
      openai.ok && [openai.settings.provider.id, openai.settings.model],
    ).toEqual(["openai", defaultComputerModel]);
    expect(openai.ok && openai.settings.chosen).toBe(false);
    const anthropic = choose(["groq", "anthropic"]);
    expect(
      anthropic.ok && [
        anthropic.settings.provider.id,
        anthropic.settings.model,
      ],
    ).toEqual(["anthropic", defaultAnthropicModel]);
    // A provider with no default needs a chosen model: no id is guessed.
    const together = choose(["together", "mistral"]);
    expect(together).toMatchObject({ ok: false, reason: "no_model" });
    expect(!together.ok && together.problem).toMatch(
      /clawdtime computer model together\/MODEL/,
    );
    expect(choose([])).toMatchObject({ ok: false, reason: "no_key" });
    // Custom is never taken by itself.
    expect(choose(["custom"])).toMatchObject({ ok: false, reason: "no_key" });
  });

  it("follows a setting, says which key is missing, and never names a key", () => {
    const chosen = choose(["openai", "groq"], "groq/a-vision-model");
    expect(chosen.ok && chosen.settings).toMatchObject({
      provider: { id: "groq" },
      model: "a-vision-model",
      chosen: true,
      modelFrom: "environment",
      key: "groq-key",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
    });
    const missing = choose(["openai"], "anthropic/claude-opus-5-5");
    expect(missing).toMatchObject({ ok: false, reason: "missing_key" });
    expect(!missing.ok && missing.problem).toMatch(
      /clawdtime keys set anthropic, or put CLAWDTIME_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY/,
    );
    expect(!missing.ok && missing.problem).not.toContain("openai-key");
  });

  it("needs a usable base address for a custom service, and no key", () => {
    expect(choose([], "custom/local-vision")).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(
      choose([], "custom/local-vision", {
        customBase: "http://example.test/v1",
      }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    const local = choose([], "custom/local-vision", {
      customBase: "http://127.0.0.1:8080/v1",
    });
    expect(local.ok && local.settings).toMatchObject({
      key: "",
      keyFrom: null,
      endpoint: "http://127.0.0.1:8080/v1/chat/completions",
    });
  });

  it("reads the effort and the speed, and refuses a value it does not know", () => {
    const set = choose(["anthropic"], null, {
      effort: " High ",
      speed: "fast",
    });
    expect(set.ok && [set.settings.effort, set.settings.speed]).toEqual([
      "high",
      "fast",
    ]);
    const plain = choose(["anthropic"]);
    expect(plain.ok && [plain.settings.effort, plain.settings.speed]).toEqual([
      null,
      "standard",
    ]);
    expect(choose(["anthropic"], null, { effort: "max" })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(choose(["anthropic"], null, { speed: "turbo" })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("builds the planner from the environment for any provider", async () => {
    const net = service(json(message([toolUse("wait", { ms: 1, why: "w" })])));
    const built = plannerFromEnvironment(
      { ANTHROPIC_API_KEY: key, CLAWDTIME_COMPUTER_EFFORT: "medium" },
      { request: net.request },
    )!;
    expect(built.provider.id).toBe("anthropic");
    expect(built.model).toBe(defaultAnthropicModel);
    await built.next(input());
    expect(net.sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(net.sent[0]!.body.output_config).toEqual({ effort: "medium" });
    expect(plannerFromEnvironment({ TOGETHER_API_KEY: key })).toBeNull();
    // The old name still makes the same planner.
    expect(OpenAIPlanner).toBe(ModelPlanner);
  });
});

describe("the chat completions providers", () => {
  it.each(chatProviders.map((provider) => [provider.id, provider] as const))(
    "%s: the address, the key header, the functions, the picture, and one tool call back",
    async (_id, provider) => {
      const net = service(
        json(chatCall("click_element", { element: 1, why: "Open" })),
      );
      const planned = await planner(net.request, {
        provider: provider.id,
        model: "a-vision-model",
      }).next(input());
      expect(planned).toEqual({
        action: { kind: "click_element", element: 1 },
        why: "Open",
      });
      const only = net.sent[0]!;
      expect(only.url).toBe(provider.endpoint);
      expect(only.headers.get("authorization")).toBe(`Bearer ${key}`);
      expect(only.body.model).toBe("a-vision-model");
      expect(only.body.messages.map((item) => item.role)).toEqual([
        "system",
        "user",
      ]);
      expect(
        (only.body.tools as { function: { name: string } }[]).map(
          (tool) => tool.function.name,
        ),
      ).toContain("click_element");
      const parts = only.body.messages[1]!.content as {
        type: string;
        image_url?: Record<string, string>;
      }[];
      expect(parts.map((part) => part.type)).toEqual(["text", "image_url"]);
      const openai = provider.id === "openai";
      expect(parts[1]!.image_url).toEqual({
        url: "data:image/jpeg;base64,aW1hZ2U=",
        ...(openai ? { detail: "high" } : {}),
      });
      // Only OpenAI gets a forced single call: the others get the repair.
      expect(only.body.tool_choice).toBe(openai ? "required" : undefined);
      expect(only.body.parallel_tool_calls).toBe(openai ? false : undefined);
      expect(only.body.reasoning_effort).toBeUndefined();
    },
  );

  it("sends reasoning_effort to OpenAI only when it is set, and only to a model that takes it", async () => {
    const effort = async (model: string | undefined, set?: "low" | "high") => {
      const net = service(json(chatCall("wait", { ms: 1, why: "w" })));
      await planner(net.request, {
        ...(model ? { model } : {}),
        ...(set ? { effort: set } : {}),
      }).next(input());
      return net.sent[0]!.body.reasoning_effort;
    };
    expect(await effort(undefined)).toBeUndefined();
    expect(await effort(undefined, "low")).toBe("low");
    expect(await effort("gpt-5.4", "high")).toBe("high");
    expect(await effort("o4-mini", "low")).toBe("low");
    expect(await effort("gpt-4.1", "low")).toBeUndefined();
    expect(await effort("gpt-5-chat-latest", "low")).toBeUndefined();
    // Another provider gets none: each names it in its own way.
    const net = service(json(chatCall("wait", { ms: 1, why: "w" })));
    await planner(net.request, {
      provider: "groq",
      model: "m",
      effort: "low",
    }).next(input());
    expect(net.sent[0]!.body.reasoning_effort).toBeUndefined();
  });

  it("sends to a custom address, with no key header when it has no key", async () => {
    const net = service(json(chatCall("wait", { ms: 1, why: "w" })));
    await planner(net.request, {
      provider: "custom",
      key: "",
      model: "local-vision",
      endpoint: "http://127.0.0.1:8080/v1/chat/completions",
    }).next(input());
    expect(net.sent[0]!.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(net.sent[0]!.headers.get("authorization")).toBeNull();
    expect(
      () => new ModelPlanner({ provider: "custom", key: "", model: "m" }),
    ).toThrow(/needs the address/);
    expect(() => new ModelPlanner({ provider: "together", key })).toThrow(
      /has no default model/,
    );
  });

  it.each(otherChat.map((provider) => [provider.id, provider] as const))(
    "%s: 429 and 5xx are asked again, 401 is auth, a quota code is quota, a refusal is refused, and no key is in a message",
    async (_id, provider) => {
      const options = { provider: provider.id, model: "m" };
      const busy = service(
        json({ error: { code: "rate_limited" } }, 429, { "retry-after": "1" }),
        json({}, 503),
        json(chatCall("wait", { ms: 1, why: "w" })),
      );
      expect(
        (await planner(busy.request, options).next(input())).action,
      ).toEqual({
        kind: "wait",
        ms: 1,
      });
      expect(busy.sent).toHaveLength(3);
      const troubles: [number, unknown, string][] = [
        [401, { error: { message: key } }, "auth"],
        [429, { error: { code: "insufficient_quota", message: key } }, "quota"],
        [402, {}, "quota"],
        [400, { error: { message: key } }, "other"],
      ];
      for (const [status, body, trouble] of troubles) {
        const net = service(json(body, status));
        const error = await failed(planner(net.request, options).next(input()));
        expect(error.trouble).toBe(trouble);
        expect(error.message).not.toContain(key);
        expect(net.sent).toHaveLength(1);
      }
      // No fallback model here: a 404 names a model that the person chose.
      const unknown = service(json({}, 404));
      expect(
        (await failed(planner(unknown.request, options).next(input()))).trouble,
      ).toBe("other");
      expect(unknown.sent).toHaveLength(1);
      const refused = service(
        json({
          choices: [{ message: { refusal: "No." }, finish_reason: "stop" }],
        }),
      );
      expect(
        (await failed(planner(refused.request, options).next(input()))).trouble,
      ).toBe("refused");
    },
  );

  it("asks once more after an answer that stopped at its length limit", async () => {
    const net = service(
      json({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call_cut",
                  function: {
                    name: "type",
                    arguments: '{"text":"Hel","why":"w"}',
                  },
                },
              ],
            },
            finish_reason: "length",
          },
        ],
      }),
      json(chatCall("wait", { ms: 1, why: "w" })),
    );
    expect((await planner(net.request).next(input())).action).toEqual({
      kind: "wait",
      ms: 1,
    });
    expect(net.sent).toHaveLength(2);
    expect(net.sent[1]!.body.messages.at(-1)!.content).toMatch(
      /It stopped at its length limit before its end\./,
    );
  });

  it("tells the use of tokens, with the ones from the cache", async () => {
    const seen: PlannerUsage[] = [];
    const net = service(
      json(
        chatCall(
          "wait",
          { ms: 1, why: "w" },
          {
            prompt_tokens: 3000,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 2816 },
          },
        ),
      ),
    );
    await planner(net.request, {
      onUsage: (usage) => seen.push(usage),
    }).next(input());
    expect(seen).toEqual([
      {
        provider: "openai",
        model: defaultComputerModel,
        inputTokens: 3000,
        cachedTokens: 2816,
        cacheWriteTokens: null,
        outputTokens: 20,
      },
    ]);
  });

  it("keeps the rules and the functions the same bytes from step to step, before the turn", async () => {
    const net = service(json(chatCall("wait", { ms: 1, why: "w" })));
    const model = planner(net.request);
    await model.next(input("Shopping"));
    await model.next(input("Groceries"));
    const [a, b] = net.sent.map((item) => item.body);
    expect(JSON.stringify(a!.tools)).toBe(JSON.stringify(b!.tools));
    expect(JSON.stringify(a!.messages[0])).toBe(JSON.stringify(b!.messages[0]));
    expect(JSON.stringify(a!.messages[1])).not.toBe(
      JSON.stringify(b!.messages[1]),
    );
  });
});

describe("the Anthropic provider", () => {
  const anthropic = (
    request: typeof fetch,
    options: Partial<PlannerOptions> = {},
  ) => planner(request, { provider: "anthropic", ...options });

  it("sends the Messages request: cached rules, strict tools, the picture, auto choice, low effort, the refusal fallback", async () => {
    const net = service(
      json(message([toolUse("click_element", { element: 1, why: "Open" })])),
    );
    const planned = await anthropic(net.request).next(input());
    expect(planned).toEqual({
      action: { kind: "click_element", element: 1 },
      why: "Open",
    });
    const only = net.sent[0]!;
    expect(only.url).toBe("https://api.anthropic.com/v1/messages");
    expect(only.headers.get("authorization")).toBe(`Bearer ${key}`);
    expect(only.headers.get("anthropic-beta")).toBe(
      "server-side-fallback-2026-07-01",
    );
    const body = only.body;
    expect(body.model).toBe(defaultAnthropicModel);
    expect(body.max_tokens).toBe(16000);
    expect(body.fallbacks).toBe("default");
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
    // No sampling setting and no thinking setting.
    for (const field of ["temperature", "top_p", "top_k", "thinking", "speed"])
      expect(body).not.toHaveProperty(field);
    // The one cache marker is on the rules: the tools and the rules are read from the cache.
    const system = body.system as {
      type: string;
      text: string;
      cache_control?: unknown;
    }[];
    expect(system).toHaveLength(1);
    expect(system[0]).toMatchObject({
      type: "text",
      cache_control: { type: "ephemeral" },
    });
    expect(system[0]!.text).toMatch(/one action at a time/);
    expect(JSON.stringify(body.messages)).not.toContain("cache_control");
    const tools = body.tools as {
      name: string;
      strict?: boolean;
      input_schema: Record<string, unknown>;
    }[];
    expect(tools.map((tool) => tool.name)).toContain("click_element");
    for (const tool of tools) {
      expect(tool.strict).toBe(true);
      expect(tool.input_schema.additionalProperties).toBe(false);
      expect(JSON.stringify(tool.input_schema)).not.toMatch(
        /"minimum"|"maximum"/,
      );
    }
    expect(body.messages).toHaveLength(1);
    const turn = body.messages[0]!.content as {
      type: string;
      source?: unknown;
      text?: string;
    }[];
    expect(turn.map((part) => part.type)).toEqual(["image", "text"]);
    expect(turn[0]!.source).toEqual({
      type: "base64",
      media_type: "image/jpeg",
      data: "aW1hZ2U=",
    });
    expect(turn[1]!.text).toContain(`Goal: ${goal}`);
  });

  it("sets the effort and fast mode only on the models that take them", async () => {
    const body = async (options: Partial<PlannerOptions>) => {
      const net = service(
        json(message([toolUse("wait", { ms: 1, why: "w" })])),
      );
      await anthropic(net.request, options).next(input());
      return {
        body: net.sent[0]!.body,
        beta: net.sent[0]!.headers.get("anthropic-beta"),
      };
    };
    const fast = await body({ effort: "high", speed: "fast" });
    expect(fast.body.output_config).toEqual({ effort: "high" });
    expect(fast.body.speed).toBe("fast");
    // An older model takes no effort, no fast mode, no strict tools and no fallback.
    const old = await body({ model: "claude-sonnet-4-5", speed: "fast" });
    expect(old.body).not.toHaveProperty("output_config");
    expect(old.body).not.toHaveProperty("speed");
    expect(old.body).not.toHaveProperty("fallbacks");
    expect(old.beta).toBeNull();
    expect(
      (old.body.tools as { strict?: boolean }[]).some((tool) => tool.strict),
    ).toBe(false);
    // A model that takes the effort and strict tools, but no fast mode and no fallback.
    const haiku = await body({ model: "claude-haiku-5-5", speed: "fast" });
    expect(haiku.body.output_config).toEqual({ effort: "low" });
    expect(haiku.body).not.toHaveProperty("speed");
    expect(haiku.body).not.toHaveProperty("fallbacks");
    expect(
      (haiku.body.tools as { strict?: boolean }[]).every((tool) => tool.strict),
    ).toBe(true);
  });

  it("keeps the tools and the rules the same bytes from step to step", async () => {
    const net = service(json(message([toolUse("wait", { ms: 1, why: "w" })])));
    const model = anthropic(net.request);
    await model.next(input("Shopping"));
    await model.next(input("Groceries"));
    const [a, b] = net.sent.map((item) => item.body);
    expect(JSON.stringify([a!.tools, a!.system])).toBe(
      JSON.stringify([b!.tools, b!.system]),
    );
    expect(JSON.stringify(a!.messages)).not.toBe(JSON.stringify(b!.messages));
  });

  it("tells the use of tokens, with the ones read from and written to the cache", async () => {
    const seen: PlannerUsage[] = [];
    const net = service(
      json(
        message([toolUse("wait", { ms: 1, why: "w" })], "tool_use", {
          input_tokens: 900,
          cache_read_input_tokens: 2400,
          cache_creation_input_tokens: 0,
          output_tokens: 30,
        }),
      ),
    );
    await anthropic(net.request, { onUsage: (usage) => seen.push(usage) }).next(
      input(),
    );
    expect(seen).toEqual([
      {
        provider: "anthropic",
        model: defaultAnthropicModel,
        inputTokens: 3300,
        cachedTokens: 2400,
        cacheWriteTokens: 0,
        outputTokens: 30,
      },
    ]);
  });

  it("asks once more after an answer with no tool call, and sends the answer back unchanged with a result for each call", async () => {
    const thinking = {
      type: "thinking",
      thinking: "",
      signature: "sig_fixture",
    };
    const net = service(
      json(
        message(
          [thinking, { type: "text", text: "I will open it." }],
          "end_turn",
        ),
      ),
      json(message([toolUse("wait", { ms: 1, why: "w" })])),
    );
    const model = anthropic(net.request);
    expect((await model.next(input())).action).toEqual({ kind: "wait", ms: 1 });
    expect(net.sent).toHaveLength(2);
    const repair = net.sent[1]!.body.messages;
    expect(repair).toHaveLength(3);
    expect(repair[1]).toEqual({
      role: "assistant",
      content: [thinking, { type: "text", text: "I will open it." }],
    });
    expect(repair[2]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "The program could not use your last answer. It had no tool call. Nothing was run. Call exactly one of the offered functions, with its arguments as one JSON object.",
        },
      ],
    });
    // Two calls in one answer: none runs, and each gets its result.
    const two = service(
      json(
        message([
          toolUse("click_element", { element: 1, why: "a" }, "toolu_a"),
          toolUse("key", { combo: "cmd+q", why: "b" }, "toolu_b"),
        ]),
      ),
      json(message([toolUse("wait", { ms: 1, why: "w" })])),
    );
    expect((await anthropic(two.request).next(input())).action).toEqual({
      kind: "wait",
      ms: 1,
    });
    const tail = two.sent[1]!.body.messages.at(-1)!.content as {
      type: string;
      tool_use_id?: string;
      content?: string;
    }[];
    expect(tail.slice(0, 2)).toEqual([
      { type: "tool_result", tool_use_id: "toolu_a", content: "Not run." },
      { type: "tool_result", tool_use_id: "toolu_b", content: "Not run." },
    ]);
  });

  it("maps a refusal to refused with no second request, and a cut answer to a repair", async () => {
    const refused = service(json(message([], "refusal")));
    expect(
      (await failed(anthropic(refused.request).next(input()))).trouble,
    ).toBe("refused");
    expect(refused.sent).toHaveLength(1);
    const cut = service(
      json(message([toolUse("type", { text: "Hel", why: "w" })], "max_tokens")),
      json(message([toolUse("wait", { ms: 1, why: "w" })])),
    );
    expect((await anthropic(cut.request).next(input())).action).toEqual({
      kind: "wait",
      ms: 1,
    });
    expect(cut.sent).toHaveLength(2);
  });

  it("maps the errors of the library: 429, 529 and 5xx are asked again, 401 and 403 are auth, billing is quota", async () => {
    const time = clock();
    const busy = service(
      anthropicError(429, "rate_limit_error"),
      anthropicError(529, "overloaded_error"),
      anthropicError(500, "api_error"),
      json(message([toolUse("wait", { ms: 1, why: "w" })])),
    );
    expect(
      (
        await new ModelPlanner({
          provider: "anthropic",
          key,
          request: busy.request,
          ...time,
        }).next(input())
      ).action,
    ).toEqual({ kind: "wait", ms: 1 });
    expect(busy.sent).toHaveLength(4);
    expect(time.waits).toEqual([200, 400, 800]);
    const cases: [() => Response, string, string][] = [
      [
        anthropicError(401, "authentication_error"),
        "auth",
        "401 (authentication_error)",
      ],
      [
        anthropicError(403, "permission_error"),
        "auth",
        "403 (permission_error)",
      ],
      [anthropicError(402, "billing_error"), "quota", "402 (billing_error)"],
      [
        anthropicError(429, "rate_limit_error", {
          details: { error_code: "enforced_spend_limit_reached" },
        }),
        "quota",
        "429 (enforced_spend_limit_reached)",
      ],
      [
        anthropicError(404, "not_found_error"),
        "other",
        "404 (not_found_error)",
      ],
      [
        anthropicError(400, "invalid_request_error"),
        "other",
        "400 (invalid_request_error)",
      ],
    ];
    for (const [reply, trouble, said] of cases) {
      const net = service(reply);
      const error = await failed(anthropic(net.request).next(input()));
      expect(error.trouble).toBe(trouble);
      expect(error.message).toBe(`The language model answered ${said}.`);
      expect(error.message).not.toContain(key);
      expect(error.message).not.toContain(goal);
      expect(net.sent).toHaveLength(1);
    }
  });

  it("waits as long as the service asks, and asks again after an error of the network", async () => {
    const time = clock();
    const net = service(
      anthropicError(429, "rate_limit_error"),
      json(message([toolUse("wait", { ms: 1, why: "w" })])),
    );
    // The first reply carries a Retry-After of two seconds.
    const slow = (async (...args: Parameters<typeof fetch>) => {
      const response = await net.request(...args);
      if (response.status !== 429) return response;
      return new Response(await response.text(), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "2" },
      });
    }) as typeof fetch;
    await new ModelPlanner({
      provider: "anthropic",
      key,
      request: slow,
      ...time,
    }).next(input());
    expect(time.waits).toEqual([2000]);
    let first = true;
    const flaky = (async (...args: Parameters<typeof fetch>) => {
      if (first) {
        first = false;
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
        });
      }
      return json(message([toolUse("wait", { ms: 1, why: "w" })]))();
    }) as typeof fetch;
    expect((await anthropic(flaky).next(input())).action).toEqual({
      kind: "wait",
      ms: 1,
    });
  });

  it("reads a request for a move through the same transport", async () => {
    const net = service(
      json(message([toolUse("desktop", { direction: "left" })])),
    );
    expect(
      await anthropic(net.request).navigation("go one desktop left"),
    ).toEqual({ kind: "desktop", direction: "left" });
    expect(net.sent[0]!.body.messages[0]!.content).toEqual([
      { type: "text", text: "go one desktop left" },
    ]);
    const refused = service(json(message([], "refusal")));
    expect(
      (await failed(anthropic(refused.request).navigation("go left"))).trouble,
    ).toBe("refused");
  });
});

describe("the strict tools of Anthropic", () => {
  const fn = (
    name: string,
    properties: Record<string, unknown>,
    required: string[],
  ) =>
    ({
      type: "function",
      function: {
        name,
        description: name,
        parameters: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
      },
    }) satisfies FunctionTool;

  it("drops limits a strict schema may not have, and closes every object", () => {
    expect(
      strictSchema({
        type: "object",
        properties: {
          ms: { type: "integer", minimum: 0, maximum: 10000 },
          to: {
            oneOf: [
              { type: "object", properties: { element: { type: "integer" } } },
              { type: "object", properties: { x: { type: "number" } } },
            ],
          },
          text: { type: "string", maxLength: 10, format: "uri" },
          when: { type: "string", format: "not-a-format" },
        },
        required: ["ms"],
      }),
    ).toEqual({
      type: "object",
      properties: {
        ms: { type: "integer" },
        to: {
          anyOf: [
            {
              type: "object",
              properties: { element: { type: "integer" } },
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { x: { type: "number" } },
              additionalProperties: false,
            },
          ],
        },
        text: { type: "string", format: "uri" },
        when: { type: "string" },
      },
      required: ["ms"],
      additionalProperties: false,
    });
  });

  it("makes strict only the tools that fit the limits of the service, in their order", () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      fn(`tool_${index}`, { why: { type: "string" } }, ["why"]),
    );
    const out = messagesTools(many, true);
    expect(out.filter((tool) => tool.strict)).toHaveLength(strictLimits.tools);
    expect(out.slice(0, 20).every((tool) => tool.strict)).toBe(true);
    // The rest keep their own schema, with no strict flag.
    expect(out[20]).toEqual({
      name: "tool_20",
      description: "tool_20",
      input_schema: many[20]!.function.parameters,
    });
    // The same list gives the same tools each time.
    expect(messagesTools(many, true)).toBe(out);
    const optional = Array.from({ length: 5 }, (_, index) =>
      fn(
        `optional_${index}`,
        Object.fromEntries(
          Array.from({ length: 6 }, (_, at) => [`p${at}`, { type: "string" }]),
        ),
        [],
      ),
    );
    // 6 optional parameters each: four tools reach 24, the fifth goes without strict.
    expect(
      messagesTools(optional, true).map((tool) => tool.strict === true),
    ).toEqual([true, true, true, true, false]);
    expect(messagesTools(many, false).some((tool) => tool.strict)).toBe(false);
  });

  it("names no provider that is not in the registry", () => {
    expect(providerById("anthropic")?.wire).toBe("messages");
    expect(providerById("nowhere")).toBeUndefined();
  });
});

describe("the merged planner features through every provider", () => {
  const closer: Closer = {
    image: "Y2xvc2Vy",
    imageWidth: 960,
    imageHeight: 600,
    region: { x: 480, y: 300, w: 320, h: 200 },
  };
  const plan = TaskPlan.from([
    { goal: "Open the note", check: "The editor shows it" },
    { goal: "Add milk", check: "The note holds milk" },
  ])!.view();

  it("Anthropic: the closer look as a second image block, and a click in it mapped back", async () => {
    const net = service(
      json(
        message([
          toolUse("click_at", { x: 300, y: 150, closer: true, why: "Star" }),
        ]),
      ),
    );
    const planned = await planner(net.request, { provider: "anthropic" }).next({
      ...input(),
      closer,
    });
    // 480 + 300 * 320 / 960 = 580; 300 + 150 * 200 / 600 = 350.
    expect(planned.action).toEqual({ kind: "click_at", x: 580, y: 350 });
    const turn = net.sent[0]!.body.messages[0]!.content as {
      type: string;
      source?: { data: string };
    }[];
    expect(turn.map((part) => part.type)).toEqual(["image", "image", "text"]);
    expect(turn.map((part) => part.source?.data)).toEqual([
      "aW1hZ2U=",
      "Y2xvc2Vy",
      undefined,
    ]);
  });

  it("a plan adds its rules and plan_update, byte-stable while it does not change, for OpenAI and Anthropic", async () => {
    const chat = service(json(chatCall("wait", { ms: 1, why: "w" })));
    const openai = planner(chat.request);
    await openai.next({ ...input("Shopping"), plan });
    await openai.next({ ...input("Groceries"), plan });
    const [a, b] = chat.sent.map((item) => item.body);
    // The default request of OpenAI keeps its forced call. With a plan, a
    // plan_update may come with one action, so two calls are allowed.
    expect(a!.tool_choice).toBe("required");
    expect(a!.parallel_tool_calls).toBe(true);
    expect(
      (a!.tools as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      ),
    ).toContain("plan_update");
    expect(JSON.stringify([a!.tools, a!.messages[0]])).toBe(
      JSON.stringify([b!.tools, b!.messages[0]]),
    );
    const messages = service(
      json(
        message([
          toolUse("plan_update", {
            op: "done",
            evidence: "The editor shows it",
            why: "Met",
          }),
        ]),
      ),
    );
    const anthropic = planner(messages.request, { provider: "anthropic" });
    const chosen = await anthropic.next({ ...input("Shopping"), plan });
    expect(chosen).toMatchObject({ update: { op: "done" } });
    await anthropic.next({ ...input("Groceries"), plan });
    const [c, d] = messages.sent.map((item) => item.body);
    expect((c!.tools as { name: string }[]).map((tool) => tool.name)).toContain(
      "plan_update",
    );
    expect(JSON.stringify([c!.tools, c!.system])).toBe(
      JSON.stringify([d!.tools, d!.system]),
    );
  });

  it("the outline goes through the same call: low detail on OpenAI, one image block on Anthropic", async () => {
    const subgoals = [{ goal: "Open the note", check: "The editor shows it" }];
    const chat = service(json(chatCall("outline", { subgoals, why: "One" })));
    expect(
      await planner(chat.request).outline({
        goal,
        observation: observation(),
        page: null,
      }),
    ).toEqual({ subgoals });
    const parts = chat.sent[0]!.body.messages[1]!.content as {
      type: string;
      image_url?: { detail?: string };
    }[];
    expect(parts[1]!.image_url!.detail).toBe("low");
    expect(chat.sent[0]!.body.tool_choice).toBe("required");
    const messages = service(
      json(message([toolUse("outline", { subgoals, why: "One" })])),
    );
    expect(
      await planner(messages.request, { provider: "anthropic" }).outline({
        goal,
        observation: observation(),
        page: null,
      }),
    ).toEqual({ subgoals });
    const body = messages.sent[0]!.body;
    expect(
      (body.tools as { name: string; strict?: boolean }[]).map((tool) => [
        tool.name,
        tool.strict,
      ]),
    ).toEqual([["outline", true]]);
    expect(
      (body.messages[0]!.content as { type: string }[]).map(
        (part) => part.type,
      ),
    ).toEqual(["image", "text"]);
  });
});
