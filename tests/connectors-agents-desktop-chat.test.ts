import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsCli } from "../cli/agents.js";
import { desktopCli } from "../cli/task-desktop.js";
import type { ModelClient } from "../connectors/agents/brain.js";
import {
  desktopConnectMs,
  desktopLostText,
  desktopStateFolder,
  findDesktopService,
  sayToDesktop,
} from "../connectors/agents/desktop-chat.js";
import { fakeSystem } from "./connectors-agents-fixture.js";

/**
 * `clawdtime chat TEXT` and the desktop service. The service in the last test
 * is a real one, started as the desktop command starts it. A test started it,
 * so it has no jobs, no application tool and no hands: nothing here can open a
 * window or move a mouse. The other services are small made-up loopback
 * servers in this process.
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
  const path = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-chat-")));
  temporaries.push(path);
  return path;
};

/** The clock of the command in these tests. It is far from the real time, which the real service uses. */
const now = Date.UTC(2020, 0, 1, 12);
const credential = "c".repeat(48);
const fingerprint = "a".repeat(64);

/** A state folder as a desktop service leaves it: three owner-only files. */
function described(
  origin: string,
  values: {
    instanceId?: string;
    pid?: number;
    panelOrigin?: string;
    panelFingerprint?: string;
  } = {},
) {
  const folder = join(temporary(), "desktop");
  mkdirSync(folder, { mode: 0o700 });
  const write = (name: string, value: unknown) =>
    writeFileSync(join(folder, name), JSON.stringify(value), { mode: 0o600 });
  const pid = values.pid ?? process.pid;
  write("owner.lock", { pid });
  write("desktop-service.json", {
    version: 1,
    instanceId: values.instanceId ?? "instance-1",
    pid,
    origin,
    projectRoot: "/work/app",
    worker: "simulation",
    panelConfigPath: join(folder, "desktop-panel.json"),
    configurationFingerprint: fingerprint,
  });
  write("desktop-panel.json", {
    version: 1,
    desktopId: "desktop-1",
    origin: values.panelOrigin ?? origin,
    token: credential,
    projectRoot: "/work/app",
    receiptDirectory: join(folder, "receipts"),
    configurationFingerprint: values.panelFingerprint ?? fingerprint,
  });
  return folder;
}

interface Seen {
  method: string;
  path: string;
  authorization: string;
  body: string;
}
/** A made-up desktop service on a free loopback port. `answer` decides each request. */
async function madeUpService(
  answer: (
    seen: Seen,
    response: ServerResponse,
    request: IncomingMessage,
  ) => void,
) {
  const requests: Seen[] = [];
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const seen = {
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(seen);
      answer(seen, response, request);
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, requests };
}
const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
/**
 * Answers the two reads that come first: the state, as the instance that the
 * files name, and the chat, with or without a language model.
 */
const ready = (
  seen: Seen,
  response: ServerResponse,
  values: { instanceId?: string; model?: boolean } = {},
) => {
  if (seen.method === "GET" && seen.path === "/desktop/state") {
    json(response, 200, {
      version: 1,
      instanceId: values.instanceId ?? "instance-1",
    });
    return true;
  }
  if (seen.method === "GET" && seen.path === "/desktop/chat") {
    json(response, 200, {
      version: 1,
      model: values.model ?? true,
      messages: [],
    });
    return true;
  }
  return false;
};

/** The brain of the command itself. Its one answer shows that it was used. */
const localBrain = () => {
  const model: ModelClient & { complete: ReturnType<typeof vi.fn> } = {
    complete: vi.fn(async () => ({
      text: "The command answered by itself.",
      toolCalls: [],
    })),
  };
  return model;
};
/** Runs `clawdtime chat WORDS` with a made-up system and gives what it printed. */
async function chat(
  env: Record<string, string | undefined>,
  words: string[],
  model: ReturnType<typeof localBrain> | null = localBrain(),
) {
  const lines: string[] = [];
  await agentsCli(["--supervisor", "chat", ...words], {
    system: fakeSystem({ now, env }),
    print: (line) => lines.push(line),
    hookScript: "/x.js",
    model,
  });
  return { lines, model };
}
const paths = (requests: Seen[]) =>
  requests.map((seen) => `${seen.method} ${seen.path}`);

describe("where the chat command looks for the desktop service", () => {
  it("takes the named folder, or the folder desktop in the state folder", () => {
    const system = (env: Record<string, string | undefined>) => ({
      env,
      home: "/Users/tester",
    });
    expect(desktopStateFolder(system({}))).toBe(
      "/Users/tester/.local/share/clawdtime/desktop",
    );
    expect(
      desktopStateFolder(system({ CLAWDTIME_CONFIG_HOME: "/data/clawdtime" })),
    ).toBe("/data/clawdtime/desktop");
    expect(
      desktopStateFolder(
        system({
          CLAWDTIME_CONFIG_HOME: "/data/clawdtime",
          CLAWDTIME_DESKTOP_STATE: "/private/desk",
        }),
      ),
    ).toBe("/private/desk");
    // A name that is not a full path names nothing.
    expect(
      desktopStateFolder(system({ CLAWDTIME_DESKTOP_STATE: "desk" })),
    ).toBeNull();
  });

  it("never looks in the person's own folder from a command that a test runs", () => {
    const system = (env: Record<string, string | undefined>) => ({
      env,
      home: "/Users/tester",
    });
    expect(desktopStateFolder(system({ VITEST: "true" }))).toBeNull();
    expect(
      desktopStateFolder(
        system({ VITEST: "true", CLAWDTIME_CONFIG_HOME: "/data/clawdtime" }),
      ),
    ).toBeNull();
    // With the folder by name, a test can still reach the service that it started.
    expect(
      desktopStateFolder(
        system({ VITEST: "true", CLAWDTIME_DESKTOP_STATE: "/private/desk" }),
      ),
    ).toBe("/private/desk");
  });

  it("reads a service that its own owner-only files describe, and nothing else", () => {
    const origin = "http://127.0.0.1:13326";
    expect(findDesktopService(described(origin))).toEqual({
      origin,
      instanceId: "instance-1",
      token: credential,
    });
    // No folder, an empty folder.
    expect(findDesktopService(join(temporary(), "missing"))).toBeNull();
    const empty = join(temporary(), "desktop");
    mkdirSync(empty, { mode: 0o700 });
    expect(findDesktopService(empty)).toBeNull();
    // A folder or a file that another user can read.
    const open = described(origin);
    chmodSync(open, 0o755);
    expect(findDesktopService(open)).toBeNull();
    const readable = described(origin);
    chmodSync(join(readable, "desktop-panel.json"), 0o644);
    expect(findDesktopService(readable)).toBeNull();
    // A link in place of the file with the credential.
    const linked = described(origin);
    const elsewhere = join(temporary(), "panel.json");
    writeFileSync(elsewhere, readFileSync(join(linked, "desktop-panel.json")), {
      mode: 0o600,
    });
    rmSync(join(linked, "desktop-panel.json"));
    symlinkSync(elsewhere, join(linked, "desktop-panel.json"));
    expect(findDesktopService(linked)).toBeNull();
    // Files that do not agree, an address that is not this Mac, a process that is gone.
    expect(
      findDesktopService(
        described(origin, { panelOrigin: "http://127.0.0.1:13327" }),
      ),
    ).toBeNull();
    expect(
      findDesktopService(
        described(origin, { panelFingerprint: "b".repeat(64) }),
      ),
    ).toBeNull();
    expect(
      findDesktopService(described("http://192.168.1.20:13326")),
    ).toBeNull();
    expect(findDesktopService(described("https://127.0.0.1:13326"))).toBeNull();
    expect(findDesktopService(described(origin), () => false)).toBeNull();
    const noOwner = described(origin);
    rmSync(join(noOwner, "owner.lock"));
    expect(findDesktopService(noOwner)).toBeNull();
    const otherOwner = described(origin);
    writeFileSync(
      join(otherOwner, "owner.lock"),
      JSON.stringify({ pid: process.pid + 1 }),
      { mode: 0o600 },
    );
    expect(findDesktopService(otherOwner)).toBeNull();
  });
});

describe("clawdtime chat TEXT with a desktop service", () => {
  const own = "The command answered by itself.";

  it("hands the text to the service once, with the panel credential, and prints its answer", async () => {
    const service = await madeUpService((seen, response) => {
      if (ready(seen, response)) return;
      json(response, 200, {
        reply: {
          role: "assistant",
          text: "  Started. I look at the screen.  ",
          at: now,
          via: "chat",
        },
      });
    });
    const state = temporary();
    const { lines, model } = await chat(
      {
        CLAWDTIME_CONFIG_HOME: state,
        CLAWDTIME_DESKTOP_STATE: described(service.origin),
      },
      ["click", "the", "blue", "Send", "button"],
    );
    expect(lines).toEqual(["Started. I look at the screen."]);
    expect(paths(service.requests)).toEqual([
      "GET /desktop/state",
      "GET /desktop/chat",
      "POST /desktop/chat",
    ]);
    expect(
      service.requests.every(
        (seen) => seen.authorization === `Bearer ${credential}`,
      ),
    ).toBe(true);
    expect(JSON.parse(service.requests[2]!.body)).toEqual({
      text: "click the blue Send button",
    });
    // The command's own brain did nothing, and kept no line of the conversation.
    expect(model!.complete).not.toHaveBeenCalled();
    expect(existsSync(join(state, "agents", "chat.jsonl"))).toBe(false);
    // The credential is in nothing that was printed.
    expect(lines.join("\n")).not.toContain(credential);
  });

  it("finds the service in the folder desktop of the state folder, with no name given", async () => {
    const service = await madeUpService((seen, response) => {
      if (ready(seen, response)) return;
      json(response, 200, {
        reply: { role: "assistant", text: "From the service." },
      });
    });
    const folder = described(service.origin);
    const { lines, model } = await chat(
      { CLAWDTIME_CONFIG_HOME: dirname(folder) },
      ["what needs me?"],
    );
    expect(lines).toEqual(["From the service."]);
    expect(model!.complete).not.toHaveBeenCalled();
  });

  it("cuts the text at 2000 characters, as the route takes it", async () => {
    const service = await madeUpService((seen, response) => {
      if (ready(seen, response)) return;
      json(response, 200, { reply: { role: "assistant", text: "Taken." } });
    });
    const system = {
      env: { CLAWDTIME_DESKTOP_STATE: described(service.origin) },
      home: "/Users/tester",
    };
    expect(await sayToDesktop(system, "x".repeat(2500))).toEqual({
      kind: "answered",
      text: "Taken.",
    });
    expect(JSON.parse(service.requests[2]!.body).text).toHaveLength(2000);
    // Words that are empty go nowhere.
    expect(await sayToDesktop(system, "   ")).toEqual({ kind: "absent" });
    expect(service.requests).toHaveLength(3);
  });

  it("never takes an option of the command for a message", async () => {
    const service = await madeUpService((seen, response) => {
      if (ready(seen, response)) return;
      json(response, 200, { reply: { role: "assistant", text: "Taken." } });
    });
    for (const words of [["--recent", "12"], ["-x"], ["--help"]])
      await chat(
        {
          CLAWDTIME_CONFIG_HOME: temporary(),
          CLAWDTIME_DESKTOP_STATE: described(service.origin),
        },
        words,
      );
    expect(service.requests).toEqual([]);
  });

  it("answers by itself when no service is described", async () => {
    const state = temporary();
    const { lines, model } = await chat({ CLAWDTIME_CONFIG_HOME: state }, [
      "hello there",
    ]);
    expect(lines).toEqual([own]);
    expect(model!.complete).toHaveBeenCalledTimes(1);
    expect(existsSync(join(state, "agents", "chat.jsonl"))).toBe(true);
  });

  it("answers by itself when the service does not answer its first read within 2 seconds", async () => {
    expect(desktopConnectMs).toBe(2000);
    // This service takes the connection and never answers.
    const silent = await madeUpService(() => {});
    const started = Date.now();
    const { lines, model } = await chat(
      {
        CLAWDTIME_CONFIG_HOME: temporary(),
        CLAWDTIME_DESKTOP_STATE: described(silent.origin),
      },
      ["hello there"],
    );
    const took = Date.now() - started;
    expect(lines).toEqual([own]);
    expect(model!.complete).toHaveBeenCalledTimes(1);
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(6000);
    // Only the first read went out. The message itself never left.
    expect(paths(silent.requests)).toEqual(["GET /desktop/state"]);
  }, 15000);

  it("gives both first reads 2 seconds together, not 2 seconds each", async () => {
    // The state comes at once. The chat never comes.
    const half = await madeUpService((seen, response) => {
      if (seen.path === "/desktop/state") ready(seen, response);
    });
    const started = Date.now();
    expect(
      await sayToDesktop(
        {
          env: { CLAWDTIME_DESKTOP_STATE: described(half.origin) },
          home: "/Users/tester",
        },
        "hello there",
        { connectMs: 300 },
      ),
    ).toEqual({ kind: "absent" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(paths(half.requests)).toEqual([
      "GET /desktop/state",
      "GET /desktop/chat",
    ]);
  });

  it("answers by itself when nothing listens at the address, when the read is refused, and when another instance answers", async () => {
    // A port that was free a moment ago: the connection is refused at once.
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const free = (probe.address() as AddressInfo).port;
    await new Promise((done) => probe.close(done));
    const closed = await chat(
      {
        CLAWDTIME_CONFIG_HOME: temporary(),
        CLAWDTIME_DESKTOP_STATE: described(`http://127.0.0.1:${free}`),
      },
      ["hello there"],
    );
    expect(closed.lines).toEqual([own]);
    const refusing = await madeUpService((_seen, response) =>
      json(response, 401, { error: "Desktop authorization required." }),
    );
    const refused = await chat(
      {
        CLAWDTIME_CONFIG_HOME: temporary(),
        CLAWDTIME_DESKTOP_STATE: described(refusing.origin),
      },
      ["hello there"],
    );
    expect(refused.lines).toEqual([own]);
    expect(refusing.requests).toHaveLength(1);
    const other = await madeUpService((seen, response) => {
      ready(seen, response, { instanceId: "another-instance" });
    });
    const mismatch = await chat(
      {
        CLAWDTIME_CONFIG_HOME: temporary(),
        CLAWDTIME_DESKTOP_STATE: described(other.origin),
      },
      ["hello there"],
    );
    expect(mismatch.lines).toEqual([own]);
    expect(paths(other.requests)).toEqual(["GET /desktop/state"]);
  });

  it("answers by itself when the service has no chat, and the message never leaves", async () => {
    const boardOff = await madeUpService((seen, response) => {
      if (seen.path === "/desktop/state") return void ready(seen, response);
      json(response, 404, {});
    });
    const { lines, model } = await chat(
      {
        CLAWDTIME_CONFIG_HOME: temporary(),
        CLAWDTIME_DESKTOP_STATE: described(boardOff.origin),
      },
      ["hello there"],
    );
    expect(lines).toEqual([own]);
    expect(model!.complete).toHaveBeenCalledTimes(1);
    expect(paths(boardOff.requests)).toEqual([
      "GET /desktop/state",
      "GET /desktop/chat",
    ]);
  });

  it("answers by itself when the service has no language model and the command has one", async () => {
    const plain = await madeUpService((seen, response) => {
      if (ready(seen, response, { model: false })) return;
      json(response, 200, {
        reply: { role: "assistant", text: "A plain answer of the service." },
      });
    });
    const env = () => ({
      CLAWDTIME_CONFIG_HOME: temporary(),
      CLAWDTIME_DESKTOP_STATE: described(plain.origin),
    });
    // The command has a language model: it answers better than a service that only tells the state.
    const smart = await chat(env(), ["what is the worst bug today?"]);
    expect(smart.lines).toEqual([own]);
    expect(smart.model!.complete).toHaveBeenCalledTimes(1);
    expect(plain.requests.filter((seen) => seen.method === "POST")).toEqual([]);
    // The command has none either: the service has the task, so it answers.
    const none = await chat(env(), ["how is the task?"], null);
    expect(none.lines).toEqual(["A plain answer of the service."]);
    expect(
      plain.requests.filter((seen) => seen.method === "POST"),
    ).toHaveLength(1);
  });

  it("says that no answer came, and does not say the message again, when the service took it and went silent", async () => {
    // The connection ends in the middle of the answer.
    const dropping = await madeUpService((seen, response, request) => {
      if (ready(seen, response)) return;
      request.socket.destroy();
    });
    const dropped = await chat(
      {
        CLAWDTIME_CONFIG_HOME: temporary(),
        CLAWDTIME_DESKTOP_STATE: described(dropping.origin),
      },
      ["click the blue Send button"],
    );
    expect(dropped.lines).toEqual([desktopLostText]);
    // Exactly one message went out, and the command's own brain did not act on it.
    expect(
      dropping.requests.filter((seen) => seen.method === "POST"),
    ).toHaveLength(1);
    expect(dropped.model!.complete).not.toHaveBeenCalled();
    // The answer takes too long.
    const slow = await madeUpService((seen, response) => {
      ready(seen, response);
    });
    const system = {
      env: { CLAWDTIME_DESKTOP_STATE: described(slow.origin) },
      home: "/Users/tester",
    };
    expect(
      await sayToDesktop(system, "scroll down in Slack", { answerMs: 100 }),
    ).toEqual({ kind: "lost", text: desktopLostText });
    expect(slow.requests.filter((seen) => seen.method === "POST")).toHaveLength(
      1,
    );
    // An answer that the service refuses, or one of another shape.
    for (const reply of [
      (response: ServerResponse) => json(response, 400, { error: "Refused." }),
      (response: ServerResponse) => json(response, 404, {}),
      (response: ServerResponse) => json(response, 200, { reply: null }),
      (response: ServerResponse) =>
        json(response, 200, { reply: { role: "assistant", text: "" } }),
    ]) {
      const odd = await madeUpService((seen, response) => {
        if (ready(seen, response)) return;
        reply(response);
      });
      expect(
        await sayToDesktop(
          {
            env: { CLAWDTIME_DESKTOP_STATE: described(odd.origin) },
            home: "/Users/tester",
          },
          "scroll down in Slack",
        ),
      ).toEqual({ kind: "lost", text: desktopLostText });
    }
  });
});

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return port;
}
async function closeOwned(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timeout);
}

it("real desktop service answers clawdtime chat TEXT, and the command answers by itself again when the service is gone", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const folder = temporary();
  const panel = join(folder, "fake-panel");
  // This tiny test executable exits immediately. It opens no native UI.
  writeFileSync(panel, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const children: ChildProcess[] = [];
  const spawnOwned = ((command: string, args: string[], options: object) => {
    const child = spawn(command, args, options);
    children.push(child);
    return child;
  }) as typeof spawn;
  // The service keeps its state in the folder desktop of the state folder, as
  // the installed one does.
  const serviceState = join(folder, "service-state");
  const desk = join(serviceState, "desktop");
  const project = join(folder, "project");
  mkdirSync(serviceState, { mode: 0o700 });
  mkdirSync(desk, { mode: 0o700 });
  mkdirSync(project, { mode: 0o700 });
  const previous = {
    CLAWDTIME_CONFIG_HOME: process.env.CLAWDTIME_CONFIG_HOME,
    CLAWDTIME_OPENAI_API_KEY: process.env.CLAWDTIME_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  process.env.CLAWDTIME_CONFIG_HOME = serviceState;
  // No language model key reaches this service: its answers are the plain ones.
  delete process.env.CLAWDTIME_OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  // The service knows from this that a test started it.
  expect(process.env.VITEST).toBeTruthy();
  try {
    const port = await unusedPort();
    await desktopCli(
      [
        "--state",
        desk,
        "--project",
        project,
        "--port",
        String(port),
        "--panel-binary",
        panel,
      ],
      {
        root,
        spawn: spawnOwned,
        print: () => {},
        startupMs: 10000,
        pollMs: 50,
      },
    );
    const { token } = JSON.parse(
      readFileSync(join(desk, "desktop-panel.json"), "utf8"),
    ) as { token: string };
    const read = async (path: string) =>
      (
        await fetch(`http://127.0.0.1:${port}${path}`, {
          headers: { authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(3000),
        })
      ).json();
    type Kept = {
      model: boolean;
      messages: { role: string; text: string; via: string; at: number }[];
    };
    const kept = async () => (await read("/desktop/chat")) as Kept;
    // A service that a test started has no hands and no engine for computer work.
    expect(await read("/desktop/computer")).toMatchObject({
      enabled: false,
      message: "Computer use does not run in a service that a test started.",
    });
    expect(await read("/desktop/hands/next?after=0")).toMatchObject({
      command: null,
      run: { active: false },
    });
    expect(await kept()).toMatchObject({ model: false, messages: [] });

    // The folder by name, from a command with another state folder of its
    // own. Neither side has a language model, so the service answers.
    const commandState = temporary();
    const named = await chat(
      { CLAWDTIME_CONFIG_HOME: commandState, CLAWDTIME_DESKTOP_STATE: desk },
      ["what", "needs", "me?"],
      null,
    );
    expect(named.lines).toHaveLength(1);
    // The command kept no line: the conversation is the service's.
    expect(existsSync(join(commandState, "agents", "chat.jsonl"))).toBe(false);
    const first = await kept();
    expect(first.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(first.messages[0]).toMatchObject({
      text: "what needs me?",
      via: "chat",
    });
    // What the command printed is the answer of the service, word for word.
    expect(named.lines[0]).toBe(first.messages[1]!.text);
    expect(named.lines[0]).not.toContain(token);

    // With no name: the folder desktop in the state folder. The lines have
    // the time of the service, not the made-up time of the command.
    const found = await chat(
      { CLAWDTIME_CONFIG_HOME: serviceState },
      ["how is the task?"],
      null,
    );
    const second = await kept();
    expect(second.messages).toHaveLength(4);
    expect(second.messages[2]).toMatchObject({ text: "how is the task?" });
    expect(found.lines).toEqual([second.messages[3]!.text]);
    for (const message of second.messages)
      expect(Math.abs(message.at - Date.now())).toBeLessThan(120_000);

    // A UI request starts nothing in this service, and no command waits for hands.
    const ui = await chat(
      { CLAWDTIME_CONFIG_HOME: serviceState },
      ["click the blue Send button"],
      null,
    );
    expect(ui.lines).toHaveLength(1);
    expect(ui.lines[0]).not.toMatch(/^Started\./);
    expect((await kept()).messages).toHaveLength(6);
    expect(await read("/desktop/hands/next?after=0")).toMatchObject({
      command: null,
      run: { active: false },
    });

    // A command with a language model of its own keeps the message: this
    // service could only tell the state.
    const smart = await chat(
      { CLAWDTIME_CONFIG_HOME: commandState, CLAWDTIME_DESKTOP_STATE: desk },
      ["hello there"],
    );
    expect(smart.lines).toEqual(["The command answered by itself."]);
    expect((await kept()).messages).toHaveLength(6);

    // A command that a test runs, with no folder by name, stays with itself.
    const guarded = await chat(
      { CLAWDTIME_CONFIG_HOME: temporary(), VITEST: "true" },
      ["hello there"],
    );
    expect(guarded.lines).toEqual(["The command answered by itself."]);
    expect(guarded.model!.complete).toHaveBeenCalledTimes(1);

    // The service stops. The command answers by itself again.
    await Promise.all(children.map(closeOwned));
    const after = await chat(
      { CLAWDTIME_CONFIG_HOME: temporary(), CLAWDTIME_DESKTOP_STATE: desk },
      ["hello there"],
    );
    expect(after.lines).toEqual(["The command answered by itself."]);
    expect(after.model!.complete).toHaveBeenCalledTimes(1);
  } finally {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await Promise.all(children.map(closeOwned));
  }
}, 60000);
