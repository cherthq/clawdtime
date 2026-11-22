import type { ProactiveSourceAdapter, WatchChannel } from "./proactive.js";
/**
 * The chat says that a session is done, by itself and once, when the person
 * asked for that ("tell me when deploy fix is done", "keep an eye on docs").
 * A chat that only answers the next message cannot keep such a word: the
 * person would have to ask again.
 *
 * It only reads the board. It never sends input to a session and never
 * answers anything. A line holds the name of a session and how its work
 * ended, as the board does: never a prompt, a reply or tool input.
 *
 * The requests are in one small file of the state folder, so the desktop
 * service says the line whichever process took the request.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { secureWrite } from "../shared/state.js";
import type { ChatLog, ChatMessage } from "./brain.js";
import { holdsNews } from "./jobnews.js";
import { title } from "./render.js";
import type { AgentSession, BoardSnapshot } from "./types.js";

/** A session must look idle this long before it is said: one scan can be wrong. */
export const settleMs = 6_000;
/** A session must stay away from the board this long before it is said to be gone. */
export const goneMs = 30_000;
/** After this long a session that still works is said once, and the request ends. */
export const watchMaxAgeMs = 12 * 60 * 60 * 1000;
/** How many sessions the chat waits for at one time. */
export const maxWatches = 8;

const epoch = z.number().int().nonnegative();
const watchSchema = z
  .object({
    sessionId: z.string().regex(/^[0-9a-z][0-9a-z_-]{1,63}$/),
    /** The name that the person heard when they asked. */
    title: z.string().max(80),
    askedAt: epoch,
    /** What the looks see since when: the session idle, or away from the board. Null while it works. */
    quiet: z
      .object({ kind: z.enum(["idle", "gone"]), since: epoch })
      .strict()
      .nullable(),
  })
  .strict();
type Watch = z.infer<typeof watchSchema>;
const fileSchema = z
  .object({
    version: z.literal(1),
    watches: z.array(watchSchema).max(maxWatches),
  })
  .strict();

/** A name as one plain line: a name is data that a session or a remote Mac can set. */
const plain = (name: string) =>
  name.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);

/** Each line of this news begins with these words: they tell it from the news of a job. */
export const sessionNewsStart = "As you asked: ";

/** What the chat says for one session whose work ended. */
function endedLine(name: string, session: AgentSession) {
  switch (session.detail) {
    case "turn_complete":
      return `${sessionNewsStart}${name} is done and idle now.`;
    case "turn_failed":
      return `${sessionNewsStart}${name} stopped on an error.`;
    case "turn_interrupted":
      return `${sessionNewsStart}${name} was interrupted and is idle now.`;
    default:
      return `${sessionNewsStart}${name} stopped working and is idle now.`;
  }
}

export class SessionNews {
  private readonly file: string;
  constructor(
    root: string,
    private readonly options: {
      board: () => BoardSnapshot | null;
      log: ChatLog;
      now: () => number;
      proactive?: ProactiveSourceAdapter;
    },
  ) {
    this.file = join(root, "agents", "chat-watches.json");
  }

  /** The requests from the file. A file that cannot be read holds none. */
  private read(): Watch[] {
    try {
      if (existsSync(this.file) && lstatSync(this.file).isFile()) {
        const parsed = fileSchema.safeParse(
          JSON.parse(readFileSync(this.file, "utf8")),
        );
        if (parsed.success) return parsed.data.watches;
      }
    } catch {
      // Nothing is said for a request that cannot be read.
    }
    return [];
  }
  private write(watches: Watch[]) {
    secureWrite(this.file, { version: 1, watches });
  }

  /** The names of the sessions that the chat waits for. */
  watching(): string[] {
    return [
      ...this.read().map((watch) => plain(watch.title)),
      ...(this.options.proactive?.watching() ?? []),
    ];
  }

  /**
   * Takes the person's request for one session. The sentence is for the
   * model: it says what the chat will do, or why nothing was taken.
   */
  watch(
    session: AgentSession,
    options: { channel?: WatchChannel } = {},
  ): { ok: boolean; said: string } {
    if (options.channel && options.channel !== "chat") {
      if (!this.options.proactive)
        return {
          ok: false,
          said: "No phone-call watch service is configured. No call was scheduled, and this request was not converted to chat.",
        };
      return this.options.proactive.watch(session, options.channel);
    }
    const name = plain(title(session));
    if (session.state === "idle")
      return {
        ok: false,
        said: `${name} is idle now: its work is done already, and nothing is left to wait for. Nothing will be said later about it.`,
      };
    if (session.state === "unknown")
      return {
        ok: false,
        said: `The state of ${name} is not known, so nothing can say when it is done.`,
      };
    try {
      const watches = this.read();
      if (watches.some((watch) => watch.sessionId === session.id))
        return {
          ok: true,
          said: `The chat already says it by itself when ${name} is done.`,
        };
      if (watches.length >= maxWatches)
        return {
          ok: false,
          said: `The chat already waits for ${maxWatches} sessions, and that is its limit. Nothing was added.`,
        };
      watches.push({
        sessionId: session.id,
        title: name,
        askedAt: this.options.now(),
        quiet: null,
      });
      this.write(watches);
    } catch {
      return {
        ok: false,
        said: "The request could not be written down, so nothing will be said later.",
      };
    }
    return {
      ok: true,
      said: `The chat says it by itself, once, when ${name} is done or stops on an error.${session.state === "needs_you" ? ` ${name} waits for the person now.` : ""}`,
    };
  }

  /**
   * Ends the person's request for one session: nothing is said about it
   * later. The sentence is for the model.
   */
  unwatch(
    session: AgentSession,
    options: { channel?: WatchChannel } = {},
  ): { ok: boolean; said: string } {
    if (options.channel && options.channel !== "chat") {
      if (!this.options.proactive)
        return {
          ok: false,
          said: "No phone-call watch service is configured. No call was scheduled, and this request was not converted to chat.",
        };
      return this.options.proactive.watch(session, options.channel);
    }
    const name = plain(title(session));
    const phoneCanceled = this.options.proactive?.unwatch(session) ?? false;
    try {
      const watches = this.read();
      const kept = watches.filter((watch) => watch.sessionId !== session.id);
      if (kept.length === watches.length && !phoneCanceled)
        return { ok: false, said: `The chat did not wait for ${name}.` };
      this.write(kept);
    } catch {
      return {
        ok: false,
        said: "The request could not be taken back: its file cannot be written.",
      };
    }
    return {
      ok: true,
      said: `The chat no longer waits for ${name}: nothing will be said about it by itself.`,
    };
  }

  /**
   * Says each session that the person asked about and whose work ended,
   * once. Returns the messages that it added to the conversation. A fault
   * says nothing: the person can still ask.
   */
  tell(): ChatMessage[] {
    try {
      return this.due();
    } catch {
      return [];
    }
  }

  private due(): ChatMessage[] {
    const watches = this.read();
    if (!watches.length) return [];
    const snapshot = this.options.board();
    // With no board nothing is known: no session is done, and none is gone.
    if (!snapshot) return [];
    const now = this.options.now();
    // A question and its answer stay together on the screen, as for a job.
    const held = holdsNews(this.options.log.recent(1)[0], now);
    const kept: Watch[] = [];
    const lines: string[] = [];
    let changed = false;
    for (const watch of watches) {
      const session = snapshot.sessions.find(
        (item) => item.id === watch.sessionId,
      );
      const name = plain(session ? title(session) : watch.title);
      // A session that waits for the person is not done, and one whose
      // state is not known is not either.
      const kind = !session ? "gone" : session.state === "idle" ? "idle" : null;
      let line: string | null = null;
      if (kind === null) {
        if (watch.quiet) {
          watch.quiet = null;
          changed = true;
        }
        if (now - watch.askedAt >= watchMaxAgeMs)
          line = `${sessionNewsStart}${name} is not done after 12 hours, and I stop waiting for it now. Ask me again and I wait for it again.`;
      } else if (watch.quiet?.kind !== kind) {
        watch.quiet = { kind, since: now };
        changed = true;
      } else if (
        now - watch.quiet.since >=
        (kind === "gone" ? goneMs : settleMs)
      )
        line = session
          ? endedLine(name, session)
          : `${sessionNewsStart}${name} is no longer on the board, so its session ended or cannot be seen from here.`;
      if (line === null || held) {
        kept.push(watch);
        continue;
      }
      lines.push(line);
      changed = true;
    }
    // Written before it is said: a fault after this says nothing twice.
    if (changed) this.write(kept);
    const added: ChatMessage[] = [];
    for (const text of lines) {
      const message: ChatMessage = {
        role: "assistant",
        text: text.slice(0, 2000),
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
