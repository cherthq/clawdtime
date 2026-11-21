/**
 * The chat says the answer of a job when the job is done, by itself and once.
 * ClawdTime says "I will tell you its answer when it is done" when it starts
 * a job. A chat that only answers the next message does not keep that word:
 * the person has to ask.
 *
 * The line goes into the conversation as ClawdTime's own message, so the
 * panel shows it and a later turn knows that it was said. The journal keeps
 * which jobs were told. A job that started before the journal began is never
 * told: it is older than this, and its answer may have been said already.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { secureWrite } from "../shared/state.js";
import type { ChatLog, ChatMessage } from "./brain.js";
import type { JobFacts } from "./jobs.js";

const journalSchema = z
  .object({
    version: z.literal(1),
    /** When the journal began. A job that started before it is never told. */
    baselineAt: z.number().int().nonnegative(),
    /** The id of each job that was told, and when. */
    told: z.record(z.string().max(80), z.number().int().nonnegative()),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;

/** A question of ClawdTime, or a message of the person, waits for its answer this long. */
export const questionHoldMs = 5 * 60_000;
/** How long the journal remembers a job that it told. Jobs older than a day are not listed. */
const rememberMs = 3 * 24 * 60 * 60 * 1000;
/** A message of the conversation holds 2000 characters. */
const room = 1900;
const cutNote = " … The rest is in the terminal window of the job.";

/** What the chat says for one job that is done. The answer is text from a session: data. */
export function jobNews(job: JobFacts) {
  const head = `Done: ${job.job.slice(0, 120)}\n\n`;
  const answer = (job.text ?? job.result ?? "").trim();
  if (!answer) return `${head}It wrote no answer.`;
  const said = `${head}Its answer: ${answer}`;
  return said.length <= room
    ? said
    : `${said.slice(0, room - cutNote.length).trimEnd()}${cutNote}`;
}

/**
 * ClawdTime's message waits for a word of the person: it asks something, or
 * it says which word it needs ("Say yes or no.", "Say approve or deny to
 * answer it.", 'Say "tell docs: ..." and I type it.').
 */
const waitsForAWord = (text: string) =>
  /\?\s*$/.test(text) || /\bsay\s+(?:yes|no|approve|deny|allow|")/i.test(text);

export class JobNews {
  private readonly file: string;
  constructor(
    root: string,
    private readonly options: {
      /** The newest jobs, each with its state. */
      jobs: () => JobFacts[];
      log: ChatLog;
      now: () => number;
    },
  ) {
    this.file = join(root, "agents", "chat-jobs.json");
  }

  /** The journal from its file, or a new one that begins now. */
  private journal(now: number): Journal {
    try {
      if (existsSync(this.file) && lstatSync(this.file).isFile()) {
        const parsed = journalSchema.safeParse(
          JSON.parse(readFileSync(this.file, "utf8")),
        );
        if (parsed.success) return parsed.data;
      }
    } catch {
      // A journal that cannot be read begins again: nothing old is told.
    }
    const fresh: Journal = { version: 1, baselineAt: now, told: {} };
    secureWrite(this.file, fresh);
    return fresh;
  }

  /**
   * Says each job that finished since the journal began, once, in the order
   * in which the jobs started. Returns the messages that it added to the
   * conversation. A fault says nothing: the person can still ask.
   */
  tell(): ChatMessage[] {
    try {
      return this.due();
    } catch {
      return [];
    }
  }

  private due(): ChatMessage[] {
    const now = this.options.now();
    const journal = this.journal(now);
    // A job's start time has whole seconds.
    const since = Math.floor(journal.baselineAt / 1000) * 1000;
    const due = this.options
      .jobs()
      .filter(
        (job) =>
          job.done &&
          job.startedAt >= since &&
          journal.told[job.id] === undefined,
      )
      .sort((a, b) => a.startedAt - b.startedAt);
    if (!due.length) return [];
    // A question of ClawdTime waits for its answer ("Which one: docs or
    // payments?"), or a message of the person waits for ClawdTime's: a line
    // between the two would part them, and "the second one" would then
    // follow the news of a job. The news waits for the next quiet moment.
    // The code does not read a line of news as an answer (`news` marks it),
    // so this is for the person's eyes: the question and its answer stay
    // together on the screen.
    const last = this.options.log.recent(1)[0];
    if (
      last &&
      now - last.at < questionHoldMs &&
      (last.role === "user" || (!last.news && waitsForAWord(last.text)))
    )
      return [];
    const added: ChatMessage[] = [];
    for (const job of due) {
      // Written before it is said: a fault after this says nothing twice.
      journal.told[job.id] = now;
      for (const [id, at] of Object.entries(journal.told))
        if (now - at > rememberMs) delete journal.told[id];
      secureWrite(this.file, journal);
      const message: ChatMessage = {
        role: "assistant",
        text: jobNews(job),
        at: now,
        via: "chat",
        news: true,
      };
      this.options.log.append(message);
      added.push(message);
    }
    return added;
  }
}
