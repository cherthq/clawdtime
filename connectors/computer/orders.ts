/**
 * Conservative reader for words the person sends while a computer task runs.
 *
 * Safe by default: the task goes on only for a narrow, written shape of
 * screen order (or a plain continue phrase without a question mark). Any stop
 * word stops the task at once. Everything else holds. A casual reading of the
 * same words (typos, slang, emoji) can only make a stop or a hold more
 * likely, or read a clear order with a typo as that same order.
 */
import { looksSecretStrict } from "./journal.js";

export type WordKind = "stop" | "continue" | "order" | "hold";

const invisibleChars =
  /[\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180e\u3164\uffa0\ufe00-\ufe0f]/gu;

function normalize(text: string): { cased: string; lower: string } {
  const cased = text
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(invisibleChars, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { cased, lower: cased.toLowerCase() };
}

/**
 * Letters of other scripts that look the same as a Latin letter: Cyrillic,
 * Greek and the small capitals. NFKC keeps them as they are, so "stоp" with
 * a Cyrillic о is no "stop" to a pattern. The readers of stop, hold and
 * negation words read these letters as the Latin letter they look like.
 */
const lookalikeLetters: Record<string, string> = {
  // Cyrillic, small letters.
  а: "a",
  в: "b",
  е: "e",
  ѐ: "e",
  ё: "e",
  һ: "h",
  і: "i",
  ї: "i",
  ј: "j",
  к: "k",
  ӏ: "l",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  ԛ: "q",
  ѕ: "s",
  с: "c",
  т: "t",
  у: "y",
  ү: "y",
  х: "x",
  ԁ: "d",
  ԝ: "w",
  ѡ: "w",
  г: "r",
  п: "n",
  // Cyrillic, capital letters.
  А: "A",
  В: "B",
  Е: "E",
  Ѐ: "E",
  Ё: "E",
  Һ: "H",
  І: "I",
  Ї: "I",
  Ӏ: "I",
  Ј: "J",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  Ԛ: "Q",
  Ѕ: "S",
  С: "C",
  Т: "T",
  У: "Y",
  Ү: "Y",
  Х: "X",
  Ԝ: "W",
  // Greek, small letters.
  α: "a",
  β: "b",
  ε: "e",
  η: "n",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  ς: "s",
  τ: "t",
  υ: "u",
  χ: "x",
  ω: "w",
  γ: "y",
  // Greek, capital letters.
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
  // Latin small capitals and the dotless i.
  ᴀ: "a",
  ʙ: "b",
  ᴄ: "c",
  ᴅ: "d",
  ᴇ: "e",
  ɢ: "g",
  ʜ: "h",
  ɪ: "i",
  ᴊ: "j",
  ᴋ: "k",
  ʟ: "l",
  ᴍ: "m",
  ɴ: "n",
  ᴏ: "o",
  ᴘ: "p",
  ʀ: "r",
  ꜱ: "s",
  ᴛ: "t",
  ᴜ: "u",
  ᴠ: "v",
  ᴡ: "w",
  ʏ: "y",
  ᴢ: "z",
  ı: "i",
};
const lookalikePattern = new RegExp(
  `[${Object.keys(lookalikeLetters).join("")}]`,
  "gu",
);
/**
 * Marks that people type for the apostrophe inside a word: an acute accent,
 * a backtick, a modifier letter apostrophe, a prime. "doesn´t" is "doesn't".
 * NFKC turns the acute accent into a space and a combining mark, so this
 * runs before it.
 */
const apostropheMarks = /(?<=\p{L})[`´ʹʻʼʽˈ′‵‛＇](?=\p{L})/gu;

/**
 * The message with lookalike letters of other scripts read as Latin
 * letters, accents taken off, and every apostrophe mark read as an
 * apostrophe. For the readers of stop, hold and negation words only: a
 * reading of it never counts for more than the reading of the words as they
 * are (see `readWords`).
 */
export function latinLookalikes(text: string): string {
  return text
    .replace(apostropheMarks, "'")
    .normalize("NFKD")
    .replace(/\p{Mn}/gu, "")
    .replace(lookalikePattern, (letter) => lookalikeLetters[letter] ?? letter)
    .normalize("NFC");
}

/** A stop word anywhere in the message stops the task. */
const stopWord =
  /\b(?:stop+|stah+p+|cancel|abort|halt)\b|\b(?:quit|kill)\s+it\b/;

/**
 * Any time or date: a delay ("in an hour", "in 5min", "in 2h"), a day
 * ("tomorrow", "tonight", "on Monday", "next week"), a clock time ("at 5",
 * "5pm", "17:30") or a date ("Dec 5", "12/25/2026"). Words with a time in
 * them wait for that time: they hold.
 */
const timeUnit =
  "(?:seconds?|secs?|minutes?|mins?|moments?|hours?|hrs?|days?|weeks?|wks?|months?|years?|yrs?|bit|while|few)";
const monthName =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const dayName =
  "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?";
const timePhrase = [
  String.raw`\bin\s+(?:\d+(?:[.,]\d+)?|[a-z]+(?:\s+[a-z]+)?)\s*${timeUnit}\b`,
  String.raw`\b(?:\d+(?:[.,]\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|few|several|couple(?:\s+of)?|half\s+an?)\s*-?\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\b`,
  String.raw`\b\d+(?:ms|s|m|h|hr|d)\b`,
  String.raw`\b(?:today|tonight|tonite|tomorrow|tmrw|yesterday|soon|eventually|someday|sometime|afterwards?|overnight|weekend|noon|midnight|morning|afternoon|evening)\b`,
  String.raw`\b${dayName}\b`,
  String.raw`\b(?:next|this|every|each|coming)\s+(?:second|minute|hour|day|night|week|weekend|month|year|morning|afternoon|evening|time|${dayName})\b`,
  String.raw`\b(?:hourly|daily|nightly|weekly|monthly|yearly)\b`,
  String.raw`\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)(?![a-z])`,
  String.raw`\b\d{1,2}:\d{2}\b`,
  String.raw`\bat\s+\d{1,2}(?::\d{2})?(?=$|[\s,.;!?])`,
  String.raw`\bo'?clock\b`,
  String.raw`\b${monthName}\.?\s+\d{1,2}(?:st|nd|rd|th)?\b`,
  String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${monthName}\b`,
  String.raw`\b\d{1,2}\/\d{1,2}\/\d{2,4}\b`,
  String.raw`\b\d{4}-\d{2}-\d{2}\b`,
].join("|");

/** Fillers that may precede a standalone continue phrase. */
const continueFiller =
  "(?:ok|okay|yes|yeah|yep|sure|alright|all right|right|please|pls|plz|bro|bruh|dude|yo|now|then|so|and|well|just|uh+|um+|hey)";
const continueMessage = new RegExp(
  `^(?:${continueFiller}[,\\s]+)*(?:continue|go on|go ahead|resume|carry on|keep going|proceed)(?:[,\\s]+(?:please|pls|plz|now|bro))?$`,
);

/** Anything that defers, negates, conditions, doubts, refuses or takes over anywhere in the message. */
const deferOrDoubt = new RegExp(
  String.raw`\b(?:not|no|never|wait|waiting|hold|holding|pause|paused|pausing|later|when|after|once|until|before|if|unless|maybe|yet|i'm|i\s+am|i'll|i\s+will|i(?:'ve)?\s+got|let\s+me|dont|doesnt|didnt|wont|cant|cannot|wouldnt|shouldnt|couldnt|hang\s+on|give\s+me|one\s+sec(?:ond)?|a\s+sec(?:ond)?|a\s+couple|nah|nope|nevermind|never\s+mind|nvm|forget|already|on\s+my\s+cue|wrong|broken|mess)\b|n't\b|\bin\s+(?:\d+|[a-z]+(?:\s+[a-z]+)?)\s+(?:seconds?|secs?|minutes?|mins?|moments?|bit|few)\b|${timePhrase}`,
);

/** Hold/delay/doubt/refusal cues that disqualify even an earlier observation report. */
const hardHoldCue = new RegExp(
  String.raw`\b(?:wait|waiting|hold|holding|pause|paused|pausing|later|when|after|once|until|before|if|unless|maybe|i'm|i\s+am|i'll|i\s+will|i(?:'ve)?\s+got|let\s+me|hang\s+on|give\s+me|one\s+sec(?:ond)?|a\s+sec(?:ond)?|a\s+couple|nah|nope|nevermind|never\s+mind|nvm|forget|already|on\s+my\s+cue|wrong|broken|mess|never|no|why|how|what|whether|should|would|could|but|so|because)\b|\bin\s+(?:\d+|[a-z]+(?:\s+[a-z]+)?)\s+(?:seconds?|secs?|minutes?|mins?|moments?|bit|few)\b|${timePhrase}`,
);

/** Narrow earlier-sentence exception: only reports what the person sees or does not see. */
const observationReportShapes = [
  /^i\s+(?:(?:do\s+not|don't|dont|cannot|can\s+not|can't|cant|did\s+not|didn't|didnt)\s+)?(?:still\s+)?see(?:\s+[^,;!?]{1,60})?$/,
  /^(?:it(?:'s|\s+(?:is|was|isn't|isnt|wasn't|wasnt))|the\s+page(?:'s|\s+(?:is|was|isn't|isnt|wasn't|wasnt)))\s+(?:still\s+)?(?:not\s+)?(?:still\s+)?(?:open(?:ed|ing)?|load(?:ed|ing)?|happen(?:ed|ing)?|show(?:n|ing)?|work(?:ed|ing)?|blank)(?:\s+(?:yet|up|here|there|properly))?$/,
  /^(?:it|the\s+page)\s+(?:(?:did\s+not|didn't|didnt|does\s+not|doesn't|doesnt|will\s+not|won't|wont|cannot|can\s+not|can't|cant|has\s+not|hasn't|hasnt)\s+)?(?:still\s+)?(?:open(?:ed|s)?|load(?:ed|s)?|happen(?:ed|s)?|show(?:ed|n|s)?|work(?:ed|s)?)(?:\s+(?:up|yet|here|there|properly))?$/,
  /^nothing\s+(?:(?:is|was|has|did|does|will)\s+)?(?:still\s+)?(?:open(?:ed|ing|s)?|load(?:ed|ing|s)?|happen(?:ed|ing|s)?|show(?:ed|ing|n|s)?|work(?:ed|ing|s)?)(?:\s+(?:up|yet|here|there))?$/,
];

/** Leading fillers and optional polite leads before a screen verb. */
const orderFiller =
  "(?:ok|okay|bro|bruh|dude|yo|yeah|yep|alright|all right|so|and|then|now|just|please|pls|plz|uh+|um+|well|hey|actually)";
const politeLead = "(?:can you|could you|would you|will you|can u|pls)";
const leadingPrefix = new RegExp(
  `^(?:(?:${politeLead}|${orderFiller})[,\\s]+)+`,
);
const hasPoliteLeadPattern = new RegExp(`\\b(?:${politeLead})\\b`);

const questionDisallowed = /\b(?:or|should\s+i|yet|is\s+it|do\s+i)\b/;
const questionBehaviorAdverb =
  /\b(?:automatically|normally|usually|typically|generally|always|ever|yourself|by\s+yourself|on\s+your\s+own)\b/;
const clauseSeparator = /,|;|--|\s+-\s+|[\u2013\u2014]/;
const postSeparatorFiller =
  /^(?:please|pls|plz|thanks|thank you|thx|bro|bruh|dude|yo|now|right now|then)(?:[,\s]+(?:please|pls|plz|thanks|thank you|thx|bro|bruh|dude|yo|now|right now|then))*$/;
const actionJoiner = /\s+(?:and\s+then|and|then)\s+/g;

const screenVerb =
  /^(search for|go to|go back|switch to|open|click|press|hit|tap|type|enter|select|choose|pick|scroll|drag|use|try|close)\b(?:\s+|$)/;

const tryGerundToVerb: Record<string, string> = {
  opening: "open",
  clicking: "click",
  pressing: "press",
  hitting: "hit",
  tapping: "tap",
  closing: "close",
  selecting: "select",
  scrolling: "scroll",
  using: "use",
};

const trailingVocative =
  /(?:\s+(?:bro|bruh|dude|yo|please|pls|plz|thanks|thank you|instead|right now|now|again|for me|one more time))+$/i;

const screenNounSource =
  "(?:(?:address|search|menu|tab|tool|side|status|scroll|title)\\s+bar|toolbar|sidebar|(?:search|text|input|dialog)\\s+box(?:es)?|checkbox(?:es)?|(?:tab|button|link|page|window|app|menu|field|url|site|website|result|item|row|option|popup|dialog|folder|note|email|message|list|icon|image|video|form|dropdown|browser|draft|section)s?)";

const screenNoun = new RegExp(`\\b${screenNounSource}\\b`);

const pronounObject =
  /^(?:it|that|this|them|there|here|one|this one|that one)$|^(?:it|that|this|them)\s+(?:in|on|with|to|into|from|at|for)\s+/;

/** Base and inflected verbs that ask for work on code or content rather than a screen action. */
const codeWorkVerbStem =
  "(?:fix(?:ed|ing|es)?|add(?:ed|ing|s)?|writ(?:e|es|ing)|wrote|written|chang(?:e|ed|es|ing)|implement(?:ed|ing|s)?|refactor(?:ed|ing|s)?|build(?:ing|s)?|built|creat(?:e|ed|es|ing)|bump(?:ed|ing|s)?|push(?:ed|es|ing)?|commit(?:ted|ting|s)?|merg(?:e|ed|es|ing)|deploy(?:ed|ing|s)?|install(?:ed|ing|s)?|migrat(?:e|ed|es|ing)|renam(?:e|ed|es|ing)|delet(?:e|ed|es|ing)|remov(?:e|ed|es|ing)|updat(?:e|ed|es|ing)|edit(?:ed|ing|s)?|debug(?:ged|ging|s)?|patch(?:ed|es|ing)?|rewrit(?:e|es|ing)|rewrote|rewritten|replac(?:e|ed|es|ing)|restyl(?:e|ed|es|ing)|revert(?:ed|ing|s)?|rebas(?:e|ed|es|ing)|upgrad(?:e|ed|es|ing)|configur(?:e|ed|es|ing)|ship(?:ped|ping|s)?)";

const codeWorkVerbStart = new RegExp(`^${codeWorkVerbStem}\\b`);

const codeWorkInfinitive = new RegExp(
  `(?<!\\b(?:go|switch|back|scroll|up|down))\\s+to\\s+${codeWorkVerbStem}\\b`,
);

const codeClauseLead = new RegExp(
  `^(?:(?:${politeLead}|${orderFiller}|i|we|you|let's|lets|i'm|i\\s+am|i'll|i\\s+will|we're|we\\s+are|start|try(?:\\s+to)?|begin|keep|finish|continue|need\\s+to|want\\s+to|going\\s+to|gonna|also|to)[,\\s]+)+`,
);

const codeClauseSplit = /[,;]|\s+(?:and\s+then|and|then)\s+/;

const runCommandPattern =
  /\brun(?:ning)?\s+(?:npm|npx|yarn|pnpm|bun|git|make|pip|pip3|python|python3|node|cargo|go|pytest|vitest|jest|bash|sh|zsh|rm|docker|kubectl|terraform|swift|brew|curl)\b/;

const reviewDiffPattern =
  /\breview(?:ed|ing|s)?\s+(?:the\s+)?(?:diff|pr|pull\s+request|code|changes)\b/;

const pullCodePattern =
  /\bpull(?:ed|ing|s)?\s+(?:from\s+(?:origin|upstream|main|master|remote|[a-z0-9._/-]+)|the\s+(?:branch|repo|repository|changes|latest))\b/;

/** Unambiguous code artifacts (outside URLs and quotes). */
const strongCodeArtifact =
  /\b(?:repos?|repositor(?:y|ies)|branch(?:es)?|commits?|pull\s+requests?|functions?|components?|class(?:es)?|modules?|codebases?|backends?|scripts?|configs?|issues?|bugs?|tickets?)\b/;

/**
 * Code nouns that can also appear in UI labels (checked only after stripping
 * UI labels). "In the project" and a TODO name the code of a project: "search
 * for TODO in the project" is coding work, "open the Project tab" a label.
 */
const softCodeArtifact = /\b(?:files?|tests?|code|projects?|todos?)\b/i;

/** A code, config, dotfile, or repo build file name (matched both quoted and unquoted, outside URLs). */
const codeFileName =
  /(?:^|[\s("'])(?:(?:[a-z0-9_.-]+\/)*[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|json|md|mdx|yml|yaml|toml|sql|swift|rs|go|rb|php|java|kt|kts|c|h|cpp|hpp|cs|vue|svelte|css|scss|less|html|xml|env|lock|ini|cfg|conf|proto|graphql|gql|sh|bash|zsh|tf|tfvars|plist)|\.(?:env(?:\.[a-z0-9_-]+)?|gitignore|gitattributes|npmrc|nvmrc|eslintrc(?:\.[a-z0-9_-]+)?|prettierrc(?:\.[a-z0-9_-]+)?|editorconfig|dockerignore|bashrc|zshrc|profile)|(?:makefile|dockerfile|vagrantfile|procfile|gemfile|rakefile|justfile|jenkinsfile|brewfile))(?=$|[\s,.;:!?)'"])/;

const ordinalObject = new RegExp(
  `\\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|next|previous|prev|other|top|bottom|1st|2nd|3rd|[4-9]th)\\s+(?:one|${screenNounSource})\\b|^(?:the\\s+)?(?:first|second|third|fourth|fifth|last|next|previous|other)$`,
);

const keyNameSource =
  "(?:enter|return|escape|esc|tab|space|spacebar|delete|backspace|up|down|left|right|page up|page down|home|end|(?:up|down|left|right)\\s+arrow|arrow\\s+(?:up|down|left|right)|(?:cmd|command|ctrl|control|alt|option|shift)(?:\\s*\\+\\s*[a-z0-9]+)+)";
const keyObject = new RegExp(
  `^(?:the\\s+)?${keyNameSource}(?:\\s+key)?(?:\\s+(?:once|twice|\\d+\\s+times))?$`,
);
const explicitKey = new RegExp(`\\b${keyNameSource}\\s+key\\b`);
const keyVerbs = new Set(["press", "hit", "tap", "use", "try"]);

const codeEntryObject =
  /^(?:the\s+|my\s+)?(?:verification|confirmation|security|access|promo|coupon|invite|referral|zip|postal)\s+code$/;

const webAddress =
  /(?:https?:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?\b|localhost(?::\d{1,5})?\b|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:com|org|net|edu|gov|io|co|ai|app|dev|me|us|uk|ca|de|fr|jp|au|in|gg|tv|so|xyz|info|biz|page|site|cloud|tech|news|blog|shop|store|pro|ly|to|cc|fm|nl|se|ch|es|eu|br|kr|cn|tw|hk|sg|nz|mx|pl)(?::\d{1,5})?\b)/;

const webAddressWithPath = new RegExp(
  `${webAddress.source}(?:/(?:[^\\s,.;:!?)'"]|\\.(?=[^\\s,.;:!?)'"]))*)?`,
  "gi",
);

const quotedLabel = /"[^"\n]{1,120}"|(?:^|\s)'[^'\n]{1,120}'(?=$|\s|[,.;!])/;

const capitalizedToken =
  /(?:[A-Z][A-Za-z0-9]*[a-z]|[a-z][A-Z][a-z])[A-Za-z0-9]*/;
const leadingCapitalizedTarget = new RegExp(
  `^(?:(?:the|this|that|a|an)\\s+)?(?:[A-Z]{2,}\\s+)?(${capitalizedToken.source})\\b`,
);
const capitalizedNameVerbs = new Set([
  "open",
  "switch to",
  "close",
  "click",
  "select",
]);
const nonNameCapitalized = new Set([
  "ok",
  "okay",
  "bro",
  "bruh",
  "dude",
  "yo",
  "yeah",
  "yep",
  "yes",
  "sure",
  "alright",
  "please",
  "pls",
  "now",
  "then",
  "so",
  "and",
  "just",
  "instead",
  "again",
  "mom",
  "dad",
  "mum",
]);

const personAfterToOrFor = /\b(?:to|for)\s+[A-Z][a-z]+\b/;
const possessivePersonName = /\b[A-Z][a-z]+'s\b/;

const knownAppSource =
  "(?:browser|google chrome|chrome|safari|firefox|brave browser|brave|microsoft edge|edge|chromium|arc|finder|notes|mail|messages|terminal|iterm|textedit|photos|calendar|calculator|preview|system settings|settings)";
const knownAppExact = new RegExp(`^(?:the\\s+)?${knownAppSource}$`);
const knownAppVerbs = new Set(["open", "close", "switch to", "use", "go to"]);
const inBrowserOrAppLower = new RegExp(
  `\\b(?:in|on|with)\\s+(?:the\\s+)?${knownAppSource}\\b`,
);
const inCapitalizedApp =
  /\b(?:in|on|with)\s+(?:[A-Z][A-Za-z0-9]*[a-z]|[a-z][A-Z][a-z])[A-Za-z0-9]*\b/;

const uiButtonVerbs = new Set(["click", "tap", "press", "hit"]);
const uiButtonLabel =
  /^(?:the\s+)?(?:save|login|log in|sign in|next|back|done|submit|search|refresh|reload|apply|retry|skip|dismiss|close|open|start|play|home|settings|details|more)$/;

const singleWordVerbs = new Set(["open", "close", "switch to"]);
const singleWordExclude = new Set([
  "up",
  "down",
  "out",
  "off",
  "on",
  "in",
  "away",
  "over",
  "back",
  "around",
  "through",
  "faster",
  "slower",
  "again",
  "more",
  "less",
  "something",
  "anything",
  "nothing",
  "everything",
  "someone",
  "anyone",
  "everyone",
  "now",
  "soon",
  "door",
  "window",
  "box",
  "bag",
  "fridge",
  "gate",
  "car",
  "bed",
  "book",
  "bottle",
  "jar",
  "can",
  "cup",
  "drawer",
  "closet",
  "oven",
  "trunk",
  "package",
  "gift",
  "present",
  "mom",
  "dad",
  "mum",
  "mama",
  "papa",
  "mother",
  "father",
  "brother",
  "sister",
  "wife",
  "husband",
  "son",
  "daughter",
  "boss",
  "friend",
]);

function maskQuoted(text: string): string {
  return text
    .replace(/"[^"\n]{1,120}"/g, (match) => " ".repeat(match.length))
    .replace(/(?:^|\s)'[^'\n]{1,120}'(?=$|\s|[,.;!?])/g, (match) =>
      " ".repeat(match.length),
    );
}

function isObservationReport(sentenceLower: string): boolean {
  if (/\?/.test(sentenceLower)) return false;
  const body = sentenceLower.replace(/[.!]+$/, "").trim();
  if (!body || clauseSeparator.test(body)) return false;
  if (hardHoldCue.test(body)) return false;
  return observationReportShapes.some((shape) => shape.test(body));
}

function splitSentences(cased: string): string[] {
  // Split only at sentence-ending punctuation followed by whitespace so dots
  // inside web addresses (such as app.example.com) stay intact.
  const raw = cased
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const parts: string[] = [];
  for (const part of raw) {
    const comma = part.indexOf(", ");
    if (comma > 0) {
      const head = part.slice(0, comma).trim();
      const tail = part.slice(comma + 2).trim();
      if (tail && isObservationReport(head.toLowerCase())) {
        parts.push(head, tail);
        continue;
      }
    }
    parts.push(part);
  }
  return parts.length ? parts : [cased];
}

function hasLeadingCapitalizedName(objCased: string): boolean {
  const match = leadingCapitalizedTarget.exec(objCased);
  if (!match) return false;
  return !nonNameCapitalized.has(match[1]!.toLowerCase());
}

function stripUrls(text: string): string {
  return text.replace(webAddressWithPath, " ");
}

function hasCodeWorkInSentence(sentenceCased: string): boolean {
  const noUrlCased = stripUrls(sentenceCased)
    .replace(/[.!?]+$/, "")
    .trim();
  if (!noUrlCased) return false;
  const noUrlLower = noUrlCased.toLowerCase();
  // Code, dotfile, and repo file names hold even inside quotes.
  if (codeFileName.test(noUrlLower)) return true;

  const unquotedCased = maskQuoted(noUrlCased);
  const unquotedLower = unquotedCased.toLowerCase();
  if (strongCodeArtifact.test(unquotedLower)) return true;
  if (
    runCommandPattern.test(unquotedLower) ||
    reviewDiffPattern.test(unquotedLower) ||
    pullCodePattern.test(unquotedLower)
  )
    return true;

  // Strip UI labels, menus, tabs, buttons, capitalized labels, typed text and
  // search queries before checking soft code nouns (file/files, test/tests, code).
  const withoutUiLabels = unquotedCased
    .replace(
      /\b(?:the|this|that|a|an)\s+(?:[A-Za-z0-9_-]+\s+){1,3}(?:button|tab|menu|link|section|dialog|popup|window|bar|box|field|page|icon|item|option|dropdown)s?\b/gi,
      " ",
    )
    .replace(
      /\b(?:verification|confirmation|security|access|promo|coupon|invite|referral|zip|postal)\s+codes?\b/gi,
      " ",
    )
    .replace(/\b[A-Z]{2,}\s+[A-Z][A-Za-z0-9]*\b/g, " ")
    .replace(
      /\b(?:click|select|press|hit|tap)\s+(?:the\s+)?[A-Z][A-Za-z0-9]*(?:\s+(?!(?:and|then|or|to)\b)[A-Za-z0-9]+){0,2}\b/g,
      " ",
    )
    .replace(/\btype\s+[^,;!?]+?(?=\s+(?:in|into|on)\b|$)/gi, " ")
    // A search query is a label, but not its scope: "search for TODO in
    // the project" keeps "in the project".
    .replace(
      /\bsearch\s+for\s+[^,;!?]+?(?=\s+in\s+(?:the\s+|this\s+|my\s+|our\s+)?(?:projects?|code(?:base)?|repos?|repository|files?)\b|$)/gi,
      " ",
    );
  if (softCodeArtifact.test(withoutUiLabels)) return true;

  // Check for a coding-work verb as the main verb of any clause (or infinitive).
  if (codeWorkInfinitive.test(unquotedLower)) return true;
  for (const rawClause of unquotedLower.split(codeClauseSplit)) {
    const clause = rawClause.replace(codeClauseLead, "").trim();
    if (clause && codeWorkVerbStart.test(clause)) return true;
  }
  return false;
}

function hasValidObject(
  verb: string,
  objCased: string,
  objLower: string,
): boolean {
  if (!objLower) return false;
  if (pronounObject.test(objLower)) return true;
  if (ordinalObject.test(objLower)) return true;
  if (keyVerbs.has(verb) && keyObject.test(objLower)) return true;
  if (explicitKey.test(objLower)) return true;
  if ((verb === "enter" || verb === "type") && codeEntryObject.test(objLower))
    return true;
  if (screenNoun.test(objLower)) return true;
  if (webAddress.test(objLower)) return true;
  if (verb !== "type" && quotedLabel.test(objCased)) return true;
  if (knownAppVerbs.has(verb) && knownAppExact.test(objLower)) return true;
  if (uiButtonVerbs.has(verb) && uiButtonLabel.test(objLower)) return true;
  if (capitalizedNameVerbs.has(verb) && hasLeadingCapitalizedName(objCased))
    return true;
  if (inBrowserOrAppLower.test(objLower) || inCapitalizedApp.test(objCased))
    return true;
  if (
    verb === "search for" &&
    /^[a-z0-9"'._\s-]{2,80}$/.test(objLower) &&
    !singleWordExclude.has(objLower)
  )
    return true;
  if (
    singleWordVerbs.has(verb) &&
    /^[a-z0-9][a-z0-9._-]*$/.test(objLower) &&
    objLower.length >= 2 &&
    !singleWordExclude.has(objLower)
  )
    return true;
  return false;
}

function splitActionClauses(
  restCased: string,
  restLower: string,
): Array<{ cased: string; lower: string }> {
  const masked = maskQuoted(restLower);
  const clauses: Array<{ cased: string; lower: string }> = [];
  let start = 0;
  for (const match of masked.matchAll(actionJoiner)) {
    const index = match.index!;
    clauses.push({
      cased: restCased.slice(start, index).trim(),
      lower: restLower.slice(start, index).trim(),
    });
    start = index + match[0].length;
  }
  clauses.push({
    cased: restCased.slice(start).trim(),
    lower: restLower.slice(start).trim(),
  });
  return clauses;
}

function isSingleOrderClause(
  clauseCased: string,
  clauseLower: string,
  allowLeadingJust: boolean,
): boolean {
  let cased = clauseCased;
  let lower = clauseLower;
  if (allowLeadingJust) {
    const just = /^just\s+/.exec(lower);
    if (just) {
      cased = cased.slice(just[0].length).trim();
      lower = lower.slice(just[0].length).trim();
    }
  }
  const verbMatch = screenVerb.exec(lower);
  if (!verbMatch) return false;

  let verb = verbMatch[1]!;
  let rawCased = cased.slice(verbMatch[0].length).trim();
  let rawLower = lower.slice(verbMatch[0].length).trim();

  if (verb === "try") {
    const gerund =
      /^(opening|clicking|pressing|hitting|tapping|closing|selecting|scrolling|using)\s+/.exec(
        rawLower,
      );
    if (gerund) {
      verb = tryGerundToVerb[gerund[1]!]!;
      rawCased = rawCased.slice(gerund[0].length).trim();
      rawLower = rawLower.slice(gerund[0].length).trim();
    }
  }

  const tailMatch = trailingVocative.exec(rawLower);
  const objCased = tailMatch
    ? rawCased.slice(0, rawCased.length - tailMatch[0].length).trim()
    : rawCased;
  const objLower = tailMatch
    ? rawLower.slice(0, rawLower.length - tailMatch[0].length).trim()
    : rawLower;

  const maskedObjCased = maskQuoted(objCased);
  if (
    personAfterToOrFor.test(maskedObjCased) ||
    possessivePersonName.test(maskedObjCased)
  )
    return false;

  if (verb === "go back") {
    if (!objLower) return true;
    return hasValidObject(verb, objCased, objLower);
  }
  if (verb === "scroll") {
    const dir = /^(?:up|down)\b/.exec(objLower);
    if (!dir) return false;
    const afterDir = objLower.slice(dir[0].length).trim();
    if (!afterDir) return true;
    const afterCased = objCased.slice(dir[0].length).trim();
    return (
      hasValidObject(verb, afterCased, afterDir) ||
      /^(?:a little|more|further|slightly)$/.test(afterDir)
    );
  }
  return hasValidObject(verb, objCased, objLower);
}

function isOrderSentence(sentenceCased: string): boolean {
  const sentenceLower = sentenceCased.toLowerCase();
  const endsWithQuestion = /\?+$/.test(sentenceLower);
  const bodyCased = sentenceCased.replace(/[.!?]+$/, "").trim();
  const bodyLower = bodyCased.toLowerCase();
  if (!bodyLower || bodyLower.includes("?")) return false;
  if (deferOrDoubt.test(bodyLower)) return false;

  const prefixMatch = leadingPrefix.exec(bodyLower);
  const prefix = prefixMatch ? prefixMatch[0] : "";
  const polite = hasPoliteLeadPattern.test(prefix);
  if (endsWithQuestion && !polite) return false;

  let restCased = bodyCased.slice(prefix.length).trim();
  let restLower = bodyLower.slice(prefix.length).trim();
  if (!restLower) return false;

  const maskedRest = maskQuoted(restLower);
  if (questionDisallowed.test(maskedRest)) return false;
  if (
    (polite || endsWithQuestion) &&
    (questionBehaviorAdverb.test(maskedRest) ||
      (endsWithQuestion && /\b(?!slightly\b)[a-z]{4,}ly\b/.test(maskedRest)))
  )
    return false;

  // No remark after the order: anything after an unquoted comma, dash or
  // semicolon must be a trailing filler only.
  const sep = clauseSeparator.exec(maskedRest);
  if (sep) {
    const afterSep = restLower.slice(sep.index + sep[0].length).trim();
    if (!afterSep || !postSeparatorFiller.test(afterSep)) return false;
    restCased = restCased.slice(0, sep.index).trim();
    restLower = restLower.slice(0, sep.index).trim();
    if (!restLower) return false;
  }

  const clauses = splitActionClauses(restCased, restLower);
  if (clauses.length === 0 || clauses.length > 2) return false;
  return clauses.every((clause, index) =>
    isSingleOrderClause(clause.cased, clause.lower, index > 0),
  );
}

/**
 * The strict reader of the words exactly as they are written, with no help
 * for casual forms or typos:
 * - "stop": any stop word anywhere in the message
 * - "continue": a standalone continue phrase (after optional fillers), no "?"
 * - "order": the last sentence matches a strict screen-order shape and no
 *   earlier sentence carries a hold, wait, delay, doubt, refusal, self-takeover
 *   or question cue (except a narrow observation report of what is or is not
 *   seen on the screen)
 * - "hold": everything else
 *
 * `readWords` never reads a message less safely than this one does.
 */
export function readWordsAsWritten(text: string): WordKind {
  const { cased, lower } = normalize(text);
  if (!lower) return "hold";
  if (stopWord.test(lower)) return "stop";
  if (!lower.includes("?")) {
    const plain = lower.replace(/^[,.:;!]+|[.!,:;]+$/g, "").trim();
    if (plain && continueMessage.test(plain)) return "continue";
  }
  const sentences = splitSentences(cased);
  if (sentences.some((part) => hasCodeWorkInSentence(part))) return "hold";
  const earlier = sentences.slice(0, -1);
  for (const part of earlier) {
    const partLower = part.toLowerCase();
    if (partLower.includes("?")) return "hold";
    if (isObservationReport(partLower)) continue;
    if (deferOrDoubt.test(partLower)) return "hold";
  }
  if (isOrderSentence(sentences.at(-1)!)) return "order";
  return "hold";
}

// Casual words. People type and talk to ClawdTime casually: typos, slang,
// no punctuation, repeated letters, emoji. The reader below rewrites such a
// message into plain words and reads it again with the strict rules above.
// It is one way only: it can make a message stop or hold more easily, and it
// can read a clear screen order with a typo or a casual form as that same
// order. It never turns a stop into anything else, and it never removes a
// word or a mark that the rules read (a negation, a hold cue, a question
// mark). Quoted labels, web addresses and key combinations stay as written.
// The rewritten words are for this reading only: what the person wrote is
// what is kept, sent to the planner and checked for secrets.

/** Emoji that stop: a stop sign and the stop button. */
const stopEmoji = /[\u{1F6D1}\u23F9]/gu;
/** Emoji that ask: they count as a question mark. */
const questionEmoji = /[\u2753\u2754\u203D]/gu;
/** Emoji of doubt, refusal, delay or a raised hand: the message holds. */
const holdEmoji =
  /[\u{1F914}\u{1F615}\u{1F928}\u{1F62C}\u{1F61F}\u{1F644}\u{1F612}\u{1F624}\u{1F621}\u{1F620}\u{1F926}\u{1F937}\u{1F633}\u{1F631}\u{1FAE4}\u{1F610}\u{1F611}\u{1F645}\u{1F44E}\u274C\u2716\u274E\u{1F6AB}\u26D4\u23F3\u231B\u23F8\u270B\u{1F91A}\u{1F590}\u{1F62E}\u{1F635}\u{1FAE3}\u{1F974}\u{1F629}\u{1F62B}\u{1F61E}\u{1F622}\u{1F62D}\u{1F92C}]/u;
/** Emoji that only decorate a message: they are dropped. Any other emoji stays as written. */
const decorationEmoji =
  /[\u{1F64F}\u{1F44D}\u{1F44C}\u{1F642}\u{1F60A}\u{1F600}\u{1F601}\u{1F603}\u{1F604}\u2705\u2714\u{1F525}\u{1F4AF}\u2728\u{1F680}\u{1F449}\u{1F448}\u{1F447}\u{1F446}\u261D\u2764\u{1F499}\u{1F49A}\u{1F9E1}\u{1F49B}\u{1F49C}\u{1F64C}\u{1F44F}\u{1F4AA}\u{1F60E}\u{1F609}\u{1FAE1}\u2640\u2642\u{1F3FB}-\u{1F3FF}]/gu;

/** ClawdTime named at the start or the end, as typed or as speech is written down. */
const addressName =
  "@?(?:clawd\\s*time|clawed\\s+time|claw\\s+time|cloud\\s+time|clawd)";
const leadingAddress = new RegExp(
  `^(?:(?:hey|hi|hello|yo|ok|okay)[,!\\s]+)?${addressName}(?:[,:!.]+\\s*|\\s+|$)`,
  "i",
);
const trailingAddress = new RegExp(`[,\\s]+${addressName}\\s*([.!?]*)$`, "i");

/** One casual word, read as these plain words. */
const casualWord: Record<string, string> = {
  u: "you",
  ur: "your",
  plis: "pls",
  pliz: "pls",
  plez: "pls",
  pleez: "pls",
  pleaz: "pls",
  plse: "pls",
  plss: "pls",
  plzz: "plz",
  thx: "thanks",
  thnx: "thanks",
  thanx: "thanks",
  thnks: "thanks",
  thks: "thanks",
  tnx: "thanks",
  k: "ok",
  kk: "ok",
  okk: "ok",
  okie: "ok",
  oki: "ok",
  okey: "ok",
  aight: "alright",
  ight: "alright",
  alr: "alright",
  yea: "yeah",
  yeh: "yeah",
  yah: "yeah",
  yup: "yep",
  rn: "right now",
  asap: "now",
  btn: "button",
  btns: "buttons",
  pg: "page",
  msg: "message",
  msgs: "messages",
  dwn: "down",
  opn: "open",
  srch: "search",
  goto: "go to",
  teh: "the",
  hte: "the",
  tht: "that",
  // Hold cues, without the apostrophe or with a typo. They only hold more.
  im: "i'm",
  ill: "i'll",
  ive: "i've",
  lemme: "let me",
  gimme: "give me",
  imma: "i'm going to",
  ima: "i'm going to",
  wanna: "want to",
  gonna: "going to",
  gotta: "got to",
  dnt: "don't",
  dnot: "don't",
  donot: "do not",
  isnt: "isn't",
  arent: "aren't",
  wasnt: "wasn't",
  werent: "weren't",
  havent: "haven't",
  hasnt: "hasn't",
  hadnt: "hadn't",
  aint: "ain't",
  wiat: "wait",
  wair: "wait",
  waut: "wait",
  wsit: "wait",
  wate: "wait",
  w8: "wait",
  hld: "hold",
  hlod: "hold",
  hodl: "hold",
  hokd: "hold",
  hol: "hold",
  holdon: "hold on",
  holdup: "hold up",
  hangon: "hang on",
  pasue: "pause",
  puase: "pause",
  paus: "pause",
  nvmd: "nevermind",
  nvrm: "nevermind",
  nevrmind: "nevermind",
  nm: "nevermind",
  jk: "nevermind",
  idk: "i don't know",
  idek: "i don't know",
  dunno: "i don't know",
  unsure: "not sure",
  brb: "wait",
  afk: "wait",
  w8t: "wait",
  wt: "wait",
  nt: "not",
  wen: "when",
  whn: "when",
  b4: "before",
  bfr: "before",
  bfor: "before",
  l8r: "later",
  l8: "later",
  ltr: "later",
  til: "until",
  till: "until",
  nvr: "never",
  tmr: "tomorrow",
  tmrw: "tomorrow",
  tmrrw: "tomorrow",
  "2moro": "tomorrow",
  "2morrow": "tomorrow",
  "2day": "today",
  "2nite": "tonight",
  tonite: "tonight",
  // Stop words, swapped or misspelled. "Step", "shop", "atop", "stow" and
  // "top" are words of their own and are not here.
  stpo: "stop",
  sotp: "stop",
  tsop: "stop",
  sstop: "stop",
  stopit: "stop it",
  cancle: "cancel",
  cancell: "cancel",
  cansel: "cancel",
  cancl: "cancel",
  cacnel: "cancel",
  cnacel: "cancel",
  canecl: "cancel",
  acncel: "cancel",
  abrot: "abort",
  aboart: "abort",
  abotr: "abort",
  aobrt: "abort",
  baort: "abort",
  abourt: "abort",
  hlat: "halt",
  ahlt: "halt",
  hatl: "halt",
};

const stopWords = new Set(["stop", "cancel", "abort", "halt", "stahp"]);
/** A word that the strict reader stops on by itself ("stop", "stopp", "stahp"). */
const stopForm = /^(?:stop+|stah+p+|cancel|abort|halt)$/;

/** Single words that the rules read as a hold cue. A doubled letter does not hide one ("noo", "waitt"). */
const holdCueWords = new Set([
  "not",
  "no",
  "never",
  "wait",
  "hold",
  "pause",
  "later",
  "when",
  "after",
  "once",
  "until",
  "before",
  "if",
  "unless",
  "maybe",
  "yet",
  "nah",
  "nope",
  "nevermind",
  "nvm",
  "forget",
  "already",
  "wrong",
  "broken",
  "mess",
  "today",
  "tonight",
  "tomorrow",
  "yesterday",
  "soon",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

/**
 * Words of the rules that hold, with no apostrophe: a typo of one of these
 * holds as well ("waitng", "doesnot", "cannnot").
 */
const holdTypoTargets = [
  ...holdCueWords,
  ..."waiting holding paused pausing cannot doesnt didnt wouldnt shouldnt couldnt".split(
    " ",
  ),
];

/** The screen verbs, screen nouns, key names and known app and browser names that a typo may stand for. */
const typoVocabulary = [
  "open",
  "click",
  "press",
  "type",
  "enter",
  "select",
  "choose",
  "pick",
  "scroll",
  "drag",
  "close",
  "switch",
  "search",
  "button",
  "buttons",
  "link",
  "links",
  "page",
  "pages",
  "window",
  "windows",
  "tabs",
  "menu",
  "menus",
  "field",
  "fields",
  "site",
  "sites",
  "website",
  "websites",
  "result",
  "results",
  "item",
  "items",
  "option",
  "options",
  "popup",
  "popups",
  "dialog",
  "dialogs",
  "folder",
  "folders",
  "note",
  "notes",
  "email",
  "emails",
  "message",
  "messages",
  "list",
  "lists",
  "icon",
  "icons",
  "image",
  "images",
  "video",
  "videos",
  "form",
  "forms",
  "dropdown",
  "dropdowns",
  "browser",
  "browsers",
  "draft",
  "drafts",
  "section",
  "sections",
  "toolbar",
  "sidebar",
  "checkbox",
  "address",
  "input",
  "return",
  "escape",
  "space",
  "spacebar",
  "delete",
  "backspace",
  "down",
  "chrome",
  "google",
  "safari",
  "firefox",
  "brave",
  "edge",
  "chromium",
  "microsoft",
  "finder",
  "mail",
  "terminal",
  "iterm",
  "textedit",
  "photos",
  "calendar",
  "calculator",
  "preview",
  "settings",
  "system",
];
const typoTargets = new Set(typoVocabulary);

/**
 * Words that the rules read for themselves (fillers, cues, ordinals, key
 * names, labels, code words, everyday objects). A typo is never read into
 * them or out of them.
 */
const ruleWords = new Set(
  (
    "ok okay yes yeah yep sure alright right please pls plz bro bruh dude yo now then so and well just " +
    "hey actually thanks thank instead again more less not no never wait waiting hold holding pause paused " +
    "pausing later when after once until before if unless maybe yet dont doesnt didnt wont cant cannot " +
    "wouldnt shouldnt couldnt hang give sec second seconds couple nah nope nevermind mind nvm forget already " +
    "cue wrong broken mess minute minutes moment moments few bit why how what whether should would could but " +
    "because first third fourth fifth last next previous prev other top bottom esc tab left up home end key " +
    "arrow cmd command ctrl control alt option shift save login log sign back done submit refresh reload " +
    "apply retry skip dismiss start play details it that this them there here one in on with to into from at " +
    "for the a an my your our his her their these those out off away over around through faster slower " +
    "something anything nothing everything someone anyone everyone soon door box bag fridge gate car bed book " +
    "bottle jar can cup drawer closet oven trunk package gift present mom dad mum mama papa mother father " +
    "brother sister wife husband son daughter boss friend file files test tests code project projects todo " +
    "todos repo repos branch commit function component class module codebase backend script config issue bug " +
    "ticket fix add write change build create push merge deploy install rename remove update edit debug patch " +
    "replace revert ship go use try hit tap stop cancel abort halt quit kill stahp see show load happen work " +
    "bar url app apps row rows pane panel engine history screen computer mac laptop desktop machine " +
    "device mouse keyboard cursor things stuff able possible know hour hours day days week weeks " +
    "month months year years noon midnight morning afternoon evening weekend eventually someday sometime " +
    "afterward afterwards overnight hourly daily nightly weekly monthly yearly clock while"
  ).split(" "),
);

/**
 * English words that one typo away look like a screen word but mean
 * something else. They stay as they are: "clock" is no "click", "chose" no
 * "choose", "filed" no "field", "lost" no "list". "Pen" and "lick" are too
 * short or too far from a screen word already, and are here all the same.
 */
const typoDenyList = new Set([
  "pen",
  "lick",
  "clock",
  "cluck",
  "chose",
  "puck",
  "pock",
  "prick",
  "drab",
  "cloze",
  "fork",
  "firm",
  "forum",
  "lost",
  "lust",
  "maul",
  "pave",
  "pate",
  "phage",
  "sire",
  "suite",
  "spite",
  "smite",
  "lino",
  "lunk",
  "tans",
  "widow",
  "filed",
  "potion",
  "folded",
  "browse",
  "browsed",
  "brace",
  "fonder",
  "funder",
  "finer",
  "spade",
  "deplete",
  "noted",
  "drown",
  "daft",
  "burton",
  "calculate",
  "settling",
  "settlings",
  "escapee",
]);

const keyboardRows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
/** The keys next to each letter on a common keyboard. */
const nextKeys = new Map<string, Set<string>>();
keyboardRows.forEach((row, r) => {
  [...row].forEach((letter, c) => {
    const near = new Set<string>();
    const add = (rr: number, cc: number) => {
      const key = keyboardRows[rr]?.[cc];
      if (key) near.add(key);
    };
    add(r, c - 1);
    add(r, c + 1);
    add(r - 1, c);
    add(r - 1, c + 1);
    add(r + 1, c - 1);
    add(r + 1, c);
    nextKeys.set(letter, near);
  });
});

/**
 * How many typos turn `target` into `typed`, or Infinity. A typo is one of:
 * two neighbouring letters swapped, a letter hit with a key next to it (not
 * the first letter), a letter left out (not the first), or one letter too
 * many (not the first; at the end only a repeated letter, so that "opens",
 * "typed" and "closer" stay as they are).
 */
export function typoCount(typed: string, target: string): number {
  const n = typed.length;
  const m = target.length;
  const row = () => new Array<number>(m + 1).fill(Infinity);
  const d: number[][] = Array.from({ length: n + 1 }, row);
  d[0]![0] = 0;
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue;
      let best = Infinity;
      if (i > 1 && (i < n || typed[i - 1] === typed[i - 2]))
        best = Math.min(best, d[i - 1]![j]! + 1);
      if (j > 1) best = Math.min(best, d[i]![j - 1]! + 1);
      if (i > 0 && j > 0) {
        const a = typed[i - 1]!;
        const b = target[j - 1]!;
        if (a === b) best = Math.min(best, d[i - 1]![j - 1]!);
        else if (i > 1 && j > 1 && nextKeys.get(b)?.has(a))
          best = Math.min(best, d[i - 1]![j - 1]! + 1);
      }
      if (
        i > 1 &&
        j > 1 &&
        typed[i - 1] === target[j - 2] &&
        typed[i - 2] === target[j - 1] &&
        typed[i - 1] !== typed[i - 2]
      )
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  return d[n]![m]!;
}

/**
 * Words that make the rules hold or stop: words of holding, doubt, refusal
 * or stopping, code words, everyday things and people. A word one edit away
 * from one of them is never read as a screen word: "click it nore" may be
 * "nope", "notr" may be "not", and "open the settings fiel" may be "file".
 */
const holdRivals = [
  ...holdCueWords,
  ...stopWords,
  ...singleWordExclude,
  ...(
    "waiting holding paused pausing dont doesnt didnt wont cant cannot wouldnt shouldnt couldnt isnt " +
    "hang give sec second seconds minute minutes moment moments couple why how what whether should " +
    "would could but because quit kill file files test tests code project projects todo todos repo " +
    "repos branch branches commit commits function functions component components class classes module " +
    "modules codebase backend script scripts config configs issue issues bug bugs ticket tickets readme " +
    "fix add write change build create push merge deploy install rename remove update edit debug patch " +
    "replace revert ship"
  ).split(" "),
].filter((word) => !typoTargets.has(word));

/** True when one insertion, deletion, change or swap of two neighbours turns `a` into `b`. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let start = 0;
  while (start < a.length && a[start] === b[start]) start++;
  if (a.length === b.length) {
    if (a.slice(start + 1) === b.slice(start + 1)) return true;
    return (
      a[start] === b[start + 1] &&
      a[start + 1] === b[start] &&
      a.slice(start + 2) === b.slice(start + 2)
    );
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(start + 1) === short.slice(start);
}

/** What `typoTarget` found for words seen before. The answer of a word never changes. */
const typoMemo = new Map<string, string | null>();

/**
 * The screen word that a typed word stands for, or null. Only words of 4
 * letters or more take one typo, and words of 8 or more (typed and meant)
 * take two. A word that the rules read, a word of the deny list, a word one
 * edit away from a word of holding or stopping, or a word with two equally
 * near screen words is not changed.
 */
export function typoTarget(word: string): string | null {
  const typed = word.toLowerCase();
  if (typoTargets.has(typed)) return typed;
  const known = typoMemo.get(typed);
  if (known !== undefined) return known;
  if (typoMemo.size >= 4096) typoMemo.clear();
  const found = findTypoTarget(typed);
  typoMemo.set(typed, found);
  return found;
}

function findTypoTarget(typed: string): string | null {
  if (typed.length < 4 || !/^[a-z]+$/.test(typed)) return null;
  if (ruleWords.has(typed) || typoDenyList.has(typed)) return null;
  if (holdRivals.some((rival) => rival === typed || oneEditApart(typed, rival)))
    return null;
  let best: string | null = null;
  let bestCount = Infinity;
  let tied = false;
  for (const target of typoVocabulary) {
    const limit = Math.min(typed.length, target.length) >= 8 ? 2 : 1;
    if (Math.abs(target.length - typed.length) > limit) continue;
    const count = typoCount(typed, target);
    if (count > limit) continue;
    if (count < bestCount) {
      best = target;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) tied = true;
  }
  return best !== null && !tied ? best : null;
}

/** A word that the reader knows as it is. A long "chooose" is "chose" before it is "choose". */
const knownWord = (word: string) =>
  stopWords.has(word) ||
  holdCueWords.has(word) ||
  ruleWords.has(word) ||
  typoDenyList.has(word) ||
  typoTargets.has(word) ||
  word in casualWord;

/**
 * English words that are one typo away from a stop word but are words of
 * their own: "hat" is no "halt", "half" no "halt", "stomp" no "stop". Words
 * that the reader knows ("top", "step", "shop", "atop", "stow") are never a
 * typo of a stop word either.
 */
const stopTypoDenyList = new Set(["hat", "half", "stomp", "sop"]);

/**
 * The stop word that a typed word stands for, or null: one typo away from
 * "stop", "cancel", "abort" or "halt" ("stp", "srop", "sttop", "canceel",
 * "abortt", "haltt"). A typo is what `typoCount` counts as one.
 */
function stopTypo(word: string): string | null {
  if (stopWords.has(word)) return word;
  if (word.length < 3 || !/^[a-z]+$/.test(word)) return null;
  if (stopTypoDenyList.has(word) || knownWord(word)) return null;
  for (const stop of ["stop", "cancel", "abort", "halt"])
    if (Math.abs(stop.length - word.length) <= 1 && typoCount(word, stop) <= 1)
      return stop;
  return null;
}

/**
 * A word one typo away from a hold cue that names a thing on a screen: the
 * "layer" of a drawing is no "later". Any other such word holds: a hold is
 * the safe reading.
 */
const holdTypoDenyList = new Set([
  "layer",
  // Ordinary words one letter from a hold cue: "running late" is no "later".
  "late",
  "laser",
  "lager",
  "bait",
  "wail",
  "hole",
]);

/**
 * The hold cue that a typed word of 4 letters or more stands for, or null:
 * "befor", "untl", "latr", "waot", "nevr", "tomorow". Words of 8 letters or
 * more take two typos. Every hold cue holds, so two near cues are no tie.
 */
function holdTypo(word: string): string | null {
  if (word.length < 4 || !/^[a-z]+$/.test(word)) return null;
  if (holdTypoDenyList.has(word) || knownWord(word)) return null;
  for (const cue of holdTypoTargets) {
    if (cue.length < 4) continue;
    const limit = Math.min(word.length, cue.length) >= 8 ? 2 : 1;
    if (Math.abs(cue.length - word.length) > limit) continue;
    if (typoCount(word, cue) <= limit) return cue;
  }
  return null;
}

/**
 * A run of three or more of the same letter becomes one or two: "pleeease",
 * "stooop", "noooo". A known word wins; else every run becomes one letter
 * ("Fiiixing" is "Fixing").
 */
function shortenRuns(word: string): string {
  const runs = [...word.matchAll(/([a-z])\1{2,}/gi)];
  if (runs.length === 0 || runs.length > 4) return word;
  const forms: string[] = [];
  for (let mask = 0; mask < 1 << runs.length; mask++) {
    let form = "";
    let at = 0;
    runs.forEach((run, index) => {
      form += word.slice(at, run.index);
      form += run[1]!.repeat(mask & (1 << index) ? 2 : 1);
      at = run.index! + run[0].length;
    });
    forms.push(form + word.slice(at));
  }
  const lower = (form: string) => form.toLowerCase();
  return (
    forms.find((form) => stopForm.test(lower(form))) ??
    forms.find((form) => knownWord(lower(form))) ??
    forms[0]!
  );
}

/** Spans that stay as written: quoted labels, web addresses and key combinations. */
function keptSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const patterns = [
    /"[^"\n]{1,120}"/g,
    /(?:^|\s)'[^'\n]{1,120}'(?=$|\s|[,.;!?])/g,
    new RegExp(webAddressWithPath.source, "gi"),
    /\b(?:cmd|command|ctrl|control|alt|option|shift|fn)(?:\s*\+\s*[a-z0-9]+)+/gi,
  ];
  for (const pattern of patterns)
    for (const match of text.matchAll(pattern))
      spans.push([match.index!, match.index! + match[0].length]);
  return spans.sort((a, b) => a[0] - b[0]);
}

/** Applies `rewrite` to the parts of `text` outside the kept spans. */
function outsideKept(
  text: string,
  rewrite: (part: string, offset: number) => string,
): string {
  let out = "";
  let at = 0;
  for (const [start, end] of keptSpans(text)) {
    if (start < at) {
      at = Math.max(at, end);
      continue;
    }
    out += rewrite(text.slice(at, start), at) + text.slice(start, end);
    at = end;
  }
  return out + rewrite(text.slice(at), at);
}

/** A word on its own: not part of a name such as worker.ts, sign-in, it's or a@b. */
const wordToken =
  /(?<![A-Za-z0-9'_\/@-])(?<![A-Za-z0-9]\.)[A-Za-z]+(?![A-Za-z0-9'_\/@-]|\.[A-Za-z0-9])|\b(?:w8t?|b4|l8r?|2moro|2morrow|2day|2nite)\b/gi;

/** True when the word at `index` opens a sentence. */
function opensSentence(part: string, index: number, partOpens: boolean) {
  const before = part.slice(0, index);
  return partOpens && /^[\s"'(]*$/.test(before)
    ? true
    : /[.!?]\s+$/.test(before);
}

/**
 * One word as the reader reads it: runs of letters shortened, a casual form
 * spelled out, a doubled letter that hides a hold cue taken away, and a
 * typo of a screen word corrected. A capitalized word inside a sentence is
 * a name and stays as it is.
 */
function readWord(word: string, opens: boolean): string {
  const short = shortenRuns(word);
  const lower = short.toLowerCase();
  const casual = casualWord[lower];
  if (casual !== undefined) return casual;
  if (knownWord(lower)) return short;
  const single = lower.replace(/([a-z])\1+/g, "$1");
  if (holdCueWords.has(single)) return single;
  // A typo of a stop word stops and a typo of a hold cue holds, also in a
  // word that looks like a name.
  const stop = stopTypo(lower);
  if (stop !== null) return stop;
  const cue = holdTypo(lower);
  if (cue !== null) return cue;
  const capitalized = /^[A-Z][a-z]/.test(short);
  if (capitalized && !opens) return short;
  const target = typoTarget(lower);
  if (target === null) return short;
  return capitalized ? target[0]!.toUpperCase() + target.slice(1) : target;
}

/** Words that, after a bare "search", name no query: "search bar", "search the page". */
const searchNoQuery =
  /^(?:for|the|a|an|my|your|our|his|her|their|this|that|these|those|it|me|up|bar|box|field|button|results?|tab|page|engine|history|icon|again|more)\b/i;

/**
 * The message as the casual reader reads it. For reading only: it is never
 * kept, sent or shown.
 */
export function casualWords(text: string): string {
  let words = normalize(text)
    .cased.replace(stopEmoji, " stop ")
    .replace(questionEmoji, "?")
    .replace(decorationEmoji, " ")
    .replace(/[\u201a\u201b]/g, "'")
    .replace(/[\u201e\u201f\u00ab\u00bb]/g, '"')
    .replace(/\*+([^*\s][^*]*?)\*+/g, "$1")
    .replace(/[!?.,;]{2,}/g, (run) =>
      run.includes("?")
        ? "?"
        : run.includes("!")
          ? "!"
          : run.includes(".")
            ? "."
            : run[0]!,
    )
    .replace(/\s+([?!.,;])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  words = words.replace(leadingAddress, "").replace(trailingAddress, "$1");
  words = outsideKept(words, (part, offset) => {
    const partOpens = offset === 0;
    let out = part
      .replace(/(?<=\s)[nN](?=\s+[A-Za-z])/g, "and")
      .replace(/\s&\s/g, " and ")
      .replace(/\s\+\s/g, " and ")
      .replace(/\b[wW]\/(?=\s|[A-Za-z])/g, "with ")
      .replace(/\b(?:1|one)\s*(?:secs?|mins?|minutes?|moments?)\b/gi, "one sec")
      .replace(/\b(?:a|one)\s+(?:mins?|moment)\b/gi, "one sec");
    out = out.replace(wordToken, (word, index: number) =>
      readWord(word, opensSentence(out, index, partOpens)),
    );
    return out;
  });
  words = words.replace(
    /(^|[,;]\s*|\b(?:and|then)\s+|^(?:(?:ok|okay|so|now|just|pls|plz|please|yo|hey|can you|could you|would you|will you)[,\s]+)+)search\s+(?=[A-Za-z0-9"'])/gi,
    (match: string, lead: string, index: number, all: string) =>
      searchNoQuery.test(all.slice(index + match.length))
        ? match
        : `${lead}search for `,
  );
  return words.replace(/\s+/g, " ").trim();
}

/**
 * A word of any script on its own, for the reader of stop words. Its
 * letters may be lookalike letters of another script ("stоp").
 */
const anyScriptWord =
  /(?<![\p{L}\p{M}\p{N}'_\/@-])(?<![\p{L}\p{N}]\.)[\p{L}\p{M}]+(?![\p{L}\p{M}\p{N}'_\/@-]|\.[\p{L}\p{N}])/gu;

/**
 * The message with its stop words spelled out ("stpo", "cancle", "stp",
 * "sttop", "stooop", "stоp" with a Cyrillic о, a stop sign) and nothing else
 * changed. Other readers of stop words use it.
 */
export function spellStopWords(text: string): string {
  return outsideKept(
    normalize(text).cased.replace(stopEmoji, " stop "),
    (part) =>
      part.replace(anyScriptWord, (word) => {
        const lower = shortenRuns(latinLookalikes(word)).toLowerCase();
        if (!/^[a-z]+$/.test(lower)) return word;
        const spelled = casualWord[lower];
        if (spelled !== undefined)
          return /^(?:stop|cancel|abort|halt)\b/.test(spelled) ? spelled : word;
        return stopTypo(lower) ?? word;
      }),
  )
    .replace(/\s+/g, " ")
    .trim();
}

const abilityFiller =
  "(?:ok|okay|so|hey|yo|hi|hello|um+|uh+|well|and|but|also|quick\\s+question|just\\s+wondering|actually|wait|bro|dude)";
const abilityLead =
  "(?:(?:can|could|would|will)\\s+you(?:\\s+(?:even|actually|really|also|ever|now))?|you\\s+can|are\\s+you\\s+(?:able|allowed)\\s+to|(?:do|did)\\s+you\\s+know\\s+how\\s+to|is\\s+it\\s+possible\\s+(?:for\\s+you\\s+)?to|do\\s+you\\s+have\\s+(?:the\\s+)?(?:ability|access)\\s+to)";
const abilityVerb =
  "(?:click|tap|press|open|use|type|scroll|control|operate|see|read|look\\s+at|move|drag|select|run|access|navigate|browse|do|work\\s+(?:on|in|with)|touch|handle|take\\s+over|drive|interact\\s+with|search(?:\\s+for)?|find|google|look\\s+(?:things|stuff)\\s+up|look\\s+up|surf)";
const genericDevice =
  "(?:(?:my|the|this|your|a)\\s+(?:screen|computer|mac|laptop|desktop|machine|device)|(?:a\\s+)?browsers?|the\\s+(?:mouse|keyboard|cursor))";
const genericWeb = "(?:the\\s+(?:web|internet|net)|online)";
const genericThing = `(?:buttons|links|apps|applications|programs|windows|tabs|menus|websites|sites|web\\s*pages|pages|things|stuff|anything|everything|something|icons|fields|forms|keys|info|information|${genericWeb}|${genericDevice})`;
const genericTail = `(?:\\s+(?:on|in|with|of|from|across|using|around)\\s+(?:${genericDevice}|${genericWeb})|\\s+${genericWeb}|\\s+for\\s+me|\\s+(?:by\\s+)?yourself|\\s+like\\s+(?:a\\s+)?(?:person|human|me)|\\s+at\\s+all|\\s+too|\\s+here|\\s+there)*`;
const abilityQuestion = new RegExp(
  `^(?:${abilityFiller}[,\\s]+)*${abilityLead}\\s+${abilityVerb}(?:\\s+(?:on|in|with|around))?(?:\\s+${genericThing})?${genericTail}(?:[,\\s]+(?:please|pls|plz|bro|dude))?\\s*[?.!]*$`,
);

/**
 * A question about what ClawdTime can do, in the form of a polite request
 * whose object is generic and names no target: "Can you click buttons on my
 * screen?", "can u use my mac?", "are you able to open apps", "can you
 * search the web?", "can you look things up?". It is answered as a question
 * and starts no task. "Can you click the Send button?" and "can you search
 * running shoes?" name a target and are requests.
 */
export function asksWhatItCanDo(text: string): boolean {
  return asksAbility(text, casualWords(text));
}

function asksAbility(text: string, casual: string): boolean {
  const plain = (words: string) =>
    words.toLowerCase().replace(/\s+/g, " ").trim();
  return (
    abilityQuestion.test(plain(normalize(text).cased)) ||
    abilityQuestion.test(plain(casual))
  );
}

/**
 * Classifies words that arrive while a computer task runs, as
 * `readWordsAsWritten` does, and also reads casual forms and typos:
 * - a stop as written stays a stop;
 * - a stop word with a typo, a long "stooop", or a stop sign stops;
 * - a hold cue with a typo or without its apostrophe, an emoji of doubt,
 *   refusal or delay, and a question about what ClawdTime can do hold;
 * - a message that holds as written is read as an order (or a continue)
 *   only when its casual reading is one by the same strict rules and holds
 *   no secret;
 * - an order or a continue as written holds when its casual reading holds.
 */
export function readWords(text: string): WordKind {
  const plain = readPlainWords(text);
  if (plain === "stop") return "stop";
  // Lookalike letters of another script and other apostrophe marks hide no
  // stop, hold or negation: "stоp" with a Cyrillic о stops, and "doesn´t"
  // holds. That reading only ever adds a stop or a hold.
  const latin = latinLookalikes(text);
  if (latin === text) return plain;
  const seen = readPlainWords(latin);
  if (seen === "stop") return "stop";
  return seen === plain ? plain : "hold";
}

/** `readWords` for the letters as they are. */
function readPlainWords(text: string): WordKind {
  const written = readWordsAsWritten(text);
  if (written === "stop") return "stop";
  const casual = casualWords(text);
  const reread = casual ? readWordsAsWritten(casual) : "hold";
  if (reread === "stop") return "stop";
  if (holdEmoji.test(text) || asksAbility(text, casual)) return "hold";
  if (written === "hold") {
    // Words that look like a secret once spelled out keep their written
    // reading: a typo never reads a secret into an order.
    if (looksSecretStrict(casual)) return "hold";
    // A long run of one letter that the reader could not resolve, as in a
    // file name or a quoted label, is a word it does not know: it holds.
    if (/([a-z])\1\1/i.test(stripUrls(casual))) return "hold";
    return reread === "order" || reread === "continue" ? reread : "hold";
  }
  return reread === "hold" ? "hold" : written;
}

// Words that hold back work that has not started yet. A new message is read
// with them before it goes to the computer engine, and the request of the
// worker before it counts as a yes ahead of time. Such words never start work
// on the screen at once: "hang on, reply to Sam", "reply to Sam tomorrow",
// "book the 3pm slot once I confirm". They are the hold, wait, doubt and
// condition cues of the reader above, and words for a later time. A word in
// quotes is what the person quotes, not what they ask.

/** The hold, wait, doubt and condition cues of `deferOrDoubt` that hold back a start. */
const startHoldCue =
  /\b(?:wait|waiting|hold|holding|pause|paused|pausing|later|when|whenever|after|once|until|till|before|if|unless|maybe|perhaps|hang\s+on|give\s+me|one\s+sec(?:ond)?|a\s+sec(?:ond)?|a\s+moment|on\s+my\s+cue|not\s+yet|not\s+now|let\s+me|as\s+soon\s+as)\b|\bin\s+(?:\d+|[a-z]+(?:\s+[a-z]+)?)\s+(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|moments?|bit|few|while)\b/;
const weekday = "(?:mon|tues|wednes|thurs|fri|satur|sun)day";
/** A later time for the work itself: "tomorrow", "tonight", "next week", "at 5pm". */
const laterTime = new RegExp(
  String.raw`\b(?:tomorrow|tmrw|tmr|tonight|tonite|later\s+today|this\s+(?:morning|afternoon|evening|weekend)|next\s+(?:week|month|year|weekend|${weekday})|(?:in|by)\s+the\s+(?:morning|afternoon|evening)|first\s+thing|end\s+of\s+(?:the\s+)?(?:day|week)|eod|on\s+${weekday}|at\s+(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|\d{1,2}\s+o'?clock))\b`,
  "g",
);
/** A time that names the thing, not when to work: "for tomorrow", "to Friday", "tomorrow's meeting". */
const timeOfThing = /\b(?:for|to|from|of|through|thru)\s+$/;
/** Fillers and polite leads before the first verb. */
const startLead =
  /^(?:(?:hey|hi|hello|yo|ok|okay|so|now|also|and|then|please|pls|plz|just|kindly|can\s+you|could\s+you|would\s+you|will\s+you|can\s+u|go\s+ahead\s+and|i\s+(?:want|need)\s+you\s+to|help\s+me(?:\s+to)?)[,\s]+)*/;
/** A verb that makes or moves something with a date: the time is that thing's. */
const datedVerb =
  /^(?:schedule|reschedule|book|reserve|set(?:\s+up)?|add|create|make|plan|arrange|move|put|block|invite|accept|decline|rsvp|cancel)\b/;
/** "Pause the music", "hold the shift key": the verb of the work, not a hold. */
const holdAsVerb =
  /^(?:pause|hold)\s+(?=(?:the|my|this|that|a|an|all|it|playback|music|video|song)\b)/;
/** Words that only join two parts of the work: "check my mail, after that reply to Sam". */
const sequenceJoiner =
  /(?<=\S)\s*,?\s+(?:and\s+)?(?:after\s+that|afterwards|once\s+(?:that|it|this)(?:'s|\s+is)\s+done|when\s+(?:that|it|this)(?:'s|\s+is)\s+done)\s*,?\s+(?=\S)/g;

function holdsStart(lower: string): boolean {
  const words = stripUrls(maskQuoted(lower))
    .replace(sequenceJoiner, ", then ")
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return false;
  const opening = words.replace(startLead, "");
  if (startHoldCue.test(opening.replace(holdAsVerb, "do "))) return true;
  if (datedVerb.test(opening)) return false;
  for (const found of words.matchAll(laterTime)) {
    const at = found.index ?? 0;
    const after = words.slice(at + found[0].length);
    if (timeOfThing.test(words.slice(0, at)) || /^'s\b/.test(after)) continue;
    return true;
  }
  return false;
}

/**
 * True when the words hold back work that has not started: a hold or a wait
 * ("hang on", "pause, then", "but wait for me"), a doubt ("maybe"), a
 * condition ("once I confirm", "if it is cheap"), or a later time ("tomorrow",
 * "after the meeting"). It reads the words as written and as the casual
 * reader reads them, and an emoji of doubt or delay holds too. It changes
 * nothing of `readWords`.
 */
export function defersWork(text: string): boolean {
  const { lower } = normalize(text);
  if (!lower) return false;
  if (holdEmoji.test(text)) return true;
  return holdsStart(lower) || holdsStart(casualWords(text).toLowerCase());
}

/**
 * True when the words read as code work to the strict reader: what they name
 * (see `namesCodeWork`), or a verb of code work at the head of a clause ("add
 * dark mode", "fix the typo"). Such a verb is also a verb for the screen
 * ("add it to the cart"), so this only says that the words may be code work.
 */
export function holdsCodeWork(text: string): boolean {
  return splitSentences(normalize(text).cased).some(hasCodeWorkInSentence);
}

/**
 * True when the words name code work by what they name: a code file name, a
 * code artifact (a repository, a branch, a commit, a function), a command to
 * run, a diff to review, code to pull, or a soft code noun (a file, a test, the
 * code) outside a label of the screen. A verb alone names none: "add it to the
 * cart", "change the size" and "remove the filter" are words for the screen.
 */
export function namesCodeWork(text: string): boolean {
  return splitSentences(normalize(text).cased).some((sentence) => {
    const noUrlCased = stripUrls(sentence)
      .replace(/[.!?]+$/, "")
      .trim();
    if (!noUrlCased) return false;
    const noUrlLower = noUrlCased.toLowerCase();
    if (codeFileName.test(noUrlLower)) return true;
    const unquotedCased = maskQuoted(noUrlCased);
    const unquotedLower = unquotedCased.toLowerCase();
    if (
      strongCodeArtifact.test(unquotedLower) ||
      runCommandPattern.test(unquotedLower) ||
      reviewDiffPattern.test(unquotedLower) ||
      pullCodePattern.test(unquotedLower)
    )
      return true;
    const withoutUiLabels = unquotedCased
      .replace(
        /\b(?:the|this|that|a|an)\s+(?:[A-Za-z0-9_-]+\s+){1,3}(?:button|tab|menu|link|section|dialog|popup|window|bar|box|field|page|icon|item|option|dropdown)s?\b/gi,
        " ",
      )
      .replace(
        /\b(?:verification|confirmation|security|access|promo|coupon|invite|referral|zip|postal)\s+codes?\b/gi,
        " ",
      )
      .replace(/\btype\s+[^,;!?]+?(?=\s+(?:in|into|on)\b|$)/gi, " ");
    return softCodeArtifact.test(withoutUiLabels);
  });
}

// Words while a task runs. The worker goes on by itself. Every message that
// is not a stop steers the task: it goes to the planner as the newest words,
// and the task keeps going. Only three kinds of words are read apart: a plain
// request to pause ("wait", "hold on", "let me do it"), a question about how
// the task goes ("are you done?"), and a plain go or thanks ("continue",
// "ok", "thanks") that carries nothing to steer with. `readWords` stays the
// reader of stops. A stop always wins.

/** What a message that arrives while a computer task runs does to that task. */
export type MidTaskKind = "stop" | "pause" | "status" | "go" | "steer";

/** Where a message splits into parts for the readers below. A dot inside a web address splits nothing. */
const midTaskSplit =
  /[,;:!?…]+|\.+(?=\s|$)|\s+-+\s+|[–—]|\s+(?:and\s+then|and|then)\s+/;
/** Words that may open or close any part, and say nothing by themselves. */
const midTaskLead =
  /^(?:(?:ok|okay|k|kk|hey|hi|hello|yo|bro|bruh|dude|man|um+|uh+|hm+|oh|ah|so|well|actually|please|pls|plz|just|now|sorry|oops|alright|all\s+right|and|but|no|nope|nah|clawdtime|clawd)\s+)+/;
const midTaskTrail =
  /(?:\s+(?:please|pls|plz|bro|bruh|dude|man|thanks|thank\s+you|thx|now|right\s+now|ok|okay|clawdtime))+$/;
/** A part that only says yes, no, sorry or thanks. It may stand beside a pause. */
const midTaskNeutral =
  /^(?:ok|okay|k|kk|hey|hi|hello|yo|bro|bruh|dude|man|um+|uh+|hm+|oh|ah|so|well|actually|please|pls|plz|just|now|sorry|oops|alright|all\s+right|no|nope|nah|no\s+no|yes|yeah|yep|sure|right|thanks|thank\s+you|thx|ty|clawdtime|clawd)$/;

/** A short time to wait: "a sec", "one moment", "2 minutes", "a bit". */
const pauseSpan = String.raw`(?:(?:a|one|1|a\s+few|few|a\s+couple(?:\s+of)?|couple(?:\s+of)?|two|2|three|3|five|5|ten|10|\d{1,2})\s*(?:sec(?:ond)?s?|moments?|minutes?|mins?|ticks?|mo)\b|a\s+(?:bit|while|tick))`;
/** What may follow the words of a pause and keep them a pause. */
const pauseTail = String.raw`(?:please|pls|plz|now|right\s+now|for\s+now|for\s+(?:just\s+)?me|for\s+(?:just\s+)?${pauseSpan}|just\s+${pauseSpan}|${pauseSpan}|there|here|then|first|up|on|it|that|this|everything|all|(?:until|till)\s+i\s+(?:say(?:\s+so)?|tell\s+you(?:\s+to)?|(?:am|'m)\s+(?:back|done|ready|finished)|come\s+back|get\s+back|(?:have|'ve)\s+(?:checked|looked|done\s+it))|bro|bruh|dude|man|thanks|thank\s+you|thx)`;
/** What the person does on the Mac themselves: "let me do it", "I'll type the code". */
const takeVerb = String.raw`(?:do|handle|finish|type|fill(?:\s+(?:in|out))?|enter|solve|sort(?:\s+out)?|take\s+care\s+of|take\s+over|take\s+it(?:\s+from\s+here)?|take\s+(?:this|that)(?:\s+one)?|drive|fix|try|click|log\s+in|sign\s+in|pay)`;
/** What the person looks at themselves: "let me check", "I need to see something". */
const lookVerb = String.raw`(?:check|look|see|think|read|take\s+a\s+look|have\s+a\s+look|look\s+at)`;
/** Up to six more words of what the person does themselves. */
const someWords = String.raw`(?:\s+[a-z0-9'"./@-]+){0,6}`;
/** Only what the person looks at or does now, in a few words. */
const selfObject = String.raw`(?:\s+(?:it|this|that|something|smth|sth|first|now|myself|real\s+quick|quickly|quick|a\s+sec|for\s+a\s+sec|one\s+sec|again|here|at\s+(?:it|this|that|something)|the\s+rest|this\s+(?:one|part|step|bit)|that\s+(?:one|part|step|bit)|what\s+(?:you|u)\s+(?:did|do|are\s+doing)|the\s+(?:screen|page|mac|tab|window|captcha|code|password|login|sign[- ]?in|form|payment))){0,4}`;
/** The words of a plain request to pause, each as a whole part of the message. */
const pauseHead = [
  String.raw`wait(?:\s+up)?`,
  String.raw`hold(?:\s+(?:on|up|off|it|that|everything))?`,
  String.raw`hang\s+(?:on|tight)`,
  String.raw`pause(?:\s+(?:the\s+task|the\s+work|everything|for\s+now))?`,
  String.raw`(?:just\s+)?(?:a|one|1)\s+(?:sec(?:ond)?|moment|minute|min|tick|mo)`,
  String.raw`sec`,
  String.raw`give\s+me\s+(?:just\s+)?(?:${pauseSpan}|(?:a\s+)?(?:sec(?:ond)?|moment|minute|min))`,
  String.raw`not\s+(?:yet|now|just\s+yet|right\s+now)`,
  String.raw`(?:don't|dont|do\s+not)\s+(?:do|touch|click|type|press|move)\s+anything(?:\s+(?:yet|now|else))?`,
  String.raw`(?:let\s+me|i(?:'ll|\s+will)|i(?:'m|\s+am)\s+(?:going\s+to|gonna))\s+${takeVerb}${someWords}`,
  String.raw`let\s+me\s+${lookVerb}${selfObject}`,
  String.raw`i(?:'ve|\s+have)?\s+got\s+(?:this|it\s+from\s+here)`,
  String.raw`i\s+(?:need|have)\s+to\s+(?:${takeVerb}|${lookVerb})${selfObject}`,
  String.raw`i(?:'m|\s+am)\s+(?:checking|looking|doing|typing|reading|fixing|trying|entering|handling|taking\s+over)${selfObject}`,
  String.raw`my\s+turn`,
  String.raw`hands\s+off(?:\s+the\s+(?:mac|mouse|keyboard|computer))?`,
  String.raw`(?:i(?:'ll|\s+will)\s+)?be\s+(?:right\s+)?back`,
  String.raw`back\s+off`,
].join("|");
const pausePart = String.raw`(?:${pauseHead})(?:\s+${pauseTail})*`;
const pauseClause = new RegExp(String.raw`^${pausePart}(?:\s+${pausePart})*$`);
/** Emoji that ask to wait: a raised hand, a pause button, an hourglass. */
const pauseEmoji = /[⏸⏳⌛✋\u{1F91A}\u{1F590}]/gu;

/** The message as plain lower-case words, as written and as the casual reader reads it. */
function midTaskReadings(text: string): string[] {
  const forms = [text, latinLookalikes(text)];
  const readings = new Set<string>();
  for (const form of forms) {
    for (const words of [normalize(form).cased, casualWords(form)])
      readings.add(
        words
          .replace(pauseEmoji, " wait ")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim(),
      );
  }
  return [...readings];
}

/**
 * The parts of a message, each with the words that open it and say nothing
 * taken off, and once more with the words that close it taken off too ("not
 * right now" stays itself, "wait now" is "wait").
 */
function midTaskParts(lower: string): string[][] {
  return lower.split(midTaskSplit).map((part) => {
    const opened = part
      .replace(/["()*]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(midTaskLead, "")
      .trim();
    return [opened, opened.replace(midTaskTrail, "").trim()];
  });
}

/** True when every part of the message is a pause or says nothing, and one part is a pause. */
function pausesAll(lower: string): boolean {
  let pause = false;
  for (const forms of midTaskParts(lower)) {
    if (forms.some((part) => !part || midTaskNeutral.test(part))) continue;
    if (!forms.some((part) => pauseClause.test(part))) return false;
    pause = true;
  }
  return pause;
}

/** Words that may open a question about the task. */
const statusLead = String.raw`(?:(?:hey|hi|yo|bro|bruh|dude|ok|okay|so|well|wait|hold\s+on|hang\s+on|and|but|uh+|um+|hm+|oh|clawdtime|clawd)[,\s]+)*`;
/** A question about how the task goes, as a whole sentence. */
const statusAsks = [
  String.raw`(?:are|r)\s+(?:you|u)\s+(?:(?:still|almost|nearly|already|all)\s+)?(?:done|finished|ready|there|here|stuck|frozen|hung|working|busy|on\s+it|close|okay|ok|alive|going|awake)(?:\s+(?:yet|now|already|right\s+now|with\s+(?:it|that|this)))?`,
  String.raw`(?:is|has)\s+(?:it|that|this|the\s+(?:task|page|tab|window|screen|site|computer\s+task|work))\s+(?:(?:still|already|all|almost)\s+)?(?:done|finished|ready|open(?:ed)?|loaded|loading|working|running|over|stuck|going)(?:\s+(?:yet|now|already))?`,
  String.raw`what\s+(?:are|r)\s+(?:you|u)\s+(?:doing|doin|up\s+to|on|working\s+on|looking\s+at)(?:\s+(?:now|right\s+now))?`,
  String.raw`what(?:'s|\s+is)\s+(?:happening|going\s+on|the\s+(?:status|progress|holdup|hold\s+up)|up|taking\s+(?:so\s+)?long)(?:\s+(?:now|there))?`,
  String.raw`where\s+(?:are|r)\s+(?:you|u)(?:\s+(?:now|at|up\s+to|with\s+(?:it|that|this)))?`,
  String.raw`how(?:'s|\s+is)\s+(?:it|that|this|the\s+task|everything|it\s+all)\s+going`,
  String.raw`how\s+(?:are|r)\s+(?:you|u)\s+(?:doing|getting\s+on)(?:\s+with\s+(?:it|that|this))?`,
  String.raw`how\s+far\s+(?:along\s+)?(?:are\s+(?:you|u)|is\s+it)`,
  String.raw`how\s+(?:much\s+)?(?:long(?:er)?|more)(?:\s+(?:will\s+(?:it|this|that)\s+take|left|to\s+go|now))?`,
  String.raw`(?:did|does)\s+(?:it|that|this)\s+work`,
  String.raw`what\s+did\s+(?:you|u)\s+(?:just\s+)?(?:do|open|click|type)`,
  String.raw`(?:do\s+(?:you|u)\s+)?need\s+(?:any\s+)?help(?:\s+with\s+(?:it|that|this))?`,
].join("|");
/** Short questions that ask only with their question mark: "done?", "still there?", "progress?". */
const statusShort = String.raw`(?:(?:you|u)\s+(?:(?:still|almost)\s+)?(?:done|finished|there|stuck|ok|okay|working|on\s+it)(?:\s+(?:yet|now))?|still\s+(?:working|going|there|on\s+it|at\s+it)|done(?:\s+yet)?|finished(?:\s+yet)?|almost\s+(?:done|there)|(?:any\s+)?(?:progress|status|update|news)(?:\s+(?:yet|now))?|which\s+step|what\s+step(?:\s+are\s+(?:you|u)\s+on)?)`;
const statusSentence = new RegExp(
  String.raw`^${statusLead}(?:(?:${statusAsks})[\s?!.]*|(?:${statusShort})\s*\?[\s?!.]*)$`,
);

/** True when every sentence of the message asks how the task goes. */
function asksStatus(lower: string): boolean {
  const sentences = lower
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.replace(midTaskTrail, "").trim())
    .filter(Boolean);
  return (
    sentences.length > 0 &&
    sentences.every((part) =>
      statusSentence.test(part.replace(/\s+([?!.])/g, "$1")),
    )
  );
}

/** A message that only says go on, yes or thanks: it carries nothing to steer with. */
const goOnly =
  /^(?:(?:ok|okay|k|kk|cool|nice|great|good|perfect|awesome|fine|thanks|thank\s+you|thx|ty|alright|all\s+right|sure|yes|yeah|yep|yup|right|got\s+it|sounds\s+good|looks\s+good|go|lgtm|nice\s+one|good\s+job|well\s+done|bro|dude|man|please|pls|hey|hi|hello|yo)[\s,.!]*)+$/;

/**
 * Reads a message that arrives while a computer task runs:
 * - "stop": `readWords` reads a stop (also a typo, a lookalike letter or a
 *   casual form of one). It always wins.
 * - "pause": every part of the message is a plain request to pause ("wait",
 *   "hold on", "one sec", "give me a minute", "let me do it", "I'll take it
 *   from here"), or a yes, a no or a thanks beside one.
 * - "status": every sentence asks how the task goes ("are you done?", "what
 *   are you doing?").
 * - "go": a plain continue phrase, or only a yes, an ok or a thanks.
 * - "steer": everything else. "not instagram, flipkart", "no, the other one",
 *   "hmm try the search box" and "that's wrong, go back" all steer.
 */
export function readMidTask(text: string): MidTaskKind {
  if (readWords(text) === "stop") return "stop";
  const readings = midTaskReadings(text);
  if (readings.some(pausesAll)) return "pause";
  if (readings.some(asksStatus)) return "status";
  if (
    readWords(text) === "continue" ||
    readings.some((words) => !words.replace(/[\s,.!]+/g, "")) ||
    readings.some((words) => goOnly.test(words))
  )
    return "go";
  return "steer";
}
