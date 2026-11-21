import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopCli } from "../cli/task-desktop.js";
import {
  ComputerJournal,
  setComputerSwitch,
} from "../connectors/computer/journal.js";
import { PanelHands } from "../connectors/computer/panel-hands.js";
import {
  handsNextSchema,
  type Action,
  type HandsNext,
} from "../connectors/computer/ports.js";
import {
  buildComputer,
  computerPort,
  offComputerPort,
} from "../connectors/computer/service.js";
import {
  ComputerWorker,
  computerStatusSchema,
  offText,
  stoppedText,
} from "../connectors/computer/worker.js";
import { createTaskApp } from "../src/control/task-app.js";
import type { DesktopExecutor } from "../src/control/desktop-executor.js";
import type { TaskDesktopService } from "../src/control/task-desktop-service.js";
import type { TaskService } from "../src/control/task-service.js";
import { DomainError } from "../src/storage/security.js";
import {
  element,
  observation,
  ScriptedPlanner,
  until,
} from "./connectors-computer-fixture.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

const panel = "p".repeat(40);
const desktop = {
  authorizePanel(value: string) {
    if (value !== panel)
      throw new DomainError(401, "Desktop authorization required.");
  },
} as TaskDesktopService;

/** The real routes over a real worker. The hands are the ones that the panel serves. */
function fixture(
  script: ConstructorParameters<typeof ScriptedPlanner>[0],
  executor?: DesktopExecutor,
) {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-computer-routes-"));
  roots.push(home);
  const hands = new PanelHands({ first: 1, timeoutMs: 5000 });
  const said: string[] = [];
  const worker = new ComputerWorker({
    hands,
    planner: new ScriptedPlanner(script),
    journal: new ComputerJournal(home),
    notify: (text) => said.push(text),
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
    undefined,
    executor,
    computerPort(worker, hands),
  );
  const get = (path: string, token = panel, origin?: string) =>
    app.request(path, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(origin ? { origin } : {}),
      },
    });
  const post = (path: string, body: unknown, token = panel) =>
    app.request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const next = async (after: number) =>
    handsNextSchema.parse(
      await (await get(`/desktop/hands/next?after=${after}`)).json(),
    );
  /** A stand-in for the panel: it takes each command once and posts a made-up result. */
  const seen = observation([element(1, { title: "Save" })]);
  const served: HandsNext["command"][] = [];
  let last = 0;
  const serve = async (until: () => boolean) => {
    for (let turn = 0; turn < 400 && !until(); turn++) {
      const { command } = await next(last);
      if (!command) {
        await new Promise((done) => setTimeout(done, 2));
        continue;
      }
      served.push(command);
      last = command.seq;
      const posted = await post("/desktop/hands/result", {
        seq: command.seq,
        ok: true,
        ...(command.command.kind === "observe"
          ? {
              observation: command.command.image
                ? seen
                : {
                    ...seen,
                    image: undefined,
                    imageWidth: undefined,
                    imageHeight: undefined,
                  },
            }
          : {}),
      });
      expect(await posted.json()).toEqual({ ok: true });
    }
  };
  return { home, hands, worker, said, app, get, post, next, serve, served };
}
const click: Action = { kind: "click_element", element: 1 };
const done: Action = { kind: "done", summary: "Saved." };

describe("the routes of computer use", () => {
  it("serve one whole task to the panel: next, result, and the state", async () => {
    const f = fixture([click, done]);
    const idle = await f.get("/desktop/computer");
    expect(idle.status).toBe(200);
    expect(computerStatusSchema.parse(await idle.json())).toMatchObject({
      enabled: true,
      state: "idle",
      step: 0,
      goal: "",
      question: null,
    });
    expect(await f.next(0)).toEqual({
      version: 1,
      command: null,
      run: { active: false, goal: "", step: 0, state: "idle" },
    });
    await f.worker.submit("talk_1_execution", "Save the note");
    const first = await f.next(0);
    expect(first).toEqual({
      version: 1,
      command: {
        seq: 1,
        command: { kind: "observe", image: true, elements: true },
        label: "Look at the screen",
      },
      run: { active: true, goal: "Save the note", step: 0, state: "running" },
    });
    // The same command is served again until its result arrives.
    expect(await f.next(0)).toEqual(first);
    // A panel that already ran number 1 is not given it again.
    expect((await f.next(1)).command).toBeNull();
    await f.serve(() => f.worker.snapshot().state === "completed");
    expect(f.served.map((item) => item!.command.kind)).toEqual([
      "observe",
      "observe",
      "click",
      "observe",
    ]);
    expect(f.served.map((item) => item!.seq)).toEqual([1, 2, 3, 4]);
    expect(f.served[2]).toMatchObject({
      command: { kind: "click", x: 150, y: 212, button: "left", count: 1 },
      label: 'Click "Save"',
    });
    expect(
      computerStatusSchema.parse(
        await (await f.get("/desktop/computer")).json(),
      ),
    ).toMatchObject({
      enabled: true,
      state: "completed",
      message: "Done. Saved.",
      goal: "Save the note",
      question: null,
    });
    expect((await f.next(4)).run).toEqual({
      active: false,
      goal: "",
      step: 0,
      state: "idle",
    });
    expect(f.said).toEqual(["Done. Saved."]);
  });

  it("show the question that the worker asks", async () => {
    const f = fixture([click, done]);
    await f.worker.submit("r1", "Send the mail");
    // This panel shows a button that needs a yes.
    const { command } = await f.next(0);
    await f.post("/desktop/hands/result", {
      seq: command!.seq,
      ok: true,
      observation: observation([element(1, { title: "Send" })]),
    });
    await until(() => f.worker.snapshot().state === "waiting_for_person");
    const status = computerStatusSchema.parse(
      await (await f.get("/desktop/computer")).json(),
    );
    expect(status).toMatchObject({
      state: "waiting_for_person",
      step: 1,
      goal: "Send the mail",
    });
    expect(status.question).toMatch(/^Click "Send"\?/);
    expect(status.message).toBe(status.question);
    expect((await f.next(command!.seq)).run.state).toBe("waiting_for_person");
    f.worker.stop();
  });

  it("refuse every route without the panel credential, and a browser origin", async () => {
    const f = fixture([click]);
    await f.worker.submit("r1", "Save the note");
    for (const token of ["", "x".repeat(40), "o".repeat(40)]) {
      expect((await f.get("/desktop/hands/next?after=0", token)).status).toBe(
        401,
      );
      expect((await f.get("/desktop/computer", token)).status).toBe(401);
      expect(
        (await f.post("/desktop/hands/result", { seq: 1, ok: true }, token))
          .status,
      ).toBe(401);
      expect((await f.post("/desktop/execution/stop", {}, token)).status).toBe(
        401,
      );
    }
    // Nothing above reached the worker: its first command still waits, and it still runs.
    expect((await f.next(0)).command?.seq).toBe(1);
    expect(f.worker.snapshot().state).toBe("running");
    expect(
      (await f.get("/desktop/computer", panel, "https://example.com")).status,
    ).toBe(403);
    expect(
      (await f.get("/desktop/hands/next?after=0", panel, "https://example.com"))
        .status,
    ).toBe(403);
    f.worker.stop();
  });

  it("refuse a result of another shape, ignore one for another number, and take `after` as a number only", async () => {
    const f = fixture([click]);
    await f.worker.submit("r1", "Save the note");
    const { command } = await f.next(0);
    for (const body of [
      "{",
      {},
      { seq: 1 },
      { seq: 1, ok: true, extra: 1 },
      { seq: 1, ok: false, error: "exploded" },
      { seq: 1, ok: true, observation: { at: 1 } },
    ])
      expect((await f.post("/desktop/hands/result", body)).status).toBe(400);
    const other = await f.post("/desktop/hands/result", { seq: 99, ok: true });
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ ok: false });
    expect((await f.next(0)).command).toEqual(command);
    for (const after of ["abc", "-1", "1.5", "1e3", "9".repeat(30), ""])
      expect((await f.get(`/desktop/hands/next?after=${after}`)).status).toBe(
        400,
      );
    // With no `after` the panel has run nothing yet.
    expect(
      handsNextSchema.parse(await (await f.get("/desktop/hands/next")).json())
        .command,
    ).toEqual(command);
    f.worker.stop();
  });

  it("take a result with a picture of up to 6 MB, on that route only and only with the credential", async () => {
    const f = fixture([done]);
    await f.worker.submit("r1", "Look");
    const { command } = await f.next(0);
    const picture = "A".repeat(3_900_000);
    const body = JSON.stringify({
      seq: command!.seq,
      ok: true,
      observation: observation([], { image: picture }),
    });
    expect(body.length).toBeGreaterThan(3_900_000);
    // With another credential the body is refused before it is read.
    expect(
      (await f.post("/desktop/hands/result", body, "x".repeat(40))).status,
    ).toBe(401);
    const taken = await f.post("/desktop/hands/result", body);
    expect(taken.status).toBe(200);
    expect(await taken.json()).toEqual({ ok: true });
    await f.worker.idle();
    expect(f.worker.snapshot().state).toBe("completed");
    // More than 6 MB is refused, here as well.
    const large = JSON.stringify({
      seq: 5,
      ok: true,
      pad: "A".repeat(6_400_000),
    });
    expect((await f.post("/desktop/hands/result", large)).status).toBe(400);
    // The credential is checked first: another credential learns nothing of the limit.
    expect(
      (await f.post("/desktop/hands/result", large, "x".repeat(40))).status,
    ).toBe(401);
    // Every other route keeps its small limit.
    expect(
      (await f.post("/desktop/execution/stop", { pad: "A".repeat(40_000) }))
        .status,
    ).toBe(400);
  });

  it("stop this worker through the existing stop route, and take back a command that the panel has not fetched", async () => {
    const f = fixture([click, click, done]);
    await f.worker.submit("r1", "Save the note");
    // The panel has not asked yet: the first command only waits.
    const stopped = await f.post("/desktop/execution/stop", {});
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({
      execution: { configured: true, canStop: false, message: stoppedText },
    });
    await f.worker.idle();
    expect(f.worker.snapshot()).toMatchObject({
      state: "canceled",
      message: stoppedText,
    });
    // The command was taken back: a panel that asks now gets nothing to run.
    expect(await f.next(0)).toEqual({
      version: 1,
      command: null,
      run: { active: false, goal: "", step: 0, state: "idle" },
    });
    expect(
      (await (await f.get("/desktop/computer")).json()) as { state: string },
    ).toMatchObject({ state: "canceled", message: stoppedText });
  });

  it("stop after an action that the panel already has: its result is awaited, and nothing follows it", async () => {
    const f = fixture([click, click, done]);
    await f.worker.submit("r1", "Save the note");
    // The panel takes commands until the click is in its hands.
    await f.serve(() => f.served.length === 2);
    await until(() => f.hands.next(0) !== null);
    const { command } = await f.next(2);
    expect(command?.command.kind).toBe("click");
    const stopped = (await (
      await f.post("/desktop/execution/stop", {})
    ).json()) as { execution: { state: string; message: string } };
    expect(stopped.execution).toMatchObject({
      state: "stopping",
      message: stoppedText,
    });
    // The click is still served: the panel may be in the middle of it.
    expect((await f.next(2)).command).toEqual(command);
    expect((await f.next(2)).run).toMatchObject({
      active: true,
      state: "stopping",
    });
    await f.post("/desktop/hands/result", { seq: command!.seq, ok: true });
    await f.worker.idle();
    expect(f.worker.snapshot().state).toBe("canceled");
    expect((await f.next(command!.seq)).command).toBeNull();
  });

  it("keep the stop route of an existing chat connection when both are there", async () => {
    const executor = {
      stop: vi.fn(() => ({
        configured: true,
        state: "canceled",
        canStop: false,
        message: "Stopped before the agent claimed the request.",
      })),
      command: vi.fn(),
    } as unknown as DesktopExecutor;
    const f = fixture([click], executor);
    expect(
      await (await f.post("/desktop/execution/stop", {})).json(),
    ).toMatchObject({
      execution: { message: "Stopped before the agent claimed the request." },
    });
    expect(executor.stop).toHaveBeenCalledTimes(1);
  });
});

describe("computer use that is off", () => {
  it("answers the panel with nothing to do, and has no stop route of its own", async () => {
    const app = createTaskApp(
      {} as TaskService,
      "o".repeat(40),
      undefined,
      undefined,
      undefined,
      undefined,
      desktop,
      undefined,
      undefined,
      undefined,
      offComputerPort(offText),
    );
    const headers = {
      authorization: `Bearer ${panel}`,
      "content-type": "application/json",
    };
    const status = await app.request("/desktop/computer", { headers });
    expect(computerStatusSchema.parse(await status.json())).toEqual({
      version: 1,
      enabled: false,
      state: "idle",
      message: offText,
      step: 0,
      goal: "",
      question: null,
    });
    expect(
      handsNextSchema.parse(
        await (
          await app.request("/desktop/hands/next?after=0", { headers })
        ).json(),
      ),
    ).toEqual({
      version: 1,
      command: null,
      run: { active: false, goal: "", step: 0, state: "idle" },
    });
    const posted = await app.request("/desktop/hands/result", {
      method: "POST",
      headers,
      body: JSON.stringify({ seq: 1, ok: true }),
    });
    expect(await posted.json()).toEqual({ ok: false });
    expect(
      (
        await app.request("/desktop/execution/stop", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
    ).toBe(404);
    expect(
      (await app.request("/desktop/computer", { headers: {} })).status,
    ).toBe(401);
  });

  it("has no routes at all in a service that was given no port", async () => {
    const app = createTaskApp(
      {} as TaskService,
      "o".repeat(40),
      undefined,
      undefined,
      undefined,
      undefined,
      desktop,
    );
    const headers = { authorization: `Bearer ${panel}` };
    for (const path of ["/desktop/computer", "/desktop/hands/next?after=0"])
      expect((await app.request(path, { headers })).status).toBe(404);
  });
});

describe("how the service builds computer use", () => {
  const home = () => {
    const path = mkdtempSync(join(tmpdir(), "clawdtime-computer-build-"));
    roots.push(path);
    return path;
  };
  it("is off by default, with or without a key", () => {
    const built = buildComputer({ root: home(), env: { OPENAI_API_KEY: "k" } });
    expect(built.worker).toBeNull();
    expect(built.port.status()).toMatchObject({
      enabled: false,
      message: offText,
    });
    expect(built.port.stop).toBeUndefined();
  });
  it("needs a key for the language model when it is on", () => {
    const root = home();
    setComputerSwitch(root, true);
    const built = buildComputer({ root, env: {} });
    expect(built.worker).toBeNull();
    expect(built.port.status()).toMatchObject({ enabled: false });
    expect(built.port.status().message).toMatch(
      /CLAWDTIME_OPENAI_API_KEY or OPENAI_API_KEY/,
    );
  });
  it("builds the worker when it is on and a key is there, and the switch stops it again", () => {
    const root = home();
    setComputerSwitch(root, true);
    const built = buildComputer({
      root,
      env: { CLAWDTIME_OPENAI_API_KEY: "k" },
    });
    expect(built.worker).not.toBeNull();
    expect(built.port.status()).toMatchObject({ enabled: true, state: "idle" });
    expect(built.worker!.snapshot()).toMatchObject({
      configured: true,
      state: "idle",
      canStop: false,
    });
    expect(built.port.stop?.().state).toBe("idle");
    // Off takes hold at once, with no restart.
    setComputerSwitch(root, false);
    expect(built.port.status()).toMatchObject({
      enabled: false,
      message: offText,
    });
    expect(built.worker!.snapshot().configured).toBe(false);
  });
  it("is not built where the service says that it may not run", () => {
    const root = home();
    setComputerSwitch(root, true);
    const built = buildComputer({
      root,
      env: { OPENAI_API_KEY: "k" },
      unavailable: "An existing chat connection does the computer work here.",
    });
    expect(built.worker).toBeNull();
    expect(built.port.status()).toMatchObject({
      enabled: false,
      message: "An existing chat connection does the computer work here.",
    });
  });
  it("marks a request that was running at start as uncertain", () => {
    const root = home();
    setComputerSwitch(root, true);
    new ComputerJournal(root).open("r1", "Pay the invoice");
    const built = buildComputer({ root, env: { OPENAI_API_KEY: "k" } });
    expect(built.port.status()).toMatchObject({
      enabled: true,
      state: "uncertain",
      goal: "Pay the invoice",
    });
  });
});

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Synthetic port unavailable");
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}
async function closeOwned(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timeout);
}

/** What a service that a test started says about computer use. */
const testServiceText =
  "Computer use does not run in a service that a test started.";

it("real desktop service that a test started has no worker and no hands, whatever the switch and the key say", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const temporary = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-computer-service-")),
  );
  const panelBinary = join(temporary, "fake-panel");
  // This tiny test executable exits immediately. It opens no native UI.
  writeFileSync(panelBinary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const children: ChildProcess[] = [];
  const spawnOwned = ((command: string, args: string[], options: object) => {
    const child = spawn(command, args, options);
    children.push(child);
    return child;
  }) as typeof spawn;
  /** Starts one real service on a free port, with its own state folder. */
  const start = async (name: string, key: string | null) => {
    const project = join(temporary, `${name}-project`);
    const state = join(temporary, `${name}-private`);
    mkdirSync(project, { mode: 0o700 });
    mkdirSync(state, { mode: 0o700 });
    process.env.CLAWDTIME_CONFIG_HOME = join(temporary, `${name}-state`);
    // The key is never used here: no request reaches the planner or the chat.
    if (key) process.env.CLAWDTIME_OPENAI_API_KEY = key;
    else delete process.env.CLAWDTIME_OPENAI_API_KEY;
    const port = await unusedPort();
    await desktopCli(
      [
        "--state",
        state,
        "--project",
        project,
        "--port",
        String(port),
        "--panel-binary",
        panelBinary,
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
      readFileSync(join(state, "desktop-panel.json"), "utf8"),
    );
    return (path: string, init: RequestInit = {}, credential = token) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
  };
  const previous = {
    CLAWDTIME_CONFIG_HOME: process.env.CLAWDTIME_CONFIG_HOME,
    CLAWDTIME_OPENAI_API_KEY: process.env.CLAWDTIME_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  delete process.env.OPENAI_API_KEY;
  const other = "x".repeat(64);
  // The service knows that a test started it by this name in its environment.
  expect(process.env.VITEST).toBeTruthy();
  try {
    const post = (
      request: Awaited<ReturnType<typeof start>>,
      path: string,
      body: unknown,
      credential?: string,
    ) =>
      request(path, { method: "POST", body: JSON.stringify(body) }, credential);
    /** No worker, no command for the hands, no stop route, nothing in the chat. */
    const hasNoHands = async (request: Awaited<ReturnType<typeof start>>) => {
      expect(
        computerStatusSchema.parse(
          await (await request("/desktop/computer")).json(),
        ),
      ).toEqual({
        version: 1,
        enabled: false,
        state: "idle",
        message: testServiceText,
        step: 0,
        goal: "",
        question: null,
      });
      expect(
        handsNextSchema.parse(
          await (await request("/desktop/hands/next?after=0")).json(),
        ),
      ).toEqual({
        version: 1,
        command: null,
        run: { active: false, goal: "", step: 0, state: "idle" },
      });
      const late = await post(request, "/desktop/hands/result", {
        seq: 1,
        ok: true,
      });
      expect(late.status).toBe(200);
      expect(await late.json()).toEqual({ ok: false });
      expect(
        (await post(request, "/desktop/hands/result", { seq: 1, ok: "yes" }))
          .status,
      ).toBe(400);
      expect((await post(request, "/desktop/execution/stop", {})).status).toBe(
        404,
      );
      expect(
        (
          (await (await request("/desktop/chat")).json()) as {
            execution?: unknown;
          }
        ).execution,
      ).toBeUndefined();
      // Another credential reaches none of it.
      expect((await request("/desktop/computer", {}, other)).status).toBe(401);
      expect(
        (await request("/desktop/hands/next?after=0", {}, other)).status,
      ).toBe(401);
      expect(
        (
          await post(
            request,
            "/desktop/hands/result",
            { seq: 1, ok: true },
            other,
          )
        ).status,
      ).toBe(401);
    };

    // The switch is on and a key is there. Outside a test this service would
    // have a worker. Here it has none, and a request that was running before
    // this start is left as it was: nothing of the record is touched.
    const onState = join(temporary, "on-state");
    setComputerSwitch(onState, true);
    const journal = new ComputerJournal(onState);
    journal.open("talk_before_execution", "Pay the invoice");
    const on = await start("on", "test-key-that-is-never-sent");
    await hasNoHands(on);
    expect(journal.get("talk_before_execution")).toMatchObject({
      state: "running",
      steps: [],
    });

    // The switch was never turned on.
    await hasNoHands(await start("off", "test-key-that-is-never-sent"));

    // On, with no key for the language model. This service has no language
    // model at all, so a message costs nothing: one that asks for work on the
    // screen starts no computer task, and no command waits after it.
    setComputerSwitch(join(temporary, "nokey-state"), true);
    const nokey = await start("nokey", null);
    await hasNoHands(nokey);
    const said = (await (
      await post(nokey, "/desktop/chat", { text: "click the blue Send button" })
    ).json()) as { reply: { text: string } };
    expect(said.reply.text.length).toBeGreaterThan(0);
    expect(said.reply.text).not.toMatch(/^Started\./);
    await hasNoHands(nokey);
  } finally {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await Promise.all(children.map(closeOwned));
    rmSync(temporary, { recursive: true, force: true });
  }
}, 60000);
