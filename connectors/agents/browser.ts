import type { Runner } from "./focus.js";

/**
 * Browser use, as far as the browser's own scripting goes: list the open tabs,
 * open a page, bring a tab forward, and read the text of the front page.
 * macOS asks for Automation permission for each browser once. Reading page
 * text also needs the browser's "Allow JavaScript from Apple Events" setting.
 */
export const browsers = [
  "Google Chrome",
  "Safari",
  "Arc",
  "Brave Browser",
  "Microsoft Edge",
] as const;
export type BrowserName = (typeof browsers)[number];

export interface BrowserTab {
  browser: BrowserName;
  window: number;
  tab: number;
  active: boolean;
  title: string;
  url: string;
}

// Safari names its tab title "name" and its front tab "current tab"; the others follow Chrome.
const listScript = (browser: BrowserName) =>
  browser === "Safari"
    ? `tell application "Safari"
  set out to ""
  repeat with w from 1 to count of windows
    set front to index of current tab of window w
    repeat with t from 1 to count of tabs of window w
      set out to out & w & tab & t & tab & (t is front) & tab & (name of tab t of window w) & tab & (URL of tab t of window w) & linefeed
    end repeat
  end repeat
  return out
end tell`
    : `tell application "${browser}"
  set out to ""
  repeat with w from 1 to count of windows
    set front to active tab index of window w
    repeat with t from 1 to count of tabs of window w
      set out to out & w & tab & t & tab & (t is front) & tab & (title of tab t of window w) & tab & (URL of tab t of window w) & linefeed
    end repeat
  end repeat
  return out
end tell`;

const clean = (value: string, max: number) =>
  value.replace(/\p{C}/gu, " ").trim().slice(0, max);

export function parseTabs(browser: BrowserName, output: string): BrowserTab[] {
  const tabs: BrowserTab[] = [];
  for (const line of output.split("\n")) {
    const [window, tab, active, title, ...url] = line.split("\t");
    if (!window || !tab || !/^\d+$/.test(window) || !/^\d+$/.test(tab))
      continue;
    tabs.push({
      browser,
      window: Number(window),
      tab: Number(tab),
      active: active === "true",
      title: clean(title ?? "", 200),
      url: clean(url.join("\t"), 2000),
    });
  }
  return tabs.slice(0, 500);
}

/** Tabs of the browsers that run. A browser that is not running is never started. */
export async function listTabs(
  running: BrowserName[],
  run: Runner,
): Promise<BrowserTab[]> {
  const all: BrowserTab[] = [];
  for (const browser of running) {
    const result = await run(
      "/usr/bin/osascript",
      ["-e", listScript(browser)],
      8000,
    );
    if (result.status === 0) all.push(...parseTabs(browser, result.stdout));
  }
  return all;
}

/** Only web addresses. Anything else, a file or a script, is refused. */
export function webAddress(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Give a full web address, for example https://trychert.com",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Only http and https addresses open in the browser.");
  return url.toString();
}

export async function openPage(
  address: string,
  browser: BrowserName | null,
  run: Runner,
) {
  const url = webAddress(address);
  const args = browser ? ["-a", browser, url] : [url];
  return (await run("/usr/bin/open", args, 8000)).status === 0;
}

export async function focusTab(
  tab: Pick<BrowserTab, "browser" | "window" | "tab">,
  run: Runner,
) {
  const script =
    tab.browser === "Safari"
      ? `on run argv
  tell application "Safari"
    set current tab of window ((item 1 of argv) as integer) to tab ((item 2 of argv) as integer) of window ((item 1 of argv) as integer)
    set index of window ((item 1 of argv) as integer) to 1
    activate
  end tell
  return "ok"
end run`
      : `on run argv
  tell application "${tab.browser}"
    set active tab index of window ((item 1 of argv) as integer) to ((item 2 of argv) as integer)
    set index of window ((item 1 of argv) as integer) to 1
    activate
  end tell
  return "ok"
end run`;
  const result = await run(
    "/usr/bin/osascript",
    ["-e", script, String(tab.window), String(tab.tab)],
    8000,
  );
  return result.status === 0 && result.stdout.trim() === "ok";
}

/** The visible text of the front page, cut to a bounded length. null when the browser refuses. */
export async function frontPageText(
  browser: BrowserName,
  run: Runner,
  limit = 20_000,
) {
  const read =
    "document.title + String.fromCharCode(10) + document.body.innerText";
  const script =
    browser === "Safari"
      ? `tell application "Safari" to return do JavaScript "${read}" in current tab of front window`
      : `tell application "${browser}" to return execute active tab of front window javascript "${read}"`;
  const result = await run("/usr/bin/osascript", ["-e", script], 10_000);
  if (result.status !== 0) return null;
  return result.stdout
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .slice(0, limit);
}

export const frontCommands = ["reload", "back", "forward"] as const;
export type FrontCommand = (typeof frontCommands)[number];

/**
 * Reloads the front page, or goes one page back or forward, through the
 * browser's own scripting. It sends no key and no click. Safari offers only
 * the reload this way. false: the browser refused, or has no such command.
 */
export async function frontCommand(
  browser: BrowserName,
  command: FrontCommand,
  run: Runner,
) {
  const script =
    browser === "Safari"
      ? command === "reload"
        ? `tell application "Safari"
  set page to URL of front document
  set URL of front document to page
  return "ok"
end tell`
        : null
      : `tell application "${browser}"
  ${command === "reload" ? "reload" : command === "back" ? "go back" : "go forward"} active tab of front window
  return "ok"
end tell`;
  if (!script) return false;
  const result = await run("/usr/bin/osascript", ["-e", script], 8000);
  return result.status === 0 && result.stdout.trim() === "ok";
}
