import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerJournal,
  setComputerSwitch,
} from "../connectors/computer/journal.js";
import {
  handsNextSchema,
  type Action,
  type HandsNext,
} from "../connectors/computer/ports.js";
import {
  actorsText,
  backgroundEngineText,
  bundledEngineText,
  chatEngineText,
  chooseExecution,
  noBoardText,
  noKeyText,
  testServiceText,
} from "../connectors/computer/service.js";
import {
  computerStatusSchema,
  offText,
  stoppedText,
} from "../connectors/computer/worker.js";
import { createTaskApp } from "../src/control/task-app.js";
import type { BundledCuaRuntime } from "../src/control/bundled-cua-runtime.js";
import type {
  DesktopExecutionSnapshot,
  DesktopExecutor,
} from "../src/control/desktop-executor.js";
import type { TaskDesktopService } from "../src/control/task-desktop-service.js";
import type { TaskService } from "../src/control/task-service.js";
import { DomainError } from "../src/storage/security.js";
import {
  element,
  observation,
  ScriptedPlanner,
} from "./connectors-computer-fixture.js";

/**
 * Which engine does the computer work in one desktop service. Every case goes
 * through `chooseExecution`, which the service calls, and through the real
 * route code. The chat connection and the bundled runtime are made up, and a
 * stand-in for the panel takes the commands: nothing here reaches a screen, a
 * mouse, a keyboard or a language model.
 */

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const home = () => {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-computer-engine-"));
  roots.push(path);
  return path;
};
/** A state folder where the person turned computer use on. */
const turnedOn = () => {
  const root = home();
  setComputerSwitch(root, true);
  return root;
};
/** An environment of a service that no test started, with a key that is never sent. */
const withKey = { CLAWDTIME_OPENAI_API_KEY: "test-key-that-is-never-sent" };

const panel = "p".repeat(40);
const desktop = {
  authorizePanel(value: string) {
    if (value !== panel)
      throw new DomainError(401, "Desktop authorization required.");
  },
} as TaskDesktopService;

const still = (message: string, mode?: "native" | "browser") => ({
  configured: true,
  state: "idle",
  canStop: false,
  message,
  ...(mode ? { mode } : {}),
});
/** A made-up connection to an existing chat: it has the command route of that engine. */
function chatEngine() {
  const snapshot = still("Connected to your selected chat.");
  return {
    snapshot: vi.fn((): DesktopExecutionSnapshot => snapshot),
    submit: vi.fn(async () => ({ message: "Queued for the chat." })),
    stop: vi.fn((): DesktopExecutionSnapshot => ({
      ...snapshot,
      state: "canceled",
      message: "Stopped before the agent claimed the request.",
    })),
    command: vi.fn(() => ({ requests: [] })),
  };
}
/** A made-up bundled runtime: it has the decision route of that engine. */
function bundledEngine() {
  const snapshot = still("The bundled runtime is ready.", "native");
  return {
    snapshot: vi.fn((): DesktopExecutionSnapshot => snapshot),
    submit: vi.fn(async () => ({ message: "The bundled runtime started." })),
    stop: vi.fn((): DesktopExecutionSnapshot => ({
      ...snapshot,
      state: "canceled",
      message: "The bundled runtime stopped.",
    })),
    decision: vi.fn((): DesktopExecutionSnapshot => ({
      ...snapshot,
      message: "The bundled runtime took the decision.",
    })),
  };
}

type Chosen = ReturnType<typeof chooseExecution>;
/** The real routes over what was chosen, as the service wires them. */
function routes(chosen: Chosen) {
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
    chosen.configured as unknown as DesktopExecutor | BundledCuaRuntime,
    chosen.computer.port,
  );
  const get = (path: string) =>
    app.request(path, { headers: { authorization: `Bearer ${panel}` } });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${panel}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const status = async () =>
    computerStatusSchema.parse(await (await get("/desktop/computer")).json());
  const next = async (after: number) =>
    handsNextSchema.parse(
      await (await get(`/desktop/hands/next?after=${after}`)).json(),
    );
  return { app, get, post, status, next };
}
const nothingForTheHands: HandsNext = {
  version: 1,
  command: null,
  run: { active: false, goal: "", step: 0, state: "idle" },
};
const click: Action = { kind: "click_element", element: 1 };
const done: Action = { kind: "done", summary: "Saved." };

describe("which engine does the computer work in a desktop service", () => {
  it("keeps an existing chat connection first, also with the worker turned on", async () => {
    const chat = chatEngine();
    const chosen = chooseExecution({
      root: turnedOn(),
      env: withKey,
      chat,
      actors: false,
      board: true,
    });
    expect(chosen.engine).toBe("chat");
    expect(chosen.execution).toBe(chat);
    expect(chosen.configured).toBe(chat);
    expect(chosen.computer.worker).toBeNull();
    const f = routes(chosen);
    // The routes of the hands answer, with nothing to do and the reason.
    expect(await f.status()).toMatchObject({
      enabled: false,
      state: "idle",
      message: chatEngineText,
    });
    expect(await f.next(0)).toEqual(nothingForTheHands);
    expect(
      await (
        await f.post("/desktop/hands/result", { seq: 1, ok: true })
      ).json(),
    ).toEqual({ ok: false });
    // Stop and the command route are the chat connection's own.
    expect(
      await (await f.post("/desktop/execution/stop", {})).json(),
    ).toMatchObject({
      execution: { message: "Stopped before the agent claimed the request." },
    });
    expect(chat.stop).toHaveBeenCalledTimes(1);
    expect((await f.post("/executor/command", {})).status).toBe(200);
    expect(chat.command).toHaveBeenCalledTimes(1);
    // The decision route belongs to the bundled runtime only.
    expect((await f.post("/desktop/execution/decision", {})).status).toBe(404);
  });

  it("takes the bundled runtime next, also with the worker turned on, and leaves its routes as they are", async () => {
    const bundled = bundledEngine();
    const chosen = chooseExecution({
      root: turnedOn(),
      env: withKey,
      bundled,
      actors: false,
      board: true,
    });
    expect(chosen.engine).toBe("bundled");
    expect(chosen.execution).toBe(bundled);
    expect(chosen.configured).toBe(bundled);
    expect(chosen.computer.worker).toBeNull();
    const f = routes(chosen);
    expect(await f.status()).toMatchObject({
      enabled: false,
      state: "idle",
      message: bundledEngineText,
    });
    expect(await f.next(0)).toEqual(nothingForTheHands);
    expect(
      await (
        await f.post("/desktop/hands/result", { seq: 1, ok: true })
      ).json(),
    ).toEqual({ ok: false });
    expect(
      await (await f.post("/desktop/execution/stop", {})).json(),
    ).toMatchObject({ execution: { message: "The bundled runtime stopped." } });
    expect(bundled.stop).toHaveBeenCalledTimes(1);
    const decided = await f.post("/desktop/execution/decision", {
      actionId: "action-1",
      approve: true,
    });
    expect(await decided.json()).toMatchObject({
      execution: { message: "The bundled runtime took the decision." },
    });
    expect(bundled.decision).toHaveBeenCalledExactlyOnceWith("action-1", true);
    // The command route belongs to the chat connection only.
    expect((await f.post("/executor/command", {})).status).toBe(404);
  });

  it("takes the background runtime before the bundled runtime and the worker, and gives the hands nothing", async () => {
    // A made-up background runtime: it has no decision route and no command route.
    const snapshot: DesktopExecutionSnapshot = {
      ...still("The background runtime is ready."),
      mode: "background",
    };
    const background = {
      snapshot: vi.fn((): DesktopExecutionSnapshot => snapshot),
      submit: vi.fn(async () => ({
        message: "The background runtime took it.",
      })),
      stop: vi.fn((): DesktopExecutionSnapshot => ({
        ...snapshot,
        state: "canceled",
        message: "The background runtime stopped.",
      })),
    };
    const bundled = bundledEngine();
    const chosen = chooseExecution({
      root: turnedOn(),
      env: withKey,
      background,
      bundled,
      actors: false,
      board: true,
    });
    expect(chosen.engine).toBe("background");
    expect(chosen.execution).toBe(background);
    expect(chosen.configured).toBe(background);
    // The switch is on and a key is there: the worker is still not built.
    expect(chosen.computer.worker).toBeNull();
    const f = routes(chosen);
    expect(await f.status()).toMatchObject({
      enabled: false,
      state: "idle",
      message: backgroundEngineText,
    });
    expect(await f.next(0)).toEqual(nothingForTheHands);
    expect(
      await (
        await f.post("/desktop/hands/result", { seq: 1, ok: true })
      ).json(),
    ).toEqual({ ok: false });
    expect(
      await (await f.post("/desktop/execution/stop", {})).json(),
    ).toMatchObject({
      execution: { message: "The background runtime stopped." },
    });
    expect(background.stop).toHaveBeenCalledTimes(1);
    expect(bundled.stop).not.toHaveBeenCalled();
    // The chat connection still comes first.
    const chat = chatEngine();
    expect(
      chooseExecution({
        root: turnedOn(),
        env: withKey,
        chat,
        background,
        actors: false,
        board: true,
      }).engine,
    ).toBe("chat");
  });

  it("puts the chat connection before the bundled runtime when a caller gives both", () => {
    const chat = chatEngine();
    const bundled = bundledEngine();
    const chosen = chooseExecution({
      root: turnedOn(),
      env: withKey,
      chat,
      bundled,
      actors: false,
      board: true,
    });
    expect(chosen.engine).toBe("chat");
    expect(chosen.execution).toBe(chat);
    expect(chosen.computer.port.status()).toMatchObject({
      enabled: false,
      message: chatEngineText,
    });
  });

  it("runs the worker with no other engine, the switch on and a key: one whole task through the routes", async () => {
    const root = turnedOn();
    const said: string[] = [];
    const chosen = chooseExecution({
      root,
      env: withKey,
      actors: false,
      board: true,
      planner: new ScriptedPlanner([click, done]),
      notify: (text) => said.push(text),
    });
    expect(chosen.engine).toBe("worker");
    expect(chosen.configured).toBeUndefined();
    const worker = chosen.computer.worker!;
    expect(chosen.execution).toBe(worker);
    expect(worker.snapshot()).toMatchObject({
      configured: true,
      state: "idle",
      canStop: false,
    });
    const f = routes(chosen);
    expect(await f.status()).toMatchObject({ enabled: true, state: "idle" });
    expect(await f.next(0)).toEqual(nothingForTheHands);
    // The other engines' routes are not there.
    expect((await f.post("/executor/command", {})).status).toBe(404);
    expect((await f.post("/desktop/execution/decision", {})).status).toBe(404);
    expect(
      await chosen.execution!.submit("talk_1_execution", "Save the note"),
    ).toMatchObject({ message: expect.stringMatching(/^Started\./) });
    // A stand-in for the panel: it takes each command once and posts a made-up result.
    const before = observation([element(1, { title: "Save" })]);
    // After the click the app shows that it saved: a done then rests on a change.
    const after = observation([element(1, { title: "Saved" })]);
    let seen = before;
    const served: NonNullable<HandsNext["command"]>[] = [];
    let last = 0;
    for (
      let turn = 0;
      turn < 400 && worker.snapshot().state !== "completed";
      turn++
    ) {
      const { command, run } = await f.next(last);
      if (!command) {
        await new Promise((go) => setTimeout(go, 2));
        continue;
      }
      expect(run).toMatchObject({ active: true, goal: "Save the note" });
      served.push(command);
      last = command.seq;
      const posted = await f.post("/desktop/hands/result", {
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
      if (command.command.kind === "click") seen = after;
    }
    expect(served.map((item) => item.command.kind)).toEqual([
      "observe",
      "observe",
      "click",
      "observe",
    ]);
    // Each command comes with the short label that the panel shows at the cursor.
    expect(served.map((item) => item.label)).toEqual([
      "Look at the screen",
      "Check the screen",
      'Click "Save"',
      "Look at the screen",
    ]);
    expect(await f.status()).toMatchObject({
      enabled: true,
      state: "completed",
      message: "Done. Saved.",
    });
    expect(said).toEqual(["Done. Saved."]);
    expect(new ComputerJournal(root).get("talk_1_execution")).toMatchObject({
      state: "completed",
    });
    // The stop route is the worker's own.
    expect(
      await (await f.post("/desktop/execution/stop", {})).json(),
    ).toMatchObject({ execution: { configured: true, state: "completed" } });
  });

  it("stops the worker through the stop route when it is the engine", async () => {
    const chosen = chooseExecution({
      root: turnedOn(),
      env: withKey,
      actors: false,
      board: true,
      planner: new ScriptedPlanner([click, done]),
    });
    const f = routes(chosen);
    await chosen.execution!.submit("talk_2_execution", "Save the note");
    expect(
      await (await f.post("/desktop/execution/stop", {})).json(),
    ).toMatchObject({ execution: { canStop: false, message: stoppedText } });
    await chosen.computer.worker!.idle();
    // The command that waited was taken back: the hands get nothing.
    expect(await f.next(0)).toEqual(nothingForTheHands);
  });

  it("has no engine in a service that a test started, whatever the switch and the key say", async () => {
    const chosen = chooseExecution({
      root: turnedOn(),
      env: { ...withKey, VITEST: "true" },
      actors: false,
      board: true,
      planner: new ScriptedPlanner([click, done]),
    });
    expect(chosen.engine).toBe("none");
    expect(chosen.execution).toBeUndefined();
    expect(chosen.computer.worker).toBeNull();
    const f = routes(chosen);
    expect(await f.status()).toEqual({
      version: 1,
      enabled: false,
      state: "idle",
      message: testServiceText,
      step: 0,
      goal: "",
      question: null,
    });
    // No command can come out, and a result that is posted is taken by nothing.
    expect(await f.next(0)).toEqual(nothingForTheHands);
    expect(
      await (
        await f.post("/desktop/hands/result", { seq: 1, ok: true })
      ).json(),
    ).toEqual({ ok: false });
    expect((await f.post("/desktop/execution/stop", {})).status).toBe(404);
  });

  it("has no engine with the switch off, and none with the switch on and no key", async () => {
    const off = chooseExecution({
      root: home(),
      env: withKey,
      actors: false,
      board: true,
    });
    expect(off.engine).toBe("none");
    expect(off.execution).toBeUndefined();
    expect(await routes(off).status()).toMatchObject({
      enabled: false,
      message: offText,
    });
    expect(await routes(off).next(0)).toEqual(nothingForTheHands);
    const noKey = chooseExecution({
      root: turnedOn(),
      env: {},
      actors: false,
      board: true,
    });
    expect(noKey.engine).toBe("none");
    expect(noKey.execution).toBeUndefined();
    expect(await routes(noKey).status()).toMatchObject({
      enabled: false,
      message: noKeyText,
    });
    expect(
      (await routes(noKey).post("/desktop/execution/stop", {})).status,
    ).toBe(404);
  });

  it("has no worker in a service with phone or presentation actors, or without the agent board", () => {
    const actors = chooseExecution({
      root: turnedOn(),
      env: withKey,
      actors: true,
      board: true,
    });
    expect(actors.engine).toBe("none");
    expect(actors.computer.port.status()).toMatchObject({
      enabled: false,
      message: actorsText,
    });
    const noBoard = chooseExecution({
      root: turnedOn(),
      env: withKey,
      actors: false,
      board: false,
    });
    expect(noBoard.engine).toBe("none");
    expect(noBoard.computer.port.status()).toMatchObject({
      enabled: false,
      message: noBoardText,
    });
  });
});
