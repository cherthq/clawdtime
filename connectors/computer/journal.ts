/**
 * Computer use: the journal and the switch.
 *
 * The journal is the record of what the worker was asked and what it did:
 * the request, its state, and each step as the kind of action and the name of
 * the element. It has no place for an image, for typed text or for the text of
 * a page. It lives in the state folder with the same rules as the decision
 * desk: a folder for its owner only, files for its owner only, written whole
 * and then renamed, and no symbolic link is followed.
 *
 * What the person said for a request while it ran is part of the record too.
 * It is kept in a file of its own beside the journal, `guidance.json`. The
 * journal is read whole and strictly, so a build that does not know a field
 * cannot read a journal that has it, and then blocks all work. A file that
 * such a build never opens cannot do that.
 *
 * The journal is what makes a restart safe. A request that was running when
 * the service stopped has an unknown result. It becomes `uncertain`, it is
 * never run again, and it blocks new work until the person clears it.
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { looksSecret } from "../agents/memory.js";
import { secureWrite } from "../shared/state.js";

export const computerDirectory = (root: string) => join(root, "computer");

/**
 * running and waiting_for_person are live. The other four are final: the
 * request ended (completed, blocked, canceled) or its result is not known
 * (uncertain).
 */
export const requestStates = [
  "running",
  "waiting_for_person",
  "completed",
  "blocked",
  "canceled",
  "uncertain",
] as const;
export type RequestState = (typeof requestStates)[number];
const live = new Set<RequestState>(["running", "waiting_for_person"]);

const moment = z.number().int().nonnegative();
const stepSchema = z
  .object({
    n: z.number().int().positive(),
    /** The kind of action: click_element, type, key. Never its text. */
    kind: z.string().max(40),
    /** The name of the element, the key or the site. */
    target: z.string().max(80),
    /** ok, or one word for why it did not run. */
    outcome: z.string().max(40),
    at: moment,
  })
  .strict();
const identity = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
const requestSchema = z
  .object({
    id: identity,
    /** What the person asked, as one line. */
    goal: z.string().max(300),
    state: z.enum(requestStates),
    /** One word for how it came to this state: done, stopped, restart. */
    reason: z.string().max(80),
    createdAt: moment,
    updatedAt: moment,
    /** When the person cleared an uncertain request. Its record stays. */
    clearedAt: moment.optional(),
    steps: z.array(stepSchema).max(200),
  })
  .strict();
const journalSchema = z
  .object({ version: z.literal(1), requests: z.array(requestSchema).max(400) })
  .strict();
export type JournalStep = z.infer<typeof stepSchema>;
export type JournalRequest = z.infer<typeof requestSchema>;

/** The most times that the person can add words to one request while it runs. */
export const guidanceLimit = 8;
/**
 * How many ids of refused, stopped or otherwise handled words are kept per
 * request so that a replay after a restart starts nothing. Ids only, no text.
 */
const seenLimit = 64;
const saidSchema = z.object({
  /** The id that the words came with. The same id is taken once. */
  id: identity,
  /** What the person said, as one line. It is kept as the goal is kept. */
  text: z.string().max(300),
  at: moment,
});
/** A field that a later build adds here is dropped on reading, not refused. */
const guidanceSchema = z.object({
  version: z.literal(1),
  requests: z
    .array(
      z.object({
        /** The request that the words were for. */
        id: identity,
        /** Oldest first. */
        said: z.array(saidSchema).max(guidanceLimit),
        /** Ids of words for this request that were not added to `said`. */
        seen: z.array(identity).max(seenLimit).optional(),
      }),
    )
    .max(400),
});
export type JournalGuidance = z.infer<typeof saidSchema>;

const clean = (value: string, limit: number) =>
  value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, limit);
const invisibleSecretClass =
  "[\\p{Cf}\\u034f\\u115f\\u1160\\u17b4\\u17b5\\u180e\\u3164\\uffa0\\ufe00-\\ufe0f]";
const invisibleSecretChars = new RegExp(invisibleSecretClass, "gu");
const invisibleAroundOp = new RegExp(
  `${invisibleSecretClass}+(is|was|[:=])${invisibleSecretClass}+`,
  "giu",
);
const invisibleBeforeOp = new RegExp(
  `${invisibleSecretClass}+(is|was)(?=\\s|$)`,
  "giu",
);
const invisibleAfterOp = new RegExp(
  `(^|\\s)(is|was)${invisibleSecretClass}+`,
  "giu",
);
const invisibleAroundPunctOp = new RegExp(
  `${invisibleSecretClass}+([:=])|([:=])${invisibleSecretClass}+`,
  "gu",
);
const secretNoun =
  "(?:password|passwd|passcode|passphrase|pin|secret|token|api[ _-]?key|credential|pw|pwd|2fa|ssn|cvv|cvc)";
const plainStateTail =
  "(?:(?:already|filled|expired|wrong|correct|required|empty|needed|not|missing|blank|invalid|valid|hidden|autofilled|the\\s+same|different|unchanged|unknown|pending|active|inactive|in\\s+\\S+|on\\s+(?:my|the|your|a|this|that)\\s+\\S+)(?![A-Za-z0-9_-])|set(?!\\s+to\\s+\\S)(?![A-Za-z0-9_-])|saved(?!\\s+as\\s+\\S)(?![A-Za-z0-9_-]))";
const nonSecretBareWord =
  "(?:is|was|are|were|be|been|has|have|had|will|would|can|could|should|may|might|must|do|does|did|in|into|on|onto|for|to|of|at|by|from|with|without|about|and|or|but|if|when|as|that|this|these|those|then|than|here|there|now|yet|still|already|not|no|never|please|pls|again|first|next|yourself|myself|the|your|mine|field|fields|box|boxes|input|inputs|bar|settings|setting|manager|reset|change|screen|page|tab|button|link|window|dialog|popup|prompt|form|section|entry|label|icon|check|error|message|text|area|row|item|option|menu|list|step|login|sign|account|autofill|saved|filled|expired|wrong|correct|required|empty|set|needed|missing|blank|hidden|invalid|valid|generator|recovery|lock|locked|unlock|policy|policies|rule|rules|strength|hint|hints|hash|hashed|key|keys|store|vault|sync|value|values|number|numbers|code|codes|card|cards|type|name|header|headers|body|cookie|cookies|file|files|folder|path|scope|scopes|refresh|revoke|rotate|same|different)(?![A-Za-z0-9_-])";
/** A word between a secret noun and its value: "pin number is", "pin code: 4821". */
const secretQualifier = String.raw`(?:\s+(?:number|no\.?|num|code|digits|word|phrase))?`;
/** Words that stand for no value of their own after a verb of typing: "type my pin in the pin field". */
const notAValue = String.raw`(?:(?:my|the|your|a|an|it|its|this|that|these|those|them|his|her|our|their|one|in|into|on|out|something|anything|nothing|everything|some|any|text|word|words|name|names|email|e-mail|username|user|login|code|value|here|there|now|again|me|you|yours|mine|same|cursor|mouse|pointer|caret|focus|tab|space|key|keys|keyboard|autofill|manager)|${secretNoun}s?)(?![A-Za-z0-9_-])`;
const strictSecretShapes = [
  // Sentence and contraction forms: secret noun (optionally "for <target>") followed by is/was/'s (optionally "set to"/"saved as") and a non-state value.
  new RegExp(
    String.raw`\b${secretNoun}${secretQualifier}(?:\s+for\s+(?:[A-Za-z0-9._-]+\s+){0,3}[A-Za-z0-9._-]+)?(?:\s+(?:is|was)(?:\s+(?:set\s+to|saved\s+as))?|'s(?:\s+(?:set\s+to|saved\s+as))?)\s+(?!${plainStateTail})\S+`,
    "i",
  ),
  // Key-value forms with : or = (full-width colon/equals fold via NFKC).
  new RegExp(String.raw`\b${secretNoun}\s*[:=]\s*\S+`, "i"),
  // Quoted or bare value directly after a secret noun.
  new RegExp(
    String.raw`\b${secretNoun}\s+(?:["'][^"'\s][^"']*["']|(?!${nonSecretBareWord})[A-Za-z0-9!@#$%^&*_+=~./-]{4,})`,
    "i",
  ),
  // A 4 to 8 digit code (with or without spaces/hyphens) after pin, code, otp, passcode, or 2fa, or 3 to 4 digits after cvv/cvc.
  new RegExp(
    String.raw`(?<!\b(?:zip|postal|area|country|error|status|http|exit|promo|coupon|discount|referral|invite|gift|voucher)\s+)\b(?:pin|code|otp|passcode|2fa)\b${secretQualifier}(?:\s+(?:is|was)|'s)?\s*[:=#-]?\s*\d(?:[ -]?\d){3,7}\b`,
    "i",
  ),
  /\b(?:cvv|cvc)\b(?:\s+(?:is|was)|'s)?\s*[:=#-]?\s*\d{3,4}\b/i,
  // Value before secret noun: "type 4821 as the pin", "enter hunter2 as the password".
  new RegExp(
    String.raw`\b(?:type|enter|use|put)\s+(?:\d(?:[ -]?\d){2,7}|"[^"\n]+"|'[^'\n]+'|\S{3,})\s+as\s+(?:the\s+|my\s+)?(?:code|otp|${secretNoun})\b`,
    "i",
  ),
  // A value typed into a secret field: "type hunter22 in the password field", "enter 4821 in the pin box", "use hunter22 for the password".
  new RegExp(
    String.raw`\b(?:type|enter|input|put|paste|write|key|fill|use)(?:\s+in)?\s+(?:(?:the|my)\s+)?(?!${notAValue})(?:"[^"\n]+"|'[^'\n]+'|\S+)\s+(?:in|into|inside|on|for|as|at|to)\s+(?:(?:the|my|your|a|an|this|that)\s+)?(?:[A-Za-z0-9'_-]+\s+){0,2}?${secretNoun}s?\b`,
    "i",
  ),
  // A secret field filled with a value: "fill the password field with hunter22".
  new RegExp(
    String.raw`\bfill\s+(?:in\s+|out\s+)?(?:(?:the|my|your|a|an)\s+)?(?:[A-Za-z0-9'_-]+\s+){0,2}?${secretNoun}s?(?:\s+(?:field|box|input|slot|entry))?\s+with\s+(?:(?:the|my)\s+)?(?!${notAValue})\S+`,
    "i",
  ),
  // Payment card numbers: 13 to 19 digits with optional spaces or hyphens (excluding order/ISBN/tracking/invoice/shipment references).
  /(?<!\b(?:order|isbn|tracking|invoice|shipment)\s+)(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/i,
];
/**
 * Long secret nouns that people misspell ("pasword", "passwrod", "paswrd",
 * "credental"), and the English words near them that stay as they are.
 */
const misspeltSecretNouns = [
  "password",
  "passcode",
  "passphrase",
  "credential",
  "secret",
];
const nearSecretNouns = new Set([
  "passport",
  "passports",
  "paraphrase",
  "paraphrases",
  "cadential",
  "secrete",
  "secreted",
  "secretes",
]);

/** How many edits (an insertion, a deletion, a change, a swap of two neighbours) turn `a` into `b`. */
function editCount(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  return d[a.length]![b.length]!;
}

/**
 * The words with a misspelt secret noun spelled out: "my pasword is" reads
 * "my password is", and "pass code" reads "passcode". A noun of 8 letters or
 * more takes two edits, a shorter one takes one. The first letter is kept.
 */
export function spellSecretNouns(text: string): string {
  return text
    .replace(/\bpass\s+(word|code|phrase)(s?)\b/gi, "pass$1$2")
    .replace(/\b[A-Za-z]{5,14}\b/g, (word) => {
      const lower = word.toLowerCase();
      if (nearSecretNouns.has(lower)) return word;
      for (const noun of misspeltSecretNouns) {
        const base =
          lower.endsWith("s") && lower.length > noun.length
            ? lower.slice(0, -1)
            : lower;
        if (base === noun || base[0] !== noun[0]) continue;
        const limit = noun.length >= 8 ? 2 : 1;
        if (Math.abs(base.length - noun.length) > limit) continue;
        if (editCount(base, noun) <= limit) return noun;
      }
      return word;
    });
}

/** A secret named as a thing: a secret noun, also misspelt ("the pin field", "my pasword"). */
const namedSecret = new RegExp(
  String.raw`\b${secretNoun}s?\b|\b(?:otp|one[- ]time\s+(?:code|password)|verification\s+code|security\s+code)\b`,
  "i",
);

/** True when the words name a secret or a field for one: "type my pin in the pin field". */
export function namesSecret(text: string): boolean {
  const plain = text.normalize("NFKC").replace(invisibleSecretChars, "");
  return namedSecret.test(plain) || namedSecret.test(spellSecretNouns(plain));
}

/**
 * True when the words are one short value on their own that is a secret
 * right after words that name one: a number of 3 to 12 digits ("4821",
 * "48 21"), or one word of 4 or more with a letter and a digit or a symbol
 * ("hunter22", "p@ss").
 */
export function looksBareSecret(text: string): boolean {
  const value = text
    .normalize("NFKC")
    .replace(invisibleSecretChars, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'\u2018\u201c]+|["'\u2019\u201d.!,;]+$/g, "");
  return (
    /^\d(?:[ -]?\d){2,11}$/.test(value) ||
    /^(?=\S*[A-Za-z])(?=\S*[\d!@#$%^&*_+=~])[^\s?]{4,64}$/.test(value)
  );
}

/**
 * Strict credential check for computer-use guidance and journal records.
 * Normalizes NFKC, strips format and invisible joiner characters (\p{Cf},
 * U+034F, etc.) to "", tests a newline-joined variant for wrapped tokens,
 * separates one- or two-sided invisible characters around is/was/:/=, and
 * checks contractions, bare/quoted secret values, spaced PIN/OTP/CVV/SSN codes,
 * value-before-noun forms, a value typed into a secret field, misspelt secret
 * nouns, and payment card numbers while ignoring plain state
 * remarks ("is already filled", "is the same", "is on my phone").
 */
export function looksSecretStrict(text: string): boolean {
  const normalized = text
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
  const stripped = normalized.replace(invisibleSecretChars, "");
  const opSpaced = normalized
    .replace(invisibleAroundOp, " $1 ")
    .replace(invisibleBeforeOp, " $1 ")
    .replace(invisibleAfterOp, "$1$2 ")
    .replace(invisibleAroundPunctOp, " $1$2 ")
    .replace(invisibleSecretChars, "");
  const noNewlines = stripped.replace(/[\r\n]+\s*/g, "");
  if (looksSecret(noNewlines)) return true;
  const variants = [
    normalized,
    stripped,
    opSpaced,
    clean(normalized, normalized.length),
    clean(stripped, stripped.length),
    clean(opSpaced, opSpaced.length),
  ];
  // A misspelt secret noun hides no secret: "my pasword is hunter22".
  return [...variants, ...variants.map(spellSecretNouns)].some(
    (value) =>
      looksSecret(value) ||
      strictSecretShapes.some((shape) => shape.test(value)),
  );
}
/** What the journal holds in place of a request that carried a credential. */
export const credentialMarker =
  "[A request that held a credential. Its text is not kept.]";
const keptRequests = 30;
const keptSteps = 200;
const maximumBytes = 2 * 1024 * 1024;

export class ComputerJournal {
  readonly file: string;
  /** What the person said for requests while they ran. */
  readonly guidanceFile: string;
  private cache: { stamp: string; requests: JournalRequest[] } | undefined;
  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(computerDirectory(root), "journal.json");
    this.guidanceFile = join(computerDirectory(root), "guidance.json");
  }

  /** The requests, or null when the file is there and cannot be read. */
  private load(): JournalRequest[] | null {
    let stat;
    try {
      stat = lstatSync(this.file);
    } catch {
      return [];
    }
    if (!stat.isFile() || stat.size > maximumBytes) return null;
    const stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    if (this.cache?.stamp === stamp) return this.cache.requests;
    try {
      const requests = journalSchema.parse(
        JSON.parse(readFileSync(this.file, "utf8")),
      ).requests;
      this.cache = { stamp, requests };
      return requests;
    } catch {
      return null;
    }
  }
  private save(requests: JournalRequest[]) {
    // The last requests stay. One whose result is unknown and not cleared is never dropped.
    const open = (request: JournalRequest) =>
      live.has(request.state) ||
      (request.state === "uncertain" && request.clearedAt === undefined);
    let extra = requests.length - keptRequests;
    const kept = requests.filter((request) => {
      if (extra <= 0 || open(request)) return true;
      extra--;
      return false;
    });
    secureWrite(this.file, { version: 1, requests: kept });
    this.cache = undefined;
    if (kept.length < requests.length) this.pruneGuidance(kept);
  }
  private pruneGuidance(kept: JournalRequest[]) {
    if (!existsSync(this.guidanceFile)) return;
    const entries = this.said();
    if (!entries) return;
    const known = new Set(kept.map((request) => request.id));
    const retained = entries.filter((entry) => known.has(entry.id));
    if (retained.length === entries.length) return;
    try {
      secureWrite(
        this.guidanceFile,
        guidanceSchema.parse({ version: 1, requests: retained }),
      );
    } catch {
      // Pruning guidance must never break saving the journal.
    }
  }
  private change(
    id: string,
    edit: (request: JournalRequest) => JournalRequest,
  ) {
    const requests = this.load();
    if (!requests)
      throw new Error("The journal of computer requests cannot be read.");
    const index = requests.findIndex((request) => request.id === id);
    if (index < 0) throw new Error("No such computer request.");
    const next = [...requests];
    next[index] = requestSchema.parse(edit(requests[index]!));
    this.save(next);
  }

  /** True when the file is missing or valid. False when it is there and cannot be read. */
  readable() {
    return this.load() !== null;
  }
  all(): JournalRequest[] {
    return this.load() ?? [];
  }
  get(id: string) {
    return this.all().find((request) => request.id === id) ?? null;
  }
  latest() {
    return this.all().at(-1) ?? null;
  }
  /**
   * The request that blocks new work: its result is unknown and the person
   * has not cleared it. A journal that cannot be read blocks too, because it
   * cannot say that nothing is unknown.
   */
  unresolved(): JournalRequest | null {
    const requests = this.load();
    if (!requests)
      return {
        id: "unreadable",
        goal: "",
        state: "uncertain",
        reason: "unreadable_journal",
        createdAt: 0,
        updatedAt: 0,
        steps: [],
      };
    return (
      requests.find(
        (request) =>
          request.state === "uncertain" && request.clearedAt === undefined,
      ) ?? null
    );
  }

  /**
   * On start: a request that was running has an unknown result now. It is
   * marked uncertain and nothing runs it again. Returns the requests that changed.
   */
  recover(): JournalRequest[] {
    const requests = this.load();
    if (!requests) return [];
    const changed: JournalRequest[] = [];
    const next = requests.map((request) => {
      if (!live.has(request.state)) return request;
      const uncertain: JournalRequest = {
        ...request,
        state: "uncertain",
        reason: "restart",
        updatedAt: this.now(),
      };
      changed.push(uncertain);
      return uncertain;
    });
    if (changed.length) this.save(next);
    return changed;
  }

  /** Records a new request as running, before anything is done for it. */
  open(id: string, goal: string): JournalRequest {
    const requests = this.load();
    if (!requests)
      throw new Error("The journal of computer requests cannot be read.");
    if (requests.some((request) => request.id === id))
      throw new Error("That computer request is already in the journal.");
    const at = this.now();
    const request = requestSchema.parse({
      id,
      // A credential is never kept, here as in the chat and in memory.
      goal: looksSecretStrict(goal) ? credentialMarker : clean(goal, 300),
      state: "running",
      reason: "started",
      createdAt: at,
      updatedAt: at,
      steps: [],
    });
    this.save([...requests, request]);
    return request;
  }
  set(id: string, state: RequestState, reason: string) {
    this.change(id, (request) => ({
      ...request,
      state,
      reason: clean(reason, 80),
      updatedAt: this.now(),
    }));
  }
  /** The words that are kept, by request. Empty when there is no file, null when it cannot be read. */
  private said(): z.infer<typeof guidanceSchema>["requests"] | null {
    let stat;
    try {
      stat = lstatSync(this.guidanceFile);
    } catch {
      return [];
    }
    if (!stat.isFile() || stat.size > maximumBytes) return null;
    try {
      return guidanceSchema.parse(
        JSON.parse(readFileSync(this.guidanceFile, "utf8")),
      ).requests;
    } catch {
      return null;
    }
  }
  /** What the person said for this request after it began, oldest first. */
  guidance(id: string): JournalGuidance[] {
    return this.said()?.find((entry) => entry.id === id)?.said ?? [];
  }
  /**
   * Records what the person said for a request after it began. The words are
   * kept as the goal is kept: one line, and a marker in place of a
   * credential. A request has room for `guidanceLimit` of them: one more is
   * not written. Words stay as long as the journal holds their request.
   * Returns the line as it is kept.
   */
  guide(id: string, said: { id: string; text: string }): string {
    const requests = this.load();
    if (!requests?.some((request) => request.id === id))
      throw new Error("No such computer request.");
    const kept = this.said();
    if (!kept)
      throw new Error("The words for computer requests cannot be read.");
    const line = clean(said.text, 300);
    // Check raw, format-stripped (\p{Cf} -> "") and cleaned forms, plus strict shapes.
    const text = looksSecretStrict(said.text) ? credentialMarker : line;
    const existing = kept.find((entry) => entry.id === id);
    const before = existing?.said ?? [];
    const known = new Set(requests.map((request) => request.id));
    secureWrite(
      this.guidanceFile,
      guidanceSchema.parse({
        version: 1,
        requests: [
          ...kept.filter((entry) => entry.id !== id && known.has(entry.id)),
          {
            id,
            said: [...before, { id: said.id, text, at: this.now() }],
            ...(existing?.seen?.length ? { seen: existing.seen } : {}),
          },
        ],
      }),
    );
    return text;
  }
  /**
   * Records only the id of words for a request that were not kept as guidance
   * (stops, refusals, secrets, over-limit or late words). Ids stay outside the
   * 8-addition cap in a bounded list so a replay after a restart starts nothing.
   */
  seen(id: string, wordId: string) {
    const parsedId = identity.parse(wordId);
    const requests = this.load();
    if (!requests?.some((request) => request.id === id))
      throw new Error("No such computer request.");
    const kept = this.said();
    if (!kept)
      throw new Error("The words for computer requests cannot be read.");
    const existing = kept.find((entry) => entry.id === id);
    const said = existing?.said ?? [];
    const before = existing?.seen ?? [];
    if (
      said.some((entry) => entry.id === parsedId) ||
      before.includes(parsedId)
    )
      return;
    const known = new Set(requests.map((request) => request.id));
    secureWrite(
      this.guidanceFile,
      guidanceSchema.parse({
        version: 1,
        requests: [
          ...kept.filter((entry) => entry.id !== id && known.has(entry.id)),
          { id, said, seen: [...before, parsedId].slice(-seenLimit) },
        ],
      }),
    );
  }
  /** The id of the request that took or handled the words with this id while it ran. Null when none did. */
  guided(id: string): string | null {
    return (
      this.said()?.find(
        (entry) =>
          entry.said.some((said) => said.id === id) ||
          (entry.seen?.includes(id) ?? false),
      )?.id ?? null
    );
  }
  /** One step: the kind of action, the name of the element and the outcome. Nothing else is taken. */
  step(id: string, step: { kind: string; target: string; outcome: string }) {
    this.change(id, (request) => ({
      ...request,
      updatedAt: this.now(),
      steps: [
        ...request.steps,
        {
          n: (request.steps.at(-1)?.n ?? 0) + 1,
          kind: clean(step.kind, 40),
          target: clean(step.target, 80),
          outcome: clean(step.outcome, 40),
          at: this.now(),
        },
      ].slice(-keptSteps),
    }));
  }

  private setAsideGuidance(): string | null {
    if (this.said() !== null) return null;
    const aside = join(
      computerDirectory(this.root),
      `guidance.unreadable-${this.now()}.json`,
    );
    if (existsSync(aside)) throw new Error("Clear it again in a moment.");
    renameSync(this.guidanceFile, aside);
    return aside;
  }

  /**
   * The person says that they looked at the result of the uncertain request.
   * Its record stays, with the time. A file that cannot be read is set aside
   * under another name, never removed.
   */
  clear(): { cleared: JournalRequest[]; setAside: string | null } {
    const requests = this.load();
    if (!requests) {
      const aside = join(
        computerDirectory(this.root),
        `journal.unreadable-${this.now()}.json`,
      );
      if (existsSync(aside)) throw new Error("Clear it again in a moment.");
      renameSync(this.file, aside);
      this.cache = undefined;
      try {
        this.setAsideGuidance();
      } catch {
        // The journal is already set aside; a second clear can handle guidance.
      }
      return { cleared: [], setAside: aside };
    }
    const cleared: JournalRequest[] = [];
    const next = requests.map((request) => {
      if (request.state !== "uncertain" || request.clearedAt !== undefined)
        return request;
      const done = { ...request, clearedAt: this.now() };
      cleared.push(done);
      return done;
    });
    if (cleared.length) this.save(next);
    const guidanceAside = this.setAsideGuidance();
    return { cleared, setAside: guidanceAside };
  }
}

const switchSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    since: moment,
  })
  .strict();
const switchFile = (root: string) =>
  join(computerDirectory(root), "config.json");

/**
 * The switch for computer use. It is off until the person turns it on. A file
 * that is not a regular owner-only file of this user, or that is not valid,
 * does not turn it on.
 */
export function readComputerSwitch(root: string): {
  enabled: boolean;
  since: number | null;
  problem: string | null;
} {
  const file = switchFile(root);
  const off = (problem: string | null) => ({
    enabled: false,
    since: null,
    problem,
  });
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return off(null);
  }
  if (
    !stat.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && stat.uid !== process.getuid()) ||
    stat.size > 4096
  )
    return off(
      "The switch file is not a regular owner-only file of this user. It is ignored, so computer use is off.",
    );
  try {
    const value = switchSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    return { enabled: value.enabled, since: value.since, problem: null };
  } catch {
    return off(
      "The switch file is not valid. It is ignored, so computer use is off.",
    );
  }
}
export function setComputerSwitch(
  root: string,
  enabled: boolean,
  now = Date.now(),
) {
  secureWrite(switchFile(root), { version: 1, enabled, since: now });
}

/** True when the folder of computer use is missing, or is a real folder for its owner only. */
export function computerFolderPrivate(root: string) {
  try {
    const stat = statSync(computerDirectory(root));
    return (
      stat.isDirectory() &&
      !lstatSync(computerDirectory(root)).isSymbolicLink() &&
      (stat.mode & 0o077) === 0
    );
  } catch {
    return true;
  }
}
