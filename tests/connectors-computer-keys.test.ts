import {
  chmodSync,
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerCli } from "../cli/computer.js";
import { keysCli } from "../cli/keys.js";
import {
  checkKey,
  findKey,
  keyRows,
  keyStoreFile,
  KeyStoreError,
  modelChoiceFile,
  plannerSetup,
  readModelChoice,
  removeStoredKey,
  storedKeys,
  storeKey,
  storeModelChoice,
} from "../connectors/computer/keys.js";
import {
  computerDirectory,
  setComputerSwitch,
} from "../connectors/computer/journal.js";
import { providerById, providerIds } from "../connectors/computer/providers.js";
import { buildComputer, noKeyText } from "../connectors/computer/service.js";

const secret = "fixture-stored-key-9f8e7d6c5b4a";
const other = "fixture-environment-key-1a2b3c";
const anthropic = providerById("anthropic")!;
const openai = providerById("openai")!;
const together = providerById("together")!;

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true }));
});
const home = () => {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-keys-"));
  roots.push(path);
  return path;
};
const mode = (path: string) => statSync(path).mode & 0o777;

/** The two commands with a state folder of their own, a made-up prompt and no terminal. */
function cli(
  env: Record<string, string | undefined> = {},
  typed = `${secret}\n`,
) {
  const root = home();
  const lines: string[] = [];
  const asked: string[] = [];
  const all = { CLAWDTIME_CONFIG_HOME: root, ...env };
  const keys = (...args: string[]) => {
    lines.length = 0;
    return keysCli(args, {
      env: all,
      home: "/nowhere",
      print: (line) => lines.push(line),
      readSecret: async (prompt) => {
        asked.push(prompt);
        return typed;
      },
    }).then(() => lines.join("\n"));
  };
  const computer = (...args: string[]) => {
    lines.length = 0;
    return computerCli(args, {
      env: all,
      home: "/nowhere",
      now: () => Date.UTC(2026, 10, 25, 12),
      print: (line) => lines.push(line),
    }).then(() => lines.join("\n"));
  };
  return { root, keys, computer, asked };
}

describe("the key store", () => {
  it("stores a key for its owner only, in a folder for its owner only, and removes it again", () => {
    const root = home();
    storeKey(root, anthropic, `  ${secret}\n`);
    const file = keyStoreFile(root);
    expect(mode(file)).toBe(0o600);
    expect(mode(computerDirectory(root))).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      keys: { anthropic: secret },
    });
    expect(storedKeys(root)).toEqual({
      keys: { anthropic: secret },
      problem: null,
    });
    storeKey(root, together, other);
    expect(Object.keys(storedKeys(root).keys)).toEqual([
      "anthropic",
      "together",
    ]);
    expect(removeStoredKey(root, anthropic)).toBe(true);
    expect(removeStoredKey(root, anthropic)).toBe(false);
    expect(storedKeys(root).keys).toEqual({ together: other });
    expect(mode(file)).toBe(0o600);
  });

  it("lets the environment win over the store", () => {
    const root = home();
    storeKey(root, openai, secret);
    const stored = storedKeys(root).keys;
    expect(findKey(openai, {}, stored)).toEqual({
      key: secret,
      from: { kind: "store" },
    });
    expect(findKey(openai, { OPENAI_API_KEY: other }, stored)).toEqual({
      key: other,
      from: { kind: "environment", name: "OPENAI_API_KEY" },
    });
    expect(
      findKey(
        openai,
        { OPENAI_API_KEY: "general", CLAWDTIME_OPENAI_API_KEY: other },
        stored,
      )?.from,
    ).toEqual({ kind: "environment", name: "CLAWDTIME_OPENAI_API_KEY" });
    const setup = plannerSetup({ OPENAI_API_KEY: other }, root);
    expect(setup.ok && setup.settings.key).toBe(other);
    const fromStore = plannerSetup({}, root);
    expect(
      fromStore.ok && [fromStore.settings.key, fromStore.settings.keyFrom],
    ).toEqual([secret, { kind: "store" }]);
    const rows = keyRows({ OPENAI_API_KEY: other }, root).rows;
    expect(rows.find((row) => row.provider.id === "openai")).toMatchObject({
      from: { kind: "environment", name: "OPENAI_API_KEY" },
      shadowed: true,
    });
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toContain(other);
  });

  it("refuses a store that others can read, and does not overwrite it", () => {
    const root = home();
    storeKey(root, openai, secret);
    const file = keyStoreFile(root);
    chmodSync(file, 0o640);
    const read = storedKeys(root);
    expect(read.keys).toEqual({});
    expect(read.problem).toMatch(
      /is not a regular file of this user for its owner only/,
    );
    expect(read.problem).toContain(`chmod 600 ${file}`);
    expect(() => storeKey(root, anthropic, other)).toThrow(KeyStoreError);
    expect(() => removeStoredKey(root, openai)).toThrow(KeyStoreError);
    expect(JSON.parse(readFileSync(file, "utf8")).keys).toEqual({
      openai: secret,
    });
    // The planner does not use it, and says why.
    const setup = plannerSetup({}, root);
    expect(setup).toMatchObject({ ok: false, reason: "no_key" });
    expect(!setup.ok && setup.problem).toMatch(
      /not a regular file of this user/,
    );
    expect(!setup.ok && setup.problem).not.toContain(secret);
  });

  it("refuses a folder that others can open, a link in place of the file, a file of another user, and a file that is not valid", () => {
    const open = home();
    storeKey(open, openai, secret);
    chmodSync(computerDirectory(open), 0o755);
    expect(storedKeys(open).problem).toMatch(/chmod 700/);
    expect(() => storeKey(open, anthropic, other)).toThrow(/chmod 700/);
    chmodSync(computerDirectory(open), 0o700);

    const linked = home();
    mkdirSync(computerDirectory(linked), { mode: 0o700 });
    const elsewhere = join(linked, "elsewhere.json");
    writeFileSync(
      elsewhere,
      JSON.stringify({ version: 1, keys: { openai: secret } }),
      {
        mode: 0o600,
      },
    );
    symlinkSync(elsewhere, keyStoreFile(linked));
    expect(storedKeys(linked)).toMatchObject({ keys: {} });
    expect(storedKeys(linked).problem).toMatch(/not a regular file/);
    expect(() => storeKey(linked, anthropic, other)).toThrow();

    const foreign = home();
    storeKey(foreign, openai, secret);
    vi.spyOn(process, "getuid").mockReturnValue(4_000_000);
    expect(storedKeys(foreign).problem).toMatch(
      /not a folder of this user|not a regular file of this user/,
    );
    vi.restoreAllMocks();

    const broken = home();
    mkdirSync(computerDirectory(broken), { mode: 0o700 });
    writeFileSync(
      keyStoreFile(broken),
      `{"version":1,"keys":{"openai":"${secret}"`,
      {
        mode: 0o600,
      },
    );
    const problem = storedKeys(broken).problem!;
    expect(problem).toMatch(/is not valid, so it is not used and not changed/);
    expect(problem).not.toContain(secret);
    expect(() => storeKey(broken, anthropic, other)).toThrow(/is not valid/);
    expect(readFileSync(keyStoreFile(broken), "utf8")).toContain(secret);
  });

  it("checks a key and never quotes it", () => {
    expect(checkKey(`\t${secret}\r\n`)).toBe(secret);
    for (const bad of [
      "",
      "   \n",
      `${secret} ${other}`,
      `${secret}\u0007`,
      "x".repeat(5000),
    ]) {
      let message = "";
      try {
        checkKey(bad);
      } catch (error) {
        expect(error).toBeInstanceOf(KeyStoreError);
        message = (error as Error).message;
      }
      expect(message).toMatch(/Nothing was stored\.$/);
      expect(message).not.toContain(secret);
      expect(message).not.toContain(other);
    }
  });

  it("keeps the chosen model in its own private file", () => {
    const root = home();
    expect(readModelChoice(root)).toEqual({ choice: null, problem: null });
    storeModelChoice(root, { model: "anthropic/claude-opus-5-5" });
    expect(mode(modelChoiceFile(root))).toBe(0o600);
    expect(readModelChoice(root).choice).toEqual({
      model: "anthropic/claude-opus-5-5",
    });
    storeModelChoice(root, null);
    expect(readModelChoice(root).choice).toBeNull();
    expect(() => storeModelChoice(root, { model: `sk-ant-${secret}` })).toThrow(
      /looks like a key/,
    );
    chmodSync(modelChoiceFile(root), 0o644);
    expect(readModelChoice(root).problem).toMatch(/not a regular file/);
    expect(plannerSetup({ OPENAI_API_KEY: other }, root)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    // A model in the environment wins, and needs no stored choice.
    expect(
      plannerSetup(
        { OPENAI_API_KEY: other, CLAWDTIME_COMPUTER_MODEL: "gpt-4.1" },
        root,
      ),
    ).toMatchObject({
      ok: true,
      settings: { model: "gpt-4.1", modelFrom: "environment" },
    });
  });
});

describe("clawdtime keys", () => {
  it("sets, lists and removes a key, and never prints any part of it", async () => {
    const { root, keys, asked } = cli();
    const before = await keys("list");
    expect(before).toMatch(
      /^Keys of the language model providers\. The environment wins over the store\./,
    );
    expect(before).toMatch(/anthropic +not set/);
    const set = await keys("set", "anthropic");
    expect(asked).toEqual(["Key for Anthropic (it is not shown): "]);
    expect(set).toMatch(
      /^The key for Anthropic is stored in .*keys\.json, for its owner only\. The desktop service reads it when it starts: start it again\.$/,
    );
    expect(storedKeys(root).keys.anthropic).toBe(secret);
    const after = await keys("list");
    expect(after).toMatch(/anthropic +set, in the key store/);
    expect(after).toMatch(/openai +not set/);
    expect(after).toContain(`Store: ${keyStoreFile(root)}`);
    expect(await keys("remove", "anthropic")).toBe(
      "The stored key for Anthropic is removed. Start the desktop service again.",
    );
    expect(await keys("remove", "anthropic")).toBe(
      "No key for Anthropic is stored.",
    );
    for (const text of [set, after, before]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(secret.slice(0, 8));
      expect(text).not.toContain(secret.slice(-6));
    }
  });

  it("says when the environment wins, and when a provider needs a chosen model", async () => {
    const { keys } = cli({ TOGETHER_API_KEY: other });
    const set = await keys("set", "together");
    expect(set).toMatch(
      /TOGETHER_API_KEY is set in this environment, and it wins over the stored key\./,
    );
    expect(set).toMatch(
      /Together AI has no default model\. Choose one that reads pictures: clawdtime computer model together\/MODEL/,
    );
    expect(await keys("list")).toMatch(
      /together +set, in the environment \(TOGETHER_API_KEY\)\. It wins over the stored key/,
    );
    expect(set).not.toContain(other);
    expect(set).not.toContain(secret);
  });

  it("refuses a provider it does not know, a bad key and a store that others can read, with no key in the error", async () => {
    const { root, keys } = cli({}, `${secret} trailing words`);
    await expect(keys("set", "nowhere")).rejects.toThrow(/Name one provider/);
    await expect(keys("set")).rejects.toThrow(/Use: clawdtime keys/);
    const error = await keys("set", "openai").catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(KeyStoreError);
    expect((error as Error).message).not.toContain(secret);
    storeKey(root, openai, other);
    chmodSync(keyStoreFile(root), 0o604);
    const list = await keys("list");
    expect(list).toMatch(/openai +not set/);
    expect(list).toMatch(/not a regular file of this user for its owner only/);
    expect(list).not.toContain(other);
  });
});

describe("clawdtime computer model", () => {
  it("shows, chooses and clears the model, and the environment wins", async () => {
    const { root, keys, computer } = cli();
    expect(await computer("model")).toMatch(
      /^Model of the planner: gpt-6\.2-astra\. CLAWDTIME_COMPUTER_MODEL changes it\./,
    );
    const chosen = await computer("model", "anthropic/claude-opus-5-5");
    expect(chosen).toMatch(
      /^The planner model is now anthropic\/claude-opus-5-5\. Start the ClawdTime desktop service again/,
    );
    expect(chosen).toMatch(
      /no key for Anthropic is set\. Set one: clawdtime keys set anthropic/,
    );
    expect(chosen).toMatch(
      /npm run eval:computer:planner -- anthropic\/claude-opus-5-5/,
    );
    expect(readModelChoice(root).choice).toEqual({
      model: "anthropic/claude-opus-5-5",
    });
    await keys("set", "anthropic");
    const shown = await computer("model");
    expect(shown).toMatch(
      /anthropic\/claude-opus-5-5\. clawdtime computer model chose it/,
    );
    expect(shown).toMatch(/Key: found in the key store, for Anthropic/);
    expect(shown).not.toContain(secret);
    const doctor = await computer("doctor");
    expect(doctor).toMatch(/model key +found in the key store, for Anthropic/);
    expect(doctor).toMatch(
      /model +anthropic\/claude-opus-5-5\. clawdtime computer model chose it/,
    );
    expect(doctor).toMatch(/effort +low, the default of the planner/);
    expect(doctor).toMatch(
      /speed +standard\. CLAWDTIME_COMPUTER_SPEED=fast turns on fast mode/,
    );
    expect(doctor).toMatch(
      /A refusal goes to the default fallback model of the service/,
    );
    expect(doctor).not.toContain(secret);
    expect(await computer("model", "auto")).toMatch(/^No model is chosen now/);
    expect(readModelChoice(root).choice).toBeNull();
    // With a key of Anthropic only, Anthropic is the first provider with a key.
    expect(await computer("model")).toMatch(
      /anthropic\/claude-opus-5-5, the default of Anthropic, the first provider with a key/,
    );
  });

  it("takes a base address for a custom service only, and refuses a key as a model with no echo", async () => {
    const { root, computer } = cli({ CLAWDTIME_COMPUTER_MODEL: "gpt-4.1" });
    const custom = await computer(
      "model",
      "custom/local-vision",
      "--base-url",
      "http://127.0.0.1:8080/v1",
    );
    expect(custom).toMatch(
      /CLAWDTIME_COMPUTER_MODEL is set in this environment, and it wins over the stored choice\./,
    );
    expect(readModelChoice(root).choice).toEqual({
      model: "custom/local-vision",
      baseUrl: "http://127.0.0.1:8080/v1",
    });
    // A new model of the custom service keeps its address.
    await computer("model", "custom/other-vision");
    expect(readModelChoice(root).choice?.baseUrl).toBe(
      "http://127.0.0.1:8080/v1",
    );
    await expect(
      computer("model", "custom/x", "--base-url", "http://example.test/v1"),
    ).rejects.toThrow(/base address cannot be used/);
    await expect(
      computer(
        "model",
        "anthropic/claude-opus-5-5",
        "--base-url",
        "https://example.test",
      ),
    ).rejects.toThrow(/Only the custom provider/);
    const error = await computer("model", `sk-ant-${secret}`).catch(
      (caught: Error) => caught,
    );
    expect((error as Error).message).toMatch(/looks like a key/);
    expect((error as Error).message).not.toContain(secret);
  });

  it("doctor names a provider with no default model, and an effort that the model does not take", async () => {
    const together = cli({ TOGETHER_API_KEY: other });
    const doctor = await together.computer("doctor");
    expect(doctor).toMatch(
      /model key +found for Together AI\. See the model line\./,
    );
    expect(doctor).toMatch(
      /model +none\. A key for Together AI is set, but Together AI has no default model\. Choose one that reads pictures: clawdtime computer model together\/MODEL/,
    );
    expect(doctor).not.toContain(other);
    const old = cli({
      OPENAI_API_KEY: other,
      CLAWDTIME_COMPUTER_MODEL: "gpt-4.1",
      CLAWDTIME_COMPUTER_EFFORT: "high",
      CLAWDTIME_COMPUTER_SPEED: "fast",
    });
    const text = await old.computer("doctor");
    expect(text).toMatch(
      /effort +not sent: gpt-4\.1 takes no reasoning effort\./,
    );
    expect(text).toMatch(
      /speed +standard: fast mode is not there for gpt-4\.1\./,
    );
    const newest = await cli({
      OPENAI_API_KEY: other,
      CLAWDTIME_COMPUTER_MODEL: "gpt-6.2-astra",
    }).computer("doctor");
    expect(newest).toMatch(
      /effort +low for a step and medium for the plan, as reasoning\.effort\. gpt-6\.2-astra goes to the Responses route\./,
    );
    const routed = await cli({
      OPENAI_API_KEY: other,
      CLAWDTIME_COMPUTER_EFFORT: "high",
      CLAWDTIME_OPENAI_API: "responses",
    }).computer("doctor");
    expect(routed).toMatch(
      /effort +high, set by CLAWDTIME_COMPUTER_EFFORT, as reasoning\.effort\. CLAWDTIME_OPENAI_API chose the Responses route\./,
    );
    const bad = await cli({
      OPENAI_API_KEY: other,
      CLAWDTIME_COMPUTER_EFFORT: "huge",
    }).computer("doctor");
    expect(bad).toMatch(
      /model +none\. CLAWDTIME_COMPUTER_EFFORT is not low, medium, high or xhigh/,
    );
  });
});

describe("the machine readable answers for the Mac app", () => {
  const never = (text: string, ...keys: string[]) => {
    for (const key of keys) {
      expect(text).not.toContain(key);
      expect(text).not.toContain(key.slice(0, 10));
      expect(text).not.toContain(key.slice(-8));
    }
  };

  it("keys list --json names each provider, where its key comes from and its default model, and never a key", async () => {
    const { root, keys } = cli({ TOGETHER_API_KEY: other });
    await keys("set", "anthropic");
    await keys("set", "together");
    const text = await keys("list", "--json");
    expect(text.split("\n")).toHaveLength(1);
    const report = JSON.parse(text) as {
      version: number;
      store: string;
      problem: string | null;
      providers: Record<string, unknown>[];
    };
    expect(report).toMatchObject({
      version: 1,
      store: keyStoreFile(root),
      problem: null,
    });
    expect(report.providers.map((row) => row.id)).toEqual([...providerIds]);
    const row = (id: string) => report.providers.find((p) => p.id === id);
    expect(row("openai")).toEqual({
      id: "openai",
      name: "OpenAI",
      set: false,
      source: null,
      variable: null,
      stored: false,
      defaultModel: "gpt-6.2-astra",
      needsModel: false,
      needsBaseUrl: false,
    });
    expect(row("anthropic")).toEqual({
      id: "anthropic",
      name: "Anthropic",
      set: true,
      source: "store",
      variable: null,
      stored: true,
      defaultModel: "claude-opus-5-5",
      needsModel: false,
      needsBaseUrl: false,
    });
    // The environment wins, and the stored key under it is still there.
    expect(row("together")).toEqual({
      id: "together",
      name: "Together AI",
      set: true,
      source: "environment",
      variable: "TOGETHER_API_KEY",
      stored: true,
      defaultModel: null,
      needsModel: true,
      needsBaseUrl: false,
    });
    expect(row("custom")).toMatchObject({
      set: false,
      needsModel: true,
      needsBaseUrl: true,
    });
    never(text, secret, other);
  });

  it("keys list --json says when the store cannot be used, and takes no other word", async () => {
    const { root, keys } = cli();
    storeKey(root, openai, other);
    chmodSync(keyStoreFile(root), 0o604);
    const text = await keys("list", "--json");
    const report = JSON.parse(text) as {
      problem: string;
      providers: { id: string; set: boolean }[];
    };
    expect(report.problem).toMatch(
      /not a regular file of this user for its owner only/,
    );
    expect(report.providers.find((p) => p.id === "openai")?.set).toBe(false);
    never(text, other);
    await expect(keys("list", "--yaml")).rejects.toThrow(/Use: clawdtime keys/);
    await expect(keys("list", "--json", "more")).rejects.toThrow(
      /Use: clawdtime keys/,
    );
  });

  it("computer model --json says the provider, the model and where the choice comes from", async () => {
    const { keys, computer } = cli();
    const read = async (...extra: string[]) => {
      const text = await computer("model", "--json", ...extra);
      expect(text.split("\n")).toHaveLength(1);
      never(text, secret, other);
      return JSON.parse(text) as Record<string, unknown>;
    };
    expect(await read()).toEqual({
      version: 1,
      ok: false,
      reason: "no_key",
      problem: expect.stringMatching(/^No key for a language model is set\./),
      provider: null,
      providerName: null,
      model: null,
      name: null,
      from: "default",
      variable: null,
      baseUrl: null,
      key: null,
    });
    await keys("set", "anthropic");
    expect(await read()).toEqual({
      version: 1,
      ok: true,
      reason: null,
      problem: null,
      provider: "anthropic",
      providerName: "Anthropic",
      model: "claude-opus-5-5",
      name: "anthropic/claude-opus-5-5",
      from: "default",
      variable: null,
      baseUrl: null,
      key: { source: "store", variable: null },
    });
    await computer("model", "groq/a-vision-model");
    expect(await read()).toMatchObject({
      ok: false,
      reason: "missing_key",
      provider: "groq",
      providerName: "Groq",
      model: "a-vision-model",
      name: "groq/a-vision-model",
      from: "store",
      key: null,
    });
    await computer(
      "model",
      "custom/local-vision",
      "--base-url",
      "http://127.0.0.1:8080/v1",
    );
    expect(await read()).toMatchObject({
      ok: true,
      provider: "custom",
      model: "local-vision",
      from: "store",
      baseUrl: "http://127.0.0.1:8080/v1",
      key: { source: null, variable: null },
    });
    await expect(computer("model", "--json", "more")).rejects.toThrow(
      /Use: clawdtime computer/,
    );
  });

  it("computer model --json names the variable that wins, and never a model setting that looks like a key", async () => {
    const chosen = cli({
      OPENAI_API_KEY: other,
      CLAWDTIME_COMPUTER_MODEL: "gpt-4.1",
    });
    await chosen.computer("model", "anthropic/claude-opus-5-5");
    const text = await chosen.computer("model", "--json");
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      provider: "openai",
      model: "gpt-4.1",
      name: "gpt-4.1",
      from: "environment",
      variable: "CLAWDTIME_COMPUTER_MODEL",
      key: { source: "environment", variable: "OPENAI_API_KEY" },
    });
    never(text, other);
    const pasted = cli({ CLAWDTIME_COMPUTER_MODEL: `sk-ant-${secret}` });
    const refused = await pasted.computer("model", "--json");
    expect(JSON.parse(refused)).toMatchObject({
      ok: false,
      reason: "invalid",
      provider: null,
      model: null,
      name: null,
      from: "environment",
    });
    never(refused, secret);
  });
});

describe("the service with stored keys", () => {
  it("builds the worker with a stored key, and says what is missing for a chosen model", () => {
    const root = home();
    setComputerSwitch(root, true);
    expect(buildComputer({ root, env: {} }).port.status().message).toBe(
      noKeyText,
    );
    storeKey(root, anthropic, secret);
    const built = buildComputer({ root, env: {} });
    expect(built.worker).not.toBeNull();
    expect(built.port.status()).toMatchObject({ enabled: true, state: "idle" });
    storeModelChoice(root, { model: "together/a-vision-model" });
    const missing = buildComputer({ root, env: {} }).port.status();
    expect(missing.enabled).toBe(false);
    expect(missing.message).toMatch(
      /^The planner model is together\/a-vision-model, but no key for Together AI is set\. Set one: clawdtime keys set together/,
    );
    expect(missing.message).not.toContain(secret);
  });
});
