import { describe, expect, it } from "vitest";
import {
  giveUpNote,
  otherWays,
  progressEndText,
  ProgressGuard,
  type ProgressContext,
  type ProgressVerdict,
} from "../connectors/computer/progress.js";

const plain: ProgressContext = {
  browser: false,
  page: false,
  usedBrowser: false,
  address: false,
};
/** One input that went out: the action, and the screen before and after it. */
const input = (signature: string, before: string, after: string) => ({
  signature,
  kind: signature.split("|")[0]!,
  before,
  after,
  input: true,
});
/** A step that sent no input: a wait, a reading, a refused or held action. */
const quiet = (before: string, after: string | null) => ({
  signature: "wait",
  kind: "wait",
  before,
  after,
  input: false,
});
const kinds = (verdicts: ProgressVerdict[]) => verdicts.map((v) => v.kind);

describe("the progress guard: a swing", () => {
  it("answers a nudge after two rounds of two actions with no new screen", () => {
    const guard = new ProgressGuard();
    const verdicts = [
      // The first round shows two screens, the second shows them again.
      guard.step(input("click|Open", "home", "menu"), plain),
      guard.step(input("key|escape", "menu", "home"), plain),
      guard.step(input("click|Open", "home", "menu"), plain),
      guard.step(input("key|escape", "menu", "home"), plain),
    ];
    expect(kinds(verdicts)).toEqual(["allow", "allow", "allow", "nudge"]);
    const nudge = verdicts[3]!;
    expect(nudge).toMatchObject({ kind: "nudge", pattern: "swing" });
    expect((nudge as { note: string }).note).toBe(
      "You went back and forth between the same 2 actions, and the screen showed nothing new. Do not repeat them. Try another way: scroll; a search field; open_app for the right app or window.",
    );
  });

  it("answers a nudge after two rounds of three actions", () => {
    const guard = new ProgressGuard();
    const round = [
      input("click|Tab A", "a", "b"),
      input("click|Tab B", "b", "c"),
      input("click|Tab C", "c", "a"),
    ];
    const verdicts = [...round, ...round].map((step) =>
      guard.step(step, plain),
    );
    expect(kinds(verdicts)).toEqual([
      "allow",
      "allow",
      "allow",
      "allow",
      "allow",
      "nudge",
    ]);
    expect((verdicts[5] as { note: string }).note).toMatch(
      /^You went back and forth between the same 3 actions/,
    );
  });

  it("gives no false alarm when the screen changes each time", () => {
    // Next, then a scroll, again and again, through new pages.
    const guard = new ProgressGuard();
    const verdicts = Array.from({ length: 12 }, (_, index) =>
      guard.step(
        input(
          index % 2 ? "scroll|down" : "click|Next",
          `page ${index}`,
          `page ${index + 1}`,
        ),
        plain,
      ),
    );
    expect(verdicts.every((verdict) => verdict.kind === "allow")).toBe(true);
  });

  it("gives no false alarm when the second round shows something new", () => {
    const guard = new ProgressGuard();
    const verdicts = [
      guard.step(input("click|Open", "home", "menu"), plain),
      guard.step(input("key|escape", "menu", "home"), plain),
      guard.step(input("click|Open", "home", "menu"), plain),
      // The list has one more row now.
      guard.step(input("key|escape", "menu", "home with a new row"), plain),
    ];
    expect(kinds(verdicts)).toEqual(["allow", "allow", "allow", "allow"]);
  });

  it("leaves a run of one action to the worker's own streak", () => {
    const guard = new ProgressGuard();
    const verdicts = Array.from({ length: 8 }, () =>
      guard.step(input("click|Save", "same", "same"), plain),
    );
    expect(verdicts.every((verdict) => verdict.kind === "allow")).toBe(true);
  });

  it("reads steps that sent nothing as neither a round nor a break", () => {
    const guard = new ProgressGuard();
    const verdicts = [
      guard.step(input("click|Open", "home", "menu"), plain),
      guard.step(quiet("menu", "menu"), plain),
      guard.step(input("key|escape", "menu", "home"), plain),
      guard.step(input("click|Open", "home", "menu"), plain),
      guard.step(quiet("menu", "menu"), plain),
      guard.step(input("key|escape", "menu", "home"), plain),
    ];
    expect(kinds(verdicts).at(-1)).toBe("nudge");
  });

  it("closes no round with a look that was not read", () => {
    const guard = new ProgressGuard();
    const verdicts = [
      guard.step(input("click|Open", "home", "menu"), plain),
      guard.step(input("key|escape", "menu", "home"), plain),
      guard.step(input("click|Open", "home", "menu"), plain),
      guard.step(
        { ...input("key|escape", "menu", "home"), after: null },
        plain,
      ),
    ];
    expect(kinds(verdicts)).toEqual(["allow", "allow", "allow", "allow"]);
  });
});

describe("the progress guard: a still screen", () => {
  it("answers a nudge after four inputs of two or more actions with no new screen", () => {
    const guard = new ProgressGuard();
    const verdicts = [
      guard.step(input("click|Send", "form", "form"), plain),
      guard.step(input("key|return", "form", "form"), plain),
      guard.step(input("click|Send", "form", "form"), plain),
      guard.step(input("click_at|40|20", "form", "form"), plain),
    ];
    expect(kinds(verdicts)).toEqual(["allow", "allow", "allow", "nudge"]);
    expect((verdicts[3] as { note: string }).note).toBe(
      "Your last 4 actions did not change the screen. Do not repeat them. Try another way: scroll; a search field; open_app for the right app or window.",
    );
  });

  it("starts again when the screen shows something new, also after a wait", () => {
    const guard = new ProgressGuard();
    const verdicts = [
      guard.step(input("click|Send", "form", "form"), plain),
      guard.step(input("key|return", "form", "form"), plain),
      guard.step(input("click|Send", "form", "form"), plain),
      // A wait after which the page came.
      guard.step(quiet("form", "sent page"), plain),
      guard.step(input("key|return", "sent page", "sent page"), plain),
    ];
    expect(verdicts.every((verdict) => verdict.kind === "allow")).toBe(true);
  });

  it("counts a screen that came back as no new screen", () => {
    // A, then B, then back to A: nothing that this request had not seen.
    const guard = new ProgressGuard();
    const verdicts = [
      guard.step(input("click|One", "a", "b"), plain),
      guard.step(input("click|Two", "b", "a"), plain),
      guard.step(input("key|down", "a", "b"), plain),
      guard.step(input("key|up", "b", "a"), plain),
      guard.step(input("click|Three", "a", "b"), plain),
    ];
    expect(kinds(verdicts)).toEqual([
      "allow",
      "allow",
      "allow",
      "allow",
      "nudge",
    ]);
    expect(verdicts[4]).toMatchObject({ pattern: "still" });
  });
});

describe("the progress guard: its answers in order", () => {
  const swingOnce = (guard: ProgressGuard) =>
    [
      input("click|Open", "home", "menu"),
      input("key|escape", "menu", "home"),
      input("click|Open", "home", "menu"),
      input("key|escape", "menu", "home"),
    ]
      .map((step) => guard.step(step, plain))
      .filter((verdict) => verdict.kind !== "allow");

  it("nudges twice, asks twice, then ends", () => {
    const guard = new ProgressGuard();
    const answers = Array.from({ length: 5 }, () => swingOnce(guard)).flat();
    expect(kinds(answers)).toEqual(["nudge", "nudge", "ask", "ask", "end"]);
    expect(answers[2]).toEqual({
      kind: "ask",
      pattern: "swing",
      question:
        "I keep going back and forth, and the screen shows nothing new. What should I try next? Say it in a few words, or say no to stop.",
    });
    expect(answers[4]).toEqual({
      kind: "end",
      pattern: "swing",
      text: progressEndText,
    });
    expect(progressEndText).not.toMatch(/^I cannot/);
    expect(guard.counts).toEqual({ nudges: 2, asks: 2 });
  });

  it("starts both patterns again when the person speaks, and keeps the counts", () => {
    const guard = new ProgressGuard();
    guard.step(input("click|Open", "home", "menu"), plain);
    guard.step(input("key|escape", "menu", "home"), plain);
    guard.step(input("click|Open", "home", "menu"), plain);
    guard.heard();
    // Only one action after the person's words: no round yet.
    expect(guard.step(input("key|escape", "menu", "home"), plain).kind).toBe(
      "allow",
    );
    expect(kinds(swingOnce(guard))).toEqual(["nudge"]);
    expect(guard.counts).toEqual({ nudges: 1, asks: 0 });
  });

  it("takes other limits", () => {
    const guard = new ProgressGuard({ nudges: 0, asks: 1 });
    expect(kinds(swingOnce(guard))).toEqual(["ask"]);
    expect(kinds(swingOnce(guard))).toEqual(["end"]);
  });
});

describe("the other ways", () => {
  it("offers the browser reading first when a page is in front and the browser was not used", () => {
    expect(
      otherWays({
        browser: true,
        page: true,
        usedBrowser: false,
        address: true,
      }),
    ).toEqual([
      "browser_read and the page elements",
      "keys: Tab, Return, Escape, a menu shortcut",
      "scroll",
      "a search field",
      "open_url with the address",
      "open_app for the right app or window",
    ]);
  });

  it("does not offer the browser without a page, without a driver, or after it was used", () => {
    const browser = "browser_read and the page elements";
    expect(otherWays({ ...plain, browser: true, page: false })).not.toContain(
      browser,
    );
    expect(otherWays({ ...plain, browser: false, page: true })).not.toContain(
      browser,
    );
    expect(
      otherWays({ ...plain, browser: true, page: true, usedBrowser: true }),
    ).not.toContain(browser);
    expect(
      otherWays(
        { ...plain, browser: true, page: true },
        new Set(["browser_click"]),
      ),
    ).not.toContain(browser);
  });

  it("drops the ways whose kind was tried, and always keeps a search field", () => {
    expect(
      otherWays(
        { ...plain, address: true },
        new Set(["key", "scroll", "open_url", "open_app"]),
      ),
    ).toEqual(["a search field"]);
  });

  it("names the address only when the person's words hold one", () => {
    expect(otherWays(plain)).not.toContain("open_url with the address");
    expect(otherWays({ ...plain, address: true })).toContain(
      "open_url with the address",
    );
  });

  it("makes one short note for a first give_up", () => {
    const note = giveUpNote(otherWays(plain));
    expect(note).toBe(
      "Do not give up yet. Try another way first: keys: Tab, Return, Escape, a menu shortcut; scroll; a search field; open_app for the right app or window. Give up only when none of them can work.",
    );
    // It fits the line that the planner reads of one step.
    expect(
      giveUpNote(
        otherWays({
          browser: true,
          page: true,
          usedBrowser: false,
          address: true,
        }),
      ).length,
    ).toBeLessThan(290);
  });
});
