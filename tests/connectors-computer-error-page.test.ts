import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  errorPage,
  pageError,
  screenError,
} from "../connectors/computer/error-page.js";
import { recentPlaces } from "../connectors/agents/speech.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import type { Action, BrowserPage } from "../connectors/computer/ports.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import {
  element,
  FakeBrowser,
  FakeHands,
  observation,
  page,
  ScriptedPlanner,
} from "./connectors-computer-fixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

const chrome = (window: string) => ({
  name: "Google Chrome",
  bundleId: "com.google.Chrome",
  window,
});
/** Chrome in front with its page for a name that was not found. */
const unreachable = observation(
  [
    element(1, {
      role: "AXTextField",
      title: "Address and search bar",
      value: "brightwave5.co",
    }),
    element(2, { role: "AXStaticText", title: "This site can’t be reached" }),
    element(3, { role: "AXStaticText", title: "DNS_PROBE_FINISHED_NXDOMAIN" }),
  ],
  { app: chrome("brightwave5.co") },
);
const loaded = observation(
  [
    element(1, {
      role: "AXStaticText",
      title: "Brightwave: studio for small shops",
    }),
  ],
  { app: chrome("Brightwave") },
);
const done: Action = {
  kind: "done",
  summary: "Opened brightwave5.co in Chrome. The page shows a network error.",
};

function setup(
  script: Action[],
  screens: ReturnType<typeof observation>[],
  browser?: FakeBrowser,
) {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-error-page-"));
  roots.push(home);
  const clock = { now: 1_000_000 };
  const hands = new FakeHands(screens);
  const planner = new ScriptedPlanner(script);
  const said: string[] = [];
  const journal = new ComputerJournal(home, () => clock.now);
  const worker = new ComputerWorker({
    hands,
    planner,
    journal,
    now: () => clock.now,
    notify: (text) => said.push(text),
    ...(browser ? { browser } : {}),
  });
  return { worker, planner, hands, said, journal };
}

describe("an error page of the browser", () => {
  it("is known on the page and on the screen of Chrome and Safari, by fixed labels only", () => {
    const bad = (values: Partial<BrowserPage>) => pageError(page([], values));
    expect(
      bad({
        text: "This site can't be reached\nbrightwave5.co's server IP address could not be found.",
      }),
    ).toBe("the site cannot be reached");
    expect(bad({ text: "ERR_NAME_NOT_RESOLVED" })).toBe(
      "the server was not found",
    );
    expect(
      bad({ browser: "safari", title: "Failed to open page", text: "" }),
    ).toBe("the page cannot be opened");
    expect(
      bad({ browser: "safari", text: "Safari Can’t Find the Server" }),
    ).toBe("the server was not found");
    expect(bad({ text: "This page isn’t working\nHTTP ERROR 500" })).toBe(
      "the page is not working",
    );
    expect(bad({ title: "404", text: "Page not found" })).toBe(
      "the page was not found",
    );
    expect(bad({ title: "Brightwave", text: "404 Not Found\nnginx" })).toBe(
      "the page was not found",
    );
    expect(
      bad({ url: "chrome-error://chromewebdata/", title: "", text: "" }),
    ).toBe("an error page of the browser");
    expect(bad({ url: "https://brightwave5.co/", title: "", text: "" })).toBe(
      "an empty page",
    );
    expect(
      screenError(
        observation(
          [
            element(1, {
              role: "AXStaticText",
              title: "Safari Can't Find the Server",
            }),
          ],
          {
            app: {
              name: "Safari",
              bundleId: "com.apple.Safari",
              window: "Failed to open page",
            },
          },
        ),
      ),
    ).toBe("the server was not found");
    expect(screenError(unreachable)).toBe("the site cannot be reached");
  });

  it("is not read into a page that loaded, an app that is no browser, or a goal about an error", () => {
    expect(pageError(page())).toBeNull();
    expect(
      pageError(page([], { url: "about:blank", title: "", text: "" })),
    ).toBeNull();
    expect(
      pageError(
        page([], {
          title: "Brightwave",
          text: `${"A long story of the studio. ".repeat(40)} Old links show 404 not found.`,
        }),
      ),
    ).toBeNull();
    expect(screenError(loaded)).toBeNull();
    // The same words in an app that is no browser are not a page.
    expect(
      screenError(
        observation([
          element(1, {
            role: "AXStaticText",
            title: "This site can't be reached",
          }),
        ]),
      ),
    ).toBeNull();
    expect(
      errorPage(
        unreachable,
        null,
        "Why does brightwave5.co say it can't be reached?",
      ),
    ).toBeNull();
    expect(errorPage(unreachable, null, "Open brightwave5.co")).toBe(
      "the site cannot be reached",
    );
  });
});

// "Open <address>" is opened by the worker itself (`directOpening`): the
// planner first sees the screen after it, as the owner's Mac did.
describe("a done while the browser shows an error page", () => {
  it("goes back to the planner once with the misheard address note, and the next done is taken", async () => {
    const { worker, planner, said } = setup([done, done], [unreachable]);
    await worker.submit("error_done", "Open brightwave5.co");
    await worker.idle();
    expect(planner.inputs).toHaveLength(2);
    const note = planner.inputs[1]!.history.at(-1)!.outcome;
    expect(note).toMatch(
      /^not taken yet: the page did not load \(the browser shows the site cannot be reached\)\./,
    );
    expect(note).toContain("The address may be misheard or misspelled");
    expect(note).toContain(
      "search the web for the name that the owner said, open the site that fits",
    );
    // The page text itself is never said back.
    expect(note).not.toContain("DNS_PROBE");
    expect(said.at(-1)).toBe(`Done. ${(done as { summary: string }).summary}`);
  });

  it("is taken at once when the page loaded", async () => {
    const { worker, planner, said } = setup(
      [{ kind: "done", summary: "Brightwave is open." }],
      [loaded],
    );
    await worker.submit("loaded_done", "Open brightwave.co");
    await worker.idle();
    expect(planner.inputs).toHaveLength(1);
    expect(said.at(-1)).toBe("Done. Brightwave is open.");
  });

  it("lets the planner search the name after the note and end on the site that loaded", async () => {
    const search: Action = {
      kind: "open_url",
      url: "https://www.google.com/search?q=brightwave",
    };
    const right: Action = { kind: "open_url", url: "https://brightwave.co" };
    const { worker, planner, hands, said } = setup(
      [done, search, right, { kind: "done", summary: "Brightwave is open." }],
      [unreachable, unreachable, unreachable, unreachable, loaded],
    );
    await worker.submit("search_after", "Open brightwave5.co");
    await worker.idle();
    expect(planner.inputs).toHaveLength(4);
    expect(
      hands.sent.map((command) =>
        command.kind === "open_url" ? command.url : command.kind,
      ),
    ).toEqual([
      "https://brightwave5.co/",
      "https://www.google.com/search?q=brightwave",
      "https://brightwave.co/",
    ]);
    expect(said.at(-1)).toBe("Done. Brightwave is open.");
  });
});

describe("open_url and browser_open on an address that does not load", () => {
  it("open_url: the next turn reads that the page did not load and may be misheard", async () => {
    const { worker, planner, journal } = setup([done, done], [unreachable]);
    await worker.submit("open_note", "Open brightwave5.co");
    await worker.idle();
    expect(planner.inputs[0]!.history.at(-1)!.outcome).toBe(
      "ok, the address went to the browser, but the page did not load (the browser shows the site cannot be reached). The address may be misheard or misspelled: search the web for the name that the owner said, open the site that fits, then check that it loaded.",
    );
    // The record keeps that the site did not load, so its name never joins the words for speech to text.
    const steps = journal.get("open_note")!.steps;
    expect(steps.map((step) => [step.kind, step.target, step.outcome])).toEqual(
      [
        ["open_url", "brightwave5.co", "ok"],
        ["open_url", "brightwave5.co", "not_loaded"],
        ["done", "", "done_error_page"],
        ["done", "", "ok"],
      ],
    );
    expect(recentPlaces(journal.all())).toEqual([]);
  });

  it("open_url: a page that loaded keeps the plain ok", async () => {
    const { worker, planner, journal } = setup([done], [loaded]);
    await worker.submit("open_ok", "Open brightwave.co");
    await worker.idle();
    expect(planner.inputs[0]!.history.at(-1)!.outcome).toBe("ok");
    expect(recentPlaces(journal.all())).toEqual(["brightwave.co"]);
  });

  it("browser_open: the reading after it is an error page, so its line says so", async () => {
    const browser = new FakeBrowser(
      page([], {
        url: "https://brightwave5.co/",
        title: "brightwave5.co",
        text: "This site can\u2019t be reached\nCheck if there is a typo in brightwave5.co.\nDNS_PROBE_FINISHED_NXDOMAIN",
      }),
    );
    const { worker, planner } = setup(
      [{ kind: "browser_open", url: "https://brightwave5.co" }, done, done],
      [loaded],
      browser,
    );
    await worker.submit("browser_note", "Check what brightwave5.co sells");
    await worker.idle();
    expect(browser.calls).toContain("open https://brightwave5.co");
    expect(planner.inputs[1]!.history.at(-1)!.outcome).toMatch(
      /^ok, the address went to the browser, but the page did not load \(the browser shows the site cannot be reached\)/,
    );
    expect(planner.inputs[2]!.history.at(-1)!.outcome).toMatch(
      /^not taken yet: the page did not load/,
    );
  });
});
