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
  /\b(?:stop+|stah+p+|cancel|abort|halt)\b|\b(?:quit|kill)\s+it\b/;

/** Fillers that may precede a standalone continue phrase. */
const continueFiller =
  "(?:ok|okay|yes|yeah|yep|sure|alright|all right|right|please|pls|plz|bro|bruh|dude|yo|now|then|so|and|well|just|uh+|um+|hey)";
const continueMessage = new RegExp(
  `^(?:${continueFiller}[,\\s]+)*(?:continue|go on|go ahead|resume|carry on|keep going|proceed)(?:[,\\s]+(?:please|pls|plz|now|bro))?$`,
);

/** Anything that defers, negates, conditions, doubts, refuses or takes over anywhere in the message. */
const deferOrDoubt =
  /\b(?:not|no|never|wait|waiting|hold|holding|pause|paused|pausing|later|when|after|once|until|before|if|unless|maybe|yet|i'm|i\s+am|i'll|i\s+will|i(?:'ve)?\s+got|let\s+me|dont|doesnt|didnt|wont|cant|cannot|wouldnt|shouldnt|couldnt|hang\s+on|give\s+me|one\s+sec(?:ond)?|a\s+sec(?:ond)?|a\s+couple|nah|nope|nevermind|never\s+mind|nvm|forget|already|on\s+my\s+cue|wrong|broken|mess)\b|n't\b|\bin\s+(?:\d+|[a-z]+(?:\s+[a-z]+)?)\s+(?:seconds?|secs?|minutes?|mins?|moments?|bit|few)\b/;

/** Hold/delay/doubt/refusal cues that disqualify even an earlier observation report. */
const hardHoldCue =
  /\b(?:wait|waiting|hold|holding|pause|paused|pausing|later|when|after|once|until|before|if|unless|maybe|i'm|i\s+am|i'll|i\s+will|i(?:'ve)?\s+got|let\s+me|hang\s+on|give\s+me|one\s+sec(?:ond)?|a\s+sec(?:ond)?|a\s+couple|nah|nope|nevermind|never\s+mind|nvm|forget|already|on\s+my\s+cue|wrong|broken|mess|never|no|why|how|what|whether|should|would|could|but|so|because)\b|\bin\s+(?:\d+|[a-z]+(?:\s+[a-z]+)?)\s+(?:seconds?|secs?|minutes?|mins?|moments?|bit|few)\b/;

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
  "(?:(?:address|search|menu|tab|tool|side|status|scroll|title)\\s+bar|toolbar|sidebar|(?:search|text|input|dialog)\\s+box(?:es)?|checkbox(?:es)?|(?:tab|button|link|page|window|app|menu|field|url|site|website|result|item|row|option|popup|dialog|folder|note|email|message|list|icon|image|video|form|dropdown|browser|draft)s?)";

const screenNoun = new RegExp(`\\b${screenNounSource}\\b`);

const pronounObject =
  /^(?:it|that|this|them|there|here|one|this one|that one)$|^(?:it|that|this|them)\s+(?:in|on|with|to|into|from|at|for)\s+/;

/** Verbs that ask for work on code or content rather than a screen action. */
const codeWorkVerb =
  /\b(?:fix|add|write|change|implement|refactor|build|create|bump|push|commit|merge|deploy|install|migrate|rename|delete|remove|update|edit)\b/;

/** Objects that name code artifacts rather than UI targets. */
const codeWorkObject =
  /\b(?:files?|repos?|repositor(?:y|ies)|branch(?:es)?|commits?|functions?|components?|class(?:es)?|modules?|tests?|code|readme|configs?|issues?|tickets?|bugs?)\b/;

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
  /(?:https?:\/\/)?(?:localhost(?::\d{1,5})?\b|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:com|org|net|edu|gov|io|co|ai|app|dev|me|us|uk|ca|de|fr|jp|au|in|gg|tv|so|sh|xyz|info|biz|page|site|cloud|tech|news|blog|shop|store|pro|ly|to|cc|fm|nl|se|ch|es|eu|br|kr|cn|tw|hk|sg|nz|mx|pl)(?::\d{1,5})?\b)/;

const webAddressWithPath = new RegExp(
  `${webAddress.source}(?:/[^\\s,.;:!?)'"]*)?`,
  "g",
);

const quotedLabel = /"[^"\n]{1,120}"|(?:^|\s)'[^'\n]{1,120}'(?=$|\s|[,.;!])/;

const capitalizedToken =
  /(?:[A-Z][A-Za-z0-9]*[a-z]|[a-z][A-Z][a-z])[A-Za-z0-9]*/;
const leadingCapitalizedTarget = new RegExp(
  `^(?:(?:the|this|that|a|an)\\s+)?(${capitalizedToken.source})\\b`,
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

function hasCodeWork(verb: string, objLower: string): boolean {
  if (!objLower) return false;
  const unquoted = maskQuoted(objLower);
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
  if (pronounObject.test(objLower)) return true;
  if (ordinalObject.test(objLower)) return true;
  if (keyVerbs.has(verb) && keyObject.test(objLower)) return true;
  if (explicitKey.test(objLower)) return true;
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
 * Classifies words that arrive while a computer task runs:
 * - "stop": any stop word anywhere in the message
 * - "continue": a standalone continue phrase (after optional fillers), no "?"
 * - "order": the last sentence matches a strict screen-order shape and no
 *   earlier sentence carries a hold, wait, delay, doubt, refusal, self-takeover
 *   or question cue (except a narrow observation report of what is or is not
 *   seen on the screen)
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
  const sentences = splitSentences(cased);
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
