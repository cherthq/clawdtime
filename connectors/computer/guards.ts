/**
 * Computer use: the checks on one planned action.
 *
 * The planner's output is an untrusted single-action plan. Every action goes
 * through `check` before anything is sent, and through `retarget` and `check`
 * again against a look that is taken just before it is sent. The rules live
 * here, in code. The prompt of the planner repeats some of them, but nothing
 * depends on the planner following its prompt.
 */
import { z } from "zod";
import type {
  Action,
  BrowserElement,
  BrowserPage,
  BrowserPort,
  BrowserTab,
  DragEnd,
  HandCommand,
  Observation,
  ScreenElement,
} from "./ports.js";
import { parsePageKey, type PageKey } from "./browser-script.js";
import { closerSecureText, secureInArea } from "./closer.js";
import { sameWindowTitle } from "./desktop.js";

const finite = z.number().finite();
const number = z.number().int().nonnegative();
const words = (limit: number) => z.string().max(limit);
const direction = z.enum(["up", "down"]);
const flag = z.boolean().optional();
/** One end of a drag: an element, or a point of the last image. Never both. */
const dragEnd = z.union([
  z.object({ element: number }).strict(),
  z.object({ x: finite, y: finite }).strict(),
]);

/** One action, exactly as the contract lists it. Anything else is refused. */
export const actionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("click_element"),
      element: number,
      double: flag,
      right: flag,
    })
    .strict(),
  z
    .object({
      kind: z.literal("click_at"),
      x: finite,
      y: finite,
      double: flag,
      right: flag,
    })
    .strict(),
  z
    .object({
      kind: z.literal("type"),
      text: words(4000),
      element: number.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("key"), combo: words(40) }).strict(),
  z
    .object({
      kind: z.literal("scroll"),
      direction,
      element: number.optional(),
      amount: z.number().int().min(1).max(10).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("hover"),
      element: number.optional(),
      x: finite.optional(),
      y: finite.optional(),
    })
    .strict()
    // Exactly one of the two: an element, or a whole point.
    .refine((action) =>
      action.element !== undefined
        ? action.x === undefined && action.y === undefined
        : action.x !== undefined && action.y !== undefined,
    ),
  z.object({ kind: z.literal("drag"), from: dragEnd, to: dragEnd }).strict(),
  z
    .object({
      kind: z.literal("open_app"),
      name: words(120),
      window: words(200).min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("open_url"),
      url: words(2000),
      browser: words(120).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("quit_app"), name: words(120) }).strict(),
  z.object({ kind: z.literal("browser_read") }).strict(),
  z.object({ kind: z.literal("browser_open"), url: words(2000) }).strict(),
  z.object({ kind: z.literal("browser_click"), index: number }).strict(),
  z
    .object({
      kind: z.literal("browser_type"),
      index: number,
      text: words(4000),
      submit: flag,
    })
    .strict(),
  z.object({ kind: z.literal("browser_scroll"), direction }).strict(),
  z.object({ kind: z.literal("browser_back") }).strict(),
  z.object({ kind: z.literal("browser_hover"), index: number }).strict(),
  z
    .object({
      kind: z.literal("browser_select"),
      index: number,
      option: words(400),
    })
    .strict(),
  z.object({ kind: z.literal("browser_key"), combo: words(40) }).strict(),
  z
    .object({
      kind: z.literal("browser_wait"),
      text: words(200).optional(),
      ms: z.number().int().min(100).max(10_000),
    })
    .strict(),
  z.object({ kind: z.literal("browser_tabs") }).strict(),
  z
    .object({
      kind: z.literal("browser_switch_tab"),
      tab: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("wait"),
      ms: z.number().int().min(0).max(10_000),
    })
    .strict(),
  z.object({ kind: z.literal("look_closer"), x: finite, y: finite }).strict(),
  z.object({ kind: z.literal("ask"), question: words(2000) }).strict(),
  z.object({ kind: z.literal("done"), summary: words(4000) }).strict(),
  z.object({ kind: z.literal("give_up"), reason: words(2000) }).strict(),
]) satisfies z.ZodType<Action>;

/** One clean line: no control character, no run of spaces. */
export const clean = (value: string, limit: number) =>
  value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, limit);

/** One row of the policy: what asks for the person's yes, and why. */
export interface PolicyRow {
  /** What asks, in plain words. */
  asks: string;
  /** When the person's own request already said yes to it. Null: never. */
  unless: string | null;
  /** Why the yes is needed. It ends the question. */
  reason: string;
}

/**
 * The policy: the only actions that need the person's yes. A question can
 * reach a person who is away, by a call or a message, so it is asked only
 * before what cannot be undone and costs money, data or trust. Everything
 * else goes with no question: opening and quitting apps, closing what loses
 * nothing, a plain OK, a cookie banner, a download, a move, a scroll, a link,
 * a cart and the pages of a checkout before its last step.
 *
 * Every question of the checks comes from one row of this table, and ends
 * with the reason of its row. `nameRules` say which names belong to a row.
 */
export const askPolicy = {
  pay: {
    asks: "Paying or placing an order: Buy, Pay, Place order, the last step of a checkout, a Continue where the screen says that it charges, Subscribe, Donate, Send money, a Transfer of an amount, Book, Rent, a button that is only a price, and the same names in other languages.",
    unless: null,
    reason: "It spends your money.",
  },
  loss: {
    asks: "What is lost for good: Delete forever, Empty Trash, Erase, Delete account, Uninstall, Terminate, Factory reset, Revoke, Overwrite, Shut down, a log out of the Mac, a Delete, Remove or OK where the screen says that it cannot be undone, a Replace of a file that exists, a terminal command that deletes for good, and one that moves files that the request does not name.",
    unless: null,
    reason: "What it removes is gone for good.",
  },
  unsaved: {
    asks: "Losing changes that are not saved: Don't Save, Discard, Revert, a button of a sheet that asks to save (also its Delete for a new document that was never saved), a quit or a close while the window shows unsaved work, a force quit of an app, and a stop of a process that is no app.",
    unless:
      "The request asks to lose the changes: without saving, discard, throw away, revert.",
    reason: "Changes that are not saved are lost.",
  },
  send: {
    asks: "Sending as you to other people: Send, Reply, Reply All, Forward, Post, Comment, Publish, Submit, Share, Return in a messages app, a command that publishes, and an address with a long part that you did not write.",
    unless:
      "The request asks for a send of that kind, to the people that the screen shows: reply, send, post. Reply All, Forward and Share need their own verb. Text me or tell me asks for no send. An address with a long part asks always.",
    reason: "It sends as you to other people.",
  },
  public: {
    asks: "Acting as you in public: Like, Follow, Repost, Upvote.",
    unless: "The request asks to like, follow or repost.",
    reason: "It acts as you in public.",
  },
  account: {
    asks: "Security and accounts: a password, two-factor, recovery, privacy or visibility setting, a switch of the security and privacy settings of macOS, and a terminal command that runs as an administrator, changes the security of the Mac or runs code from the web.",
    unless: null,
    reason: "It changes the security or the privacy of your account.",
  },
  grant: {
    asks: "A yes in your place: Allow, OK, Approve or Trust in a permission dialog of macOS, of a site, of a sign-in that asks for access to an account, or of ClawdTime, and a name that grants access.",
    unless: null,
    reason: "It gives access in your place.",
  },
  terms: {
    asks: "Agree or Accept for terms that bind you. A cookie banner with no words of binding terms is not such terms.",
    unless: null,
    reason: "It accepts terms that bind you.",
  },
  terminal: {
    asks: "Typing or a key in a terminal, and a paste into one, and a drop onto one.",
    unless:
      "The request asks for terminal work: a command, a script, a build, a test, git. A paste and a drop ask always.",
    reason:
      "Text in a terminal runs as a command, and your request did not ask for one.",
  },
  trash: {
    asks: "A drag that drops onto the Trash.",
    unless: null,
    reason: "It moves what it drags to the Trash.",
  },
  secret: {
    asks: "A drag that starts in a password field.",
    unless: null,
    reason: "It could carry your password somewhere else.",
  },
} as const satisfies Record<string, PolicyRow>;
export type AskKind = keyof typeof askPolicy;
/** Why the person's yes is needed: the row, and the reason that the question says. */
export interface Ask {
  kind: AskKind;
  reason: string;
}
const ask = (kind: AskKind, reason: string = askPolicy[kind].reason): Ask => ({
  kind,
  reason,
});

/**
 * A name as the rules read it: lower case, straight apostrophes, a hyphen as
 * a space, and no accents, so that the rules of other languages are plain
 * letters: an umlaut reads as its vowel.
 */
const plain = (value: string) =>
  clean(value, 600)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[-_\u2010-\u2015]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
/**
 * A name that ends with an ellipsis. Only a menu item of macOS that ends with
 * one opens a dialog first. A web page writes its labels as it likes, so there
 * an ellipsis lifts nothing.
 */
const trailingDots = /\s*(?:\u2026|\.\.\.)$/;

/** What a name is judged in. */
interface Scene {
  /** The person's own request. Empty once they said more: then it asks for nothing. */
  goal: string;
  /** What the screen or the page shows, as one plain text: the window, the names, the page. */
  text: string;
  /** The app in front, for a name on the screen. */
  app?: Observation["app"];
  /** The people that a message goes to, as the screen or the page shows them: "To: Jane". */
  to: string[];
}
/** The people of one label of recipients and its value: "To: Sam, Jane" is two. */
function recipientsOf(label: string, value: string | undefined) {
  const said = plain(label);
  // A label of a field ends with a colon, or is the word alone.
  const found = /^(to|cc|bcc)(?::\s*(.*)|$)/.exec(said);
  if (!found) return [];
  const names = found[2]?.trim() || plain(value ?? "");
  return names
    .split(/[,;]|\band\b/)
    .map((name) => name.trim())
    .filter(Boolean);
}
const screenScene = (observation: Observation, goal?: string): Scene => ({
  goal: goal ?? "",
  text: plain(
    [
      observation.app.window,
      ...observation.elements.map((item) => item.title),
    ].join("\n"),
  ),
  app: observation.app,
  to: observation.elements.flatMap((item) =>
    item.secure ? [] : recipientsOf(item.title, item.value),
  ),
});
const pageScene = (page: BrowserPage | null, goal?: string): Scene => ({
  goal: goal ?? "",
  text: page
    ? plain(
        [
          page.title,
          page.text,
          ...page.elements.map((item) => item.label),
        ].join("\n"),
      )
    : "",
  to: page
    ? page.elements.flatMap((item) =>
        item.password ? [] : recipientsOf(item.label, item.value),
      )
    : [],
});

// Words on the screen that say what is at stake.
const money =
  /(?:us\$|c\$|a\$|\$|\u20ac|\u00a3|\u20b9|\u00a5|rs\.?\s?)\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:usd|eur|gbp|inr|cad|aud|dollars?|euros?|pounds?|rupees?)\b/;
const chargeWords =
  /\b(?:total|order summary|amount due|you(?:'ll| will)? (?:pay|be charged)|charged?|billing|payment|card ending|subtotal)\b/;
const charged = (scene: Scene) =>
  money.test(scene.text) && chargeWords.test(scene.text);
/** Words that say this step charges: "your card will be charged $48.00". */
const chargeNowWords =
  /\b(?:will|'ll|is going to) be (?:charged|billed|debited)\b|\bwe(?:'ll| will) (?:charge|bill|debit)\b|\bauthori[sz]e (?:a |the |this )?(?:charge|payment)\b|\bagree to (?:be charged|pay)\b/;
const chargedNow = (scene: Scene) =>
  money.test(scene.text) && chargeNowWords.test(scene.text);
const permanentWords =
  /\b(?:cannot|can not|can't|won't be able to|unable to) (?:be )?(?:undo(?:ne)?|reverse[d]?|recover(?:ed)?|restore[d]?)\b|\bpermanent(?:ly)?\b|\birreversibl[ey]\b|\bforever\b|\bno undo\b|\bwill be lost\b|\bnicht (?:mehr )?(?:ruckgangig|wiederhergestellt)\b|\bendgultig\b|\bno se puede (?:deshacer|recuperar)\b|\bpara siempre\b|\bdefinitivamente\b|\bpermanentemente\b|\bne (?:peut|pourra) (?:pas )?etre (?:annule|recupere)|\bdefinitivement\b|\bnon (?:puo|potra) essere (?:annullat|recuperat)|\bkan niet (?:ongedaan|hersteld)\b/;
const replaceWords =
  /\balready exists\b|\breplacing it\b|\bwill (?:replace|overwrite)\b/;
const saveSheetWords =
  /\bdo you want to (?:save|keep)\b|\bsave (?:the |your )?changes\b|\bnot (?:been )?saved\b|\bunsaved changes\b|\bchanges (?:you made )?(?:will|may) (?:be lost|not be saved)\b|\bsave this (?:message|document|file) as a draft\b/;
const sessionWords =
  /\byour computer now\b|\bquit all applications\b|\bthe computer will\b|\bautomatically in \d+ seconds\b/;
const permissionWords =
  /\bwould like to:? (?:access|control|record|use|receive|find|send|connect|add|administer|make changes|read|view|see|manage|edit|delete|compose)\b|\bwants? to (?:access|use|control|record|know your location|show notifications|see|connect|make changes|install)\b|\b(?:wants?|would like|requests?|is requesting) (?:access|permission)\b|\baccess (?:to )?your (?:contacts|calendars?|reminders|photos|camera|microphone|location|files|documents|desktop|downloads|keychain|data|account|screen)\b|\b(?:full disk access|screen recording|screen & system audio recording|input monitoring|location services|keychain|administrator)\b|\bis trying to (?:install|modify|unlock|change|add)\b|\bdownloaded from the internet\b|\bunidentified developer\b|\bpermissions? (?:to|for|request(?:ed)?)\b|\brequested permissions\b|\bwill allow \S+ to (?:access|read|view|see|manage|edit|delete|send|compose)\b/;
const termsWords =
  /\b(?:terms|conditions|agreement|license|licence|eula|contract)\b/;
const cookieWords = /\bcookies?\b/;
/** Words of terms that bind, which a cookie banner does not hold. */
const bindingWords =
  /\b(?:terms of (?:service|use|sale)|terms (?:and|&) conditions|(?:user|license|licence|service|subscriber|subscription|end user) agreement|eula|arbitration|class actions?|waive|contract)\b/;
/** A cookie banner: it speaks of cookies, and holds no words of terms that bind. */
const cookieBanner = (scene: Scene) =>
  cookieWords.test(scene.text) && !bindingWords.test(scene.text);
/** The apps of macOS that ask for a permission, and ClawdTime itself. A yes there is a yes in the person's place. */
const permissionApps = new Set([
  "com.apple.usernotificationcenter",
  "com.apple.coreservices.uiagent",
  "com.apple.securityagent",
  "com.apple.localauthentication.uiagent",
  "com.apple.accessibility.universalaccessauthwarn",
]);
const asksPermission = (scene: Scene) => {
  const bundle = scene.app?.bundleId.toLowerCase() ?? "";
  return (
    permissionApps.has(bundle) ||
    bundle.startsWith("com.clawdtime.") ||
    permissionWords.test(scene.text)
  );
};

/** The fillers in front of a verb of a request: "please", "can you", "and then". */
const fillers =
  /^(?:(?:please|pls|kindly|just|now|also|then|and|so|ok|okay|hey|clawdtime|can you|could you|would you|will you|you can|you may|go ahead and|i want you to|i need you to|i'd like you to|i would like you to|help me|try to|remember to|make sure to|make sure you|feel free to|be sure to)\s+)*/;
/** A dash between two parts of the request: "on it - send it". A hyphen inside a word stays: e-mail. */
const dashBreak = /\s[-\u2013\u2014]+\s|\u2014/g;
/** Quotation marks and brackets: "Send it", (send it). An apostrophe inside a word stays: don't, Sam's. */
const quoteMarks = /["\u201c\u201d\u201e()[\]]|(?<![a-z0-9])'|'(?![a-z0-9])/g;
/** The parts of the request, each with no filler in front: "reply to sam", "send it". */
const requestParts = (goal: string) =>
  goal
    ? plain(goal.replace(dashBreak, "; "))
        .replace(quoteMarks, " ")
        .split(/[.;:!?,\n]|\b(?:and|then|also|but|after that|afterwards)\b/)
        .map((part) => part.trim().replace(fillers, ""))
    : [];
/**
 * The words after a verb that turn it to ClawdTime or to the person: "text
 * me", "message us". A request asks ClawdTime to tell the person, not to send
 * as them.
 */
const toSelf = /^(?:to )?(?:me|us|myself|ourselves)\b/;
/** A question of the person to ClawdTime: "answer the question", "reply to my question". */
const ownQuestion =
  /^(?:to )?(?:the|my|this|that|these|those|your|our|a) questions?\b/;
/** The verb of one part of the request, with the words after it. Null when the part does not start with one, or turns it to ClawdTime. */
function requestVerb(part: string, verbs: string) {
  const found = new RegExp(`^(${verbs})\\b\\s*(.*)$`).exec(part);
  if (!found) return null;
  const [, verb = "", rest = ""] = found;
  if (toSelf.test(rest)) return null;
  if (/^(?:reply|respond|answer)$/.test(verb) && ownQuestion.test(rest))
    return null;
  return { verb, rest };
}
/**
 * True when a part of the request starts with one of these verbs: "Reply to
 * Sam", "read it and reply". A noun is not a verb: "read my messages" asks
 * for no send. A denial is no verb either: "don't reply" asks for nothing.
 * Nor is a verb that turns to ClawdTime itself: "text me", "message me".
 */
const requestSays = (goal: string, verbs: string) =>
  requestParts(goal).some((part) => requestVerb(part, verbs) !== null);
const sendVerbs =
  "send|reply|respond|answer|post|tweet|publish|comment|submit|share|message|text|email|e mail|mail|dm|write back|write to|tell(?! me\\b| us\\b)|forward|invite|rsvp|announce";
/**
 * The kinds of a send. A plain send, a post or a Return goes to the person or
 * the thread that the request names. A reply goes to who wrote. A reply to
 * all, a forward and a share go wider, so only their own verb asks for them.
 */
type SendKind = "send" | "reply" | "all" | "forward" | "share";
/** The kinds of a send in the request that ask for a send of this kind. */
const sendCovers: Record<SendKind, readonly SendKind[]> = {
  send: ["send", "reply", "all", "forward", "share"],
  reply: ["reply", "all"],
  all: ["all"],
  forward: ["forward"],
  share: ["share", "send"],
};
const toAll = /^(?:to )?(?:all|everyone|everybody)\b/;
/** The kind of a send that a verb of the request asks for. */
function verbKind(verb: string, rest: string): SendKind {
  if (/^(?:reply|respond|answer|write back)$/.test(verb))
    return toAll.test(rest) ? "all" : "reply";
  if (verb === "forward") return "forward";
  if (verb === "share") return "share";
  return /^(?:\w+ )?to (?:all|everyone|everybody)\b/.test(rest)
    ? "all"
    : "send";
}
/** The kind of a send that a name, or a sentence of the planner, does. */
function nameKind(name: string): SendKind {
  if (
    /\b(?:reply|respond|answer)(?: to)? (?:all|everyone|everybody)\b|\ballen antworten\b|\bresponder a todos\b|\brepondre a tous\b|\brispondi a tutti\b/.test(
      name,
    )
  )
    return "all";
  if (/\b(?:forward|fwd|weiterleiten|reenviar|inoltra|doorsturen)\b/.test(name))
    return "forward";
  if (
    /\b(?:reply|respond|answer|antworten|responder|repondre|rispondi|beantwoorden)\b/.test(
      name,
    )
  )
    return "reply";
  if (/\b(?:share|teilen|compartir|partager|condividi|delen)\b/.test(name))
    return "share";
  return "send";
}
/** Words after "to" that name no person: a pronoun, an article, a thing. */
const noPerson =
  /^(?:it|them|him|her|this|that|these|those|the|a|an|my|our|your|his|their|its|all|everyone|everybody|me|us|whoever|anyone|someone)$/;
/** The verbs that take the person as their object: "text Mom", "email Bob". */
const personVerbs =
  /^(?:message|text|email|e mail|mail|dm|tell|invite|write to|ping)$/;
/** The people that one send of the request names: "Sam" in "reply to Sam", "Mom" in "text Mom". */
function peopleNamed(verb: string, rest: string) {
  const found: string[] = [];
  const first = /^([a-z0-9][\w'@.]*)/.exec(rest)?.[1];
  if (personVerbs.test(verb) && first && !noPerson.test(first))
    found.push(first);
  for (const match of rest.matchAll(/\b(?:to|with) ([a-z0-9][\w'@.]*)/g))
    if (!noPerson.test(match[1]!)) found.push(match[1]!);
  return found;
}
/** The words of a name of a person, with no mail domain: "jane", "doe". */
const personWords = (person: string) =>
  person
    .replace(/@[\w.-]+/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
/**
 * True when the request asks for a send of this kind, to the people that the
 * screen or the page shows. "Reply to Sam" asks for Reply and Send, not for
 * Reply All, not for a Forward, and not for a Send to Jane. A request that
 * names no person, such as "reply to it", names the thread: a send there
 * goes to who is already in it.
 */
function sendAsked(goal: string, scene?: Scene, name = "") {
  let kind = nameKind(name);
  // A Send of a forward that is written: "Fwd: Lunch".
  if (kind === "send" && /\bfwd?:/.test(scene?.text ?? "")) kind = "forward";
  const asked = requestParts(goal).flatMap((part) => {
    const found = requestVerb(part, sendVerbs);
    return found && sendCovers[kind].includes(verbKind(found.verb, found.rest))
      ? [found]
      : [];
  });
  if (!asked.length) return false;
  const named = asked.flatMap(({ verb, rest }) => peopleNamed(verb, rest));
  if (!named.length || !scene?.to.length) return true;
  // Every person that it goes to is one that the request names.
  const said = new Set(personWords(plain(goal)));
  return scene.to.every((person) =>
    personWords(person).some((word) => said.has(word)),
  );
}
const publicVerbs =
  "like|unlike|follow|unfollow|repost|retweet|upvote|downvote|react|favorite|favourite|vote|endorse";
const commandVerbs =
  "run|execute|install|build|compile|commit|push|pull|clone|deploy|rebase|merge|lint|test|debug";
const publishVerbs =
  "push|publish|deploy|release|ship|merge|open a pull request|create a pull request|send";
const denial = /\b(?:don't|do not|never|not|without|no)\s+(?:\w+\s+){0,3}$/;
/** True when the request holds these words, and no denial right before them. */
function requestHolds(goal: string, words: RegExp) {
  const said = plain(goal);
  for (const found of said.matchAll(new RegExp(words.source, "g")))
    if (!denial.test(said.slice(0, found.index))) return true;
  return false;
}
/** The request asks to lose the changes that are not saved. The chat's force quit reads it too. */
export const asksToLose = (goal: string) =>
  /\b(?:without saving|don't save|do not save)\b/.test(plain(goal)) ||
  requestHolds(
    goal,
    /\b(?:discard|throw away|revert|lose (?:the |my |all |any )?(?:changes|edits))\b/,
  );
/** The request asks for terminal work: a command, a script, a build, a test, git. */
export const asksForCommand = (goal: string | undefined) =>
  !!goal &&
  (requestHolds(
    goal,
    /\b(?:terminal|shell|command line|commands?|cli|bash|zsh|iterm|scripts?|repo|repository|codebase|source code|coding|bug|tests?|build|commit|branch|pull request|git|npm|npx|pnpm|yarn|pip3?|brew|python3?|node|cargo|xcodebuild|docker|kubectl|ssh|gh|tsc|vitest|pytest)\b/,
  ) ||
    requestSays(goal, commandVerbs));

/** One rule of names for a row of the policy. */
interface NameRule {
  kind: AskKind;
  /** At the start of a name only: "Send" and "Send now", not "Quick send". */
  start?: string;
  /** Anywhere in a name, as whole words. */
  any?: string;
  /** At the end of a name: "12 likes. Like". */
  end?: string;
  /** Only while this holds for the screen or the page. `dots`: the name ends with an ellipsis. */
  when?: (scene: Scene, dots: boolean) => boolean;
  /** Not while this holds. */
  unless?: (scene: Scene) => boolean;
  /** The request asked for it already, for this name on this screen. */
  asked?: (goal: string, scene: Scene, name: string) => boolean;
  /** A menu item with an ellipsis opens a dialog first, and asks nothing. With this, it asks. */
  dots?: true;
  /** A reason of its own, in place of the row's. */
  reason?: string;
}
/** The browsers that the worker drives: their own Forward button goes to the next page. */
const browserBundle =
  /^(?:com\.google\.chrome|com\.apple\.safari|com\.brave\.browser|com\.microsoft\.edgemac|org\.chromium\.chromium)\b/;
const browserInFront = (scene: Scene) =>
  !!scene.app && browserBundle.test(scene.app.bundleId.toLowerCase());
/**
 * Which names ask, and for which row. The first rule that fits gives the
 * row. Words count as whole words: "Sender", "Reorder", "Postpone" and
 * "Formatting" are none of them.
 */
const nameRules: readonly NameRule[] = [
  {
    kind: "pay",
    // The same in the languages that shops use most: "Jetzt kaufen", "Pagar".
    start:
      "buy|pay|purchase|subscribe|donate|book|reserve|rent|order(?: now)?$|(?:jetzt |nu )?(?:kaufen|bezahlen|bestellen|kopen|betalen)|zahlungspflichtig|kostenpflichtig|comprar|pagar|compra|paga|acquista|payer|acheter|commander",
    any: "buy (?:it )?now|pay now|pay with|apple pay|google pay|shop pay|subscribe|donate|place (?:the |your |my |this )?order|complete (?:the |your |my )?(?:order|purchase|payment|checkout|booking|reservation)|confirm (?:and pay|(?:the |your |my )?(?:order|purchase|payment|booking|reservation|subscription|transfer))|submit (?:the |your |my )?(?:order|payment)|send (?:money|payment)|transfer (?:money|funds)|make (?:a )?payment|start (?:my |your |the )?(?:free )?trial|1 click|one click|(?:passer|valider|confirmer) (?:la |ma |votre )?commande|(?:realizar|confirmar) (?:el |mi |su )?pedido|finalizar (?:la |mi |su )?compra|bestellung (?:abschicken|absenden|bestatigen)|bestelling plaatsen",
  },
  {
    // The last step of a checkout, with a total on the screen.
    kind: "pay",
    start:
      "confirm|submit|complete|finish|authori[sz]e|approve|transfer|verify|send|place|confirmar|confirmer|bestatigen|bevestigen",
    when: charged,
  },
  {
    // A step that the screen says charges: "By clicking Continue, your card will be charged $48.00."
    kind: "pay",
    start:
      "continue|next|proceed|ok|yes|done|go|start|join|sign up|upgrade|(?:i )?agree|(?:i )?accept|weiter|continuar|continuer",
    when: chargedNow,
  },
  {
    // A transfer of money, with an amount on the screen. A transfer of an account is a row of its own.
    kind: "pay",
    start: "transfer(?! ownership)|withdraw|wire|transferir|uberweisen",
    when: (scene) => money.test(scene.text),
  },
  {
    kind: "loss",
    // The Apple menu and the dialog of macOS: every app quits.
    start: "restart|log out|log off|shut down",
    when: (scene, dots) => dots || sessionWords.test(scene.text),
    dots: true,
    reason: "Every app quits, and changes that are not saved are lost.",
  },
  {
    kind: "loss",
    any: "(?:delete|remove|erase|clear|empty)(?: it| them| this| these| all| everything| items?| files?)? (?:forever|permanently|immediately|for good)|permanently (?:delete|remove|erase)|empty (?:the )?(?:trash|bin|recycle bin|recently deleted)|factory reset|reset (?:all|everything|to factory|(?:all )?settings|(?:this |the )?(?:mac|device|phone|computer|iphone|ipad))|erase|uninstall|wipe|terminate|destroy|purge|revoke|overwrite|shut down|(?:delete|close|deactivate) (?:my |your |the |this )?(?:account|profile)|delete (?:my |your |the |this )?(?:repository|repo|organization|organisation|workspace|database|project|server|instance|domain|website|site|channel|team|backups?|vault|api key|key|token|branch|everything)|drop (?:table|database)|clear (?:all )?(?:browsing )?(?:history|data|website data)|format (?:the )?(?:disk|drive|volume|partition|card)|(?:endgultig|dauerhaft) (?:loschen|entfernen)|supprimer (?:definitivement|pour toujours)|(?:eliminar|borrar) (?:para siempre|permanentemente|definitivamente)|elimina (?:definitivamente|per sempre)|definitief verwijderen|papierkorb leeren|vider la corbeille|vaciar (?:la )?papelera|svuota (?:il )?cestino|prullenbak legen",
  },
  {
    // A button of a sheet that asks to save: all but Save loses the changes.
    // It comes before the plain Delete below: the sheet of a new document that
    // was never saved names its button Delete and says that it cannot be
    // undone, and what it loses is the unsaved document.
    kind: "unsaved",
    start: "delete|close|quit|leave|continue|ok|yes|don't keep",
    when: (scene) => saveSheetWords.test(scene.text),
    asked: asksToLose,
  },
  {
    // A plain Delete or OK, where the screen says that it cannot be undone.
    kind: "loss",
    start:
      "delete|remove|clear|reset|empty|erase|ok|yes|confirm|continue|proceed|i understand|loschen|entfernen|supprimer|eliminar|borrar|elimina|cancella|verwijderen",
    when: (scene) => permanentWords.test(scene.text),
  },
  {
    kind: "loss",
    start: "replace",
    when: (scene) => replaceWords.test(scene.text),
    reason: "It replaces a file that exists, which is then gone for good.",
  },
  {
    kind: "unsaved",
    start:
      "don't save|do not save|discard|revert|throw away|lose changes|close without saving|quit without saving|delete draft",
    any: "discard|revert to saved",
    asked: asksToLose,
  },
  {
    kind: "account",
    any: "(?:change|reset|update|set|set up|remove|turn off|disable|create|save|edit) (?:the |your |my |a |new |account |login )?(?:password|passcode|pin)|two factor|2fa|two step|multi factor|mfa|authenticator|security keys?|passkeys?|backup codes?|recovery (?:email|phone|key|codes?|contact|number|address)|trusted (?:phone|number|device)s?|(?:sign|log) out (?:of |from )?(?:all|other|every)|make (?:it |this |my )?(?:profile |account |repo |repository |page |post )?(?:public|private)|change (?:the )?visibility|who can see|location services|share (?:my )?location|privacy settings|transfer ownership",
  },
  {
    kind: "grant",
    any: "(?:grant|allow|give) (?:full |me |them |it )?(?:access|permission)|allow full (?:disk )?access|trust (?:this )?(?:computer|device|mac|browser|app|developer|certificate)|authori[sz]e (?:app|application|access|this|device)|open anyway",
  },
  {
    // A permission dialog: "Allow" and "OK" give the yes. "Don't Allow" does not.
    kind: "grant",
    start:
      "allow|always allow|approve|authori[sz]e|grant|permit|trust|ok|open|continue|accept|yes|install|turn on|enable|agree",
    when: asksPermission,
  },
  {
    kind: "terms",
    any: "(?:i )?(?:agree|accept)(?: to)?(?: all)?(?: the)? (?:terms|conditions|agreement|license|licence|eula)",
  },
  {
    kind: "terms",
    // "Accept all cookies" accepts only the cookies.
    start: "(?:i )?agree|(?:i )?accept(?! (?:all )?cookies\\b)",
    when: (scene) => termsWords.test(scene.text),
    // A cookie banner is no such terms. A word about cookies elsewhere on a
    // page of binding terms lifts nothing.
    unless: cookieBanner,
  },
  {
    // "Send to Back" and "Send Backward" of a drawing app send nothing.
    kind: "send",
    start:
      "send(?! to back| backward)|reply|respond|post|tweet|publish|comment|submit|share|answer|senden|absenden|antworten|enviar|responder|envoyer|repondre|publier|publicar|invia|rispondi|pubblica|verzenden|versturen|beantwoorden|posten|veroffentlichen|teilen|compartir|partager|condividi|delen",
    asked: sendAsked,
  },
  {
    // A forward of a mail or a message. The Forward button of a browser goes to the next page.
    kind: "send",
    start: "forward|fwd|weiterleiten|reenviar|inoltra|doorsturen",
    unless: browserInFront,
    asked: sendAsked,
  },
  {
    kind: "public",
    start:
      "like|unlike|follow|unfollow|repost|retweet|upvote|downvote|react|favorite|favourite|vote|endorse",
    end: "like|follow|repost|retweet",
    asked: (goal) => requestSays(goal, publicVerbs),
  },
];
const alternatives = (rule: NameRule) =>
  [rule.start, rule.any, rule.end].filter(Boolean).join("|");
const compiled = nameRules.map((rule) => ({
  rule,
  name: new RegExp(
    [
      rule.start && `^(?:${rule.start})\\b`,
      rule.any && `\\b(?:${rule.any})\\b`,
      rule.end && `\\b(?:${rule.end})$`,
    ]
      .filter(Boolean)
      .join("|"),
  ),
  // In a sentence of the planner a word is anywhere.
  words: new RegExp(`\\b(?:${alternatives(rule)})\\b`),
}));
/** A button whose whole name is a price: it buys. */
const priceOnly = new RegExp(`^(?:${money.source})$`);
/**
 * A text field in the planner's words, named by what it takes: "the reply
 * box", "the Reply\u2026 field". A click there gives it the focus and sends
 * nothing, so these words name no control.
 */
const fieldWords =
  /\b(?:send|reply|respond|answer|post|comment|message|share|tweet|chat|compose)(?:\u2026|\.\.\.)?["'\u201d]?\s+(?:text\s+)?(?:box|field|area|input|composer)\b/g;

const moneyWords: Record<string, string> = {
  $: "dollars",
  us$: "dollars",
  c$: "dollars",
  a$: "dollars",
  "\u20ac": "euros",
  "\u00a3": "pounds",
  "\u20b9": "rupees",
  "\u00a5": "yen",
  rs: "rupees",
  "rs.": "rupees",
};
/** An amount as a person says it: "$48.00" is "48 dollars". */
function sayMoney(amount: string) {
  const symbol = /^(us\$|c\$|a\$|\$|\u20ac|\u00a3|\u20b9|\u00a5|rs\.?)\s?/.exec(
    amount,
  );
  if (!symbol) return amount;
  const number = amount.slice(symbol[0].length).replace(/\.00$/, "");
  return `${number} ${moneyWords[symbol[1]!]}`;
}
const totalLabels = [
  "order total",
  "grand total",
  "total due",
  "amount due",
  "total to pay",
  "estimated total",
  "you(?:'ll| will)? pay",
  "total",
];
/** What a payment costs, as the screen says it: the total, else the price on the button. */
function costOf(name: string, scene: Scene) {
  let amount: string | null = null;
  for (const label of totalLabels) {
    const found = new RegExp(
      `\\b${label}\\b[^\\d$\u20ac\u00a3\u20b9\u00a5]{0,24}(${money.source})`,
    ).exec(scene.text);
    if (found) {
      amount = found[1]!;
      break;
    }
  }
  amount ??= money.exec(name)?.[0] ?? null;
  if (!amount) return null;
  const items = /\b(\d{1,3}) items?\b|\bitems? \((\d{1,3})\)/.exec(scene.text);
  const count = items ? Number(items[1] ?? items[2]) : 0;
  return `${sayMoney(amount.trim())}${count ? ` for ${count} item${count === 1 ? "" : "s"}` : ""}`;
}

/**
 * What a name is: the name of a control, the name of a menu item of macOS,
 * or the planner's own sentence about a point or a control with no name of
 * its own. A sentence is no name of a control, so a word counts anywhere in
 * it. Only a menu item opens a dialog first when its name ends with an
 * ellipsis.
 */
type NameOf = "control" | "menu" | "words";
/** The row of the policy that a name asks for, with its reason. Null when nothing asks. */
function askFor(raw: string, scene: Scene, of: NameOf = "control"): Ask | null {
  const words = of === "words";
  const dots = !words && trailingDots.test(clean(raw, 200));
  const said = plain(clean(raw, 200).replace(trailingDots, ""));
  const name = words ? said.replace(fieldWords, " ").trim() : said;
  if (!name) return null;
  const pay = (found: Ask) => {
    if (found.kind !== "pay") return found;
    const cost = costOf(name, scene);
    return cost ? ask("pay", `It spends your money: ${cost}.`) : found;
  };
  if (!words && priceOnly.test(name)) return pay(ask("pay"));
  for (const { rule, name: names, words: loose } of compiled) {
    if (!(words ? loose : names).test(name)) continue;
    // A menu item with an ellipsis opens a dialog first: its button asks.
    if (dots && of === "menu" && !rule.dots) continue;
    if (rule.when && !rule.when(scene, dots)) continue;
    if (rule.unless?.(scene)) continue;
    // The request asked for it: no question. An earlier rule still asks.
    if (rule.asked?.(scene.goal, scene, name)) return null;
    return pay(ask(rule.kind, rule.reason));
  }
  return null;
}

/**
 * A close takes away only a view. A plain close control is "Close" alone, or
 * with the thing that closes on the screen ("Close tab"). "Close account"
 * ends more than a view, and is a row of its own.
 */
const plainClose =
  /^(?:close|dismiss)(?:\s+(?:this|the))?(?:\s+(?:button|tab|window|banner|dialog|panel|sidebar|pop-?up|notification|message|sheet|drawer|menu|search|alert|preview))?$/i;
const quitName = /^quit\b/i;
/**
 * The window in front shows work that is not saved: "Report \u2014 Edited",
 * "Report (Edited)", a dot in front of the title. Null when it shows none.
 */
function unsavedIn(observation: Observation) {
  const title = clean(observation.app.window, 120);
  if (
    /\bedited\b|\bunsaved\b|\bnot saved\b/i.test(title) ||
    /^[\u25cf\u2022*]/.test(title)
  )
    return title;
  const mark = observation.elements.find((item) =>
    /[(\u2014\u2013-]\s*edited\)?$/i.test(clean(item.title, 120)),
  );
  return mark ? clean(mark.title, 120) : null;
}
/** A quit or a close of the window in front, while it shows unsaved work. */
function unsavedRisk(observation: Observation | null, goal?: string) {
  if (!observation || asksToLose(goal ?? "")) return null;
  const title = unsavedIn(observation);
  return title
    ? ask(
        "unsaved",
        `"${title}" shows changes that are not saved, which can be lost.`,
      )
    : null;
}

/** A setting of macOS for security or privacy: a switch there changes who may do what. */
const settingsBundles = new Set([
  "com.apple.systempreferences",
  "com.apple.settings",
]);
const privatePanes =
  /\b(?:privacy|security|screen (?:& system audio )?recording|accessibility|full disk access|input monitoring|automation|files and folders|location services|camera|microphone|passwords?|touch id|users (?:&|and) groups|login items|filevault|firewall|sharing|remote (?:login|management)|developer tools|app management)\b/i;
const settingRoles = new Set([
  "AXCheckBox",
  "AXSwitch",
  "AXToggle",
  "AXRadioButton",
  "AXPopUpButton",
]);
function settingRisk(item: ScreenElement, observation: Observation) {
  if (
    !settingsBundles.has(observation.app.bundleId.toLowerCase()) ||
    !privatePanes.test(observation.app.window)
  )
    return null;
  const name = plain(item.title);
  return settingRoles.has(item.role) ||
    /^(?:\+|-|add|remove|allow|turn on|turn off|enable|disable|open anyway)(?:\s|$)/.test(
      name,
    )
    ? ask("account")
    : null;
}

/** A menu item of macOS, whose ellipsis opens a dialog first, or another control. */
const nameOfItem = (item: ScreenElement): NameOf =>
  item.role === "AXMenuItem" ? "menu" : "control";
/** The roles that only hold other elements. */
const containerRoles = new Set([
  "AXApplication",
  "AXBrowser",
  "AXDrawer",
  "AXGrid",
  "AXGroup",
  "AXLayoutArea",
  "AXList",
  "AXOutline",
  "AXScrollArea",
  "AXSheet",
  "AXSplitGroup",
  "AXTabGroup",
  "AXTable",
  "AXToolbar",
  "AXWebArea",
  "AXWindow",
]);
/**
 * An element whose name does not say what a click on it presses: it has no
 * name, it only holds other elements, or it covers a sixteenth of the screen
 * or more. For such an element the planner's own words count too.
 */
const nameless = (item: ScreenElement | null, observation: Observation) =>
  !item ||
  !clean(item.title, 80) ||
  containerRoles.has(item.role) ||
  item.w * item.h * 16 >= observation.screen.width * observation.screen.height;

/** A name on the screen: the table, a close or a quit of unsaved work, a switch of the private settings. */
function screenRisk(
  item: ScreenElement,
  observation: Observation,
  goal?: string,
) {
  const name = clean(item.title, 80);
  return (
    // The name of a window is its title: it says what the window shows, not what a click presses.
    (item.role === "AXWindow"
      ? null
      : askFor(item.title, screenScene(observation, goal), nameOfItem(item))) ??
    (plainClose.test(name) ||
    quitName.test(name) ||
    item.role === "AXCloseButton"
      ? unsavedRisk(observation, goal)
      : null) ??
    settingRisk(item, observation)
  );
}

/** A terminal command that asks whatever the request says. */
const commandRisks: readonly (readonly [RegExp, AskKind, string])[] = [
  [
    /\bgit\s+push\b[^;&|]*(?:\s-f\b|\s--force\b|\s\+\S)/,
    "loss",
    "The command overwrites the history that others share.",
  ],
  [
    /(?:^|[\s;&|(`'"\\/])(?:rm|rmdir|shred|unlink|srm)(?:\s|$|['"])/,
    "loss",
    "The command deletes files for good.",
  ],
  [
    // A delete by find, by a script, or by a sync that deletes.
    /(?:^|\s)-delete(?:\s|$)|\bshutil\.rmtree\b|\bos\.(?:remove|unlink|rmdir|removedirs)\b|\bfs(?:\.promises)?\.(?:rm|rmdir|unlink)(?:sync)?\b|\brimraf\b|\bfileutils\.rm(?:_rf|_r|_f)?\b|\bunlink\s*\(|\bremove-item\b|\brsync\b[^;&|]*\s--delete/,
    "loss",
    "The command deletes files for good.",
  ],
  [
    /(?:^|[\s;&|(`'"\\/])(?:mv|cp)\s[^;&|]*\/dev\/null\b/,
    "loss",
    "The command throws files away to /dev/null, for good.",
  ],
  [
    /\bgit\s+(?:reset\s[^;&|]*--hard|clean\b|checkout\s(?:[^;&|]*\s)?--(?:\s|$)|restore\b|branch\s[^;&|]*-d\b|stash\s+(?:drop|clear)\b)/,
    "loss",
    "The command throws away work in git for good.",
  ],
  [
    /(?:^|[\s;&|(])(?:dd|mkfs(?:\.\w+)?|fdisk|newfs_\w+)\s|\bdiskutil\s+(?:erase\w*|partition\w*|zero\w*|secure\w*|reformat)\b/,
    "loss",
    "The command can erase a disk.",
  ],
  [
    /\b(?:drop\s+(?:table|database|schema)|truncate\s+(?:table\s+)?\w|delete\s+from)\b/,
    "loss",
    "The command deletes data for good.",
  ],
  [
    /(?:^|[\s;&|(])(?:killall|pkill|kill\s+-(?:9|kill))\b/,
    "loss",
    "The command ends programs, with their work.",
  ],
  [
    /\b(?:curl|wget)\b[^;&]*\|\s*(?:sudo\s+)?(?:(?:ba|z|k|fi)?sh|python3?|node|ruby|perl)\b|\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/,
    "account",
    "The command runs code from the web.",
  ],
  [
    /(?:^|[\s;&|(])(?:sudo|doas)\s|(?:^|[\s;&|(])su(?:\s+-|\s*$)/,
    "account",
    "The command runs as an administrator.",
  ],
  [
    /(?:^|[\s;&|(])(?:launchctl|tccutil|csrutil|spctl|security|passwd|dscl|systemsetup|fdesetup|pfctl)\b|\bdefaults\s+delete\b|\bch(?:mod|own)\s+-r\b/,
    "account",
    "The command changes the security of the Mac.",
  ],
];
const publishCommand =
  /\bgit\s+push\b|\b(?:npm|pnpm|yarn)\s+publish\b|\bdocker\s+push\b|\bgh\s+(?:pr\s+(?:create|merge)|release\s+create|repo\s+create)\b/;
/** The commands that delete or move, whose end can start a text that is typed in parts. */
const partCommands = ["rm", "rmdir", "shred", "unlink", "srm", "mv"];
/**
 * The lines that a text can run as. The worker cannot see what is typed on
 * the line already, so a text that starts with the end of such a command and
 * has more after it is read as that command too: "r", then "m -rf ~", runs
 * "rm -rf ~".
 */
function linesOf(text: string) {
  const lines = [text];
  const first = /^(\S+)\s+\S/.exec(text)?.[1];
  if (first)
    for (const command of partCommands)
      if (command.length > first.length && command.endsWith(first))
        lines.push(`${command.slice(0, -first.length)}${text}`);
  return lines;
}
/** What a move of the line moves, and where to: every word after mv that is no option. */
function movedPaths(line: string) {
  const paths: string[] = [];
  for (const found of line.matchAll(/(?:^|[\s;&|(`'"\\/])mv\s+([^;&|]*)/g))
    for (const word of found[1]!.split(/\s+/))
      if (word && !word.startsWith("-"))
        paths.push(word.replace(/^['"]+|['"]+$/g, ""));
  return paths;
}
/** True when the request names this path, or its last part: "report.txt", "Documents". */
function pathNamed(path: string, goal: string) {
  const said = goal.toLowerCase();
  const last = path.replace(/\/+$/, "").split("/").at(-1) ?? "";
  return [path, last].some(
    (name) =>
      name.length > 1 &&
      !/^[~.*]+$/.test(name) &&
      new RegExp(
        `(?:^|[^\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\w-])`,
      ).test(said),
  );
}
const moveRisk = ask(
  "loss",
  "The command moves files that your request does not name. A move can overwrite a file, which is then gone for good.",
);
/**
 * Text for a terminal: a command that asks always, else a question unless the
 * request asks for terminal work. The text is read as every line that it can
 * run as (`linesOf`).
 */
function terminalRisk(text: string | null, goal?: string) {
  if (text !== null)
    for (const said of linesOf(text.toLowerCase())) {
      for (const [pattern, kind, reason] of commandRisks)
        if (pattern.test(said)) return ask(kind, reason);
      if (movedPaths(said).some((path) => !pathNamed(path, goal ?? "")))
        return moveRisk;
      if (publishCommand.test(said) && !requestSays(goal ?? "", publishVerbs))
        return ask("send", "The command publishes your work to other people.");
    }
  return asksForCommand(goal) ? null : ask("terminal");
}
const pasteRisk = ask(
  "terminal",
  "It pastes text that I cannot see into a terminal, where it runs as a command.",
);
const terminalDropRisk = ask(
  "terminal",
  "What is dropped on a terminal is typed there, where it can run as a command.",
);
const sessionKeyRisk = ask(
  "loss",
  "It logs you out of the Mac: every app quits, and changes that are not saved are lost.",
);
/** Return and the send keys in an app that sends what is typed. */
const sendKeyRisk = (observation: Observation, goal?: string) =>
  sendAsked(goal ?? "", screenScene(observation, goal))
    ? null
    : ask("send", `This key sends what is typed. ${askPolicy.send.reason}`);
/** A key that can press a control that asks: the question names it. */
const pressRisk = (name: string, found: Ask) =>
  ask(found.kind, `It can press "${clean(name, 40)}". ${found.reason}`);

const terminalBundles = new Set([
  "com.apple.terminal",
  "com.googlecode.iterm2",
  "dev.warp.warp-stable",
  "com.mitchellh.ghostty",
  "net.kovidgoyal.kitty",
  "org.alacritty",
  "io.alacritty",
  "co.zeit.hyper",
  "com.github.wez.wezterm",
  "org.tabby",
  "com.raphaelamorim.rio",
]);
const terminalName =
  /^(?:terminal|iterm2?|warp|ghostty|kitty|alacritty|hyper|wezterm|tabby|rio)$/i;
/** The Trash of the Dock, by its name. In the planner's words, the word anywhere. */
const trashName = /^(?:trash|bin|recycle bin)$|\b(?:the )?trash\b/i;
/** True when keys go to a terminal: a terminal app is in front, or a terminal inside another app has the focus. */
export function inTerminal(observation: Observation) {
  const app = observation.app;
  return (
    terminalBundles.has(app.bundleId.toLowerCase()) ||
    terminalName.test(app.name.trim()) ||
    observation.elements.some(
      (item) =>
        item.focused &&
        /\b(?:terminal|shell)\b/i.test(`${item.role} ${item.title}`),
    )
  );
}

/** Apps where Return sends what is typed to another person. */
const sendingBundles = new Set([
  "com.apple.mobilesms",
  "com.apple.mail",
  "com.tinyspeck.slackmacgap",
  "net.whatsapp.whatsapp",
  "ru.keepcoder.telegram",
  "com.hnc.discord",
  "org.whispersystems.signal-desktop",
  "com.microsoft.teams",
  "com.microsoft.teams2",
  "com.microsoft.outlook",
  "com.facebook.archon",
]);
const sendingName =
  /^(?:messages|mail|slack|whatsapp|telegram|discord|signal|microsoft teams|outlook|messenger)$/i;
const sendsOnReturn = (app: Observation["app"]) =>
  sendingBundles.has(app.bundleId.toLowerCase()) ||
  sendingName.test(app.name.trim());
/** The browsers of the Mac, by their app. */
const browserBundles = new Set([
  "com.apple.safari",
  "com.apple.safaritechnologypreview",
  "com.google.chrome",
  "com.google.chrome.beta",
  "com.google.chrome.dev",
  "com.google.chrome.canary",
  "com.google.chrome.for.testing",
  "org.chromium.chromium",
  "com.brave.browser",
  "com.microsoft.edgemac",
  "org.mozilla.firefox",
  "company.thebrowser.browser",
  "com.operasoftware.opera",
  "com.vivaldi.vivaldi",
]);
const browserName =
  /^(?:safari|google chrome|chrome|chromium|brave browser|microsoft edge|firefox|arc|opera|vivaldi)\b/i;
/** Messaging sites, by the title of the page or its window: Return sends there as in their apps. */
const chatSite =
  /\b(?:slack|whatsapp|messenger|discord|telegram|microsoft teams|google chat|google messages|messages for web)\b/i;
const chatHosts =
  /(?:^|\.)(?:slack\.com|whatsapp\.com|messenger\.com|discord\.com|telegram\.org|teams\.microsoft\.com|teams\.live\.com|chat\.google\.com|messages\.google\.com)$/i;
/** The words of a field where what is typed goes to other people: a message, a comment, a post. */
const messageWords =
  /\b(?:message|comment|reply|post|tweet|chat|compose|status|what's happening|say something|write)\b/;
const searchWords = /\b(?:search|find|filter)\b/i;
/**
 * Return in a web chat sends what is typed, as in a chat app: a messaging
 * site in a browser, or a page whose field with the focus is a message box.
 * A search field takes Return for its search.
 */
function webChat(observation: Observation) {
  const { app } = observation;
  if (
    !browserBundles.has(app.bundleId.toLowerCase()) &&
    !browserName.test(app.name.trim())
  )
    return false;
  const field = observation.elements.find(
    (item) => item.focused && textRoles.has(item.role),
  );
  if (
    field &&
    (field.role === "AXSearchField" || searchWords.test(field.title))
  )
    return false;
  return (
    chatSite.test(app.window) ||
    (!!field && messageWords.test(plain(field.title)))
  );
}
/** A page of a messaging site, by its address or its title. */
const chatPage = (page: BrowserPage) =>
  chatHosts.test(hostOf(page.url)) || chatSite.test(page.title);

const modifierNames: Record<string, string> = {
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  ctrl: "ctrl",
  control: "ctrl",
  opt: "opt",
  option: "opt",
  alt: "opt",
  shift: "shift",
  fn: "fn",
};
const modifierOrder = ["cmd", "ctrl", "opt", "shift", "fn"];
const keyNames: Record<string, string> = {
  return: "return",
  enter: "return",
  tab: "tab",
  space: "space",
  escape: "escape",
  esc: "escape",
  delete: "delete",
  backspace: "delete",
  forwarddelete: "forwarddelete",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
};
/**
 * One key with known modifiers, written one way: modifiers first, in the order
 * cmd, ctrl, opt, shift, fn. Null for anything else. The power key and the
 * media keys have no name here, so they are never sent.
 */
export function parseCombo(raw: string) {
  const parts = raw
    .trim()
    .toLowerCase()
    .split("+")
    .map((part) => part.trim());
  if (parts.some((part) => !part)) return null;
  const last = parts.at(-1)!;
  const modifiers = parts.slice(0, -1).map((part) => modifierNames[part]);
  if (
    modifiers.some((modifier) => !modifier) ||
    new Set(modifiers).size !== modifiers.length
  )
    return null;
  const key =
    keyNames[last] ??
    (/^f(?:[1-9]|1[0-2])$/.test(last) || /^[a-z0-9`\-=[\]\\;',./]$/.test(last)
      ? last
      : null);
  if (!key) return null;
  const held = new Set(modifiers as string[]);
  return {
    combo: [...modifierOrder.filter((name) => held.has(name)), key].join("+"),
    modifiers: held,
    key,
  };
}
/**
 * Keys that macOS takes before the app in front: Spotlight, the menu bar, the
 * Dock and the status menus by keyboard, Mission Control and the app windows,
 * and the screenshot bar. They type nothing into a terminal.
 */
const systemKeys = new Set([
  "cmd+space",
  "ctrl+f2",
  "ctrl+f3",
  "ctrl+f8",
  "ctrl+up",
  "ctrl+down",
  "cmd+shift+3",
  "cmd+shift+4",
  "cmd+shift+5",
]);
const systemKey = (combo: string) => systemKeys.has(combo);
function keyRisk(
  parsed: NonNullable<ReturnType<typeof parseCombo>>,
  observation: Observation,
  goal?: string,
): Ask | null {
  const { key, modifiers } = parsed;
  const cmd = modifiers.has("cmd");
  if (inTerminal(observation) && !systemKey(parsed.combo)) {
    // A paste is text that nobody checked, and a line break in it runs.
    if (cmd && key === "v") return pasteRisk;
    const terminal = terminalRisk(null, goal);
    if (terminal) return terminal;
  }
  // Log out of the Mac, with its dialog or at once.
  if (cmd && modifiers.has("shift") && key === "q") return sessionKeyRisk;
  // Lock the screen: nothing is lost.
  if (cmd && modifiers.has("ctrl") && key === "q") return null;
  // Quit the app, or close a window or a tab: only unsaved work can be lost.
  if (cmd && (key === "q" || key === "w"))
    return unsavedRisk(observation, goal);
  const writing = hasTextFocus(observation);
  // Delete at once, and empty the Trash, in Finder. Command with Delete alone
  // moves to the Trash, which can be undone.
  if (
    cmd &&
    (key === "delete" || key === "forwarddelete") &&
    (modifiers.has("opt") || modifiers.has("shift")) &&
    !writing
  )
    return ask("loss");
  if (key === "return" && (cmd || modifiers.has("ctrl")))
    return sendKeyRisk(observation, goal);
  if (
    key === "return" &&
    !modifiers.size &&
    (sendsOnReturn(observation.app) || webChat(observation))
  )
    return sendKeyRisk(observation, goal);
  // The mail app sends with this one.
  if (
    key === "d" &&
    cmd &&
    modifiers.has("shift") &&
    observation.app.bundleId.toLowerCase() === "com.apple.mail"
  )
    return sendKeyRisk(observation, goal);
  // Return and Space press the default button of a window, the chosen item of
  // an open menu, and whatever has the focus. So a key can do what a click on
  // "Place order" does. With the focus in a text field the key goes to the
  // text, and this does not apply.
  if ((key === "return" || key === "space") && !modifiers.size && !writing) {
    const scene = screenScene(observation, goal);
    for (const item of observation.elements) {
      if (
        !item.enabled ||
        !(
          item.role === "AXButton" ||
          item.role === "AXMenuItem" ||
          item.focused
        )
      )
        continue;
      const found =
        askFor(item.title, scene, nameOfItem(item)) ??
        (item.focused ? settingRisk(item, observation) : null);
      if (found) return pressRisk(item.title, found);
    }
  }
  return null;
}

/** An http or https link with no login in it and no space or control character. Null for anything else. */
function safeLink(raw: string) {
  if (!/^https?:\/\//i.test(raw) || /[\s\p{C}]/u.test(raw)) return null;
  try {
    const link = new URL(raw);
    if (
      (link.protocol !== "http:" && link.protocol !== "https:") ||
      !link.hostname ||
      link.username ||
      link.password
    )
      return null;
    return link;
  } catch {
    return null;
  }
}
const linkRefusal =
  "Only http and https links are opened, with no login in the link.";
/** A path and a query longer than this, that the person did not write, can carry what the screen shows. */
const longAddressPart = 120;
/**
 * An address that the planner chose opens with no question: a shop, a site of
 * the news, a page that the task needs. Only an address with a long path or
 * query that the person did not write asks: such a part could carry what the
 * screen shows to the site.
 */
const addressRisk = (link: URL, goal?: string) => {
  const rest = `${link.pathname}${link.search}`;
  return rest.length > longAddressPart &&
    !(goal ?? "").toLowerCase().includes(rest.toLowerCase())
    ? ask(
        "send",
        `The address carries a long part that you did not write, which could send what the screen shows to ${clean(link.host, 80)}.`,
      )
    : null;
};

const textRoles = new Set([
  "AXTextField",
  "AXTextArea",
  "AXSearchField",
  "AXComboBox",
  "AXSecureTextField",
]);
/** True when a field that takes text has the focus: typed text goes there. */
export const hasTextFocus = (observation: Observation) =>
  observation.elements.some((item) => item.focused && textRoles.has(item.role));
/**
 * What takes typing with the focus, though it is no text field: a cell of a
 * spreadsheet or of a table, the sheet itself, a grid, the canvas of a
 * document (AXLayoutArea), a web page that draws its own editor (web sheets
 * and slides do), and the view of a document, which is the only scroll area
 * that takes the focus itself. The hands name no caret, so a web page with
 * the focus counts.
 */
const typingRoles = new Set([
  ...textRoles,
  "AXCell",
  "AXTable",
  "AXGrid",
  "AXLayoutArea",
  "AXWebArea",
  "AXScrollArea",
]);
/**
 * True when what has the focus takes typing: a text field, a cell, a sheet,
 * a grid, a canvas or a web editor. Typed text and the keys that edit text go
 * there. Return and Space are judged by `hasTextFocus`: a list or a sheet
 * with the focus passes them on to the default button of the window.
 */
export const hasTypingFocus = (observation: Observation) =>
  observation.elements.some(
    (item) => item.focused && typingRoles.has(item.role),
  );
const middle = (item: ScreenElement) => ({
  x: item.x + item.w / 2,
  y: item.y + item.h / 2,
});
const onScreen = (observation: Observation, point: { x: number; y: number }) =>
  point.x >= 0 &&
  point.y >= 0 &&
  point.x < observation.screen.width &&
  point.y < observation.screen.height;
const nameOf = (item: ScreenElement) => {
  const title = clean(item.title, 80);
  return title
    ? `"${title}"`
    : `the ${item.role.replace(/^AX/, "").toLowerCase() || "element"}`;
};
/** The smallest element that holds the point, of those that `take` keeps. */
function under(
  observation: Observation,
  point: { x: number; y: number },
  take = (_item: ScreenElement) => true,
) {
  let best: ScreenElement | null = null;
  for (const item of observation.elements)
    if (
      take(item) &&
      item.w > 0 &&
      item.h > 0 &&
      point.x >= item.x &&
      point.y >= item.y &&
      point.x < item.x + item.w &&
      point.y < item.y + item.h &&
      (!best || item.w * item.h < best.w * best.h)
    )
      best = item;
  return best;
}
/** The roles that are a part of a control, not a control: a click on one presses what holds it. */
const partRoles = new Set([
  "AXImage",
  "AXStaticText",
  "AXUnknown",
  "AXHeading",
  "OCRText",
]);
/**
 * Every element that a click on `start` presses: `start`, then each larger
 * element that holds it, up to and with the first one that is no part of
 * another (no image and no text): a named image inside a "Send" button is a
 * press of "Send". A container ends the row and is not in it: a group holds
 * the point, but a click does not press the group. An element beside `start`
 * that only overlaps it is not in the row.
 */
function pressedFrom(observation: Observation, start: ScreenElement) {
  const row: ScreenElement[] = [start];
  if (!partRoles.has(start.role)) return row;
  const holds = (outer: ScreenElement, inner: ScreenElement) =>
    outer.x <= inner.x + 1 &&
    outer.y <= inner.y + 1 &&
    outer.x + outer.w >= inner.x + inner.w - 1 &&
    outer.y + outer.h >= inner.y + inner.h - 1;
  const around = observation.elements
    .filter(
      (item) =>
        item !== start &&
        item.w * item.h > start.w * start.h &&
        holds(item, start),
    )
    .sort((left, right) => left.w * left.h - right.w * right.h);
  for (const item of around) {
    if (containerRoles.has(item.role)) break;
    if (!holds(item, row.at(-1)!)) continue;
    row.push(item);
    if (!partRoles.has(item.role)) break;
  }
  return row;
}
/** The first element of the row whose name asks, with its question. */
function rowRisk(
  row: readonly ScreenElement[],
  observation: Observation,
  goal?: string,
) {
  for (const item of row) {
    const found = screenRisk(item, observation, goal);
    if (found) return { item, found };
  }
  return null;
}
/**
 * A click at the point goes into a text field: on the field, or on a text
 * that it shows, such as its placeholder "Reply\u2026". It gives the field the
 * focus and presses nothing. A text of a button inside the field is the
 * button's.
 */
const intoField = (
  observation: Observation,
  item: ScreenElement | null,
  point: { x: number; y: number },
) =>
  !!item &&
  (textRoles.has(item.role) ||
    (item.role === "AXStaticText" &&
      textRoles.has(
        under(observation, point, (each) => each.role !== "AXStaticText")
          ?.role ?? "",
      )));
/** A point of the last image as a point of the screen. Null when it has no image or the point is outside it. */
function screenPoint(observation: Observation, x: number, y: number) {
  const { imageWidth, imageHeight } = observation;
  if (!imageWidth || !imageHeight) return "no_image" as const;
  if (!(x >= 0 && y >= 0 && x < imageWidth && y < imageHeight))
    return "outside" as const;
  return {
    x: (x * observation.screen.width) / imageWidth,
    y: (y * observation.screen.height) / imageHeight,
  };
}
/** The element with the focus when it is a secure field. */
export const focusedSecure = (observation: Observation) =>
  observation.elements.find((item) => item.focused && item.secure) ?? null;

/** How much larger a closer look shows its part than the last picture does. */
export const closerMagnify = 3;
/** The part of the last picture that a closer look shows: a quarter of its width and of its height. */
const closerShare = 0.25;
/**
 * The part of the last picture around a point that a closer look shows, in
 * its pixels, kept inside the picture, and the command for the hands, in
 * screen points. Null with no picture, or a point outside it.
 */
export function closerPart(
  point: { x: number; y: number },
  seen: Observation | null,
): {
  region: { x: number; y: number; w: number; h: number };
  command: HandCommand;
} | null {
  const width = seen?.imageWidth,
    height = seen?.imageHeight;
  if (!seen || !width || !height) return null;
  if (!(point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height))
    return null;
  const w = Math.round(width * closerShare),
    h = Math.round(height * closerShare);
  const x = Math.round(Math.min(Math.max(point.x - w / 2, 0), width - w));
  const y = Math.round(Math.min(Math.max(point.y - h / 2, 0), height - h));
  const across = seen.screen.width / width,
    down = seen.screen.height / height;
  return {
    region: { x, y, w, h },
    command: {
      kind: "zoom",
      x: x * across,
      y: y * down,
      w: w * across,
      h: h * down,
      width: Math.min(1600, w * closerMagnify),
      height: Math.min(1600, h * closerMagnify),
    },
  };
}

/** What the worker knows when it checks an action. */
export interface View {
  /** The last observation of the screen. Null after an action, until the next look. */
  observation: Observation | null;
  /** The last reading of the page. Null after an action on the screen. */
  page: BrowserPage | null;
  /** The observation came after the last action that was sent. */
  fresh: boolean;
  /** A browser is connected. */
  browser: boolean;
  /** The optional methods of the connected browser. Absent: it has none of them. */
  browserMethods?: readonly BrowserMethod[];
  /**
   * The person's own request, word for word. Only it can say that a send, a
   * terminal command or the loss of unsaved changes was asked for.
   */
  goal?: string;
}

export type BrowserCall =
  | { name: "read" }
  | { name: "open"; url: string }
  | { name: "click"; index: number; element: BrowserElement }
  | {
      name: "type";
      index: number;
      text: string;
      submit: boolean;
      element: BrowserElement;
    }
  | { name: "scroll"; direction: "up" | "down" }
  | { name: "back" }
  | { name: "hover"; index: number; element: BrowserElement }
  | {
      name: "select";
      index: number;
      option: string;
      element: BrowserElement;
    }
  | { name: "key"; combo: PageKey }
  | { name: "wait"; text: string | null; ms: number }
  | { name: "tabs" }
  /** `listed` is the tab of the list that the planner read: it is found again before the switch. */
  | { name: "switch_tab"; tab: number; listed: BrowserTab };

/** The optional methods of a browser driver. */
export const browserMethodNames = [
  "hover",
  "select",
  "key",
  "waitFor",
  "tabs",
  "switchTab",
] as const;
export type BrowserMethod = (typeof browserMethodNames)[number];
/** The optional methods that this driver has. */
export const browserMethods = (port: BrowserPort | undefined) =>
  port
    ? browserMethodNames.filter((name) => typeof port[name] === "function")
    : [];
/**
 * The optional methods that each browser action needs. A switch needs the
 * list of the tabs too: its numbers come from that list, and the worker lists
 * the tabs again just before it switches.
 */
export const browserActionNeeds: Readonly<
  Record<string, readonly BrowserMethod[]>
> = {
  browser_hover: ["hover"],
  browser_select: ["select"],
  browser_key: ["key"],
  browser_wait: ["waitFor"],
  browser_tabs: ["tabs"],
  browser_switch_tab: ["tabs", "switchTab"],
};
/** True when a driver with these methods can do this kind of action. */
export const browserCan = (
  kind: string,
  methods: readonly BrowserMethod[] = [],
) => (browserActionNeeds[kind] ?? []).every((need) => methods.includes(need));
/** A call that changes nothing on the page: a reading, a wait, a list of the tabs. */
export const quietCall = (call: BrowserCall) =>
  call.name === "read" || call.name === "wait" || call.name === "tabs";
/** A call whose target is checked against a new reading just before it goes. */
export const readsBeforeCall = (call: BrowserCall) =>
  call.name === "click" ||
  call.name === "type" ||
  call.name === "hover" ||
  call.name === "select" ||
  call.name === "key" ||
  call.name === "switch_tab";

/** What goes out when the action runs. */
export type Send =
  | {
      via: "hands";
      /** Input that depends on the screen: the worker looks again just before it sends it. */
      look: boolean;
      /** A click that gives the field the focus, before the text. */
      focus?: HandCommand;
      command: HandCommand;
    }
  | { via: "browser"; call: BrowserCall };

export type Checked =
  /** Not valid, or not allowed. Nothing is sent. The planner is told why. */
  | { verdict: "refuse"; reason: string }
  /** Text for a secure field. The worker never types it: the person does. */
  | { verdict: "person_types"; label: string; target: string }
  | {
      verdict: "run";
      /** A few words for the banner and the question: Click "Save". */
      label: string;
      /** The name of the element, for the journal. Never typed text or page text. */
      target: string;
      /** Why the person's yes is needed first, as the question says it. Null when it is not. */
      risk: string | null;
      /** The row of the policy that asks (`askPolicy`). Null when nothing asks. */
      policy: AskKind | null;
      /** The same for the same target and arguments. Null for an action that may repeat. */
      signature: string | null;
      send: Send;
    }
  | { verdict: "ask"; question: string }
  | { verdict: "done"; summary: string }
  | { verdict: "give_up"; reason: string };

const refuse = (reason: string): Checked => ({ verdict: "refuse", reason });
/** The question of a row, or none, as a result carries it. */
const asking = (found: Ask | null) => ({
  risk: found?.reason ?? null,
  policy: found?.kind ?? null,
});

/**
 * The question before an action that needs a yes. It is short enough for a
 * phone call, and concrete: what the action does, where, and what it costs or
 * loses. 'Click "Place order" on shop.example? It spends your money: 48
 * dollars for 2 items. Say yes or no.'
 */
export function yesQuestion(
  checked: { label: string; risk: string | null; send: Send },
  observation: Observation | null,
  page: BrowserPage | null,
) {
  let what = checked.label;
  if (checked.send.via === "browser") {
    const host = hostOf(page?.url);
    if (host && what.endsWith(onThePage))
      what = `${what.slice(0, -onThePage.length)} on ${host}`;
  } else if (checked.send.look && observation?.app.name.trim())
    // An open, a quit and a wait name their app in the label already.
    what = `${what} in ${clean(observation.app.name, 60)}`;
  return `${what}? ${checked.risk ?? ""} Say yes or no.`.replace(/\s+/g, " ");
}
const onThePage = " on the page";
const hostOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};
const noImageRefusal =
  "The last observation has no image, so a point has no meaning.";
const outsideRefusal = "That point is outside the last image.";
const oneLine = /[\p{Cc}\u2028\u2029]/u;
const lineRefusal =
  "Type one line with no line break or tab. Press Return or Tab as a key of its own.";

const pageTextEntry = (item: BrowserElement) =>
  item.password ||
  /^(?:textbox|searchbox|combobox|spinbutton)$/i.test(item.role) ||
  /^(?:textarea|select)$/i.test(item.tag);
const pageSearch = (item: BrowserElement) =>
  /search/i.test(`${item.role} ${item.label}`);
const pageName = (item: BrowserElement) => {
  const label = clean(item.label, 80);
  return label ? `"${label}"` : `the ${clean(item.tag, 20) || "element"}`;
};
/** A list of choices: a select, or what the page calls a listbox or a combobox. */
const pageChoice = (item: BrowserElement) =>
  /^select$/i.test(item.tag) || /^(?:listbox|combobox)$/i.test(item.role);
/**
 * Enter and Space in a page can press what has the focus, and Enter can
 * submit the form of a field. A reading does not say which element has the
 * focus, so either key asks while any control of the page that is not a
 * field has a name that a click asks about.
 */
const pageKeyRisk = (
  key: PageKey,
  page: BrowserPage,
  goal?: string,
): Ask | null => {
  if (key !== "Enter" && key !== "Space") return null;
  const scene = pageScene(page, goal);
  for (const item of page.elements) {
    if (item.disabled || pageTextEntry(item)) continue;
    const found = askFor(item.label, scene);
    if (found) return pressRisk(item.label, found);
  }
  // On a messaging site, Enter sends what is typed, as in its app.
  if (key === "Enter" && chatPage(page) && !sendAsked(goal ?? "", scene))
    return ask(
      "send",
      `This key sends what is typed. ${askPolicy.send.reason}`,
    );
  return null;
};
/** A field where what is typed goes to other people: a message, a comment, a post. */
const messageBox = (item: BrowserElement) =>
  /^textarea$/i.test(item.tag) || messageWords.test(plain(item.label));
/**
 * Enter in a field submits its form: what a button of the page would do. A
 * search goes with no question. A message, a comment or a post asks unless
 * the request asks to send it.
 */
const submitRisk = (field: BrowserElement, page: BrowserPage, goal?: string) =>
  pageSearch(field)
    ? null
    : (pageKeyRisk("Enter", page, goal) ??
      (messageBox(field) && !sendAsked(goal ?? "", pageScene(page, goal))
        ? ask("send", `It submits what is typed. ${askPolicy.send.reason}`)
        : null));

/**
 * Checks one planned action against what the worker last saw. It sends
 * nothing. The result says whether the action may run, what it would send, and
 * whether the person must say yes first.
 */
export function check(raw: unknown, view: View, why: string): Checked {
  const parsed = actionSchema.safeParse(raw);
  if (!parsed.success)
    return refuse("That is not one known action with valid arguments.");
  const action = parsed.data;
  switch (action.kind) {
    case "ask":
      return { verdict: "ask", question: action.question };
    case "give_up":
      return { verdict: "give_up", reason: action.reason };
    case "done":
      return view.fresh && view.observation
        ? { verdict: "done", summary: action.summary }
        : refuse(
            "Done needs a view of the screen that is newer than the last action.",
          );
    case "wait":
      return {
        verdict: "run",
        label: "Wait",
        target: "",
        ...asking(null),
        signature: null,
        send: {
          via: "hands",
          look: false,
          command: { kind: "wait", ms: action.ms },
        },
      };
    case "look_closer": {
      const part = closerPart(action, view.observation);
      if (!part)
        return refuse(
          "A closer look needs a picture of the screen, and a point inside it.",
        );
      // A password field is never shown larger (closer.ts).
      if (
        view.observation &&
        part.command.kind === "zoom" &&
        secureInArea(view.observation, part.command)
      )
        return refuse(closerSecureText);
      return {
        verdict: "run",
        label: "Look closer",
        target: "",
        risk: null,
        policy: null,
        signature: null,
        send: { via: "hands", look: false, command: part.command },
      };
    }
    case "open_app": {
      const name = action.name.trim();
      if (!name || name.startsWith(".") || /[\p{C}/\\:]/u.test(name))
        return refuse("That is not the plain name of an app.");
      if (
        action.window !== undefined &&
        (!action.window.trim() || /\p{C}/u.test(action.window))
      )
        return refuse(
          "Use the exact nonempty window title, without control characters.",
        );
      return {
        verdict: "run",
        label: `Open ${clean(name, 80)}`,
        target: clean(name, 80),
        ...asking(null),
        signature: JSON.stringify(["open_app", name, action.window ?? null]),
        send: {
          via: "hands",
          look: false,
          command: {
            kind: "open_app",
            name,
            ...(action.window === undefined ? {} : { window: action.window }),
          },
        },
      };
    }
    case "quit_app": {
      const name = action.name.trim();
      if (!name || name.startsWith(".") || /[\p{C}/\\:]/u.test(name))
        return refuse("That is not the plain name of an app.");
      return {
        verdict: "run",
        label: `Quit ${clean(name, 80)}`,
        target: clean(name, 80),
        // The hands quit the polite way, and an app with unsaved work asks
        // first. So a quit asks only while the app is in front and shows
        // changes that are not saved.
        ...asking(
          view.observation &&
            clean(view.observation.app.name, 120).toLowerCase() ===
              clean(name, 120).toLowerCase()
            ? unsavedRisk(view.observation, view.goal)
            : null,
        ),
        signature: JSON.stringify(["quit_app", name]),
        send: {
          via: "hands",
          look: false,
          command: { kind: "quit_app", name },
        },
      };
    }
    case "open_url": {
      const link = safeLink(action.url);
      if (!link) return refuse(linkRefusal);
      const browser = action.browser?.trim();
      if (
        browser !== undefined &&
        (!browser || browser.startsWith(".") || /[\p{C}/\\:]/u.test(browser))
      )
        return refuse("That is not the plain name of an app.");
      const host = clean(link.hostname, 80);
      return {
        verdict: "run",
        label: browser
          ? `Open ${host} in ${clean(browser, 60)}`
          : `Open ${host}`,
        target: host,
        ...asking(addressRisk(link, view.goal)),
        signature: `open_url|${action.url}${browser ? `|${browser}` : ""}`,
        send: {
          via: "hands",
          look: false,
          command: {
            kind: "open_url",
            // The address as it was checked here, written one way: the hands
            // then read the same site that the question above was about.
            url: link.href,
            ...(browser ? { browser } : {}),
          },
        },
      };
    }
    case "browser_read":
    case "browser_open":
    case "browser_click":
    case "browser_type":
    case "browser_scroll":
    case "browser_back":
    case "browser_hover":
    case "browser_select":
    case "browser_key":
    case "browser_wait":
    case "browser_tabs":
    case "browser_switch_tab":
      return checkBrowser(action, view, why);
    default:
      return checkScreen(action, view, why);
  }
}

function checkScreen(
  action: Extract<
    Action,
    {
      kind:
        | "click_element"
        | "click_at"
        | "type"
        | "key"
        | "scroll"
        | "hover"
        | "drag";
    }
  >,
  view: View,
  why: string,
): Checked {
  const seen = view.observation;
  if (!seen || !view.fresh)
    return refuse("There is no fresh view of the screen. Nothing was sent.");
  /** The element with this number, when it can take input. A hover may name a disabled one: it sends no input. */
  const pick = (id: number, disabledToo = false) => {
    const found = seen.elements.find((item) => item.id === id);
    if (!found) return refuse(`The last observation has no element ${id}.`);
    if (!found.enabled && !disabledToo)
      return refuse(`Element ${id} is disabled.`);
    if (!(found.w > 0 && found.h > 0) || !onScreen(seen, middle(found)))
      return refuse(`Element ${id} is off the screen.`);
    return found;
  };
  const click = (
    point: { x: number; y: number },
    double?: boolean,
    right?: boolean,
  ): HandCommand => ({
    kind: "click",
    x: point.x,
    y: point.y,
    button: right ? "right" : "left",
    count: double ? 2 : 1,
  });
  const verb = (double?: boolean, right?: boolean) =>
    right ? "Right-click" : double ? "Double-click" : "Click";
  switch (action.kind) {
    case "click_element": {
      const found = pick(action.element);
      if ("verdict" in found) return found;
      const point = middle(found);
      // The click presses the element and what holds it, up to its control:
      // the name that asks may be the button's, not its image's.
      const pressed = intoField(seen, found, point)
        ? null
        : rowRisk(pressedFrom(seen, found), seen, view.goal);
      const named = pressed?.item ?? found;
      return {
        verdict: "run",
        label: `${verb(action.double, action.right)} ${nameOf(named)}`,
        target: clean(named.title, 80),
        // A click on a text field only gives it the focus. For a control
        // with no name, or one that only holds others, the planner's own
        // words count too. They can add a question. They never remove one.
        ...asking(
          intoField(seen, found, point)
            ? null
            : (pressed?.found ??
                (nameless(found, seen)
                  ? askFor(why, screenScene(seen, view.goal), "words")
                  : null)),
        ),
        signature: `click|${found.role}|${found.title || `${Math.round(point.x)},${Math.round(point.y)}`}|${!!action.double}|${!!action.right}`,
        send: {
          via: "hands",
          look: true,
          command: click(point, action.double, action.right),
        },
      };
    }
    case "click_at": {
      const point = screenPoint(seen, action.x, action.y);
      if (point === "no_image") return refuse(noImageRefusal);
      if (point === "outside") return refuse(outsideRefusal);
      const found = under(seen, point);
      // Every element under the point, up to the control that the click
      // presses, counts: a named image inside "Send" asks as a send.
      const pressed = intoField(seen, found, point)
        ? null
        : found
          ? rowRisk(
              pressedFrom(seen, found).filter(
                (item) => item !== found || clean(found.title, 80) !== "",
              ),
              seen,
              view.goal,
            )
          : null;
      const named =
        pressed?.item ?? (found && clean(found.title, 80) ? found : null);
      return {
        verdict: "run",
        label: named
          ? `${verb(action.double, action.right)} ${nameOf(named)}`
          : `${verb(action.double, action.right)} at a point`,
        target: named ? clean(named.title, 80) : "",
        // With no name under the point, or only a large one that holds the
        // control, the planner's own words count too. They can add a
        // question. They never remove one.
        ...asking(
          intoField(seen, found, point)
            ? null
            : (pressed?.found ??
                (nameless(found, seen)
                  ? askFor(why, screenScene(seen, view.goal), "words")
                  : null)),
        ),
        signature: `click_at|${Math.round(point.x / 8)}|${Math.round(point.y / 8)}|${!!action.double}|${!!action.right}`,
        send: {
          via: "hands",
          look: true,
          command: click(point, action.double, action.right),
        },
      };
    }
    case "type": {
      if (!action.text) return refuse("There is no text to type.");
      if (oneLine.test(action.text)) return refuse(lineRefusal);
      let field: ScreenElement | null = null;
      if (action.element !== undefined) {
        const found = seen.elements.find((item) => item.id === action.element);
        // A secure field is named before anything else is said about it.
        if (found?.secure)
          return {
            verdict: "person_types",
            label: `Type in ${nameOf(found)}`,
            target: clean(found.title, 80),
          };
        const usable = pick(action.element);
        if ("verdict" in usable) return usable;
        field = usable;
      } else {
        const secure = focusedSecure(seen);
        if (secure)
          return {
            verdict: "person_types",
            label: `Type in ${nameOf(secure)}`,
            target: clean(secure.title, 80),
          };
      }
      return {
        verdict: "run",
        label: field ? `Type in ${nameOf(field)}` : "Type text",
        target: field ? clean(field.title, 80) : "",
        ...asking(
          inTerminal(seen) ? terminalRisk(action.text, view.goal) : null,
        ),
        signature: `type|${field ? `${field.role}|${field.title}` : ""}|${action.text}`,
        send: {
          via: "hands",
          look: true,
          // A field that has the focus is not clicked again: a click moves
          // the caret and drops a selection, so "select all, then type" would
          // add the text in place of replacing what was selected.
          ...(field && !field.focused ? { focus: click(middle(field)) } : {}),
          command: { kind: "type", text: action.text },
        },
      };
    }
    case "key": {
      const parsed = parseCombo(action.combo);
      if (!parsed) return refuse("That is not one key with known modifiers.");
      if (parsed.modifiers.has("cmd") && parsed.key === "tab")
        return refuse(
          "Application switching needs a goal-only navigation interpretation. Ask to return to the previous app, or name the app to bring forward.",
        );
      if (
        parsed.modifiers.has("ctrl") &&
        (parsed.key === "left" ||
          parsed.key === "right" ||
          /^[0-9]$/.test(parsed.key))
      )
        return refuse(
          "Unverified desktop-navigation shortcuts are not supported. For a specific window use open_app; for one desktop transition ask separately to switch the desktop left or right.",
        );
      return {
        verdict: "run",
        label: `Press ${parsed.combo}`,
        target: parsed.combo,
        ...asking(keyRisk(parsed, seen, view.goal)),
        signature: `key|${parsed.combo}`,
        send: {
          via: "hands",
          look: true,
          command: { kind: "key", combo: parsed.combo },
        },
      };
    }
    case "scroll": {
      let point = { x: seen.screen.width / 2, y: seen.screen.height / 2 };
      let target = "";
      if (action.element !== undefined) {
        const found = pick(action.element);
        if ("verdict" in found) return found;
        point = middle(found);
        target = clean(found.title, 80);
      }
      return {
        verdict: "run",
        label: `Scroll ${action.direction}`,
        target,
        ...asking(null),
        signature: null,
        send: {
          via: "hands",
          look: true,
          command: {
            kind: "scroll",
            x: point.x,
            y: point.y,
            dx: 0,
            // A positive number moves the content up, which shows what is below.
            dy: (action.direction === "down" ? 1 : -1) * (action.amount ?? 5),
          },
        },
      };
    }
    case "hover": {
      // No click and no key go out, so a hover needs no yes.
      if (action.element !== undefined) {
        const found = pick(action.element, true);
        if ("verdict" in found) return found;
        const point = middle(found);
        return {
          verdict: "run",
          label: `Hover over ${nameOf(found)}`,
          target: clean(found.title, 80),
          ...asking(null),
          signature: `hover|${found.role}|${found.title || `${Math.round(point.x)},${Math.round(point.y)}`}`,
          send: {
            via: "hands",
            look: true,
            command: { kind: "move", x: point.x, y: point.y },
          },
        };
      }
      const point = screenPoint(seen, action.x ?? Number.NaN, action.y ?? 0);
      if (point === "no_image") return refuse(noImageRefusal);
      if (point === "outside") return refuse(outsideRefusal);
      const found = under(seen, point);
      const named = found && clean(found.title, 80) ? found : null;
      return {
        verdict: "run",
        label: named ? `Hover over ${nameOf(named)}` : "Hover at a point",
        target: named ? clean(named.title, 80) : "",
        ...asking(null),
        signature: `hover_at|${Math.round(point.x / 8)}|${Math.round(point.y / 8)}`,
        send: {
          via: "hands",
          look: true,
          command: { kind: "move", x: point.x, y: point.y },
        },
      };
    }
    case "drag": {
      /** One end: its place on the screen, what lies there, and its name. */
      const end = (given: DragEnd) => {
        if ("element" in given) {
          const found = pick(given.element);
          if ("verdict" in found) return found;
          return {
            point: middle(found),
            item: found as ScreenElement | null,
            words: false,
            reads: nameless(found, seen),
            key: `${found.role}|${found.title}`,
          };
        }
        const point = screenPoint(seen, given.x, given.y);
        if (point === "no_image") return refuse(noImageRefusal);
        if (point === "outside") return refuse(outsideRefusal);
        const found = under(seen, point);
        return {
          point,
          item: found,
          // A point with no named element under it has no name to judge.
          words: !(found && clean(found.title, 80)),
          // Nor one with only a large element that holds others.
          reads: nameless(found, seen),
          key: `${Math.round(point.x / 8)},${Math.round(point.y / 8)}`,
        };
      };
      const from = end(action.from);
      if ("verdict" in from) return from;
      const to = end(action.to);
      if ("verdict" in to) return to;
      if (
        Math.abs(from.point.x - to.point.x) < 4 &&
        Math.abs(from.point.y - to.point.y) < 4
      )
        return refuse(
          "A drag needs two places apart. For one place, use a click.",
        );
      // What is dropped into a password field is typed into it.
      if (to.item?.secure)
        return refuse(
          "A drag never drops onto a password field. The person types it.",
        );
      const named = (side: typeof from) =>
        side.item && !side.words ? side.item : null;
      const source = named(from);
      const goal = named(to);
      const scene = screenScene(seen, view.goal);
      /** A click at this end would ask: the same rule, at both ends. A field only takes what is dropped. */
      const endRisk = (item: ScreenElement | null) =>
        item && !textRoles.has(item.role)
          ? askFor(item.title, scene, nameOfItem(item))
          : null;
      const risk =
        (from.item?.secure ? ask("secret") : null) ??
        (inTerminal(seen) ||
        (goal !== null && terminalName.test(clean(goal.title, 80)))
          ? terminalDropRisk
          : null) ??
        (goal !== null && trashName.test(clean(goal.title, 80))
          ? ask("trash")
          : null) ??
        endRisk(source) ??
        endRisk(goal) ??
        // With no name at an end, or only a large one, the planner's own
        // words count too. They can add a question. They never remove one.
        (to.reads && trashName.test(why) ? ask("trash") : null) ??
        (from.reads || to.reads ? askFor(why, scene, "words") : null);
      const fromName = source ? nameOf(source) : null;
      const toName = goal ? nameOf(goal) : "a point";
      return {
        verdict: "run",
        label: fromName
          ? `Drag ${fromName} to ${toName}`
          : `Drag from a point to ${toName}`,
        target: [source, goal]
          .map((item) => (item ? clean(item.title, 60) : ""))
          .filter(Boolean)
          .join(" to "),
        ...asking(risk),
        signature: `drag|${from.key}|${to.key}`,
        send: {
          via: "hands",
          look: true,
          command: {
            kind: "drag",
            fromX: from.point.x,
            fromY: from.point.y,
            toX: to.point.x,
            toY: to.point.y,
          },
        },
      };
    }
  }
}

function checkBrowser(
  action: Extract<Action, { kind: `browser_${string}` }>,
  view: View,
  why: string,
): Checked {
  if (!view.browser)
    return refuse("No browser is connected here. Use the screen.");
  if (!browserCan(action.kind, view.browserMethods))
    return refuse(
      "The browser that is connected cannot do that. Use another browser action or the screen.",
    );
  const ready = (
    label: string,
    target: string,
    risk: Ask | null,
    signature: string | null,
    call: BrowserCall,
  ): Checked => ({
    verdict: "run",
    label,
    target,
    ...asking(risk),
    signature,
    send: { via: "browser", call },
  });
  const scene = pageScene(view.page, view.goal);
  /** The element of the last page with this number, when it can take input. */
  const pick = (index: number) => {
    if (!view.page) return refuse("Read the page first, with browser_read.");
    const found = view.page.elements.find((item) => item.index === index);
    if (!found) return refuse(`The last page has no element ${index}.`);
    return found;
  };
  switch (action.kind) {
    case "browser_read":
      return ready("Read the page", "", null, null, { name: "read" });
    case "browser_scroll":
      return ready(`Scroll the page ${action.direction}`, "", null, null, {
        name: "scroll",
        direction: action.direction,
      });
    case "browser_back":
      return ready("Go back", "", null, "browser_back", { name: "back" });
    case "browser_open": {
      const link = safeLink(action.url);
      if (!link) return refuse(linkRefusal);
      const host = clean(link.hostname, 80);
      return ready(
        `Open ${host} in the browser`,
        host,
        addressRisk(link, view.goal),
        `browser_open|${action.url}`,
        { name: "open", url: action.url },
      );
    }
    case "browser_click": {
      const found = pick(action.index);
      if ("verdict" in found) return found;
      if (found.disabled)
        return refuse(`Element ${action.index} of the page is disabled.`);
      return ready(
        `Click ${pageName(found)} on the page`,
        clean(found.label, 80),
        pageTextEntry(found)
          ? null
          : (askFor(found.label, scene) ??
              // A control with no name: the planner's own words count too.
              (clean(found.label, 80) ? null : askFor(why, scene, "words"))),
        `browser_click|${found.tag}|${found.role}|${found.label}`,
        { name: "click", index: action.index, element: found },
      );
    }
    case "browser_type": {
      const found = pick(action.index);
      if ("verdict" in found) return found;
      const label = `Type in ${pageName(found)} on the page`;
      // A disabled field first: nobody can type in it, also not the person.
      if (found.disabled)
        return refuse(`Element ${action.index} of the page is disabled.`);
      if (found.password)
        return {
          verdict: "person_types",
          label,
          target: clean(found.label, 80),
        };
      const submit = action.submit === true;
      if (!action.text && !submit) return refuse("There is no text to type.");
      if (oneLine.test(action.text)) return refuse(lineRefusal);
      return ready(
        label,
        clean(found.label, 80),
        submit && view.page ? submitRisk(found, view.page, view.goal) : null,
        `browser_type|${found.tag}|${found.label}|${submit}|${action.text}`,
        {
          name: "type",
          index: action.index,
          text: action.text,
          submit,
          element: found,
        },
      );
    }
    case "browser_hover": {
      // A hover may name a disabled element: it sends no click and no text.
      const found = pick(action.index);
      if ("verdict" in found) return found;
      return ready(
        `Hover over ${pageName(found)} on the page`,
        clean(found.label, 80),
        null,
        `browser_hover|${found.tag}|${found.role}|${found.label}`,
        { name: "hover", index: action.index, element: found },
      );
    }
    case "browser_select": {
      const found = pick(action.index);
      if ("verdict" in found) return found;
      if (found.disabled)
        return refuse(`Element ${action.index} of the page is disabled.`);
      if (found.password || !pageChoice(found))
        return refuse(
          `Element ${action.index} of the page is not a list of choices. Use browser_click.`,
        );
      if (/\p{C}/u.test(action.option) || !clean(action.option, 400))
        return refuse("Name the option on one line, as the page shows it.");
      const option = clean(action.option, 400);
      return ready(
        `Choose "${clean(option, 60)}" in ${pageName(found)} on the page`,
        clean(found.label, 80),
        // The choice is what a click on it would press: an option such as
        // "Delete selected" asks, as a button with that name does.
        askFor(option, scene),
        `browser_select|${found.tag}|${found.role}|${found.label}|${option}`,
        { name: "select", index: action.index, option, element: found },
      );
    }
    case "browser_key": {
      const key = parsePageKey(action.combo);
      if (!key)
        return refuse(
          "That is not a key that a page takes here: Enter, Escape, Tab, Shift+Tab, the arrow keys, PageUp, PageDown, Home, End, Backspace or Space.",
        );
      if (!view.page) return refuse("Read the page first, with browser_read.");
      return ready(
        `Press ${key} on the page`,
        key,
        pageKeyRisk(key, view.page, view.goal),
        `browser_key|${key}`,
        { name: "key", combo: key },
      );
    }
    case "browser_wait": {
      if (
        action.text !== undefined &&
        (/\p{C}/u.test(action.text) || !clean(action.text, 200))
      )
        return refuse(
          "Give the words to wait for on one line, or leave them out.",
        );
      const text = action.text === undefined ? null : clean(action.text, 200);
      // A wait changes nothing on the page: it may repeat, as a reading does.
      return ready("Wait for the page", "", null, null, {
        name: "wait",
        text,
        ms: action.ms,
      });
    }
    case "browser_tabs":
      return ready("List the tabs", "", null, null, { name: "tabs" });
    case "browser_switch_tab": {
      const listed = view.page?.tabs;
      if (!listed) return refuse("List the tabs first, with browser_tabs.");
      const tab = listed.find((item) => item.index === action.tab);
      if (!tab)
        return refuse(`The last list of tabs has no tab ${action.tab}.`);
      const title = clean(tab.title, 80);
      return ready(
        title ? `Switch to the tab "${title}"` : "Switch to another tab",
        title,
        null,
        `browser_switch_tab|${tab.url}|${tab.title}`,
        { name: "switch_tab", tab: action.tab, listed: tab },
      );
    }
    default:
      return refuse("That is not one known action with valid arguments.");
  }
}

const sameKind = (left: ScreenElement, right: ScreenElement) =>
  left.role === right.role &&
  left.title === right.title &&
  left.secure === right.secure;
const samePlace = (left: ScreenElement, right: ScreenElement) => {
  const tol = left.role === "OCRText" ? 6 : 2;
  return (
    Math.abs(left.x - right.x) <= tol &&
    Math.abs(left.y - right.y) <= tol &&
    Math.abs(left.w - right.w) <= tol &&
    Math.abs(left.h - right.h) <= tol
  );
};

/**
 * The same action against a newer look at the screen. The number of an element
 * names it inside one observation only, so the element is found again by its
 * role, its name and its place. The result is refused when another app or
 * window is in front, when the element is gone, when two elements could be it,
 * or when something else is under the point.
 */
export function retarget(
  action: Action,
  before: Observation,
  after: Observation,
):
  | { ok: true; action: Action; observation: Observation }
  | { ok: false; reason: string } {
  if (
    before.surfaceEpoch !== after.surfaceEpoch ||
    before.screen.width !== after.screen.width ||
    before.screen.height !== after.screen.height ||
    before.screen.scale !== after.screen.scale
  )
    return {
      ok: false,
      reason:
        "The desktop or display changed. Old coordinates were retired; nothing was sent.",
    };
  if (
    before.app.bundleId !== after.app.bundleId ||
    !sameWindowTitle(before.app.window, after.app.window)
  )
    return {
      ok: false,
      reason: "Another app or window came to the front. Nothing was sent.",
    };
  // A look that took no image keeps the size of the last image, when the screen is the same.
  const observation: Observation =
    after.imageWidth ||
    !before.imageWidth ||
    !before.imageHeight ||
    before.screen.width !== after.screen.width ||
    before.screen.height !== after.screen.height
      ? after
      : {
          ...after,
          imageWidth: before.imageWidth,
          imageHeight: before.imageHeight,
        };
  const gone = {
    ok: false as const,
    reason:
      "The screen changed: the target is no longer there. Nothing was sent.",
  };
  if (action.kind === "click_at") {
    const point = screenPoint(before, action.x, action.y);
    if (typeof point === "string") return gone;
    const was = under(before, point);
    const is = under(after, point);
    if (was === null ? is !== null : is === null || !sameKind(was, is))
      return gone;
    return { ok: true, action, observation };
  }
  /** The number of the same element in the newer look. Null when it is gone or two could be it. */
  const again = (id: number) => {
    const was = before.elements.find((item) => item.id === id);
    if (!was) return null;
    const alike = after.elements.filter((item) => sameKind(item, was));
    const found =
      alike.find((item) => samePlace(item, was)) ??
      (alike.length === 1 ? alike[0] : undefined);
    return found ? found.id : null;
  };
  /** True when the same thing, or nothing, lies under this point of the last image. */
  const stays = (x: number, y: number) => {
    const point = screenPoint(before, x, y);
    if (typeof point === "string") return false;
    const was = under(before, point);
    const is = under(after, point);
    return was === null ? is === null : is !== null && sameKind(was, is);
  };
  if (action.kind === "hover") {
    if (action.element === undefined)
      return stays(action.x ?? Number.NaN, action.y ?? 0)
        ? { ok: true, action, observation }
        : gone;
    const found = again(action.element);
    if (found === null) return gone;
    return { ok: true, action: { ...action, element: found }, observation };
  }
  if (action.kind === "drag") {
    // Both ends must be where they were: a drag that lands elsewhere moves
    // something to a place that nobody chose.
    const end = (given: DragEnd): DragEnd | null => {
      if (!("element" in given)) return stays(given.x, given.y) ? given : null;
      const found = again(given.element);
      return found === null ? null : { element: found };
    };
    const from = end(action.from);
    const to = end(action.to);
    if (!from || !to) return gone;
    return { ok: true, action: { ...action, from, to }, observation };
  }
  if (
    (action.kind === "click_element" ||
      action.kind === "type" ||
      action.kind === "scroll") &&
    action.element !== undefined
  ) {
    const was = before.elements.find((item) => item.id === action.element);
    if (!was) return gone;
    const alike = after.elements.filter((item) => sameKind(item, was));
    const found =
      alike.find((item) => samePlace(item, was)) ??
      (alike.length === 1 ? alike[0] : undefined);
    if (!found) return gone;
    return { ok: true, action: { ...action, element: found.id }, observation };
  }
  return { ok: true, action, observation };
}

/**
 * True when the input presses an element of the look: a click on an
 * element, a click at a point inside one, or a drag from or onto one. A
 * label can change in place with no change that a picture shows (Cancel
 * becomes Delete), so the worker reads the element's own name and role
 * again, with a walk of the tree, just before such an input goes.
 */
export function pressesElement(action: Action, observation: Observation) {
  const at = (x: number, y: number) => {
    const point = screenPoint(observation, x, y);
    return typeof point !== "string" && under(observation, point) !== null;
  };
  switch (action.kind) {
    case "click_element":
      return true;
    case "click_at":
      return at(action.x, action.y);
    case "drag":
      return [action.from, action.to].some((end) =>
        "element" in end ? true : at(end.x, end.y),
      );
    default:
      return false;
  }
}

/** The tab of a newer list that is the same as this one: the same address and title. Null when it is gone or two could be it. */
export function sameTab(was: BrowserTab, tabs: BrowserTab[] | undefined) {
  const alike = (tabs ?? []).filter(
    (item) => item.url === was.url && item.title === was.title,
  );
  return (
    alike.find((item) => item.index === was.index) ??
    (alike.length === 1 ? alike[0]! : null)
  );
}

/**
 * The same browser action against a newer reading, just before it is sent.
 * The newer reading must be of the same page as the reading that the
 * planner chose from (`read`): the same tab, and the same origin and path of
 * the address (`samePage`). An element is found again as `samePageElement`
 * finds it, and a tab by its address and its title. A key has no target of
 * its own: it is checked again against the newer reading. Null when the page
 * or the target is gone, or two could be it.
 */
export function againstPage(
  action: Action,
  call: BrowserCall,
  now: BrowserPage,
  read: BrowserPage,
): Action | null {
  if (call.name !== "switch_tab" && !samePage(read, now)) return null;
  if ("element" in call) {
    const same = samePageElement(call.element, now);
    return same ? ({ ...action, index: same.index } as Action) : null;
  }
  if (call.name === "switch_tab") {
    const same = sameTab(call.listed, now.tabs);
    return same ? ({ ...action, tab: same.index } as Action) : null;
  }
  return action;
}

/**
 * True when two readings are of the same page: the same tab, as the driver
 * names it, and the same origin and path of the address. Its query and its
 * fragment may change: a page writes its state there. The same button on
 * another site, or on another page of the same site, is another button.
 */
export function samePage(was: BrowserPage, now: BrowserPage) {
  if (was.tab !== now.tab) return false;
  const place = (url: string) => {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return null;
    }
  };
  const before = place(was.url);
  return before !== null && before === place(now.url);
}

/** The element of a newer reading of the page that is the same as this one. Null when it is gone or two could be it. */
export function samePageElement(was: BrowserElement, page: BrowserPage) {
  const alike = page.elements.filter(
    (item) =>
      item.tag === was.tag &&
      item.role === was.role &&
      item.label === was.label &&
      item.password === was.password &&
      item.href === was.href,
  );
  return (
    alike.find((item) => item.index === was.index) ??
    (alike.length === 1 ? alike[0]! : null)
  );
}
