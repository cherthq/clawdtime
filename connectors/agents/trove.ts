import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { secureWrite } from "../shared/state.js";
import { agentKinds, type AgentKind } from "./types.js";

/**
 * The trove: what each agent asked and what the person answered. It is the
 * supervisor's memory. It suggests an answer the person gave before, repeats an
 * answer only where the person made a rule, and keeps the notes the person
 * marks as critical. Everything stays in owner-only files on this Mac.
 */
export const troveDirectory = (root: string) => join(root, "trove");

const text = (max: number) => z.string().max(max);
export const decisionKinds = ["permission", "question", "plan"] as const;
export const decisionValues = ["allow", "deny", "answer"] as const;
export const decisionVias = [
  "panel",
  "cli",
  "call",
  "playbook",
  "terminal",
] as const;

export const troveEntrySchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[0-9a-f]{16}$/),
    at: z.number().int().nonnegative(),
    agent: z.enum(agentKinds),
    project: text(120),
    cwd: text(4096).nullable(),
    kind: z.enum(decisionKinds),
    tool: text(80),
    /** The key that groups like requests: "Bash:npm test", "Edit". */
    pattern: text(160),
    /** What the agent asked, cut to a bounded length. */
    summary: text(600),
    decision: z.enum(decisionValues),
    /** The answer text of a question, or the reason of a denial. */
    text: text(600).nullable(),
    via: z.enum(decisionVias),
    /** Seconds from the request to the answer. */
    waitedSeconds: z.number().nonnegative().nullable(),
  })
  .strict();
export type TroveEntry = z.infer<typeof troveEntrySchema>;

export const ruleSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[0-9a-f]{8}$/),
    agent: z.enum(agentKinds),
    /** The working directory the rule holds in. A rule never crosses projects. */
    cwd: text(4096),
    pattern: text(160),
    decision: z.literal("allow"),
    createdAt: z.number().int().nonnegative(),
    note: text(300),
  })
  .strict();
export type TroveRule = z.infer<typeof ruleSchema>;

export const noteSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[0-9a-f]{8}$/),
    at: z.number().int().nonnegative(),
    text: text(2000),
    project: text(120).nullable(),
  })
  .strict();
export type TroveNote = z.infer<typeof noteSchema>;

const safeFile = (file: string) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Refusing a trove path that is not a regular file.");
  }
};
function appendLine(file: string, value: unknown) {
  safeFile(file);
  appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
function readLines<T>(file: string, schema: z.ZodType<T>, limit: number): T[] {
  if (!existsSync(file)) return [];
  safeFile(file);
  const result: T[] = [];
  // A line that does not parse is skipped. One bad write never hides the rest.
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      result.push(schema.parse(JSON.parse(line)));
    } catch {
      continue;
    }
  }
  return result.slice(-limit);
}

const quiet = /^[A-Za-z0-9][A-Za-z0-9_.:@=+-]{0,39}$/;
/** How much of a request the person is shown. The rest is cut. */
export const shownLength = 600;
/**
 * The key of a request. A shell command is grouped by its program and its
 * first plain word ("git push", "npm test"); every other tool by its name.
 * Paths and options are left out, so they never widen a rule by accident.
 *
 * `command` is the raw command, before any change of its spaces and before
 * any cut. A key that names a command stands for what the person saw. So the
 * bare tool name stays, and no rule matches it, when the person did not see
 * the whole command as the shell reads it.
 */
export function requestPattern(tool: string, command: string) {
  const name = tool.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 60) || "tool";
  if (!/^(bash|shell|exec|exec_command|local_shell)$/i.test(name)) return name;
  // A line break starts a new command, and the person is shown one line.
  if (/[\p{C}\u2028\u2029]/u.test(command.replaceAll("\t", " "))) return "Bash";
  // A command that is longer than what is shown can hide anything in its end.
  if (command.length > shownLength) return "Bash";
  // Only a single plain command gets a narrow key. Anything with shell
  // syntax (pipes, lists, substitutions) keeps the bare tool name.
  if (/[;&|`$><(){}\\]/.test(command)) return "Bash";
  const words = command.trim().split(/\s+/).slice(0, 3);
  // A program with a slash is a file of that place, not the command of that name.
  const program = words[0] ?? "";
  if (!quiet.test(program)) return "Bash";
  const second = words[1];
  return second && quiet.test(second) && !second.startsWith("-")
    ? `Bash:${program} ${second}`
    : `Bash:${program}`;
}

export interface RequestFacts {
  agent: AgentKind;
  cwd: string | null;
  pattern: string;
  /** The file that a file tool asks for, as the agent gave it. */
  path?: string | null;
}

/** Tools that change or read one file. Their rule holds only inside the project folder. */
const fileTools = /^(edit|multiedit|write|notebookedit|read|apply_patch)$/i;
/** The real place of a path: links are followed for the part of it that exists. */
function settled(path: string): string {
  const rest: string[] = [];
  let head = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(head), ...rest);
    } catch {
      const parent = dirname(head);
      if (parent === head) return join(head, ...rest);
      rest.unshift(basename(head));
      head = parent;
    }
  }
}
function inside(folder: string, path: string) {
  const root = settled(folder);
  const target = settled(resolve(folder, path));
  return (
    target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
  );
}
/** A key that can be a rule: never the bare name of the shell tool, never a program alone. */
const keyed = (pattern: string) =>
  pattern !== "Bash" && !/^Bash:\S+$/.test(pattern);
/** A request with a file is covered only when that file is inside the project folder. */
const coversPath = (request: RequestFacts) =>
  request.path === null || request.path === undefined
    ? !fileTools.test(request.pattern)
    : request.cwd !== null && inside(request.cwd, request.path);
/**
 * True when the person can make a rule from this request, and when a rule can
 * answer it: it has a project folder, its key names one command with its first
 * word, and a file that it asks for is inside the project folder.
 */
export const rememberable = (request: RequestFacts) =>
  !!request.cwd && keyed(request.pattern) && coversPath(request);

export class Trove {
  private readonly directory: string;
  constructor(root: string) {
    this.directory = troveDirectory(root);
  }
  private file(name: string) {
    return join(this.directory, name);
  }
  private id(bytes: number) {
    return randomBytes(bytes).toString("hex");
  }

  record(entry: Omit<TroveEntry, "version" | "id">): TroveEntry {
    const stored = troveEntrySchema.parse({
      version: 1,
      id: this.id(8),
      ...entry,
      summary: entry.summary.slice(0, 600),
      text: entry.text?.slice(0, 600) ?? null,
    });
    appendLine(this.file("decisions.jsonl"), stored);
    return stored;
  }
  decisions(limit = 500): TroveEntry[] {
    return readLines(this.file("decisions.jsonl"), troveEntrySchema, limit);
  }
  /** Words of the query must all appear in the entry. Newest first. */
  search(query: string, limit = 50): TroveEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.decisions(5000)
      .filter((entry) => {
        const haystack =
          `${entry.agent} ${entry.project} ${entry.tool} ${entry.pattern} ${entry.summary} ${entry.decision} ${entry.text ?? ""} ${entry.via}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .reverse()
      .slice(0, limit);
  }
  /** What the person answered before to the same kind of request in the same project. */
  suggest(request: RequestFacts) {
    let allowed = 0;
    let denied = 0;
    let lastAt: number | null = null;
    for (const entry of this.decisions(5000)) {
      if (
        entry.agent !== request.agent ||
        entry.cwd !== request.cwd ||
        entry.pattern !== request.pattern ||
        entry.via === "playbook"
      )
        continue;
      if (entry.decision === "allow") allowed++;
      else if (entry.decision === "deny") denied++;
      lastAt = entry.at;
    }
    return { allowed, denied, lastAt };
  }

  rules(): TroveRule[] {
    const file = this.file("rules.json");
    if (!existsSync(file)) return [];
    safeFile(file);
    try {
      return z
        .array(ruleSchema)
        .max(500)
        .parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      // A rules file that cannot be read gives no rule: nothing is allowed by it.
      return [];
    }
  }
  /** A rule is only ever made by the person. It allows one pattern in one project. */
  addRule(request: RequestFacts, note: string, at: number): TroveRule {
    if (!request.cwd)
      throw new Error("A rule needs the project folder of the request.");
    if (!keyed(request.pattern))
      throw new Error(
        "This command is too broad for a rule. Answer it each time.",
      );
    if (!coversPath(request))
      throw new Error(
        "A rule for a file holds only inside the project folder. This request is outside the project folder.",
      );
    const existing = this.rules();
    const same = existing.find(
      (rule) =>
        rule.agent === request.agent &&
        rule.cwd === request.cwd &&
        rule.pattern === request.pattern,
    );
    if (same) return same;
    const rule = ruleSchema.parse({
      version: 1,
      id: this.id(4),
      agent: request.agent,
      cwd: request.cwd,
      pattern: request.pattern,
      decision: "allow",
      createdAt: at,
      note: note.slice(0, 300),
    });
    secureWrite(this.file("rules.json"), [...existing, rule]);
    return rule;
  }
  removeRule(id: string) {
    const existing = this.rules();
    const kept = existing.filter((rule) => rule.id !== id);
    if (kept.length === existing.length) return false;
    secureWrite(this.file("rules.json"), kept);
    return true;
  }
  matchRule(request: RequestFacts): TroveRule | null {
    if (!rememberable(request)) return null;
    return (
      this.rules().find(
        (rule) =>
          rule.agent === request.agent &&
          rule.cwd === request.cwd &&
          rule.pattern === request.pattern,
      ) ?? null
    );
  }

  note(value: string, project: string | null, at: number): TroveNote {
    const stored = noteSchema.parse({
      version: 1,
      id: this.id(4),
      at,
      text: value.trim().slice(0, 2000),
      project,
    });
    if (!stored.text) throw new Error("A note needs some text.");
    appendLine(this.file("notes.jsonl"), stored);
    return stored;
  }
  notes(limit = 500): TroveNote[] {
    return readLines(this.file("notes.jsonl"), noteSchema, limit);
  }

  /** The trove as a playbook a person can read: notes, rules, then decisions by project. */
  playbook(now: number) {
    const day = (time: number) => new Date(time).toISOString().slice(0, 10);
    const lines = [`# ClawdTime playbook`, ``, `Written ${day(now)}.`, ``];
    const notes = this.notes();
    lines.push(`## Critical decisions`, ``);
    if (!notes.length) lines.push(`None recorded.`);
    for (const note of [...notes].reverse())
      lines.push(
        `- ${day(note.at)}${note.project ? ` (${note.project})` : ""}: ${note.text.replace(/\s+/g, " ")}`,
      );
    const rules = this.rules();
    lines.push(``, `## Standing rules`, ``);
    if (!rules.length)
      lines.push(`None. Every request is answered by a person.`);
    for (const rule of rules)
      lines.push(
        `- Allow \`${rule.pattern}\` for ${rule.agent} in \`${rule.cwd}\` (since ${day(rule.createdAt)})${rule.note ? `: ${rule.note}` : ""}`,
      );
    const groups = new Map<
      string,
      {
        allow: number;
        deny: number;
        answer: number;
        last: number;
        project: string;
      }
    >();
    for (const entry of this.decisions(5000)) {
      const key = `${entry.project}\u0000${entry.agent}\u0000${entry.pattern}`;
      const group = groups.get(key) ?? {
        allow: 0,
        deny: 0,
        answer: 0,
        last: 0,
        project: entry.project,
      };
      group[entry.decision]++;
      group.last = Math.max(group.last, entry.at);
      groups.set(key, group);
    }
    lines.push(``, `## What was answered before`, ``);
    if (!groups.size) lines.push(`Nothing yet.`);
    else
      lines.push(
        `| Project | Agent | Request | Allowed | Denied | Answered | Last |`,
        `|---|---|---|---|---|---|---|`,
      );
    for (const [key, group] of [...groups].sort(
      (a, b) => b[1].last - a[1].last,
    )) {
      const [project, agent, pattern] = key.split("\u0000");
      lines.push(
        `| ${project} | ${agent} | \`${pattern}\` | ${group.allow} | ${group.deny} | ${group.answer} | ${day(group.last)} |`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
}
