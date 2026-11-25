/**
 * What the planner reads of the element of each step, and the ways that did
 * not work in a request.
 *
 * A step line said only "click_element: ok", so the planner could not see
 * what it hit. The worker now keeps the name that the journal keeps for the
 * step, with the role of the element when the look named it by its number.
 *
 * The planner reads only its last 12 steps, and a request may take 80
 * actions: a way that failed at step 3 is out of view by step 16 and can
 * come back. The worker reads each step line once, before a turn of the
 * planner, and keeps one row for each way that did not work: the kind of the
 * action, the role and the name of its element, fixed words for why, and a
 * count. The newest rows stay. The brief gives the rows that are older than
 * the steps it shows.
 *
 * A name is cut short, and a name that looks like a secret is left out, with
 * the same check that keeps secrets out of the journal. Typed text is never a
 * name, and a row holds no words of the step line but its name.
 */
import { looksSecretStrict } from "./journal.js";
import type { Action, Observation, StepRecord } from "./ports.js";

/** The most characters of a name in a step line. */
export const aimLength = 60;
/** The most ways that did not work in one request. The newest stay. */
export const failedWaysLimit = 12;

/** One way that did not work in this request. */
export interface FailedWay {
  kind: string;
  /** The role of its element, when the look named one. */
  role?: string;
  /** The name of its element, or its key, app or site. Never typed text. */
  name: string;
  /** Fixed words: why it did not work the last time. */
  reason: string;
  /** How often it did not work. */
  count: number;
  /** The step of its newest try. */
  step: number;
}

const plain = (value: string, limit: number) =>
  value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, limit);

/**
 * The element of one step, for its record. `target` is the name that the
 * checks gave the journal: empty when they refused the action before they
 * named one. Then the element of the look with the number of the action
 * names it. The role comes only from the element of the look that has the
 * same name.
 */
export function aimOf(
  action: Action,
  target: string,
  seen: Observation | null,
): { target?: string; role?: string } {
  const id =
    "element" in action && typeof action.element === "number"
      ? action.element
      : undefined;
  const found =
    id === undefined
      ? undefined
      : seen?.elements.find((item) => item.id === id);
  const name = plain(target || (found?.title ?? ""), aimLength);
  if (!name || looksSecretStrict(name)) return {};
  const role =
    found && plain(found.title, aimLength) === name
      ? plain(found.role, 40)
      : "";
  return role ? { target: name, role } : { target: name };
}

/** The worker's own words at the start of a step line, and the fixed words of a row for each. */
const reasons: [prefix: string, reason: string][] = [
  ["refused:", "refused, nothing was sent"],
  ["not sent:", "held back, nothing was sent"],
  ["did not run:", "the Mac did not run it"],
  [
    "sent, but the screen looks the same",
    "sent, but the screen did not change",
  ],
  ["ok, the address went to the browser, but", "the page did not load"],
];
/** The line of a step that was tried again and again ends with the outcome of its last try. */
const repeated =
  /^This action did not work \d+ times in a row\b.*? Last outcome: /s;

/**
 * Why a step did not work, in fixed words, from the start of its line. Null
 * for a step that worked, and for one that was held back for the person: they
 * said more, asked to hold or took over, and the way itself may be right.
 */
export function failedReason(outcome: string): string | null {
  const last = repeated.exec(outcome);
  if (last)
    return (
      failedReason(outcome.slice(last[0].length)) ??
      "tried again and again, with no result"
    );
  const found = reasons.find(([prefix]) => outcome.startsWith(prefix));
  if (!found) return null;
  if (found[0] === "not sent:" && /\bthe person\b/i.test(outcome)) return null;
  return found[1];
}

/**
 * The list with these step records read into it: one row for each kind,
 * role and name, its count, the reason of its newest try, last. A record
 * with no name, a name that looks like a secret or no reason adds nothing.
 */
export function keepFailed(
  list: readonly FailedWay[],
  records: readonly StepRecord[],
): FailedWay[] {
  let rows = [...list];
  for (const record of records) {
    const reason = failedReason(record.outcome);
    const name = record.target ?? "";
    if (!reason || !name || looksSecretStrict(name)) continue;
    const kind = record.action.kind;
    const role = record.role;
    const same = rows.find(
      (row) => row.kind === kind && row.role === role && row.name === name,
    );
    rows = [
      ...rows.filter((row) => row !== same),
      {
        kind,
        ...(role ? { role } : {}),
        name,
        reason,
        count: (same?.count ?? 0) + 1,
        step: record.step,
      },
    ];
  }
  return rows.slice(-failedWaysLimit);
}
