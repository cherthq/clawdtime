import { join } from "node:path";
import { realRunner, type Runner } from "./focus.js";
import type { System } from "./system.js";

/**
 * Opens an application of this Mac, with a web address when one is given.
 * It runs the system's own `open` with arguments, never a shell line. Opening
 * an application needs no permission from macOS and sends nothing into it.
 *
 * The person often says less than the full name ("chrome"). The application
 * is found among the installed ones by its name or by all the words given,
 * and only one match opens: two matches open nothing.
 */
const folders = (home: string) => [
  "/Applications",
  "/System/Applications",
  "/System/Applications/Utilities",
  "/Applications/Utilities",
  join(home, "Applications"),
  // Finder and the other applications of the system itself.
  "/System/Library/CoreServices",
];
const wordsOf = (value: string) =>
  value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** A name of an application as a person or a model gives it: words only, no path and no option. */
export const appName = (value: string) => {
  const name = value
    .replace(/\p{C}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.app$/i, "")
    .trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} .+&'-]{0,58}$/u.test(name) ? name : null;
};

/** The full path of the one installed application that the name means, or null. */
export function findApp(system: System, name: string): string | null {
  const wanted = wordsOf(name);
  if (!wanted.length) return null;
  const found: { path: string; words: string[]; base: string }[] = [];
  for (const folder of folders(system.home))
    for (const entry of system.list(folder))
      if (/\.app$/i.test(entry)) {
        const base = entry.replace(/\.app$/i, "");
        found.push({
          path: join(folder, entry),
          words: wordsOf(base),
          base: base.toLowerCase(),
        });
      }
  const exact = found.filter((app) => app.base === name.toLowerCase());
  if (exact.length) return exact[0]!.path;
  const fits = found.filter((app) =>
    wanted.every((word) => app.words.includes(word)),
  );
  if (!fits.length) return null;
  // "Chrome" means Google Chrome, not Chrome Remote Desktop: the name with
  // the fewest other words wins. Two such names open nothing.
  const fewest = Math.min(...fits.map((app) => app.words.length));
  const best = fits.filter((app) => app.words.length === fewest);
  // The same application in two folders is one application.
  const names = new Set(best.map((app) => app.base));
  return names.size === 1 ? best[0]!.path : null;
}

/** A web address that may be opened: http or https, with a host and no login in it. */
export function webAddress(value: string): URL | null {
  if (value.length > 2000) return null;
  try {
    const text = value.trim();
    // A bare site gets https. A server of this Mac gets http.
    const url = new URL(
      /^https?:\/\//i.test(text)
        ? text
        : `${/^(?:localhost|127\.0\.0\.1)(?:[:/]|$)/i.test(text) ? "http" : "https"}://${text}`,
    );
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!local && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname))
      return null;
    return url;
  } catch {
    return null;
  }
}

export interface OpenResult {
  ok: boolean;
  /** One sentence that can be said aloud. */
  said: string;
}

/**
 * Opens the application, the address in the application, or the address in
 * the default browser. `name` and `url` were checked against the person's own
 * words by the caller.
 */
export async function openApp(
  system: System,
  name: string | null,
  url: URL | null,
  run: Runner = realRunner,
): Promise<OpenResult> {
  let path: string | null = null;
  let shown = "the browser";
  if (name) {
    path = findApp(system, name);
    if (!path)
      return {
        ok: false,
        said: `I could not find one application named ${name} on this Mac.`,
      };
    shown = path.replace(/^.*\//, "").replace(/\.app$/i, "");
  }
  const args = [...(path ? ["-a", path] : []), ...(url ? [url.href] : [])];
  if (!args.length) return { ok: false, said: "There is nothing to open." };
  const opened = await run("/usr/bin/open", args, 10_000);
  if (opened.status !== 0)
    return { ok: false, said: `${name ?? "The address"} did not open.` };
  return {
    ok: true,
    said: url ? `Opened ${url.hostname} in ${shown}.` : `Opened ${shown}.`,
  };
}
