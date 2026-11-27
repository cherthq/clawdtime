import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCli, startHelp } from "../cli/start.js";
import { main } from "../cli/main.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A made-up home and checkout. The desktop is a fake: nothing starts. */
function setup(options: { panel?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-start-")));
  roots.push(base);
  const home = join(base, "home"),
    root = join(base, "checkout");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(join(root, "mac", ".build", "debug"), { recursive: true });
  if (options.panel !== false)
    writeFileSync(
      join(root, "mac", ".build", "debug", "ClawdTimeTaskPanel"),
      "synthetic executable, never run",
      { mode: 0o700 },
    );
  const calls: { args: string[]; root: string; chat?: string }[] = [];
  const lines: string[] = [];
  const env: Record<string, string | undefined> = {};
  const run = (args: string[], extra: { cwd?: string } = {}) =>
    startCli(args, {
      env,
      home,
      root,
      cwd: extra.cwd ?? base,
      print: (line) => lines.push(line),
      desktop: async (desktopArgs, dependencies) => {
        calls.push({
          args: desktopArgs,
          root: dependencies.root,
          chat: env.CLAWDTIME_CHAT,
        });
      },
    });
  return { base, home, root, env, calls, lines, run };
}

/** The file that the desktop service writes on its first start. */
function bind(state: string, projectRoot: string) {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(state, "local-config.json"),
    JSON.stringify({
      key: "synthetic-key-never-read",
      operatorToken: "synthetic-token-never-read",
      projectRoot,
    }),
    { mode: 0o600 },
  );
}

describe("clawdtime start", () => {
  it("starts the desktop as the README does, in a project folder of its own", async () => {
    const { home, root, calls, lines, run } = setup();
    await run([]);
    const project = join(home, "clawdtime-work");
    expect(existsSync(project)).toBe(true);
    expect(statSync(project).mode & 0o077).toBe(0);
    expect(calls).toEqual([
      {
        args: [
          "--state",
          join(home, ".local", "share", "clawdtime", "desktop"),
          "--project",
          project,
          "--panel-binary",
          join(root, "mac", ".build", "debug", "ClawdTimeTaskPanel"),
        ],
        root,
        chat: "agent",
      },
    ]);
    expect(lines[0]).toBe(
      `Coding work runs in ${project}. To choose another folder, start with --project PATH the first time.`,
    );
    expect(lines.at(-1)).toMatch(/^Click the mascot to open the chat\./);
  });

  it("keeps a chat setting that the person chose, and passes --tucked", async () => {
    const { env, calls, run } = setup();
    env.CLAWDTIME_CHAT = "supervisor";
    await run(["--tucked", "true"]);
    expect(calls[0]!.chat).toBe("supervisor");
    expect(calls[0]!.args.slice(-4, -2)).toEqual(["--tucked", "true"]);
  });

  it("uses the project that a person names on the first start", async () => {
    const { base, home, root, calls, run } = setup();
    const project = join(base, "code", "stonepad");
    mkdirSync(project, { recursive: true });
    await run(["--project", "code/stonepad"], { cwd: base });
    expect(calls[0]!.args).toEqual([
      "--state",
      join(home, ".local", "share", "clawdtime", "desktop"),
      "--project",
      project,
      "--panel-binary",
      join(root, "mac", ".build", "debug", "ClawdTimeTaskPanel"),
    ]);
    expect(existsSync(join(home, "clawdtime-work"))).toBe(false);
  });

  it("keeps the project that the desktop is bound to, and refuses another one", async () => {
    const { base, home, root, calls, run } = setup();
    const project = join(base, "code", "riverchat");
    const other = join(base, "code", "stonepad");
    mkdirSync(project, { recursive: true });
    mkdirSync(other, { recursive: true });
    const state = join(home, ".local", "share", "clawdtime", "desktop");
    bind(state, project);
    await run([]);
    expect(calls[0]!.args).toEqual([
      "--state",
      state,
      "--project",
      project,
      "--panel-binary",
      join(root, "mac", ".build", "debug", "ClawdTimeTaskPanel"),
    ]);
    await expect(run(["--project", other])).rejects.toThrow(
      `This desktop works in ${project}. Start it without --project to use that folder.`,
    );
    expect(calls).toHaveLength(1);
    expect(existsSync(join(home, "clawdtime-work"))).toBe(false);
  });

  it("says how to build the panel when it is not built, and starts nothing", async () => {
    const { root, calls, run } = setup({ panel: false });
    await expect(run([])).rejects.toThrow(
      `Build the panel first: cd ${join(root, "mac")} && swift build --product ClawdTimeTaskPanel`,
    );
    expect(calls).toEqual([]);
  });

  it("uses the state folder of CLAWDTIME_DESKTOP_STATE and of CLAWDTIME_CONFIG_HOME", async () => {
    const first = setup();
    first.env.CLAWDTIME_DESKTOP_STATE = join(first.base, "elsewhere");
    await first.run([]);
    expect(first.calls[0]!.args[1]).toBe(join(first.base, "elsewhere"));
    first.env.CLAWDTIME_DESKTOP_STATE = "relative/desktop";
    await expect(first.run([])).rejects.toThrow(
      "CLAWDTIME_DESKTOP_STATE must be an absolute path.",
    );
    const second = setup();
    second.env.CLAWDTIME_CONFIG_HOME = join(second.base, "config");
    await second.run([]);
    expect(second.calls[0]!.args[1]).toBe(
      join(second.base, "config", "desktop"),
    );
  });

  it("refuses a project that holds the state folder, such as the home folder", async () => {
    const { home, calls, run } = setup();
    await expect(run(["--project", home])).rejects.toThrow(
      "The project folder must not hold the state folder",
    );
    expect(calls).toEqual([]);
  });

  it("refuses a missing project folder and a wrong option", async () => {
    const { base, calls, run } = setup();
    await expect(run(["--project", join(base, "nowhere")])).rejects.toThrow(
      `The project folder ${join(base, "nowhere")} does not exist.`,
    );
    await expect(run(["--port", "4000"])).rejects.toThrow(
      "Use: clawdtime start [--project PATH] [--tucked true|false]",
    );
    await expect(run(["--project"])).rejects.toThrow("Use: clawdtime start");
    await expect(run(["--tucked", "yes"])).rejects.toThrow(
      "Use --tucked true or --tucked false.",
    );
    expect(calls).toEqual([]);
  });

  it("has help, and is a command of clawdtime itself", async () => {
    const { lines, calls, run } = setup();
    await run(["help"]);
    expect(lines).toEqual([startHelp]);
    expect(calls).toEqual([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main(["start", "--help"]);
      expect(log.mock.calls[0]![0]).toBe(startHelp);
      log.mockClear();
      await main(["help"]);
      expect(log.mock.calls[0]![0]).toContain(
        "start [--project PATH] [--tucked true] (start the desktop",
      );
    } finally {
      log.mockRestore();
    }
  });
});
