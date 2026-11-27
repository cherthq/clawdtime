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
import { afterEach, describe, expect, it } from "vitest";
import { desktopCli } from "../cli/task-desktop.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import {
  prepareTaskDesktop,
  renewDesktopSession,
} from "../src/control/task-desktop-config.js";
import { TaskService } from "../src/control/task-service.js";
import { DesktopStartError } from "../src/desktop-start.js";
import { DesktopRefusal } from "../src/service-output.js";
import { Vault } from "../src/storage/security.js";
import { Store } from "../src/storage/store.js";

// Made-up values only. The real service here runs in a temporary folder on
// an unused port, with a panel that exits at once: it opens no window.
const day = 24 * 60 * 60 * 1000;
const key = "cd".repeat(32);
const folders: string[] = [];
afterEach(() => {
  while (folders.length)
    rmSync(folders.pop()!, { recursive: true, force: true });
});

/** A desktop folder whose session was registered `ago` milliseconds back. */
function desktopMadeAgo(ago: number, options: { openTask?: boolean } = {}) {
  const temporary = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-renewal-")),
  );
  folders.push(temporary);
  const project = join(temporary, "project"),
    state = join(temporary, "private");
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(
    join(state, "local-config.json"),
    JSON.stringify({
      key,
      operatorToken: "made_up_operator_".repeat(4),
      projectRoot: project,
    }),
    { mode: 0o600 },
  );
  const now = Date.now() - ago;
  const open = (clock: () => number) => {
    const store = new Store(join(state, "tasks.sqlite"));
    const vault = new Vault(key);
    if (!store.get("pairing", "local-demo-pairing"))
      store.put("pairing", {
        id: "local-demo-pairing",
        memberId: "local-demo-member",
        deviceId: "local-demo-device",
        recipient: "fixture",
        conversationId: "fixture",
        lineId: "fixture",
        displayId: "none",
        allowView: false,
        allowControl: false,
        createdAt: clock(),
      });
    const service = new TaskService(
      store,
      vault,
      new TaskLedger(store, vault, clock),
      {
        projectRoots: [project],
        simulation: true,
        clock,
      },
    );
    return { store, service };
  };
  return {
    project,
    state,
    open,
    /** Registers the desktop's session at the time `ago` back. */
    register: (port: number) => {
      const { store, service } = open(() => now);
      try {
        const setup = prepareTaskDesktop(service, {
          directory: state,
          projectRoot: project,
          worker: "simulation",
          port,
        });
        if (options.openTask)
          service.create(setup.config.sessionToken, {
            eventId: "made-up-open-task",
            goal: "A made-up task that waits in the queue.",
          });
        return service.authenticate(setup.config.sessionToken).expiresAt;
      } finally {
        store.close();
      }
    },
  };
}

describe("the desktop's own task session at startup", () => {
  it("renews an expired session while nothing is open, with the same identity", () => {
    const desk = desktopMadeAgo(25 * 60 * 60 * 1000);
    const before = desk.register(13326);
    const clock = () => Date.now();
    const { store, service } = desk.open(clock);
    try {
      expect(renewDesktopSession(service, { directory: desk.state })).toBe(
        "renewed",
      );
      // The start then registers the same session from its receipt.
      const setup = prepareTaskDesktop(service, {
        directory: desk.state,
        projectRoot: desk.project,
        worker: "simulation",
        port: 13326,
      });
      const session = service.authenticate(setup.config.sessionToken);
      expect(session.expiresAt).toBeGreaterThan(Date.now() + day - 60_000);
      expect(session.createdAt).toBeLessThan(before);
      expect(store.all("task-session")).toHaveLength(1);
      expect(renewDesktopSession(service, { directory: desk.state })).toBe(
        "active",
      );
    } finally {
      store.close();
    }
  });

  it("refuses with plain words and changes nothing while a task is queued", () => {
    const desk = desktopMadeAgo(25 * 60 * 60 * 1000, { openTask: true });
    const before = desk.register(13326);
    const { store, service } = desk.open(() => Date.now());
    try {
      let refusal: unknown;
      try {
        renewDesktopSession(service, { directory: desk.state });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(DesktopRefusal);
      expect((refusal as DesktopRefusal).kind).toBe("session_open_work");
      expect((refusal as DesktopRefusal).message).toContain(
        "was not renewed and nothing was changed",
      );
      const sealed = store.all<{ sealed: string }>("task-session")[0]!;
      expect(
        new Vault(key).open<{ expiresAt: number }>(sealed.sealed).expiresAt,
      ).toBe(before);
    } finally {
      store.close();
    }
  });

  it("leaves a fresh folder and an active session alone", () => {
    const fresh = desktopMadeAgo(0);
    {
      const { store, service } = fresh.open(() => Date.now());
      expect(renewDesktopSession(service, { directory: fresh.state })).toBe(
        "none",
      );
      store.close();
    }
    fresh.register(13326);
    const { store, service } = fresh.open(() => Date.now());
    try {
      expect(renewDesktopSession(service, { directory: fresh.state })).toBe(
        "active",
      );
    } finally {
      store.close();
    }
  });
});

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no port");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}
async function closeOwned(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}

describe("a real isolated desktop service", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const start = async (
    desk: ReturnType<typeof desktopMadeAgo>,
    port: number,
  ) => {
    const services: ChildProcess[] = [];
    const launch = desktopCli(
      [
        "--state",
        desk.state,
        "--project",
        desk.project,
        "--port",
        String(port),
        "--panel-binary",
        "/bin/sh",
      ],
      {
        root,
        print: () => {},
        startupMs: 15000,
        pollMs: 50,
        panel: false,
        spawn: ((command: string, args: string[], options: object) => {
          const child = spawn(command, args, options);
          services.push(child);
          return child;
        }) as typeof spawn,
      },
    );
    return { launch, services };
  };

  it("starts after its session expired, renews it, and says so in its log", async () => {
    const desk = desktopMadeAgo(25 * 60 * 60 * 1000);
    const port = await unusedPort();
    desk.register(port);
    const { launch, services } = await start(desk, port);
    try {
      await launch;
      const log = readFileSync(join(desk.state, "desktop-start.log"), "utf8");
      expect(log).toContain(
        "The task session of this desktop had expired. It was renewed for 24 hours",
      );
      // The log holds no credential of the folder.
      expect(log).not.toContain("made_up_operator_");
      expect(log).not.toContain(key);
    } finally {
      await Promise.all(services.map(closeOwned));
    }
  }, 30000);

  it("stops with the plain reason when a task is open, and keeps the session as it was", async () => {
    const desk = desktopMadeAgo(25 * 60 * 60 * 1000, { openTask: true });
    const port = await unusedPort();
    const before = desk.register(port);
    const { launch, services } = await start(desk, port);
    try {
      const refusal = await launch.then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(DesktopStartError);
      expect((refusal as DesktopStartError).kind).toBe("session_open_work");
      expect((refusal as DesktopStartError).reason).toBe(
        "The task session of this desktop expired while a task, call or voice is still open, so it was not renewed and nothing was changed.",
      );
      const { store } = desk.open(() => Date.now());
      try {
        const sealed = store.all<{ sealed: string }>("task-session")[0]!;
        expect(
          new Vault(key).open<{ expiresAt: number }>(sealed.sealed).expiresAt,
        ).toBe(before);
      } finally {
        store.close();
      }
    } finally {
      await Promise.all(services.map(closeOwned));
    }
  }, 30000);
});
