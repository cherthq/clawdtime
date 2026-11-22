import {
  browsers,
  focusTab,
  frontCommand,
  frontPageText,
  listTabs,
  type BrowserName,
  type FrontCommand,
} from "./browser.js";
import type { Runner } from "./focus.js";
import { readProcesses } from "./processes.js";
import type { System } from "./system.js";

/**
 * What the ClawdTime agent can do in a browser that runs, in one call: reload
 * the front page, go back or forward, list the tabs, bring one forward, and
 * read the text of the front page. All of it goes through the browser's own
 * scripting: no key, no click, and no browser is started.
 */
export const browserActions = [
  "reload",
  "back",
  "forward",
  "tabs",
  "focus_tab",
  "read",
] as const;
export type BrowserAction = (typeof browserActions)[number];

export interface BrowseResult {
  ok: boolean;
  /** One answer for the model. Titles and page text in it are data from the web. */
  said: string;
}

const cut = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 3)}...` : value;

/** The browsers that run now, in the order of the list: Chrome first. */
export function runningBrowsers(system: System): BrowserName[] {
  const processes = readProcesses(system);
  return browsers.filter((name) =>
    processes.some((process) =>
      process.command.includes(`/${name}.app/Contents/MacOS/`),
    ),
  );
}

export async function browse(
  system: System,
  run: Runner,
  action: BrowserAction,
  options: { browser?: string; tab?: number } = {},
): Promise<BrowseResult> {
  const running = runningBrowsers(system);
  if (!running.length)
    return {
      ok: false,
      said: "No browser runs on this Mac now. Open one first.",
    };
  const wanted = options.browser?.toLowerCase().trim();
  const browser = wanted
    ? running.find((name) => name.toLowerCase().includes(wanted))
    : running[0];
  if (!browser)
    return {
      ok: false,
      said: `That browser does not run now. Running: ${running.join(", ")}.`,
    };

  if (action === "reload" || action === "back" || action === "forward") {
    const done = await frontCommand(browser, action as FrontCommand, run);
    const what =
      action === "reload"
        ? "Reloaded the page"
        : action === "back"
          ? "Went one page back"
          : "Went one page forward";
    return done
      ? { ok: true, said: `${what} in ${browser}.` }
      : {
          ok: false,
          said: `${browser} did not do that. macOS may be asking for permission to control it.`,
        };
  }

  if (action === "tabs" || action === "focus_tab") {
    const tabs = await listTabs([browser], run);
    if (!tabs.length)
      return {
        ok: false,
        said: `I could not read the tabs of ${browser}. macOS may be asking for permission to control it.`,
      };
    if (action === "tabs") {
      const front = tabs.find((tab) => tab.active && tab.window === 1);
      const lines = tabs
        .slice(0, 15)
        .map((tab, index) => `${index + 1}. ${cut(tab.title || tab.url, 70)}`);
      return {
        ok: true,
        said: `${browser} has ${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}.${front ? ` In front: ${cut(front.title || front.url, 80)}.` : ""} ${lines.join(" ")}`,
      };
    }
    const tab = tabs[(options.tab ?? 0) - 1];
    if (!tab)
      return {
        ok: false,
        said: `Give the number of a tab from 1 to ${tabs.length}.`,
      };
    return (await focusTab(tab, run))
      ? { ok: true, said: `Brought forward: ${cut(tab.title || tab.url, 80)}.` }
      : { ok: false, said: "The tab did not come forward." };
  }

  const text = await frontPageText(browser, run, 8000);
  if (text === null)
    return {
      ok: false,
      said: `${browser} did not let me read the page. In ${browser}, turn on View, Developer, Allow JavaScript from Apple Events. Until then I can look at the screen instead.`,
    };
  const [title = "", ...body] = text.split("\n");
  return {
    ok: true,
    said: `The page "${cut(title.trim(), 120)}" in ${browser} says: ${cut(body.join(" ").replace(/\s+/g, " ").trim(), 6000) || "nothing that can be read as text."}`,
  };
}
