import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsCli } from "../cli/agents.js";
import { talkLoop } from "../cli/supervisor.js";
import {
  ChatLog,
  OpenAIModel,
  Supervisor,
  type ModelClient,
  type ModelMessage,
  type SupervisorWorld,
  type ToolCall,
} from "../connectors/agents/brain.js";
import { converseByCall, type CallClient } from "../connectors/agents/call.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import {
  speak,
  speechSettings,
  transcribe,
} from "../connectors/agents/speech.js";
import type {
  AgentSession,
  BoardSnapshot,
} from "../connectors/agents/types.js";
import { fakeSystem } from "./connectors-agents-fixture.js";

const now = new Date(2026, 10, 20, 12, 0, 0).getTime();
const root = () => mkdtempSync(join(tmpdir(), "clawdtime-talk-"));
const session = (values: Partial<AgentSession> = {}): AgentSession => ({
  id: "100-abc",
  pid: 100,
  agent: "claude-code",
  agentLabel: "Claude Code",
  agentVersion: null,
  name: "deploy fix",
  project: "work",
  cwd: "/work/app",
  mode: "interactive",
  state: "working",
  detail: "turn_running",
  since: now - 90_000,
  source: "registry",
  startedAt: now - 3_600_000,
  spawnedBy: null,
  terminal: {
    tty: "ttys001",
    app: "Terminal",
    appPath: "/System/Applications/Utilities/Terminal.app",
    tmux: null,
    remote: false,
  },
  focus: "tab",
  ...values,
});
const board = (sessions: AgentSession[]): BoardSnapshot => ({
  version: 1,
  generatedAt: now,
  intervalMs: 3000,
  counts: {
    needs_you: sessions.filter((s) => s.state === "needs_you").length,
    working: sessions.filter((s) => s.state === "working").length,
    idle: sessions.filter((s) => s.state === "idle").length,
    unknown: 0,
  },
  sessions,
});
/** A model that follows a script: each step is the tool calls to make, or the final words. */
function scripted(steps: (ToolCall[] | string)[]) {
  const seen: { system: string; messages: ModelMessage[] }[] = [];
  let step = 0;
  const model: ModelClient = {
    async complete(input) {
      seen.push({
        system: input.system,
        messages: structuredClone(input.messages),
      });
      const next = steps[Math.min(step++, steps.length - 1)]!;
      return typeof next === "string"
        ? { text: next, toolCalls: [] }
        : { text: "", toolCalls: next };
    },
  };
  return { model, seen };
}
const call = (name: string, args: unknown, id = `c-${name}`): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});
function world(sessions: AgentSession[], directory = root()) {
  const log: string[] = [];
  const desk = new DecisionDesk(directory, () => now);
  const value: SupervisorWorld = {
    now: () => now,
    board: () => board(sessions),
    desk,
    focus: async (item) => {
      log.push(`focus ${item.id}`);
      return { ok: true };
    },
    send: async (item, text) => {
      log.push(`send ${item.id}: ${text}`);
      return { ok: true, route: "tmux" };
    },
    clis: () => [],
  };
  return { value, desk, log };
}
const ask = (desk: DecisionDesk, command = "git push origin main") =>
  desk.open({
    agent: "claude-code",
    sessionId: "s",
    cwd: "/work/app",
    pids: [],
    described: {
      kind: "permission",
      tool: "Bash",
      summary: command,
      options: [],
    },
    holdSeconds: 45,
  });

describe("the ClawdTime agent", () => {
  it.each([
    "can u check and summarize my emails?",
    "Can you check my emails?",
    "please read my inbox",
  ])("does not invent an approval or email agent for %s", async (spoken) => {
    const { value, desk, log } = world([session()]);
    const { model, seen } = scripted([
      "I need your approval to read your emails; please say approve or deny.",
    ]);
    const answer = await new Supervisor(value, model).reply([], spoken, "chat");
    expect(answer).toContain("no email integration");
    expect(answer).toContain("paste email text");
    expect(seen).toEqual([]);
    expect(desk.pending()).toEqual([]);
    expect(log).toEqual([]);
  });

  it("ignores a stale invented approval when no request or task can take it", async () => {
    const { value, desk, log } = world([
      session({ state: "needs_you", detail: "permission_prompt" }),
    ]);
    const { model, seen } = scripted([
      [call("decide", { request: 1, decision: "allow" })],
      "Approved. I will read your email.",
    ]);
    const answer = await new Supervisor(value, model).reply(
      [
        {
          role: "assistant",
          text: "Say approve and I can read your inbox.",
          at: now,
          via: "chat",
        },
      ],
      "yes approve it",
      "chat",
    );
    expect(answer).toBe(
      "There is no pending request to approve or deny. Nothing was authorized.",
    );
    expect(seen).toEqual([]);
    expect(desk.pending()).toEqual([]);
    expect(log).toEqual([]);
  });

  it("grounds model replies in current requests and rejects a phantom approval invitation", async () => {
    const { value, log } = world([]);
    const { model, seen } = scripted([
      "I need your approval to retrieve the account information. Please approve.",
    ]);
    const answer = await new Supervisor(value, model).reply(
      [],
      "Can you get my account information?",
      "chat",
    );
    expect(answer).toContain("no pending request");
    expect(seen[0]!.system).toContain("pending desk requests=0");
    expect(seen[0]!.system).toContain(
      "Approval cannot add a missing capability",
    );
    expect(log).toEqual([]);
  });

  it("still summarizes supplied email text and forwards explicit instructions to a named agent", async () => {
    const { value, log } = world([session()]);
    let run = scripted(["The meeting moved to Tuesday."]);
    expect(
      await new Supervisor(value, run.model).reply(
        [],
        "Summarize this email: The meeting is now on Tuesday.",
        "chat",
      ),
    ).toBe("The meeting moved to Tuesday.");
    expect(run.seen).toHaveLength(1);
    run = scripted([
      [
        call("type_into_session", {
          session: "deploy fix",
          text: "summarize my emails",
        }),
      ],
      "Passed your instruction to deploy fix.",
    ]);
    expect(
      await new Supervisor(value, run.model).reply(
        [],
        "Tell deploy fix: summarize my emails",
        "chat",
      ),
    ).toBe("Passed your instruction to deploy fix.");
    expect(log).toEqual(["send 100-abc: summarize my emails"]);
  });

  it("looks at the state through its tool and answers in words", async () => {
    const { value } = world([
      session(),
      session({
        id: "2-a",
        pid: 2,
        name: "docs",
        state: "needs_you",
        detail: "permission_prompt",
      }),
    ]);
    const { model, seen } = scripted([
      [call("status", {})],
      "One agent needs you: docs waits on a permission.",
    ]);
    const answer = await new Supervisor(value, model).reply(
      [],
      "what needs me?",
      "chat",
    );
    expect(answer).toBe("One agent needs you: docs waits on a permission.");
    const tool = seen[1]!.messages.at(-1)!;
    expect(tool.role).toBe("tool");
    expect(tool.content).toContain("Sessions: 1 needs you · 1 working.");
    expect(tool.content).toContain(
      "- docs (Claude Code): permission needed for 1m",
    );
    expect(tool.content).toContain("No request waits for an answer here.");
    expect(seen[0]!.system).toContain("only when the person clearly said so");
  });

  it("answers a request only when the person's own last words say so", async () => {
    const { value, desk } = world([session()]);
    const request = ask(desk);
    // The model tries to allow, but the person only asked a question: the code refuses.
    let run = scripted([
      [call("decide", { request: 1, decision: "allow" })],
      "I need your yes or no.",
    ]);
    expect(
      await new Supervisor(value, run.model).reply(
        [],
        "what does it want to push?",
        "chat",
      ),
    ).toBe("I need your yes or no.");
    expect(run.seen[1]!.messages.at(-1)!.content).toBe(
      "The person did not clearly say that. Ask them.",
    );
    expect(desk.take(request.id)).toBeNull();
    // The person says deny, the model asks for allow: refused too.
    run = scripted([[call("decide", { request: 1, decision: "allow" })], "ok"]);
    await new Supervisor(value, run.model).reply([], "deny it", "chat");
    expect(desk.take(request.id)).toBeNull();
    // A clear yes: allowed, and the trove will say it came through the panel.
    run = scripted([
      [call("decide", { request: 1, decision: "allow" })],
      "Allowed. It pushes now.",
    ]);
    expect(
      await new Supervisor(value, run.model).reply(
        [],
        "yes, approve the push",
        "chat",
      ),
    ).toBe("Allowed. It pushes now.");
    // Once it is answered it no longer waits for the person, even before its hook takes the answer.
    expect(desk.pending()).toEqual([]);
    expect(desk.take(request.id)).toMatchObject({
      decision: "allow",
      via: "panel",
    });
    expect(run.seen[1]!.messages.at(-1)!.content).toBe(
      "Allowed. The agent continues.",
    );
    run = scripted([[call("decide", { request: 9, decision: "allow" })], "ok"]);
    await new Supervisor(value, run.model).reply(
      [],
      "approve request 9",
      "chat",
    );
    expect(run.seen[1]!.messages.at(-1)!.content).toBe(
      "No request has that number.",
    );
  });

  it("types only the person's own words, opens a session, and keeps a note", async () => {
    const { value, desk, log } = world([
      session(),
      session({ id: "2-a", pid: 2, name: "docs" }),
    ]);
    let run = scripted([
      [call("type_into_session", { session: "deploy fix", text: "rm -rf /" })],
      "I need the exact text.",
    ]);
    await new Supervisor(value, run.model).reply(
      [],
      "tell deploy fix to clean up",
      "voice",
    );
    expect(run.seen[1]!.messages.at(-1)!.content).toContain(
      "Only the person's own words are typed",
    );
    expect(log).toEqual([]);
    run = scripted([
      [
        call("type_into_session", {
          session: "deploy fix",
          text: "run the tests again",
        }),
      ],
      "Typed.",
    ]);
    await new Supervisor(value, run.model).reply(
      [],
      "Tell deploy fix: run the tests again",
      "voice",
    );
    expect(log).toEqual(["send 100-abc: run the tests again"]);
    run = scripted([
      [
        call("open_session", { session: "docs" }),
        call("open_session", { session: "d" }, "c-2"),
        call("note_decision", { text: "Never push on Friday." }, "c-3"),
        call("set_away", { away: true }, "c-4"),
        call("search_trove", { query: "push" }, "c-5"),
        call("nope", {}, "c-6"),
      ],
      "Done.",
    ]);
    await new Supervisor(value, run.model).reply(
      [],
      "open docs and remember: never push on Friday",
      "chat",
    );
    const results = run.seen[1]!.messages.filter(
      (message) => message.role === "tool",
    ).map((message) => message.content);
    expect(results).toEqual([
      "Opened docs.",
      "No single session has that name.",
      "Kept in the trove as a critical decision.",
      "Away mode is on.",
      // The decision kept one step before is found at once.
      "2026-11-20 the person decided: Never push on Friday.",
      "There is no such tool.",
    ]);
    expect(log.at(-1)).toBe("focus 2-a");
    expect(desk.trove.notes()[0]!.text).toBe("Never push on Friday.");
    // The model rewords the decision: the person's own sentence is kept instead.
    run = scripted([
      [call("note_decision", { text: "Do not deploy during weekends ever." })],
      "Kept.",
    ]);
    await new Supervisor(value, run.model).reply(
      [],
      "remember this: no deploys on Saturday",
      "chat",
    );
    expect(desk.trove.notes()[1]!.text).toBe(
      "remember this: no deploys on Saturday",
    );
    // A question about the past finds the stated decisions, not only the answered requests.
    run = scripted([[call("search_trove", { query: "git push" })], "Never."]);
    await new Supervisor(value, run.model).reply(
      [],
      "what did I decide about a push?",
      "chat",
    );
    expect(run.seen[1]!.messages.at(-1)!.content).toBe(
      "2026-11-20 the person decided: Never push on Friday.",
    );
    expect(desk.away()).toBe(true);
  });

  it("works with no language model, and falls back when the model fails", async () => {
    const { value, desk } = world([
      session({ state: "needs_you", detail: "question" }),
    ]);
    const plain = new Supervisor(value, null);
    expect(plain.ready).toBe(false);
    expect(await plain.reply([], "what is going on", "chat")).toBe(
      "deploy fix needs you.",
    );
    const request = ask(desk, "npm test");
    expect(await plain.reply([], "hmm", "chat")).toBe(
      "One request waits for your answer: npm test. Say approve or deny to answer a request.",
    );
    expect(await plain.reply([], "approve", "call")).toBe(
      "Allowed. The agent continues.",
    );
    expect(desk.take(request.id)).toMatchObject({
      decision: "allow",
      via: "call",
    });
    expect(await plain.reply([], "   ", "chat")).toBe("I did not catch that.");
    const broken: ModelClient = {
      complete: async () => {
        throw new Error("offline");
      },
    };
    expect(
      await new Supervisor(world([session()]).value, broken).reply(
        [],
        "status?",
        "chat",
      ),
    ).toBe("1 working.");
    // A model that never stops calling tools is cut off.
    const loop = scripted([[call("status", {})]]);
    expect(
      await new Supervisor(value, loop.model).reply([], "status", "chat"),
    ).toContain("too many steps");
    expect(loop.seen).toHaveLength(6);
  });

  it("sends the model its tools and history, and reports only a status on failure", async () => {
    const bodies: any[] = [];
    const ok = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      expect((init.headers as Record<string, string>).authorization).toBe(
        "Bearer sk-test",
      );
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: { name: "status", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      );
    }) as typeof fetch;
    const turn = await new OpenAIModel("sk-test", "model-x", ok).complete({
      system: "sys",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c0", name: "status", arguments: "{}" }],
        },
        { role: "tool", toolCallId: "c0", content: "state" },
      ],
      tools: [
        {
          name: "status",
          description: "d",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    expect(turn).toEqual({
      text: "",
      toolCalls: [{ id: "c1", name: "status", arguments: "{}" }],
    });
    expect(bodies[0].model).toBe("model-x");
    expect(bodies[0].messages.map((message: any) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(bodies[0].messages[2].tool_calls[0]).toEqual({
      id: "c0",
      type: "function",
      function: { name: "status", arguments: "{}" },
    });
    expect(bodies[0].messages[3]).toEqual({
      role: "tool",
      tool_call_id: "c0",
      content: "state",
    });
    expect(bodies[0].tools[0]).toEqual({
      type: "function",
      function: {
        name: "status",
        description: "d",
        parameters: { type: "object", properties: {} },
      },
    });
    const refused = (async () =>
      new Response(
        JSON.stringify({ error: { message: "key sk-test is wrong" } }),
        { status: 401 },
      )) as typeof fetch;
    await expect(
      new OpenAIModel("sk-test", "m", refused).complete({
        system: "",
        messages: [],
        tools: [],
      }),
    ).rejects.toThrow("The language model answered 401.");
    await expect(
      new OpenAIModel("sk-test", "m", refused).complete({
        system: "",
        messages: [],
        tools: [],
      }),
    ).rejects.not.toThrow("sk-test");
  });
});

describe("chat log and speech", () => {
  it("keeps the conversation in one owner-only file and skips a broken line", () => {
    const directory = root();
    const log = new ChatLog(directory);
    expect(log.recent()).toEqual([]);
    for (let index = 0; index < 70; index++)
      log.append({
        role: index % 2 ? "assistant" : "user",
        text: `line ${index}`,
        at: now + index,
        via: "chat",
      });
    const file = join(directory, "agents", "chat.jsonl");
    writeFileSync(file, readFileSync(file, "utf8") + "{broken\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(log.recent()).toHaveLength(60);
    expect(log.recent(2).map((message) => message.text)).toEqual([
      "line 68",
      "line 69",
    ]);
    log.append({ role: "user", text: "x".repeat(5000), at: now, via: "voice" });
    expect(log.recent(1)[0]!.text).toHaveLength(2000);
  });

  it("turns a recording into words and an answer into sound", async () => {
    expect(speechSettings({})).toBeNull();
    expect(speechSettings({ OPENAI_API_KEY: "sk-a" })).toMatchObject({
      key: "sk-a",
      voice: "alloy",
    });
    expect(
      speechSettings({
        CLAWDTIME_OPENAI_API_KEY: "sk-b",
        OPENAI_API_KEY: "sk-a",
        CLAWDTIME_VOICE: "sage",
        CLAWDTIME_SPEAK_MODEL: "tts-x",
      }),
    ).toMatchObject({ key: "sk-b", voice: "sage", speakModel: "tts-x" });
    const directory = root();
    const recording = join(directory, "a.wav");
    writeFileSync(recording, Buffer.alloc(4000, 1));
    const requests: { url: string; model?: string; body?: any }[] = [];
    const request = (async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/audio/transcriptions")) {
        const form = init.body as FormData;
        requests.push({ url: String(url), model: String(form.get("model")) });
        expect((form.get("file") as Blob).size).toBe(4000);
        return new Response(
          JSON.stringify({ text: "  approve the push\u0007 " }),
        );
      }
      requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(new Uint8Array([73, 68, 51]));
    }) as typeof fetch;
    const settings = {
      ...speechSettings({ OPENAI_API_KEY: "sk-a" })!,
      request,
    };
    expect(await transcribe(recording, settings)).toBe("approve the push");
    expect(requests[0]).toEqual({
      url: "https://api.openai.com/v1/audio/transcriptions",
      model: "gpt-4o-mini-transcribe",
    });
    expect([...(await speak("Allowed.", settings))]).toEqual([73, 68, 51]);
    expect(requests[1]!.body).toEqual({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: "Allowed.",
      response_format: "mp3",
    });
    // A recording with almost nothing in it is silence: no request is made.
    writeFileSync(recording, Buffer.alloc(200));
    expect(await transcribe(recording, settings)).toBe("");
    expect(requests).toHaveLength(2);
    const refused = {
      ...settings,
      request: (async () =>
        new Response("no", { status: 429 })) as typeof fetch,
    };
    writeFileSync(recording, Buffer.alloc(4000, 1));
    await expect(transcribe(recording, refused)).rejects.toThrow(
      "Transcription answered 429.",
    );
    await expect(speak("x", refused)).rejects.toThrow("Speech answered 429.");
  });

  it("the service keeps the chat, hears a recording, answers, and speaks", async () => {
    const directory = root();
    const { model } = scripted(["All quiet. Nothing waits for you."]);
    const sounds: string[] = [];
    const request = (async (url: string) =>
      String(url).endsWith("/audio/transcriptions")
        ? new Response(JSON.stringify({ text: "what needs me" }))
        : (sounds.push("spoken"),
          new Response(new Uint8Array([1, 2, 3])))) as typeof fetch;
    const feed = new BoardFeed({
      root: directory,
      now: () => now,
      model,
      speech: {
        key: "sk",
        transcribeModel: "t",
        speakModel: "s",
        voice: "v",
        request,
      },
    });
    const view = feed.chat();
    expect(view).toMatchObject({
      version: 1,
      model: true,
      speech: true,
      messages: [],
    });
    expect(statSync(view.voiceDirectory).mode & 0o777).toBe(0o700);
    expect(await feed.say("hello")).toEqual({
      role: "assistant",
      text: "All quiet. Nothing waits for you.",
      at: now,
      via: "chat",
    });
    writeFileSync(
      join(view.voiceDirectory, "rec-1.wav"),
      Buffer.alloc(4000, 1),
    );
    const heard = await feed.hear("rec-1.wav");
    expect(heard.heard).toBe("what needs me");
    expect(heard.reply).toMatchObject({ role: "assistant", via: "voice" });
    expect(heard.audio).toMatch(/^reply-[a-z0-9]+\.mp3$/);
    expect([...readFileSync(join(view.voiceDirectory, heard.audio!))]).toEqual([
      1, 2, 3,
    ]);
    // The recording is gone once its words are known. Only the newest answer is kept as sound.
    expect(readdirSync(view.voiceDirectory)).toEqual([heard.audio]);
    expect(
      feed.chat().messages.map((message) => `${message.role}/${message.via}`),
    ).toEqual(["user/chat", "assistant/chat", "user/voice", "assistant/voice"]);
    // A file name that could leave the folder is refused before anything is read.
    expect(await feed.hear("../chat.jsonl")).toEqual({
      heard: "",
      reply: null,
      audio: null,
    });
    expect(await feed.hear("missing.wav")).toEqual({
      heard: "",
      reply: null,
      audio: null,
    });
    const silent = new BoardFeed({ root: root(), model: null, speech: null });
    expect(silent.chat()).toMatchObject({ model: false, speech: false });
    expect(await silent.hear("rec.wav")).toEqual({
      heard: "",
      reply: null,
      audio: null,
    });
    // With no model it answers from the state, and it invites an answer only
    // when a request waits: here nothing does.
    expect((await silent.say("status")).text).toBe(
      "I cannot see the agents now.",
    );
  });
});

describe("a conversation on a call", () => {
  it("answers each thing the person says and ends on goodbye", async () => {
    const log: string[] = [];
    const pages = [
      { turns: [] },
      {
        turns: [
          { id: "t1", sequence: 1, text: "what needs" },
          { id: "t2", sequence: 2, text: "me right now" },
        ],
      },
      { turns: [{ id: "t3", sequence: 3, text: "okay thanks, goodbye" }] },
    ];
    let page = 0;
    const client: CallClient = {
      async requestAttention(input) {
        log.push(`call ${input.reason}: ${input.question}`);
        return { request: { id: "att", state: "requested" } };
      },
      async conversationTurns() {
        return {
          turns: pages[Math.min(page++, pages.length - 1)]!.turns,
          request: { state: "connected" },
        };
      },
      async conversationOperation(_id, operation, body) {
        log.push(`${operation} ${JSON.stringify(body)}`);
        return {};
      },
      async heartbeat() {
        return {};
      },
    };
    const heard: string[] = [];
    let clock = now;
    const result = await converseByCall(
      client,
      async (spoken) => {
        heard.push(spoken);
        return "One agent needs you.";
      },
      {
        now: () => (clock += 1000),
        deadline: now + 600_000,
        greeting: "ClawdTime here. What do you need?",
        key: "k1",
        pollMs: 1,
        beatMs: 100_000,
      },
    );
    expect(result).toEqual({ turns: 2, ended: "goodbye" });
    // Two fragments of one sentence are answered together, once.
    expect(heard).toEqual(["what needs me right now"]);
    expect(log[0]).toBe("call decision: ClawdTime here. What do you need?");
    expect(log).toContain(
      'reply {"turnId":"t2","replyId":"reply-t2","text":"One agent needs you.","expectedCursor":2}',
    );
    expect(log).toContain(
      'reply {"turnId":"t3","replyId":"reply-t3","text":"Goodbye.","expectedCursor":3}',
    );
    expect(log.at(-1)).toBe("end {}");
  });

  it("stops when the person hangs up", async () => {
    const client: CallClient = {
      async requestAttention() {
        return { request: { id: "att", state: "requested" } };
      },
      async conversationTurns() {
        return { turns: [], request: { state: "disconnected" } };
      },
      async conversationOperation() {
        return {};
      },
      async heartbeat() {
        return {};
      },
    };
    expect(
      await converseByCall(client, async () => "x", {
        now: () => now,
        deadline: now + 60_000,
        greeting: "Hi",
        key: "k",
        pollMs: 1,
        beatMs: 100_000,
      }),
    ).toEqual({ turns: 0, ended: "hung_up" });
  });
});

describe("chat command", () => {
  it("answers one typed line and keeps both sides in the log", async () => {
    const directory = root();
    mkdirSync(directory, { recursive: true });
    const lines: string[] = [];
    const { model } = scripted([
      [call("status", {})],
      "Nothing runs and nothing waits.",
    ]);
    await agentsCli(["--supervisor", "chat", "what", "is", "running?"], {
      system: fakeSystem({ now, env: { CLAWDTIME_CONFIG_HOME: directory } }),
      print: (line) => lines.push(line),
      hookScript: "/x.js",
      model,
    });
    expect(lines).toEqual(["Nothing runs and nothing waits."]);
    expect(
      new ChatLog(directory).recent().map((message) => message.text),
    ).toEqual(["what is running?", "Nothing runs and nothing waits."]);
    expect(existsSync(join(directory, "agents", "chat.jsonl"))).toBe(true);
    await expect(
      agentsCli(["--supervisor", "talk"], {
        system: fakeSystem({ now, env: { CLAWDTIME_CONFIG_HOME: directory } }),
        print: () => {},
        hookScript: "/x.js",
        model: null,
      }),
    ).rejects.toThrow("Speech needs");
  });
});

describe("talk in a terminal", () => {
  it("takes one Return to start and one to send, and never reads a key twice", async () => {
    const input = ["", "", "", "", "q"];
    const printed: string[] = [];
    const log: string[] = [];
    let recordings = 0;
    const turns = await talkLoop({
      print: (line) => printed.push(line),
      next: async () => input.shift() ?? null,
      record: () => {
        const file = `rec-${++recordings}.wav`;
        log.push(`record ${file}`);
        return {
          stop: async () => {
            log.push(`stop ${file}`);
            return file;
          },
        };
      },
      hear: async (file) =>
        file === "rec-1.wav" ? "what needs me" : "approve it",
      answer: async (words) => {
        log.push(`answer ${words}`);
        return words === "approve it" ? "Allowed." : "One request waits.";
      },
      say: async (text) => {
        log.push(`say ${text}`);
      },
    });
    expect(turns).toBe(2);
    // Five lines: start, send, start, send, q. Two recordings, not three.
    expect(log).toEqual([
      "record rec-1.wav",
      "stop rec-1.wav",
      "answer what needs me",
      "say One request waits.",
      "record rec-2.wav",
      "stop rec-2.wav",
      "answer approve it",
      "say Allowed.",
    ]);
    expect(printed.filter((line) => line.startsWith("You: "))).toEqual([
      "You: what needs me",
      "You: approve it",
    ]);
    expect(printed.at(-1)).toBe(
      "Press Return to speak again, or q and Return to stop.",
    );
  });

  it("stops a recording when the input ends, and goes on when nothing was heard or speech fails", async () => {
    const log: string[] = [];
    const printed: string[] = [];
    const record = () => ({
      stop: async () => {
        log.push("stop");
        return "rec.wav";
      },
    });
    // The input ends in the middle of a recording: it is stopped and nothing is answered.
    expect(
      await talkLoop({
        print: () => {},
        next: (() => {
          const lines: (string | null)[] = ["", null];
          return async () => lines.shift() ?? null;
        })(),
        record,
        hear: async () => "half a sentence",
        answer: async () => {
          log.push("answer");
          return "x";
        },
        say: async () => {},
      }),
    ).toBe(0);
    expect(log).toEqual(["stop"]);
    const lines = ["", "", "", "", "q"];
    let heard = 0;
    expect(
      await talkLoop({
        print: (line) => printed.push(line),
        next: async () => lines.shift() ?? null,
        record,
        hear: async () => (heard++ === 0 ? "" : "status"),
        answer: async () => "All quiet.",
        say: async () => {
          throw new Error("Speech answered 429.");
        },
      }),
    ).toBe(1);
    expect(printed).toContain(
      "I did not catch that. Press Return to try again.",
    );
    expect(printed).toContain("ClawdTime: All quiet.");
    expect(printed).toContain("Speech answered 429.");
  });
});
