/**
 * A short correction right after a computer request.
 *
 * Speech to text can mishear a name, and the worker then opens the wrong
 * thing. The owner says the name again, short and casual, right after: a
 * made-up "brightwave bro" after a request that opened bright5.co. That is no
 * chat: it is the request again, with the name that the owner meant. This
 * reads only that narrow form: one to three words with no verb, not a stop,
 * not a hold, not a question, right after a request that opened something.
 * The new request says what was corrected, so the planner can search the
 * name when it is no address.
 */
import { webAddress } from "../computer/navigation.js";
import { readWords } from "../computer/orders.js";

/** How long after the end of the last computer request a short name still corrects it. */
export const correctionMs = 5 * 60_000;

/** Words around a name that say nothing by themselves: "bro", "no", "I mean". */
const filler = new Set(
  "bro bruh brother dude man mate buddy yo hey pls please plz lol haha oh ah uh um umm hmm sorry no nah nope i mean meant like actually".split(
    " ",
  ),
);
/**
 * Words that make the message more than a name: a verb, a yes or a thanks,
 * a word that points back, a question word. Such a message goes on to the
 * chat as before.
 */
const notAName = new Set(
  (
    "open go goto visit search find look check click type close quit stop wait hold pause cancel read show tell call reload refresh retry try do did does done make send reply use start run play see get put keep let help fix scroll press continue resume again back skip " +
    "is are was were be been am have has had can could would should will want need know think said say " +
    "ok okay k kk yes yeah yep yup sure cool nice great good fine perfect awesome thanks thank thx ty alright right correct wrong never mind nvm whatever wow oops " +
    "hang sec second moment minute yet not dont don't " +
    "it its that this these those there here now then later too also all nothing everything something anything me you him her them us my your our " +
    "what why how where who when which"
  ).split(" "),
);
/** The verbs that open something: a request that one of these began can be corrected by a name. */
const opening =
  /^(?:please\s+)?(?:open|go\s+to|goto|visit|launch|bring\s+up|pull\s+up|show(?:\s+me)?|load|take\s+me\s+to|navigate\s+to)\b/i;
/** What the code adds to a corrected request, so that a second correction reads the name again. */
const correctedNote = /\s*\(the owner corrected [^)]*\)\s*$/i;

/**
 * What the last request opened: its address as written, or the words after
 * its verb ("Open Ledgerly in Safari" gives "Ledgerly"). Empty when the
 * request opened nothing.
 */
export function openedTarget(goal: string): string {
  const text = goal.replace(correctedNote, "").trim();
  for (const word of text.split(/\s+/)) {
    const address = webAddress(word);
    if (address && !address.fileLike)
      return address.url.hostname.replace(/^www\./, "");
  }
  const verb = opening.exec(text);
  if (!verb) return "";
  return text
    .slice(verb[0].length)
    .replace(
      /\s+(?:in|on|with|using)\s+(?:the\s+)?(?:browser|chrome|safari|a\s+new\s+tab)\b.*$/i,
      "",
    )
    .replace(/^\s*(?:the|my)\s+/i, "")
    .replace(/[.!]+$/, "")
    .trim()
    .slice(0, 80);
}

/**
 * The name in a short follow-up, or null. One to three words ("brightwave
 * bro", "no, ledgerly.com", "brightwave dot co"), with no verb, no yes, no
 * question and no stop or hold.
 */
export function correctedName(words: string): string | null {
  const text = words
    .replace(/\p{C}/gu, " ")
    .replace(/\s+dot\s+(?=[a-z]{2,}\b)/gi, ".")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || /[?？]/.test(text)) return null;
  const tokens = text
    .split(" ")
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[,.;:!]+$/gu, ""))
    .filter(Boolean);
  if (tokens.length < 1 || tokens.length > 3) return null;
  const kind = readWords(text);
  if (kind === "stop" || kind === "continue" || kind === "order") return null;
  const name = tokens.filter((token) => !filler.has(token.toLowerCase()));
  if (!name.length) return null;
  if (name.some((token) => notAName.has(token.toLowerCase()))) return null;
  // A name has a letter: "5" or "2pm" is no name.
  if (!name.some((token) => /\p{L}{2,}/u.test(token))) return null;
  if (name.length === 1) {
    const address = webAddress(name[0]!);
    if (address && !address.fileLike)
      return address.url.hostname.replace(/^www\./, "");
  }
  return name.join(" ");
}

/**
 * The new request for a short correction of the last request that opened
 * something, or null: "Open brightwave (the owner corrected bright5.co)". Null
 * when the words are no such name, when the last request opened nothing,
 * and when the name is the same as what was opened.
 */
export function correctionRequest(
  words: string,
  lastGoal: string,
): string | null {
  const target = openedTarget(lastGoal);
  if (!target) return null;
  const name = correctedName(words);
  if (!name || name.toLowerCase() === target.toLowerCase()) return null;
  return `Open ${name} (the owner corrected ${target})`;
}
