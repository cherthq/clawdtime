/**
 * Scripted paths for the request eval in its check mode.
 *
 * A path is a list of steps. Each call of the planner gets one action from
 * the step that is due, through the planner's own transport, so the real
 * worker checks it, asks the person where it must, and sends it to the hands
 * as it would a model's choice. A step reads the screen as the model reads
 * it: the elements that the planner listed, with their numbers of this turn.
 * Only to find a target that the picture alone shows, or to read what the app
 * holds, may a step look into the page of the app. A model never gets that.
 *
 * The next step is due once the last one went out, or the person answered.
 * When the worker held the step back (the screen changed, the checks
 * refused it), the same step comes again with the new screen. A done that
 * the plan did not take yet, because a subgoal is still open, comes again
 * on every path, as the note of the worker asks. A step can also say "next"
 * to give its turn to the step after it, for a path that depends on what
 * the screen shows. A change of the plan takes no step of the journal, so a
 * step that changes the plan says "next" once the brief shows the change.
 */
import type { Page } from "@playwright/test";
import type { JournalStep } from "../connectors/computer/journal.js";
import type { EvalBrowser } from "./computer-eval-browser.js";
import {
  readBrief,
  type BriefElement,
  type BriefPageElement,
  type PlannerAsk,
  type ScriptAction,
} from "./computer-eval-model.js";

export interface ScriptView {
  ask: PlannerAsk;
  screen: BriefElement[];
  page: BriefPageElement[];
  /** The page of the app, or the tab in front. Not what a model gets. */
  app: Page;
  browser?: EvalBrowser;
}
export type Step = (
  view: ScriptView,
) => ScriptAction | "next" | Promise<ScriptAction | "next">;

/** The journal outcomes of a step that went out, or that the person answered. */
const wentOut = new Set(["ok", "answered", "person_typed"]);
/** The journal outcome of a done that the plan did not take yet (plan.ts). */
const planOpen = "plan_open";

export interface Player {
  choose: (ask: PlannerAsk) => Promise<ScriptAction>;
  /** Why the script could not give a step, when it could not. */
  trouble: () => string | null;
}

export function player(
  steps: Step[],
  context: {
    app: () => Page;
    browser?: EvalBrowser;
    steps: () => readonly JournalStep[];
    /** A wrong path goes on after any outcome: it must end, not try until it works. */
    always: boolean;
  },
): Player {
  let index = 0;
  let seen = 0;
  let trouble: string | null = null;
  return {
    trouble: () => trouble,
    choose: async (ask) => {
      const done = context.steps();
      if (done.length > seen) {
        const last = done.at(-1)!;
        seen = done.length;
        if (
          last.outcome !== planOpen &&
          (context.always || wentOut.has(last.outcome))
        )
          index += 1;
      }
      const view: ScriptView = {
        ask,
        ...readBrief(ask.brief),
        app: context.app(),
        ...(context.browser ? { browser: context.browser } : {}),
      };
      try {
        for (;;) {
          const step = steps[index];
          if (!step)
            return {
              kind: "give_up",
              reason: "The script has no more steps.",
            };
          const action = await step(view);
          if (action !== "next") return action;
          index += 1;
        }
      } catch (error) {
        trouble = `step ${index + 1}: ${error instanceof Error ? error.message : String(error)}`;
        return { kind: "give_up", reason: "The script could not go on." };
      }
    },
  };
}

/** The number of the one element of the screen with this name, and this role when one is given. */
export function named(view: ScriptView, title: string, role?: string) {
  const found = view.screen.filter(
    (item) => item.title === title && (!role || item.role === role),
  );
  if (found.length !== 1)
    throw new Error(
      `the screen lists ${found.length} elements named "${title}"`,
    );
  return found[0]!.id;
}

/** The box of an element of the app, in pixels of the picture. */
async function boxOf(view: ScriptView, selector: string) {
  const box = await view.app.evaluate((css) => {
    const el = document.querySelector(css);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, selector);
  if (!box) throw new Error(`the app has no ${selector}`);
  return box;
}

/** A point inside an element of the app, in pixels of the picture: its middle unless a share of its width and height is given. */
export async function pointIn(
  view: ScriptView,
  selector: string,
  across = 0.5,
  down = 0.5,
) {
  const box = await boxOf(view, selector);
  return {
    x: Math.round(box.x + box.w * across),
    y: Math.round(box.y + box.h * down),
  };
}

/**
 * A point of the first picture in the pixels of the closer picture of this
 * turn, read from the brief as the model reads it: the part of the first
 * picture that the closer picture shows, and its size.
 */
export function inCloser(view: ScriptView, point: { x: number; y: number }) {
  const m =
    /the second picture is the part of the first picture from (\d+),(\d+) to (\d+),(\d+), (\d+) by (\d+) pixels/.exec(
      view.ask.brief,
    );
  if (!m) throw new Error("this turn has no closer picture");
  const [left, top, right, bottom, width, height] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return {
    x: Math.round(((point.x - left) * width) / (right - left)),
    y: Math.round(((point.y - top) * height) / (bottom - top)),
  };
}

/** The number of the listed element whose middle lies in this element of the app. */
export async function under(view: ScriptView, selector: string) {
  const box = await boxOf(view, selector);
  const middle = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const inside = view.screen
    .filter(
      (item) =>
        item.x !== undefined &&
        item.y !== undefined &&
        item.x >= box.x - 1 &&
        item.x <= box.x + box.w + 1 &&
        item.y >= box.y - 1 &&
        item.y <= box.y + box.h + 1,
    )
    .sort(
      (a, b) =>
        Math.hypot(a.x! - middle.x, a.y! - middle.y) -
        Math.hypot(b.x! - middle.x, b.y! - middle.y),
    );
  if (!inside[0]) throw new Error(`no listed element lies in ${selector}`);
  return inside[0].id;
}

/** The element named `title` on the row of the element named `row`: the one nearest to its height. */
export function inRow(view: ScriptView, row: string, title: string) {
  const anchor = view.screen.find((item) => item.title === row);
  if (anchor?.y === undefined) throw new Error(`the screen lists no "${row}"`);
  const found = view.screen
    .filter((item) => item.title === title && item.y !== undefined)
    .sort((a, b) => Math.abs(a.y! - anchor.y!) - Math.abs(b.y! - anchor.y!));
  if (!found[0]) throw new Error(`the screen lists no "${title}"`);
  return found[0].id;
}

/** The number of the one element of the last page reading with this label. */
export function onPage(view: ScriptView, label: string) {
  const found = view.page.filter((item) => item.label === label);
  if (found.length !== 1)
    throw new Error(`the page reading has ${found.length} elements "${label}"`);
  return found[0]!.index;
}

/** What the app holds now. */
export async function stateOf(view: ScriptView) {
  if (view.browser) return view.browser.state();
  return (await view.app.evaluate("window.state()")) as Record<string, unknown>;
}

/** Today's actions, in the loose form of a function call. */
export const act = {
  click: (element: number): ScriptAction => ({
    kind: "click_element",
    element,
  }),
  clickAt: (point: { x: number; y: number }): ScriptAction => ({
    kind: "click_at",
    ...point,
  }),
  type: (text: string, element?: number): ScriptAction => ({
    kind: "type",
    text,
    ...(element !== undefined ? { element } : {}),
  }),
  key: (combo: string): ScriptAction => ({ kind: "key", combo }),
  scroll: (direction: "up" | "down", element?: number): ScriptAction => ({
    kind: "scroll",
    direction,
    ...(element !== undefined ? { element } : {}),
  }),
  wait: (ms: number): ScriptAction => ({ kind: "wait", ms }),
  ask: (question: string): ScriptAction => ({ kind: "ask", question }),
  done: (summary: string): ScriptAction => ({ kind: "done", summary }),
  giveUp: (reason: string): ScriptAction => ({ kind: "give_up", reason }),
  lookCloser: (point: { x: number; y: number }): ScriptAction => ({
    kind: "look_closer",
    ...point,
  }),
  /** A click at a point of the closer picture of this turn, in its pixels. */
  clickInCloser: (point: { x: number; y: number }): ScriptAction => ({
    kind: "click_at",
    ...point,
    closer: true,
  }),
  /** Keep facts in the plan, with no action. */
  planNote: (facts: string[]): ScriptAction => ({
    kind: "plan_update",
    op: "note",
    facts,
  }),
  read: (): ScriptAction => ({ kind: "browser_read" }),
  pageClick: (index: number): ScriptAction => ({
    kind: "browser_click",
    index,
  }),
  pageType: (index: number, text: string, submit = false): ScriptAction => ({
    kind: "browser_type",
    index,
    text,
    ...(submit ? { submit } : {}),
  }),
};
