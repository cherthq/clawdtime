/**
 * Computer use: the services that can be the language model of the planner.
 *
 * Each provider has an id, a name for people, the variables that can hold its
 * key, the address of its interface, and a default model only where that exact
 * model is known to work as the planner. A provider with no default needs a
 * model that the person chose: no model id is guessed here.
 *
 * Three transports carry one request of the planner. Most providers speak the
 * chat completions interface of OpenAI, so one transport over `fetch` serves
 * them all, with their own address and key. The newest models of OpenAI take
 * functions with a reasoning effort only on its Responses route, so they get
 * a transport of their own over `fetch` (`openaiWire`). Anthropic gets its
 * official library and its Messages interface. All three take the same
 * request (the rules, the functions and the turn) and give back the same
 * answer (the tool calls, a refusal, the use of tokens). None retries:
 * `model-call.ts` is the only layer that asks again.
 *
 * A request puts what never changes first: the functions and the rules, the
 * same bytes in every step, so that the service can keep them in its cache.
 * Only the turn after them changes.
 *
 * No message from here holds a key, the request, the picture or the body of
 * an answer. A failure names a status, an error code of the service, or a
 * code of the network.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  PlannerError,
  retryAfterMs,
  statusTrouble,
  thrownTrouble,
  errorCode,
  type Attempt,
} from "./model-call.js";

export const providerIds = [
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
] as const;
export type ProviderId = (typeof providerIds)[number];

/**
 * The model of the planner on OpenAI. It is the one that did best in the
 * planner test (`npm run eval:computer:planner`): run that test before this
 * line changes.
 */
export const defaultComputerModel = "gpt-6.2-astra";
/**
 * The model before it. When the service says that a key may not use the
 * default, or does not know it, the planner goes to this one, once, and stays
 * there. A model that the person chose is never replaced.
 */
export const fallbackComputerModel = "gpt-5.4";
/** The model of the planner on Anthropic. */
export const defaultAnthropicModel = "claude-opus-5-5";

export interface Provider {
  readonly id: ProviderId;
  /** The name for people. */
  readonly name: string;
  /** The variables that can hold the key, the first one wins. */
  readonly keys: readonly string[];
  /**
   * The address of the chat completions route. Null for Anthropic, whose
   * library knows its address, and for `custom`, whose address the person
   * gives.
   */
  readonly endpoint: string | null;
  /** The model when the person chose none. Null: the person must choose. */
  readonly defaultModel: string | null;
  /** The interface. OpenAI also has its Responses route, by model or by setting (`openaiWire`). */
  readonly wire: "chat" | "messages";
}

const chat = (
  id: ProviderId,
  name: string,
  keys: string[],
  endpoint: string | null,
): Provider => ({ id, name, keys, endpoint, defaultModel: null, wire: "chat" });

/** Every provider, in the fixed order of the choice with no setting. */
export const providers: readonly Provider[] = [
  {
    id: "openai",
    name: "OpenAI",
    keys: ["CLAWDTIME_OPENAI_API_KEY", "OPENAI_API_KEY"],
    endpoint: "https://api.openai.com/v1/chat/completions",
    defaultModel: defaultComputerModel,
    wire: "chat",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    keys: ["CLAWDTIME_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
    endpoint: null,
    defaultModel: defaultAnthropicModel,
    wire: "messages",
  },
  chat(
    "together",
    "Together AI",
    ["CLAWDTIME_TOGETHER_API_KEY", "TOGETHER_API_KEY"],
    "https://api.together.xyz/v1/chat/completions",
  ),
  chat(
    "openrouter",
    "OpenRouter",
    ["CLAWDTIME_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"],
    "https://openrouter.ai/api/v1/chat/completions",
  ),
  chat(
    "groq",
    "Groq",
    ["CLAWDTIME_GROQ_API_KEY", "GROQ_API_KEY"],
    "https://api.groq.com/openai/v1/chat/completions",
  ),
  chat(
    "fireworks",
    "Fireworks AI",
    ["CLAWDTIME_FIREWORKS_API_KEY", "FIREWORKS_API_KEY"],
    "https://api.fireworks.ai/inference/v1/chat/completions",
  ),
  chat(
    "xai",
    "xAI",
    ["CLAWDTIME_XAI_API_KEY", "XAI_API_KEY"],
    "https://api.x.ai/v1/chat/completions",
  ),
  chat(
    "gemini",
    "Google Gemini",
    ["CLAWDTIME_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  ),
  chat(
    "mistral",
    "Mistral",
    ["CLAWDTIME_MISTRAL_API_KEY", "MISTRAL_API_KEY"],
    "https://api.mistral.ai/v1/chat/completions",
  ),
  chat(
    "deepseek",
    "DeepSeek",
    ["CLAWDTIME_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"],
    "https://api.deepseek.com/chat/completions",
  ),
  chat("custom", "a custom service", ["CLAWDTIME_CUSTOM_API_KEY"], null),
];

export function providerById(id: string): Provider | undefined {
  return providers.find((provider) => provider.id === id);
}

/** Every variable of the planner that the desktop service reads from its environment. */
export const plannerVariables: readonly string[] = [
  ...providers.flatMap((provider) => provider.keys),
  "CLAWDTIME_COMPUTER_MODEL",
  "CLAWDTIME_COMPUTER_EFFORT",
  "CLAWDTIME_COMPUTER_SPEED",
  "CLAWDTIME_CUSTOM_BASE_URL",
  "CLAWDTIME_OPENAI_API",
];

export type Effort = "low" | "medium" | "high" | "xhigh";
export const efforts: readonly Effort[] = ["low", "medium", "high", "xhigh"];
/** The effort of the step planner when the person set none. */
export const defaultEffort: Effort = "low";
export type Speed = "standard" | "fast";

/** Anthropic models that take `output_config.effort`. */
const effortModels =
  /^claude-(?:fable-5|mythos-5|opus-5|opus-4-[5-8]|sonnet-5|sonnet-4-6|haiku-5)/;
/** Anthropic models that take a tool with `strict: true`. */
const strictModels =
  /^claude-(?:fable-5|mythos-5|opus-5|opus-4-8|opus-4-5|opus-4-1|sonnet-5|haiku-5|haiku-4-5)/;
/** Anthropic models for which the reference turns the server-side refusal fallback on. */
const fallbackModels = new Set([
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);
/** Anthropic models that take `speed: "fast"` with no beta flag. */
const fastModels = new Set([
  "claude-opus-5-5",
  "claude-fable-5-2",
  "claude-mythos-5-2",
]);
/** OpenAI models that take a reasoning effort: the reasoning models, not their chat versions. */
export const reasoningModels =
  /^(?:gpt-(?:[5-9]|[1-9]\d+)(?![\w.-]*chat)|o[1-9])/;

/** The two routes of OpenAI: chat completions and Responses. */
export type OpenAIApi = "chat" | "responses";
export const openaiApis: readonly OpenAIApi[] = ["chat", "responses"];
/** The Responses route of OpenAI. */
export const responsesEndpoint = "https://api.openai.com/v1/responses";
/**
 * OpenAI models that go to the Responses route by their name. On chat
 * completions `gpt-6.2-astra` and `gpt-6.2-sol` answer 400 to functions with
 * a reasoning effort, and refuse `none` (measured 26 Nov 2026).
 */
export const responsesModels =
  /^(?:gpt-(?:[6-9]|[1-9]\d+)(?![\w.-]*chat)|gpt-5\.6)/;

/**
 * `CLAWDTIME_OPENAI_API`: `responses` or `chat` for every model of OpenAI,
 * null when it is not set, `invalid` for any other value.
 */
export function openaiApiSetting(
  text: string | undefined,
): OpenAIApi | null | "invalid" {
  const value = text?.trim().toLowerCase();
  if (!value) return null;
  return openaiApis.includes(value as OpenAIApi)
    ? (value as OpenAIApi)
    : "invalid";
}

/**
 * The transport of a request: the Messages interface of Anthropic, the
 * Responses route of OpenAI, or chat completions. OpenAI follows the setting
 * when there is one, else the name of the model, or Responses when a
 * reasoning model is asked for an explicit reasoning effort.
 */
export function openaiWire(
  provider: Provider,
  model: string,
  api?: OpenAIApi | null,
  effort?: Effort | string | null,
): "chat" | "messages" | "responses" {
  if (provider.id !== "openai") return provider.wire;
  if (api) return api;
  if (responsesModels.test(model)) return "responses";
  if (effort && effort !== "none" && reasoningModels.test(model))
    return "responses";
  return "chat";
}

/**
 * The effort of a request on the Responses route: the person's, or the
 * default of the request, on a model that reasons. This route always names
 * one: the step planner gets `low`, the outline and the chat `medium`.
 */
export const responsesEffort = (
  model: string,
  setting: Effort | null | undefined,
  fallback: Effort,
): Effort | null =>
  reasoningModels.test(model) ? (setting ?? fallback) : null;

/**
 * The effort that a request names, or null when it names none. Anthropic gets
 * the person's effort or the low default on a model that takes it. OpenAI
 * gets `reasoning_effort` only when the person set one, and only on a model
 * that takes it: without a setting its request stays as it was measured. The
 * other providers get none, because each names it in its own way.
 */
export function sentEffort(
  provider: ProviderId,
  model: string,
  setting: Effort | null | undefined,
): Effort | null {
  if (provider === "anthropic")
    return effortModels.test(model) ? (setting ?? defaultEffort) : null;
  if (provider === "openai")
    return setting && reasoningModels.test(model) ? setting : null;
  return null;
}
/** Whether a request asks for fast mode: only on the Anthropic models that take it. */
export const sentFast = (
  provider: ProviderId,
  model: string,
  setting: Speed | null | undefined,
) => provider === "anthropic" && setting === "fast" && fastModels.has(model);
/** Whether a request turns on the server-side refusal fallback of Anthropic. */
export const refusalFallback = (provider: ProviderId, model: string) =>
  provider === "anthropic" && fallbackModels.has(model);

/** A model id: plain characters only, so that nothing else hides in a setting. */
const modelShape = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
/** Beginnings of keys of the providers. A model setting that has one is a key. */
const keyStarts = /^(?:sk-|sk_|gsk_|xai-|fw_|AIza|tgp_|r8_|pplx-|nvapi-)/;

/**
 * A model setting: `provider/model`, or a bare model, which means OpenAI as
 * it always did. A problem never quotes the setting: a key can be pasted
 * there by mistake.
 */
export function parseModel(
  text: string,
  looksSecret: (value: string) => boolean = () => false,
):
  | { ok: true; provider: Provider; model: string }
  | { ok: false; problem: string } {
  const value = text.trim();
  if (keyStarts.test(value) || looksSecret(value))
    return {
      ok: false,
      problem:
        "The model setting looks like a key, not a model, so it is not used and not shown. Set the model again, and keep the key in: clawdtime keys set PROVIDER",
    };
  if (!modelShape.test(value))
    return {
      ok: false,
      problem: `The model setting is not a model name. Use provider/model, for example ${providerIds[1]}/${defaultAnthropicModel}, or a bare model of OpenAI.`,
    };
  const slash = value.indexOf("/");
  if (slash < 0) return { ok: true, provider: providers[0]!, model: value };
  const head = value.slice(0, slash);
  const provider = providerById(head);
  if (!provider)
    return {
      ok: false,
      problem: `The model setting names no known provider. Use one of: ${providerIds.join(", ")}.`,
    };
  const model = value.slice(slash + 1);
  if (!model)
    return {
      ok: false,
      problem: `The model setting names ${provider.name} but no model. Use ${provider.id}/MODEL.`,
    };
  return { ok: true, provider, model };
}

/** The model as people write it: a bare model for OpenAI, provider/model for every other. */
export const modelName = (provider: Provider, model: string) =>
  provider.id === "openai" ? model : `${provider.id}/${model}`;

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
/**
 * The chat completions route of a base address that the person gave, or null
 * when the address cannot be used: https, or http only to this Mac itself, and
 * no name, password, query or fragment in it.
 */
export function chatEndpoint(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && loopback.has(url.hostname))
  )
    return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path.endsWith("/chat/completions") ? path : `${path}/chat/completions`}`;
}

export type KeySource =
  { kind: "environment"; name: string } | { kind: "store" };
export interface KeyFound {
  key: string;
  from: KeySource;
}

/** What the planner uses, after the choice. */
export interface PlannerSettings {
  provider: Provider;
  model: string;
  /** The person chose the model: it is never replaced. */
  chosen: boolean;
  modelFrom: "environment" | "store" | "default";
  /** Empty only for a custom service with no key. */
  key: string;
  keyFrom: KeySource | null;
  /** The chat completions route. Null for Anthropic. */
  endpoint: string | null;
  /** The effort that the person set, or null for the default. */
  effort: Effort | null;
  speed: Speed;
  /** The route of OpenAI that the person set, or null: the name of the model chooses (`openaiWire`). */
  api: OpenAIApi | null;
}
export type Selection =
  | { ok: true; settings: PlannerSettings }
  | {
      ok: false;
      /** `no_key`: no key at all and no choice, the plain case of a new Mac. */
      reason: "no_key" | "missing_key" | "no_model" | "invalid";
      problem: string;
      provider: Provider | null;
    };

const keyHelp = (provider: Provider) =>
  `Set one: clawdtime keys set ${provider.id}, or put ${provider.keys.join(" or ")} in the environment of the service.`;

/**
 * The provider, the model and the key of the planner. A model setting comes
 * first. With none, the first provider in the fixed order that has a key
 * gives its default model. The OpenAI fallback stays only for that default.
 */
export function selectPlanner(input: {
  setting: { text: string; from: "environment" | "store" } | null;
  findKey: (provider: Provider) => KeyFound | null;
  /** The base address for `custom`, when the person gave one. */
  customBase?: string | null;
  effort?: string | undefined;
  speed?: string | undefined;
  /** `CLAWDTIME_OPENAI_API`. */
  api?: string | undefined;
  looksSecret?: (value: string) => boolean;
}): Selection {
  const effortText = input.effort?.trim().toLowerCase();
  const speedText = input.speed?.trim().toLowerCase();
  const api = openaiApiSetting(input.api);
  const invalid = (problem: string): Selection => ({
    ok: false,
    reason: "invalid",
    problem,
    provider: null,
  });
  if (effortText && !efforts.includes(effortText as Effort))
    return invalid(
      "CLAWDTIME_COMPUTER_EFFORT is not low, medium, high or xhigh, so the planner does not start. Fix it or remove it.",
    );
  if (speedText && speedText !== "fast" && speedText !== "standard")
    return invalid(
      "CLAWDTIME_COMPUTER_SPEED is not fast or standard, so the planner does not start. Fix it or remove it.",
    );
  if (api === "invalid")
    return invalid(
      "CLAWDTIME_OPENAI_API is not responses or chat, so the planner does not start. Fix it or remove it.",
    );
  const effort = (effortText || null) as Effort | null;
  const speed: Speed = speedText === "fast" ? "fast" : "standard";
  const settle = (
    provider: Provider,
    model: string,
    modelFrom: PlannerSettings["modelFrom"],
  ): Selection => {
    let endpoint = provider.endpoint;
    if (provider.id === "custom") {
      endpoint = input.customBase ? chatEndpoint(input.customBase) : null;
      if (!endpoint)
        return {
          ok: false,
          reason: "invalid",
          problem: input.customBase
            ? "The base address of the custom service cannot be used. Give an https address, or http only to this Mac, with no name, password or query in it."
            : "The custom service needs its base address. Run: clawdtime computer model custom/MODEL --base-url https://HOST/v1, or set CLAWDTIME_CUSTOM_BASE_URL.",
          provider,
        };
    }
    const found = input.findKey(provider);
    if (!found && provider.id !== "custom")
      return {
        ok: false,
        reason: "missing_key",
        problem: `The planner model is ${modelName(provider, model)}, but no key for ${provider.name} is set. ${keyHelp(provider)}`,
        provider,
      };
    return {
      ok: true,
      settings: {
        provider,
        model,
        chosen: modelFrom !== "default",
        modelFrom,
        key: found?.key ?? "",
        keyFrom: found?.from ?? null,
        endpoint,
        effort,
        speed,
        api,
      },
    };
  };
  if (input.setting) {
    const parsed = parseModel(input.setting.text, input.looksSecret);
    if (!parsed.ok) return invalid(parsed.problem);
    return settle(parsed.provider, parsed.model, input.setting.from);
  }
  for (const provider of providers) {
    if (provider.id === "custom" || !input.findKey(provider)) continue;
    if (provider.defaultModel)
      return settle(provider, provider.defaultModel, "default");
    return {
      ok: false,
      reason: "no_model",
      problem: `A key for ${provider.name} is set, but ${provider.name} has no default model. Choose one that reads pictures: clawdtime computer model ${provider.id}/MODEL. Run the planner test before you rely on it: npm run eval:computer:planner -- ${provider.id}/MODEL`,
      provider,
    };
  }
  return {
    ok: false,
    reason: "no_key",
    problem: `No key for a language model is set. ${keyHelp(providers[0]!)} Any other provider works too: clawdtime keys list`,
    provider: null,
  };
}

// The request and the answer that both transports share.

/** One function that the model may call. The tool lists of the planner have this shape. */
export interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

/** One request of the planner. */
export interface PlannerRequest {
  /** The rules. The same bytes in each step: they come first, with the functions. */
  system: string;
  /** The offered functions, in their fixed order. */
  tools: readonly FunctionTool[];
  /**
   * The turn: plain text, or a text with pictures (JPEG, base64), in their
   * order: the screen, then a closer look when there is one. `detail` is the
   * size at which a provider that takes it reads them, `high` by default.
   */
  user:
    | string
    | {
        text: string;
        images?: readonly string[];
        detail?: "high" | "low";
      };
  /** Earlier answers that could not be used, each with what the program said about it. */
  repairs?: readonly { answer: ModelAnswer; note: string }[];
  /** A change of the plan may come with one action in the same answer: two calls are allowed. */
  pair?: boolean;
  /**
   * The effort of this request on a route that always names one (Responses)
   * when the person set none. Left out: `low`, the effort of a step.
   */
  defaultEffort?: Effort;
}

/** One tool call of an answer. Nothing in it is trusted. */
export interface ModelCall {
  id: string | null;
  name: string | null;
  /** The arguments as JSON text, as the model sent them. Empty when it sent none. */
  arguments: string;
}

/** How many tokens one answer took, as the service counted them. */
export interface PlannerUsage {
  provider: ProviderId;
  model: string;
  /** Every token of the request, the ones from the cache included. */
  inputTokens: number | null;
  /** Tokens of the request that the service read from its cache. */
  cachedTokens: number | null;
  /** Tokens of the request that the service wrote to its cache (Anthropic). */
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  /** Tokens of the answer spent on reasoning, when the service reports them. */
  reasoningTokens?: number | null;
}
export type UsageReport = (usage: PlannerUsage) => void;

/** One answer of the model. */
export interface ModelAnswer {
  refused: boolean;
  /** The answer stopped at its token limit: no call in it can be trusted whole. */
  cut: boolean;
  calls: readonly ModelCall[];
  usage: PlannerUsage | null;
  /** The answer as the provider sent it, for its own repair. The planner never reads it. */
  raw: unknown;
}

/** One request out, one answer back. A failure of the service is an Attempt that is not ok; the caller's abort throws. */
export interface Transport {
  /** The model that the next request names. */
  readonly model: string;
  send(
    request: PlannerRequest,
    signal: AbortSignal,
  ): Promise<Attempt<ModelAnswer>>;
  /** One turn of a conversation with tools, for the chat. Absent on a transport that has none. */
  converse?(
    request: ConversationRequest,
    signal: AbortSignal,
  ): Promise<Attempt<ConversationAnswer>>;
}

// A conversation: the chat of ClawdTime speaks over the same transports. It is
// many turns, the model chooses whether to call a function, and it may call
// several in one answer. The planner's requests above do not change.

/** One message of a conversation. Nothing in it is trusted. */
export type ConversationMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      calls?: readonly { id: string; name: string; arguments: string }[];
    }
  | { role: "tool"; callId: string; content: string };

/** One request of the chat: its rules, its functions and the conversation so far. */
export interface ConversationRequest {
  system: string;
  tools: readonly FunctionTool[];
  messages: readonly ConversationMessage[];
}

/** One answer of the chat: words, calls, or both. */
export interface ConversationAnswer {
  text: string;
  calls: readonly ModelCall[];
  refused: boolean;
  cut: boolean;
  usage: PlannerUsage | null;
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

// The chat completions transport: OpenAI and every provider that speaks its interface.

/** A message of a chat completions answer. Nothing in it is trusted. */
interface ChatMessage {
  content?: unknown;
  refusal?: unknown;
  tool_calls?: unknown;
}
interface ChatToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

function firstChoice(body: unknown): { message: ChatMessage; finish: unknown } {
  const choices =
    body && typeof body === "object"
      ? (body as { choices?: unknown }).choices
      : undefined;
  const choice: { message?: unknown; finish_reason?: unknown } =
    Array.isArray(choices) && choices[0] && typeof choices[0] === "object"
      ? choices[0]
      : {};
  const message =
    choice.message && typeof choice.message === "object"
      ? (choice.message as ChatMessage)
      : {};
  return { message, finish: choice.finish_reason };
}
const chatCalls = (message: ChatMessage): ChatToolCall[] =>
  Array.isArray(message.tool_calls)
    ? message.tool_calls.filter(
        (call): call is ChatToolCall => !!call && typeof call === "object",
      )
    : [];

/**
 * The messages that go back after a chat answer that cannot be used: its own
 * answer, a result for each of its tool calls (the service needs one), and
 * what was wrong.
 */
function chatRepair(
  message: ChatMessage,
  note: string,
): Record<string, unknown>[] {
  const tell = { role: "user", content: note };
  const content =
    typeof message.content === "string" && message.content.trim()
      ? message.content
      : null;
  const echoed = chatCalls(message).map((call) => ({
    id: call.id,
    name: call.function?.name,
    arguments: call.function?.arguments,
  }));
  if (
    echoed.length > 0 &&
    echoed.every(
      (call) =>
        typeof call.id === "string" &&
        call.id !== "" &&
        typeof call.name === "string" &&
        call.name !== "",
    )
  )
    return [
      {
        role: "assistant",
        content,
        tool_calls: echoed.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: typeof call.arguments === "string" ? call.arguments : "",
          },
        })),
      },
      ...echoed.map((call) => ({
        role: "tool",
        tool_call_id: call.id,
        content: "Not run.",
      })),
      tell,
    ];
  return [...(content !== null ? [{ role: "assistant", content }] : []), tell];
}

/** A chat completions answer in the shared shape. */
export function chatAnswer(
  body: unknown,
  provider: ProviderId,
  model: string,
): ModelAnswer {
  const { message, finish } = firstChoice(body);
  const usage =
    body && typeof body === "object"
      ? (body as { usage?: unknown }).usage
      : undefined;
  const used =
    usage && typeof usage === "object"
      ? (usage as {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          prompt_tokens_details?: { cached_tokens?: unknown } | null;
        })
      : null;
  return {
    refused:
      finish === "content_filter" ||
      (typeof message.refusal === "string" && message.refusal.trim() !== ""),
    cut: finish === "length",
    calls: chatCalls(message).map((call) => ({
      id: typeof call.id === "string" ? call.id : null,
      name: typeof call.function?.name === "string" ? call.function.name : null,
      arguments:
        typeof call.function?.arguments === "string"
          ? call.function.arguments
          : "",
    })),
    usage: used
      ? {
          provider,
          model,
          inputTokens: count(used.prompt_tokens),
          cachedTokens: count(used.prompt_tokens_details?.cached_tokens),
          cacheWriteTokens: null,
          outputTokens: count(used.completion_tokens),
        }
      : null,
    raw: message,
  };
}

/**
 * The chat completions interface. OpenAI gets a forced single tool call and
 * the large picture, as it was measured. The other providers get neither:
 * each takes these fields in its own way, and an answer with no call or with
 * several gets the repair of the planner.
 */
export class ChatTransport implements Transport {
  private current: string;
  /** The model to go to when OpenAI refuses the default one. Null when the person chose the model. */
  private fallback: string | null;
  /** The service refused the effort for this model: it is not sent again. */
  private noEffort = false;
  constructor(
    private readonly options: {
      provider: Provider;
      endpoint: string;
      key: string;
      model: string;
      fallback: string | null;
      effort: Effort | null;
      request: typeof fetch;
      now: () => number;
    },
  ) {
    this.current = options.model;
    this.fallback = options.fallback;
  }

  get model() {
    return this.current;
  }

  /** The body of one request. The rules and the functions come before the turn. */
  body(request: PlannerRequest): Record<string, unknown> {
    const openai = this.options.provider.id === "openai";
    const { user } = request;
    const effort = this.noEffort
      ? null
      : sentEffort(this.options.provider.id, this.current, this.options.effort);
    return {
      model: this.current,
      messages: [
        { role: "system", content: request.system },
        {
          role: "user",
          content:
            typeof user === "string"
              ? user
              : [
                  { type: "text", text: user.text },
                  ...(user.images ?? []).map((image) => ({
                    type: "image_url",
                    image_url: {
                      url: `data:image/jpeg;base64,${image}`,
                      ...(openai ? { detail: user.detail ?? "high" } : {}),
                    },
                  })),
                ],
        },
        ...(request.repairs ?? []).flatMap(({ answer, note }) =>
          chatRepair(answer.raw as ChatMessage, note),
        ),
      ],
      tools: request.tools,
      // One action for each turn: a function call, and only one.
      ...(openai
        ? {
            tool_choice: "required",
            parallel_tool_calls: request.pair === true,
          }
        : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
    };
  }

  /**
   * One request. When OpenAI answers that this key may not use the default
   * model (403) or that it does not know the model (404), the same request
   * goes out once more with the model before it, and the planner stays there.
   */
  async send(
    request: PlannerRequest,
    signal: AbortSignal,
  ): Promise<Attempt<ModelAnswer>> {
    return this.exchange(
      () => this.body(request),
      signal,
      (parsed) => chatAnswer(parsed, this.options.provider.id, this.current),
    );
  }

  /** The body of one turn of a conversation. The tool choice is the model's own. */
  conversationBody(request: ConversationRequest): Record<string, unknown> {
    const openai = this.options.provider.id === "openai";
    const effort = this.noEffort
      ? null
      : sentEffort(this.options.provider.id, this.current, this.options.effort);
    return {
      model: this.current,
      messages: [
        { role: "system", content: request.system },
        ...request.messages.map((message) =>
          message.role === "tool"
            ? {
                role: "tool",
                tool_call_id: message.callId,
                content: message.content,
              }
            : message.role === "assistant" && message.calls?.length
              ? {
                  role: "assistant",
                  content: message.content || null,
                  tool_calls: message.calls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }
              : { role: message.role, content: message.content },
        ),
      ],
      // A request with no functions carries no list: an empty one is refused.
      ...(request.tools.length
        ? {
            tools: request.tools,
            ...(openai ? { parallel_tool_calls: true } : {}),
          }
        : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
    };
  }

  /** One turn of a conversation, over the same route, key and fallbacks as the planner. */
  async converse(
    request: ConversationRequest,
    signal: AbortSignal,
  ): Promise<Attempt<ConversationAnswer>> {
    return this.exchange(
      () => this.conversationBody(request),
      signal,
      (parsed) => {
        const { message } = firstChoice(parsed);
        const { refused, cut, calls, usage } = chatAnswer(
          parsed,
          this.options.provider.id,
          this.current,
        );
        return {
          text: typeof message.content === "string" ? message.content : "",
          refused,
          cut,
          calls,
          usage,
        };
      },
    );
  }

  /**
   * One request and its answer. The body is made again for each try, so that
   * a fallback model or a dropped effort goes out in the next one.
   */
  private async exchange<T>(
    body: () => Record<string, unknown>,
    signal: AbortSignal,
    parse: (parsed: unknown) => T,
  ): Promise<Attempt<T>> {
    const post = () =>
      this.options.request(this.options.endpoint, {
        method: "POST",
        headers: {
          ...(this.options.key
            ? { authorization: `Bearer ${this.options.key}` }
            : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify(body()),
        signal,
      });
    let response = await post();
    // Some models refuse a reasoning effort with functions (gpt-5.4 answers
    // 400 to "low", measured 26 Nov 2026). The same request goes out once
    // more with no effort, and the planner sends none after that.
    if (
      response.status === 400 &&
      !this.noEffort &&
      sentEffort(this.options.provider.id, this.current, this.options.effort)
    ) {
      response.body?.cancel().catch(() => {});
      this.noEffort = true;
      response = await post();
    }
    if (
      this.fallback !== null &&
      (response.status === 403 || response.status === 404)
    ) {
      response.body?.cancel().catch(() => {});
      this.current = this.fallback;
      this.fallback = null;
      response = await post();
      if (
        response.status === 400 &&
        !this.noEffort &&
        sentEffort(this.options.provider.id, this.current, this.options.effort)
      ) {
        response.body?.cancel().catch(() => {});
        this.noEffort = true;
        response = await post();
      }
    }
    if (response.ok) {
      const text = await response.text();
      try {
        return { ok: true, value: parse(JSON.parse(text) as unknown) };
      } catch {
        // A cut or garbled answer: the next request can pass.
        return { ok: false, error: notJson() };
      }
    }
    return failure(response, this.options.now());
  }
}

const notJson = () =>
  new PlannerError(
    "transient",
    "The language model sent an answer that is not JSON.",
  );

/**
 * A failed answer over `fetch` as the trouble of the planner. The body of a
 * failure can echo the request: only its error code is read. `body` is the
 * text when it was read already.
 */
async function failure(
  response: Response,
  now: number,
  body?: string | null,
): Promise<Attempt<never>> {
  let code: string | null = null;
  try {
    code = errorCode(body ?? (await response.text()));
  } catch {
    // No body: the status says enough.
  }
  const wait = retryAfterMs(response.headers, now);
  return {
    ok: false,
    error: new PlannerError(
      statusTrouble(response.status, code),
      `The language model answered ${response.status}${code ? ` (${code})` : ""}.`,
    ),
    ...(wait !== undefined ? { retryAfterMs: wait } : {}),
  };
}

/** The parameter that a refused request names (`error.param`), only in a plain shape. */
const plainParam = /^[a-z][a-z0-9_.]{0,63}$/;
export function errorParam(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const error =
    parsed && typeof parsed === "object"
      ? (parsed as { error?: unknown }).error
      : undefined;
  const param =
    error && typeof error === "object"
      ? (error as { param?: unknown }).param
      : undefined;
  return typeof param === "string" && plainParam.test(param) ? param : null;
}

// The Responses transport of OpenAI, over `fetch`.

/** One item of a Responses answer. Nothing in it is trusted. */
interface ResponsesItem {
  type?: unknown;
  id?: unknown;
  call_id?: unknown;
  name?: unknown;
  arguments?: unknown;
  content?: unknown;
  encrypted_content?: unknown;
}
interface ResponsesPart {
  type?: unknown;
  text?: unknown;
  refusal?: unknown;
}

const outputItems = (body: unknown): ResponsesItem[] => {
  const output =
    body && typeof body === "object"
      ? (body as { output?: unknown }).output
      : undefined;
  return Array.isArray(output)
    ? output.filter(
        (item): item is ResponsesItem => !!item && typeof item === "object",
      )
    : [];
};
const itemParts = (item: ResponsesItem): ResponsesPart[] =>
  Array.isArray(item.content)
    ? item.content.filter(
        (part): part is ResponsesPart => !!part && typeof part === "object",
      )
    : [];
/** The words of one message item. */
const itemText = (item: ResponsesItem) =>
  itemParts(item)
    .flatMap((part) =>
      part.type === "output_text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("");

/** The words of the messages of a Responses answer. */
export function responsesText(body: unknown): string {
  return outputItems(body)
    .filter((item) => item.type === "message")
    .map(itemText)
    .filter((text) => text !== "")
    .join("\n")
    .trim();
}

/** A Responses answer in the shared shape. `raw` is its output items, for its repair. */
export function responsesAnswer(body: unknown, model: string): ModelAnswer {
  const items = outputItems(body);
  const top =
    body && typeof body === "object"
      ? (body as {
          status?: unknown;
          incomplete_details?: { reason?: unknown } | null;
          usage?: unknown;
        })
      : {};
  const reason =
    top.incomplete_details && typeof top.incomplete_details === "object"
      ? top.incomplete_details.reason
      : undefined;
  const incomplete = top.status === "incomplete";
  const used =
    top.usage && typeof top.usage === "object"
      ? (top.usage as {
          input_tokens?: unknown;
          output_tokens?: unknown;
          input_tokens_details?: { cached_tokens?: unknown } | null;
          output_tokens_details?: { reasoning_tokens?: unknown } | null;
        })
      : null;
  const reasoning = count(used?.output_tokens_details?.reasoning_tokens);
  return {
    refused:
      (incomplete && reason === "content_filter") ||
      items.some(
        (item) =>
          item.type === "message" &&
          itemParts(item).some(
            (part) =>
              part.type === "refusal" &&
              typeof part.refusal === "string" &&
              part.refusal.trim() !== "",
          ),
      ),
    cut: incomplete && reason === "max_output_tokens",
    calls: items
      .filter((item) => item.type === "function_call")
      .map((call) => ({
        id: typeof call.call_id === "string" ? call.call_id : null,
        name: typeof call.name === "string" ? call.name : null,
        arguments: typeof call.arguments === "string" ? call.arguments : "",
      })),
    usage: used
      ? {
          provider: "openai",
          model,
          inputTokens: count(used.input_tokens),
          cachedTokens: count(used.input_tokens_details?.cached_tokens),
          cacheWriteTokens: null,
          outputTokens: count(used.output_tokens),
          ...(reasoning !== null ? { reasoningTokens: reasoning } : {}),
        }
      : null,
    raw: items,
  };
}

/** The functions in the form of the Responses route. Not strict, as on chat completions: their schemas have optional fields. */
export function responsesTools(
  tools: readonly FunctionTool[],
): Record<string, unknown>[] {
  return tools.map(({ function: spec }) => ({
    type: "function",
    name: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    parameters: spec.parameters,
    strict: false,
  }));
}

/** A function call as an input item of its own, with no id of the service. */
const callItem = (call: { id: string; name: string; arguments: string }) => ({
  type: "function_call",
  call_id: call.id,
  name: call.name,
  arguments: call.arguments,
});

/**
 * The input items that go back after a Responses answer that cannot be
 * used. The answer goes back as the service sent it, its reasoning included,
 * when the service can read all of it again: every reasoning item has its
 * encrypted content, and every call has its id and its name. Each call then
 * gets a result that says what was wrong, and an answer with no call gets it
 * as words of the person. When a reasoning item cannot go back, the words
 * and the calls go back with no ids of the service, so that no item points
 * at one that is not there. A call with no id or no name cannot go back.
 */
function responsesRepair(
  raw: unknown,
  note: string,
): Record<string, unknown>[] {
  const items = Array.isArray(raw)
    ? raw.filter(
        (item): item is ResponsesItem => !!item && typeof item === "object",
      )
    : [];
  const calls = items.filter((item) => item.type === "function_call");
  const usable = calls.every(
    (call) =>
      typeof call.call_id === "string" &&
      call.call_id !== "" &&
      typeof call.name === "string" &&
      call.name !== "",
  );
  const results = usable
    ? calls.map((call) => ({
        type: "function_call_output",
        call_id: call.call_id,
        output: note,
      }))
    : [];
  const after = results.length ? results : [{ role: "user", content: note }];
  const whole =
    usable &&
    items.every(
      (item) =>
        item.type !== "reasoning" || typeof item.encrypted_content === "string",
    );
  if (whole)
    return [
      ...(items.filter((item) =>
        ["reasoning", "message", "function_call"].includes(String(item.type)),
      ) as Record<string, unknown>[]),
      ...after,
    ];
  return [
    ...items
      .filter((item) => item.type === "message")
      .map(itemText)
      .filter((text) => text.trim() !== "")
      .map((text) => ({ role: "assistant", content: text })),
    ...(usable
      ? calls.map((call) =>
          callItem({
            id: call.call_id as string,
            name: call.name as string,
            arguments: typeof call.arguments === "string" ? call.arguments : "",
          }),
        )
      : []),
    ...after,
  ];
}

/** Error codes of a Responses answer that failed after its start, that a later request can pass. */
const passingCodes = new Set(["server_error", "rate_limit_exceeded"]);

/**
 * The Responses route of OpenAI. It takes what chat completions takes, in
 * its own form: the rules as `instructions`, the turn and the repairs as
 * `input` items, the functions with their name at the top, and the effort as
 * `reasoning.effort`, always named on a model that reasons. The rules and
 * the functions come first, the same bytes in every step. Nothing is stored
 * on the service (`store: false`), so the reasoning of an answer comes back
 * encrypted, for its repair. A forced call is `tool_choice: "required"`; when
 * the service refuses it, the tool choice is the model's own from then on,
 * and the repair of the planner handles an answer with no call.
 */
export class ResponsesTransport implements Transport {
  private current: string;
  /** The model to go to when the service refuses the default one. Null when the person chose the model. */
  private fallback: string | null;
  /** The service refused the effort: it is not sent again. */
  private noEffort = false;
  /** The service refused a forced call: the choice is `auto` from then on. */
  private noRequired = false;
  /** The default model fell back after 403/404: do not force a default effort on it. */
  private fellBack = false;
  constructor(
    private readonly options: {
      key: string;
      model: string;
      fallback: string | null;
      effort: Effort | null;
      request: typeof fetch;
      now: () => number;
    },
  ) {
    this.current = options.model;
    this.fallback = options.fallback;
  }

  get model() {
    return this.current;
  }

  private effort(fallback: Effort) {
    if (this.noEffort) return null;
    if (this.fellBack && !this.options.effort) return null;
    return responsesEffort(this.current, this.options.effort, fallback);
  }

  /** The body of one request. The rules and the functions come before the turn. */
  body(request: PlannerRequest): Record<string, unknown> {
    const { user } = request;
    const effort = this.effort(request.defaultEffort ?? defaultEffort);
    const hasTools = request.tools.length > 0;
    return {
      model: this.current,
      instructions: request.system,
      ...(hasTools ? { tools: responsesTools(request.tools) } : {}),
      input: [
        {
          role: "user",
          content:
            typeof user === "string"
              ? user
              : [
                  { type: "input_text", text: user.text },
                  ...(user.images ?? []).map((image) => ({
                    type: "input_image",
                    image_url: `data:image/jpeg;base64,${image}`,
                    detail: user.detail ?? "high",
                  })),
                ],
        },
        ...(request.repairs ?? []).flatMap(({ answer, note }) =>
          responsesRepair(answer.raw, note),
        ),
      ],
      // One action for each turn: a function call, and only one.
      ...(hasTools
        ? {
            tool_choice: this.noRequired ? "auto" : "required",
            parallel_tool_calls: request.pair === true,
          }
        : {}),
      ...(effort
        ? {
            reasoning: { effort },
            include: ["reasoning.encrypted_content"],
          }
        : {}),
      store: false,
    };
  }

  async send(
    request: PlannerRequest,
    signal: AbortSignal,
  ): Promise<Attempt<ModelAnswer>> {
    return this.exchange(
      () => this.body(request),
      signal,
      (parsed) => responsesAnswer(parsed, this.current),
    );
  }

  /** The body of one turn of a conversation. The tool choice is the model's own. */
  conversationBody(request: ConversationRequest): Record<string, unknown> {
    const effort = this.effort("medium");
    return {
      model: this.current,
      instructions: request.system,
      // A request with no functions carries no list: an empty one is refused.
      ...(request.tools.length
        ? { tools: responsesTools(request.tools), parallel_tool_calls: true }
        : {}),
      input: request.messages.flatMap((message): Record<string, unknown>[] =>
        message.role === "tool"
          ? [
              {
                type: "function_call_output",
                call_id: message.callId,
                output: message.content,
              },
            ]
          : message.role === "assistant"
            ? [
                ...(message.content.trim()
                  ? [{ role: "assistant", content: message.content }]
                  : []),
                ...(message.calls ?? []).map(callItem),
              ]
            : [{ role: "user", content: message.content }],
      ),
      ...(effort ? { reasoning: { effort } } : {}),
      store: false,
    };
  }

  async converse(
    request: ConversationRequest,
    signal: AbortSignal,
  ): Promise<Attempt<ConversationAnswer>> {
    return this.exchange(
      () => this.conversationBody(request),
      signal,
      (parsed) => {
        const { refused, cut, calls, usage } = responsesAnswer(
          parsed,
          this.current,
        );
        return { text: responsesText(parsed), refused, cut, calls, usage };
      },
    );
  }

  /**
   * One request and its answer. The body is made again for each try. A 400
   * that names `tool_choice` turns the forced call off; any other 400 to a
   * request with an effort drops the effort, as on chat completions. Each
   * goes out once more, and stays so. A 403 or 404 to the default model goes
   * to the model before it, once.
   */
  private async exchange<T>(
    make: () => Record<string, unknown>,
    signal: AbortSignal,
    parse: (parsed: unknown) => T,
  ): Promise<Attempt<T>> {
    let body: Record<string, unknown> = {};
    const post = () => {
      body = make();
      return this.options.request(responsesEndpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    };
    let response = await post();
    let read: string | null = null;
    const retryBadRequest = async () => {
      while (response.status === 400) {
        read = await response.text().catch(() => "");
        const param = errorParam(read);
        if (
          param === "tool_choice" &&
          body.tool_choice === "required" &&
          !this.noRequired
        )
          this.noRequired = true;
        else if (
          "reasoning" in body &&
          !this.noEffort &&
          (param === null ||
            param.startsWith("reasoning") ||
            param === "effort")
        )
          this.noEffort = true;
        else break;
        read = null;
        response = await post();
      }
    };
    await retryBadRequest();
    if (
      this.fallback !== null &&
      (response.status === 403 || response.status === 404)
    ) {
      response.body?.cancel().catch(() => {});
      this.current = this.fallback;
      this.fallback = null;
      this.fellBack = true;
      response = await post();
      await retryBadRequest();
    }
    if (!response.ok) return failure(response, this.options.now(), read);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text()) as unknown;
    } catch {
      return { ok: false, error: notJson() };
    }
    const top =
      parsed && typeof parsed === "object"
        ? (parsed as { status?: unknown; error?: { code?: unknown } | null })
        : {};
    if (top.status === "failed") {
      const code =
        top.error &&
        typeof top.error === "object" &&
        typeof top.error.code === "string" &&
        plainParam.test(top.error.code)
          ? top.error.code
          : null;
      return {
        ok: false,
        error: new PlannerError(
          code === null || passingCodes.has(code) ? "transient" : "other",
          `The language model answered failed${code ? ` (${code})` : ""}.`,
        ),
      };
    }
    return { ok: true, value: parse(parsed) };
  }
}

// The Messages transport of Anthropic, through its official library.

type MessageParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentParam = Anthropic.Beta.BetaContentBlockParam;
type Tool = Anthropic.Beta.BetaTool;

/** The service limits for tools with `strict: true` in one request. */
export const strictLimits = { tools: 20, optional: 24, unions: 16 };
/** Keywords that a strict schema may not have. The worker checks every action in code anyway. */
const unsupported = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "propertyNames",
  "not",
]);
const formats = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** A schema as a strict tool takes it: no numeric or length limits, every object closed. */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(schema)) {
    if (unsupported.has(name)) continue;
    if (name === "format" && !formats.has(String(value))) continue;
    if (name === "minItems" && value !== 0 && value !== 1) continue;
    if (name === "properties" && value && typeof value === "object")
      out[name] = Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, strictSchema(inner)]),
      );
    else if (
      ["items", "anyOf", "allOf", "oneOf", "$defs", "definitions"].includes(
        name,
      )
    )
      out[name === "oneOf" ? "anyOf" : name] =
        name === "$defs" || name === "definitions"
          ? Object.fromEntries(
              Object.entries(value as object).map(([key, inner]) => [
                key,
                strictSchema(inner),
              ]),
            )
          : strictSchema(value);
    else out[name] = value;
  }
  if (out.type === "object" || out.properties !== undefined)
    out.additionalProperties = false;
  return out;
}

/** The optional parameters and the parameters with a union type of a schema, as the service counts them. */
function complexity(schema: unknown): { optional: number; unions: number } {
  let optional = 0;
  let unions = 0;
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const { properties, required } = node as {
      properties?: Record<string, unknown>;
      required?: unknown;
    };
    if (properties && typeof properties === "object") {
      const needed = new Set(Array.isArray(required) ? required : []);
      for (const [key, inner] of Object.entries(properties)) {
        if (!needed.has(key)) optional++;
        if (
          inner &&
          typeof inner === "object" &&
          ((inner as { anyOf?: unknown }).anyOf !== undefined ||
            Array.isArray((inner as { type?: unknown }).type))
        )
          unions++;
      }
    }
    for (const [key, value] of Object.entries(node))
      if (key !== "properties") walk(value);
    if (properties) Object.values(properties).forEach(walk);
  };
  walk(schema);
  return { optional, unions };
}

const convertedStrict = new WeakMap<readonly FunctionTool[], Tool[]>();
const convertedPlain = new WeakMap<readonly FunctionTool[], Tool[]>();
/**
 * The functions as Anthropic tools. On a model that takes strict tools, each
 * one is strict while the request stays inside the limits of the service, in
 * the fixed order of the list, so the same list always gives the same bytes.
 */
export function messagesTools(
  tools: readonly FunctionTool[],
  strict: boolean,
): Tool[] {
  const cache = strict ? convertedStrict : convertedPlain;
  const known = cache.get(tools);
  if (known) return known;
  let strictTools = 0;
  let optional = 0;
  let unions = 0;
  const out = tools.map(({ function: spec }): Tool => {
    const base = {
      name: spec.name,
      ...(spec.description ? { description: spec.description } : {}),
    };
    if (strict) {
      const schema = strictSchema(spec.parameters) as Tool["input_schema"];
      const cost = complexity(schema);
      if (
        strictTools + 1 <= strictLimits.tools &&
        optional + cost.optional <= strictLimits.optional &&
        unions + cost.unions <= strictLimits.unions
      ) {
        strictTools++;
        optional += cost.optional;
        unions += cost.unions;
        return { ...base, strict: true, input_schema: schema };
      }
    }
    return { ...base, input_schema: spec.parameters as Tool["input_schema"] };
  });
  cache.set(tools, out);
  return out;
}

/** A Messages answer in the shared shape. */
export function messagesAnswer(message: Message, model: string): ModelAnswer {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const usage = message.usage;
  const read = count(usage?.cache_read_input_tokens);
  const written = count(usage?.cache_creation_input_tokens);
  const fresh = count(usage?.input_tokens);
  return {
    refused: message.stop_reason === "refusal",
    cut: message.stop_reason === "max_tokens",
    calls: blocks.flatMap((block) =>
      block.type === "tool_use"
        ? [
            {
              id: typeof block.id === "string" ? block.id : null,
              name: typeof block.name === "string" ? block.name : null,
              arguments: JSON.stringify(block.input ?? {}),
            },
          ]
        : [],
    ),
    usage: usage
      ? {
          provider: "anthropic",
          model,
          inputTokens:
            fresh === null ? null : fresh + (read ?? 0) + (written ?? 0),
          cachedTokens: read,
          cacheWriteTokens: written,
          outputTokens: count(usage.output_tokens),
        }
      : null,
    raw: message,
  };
}

/** A plain error code of the service: a key never has this shape. */
const serviceCode = /^[a-z][a-z0-9_]{0,63}$/;
const neverAborted = new AbortController().signal;

/** A failure of the library as the trouble of the planner. Its own message is never used: it can quote the service. */
export function messagesFailure(
  error: unknown,
  now: number,
): { error: PlannerError; retryAfterMs?: number } {
  if (error instanceof Anthropic.APIConnectionTimeoutError)
    return {
      error: new PlannerError(
        "transient",
        "The language model did not answer in time.",
      ),
    };
  if (error instanceof Anthropic.APIConnectionError) {
    const mapped = thrownTrouble(error.cause, neverAborted);
    return {
      error:
        mapped.trouble === "transient"
          ? mapped
          : new PlannerError(
              "transient",
              "The language model could not be reached.",
            ),
    };
  }
  if (error instanceof Anthropic.APIError && typeof error.status === "number") {
    const code =
      [error.errorCode, error.type].find(
        (value): value is string =>
          typeof value === "string" && serviceCode.test(value),
      ) ?? null;
    const trouble =
      error.status === 529
        ? "transient"
        : error.type === "billing_error" ||
            error.errorCode === "enforced_spend_limit_reached"
          ? "quota"
          : statusTrouble(error.status, code);
    const wait = error.headers ? retryAfterMs(error.headers, now) : undefined;
    return {
      error: new PlannerError(
        trouble,
        `The language model answered ${error.status}${code ? ` (${code})` : ""}.`,
      ),
      ...(wait !== undefined ? { retryAfterMs: wait } : {}),
    };
  }
  if (error instanceof SyntaxError)
    return {
      error: new PlannerError(
        "transient",
        "The language model sent an answer that is not JSON.",
      ),
    };
  return { error: thrownTrouble(error, neverAborted) };
}

/** The largest answer of one step: room for the thinking of the model and one call. */
export const messagesMaxTokens = 16_000;

/**
 * The Messages interface of Anthropic. The rules carry the one cache marker,
 * so the functions and the rules are read from the cache after the first
 * step. The tool choice is `auto`: current models refuse a forced one, and
 * the repair of the planner handles an answer with no call. No temperature
 * and no thinking setting go out; the effort sets the depth. The library
 * never retries.
 */
export class MessagesTransport implements Transport {
  private readonly client: Anthropic;
  constructor(
    private readonly options: {
      key: string;
      model: string;
      effort: Effort | null;
      speed: Speed | null;
      timeoutMs: number;
      now: () => number;
      /** The network call of the library. Tests replace it. */
      request?: typeof fetch | undefined;
    },
  ) {
    this.client = new Anthropic({
      apiKey: options.key,
      // Named here, so that no variable of the environment sends the key elsewhere.
      baseURL: "https://api.anthropic.com",
      webhookKey: null,
      maxRetries: 0,
      timeout: options.timeoutMs,
      // Nothing of a request goes to a log or a trace: it holds the screen.
      logLevel: "off",
      openTelemetry: false,
      ...(options.request ? { fetch: options.request } : {}),
    });
  }

  get model() {
    return this.options.model;
  }

  params(request: PlannerRequest): MessageParams {
    const { model } = this.options;
    const { user } = request;
    const turn: ContentParam[] =
      typeof user === "string"
        ? [{ type: "text", text: user }]
        : [
            // Each picture as an image block, in its order, before the text.
            ...(user.images ?? []).map((data) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: "image/jpeg" as const,
                data,
              },
            })),
            { type: "text", text: user.text },
          ];
    const messages: MessageParam[] = [{ role: "user", content: turn }];
    for (const { answer, note } of request.repairs ?? []) {
      const said = Array.isArray((answer.raw as Message | null)?.content)
        ? (answer.raw as Message).content
        : [];
      // The answer goes back unchanged, its thinking included, as the service asks.
      if (said.length) messages.push({ role: "assistant", content: said });
      messages.push({
        role: "user",
        content: [
          ...said.flatMap((block): ContentParam[] =>
            block.type === "tool_use"
              ? [
                  {
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: "Not run.",
                  },
                ]
              : [],
          ),
          { type: "text", text: note },
        ],
      });
    }
    const effort = sentEffort("anthropic", model, this.options.effort);
    // Do not set strict: true on Anthropic tool lists: full planner tool sets
    // exceed Anthropic's server-side compiled grammar limit (400) and even small
    // strict sets add multi-second cold grammar compilation latency. The worker
    // validates every tool call strictly in code and repairs malformed calls.
    return {
      model,
      max_tokens: messagesMaxTokens,
      tools: messagesTools(request.tools, false),
      system: [
        {
          type: "text",
          text: request.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      tool_choice: {
        type: "auto",
        disable_parallel_tool_use: request.pair !== true,
      },
      messages,
      ...(effort ? { output_config: { effort } } : {}),
      ...(sentFast("anthropic", model, this.options.speed)
        ? { speed: "fast" as const }
        : {}),
      ...(refusalFallback("anthropic", model)
        ? {
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default" as const,
          }
        : {}),
    };
  }

  async send(
    request: PlannerRequest,
    signal: AbortSignal,
  ): Promise<Attempt<ModelAnswer>> {
    let message: Message;
    try {
      message = await this.client.beta.messages.create(this.params(request), {
        signal,
      });
    } catch (error) {
      // An abort is the caller's, or the time of one request: the retry layer judges it.
      if (signal.aborted) throw error;
      return { ok: false, ...messagesFailure(error, this.options.now()) };
    }
    return { ok: true, value: messagesAnswer(message, this.options.model) };
  }

  /**
   * The parameters of one turn of a conversation. Tool results go back in a
   * user message right after the answer that called them, and messages of one
   * role in a row join into one, as the service asks.
   */
  conversationParams(request: ConversationRequest): MessageParams {
    const { model } = this.options;
    const messages: MessageParam[] = [];
    const add = (role: "user" | "assistant", blocks: ContentParam[]) => {
      if (!blocks.length) return;
      const last = messages.at(-1);
      if (last?.role === role && Array.isArray(last.content))
        last.content.push(...blocks);
      else messages.push({ role, content: blocks });
    };
    for (const message of request.messages) {
      if (message.role === "tool")
        add("user", [
          {
            type: "tool_result",
            tool_use_id: message.callId,
            content: message.content,
          },
        ]);
      else if (message.role === "user")
        add("user", [{ type: "text", text: message.content || "(empty)" }]);
      else
        add("assistant", [
          ...(message.content.trim()
            ? [{ type: "text" as const, text: message.content }]
            : []),
          ...(message.calls ?? []).map((call) => {
            let input: unknown = {};
            try {
              input = JSON.parse(call.arguments || "{}");
            } catch {
              input = {};
            }
            return {
              type: "tool_use" as const,
              id: call.id,
              name: call.name,
              input:
                input && typeof input === "object" && !Array.isArray(input)
                  ? (input as Record<string, unknown>)
                  : {},
            };
          }),
        ]);
    }
    const effort = sentEffort("anthropic", model, this.options.effort);
    return {
      model,
      max_tokens: conversationMaxTokens,
      ...(request.tools.length
        ? {
            tools: messagesTools(request.tools, false),
            tool_choice: { type: "auto" as const },
          }
        : {}),
      system: [
        {
          type: "text",
          text: request.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
      ...(effort ? { output_config: { effort } } : {}),
      ...(sentFast("anthropic", model, this.options.speed)
        ? { speed: "fast" as const }
        : {}),
    };
  }

  async converse(
    request: ConversationRequest,
    signal: AbortSignal,
  ): Promise<Attempt<ConversationAnswer>> {
    let message: Message;
    try {
      message = await this.client.beta.messages.create(
        this.conversationParams(request),
        { signal },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      return { ok: false, ...messagesFailure(error, this.options.now()) };
    }
    const { refused, cut, calls, usage } = messagesAnswer(
      message,
      this.options.model,
    );
    const blocks = Array.isArray(message.content) ? message.content : [];
    return {
      ok: true,
      value: {
        text: blocks
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n")
          .trim(),
        refused,
        cut,
        calls,
        usage,
      },
    };
  }
}

/** The largest answer of one chat turn: a few sentences or a few calls. */
export const conversationMaxTokens = 4_096;
