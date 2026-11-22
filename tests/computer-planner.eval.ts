/**
 * The planner of computer use, measured without the real screen.
 *
 * Each task is one decision: a goal, a rendered screen (a picture and named
 * elements, in the form that the hands give) and sometimes earlier steps. On
 * the board screen the targets are drawn and have no element: only a click at
 * a point in the picture reaches them. The
 * real planner code builds the request, a real language model answers, and a
 * check says whether the chosen action is right. The time of each answer is
 * kept. It is the check to run before the model of the planner changes.
 *
 *   npm run eval:computer:planner -- gpt-4.1 gpt-5.4 gpt-4.1:low
 *
 * Each argument is a model, with ":low" for a small picture. With no argument
 * it measures the model that the service would use. REPEATS (default 2) is
 * how often each task runs; OUT names a file for every answer.
 *
 * It needs a key for the language model in the environment, as the service
 * does, and the Chromium of Playwright (`npm run cua:install-browser`). It
 * costs real model calls: tasks times repeats for each argument. It opens no
 * window, sends no input and reads nothing of the person's screen.
 */
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import {
  defaultComputerModel,
  OpenAIPlanner,
} from "../connectors/computer/planner.js";
import type {
  Action,
  Observation,
  ScreenElement,
  StepRecord,
} from "../connectors/computer/ports.js";
import { screens } from "./computer-planner-screens.js";

const key = process.env.CLAWDTIME_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
if (!key)
  throw new Error(
    "The planner test needs CLAWDTIME_OPENAI_API_KEY or OPENAI_API_KEY in the environment.",
  );

// The picture is 1280 wide, as the hands send it. The screen is a 1512 by 982 display.
const picture = { width: 1280, height: 831 };
const display = { width: 1512, height: 982, scale: 2 };
const toScreen = display.width / picture.width;

interface Box {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Seen {
  observation: Observation;
  /** The element with this data-key: its number, and its box in pixels of the picture. */
  at: Record<string, Box>;
}

async function render(): Promise<Record<string, Seen>> {
  const browser = await chromium.launch({ headless: true });
  const seen: Record<string, Seen> = {};
  try {
    const page = await browser.newPage({
      viewport: picture,
      deviceScaleFactor: 1,
    });
    for (const [name, screen] of Object.entries(screens)) {
      await page.setContent(screen.html);
      // What the picture shows and the Accessibility tree does not name: a box for the checks, and no element.
      const drawn = (await page.evaluate(`(() => {
        const out = [];
        for (const el of document.querySelectorAll("[data-key]:not([data-role])")) {
          const r = el.getBoundingClientRect();
          out.push({ key: el.dataset.key, x: r.left, y: r.top, w: r.width, h: r.height });
        }
        return out;
      })()`)) as { key: string; x: number; y: number; w: number; h: number }[];
      const found = (await page.evaluate(`(() => {
        const out = [];
        for (const el of document.querySelectorAll("[data-role]")) {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.top >= innerHeight) continue;
          // What a scroll area cut off is not on the screen.
          const clip = el.closest(".sidebar, .window");
          const c = clip ? clip.getBoundingClientRect() : r;
          if (r.top >= c.bottom || r.bottom <= c.top) continue;
          out.push({ role: el.dataset.role, title: el.dataset.title || "", value: el.dataset.value, key: el.dataset.key || "",
            secure: el.dataset.secure === "true", focused: el.dataset.focused === "true", enabled: el.dataset.enabled !== "false",
            x: r.left, y: r.top, w: r.width, h: Math.min(r.bottom, c.bottom) - r.top });
        }
        return out;
      })()`)) as (Omit<ScreenElement, "id"> & { key: string })[];
      const image = (
        await page.screenshot({ type: "jpeg", quality: 80 })
      ).toString("base64");
      const at: Seen["at"] = {};
      // No element has the number 0, so only a point inside the box hits it.
      for (const item of drawn)
        at[item.key] = { id: 0, x: item.x, y: item.y, w: item.w, h: item.h };
      const elements = found.map((item, index): ScreenElement => {
        if (item.key)
          at[item.key] = {
            id: index + 1,
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
          };
        return {
          id: index + 1,
          role: item.role,
          title: item.title,
          ...(item.value !== undefined && !item.secure
            ? { value: item.value }
            : {}),
          x: item.x * toScreen,
          y: item.y * toScreen,
          w: item.w * toScreen,
          h: item.h * toScreen,
          enabled: item.enabled,
          focused: item.focused,
          secure: item.secure,
        };
      });
      seen[name] = {
        at,
        observation: {
          at: 1,
          surfaceEpoch: 1,
          screen: display,
          cursor: { x: 700, y: 500 },
          app: screen.app,
          elements,
          image,
          imageWidth: picture.width,
          imageHeight: picture.height,
        },
      };
    }
  } finally {
    await browser.close();
  }
  return seen;
}

interface Task {
  id: string;
  screen: keyof typeof screens;
  goal: string;
  history?: StepRecord[];
  /** True when the action is a right next step. */
  right: (action: Action, seen: Seen) => boolean;
}
/** A click on one of these elements: by its number, or at a point inside its box. */
const hits = (action: Action, seen: Seen, ...keys: string[]) =>
  keys.some((name) => {
    const box = seen.at[name];
    if (!box) return false;
    if (action.kind === "click_element")
      return box.id > 0 && action.element === box.id;
    if (action.kind !== "click_at") return false;
    return (
      action.x >= box.x - 2 &&
      action.x <= box.x + box.w + 2 &&
      action.y >= box.y - 2 &&
      action.y <= box.y + box.h + 2
    );
  });
const number = (seen: Seen, name: string) => seen.at[name]?.id;

const tasks: Task[] = [
  {
    id: "open a named row",
    screen: "notes",
    goal: "Open the note named Budget 2027.",
    right: (a, s) => hits(a, s, "note-0"),
  },
  {
    id: "icon with no name (picture only)",
    screen: "notes",
    goal: "Click the trash button in the toolbar of Notes.",
    right: (a, s) => hits(a, s, "trash"),
  },
  {
    id: "another icon with no name (picture only)",
    screen: "notes",
    goal: "Click the share button in the toolbar of Notes.",
    right: (a, s) => hits(a, s, "share"),
  },
  {
    id: "type into the editor",
    screen: "notes",
    goal: "Add the line 'Call the bank at 9' to the note that is open.",
    right: (a, s) =>
      hits(a, s, "editor") ||
      (a.kind === "type" &&
        a.text.includes("Call the bank at 9") &&
        (a.element === undefined || a.element === number(s, "editor"))),
  },
  {
    id: "target is not in view: scroll or search",
    screen: "notes",
    goal: "Open the note named Zebra crossing.",
    right: (a, s) =>
      (a.kind === "scroll" && a.direction === "down") ||
      hits(a, s, "search") ||
      (a.kind === "type" &&
        a.element === number(s, "search") &&
        /zebra/i.test(a.text)),
  },
  {
    id: "turn on a switch that is off",
    screen: "settings",
    goal: "Turn on Bluetooth.",
    right: (a, s) => hits(a, s, "bluetooth"),
  },
  {
    id: "state from the picture only",
    screen: "settings",
    goal: "Is dark mode on? Only tell me. Change nothing.",
    right: (a) =>
      a.kind === "done" &&
      /\b(off|not on|disabled|is not)\b/i.test(a.summary) &&
      !/\bis on\b/i.test(a.summary),
  },
  {
    id: "state from the picture only, and it is on",
    screen: "settings",
    goal: "Are notifications on? Only tell me. Change nothing.",
    right: (a) =>
      a.kind === "done" &&
      /\b(on|enabled|yes)\b/i.test(a.summary) &&
      !/\b(off|not on|disabled)\b/i.test(a.summary),
  },
  {
    id: "already done: no click",
    screen: "settings",
    goal: "Turn on Wi-Fi.",
    right: (a) => a.kind === "done",
  },
  {
    id: "no such control: no click",
    screen: "settings",
    goal: "Click the Export button.",
    right: (a) =>
      a.kind === "give_up" || a.kind === "ask" || a.kind === "scroll",
  },
  {
    id: "the right button of a dialog",
    screen: "dialog",
    goal: "Save the document.",
    right: (a, s) => hits(a, s, "save"),
  },
  {
    id: "the careful button of a dialog",
    screen: "dialog",
    goal: "Close this dialog. Do not save and do not lose the changes.",
    right: (a, s) => hits(a, s, "cancel"),
  },
  {
    id: "done after the step worked",
    screen: "saved",
    goal: "Save the document.",
    history: [
      {
        step: 1,
        action: { kind: "click_element", element: 5 },
        why: "The Save button of the dialog saves the document.",
        outcome: "ok",
      },
    ],
    right: (a) => a.kind === "done",
  },
  {
    id: "one of ten links with the same name",
    screen: "invoices",
    goal: "Open the invoice of Granite Tools.",
    right: (a, s) => hits(a, s, "view-6"),
  },
  {
    id: "read a value of a row",
    screen: "invoices",
    goal: "What is the amount of the invoice of Cedar Works? Only tell me.",
    right: (a) => a.kind === "done" && /2,?315\.75/.test(a.summary),
  },
  {
    id: "text into a named field",
    screen: "login",
    goal: "Sign in with the email ada@example.com. I type the password myself.",
    right: (a, s) =>
      hits(a, s, "email") ||
      (a.kind === "type" &&
        a.text === "ada@example.com" &&
        a.element === number(s, "email")),
  },
  {
    id: "point: a large drawn thing",
    screen: "board",
    goal: "Click the sticky note that says Pricing.",
    right: (a, s) => hits(a, s, "sticky-pricing"),
  },
  {
    id: "point: a drawn tool of 30 pixels",
    screen: "board",
    goal: "Choose the text tool, the letter T, in the tool bar on the board.",
    right: (a, s) => hits(a, s, "tool-text"),
  },
  {
    id: "point: another drawn tool of 30 pixels",
    screen: "board",
    goal: "Choose the magnifier tool in the tool bar on the board.",
    right: (a, s) => hits(a, s, "tool-zoom"),
  },
  {
    id: "point: a drawn x of 18 pixels",
    screen: "board",
    goal: "Close the yellow banner at the top of the board with its x.",
    right: (a, s) => hits(a, s, "banner-x"),
  },
  {
    id: "point: one of five drawn stars",
    screen: "board",
    goal: "Rate this board with three stars.",
    right: (a, s) => hits(a, s, "star-3"),
  },
  {
    id: "password: hand over to the person",
    screen: "loginTyped",
    goal: "Sign in with the email ada@example.com. I type the password myself.",
    history: [
      {
        step: 1,
        action: { kind: "type", text: "ada@example.com", element: 2 },
        why: "The email goes into the Email field.",
        outcome: "ok",
      },
    ],
    right: (a, s) => a.kind === "ask" || hits(a, s, "password"),
  },
];

interface Config {
  label: string;
  model: string;
  detail: "high" | "low";
}
const configs: Config[] = (
  process.argv.slice(2).length
    ? process.argv.slice(2)
    : [process.env.CLAWDTIME_COMPUTER_MODEL || defaultComputerModel]
).map((word) => {
  const [model, detail] = word.split(":");
  if (!model || (detail !== undefined && detail !== "low" && detail !== "high"))
    throw new Error(`Use a model, with :low for a small picture. Got: ${word}`);
  return { label: word, model, detail: detail === "low" ? "low" : "high" };
});
const repeats = Math.max(1, Math.floor(Number(process.env.REPEATS ?? "2")));

interface Row {
  config: string;
  task: string;
  run: number;
  ms: number;
  right: boolean;
  action: string;
  error?: string;
}
const rows: Row[] = [];
const seen = await render();

async function measure(config: Config) {
  // The planner asks for the large picture. For ":low" the request is changed on its way out.
  const request: typeof fetch = async (url, init) => {
    if (config.detail === "high") return fetch(url, init);
    const body = JSON.parse(String(init?.body)) as {
      messages: { content: unknown }[];
    };
    for (const message of body.messages)
      if (Array.isArray(message.content))
        for (const part of message.content as {
          type?: string;
          image_url?: { detail?: string };
        }[])
          if (part.type === "image_url" && part.image_url)
            part.image_url.detail = "low";
    return fetch(url, { ...init, body: JSON.stringify(body) });
  };
  const planner = new OpenAIPlanner({
    key: key!,
    model: config.model,
    request,
  });
  let failures = 0;
  for (let run = 1; run <= repeats; run++)
    for (const task of tasks) {
      const view = seen[task.screen]!;
      const from = performance.now();
      try {
        const { action } = await planner.next({
          goal: task.goal,
          history: task.history ?? [],
          observation: view.observation,
          page: null,
        });
        const { kind, ...rest } = action;
        rows.push({
          config: config.label,
          task: task.id,
          run,
          ms: Math.round(performance.now() - from),
          right: task.right(action, view),
          action: `${kind} ${JSON.stringify(rest).slice(0, 160)}`,
        });
      } catch (error) {
        rows.push({
          config: config.label,
          task: task.id,
          run,
          ms: Math.round(performance.now() - from),
          right: false,
          action: "",
          error: String(error instanceof Error ? error.message : error).slice(
            0,
            200,
          ),
        });
        // A model that the service refuses is not asked for every task.
        if (
          ++failures >= 3 &&
          failures === rows.filter((row) => row.config === config.label).length
        )
          return;
      }
    }
}
await Promise.all(configs.map(measure));

const at = (values: number[], share: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]!
    : 0;
};
if (process.env.OUT)
  writeFileSync(
    process.env.OUT,
    `${JSON.stringify({ at: new Date().toISOString(), repeats, tasks: tasks.length, rows }, null, 1)}\n`,
  );
console.log(`${tasks.length} tasks, ${repeats} runs of each.`);
console.log("model | right | median ms | 90th ms | no answer");
for (const config of configs) {
  const mine = rows.filter((row) => row.config === config.label);
  const answered = mine.filter((row) => !row.error);
  const times = answered.map((row) => row.ms);
  const failed = mine.find((row) => row.error);
  console.log(
    `${config.label} | ${mine.filter((row) => row.right).length} of ${mine.length} | ${at(times, 0.5)} | ${at(times, 0.9)} | ${mine.length - answered.length}${failed ? ` (${failed.error})` : ""}`,
  );
}
const wrong = rows.filter((row) => !row.right && !row.error);
if (wrong.length) console.log("\nWrong answers:");
for (const row of wrong)
  console.log(`  ${row.config} | ${row.task} | ${row.action}`);
