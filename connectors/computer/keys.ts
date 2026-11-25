/**
 * Computer use: the keys of the providers and the chosen model, in the state
 * folder.
 *
 * The key store is one file, `computer/keys.json`, for its owner only, in a
 * folder for its owner only. It is written whole and then renamed, and no
 * symbolic link is followed. A file that is not a regular file of this user
 * with owner-only access is not read, and it is never overwritten: the
 * person looks at it first. The chosen model lives beside it in
 * `computer/model.json`, with the same rules.
 *
 * The environment wins over the store: a key in a variable of the service is
 * used before a stored one. Nothing here prints, logs or returns a key in a
 * message. Every problem is a fixed sentence that names a file or a variable,
 * never a value.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { looksSecret } from "../agents/memory.js";
import { secureWrite } from "../shared/state.js";
import { computerDirectory } from "./journal.js";
import {
  parseModel,
  providerById,
  providers,
  selectPlanner,
  type KeyFound,
  type Provider,
  type ProviderId,
  type Selection,
} from "./providers.js";

export const keyStoreFile = (root: string) =>
  join(computerDirectory(root), "keys.json");
export const modelChoiceFile = (root: string) =>
  join(computerDirectory(root), "model.json");

/** A problem of the store, with a fixed text that holds no key. */
export class KeyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyStoreError";
  }
}

const largest = 64 * 1024;
const mine = (stat: Stats) =>
  process.getuid === undefined || stat.uid === process.getuid();
const folderOpen = (folder: string) =>
  `The folder ${folder} is not a folder of this user for its owner only, so no key is read from it or written to it. Run: chmod 700 ${folder}`;
const notPrivate = (file: string) =>
  `${file} is not a regular file of this user for its owner only, so it is not used. Look at it, then run: chmod 600 ${file}`;
const notValid = (file: string) =>
  `${file} is not valid, so it is not used and not changed. Look at it, and move it away to start again.`;

/** The folder is missing (nothing is stored), private (null), or a problem. */
function folderProblem(root: string): string | null | "missing" {
  const folder = computerDirectory(root);
  let stat: Stats;
  try {
    stat = lstatSync(folder);
  } catch {
    return "missing";
  }
  return stat.isDirectory() && (stat.mode & 0o077) === 0 && mine(stat)
    ? null
    : folderOpen(folder);
}

/**
 * One private JSON file: null when it is not there. The file is opened with
 * no link followed and with no wait, so a link or a pipe in its place is
 * refused, and it is checked again once it is open.
 */
function readPrivate(
  root: string,
  file: string,
): { value: unknown; problem: string | null } {
  const folder = folderProblem(root);
  if (folder === "missing") return { value: null, problem: null };
  if (folder) return { value: null, problem: folder };
  let before: Stats;
  try {
    before = lstatSync(file);
  } catch {
    return { value: null, problem: null };
  }
  const safe = (stat: Stats) =>
    stat.isFile() && (stat.mode & 0o077) === 0 && mine(stat);
  if (!safe(before)) return { value: null, problem: notPrivate(file) };
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return { value: null, problem: notPrivate(file) };
  }
  try {
    const stat = fstatSync(fd);
    if (!safe(stat) || stat.ino !== before.ino || stat.dev !== before.dev)
      return { value: null, problem: notPrivate(file) };
    if (stat.size > largest) return { value: null, problem: notValid(file) };
    try {
      return { value: JSON.parse(readFileSync(fd, "utf8")), problem: null };
    } catch {
      return { value: null, problem: notValid(file) };
    }
  } finally {
    closeSync(fd);
  }
}

function writePrivate(root: string, file: string, value: unknown) {
  const folder = folderProblem(root);
  if (folder && folder !== "missing") throw new KeyStoreError(folder);
  // A new folder is made for its owner only.
  secureWrite(file, value);
}

const storeSchema = z
  .object({
    version: z.literal(1),
    keys: z.record(z.string(), z.string()),
  })
  .strict();

/** The stored keys. A store that cannot be used gives none, and its problem. */
export function storedKeys(root: string): {
  keys: Partial<Record<ProviderId, string>>;
  problem: string | null;
} {
  const file = keyStoreFile(root);
  const read = readPrivate(root, file);
  if (read.problem || read.value === null)
    return { keys: {}, problem: read.problem };
  const parsed = storeSchema.safeParse(read.value);
  if (!parsed.success) return { keys: {}, problem: notValid(file) };
  const keys: Partial<Record<ProviderId, string>> = {};
  for (const [id, key] of Object.entries(parsed.data.keys)) {
    const provider = providerById(id);
    if (provider && key) keys[provider.id] = key;
  }
  return { keys, problem: null };
}

/**
 * A key as it is stored: the spaces and the line end around it go, and what
 * is left must be one word of plain characters. The reasons are fixed
 * sentences: they never quote the key.
 */
export function checkKey(raw: string): string {
  const key = raw.trim();
  if (!key) throw new KeyStoreError("No key came in. Nothing was stored.");
  if (key.length > 4096)
    throw new KeyStoreError("The key is too long. Nothing was stored.");
  if (!/^[\x21-\x7e]+$/.test(key))
    throw new KeyStoreError(
      "The key has a space, a line end or another character that a key does not have. Paste only the key. Nothing was stored.",
    );
  return key;
}

function saveKeys(root: string, keys: Partial<Record<ProviderId, string>>) {
  const sorted = Object.fromEntries(
    providers
      .filter((provider) => keys[provider.id])
      .map((provider) => [provider.id, keys[provider.id]]),
  );
  writePrivate(root, keyStoreFile(root), { version: 1, keys: sorted });
}

/** Stores the key of one provider. A store that cannot be read is not overwritten. */
export function storeKey(root: string, provider: Provider, raw: string) {
  const key = checkKey(raw);
  const { keys, problem } = storedKeys(root);
  if (problem) throw new KeyStoreError(problem);
  saveKeys(root, { ...keys, [provider.id]: key });
}

/** Removes the stored key of one provider. False when none was stored. */
export function removeStoredKey(root: string, provider: Provider): boolean {
  const { keys, problem } = storedKeys(root);
  if (problem) throw new KeyStoreError(problem);
  if (!keys[provider.id]) return false;
  const rest = { ...keys };
  delete rest[provider.id];
  saveKeys(root, rest);
  return true;
}

/** The key of one provider: the environment first, then the store. */
export function findKey(
  provider: Provider,
  env: Record<string, string | undefined>,
  stored: Partial<Record<ProviderId, string>> = {},
): KeyFound | null {
  for (const name of provider.keys) {
    const key = env[name];
    if (key) return { key, from: { kind: "environment", name } };
  }
  const key = stored[provider.id];
  return key ? { key, from: { kind: "store" } } : null;
}

export interface KeyRow {
  provider: Provider;
  /** Where the key that is used comes from. Null: no key. */
  from: KeyFound["from"] | null;
  /** A stored key that a variable of the environment overrides. */
  shadowed: boolean;
}
/** Each provider with where its key comes from. It holds no key. */
export function keyRows(
  env: Record<string, string | undefined>,
  root: string,
): { rows: KeyRow[]; problem: string | null; file: string } {
  const { keys, problem } = storedKeys(root);
  return {
    file: keyStoreFile(root),
    problem,
    rows: providers.map((provider) => {
      const found = findKey(provider, env, keys);
      return {
        provider,
        from: found?.from ?? null,
        shadowed: found?.from.kind === "environment" && !!keys[provider.id],
      };
    }),
  };
}

const choiceSchema = z
  .object({
    version: z.literal(1),
    model: z.string().min(1).max(200).nullable(),
    baseUrl: z.string().min(1).max(2048).optional(),
  })
  .strict();
export interface ModelChoice {
  model: string;
  /** The base address of a custom service. */
  baseUrl?: string;
}

/** The model that `clawdtime computer model` stored, or null. */
export function readModelChoice(root: string): {
  choice: ModelChoice | null;
  problem: string | null;
} {
  const file = modelChoiceFile(root);
  const read = readPrivate(root, file);
  if (read.problem || read.value === null)
    return { choice: null, problem: read.problem };
  const parsed = choiceSchema.safeParse(read.value);
  if (!parsed.success) return { choice: null, problem: notValid(file) };
  const { model, baseUrl } = parsed.data;
  return {
    choice: model ? { model, ...(baseUrl ? { baseUrl } : {}) } : null,
    problem: null,
  };
}

/** Stores the chosen model, or no choice. The model must be one that the planner can use. */
export function storeModelChoice(root: string, choice: ModelChoice | null) {
  if (choice) {
    const parsed = parseModel(choice.model, looksSecret);
    if (!parsed.ok) throw new KeyStoreError(parsed.problem);
  }
  const { problem } = readModelChoice(root);
  if (problem) throw new KeyStoreError(problem);
  writePrivate(root, modelChoiceFile(root), {
    version: 1,
    model: choice?.model.trim() ?? null,
    ...(choice?.baseUrl ? { baseUrl: choice.baseUrl.trim() } : {}),
  });
}

/**
 * The provider, the model and the key of the planner, from the environment
 * and, when a state folder is given, from the store. A variable of the
 * environment wins over the store, for the model and for each key.
 */
export function plannerSetup(
  env: Record<string, string | undefined>,
  root?: string,
): Selection {
  const fromEnvironment = env.CLAWDTIME_COMPUTER_MODEL?.trim();
  const stored = root ? readModelChoice(root) : { choice: null, problem: null };
  if (!fromEnvironment && stored.problem)
    return {
      ok: false,
      reason: "invalid",
      problem: stored.problem,
      provider: null,
    };
  const keys = root ? storedKeys(root) : { keys: {}, problem: null };
  const setting = fromEnvironment
    ? { text: fromEnvironment, from: "environment" as const }
    : stored.choice
      ? { text: stored.choice.model, from: "store" as const }
      : null;
  const selection = selectPlanner({
    setting,
    findKey: (provider) => findKey(provider, env, keys.keys),
    customBase:
      env.CLAWDTIME_CUSTOM_BASE_URL?.trim() || stored.choice?.baseUrl || null,
    effort: env.CLAWDTIME_COMPUTER_EFFORT,
    speed: env.CLAWDTIME_COMPUTER_SPEED,
    looksSecret,
  });
  // A key that is missing can be in a store that cannot be read: say so.
  if (
    !selection.ok &&
    (selection.reason === "no_key" || selection.reason === "missing_key") &&
    keys.problem
  )
    return { ...selection, problem: `${selection.problem} ${keys.problem}` };
  return selection;
}
