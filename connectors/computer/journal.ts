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
const requestSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/),
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

const clean = (value: string, limit: number) =>
  value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, limit);
/** What the journal holds in place of a request that carried a credential. */
export const credentialMarker =
  "[A request that held a credential. Its text is not kept.]";
const keptRequests = 30;
const keptSteps = 200;
const maximumBytes = 2 * 1024 * 1024;

export class ComputerJournal {
  readonly file: string;
  private cache: { stamp: string; requests: JournalRequest[] } | undefined;
  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(computerDirectory(root), "journal.json");
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
      goal: looksSecret(goal) ? credentialMarker : clean(goal, 300),
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
    return { cleared, setAside: null };
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
