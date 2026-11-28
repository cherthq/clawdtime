/**
 * Model keys that the person keeps in the shell startup files. The Mac app
 * starts from Finder with no shell variables, so a key that the person
 * exported in Terminal is not in its environment. Setup reads these files as
 * text and runs no shell: only a plain assignment of a key variable counts.
 *
 * A value with `$`, a backtick or a backslash is left alone: it needs a shell
 * to have a value. Nothing here logs, prints or returns a key in a message.
 */
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  providers,
  type Provider,
} from "../../connectors/computer/providers.js";
import type { KnownKey } from "./engine.js";

/** The startup files of each shell, in the order the shell reads them. */
export function shellFiles(
  home: string,
  env: Record<string, string | undefined>,
): string[] {
  const shell = basename(env.SHELL ?? "/bin/zsh");
  if (shell === "bash")
    return [".bash_profile", ".bashrc", ".profile"].map((name) =>
      join(home, name),
    );
  // zsh is the shell of macOS. ZDOTDIR moves its files.
  const zsh = env.ZDOTDIR?.startsWith("/") ? env.ZDOTDIR : home;
  return [".zshenv", ".zprofile", ".zshrc"].map((name) => join(zsh, name));
}

const largest = 256 * 1024;

/** One file of the person, as text: a regular file of this user, not too large. */
function readOwn(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > largest) return null;
    if (process.getuid && stat.uid !== process.getuid()) return null;
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * The value of each assignment of `names` in one file, the last one wins, as
 * in a shell. `export NAME=value`, `NAME=value`, with single or double quotes.
 * An empty value is kept as "": it clears the variable.
 */
export function assignments(
  text: string,
  names: readonly string[],
): Map<string, string> {
  const found = new Map<string, string>();
  const wanted = new Set(names);
  for (const line of text.split(/\r?\n/)) {
    const match =
      /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(?:'([^']*)'|"([^"$`\\]*)"|([^\s'"$`\\;#|&<>()]*))\s*(?:#.*)?$/.exec(
        line,
      );
    if (!match || !wanted.has(match[1]!)) continue;
    found.set(match[1]!, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return found;
}

/**
 * The keys of `offered` providers in the shell startup files. A later file
 * wins over an earlier one, as in the shell. Each provider gives one key at
 * most: the first of its variables that has one.
 */
export function shellKeys(
  home: string,
  env: Record<string, string | undefined>,
  offered: readonly Provider[] = providers.filter((one) => one.defaultModel),
  read: (file: string) => string | null = readOwn,
): KnownKey[] {
  const names = offered.flatMap((provider) => provider.keys);
  const values = new Map<string, { key: string; source: string }>();
  for (const file of shellFiles(home, env)) {
    const text = read(file);
    if (text === null) continue;
    for (const [name, key] of assignments(text, names))
      if (key) values.set(name, { key, source: file });
      else values.delete(name);
  }
  const found: KnownKey[] = [];
  for (const provider of offered)
    for (const name of provider.keys) {
      const value = values.get(name);
      if (!value) continue;
      found.push({ provider, key: value.key, source: value.source });
      break;
    }
  return found;
}
