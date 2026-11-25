/**
 * What the planner reads of the element of each step. A step line said only
 * "click_element: ok", so the planner could not see what it hit. The worker
 * now keeps the name that the journal keeps for the step, with the role of
 * the element when the look named it by its number. The name is cut short,
 * and a name that looks like a secret is left out, with the same check that
 * keeps secrets out of the journal. Typed text is never a name.
 */
import { looksSecretStrict } from "./journal.js";
import type { Action, Observation } from "./ports.js";

/** The most characters of a name in a step line. */
export const aimLength = 60;

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
