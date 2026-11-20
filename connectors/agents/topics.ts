import { join } from "node:path";
import { claudeHome } from "./evidence.js";
import { title } from "./render.js";
import type { System } from "./system.js";
import type { AgentSession } from "./types.js";

/**
 * What a session is about, in the few words that its own terminal shows in
 * its title bar, and the search that finds a session from what a person says.
 *
 * A board name such as "work-13" says nothing about the job. Claude Code gives
 * each session a short title and writes it as a line of its own kind in the
 * session file. Only lines of that kind are read here: never a prompt, an
 * answer or a tool result. The title is data. It never goes into the board
 * snapshot.
 */
const titleKind = "ai-title";
const titleMark = /"type"\s*:\s*"ai-title"/;
const clean = (value: string) =>
  value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120);

function parse(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The title that a Claude Code session gave itself: the newest title line near
 * the end of its session file. null when there is none, or when the registry
 * file belongs to an earlier process with the same number.
 */
export function claudeTitle(
  system: System,
  pid: number,
  startedAt: number | null,
): string | null {
  const record = parse(
    system.readText(
      join(claudeHome(system), "sessions", `${pid}.json`),
      65_536,
    ),
  );
  if (!record || record.pid !== pid) return null;
  const registered =
    typeof record.startedAt === "number" && Number.isFinite(record.startedAt)
      ? record.startedAt
      : null;
  if (
    registered !== null &&
    startedAt !== null &&
    registered < startedAt - 5000
  )
    return null;
  const { sessionId, cwd } = record;
  if (typeof sessionId !== "string" || !/^[0-9A-Za-z-]{8,64}$/.test(sessionId))
    return null;
  if (typeof cwd !== "string" || !cwd.startsWith("/") || cwd.length > 4096)
    return null;
  const tail = system.readTail(
    join(
      claudeHome(system),
      "projects",
      cwd.replace(/[^A-Za-z0-9]/g, "-"),
      `${sessionId}.jsonl`,
    ),
    262_144,
  );
  if (!tail) return null;
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    // A title line is short. A long line is a message, whatever it quotes.
    if (line.length > 2000 || !titleMark.test(line)) continue;
    const entry = parse(line);
    if (entry?.type !== titleKind || typeof entry.aiTitle !== "string")
      continue;
    const found = clean(entry.aiTitle);
    if (found) return found;
  }
  return null;
}

/**
 * The words that find a session: its name, and for a Claude Code session of
 * this Mac the title that it shows in its terminal.
 */
export function sessionTitles(system: System, session: AgentSession): string[] {
  const titles = [title(session)];
  if (
    session.agent === "claude-code" &&
    session.pid !== null &&
    !session.host
  ) {
    const own = claudeTitle(system, session.pid, session.startedAt);
    if (own && !titles.includes(own)) titles.push(own);
  }
  return titles;
}

export type SessionPick =
  | { kind: "one"; session: AgentSession }
  | { kind: "many"; sessions: AgentSession[] }
  | { kind: "none" };

/** Words that every request to show a session holds. They name no session. */
const filler = new Set(
  `a an and the it its this that these those to of in on at for with from by or is are be was do does did
please show open bring switch go get put take back me my i you your we us can could would will want need
see look view display focus zoom into onto front window windows terminal terminals screen session sessions
tab tabs agent agents claude code codex one ones up down again now there here where which what who if all
about doing working work works running run runs thing stuff just some any make bigger larger smaller size
maximize maximise restore text full them they everything something anything nothing other another read
tell say give`.split(/\s+/),
);
/** Words that ask for the newest session. They describe none. */
const newestWords = new Set(
  "new newest latest recent just started opened made created last".split(" "),
);
const wordsOf = (value: string) =>
  value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** A word and what it is without a plain ending: "lines" and "line", "checking" and "check". */
const forms = (word: string) => {
  const found = [word];
  for (const ending of ["ing", "ed", "es", "s"])
    if (word.endsWith(ending) && word.length - ending.length >= 3)
      found.push(word.slice(0, -ending.length));
  return found;
};
/**
 * Two words are the same word when they agree but for a plain ending. The
 * start of one word is not the other word: "them" is not "theme", and "read"
 * is not "ready".
 */
const same = (a: string, b: string) => {
  const other = forms(b);
  return forms(a).some((form) => other.includes(form));
};
const asksForNewest =
  /\b(?:new|newest|latest|recent|just (?:started|opened|made|created)|last (?:started|opened))\b/i;
/** What the person rules out names no session: "not the billing one" is cut before the count. */
const ruledOut =
  /\b(?:not|except|without|other than|rather than|instead of)\b[^,.;:!?]*/gi;

/**
 * The session that the words are about. It counts, for each session, how many
 * of the person's own words stand in its name or its title. One session with
 * the most words is the answer, when at least two words fit or every word
 * does. Otherwise the sessions that fit are all returned, so the person can
 * say which one. Words that fit nothing find nothing: this never guesses.
 */
export function pickSession(
  words: string,
  sessions: AgentSession[],
  titles: (session: AgentSession) => string[],
): SessionPick {
  const wanted = [
    ...new Set(
      wordsOf(words.replace(ruledOut, " ")).filter(
        (word) => !filler.has(word) && !newestWords.has(word),
      ),
    ),
  ];
  if (wanted.length) {
    const sure = (score: number) => score >= 2 || score === wanted.length;
    const all = sessions
      .map((session) => {
        const own = titles(session).flatMap(wordsOf);
        return {
          session,
          score: wanted.filter((word) => own.some((have) => same(word, have)))
            .length,
        };
      })
      .filter((entry) => entry.score > 0);
    // A session to show needs a window. One that has a window and fits for
    // sure is not hidden by a better fit that has none.
    const windowed = all.filter((entry) => entry.session.focus !== "none");
    const scored = (
      windowed.some((entry) => sure(entry.score)) ? windowed : all
    ).sort((a, b) => b.score - a.score);
    if (scored.length) {
      const top = scored[0]!.score;
      const best = scored.filter((entry) => entry.score === top);
      // One word that fits is enough only when it is all that the person
      // gave. "The session that checks the lines" is not the session about a
      // dedicated line: one fitting word of several is a maybe, not an answer.
      return sure(top) && best.length === 1
        ? { kind: "one", session: best[0]!.session }
        : { kind: "many", sessions: best.slice(0, 5).map((e) => e.session) };
    }
    // The person described a session and nothing fits: "the new deploy
    // session" is not the newest session of any kind.
    return { kind: "none" };
  }
  if (asksForNewest.test(words)) {
    // The new session to show is one that has a window on this Mac.
    const newest = sessions
      .filter((session) => session.focus !== "none" && session.startedAt)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    if (newest) return { kind: "one", session: newest };
  }
  return { kind: "none" };
}

/**
 * The titles that a session's own terminal tab can show. Only a Claude Code
 * session of this Mac is known to show its name or its title there. For any
 * other session the tab is not found by a title: a tab of another session
 * could carry the same words.
 */
export const tabTitles = (session: AgentSession, titles: string[]) =>
  session.agent === "claude-code" && session.pid !== null && !session.host
    ? titles
    : [];

/**
 * The titles of sessions, kept for a few seconds: one status reads the title
 * of every session, and each title is the end of a file.
 */
export function titleReader(system: System, keepMs = 5000) {
  const known = new Map<string, { at: number; titles: string[] }>();
  return (session: AgentSession): string[] => {
    const now = system.now();
    const have = known.get(session.id);
    if (have && now - have.at < keepMs) return have.titles;
    const titles = sessionTitles(system, session);
    if (known.size > 500) known.clear();
    known.set(session.id, { at: now, titles });
    return titles;
  };
}
