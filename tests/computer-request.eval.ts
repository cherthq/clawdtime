/**
 * Whole requests of computer use, measured without the real screen.
 *
 * The real worker does each request from its start to its end: it looks,
 * plans with a real language model, checks each action in code, asks the
 * person where the checks say so, and acts. Only the hands are replaced: they
 * look at a small app in a headless browser and click and type there, in
 * place of the Mac. A check of what the app holds at the end says whether the
 * request was done. The test keeps the steps and the seconds of each request.
 *
 *   npm run eval:computer:request -- gpt-5.4
 *
 * Each argument is a model. With none it uses the model that the service
 * would use. REPEATS (default 1) is how often each request runs; ONLY names a
 * part of a request's name; OUT names a file for every result.
 *
 * It needs a key for the language model in the environment and the Chromium
 * of Playwright. It costs real model calls: about two for each step. It opens
 * no window, sends no input to the Mac and reads nothing of its screen. It is
 * not physical acceptance: the apps are pages, not the apps of a Mac.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { ComputerJournal } from "../connectors/computer/journal.js";
import {
  defaultComputerModel,
  OpenAIPlanner,
} from "../connectors/computer/planner.js";
import type {
  HandCommand,
  HandResult,
  Hands,
  Observation,
  ScreenElement,
} from "../connectors/computer/ports.js";
import {
  ComputerWorker,
  type StepTiming,
} from "../connectors/computer/worker.js";
import { apps, type App } from "./computer-request-apps.js";

const key = process.env.CLAWDTIME_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
if (!key)
  throw new Error(
    "The request test needs CLAWDTIME_OPENAI_API_KEY or OPENAI_API_KEY in the environment.",
  );

// The picture is 1280 wide, as the hands send it. The screen is a 1512 by 982 display.
const picture = { width: 1280, height: 831 };
const display = { width: 1512, height: 982, scale: 2 };
const toScreen = display.width / picture.width;

/** The keys of a combination, in the names that the browser knows. */
const keyNames: Record<string, string> = {
  cmd: "Meta",
  command: "Meta",
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  return: "Enter",
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  delete: "Backspace",
  backspace: "Backspace",
  space: "Space",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
};

/** The hands, on a page in place of the Mac. Coordinates of a command are points of the display. */
class PageHands implements Hands {
  private seq = 0;
  private epoch = 1;
  readonly sent: HandCommand[] = [];
  constructor(
    private readonly page: Page,
    private readonly app: App["app"],
  ) {}

  private async observe(
    image: boolean,
    elements: boolean,
  ): Promise<Observation> {
    const found = elements
      ? ((await this.page.evaluate(`(() => {
          const out = [];
          for (const el of document.querySelectorAll("[data-role]")) {
            if (el.closest("[hidden]")) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.top >= innerHeight) continue;
            // What a scroll area cut off is not on the screen.
            const clip = el.closest(".sidebar, .window");
            const c = clip && clip !== el ? clip.getBoundingClientRect() : r;
            if (r.top >= c.bottom || r.bottom <= c.top) continue;
            const secure = el.type === "password";
            const field = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
            const value = secure ? undefined : field ? el.value : el.dataset.value;
            out.push({ role: el.dataset.role, title: el.dataset.title || "", value: value === "" ? undefined : value,
              secure, focused: document.activeElement === el, enabled: !el.disabled,
              x: r.left, y: Math.max(r.top, c.top), w: r.width, h: Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) });
          }
          return out;
        })()`)) as Omit<ScreenElement, "id">[])
      : [];
    const shot = image
      ? (await this.page.screenshot({ type: "jpeg", quality: 80 })).toString(
          "base64",
        )
      : null;
    return {
      at: Date.now(),
      surfaceEpoch: this.epoch,
      screen: display,
      cursor: { x: 700, y: 500 },
      app: this.app,
      elements: found.map((item, index) => ({
        id: index + 1,
        role: item.role,
        title: item.title.slice(0, 200),
        ...(item.value !== undefined
          ? { value: item.value.slice(0, 200) }
          : {}),
        x: item.x * toScreen,
        y: item.y * toScreen,
        w: item.w * toScreen,
        h: item.h * toScreen,
        enabled: item.enabled,
        focused: item.focused,
        secure: item.secure,
      })),
      ...(shot
        ? {
            image: shot,
            imageWidth: picture.width,
            imageHeight: picture.height,
          }
        : {}),
    };
  }

  async run(command: HandCommand): Promise<HandResult> {
    const seq = ++this.seq;
    if (command.kind !== "observe" && command.kind !== "wait")
      this.sent.push(command);
    const at = (value: number) => value / toScreen;
    switch (command.kind) {
      case "observe":
        return {
          seq,
          ok: true,
          observation: await this.observe(command.image, command.elements),
        };
      case "wait":
        await this.page.waitForTimeout(Math.min(command.ms, 1500));
        return { seq, ok: true };
      case "move":
        await this.page.mouse.move(at(command.x), at(command.y));
        return { seq, ok: true };
      case "click":
        await this.page.mouse.click(at(command.x), at(command.y), {
          button: command.button,
          clickCount: command.count,
        });
        return { seq, ok: true };
      case "drag":
        await this.page.mouse.move(at(command.fromX), at(command.fromY));
        await this.page.mouse.down();
        await this.page.mouse.move(at(command.toX), at(command.toY), {
          steps: 6,
        });
        await this.page.mouse.up();
        return { seq, ok: true };
      case "scroll":
        await this.page.mouse.move(at(command.x), at(command.y));
        // Positive dy moves the content up: the wheel of the browser turns down.
        await this.page.mouse.wheel(command.dx * 40, command.dy * 40);
        return { seq, ok: true };
      case "type":
        await this.page.keyboard.type(command.text);
        return { seq, ok: true };
      case "key": {
        const combo = command.combo
          .toLowerCase()
          .split("+")
          .map((part) => keyNames[part] ?? (part.length === 1 ? part : null));
        if (combo.some((part) => part === null))
          return { seq, ok: false, error: "refused" };
        await this.page.keyboard.press(combo.join("+"));
        return { seq, ok: true };
      }
      case "open_app": {
        // Only the app of this page is on this desk, and it is in front.
        const wanted = command.name.trim().toLowerCase();
        if (wanted !== this.app.name.toLowerCase())
          return { seq, ok: false, error: "not_found" };
        this.epoch += 1;
        return {
          seq,
          ok: true,
          resolvedBundleId: this.app.bundleId,
          observation: await this.observe(true, true),
        };
      }
      default:
        return { seq, ok: false, error: "refused" };
    }
  }
}

/** What the person does when the worker asks: the answer, after any typing of their own on the page. */
type Person = (question: string, page: Page) => Promise<string> | string;
const yes: Person = () => "yes";
const no: Person = () => "no";

interface Request {
  id: string;
  app: keyof typeof apps;
  goal: string;
  person?: Person;
  /** True when the app holds what the request asked for. `said` is the worker's last message. */
  done: (
    state: Record<string, unknown>,
    said: string,
    final: string,
  ) => boolean;
}
interface NotesState {
  open: string;
  deleted: string[];
  notes: { name: string; text: string }[];
}
const noteOf = (state: Record<string, unknown>, name: string) =>
  (state as unknown as NotesState).notes.find((note) => note.name === name);
const switches = (state: Record<string, unknown>) =>
  state.switches as Record<string, boolean>;

const requests: Request[] = [
  {
    id: "open a note and read it",
    app: "notes",
    goal: "Open the note named Budget 2027 and tell me what it says.",
    done: (state, said) =>
      state.open === "Budget 2027" && /1,?200/.test(said) && /400/.test(said),
  },
  {
    id: "add a line to a note",
    app: "notes",
    goal: "Add the line 'Call the bank at 9' to the note named Call list.",
    done: (state) =>
      /Dentist on Monday\.[\s\S]*Call the bank at 9/.test(
        noteOf(state, "Call list")?.text ?? "",
      ) &&
      (state as unknown as NotesState).notes.filter((note) =>
        note.text.includes("Call the bank"),
      ).length === 1,
  },
  {
    id: "find a note that is not in view",
    app: "notes",
    goal: "Open the note named Zebra crossing and tell me what it says.",
    done: (state, said) =>
      state.open === "Zebra crossing" && /next spring/i.test(said),
  },
  {
    id: "make a new note",
    app: "notes",
    goal: "Make a new note that says 'Buy stamps'.",
    done: (state) => {
      const notes = (state as unknown as NotesState).notes;
      return (
        notes.length === 16 &&
        notes.filter((note) => note.text.trim() === "Buy stamps").length === 1
      );
    },
  },
  {
    id: "delete a note, the person says yes",
    app: "notes",
    goal: "Delete the note named Recipes.",
    person: yes,
    done: (state) => {
      const held = state as unknown as NotesState;
      return (
        held.deleted.length === 1 &&
        held.deleted[0] === "Recipes" &&
        held.notes.length === 14
      );
    },
  },
  {
    id: "delete a note, the person says no",
    app: "notes",
    goal: "Delete the note named Recipes.",
    person: no,
    done: (state, _said, final) =>
      (state as unknown as NotesState).deleted.length === 0 &&
      final === "canceled",
  },
  {
    id: "turn on two switches",
    app: "settings",
    goal: "Turn on Bluetooth and dark mode.",
    done: (state) => {
      const now = switches(state);
      return (
        now.Bluetooth === true &&
        now["Dark mode"] === true &&
        now["Wi-Fi"] === true &&
        now.Notifications === true &&
        now["Automatic updates"] === true
      );
    },
  },
  {
    id: "a switch that is on already",
    app: "settings",
    goal: "Make sure that Wi-Fi is on.",
    done: (state) =>
      switches(state)["Wi-Fi"] === true &&
      (state.changes as string[]).length === 0,
  },
  {
    id: "a switch whose state only the picture shows",
    app: "settings",
    goal: "Turn off notifications.",
    done: (state) =>
      switches(state).Notifications === false &&
      (state.changes as string[]).length === 1,
  },
  {
    id: "save in a dialog",
    app: "document",
    goal: "Save the document.",
    done: (state) => state.outcome === "saved",
  },
  {
    id: "sign in, the person types the password",
    app: "login",
    goal: "Sign in with the email ada@example.com. I type the password myself.",
    // The person types into the password field themselves, then says yes.
    person: async (_question, page) => {
      await page.click("#password");
      await page.keyboard.type("a-test-password");
      return "yes";
    },
    done: (state) => state.signedIn === "ada@example.com",
  },
  {
    id: "drawn stars",
    app: "board",
    goal: "Rate this board with four stars.",
    done: (state) => state.stars === 4,
  },
  {
    id: "a drawn x",
    app: "board",
    goal: "Close the yellow banner at the top of the board.",
    done: (state) => state.banner === false,
  },
];

const models = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [process.env.CLAWDTIME_COMPUTER_MODEL || defaultComputerModel];
const repeats = Math.max(1, Math.floor(Number(process.env.REPEATS ?? "1")));
const only = process.env.ONLY;
const chosen = requests.filter((request) => !only || request.id.includes(only));

interface Row {
  model: string;
  request: string;
  run: number;
  done: boolean;
  state: string;
  reason: string;
  steps: number;
  inputs: number;
  questions: number;
  seconds: number;
  lookMs: number;
  planMs: number;
  actMs: number;
  said: string;
  kinds: string;
  /** What the worker asked the person, and what the hands sent, for a look at a request that went wrong. */
  asked: string[];
  sent: string[];
}
const rows: Row[] = [];
const browser = await chromium.launch({ headless: true });

async function one(model: string, request: Request, run: number): Promise<Row> {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-request-eval-"));
  const page = await browser.newPage({
    viewport: picture,
    deviceScaleFactor: 1,
  });
  try {
    const app = apps[request.app];
    await page.setContent(app.html);
    const hands = new PageHands(page, app.app);
    const journal = new ComputerJournal(root);
    const said: string[] = [];
    const timed: StepTiming[] = [];
    const worker = new ComputerWorker({
      hands,
      planner: new OpenAIPlanner({ key: key!, model }),
      journal,
      notify: (text) => said.push(text),
      timing: (entry) => timed.push(entry),
      maxMs: 180_000,
    });
    const id = `r${run}`;
    const from = performance.now();
    let questions = 0;
    const asked: string[] = [];
    // The supervisor read the request already: it is work for the planner, and no move.
    await worker.submitRead(id, request.goal, { kind: "none" });
    for (;;) {
      const now = worker.snapshot();
      if (now.state === "waiting_for_person") {
        questions += 1;
        asked.push(now.message.slice(0, 200));
        if (questions > 6) {
          worker.stop();
          break;
        }
        const reply = await (request.person ?? yes)(now.message, page);
        await worker.answer(reply);
      } else if (now.state !== "running" && now.state !== "stopping") break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await worker.idle();
    const seconds = (performance.now() - from) / 1000;
    const record = journal.get(id);
    const final = record?.state ?? "unknown";
    const last = said.at(-1) ?? "";
    const state = (await page.evaluate("window.state()")) as Record<
      string,
      unknown
    >;
    const sum = (pick: (entry: StepTiming) => number) =>
      Math.round(timed.reduce((total, entry) => total + pick(entry), 0));
    return {
      model,
      request: request.id,
      run,
      done: request.done(state, last, final),
      state: final,
      reason: record?.reason ?? "",
      steps: timed.length,
      inputs: hands.sent.length,
      questions,
      seconds: Math.round(seconds * 10) / 10,
      lookMs: sum((entry) => entry.lookMs),
      planMs: sum((entry) => entry.planMs),
      actMs: sum((entry) => entry.actMs),
      said: last.slice(0, 200),
      kinds: timed.map((entry) => entry.kind).join(" "),
      asked,
      // A point is given in pixels of the picture, as the planner sees it.
      sent: hands.sent.map((command) =>
        command.kind === "click"
          ? `click ${Math.round(command.x / toScreen)},${Math.round(command.y / toScreen)}`
          : command.kind === "type"
            ? `type ${JSON.stringify(command.text.slice(0, 40))}`
            : command.kind === "key"
              ? `key ${command.combo}`
              : command.kind,
      ),
    };
  } finally {
    await page.close();
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  for (const model of models)
    for (let run = 1; run <= repeats; run++) {
      // Requests of one model run side by side: each has its own page, worker and journal.
      const batch = await Promise.all(
        chosen.map((request) =>
          one(model, request, run).catch((error): Row => ({
            model,
            request: request.id,
            run,
            done: false,
            state: "fault",
            reason: String(
              error instanceof Error ? error.message : error,
            ).slice(0, 160),
            steps: 0,
            inputs: 0,
            questions: 0,
            seconds: 0,
            lookMs: 0,
            planMs: 0,
            actMs: 0,
            said: "",
            kinds: "",
            asked: [],
            sent: [],
          })),
        ),
      );
      rows.push(...batch);
    }
} finally {
  await browser.close();
}

if (process.env.OUT)
  writeFileSync(
    process.env.OUT,
    `${JSON.stringify({ at: new Date().toISOString(), repeats, rows }, null, 1)}\n`,
  );
console.log(`${chosen.length} requests, ${repeats} runs of each.`);
for (const model of models) {
  const mine = rows.filter((row) => row.model === model);
  const total = (pick: (row: Row) => number) =>
    mine.reduce((sum, row) => sum + pick(row), 0);
  console.log(
    `\n${model}: ${mine.filter((row) => row.done).length} of ${mine.length} done | ${total((row) => row.steps)} steps | ${Math.round(total((row) => row.seconds))} s in all | plan ${Math.round(total((row) => row.planMs) / 1000)} s, look ${Math.round(total((row) => row.lookMs) / 1000)} s, act ${Math.round(total((row) => row.actMs) / 1000)} s`,
  );
  console.log(
    "request | done | end | steps | inputs | questions | seconds | actions",
  );
  for (const row of mine)
    console.log(
      `${row.request} | ${row.done ? "yes" : "NO"} | ${row.state}${row.reason && row.state !== "completed" ? ` (${row.reason})` : ""} | ${row.steps} | ${row.inputs} | ${row.questions} | ${row.seconds} | ${row.kinds}`,
    );
  for (const row of mine.filter((item) => !item.done))
    console.log(`  not done: ${row.request}: ${row.said}`);
}
