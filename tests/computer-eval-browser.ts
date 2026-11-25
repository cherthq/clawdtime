/**
 * A browser for the request eval: tabs of headless Chromium, driven by the
 * driver of the product with its own page script.
 *
 * Where the driver would start /usr/bin/osascript, the command runner here
 * does the same in the tab in front: the page script is evaluated in that
 * page and its answer is printed as osascript prints it. So reading,
 * clicking, typing, scrolling and going back are the driver's own code
 * (`AppleEventsBrowser` and `browser-script.ts`), with its numbers and its
 * wait for a settled page.
 *
 * The contract of this change adds optional methods: hover, select, key,
 * waitFor, tabs, switchTab and close. The driver of this build has none of
 * them, so this port gives them on top of it: a hover is a move of the
 * headless pointer to the element that the page script numbered, a select is
 * the page script's own choice in a list, a key is a key of the headless
 * keyboard, and the tabs are the pages of the context. Their pages carry the
 * fields that the contract adds (`tabs`, `found`), typed loosely here.
 *
 * Every page comes from `sites`, served in the context itself: nothing goes
 * to the network, no window opens and no browser of the person is used.
 */
import type { BrowserContext, Page } from "@playwright/test";
import {
  AppleEventsBrowser,
  openScript,
  probeScript,
  runScript,
  supportedBrowsers,
  type CommandRunner,
} from "../connectors/computer/browser.js";
import type { BrowserPage, BrowserPort } from "../connectors/computer/ports.js";

const chrome = supportedBrowsers.find(
  (item) => item.id === "com.google.Chrome",
)!;

export interface EvalTab {
  index: number;
  title: string;
  url: string;
  active: boolean;
}
/** A reading with the fields that the contract adds. */
export type EvalPage = BrowserPage & { tabs?: EvalTab[]; found?: boolean };

/** The keys that the contract allows in a page, in the names of the headless keyboard. */
const pageKeys = new Set([
  "Enter",
  "Escape",
  "Tab",
  "Shift+Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Backspace",
  "Space",
]);

/** Serves each address of `sites` in this context. Any other address of a test site is a page that says so. */
export async function serveSites(
  context: BrowserContext,
  sites: Record<string, string>,
) {
  await context.route(
    (url) => url.hostname.endsWith(".example"),
    (route) => {
      const url = new URL(route.request().url());
      const html = sites[`${url.origin}${url.pathname}`];
      return route.fulfill({
        status: html ? 200 : 404,
        contentType: "text/html; charset=utf-8",
        body:
          html ??
          "<!doctype html><title>Not found</title><p>This page does not exist.</p>",
      });
    },
  );
}

export class EvalBrowser implements BrowserPort {
  /** The tabs of the one window, in order. */
  readonly pages: Page[] = [];
  private current = 0;
  private readonly driver: AppleEventsBrowser;
  constructor(private readonly context: BrowserContext) {
    this.driver = new AppleEventsBrowser(this.runner());
  }

  /** The tab in front. */
  get active(): Page {
    const page = this.pages[this.current];
    if (!page) throw new Error("The eval browser has no tab.");
    return page;
  }

  /** Opens each address in a tab of its own and brings one of them to the front. */
  async start(urls: string[], active = 0) {
    for (const url of urls) {
      const page = await this.context.newPage();
      await page.goto(url, { waitUntil: "load" });
      this.pages.push(page);
    }
    this.current = Math.min(Math.max(0, active), this.pages.length - 1);
    await this.active.bringToFront();
  }

  /** What osascript would print for the command of the driver, done in the tab in front. */
  private runner(): CommandRunner {
    const printed = (stdout: string) => ({ status: 0, stdout, stderr: "" });
    return async (_command, args) => {
      const [, script, argument] = args;
      if (script === probeScript) return printed(`front ${chrome.id}\n`);
      if (script === openScript(chrome)) {
        const page = await this.context.newPage();
        this.pages.push(page);
        this.current = this.pages.length - 1;
        await page.goto(argument!, { waitUntil: "commit" });
        return printed("clawdtime:opened");
      }
      if (script === runScript(chrome)) {
        try {
          const answer: unknown = await this.active.evaluate(argument!);
          return printed(
            answer === undefined || answer === null
              ? "clawdtime:no-answer"
              : String(answer),
          );
        } catch {
          // The document left while the script ran. The real browser gives no answer then.
          return printed("clawdtime:no-answer");
        }
      }
      return {
        status: 1,
        stdout: "",
        stderr: "The eval browser does not know this command.",
      };
    };
  }

  doctor() {
    return this.driver.doctor();
  }
  open(url: string) {
    return this.driver.open(url);
  }
  read() {
    return this.driver.read();
  }
  click(index: number) {
    return this.driver.click(index);
  }
  type(index: number, text: string, submit: boolean) {
    return this.driver.type(index, text, submit);
  }
  scroll(direction: "down" | "up") {
    return this.driver.scroll(direction);
  }
  back() {
    return this.driver.back();
  }

  /** The reading once the page stayed the same for two readings in a row, as the driver waits. */
  private async settled(): Promise<BrowserPage> {
    const until = Date.now() + 3000;
    await this.active.waitForTimeout(150);
    let last = "";
    for (;;) {
      const page = await this.driver.read();
      const now = JSON.stringify(page);
      if (now === last || Date.now() >= until) return page;
      last = now;
      await this.active.waitForTimeout(250);
    }
  }

  async hover(index: number): Promise<BrowserPage> {
    const point = await this.active.evaluate(
      ({ session, index }) => {
        const mark = Symbol.for("clawdtime.browser.number");
        for (const el of document.querySelectorAll("*")) {
          const given = (
            el as unknown as Record<
              symbol,
              { session: string; index: number } | undefined
            >
          )[mark];
          if (given?.session !== session || given.index !== index) continue;
          el.scrollIntoView({ block: "center", inline: "center" });
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        return null;
      },
      { session: this.driver.session, index },
    );
    if (!point)
      throw new Error(
        `Number ${index} is not on the page any more. Read the page again and use a number from that reading.`,
      );
    await this.active.mouse.move(point.x, point.y);
    return this.settled();
  }

  /** The page script chooses in a list by the text of a choice. */
  async select(index: number, option: string): Promise<BrowserPage> {
    return this.driver.type(index, option, false);
  }

  async key(combo: string): Promise<BrowserPage> {
    if (!pageKeys.has(combo))
      throw new Error(`The page does not take the key ${combo.slice(0, 40)}.`);
    await this.active.keyboard.press(combo);
    return this.settled();
  }

  async waitFor(text: string | null, ms: number): Promise<EvalPage> {
    const until = Date.now() + Math.min(Math.max(ms, 100), 10_000);
    const wanted = text?.trim().toLowerCase() ?? "";
    for (;;) {
      const page = await this.driver.read();
      const found = wanted !== "" && page.text.toLowerCase().includes(wanted);
      if (found || Date.now() >= until)
        return Object.assign(page, wanted ? { found } : {});
      await this.active.waitForTimeout(200);
    }
  }

  private async list(): Promise<EvalTab[]> {
    const tabs: EvalTab[] = [];
    for (const [index, page] of this.pages.entries())
      tabs.push({
        index: index + 1,
        title: await page.title(),
        url: page.url(),
        active: index === this.current,
      });
    return tabs;
  }

  /** The number of the tab whose title fits, as `tabs` lists it, for a script. */
  async tabNumber(title: RegExp): Promise<number> {
    const found = (await this.list()).find((tab) => title.test(tab.title));
    if (!found) throw new Error(`no tab has a title that fits ${title}`);
    return found.index;
  }

  async tabs(): Promise<EvalPage> {
    const page = await this.driver.read();
    return Object.assign(page, { tabs: await this.list() });
  }

  async switchTab(tab: number): Promise<BrowserPage> {
    if (!Number.isSafeInteger(tab) || tab < 1 || tab > this.pages.length)
      throw new Error(`There is no tab ${tab}. List the tabs again.`);
    this.current = tab - 1;
    await this.active.bringToFront();
    return this.driver.read();
  }

  async close() {}

  /** What the first tab holds for the check at the end, and which tab is in front. */
  async state(): Promise<Record<string, unknown>> {
    const first = this.pages[0];
    const held = first
      ? ((await first.evaluate(
          "typeof window.state === 'function' ? window.state() : ({})",
        )) as Record<string, unknown>)
      : {};
    return {
      ...held,
      activeUrl: this.active.url(),
      activeTitle: await this.active.title(),
    };
  }
}
