/**
 * `clawdtime settings`: every setting of ClawdTime in one place, for a person
 * in a terminal and for the Settings window of the Mac app, which reads and
 * writes them only through this command.
 *
 * A setting lives where its part reads it:
 * - Memory, away and computer use keep their own files, which the service
 *   reads on every use: a change works at once.
 * - The look of the mascot and the voice are preferences of the panel. The
 *   command writes them with `defaults` and posts a notice, so a running
 *   panel reads them again at once.
 * - The models keep their own files: the planner in computer/model.json, the
 *   chat in settings.json.
 * - Settings that the service reads from its environment are kept in
 *   settings.json. `clawdtime start` gives them to the service as variables
 *   (`applyStoredSettings`). A variable that is set already wins, as for the
 *   planner model. The service reads them when it starts.
 *
 * Nothing here holds or prints a key.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stateRoot } from "../connectors/agents/hooks.js";
import { looksSecret, Memory } from "../connectors/agents/memory.js";
import { DecisionDesk, deskDirectory } from "../connectors/agents/decisions.js";
import { defaultChatAgentModel } from "../connectors/agents/chat-model.js";
import {
  computerDirectory,
  readComputerSwitch,
  setComputerSwitch,
} from "../connectors/computer/journal.js";
import {
  plannerSetup,
  readModelChoice,
  storedKeys,
  storeModelChoice,
} from "../connectors/computer/keys.js";
import {
  defaultComputerModel,
  modelName,
  parseModel,
} from "../connectors/computer/providers.js";
import {
  readPrivateJSON,
  writePrivateJSON,
} from "../connectors/shared/private-file.js";
import { phoneEnding, readOwner } from "../connectors/shared/owner.js";
import {
  readSharedPairing,
  sharedConnectionLock,
  sharedPairingPaths,
} from "../src/onboard/pairing.js";
import { packageVersion } from "../src/onboard/system.js";
import { processLockHolder } from "../src/process-lock.js";
import { reachSummary } from "./computer.js";
import { macTrash, unpairThisMac } from "./uninstall.js";

export const settingsHelp = `clawdtime settings: every setting of ClawdTime in one place
  clawdtime settings [--json]                  each setting, its value, where it comes from and when a change works
  clawdtime settings set NAME VALUE [--json]   change one setting
  clawdtime settings reset NAME [--json]       go back to the default
  clawdtime settings forget-memory --yes [--json]    remove every fact in memory for good
  clawdtime settings privacy [--json]          what ClawdTime keeps on this Mac, and where
  clawdtime settings delete-history --yes [--json]   move the chat history, the spoken replies and the step times to the Trash
  clawdtime settings phone [--json]            the pairing of this Mac with the shared number, and calls to you
  clawdtime settings phone unpair --yes [--json]     unpair this Mac
  clawdtime settings update [--json]           check for a newer release
A variable in the environment wins over a stored setting. The desktop service
reads its settings when it starts: "applies" says when a change works.`;
const usage =
  "Use: clawdtime settings [--json] | set NAME VALUE | reset NAME | forget-memory --yes | privacy | delete-history --yes | phone [unpair --yes] | update";

export type SettingValue = boolean | number | string;
export type SettingSource = "store" | "environment" | "default";
/** When a change works: now, or when the desktop service starts again. */
export type Applies = "now" | "restart";

/** The preferences of the panel. The Mac writes them with `defaults`; tests keep them in memory. */
export interface PanelDefaults {
  read(): Record<string, unknown>;
  write(key: string, value: boolean | number | string): void;
  /** Tells a running panel to read its preferences again. */
  changed(): void;
}

export interface SettingsCliDependencies {
  env?: Record<string, string | undefined>;
  home?: string;
  print?: (line: string) => void;
  panel?: PanelDefaults;
  /** Moves a path to the Trash. Nothing here deletes a file. */
  trash?: (path: string) => Promise<void>;
  request?: typeof fetch;
  /** The version of this runtime. */
  version?: string;
  now?: () => number;
}

/** The file of the stored settings, in the state folder, for its owner only. */
export const settingsFile = (root: string) => join(root, "settings.json");

type Stored = Record<string, SettingValue>;
function readStore(root: string): { values: Stored; problem: string | null } {
  const read = readPrivateJSON(settingsFile(root));
  if (read.problem) return { values: {}, problem: read.problem };
  const value = read.value as { version?: unknown; values?: unknown } | null;
  if (value === null) return { values: {}, problem: null };
  if (
    value.version !== 1 ||
    typeof value.values !== "object" ||
    value.values === null ||
    Array.isArray(value.values)
  )
    return {
      values: {},
      problem: `${settingsFile(root)} is not valid, so it is not used and not changed. Look at it, and move it away to start again.`,
    };
  return { values: value.values as Stored, problem: null };
}
function writeStore(root: string, change: (values: Stored) => void) {
  const { values, problem } = readStore(root);
  // A file that cannot be read is never written over in silence.
  if (problem) throw new Error(problem);
  change(values);
  writePrivateJSON(settingsFile(root), { version: 1, values });
}

// MARK: the definitions

interface Context {
  env: Record<string, string | undefined>;
  root: string;
  home: string;
  panel: PanelDefaults;
  now: () => number;
  /** Read once for each command. */
  store: Stored;
  panelValues: Record<string, unknown>;
}

interface Definition {
  id: string;
  kind: "boolean" | "choice" | "number" | "text" | "model";
  choices?: readonly string[];
  min?: number;
  max?: number;
  step?: "integer";
  default: SettingValue;
  /** When a change works. Computer use on needs a start; off works at once. */
  applies: Applies;
  /** The variable of the service's environment that wins over the stored value. */
  variable?: string;
  /** The stored value as that variable. Undefined: the variable stays unset. */
  toVariable?: (value: SettingValue) => string | undefined;
  read(context: Context): { value: SettingValue; from: SettingSource };
  /** Stores a checked value, or the default for null. Returns when it works. */
  write(context: Context, value: SettingValue | null): Applies;
  /** The choices that this Mac can use now, when they depend on it. */
  choicesNow?(context: Context): readonly string[];
}

const mascotStyles = [
  "flint",
  "jet",
  "jade",
  "lapis",
  "amber",
  "garnet",
  "amethyst",
  "pebble",
  "core",
  "neon",
  "iris",
] as const;
/** The voices of the speech model of OpenAI. */
const voices = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "marin",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
] as const;

const round = (value: number) => Math.round(value * 100) / 100;

/** A preference of the panel, in its own preferences. A running panel reads it again at once. */
function panelSetting(
  id: string,
  key: string,
  spec: Pick<Definition, "kind" | "choices" | "min" | "max"> & {
    default: SettingValue;
  },
): Definition {
  const fits = (value: unknown): value is SettingValue =>
    spec.kind === "boolean"
      ? typeof value === "boolean"
      : spec.kind === "number"
        ? typeof value === "number" &&
          Number.isFinite(value) &&
          value >= spec.min! &&
          value <= spec.max!
        : typeof value === "string" &&
          (!spec.choices || spec.choices.includes(value));
  return {
    id,
    ...spec,
    applies: "now",
    read: ({ panelValues }) => {
      const value = panelValues[key];
      if (!fits(value)) return { value: spec.default, from: "default" };
      return {
        value: typeof value === "number" ? round(value) : value,
        from: "store",
      };
    },
    write: ({ panel }, value) => {
      panel.write(key, value ?? spec.default);
      panel.changed();
      return "now";
    },
  };
}

/** A setting that the service reads from its environment, kept in settings.json. */
function serviceSetting(
  id: string,
  variable: string,
  spec: Pick<Definition, "kind" | "choices" | "min" | "max" | "step"> & {
    default: SettingValue;
    /** The variable, as it is, read as the service reads it. */
    fromVariable: (text: string) => SettingValue;
    toVariable: (value: SettingValue) => string | undefined;
  },
): Definition {
  const { fromVariable, ...rest } = spec;
  const definition: Definition = {
    id,
    ...rest,
    applies: "restart",
    variable,
    read: ({ env, store }) => {
      const raw = env[variable];
      if (raw?.trim()) return { value: fromVariable(raw), from: "environment" };
      const stored = store[id];
      if (stored !== undefined && fitsStored(definition, stored))
        return { value: stored, from: "store" };
      return { value: spec.default, from: "default" };
    },
    write: ({ root }, value) => {
      writeStore(root, (values) => {
        if (value === null) delete values[id];
        else values[id] = value;
      });
      return "restart";
    },
  };
  return definition;
}
/** True when a stored value fits its setting: a hand can change the file. */
function fitsStored(definition: Definition, value: unknown) {
  if (
    typeof value !== "boolean" &&
    typeof value !== "number" &&
    typeof value !== "string"
  )
    return false;
  try {
    // The type counts too: "off" is not off, and "on " is not on.
    return parseValue(definition, String(value)) === value;
  } catch {
    return false;
  }
}

const switchFile = (root: string) =>
  join(computerDirectory(root), "config.json");

/** The planner model as people write it, from what the planner would use. */
function plannerName(context: Context): {
  value: string;
  from: SettingSource;
} {
  const fromEnvironment = context.env.CLAWDTIME_COMPUTER_MODEL?.trim();
  const stored = readModelChoice(context.root).choice;
  const setup = plannerSetup(context.env, context.root);
  const from: SettingSource = fromEnvironment
    ? "environment"
    : stored
      ? "store"
      : "default";
  if (setup.ok)
    return {
      value: modelName(setup.settings.provider, setup.settings.model),
      from,
    };
  return {
    value: fromEnvironment || stored?.model || defaultComputerModel,
    from,
  };
}

const definitions: Definition[] = [
  // General
  panelSetting("mascot.style", "pet.style", {
    kind: "choice",
    choices: mascotStyles,
    default: "flint",
  }),
  panelSetting("mascot.size", "pet.size", {
    kind: "number",
    min: 0.5,
    max: 1.5,
    default: 0.7,
  }),
  panelSetting("mascot.eye", "pet.flintEye", {
    kind: "boolean",
    default: false,
  }),
  serviceSetting("cursor.pace", "CLAWDTIME_CURSOR_PACE", {
    kind: "choice",
    choices: ["auto", "calm", "fast"],
    default: "auto",
    // The panel reads it in any case, with no space around it.
    fromVariable: (text) => {
      const pace = text.trim().toLowerCase();
      return pace === "calm" || pace === "fast" ? pace : "auto";
    },
    toVariable: (value) => (value === "auto" ? undefined : String(value)),
  }),
  // Assistant
  panelSetting("voice.replies", "voice.replies", {
    kind: "boolean",
    default: true,
  }),
  serviceSetting("voice.name", "CLAWDTIME_VOICE", {
    kind: "choice",
    choices: voices,
    default: "alloy",
    fromVariable: (text) => text,
    toVariable: (value) => String(value),
  }),
  panelSetting("voice.speed", "voice.rate", {
    kind: "number",
    min: 0.5,
    max: 2,
    default: 1,
  }),
  serviceSetting("vocabulary", "CLAWDTIME_VOCABULARY", {
    kind: "text",
    default: "",
    fromVariable: (text) => text,
    toVariable: (value) => (String(value).trim() ? String(value) : undefined),
  }),
  {
    id: "memory",
    kind: "boolean",
    default: false,
    applies: "now",
    read: ({ root }) => ({
      value: new Memory(root).enabled(),
      from: existsSync(join(root, "memory", "settings.json"))
        ? "store"
        : "default",
    }),
    write: ({ root }, value) => {
      new Memory(root).setEnabled(value === true);
      return "now";
    },
  },
  {
    id: "away",
    kind: "boolean",
    default: false,
    applies: "now",
    read: ({ root }) => ({
      value: new DecisionDesk(root).away(),
      from: existsSync(join(deskDirectory(root), "mode.json"))
        ? "store"
        : "default",
    }),
    write: ({ root, now }, value) => {
      new DecisionDesk(root, now).setAway(value === true);
      return "now";
    },
  },
  // Models
  {
    id: "speed",
    kind: "choice",
    default: "best",
    applies: "restart",
    choicesNow: (context) =>
      presetsFor(context).presets.map((preset) => preset.id),
    read: (context) => ({ value: currentPreset(context), from: "default" }),
    write: (context, value) => {
      const preset = presetsFor(context).presets.find(
        (item) => item.id === (value ?? "best"),
      );
      if (!preset)
        throw new Error(
          `Choose one of: ${presetsFor(context)
            .presets.map((item) => item.id)
            .join(", ")}.`,
        );
      const plain =
        preset.planner === defaultComputerModel &&
        preset.chat === defaultChatAgentModel;
      // Both files change, or neither: the store is checked first.
      const { problem } = readStore(context.root);
      if (problem) throw new Error(problem);
      storeModelChoice(context.root, plain ? null : { model: preset.planner });
      writeStore(context.root, (values) => {
        if (plain) delete values["model.chat"];
        else values["model.chat"] = preset.chat;
      });
      return "restart";
    },
  },
  {
    id: "model.planner",
    kind: "model",
    default: defaultComputerModel,
    applies: "restart",
    variable: "CLAWDTIME_COMPUTER_MODEL",
    read: plannerName,
    write: ({ root }, value) => {
      if (value === null) storeModelChoice(root, null);
      else {
        const parsed = parseModel(String(value), looksSecret);
        if (!parsed.ok) throw new Error(parsed.problem);
        // A custom service keeps the address that it had.
        const baseUrl =
          parsed.provider.id === "custom"
            ? readModelChoice(root).choice?.baseUrl
            : undefined;
        storeModelChoice(root, {
          model: String(value).trim(),
          ...(baseUrl ? { baseUrl } : {}),
        });
      }
      return "restart";
    },
  },
  serviceSetting("model.chat", "CLAWDTIME_SUPERVISOR_MODEL", {
    kind: "model",
    default: defaultChatAgentModel,
    fromVariable: (text) => text.trim(),
    toVariable: (value) => String(value),
  }),
  // Computer use
  {
    id: "computer",
    kind: "boolean",
    default: false,
    applies: "restart",
    read: ({ root }) => ({
      value: readComputerSwitch(root).enabled,
      from: existsSync(switchFile(root)) ? "store" : "default",
    }),
    write: ({ root, now }, value) => {
      setComputerSwitch(root, value === true, now());
      // Off stops before the next action. On builds the worker when the service starts.
      return value === true ? "restart" : "now";
    },
  },
  serviceSetting("computer.ask", "CLAWDTIME_COMPUTER_TRUST", {
    kind: "choice",
    choices: ["risky", "never"],
    default: "risky",
    fromVariable: (text) => (text === "on" ? "never" : "risky"),
    toVariable: (value) => (value === "never" ? "on" : undefined),
  }),
  serviceSetting("computer.browser", "CLAWDTIME_COMPUTER_BROWSER", {
    kind: "choice",
    choices: ["off", "on", "own"],
    default: "off",
    // "auto" is ClawdTime's own browser when one is found, else off.
    fromVariable: (text) =>
      text === "on" || text === "own" || text === "auto" ? text : "off",
    toVariable: (value) => (value === "off" ? undefined : String(value)),
  }),
  // Phone
  serviceSetting("reach", "CLAWDTIME_COMPUTER_REACH", {
    kind: "boolean",
    default: true,
    fromVariable: (text) => text !== "off",
    toVariable: (value) => (value === false ? "off" : undefined),
  }),
  serviceSetting("reach.wait", "CLAWDTIME_COMPUTER_REACH_SECONDS", {
    kind: "number",
    min: 0,
    max: 600,
    step: "integer",
    default: 45,
    fromVariable: (text) => {
      const value = Number(text);
      return Number.isFinite(value) && value >= 0 && value <= 600 ? value : 45;
    },
    toVariable: (value) => String(value),
  }),
];

const keyWord =
  /(?:^|[\s,/])(?:sk-|sk_|gsk_|xai-|fw_|AIza|tgp_|r8_|pplx-|nvapi-)/;
/** Shown for a value that looks like a key: a key is never printed. */
export const hiddenValue = "(hidden: it looks like a key)";
/** A value as it may be shown. A text that looks like a key is never shown. */
const visible = (value: SettingValue): SettingValue =>
  typeof value === "string" && (looksSecret(value) || keyWord.test(value))
    ? hiddenValue
    : value;

/** Every id, in the order of the Settings window. */
export const settingIds = definitions.map((definition) => definition.id);

/** The words of a person, as a value of the setting. Throws a plain sentence. */
function parseValue(definition: Definition, text: string): SettingValue {
  const raw = text.trim();
  const name = definition.id;
  switch (definition.kind) {
    case "boolean": {
      const word = raw.toLowerCase();
      if (["on", "true", "yes", "1"].includes(word)) return true;
      if (["off", "false", "no", "0"].includes(word)) return false;
      throw new Error(`Use on or off for ${name}.`);
    }
    case "number": {
      const value = Number(raw);
      const range = `Use a number from ${definition.min} to ${definition.max} for ${name}.`;
      if (!raw || !Number.isFinite(value)) throw new Error(range);
      if (value < definition.min! || value > definition.max!)
        throw new Error(range);
      if (definition.step === "integer" && !Number.isInteger(value))
        throw new Error(`Use a whole number for ${name}.`);
      return value;
    }
    case "choice": {
      const choices = definition.choices ?? [];
      if (!choices.includes(raw))
        throw new Error(`Choose one of: ${choices.join(", ")}.`);
      return raw;
    }
    case "text": {
      if (looksSecret(raw))
        throw new Error(
          `That looks like a key. ClawdTime keeps no key in a setting. Nothing was changed.`,
        );
      if (raw.length > 400 || /\p{C}/u.test(raw))
        throw new Error(
          `Use plain words for ${name}: 400 characters or fewer, with no line break.`,
        );
      return raw;
    }
    case "model": {
      const parsed = parseModel(raw, looksSecret);
      if (!parsed.ok) throw new Error(parsed.problem);
      return raw;
    }
  }
}

// MARK: speed presets

export interface SpeedPreset {
  id: "fast" | "balanced" | "best";
  planner: string;
  chat: string;
  /** What the evals measured, in one short sentence. */
  summary: string;
}

/**
 * The presets of the Speed setting, from the evals: the planner test (38
 * screens, two runs) and the request test (23 tasks) on build 3821123 of
 * 26 November 2026, and the chat bench of 20 November 2026. Measure again
 * before a line changes: npm run eval:computer:planner, eval:computer:request,
 * eval:chat.
 */
export const speedPresets: Record<"openai" | "anthropic", SpeedPreset[]> = {
  openai: [
    {
      id: "fast",
      planner: "gpt-5.4",
      chat: "gpt-4.1-mini",
      summary:
        "About 1.5 s for each step. 76 of 76 screens right, 22 of 23 long tasks done.",
    },
    {
      id: "balanced",
      planner: "gpt-6.2-sol",
      chat: "gpt-4.1-mini",
      summary:
        "About 2 s for each step. 74 of 76 screens right, 23 of 23 long tasks done.",
    },
    {
      id: "best",
      planner: defaultComputerModel,
      chat: defaultChatAgentModel,
      summary:
        "About 3 s for each step. 76 of 76 screens right, 23 of 23 long tasks done.",
    },
  ],
  anthropic: [
    {
      id: "fast",
      planner: "anthropic/claude-fable-5-2",
      chat: "anthropic/claude-fable-5-2",
      summary:
        "About 1.6 s for each step. 74 of 76 screens right, 23 of 23 long tasks done.",
    },
    {
      id: "best",
      planner: "anthropic/claude-opus-5-5",
      chat: "anthropic/claude-opus-5-5",
      summary:
        "About 1.7 s for each step. 75 of 76 screens right, 23 of 23 long tasks done.",
    },
  ],
};

/** The provider that plans now, and its presets. A provider with no measurement has none. */
function presetsFor(context: Context): {
  provider: string;
  presets: SpeedPreset[];
} {
  const setup = plannerSetup(context.env, context.root);
  const provider = setup.ok
    ? setup.settings.provider.id
    : (setup.provider?.id ?? "openai");
  const presets =
    provider === "openai" || provider === "anthropic"
      ? speedPresets[provider]
      : [];
  return { provider, presets };
}

/** One spelling for a model: provider/model. */
const canonical = (text: string) => {
  const parsed = parseModel(text, looksSecret);
  return parsed.ok ? `${parsed.provider.id}/${parsed.model}` : text;
};

function currentPreset(context: Context): string {
  const planner = canonical(plannerName(context).value);
  const chat = canonical(
    String(definitionById("model.chat")!.read(context).value),
  );
  return (
    presetsFor(context).presets.find(
      (preset) =>
        canonical(preset.planner) === planner &&
        canonical(preset.chat) === chat,
    )?.id ?? "custom"
  );
}

const definitionById = (id: string) =>
  definitions.find((definition) => definition.id === id);

// MARK: the report

function context(dependencies: SettingsCliDependencies) {
  const env = dependencies.env ?? process.env;
  const home = dependencies.home ?? homedir();
  const root = stateRoot({ env, home });
  const panel = dependencies.panel ?? macPanelDefaults();
  const { values, problem } = readStore(root);
  let panelValues: Record<string, unknown> = {};
  try {
    panelValues = panel.read();
  } catch {
    panelValues = {};
  }
  const value: Context = {
    env,
    home,
    root,
    panel,
    now: dependencies.now ?? Date.now,
    store: values,
    panelValues,
  };
  return { context: value, problem };
}

function report(context: Context, problem: string | null) {
  const speed = presetsFor(context);
  return {
    version: 1,
    store: settingsFile(context.root),
    problem,
    settings: definitions.map((definition) => {
      const { value, from } = definition.read(context);
      return {
        id: definition.id,
        kind: definition.kind,
        value: visible(value),
        default: definition.default,
        from,
        applies: definition.applies,
        variable: definition.variable ?? null,
        ...(definition.choicesNow
          ? { choices: [...definition.choicesNow(context)] }
          : definition.choices
            ? { choices: [...definition.choices] }
            : {}),
        ...(definition.min !== undefined
          ? { min: definition.min, max: definition.max }
          : {}),
      };
    }),
    speed: { provider: speed.provider, presets: speed.presets },
  };
}
const shown = (value: SettingValue) =>
  typeof value === "boolean" ? (value ? "on" : "off") : String(value) || '""';

// MARK: the command

export async function settingsCli(
  args: string[],
  dependencies: SettingsCliDependencies = {},
) {
  const print = dependencies.print ?? console.log;
  const json = args.includes("--json");
  const rest = args.filter((arg) => arg !== "--json");
  const yes = rest.includes("--yes");
  const words = rest.filter((arg) => arg !== "--yes");
  const command = words[0] ?? "list";
  if (command === "help" || command === "--help") return print(settingsHelp);
  const { context: here, problem } = context(dependencies);
  const out = (value: unknown, text: string) =>
    print(json ? JSON.stringify(value) : text);

  if (command === "list") {
    if (words.length > 1) throw new Error(usage);
    const value = report(here, problem);
    if (json) return print(JSON.stringify(value));
    print("Settings of ClawdTime. A variable in the environment wins.");
    for (const setting of value.settings)
      print(
        `  ${setting.id.padEnd(17)} ${shown(setting.value as SettingValue)}${setting.from === "default" ? "" : `  (${setting.from === "store" ? "stored" : `from ${setting.variable}`})`}`,
      );
    if (problem) print(problem);
    return;
  }

  if (command === "set" || command === "reset") {
    const id = words[1];
    if (!id || words.length !== (command === "set" ? 3 : 2))
      throw new Error(usage);
    const definition = definitionById(id);
    if (!definition)
      throw new Error(`Name one setting: ${settingIds.join(", ")}.`);
    let value: SettingValue | null = null;
    if (command === "set") {
      if (definition.choicesNow) {
        const choices = definition.choicesNow(here);
        if (!choices.includes(words[2]!.trim()))
          throw new Error(
            choices.length
              ? `Choose one of: ${choices.join(", ")}.`
              : "Choose one of: none. The evals measured no preset for the provider in use. Choose the models in model.planner and model.chat.",
          );
        value = words[2]!.trim();
      } else value = parseValue(definition, words[2]!);
    }
    const applies = definition.write(here, value);
    const after = context(dependencies).context;
    const now = definition.read(after);
    const shadowed =
      definition.variable && here.env[definition.variable]?.trim()
        ? definition.variable
        : null;
    return out(
      {
        version: 1,
        ok: true,
        id,
        value: visible(now.value),
        from: now.from,
        applies,
        shadowed,
      },
      `${id} is now ${shown(visible(now.value))}. ${applies === "now" ? "It works now." : "The desktop uses it when it starts again."}${shadowed ? ` ${shadowed} is set in this environment, and it wins.` : ""}`,
    );
  }

  if (command === "forget-memory") {
    if (words.length !== 1) throw new Error(usage);
    if (!yes)
      throw new Error(
        "This removes every fact in memory for good. Run it again with --yes.",
      );
    const memory = new Memory(here.root, here.now);
    let removed = 0;
    for (const fact of memory.facts()) removed += memory.forget(fact.id);
    return out(
      { version: 1, ok: true, removed },
      removed
        ? `Removed ${removed} ${removed === 1 ? "fact" : "facts"} for good.`
        : "Memory is empty.",
    );
  }

  if (command === "privacy") {
    if (words.length !== 1) throw new Error(usage);
    const value = privacy(here);
    if (json) return print(JSON.stringify(value));
    print(
      `ClawdTime keeps these on this Mac. The state folder: ${value.folder}`,
    );
    for (const item of value.items)
      print(
        `  ${item.name}: ${item.exists ? `${item.count === null ? "" : `${item.count}, `}${size(item.bytes)}` : "none"}. ${item.path}`,
      );
    return;
  }

  if (command === "delete-history") {
    if (words.length !== 1) throw new Error(usage);
    if (!yes)
      throw new Error(
        "This moves the chat history, the spoken replies and the step times to the Trash. Run it again with --yes.",
      );
    const moved: string[] = [];
    for (const path of historyFiles(here.root)) {
      await (dependencies.trash ?? macTrash)(path);
      moved.push(path);
    }
    return out(
      {
        version: 1,
        ok: true,
        moved,
        kept: ["memory", "requests", "keys", "settings"],
        applies: "restart",
      },
      moved.length
        ? `Moved ${moved.length} ${moved.length === 1 ? "file" : "files"} to the Trash. The record of computer requests stays: it holds what each request did. The desktop forgets the chat when it starts again.`
        : "No history to move.",
    );
  }

  if (command === "update") {
    if (words.length !== 1) throw new Error(usage);
    const value = await checkUpdate(here.env, dependencies);
    return out(
      value,
      value.newer
        ? `ClawdTime ${value.latest} is out. This Mac has ${value.current}.`
        : `ClawdTime ${value.current} is the newest release.`,
    );
  }

  if (command === "phone") {
    if (words[1] === "unpair") {
      if (words.length !== 2) throw new Error(usage);
      if (!yes)
        throw new Error(
          "This unpairs this Mac from the shared number. Run it again with --yes.",
        );
      const value = await unpair(here, dependencies);
      return out(value, value.sentence);
    }
    if (words.length !== 1) throw new Error(usage);
    const value = phone(here);
    return out(
      value,
      value.pairing === "paired"
        ? `This Mac is paired with ${value.origin}. The connection is ${value.connection}.`
        : value.pairing === "unusable"
          ? "The pairing file cannot be used. Run setup again."
          : "This Mac is not paired. Run setup to pair it.",
    );
  }
  throw new Error(usage);
}

// MARK: start

/**
 * Gives the stored settings of the service to its environment, as the
 * variables that it reads. A variable that is set already wins. A file that
 * cannot be used gives nothing, and a stored value that does not fit is left
 * out. Returns the variables that it set.
 */
export function applyStoredSettings(
  env: Record<string, string | undefined>,
  root: string,
): string[] {
  const { values, problem } = readStore(root);
  if (problem) return [];
  const applied: string[] = [];
  for (const definition of definitions) {
    const { variable, toVariable } = definition;
    if (!variable || !toVariable) continue;
    const stored = values[definition.id];
    if (stored === undefined || !fitsStored(definition, stored)) continue;
    if (env[variable]?.trim()) continue;
    const text = toVariable(stored);
    if (text === undefined) continue;
    env[variable] = text;
    applied.push(variable);
  }
  return applied;
}

// MARK: privacy and history

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} bytes`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${Math.round(bytes / (1024 * 1024))} MB`;

/** The files and the bytes under a path, without following a link. */
function measure(path: string, filter?: (name: string) => boolean) {
  let files = 0;
  let bytes = 0;
  const walk = (place: string, depth: number) => {
    let stat;
    try {
      stat = lstatSync(place);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      files++;
      bytes += stat.size;
      return;
    }
    if (!stat.isDirectory() || depth > 6) return;
    let names: string[] = [];
    try {
      names = readdirSync(place);
    } catch {
      return;
    }
    for (const name of names)
      if (depth > 0 || !filter || filter(name))
        walk(join(place, name), depth + 1);
  };
  walk(path, 0);
  return { files, bytes, exists: existsSync(path) };
}

const chatName = /^chat(-[0-9TZ-]+)?\.jsonl$/;

/** The files that delete-history moves: the chats, the spoken replies and the step times. */
function historyFiles(root: string): string[] {
  const agents = join(root, "agents");
  const voice = join(agents, "voice");
  const computer = computerDirectory(root);
  const files: string[] = [];
  const regular = (path: string) => {
    try {
      return lstatSync(path).isFile();
    } catch {
      return false;
    }
  };
  // A folder that is a link, or that leads out of the state folder, is not read.
  let base: string;
  try {
    base = realpathSync(root);
  } catch {
    return [];
  }
  const own = (folder: string) => {
    try {
      return (
        lstatSync(folder).isDirectory() &&
        realpathSync(folder).startsWith(base + sep)
      );
    } catch {
      return false;
    }
  };
  const names = (folder: string) => {
    try {
      return readdirSync(folder).sort();
    } catch {
      return [];
    }
  };
  if (own(agents))
    for (const name of names(agents))
      if (chatName.test(name) && regular(join(agents, name)))
        files.push(join(agents, name));
  if (own(agents) && own(voice))
    for (const name of names(voice))
      if (regular(join(voice, name))) files.push(join(voice, name));
  const timing = join(computer, "timing.json");
  if (own(computer) && regular(timing)) files.push(timing);
  return files;
}

function privacy(context: Context) {
  const { root, home } = context;
  const item = (
    id: string,
    name: string,
    what: string,
    path: string,
    options: {
      removable: boolean;
      count?: number | null;
      filter?: (name: string) => boolean;
    },
  ) => {
    const measured = measure(path, options.filter);
    return {
      id,
      name,
      what,
      path,
      exists: options.filter ? measured.files > 0 : measured.exists,
      count: options.count === undefined ? measured.files : options.count,
      bytes: measured.bytes,
      removable: options.removable,
    };
  };
  let facts: number | null = null;
  try {
    facts = new Memory(root).facts().length;
  } catch {
    facts = null;
  }
  let keys: number | null = null;
  try {
    keys = Object.keys(storedKeys(root).keys).length;
  } catch {
    keys = null;
  }
  return {
    version: 1,
    folder: root,
    items: [
      item(
        "chat",
        "Chat history",
        "Your conversations with ClawdTime.",
        join(root, "agents"),
        { removable: true, filter: (name) => chatName.test(name) },
      ),
      item(
        "voice",
        "Spoken replies",
        "The last recording and spoken answer of a talk.",
        join(root, "agents", "voice"),
        { removable: true },
      ),
      item(
        "memory",
        "Memory",
        "What you told ClawdTime to keep, while memory is on.",
        join(root, "memory", "facts.json"),
        { removable: false, count: facts },
      ),
      item(
        "requests",
        "Record of computer requests",
        "Each request and its steps, by kind and name. No picture and no typed text.",
        join(computerDirectory(root), "journal.json"),
        { removable: false },
      ),
      item(
        "timing",
        "Step times",
        "The time of each step, when step timing is on.",
        join(computerDirectory(root), "timing.json"),
        { removable: true },
      ),
      item(
        "keys",
        "Model keys",
        "The keys of your model providers. Only you can read the file.",
        join(computerDirectory(root), "keys.json"),
        { removable: false, count: keys },
      ),
      item(
        "settings",
        "Settings",
        "The choices that you make in Settings.",
        settingsFile(root),
        { removable: false },
      ),
      item(
        "pairing",
        "Phone pairing",
        "The pairing of this Mac with the shared number.",
        sharedPairingPaths(home).file,
        { removable: false },
      ),
      item(
        "logs",
        "Logs",
        "What the desktop and the phone connection wrote.",
        join(home, "Library", "Logs", "ClawdTime"),
        { removable: false },
      ),
    ],
  };
}

// MARK: update

/** The folder of this package's package.json: the checkout, or app/ of a release runtime. */
function packageRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith(`${sep}dist${sep}cli`)
    ? resolve(here, "../..")
    : resolve(here, "..");
}

const defaultReleaseBase =
  "https://github.com/cherthq/clawdtime/releases/latest/download";
const releasePage = "https://github.com/cherthq/clawdtime/releases/latest";
const threeNumbers = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;

/** True when version a is older than version b, part by part as numbers. */
const older = (a: string, b: string) => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index++)
    if (left[index] !== right[index]) return left[index]! < right[index]!;
  return false;
};

/** Why an address of the release cannot be used, or null: https, or http to 127.0.0.1 for a test release. */
function releaseUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not an address";
  }
  const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !loopback) return "not https";
  if (url.username || url.password) return "a name or a password";
  return null;
}

/** The base of latest.json, with no query or fragment. */
function releaseBase(env: Record<string, string | undefined>) {
  const raw = env.CLAWDTIME_RELEASE_BASE?.trim() || defaultReleaseBase;
  let query = true;
  try {
    const url = new URL(raw);
    query = Boolean(url.search || url.hash);
  } catch {
    query = true;
  }
  if (releaseUrlProblem(raw) || query)
    throw new Error(
      "CLAWDTIME_RELEASE_BASE must be an https address, or http to 127.0.0.1. Nothing was checked.",
    );
  return raw.replace(/\/+$/, "");
}

async function checkUpdate(
  env: Record<string, string | undefined>,
  dependencies: SettingsCliDependencies,
) {
  const base = releaseBase(env);
  const current = dependencies.version ?? packageVersion(packageRoot());
  let response: Response;
  try {
    response = await (dependencies.request ?? fetch)(`${base}/latest.json`, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(
      "ClawdTime could not reach the release on the network. Check the network, then try again.",
    );
  }
  const unreadable =
    "latest.json of the release cannot be read. Try again later.";
  if (!response.ok) throw new Error(unreadable);
  // A redirect may not leave https, also when the answer looks right.
  if (response.url && releaseUrlProblem(response.url))
    throw new Error(unreadable);
  let body: { version?: unknown; commit?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new Error(unreadable);
  }
  if (
    typeof body?.version !== "string" ||
    !threeNumbers.test(body.version) ||
    typeof body.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(body.commit)
  )
    throw new Error(unreadable);
  return {
    version: 1,
    current,
    latest: body.version,
    commit: body.commit,
    // Null: this runtime does not know its own version.
    newer: threeNumbers.test(current) ? older(current, body.version) : null,
    page: base === defaultReleaseBase ? releasePage : null,
  };
}

// MARK: phone

/** Whether a `clawdtime shared run` holds the pairing now. "unknown" when the lock cannot be read. */
function connectionState(home: string): "running" | "off" | "unknown" {
  try {
    return processLockHolder(sharedConnectionLock(home)) !== null
      ? "running"
      : "off";
  } catch {
    return "unknown";
  }
}

function phone(context: Context) {
  const pairing = readSharedPairing(sharedPairingPaths(context.home).file);
  const { owner } = readOwner(context.root);
  // The settings that the service gets at its start, as it will read them.
  const env = { ...context.env };
  applyStoredSettings(env, context.root);
  const off = env.CLAWDTIME_COMPUTER_REACH === "off";
  const reach = off
    ? { calls: "off", texts: "off" }
    : reachSummary(context.root, env, context.now());
  return {
    version: 1,
    pairing: pairing.kind,
    origin: pairing.kind === "paired" ? pairing.connection.origin : null,
    view: pairing.kind === "paired" ? pairing.connection.allowView : null,
    control: pairing.kind === "paired" ? pairing.connection.allowControl : null,
    connection: connectionState(context.home),
    owner: owner
      ? {
          ending: phoneEnding(owner.phone),
          consent: owner.consent?.answer ?? null,
        }
      : null,
    calls: reach.calls,
    texts: reach.texts,
  };
}

async function unpair(context: Context, dependencies: SettingsCliDependencies) {
  const state = connectionState(context.home);
  if (state !== "off")
    throw new Error(
      state === "running"
        ? "The phone connection is on, and it uses the pairing. Stop it first."
        : "ClawdTime cannot tell whether the phone connection is on, so nothing was changed. Stop ClawdTime, then try again.",
    );
  const file = sharedPairingPaths(context.home).file;
  const pairing = readSharedPairing(file);
  if (pairing.kind === "none")
    return {
      version: 1,
      result: "none" as const,
      sentence: "This Mac is not paired.",
    };
  if (pairing.kind === "unusable")
    throw new Error(
      `The pairing file ${file} cannot be used. Look at it, and move it away to start again.`,
    );
  const result = await unpairThisMac(
    pairing.connection,
    dependencies.request ?? fetch,
  );
  if (result === "pending")
    return {
      version: 1,
      result,
      sentence:
        "The coordinator did not confirm the unpairing. The pairing stays. Try again when this Mac is online.",
    };
  await (dependencies.trash ?? macTrash)(file);
  return {
    version: 1,
    result,
    sentence:
      result === "unpaired"
        ? "This Mac is unpaired. The pairing file is in the Trash."
        : "The coordinator no longer accepts this Mac, so it has no access there. The pairing file is in the Trash.",
  };
}

// MARK: the panel's preferences

/** The preferences domain of the panel: the name of its program. */
export const panelDomain = "ClawdTimeTaskPanel";
/** The notice that a running panel waits for, to read its preferences again. */
export const panelNotice = "com.clawdtime.panel.settings";

export function macPanelDefaults(): PanelDefaults {
  return {
    read() {
      const exported = spawnSync(
        "/usr/bin/defaults",
        ["export", panelDomain, "-"],
        { encoding: "utf8", timeout: 10_000 },
      );
      if (exported.status !== 0 || !exported.stdout) return {};
      const converted = spawnSync(
        "/usr/bin/plutil",
        ["-convert", "json", "-o", "-", "-"],
        { input: exported.stdout, encoding: "utf8", timeout: 10_000 },
      );
      if (converted.status !== 0) return {};
      try {
        const value: unknown = JSON.parse(converted.stdout);
        return value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    },
    write(key, value) {
      const type =
        typeof value === "boolean"
          ? "-bool"
          : typeof value === "number"
            ? "-float"
            : "-string";
      const result = spawnSync(
        "/usr/bin/defaults",
        ["write", panelDomain, key, type, String(value)],
        { timeout: 10_000 },
      );
      if (result.status !== 0)
        throw new Error(
          "The preferences of the panel could not be written. Nothing was changed.",
        );
    },
    changed() {
      spawnSync("/usr/bin/notifyutil", ["-p", panelNotice], {
        timeout: 5_000,
      });
    },
  };
}
