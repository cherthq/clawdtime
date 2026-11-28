import { defaultChatAgentModel } from "../connectors/agents/chat-model.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyStoredSettings,
  settingsCli,
  settingsFile,
  speedPresets,
  type PanelDefaults,
  type SettingsCliDependencies,
} from "../cli/settings.js";
import { Memory } from "../connectors/agents/memory.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import {
  readComputerSwitch,
  setComputerSwitch,
} from "../connectors/computer/journal.js";
import {
  readModelChoice,
  storeKey,
  storeModelChoice,
} from "../connectors/computer/keys.js";
import { providerById } from "../connectors/computer/providers.js";
import { startCli } from "../cli/start.js";

const secret = "fixture-stored-key-9f8e7d6c5b4a";
const roots: string[] = [];
afterEach(() => {
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true }));
});
const folder = () => {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-settings-"));
  roots.push(path);
  return path;
};

/** The panel's preferences in memory, as `defaults` would keep them. */
class FakePanel implements PanelDefaults {
  values: Record<string, unknown> = {};
  told = 0;
  read() {
    return { ...this.values };
  }
  write(key: string, value: boolean | number | string) {
    this.values[key] = value;
  }
  changed() {
    this.told++;
  }
}

/** The command with a state folder and a home of its own, a fake panel, trash and network. */
function cli(
  env: Record<string, string | undefined> = {},
  options: { version?: string } = {},
) {
  const home = folder();
  const root = join(home, "state");
  const panel = new FakePanel();
  const trashed: string[] = [];
  const lines: string[] = [];
  const requests: string[] = [];
  let answer: (url: string) => Promise<Response> = async () =>
    new Response("{}", { status: 404 });
  const all = { CLAWDTIME_CONFIG_HOME: root, ...env };
  const dependencies = (): SettingsCliDependencies => ({
    env: all,
    home,
    print: (line) => lines.push(line),
    panel,
    trash: async (path) => {
      trashed.push(path);
      rmSync(path, { recursive: true, force: true });
    },
    request: (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      return answer(url);
    }) as typeof fetch,
    version: options.version ?? "0.4.0",
    now: () => Date.UTC(2026, 10, 28, 9),
  });
  const run = async (...args: string[]) => {
    lines.length = 0;
    await settingsCli(args, dependencies());
    return lines.join("\n");
  };
  const json = async (...args: string[]) =>
    JSON.parse(await run(...args, "--json")) as Record<string, any>;
  return {
    home,
    root,
    env: all,
    panel,
    trashed,
    requests,
    run,
    json,
    answer: (fn: (url: string) => Promise<Response>) => {
      answer = fn;
    },
  };
}

type Row = {
  id: string;
  value: unknown;
  default: unknown;
  from: string;
  kind: string;
  applies: string;
  variable?: string | null;
  choices?: string[];
};
const row = (report: Record<string, any>, id: string) =>
  (report.settings as Row[]).find((setting) => setting.id === id)!;

describe("clawdtime settings --json", () => {
  it("lists every setting with its default, where it comes from and when a change is used", async () => {
    const { json } = cli();
    const report = await json();
    expect(report.version).toBe(1);
    expect(report.problem).toBeNull();
    const ids = (report.settings as Row[]).map((setting) => setting.id);
    expect(ids).toEqual([
      "mascot.style",
      "mascot.size",
      "mascot.eye",
      "cursor.pace",
      "voice.replies",
      "voice.name",
      "voice.speed",
      "vocabulary",
      "memory",
      "away",
      "speed",
      "model.planner",
      "model.chat",
      "computer",
      "computer.ask",
      "computer.browser",
      "reach",
      "reach.wait",
    ]);
    for (const setting of report.settings as Row[])
      expect(setting.from, setting.id).toBe("default");
    expect(row(report, "mascot.style")).toMatchObject({
      value: "flint",
      kind: "choice",
      applies: "now",
    });
    expect(row(report, "mascot.style").choices).toContain("jet");
    expect(row(report, "memory")).toMatchObject({
      value: false,
      applies: "now",
    });
    expect(row(report, "computer.browser")).toMatchObject({
      value: "off",
      choices: ["off", "on", "own"],
      applies: "restart",
      variable: "CLAWDTIME_COMPUTER_BROWSER",
    });
    expect(row(report, "computer.ask")).toMatchObject({
      value: "risky",
      choices: ["risky", "never"],
    });
    expect(row(report, "reach.wait")).toMatchObject({
      value: 45,
      kind: "number",
    });
    expect(row(report, "voice.name")).toMatchObject({ value: "alloy" });
    expect(row(report, "model.chat")).toMatchObject({
      value: defaultChatAgentModel,
    });
  });

  it("never holds a key, also when a stored key and a key in the environment are there", async () => {
    const { root, json, run } = cli({
      OPENAI_API_KEY: "sk-fixture-env-key-1234",
    });
    storeKey(root, providerById("anthropic")!, secret);
    const text = JSON.stringify(await json());
    expect(text).not.toContain(secret);
    expect(text).not.toContain("sk-fixture-env-key-1234");
    expect(await run()).not.toContain(secret);
  });

  it("says that a variable of the environment wins over a stored value", async () => {
    const { json } = cli({ CLAWDTIME_COMPUTER_BROWSER: "own" });
    await json("set", "computer.browser", "on");
    const browser = row(await json(), "computer.browser");
    expect(browser).toMatchObject({ value: "own", from: "environment" });
  });
});

describe("clawdtime settings set", () => {
  it("stores a setting of the service in an owner-only file and says when it is used", async () => {
    const { root, json } = cli();
    const done = await json("set", "computer.browser", "own");
    expect(done).toMatchObject({
      version: 1,
      ok: true,
      id: "computer.browser",
      value: "own",
      applies: "restart",
      shadowed: null,
    });
    expect(statSync(settingsFile(root)).mode & 0o777).toBe(0o600);
    expect(row(await json(), "computer.browser")).toMatchObject({
      value: "own",
      from: "store",
    });
    const shadowed = cli({ CLAWDTIME_COMPUTER_TRUST: "on" });
    expect((await shadowed.json("set", "computer.ask", "risky")).shadowed).toBe(
      "CLAWDTIME_COMPUTER_TRUST",
    );
  });

  it("turns memory, away and computer use on and off in their own files, at once", async () => {
    const { root, json } = cli();
    expect(await json("set", "memory", "on")).toMatchObject({
      value: true,
      applies: "now",
    });
    expect(new Memory(root).enabled()).toBe(true);
    await json("set", "away", "true");
    expect(new DecisionDesk(root).away()).toBe(true);
    expect((await json("set", "computer", "on")).applies).toBe("restart");
    expect(readComputerSwitch(root).enabled).toBe(true);
    expect((await json("set", "computer", "off")).applies).toBe("now");
    expect(readComputerSwitch(root).enabled).toBe(false);
    await json("set", "memory", "off");
    expect(new Memory(root).enabled()).toBe(false);
    const report = await json();
    expect(row(report, "away")).toMatchObject({ value: true, from: "store" });
  });

  it("writes the look of the mascot and the voice into the panel's preferences, and tells a running panel", async () => {
    const { panel, json } = cli();
    await json("set", "mascot.style", "jet");
    await json("set", "mascot.size", "1.2");
    await json("set", "mascot.eye", "on");
    await json("set", "voice.replies", "off");
    await json("set", "voice.speed", "1.25");
    expect(panel.values).toEqual({
      "pet.style": "jet",
      "pet.size": 1.2,
      "pet.flintEye": true,
      "voice.replies": false,
      "voice.rate": 1.25,
    });
    expect(panel.told).toBe(5);
    const report = await json();
    expect(row(report, "mascot.size")).toMatchObject({
      value: 1.2,
      from: "store",
    });
    expect(row(report, "voice.replies")).toMatchObject({ value: false });
  });

  it("refuses a value that does not fit, and changes nothing", async () => {
    const { root, panel, run } = cli();
    for (const [id, value, words] of [
      ["mascot.style", "dragon", "Choose one of"],
      ["mascot.size", "9", "from 0.5 to 1.5"],
      ["mascot.size", "big", "from 0.5 to 1.5"],
      ["memory", "maybe", "Use on or off"],
      ["reach.wait", "-3", "from 0 to 600"],
      ["computer.browser", "chrome", "Choose one of"],
      ["vocabulary", "sk-live-abcdefghijklmnop", "looks like a key"],
      ["model.chat", "sk-proj-abcdefghijklmnopqrstuv", "looks like a key"],
      ["model.planner", "nobody/vision", "no known provider"],
      ["nothing.here", "1", "Name one setting"],
    ] as const)
      await expect(run("set", id, value), `${id} ${value}`).rejects.toThrow(
        words,
      );
    expect(existsSync(settingsFile(root))).toBe(false);
    expect(panel.values).toEqual({});
    await expect(run("set", "memory")).rejects.toThrow(
      "Use: clawdtime settings",
    );
  });

  it("goes back to the default with reset", async () => {
    const { panel, json } = cli();
    await json("set", "voice.name", "coral");
    await json("set", "mascot.style", "jade");
    expect((await json("reset", "voice.name")).value).toBe("alloy");
    expect((await json("reset", "mascot.style")).value).toBe("flint");
    expect(panel.values["pet.style"]).toBe("flint");
    expect(row(await json(), "voice.name").from).toBe("default");
  });

  it("chooses the planner model and the chat model", async () => {
    const { root, json } = cli();
    await json("set", "model.planner", "anthropic/claude-opus-5-5");
    expect(readModelChoice(root).choice?.model).toBe(
      "anthropic/claude-opus-5-5",
    );
    await json("set", "model.chat", "gpt-4.1-mini");
    const report = await json();
    expect(row(report, "model.planner")).toMatchObject({
      value: "anthropic/claude-opus-5-5",
      from: "store",
    });
    expect(row(report, "model.chat")).toMatchObject({
      value: "gpt-4.1-mini",
      from: "store",
      variable: "CLAWDTIME_SUPERVISOR_MODEL",
    });
    await json("reset", "model.planner");
    expect(readModelChoice(root).choice).toBeNull();
  });
});

describe("the speed presets", () => {
  it("come from the evals, and Best is what ClawdTime uses with no choice", async () => {
    expect(speedPresets.openai.map((preset) => preset.id)).toEqual([
      "fast",
      "balanced",
      "best",
    ]);
    const { json } = cli({ OPENAI_API_KEY: "sk-fixture-env-key-1234" });
    const report = await json();
    expect(row(report, "speed")).toMatchObject({
      value: "best",
      choices: ["fast", "balanced", "best"],
    });
    expect(report.speed.provider).toBe("openai");
    expect(report.speed.presets[0]).toMatchObject({
      id: "fast",
      planner: "gpt-5.4",
      chat: "gpt-4.1-mini",
    });
  });

  it("set the planner and the chat model together, and a single change reads as custom", async () => {
    const { root, json } = cli({ OPENAI_API_KEY: "sk-fixture-env-key-1234" });
    const done = await json("set", "speed", "fast");
    expect(done).toMatchObject({ value: "fast", applies: "restart" });
    expect(readModelChoice(root).choice?.model).toBe("gpt-5.4");
    let report = await json();
    expect(row(report, "model.chat").value).toBe("gpt-4.1-mini");
    expect(row(report, "speed").value).toBe("fast");
    await json("set", "model.chat", "gpt-5.5");
    expect(row(await json(), "speed").value).toBe("custom");
    await json("set", "speed", "best");
    expect(readModelChoice(root).choice).toBeNull();
    report = await json();
    expect(row(report, "model.chat").from).toBe("default");
    expect(row(report, "speed").value).toBe("best");
  });

  it("follow the provider in use: with only an Anthropic key, Fast and Best", async () => {
    const { root, json, run } = cli();
    storeKey(root, providerById("anthropic")!, secret);
    const report = await json();
    expect(report.speed.provider).toBe("anthropic");
    expect(row(report, "speed").choices).toEqual(["fast", "best"]);
    await json("set", "speed", "fast");
    expect(readModelChoice(root).choice?.model).toBe(
      "anthropic/claude-fable-5-2",
    );
    await expect(run("set", "speed", "balanced")).rejects.toThrow(
      "Choose one of",
    );
  });

  it("are not offered for a provider that the evals did not measure", async () => {
    const { root, json, run } = cli();
    storeKey(root, providerById("groq")!, secret);
    storeModelChoice(root, { model: "groq/a-vision-model" });
    const report = await json();
    expect(report.speed.presets).toEqual([]);
    expect(row(report, "speed")).toMatchObject({
      value: "custom",
      choices: [],
    });
    await expect(run("set", "speed", "fast")).rejects.toThrow("Choose one of");
  });
});

describe("applyStoredSettings", () => {
  it("gives the stored settings to the service as variables, and a variable that is set wins", async () => {
    const { root, json } = cli();
    await json("set", "computer.ask", "never");
    await json("set", "computer.browser", "own");
    await json("set", "voice.name", "coral");
    await json("set", "vocabulary", "Brightwave, Ledgerly");
    await json("set", "reach", "off");
    await json("set", "reach.wait", "90");
    await json("set", "cursor.pace", "calm");
    await json("set", "model.chat", "gpt-4.1-mini");
    const env: Record<string, string | undefined> = {
      CLAWDTIME_COMPUTER_BROWSER: "on",
    };
    const applied = applyStoredSettings(env, root);
    expect(env).toEqual({
      CLAWDTIME_COMPUTER_BROWSER: "on",
      CLAWDTIME_COMPUTER_TRUST: "on",
      CLAWDTIME_VOICE: "coral",
      CLAWDTIME_VOCABULARY: "Brightwave, Ledgerly",
      CLAWDTIME_COMPUTER_REACH: "off",
      CLAWDTIME_COMPUTER_REACH_SECONDS: "90",
      CLAWDTIME_CURSOR_PACE: "calm",
      CLAWDTIME_SUPERVISOR_MODEL: "gpt-4.1-mini",
    });
    expect(applied).not.toContain("CLAWDTIME_COMPUTER_BROWSER");
  });

  it("sets nothing for a default, and reads past a file it cannot use", async () => {
    const { root, json } = cli();
    await json("set", "computer.ask", "risky");
    await json("set", "cursor.pace", "auto");
    const env: Record<string, string | undefined> = {};
    applyStoredSettings(env, root);
    expect(env).toEqual({});
    writeFileSync(settingsFile(root), "not json", { mode: 0o600 });
    expect(applyStoredSettings(env, root)).toEqual([]);
    expect((await json()).problem).toContain("settings.json");
    // A damaged file is never written over in silence.
    await expect(json("set", "voice.name", "coral")).rejects.toThrow(
      "settings.json",
    );
    expect(readFileSync(settingsFile(root), "utf8")).toBe("not json");
  });

  it("is what clawdtime start gives the desktop service", async () => {
    const { home, root, json } = cli();
    await json("set", "computer.browser", "own");
    await json("set", "voice.name", "coral");
    const checkout = join(home, "checkout");
    mkdirSync(join(checkout, "mac", ".build", "debug"), { recursive: true });
    writeFileSync(
      join(checkout, "mac", ".build", "debug", "ClawdTimeTaskPanel"),
      "synthetic executable, never run",
      { mode: 0o700 },
    );
    const env: Record<string, string | undefined> = {
      CLAWDTIME_CONFIG_HOME: root,
      CLAWDTIME_VOICE: "sage",
    };
    const seen: Record<string, string | undefined>[] = [];
    await startCli([], {
      env,
      home,
      root: checkout,
      cwd: home,
      print: () => {},
      desktop: async () => {
        seen.push({ ...env });
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      CLAWDTIME_COMPUTER_BROWSER: "own",
      CLAWDTIME_VOICE: "sage",
      CLAWDTIME_CHAT: "agent",
    });
  });

  it("ignores a stored value that a hand changed into one that does not fit", () => {
    const root = folder();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(
      settingsFile(root),
      JSON.stringify({
        version: 1,
        values: {
          "computer.browser": "chrome",
          "reach.wait": 9000,
          "model.chat": "sk-proj-abcdefghijklmnopqrstuv",
          "voice.name": "coral",
        },
      }),
      { mode: 0o600 },
    );
    const env: Record<string, string | undefined> = {};
    applyStoredSettings(env, root);
    expect(env).toEqual({ CLAWDTIME_VOICE: "coral" });
  });
});

describe("memory, privacy and history", () => {
  it("forgets every fact only with --yes", async () => {
    const { root, json, run } = cli();
    const memory = new Memory(root);
    memory.setEnabled(true);
    memory.remember({ text: "I use the Stonepad notes app" });
    memory.remember({ text: "My shop is shop.example" });
    await expect(run("forget-memory")).rejects.toThrow("--yes");
    expect(new Memory(root).facts()).toHaveLength(2);
    expect(await json("forget-memory", "--yes")).toMatchObject({
      version: 1,
      removed: 2,
    });
    expect(new Memory(root).facts()).toHaveLength(0);
    expect(new Memory(root).enabled()).toBe(true);
  });

  it("says what is kept, where, and how much, with no key and no text of a chat", async () => {
    const { root, home, json } = cli();
    storeKey(root, providerById("openai")!, secret);
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(
      join(root, "agents", "chat.jsonl"),
      '{"text":"a private line"}\n',
    );
    writeFileSync(join(root, "agents", "chat-20261127T100000Z.jsonl"), "{}\n");
    const report = await json("privacy");
    expect(report.folder).toBe(root);
    const ids = (report.items as { id: string }[]).map((item) => item.id);
    expect(ids).toEqual([
      "chat",
      "voice",
      "memory",
      "requests",
      "timing",
      "keys",
      "settings",
      "pairing",
      "logs",
    ]);
    const chat = (report.items as any[]).find((item) => item.id === "chat");
    expect(chat).toMatchObject({ count: 2, removable: true });
    expect(chat.bytes).toBeGreaterThan(0);
    const keys = (report.items as any[]).find((item) => item.id === "keys");
    expect(keys).toMatchObject({ count: 1, removable: false });
    const logs = (report.items as any[]).find((item) => item.id === "logs");
    expect(logs.path).toBe(join(home, "Library", "Logs", "ClawdTime"));
    const text = JSON.stringify(report);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("a private line");
  });

  it("moves the chat history, the spoken replies and the step times to the Trash, and keeps the record of requests", async () => {
    const { root, json, run, trashed } = cli();
    const agents = join(root, "agents");
    mkdirSync(join(agents, "voice"), { recursive: true });
    mkdirSync(join(root, "computer"), { recursive: true });
    writeFileSync(join(agents, "chat.jsonl"), "{}\n");
    writeFileSync(join(agents, "chat-20261127T100000Z.jsonl"), "{}\n");
    writeFileSync(join(agents, "voice", "reply-1.mp3"), "mp3");
    writeFileSync(join(root, "computer", "timing.json"), "[]");
    writeFileSync(join(root, "computer", "journal.json"), "[]");
    writeFileSync(join(agents, "texts.json"), "{}");
    await expect(run("delete-history")).rejects.toThrow("--yes");
    expect(trashed).toEqual([]);
    const done = await json("delete-history", "--yes");
    expect(done).toMatchObject({ version: 1, ok: true, applies: "restart" });
    expect([...trashed].sort()).toEqual(
      [
        join(agents, "chat-20261127T100000Z.jsonl"),
        join(agents, "chat.jsonl"),
        join(agents, "voice", "reply-1.mp3"),
        join(root, "computer", "timing.json"),
      ].sort(),
    );
    expect(existsSync(join(root, "computer", "journal.json"))).toBe(true);
    expect(existsSync(join(agents, "texts.json"))).toBe(true);
    expect((await json("delete-history", "--yes")).moved).toEqual([]);
  });
});

describe("clawdtime settings update", () => {
  const latest = (version: string) =>
    new Response(
      JSON.stringify({
        version,
        commit: "a".repeat(40),
        arch: "arm64",
        url: `clawdtime-${version}-darwin-arm64.tar.gz`,
        sha256: "b".repeat(64),
        minimumMacOS: "14.0",
      }),
      { status: 200 },
    );

  it("reads latest.json of the release and says whether it is newer", async () => {
    const { json, answer, requests } = cli();
    answer(async () => latest("0.10.0"));
    expect(await json("update")).toEqual({
      version: 1,
      current: "0.4.0",
      latest: "0.10.0",
      commit: "a".repeat(40),
      newer: true,
      page: "https://github.com/cherthq/clawdtime/releases/latest",
    });
    expect(requests).toEqual([
      "https://github.com/cherthq/clawdtime/releases/latest/download/latest.json",
    ]);
    answer(async () => latest("0.4.0"));
    expect((await json("update")).newer).toBe(false);
    answer(async () => latest("0.3.9"));
    expect((await json("update")).newer).toBe(false);
  });

  it("uses CLAWDTIME_RELEASE_BASE, and refuses a base or an answer it cannot trust", async () => {
    const local = cli({
      CLAWDTIME_RELEASE_BASE: "https://releases.example/clawdtime",
    });
    local.answer(async () => latest("0.5.0"));
    await local.json("update");
    expect(local.requests).toEqual([
      "https://releases.example/clawdtime/latest.json",
    ]);
    const bad = cli({ CLAWDTIME_RELEASE_BASE: "http://releases.example" });
    await expect(bad.run("update")).rejects.toThrow("https");
    expect(bad.requests).toEqual([]);
    const broken = cli();
    broken.answer(async () => new Response("nope", { status: 200 }));
    await expect(broken.run("update")).rejects.toThrow("latest.json");
    broken.answer(async () => latest("1.0"));
    await expect(broken.run("update")).rejects.toThrow("latest.json");
    broken.answer(async () => {
      throw new Error("offline");
    });
    await expect(broken.run("update")).rejects.toThrow("network");
  });
});

describe("clawdtime settings phone", () => {
  const pair = (home: string) => {
    const directory = join(home, ".config", "clawdtime", "shared");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, "connection.json"),
      JSON.stringify({
        origin: "https://coordinator.example",
        credential: "fixture-device-credential-0123456789",
        deviceId: "device-0001",
        displayId: "display-0001",
        allowView: true,
        allowControl: false,
        walkthroughReports: false,
      }),
      { mode: 0o600 },
    );
    return join(directory, "connection.json");
  };

  it("says when no phone is paired", async () => {
    const { json } = cli();
    expect(await json("phone")).toMatchObject({
      version: 1,
      pairing: "none",
      origin: null,
      connection: "off",
      owner: null,
    });
  });

  it("says that this Mac is paired, what it allows and the end of the number, never the credential", async () => {
    const { home, root, json } = cli();
    pair(home);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(root, "owner.json"),
      JSON.stringify({
        version: 1,
        phone: "+14155550100",
        consent: { answer: "yes", at: 1 },
      }),
      { mode: 0o600 },
    );
    const report = await json("phone");
    expect(report).toMatchObject({
      pairing: "paired",
      origin: "https://coordinator.example",
      view: true,
      control: false,
      owner: { ending: "ends in 00", consent: "yes" },
    });
    expect(JSON.stringify(report)).not.toContain("fixture-device-credential");
    expect(JSON.stringify(report)).not.toContain("5550100");
  });

  it("unpairs only with --yes, and moves the pairing to the Trash when the coordinator confirms", async () => {
    const { home, json, run, trashed, answer, requests } = cli();
    const file = pair(home);
    await expect(run("phone", "unpair")).rejects.toThrow("--yes");
    answer(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    expect(await json("phone", "unpair", "--yes")).toMatchObject({
      version: 1,
      result: "unpaired",
    });
    expect(requests).toEqual(["https://coordinator.example/device/unpair"]);
    expect(trashed).toEqual([file]);
    expect((await json("phone")).pairing).toBe("none");
  });

  it("keeps the pairing when the coordinator does not answer", async () => {
    const { home, json, trashed, answer } = cli();
    const file = pair(home);
    answer(async () => new Response("busy", { status: 503 }));
    expect(await json("phone", "unpair", "--yes")).toMatchObject({
      result: "pending",
    });
    expect(trashed).toEqual([]);
    expect(readFileSync(file, "utf8")).toContain("coordinator.example");
  });
});

describe("settings and the other commands", () => {
  it("prints a short list for a person, and help", async () => {
    const { run } = cli();
    const text = await run();
    expect(text).toContain("mascot.style");
    expect(text).toContain("flint");
    expect(await run("help")).toContain("clawdtime settings set NAME VALUE");
  });

  it("agrees with clawdtime computer on and off", async () => {
    const { root, json } = cli();
    setComputerSwitch(root, true, 1);
    expect(row(await json(), "computer")).toMatchObject({
      value: true,
      from: "store",
    });
  });
});

describe("what an independent review found", () => {
  const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

  it("never prints a key that sits where a model or a name should be", async () => {
    for (const env of [
      { CLAWDTIME_COMPUTER_MODEL: key },
      { CLAWDTIME_SUPERVISOR_MODEL: key },
      { CLAWDTIME_VOCABULARY: `Brightwave, ${key}` },
    ]) {
      const { json, run } = cli(env);
      expect(JSON.stringify(await json()), Object.keys(env)[0]).not.toContain(
        key,
      );
      expect(await run()).not.toContain(key);
    }
    const shadowed = cli({ CLAWDTIME_SUPERVISOR_MODEL: key });
    expect(
      JSON.stringify(await shadowed.json("set", "model.chat", "gpt-4.1-mini")),
    ).not.toContain(key);
    const { root, json } = cli();
    mkdirSync(join(root, "computer"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(root, "computer", "model.json"),
      JSON.stringify({ version: 1, model: key }),
      { mode: 0o600 },
    );
    expect(JSON.stringify(await json())).not.toContain(key);
  });

  it("moves nothing that a link leads to outside the state folder", async () => {
    const { root, home, json, trashed } = cli();
    const outside = join(home, "Documents");
    mkdirSync(outside);
    writeFileSync(join(outside, "taxes.pdf"), "x");
    writeFileSync(join(outside, "chat.jsonl"), "{}");
    mkdirSync(join(root, "agents"), { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(root, "agents", "voice"));
    expect((await json("delete-history", "--yes")).moved).toEqual([]);
    rmSync(join(root, "agents"), { recursive: true });
    symlinkSync(outside, join(root, "agents"));
    mkdirSync(join(root, "computer"), { recursive: true });
    symlinkSync(
      join(outside, "taxes.pdf"),
      join(root, "computer", "timing.json"),
    );
    expect((await json("delete-history", "--yes")).moved).toEqual([]);
    expect(trashed).toEqual([]);
    expect(existsSync(join(outside, "taxes.pdf"))).toBe(true);
  });

  it("ignores a stored value of the wrong type, in the report and for the service alike", async () => {
    const { root, json } = cli();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(
      settingsFile(root),
      JSON.stringify({
        version: 1,
        values: { reach: "off", "computer.browser": "on ", "reach.wait": "90" },
      }),
      { mode: 0o600 },
    );
    const report = await json();
    const env: Record<string, string | undefined> = {};
    applyStoredSettings(env, root);
    expect(env).toEqual({});
    expect(row(report, "reach")).toMatchObject({
      value: true,
      from: "default",
    });
    expect(row(report, "computer.browser")).toMatchObject({
      value: "off",
      from: "default",
    });
    expect(row(report, "reach.wait")).toMatchObject({
      value: 45,
      from: "default",
    });
  });

  it("reads a variable as the service reads it", async () => {
    const read = async (env: Record<string, string>, id: string) =>
      row(await cli(env).json(), id);
    expect(
      await read({ CLAWDTIME_COMPUTER_TRUST: " on" }, "computer.ask"),
    ).toMatchObject({
      value: "risky",
      from: "environment",
    });
    expect(
      await read({ CLAWDTIME_COMPUTER_TRUST: "on" }, "computer.ask"),
    ).toMatchObject({ value: "never" });
    expect(
      await read({ CLAWDTIME_COMPUTER_BROWSER: "auto" }, "computer.browser"),
    ).toMatchObject({ value: "auto" });
    expect(
      await read({ CLAWDTIME_COMPUTER_BROWSER: "On" }, "computer.browser"),
    ).toMatchObject({ value: "off" });
    expect(
      await read({ CLAWDTIME_CURSOR_PACE: "CALM" }, "cursor.pace"),
    ).toMatchObject({ value: "calm" });
    expect(
      await read({ CLAWDTIME_COMPUTER_REACH_SECONDS: "9000" }, "reach.wait"),
    ).toMatchObject({ value: 45 });
    expect(
      await read({ CLAWDTIME_COMPUTER_REACH: "OFF" }, "reach"),
    ).toMatchObject({ value: true });
  });

  it("changes no model when settings.json cannot be used", async () => {
    const { root, run } = cli({ OPENAI_API_KEY: "sk-fixture-env-key-1234" });
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(settingsFile(root), "not json", { mode: 0o600 });
    await expect(run("set", "speed", "fast")).rejects.toThrow("settings.json");
    expect(readModelChoice(root).choice).toBeNull();
  });

  it("refuses to unpair when it cannot tell whether the phone connection runs", async () => {
    const { home, json, run, requests } = cli();
    const directory = join(home, ".config", "clawdtime", "shared");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // A lock that points at itself cannot be opened: ELOOP.
    symlinkSync(
      join(directory, "connection.lock"),
      join(directory, "connection.lock"),
    );
    await expect(run("phone", "unpair", "--yes")).rejects.toThrow(
      "phone connection",
    );
    expect(requests).toEqual([]);
    expect((await json("phone")).connection).toBe("unknown");
  });

  it("says that calls are off when Settings turned them off", async () => {
    const { json } = cli();
    await json("set", "reach", "off");
    const report = await json("phone");
    expect(report.calls).toBe("off");
    expect(report.texts).toBe("off");
  });

  it("trusts no redirect to http, and says when this version is not known", async () => {
    const latest = new Response(
      JSON.stringify({ version: "0.5.0", commit: "a".repeat(40) }),
      { status: 200 },
    );
    const moved = cli();
    moved.answer(async () => {
      const response = latest.clone();
      Object.defineProperty(response, "url", {
        value: "http://releases.example/latest.json",
      });
      return response;
    });
    await expect(moved.run("update")).rejects.toThrow("latest.json");
    const unknown = cli({}, { version: "unknown" });
    unknown.answer(async () => latest.clone());
    expect((await unknown.json("update")).newer).toBeNull();
  });
});
