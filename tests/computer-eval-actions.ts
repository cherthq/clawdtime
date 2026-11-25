/**
 * The new kinds of action, for the two evals of computer use.
 *
 * The contract of this change adds hover, drag, scroll with an amount, and
 * new browser actions (hover, select, key, wait, tabs, switch tab). This
 * build does not have them in `ports.ts` yet. So their shapes live here, in
 * one place, typed loosely, and the evals ask the build at run time which of
 * them it offers: the planner must offer the function, and the checks of the
 * worker must take the action. A case that needs a kind that is not offered
 * is skipped, with a line that says so.
 */
import { actionSchema } from "../connectors/computer/guards.js";
import { OpenAIPlanner } from "../connectors/computer/planner.js";
import type { Action } from "../connectors/computer/ports.js";
import { readAsk, toolAnswer } from "./computer-eval-model.js";

/** One end of a drag: an element by its number, or a point of the picture. */
export type DragEnd = { element: number } | { x: number; y: number };
export type NewAction =
  | { kind: "hover"; element?: number; x?: number; y?: number }
  | { kind: "drag"; from: DragEnd; to: DragEnd }
  | {
      kind: "scroll";
      direction: "up" | "down";
      element?: number;
      amount?: number;
    }
  | { kind: "browser_hover"; index: number }
  | { kind: "browser_select"; index: number; option: string }
  | { kind: "browser_key"; combo: string }
  | { kind: "browser_wait"; text?: string; ms: number }
  | { kind: "browser_tabs" }
  | { kind: "browser_switch_tab"; tab: number };
/** The new actions, built in one place. Points are pixels of the picture, as for click_at. */
export const newAction = {
  hover: (target: DragEnd): NewAction => ({ kind: "hover", ...target }),
  drag: (from: DragEnd, to: DragEnd): NewAction => ({
    kind: "drag",
    from,
    to,
  }),
  scroll: (
    direction: "up" | "down",
    amount: number,
    element?: number,
  ): NewAction => ({
    kind: "scroll",
    direction,
    amount,
    ...(element !== undefined ? { element } : {}),
  }),
  browserHover: (index: number): NewAction => ({
    kind: "browser_hover",
    index,
  }),
  browserSelect: (index: number, option: string): NewAction => ({
    kind: "browser_select",
    index,
    option,
  }),
  browserKey: (combo: string): NewAction => ({ kind: "browser_key", combo }),
  browserWait: (ms: number, text?: string): NewAction => ({
    kind: "browser_wait",
    ms,
    ...(text !== undefined ? { text } : {}),
  }),
  browserTabs: (): NewAction => ({ kind: "browser_tabs" }),
  browserSwitchTab: (tab: number): NewAction => ({
    kind: "browser_switch_tab",
    tab,
  }),
};
/** An action of today or of the contract, as a check reads it. */
export type AnyAction = Action | NewAction;
/** A new action where an action of this build is wanted. */
export const asAction = (action: NewAction) => action as unknown as Action;
/** An action, read as one of today's kinds or of the new ones. */
export const loose = (action: Action) => action as unknown as AnyAction;

export type NewKind =
  | "hover"
  | "drag"
  | "scroll_amount"
  | "browser_hover"
  | "browser_select"
  | "browser_key"
  | "browser_wait"
  | "browser_tabs"
  | "browser_switch_tab";

/** For each new kind: the function of the planner, a property it must have, and an action the checks must take. */
const probes: Record<
  NewKind,
  { tool: string; property?: string; sample: NewAction }
> = {
  hover: { tool: "hover", sample: { kind: "hover", element: 1 } },
  drag: {
    tool: "drag",
    sample: { kind: "drag", from: { element: 1 }, to: { x: 10, y: 10 } },
  },
  scroll_amount: {
    tool: "scroll",
    property: "amount",
    sample: { kind: "scroll", direction: "down", amount: 3 },
  },
  browser_hover: {
    tool: "browser_hover",
    sample: { kind: "browser_hover", index: 1 },
  },
  browser_select: {
    tool: "browser_select",
    sample: { kind: "browser_select", index: 1, option: "One" },
  },
  browser_key: {
    tool: "browser_key",
    sample: { kind: "browser_key", combo: "Enter" },
  },
  browser_wait: {
    tool: "browser_wait",
    sample: { kind: "browser_wait", text: "Done", ms: 1000 },
  },
  browser_tabs: { tool: "browser_tabs", sample: { kind: "browser_tabs" } },
  browser_switch_tab: {
    tool: "browser_switch_tab",
    sample: { kind: "browser_switch_tab", tab: 1 },
  },
};

/**
 * The functions that the planner of this build offers with a browser, each
 * with the names of its arguments. One call to a transport that answers
 * itself: no network and no model.
 */
export async function offeredTools(): Promise<Map<string, string[]>> {
  let tools = new Map<string, string[]>();
  const planner = new OpenAIPlanner({
    key: "no-key-scripted",
    model: "scripted",
    browser: true,
    request: async (_url, init) => {
      tools = readAsk(init).tools;
      return toolAnswer("done", { summary: "Nothing to do." });
    },
  });
  await planner.next({
    goal: "Say what the screen shows.",
    history: [],
    observation: null,
    page: null,
  });
  return tools;
}

/** The new kinds that this build offers: the planner has the function and the checks take the action. */
export async function newKindsOffered(): Promise<Set<NewKind>> {
  const tools = await offeredTools();
  const offered = new Set<NewKind>();
  for (const [kind, probe] of Object.entries(probes) as [
    NewKind,
    (typeof probes)[NewKind],
  ][]) {
    const properties = tools.get(probe.tool);
    if (!properties) continue;
    if (probe.property && !properties.includes(probe.property)) continue;
    if (!actionSchema.safeParse(probe.sample).success) continue;
    offered.add(kind);
  }
  return offered;
}

/** The kinds of this list that the build does not offer, for the line that says why a case was skipped. */
export const missing = (needs: NewKind[] | undefined, offered: Set<NewKind>) =>
  (needs ?? []).filter((kind) => !offered.has(kind));
