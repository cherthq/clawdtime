/**
 * Memory for computer use. It is ClawdTime's own memory
 * (`connectors/agents/memory.ts`), behind its own switch: memory is off until
 * the person turns it on (`clawdtime memory on`), and while it is off computer
 * use reads nothing from it and writes nothing to it.
 *
 * Before a request the worker reads the few notes that fit its goal, with the
 * memory's own search, and gives them to the planner as data. After the
 * request it keeps what the owner taught in it: the owner's own words for the
 * request while it ran, and its outcome in one line of fixed words. Each note
 * carries the goal as its context. A note is never a secret, and it never
 * holds text that was typed, the text of a page or a picture: it is built from
 * the owner's words, fixed words and the names of the sites and apps that the
 * request opened.
 */
import { terms, type FactKind, type Memory } from "../agents/memory.js";
import { clean } from "./guards.js";
import {
  looksBareSecret,
  looksSecretStrict,
  namesSecret,
  type RequestState,
} from "./journal.js";
import { casualWords } from "./orders.js";
import { rememberedLength, rememberedLimit } from "./planner.js";
import type { StepRecord } from "./ports.js";

/** The most notes that one request keeps. */
export const lessonLimit = 3;

/** What one request taught, as the worker knows it at its end. */
export interface Lesson {
  goal: string;
  /**
   * The owner's own words for the request after it began, oldest first: what
   * they added while it ran, and their answers to its questions.
   */
  said: string[];
  state: RequestState;
  /** Why it ended, in the journal's one word. */
  reason: string;
  /** The steps of the request. Only the sites and apps that it opened are read. */
  history: StepRecord[];
}

/** One note to keep. */
export interface LessonNote {
  text: string;
  kind: FactKind;
  source: "said" | "inferred";
}

/** What the worker needs of the memory. The worker runs the same without it. */
export interface ComputerMemory {
  /** True while memory is on. It is read at each call. */
  on(): boolean;
  /** The notes that fit the goal: at most 5, of at most 300 characters. None while memory is off. */
  recall(goal: string): string[];
  /** Keeps what the request taught, at most 3 notes. The number kept. Nothing while memory is off. */
  learn(lesson: Lesson): number;
}

/** Words that teach nothing by themselves: a yes, a wait, a thanks. */
const filler = new Set(
  terms(
    "ok okay yes yeah yep sure fine thanks thank you go ahead on continue carry keep going wait hold hang sec second moment minute please pls now done typed it there right good great cool no nope stop pause again",
  ),
);
/** The owner's words teach something: one word that is not filler, and no bare value. */
const teaches = (words: string) =>
  !looksBareSecret(words) && terms(words).some((word) => !filler.has(word));
/** A note that holds a secret, or speaks of one, is never kept. */
const unsafe = (text: string) =>
  looksSecretStrict(text) ||
  looksSecretStrict(casualWords(text)) ||
  namesSecret(text);
/** One sentence: it ends with a stop. */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The sites and the apps that the request opened, in the order it opened them. At most 3. */
function placesOf(history: StepRecord[]): string[] {
  const places: string[] = [];
  for (const { action, outcome } of history) {
    // "ok", or "sent, ..." when the screen did not move after it. A site
    // whose page did not load was not opened: its name may be misheard.
    if (
      !/^(?:ok|sent)\b/.test(outcome) ||
      outcome.includes("the page did not load")
    )
      continue;
    let place = "";
    if (action.kind === "open_url" || action.kind === "browser_open")
      try {
        place = new URL(action.url).hostname.replace(/^www\./, "");
      } catch {
        place = "";
      }
    else if (action.kind === "open_app") place = clean(action.name, 40);
    if (place && !places.includes(place)) places.push(place);
    if (places.length === 3) break;
  }
  return places;
}
const listed = (items: string[]) =>
  items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const endings: Record<RequestState, string> = {
  completed: "It was done.",
  blocked: "It did not finish.",
  canceled: "It was stopped before its end.",
  uncertain: "Its result is not known.",
  running: "It did not finish.",
  waiting_for_person: "It did not finish.",
};

/**
 * The notes that one request keeps: the owner's newest words for it, each
 * with the goal as context, then its outcome in one line. At most 3. None
 * when the goal holds a secret. The outcome comes only after a step, and not
 * for a one-step move to a desktop or an app.
 */
export function lessonNotes(lesson: Lesson): LessonNote[] {
  const goal = clean(lesson.goal, 2000);
  if (!goal || unsafe(goal)) return [];
  const about = `the request "${clean(goal, 120).replace(/"/g, "'")}"`;
  const said = [
    ...new Set(lesson.said.map((words) => clean(words, 600)).filter(Boolean)),
  ]
    .filter(teaches)
    .map((words): LessonNote => ({
      text: sentence(`For ${about}, the owner said: ${clean(words, 160)}`),
      kind: "preference",
      source: "said",
    }))
    .filter((note) => !unsafe(note.text));
  const places = placesOf(lesson.history);
  const outcome: LessonNote | null =
    lesson.history.length === 0 || lesson.reason === "desktop_switched"
      ? null
      : {
          text: `${places.length ? `Opened ${listed(places)} for` : "Worked on"} ${about}. ${endings[lesson.state]}`,
          kind: "episode",
          source: "inferred",
        };
  const notes = outcome && !unsafe(outcome.text) ? [outcome] : [];
  // When there are more words than the notes allow, the newest are kept.
  return [...said.slice(-(lessonLimit - notes.length)), ...notes];
}

/**
 * Computer use over the person's memory. Every call reads the switch first,
 * and a memory that cannot be read or written changes nothing of a request.
 */
export function computerMemory(memory: Memory): ComputerMemory {
  const on = () => {
    try {
      return memory.enabled();
    } catch {
      return false;
    }
  };
  return {
    on,
    recall: (goal) => {
      if (!on()) return [];
      try {
        // The person's own notes, not those of one project folder.
        return memory
          .search(goal, { scope: null, limit: rememberedLimit })
          .map(({ fact }) => clean(fact.text, rememberedLength))
          .filter((text) => text !== "" && !looksSecretStrict(text));
      } catch {
        return [];
      }
    },
    learn: (lesson) => {
      if (!on()) return 0;
      let kept = 0;
      for (const note of lessonNotes(lesson))
        try {
          memory.remember(note);
          kept++;
        } catch {
          // A note that memory refuses, such as a credential, is left out.
        }
      return kept;
    },
  };
}
