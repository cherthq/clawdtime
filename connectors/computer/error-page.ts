/**
 * Computer use: a page that did not load.
 *
 * A browser shows a page of its own when an address does not load: the name
 * was not found, the server did not answer, the page is not there. A planner
 * that sees one may still call done and say what the page shows. That is no
 * result. Spoken words are often misheard (a made-up "Brightwave" written as "Bright5"), so
 * the address may be wrong, and the way on is a search for the name.
 *
 * Only the browsers' own wording counts, read from the page or from the
 * screen while a browser is in front. What is said back is one of the fixed
 * labels below, never text of the page: that text is data.
 */
import { supportedBrowsers } from "./browser.js";
import type { BrowserPage, Observation } from "./ports.js";

const browserApps = new Set(supportedBrowsers.map((browser) => browser.id));

/** The words of the error pages, with what each one means. The kind of apostrophe does not count. */
const errorWords: readonly { label: string; words: RegExp }[] = [
  {
    label: "the site cannot be reached",
    words: /this site can.?t be reached/i,
  },
  {
    label: "the server was not found",
    words:
      /server IP address could not be found|safari can.?t find the server|\bDNS_PROBE_[A-Z_]+|\bERR_NAME_NOT_RESOLVED\b/i,
  },
  { label: "the page cannot be opened", words: /safari can.?t open the page/i },
  { label: "the page is not working", words: /this page isn.?t working/i },
  { label: "a network error", words: /\bERR_[A-Z_]{4,}\b/ },
  { label: "the page was not found", words: /\bHTTP ERROR 404\b/i },
  { label: "the page is not working", words: /\bHTTP ERROR 5\d\d\b/i },
];
/** A title of a page that is not there: "404", "Not Found", "Page not found". */
const missingTitle = /\b404\b|\bnot found\b/i;
/** The same words as the headline of a page: near its start, where an error page puts them. */
const missingHeadline =
  /\b404\b\W+(?:\w+\W+){0,2}?not found\b|\bnot found\W+404\b|\berror\W*404\b|\b404\W*error\b|^\W*(?:page\s+)?not found\b/i;
/** How much of the start of a page is read for the headline. */
const headlineChars = 600;
/** How much of the screen is read: the toolbar and the tabs of the browser come first. */
const screenChars = 3000;
/** A goal about an error itself: the error page may be what it asks to see. */
const aboutErrors =
  /\b(?:404|errors?|not found|can.?t be reached|ERR_\w+|DNS\w*)\b/i;

const wordsIn = (text: string) =>
  errorWords.find((row) => row.words.test(text))?.label ?? null;

/** What a reading of the page shows when it is an error page, as a fixed label, or null. */
export function pageError(page: BrowserPage | null): string | null {
  if (!page) return null;
  const url = page.url.trim();
  // The address of Chrome's own error page, and Safari's title for one.
  if (/^chrome-error:/i.test(url)) return "an error page of the browser";
  if (/^failed to open page$/i.test(page.title.trim()))
    return "the page cannot be opened";
  const start = page.text.slice(0, headlineChars);
  const found = wordsIn(`${page.title}\n${start}`);
  if (found) return found;
  if (missingTitle.test(page.title) || missingHeadline.test(start.trim()))
    return "the page was not found";
  // A tab with nothing at all at a web address: no title, no text, no element.
  if (
    /^https?:/i.test(url) &&
    !page.title.trim() &&
    !page.text.trim() &&
    page.elements.length === 0
  )
    return "an empty page";
  return null;
}

/** What the screen shows when a browser is in front with an error page, as a fixed label, or null. */
export function screenError(observation: Observation | null): string | null {
  if (!observation || !browserApps.has(observation.app.bundleId)) return null;
  const window = observation.app.window;
  const texts = observation.elements
    .map((item) => [item.title, item.value ?? ""].join(" ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, screenChars);
  const found = wordsIn(`${window}\n${texts}`);
  if (found) return found;
  if (missingTitle.test(window)) return "the page was not found";
  return null;
}

/**
 * An error page in front, on the page that was read or on the screen, as a
 * fixed label. Null when none shows, and for a goal about an error itself
 * ("why does the shop show a 404?"), where that page can be the answer.
 */
export const errorPage = (
  observation: Observation | null,
  page: BrowserPage | null,
  goal = "",
): string | null =>
  aboutErrors.test(goal) ? null : (pageError(page) ?? screenError(observation));

/** What the planner reads when a page did not load. */
export const notLoadedNote = (shows: string) =>
  `the page did not load (the browser shows ${shows}). The address may be misheard or misspelled: search the web for the name that the owner said, open the site that fits, then check that it loaded.`;
