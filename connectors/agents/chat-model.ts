/**
 * The language model of the chat agent.
 *
 * The chat keeps its own model setting, `CLAWDTIME_SUPERVISOR_MODEL`: a bare
 * model of OpenAI (`gpt-5.4` when it is not set), or `provider/model` for
 * any provider of the computer engine. The key comes from the same places as
 * the planner's: the environment first, then the key store of the state
 * folder. The request goes over the providers' own transports
 * (`connectors/computer/providers.ts`): the newest models of OpenAI go to its
 * Responses route, and `CLAWDTIME_OPENAI_API` can choose the route for any
 * model of OpenAI. Each has the retry layer of `model-call.ts`: a request of
 * the model changes nothing on the Mac, so it is the one thing that may be
 * asked again.
 *
 * No message from here holds the key, the request or the body of an answer.
 */
import {
  callWithRetries,
  CircuitBreaker,
  defaultRetryPolicy,
  realClock,
  type Clock,
  type RetryPolicy,
} from "../computer/model-call.js";
import {
  ChatTransport,
  chatEndpoint,
  efforts,
  fallbackComputerModel,
  MessagesTransport,
  modelName,
  openaiApiSetting,
  openaiWire,
  parseModel,
  ResponsesTransport,
  type ConversationMessage,
  type Effort,
  type FunctionTool,
  type Transport,
} from "../computer/providers.js";
import { findKey, storedKeys } from "../computer/keys.js";
import type { ModelClient } from "./brain.js";
import type { LoopCall, LoopMessage, LoopModel } from "./agent-loop.js";
import { looksSecret } from "./memory.js";

/**
 * The OpenAI model that the chat agent uses when `CLAWDTIME_SUPERVISOR_MODEL`
 * is not set. A chat turn chooses a tool and says one or two sentences, and
 * the owner waits for every one. `gpt-5.4` answers a turn in a median of
 * 1.06 s, where `gpt-6.2-astra`, the planner's model, takes 1.98 s, and the
 * chat eval gives it the same first actions (55 of 55 in four runs; 54 to 55
 * of 55 for the planner's model). Measured 28 Nov 2026: run `npm run
 * eval:chat` before this line changes.
 */
export const defaultChatAgentModel = fallbackComputerModel;

/** A chat turn waits for its answer this long, with its retries. */
export const chatRetryPolicy: RetryPolicy = {
  ...defaultRetryPolicy,
  attempts: 3,
  attemptTimeoutMs: 30_000,
  budgetMs: 45_000,
};

export type ChatModelSetup =
  { ok: true; model: LoopModel; name: string } | { ok: false; problem: string };

/** The messages of the loop in the shape of the transports. */
export const toConversation = (
  messages: readonly LoopMessage[],
): ConversationMessage[] =>
  messages.map((message) =>
    message.role === "tool"
      ? { role: "tool", callId: message.callId, content: message.content }
      : message.role === "assistant"
        ? {
            role: "assistant",
            content: message.content,
            ...(message.calls?.length ? { calls: message.calls } : {}),
          }
        : { role: "user", content: message.content },
  );

/** A model of the loop over one transport. */
export function transportModel(
  transport: Transport,
  options: {
    policy?: RetryPolicy;
    clock?: Clock;
  } = {},
): LoopModel {
  const policy = options.policy ?? chatRetryPolicy;
  const clock = options.clock ?? realClock;
  const breaker = new CircuitBreaker(policy, () => clock.now());
  return {
    async next(request, signal) {
      if (!transport.converse)
        throw new Error("This transport cannot hold a conversation.");
      const tools: FunctionTool[] = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      const answer = await callWithRetries(
        (attempt) =>
          transport.converse!(
            {
              system: request.system,
              tools,
              messages: toConversation(request.messages),
            },
            attempt,
          ),
        {
          signal,
          deadline: clock.now() + policy.budgetMs,
          policy,
          clock,
          breaker,
        },
      );
      if (answer.refused && !answer.calls.length)
        return {
          text: answer.text || "I can't help with that one.",
          calls: [],
        };
      return {
        text: answer.text,
        calls: answer.calls.flatMap((call, index): LoopCall[] =>
          call.name
            ? [
                {
                  id: call.id ?? `call_${index}`,
                  name: call.name,
                  arguments: call.arguments,
                },
              ]
            : [],
        ),
      };
    },
  };
}

/**
 * The chat's model from this Mac's settings, over the providers layer. A
 * problem names what to set, never the setting itself: a key can be pasted
 * there by mistake.
 */
export function chatModelSetup(
  env: Record<string, string | undefined>,
  root?: string,
  request: typeof fetch = fetch,
): ChatModelSetup {
  const explicit = env.CLAWDTIME_SUPERVISOR_MODEL?.trim();
  const setting = explicit || defaultChatAgentModel;
  const chosen = Boolean(explicit);
  const parsed = parseModel(setting, looksSecret);
  if (!parsed.ok)
    return {
      ok: false,
      problem: `CLAWDTIME_SUPERVISOR_MODEL cannot be used: ${parsed.problem}`,
    };
  const { provider, model } = parsed;
  let stored: Record<string, string> = {};
  try {
    stored = root ? (storedKeys(root).keys as Record<string, string>) : {};
  } catch {
    stored = {};
  }
  const found = findKey(provider, env, stored);
  if (!found && provider.id !== "custom")
    return {
      ok: false,
      problem: `The chat model is ${modelName(provider, model)}, but no key for ${provider.name} is set. Put ${provider.keys.join(" or ")} in the environment, or run: clawdtime keys set ${provider.id}`,
    };
  const effortText = env.CLAWDTIME_SUPERVISOR_REASONING?.trim().toLowerCase();
  const effort = efforts.includes(effortText as Effort)
    ? (effortText as Effort)
    : null;
  const api = openaiApiSetting(env.CLAWDTIME_OPENAI_API);
  if (api === "invalid")
    return {
      ok: false,
      problem:
        "CLAWDTIME_OPENAI_API is not responses or chat. Fix it or remove it.",
    };
  const now = () => Date.now();
  // A default that is not the fallback goes to it, once, when a key may not use it.
  const fallback =
    provider.id === "openai" && !chosen && model !== fallbackComputerModel
      ? fallbackComputerModel
      : null;
  let transport: Transport;
  const wire = openaiWire(provider, model, api, effort);
  if (wire === "messages")
    transport = new MessagesTransport({
      key: found!.key,
      model,
      effort,
      speed: null,
      timeoutMs: chatRetryPolicy.attemptTimeoutMs,
      now,
      ...(request !== fetch ? { request } : {}),
    });
  else if (wire === "responses")
    // The newest models of OpenAI, or CLAWDTIME_OPENAI_API=responses. With no
    // effort set, a turn of the chat gets `medium` (and falls back cleanly to
    // `gpt-5.4` when the model was not explicitly chosen).
    transport = new ResponsesTransport({
      key: found!.key,
      model,
      fallback,
      effort,
      request,
      now,
    });
  else {
    const endpoint =
      provider.id === "custom"
        ? chatEndpoint(env.CLAWDTIME_CUSTOM_BASE_URL ?? "")
        : provider.endpoint;
    if (!endpoint)
      return {
        ok: false,
        problem:
          "The custom service needs its base address: set CLAWDTIME_CUSTOM_BASE_URL.",
      };
    transport = new ChatTransport({
      provider,
      endpoint,
      key: found?.key ?? "",
      model,
      fallback,
      effort,
      request,
      now,
    });
  }
  return {
    ok: true,
    model: transportModel(transport),
    name: modelName(provider, model),
  };
}

/**
 * A model of the loop over the chat's older client (`ModelClient` of
 * `brain.ts`), which the services and the tests already pass in. It has no
 * abort of its own: the loop leaves a request at Stop.
 */
export function clientModel(client: ModelClient): LoopModel {
  return {
    async next(request) {
      const answer = await client.complete({
        system: request.system,
        messages: request.messages.map((message) =>
          message.role === "tool"
            ? {
                role: "tool" as const,
                toolCallId: message.callId,
                content: message.content,
              }
            : message.role === "assistant"
              ? {
                  role: "assistant" as const,
                  content: message.content,
                  ...(message.calls?.length
                    ? { toolCalls: message.calls }
                    : {}),
                }
              : { role: "user" as const, content: message.content },
        ),
        tools: request.tools,
      });
      return { text: answer.text, calls: answer.toolCalls };
    },
  };
}
