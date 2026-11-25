/**
 * Computer use: keys that edit text go only where text has the focus.
 *
 * Select all, cut, paste and delete a word act on the text of the field that
 * has the focus. With no such field they act on whatever else is in front:
 * cmd+a in a list of notes selects every note, and the text typed next goes
 * nowhere. The planner test showed it (23 Nov 2026): after a click on a note
 * in the list, the planner pressed cmd+a before it clicked into the note, in
 * 2 of 3 runs.
 *
 * So the worker holds such a key back when the last look before it names
 * elements and none of them takes typing with the focus. The planner reads
 * why and clicks into the text first. When the look names no element at all,
 * the worker cannot tell where the focus is, and the key goes as before.
 *
 * A text field is not the only thing that takes typing: a spreadsheet cell
 * or its sheet, a grid, the canvas of a document and a web page that draws
 * its own editor do too (`hasTypingFocus`). The stress run on the owner's Mac
 * (26 Nov 2026) typed into cells of a spreadsheet, and the worker read that
 * as typing with no field.
 *
 * cmd+delete is not in the list: in Finder it moves a file to the Trash, and
 * that key has its own question.
 */
import { hasTypingFocus, parseCombo } from "./guards.js";
import type { Action, Observation } from "./ports.js";

/** The combos that edit text, written as `parseCombo` writes them. */
const textCombos = new Set([
  // Select all, cut, paste, and paste and match style.
  "cmd+a",
  "cmd+x",
  "cmd+v",
  "cmd+shift+v",
  "cmd+opt+shift+v",
  // Delete one word back or forward.
  "opt+delete",
  "opt+forwarddelete",
]);

export const noTextFocusText =
  "No text field has the focus. Click into the text first.";

/** True when the combo edits the text of the field with the focus. */
export function editsText(combo: string): boolean {
  const parsed = parseCombo(combo);
  return parsed !== null && textCombos.has(parsed.combo);
}

/**
 * Why a key is held back just before it goes, or null when it may go. `seen`
 * is the last look before the key.
 */
export function textKeyHold(
  action: Action,
  seen: Observation | null,
): string | null {
  if (action.kind !== "key" || !editsText(action.combo)) return null;
  if (!seen || seen.elements.length === 0) return null;
  return hasTypingFocus(seen) ? null : noTextFocusText;
}
