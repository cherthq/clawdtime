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
  HandCommand,
  Observation,
  ScreenElement,
} from "./ports.js";
import { webAddress } from "./navigation.js";

const finite = z.number().finite();
const number = z.number().int().nonnegative();
const words = (limit: number) => z.string().max(limit);
const direction = z.enum(["up", "down"]);
const flag = z.boolean().optional();

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
    })
    .strict(),
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
  z
    .object({
      kind: z.literal("wait"),
      ms: z.number().int().min(0).max(10_000),
    })
    .strict(),
  z.object({ kind: z.literal("ask"), question: words(2000) }).strict(),
  z.object({ kind: z.literal("done"), summary: words(4000) }).strict(),
  z.object({ kind: z.literal("give_up"), reason: words(2000) }).strict(),
]) satisfies z.ZodType<Action>;

/** One clean line: no control character, no run of spaces. */
export const clean = (value: string, limit: number) =>
  value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, limit);

/**
 * Words in a name that say an action that cannot be undone, or that speaks
 * for the person. A click on such a name needs the person's yes. A word counts
 * only as a whole word: "Sender" and "Reorder" do not count.
 */
export const dangerWords = [
  "send",
  "delete",
  "remove",
  "erase",
  "pay",
  "buy",
  "order",
  "submit",
  "post",
  "publish",
  "share",
  "transfer",
  "confirm",
  "sign out",
  "log out",
  "empty trash",
  "reset",
  "format",
  "purchase",
  "check out",
  "donate",
  "discard",
  "trash",
  "uninstall",
  "wipe",
  "shut down",
  "restart",
  "log off",
  "quit",
  "replace",
  "overwrite",
  "revert",
  "don't save",
  // A program that still ran is gone.
  "terminate",
  // A name that gives a yes in the person's place: a permission of macOS, a
  // request of an agent, the terms of a site.
  "approve",
  "allow",
  "accept",
  "authorize",
  "authorise",
  "grant",
  "agree",
  "permit",
  "trust",
] as const;
// A space in a word also stands for no space and for a hyphen: "log out",
// "logout", "log-out". An apostrophe also stands for the curved one.
const danger = new RegExp(
  `\\b(?:${dangerWords
    .map((word) => word.replace(/ /g, "[\\s-]*").replace(/'/g, "['\u2019]?"))
    .join("|")})\\b`,
  "i",
);
/**
 * A close takes away what was open. It asks, except when the person's own
 * request says to close or to dismiss: then the person asked for it already,
 * and a question for each banner, tab and window is one too many. What can
 * be lost with a close keeps its own question: "Don't Save", "Delete",
 * "Terminate". A request that says not to close asks as before: a word of
 * denial up to four words before the close counts, which errs to a question.
 *
 * Only a plain close control goes without the question: a name that is
 * "Close" alone, or with the thing that closes on the screen ("Close tab").
 * "Close account" or "Close issue" ends something that is not a view, and
 * asks whatever the request says.
 */
const closing = /\bclose\b/i;
const plainClose =
  /^(?:close|dismiss)(?:\s+(?:this|the))?(?:\s+(?:button|tab|window|banner|dialog|panel|sidebar|pop-?up|notification|message|sheet|drawer|menu|search|alert|preview))?$/i;
export const askedToClose = (goal: string | undefined) =>
  !!goal &&
  /\b(?:close|dismiss)\b/i.test(goal) &&
  !/\b(?:don['\u2019]?t|do not|never|not|without)\s+(?:\w+\s+){0,4}(?:close|dismiss)\b/i.test(
    goal,
  );
/**
 * `words` is true when the name is the planner's own sentence about a point
 * with no named element: a sentence is no name of a control, so only the
 * request decides for it.
 */
const dangerRisk = (name: string, goal?: string, words = false) => {
  let found = danger.exec(name);
  if (!found) {
    found = closing.exec(name);
    if (
      found &&
      askedToClose(goal) &&
      (words || plainClose.test(clean(name, 80)))
    )
      found = null;
  }
  return found
    ? `"${clean(found[0], 40)}" may be something that cannot be undone, or that speaks for you.`
    : null;
};
const terminalRisk =
  "This goes into a terminal, where text can run as a command.";
const appQuitRisk =
  "This quits the app, with what is open in it. Work that is not saved can be lost.";
const quitRisk =
  "This key combination can quit an app, log out or lock the Mac.";
const removeRisk = "This key combination can remove something.";
const closeRisk =
  "This key combination closes a window or a tab, with what is open in it.";
const sendRisk = "This key usually sends or submits what is typed.";
const submitRisk = "This submits a form.";

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
function keyRisk(
  parsed: NonNullable<ReturnType<typeof parseCombo>>,
  observation: Observation,
  goal?: string,
) {
  const { key, modifiers } = parsed;
  if (inTerminal(observation)) return terminalRisk;
  // Quit, log out with shift, lock with ctrl; and the force-quit window.
  if (modifiers.has("cmd") && key === "q") return quitRisk;
  if (modifiers.has("cmd") && modifiers.has("opt") && key === "escape")
    return quitRisk;
  if (modifiers.has("cmd") && (key === "delete" || key === "forwarddelete"))
    return removeRisk;
  // Close a window or a tab, in any form (with shift: all of them).
  if (modifiers.has("cmd") && key === "w")
    return askedToClose(goal) ? null : closeRisk;
  if (key === "return" && (modifiers.has("cmd") || modifiers.has("ctrl")))
    return sendRisk;
  if (key === "return" && !modifiers.size && sendsOnReturn(observation.app))
    return sendRisk;
  // The mail app sends with this one.
  if (
    key === "d" &&
    modifiers.has("cmd") &&
    modifiers.has("shift") &&
    observation.app.bundleId.toLowerCase() === "com.apple.mail"
  )
    return sendRisk;
  // Return and Space press the default button of a window, the chosen item of
  // an open menu, and whatever has the focus. So a key can do what a click on
  // "Delete" does. With the focus in a text field the key goes to the text,
  // and this does not apply.
  if ((key === "return" || key === "space") && !modifiers.size) {
    const writing = observation.elements.some(
      (item) => item.focused && textRoles.has(item.role),
    );
    const button = writing
      ? undefined
      : observation.elements.find(
          (item) =>
            item.enabled &&
            (item.role === "AXButton" ||
              item.role === "AXMenuItem" ||
              item.focused) &&
            danger.test(item.title),
        );
    if (button)
      return `This key can press "${clean(button.title, 40)}", which may be something that cannot be undone, or that speaks for you.`;
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
/** A site as the checks compare it: its host with no "www." in front, and its port when it has one. */
const siteKey = (url: URL) =>
  `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.port ? `:${url.port}` : ""}`;
/**
 * The sites that the person's own words name. Each word is read as the
 * reader of a direct request reads an address (`webAddress`): "example.com",
 * "https://Example.com/board," and "localhost:3000" name a site; a file name
 * ("README.md"), a mail address and a word in another script do not.
 */
function sitesIn(said: string) {
  const sites = new Set<string>();
  for (const word of said.split(/\s+/)) {
    const found = webAddress(word);
    if (found) sites.add(siteKey(found.url));
  }
  return sites;
}
/** A path and a query longer than this, that the person did not write, can carry what the screen shows. */
const longAddressPart = 120;
/**
 * An address that the planner chose is a plan that nobody checked, as every
 * other part of its action. It may open with no question only when the
 * person's own request holds its site, with the same port; with plain http
 * only when the person wrote http, or for a server of this Mac; and with a
 * long path or query only when the person wrote it. For every other address
 * the person says yes first, and the question names the site.
 */
const unaskedRisk = (link: URL, goal?: string) => {
  const host = clean(link.host, 80);
  const said = goal ?? "";
  if (!sitesIn(said).has(siteKey(link)))
    return `The address ${host} is not in your request.`;
  const own = link.hostname === "localhost" || link.hostname === "127.0.0.1";
  if (
    link.protocol === "http:" &&
    !own &&
    !said.toLowerCase().includes(`http://${link.hostname.toLowerCase()}`) &&
    !said.toLowerCase().includes(`http://www.${link.hostname.toLowerCase()}`)
  )
    return `The address ${host} would open with plain http, which you did not ask for.`;
  const rest = `${link.pathname}${link.search}`;
  if (
    rest.length > longAddressPart &&
    !said.toLowerCase().includes(rest.toLowerCase())
  )
    return `The address ${host} carries a long part that is not in your request.`;
  return null;
};
/** Words of a browser's name that name nothing by themselves. */
const browserFillers = new Set([
  "the",
  "my",
  "a",
  "an",
  "your",
  "our",
  "browser",
  "web",
  "app",
]);
/**
 * A browser that the planner chose: it opens the address with no question
 * only when the person named it, by a word of its name ("Fixture" for
 * "Fixture Browser"). Another app that opens web addresses could read the page.
 */
const browserRisk = (browser: string, goal?: string) => {
  const said = new Set((goal ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u));
  const named = browser
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !browserFillers.has(word));
  return named.length && named.some((word) => said.has(word))
    ? null
    : `The browser ${clean(browser, 60)} is not in your request.`;
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
/** The smallest element that holds the point. */
function under(observation: Observation, point: { x: number; y: number }) {
  let best: ScreenElement | null = null;
  for (const item of observation.elements)
    if (
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
  /** The person's own request, word for word. Only it can say that a close was asked for. */
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
  | { name: "back" };

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
      /** Why the person's yes is needed first. Null when it is not. */
      risk: string | null;
      /** The same for the same target and arguments. Null for an action that may repeat. */
      signature: string | null;
      send: Send;
    }
  | { verdict: "ask"; question: string }
  | { verdict: "done"; summary: string }
  | { verdict: "give_up"; reason: string };

const refuse = (reason: string): Checked => ({ verdict: "refuse", reason });
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
        risk: null,
        signature: null,
        send: {
          via: "hands",
          look: false,
          command: { kind: "wait", ms: action.ms },
        },
      };
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
        risk: null,
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
        // A quit always asks: work that is not saved, and what still runs in the app, can be lost.
        risk: appQuitRisk,
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
        risk:
          unaskedRisk(link, view.goal) ??
          (browser ? browserRisk(browser, view.goal) : null),
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
      return checkBrowser(action, view);
    default:
      return checkScreen(action, view, why);
  }
}

function checkScreen(
  action: Extract<
    Action,
    { kind: "click_element" | "click_at" | "type" | "key" | "scroll" }
  >,
  view: View,
  why: string,
): Checked {
  const seen = view.observation;
  if (!seen || !view.fresh)
    return refuse("There is no fresh view of the screen. Nothing was sent.");
  /** The element with this number, when it can take input. */
  const pick = (id: number) => {
    const found = seen.elements.find((item) => item.id === id);
    if (!found) return refuse(`The last observation has no element ${id}.`);
    if (!found.enabled) return refuse(`Element ${id} is disabled.`);
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
      return {
        verdict: "run",
        label: `${verb(action.double, action.right)} ${nameOf(found)}`,
        target: clean(found.title, 80),
        // A click on a text field only gives it the focus.
        risk: textRoles.has(found.role)
          ? null
          : dangerRisk(found.title, view.goal),
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
      if (point === "no_image")
        return refuse(
          "The last observation has no image, so a point has no meaning.",
        );
      if (point === "outside")
        return refuse("That point is outside the last image.");
      const found = under(seen, point);
      const named = found && clean(found.title, 80) ? found : null;
      return {
        verdict: "run",
        label: named
          ? `${verb(action.double, action.right)} ${nameOf(named)}`
          : `${verb(action.double, action.right)} at a point`,
        target: named ? clean(named.title, 80) : "",
        // With no name under the point, the planner's own words are the only
        // name there is. They can add a question. They never remove one.
        risk: named
          ? textRoles.has(named.role)
            ? null
            : dangerRisk(named.title, view.goal)
          : dangerRisk(why, view.goal, true),
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
        risk: inTerminal(seen) ? terminalRisk : null,
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
        risk: keyRisk(parsed, seen, view.goal),
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
        risk: null,
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
            dy: action.direction === "down" ? 5 : -5,
          },
        },
      };
    }
  }
}

function checkBrowser(
  action: Extract<Action, { kind: `browser_${string}` }>,
  view: View,
): Checked {
  if (!view.browser)
    return refuse("No browser is connected here. Use the screen.");
  const ready = (
    label: string,
    target: string,
    risk: string | null,
    signature: string | null,
    call: BrowserCall,
  ): Checked => ({
    verdict: "run",
    label,
    target,
    risk,
    signature,
    send: { via: "browser", call },
  });
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
        unaskedRisk(link, view.goal),
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
        pageTextEntry(found) ? null : dangerRisk(found.label, view.goal),
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
        submit && !pageSearch(found) ? submitRisk : null,
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
    default:
      return refuse("That is not one known action with valid arguments.");
  }
}

const sameKind = (left: ScreenElement, right: ScreenElement) =>
  left.role === right.role &&
  left.title === right.title &&
  left.secure === right.secure;
const samePlace = (left: ScreenElement, right: ScreenElement) =>
  Math.abs(left.x - right.x) <= 2 &&
  Math.abs(left.y - right.y) <= 2 &&
  Math.abs(left.w - right.w) <= 2 &&
  Math.abs(left.h - right.h) <= 2;

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
    before.app.window !== after.app.window
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
