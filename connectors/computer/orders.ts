/**
 * Conservative reader for words the person sends while a computer task runs.
 *
 * Safe by default: the task goes on only for a narrow, written shape of
 * screen order (or a plain continue phrase without a question mark). Any stop
 * word stops the task at once. Everything else holds.
 */
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

/** A stop word anywhere in the message stops the task. */
const stopWord =
  /\b(?:stop+|stah+p+|cancel|abort|halt|enough)\b|\b(?:quit|kill)\s+it\b/;

/** Fillers that may precede a standalone continue phrase. */
const continueFiller =
  "(?:ok|okay|yes|yeah|yep|sure|alright|all right|right|please|pls|plz|bro|bruh|dude|yo|now|then|so|and|well|just|uh+|um+|hey)";
const continueMessage = new RegExp(
  `^(?:${continueFiller}[,\\s]+)*(?:continue|go on|go ahead|resume|carry on|keep going|proceed)(?:[,\\s]+(?:please|pls|plz|now|bro))?$`,
);

/** Anything that defers, negates, conditions or doubts in the order sentence. */
const deferOrDoubt =
  /\b(?:not|no|never|wait|waiting|hold|holding|pause|paused|pausing|later|when|after|once|until|before|if|unless|maybe|i'm|i\s+am|i'll|dont|doesnt|didnt|wont|cant|cannot|wouldnt|shouldnt|couldnt)\b|n't\b|\bin\s+a\s+(?:second|sec|minute|min|moment|bit|few)\b/;

/** Leading fillers and optional polite leads before a screen verb. */
const orderFiller =
  "(?:ok|okay|bro|bruh|dude|yo|yeah|yep|alright|all right|so|and|then|now|just|please|pls|plz|uh+|um+|well|hey)";
const politeLead = "(?:can you|could you|would you|will you|can u|pls)";
const leadingPrefix = new RegExp(
  `^(?:(?:${politeLead}|${orderFiller})[,\\s]+)+`,
);
const hasPoliteLeadPattern = new RegExp(`\\b(?:${politeLead})\\b`);

const screenVerb =
  /^(search for|go to|go back|switch to|open|click|press|hit|tap|type|enter|select|choose|pick|scroll|drag|use|try|close)\b(?:\s+|$)/;

const trailingVocative =
  /(?:,?\s+(?:bro|bruh|dude|yo|please|pls|plz|instead|now|again))+$/i;

const screenNounSource =
  "(?:address bar|search box|(?:tab|button|link|page|window|app|menu|field|bar|url|site|website|result|item|row|option|popup|dialog|folder|note|email|message|list|card|icon|image|video|form|dropdown|browser|draft)s?|box(?:es)?|checkbox(?:es)?)";

const screenNoun = new RegExp(`\\b${screenNounSource}\\b`);

const pronounObject =
  /^(?:it|that|this|them|there|here|one|this one|that one)$|^(?:it|that|this|them)\s+(?:in|on|with|to|into|from|at|for)\s+/;

const pronounAndScreenVerb = new RegExp(
  `^(?:it|that|this|them|there|here|one|this one|that one)\\s+(?:and\\s+(?:then\\s+)?|then\\s+)${screenVerb.source.slice(1)}`,
);

/** Verbs that ask for work on code or content rather than a screen action. */
const codeWorkVerb =
  /\b(?:fix|add|write|change|implement|refactor|build|create|bump|push|commit|merge|deploy|install|migrate|rename|delete|remove|update|edit)\b/;

/** Objects that name code artifacts rather than UI targets. */
const codeWorkObject =
  /\b(?:files?|repos?|repositor(?:y|ies)|branch(?:es)?|commits?|functions?|components?|class(?:es)?|modules?|tests?|code|readme|configs?)\b/;

/** A file name with a common code, markup, data or config extension. */
const codeFileName =
  /(?:^|[\s(])(?:[a-z0-9_.-]+\/)*[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|json|md|mdx|yml|yaml|toml|sql|swift|rs|go|rb|php|java|kt|kts|c|h|cpp|hpp|cs|vue|svelte|css|scss|less|html|xml|env|lock|ini|cfg|conf|proto|graphql|gql)(?=$|[\s,.;:!?)'"])/;

const ordinalObject = new RegExp(
  `\\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|next|previous|prev|other|top|bottom|1st|2nd|3rd|[4-9]th)\\s+(?:one|${screenNounSource})\\b|^(?:the\\s+)?(?:first|second|third|fourth|fifth|last|next|previous|other)$`,
);

const keyNameSource =
  "(?:enter|return|escape|esc|tab|space|spacebar|delete|backspace|up|down|left|right|page up|page down|home|end|(?:up|down|left|right)\\s+arrow|arrow\\s+(?:up|down|left|right)|(?:cmd|command|ctrl|control|alt|option|shift)(?:\\s*\\+\\s*[a-z0-9]+)+)";
const keyObject = new RegExp(`^(?:the\\s+)?${keyNameSource}(?:\\s+key)?$`);
const explicitKey = new RegExp(`\\b${keyNameSource}\\s+key\\b`);
const keyVerbs = new Set(["press", "hit", "tap", "use", "try"]);

const webAddress =
  /(?:https?:\/\/)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:com|org|net|edu|gov|io|co|ai|app|dev|me|us|uk|ca|de|fr|jp|au|in|gg|tv|so|sh|xyz|info|biz|page|site|cloud|tech|news|blog|shop|store|pro|ly|to|cc|fm|nl|se|ch|es|eu|br|kr|cn|tw|hk|sg|nz|mx|pl)\b/;

const webAddressWithPath = new RegExp(
  `${webAddress.source}(?:/[^\\s,.;:!?)'"]*)?`,
  "g",
);

const quotedLabel = /"[^"\n]{1,120}"|(?:^|\s)'[^'\n]{1,120}'(?=$|\s|[,.;!])/;

const capitalizedToken =
  /\b(?:[A-Z][A-Za-z0-9]*[a-z]|[a-z][A-Z][a-z])[A-Za-z0-9]*\b/g;
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
]);

const inBrowserOrAppLower =
  /\b(?:in|on|with)\s+(?:the\s+)?(?:browser|google chrome|chrome|safari|firefox|brave browser|brave|microsoft edge|edge|chromium|arc|finder|notes|mail|messages|terminal|iterm|textedit|photos|calendar|calculator|preview|system settings|settings)\b/;
const inCapitalizedApp =
  /\b(?:in|on|with)\s+(?:[A-Z][A-Za-z0-9]*[a-z]|[a-z][A-Z][a-z])[A-Za-z0-9]*\b/;

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
]);

function lastSentence(cased: string): string {
  // Split only at sentence-ending punctuation followed by whitespace so dots
  // inside web addresses (such as app.example.com) stay intact.
  const parts = cased
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.at(-1) ?? cased;
}

function hasCapitalizedName(objCased: string): boolean {
  const matches = objCased.match(capitalizedToken);
  if (!matches) return false;
  return matches.some((word) => !nonNameCapitalized.has(word.toLowerCase()));
}

function hasCodeWork(verb: string, objLower: string): boolean {
  if (!objLower) return false;
  const unquoted = objLower
    .replace(/"[^"\n]{1,120}"/g, " ")
    .replace(/(?:^|\s)'[^'\n]{1,120}'(?=$|\s|[,.;!?])/g, " ");
  if (codeWorkObject.test(unquoted)) return true;
  const withoutWeb = unquoted.replace(webAddressWithPath, " ");
  if (codeFileName.test(withoutWeb)) return true;
  if (keyVerbs.has(verb) && keyObject.test(objLower)) return false;
  const forVerb = unquoted.replace(/\bdelete\s+key\b/g, " ");
  return codeWorkVerb.test(forVerb);
}

function hasValidObject(
  verb: string,
  objCased: string,
  objLower: string,
): boolean {
  if (!objLower) return false;
  if (pronounObject.test(objLower) || pronounAndScreenVerb.test(objLower))
    return true;
  if (ordinalObject.test(objLower)) return true;
  if (keyVerbs.has(verb) && keyObject.test(objLower)) return true;
  if (explicitKey.test(objLower)) return true;
  if (screenNoun.test(objLower)) return true;
  if (webAddress.test(objLower)) return true;
  if (quotedLabel.test(objCased)) return true;
  if (hasCapitalizedName(objCased)) return true;
  if (inBrowserOrAppLower.test(objLower) || inCapitalizedApp.test(objCased))
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

  const restCased = bodyCased.slice(prefix.length).trim();
  const restLower = bodyLower.slice(prefix.length).trim();
  const verbMatch = screenVerb.exec(restLower);
  if (!verbMatch) return false;

  const verb = verbMatch[1]!;
  const rawCased = restCased.slice(verbMatch[0].length).trim();
  const rawLower = restLower.slice(verbMatch[0].length).trim();
  const tailMatch = trailingVocative.exec(rawLower);
  const objCased = tailMatch
    ? rawCased.slice(0, rawCased.length - tailMatch[0].length).trim()
    : rawCased;
  const objLower = tailMatch
    ? rawLower.slice(0, rawLower.length - tailMatch[0].length).trim()
    : rawLower;

  if (hasCodeWork(verb, objLower)) return false;

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

/**
 * Classifies words that arrive while a computer task runs:
 * - "stop": any stop word anywhere in the message
 * - "continue": a standalone continue phrase (after optional fillers), no "?"
 * - "order": the last sentence matches a strict screen-order shape with no
 *   deferral, negation or doubt words (earlier sentences may be any non-stop)
 * - "hold": everything else
 */
export function readWords(text: string): WordKind {
  const { cased, lower } = normalize(text);
  if (!lower) return "hold";
  if (stopWord.test(lower)) return "stop";
  if (!lower.includes("?")) {
    const plain = lower.replace(/^[,.:;!]+|[.!,:;]+$/g, "").trim();
    if (plain && continueMessage.test(plain)) return "continue";
  }
  if (isOrderSentence(lastSentence(cased))) return "order";
  return "hold";
}
