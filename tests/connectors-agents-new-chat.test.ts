import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsCli } from "../cli/agents.js";
import {
  asksForNewChat,
  chatBusyText,
  ChatLog,
  computerTaskNow,
  Supervisor,
  switchChat,
  type ChatMessage,
  type ModelClient,
} from "../connectors/agents/brain.js";
import { desktopChatLostText } from "../connectors/agents/desktop-chat.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import type { Action } from "../connectors/computer/ports.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import { createTaskApp } from "../src/control/task-app.js";
import type { TaskDesktopService } from "../src/control/task-desktop-service.js";
import type { TaskService } from "../src/control/task-service.js";
import { DomainError } from "../src/storage/security.js";
import { fakeSystem } from "./connectors-agents-fixture.js";
import {
  element,
  FakeHands,
  observation,
  ScriptedPlanner,
  until,
} from "./connectors-computer-fixture.js";

/**
 * A new chat: the conversation is put aside, never deleted, and an empty one
 * starts. Work that runs goes on. No window opens and no input is sent here.
 */

const temporaries: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  temporaries
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true }));
});
const temporary = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-new-chat-")));
  temporaries.push(path);
  return path;
};

/** 26 November 2026, 10:15:30 UTC. */
const now = Date.UTC(2026, 10, 26, 10, 15, 30, 123);
const stamp = "20261126T101530Z";
const line = (
  role: ChatMessage["role"],
  text: string,
  at = now,
): ChatMessage => ({ role, text, at, via: "chat" });
const mode = (path: string) => statSync(path).mode & 0o777;
const chatFiles = (root: string) =>
  readdirSync(join(root, "agents"))
    .filter((name) => /^chat.*\.jsonl$/.test(name))
    .sort();
/** Every message in every chat file: nothing is lost when the count stays. */
const allWords = (root: string) =>
  chatFiles(root)
    .flatMap((name) =>
      readFileSync(join(root, "agents", name), "utf8")
        .split("\n")
        .filter(Boolean),
    )
    .sort();
/** Every file under the state folder except the chat files, with its text. */
const otherFiles = (root: string) => {
  const result: Record<string, string> = {};
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (!/^chat.*\.jsonl$/.test(name))
        result[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return result;
};

describe("the chat log puts a conversation aside and starts an empty one", () => {
  it("moves the file to chat-<time>.jsonl, owner-only, and deletes nothing", () => {
    const root = temporary();
    const log = new ChatLog(root);
    log.append(line("user", "Open Mail and find the invoice from Tuesday."));
    log.append(line("assistant", "I found it."));
    const current = join(root, "agents", "chat.jsonl");
    const before = readFileSync(current, "utf8");
    expect(log.archive(now)).toBe(stamp);
    const kept = join(root, "agents", `chat-${stamp}.jsonl`);
    expect(existsSync(current)).toBe(false);
    expect(readFileSync(kept, "utf8")).toBe(before);
    expect(mode(kept)).toBe(0o600);
    expect(mode(join(root, "agents"))).toBe(0o700);
    // The new chat is empty, and the next line starts it in an owner-only file.
    expect(log.recent()).toEqual([]);
    log.append(line("user", "what needs me?"));
    expect(mode(current)).toBe(0o600);
    expect(log.recent().map((message) => message.text)).toEqual([
      "what needs me?",
    ]);
    expect(readFileSync(kept, "utf8")).toBe(before);
  });

  it("puts nothing aside when the chat is empty, and never writes over a kept chat", () => {
    const root = temporary();
    const log = new ChatLog(root);
    expect(log.archive(now)).toBeNull();
    log.append(line("user", "one"));
    expect(log.archive(now)).toBe(stamp);
    expect(log.archive(now)).toBeNull();
    // Two chats put aside in one second: the second gets a number.
    log.append(line("user", "two"));
    expect(log.archive(now)).toBe(`${stamp}-2`);
    log.append(line("user", "three"));
    expect(log.archive(now + 1000)).toBe("20261126T101531Z");
    expect(chatFiles(root)).toEqual([
      `chat-${stamp}-2.jsonl`,
      `chat-${stamp}.jsonl`,
      "chat-20261126T101531Z.jsonl",
    ]);
    expect(allWords(root)).toHaveLength(3);
    expect(log.history().map((chat) => chat.id)).toEqual([
      "20261126T101531Z",
      `${stamp}-2`,
      stamp,
    ]);
  });

  it("lists the kept chats with their first words, and opens one again after it puts the current one aside", () => {
    const root = temporary();
    const log = new ChatLog(root);
    log.append(line("assistant", "Done. The mail is sent."));
    log.append(line("user", "  Reply   to Sam\non Slack  "));
    log.append(line("assistant", "Sent."));
    const first = log.archive(now)!;
    log.append(line("assistant", "News only."));
    const second = log.archive(now + 60_000)!;
    log.append(line("user", "the current chat"));
    expect(log.history()).toEqual([
      { id: second, messages: 1, first: "News only." },
      { id: first, messages: 3, first: "Reply to Sam on Slack" },
    ]);
    const words = allWords(root);
    expect(log.open(first, now + 120_000)).toEqual({
      archived: "20261126T101730Z",
    });
    expect(log.recent().map((message) => message.text)).toEqual([
      "Done. The mail is sent.",
      "  Reply   to Sam\non Slack  ",
      "Sent.",
    ]);
    expect(mode(join(root, "agents", "chat.jsonl"))).toBe(0o600);
    expect(log.history().map((chat) => chat.id)).toEqual([
      "20261126T101730Z",
      second,
    ]);
    // Every message is still in a file.
    expect(allWords(root)).toEqual(words);
    // An id that no kept chat has, or that is no id, opens nothing.
    expect(log.open("20200101T000000Z", now)).toBeNull();
    expect(log.open("../chat", now)).toBeNull();
    expect(log.open("20261126T101730Z/../../x", now)).toBeNull();
    expect(allWords(root)).toEqual(words);
  });

  it("moves no file that is not a regular file, and lists no such file", () => {
    const root = temporary();
    mkdirSync(join(root, "agents"), { mode: 0o700 });
    const elsewhere = join(root, "elsewhere.jsonl");
    writeFileSync(elsewhere, `${JSON.stringify(line("user", "x"))}\n`);
    symlinkSync(elsewhere, join(root, "agents", "chat.jsonl"));
    symlinkSync(elsewhere, join(root, "agents", `chat-${stamp}.jsonl`));
    writeFileSync(join(root, "agents", "chat-notatime.jsonl"), "");
    const log = new ChatLog(root);
    const result = switchChat(log, "new", now);
    expect(result).toEqual({
      ok: false,
      archived: null,
      text: "The chat file is not a regular file. Nothing was moved.",
    });
    expect(log.history()).toEqual([]);
    expect(switchChat(log, { open: stamp }, now).ok).toBe(false);
    expect(readdirSync(join(root, "agents")).sort()).toEqual([
      `chat-${stamp}.jsonl`,
      "chat-notatime.jsonl",
      "chat.jsonl",
    ]);
  });
});

describe("the words that ask for a new chat", () => {
  it("are new chat, clear the chat and start over, alone", () => {
    for (const words of [
      "new chat",
      "New chat.",
      "a new chat",
      "start a new chat",
      "Start a new conversation please",
      "new conversation",
      "clear the chat",
      "Clear chat!",
      "please clear the conversation",
      "start over",
      "Let's start over.",
      "ok, start over",
      "  start   over  ",
    ])
      expect(asksForNewChat(words), words).toBe(true);
  });

  it("are no request for a new chat inside other words", () => {
    for (const words of [
      "start over the export",
      "clear the chat in Slack",
      "open a new chat with Sam on Slack",
      "what is a new chat?",
      "new chat app",
      "start the task over",
      "start again",
      "don't start over",
      "",
    ])
      expect(asksForNewChat(words), words).toBe(false);
  });
});

const click: Action = { kind: "click_element", element: 1 };
const done: Action = { kind: "done", summary: "The mail is sent." };
/** A worker whose first step needs a yes: clicking Send. */
function waitingWorker(root: string, feed: () => BoardFeed | undefined) {
  const hands = new FakeHands([observation([element(1, { title: "Send" })])]);
  return new ComputerWorker({
    hands,
    planner: new ScriptedPlanner([click, done]),
    journal: new ComputerJournal(root),
    notify: (text) => feed()?.appendExecutionResult(text),
  });
}

describe("a new chat in the desktop service", () => {
  it("leaves the computer task running, and its question is the first line of the new chat, where a yes still answers it", async () => {
    const root = temporary();
    let feed: BoardFeed | undefined;
    const worker = waitingWorker(root, () => feed);
    feed = new BoardFeed({
      root,
      model: null,
      speech: null,
      execution: worker,
    });
    await worker.submit("r1", "Finish the draft");
    await until(() => worker.snapshot().state === "waiting_for_person");
    const question = feed.chat().messages.map((message) => message.text);
    expect(question).toHaveLength(1);
    const before = worker.snapshot();
    const others = otherFiles(root);
    const result = feed.newChat();
    expect(result).toMatchObject({ ok: true });
    expect(result.archived).toMatch(/^[0-9]{8}T[0-9]{6}Z$/);
    // The task was not touched: the same state, and no file of it changed.
    expect(worker.snapshot()).toEqual(before);
    expect(otherFiles(root)).toEqual(others);
    // The old chat is kept with the question in it.
    expect(
      readFileSync(
        join(root, "agents", `chat-${result.archived}.jsonl`),
        "utf8",
      ),
    ).toContain(JSON.stringify(question[0]).slice(1, -1));
    // The new chat says what waits, as the chat always says it.
    expect(feed.chat().messages.map((message) => message.text)).toEqual([
      computerTaskNow(worker.snapshot()),
    ]);
    expect(feed.chat().execution).toMatchObject({
      state: "waiting_for_person",
    });
    const reply = await feed.say("yes");
    expect(reply).toMatchObject({ role: "assistant", text: "Continuing." });
    await worker.idle();
    expect(feed.chat().messages.map((message) => message.text)).toEqual([
      computerTaskNow(before),
      "yes",
      "Continuing.",
      "Done. The mail is sent.",
    ]);
    feed.close();
  });

  it("starts from the typed words, keeps no line of them, and drops what ClawdTime offered in the old chat", async () => {
    const root = temporary();
    const feed = new BoardFeed({
      root,
      model: null,
      speech: null,
      now: () => now,
    });
    const dropped = vi.spyOn(Supervisor.prototype, "newConversation");
    await feed.say("status");
    expect(feed.chat().messages).toHaveLength(2);
    const reply = await feed.say("Start over.");
    expect(reply).toEqual({
      role: "assistant",
      text: `A new chat started. The chat before it is kept as ${stamp} (clawdtime chat history). Work that runs goes on.`,
      at: now,
      via: "chat",
    });
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(feed.chat().messages).toEqual([]);
    expect(feed.chatHistory()).toEqual({
      chats: [{ id: stamp, messages: 2, first: "status" }],
    });
    // Other words with "start over" in them are a message like any other.
    await feed.say("start over the export");
    expect(feed.chat().messages.map((message) => message.text)[0]).toBe(
      "start over the export",
    );
    expect(feed.chatHistory().chats).toHaveLength(1);
    // Spoken words are not taken for it: a call or the voice of the panel.
    await feed.say("new chat", "voice");
    expect(feed.chatHistory().chats).toHaveLength(1);
    dropped.mockRestore();
    feed.close();
  });

  it("does not change the chat while a turn waits for its answer", async () => {
    const root = temporary();
    let answer!: (value: { text: string; toolCalls: [] }) => void;
    const model: ModelClient = {
      complete: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    };
    const feed = new BoardFeed({ root, model, speech: null, now: () => now });
    const turn = feed.say("Write a short poem about the sea.");
    await until(() => answer !== undefined);
    expect(feed.newChat()).toEqual({
      ok: false,
      archived: null,
      text: chatBusyText,
    });
    // Typed, the words and the reason stay in the chat in view.
    expect((await feed.say("new chat")).text).toBe(chatBusyText);
    answer({ text: "Nothing waits for you.", toolCalls: [] });
    await turn;
    expect(feed.chat().messages.map((message) => message.text)).toEqual([
      "Write a short poem about the sea.",
      "new chat",
      chatBusyText,
      "Nothing waits for you.",
    ]);
    expect(feed.newChat()).toMatchObject({ ok: true, archived: stamp });
    feed.close();
  });
});

const panel = "p".repeat(40);
const desktop = {
  authorizePanel(value: string) {
    if (value !== panel)
      throw new DomainError(401, "Desktop authorization required.");
  },
} as TaskDesktopService;

describe("the routes of a new chat", () => {
  it("take the panel credential only, and the body that they name", async () => {
    const root = temporary();
    const feed = new BoardFeed({
      root,
      model: null,
      speech: null,
      now: () => now,
    });
    const app = createTaskApp(
      {} as TaskService,
      "o".repeat(40),
      undefined,
      undefined,
      undefined,
      undefined,
      desktop,
      undefined,
      feed,
    );
    const call = (
      method: "GET" | "POST",
      path: string,
      body?: unknown,
      credential: string | null = panel,
    ) =>
      app.request(path, {
        method,
        headers: {
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    new ChatLog(root).append(line("user", "Open Mail"));
    const words = allWords(root);
    for (const credential of [null, "x".repeat(40)]) {
      expect(
        (await call("POST", "/desktop/chat/new", {}, credential)).status,
      ).toBe(401);
      expect(
        (await call("GET", "/desktop/chat/history", undefined, credential))
          .status,
      ).toBe(401);
      expect(
        (await call("POST", "/desktop/chat/open", { id: stamp }, credential))
          .status,
      ).toBe(401);
    }
    expect(
      (await call("POST", "/desktop/chat/new", { all: true })).status,
    ).toBe(400);
    // Nothing moved for any of them.
    expect(chatFiles(root)).toEqual(["chat.jsonl"]);
    const started = await call("POST", "/desktop/chat/new", {});
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ ok: true, archived: stamp });
    expect(chatFiles(root)).toEqual([`chat-${stamp}.jsonl`]);
    expect(await (await call("GET", "/desktop/chat/history")).json()).toEqual({
      chats: [{ id: stamp, messages: 1, first: "Open Mail" }],
    });
    for (const id of ["../chat", "x", `${stamp}/../../a`])
      expect((await call("POST", "/desktop/chat/open", { id })).status).toBe(
        400,
      );
    const opened = await call("POST", "/desktop/chat/open", { id: stamp });
    expect(await opened.json()).toMatchObject({
      ok: true,
      opened: stamp,
      archived: null,
    });
    expect(chatFiles(root)).toEqual(["chat.jsonl"]);
    expect(allWords(root)).toEqual(words);
    feed.close();
  });
});

const credential = "c".repeat(48);
const fingerprint = "a".repeat(64);
/** A state folder as a desktop service leaves it: three owner-only files. */
function described(origin: string) {
  const folder = join(temporary(), "desktop");
  mkdirSync(folder, { mode: 0o700 });
  const write = (name: string, value: unknown) =>
    writeFileSync(join(folder, name), JSON.stringify(value), { mode: 0o600 });
  write("owner.lock", { pid: process.pid });
  write("desktop-service.json", {
    version: 1,
    instanceId: "instance-1",
    pid: process.pid,
    origin,
    configurationFingerprint: fingerprint,
  });
  write("desktop-panel.json", {
    version: 1,
    origin,
    token: credential,
    configurationFingerprint: fingerprint,
  });
  return folder;
}
const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
/** A made-up desktop service on a free loopback port. */
async function madeUpService(
  answer: (method: string, path: string, response: ServerResponse) => void,
) {
  const requests: { line: string; authorization: string; body: string }[] = [];
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const method = request.method ?? "";
      const path = request.url ?? "";
      requests.push({
        line: `${method} ${path}`,
        authorization: request.headers.authorization ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (method === "GET" && path === "/desktop/state")
        return json(response, 200, { version: 1, instanceId: "instance-1" });
      if (method === "GET" && path === "/desktop/chat")
        return json(response, 200, { version: 1, model: false, messages: [] });
      answer(method, path, response);
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, requests };
}
/** Runs `clawdtime chat WORDS` with a made-up system and gives what it printed. */
async function chat(env: Record<string, string | undefined>, words: string[]) {
  const lines: string[] = [];
  await agentsCli(["--supervisor", "chat", ...words], {
    system: fakeSystem({ now, env }),
    print: (printed) => lines.push(printed),
    hookScript: "/x.js",
    model: null,
  });
  return lines;
}

describe("clawdtime chat new, clear, history and open", () => {
  it("work on the files when no desktop service runs", async () => {
    const state = temporary();
    const env = { CLAWDTIME_CONFIG_HOME: state };
    expect(await chat(env, ["history"])).toEqual([
      "No chat is kept yet. clawdtime chat new puts the current chat aside.",
    ]);
    const log = new ChatLog(state);
    log.append(line("user", "Find a USB-C charger on Amazon"));
    log.append(line("assistant", "Started."));
    expect(await chat(env, ["new"])).toEqual([
      `A new chat started. The chat before it is kept as ${stamp} (clawdtime chat history). Work that runs goes on.`,
    ]);
    expect(await chat(env, ["clear"])).toEqual([
      "A new chat started. Work that runs goes on.",
    ]);
    log.append(line("user", "Read my unread messages in Slack"));
    expect(await chat(env, ["clear"])).toEqual([
      `A new chat started. The chat before it is kept as ${stamp}-2 (clawdtime chat history). Work that runs goes on.`,
    ]);
    expect(await chat(env, ["history"])).toEqual([
      `${stamp}-2  1 message  Read my unread messages in Slack`,
      `${stamp}  2 messages  Find a USB-C charger on Amazon`,
      "Open one with: clawdtime chat open TIME",
    ]);
    // The start of a time opens the one chat that has it, and the full time.
    await expect(chat(env, ["open", "20261126"])).rejects.toThrow(
      /fits 2 kept chats/,
    );
    await expect(chat(env, ["open", "20250101"])).rejects.toThrow(
      /No kept chat has the time 20250101/,
    );
    expect(await chat(env, ["open", `${stamp}-2`])).toEqual([
      `Opened the chat ${stamp}-2. Work that runs goes on.`,
    ]);
    expect(log.recent().map((message) => message.text)).toEqual([
      "Read my unread messages in Slack",
    ]);
    // The typed words, as one message, start a new chat too.
    expect(await chat(env, ["new", "chat"])).toEqual([
      `A new chat started. The chat before it is kept as ${stamp}-2 (clawdtime chat history). Work that runs goes on.`,
    ]);
    expect(log.recent()).toEqual([]);
    expect(allWords(state)).toHaveLength(3);
    for (const name of chatFiles(state))
      expect(mode(join(state, "agents", name))).toBe(0o600);
  });

  it("go to the desktop service when it runs, once, with the panel credential", async () => {
    const service = await madeUpService((method, path, response) => {
      if (method === "POST" && path === "/desktop/chat/new")
        return json(response, 200, {
          ok: true,
          archived: stamp,
          text: "A new chat started. Work that runs goes on.",
        });
      if (method === "GET" && path === "/desktop/chat/history")
        return json(response, 200, {
          chats: [{ id: stamp, messages: 4, first: "Open Mail" }],
        });
      if (method === "POST" && path === "/desktop/chat/open")
        return json(response, 200, {
          ok: false,
          archived: null,
          text: chatBusyText,
        });
      json(response, 404, {});
    });
    const state = temporary();
    const env = {
      CLAWDTIME_CONFIG_HOME: state,
      CLAWDTIME_DESKTOP_STATE: described(service.origin),
    };
    new ChatLog(state).append(line("user", "the command's own folder"));
    expect(await chat(env, ["new"])).toEqual([
      "A new chat started. Work that runs goes on.",
    ]);
    expect(await chat(env, ["history"])).toEqual([
      `${stamp}  4 messages  Open Mail`,
      "Open one with: clawdtime chat open TIME",
    ]);
    await expect(chat(env, ["open", "20261126"])).rejects.toThrow(chatBusyText);
    const reads = new Set(["GET /desktop/state", "GET /desktop/chat"]);
    expect(
      service.requests
        .map((request) => request.line)
        .filter((path) => !reads.has(path)),
    ).toEqual([
      "POST /desktop/chat/new",
      "GET /desktop/chat/history",
      "GET /desktop/chat/history",
      "POST /desktop/chat/open",
    ]);
    expect(
      service.requests.every(
        (request) => request.authorization === `Bearer ${credential}`,
      ),
    ).toBe(true);
    const posted = service.requests.filter((request) =>
      request.line.startsWith("POST"),
    );
    expect(posted.map((request) => JSON.parse(request.body))).toEqual([
      {},
      { id: stamp },
    ]);
    // The service owns the chat: the command's own files did not change.
    expect(chatFiles(state)).toEqual(["chat.jsonl"]);
  });

  it("say that no answer came, and send nothing again, when the service took the request and went silent", async () => {
    const service = await madeUpService((_method, _path, response) =>
      json(response, 500, {}),
    );
    const state = temporary();
    new ChatLog(state).append(line("user", "kept"));
    await expect(
      chat(
        {
          CLAWDTIME_CONFIG_HOME: state,
          CLAWDTIME_DESKTOP_STATE: described(service.origin),
        },
        ["clear"],
      ),
    ).rejects.toThrow(desktopChatLostText);
    expect(
      service.requests.filter((request) => request.line.startsWith("POST")),
    ).toHaveLength(1);
    expect(chatFiles(state)).toEqual(["chat.jsonl"]);
  });
});
