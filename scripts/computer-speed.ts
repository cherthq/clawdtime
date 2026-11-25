/**
 * Computer use: where the time of a step goes outside the language model,
 * before and after the faster hands.
 *
 *   npm run bench:computer:speed
 *
 * The real worker does one whole request with a scripted planner that thinks
 * for no time. The hands are the real `PanelHands` of the service, and a
 * made-up panel reads their commands and acts out the cost of each one with a
 * wait: the read of the next command, the picture, the walk of the
 * Accessibility tree, the glide of the guided cursor and the input itself.
 * The request runs twice: once with the numbers of the panel before (kept
 * here as the baseline), and once with the numbers of the panel now.
 *
 * The rules of the glide, the wait at the target, the move of the pointer and
 * the read of the next command are the panel's own, before and after. The
 * picture and the walk need a real screen and real apps; their numbers here
 * are named assumptions, and the encode time was measured with a generated
 * picture on a laptop. It opens no window, sends no input, reads nothing of
 * the screen and calls no language model.
 *
 * It also prints the bytes of the picture of a 3024 by 1964 screen at the old
 * and the new settings, for a generated picture. The JPEG here is written by
 * jpeg-js, a stand-in for the ImageIO of the panel: its bytes differ, the
 * change between the two settings is what counts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import {
  PanelHands,
  type HandsCost,
} from "../connectors/computer/panel-hands.js";
import type {
  Action,
  HandCommand,
  HandResult,
  Observation,
  Planner,
  ScreenElement,
} from "../connectors/computer/ports.js";
import {
  ComputerWorker,
  type StepTiming,
} from "../connectors/computer/worker.js";

/** What one panel spends, in seconds unless the name says otherwise. */
interface Panel {
  name: string;
  /** The read of the next command: held at the service until one waits, or a read every `pace` seconds. */
  held: boolean;
  /** The sleep of the panel's loop after every read and every result, when the read is not held. */
  pace: number;
  /** The glide of the guided cursor for a way of `length` points. */
  glide(length: number): number;
  /** The wait at the target after a glide, after none (same place, new label), and for the same label. */
  arrival: number;
  relabel: number;
  same: number;
  /** The move of the real pointer for a way of `length` points. */
  move(length: number): number;
  /** The picture: the list of windows and the screenshot, then the JPEG. */
  captureMs: number;
  encodeMs: number;
  /** The walk of the tree of the window in front. */
  walkMs: number;
  /** The picture and the walk at the same time. */
  together: boolean;
  /** The JPEG quality, for the bytes of the sample picture. */
  quality: number;
  /** The picture's limit: the width, or the longer side. */
  side: "width" | "long";
}

/**
 * A busy window, as the assumption of this test: 2,400 elements in the tree,
 * of which 1,500 lie in the parts of a long list that do not show, under 60
 * rows or groups. One element costs 0.18 ms to ask. The walk before asked all
 * of them, up to 3,000 and 1.5 seconds. The walk now leaves out what does not
 * show: it asks the 900 that show and the 60 that it leaves out, up to 2,000
 * and 0.6 seconds.
 */
const busyWindow = { all: 2400, hidden: 1500, hiddenRoots: 60, eachMs: 0.18 };
const walkBefore = Math.min(
  1500,
  Math.min(3000, busyWindow.all) * busyWindow.eachMs,
);
const walkNow = Math.min(
  600,
  (busyWindow.all - busyWindow.hidden + busyWindow.hiddenRoots) *
    busyWindow.eachMs,
);

/** The panel before this change: its constants as they were. */
const before: Panel = {
  name: "before",
  held: false,
  pace: 0.12,
  glide: (length) => Math.min(0.7, 0.45 + Math.max(0, length) / 2400),
  arrival: 0.3,
  relabel: 0.15,
  same: 0.15,
  move: (length) => Math.min(0.18, 0.06 + Math.max(0, length) / 6000),
  // Assumed: the list of windows and one screenshot at 1280 by 831.
  captureMs: 80,
  // Measured: a generated picture of 1280 by 831, NSBitmapImageRep at 0.6, with base64.
  encodeMs: 3,
  walkMs: walkBefore,
  together: false,
  quality: 0.6,
  side: "width",
};

/** The panel now. */
const now: Panel = {
  name: "after",
  held: true,
  pace: 0.12,
  glide: (length) => Math.min(0.26, 0.15 + Math.max(0, length) / 4000),
  arrival: 0.1,
  relabel: 0.05,
  same: 0,
  move: (length) => Math.min(0.12, 0.05 + Math.max(0, length) / 8000),
  captureMs: 80,
  // Measured: the same picture, ImageIO at 0.5, with base64.
  encodeMs: 3,
  walkMs: walkNow,
  together: true,
  quality: 0.5,
  side: "long",
};

/** Costs that did not change: one read of the service, a read of the window in front, and the events. */
const checkMs = 2;
const surfaceMs = 3;
const keyMs = 20;
const characterMs = 6;

const sleep = (seconds: number) =>
  new Promise<void>((done) => setTimeout(done, Math.max(0, seconds * 1000)));

// A made-up screen of 1512 by 982 points, shown as a picture of 1280 by 831.
const screen = { width: 1512, height: 982, scale: 2 };
const item = (
  id: number,
  role: string,
  title: string,
  x: number,
  y: number,
  w: number,
  h: number,
  focused = false,
): ScreenElement => ({
  id,
  role,
  title,
  x,
  y,
  w,
  h,
  enabled: true,
  focused,
  secure: false,
});
const elements = (focused: boolean): ScreenElement[] => [
  item(0, "AXStaticText", "Notes", 60, 14, 80, 20),
  item(1, "AXButton", "New Note", 1180, 12, 90, 28),
  item(2, "AXTextField", "Search", 560, 48, 300, 24, focused),
  item(3, "AXStaticText", "Shopping", 240, 140, 300, 22),
  item(4, "AXRow", "Groceries for Saturday", 240, 260, 420, 44),
  item(5, "AXScrollArea", "Notes list", 220, 120, 480, 820),
  item(6, "AXButton", "Pin", 1320, 12, 80, 28),
];
const look = (focused: boolean, image: boolean): Observation => ({
  at: Date.now(),
  screen,
  cursor: { x: 700, y: 500 },
  app: { name: "Notes", bundleId: "com.apple.Notes", window: "Notes" },
  elements: elements(focused),
  ...(image ? { image: "aW1hZ2U=", imageWidth: 1280, imageHeight: 831 } : {}),
});

/** The planner: a fixed request that thinks for no time. */
class Script implements Planner {
  private readonly steps: Action[] = [
    { kind: "click_element", element: 2 },
    { kind: "type", text: "groceries", element: 2 },
    { kind: "key", combo: "return" },
    { kind: "click_element", element: 4 },
    { kind: "scroll", direction: "down", element: 5 },
    { kind: "click_element", element: 6 },
    { kind: "done", summary: "The note is pinned." },
  ];
  async next() {
    const action = this.steps.shift() ?? {
      kind: "give_up" as const,
      reason: "The script ended.",
    };
    return { action, why: "scripted" };
  }
}

/** One request through the real worker and the real service side of the hands. */
async function request(panel: Panel, imageBytes: number) {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-computer-speed-"));
  const hands = new PanelHands({ first: 1 });
  const steps: (StepTiming & HandsCost)[] = [];
  const worker = new ComputerWorker({
    hands,
    planner: new Script(),
    journal: new ComputerJournal(home),
    timing: (entry) => steps.push({ ...entry, ...hands.takeCost() }),
  });
  let over = false;
  let focused = false;
  // Where the guided cursor points, and what its label says. It first comes out of the mascot.
  let place = { x: 1400, y: 900 };
  let label = "";
  let typed = 0;

  /** The cursor goes to `target` with `said`; it returns the seconds that it took. */
  const travel = async (target: { x: number; y: number }, said: string) => {
    const length = Math.hypot(target.x - place.x, target.y - place.y);
    const moved = length >= 3;
    const wait = moved
      ? panel.arrival
      : said === label
        ? panel.same
        : panel.relabel;
    const seconds = (moved ? panel.glide(length) : 0) + wait;
    place = target;
    label = said;
    await sleep(seconds);
    return { seconds, length };
  };

  const perform = async (
    command: HandCommand,
    said: string,
  ): Promise<{ result: Omit<HandResult, "seq">; cost: string }> => {
    if (command.kind === "observe") {
      const capture = command.image ? panel.captureMs + panel.encodeMs : 0;
      const walk = command.elements ? panel.walkMs : 0;
      const spent = panel.together ? Math.max(capture, walk) : capture + walk;
      // The window in front is read before and after the look.
      await sleep((spent + 2 * surfaceMs) / 1000);
      const parts = [
        ...(command.image
          ? [
              `capture=${panel.captureMs}`,
              `encode=${panel.encodeMs}`,
              `bytes=${imageBytes}`,
            ]
          : []),
        `walk=${Math.round(walk)}`,
      ];
      return {
        result: { ok: true, observation: look(focused, command.image) },
        cost: parts.join(";"),
      };
    }
    if (command.kind === "click" || command.kind === "scroll") {
      const target = { x: command.x, y: command.y };
      const way = await travel(target, said);
      await sleep((checkMs + surfaceMs) / 1000 + panel.move(way.length));
      // A click presses and lets go; a scroll turns the wheel a few times.
      await sleep(command.kind === "click" ? 0.07 : 0.06);
      if (command.kind === "click")
        focused = command.y < 80 && command.x > 500 && command.x < 900;
      return {
        result: { ok: true },
        cost: `glide=${Math.round(way.seconds * 1000)}`,
      };
    }
    if (command.kind === "type" || command.kind === "key") {
      // The field that has the keyboard: the cursor goes under its text, near its leading edge.
      const field = { x: 560 + 18, y: 48 + 24 };
      await sleep(surfaceMs / 1000);
      const way = await travel(field, said);
      await sleep((2 * checkMs + 3 * surfaceMs) / 1000);
      if (command.kind === "type") {
        typed += command.text.length;
        await sleep((command.text.length * characterMs) / 1000);
      } else await sleep(keyMs / 1000);
      return {
        result: { ok: true },
        cost: `glide=${Math.round(way.seconds * 1000)}`,
      };
    }
    if (command.kind === "wait") await sleep(command.ms / 1000);
    return { result: { ok: true }, cost: "" };
  };

  // The made-up panel: the loop of the real one, with its pace.
  const loop = (async () => {
    let last = 0;
    while (!over) {
      const began = Date.now();
      if (panel.held) await hands.wait(last, 1000, { changed: () => over });
      const pending = hands.next(last);
      if (!pending) {
        if (!panel.held)
          await sleep(Math.max(0, panel.pace - (Date.now() - began) / 1000));
        continue;
      }
      last = pending.seq;
      const done = await perform(pending.command, pending.label);
      hands.result({ seq: pending.seq, ...done.result }, done.cost || null);
      // Before, the loop slept after every result. Now the next read goes at once.
      if (!panel.held) await sleep(panel.pace);
    }
  })();

  const started = Date.now();
  await worker.submit("speed-1", "Find the groceries note and pin it");
  while (["running", "stopping"].includes(worker.status().state))
    await sleep(0.005);
  const total = Date.now() - started;
  over = true;
  await loop;
  rmSync(home, { recursive: true, force: true });
  return { steps, total, state: worker.status().state, typed };
}

/** The picture of a screen of `width` by `height` pixels at the settings of `panel`. */
function pictureSize(
  panel: Panel,
  width: number,
  height: number,
  scale: number,
) {
  const points = { width: width / scale, height: height / scale };
  if (panel.side === "width") {
    const w = Math.max(1, Math.min(1280, Math.round(points.width * scale)));
    return { width: w, height: Math.round((w * points.height) / points.width) };
  }
  const long = Math.max(points.width, points.height);
  const longPixels = Math.min(1280, long * scale);
  const shortPixels =
    (longPixels * Math.min(points.width, points.height)) / long;
  return points.width >= points.height
    ? { width: Math.round(longPixels), height: Math.round(shortPixels) }
    : { width: Math.round(shortPixels), height: Math.round(longPixels) };
}

/** A made-up screen of `width` by `height` pixels: flat parts, a side bar, lines of small marks like text, and a photo. */
function generatedScreen(width: number, height: number) {
  const data = Buffer.alloc(width * height * 4);
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const fill = (
    x0: number,
    y0: number,
    w: number,
    h: number,
    rgb: number[],
  ) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++)
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
        const at = (y * width + x) * 4;
        data[at] = rgb[0]!;
        data[at + 1] = rgb[1]!;
        data[at + 2] = rgb[2]!;
        data[at + 3] = 255;
      }
  };
  fill(0, 0, width, height, [245, 245, 247]);
  fill(0, 0, Math.round(width / 5), height, [218, 222, 229]);
  fill(0, 0, width, 104, [232, 233, 236]);
  for (let row = 160; row < height - 60; row += 68) {
    let x = Math.round(width / 5) + 80;
    while (x < width - 120) {
      const word = 16 + Math.floor(random() * 120);
      for (let letter = x; letter < x + word; letter += 18)
        fill(letter, row, 12, 24 + Math.floor(random() * 12), [30, 32, 38]);
      x += word + 28;
    }
  }
  for (let y = 140; y < 540; y += 2)
    for (let x = width - 700; x < width - 100; x += 2)
      fill(x, y, 2, 2, [
        Math.floor(random() * 255),
        (x * 3) % 255,
        (y * 5) % 255,
      ]);
  return { width, height, data };
}

/** The picture made smaller, each pixel the mean of the pixels that it covers. */
function shrink(
  source: { width: number; height: number; data: Buffer },
  width: number,
  height: number,
) {
  const data = Buffer.alloc(width * height * 4);
  const fx = source.width / width;
  const fy = source.height / height;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;
      for (let sy = Math.floor(y * fy); sy < Math.floor((y + 1) * fy); sy++)
        for (let sx = Math.floor(x * fx); sx < Math.floor((x + 1) * fx); sx++) {
          const at = (sy * source.width + sx) * 4;
          red += source.data[at]!;
          green += source.data[at + 1]!;
          blue += source.data[at + 2]!;
          count++;
        }
      const at = (y * width + x) * 4;
      data[at] = red / Math.max(1, count);
      data[at + 1] = green / Math.max(1, count);
      data[at + 2] = blue / Math.max(1, count);
      data[at + 3] = 255;
    }
  return { width, height, data };
}

const pad = (value: string | number, width: number) =>
  String(value).padStart(width);
const ms = (value: number | undefined) =>
  value === undefined ? "-" : String(Math.round(value));

function table(name: string, steps: (StepTiming & HandsCost)[]) {
  console.log(`\n${name}`);
  console.log(
    `${"step".padEnd(5)}${"kind".padEnd(15)}${pad("look", 7)}${pad("act", 7)}${pad("wait", 7)}${pad("glide", 7)}${pad("walk", 7)}${pad("capture", 9)}${pad("image KB", 10)}`,
  );
  for (const step of steps)
    console.log(
      `${String(step.step).padEnd(5)}${step.kind.padEnd(15)}${pad(ms(step.lookMs), 7)}${pad(ms(step.actMs), 7)}${pad(ms(step.pollWaitMs ?? 0), 7)}${pad(ms(step.glideMs), 7)}${pad(ms(step.walkMs), 7)}${pad(ms(step.captureMs), 9)}${pad(step.imageBytes === undefined ? "-" : Math.round(step.imageBytes / 1024), 10)}`,
    );
}

const sum = (
  steps: (StepTiming & HandsCost)[],
  part: keyof HandsCost | "lookMs" | "actMs",
) =>
  steps.reduce(
    (total, step) => total + ((step[part] as number | undefined) ?? 0),
    0,
  );

async function main() {
  console.log(
    "Computer use: the time of a step outside the language model, before and after.",
  );
  console.log(
    "The planner thinks for no time. Look, act and wait are milliseconds of each step; wait is the time that its commands waited for the panel to read them, glide is the guided cursor before its inputs.",
  );
  console.log(
    `Assumed: a picture costs ${before.captureMs} ms to take; the window has ${busyWindow.all} elements, ${busyWindow.hidden} of them in parts that do not show, at ${busyWindow.eachMs} ms each (walk ${Math.round(walkBefore)} ms before, ${Math.round(walkNow)} ms now).`,
  );
  // The picture of a 3024 by 1964 screen, made up here: no screen is captured.
  const source = generatedScreen(3024, 1964);
  const pictures = [before, now].map((panel) => {
    const size = pictureSize(panel, 3024, 1964, 2);
    const shown = shrink(source, size.width, size.height);
    const bytes = jpeg.encode(shown, Math.round(panel.quality * 100)).data
      .length;
    return { panel, size, bytes };
  });
  const old = await request(before, pictures[0]!.bytes);
  const fast = await request(now, pictures[1]!.bytes);
  table("Before", old.steps);
  table("After", fast.steps);
  const outside = (run: typeof old) =>
    sum(run.steps, "lookMs") + sum(run.steps, "actMs");
  const rows: [string, number, number][] = [
    ["look", sum(old.steps, "lookMs"), sum(fast.steps, "lookMs")],
    ["act", sum(old.steps, "actMs"), sum(fast.steps, "actMs")],
    [
      "wait for the panel",
      sum(old.steps, "pollWaitMs"),
      sum(fast.steps, "pollWaitMs"),
    ],
    [
      "glide and its wait",
      sum(old.steps, "glideMs"),
      sum(fast.steps, "glideMs"),
    ],
    ["walk of the tree", sum(old.steps, "walkMs"), sum(fast.steps, "walkMs")],
    ["look and act", outside(old), outside(fast)],
    ["whole request", old.total, fast.total],
  ];
  console.log(
    `\n${"Totals, in ms".padEnd(22)}${pad("before", 9)}${pad("after", 9)}${pad("less", 7)}`,
  );
  for (const [name, a, b] of rows)
    console.log(
      `${name.padEnd(22)}${pad(Math.round(a), 9)}${pad(Math.round(b), 9)}${pad(a > 0 ? `${Math.round(((a - b) / a) * 100)}%` : "-", 7)}`,
    );
  console.log(
    `Steps: ${old.steps.length} before, ${fast.steps.length} after. The request ended as ${old.state} before and ${fast.state} after.`,
  );
  console.log(
    `Per step, look and act: ${Math.round(outside(old) / Math.max(1, old.steps.length))} ms before, ${Math.round(outside(fast) / Math.max(1, fast.steps.length))} ms after.`,
  );

  console.log(
    "\nThe picture of a 3024 by 1964 screen (generated, no capture; JPEG by jpeg-js as a stand-in for ImageIO):",
  );
  for (const { panel, size, bytes } of pictures)
    console.log(
      `  ${panel.name.padEnd(7)}${size.width} by ${size.height}, quality ${panel.quality}: ${bytes} bytes, ${Math.ceil(bytes / 3) * 4} characters of base64`,
    );
  const [a, b] = pictures.map((picture) => picture.bytes) as [number, number];
  console.log(
    `  ${Math.round(((a - b) / a) * 100)}% fewer bytes. For this screen the size of the picture stays; a screen that stands on its side now gets 720 by 1280 in place of 1080 by 1920.`,
  );
}

// The timers of the hands do not keep the process alive; this does, until the end.
const alive = setInterval(() => {}, 1000);
try {
  await main();
} finally {
  clearInterval(alive);
}
