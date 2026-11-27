import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../cli/main.js";
import {
  isPanelCommand,
  isSharedRunCommand,
  uninstallCli,
  type UninstallPorts,
} from "../cli/uninstall.js";
import {
  saveSharedPairing,
  sharedPairingPaths,
} from "../src/onboard/pairing.js";
import { Store } from "../src/storage/store.js";

const folders: string[] = [];
afterEach(() => {
  while (folders.length)
    rmSync(folders.pop()!, { recursive: true, force: true });
});

const origin = "https://coordinator.example";
const credential = "made-up-credential.".padEnd(48, "x");

/**
 * A home folder with an installed release, its command link, settings,
 * keys, a project folder and a fake Trash. The trash mover moves into that
 * folder: no test uses the real Trash.
 */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "clawdtime uninstall "));
  folders.push(home);
  const support = join(home, "Library", "Application Support", "ClawdTime");
  const runtime = join(support, "runtime");
  mkdirSync(join(runtime, "0.4.0", "bin"), { recursive: true });
  writeFileSync(join(runtime, "0.4.0", "bin", "clawdtime"), "#!/bin/sh\n");
  symlinkSync("0.4.0", join(runtime, "current"));
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const link = join(bin, "clawdtime");
  symlinkSync(join(runtime, "current", "bin", "clawdtime"), link);
  const state = join(home, ".local", "share", "clawdtime");
  mkdirSync(join(state, "computer"), { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "computer", "keys.json"), "{}", { mode: 0o600 });
  mkdirSync(join(state, "desktop"), { recursive: true, mode: 0o700 });
  const config = join(home, ".config", "clawdtime");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const project = join(home, "clawdtime-work");
  mkdirSync(project);
  writeFileSync(join(project, "notes.txt"), "my own work");
  const trash = join(home, "Fake Trash");
  mkdirSync(trash);
  const moved: string[] = [];
  const requests: { url: string; authorization: string | null }[] = [];
  let answer: (url: string) => Promise<Response> = async () =>
    Response.json({ ok: true });
  const stops: string[] = [];
  const ports: UninstallPorts = {
    blocked: async () => null,
    stop: async () => {
      stops.push("stop");
      return ["the shared connection", "the desktop service", "the panel"];
    },
    trash: async (path) => {
      renameSync(path, join(trash, `${moved.length}-${basename(path)}`));
      moved.push(path);
    },
    request: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return answer(String(url));
    }) as typeof fetch,
    confirm: async () => true,
    others: async () => [],
  };
  const lines: string[] = [];
  const run = (args: string[], overrides: Partial<UninstallPorts> = {}) =>
    uninstallCli(["--yes", ...args], {
      env: {},
      home,
      uid: 501,
      print: (line) => lines.push(line),
      ports: { ...ports, ...overrides },
    });
  const pair = () => {
    const { directory, file } = sharedPairingPaths(home);
    saveSharedPairing(directory, file, {
      origin,
      credential,
      deviceId: "device-a",
      displayId: "display-a",
      allowView: true,
      allowControl: false,
      walkthroughReports: false,
    });
    return file;
  };
  return {
    home,
    support,
    runtime,
    link,
    state,
    config,
    project,
    trash,
    moved,
    requests,
    stops,
    lines,
    text: () => lines.join("\n"),
    run,
    pair,
    answer: (next: (url: string) => Promise<Response>) => {
      answer = next;
    },
  };
}

describe("clawdtime uninstall", () => {
  it("stops ClawdTime, then moves the runtime, the command link and the settings to the Trash", async () => {
    const f = fixture();
    expect(await f.run([])).toBe(0);
    expect(f.stops).toEqual(["stop"]);
    expect(f.moved).toEqual([f.support, f.link, f.state, f.config]);
    for (const path of f.moved) expect(existsSync(path)).toBe(false);
    expect(readdirSync(f.trash)).toHaveLength(4);
    // The project folder is the person's own work.
    expect(existsSync(join(f.project, "notes.txt"))).toBe(true);
    expect(f.text()).toContain("~/clawdtime-work");
    expect(f.text()).toContain("ClawdTime is uninstalled.");
    // The plan, one empty line, then what happened: the app shows that part.
    const result = f.lines.slice(f.lines.indexOf("") + 1).join("\n");
    expect(result).toMatch(/^Stopped the shared connection/);
    expect(result).not.toContain("clawdtime uninstall does this");
    expect(f.requests).toEqual([]);
  });

  it("moves the runtime alone when its folder holds more", async () => {
    const f = fixture();
    const other = join(f.support, "notes.txt");
    writeFileSync(other, "kept");
    expect(await f.run([])).toBe(0);
    expect(f.moved).toEqual([f.runtime, f.link, f.state, f.config]);
    expect(existsSync(other)).toBe(true);
  });

  it("lists exactly what it will move before it asks, and moves nothing on no", async () => {
    const f = fixture();
    const asked: string[] = [];
    const code = await uninstallCli([], {
      env: {},
      home: f.home,
      uid: 501,
      print: (line) => f.lines.push(line),
      ports: {
        ...(await portsOf(f)),
        confirm: async (question) => {
          asked.push(f.text());
          return question.length > 0 && false;
        },
      },
    });
    expect(code).toBe(1);
    expect(asked[0]).toContain("~/Library/Application Support/ClawdTime");
    expect(asked[0]).toContain("~/.local/bin/clawdtime");
    expect(asked[0]).toContain("~/.local/share/clawdtime");
    expect(asked[0]).toContain("~/.config/clawdtime");
    expect(f.moved).toEqual([]);
    expect(f.stops).toEqual([]);
    expect(existsSync(f.runtime)).toBe(true);
  });

  it("needs a terminal or --yes to go on", async () => {
    const f = fixture();
    const code = await uninstallCli([], {
      env: {},
      home: f.home,
      uid: 501,
      print: (line) => f.lines.push(line),
      ports: { ...(await portsOf(f)), confirm: async () => null },
    });
    expect(code).toBe(3);
    expect(f.text()).toContain("--yes");
    expect(f.moved).toEqual([]);
  });

  it("keeps the settings and keys with --keep-settings", async () => {
    const f = fixture();
    expect(await f.run(["--keep-settings"])).toBe(0);
    expect(f.moved).toEqual([f.support, f.link]);
    expect(existsSync(join(f.state, "computer", "keys.json"))).toBe(true);
    expect(existsSync(f.config)).toBe(true);
    expect(f.text()).toContain("--keep-settings");
  });

  it("keeps receipts with an unknown or pending outcome in place and says so", async () => {
    const f = fixture();
    const tasks = join(f.state, "desktop", "tasks.sqlite");
    const store = new Store(tasks);
    store.putEffect({
      id: "effect-1",
      kind: "message",
      state: "unknown",
      payload: {},
      createdAt: 1,
    });
    store.close();
    const receipts = join(f.state, "desktop", "desktop-receipts");
    mkdirSync(receipts, { mode: 0o700 });
    const operations = join(receipts, "panel-operations.json");
    writeFileSync(
      operations,
      JSON.stringify([{ eventId: "event-1", state: "pending" }]),
    );
    writeFileSync(join(receipts, "panel.lock"), "");
    expect(await f.run([])).toBe(0);
    expect(existsSync(tasks)).toBe(true);
    expect(existsSync(operations)).toBe(true);
    // Everything else of the settings goes.
    expect(existsSync(join(f.state, "computer"))).toBe(false);
    expect(existsSync(join(receipts, "panel.lock"))).toBe(false);
    expect(existsSync(f.config)).toBe(false);
    expect(f.text()).toContain("~/.local/share/clawdtime/desktop/tasks.sqlite");
    expect(f.text()).toContain(
      "~/.local/share/clawdtime/desktop/desktop-receipts/panel-operations.json",
    );
    expect(f.text()).toMatch(/unknown or pending outcome/);
  });

  it("keeps a receipt database that cannot be read", async () => {
    const f = fixture();
    const broken = join(f.state, "desktop", "tasks.sqlite");
    writeFileSync(broken, "not a database");
    expect(await f.run([])).toBe(0);
    expect(existsSync(broken)).toBe(true);
    expect(f.text()).toContain("cannot be read");
  });

  it("unpairs a paired Mac through the coordinator with its own credential", async () => {
    const f = fixture();
    const file = f.pair();
    expect(await f.run([])).toBe(0);
    expect(f.requests).toEqual([
      { url: `${origin}/device/unpair`, authorization: `Bearer ${credential}` },
    ]);
    expect(existsSync(file)).toBe(false);
    expect(f.moved).toContain(f.config);
    expect(f.text()).toContain("Unpaired this Mac from the shared number");
    expect(f.text()).not.toContain(credential);
  });

  it("moves only the revoked pairing with --keep-settings", async () => {
    const f = fixture();
    const file = f.pair();
    expect(await f.run(["--keep-settings"])).toBe(0);
    expect(f.moved).toEqual([f.support, f.link, file]);
    expect(existsSync(join(f.state, "computer", "keys.json"))).toBe(true);
  });

  it("says the unpairing is pending, keeps the pairing and moves the rest when the coordinator does not answer", async () => {
    const f = fixture();
    const file = f.pair();
    f.answer(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await f.run([])).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(f.support)).toBe(false);
    expect(existsSync(f.link)).toBe(false);
    expect(existsSync(f.state)).toBe(false);
    expect(f.text()).toContain("Unpairing is pending");
    expect(f.text()).toContain("shared pair --replace");
    expect(f.text()).toContain("~/.config/clawdtime/shared/connection.json");
    expect(f.text()).not.toContain(credential);
  });

  it("counts a coordinator that cannot unpair yet as pending", async () => {
    const f = fixture();
    const file = f.pair();
    f.answer(async () =>
      Response.json({ ok: false, code: "not_found" }, { status: 404 }),
    );
    expect(await f.run([])).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(f.text()).toContain("Unpairing is pending");
  });

  it("counts a credential that the coordinator refuses as no access", async () => {
    const f = fixture();
    const file = f.pair();
    f.answer(async () =>
      Response.json(
        { ok: false, code: "shared_number_unauthorized" },
        { status: 403 },
      ),
    );
    expect(await f.run([])).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(f.text()).toContain("no longer accepts this Mac");
  });

  it("never moves a command link that runs a source checkout, or the checkout", async () => {
    const f = fixture();
    const checkout = join(f.home, "clawdtime");
    mkdirSync(join(checkout, "cli"), { recursive: true });
    mkdirSync(join(checkout, "scripts"));
    mkdirSync(join(checkout, "dist", "cli"), { recursive: true });
    writeFileSync(join(checkout, "cli", "main.ts"), "");
    writeFileSync(join(checkout, "scripts", "install.sh"), "");
    writeFileSync(join(checkout, "dist", "cli", "main.js"), "");
    rmSync(f.link);
    symlinkSync(join(checkout, "dist", "cli", "main.js"), f.link);
    expect(await f.run([])).toBe(0);
    expect(existsSync(f.link)).toBe(true);
    expect(existsSync(join(checkout, "cli", "main.ts"))).toBe(true);
    expect(f.moved).not.toContain(f.link);
    expect(f.text()).toContain("runs the source build in ~/clawdtime");
  });

  it("never moves a source checkout inside a settings folder", async () => {
    const f = fixture();
    const inside = join(f.state, "my-checkout");
    mkdirSync(join(inside, "cli"), { recursive: true });
    mkdirSync(join(inside, "scripts"));
    writeFileSync(join(inside, "cli", "main.ts"), "");
    writeFileSync(join(inside, "scripts", "install.sh"), "");
    expect(await f.run([])).toBe(0);
    expect(existsSync(join(inside, "cli", "main.ts"))).toBe(true);
    expect(existsSync(join(f.state, "computer"))).toBe(false);
  });

  it("never moves a settings folder that is not ClawdTime's own", async () => {
    const f = fixture();
    const documents = join(f.home, "Documents");
    mkdirSync(documents);
    writeFileSync(join(documents, "letter.txt"), "mine");
    const code = await uninstallCli(["--yes"], {
      env: { CLAWDTIME_CONFIG_HOME: documents },
      home: f.home,
      uid: 501,
      print: (line) => f.lines.push(line),
      ports: await portsOf(f),
    });
    expect(code).toBe(0);
    expect(existsSync(join(documents, "letter.txt"))).toBe(true);
    expect(f.moved).not.toContain(documents);
    expect(f.text()).toContain("~/Documents");
  });

  it("refuses to run as root and changes nothing", async () => {
    const f = fixture();
    const code = await uninstallCli(["--yes"], {
      env: {},
      home: f.home,
      uid: 0,
      print: (line) => f.lines.push(line),
      ports: await portsOf(f),
    });
    expect(code).toBe(1);
    expect(f.text()).toContain("without sudo");
    expect(f.stops).toEqual([]);
    expect(f.moved).toEqual([]);
  });

  it("moves and unpairs nothing when a process cannot be stopped", async () => {
    const f = fixture();
    f.pair();
    const code = await f.run([], {
      stop: async () => {
        throw Error("The desktop service could not be identified.");
      },
    });
    expect(code).toBe(1);
    expect(f.moved).toEqual([]);
    expect(f.requests).toEqual([]);
    expect(f.text()).toContain("Nothing was unpaired or moved.");
  });

  it("changes nothing while another program blocks it", async () => {
    const f = fixture();
    const code = await f.run([], {
      blocked: async () => "An install runs now (process 4242).",
    });
    expect(code).toBe(1);
    expect(f.stops).toEqual([]);
    expect(f.moved).toEqual([]);
    expect(f.text()).toContain("process 4242");
  });

  it("--plan --json lists the same items and changes nothing", async () => {
    const f = fixture();
    f.pair();
    const code = await uninstallCli(["--plan", "--json"], {
      env: {},
      home: f.home,
      uid: 501,
      print: (line) => f.lines.push(line),
      ports: await portsOf(f),
    });
    expect(code).toBe(0);
    const plan = JSON.parse(f.text());
    expect(plan.version).toBe(1);
    expect(plan.unpair).toEqual({ origin });
    expect(
      plan.move.map((item: { path: string; settings: boolean }) => [
        item.path,
        item.settings,
      ]),
    ).toEqual([
      [f.support, false],
      [f.link, false],
      [f.state, true],
      [f.config, true],
      [sharedPairingPaths(f.home).file, false],
    ]);
    expect(f.moved).toEqual([]);
    expect(f.stops).toEqual([]);
    expect(f.requests).toEqual([]);
  });
});

describe("the clawdtime command", () => {
  it("runs this uninstall without --agent, and keeps the agent uninstall with it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main(["uninstall", "--help"]);
      expect(log.mock.calls.flat().join("\n")).toContain(
        "take ClawdTime off this Mac",
      );
      await main(["help"]);
      expect(log.mock.calls.flat().join("\n")).toContain(
        "uninstall --agent AGENT",
      );
    } finally {
      log.mockRestore();
    }
  });
});

describe("the identity of the processes it stops", () => {
  it("knows a shared run of ClawdTime by its command", () => {
    expect(
      isSharedRunCommand(
        "/Users/a/Library/Application Support/ClawdTime/runtime/0.4.0/node/bin/node /Users/a/Library/Application Support/ClawdTime/runtime/0.4.0/app/dist/cli/main.js shared run --owned",
      ),
    ).toBe(true);
    expect(
      isSharedRunCommand("node /Users/a/.local/bin/clawdtime shared run"),
    ).toBe(true);
    expect(isSharedRunCommand("/bin/sleep 300")).toBe(false);
    expect(isSharedRunCommand("node main.js shared run --other")).toBe(false);
  });

  it("knows the panel of this desktop by its exact configuration file", () => {
    const config = "/Users/a/.local/share/clawdtime/desktop/desktop-panel.json";
    const panel =
      "/Users/a/Library/Application Support/ClawdTime/runtime/0.4.0/app/native/ClawdTimeTaskPanel";
    expect(isPanelCommand(`${panel} --config ${config}`, config)).toBe(true);
    expect(isPanelCommand(`${panel} --config ${config} --tucked`, config)).toBe(
      true,
    );
    expect(
      isPanelCommand(`${panel} --config /tmp/other/desktop-panel.json`, config),
    ).toBe(false);
    expect(isPanelCommand(`/bin/sleep --config ${config}`, config)).toBe(false);
  });
});

/** The ports of a fixture, for a call of uninstallCli with other options. */
async function portsOf(f: ReturnType<typeof fixture>): Promise<UninstallPorts> {
  return {
    blocked: async () => null,
    stop: async () => {
      f.stops.push("stop");
      return [];
    },
    trash: async (path) => {
      renameSync(path, join(f.trash, `${f.moved.length}-${basename(path)}`));
      f.moved.push(path);
    },
    request: (async () => Response.json({ ok: true })) as typeof fetch,
    confirm: async () => true,
    others: async () => [],
  };
}
