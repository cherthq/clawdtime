import { describe, expect, it } from "vitest";
import {
  fitConversation,
  runAgentLoop,
  type LoopEvent,
  type LoopMessage,
  type LoopTool,
} from "../connectors/agents/agent-loop.js";
import { call, scriptedModel } from "./chat-agent-fixture.js";

const tool = (
  name: string,
  run: LoopTool["run"],
  effect = false,
): LoopTool => ({
  name,
  description: `The ${name} tool.`,
  parameters: { type: "object", properties: {} },
  effect,
  run,
});

const user = (content: string): LoopMessage => ({ role: "user", content });

describe("the agent loop", () => {
  it("runs tool rounds until the model answers in words, and gives each result back to its call", async () => {
    const model = scriptedModel([
      { calls: [call("lookup", { q: "weather" })] },
      { calls: [call("lookup", { q: "rain" })] },
      { text: "It is sunny, no rain." },
    ]);
    const seen: unknown[] = [];
    const result = await runAgentLoop([user("what's the weather?")], {
      model,
      system: "Rules.",
      tools: [
        tool("lookup", async (args) => {
          seen.push(args);
          return `result for ${String(args.q)}`;
        }),
      ],
    });
    expect(result.end).toBe("answer");
    expect(result.text).toBe("It is sunny, no rain.");
    expect(result.steps).toBe(3);
    expect(seen).toEqual([{ q: "weather" }, { q: "rain" }]);
    const second = model.requests[1]!.messages;
    const answer = second[1]!;
    const back = second[2]!;
    expect(answer.role).toBe("assistant");
    expect(back).toMatchObject({
      role: "tool",
      name: "lookup",
      content: "result for weather",
    });
    expect(
      back.role === "tool" && answer.role === "assistant" && back.callId,
    ).toBe(answer.role === "assistant" ? answer.calls![0]!.id : null);
    expect(result.calls.map((item) => item.result)).toEqual([
      "result for weather",
      "result for rain",
    ]);
  });

  it("runs reads in a row side by side, and a tool with an effect alone", async () => {
    let inside = 0;
    let most = 0;
    let effectInside = 0;
    let started = 0;
    let release!: () => void;
    const both = new Promise<void>((done) => (release = done));
    const read = tool("read", async () => {
      inside++;
      most = Math.max(most, inside);
      // Each read waits until both reads started: only side by side do they end.
      if (++started === 2) release();
      await both;
      inside--;
      return "read";
    });
    const act = tool(
      "act",
      async () => {
        effectInside++;
        expect(inside).toBe(0);
        expect(effectInside).toBe(1);
        await new Promise((done) => setTimeout(done, 5));
        effectInside--;
        return "acted";
      },
      true,
    );
    const model = scriptedModel([
      { calls: [call("read"), call("read"), call("act"), call("act")] },
      { text: "ok" },
    ]);
    const result = await runAgentLoop([user("go")], {
      model,
      system: "R",
      tools: [read, act],
    });
    expect(result.end).toBe("answer");
    expect(most).toBe(2);
    // The results go back in the order of the calls.
    expect(result.calls.map((item) => item.result)).toEqual([
      "read",
      "read",
      "acted",
      "acted",
    ]);
    const back = model.requests[1]!.messages.filter(
      (message) => message.role === "tool",
    );
    expect(back.map((message) => message.content)).toEqual([
      "read",
      "read",
      "acted",
      "acted",
    ]);
  });

  it("takes in messages that came while it ran, between rounds, as new user messages", async () => {
    const inbox: string[] = [];
    const events: LoopEvent[] = [];
    const model = scriptedModel([
      () => {
        inbox.push("no, the Pro Max");
        return { calls: [call("search", { q: "Aero 7 Pro" })] };
      },
      { text: "Switched to the Pro Max." },
    ]);
    const result = await runAgentLoop([user("search Aero 7 Pro")], {
      model,
      system: "R",
      tools: [tool("search", async () => "searching")],
      inbox: () => inbox.splice(0),
      listener: (event) => events.push(event),
    });
    const second = model.requests[1]!.messages;
    expect(second.at(-1)).toEqual({ role: "user", content: "no, the Pro Max" });
    expect(second.at(-2)).toMatchObject({ role: "tool", content: "searching" });
    expect(result.text).toBe("Switched to the Pro Max.");
    expect(events.some((event) => event.kind === "message")).toBe(true);
  });

  it("asks again when a message came during the request that answered in words", async () => {
    const inbox: string[] = [];
    const model = scriptedModel([
      () => {
        inbox.push("and the reviews too");
        return { text: "Searching now." };
      },
      { text: "I'll check the reviews too." },
    ]);
    const result = await runAgentLoop([user("search it")], {
      model,
      system: "R",
      tools: [],
      inbox: () => inbox.splice(0),
    });
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]!.messages.at(-1)).toEqual({
      role: "user",
      content: "and the reviews too",
    });
    expect(result.text).toBe("I'll check the reviews too.");
  });

  it("lets the gate refuse a call with a reason that the model reads, and never runs it", async () => {
    let ran = false;
    const model = scriptedModel([
      { calls: [call("send", { to: "Sam" })] },
      { text: "I could not send it." },
    ]);
    const result = await runAgentLoop([user("send it")], {
      model,
      system: "R",
      tools: [tool("send", async () => ((ran = true), "sent"), true)],
      gate: (seen) =>
        seen.name === "send"
          ? { allow: false, reason: "The owner said stop." }
          : { allow: true },
    });
    expect(ran).toBe(false);
    expect(result.calls[0]!.refused).toBe("The owner said stop.");
    expect(model.requests[1]!.messages.at(-1)).toMatchObject({
      role: "tool",
      content: "Refused: The owner said stop.",
    });
  });

  it("cuts long results, lets the hook shorten them, and reports bad calls as errors", async () => {
    const model = scriptedModel([
      {
        calls: [
          call("big"),
          { id: "x1", name: "missing", arguments: "{}" },
          { id: "x2", name: "big", arguments: "not json" },
        ],
      },
      { text: "ok" },
    ]);
    const result = await runAgentLoop([user("go")], {
      model,
      system: "R",
      tools: [tool("big", async () => "y".repeat(10_000))],
      resultLimit: 100,
      after: (_call, text) => `${text.length}:${text.slice(-5)}`,
    });
    expect(result.calls[0]!.result).toBe("100:[cut]");
    expect(result.calls[1]!.result).toBe(
      "Error: there is no tool named missing.",
    );
    expect(result.calls[2]!.result).toBe("Error: The arguments are not JSON.");
  });

  it("asks once more with no tools at the step limit, so the model says words", async () => {
    const model = scriptedModel([
      { calls: [call("again")] },
      { calls: [call("again")] },
      (request) => ({
        text: request.tools.length
          ? "still tools"
          : "I stopped after two rounds.",
      }),
    ]);
    const result = await runAgentLoop([user("go")], {
      model,
      system: "R",
      tools: [tool("again", async () => "more")],
      maxSteps: 2,
    });
    expect(result.end).toBe("limit");
    expect(model.requests[2]!.tools).toEqual([]);
    expect(result.text).toBe("I stopped after two rounds.");
  });

  it("ends at an abort: a waiting request of the model is left and no call starts", async () => {
    const abort = new AbortController();
    let ran = false;
    const model = scriptedModel([
      () => {
        abort.abort(new Error("stopped"));
        return { calls: [call("act")] };
      },
    ]);
    const result = await runAgentLoop([user("go")], {
      model,
      system: "R",
      tools: [tool("act", async () => ((ran = true), "acted"), true)],
      signal: abort.signal,
    });
    expect(result.end).toBe("aborted");
    expect(result.text).toBe("");
    expect(ran).toBe(false);

    // A request that never answers ends at the abort too.
    const second = new AbortController();
    const hanging = runAgentLoop([user("go")], {
      model: { next: () => new Promise(() => {}) },
      system: "R",
      tools: [],
      signal: second.signal,
    });
    second.abort(new Error("stopped"));
    expect((await hanging).end).toBe("aborted");
  });

  it("sends the rules and the live context made again before every request", async () => {
    let round = 0;
    const model = scriptedModel([{ calls: [call("tick")] }, { text: "ok" }]);
    await runAgentLoop([user("go")], {
      model,
      system: "Rules.",
      context: () => `Round ${++round}.`,
      tools: [tool("tick", async () => "ticked")],
    });
    expect(model.requests.map((request) => request.system)).toEqual([
      "Rules.\n\nRound 1.",
      "Rules.\n\nRound 2.",
    ]);
  });
});

describe("fitting the conversation to a budget", () => {
  const long = (n: number) => "z".repeat(n);
  const conversation = (): LoopMessage[] => {
    const messages: LoopMessage[] = [];
    for (let index = 0; index < 6; index++) {
      messages.push({ role: "user", content: `turn ${index}` });
      messages.push({
        role: "assistant",
        content: "",
        calls: [{ id: `c${index}`, name: "read", arguments: "{}" }],
      });
      messages.push({
        role: "tool",
        callId: `c${index}`,
        name: "read",
        content: long(3_000),
      });
      messages.push({ role: "assistant", content: `answer ${index}` });
    }
    return messages;
  };

  it("keeps the newest turns whole and cuts older tool results short", () => {
    const fitted = fitConversation(conversation(), 100_000, 2);
    expect(fitted.dropped).toBe(0);
    expect(fitted.shortened).toBe(4);
    const tools = fitted.messages.filter((message) => message.role === "tool");
    expect(
      tools.slice(0, 4).every((message) => message.content.length <= 200),
    ).toBe(true);
    expect(
      tools.slice(4).every((message) => message.content.length === 3_000),
    ).toBe(true);
  });

  it("drops the oldest messages with a note, and never sends a result without its call", () => {
    const fitted = fitConversation(conversation(), 6_500, 2);
    expect(fitted.dropped).toBeGreaterThan(0);
    expect(fitted.messages[0]).toMatchObject({ role: "user" });
    expect(fitted.messages[0]!.content).toMatch(
      /earlier messages of this conversation were left out/,
    );
    const calls = new Set(
      fitted.messages.flatMap((message) =>
        message.role === "assistant"
          ? (message.calls ?? []).map((item) => item.id)
          : [],
      ),
    );
    for (const message of fitted.messages)
      if (message.role === "tool") expect(calls.has(message.callId)).toBe(true);
    // The newest turn stays whole.
    expect(fitted.messages.at(-1)).toEqual({
      role: "assistant",
      content: "answer 5",
    });
    expect(
      fitted.messages.some((message) => message.content === "turn 5"),
    ).toBe(true);
  });

  it("keeps fewer turns whole when even those do not fit, down to one", () => {
    const fitted = fitConversation(conversation(), 3_500, 4);
    const whole = fitted.messages.filter(
      (message) => message.role === "tool" && message.content.length === 3_000,
    );
    expect(whole).toHaveLength(1);
  });
});
