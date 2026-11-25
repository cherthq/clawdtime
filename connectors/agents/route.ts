import { catalog } from "./catalog.js";

/**
 * The road of one message of the person: the computer engine, a coding job,
 * both in that order, or an answer of the language model.
 *
 * ClawdTime is first of all a computer use agent. Work that is done on this
 * Mac goes to the computer engine: work in an app, on a web page, in an
 * account (mail, chat, posts, a calendar), on a file in an app, or in a
 * setting. That holds also when the words do not name the screen: "follow up
 * on my latest X posts", "reply to Sam on Slack", "book the 3pm slot". A
 * coding job starts only for code work: a repository, a build, a test, a
 * script, a pull request, work in a terminal, or work for a coding agent that
 * the person names. A message with both parts ("fix the failing test and
 * then open the PR page") takes both roads: the code part goes to a job
 * first, then the screen part goes to the engine.
 *
 * The road is read from the person's own words and from nothing else. It
 * grants nothing: every gate after it still reads the message (a stop, a
 * question that waits, an approval, the gates of the engine and of a job). A
 * message that this reader cannot place for sure is an "answer": the
 * language model reads it, with the tools of the turn.
 */
export type Road =
  /** Work on the screen. `reads` is true when it only looks and changes nothing. */
  | { kind: "engine"; reads: boolean }
  /** Code work for a coding agent. */
  | { kind: "job" }
  /** Code work and screen work in one message: the code part first, then the screen part. */
  | { kind: "both"; code: string; screen: string; reads: boolean }
  /** Not placed here: the language model answers, or picks a tool. */
  | { kind: "answer" };

type Part = "code" | "screen" | "reads" | null;

const answer: Road = { kind: "answer" };

/** Words that open a message and add nothing to it. */
const fillers =
  /^(?:(?:hey|hi|hello|yo|ok|okay|so|well|alright|right|um+|uh+|now|also|and|then|clawdtime)[,.!:]?\s+)+/i;
/** A polite way into a request: "can you", "could you please", "I want you to", "help me". */
const politeLead =
  /^(?:(?:please|pls|plz)[,]?\s+)?(?:(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+|pls\s+)?|i\s+(?:want|need)\s+you\s+to\s+|i(?:['\u2019]d|\s+would)\s+like\s+you\s+to\s+|go\s+ahead\s+and\s+|let['\u2019]?s\s+|help\s+me(?:\s+to)?\s+|i\s+(?:need|want|have)\s+to\s+|i\s+gotta\s+)/i;
/** Soft words before the verb: "please", "just", "quickly". */
const softeners = /^(?:(?:please|pls|plz|just|quickly|quick)[,]?\s+)+/i;
/** Soft words at the end: "please", "for me", "thanks". */
const tail =
  /(?:[\s,]+(?:please|pls|plz|for\s+me|thanks|thank\s+you|thx|real\s+quick|asap|now))+[.!?\s]*$|[.!?\s]+$/i;

/** The person's request without what leads into it, and whether it was asked politely. */
export function requestWords(text: string): {
  body: string;
  polite: boolean;
} {
  let body = text.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
  let polite = false;
  for (let round = 0; round < 4; round++) {
    const before = body;
    body = body.replace(fillers, "");
    if (politeLead.test(body)) {
      polite = true;
      body = body.replace(politeLead, "");
    }
    body = body.replace(softeners, "");
    if (body === before) break;
  }
  return { body: body.replace(tail, "").trim(), polite };
}

/** The coding agents that ClawdTime knows, by the names that a person says. */
const agentNames = [
  ...new Set(
    catalog.flatMap((entry) => [
      ...entry.names,
      entry.label.toLowerCase(),
      entry.kind.replace(/-/g, " "),
    ]),
  ),
]
  .filter((name) => name.length >= 2)
  .sort((a, b) => b.length - a.length)
  .map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"),
  )
  .join("|");
/**
 * The person names a coding agent for the work: "use Claude to fix it", "ask
 * Codex to write the tests", "have the gemini cli look at it". A name alone
 * can be a person's name ("reply to Claude on Slack"), so it counts only
 * after a word that hands work to it, or before "code", "cli", "agent".
 */
const namesCodingAgent = (text: string) =>
  /\bclaude\s+code\b|\bcodex\b/i.test(text) ||
  new RegExp(
    `\\b(?:use|using|with|via|ask|have|get|let|open|start|launch|run|in)\\s+(?:the\\s+)?(?:${agentNames})\\b(?!\\s+(?:on|in)\\s+(?:slack|discord|teams|x|mail|gmail))`,
    "i",
  ).test(text) ||
  new RegExp(`\\b(?:${agentNames})\\s+(?:cli|agent)\\b`, "i").test(text);

/** The message names a coding agent anywhere: such words can be for a session of that agent, and other readers place them. */
export const mentionsCodingAgent = (text: string) =>
  new RegExp(`\\b(?:${agentNames})\\b`, "i").test(text);

/** Work in a terminal: a command in backticks, a command line, a shell, a port. */
const terminalWork = (text: string) =>
  /`[^`]+`/.test(text) ||
  /\b(?:in|from|on|inside)\s+(?:the\s+|a\s+|my\s+)?(?:terminal|shell|command\s+line)\b/i.test(
    text,
  ) ||
  /^(?:npm|npx|pnpm|yarn|pip|pip3|brew|git|cargo|docker|kubectl|ssh|curl|python3?|deno|grep|ls|cd|chmod|rm)\s+[-\w./:@]/i.test(
    text,
  ) ||
  /\b(?:run|execute)\s+(?:the\s+)?(?:command|script)\b/i.test(text) ||
  /\bport\s+\d{2,5}\b|\blocalhost\b/i.test(text) ||
  /\b[\p{L}\p{N}_-]+\.(?:json|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|swift|java|kt|cpp|h|cs|php|yml|yaml|toml|sql|sh|zsh|css|scss|lock|env)\b/iu.test(
    text,
  );

/** A list of nouns, found anywhere in a text, or as the last words of a thing. */
const nouns = (alternatives: string) => ({
  any: new RegExp(`\\b(?:${alternatives})\\b`, "i"),
  last: new RegExp(`\\b(?:${alternatives})$`, "i"),
});

/** Things of code. */
const codeNouns = nouns(
  "repo|repos|repository|repositories|codebase|worktrees?|branch(?:es)?|commits?|git|diffs?|pull\\s+requests?|prs?|merge\\s+conflicts?|rebase|builds?|compil(?:e|er|ation)|tests?|test\\s+suite|lint(?:er|ing)?|type\\s*checks?|type\\s+errors?|ci|pipelines?|deploy(?:s|ment|ments)?|scripts?|functions?|methods?|class(?:es)?|modules?|components?|endpoints?|apis?|bugs?|stack\\s+traces?|migrations?|schemas?|databases?|sql|dependenc(?:y|ies)|npm|yarn|pnpm|pip|brew|cargo|docker|containers?|kubernetes|k8s|servers?|tunnels?|ssh|cron|env\\s+vars?|environment\\s+variables?|config(?:uration)?s?|code|coding|refactor|terminal|shell|command\\s+line|cli|commands?|readme|logs?|crash(?:es)?|regressions?|features?|landing\\s+page|web\\s*app|frontend|backend|unit\\s+tests?|staging|production|prod|hover\\s+state|error\\s+messages?|abort\\s+messages?|commit\\s+messages?|props|handlers?|controllers?|css|html",
);
const codeNoun = codeNouns.any;

/** Things that live in an app or in an account: mail, chat, posts, a calendar, media. */
const contentNouns = nouns(
  "e-?mails?|mails?|inbox|messages?|texts|dms?|chats?|threads?|channels?|posts?|tweets?|feed|timeline|notifications?|mentions?|comments?|repl(?:y|ies)|calendar|meetings?|events?|invites?|invitations?|slots?|appointments?|reservations?|bookings?|flights?|hotels?|cart|checkout|spreadsheets?|slides?|decks?|presentations?|photos?|pictures?|songs?|playlists?|music|podcasts?|videos?|alarms?|timers?|contacts?|profile|bio|newsletters?|subscriptions?|receipts?|invoices?|followers|likes|stories|story|status\\s+update|unread|pdfs?|documents?|groceries|standup|call",
);
const contentNoun = contentNouns.any;
/** What a verb of making makes in an app: "write an email", "make a reservation", "add an event". */
const madeInAnApp = nouns(
  "e-?mails?|posts?|tweets?|threads?|events?|meetings?|playlists?|reservations?|appointments?|alarms?|timers?|invites?|invitations?|bookings?|calendar\\s+events?|channels?|contacts?|notes?|slides?|spreadsheets?",
);

/** Parts of the screen itself, and settings of the Mac. */
const screenNouns = nouns(
  "screen|windows?|tabs?|trash|browser|web\\s*pages?|pages?|websites?|sites?|links?|urls?|buttons?|fields?|menus?|dock|desktops?|sidebar|popups?|dialogs?|wi-?fi|bluetooth|volume|brightness|wallpaper|dark\\s+mode|light\\s+mode|do\\s+not\\s+disturb|settings|preferences|display",
);
const screenNoun = screenNouns.any;

/** Words that describe how software behaves: "cancel the old subscription when they upgrade". */
const describesSoftware =
  /\b(?:when(?:ever)?|if|once|after|before|unless|so\s+that)\s+(?:they|the\s+users?|users?|someone|people|a\s+user|customers?|the\s+customer|visitors?)\b|\b(?:on\s+(?:hover|click|submit|load|error))\b/i;

/**
 * Apps and accounts that a person names. A name that is also a plain word
 * ("mail", "notes", "pages", "x") counts only after "on", "in", "from" and
 * the like, or before "app".
 */
const namedApp =
  /\b(?:twitter|gmail|slack|discord|whatsapp|telegram|imessage|outlook|notion|figma|spotify|safari|chrome|firefox|linkedin|youtube|reddit|instagram|facebook|netflix|keynote|excel|powerpoint|facetime|textedit|dropbox|icloud|jira|trello|asana|google\s+(?:docs?|sheets?|slides|calendar|drive|meet|maps|search)|app\s+store|system\s+(?:settings|preferences)|x\.com)\b/i;
const placedApp =
  /\b(?:on|in|into|from|to|via|using|inside|through)\s+(?:the\s+|my\s+)?(?:x|google|messages|mail|calendar|notes|reminders|preview|pages|numbers|word|teams|zoom|music|photos|finder|maps|linear|github|settings|clock|calculator|weather|news|stocks|books|podcasts|tv)\b(?!\s*(?:-|\.)\w)|\b(?:messages|mail|calendar|notes|reminders|preview|pages|numbers|word|teams|zoom|music|photos|finder|maps|clock|calculator|weather)\s+app\b|\bx\s+(?:posts?|feed|timeline|account|profile|dms?|notifications?|threads?|replies|mentions|followers)\b/i;
/** The service X, written as its capital letter: "my latest X posts". */
const capitalX = /(?:^|[^\p{L}\p{N}])X(?:[^\p{L}\p{N}]|$)/u;
/**
 * A name with a capital letter after "on", "from", "via" or "using": "order
 * filters on Acme", "download the invoice from Acme". Days, months and the
 * Mac itself are none. A name after "in" can be a city ("what time is it in
 * Tokyo"), so it counts only in the list above.
 */
const capitalPlace =
  /\b(?:on|from|via|using)\s+(?!(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|Mac|I|A|The|My)\b)[A-Z][\p{L}\p{N}]+/u;
/** A place on the screen after "on" or "in": "on this page", "in the browser", "in that tab". */
const screenPlace =
  /\b(?:on|in|into|from|at)\s+(?:this|that|the|my|a\s+new)\s+(?:page|tab|window|site|website|screen|browser|app)\b|\b(?:search|ask|use|open|check)\s+google\b/i;
const appNamed = (text: string) =>
  namedApp.test(text) ||
  screenPlace.test(text) ||
  placedApp.test(text) ||
  capitalX.test(text) ||
  (capitalPlace.test(text) && !namesCodingAgent(text));
/** A web address, also said with "dot": "news dot example dot com". */
const webAddress =
  /\b[\p{L}\p{N}-]+(?:\.|\s+dot\s+)(?:[\p{L}\p{N}-]+(?:\.|\s+dot\s+))*(?:com|org|net|io|app|dev|co|ai|in|uk|de|edu|gov|me|tv|so|xyz)\b/iu;

/** Verbs of work that a screen can do. Their thing decides whether it is work on the screen. */
const actionVerb =
  /^(?:click|tap|double[-\s]?click|right[-\s]?click|scroll|swipe|drag|reply|respond|retweet|repost|tweet|dm|rsvp|unsubscribe|subscribe|book|reserve|reschedule|like|unlike|follow\s+up|forward|archive|google|browse|navigate|visit|play|pause|skip|mute|unmute|log\s+in|sign\s+in|log\s+out|sign\s+out|refresh|reload|bookmark|upvote|downvote|favou?rite|snooze|text|e-?mail|message|join|accept|decline|attach|upload|download|print|unfollow|follow|block|pin|unpin|star|flag|mark|type|press|hit|select|highlight|copy|paste|minimi[sz]e|turn(?:\s+(?:on|off|up|down))?|enable|disable|connect|disconnect|order|buy|purchase|shop|checkout|fill\s+(?:out|in)|sign|draft|compose|post|share|comment|send|schedule|cancel|go\s+back|go\s+forward|look\s+up|search|find|check|read|review|summari[sz]e|go\s+through|catch\s+up|look|see|view|show|open|close|quit|switch|bring\s+up|pull\s+up|go|watch|listen|set|set\s+up|change|save|move|rename|delete|clear|clean\s+up|organi[sz]e|add|create|make|write|edit|update|start|answer|invite|remove|empty|sort|filter)$/i;
/** Verbs that are work on the screen whatever their thing is: "reply to Sam", "rsvp yes", "scroll down". */
const screenOnlyVerb =
  /^(?:click|tap|double[-\s]?click|right[-\s]?click|scroll|swipe|drag|reply|respond|retweet|repost|tweet|dm|rsvp|unsubscribe|book|reserve|reschedule|follow\s+up|forward|archive|google|browse|navigate|refresh|reload|bookmark|upvote|downvote|snooze|text|e-?mail|message|unmute|mute|type|press|hit|log\s+in|sign\s+in|log\s+out|sign\s+out|look\s+up)$/i;
/** Verbs that only look: what they do changes nothing on the screen. */
const readVerb =
  /^(?:check|read|summari[sz]e|go\s+through|catch\s+up|look|see|view|show|scan|review|list|describe)$/i;
/** Verbs that look at a place or move to it: their place decides. */
const lookVerb =
  /^(?:open|show|go|look|check|review|read|view|visit|navigate|browse|refresh|reload|see|summari[sz]e|go\s+through|pull\s+up|bring\s+up|find|search|watch|close|switch|scroll|click)$/i;
/** Verbs that only code work has. */
const codeVerb =
  /^(?:refactor|debug|implement|compile|deploy|commit|merge|rebase|lint|typecheck|scaffold|push|clone|fork|install|uninstall|upgrade|bump|migrate|revert|cherry[-\s]?pick|stash|test|ship|release|benchmark)$/i;
/** Verbs that make something: their thing decides whether that is software. */
const makeVerb =
  /^(?:build|make|create|develop|design|write|add|set\s+up|spin\s+up|generate|code)$/i;
const fixVerb = /^(?:fix|repair|debug|patch|resolve|solve|investigate)$/i;
const runVerb = /^(?:run|rerun|re-run|execute|start|restart|kill)$/i;
/** What software work makes. */
const softwareThing =
  /\b(?:landing\s+page|web\s*site|website|web\s*app|apps?|application|site|dashboard|apis?|endpoints?|features?|components?|scripts?|functions?|tests?|cli|bots?|tools?|extensions?|plugins?|library|server|database|schema|migration|readme|pull\s+request|pr|branch|repo|repository|module|class|unit\s+tests?|integration|dark\s+mode|login\s+page|signup\s+page|settings\s+page|pricing\s+page|status\s+page|page\s+for\s+(?:the|our|my)\s+(?:app|site|product))\b/i;
/** "Add Sam to the meeting", "add milk to my cart": the thing goes into a thing of an app. */
const intoAnAppThing =
  /\b(?:to|into)\s+(?:the|my|our|this|that)\s+(?:meeting|call|calendar|cart|basket|playlist|channel|chat|thread|invite|event|list|group|board|folder|album|contacts)\b/i;
/** "Add a dark mode to it", "add a footer to the site": the thing goes into a piece of software. */
const intoSoftware =
  /\bto\s+(?:it|them|the\s+(?:app|site|website|page|dashboard|component|code|repo|project|landing\s+page|header|footer))\b/i;

/** Two words that make one verb: "follow up", "log in", "turn on". */
const twoWordVerb =
  /^(follow\s+up|log\s+in|sign\s+in|log\s+out|sign\s+out|look\s+up|look\s+at|look\s+for|go\s+to|go\s+back|go\s+forward|go\s+through|catch\s+(?:me\s+|us\s+)?up|turn\s+(?:on|off|up|down)|pull\s+up|bring\s+up|set\s+up|spin\s+up|fill\s+(?:out|in)|clean\s+up|switch\s+to|check\s+out|double[-\s]click|right[-\s]click|cherry[-\s]pick)\b/i;

/** The verb that opens a clause, and the words after it. */
function verbOf(clause: string): { verb: string; rest: string } {
  const two = twoWordVerb.exec(clause);
  const verb = two
    ? two[1]!
        .replace(/\s+/g, " ")
        .replace(/^catch (?:me |us )?up$/i, "catch up")
    : (/^[\p{L}-]+/u.exec(clause)?.[0] ?? "");
  const rest = clause
    .slice(two ? two[0].length : verb.length)
    .trim()
    .replace(/^(?:me|us)\s+/i, "");
  // "look at", "look for", "go to", "switch to", "check out" read as their first word.
  return {
    verb: verb
      .replace(/^(look|go|switch)\s+(?:at|for|to)$|^(check)\s+out$/i, "$1$2")
      .toLowerCase(),
    rest,
  };
}

/** The thing of a clause: the words after its verb, up to the first word that leads to another thing. */
const objectOf = (rest: string) =>
  rest.split(
    /\s+(?:about|for|to|on|in|into|at|from|with|of|that|which|who|so|because|by|via|using|when|if|before|after|until|and|or|but|without)\b/i,
    1,
  )[0]!;

/** A clause that says how a thing is, not what to do: "cancel flow needs a confirm dialog", "the page is slow". */
const isAStatement =
  /^\S+(?:\s+\S+){0,3}?\s+(?:needs?|is|are|was|were|should|must|has|had|looks?|seems?|does|doesn['\u2019]?t|isn['\u2019]?t|won['\u2019]?t|can['\u2019]?t|keeps?|feels?|works?|broke|crashed|fails?|failed)\b/i;

/** Words of time at the end of a thing: "a meeting next week", "the post tomorrow". */
const timeAtTheEnd =
  /(?:\s+(?:today|tonight|tomorrow|yesterday|now|soon|next\s+\w+|this\s+(?:morning|afternoon|evening|week|month|weekend)|at\s+\d[\w:]*(?:\s*[ap]m)?|\d{1,2}(?::\d{2})?\s*[ap]m|in\s+a\s+bit|on\s+\w+day))+$/i;

/** The last words of a thing, with no mark after them. */
const lastWords = (thing: string) =>
  thing
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(timeAtTheEnd, "")
    .replace(/\s+(?:up|down|on|off|out|away)$/i, "");

/**
 * Which road one clause of work takes, or null when its words do not say
 * for sure. The thing of the verb decides, by its last words: "open the PR
 * page" is a page, "open the button component" is code.
 */
function partOf(clause: string): Part {
  const text = clause
    .trim()
    .replace(/^(?:(?:please|just|also|now|then|and|after\s+that)[,]?\s+)+/i, "")
    .trim();
  if (!text) return null;
  const placed =
    /^((?:in|on|within|inside|at|from)\s[^,]{1,100}),\s*(.+)$/i.exec(text);
  if (placed) return partOf(`${placed[2]} ${placed[1]}`);
  if (namesCodingAgent(text) || terminalWork(text)) return "code";
  if (describesSoftware.test(text) || isAStatement.test(text)) return null;
  const { verb, rest } = verbOf(text);
  const thing = lastWords(
    objectOf(rest.replace(/^(?:on|to|at|for|in|into|with|about|from)\s+/i, "")),
  );
  const app = appNamed(text) || webAddress.test(text);
  const code = codeNoun.test(text);
  const codeThing = codeNouns.last.test(thing);
  const screenThing = screenNouns.last.test(thing);
  const contentThing = contentNouns.last.test(thing);
  const looks = readVerb.test(verb) ? "reads" : "screen";
  // Verbs that only code work has: "deploy it", "merge the branch". "Push
  // the button" is the screen's.
  if (codeVerb.test(verb))
    return !code && (screenThing || contentThing || app) ? "screen" : "code";
  // Making something: software ("build a landing page", "add a dark mode
  // to it"), or a thing in an app ("write an email to the landlord", "make
  // a reservation"). Anything else ("make the abort message clearer", "make
  // a form for signups") can be either.
  if (makeVerb.test(verb)) {
    if (softwareThing.test(thing) || intoSoftware.test(rest) || codeThing)
      return "code";
    if (
      !code &&
      (madeInAnApp.last.test(thing) || app || intoAnAppThing.test(rest))
    )
      return looks;
    return null;
  }
  // Fixing something: code, unless an app is named and no code ("fix the
  // typo in my Google Doc").
  if (fixVerb.test(verb)) return code ? "code" : app ? "screen" : null;
  if (runVerb.test(verb) && code) return "code";
  // A verb that looks or moves, and a page, a tab, an app or an address:
  // "open the PR page", "review the PR on GitHub", "refresh the browser".
  if (lookVerb.test(verb) && (screenThing || app)) return looks;
  // A thing of code: "check the logs", "update the dependencies".
  if (codeThing) return "code";
  if (code) return null;
  // Verbs that are work on the screen whatever their thing is: "reply to
  // Sam", "book the 3pm slot", "follow up on my latest X posts".
  if (screenOnlyVerb.test(verb) && rest.length > 0) return looks;
  // Another verb of the screen, with a thing of an app or of the screen as
  // its thing, or an app named: "check my email", "accept the invite from
  // Jane", "set an alarm", "turn on dark mode", "cancel my 3pm meeting".
  if (actionVerb.test(verb) && (contentThing || screenThing || app))
    return looks;
  // A verb that only looks, with a thing of an app or of the screen later in
  // the clause: "see what Priya said in the design channel", "summarize the
  // article in the front tab".
  if (readVerb.test(verb) && (contentNoun.test(rest) || screenNoun.test(rest)))
    return "reads";
  // A search names its thing after "for": "search for flights to Tokyo".
  if (
    /^(?:search|find|look\s+up|look)$/i.test(verb) &&
    /\bfor\b/i.test(rest) &&
    (contentNoun.test(rest) || screenNoun.test(rest))
  )
    return "screen";
  return null;
}

/** "Open Chrome", "launch Slack", "go to example.com in Safari": only an app or an address to open. */
const opensOnly = (clause: string) => {
  const text = clause.trim();
  const found =
    /^(?:open|launch|start|bring\s+up|pull\s+up|switch\s+to|go\s+to|focus|activate)\s+(?:up\s+)?(?:the\s+|my\s+)?(.{1,60}?)(?:\s+(?:app|application))?(?:\s+(?:in|on|with|using)\s+(?:the\s+)?([\p{L}\p{N} .-]{1,30}))?$/iu.exec(
      text,
    );
  if (!found) return false;
  const target = found[1]!;
  if (contentNoun.test(target) || codeNoun.test(target)) return false;
  if (webAddress.test(target)) return true;
  if (screenNoun.test(target)) return false;
  return target.split(/\s+/).length <= 3;
};

/** Where one clause of work ends and the next begins. */
/** Every verb that the readers above know, as one list: a clause of work opens with one of them. */
const knownVerbs = [actionVerb, codeVerb, makeVerb, fixVerb, runVerb]
  .map((verbs) => verbs.source.replace(/^\^\(\?:/, "").replace(/\)\$$/, ""))
  .join("|");
const joiner = new RegExp(
  `\\s*(?:,\\s*(?:and\\s+)?then\\s+|;\\s*(?:then\\s+)?|\\s+and\\s+then\\s+|\\s+then\\s+|,?\\s+(?:and\\s+)?after\\s+that,?\\s+|,?\\s+once\\s+(?:that(?:['\u2019]s|\\s+is)|it(?:['\u2019]s|\\s+is))\\s+done,?\\s+|[.!]\\s+(?:then\\s+)?|,?\\s+and\\s+(?=(?:${knownVerbs}|tell)\\b)|,\\s+(?=(?:${knownVerbs}|tell)\\b))`,
  "i",
);

/** Words that put the message off, take it back, or speak of it only. */
const notNow =
  /\b(?:never\s*mind|nvm|scratch\s+that|forget\s+(?:it|that|about\s+it)|hold\s+off|not\s+now|not\s+yet|until\s+i\s+say|when\s+i\s+say|wait\s+for\s+my|for\s+example|hypothetical(?:ly)?|what\s+if|(?:he|she|they|someone|somebody)\s+(?:said|says|asked|wants|wrote)|later|when\s+i(?:['\u2019]m|\s+am)\s+back)\b|\b(?:do\s+not|don['\u2019\u2018\u00b4\u02bc\u2032`]?t|dont|never)\b/i;
/** Text in quotes is the person's quote of something, not their request: it may hold words of a page or a note. */
const quotes = /["\u201c\u201d]/;
/** Words for what ClawdTime itself keeps: sessions, agents, jobs, tasks, requests, memory, calls. */
const ownThings =
  /\b(?:sessions?|agents?|jobs?|tasks?|(?<!pull\s)requests?|clawdtime|yourself|remember|remind\s+me|reminders?|memory|let\s+me\s+know|tell\s+me\s+when|keep\s+(?:an\s+)?eye|heads[-\s]up|call\s+me|away\s+mode|i(?:['\u2019]m|\s+am)\s+(?:away|leaving|back)|computer\s+(?:use|task|status|on|off)|share\s+(?:my\s+|the\s+)?screen|screen\s+shar\w*|(?:whole|entire|full)\s+screen|full\s*screen|fill\s+the\s+screen|zoom\s+(?:in|out)|bigger|larger|smaller|text\s+size|font\s+size)\b/i;
/** Words for someone or something that runs: "tell deploy fix to run the tests", "ask it to stop". */
const wordsForSomeone =
  /^(?:tell|ask)\s+(?!me\b|us\b)[^,.!?:]{1,40}?\s+(?:to|that)\b|^(?:tell|ask)\s+[^:]{1,40}:/i;
/** A stop by itself belongs to the stop of the engine, never to a new task. */
const opensWithStop =
  /^(?:stop|abort|halt)\b|^cancel(?:\s+(?:it|that|this|everything|all|now|the\s+(?:task|job|computer|screen)))?$/i;
/** Thanks, praise or a word of assent, and nothing more. */
const onlyAssent =
  /^(?:thanks|thank\s+you|thx|ty|cheers|great|nice|perfect|awesome|cool|ok(?:ay)?|got\s+it|sounds\s+good|yes|yeah|yep|no|nope|nah|sure|fine|good|lol|haha)\b[\s\S]{0,24}$/i;

/** A question: a question word opens it, or it ends with a question mark and is no polite request. */
const asksSomething = (text: string, polite: boolean) =>
  /^(?:what(?:['\u2019]s)?|whats|who(?:['\u2019]s)?|whom|whose|when|where|why|how|which|any|anything|should|shall|may|might|could\s+i|can\s+i)\b/i.test(
    text,
  ) ||
  // "Is it open", "did Sam reply": a verb of a question before its subject.
  // "Have it send me an email" asks something to be done.
  /^(?:is|are|am|was|were|do|does|did|has)\s+(?:i|you|we|they|it|he|she|there|this|that|these|those|the|my|our|your|any|[\p{Lu}][\p{L}]*)\b/u.test(
    text.charAt(0).toLowerCase() + text.slice(1),
  ) ||
  (!polite && /\?\s*$/.test(text));

/**
 * A question about what ClawdTime can do, asked like a request: "can you
 * click buttons on my screen?", "can you use my browser?", "are you able to
 * read my mail?". It asks for nothing to be done.
 */
const asksWhatItCan = (original: string, body: string, polite: boolean) => {
  if (
    /\b(?:are\s+you\s+able|do\s+you\s+know\s+how|is\s+it\s+possible|what\s+can\s+you|can\s+you\s+(?:even|actually|really|ever)|be\s+able\s+to|in\s+general|at\s+all)\b/i.test(
      original,
    )
  )
    return true;
  if (!polite || !/\?\s*$/.test(original)) return false;
  const { verb, rest } = verbOf(body);
  // "Can you do that?", "can you use my browser?", "can you see my screen?"
  if (
    /^(?:do|use|see|control|access|handle|operate|drive|run)$/i.test(verb) &&
    /^(?:(?:that|this|it|things|stuff|my\s+(?:browser|computer|screen|mac|mouse|keyboard|apps?)|the\s+(?:browser|computer|screen|mac|mouse|keyboard)|apps|browsers|websites|computers)\b|$)/i.test(
      rest,
    )
  )
    return true;
  // "Can you click buttons?": a thing in the plural with no word that points at one.
  return /^(?:[\p{L}-]+s)(?:\s+(?:on|in|for)\s+(?:my|the|a)\s+\w+)?$/iu.test(
    rest.trim(),
  );
};

/** A short question about whether something is open, running or done: the state, not a reading. */
const asksTheState =
  /^(?:is|are|was|were)\s+(?:it|that|this|they|we|the\s+[\p{L}\p{N}-]+|[\p{L}\p{N}-]+)\s+(?:still\s+)?(?:open|opened|running|loaded|ready|done|installed|on|up|working|finished|closed|sent|signed\s+in|logged\s+in)\b|^(?:did|has|have)\s+(?:it|that|this|they|you|we|the\s+[\p{L}\p{N}-]+)\s+(?:already\s+)?(?:load|loaded|open|opened|send|sent|finish|finished|work|worked|go\s+through|gone\s+through|submit|submitted|upload|uploaded|download|downloaded|save|saved|close|closed|post|posted)\b/iu;

/** A clause whose thing is only a word that points back: "push it", "send that", "tell me what it says". */
const thin = (clause: string) =>
  /^(?:(?:please|just|also|now|then|and)\s+)*(?:tell|show|give|read)\s+(?:me|us)\b/i.test(
    clause.trim(),
  ) ||
  /^(?:(?:please|just|also|now|then|and)\s+)*[\p{L}-]+(?:\s+(?:up|out|back|over|in|on|off|down))?(?:\s+(?:it|that|this|them|those|these|one|everything|all))?(?:\s+(?:too|again|as\s+well|now|please))?[.!]*$/iu.test(
    clause.trim(),
  );

/**
 * The road of one message. Pure: it reads only the words.
 */
export function roadOf(text: string): Road {
  const original = text.replace(/\s+/g, " ").trim();
  if (!original || original.length > 2000) return answer;
  const { body, polite } = requestWords(original);
  const words = body.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < 2) return answer;
  if (onlyAssent.test(body) && !polite) return answer;
  if (opensWithStop.test(body)) return answer;
  if (
    notNow.test(original) ||
    ownThings.test(original) ||
    quotes.test(original)
  )
    return answer;
  if (asksWhatItCan(original, body, polite)) return answer;
  if (wordsForSomeone.test(body) && !namesCodingAgent(body)) return answer;
  const opening = original.replace(fillers, "");
  if (asksSomething(opening, polite)) {
    // A question asks for a reading of the screen when it names an app or a
    // thing on it, and no code: "what's on my calendar today?", "did Sam
    // reply on Slack?", "any new emails?".
    if (
      /^how\s+(?:do|can|should|would|to)\b|^(?:should|shall|could|can|may|might)\s+(?:i|we)\b|\bmean\b|\bexplain\b/i.test(
        opening,
      ) ||
      asksTheState.test(opening) ||
      codeNoun.test(original) ||
      namesCodingAgent(original) ||
      terminalWork(original)
    )
      return answer;
    return contentNoun.test(original) ||
      appNamed(original) ||
      /\b(?:e-?mailed|texted|messaged|dm(?:ed|['\u2019]d)|replied|posted|tweeted|commented|mentioned|invited|called)\b/i.test(
        original,
      ) ||
      /\b(?:screen|tabs?|browser|web\s*pages?|this\s+page|the\s+page|websites?)\b/i.test(
        original,
      )
      ? { kind: "engine", reads: true }
      : answer;
  }
  const clauses = body
    .split(joiner)
    .map((clause) => clause.trim())
    .filter(Boolean)
    // "In the Notes window, click Save": a place that opens the message is
    // part of the clause after it.
    .reduce<string[]>((all, clause) => {
      const before = all.at(-1);
      if (
        before !== undefined &&
        /^(?:in|on|within|inside|at|from)\s/i.test(before) &&
        !/,/.test(before)
      )
        all[all.length - 1] = `${before}, ${clause}`;
      else all.push(clause);
      return all;
    }, []);
  if (clauses.every(opensOnly)) return answer;
  const parts = clauses.map(partOf);
  // A clause with no thing of its own goes with the one before it ("fix the
  // test and push it", "check my mail and tell me what Sam said"). A clause
  // with a thing of its own that this reader cannot place makes the whole
  // message one for the language model: "open the login page and add a
  // forgot password link" is code work as much as screen work.
  for (const [index, part] of parts.entries())
    if (part === null && !thin(clauses[index]!)) return answer;
  for (let index = 1; index < parts.length; index++)
    if (parts[index] === null) parts[index] = parts[index - 1]!;
  for (let index = parts.length - 2; index >= 0; index--)
    if (parts[index] === null) parts[index] = parts[index + 1]!;
  if (parts.every((part) => part === null)) return answer;
  const code = clauses.filter((_, index) => parts[index] === "code");
  const screen = clauses.filter((_, index) => parts[index] !== "code");
  const reads = parts.every((part) => part !== "screen");
  if (code.length && screen.length)
    return {
      kind: "both",
      code: code.join(", then "),
      screen: screen.join(", then "),
      reads,
    };
  if (code.length) return { kind: "job" };
  return { kind: "engine", reads };
}

/** "my" becomes "your", so that ClawdTime can say the person's work back to them. */
export const toThem = (text: string) =>
  text
    .replace(/\bmy\b/gi, "your")
    .replace(/\bmine\b/gi, "yours")
    .replace(/\bmyself\b/gi, "yourself")
    .replace(/\bme\b/gi, "you")
    .replace(/\bI(?:['\u2019]m|\s+am)\b/g, "you're")
    .replace(/\bI\b/g, "you");

/**
 * What ClawdTime says for work on the screen while computer use is off. It
 * never says "I cannot": it says what it would do, and the one command that
 * turns computer use on. `restart` adds the start of the desktop service,
 * for a brain that has no worker yet.
 */
export function computerOffReply(work: string, restart: boolean): string {
  const { body } = requestWords(work);
  const said = toThem(body).replace(/[.!?]+$/, "");
  const what =
    said && said.length <= 120 && !/["\n]/.test(said)
      ? `I'd ${said.charAt(0).toLowerCase()}${said.slice(1)} on the screen`
      : "I'd do that on the screen";
  return `${what}, but computer use is off. Turn it on with: clawdtime computer on${restart ? ", then start the desktop service again" : ""}. Then ask me again.`;
}
