import { homedir } from "node:os";
import { stateRoot } from "../connectors/agents/hooks.js";
import {
  keyRows,
  KeyStoreError,
  type KeyRow,
  keyStoreFile,
  removeStoredKey,
  storeKey,
  findKey,
} from "../connectors/computer/keys.js";
import { providerById, providerIds } from "../connectors/computer/providers.js";

export const keysHelp = `clawdtime keys: the keys of the language model providers that computer use can plan with
  keys list [--json]     each provider: set or not set, and where its key comes from.
                         --json prints one JSON object for the Mac app, with no key in it
  keys set PROVIDER      read a key from a hidden prompt, or from standard input, and store it
  keys remove PROVIDER   remove the stored key of a provider
Providers: ${providerIds.join(", ")}.
The store is a file in the state folder for its owner only. A key in the environment
of the service wins over the stored one. A key is never printed, not even a part of it.
Then choose a model when the provider has no default: clawdtime computer model PROVIDER/MODEL`;
const usage = "Use: clawdtime keys list [--json]|set PROVIDER|remove PROVIDER";

export interface KeysCliDependencies {
  env?: Record<string, string | undefined>;
  home?: string;
  print?: (line: string) => void;
  /** Reads the key with no echo. Tests replace it, so that no test reads a terminal. */
  readSecret?: (prompt: string) => Promise<string>;
}

/** Reads a key from the terminal with no echo, or the whole of standard input when it is no terminal. */
export async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += bytes.length;
      if (size > 16_384)
        throw new KeyStoreError(
          "Standard input is too long for a key. Nothing was stored.",
        );
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const output = process.stderr;
  output.write(prompt);
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", take);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const take = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004")
          return finish();
        if (char === "\u0003")
          return finish(new KeyStoreError("Stopped. Nothing was stored."));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on("data", take);
  });
}

const where = (row: ReturnType<typeof keyRows>["rows"][number]) =>
  !row.from
    ? "not set"
    : row.from.kind === "environment"
      ? `set, in the environment (${row.from.name})${row.shadowed ? ". It wins over the stored key" : ""}`
      : "set, in the key store";

/**
 * One provider for the Mac app: whether a key is set, where it comes from,
 * whether the store holds one, and its default model. It never holds a key.
 */
const keyEntry = (row: KeyRow) => ({
  id: row.provider.id,
  name: row.provider.name,
  set: row.from !== null,
  source: row.from?.kind ?? null,
  variable: row.from?.kind === "environment" ? row.from.name : null,
  stored: row.from?.kind === "store" || row.shadowed,
  defaultModel: row.provider.defaultModel,
  needsModel: row.provider.defaultModel === null,
  needsBaseUrl: row.provider.id === "custom",
});

/** The keys of the providers: list, set and remove. Nothing here prints a key. */
export async function keysCli(
  args: string[],
  dependencies: KeysCliDependencies = {},
) {
  const env = dependencies.env ?? process.env;
  const print = dependencies.print ?? console.log;
  const root = stateRoot({ env, home: dependencies.home ?? homedir() });
  const command = args[0] ?? "list";
  if (command === "help" || command === "--help") return print(keysHelp);
  if (command === "list") {
    const json = args[1] === "--json";
    if (args.length > (json ? 2 : 1)) throw new Error(usage);
    const { rows, problem, file } = keyRows(env, root);
    if (json)
      return print(
        JSON.stringify({
          version: 1,
          store: file,
          problem,
          providers: rows.map(keyEntry),
        }),
      );
    print(
      "Keys of the language model providers. The environment wins over the store.",
    );
    for (const row of rows)
      print(`  ${row.provider.id.padEnd(11)} ${where(row)}`);
    print(`Store: ${file}`);
    if (problem) print(problem);
    return;
  }
  if (command !== "set" && command !== "remove") throw new Error(usage);
  if (args.length !== 2) throw new Error(usage);
  const provider = providerById(args[1]!);
  if (!provider)
    throw new Error(`Name one provider: ${providerIds.join(", ")}.`);
  const environment = findKey(provider, env);
  const wins =
    environment?.from.kind === "environment"
      ? `${environment.from.name} is set in this environment, and it wins over the stored key.`
      : null;
  if (command === "set") {
    const raw = await (dependencies.readSecret ?? readSecret)(
      `Key for ${provider.name} (it is not shown): `,
    );
    storeKey(root, provider, raw);
    print(
      `The key for ${provider.name} is stored in ${keyStoreFile(root)}, for its owner only. The desktop service reads it when it starts: start it again.`,
    );
    if (wins) print(wins);
    if (!provider.defaultModel)
      print(
        `${provider.name} has no default model. Choose one that reads pictures: clawdtime computer model ${provider.id}/MODEL`,
      );
    return;
  }
  const removed = removeStoredKey(root, provider);
  print(
    removed
      ? `The stored key for ${provider.name} is removed. Start the desktop service again.`
      : `No key for ${provider.name} is stored.`,
  );
  if (wins) print(wins);
}
