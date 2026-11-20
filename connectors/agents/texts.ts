import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { JobFacts } from "./jobs.js";

/**
 * ClawdTime over text messages. The person texts the Chert line of their
 * project, ClawdTime on this Mac reads the text, answers it, and texts the
 * answer of every job that finishes.
 *
 * A Shared line has no webhook, so this reads the project's messages every few
 * seconds and needs no public address. It uses the project API key. Three
 * rules are code here:
 *
 * - One answer for one message. The key of a reply is made from the id of the
 *   message, so the service sends no second answer, also from a second process
 *   or after the journal was lost.
 * - The work of one message runs once. A message is written down as claimed
 *   before any work. After a restart a claimed message is not run again.
 * - Only the owner commands this Mac. A message counts only when its sender
 *   ends with the last four digits of the owner's number, and an answer goes
 *   only to the owner's number from the settings, never to a value from a
 *   message.
 *
 * The journal holds ids, states and the text of an answer that is still to be
 * sent. Nothing here logs the text of a message or a number.
 */
export interface TextSettings {
  /** The API of the service, such as https://app.trychert.com/api/v1. */
  base: string;
  key: string;
  project: string;
  /** The owner's own number, in international form. The only number that is answered. */
  owner: string;
  /** The line to listen on. null: the line of the owner's own texts. */
  line: string | null;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The settings from the environment, or the names of what is missing or wrong. */
export function textSettings(
  env: Record<string, string | undefined>,
): { settings: TextSettings } | { missing: string[] } {
  const missing: string[] = [];
  const key = env.CHERT_API_KEY?.trim() ?? "";
  const project = env.CHERT_PROJECT_ID?.trim() ?? "";
  const owner = (env.CLAWDTIME_OWNER_PHONE ?? "").replace(/[\s().-]/g, "");
  const line = env.CHERT_LINE_ID?.trim() || null;
  const base = (
    env.CHERT_API_BASE?.trim() || "https://app.trychert.com/api/v1"
  ).replace(/\/+$/, "");
  if (!key) missing.push("CHERT_API_KEY");
  if (!uuid.test(project)) missing.push("CHERT_PROJECT_ID");
  if (!/^\+?[0-9]{7,15}$/.test(owner)) missing.push("CLAWDTIME_OWNER_PHONE");
  if (line && !uuid.test(line)) missing.push("CHERT_LINE_ID");
  // The key travels in a header: only an encrypted address may receive it.
  if (!/^https:\/\/[^\s/]+/.test(base)) missing.push("CHERT_API_BASE");
  return missing.length
    ? { missing }
    : { settings: { base, key, project, owner, line } };
}

interface Item {
  status: "claimed" | "answered";
  at: number;
  /** The answer, kept from the moment it exists until it is sent. */
  reply?: string;
  outcomes?: string[];
}
interface Journal {
  version: 1;
  /** Messages older than this were there before the channel started. They are not answered. */
  baselineAt: number;
  /** The line of the owner's newest text: where the answer of a job goes. */
  line: string | null;
  items: Record<string, Item>;
  /** Jobs whose answer was sent, or refused for good. */
  jobs: Record<string, string>;
}

interface Message {
  id: string;
  line_id: string;
  direction: string;
  masked_recipient: string;
  created_at: string;
  text: string;
}
const isMessage = (value: unknown): value is Message => {
  const item = value as Record<string, unknown> | null;
  return (
    !!item &&
    typeof item === "object" &&
    typeof item.id === "string" &&
    uuid.test(item.id) &&
    typeof item.line_id === "string" &&
    typeof item.direction === "string" &&
    typeof item.masked_recipient === "string" &&
    typeof item.created_at === "string" &&
    typeof item.text === "string"
  );
};

export const restartNote =
  "I restarted while I worked on that. Send it again if you still need it.";
const failedNote = "I could not finish that request.";
/** A message that is this old when it is first seen is not run: a stale order must not run hours later. */
const staleMs = 10 * 60_000;
const keepMs = 7 * 24 * 60 * 60_000;
const partSize = 3800;

/** Text for a message: lines are kept, colors and control characters are not. */
export function messageText(text: string) {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\P{C}\n]/gu, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
const parts = (text: string) => {
  const found: string[] = [];
  for (let at = 0; at < text.length && found.length < 4; at += partSize)
    found.push(text.slice(at, at + partSize));
  return found.length ? found : ["Done."];
};

export class TextChannel {
  private readonly file: string;
  private readonly now: () => number;
  private readonly request: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private journal: Journal;
  private recovered = false;
  constructor(
    private readonly options: {
      settings: TextSettings;
      /** The state folder. The journal is agents/texts.json in it. */
      root: string;
      /** One request to ClawdTime, in the person's own words. */
      answer: (words: string) => Promise<string>;
      /** The jobs of this Mac, newest first. The answer of a finished one is sent as a text. */
      jobs?: () => JobFacts[];
      now?: () => number;
      request?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
      log?: (line: string) => void;
    },
  ) {
    this.file = join(options.root, "agents", "texts.json");
    this.now = options.now ?? Date.now;
    this.request = options.request ?? fetch;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? (() => {});
    this.journal = this.load();
    this.save();
  }

  private load(): Journal {
    const fresh: Journal = {
      version: 1,
      baselineAt: this.now(),
      line: null,
      items: {},
      jobs: {},
    };
    try {
      if (!existsSync(this.file) || !lstatSync(this.file).isFile())
        return fresh;
      const value = JSON.parse(readFileSync(this.file, "utf8")) as Journal;
      if (
        value?.version !== 1 ||
        typeof value.baselineAt !== "number" ||
        typeof value.items !== "object" ||
        value.items === null
      )
        return fresh;
      return {
        version: 1,
        baselineAt: value.baselineAt,
        line: typeof value.line === "string" ? value.line : null,
        items: value.items,
        jobs: value.jobs && typeof value.jobs === "object" ? value.jobs : {},
      };
    } catch {
      return fresh;
    }
  }
  private save() {
    // Old entries go, and the baseline moves with them, so a dropped message is never answered again.
    const edge = this.now() - keepMs;
    for (const [id, item] of Object.entries(this.journal.items))
      if (item.status === "answered" && item.at < edge) {
        delete this.journal.items[id];
        this.journal.baselineAt = Math.max(this.journal.baselineAt, item.at);
      }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.journal), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
  }

  private async api(
    method: "GET" | "POST",
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ status: number; data: unknown; code: string | null }> {
    const { settings } = this.options;
    const response = await this.request(`${settings.base}/shared-messages`, {
      method,
      headers: {
        authorization: `Bearer ${settings.key}`,
        "x-chert-project-id": settings.project,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    let json: { data?: unknown; error?: { code?: unknown } } = {};
    try {
      json = (await response.json()) as typeof json;
    } catch {
      json = {};
    }
    return {
      status: response.status,
      data: json.data,
      code: typeof json.error?.code === "string" ? json.error.code : null,
    };
  }

  /**
   * Sends one part. A failure of the network or of the service is tried again
   * with the same key and the same text, which the service sends once. A plain
   * refusal is not tried again.
   */
  private async send(key: string, line: string, text: string) {
    for (let attempt = 0; attempt < 5; attempt++) {
      let result: Awaited<ReturnType<TextChannel["api"]>>;
      try {
        result = await this.api(
          "POST",
          { line_id: line, recipient: this.options.settings.owner, text },
          key,
        );
      } catch {
        result = { status: 0, data: null, code: null };
      }
      if (result.status === 200) {
        const state = (result.data as { state?: unknown } | null)?.state;
        return typeof state === "string" ? state : "sent";
      }
      if (result.code === "shared_idempotency_conflict")
        return "already_answered";
      if (result.status !== 0 && result.status !== 429 && result.status < 500)
        return `refused:${result.code ?? result.status}`;
      await this.sleep(Math.min(60_000, 2000 * 2 ** attempt));
    }
    return "gave_up";
  }

  private async reply(id: string, line: string, text: string) {
    const item = this.journal.items[id]!;
    // The exact text is kept first: a restart sends this text again, with the same keys.
    item.reply = text;
    this.save();
    const outcomes: string[] = [];
    for (const [index, part] of parts(text).entries())
      outcomes.push(
        await this.send(`clawdtime-reply:${id}:${index}`, line, part),
      );
    this.journal.items[id] = {
      status: "answered",
      at: this.now(),
      outcomes,
    };
    this.save();
    this.log(`answered ${id.slice(0, 8)} ${outcomes.join(",")}`);
  }

  /** After a restart: a claimed message is answered, and its work is not run again. */
  private async recover() {
    this.recovered = true;
    const line = this.journal.line ?? this.options.settings.line;
    for (const [id, item] of Object.entries(this.journal.items))
      if (item.status === "claimed" && line)
        await this.reply(id, line, item.reply ?? restartNote);
  }

  /**
   * One round: read the messages, answer each new one from the owner, then
   * send the answer of each job that finished. "stop" means that the key was
   * refused: the channel must end and say so on the Mac.
   */
  async tick(): Promise<"ok" | "stop"> {
    if (!this.recovered) await this.recover();
    const { settings } = this.options;
    const list = await this.api("GET");
    if (list.status === 401 || list.status === 403) return "stop";
    if (list.status !== 200)
      throw new Error(`The messages could not be read (${list.status}).`);
    const items = (list.data as { items?: unknown } | null)?.items;
    const fresh = (Array.isArray(items) ? items : [])
      .filter(isMessage)
      .filter(
        (message) =>
          message.direction === "inbound" &&
          (!settings.line || message.line_id === settings.line) &&
          uuid.test(message.line_id) &&
          message.masked_recipient.endsWith(settings.owner.slice(-4)) &&
          Date.parse(message.created_at) > this.journal.baselineAt &&
          !this.journal.items[message.id],
      )
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (const message of fresh) {
      // Written down before any work: the work of one message runs once.
      this.journal.items[message.id] = { status: "claimed", at: this.now() };
      this.journal.line = message.line_id;
      this.save();
      this.log(`claimed ${message.id.slice(0, 8)}`);
      if (this.now() - Date.parse(message.created_at) > staleMs) {
        await this.reply(message.id, message.line_id, restartNote);
        continue;
      }
      let answer: string;
      try {
        answer =
          messageText(await this.options.answer(message.text)) || "Done.";
      } catch {
        answer = failedNote;
      }
      await this.reply(message.id, message.line_id, answer);
    }
    await this.tellJobs();
    return "ok";
  }

  /** The answer of each job that finished since the channel started, once, to the owner. */
  private async tellJobs() {
    const line = this.journal.line ?? this.options.settings.line;
    if (!line || !this.options.jobs) return;
    let jobs: JobFacts[];
    try {
      jobs = this.options.jobs();
    } catch {
      return;
    }
    for (const job of jobs.slice().reverse()) {
      if (
        !job.done ||
        job.startedAt <= this.journal.baselineAt ||
        this.journal.jobs[job.id]
      )
        continue;
      const text = messageText(
        `Done: ${job.job.slice(0, 120)}\n\n${job.text ?? job.result ?? ""}`,
      );
      const outcomes: string[] = [];
      for (const [index, part] of parts(text).entries())
        outcomes.push(
          await this.send(`clawdtime-job:${job.id}:${index}`, line, part),
        );
      // A refusal is final too: a closed reply window does not open by trying again.
      this.journal.jobs[job.id] = outcomes.join(",");
      this.save();
      this.log(`job ${job.id} ${outcomes.join(",")}`);
    }
  }

  /** Runs until the signal ends it, or until the key is refused. Returns why it ended. */
  async run(
    signal?: AbortSignal,
    everyMs = 3000,
  ): Promise<"stopped" | "refused"> {
    while (!signal?.aborted) {
      try {
        if ((await this.tick()) === "stop") return "refused";
      } catch (error) {
        this.log(error instanceof Error ? error.message : "The round failed.");
        await this.sleep(10_000);
      }
      await this.sleep(everyMs);
    }
    return "stopped";
  }
}
