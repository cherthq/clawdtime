/**
 * What goes into a probe, and what comes out of it.
 *
 * In: a pid, a name, a port, a label and a number of minutes are read here
 * and nowhere else. What does not parse is refused, so no word of the model
 * reaches a program as anything but a plain checked value.
 *
 * Out: the arguments of a process and the lines of a log can hold a
 * password or a key. Each one that looks like a credential, by the same
 * checks that the chat and the journal use, is hidden before the text leaves
 * this folder. The home folder is written as ~, so no user name goes along.
 */
import { looksSecret } from "../agents/memory.js";
import {
  looksBareSecret,
  looksSecretStrict,
  namesSecret,
} from "../computer/journal.js";

/** A process id that can name a process: a whole number from 1. */
export function parsePid(value: unknown): number | null {
  const text =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!/^\d{1,9}$/.test(text)) return null;
  const pid = Number(text);
  return pid >= 1 && pid <= 99_999_999 ? pid : null;
}

/**
 * A name of an app or a process: letters, digits, spaces and . _ + ( ) & ' -,
 * up to 64. No quote, no backslash, no wildcard: a name goes into a log
 * predicate between double quotes.
 */
export function parseName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value
    .trim()
    .replace(/\.app$/i, "")
    .replace(/\s+/g, " ");
  return /^[\p{L}\p{N}][\p{L}\p{N} ._+()&'-]{0,63}$/u.test(name) ? name : null;
}

/** A TCP port: 1 to 65535. */
export function parsePort(value: unknown): number | null {
  const text =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value.trim().replace(/^:/, "")
        : "";
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** A launchd label, or a part of one: letters, digits, dots, dashes, underscores. */
export function parseLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(label) ? label : null;
}

/** A whole number in a range, or the fallback when none was given. Null when it does not parse. */
export function parseCount(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{1,4}$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
  if (!Number.isInteger(number)) return null;
  return Math.min(max, Math.max(min, number));
}

const credential = (text: string) =>
  looksSecret(text) || looksSecretStrict(text);

/** A flag whose value is a secret: --password, --api-key, --token, --auth, --session. */
const secretFlag =
  /^-{1,2}[\w.-]*(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|pwd|session)[\w.-]*$/i;

/** The words of a key whose value is a secret, as the whole key or its last part: "pass", "db_password", "sid". */
const secretWord =
  "(?:pass(?:word|wd|phrase|code)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|auth(?:orization)?|credentials?|session(?:[_-]?(?:id|token|key))?|sid|cookie)";
/** A key of a key=value pair whose value is a secret: pass=, token=, secret=, sid=, db_password=, clientSecret=. */
const secretKey = (key: string) =>
  new RegExp(`^(?:[\\w.]*[_.-])?${secretWord}$`, "i").test(key) ||
  /[a-z](?:Password|Passwd|Secret|Token|ApiKey|AccessKey|PrivateKey|Credentials?)$/.test(
    key,
  );
/**
 * A word on its own whose next word is its secret: "password X", or a key
 * of several parts with a secret word in it: "aws_secret_access_key X",
 * "client-secret X". A plain "session" or "token" in a sentence is none.
 */
const secretName = (word: string) =>
  /^(?:password|passwd|passphrase)$/i.test(word) ||
  (/[_-]/.test(word) &&
    new RegExp(`^[a-z0-9]+(?:[_-][a-z0-9]+)*$`, "i").test(word) &&
    new RegExp(`(?:^|[_-])${secretWord}(?:[_-]|$)`, "i").test(word));

/** The value of a flag that is a port or a path, which is no secret: "-p 22", "-p ~/new". */
const plainValue = (value: string) =>
  /^\d{1,5}$/.test(value) || /^[~/.]/.test(value);

/** The scheme of an authorization header, before its secret. */
const authScheme = /^(?:bearer|basic|token|digest|negotiate)$/i;

/** The programs whose -a takes a password. */
const passwordA = /^(?:redis-cli|keydb-cli|valkey-cli)$/;

/**
 * The words of a command line or a log line, with each value of a
 * credential flag or pair hidden. `program` is the path of the program,
 * for the flags that mean a password only there.
 */
function hideValues(tokens: readonly string[], program = ""): string[] {
  const base = (path: string) =>
    path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  // The -a of redis-cli, also when the line runs it: "exec redis-cli -a X".
  let aIsPassword = passwordA.test(base(program));
  const out: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (passwordA.test(base(token))) aIsPassword = true;
    const next = tokens[index + 1];
    const takesNext = next !== undefined && !next.startsWith("-");
    const equals = token.indexOf("=");
    if (equals > 0) {
      const key = token.slice(0, equals);
      const value = token.slice(equals + 1);
      if (
        (secretFlag.test(key) ||
          namesSecret(key) ||
          secretKey(key.replace(/^-+/, "")) ||
          credential(token)) &&
        value
      ) {
        // No "=" before the mark: "password=" with any value after it reads as one.
        out.push(`${key} [hidden]`);
        continue;
      }
    }
    if (credential(token)) {
      out.push("[hidden]");
      continue;
    }
    // "-pStonepad99": the password of mysql and its kin, glued to its flag.
    const glued = /^-p(.+)$/.exec(token);
    if (glued && !plainValue(glued[1]!) && looksBareSecret(glued[1]!)) {
      out.push("-p [hidden]");
      continue;
    }
    // "-u sam:Stonepad99": a user and a password.
    if (
      (token === "-u" || token === "--user") &&
      takesNext &&
      /^[^:\s]+:.+$/.test(next)
    ) {
      out.push(token, `${next.slice(0, next.indexOf(":"))}:[hidden]`);
      index++;
      continue;
    }
    out.push(token);
    if (!takesNext) continue;
    const hides =
      (token === "-p" && !plainValue(next)) ||
      (token === "-a" && aIsPassword) ||
      (secretFlag.test(token) && (looksBareSecret(next) || next.length >= 6)) ||
      secretName(token) ||
      (token.endsWith(":") && secretKey(token.slice(0, -1)));
    if (hides) {
      out.push("[hidden]");
      index++;
      // "Authorization: Bearer VALUE": the value comes after its scheme.
      const after = tokens[index + 1];
      if (authScheme.test(next) && after !== undefined) {
        out.push("[hidden]");
        index++;
      }
    }
  }
  return out;
}

/** The home folder as ~, so that no user name goes along. */
export function withoutHome(text: string, home: string): string {
  if (!home || home === "/") return text;
  return text.split(home).join("~");
}

export const hiddenArguments =
  "[hidden: the arguments looked like they held a credential]";

/**
 * The arguments of a process with each value that looks like a credential
 * hidden: a token that the checks catch, the value of a secret flag
 * (`--password=...` becomes `--password [hidden]`, `--api-key VALUE`, `-p
 * VALUE`, `-pVALUE`, and `-a VALUE` of redis-cli), the value of a secret
 * pair (`pass=`, `token=`, `aws_secret_access_key VALUE`), the password of
 * `-u user:password`, and an address with a password. When the whole still
 * looks like one, all of it is hidden.
 */
export function redactArguments(
  text: string,
  home: string,
  program = "",
): string {
  const tokens = withoutHome(text, home).split(/\s+/).filter(Boolean);
  const joined = hideValues(tokens, program).join(" ");
  return credential(joined) ? hiddenArguments : joined;
}

export const hiddenLine = "[hidden: the line looked like it held a credential]";

/**
 * An address as short as it means: 0x0000000000000010 is 0x10. Crash reports
 * and logs write addresses with leading zeros, and sixteen digits read like a
 * card number to the checks.
 */
export const shortHex = (text: string) =>
  text.replace(/\b0x0+([0-9a-f]+)\b/gi, "0x$1");

/**
 * One line of a log or a report, or a note in its place when it looks like
 * a credential. In a line that does not, the value of each credential flag
 * or pair is hidden ("pass=..." becomes "pass [hidden]").
 */
export function redactLine(text: string, home: string): string {
  const line = shortHex(withoutHome(text, home));
  if (credential(line)) return hiddenLine;
  const tokens = line.split(/\s+/).filter(Boolean);
  const out = hideValues(tokens);
  const kept = out.some((token, index) => token !== tokens[index])
    ? out.join(" ")
    : line;
  return credential(kept) ? hiddenLine : kept;
}

/** True when the text looks like it holds a credential. */
export const holdsCredential = credential;
