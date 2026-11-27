import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopCli } from "../cli/task-desktop.js";
import { desktopConfigurationFingerprint } from "../src/control/task-desktop-config.js";
import {
  checkPort,
  DesktopStartError,
  openStartLog,
  readStartOutput,
  serviceStateFolder,
  startFailure,
  startLogRotateAt,
  type PortTools,
} from "../src/desktop-start.js";

// Made-up values only. No test here reads a port of this Mac or starts a
// service: the ports and the service are fakes.
const directories: string[] = [];
afterEach(() => {
  while (directories.length)
    rmSync(directories.pop()!, { recursive: true, force: true });
});
const temporary = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-start-")));
  directories.push(path);
  return path;
};
const write = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const fingerprint = (project: string, port: number) =>
  desktopConfigurationFingerprint({
    projectRoot: project,
    worker: "simulation",
    checksFingerprint: null,
    port,
  });

/** Ports as a test chooses them: the taken ones, and who holds them. */
function fakePorts(
  taken: Record<
    number,
    { pid: number; name: string; command: string; health?: unknown }
  >,
): PortTools & { probed: number[] } {
  const probed: number[] = [];
  return {
    probed,
    bindable: async (port) => {
      probed.push(port);
      return !taken[port];
    },
    health: async (port) => taken[port]?.health ?? null,
    listener: async (port) =>
      taken[port] ? { pid: taken[port].pid, name: taken[port].name } : null,
    command: async (pid) =>
      Object.values(taken).find((one) => one.pid === pid)?.command ?? null,
  };
}

/** A desktop to start: its state, its project, and a fake service. */
function fixture() {
  const root = temporary();
  const project = join(root, "project");
  const state = join(root, "private");
  const panel = join(root, "panel");
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(panel, "synthetic executable, never run", { mode: 0o700 });
  /** What the fake service writes to its output, then its exit code. */
  let service: { output: string; code: number } | null = null;
  const spawnMock = vi.fn(
    (_command: string, _args: string[], options: { stdio: unknown[] }) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 43001,
        unref: vi.fn(),
        kill: vi.fn(),
      });
      // The service writes to the descriptor it was given, as a real one does.
      if (service) {
        writeSync(options.stdio[2] as number, service.output);
        const code = service.code;
        setTimeout(() => child.emit("exit", code, null), 2);
      }
      return child;
    },
  );
  const run = (ports: PortTools, extra: string[] = []) =>
    desktopCli(
      [
        "--state",
        state,
        "--project",
        project,
        "--panel-binary",
        panel,
        ...extra,
      ],
      {
        root,
        spawn: spawnMock as unknown as typeof spawn,
        request: vi.fn(async () => new Response("{}", { status: 503 })),
        print: vi.fn(),
        startupMs: 2000,
        pollMs: 1,
        panel: false,
        ports,
      },
    );
  return {
    root,
    project,
    state,
    spawnMock,
    run,
    serviceSays: (output: string, code = 1) => {
      service = { output, code };
    },
  };
}

const error = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (caught) {
    return caught as DesktopStartError;
  }
  throw Error("expected a refusal");
};

describe("port in use", () => {
  it("names a ClawdTime desktop of another install, confirmed by its own files, and starts nothing", async () => {
    const f = fixture();
    const other = join(f.root, "other install", "desktop");
    mkdirSync(other, { recursive: true, mode: 0o700 });
    write(join(other, "owner.lock"), { pid: 52001 });
    write(join(other, "desktop-service.json"), {
      version: 1,
      pid: 52001,
      origin: "http://127.0.0.1:13326",
    });
    const ports = fakePorts({
      13326: {
        pid: 52001,
        name: "node",
        command: `/opt/made-up/node --import tsx /opt/made up/scripts/task-server.ts --state ${other} --project /opt/work --port 13326 --desktop true`,
        health: {
          mode: "simulation",
          liveDispatch: false,
          presentation: false,
          control: false,
        },
      },
    });
    const refused = await error(f.run(ports));
    expect(refused).toBeInstanceOf(DesktopStartError);
    expect(refused.kind).toBe("other_install");
    expect(refused.reason).toContain(
      "ClawdTime is already running from another install",
    );
    expect(refused.other).toEqual({
      port: 13326,
      pid: 52001,
      state: other,
      verified: true,
    });
    expect(refused.details.join(" ")).toContain(other);
    expect(f.spawnMock).not.toHaveBeenCalled();
    // The other install is left as it is.
    expect(existsSync(join(other, "owner.lock"))).toBe(true);
  });

  it("names a ClawdTime desktop by its health answer alone, and does not claim to know its folder", async () => {
    const f = fixture();
    const refused = await error(
      f.run(
        fakePorts({
          13326: {
            pid: 52002,
            name: "node",
            command: "node server.js",
            health: { mode: "standby", liveDispatch: false, control: false },
          },
        }),
      ),
    );
    expect(refused.kind).toBe("other_install");
    expect(refused.other).toEqual({
      port: 13326,
      pid: 52002,
      state: null,
      verified: false,
    });
    expect(f.spawnMock).not.toHaveBeenCalled();
  });

  it("moves a new desktop off a port that another program holds, and keeps that port", async () => {
    const f = fixture();
    const ports = fakePorts({
      13326: { pid: 52003, name: "python3", command: "python3 -m http.server" },
    });
    // The fake service answers nothing and stops: the port is what counts here.
    f.serviceSays("", 1);
    await error(f.run(ports));
    const args = f.spawnMock.mock.calls[0]![1];
    expect(args[args.indexOf("--port") + 1]).toBe("13327");
    expect(
      JSON.parse(readFileSync(join(f.state, "desktop-port.json"), "utf8")),
    ).toEqual({ version: 1, port: 13327 });
    // The next start uses the kept port first.
    ports.probed.length = 0;
    await error(f.run(ports));
    expect(ports.probed[0]).toBe(13327);
    const again = f.spawnMock.mock.calls[1]![1];
    expect(again[again.indexOf("--port") + 1]).toBe("13327");
  });

  it("moves a desktop that started before with its identity, and refuses an explicit port", async () => {
    const f = fixture();
    write(join(f.state, "desktop-binding.json"), {
      version: 1,
      desktopId: "desktop_made_up",
      configurationFingerprint: fingerprint(f.project, 13326),
      uiToken: "made-up-ui-credential-".repeat(3),
      registrationId: "desktop_registration_made_up",
    });
    const ports = fakePorts({
      13326: {
        pid: 52004,
        name: "Stonepad",
        command: "/Applications/Stonepad",
      },
    });
    const explicit = await error(f.run(ports, ["--port", "13326"]));
    expect(explicit.kind).toBe("port_in_use");
    expect(explicit.reason).toBe(
      "Port 13326 is in use by another program (Stonepad), so the desktop cannot start there. Quit that program, then try again.",
    );
    expect(f.spawnMock).not.toHaveBeenCalled();
    f.serviceSays("", 1);
    await error(f.run(ports));
    const binding = JSON.parse(
      readFileSync(join(f.state, "desktop-binding.json"), "utf8"),
    );
    expect(binding.desktopId).toBe("desktop_made_up");
    expect(binding.configurationFingerprint).toBe(
      fingerprint(f.project, 13327),
    );
  });

  it("keeps a binding of another setup where it is", async () => {
    const f = fixture();
    write(join(f.state, "desktop-binding.json"), {
      version: 1,
      desktopId: "desktop_made_up",
      configurationFingerprint: "0".repeat(64),
      uiToken: "made-up-ui-credential-".repeat(3),
      registrationId: "desktop_registration_made_up",
    });
    const refused = await error(
      f.run(fakePorts({ 13326: { pid: 1, name: "x", command: "x" } })),
    );
    expect(refused.kind).toBe("port_in_use");
    expect(f.spawnMock).not.toHaveBeenCalled();
    expect(existsSync(join(f.state, "desktop-port.json"))).toBe(false);
  });

  it("reads the state folder of a service from its command line, also with spaces", () => {
    expect(
      serviceStateFolder(
        "/a b/node /a b/app/dist/scripts/task-server.js --state /Users/made up/desk --project /p --port 13326 --desktop true",
      ),
    ).toBe("/Users/made up/desk");
    expect(
      serviceStateFolder(
        "node scripts/task-server.ts --state /x --project /p --port 3320",
      ),
    ).toBeNull();
  });

  it("a free port is free", async () => {
    expect(await checkPort(13326, fakePorts({}))).toEqual({ state: "free" });
  });
});

describe("a service that stops as it starts", () => {
  it("says the reason from the service's own words, without paths, and keeps the log", async () => {
    const f = fixture();
    f.serviceSays(
      "desktop-service-error: ENOENT: no such file or directory, open '/Users/made-up/project/missing.json'\n    at stack line\n",
    );
    const refused = await error(f.run(fakePorts({})));
    expect(refused.kind).toBe("stopped");
    expect(refused.reason).toBe(
      "The desktop service stopped as it started: ENOENT: no such file or directory, open a file",
    );
    expect(refused.reason).not.toContain("Desktop service startup failed");
    const log = join(f.state, "desktop-start.log");
    expect(refused.details).toContain(`The service log is ${log}.`);
    expect(refused.details.join(" ")).toContain("/Users/made-up/project");
    expect(statSync(log).mode & 0o777).toBe(0o600);
    expect(readFileSync(log, "utf8")).toContain("desktop-service-error");
  });

  it("masks a key, a token and a phone number in the reason", async () => {
    const f = fixture();
    const secret = `sk-made-up-${"a1".repeat(20)}`;
    f.serviceSays(
      `Error: provider refused key ${secret} for +1 415 555 0100 with Bearer ${"b2".repeat(20)}\n`,
    );
    const refused = await error(f.run(fakePorts({})));
    expect(refused.kind).toBe("stopped");
    const text = JSON.stringify(refused) + refused.message;
    expect(text).not.toContain(secret);
    expect(text).not.toContain("415 555 0100");
    expect(text).not.toContain("b2b2b2b2");
  });

  it("says that the port was taken when the service lost the race for it", async () => {
    const f = fixture();
    f.serviceSays(
      "desktop-service-error: listen EADDRINUSE: address already in use 127.0.0.1:13326\n",
    );
    const refused = await error(f.run(fakePorts({})));
    expect(refused.kind).toBe("port_in_use");
    expect(refused.reason).toContain("Port 13326 is in use by another program");
  });

  it("says what to do when the task session expired with open work", async () => {
    const f = fixture();
    f.serviceSays(
      "desktop-start-refused session_open_work: The task session of this desktop expired while a task, call or voice is still open, so it was not renewed and nothing was changed.\n",
    );
    const refused = await error(f.run(fakePorts({})));
    expect(refused.kind).toBe("session_open_work");
    expect(refused.reason).toContain("was not renewed and nothing was changed");
    expect(refused.details[0]).toBe(
      `To keep that task's record and start a new desktop, move this desktop's folder aside: mv "${f.state}" "${f.state}-kept"`,
    );
  });

  it("names an older service's own session refusal", () => {
    const refused = startFailure(
      "file:///x/task-service.ts:125\nDomainError: Task session expired or revoked.\n",
      { port: 13326, state: "/s", log: "/s/desktop-start.log", code: 1 },
    );
    expect(refused.kind).toBe("session_revoked");
  });

  it("says that the service said nothing, with its exit code", () => {
    expect(
      startFailure("", { port: 13326, state: "/s", log: "/s/l", code: 9 })
        .reason,
    ).toBe(
      "The desktop service stopped as it started and said nothing (exit code 9).",
    );
  });
});

describe("the startup log", () => {
  it("moves a large log aside and reads only what this start wrote", () => {
    const state = temporary();
    chmodSync(state, 0o700);
    const path = join(state, "desktop-start.log");
    writeFileSync(path, "x".repeat(startLogRotateAt + 1), { mode: 0o600 });
    const log = openStartLog(state);
    expect(log.offset).toBe(0);
    expect(existsSync(`${path}.1`)).toBe(true);
    writeSync(log.fd, "this start\n");
    const second = openStartLog(state);
    writeSync(second.fd, "the next start\n");
    expect(readStartOutput(path, second.offset)).toBe("the next start\n");
  });

  it("refuses a log that another user could read", () => {
    const state = temporary();
    writeFileSync(join(state, "desktop-start.log"), "", { mode: 0o644 });
    chmodSync(join(state, "desktop-start.log"), 0o644);
    expect(() => openStartLog(state)).toThrow("not a private file");
  });
});
