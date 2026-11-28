/**
 * A question about the screen as it is now: which app or window is in
 * front, what a window, page, tab or document says, or whether an app is
 * open. Only the computer task can see the screen. The task list, the
 * process level and the language model cannot, so the chat sends such a
 * question to the computer task every time.
 *
 * The reader is narrow on purpose. A question about ClawdTime's own work
 * ("how's it going?"), about the process level ("what runs on port 4173?"),
 * about code ("what does the README say?") or about a place in the world
 * ("is the bakery open tonight?") is not one. A message that it does not
 * place is left to the model. Pure: it reads only the words.
 */

/** Things on the screen that a question can name. */
const thing =
  "(?:apps?|applications?|programs?|windows?|tabs?|pages?|web\\s*pages?|sites?|websites?|documents?|docs?|pdfs?|dialogs?|pop-?ups?|alerts?|sheets?|screen|browser)";
/** Things whose words a page holds. A code file is not one. */
const shownThing =
  "(?:windows?|tabs?|pages?|web\\s*pages?|sites?|websites?|dialogs?|pop-?ups?|alerts?|sheets?|screen|browser)";
/** Words for a thing in front, open or in view now. */
const inView =
  "(?:in\\s+front|at\\s+the\\s+front|frontmost|on\\s+top|focused|in\\s+focus|active|open(?:ed)?|showing|shown|visible|up|on\\s+(?:the\\s+|my\\s+)?screen|minimi[sz]ed)";
/** "now", "right now", "currently" and the like after the question. */
const now = "(?:\\s+(?:right\\s+)?now|\\s+currently|\\s+at\\s+the\\s+moment)?";
/** "this", "the open", "my current": a thing that is on the screen now. */
const here =
  "(?:this|that|these|those|the|my|your)(?:\\s+(?:open|current|front|frontmost|active|focused))?";

const questions: RegExp[] = [
  // "Which app is in front?", "what windows are open?", "what app is open right now?"
  new RegExp(
    `^(?:which|what)\\s+${thing}\\s+(?:is|are|'s)\\s+(?:now\\s+|currently\\s+|still\\s+)?${inView}\\b`,
    "iu",
  ),
  // "What is the frontmost app?", "what's the active window?"
  new RegExp(
    `^(?:which|what)(?:\\s+is|\\s+are|'s)\\s+the\\s+(?:front|frontmost|active|current|focused|top|open)\\s+${thing}\\b`,
    "iu",
  ),
  // "What app am I in?", "what tab are we on?"
  new RegExp(
    `^(?:which|what)\\s+${thing}\\s+(?:am\\s+i|are\\s+we)\\s+(?:in|on|using|looking\\s+at)\\b`,
    "iu",
  ),
  // "What does this window say?", "what does the open Stonepad document say?"
  new RegExp(
    `^what\\s+(?:does|do)\\s+(?:${here}\\s+(?:[\\p{L}\\p{N}.-]+\\s+){0,2}?${shownThing}|(?:this|that|the\\s+open|the\\s+current|the\\s+front|my\\s+open)\\s+(?:[\\p{L}\\p{N}.-]+\\s+){0,2}?${thing})\\s+(?:say|show|read|contain|display)\\b`,
    "iu",
  ),
  // "Read me this page", "read the open document".
  new RegExp(
    `^read\\s+(?:me\\s+|out\\s+)?(?:this|that|the\\s+open|the\\s+current|the\\s+front|what(?:'s|\\s+is)\\s+on)\\s+(?:[\\p{L}\\p{N}.-]+\\s+){0,2}?${thing}\\b`,
    "iu",
  ),
  // "What's on my screen?", "what is in front?", "what am I looking at?"
  /^what(?:'s|\s+is)\s+(?:on\s+(?:my|the|this)\s+screen|in\s+front|frontmost|up\s+on\s+(?:my|the)\s+screen)\b/iu,
  /^what\s+(?:am\s+i\s+looking\s+at|do\s+you\s+see\s+on\s+(?:my|the)\s+screen)\b/iu,
  // "What is the title of this tab?", "what's this tab called?"
  new RegExp(
    `^what(?:'s|\\s+is)\\s+the\\s+(?:title|name|address|url)\\s+of\\s+${here}\\s+(?:[\\p{L}\\p{N}.-]+\\s+){0,2}?${thing}\\b`,
    "iu",
  ),
  new RegExp(
    `^what(?:'s|\\s+is)\\s+(?:this|that|the\\s+(?:open|current|front|frontmost|active))\\s+${thing}\\s+(?:called|named|titled)\\b`,
    "iu",
  ),
  // "Is Mail open?", "are my Riverchat windows open?", "is Safari in front?"
  new RegExp(
    `^(?:is|are)\\s+(?:the\\s+|my\\s+)?((?:[\\p{L}\\p{N}.'-]+\\s+){0,2}[\\p{L}\\p{N}.'-]+)\\s+(?:still\\s+)?${inView}${now}$`,
    "iu",
  ),
  // "Do I have Mail open?", "is there a Stonepad window open?"
  new RegExp(
    `^(?:do\\s+i\\s+have|have\\s+i\\s+got)\\s+(?:any\\s+|a\\s+|an\\s+)?((?:[\\p{L}\\p{N}.'-]+\\s+){0,2}[\\p{L}\\p{N}.'-]+)\\s+${inView}${now}$`,
    "iu",
  ),
  new RegExp(
    `^is\\s+there\\s+(?:a|an|any)\\s+((?:[\\p{L}\\p{N}.'-]+\\s+){0,2}[\\p{L}\\p{N}.'-]+)\\s+${inView}${now}$`,
    "iu",
  ),
];

/** A thing of code, of a job or of the process level: not the screen. */
const notTheScreen =
  /\b(?:repo(?:sitory|s)?|readme|tests?|builds?|branch(?:es)?|commits?|diffs?|pull\s+requests?|prs?|functions?|scripts?|logs?|servers?|ports?|processes|jobs?|sessions?|tasks?|search(?:es)?|memory|cpu|disk)\b|\bport\s+\d+/i;
/** A place in the world, or a time to come: "is the bakery open tonight?" */
const aPlace =
  /\b(?:stores?|shops?|restaurants?|cafes?|cafés?|bakery|bakeries|bars?|banks?|pharmac(?:y|ies)|offices?|museums?|gyms?|library|libraries|malls?|markets?|parks?|clinics?|doors?|gates?|roads?|tonight|today|tomorrow|until|weekends?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|holidays?)\b|\bat\s+\d/i;
/**
 * The thing of an "is X open?" question is a word that points back or a
 * person: "is it open?" is the model's to resolve, and "are you up?" is
 * small talk.
 */
const pointsBack =
  /^(?:it|that|this|they|them|those|these|one|you|we|i|he|she|everyone|everybody|someone|anyone)$/i;
/** Polite words in front of the question: "can you tell me", "hey", "quick question". */
const lead =
  /^(?:(?:hey|hi|ok(?:ay)?|so|quick\s+question|clawdtime|please)[\s,:!.-]+)*(?:(?:can|could|would)\s+you\s+(?:please\s+)?(?:tell|show)\s+me\s+|tell\s+me\s+|i\s+(?:want|need)\s+to\s+know\s+)?/i;

/**
 * True when one sentence of the message asks about the screen as it is now.
 * A message with a thing of code, of the process level or of a place in the
 * world is never one.
 */
export function asksAboutTheScreen(text: string): boolean {
  const plain = text.replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  if (!plain || plain.length > 600) return false;
  if (notTheScreen.test(plain) || aPlace.test(plain)) return false;
  return plain
    .split(/(?<=[.?!])\s+/)
    .map((sentence) =>
      sentence
        .replace(lead, "")
        .replace(/[\s.?!]+$/, "")
        .trim(),
    )
    .some((sentence) =>
      questions.some((question) => {
        const found = question.exec(sentence);
        if (!found) return false;
        // A question of the "is X open?" form names its X: a word that
        // points back is left to the model.
        return !found[1] || !pointsBack.test(found[1].trim());
      }),
    );
}
