import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { secureWrite } from "../shared/state.js";

/**
 * Memory: what the person told ClawdTime about themselves and their work, kept
 * as small facts in owner-only files on this Mac. It is off until the person
 * turns it on. One fact is one sentence that stands alone. A newer fact can
 * replace an older one, and the older one stays as history. Something that
 * only holds for a while expires. A credential is never kept.
 */
export const memoryDirectory = (root: string) => join(root, "memory");
export const factKinds = ["fact", "preference", "episode"] as const;
export type FactKind = (typeof factKinds)[number];
const id = z.string().regex(/^[0-9a-f]{8}$/);
export const factSchema = z
  .object({
    id,
    text: z.string().min(1).max(400),
    /** A fact holds until it changes. A preference grows stronger when it is said again. An episode expires. */
    kind: z.enum(factKinds),
    /** Null for the person. A project folder for something that holds only there. */
    scope: z.string().max(4096).nullable(),
    /** Said by the person, or worded by the model from what the person said. */
    source: z.enum(["said", "inferred"]),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    strength: z.number().int().min(1).max(99),
    /** False once a newer fact replaced this one. */
    current: z.boolean(),
    replaces: id.nullable(),
    extends: id.nullable(),
    expiresAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type MemoryFact = z.infer<typeof factSchema>;

const day = 86_400_000;
const maximumFacts = 2000;
/** Something that reads as a value, not as a plain word: it has a digit, or it is long. */
const valued = String.raw`(?:(?=\S*\d)\S{6,}|\S{16,})`;
/** A name that holds a word for a secret, such as CLIENT_SECRET or db-password. An underscore is a part of the name. */
const named = (words: string) =>
  String.raw`(?<![A-Za-z0-9])[A-Za-z0-9_.-]*(?:${words})[A-Za-z0-9_.-]*`;
const secretShapes = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  // An address that carries a password: scheme://user:password@host.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/i,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  // A name of a secret with a value after it. A plain word after it is not a value.
  new RegExp(
    String.raw`${named("api[_-]?key|secret|token|passwd|password|passphrase|credential|private[_-]?key|access[_-]?key|bearer")}\s*[:=]\s*${valued}`,
    "i",
  ),
  // After a password, any word of some length is its value.
  new RegExp(
    String.raw`${named("passwd|password|passphrase")}\s*[:=]\s*\S{6,}`,
    "i",
  ),
  // The same as a person says it: "my password is ...", "the api key is ...".
  new RegExp(
    String.raw`\b(?:password|passwd|passphrase|passcode|pin|api[ _-]?key|secret[ _-]?key|access[ _-]?key|private[ _-]?key|token|secret)\s+(?:is|was)\s+${valued}`,
    "i",
  ),
];
/** True for text that holds something shaped like a credential. */
export const looksSecret = (text: string) =>
  secretShapes.some((shape) => shape.test(text));

const tidy = (text: string) =>
  text.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, 400);
const same = (text: string) =>
  tidy(text)
    .toLowerCase()
    .replace(/[.!?,;:]+$/, "");
const stop = new Set(
  "a an and are as at be but by do does for from had has have he her his i in is it its me my of on or our she so that the their them they this to us was we were what when which who will with you your".split(
    " ",
  ),
);
/** Cuts plain endings, so "pushes", "pushed" and "pushing" meet "push". */
const stem = (word: string) => {
  let base = word;
  if (base.length > 5 && base.endsWith("ing")) base = base.slice(0, -3);
  else if (base.length > 4 && base.endsWith("ed")) base = base.slice(0, -2);
  else if (base.length > 4 && /(s|x|z|ch|sh)es$/.test(base))
    base = base.slice(0, -2);
  else if (base.length > 3 && base.endsWith("s") && !base.endsWith("ss"))
    base = base.slice(0, -1);
  if (base !== word) base = base.replace(/([bdgmnprt])\1$/, "$1");
  return base.length > 4 && base.endsWith("e") ? base.slice(0, -1) : base;
};
/** The words that carry meaning, in a plain base form. */
export const terms = (text: string) => [
  ...new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((word) => word.length > 1 && !stop.has(word))
      .map(stem),
  ),
];

export interface RememberInput {
  text: string;
  kind?: FactKind;
  scope?: string | null;
  source?: MemoryFact["source"];
  /** Days until it expires. An episode gets 14 when none is given. */
  days?: number | null;
  replaces?: string | null;
  extends?: string | null;
}

export class Memory {
  private readonly directory: string;
  private cache: { stamp: string; facts: MemoryFact[] } | undefined;
  constructor(
    root: string,
    private readonly now: () => number = Date.now,
  ) {
    this.directory = memoryDirectory(root);
  }
  private file(name: string) {
    return join(this.directory, name);
  }
  private read(name: string): { stamp: string; text: string } | null {
    const file = this.file(name);
    if (!existsSync(file)) return null;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Refusing a memory path that is not a regular file.");
    return {
      stamp: `${stat.mtimeMs}:${stat.size}`,
      text: readFileSync(file, "utf8"),
    };
  }

  /** Off until the person turns it on. A settings file that cannot be read means off. */
  enabled(): boolean {
    try {
      const found = this.read("settings.json");
      return found
        ? (JSON.parse(found.text) as { enabled?: unknown }).enabled === true
        : false;
    } catch {
      return false;
    }
  }
  setEnabled(enabled: boolean) {
    secureWrite(this.file("settings.json"), { version: 1, enabled });
  }

  /** Every stored fact that has not expired, oldest first. History is included. */
  facts(): MemoryFact[] {
    const found = this.read("facts.json");
    if (!found) return [];
    if (this.cache?.stamp !== found.stamp) {
      let rows: unknown;
      try {
        rows = JSON.parse(found.text);
      } catch {
        // A damaged file is never overwritten in silence: the person sees it.
        throw new Error(
          `The memory file is damaged: ${this.file("facts.json")}`,
        );
      }
      const facts = (Array.isArray(rows) ? rows : []).flatMap((row) => {
        const parsed = factSchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      });
      this.cache = { stamp: found.stamp, facts };
    }
    const now = this.now();
    return this.cache.facts.filter(
      (fact) => fact.expiresAt === null || fact.expiresAt > now,
    );
  }
  private write(facts: MemoryFact[]) {
    // Over the limit, history goes first, then the oldest fact.
    const kept = [...facts];
    while (kept.length > maximumFacts) {
      const old = kept.findIndex((fact) => !fact.current);
      kept.splice(old >= 0 ? old : 0, 1);
    }
    secureWrite(this.file("facts.json"), kept);
    this.cache = undefined;
  }
  private visible(scope: string | null | undefined) {
    // With no scope given, everything shows. For a project: the person's facts and that project's.
    return this.facts().filter(
      (fact) =>
        fact.current &&
        (scope === undefined || fact.scope === null || fact.scope === scope),
    );
  }

  /** Keeps one fact. The same fact again makes it stronger and newer, and adds no copy. */
  remember(input: RememberInput): { fact: MemoryFact; added: boolean } {
    const text = tidy(input.text);
    if (!text) throw new Error("A memory needs some text.");
    if (looksSecret(text))
      throw new Error("That looks like a credential. Memory never keeps one.");
    const now = this.now();
    const kind = input.kind ?? "fact";
    const scope = input.scope ?? null;
    const days = input.days ?? (kind === "episode" ? 14 : null);
    const expiresAt = days && days > 0 ? now + Math.round(days * day) : null;
    const facts = this.facts();
    const twin = facts.find(
      (fact) =>
        fact.current && fact.scope === scope && same(fact.text) === same(text),
    );
    if (twin) {
      twin.strength = Math.min(99, twin.strength + 1);
      twin.updatedAt = now;
      if (input.source === "said") twin.source = "said";
      if (twin.kind === "episode" || expiresAt) twin.expiresAt = expiresAt;
      this.write(facts);
      return { fact: twin, added: false };
    }
    const known = (value: string | null | undefined) =>
      facts.find((fact) => fact.id === value)?.id ?? null;
    const replaced = facts.find(
      (fact) => fact.id === input.replaces && fact.current,
    );
    if (replaced) replaced.current = false;
    const fact = factSchema.parse({
      id: randomBytes(4).toString("hex"),
      text,
      kind,
      scope,
      source: input.source ?? "said",
      createdAt: now,
      updatedAt: now,
      strength: 1,
      current: true,
      replaces: replaced?.id ?? null,
      extends: known(input.extends),
      expiresAt,
    });
    this.write([...facts, fact]);
    return { fact, added: true };
  }

  /** Removes facts for good: one by its id, or every one whose text holds the given words. */
  forget(what: string): number {
    const wanted = same(what);
    if (wanted.length < 3) return 0;
    const facts = this.facts();
    const gone = new Set(
      facts
        .filter((fact) =>
          id.safeParse(what.trim()).success
            ? fact.id === what.trim()
            : same(fact.text).includes(wanted),
        )
        .map((fact) => fact.id),
    );
    if (!gone.size) return 0;
    this.write(
      facts
        .filter((fact) => !gone.has(fact.id))
        .map((fact) => ({
          ...fact,
          replaces: gone.has(fact.replaces ?? "") ? null : fact.replaces,
          extends: gone.has(fact.extends ?? "") ? null : fact.extends,
        })),
    );
    return gone.size;
  }

  /**
   * Finds facts by their words. No model is used. A rare word counts for more
   * than a common one, and a strong or recent fact for a little more. The score
   * runs from 0 to 1, and a weak match returns nothing.
   */
  search(
    query: string,
    options: { scope?: string | null; limit?: number; threshold?: number } = {},
  ): { fact: MemoryFact; score: number }[] {
    const asked = terms(query);
    if (!asked.length) return [];
    const facts = this.visible(options.scope);
    const words = facts.map((fact) => terms(fact.text));
    const seen = new Map<string, number>();
    for (const list of words)
      for (const word of list) seen.set(word, (seen.get(word) ?? 0) + 1);
    const weight = (word: string) =>
      Math.log(1 + facts.length / (1 + (seen.get(word) ?? 0)));
    const total = (list: string[]) =>
      list.reduce((sum, word) => sum + weight(word), 0);
    const now = this.now();
    return facts
      .map((fact, index) => {
        const own = new Set(words[index]);
        const shared = total(asked.filter((word) => own.has(word)));
        // How much of the question the fact covers, or how much of the fact the question covers.
        const cover = shared
          ? Math.max(shared / total(asked), shared / total(words[index]!))
          : 0;
        const strong = Math.min(1, Math.log2(fact.strength + 1) / 3);
        const recent = Math.exp(-(now - fact.updatedAt) / (60 * day));
        return { fact, score: cover * (0.92 + 0.05 * strong + 0.03 * recent) };
      })
      .filter((found) => found.score >= (options.threshold ?? 0.3))
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.fact.updatedAt - left.fact.updatedAt,
      )
      .slice(0, options.limit ?? 6);
  }

  /**
   * The small summary that goes with every conversation: what lasts, strongest
   * first, then what is recent. It is at most 1,200 characters.
   */
  profile(scope?: string | null): string {
    const facts = this.visible(scope);
    const now = this.now();
    const line = (fact: MemoryFact) =>
      `- ${fact.text.length > 110 ? `${fact.text.slice(0, 109)}…` : fact.text}${fact.source === "inferred" ? " (inferred)" : ""}`;
    const lasting = facts
      .filter((fact) => fact.kind !== "episode")
      .sort(
        (left, right) =>
          right.strength - left.strength || right.updatedAt - left.updatedAt,
      )
      .slice(0, 10);
    const recent = facts
      .filter(
        (fact) =>
          !lasting.includes(fact) &&
          (fact.kind === "episode" || now - fact.updatedAt < 7 * day),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 6);
    let text = "";
    const add = (next: string) => {
      if (text.length + next.length + 1 > 1200) return false;
      text += `${text ? "\n" : ""}${next}`;
      return true;
    };
    for (const fact of lasting) if (!add(line(fact))) return text;
    // The heading goes in only with a first line under it.
    for (const [index, fact] of recent.entries())
      if (!add(index === 0 ? `Recent:\n${line(fact)}` : line(fact))) break;
    return text;
  }
}
