import { describe, expect, it } from "vitest";
import {
  chatModelSetup,
  defaultChatAgentModel,
  toConversation,
} from "../connectors/agents/chat-model.js";
import type { LoopMessage } from "../connectors/agents/agent-loop.js";
import {
  ChatTransport,
  MessagesTransport,
  providerById,
  ResponsesTransport,
} from "../connectors/computer/providers.js";

const key = "fixture-chat-key-0123456789abcdef";

/** A network that keeps each request and answers with the given bodies, in turn. */
function network(...bodies: unknown[]) {
  const sent: { url: string; headers: Headers; body: Record<string, any> }[] =
    [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: new Headers(init?.headers as HeadersInit),
      body: JSON.parse(String(init?.body)),
    });
    const body = bodies.length > 1 ? bodies.shift() : bodies[0];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { sent, request };
}

const conversation: LoopMessage[] = [
  { role: "user", content: "search Aero 7 headphones" },
  {
    role: "assistant",
    content: "",
    calls: [
      {
        id: "call_a",
        name: "computer_do",
        arguments: '{"goal":"search Aero 7 headphones"}',
      },
    ],
  },
  {
    role: "tool",
    callId: "call_a",
    name: "computer_do",
    content: "Started on the screen.",
  },
  { role: "user", content: "and check the price" },
];
const tools = [
  {
    type: "function" as const,
    function: {
      name: "computer_do",
      description: "Start a task.",
      parameters: {
        type: "object",
        properties: { goal: { type: "string" } },
        required: ["goal"],
      },
    },
  },
];

describe("a conversation over the chat completions transport", () => {
  it("sends the whole conversation with the model's own tool choice, and reads words and calls", async () => {
    const net = network({
      choices: [
        {
          message: {
            content: "Checking the price too.",
            tool_calls: [
              {
                id: "call_b",
                function: {
                  name: "computer_steer",
                  arguments: '{"words":"check the price"}',
                },
              },
              {
                id: "call_c",
                function: { name: "computer_status", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const transport = new ChatTransport({
      provider: providerById("openai")!,
      endpoint: "https://api.openai.com/v1/chat/completions",
      key,
      model: "gpt-4.1-mini",
      fallback: null,
      effort: null,
      request: net.request,
      now: () => 0,
    });
    const answer = await transport.converse(
      { system: "Rules.", tools, messages: toConversation(conversation) },
      new AbortController().signal,
    );
    expect(answer).toMatchObject({
      ok: true,
      value: {
        text: "Checking the price too.",
        calls: [
          {
            id: "call_b",
            name: "computer_steer",
            arguments: '{"words":"check the price"}',
          },
          { id: "call_c", name: "computer_status", arguments: "{}" },
        ],
        refused: false,
        cut: false,
      },
    });
    const body = net.sent[0]!.body;
    expect(body.model).toBe("gpt-4.1-mini");
    expect(body.tool_choice).toBeUndefined();
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "Rules." },
      { role: "user", content: "search Aero 7 headphones" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_a",
            type: "function",
            function: {
              name: "computer_do",
              arguments: '{"goal":"search Aero 7 headphones"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_a",
        content: "Started on the screen.",
      },
      { role: "user", content: "and check the price" },
    ]);
    expect(net.sent[0]!.headers.get("authorization")).toBe(`Bearer ${key}`);
  });

  it("carries no tool list when the turn offers none", async () => {
    const net = network({
      choices: [{ message: { content: "Okay." }, finish_reason: "stop" }],
    });
    const transport = new ChatTransport({
      provider: providerById("groq")!,
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      key,
      model: "some-model",
      fallback: null,
      effort: null,
      request: net.request,
      now: () => 0,
    });
    await transport.converse(
      { system: "R", tools: [], messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    );
    expect(net.sent[0]!.body).not.toHaveProperty("tools");
    expect(net.sent[0]!.body).not.toHaveProperty("parallel_tool_calls");
  });
});

describe("a conversation over the Messages transport", () => {
  it("puts tool results in a user message after the answer that called them, and joins one role in a row", () => {
    const transport = new MessagesTransport({
      key,
      model: "claude-opus-5-5",
      effort: null,
      speed: null,
      timeoutMs: 1000,
      now: () => 0,
    });
    const params = transport.conversationParams({
      system: "Rules.",
      tools,
      messages: toConversation(conversation),
    });
    expect(params.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "search Aero 7 headphones" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_a",
            name: "computer_do",
            input: { goal: "search Aero 7 headphones" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_a",
            content: "Started on the screen.",
          },
          { type: "text", text: "and check the price" },
        ],
      },
    ]);
    expect(params.tool_choice).toEqual({ type: "auto" });
    expect(params.system).toEqual([
      { type: "text", text: "Rules.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("reads the words and the calls of an answer", async () => {
    const net = network({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [
        { type: "text", text: "On it." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "computer_do",
          input: { goal: "search flights" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const transport = new MessagesTransport({
      key,
      model: "claude-opus-5-5",
      effort: null,
      speed: null,
      timeoutMs: 1000,
      now: () => 0,
      request: net.request,
    });
    const answer = await transport.converse(
      {
        system: "R",
        tools,
        messages: [{ role: "user", content: "search flights" }],
      },
      new AbortController().signal,
    );
    expect(answer).toMatchObject({
      ok: true,
      value: {
        text: "On it.",
        calls: [
          {
            id: "toolu_1",
            name: "computer_do",
            arguments: '{"goal":"search flights"}',
          },
        ],
      },
    });
  });
});

describe("a conversation over the Responses transport", () => {
  it("sends the rules as instructions, the calls and their results as input items, medium effort, and reads words and calls", async () => {
    const net = network({
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_1", summary: [] },
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "Checking the price too." }],
        },
        {
          type: "function_call",
          id: "fc_b",
          call_id: "call_b",
          name: "computer_steer",
          arguments: '{"words":"check the price"}',
        },
      ],
      usage: {
        input_tokens: 900,
        input_tokens_details: { cached_tokens: 512 },
        output_tokens: 40,
      },
    });
    const transport = new ResponsesTransport({
      key,
      model: "gpt-6.2-sol",
      fallback: null,
      effort: null,
      request: net.request,
      now: () => 0,
    });
    const answer = await transport.converse(
      { system: "Rules.", tools, messages: toConversation(conversation) },
      new AbortController().signal,
    );
    expect(answer).toEqual({
      ok: true,
      value: {
        text: "Checking the price too.",
        calls: [
          {
            id: "call_b",
            name: "computer_steer",
            arguments: '{"words":"check the price"}',
          },
        ],
        refused: false,
        cut: false,
        usage: {
          provider: "openai",
          model: "gpt-6.2-sol",
          inputTokens: 900,
          cachedTokens: 512,
          cacheWriteTokens: null,
          outputTokens: 40,
        },
      },
    });
    const sent = net.sent[0]!;
    expect(sent.url).toBe("https://api.openai.com/v1/responses");
    expect(sent.body).toEqual({
      model: "gpt-6.2-sol",
      instructions: "Rules.",
      tools: [
        {
          type: "function",
          name: "computer_do",
          description: "Start a task.",
          parameters: tools[0]!.function.parameters,
          strict: false,
        },
      ],
      parallel_tool_calls: true,
      input: [
        { role: "user", content: "search Aero 7 headphones" },
        {
          type: "function_call",
          call_id: "call_a",
          name: "computer_do",
          arguments: '{"goal":"search Aero 7 headphones"}',
        },
        {
          type: "function_call_output",
          call_id: "call_a",
          output: "Started on the screen.",
        },
        { role: "user", content: "and check the price" },
      ],
      reasoning: { effort: "medium" },
      store: false,
    });
    // No forced choice in a conversation, and no tool list when none is offered.
    await transport.converse(
      { system: "R", tools: [], messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    );
    expect(net.sent[1]!.body).not.toHaveProperty("tools");
    expect(net.sent[1]!.body).not.toHaveProperty("tool_choice");
    expect(net.sent[1]!.body).not.toHaveProperty("parallel_tool_calls");
  });
});

describe("the chat's model setting", () => {
  it("sends the newest models of OpenAI to the Responses route, and CLAWDTIME_OPENAI_API chooses the route for any", async () => {
    const reply = {
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hi." }],
        },
      ],
    };
    const net = network(reply);
    const setup = chatModelSetup(
      {
        CLAWDTIME_SUPERVISOR_MODEL: "gpt-6.2-sol",
        CLAWDTIME_SUPERVISOR_REASONING: "high",
        OPENAI_API_KEY: key,
      },
      undefined,
      net.request,
    );
    expect(setup).toMatchObject({ ok: true, name: "gpt-6.2-sol" });
    if (!setup.ok) return;
    expect(
      await setup.model.next(
        { system: "R", messages: [{ role: "user", content: "hi" }], tools: [] },
        new AbortController().signal,
      ),
    ).toEqual({ text: "Hi.", calls: [] });
    expect(net.sent[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(net.sent[0]!.body.reasoning).toEqual({ effort: "high" });
    const chat = network({
      choices: [{ message: { content: "Hi." }, finish_reason: "stop" }],
    });
    const back = chatModelSetup(
      {
        CLAWDTIME_SUPERVISOR_MODEL: "gpt-6.2-sol",
        CLAWDTIME_OPENAI_API: "chat",
        OPENAI_API_KEY: key,
      },
      undefined,
      chat.request,
    );
    if (!back.ok) throw new Error(back.problem);
    await back.model.next(
      { system: "R", messages: [{ role: "user", content: "hi" }], tools: [] },
      new AbortController().signal,
    );
    expect(chat.sent[0]!.url).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(
      chatModelSetup({ OPENAI_API_KEY: key, CLAWDTIME_OPENAI_API: "fast" }),
    ).toEqual({
      ok: false,
      problem:
        "CLAWDTIME_OPENAI_API is not responses or chat. Fix it or remove it.",
    });
  });

  it("uses the chat's own setting through the providers layer, with the key of that provider", async () => {
    const net = network({
      choices: [{ message: { content: "Hi." }, finish_reason: "stop" }],
    });
    const setup = chatModelSetup(
      { CLAWDTIME_SUPERVISOR_MODEL: "groq/llama-fixture", GROQ_API_KEY: key },
      undefined,
      net.request,
    );
    expect(setup).toMatchObject({ ok: true, name: "groq/llama-fixture" });
    if (!setup.ok) return;
    const answer = await setup.model.next(
      { system: "R", messages: [{ role: "user", content: "hi" }], tools: [] },
      new AbortController().signal,
    );
    expect(answer).toEqual({ text: "Hi.", calls: [] });
    expect(net.sent[0]!.url).toBe(
      "https://api.groq.com/openai/v1/chat/completions",
    );
    expect(net.sent[0]!.body.model).toBe("llama-fixture");
  });

  it("defaults to gpt-6.2-astra and falls back to gpt-5.4 on 403/404 only when unchosen", async () => {
    expect(defaultChatAgentModel).toBe("gpt-6.2-astra");
    expect(chatModelSetup({ OPENAI_API_KEY: key })).toMatchObject({
      ok: true,
      name: "gpt-6.2-astra",
    });

    for (const status of [403, 404]) {
      const sent: { url: string; body: Record<string, unknown> }[] = [];
      const request = (async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push({ url: String(url), body });
        if (body.model === "gpt-6.2-astra")
          return new Response(
            JSON.stringify({ error: { code: "model_not_found" } }),
            { status, headers: { "content-type": "application/json" } },
          );
        return new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Fallback worked." }],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      const setup = chatModelSetup({ OPENAI_API_KEY: key }, undefined, request);
      if (!setup.ok) throw new Error(setup.problem);
      expect(
        await setup.model.next(
          { system: "R", messages: [{ role: "user", content: "hi" }], tools: [] },
          new AbortController().signal,
        ),
      ).toEqual({ text: "Fallback worked.", calls: [] });
      await setup.model.next(
        {
          system: "R",
          messages: [{ role: "user", content: "again" }],
          tools: [],
        },
        new AbortController().signal,
      );
      expect(sent.map((item) => [item.url, item.body.model])).toEqual([
        ["https://api.openai.com/v1/responses", "gpt-6.2-astra"],
        ["https://api.openai.com/v1/responses", "gpt-5.4"],
        ["https://api.openai.com/v1/responses", "gpt-5.4"],
      ]);
      // Unchosen fallback sends no forced reasoning effort on gpt-5.4.
      expect(sent[0]!.body.reasoning).toEqual({ effort: "medium" });
      expect(sent[1]!.body).not.toHaveProperty("reasoning");
    }

    // Explicitly chosen gpt-6.2-astra never falls back on 403/404.
    const chosenSent: string[] = [];
    const chosenRequest = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      chosenSent.push(body.model);
      return new Response(JSON.stringify({ error: { code: "model_not_found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const explicit = chatModelSetup(
      {
        OPENAI_API_KEY: key,
        CLAWDTIME_SUPERVISOR_MODEL: "gpt-6.2-astra",
      },
      undefined,
      chosenRequest,
    );
    if (!explicit.ok) throw new Error(explicit.problem);
    await expect(
      explicit.model.next(
        { system: "R", messages: [{ role: "user", content: "hi" }], tools: [] },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/404/);
    expect(chosenSent).toEqual(["gpt-6.2-astra"]);

    // gpt-5.4 with explicit effort routes to /v1/responses; with no effort stays on chat completions.
    const responsesNet = network({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hi." }],
        },
      ],
    });
    const withEffort = chatModelSetup(
      {
        OPENAI_API_KEY: key,
        CLAWDTIME_SUPERVISOR_MODEL: "gpt-5.4",
        CLAWDTIME_SUPERVISOR_REASONING: "low",
      },
      undefined,
      responsesNet.request,
    );
    if (!withEffort.ok) throw new Error(withEffort.problem);
    await withEffort.model.next(
      { system: "R", messages: [{ role: "user", content: "hi" }], tools: [] },
      new AbortController().signal,
    );
    expect(responsesNet.sent[0]!.url).toBe(
      "https://api.openai.com/v1/responses",
    );
    expect(responsesNet.sent[0]!.body.reasoning).toEqual({ effort: "low" });

    const chatNet = network({
      choices: [{ message: { content: "Hi." }, finish_reason: "stop" }],
    });
    const noEffort = chatModelSetup(
      {
        OPENAI_API_KEY: key,
        CLAWDTIME_SUPERVISOR_MODEL: "gpt-5.4",
      },
      undefined,
      chatNet.request,
    );
    if (!noEffort.ok) throw new Error(noEffort.problem);
    await noEffort.model.next(
      { system: "R", messages: [{ role: "user", content: "hi" }], tools: [] },
      new AbortController().signal,
    );
    expect(chatNet.sent[0]!.url).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("says what to set when the key is missing or the setting is a key, and never quotes the setting", () => {
    const missing = chatModelSetup({
      CLAWDTIME_SUPERVISOR_MODEL: "anthropic/claude-opus-5-5",
    });
    expect(missing).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/no key for Anthropic/),
    });
    const pasted = chatModelSetup({
      CLAWDTIME_SUPERVISOR_MODEL: "sk-proj-abcdefghijklmnopqrstuvwxyz",
    });
    expect(pasted.ok).toBe(false);
    expect(JSON.stringify(pasted)).not.toContain("abcdefghijklmnop");
  });
});
