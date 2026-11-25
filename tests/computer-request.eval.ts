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
 * Some requests carry faults, put in front of the planner's transport and of
 * the hands, never in the product: a rate limit (429 with retry-after) or an
 * outage (503) at a chosen call, a malformed answer (no function call, or
 * arguments that are not JSON), a window that moves at the first looks and
 * then settles, and a screen that does not take some clicks. They measure
 * whether a request still ends with what the app holds, through trouble that
 * a real Mac and a real service give.
 *
 *   npm run eval:computer:request -- gpt-5.4
 *   npx tsx tests/computer-request.eval.ts --check
 *   npx tsx tests/computer-request.eval.ts --check --new-actions
 *
 * Each argument is provider/model, or a bare model of OpenAI. With none it
 * uses the model that the service would use. REPEATS (default 1) is how often each request runs; ONLY names a
 * part of a request's name; OUT names a file for every result.
 *
 * With a model it needs a key for the language model in the environment or
 * the key store, and the Chromium of Playwright. It costs real model calls: about two for each
 * step. It opens no window, sends no input to the Mac and reads nothing of
 * its screen. It is not physical acceptance: the apps are pages, not the apps
 * of a Mac.
 *
 * --check needs no model and no key. For each request it plays scripted
 * paths through the same worker, apps, hands, faults and checks, with the
 * planner's own code and a transport that answers for the model. That
 * transport answers the outline of a request with one subgoal, the goal
 * itself. An ideal path must end with the check met, and a wrong path must
 * not. So it proves that each request can be done and that its check tells
 * right from wrong. It prints one line for each request and a total, and
 * exits with status 1 when one fails.
 *
 * --new-actions adds the requests for hover, drag, scroll with an amount and
 * the new browser actions. A path that needs a kind that this build does not
 * offer is skipped, with a line that says so.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { browserMethods } from "../connectors/computer/guards.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import { stateRoot } from "../connectors/agents/hooks.js";
import {
  ModelPlanner,
  plannerFor,
  type PlannerOptions,
} from "../connectors/computer/planner.js";
import type { Hands } from "../connectors/computer/ports.js";
import {
  ComputerWorker,
  type StepTiming,
} from "../connectors/computer/worker.js";
import {
  missing,
  newAction,
  newKindsOffered,
  type NewKind,
} from "./computer-eval-actions.js";
import { EvalBrowser, serveSites } from "./computer-eval-browser.js";
import {
  FaultyHands,
  PageHands,
  picture,
  toScreen,
  type Desk,
  type HandsFaults,
} from "./computer-eval-hands.js";
import {
  scriptedModel,
  withModelFaults,
  type ModelFault,
} from "./computer-eval-model.js";
import {
  act,
  inCloser,
  inRow,
  named,
  onPage,
  player,
  pointIn,
  stateOf,
  under,
  type ScriptView,
  type Step,
} from "./computer-eval-script.js";
import { apps, browserApp, sites } from "./computer-request-apps.js";

const words = process.argv.slice(2);
const flags = new Set(words.filter((word) => word.startsWith("--")));
for (const flag of flags)
  if (flag !== "--check" && flag !== "--new-actions")
    throw new Error(`Unknown flag ${flag}. Use --check and --new-actions.`);
const checking = flags.has("--check");
const withNew = flags.has("--new-actions");
// The check mode never reads a key: it calls no model. With a model, the key
// comes from the environment or the key store, as the service takes it.
const keyFor = (model: string | null) =>
  plannerFor(
    model,
    process.env,
    stateRoot({ env: process.env, home: homedir() }),
  );

/** What the person does when the worker asks: the answer, after any typing of their own on the page. */
type Person = (question: string, page: Page) => Promise<string> | string;
const yes: Person = () => "yes";
const no: Person = () => "no";
/** The person types the password into the field themselves, then says yes. */
const typesPassword: Person = async (_question, page) => {
  await page.click("#password");
  await page.keyboard.type("a-test-password");
  return "yes";
};
/** The person gives their email when asked for it, and types the password themselves. */
const knowsEmail: Person = (question, page) =>
  /e-?mail/i.test(question) && !/password field/i.test(question)
    ? "ada@example.com"
    : /password/i.test(question)
      ? typesPassword(question, page)
      : "yes";

/** What the worker said to the person in the request. */
interface Talk {
  asked: string[];
}
/** One scripted way through a request, for --check. */
interface Path {
  name: string;
  /** An ideal path must end with the check met; a wrong one must not. */
  ideal: boolean;
  /** New kinds of action that the path uses. Without them in this build it is skipped. */
  needs?: NewKind[];
  steps: Step[];
}
interface Faults {
  model?: ModelFault[];
  hands?: HandsFaults;
}
interface Request {
  id: string;
  /** The app on the screen. */
  app?: keyof typeof apps;
  /** Or a browser with these tabs, the first one in front unless `active` says another. */
  tabs?: { urls: string[]; active?: number };
  goal: string;
  person?: Person;
  faults?: Faults;
  /** It is about the new kinds of action: only with --new-actions. */
  newActions?: true;
  /** True when the app holds what the request asked for. `said` is the worker's last message. */
  done: (
    state: Record<string, unknown>,
    said: string,
    final: string,
    talk: Talk,
  ) => boolean;
  paths: Path[];
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
const columns = (state: Record<string, unknown>) =>
  state.columns as Record<string, string[]>;

const ideal = (steps: Step[], name = "ideal"): Path => ({
  name,
  ideal: true,
  steps,
});
const wrong = (name: string, steps: Step[], needs?: NewKind[]): Path => ({
  name,
  ideal: false,
  steps,
  ...(needs ? { needs } : {}),
});
const doneStep =
  (summary: string): Step =>
  () =>
    act.done(summary);
/** Done when the reading of the page shows `seen`, else give up: a done must rest on what the planner was given. */
const doneWhenShown =
  (seen: RegExp, summary: string): Step =>
  (view) =>
    seen.test(view.ask.brief)
      ? act.done(summary)
      : act.giveUp("The page does not show the result.");

// Checks that more than one request uses.
const budgetRead: Request["done"] = (state, said) =>
  state.open === "Budget 2027" && /1,?200/.test(said) && /400/.test(said);
const newNote: Request["done"] = (state) => {
  const notes = (state as unknown as NotesState).notes;
  return (
    notes.length === 16 &&
    notes.filter((note) => note.text.trim() === "Buy stamps").length === 1
  );
};
const zebraRead: Request["done"] = (state, said) =>
  state.open === "Zebra crossing" && /next spring/i.test(said);
const twoSwitches: Request["done"] = (state) => {
  const now = switches(state);
  return (
    now.Bluetooth === true &&
    now["Dark mode"] === true &&
    now["Wi-Fi"] === true &&
    now.Notifications === true &&
    now["Automatic updates"] === true
  );
};
const notificationsOff: Request["done"] = (state) =>
  switches(state).Notifications === false &&
  (state.changes as string[]).length === 1;

// Steps that more than one path uses.
const openBudget: Step = (v) => act.click(named(v, "Budget 2027"));
const readBudget = doneStep(
  "The note Budget 2027 says: Rent 1,200. Food 400. Savings 300.",
);
const clickNamed =
  (title: string, role?: string): Step =>
  (v) =>
    act.click(named(v, title, role));
const clickIn =
  (selector: string): Step =>
  async (v) =>
    act.click(await under(v, selector));
const clickAtIn =
  (selector: string): Step =>
  async (v) =>
    act.clickAt(await pointIn(v, selector));
const askPassword: Step = () =>
  act.ask(
    "Please type your password into the Password field on the Mac yourself, then say yes.",
  );
/** A closer look at the middle of an element of the app. */
const closerAt =
  (selector: string): Step =>
  async (v) =>
    act.lookCloser(await pointIn(v, selector));
/** A click on an element of the app, at its point in the closer picture of this turn. */
const clickInCloserOn =
  (selector: string): Step =>
  async (v) =>
    act.clickInCloser(inCloser(v, await pointIn(v, selector)));
/** Text typed into a field by its name. */
const typeInto =
  (text: string, title: string): Step =>
  (v) =>
    act.type(text, named(v, title));

/** The invoice number in the open note, as the planner reads it in the value of the editor. */
const shownInvoice = (v: ScriptView) => {
  const number = /Invoice number (\d+)/.exec(
    v.screen.map((item) => item.value ?? "").join("\n"),
  )?.[1];
  if (!number) throw new Error("the screen shows no invoice number");
  return number;
};
/** The invoice number that the plan kept as a fact, as the planner reads it in its brief. */
const keptInvoice = (v: ScriptView) => {
  const number = /- "Invoice number (\d+)"/.exec(v.ask.brief)?.[1];
  if (!number) throw new Error("the plan kept no invoice number");
  return number;
};
/** Keeps the invoice number of the open note in the plan. Once the brief shows it, the turn goes to the next step. */
const keepInvoice: Step = (v) =>
  /- "Invoice number \d+"/.test(v.ask.brief)
    ? "next"
    : act.planNote([`Invoice number ${shownInvoice(v)}`]);
/** Finds the invoice note with the search, opens it and keeps its number. */
const findInvoice: Step[] = [
  typeInto("invoice", "Search"),
  clickNamed("Workshop invoice"),
  keepInvoice,
];
/** From the search for the invoice to the note Call list: the search now names that note. */
const openCallList: Step[] = [
  clickNamed("Search"),
  () => act.key("cmd+a"),
  () => act.type("Call list"),
  clickNamed("Call list"),
];
/** The kept number as a new line at the end of the open note. */
const addKeptNumber: Step[] = [
  clickIn("#editor"),
  () => act.key("return"),
  (v) => act.type(keptInvoice(v)),
];
const tellInvoice: Step = (v) =>
  act.done(
    `Invoice number ${keptInvoice(v)} is a new line of the note Call list now.`,
  );

/** The sign-in of Ledger, with the password typed by the person. */
const signInLedger: Step[] = [
  typeInto("ada@example.com", "Email"),
  askPassword,
  clickNamed("Sign in", "AXButton"),
];

/** The three pages of the trip request, with the seat that is given. */
const fillTrip = (seat: string): Step[] => [
  typeInto("Ada Lovelace", "Full name"),
  clickNamed("Next"),
  typeInto("12 March", "Travel date"),
  clickNamed("Next"),
  clickNamed(seat, "AXRadioButton"),
];
/** Done with the reference that the screen shows, else give up. */
const tellReference: Step = (v) => {
  const reference = /Your reference is (TR-\d+)/.exec(v.ask.brief)?.[1];
  return reference
    ? act.done(`The trip request is sent. Its reference is ${reference}.`)
    : act.giveUp("The screen shows no reference.");
};

const requests: Request[] = [
  {
    id: "open a note and read it",
    app: "notes",
    goal: "Open the note named Budget 2027 and tell me what it says.",
    done: budgetRead,
    paths: [
      ideal([openBudget, readBudget]),
      wrong("done without opening it", [readBudget]),
    ],
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
    paths: [
      ideal([
        clickNamed("Call list"),
        async (v) => act.type("Call the bank at 9", await under(v, "#editor")),
        doneStep("The line is added to the note Call list."),
      ]),
      wrong("into the note that was open", [
        async (v) => act.type("Call the bank at 9", await under(v, "#editor")),
        doneStep("The line is added to the note Call list."),
      ]),
    ],
  },
  {
    id: "replace the text of a note",
    app: "notes",
    goal: "Open the note named Groceries and replace all of its text with the one line 'oat milk'.",
    done: (state) => noteOf(state, "Groceries")?.text.trim() === "oat milk",
    paths: [
      ideal([
        clickNamed("Groceries"),
        clickIn("#editor"),
        () => act.key("cmd+a"),
        () => act.type("oat milk"),
        doneStep("The note Groceries now says oat milk."),
      ]),
      wrong("typed with no selection", [
        clickNamed("Groceries"),
        clickIn("#editor"),
        () => act.type("oat milk"),
        doneStep("The note Groceries now says oat milk."),
      ]),
    ],
  },
  {
    id: "find a note that is not in view",
    app: "notes",
    goal: "Open the note named Zebra crossing and tell me what it says.",
    done: zebraRead,
    paths: [
      ideal([
        (v) => act.type("Zebra", named(v, "Search")),
        clickNamed("Zebra crossing"),
        doneStep(
          "The note Zebra crossing says: The council answered: next spring.",
        ),
      ]),
      wrong("done without finding it", [
        doneStep("The note says: The council answered: next spring."),
      ]),
    ],
  },
  {
    id: "make a new note",
    app: "notes",
    goal: "Make a new note that says 'Buy stamps'.",
    done: newNote,
    paths: [
      ideal([
        clickNamed("New note"),
        () => act.type("Buy stamps"),
        doneStep("A new note says Buy stamps."),
      ]),
      wrong("typed with no new note", [
        () => act.type("Buy stamps"),
        doneStep("A new note says Buy stamps."),
      ]),
    ],
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
    paths: [
      ideal([
        clickNamed("Recipes"),
        clickIn("#trash"),
        clickIn("#remove"),
        doneStep("The note Recipes is deleted."),
      ]),
      wrong("deletes the note that was open", [
        clickIn("#trash"),
        clickIn("#remove"),
        doneStep("The note Recipes is deleted."),
      ]),
    ],
  },
  {
    id: "delete a note, the person says no",
    app: "notes",
    goal: "Delete the note named Recipes.",
    person: no,
    done: (state, _said, final) =>
      (state as unknown as NotesState).deleted.length === 0 &&
      final === "canceled",
    paths: [
      ideal([
        clickNamed("Recipes"),
        clickIn("#trash"),
        clickIn("#remove"),
        doneStep("The note Recipes is deleted."),
      ]),
      wrong("says done with no question", [
        doneStep("The note Recipes is deleted."),
      ]),
    ],
  },
  {
    id: "turn on two switches",
    app: "settings",
    goal: "Turn on Bluetooth and dark mode.",
    done: twoSwitches,
    paths: [
      ideal([
        clickNamed("Bluetooth"),
        clickNamed("Dark mode"),
        doneStep("Bluetooth and dark mode are on."),
      ]),
      wrong("only one of the two", [
        clickNamed("Bluetooth"),
        doneStep("Bluetooth and dark mode are on."),
      ]),
    ],
  },
  {
    id: "a switch that is on already",
    app: "settings",
    goal: "Make sure that Wi-Fi is on.",
    done: (state) =>
      switches(state)["Wi-Fi"] === true &&
      (state.changes as string[]).length === 0,
    paths: [
      ideal([doneStep("Wi-Fi is on already.")]),
      wrong("turns it off", [clickNamed("Wi-Fi"), doneStep("Wi-Fi is on.")]),
    ],
  },
  {
    id: "a switch whose state only the picture shows",
    app: "settings",
    goal: "Turn off notifications.",
    done: notificationsOff,
    paths: [
      ideal([clickNamed("Notifications"), doneStep("Notifications are off.")]),
      wrong("the switch below it", [
        clickNamed("Automatic updates"),
        doneStep("Notifications are off."),
      ]),
    ],
  },
  {
    id: "save in a dialog",
    app: "document",
    goal: "Save the document.",
    done: (state) => state.outcome === "saved",
    paths: [
      ideal([clickNamed("Save"), doneStep("The document is saved.")]),
      wrong("throws the changes away", [
        clickNamed("Don't Save"),
        doneStep("The document is saved."),
      ]),
    ],
  },
  {
    id: "sign in, the person types the password",
    app: "login",
    goal: "Sign in with the email ada@example.com. I type the password myself.",
    person: typesPassword,
    done: (state) => state.signedIn === "ada@example.com",
    paths: [
      ideal([
        (v) => act.type("ada@example.com", named(v, "Email")),
        askPassword,
        clickNamed("Sign in", "AXButton"),
        doneStep("You are signed in as ada@example.com."),
      ]),
      wrong("signs in with no password", [
        (v) => act.type("ada@example.com", named(v, "Email")),
        clickNamed("Sign in", "AXButton"),
        doneStep("You are signed in as ada@example.com."),
      ]),
    ],
  },
  {
    id: "drawn stars",
    app: "board",
    goal: "Rate this board with four stars.",
    done: (state) => state.stars === 4,
    paths: [
      ideal([
        clickAtIn('.star[data-star="4"]'),
        doneStep("The board is rated with four stars."),
      ]),
      ideal(
        [
          closerAt(".rating"),
          clickInCloserOn('.star[data-star="4"]'),
          doneStep("The board is rated with four stars."),
        ],
        "a closer look first",
      ),
      wrong("the third star", [
        clickAtIn('.star[data-star="3"]'),
        doneStep("The board is rated with four stars."),
      ]),
      wrong("the third star, in the closer picture", [
        closerAt(".rating"),
        clickInCloserOn('.star[data-star="3"]'),
        doneStep("The board is rated with four stars."),
      ]),
    ],
  },
  {
    id: "a drawn x",
    app: "board",
    goal: "Close the yellow banner at the top of the board.",
    done: (state) => state.banner === false,
    paths: [
      ideal([clickAtIn("#x"), doneStep("The banner is closed.")]),
      wrong("the text of the banner", [
        clickAtIn(".banner .msg"),
        doneStep("The banner is closed."),
      ]),
    ],
  },

  // Recovery: ordinary trouble on the way, and the request must still end with what the app holds.
  {
    id: "a 429 at the first call and a 503 at the third",
    app: "settings",
    goal: "Turn on Bluetooth and dark mode.",
    faults: {
      model: [
        { call: 1, kind: "429", retryAfterS: 1 },
        { call: 3, kind: "503" },
      ],
    },
    done: twoSwitches,
    paths: [
      ideal([
        clickNamed("Bluetooth"),
        clickNamed("Dark mode"),
        doneStep("Bluetooth and dark mode are on."),
      ]),
      wrong("only one of the two", [
        clickNamed("Bluetooth"),
        doneStep("Bluetooth and dark mode are on."),
      ]),
    ],
  },
  {
    id: "an answer with no function call, and one that is not JSON",
    app: "notes",
    goal: "Open the note named Budget 2027 and tell me what it says.",
    faults: {
      model: [
        { call: 1, kind: "no_tool_call" },
        { call: 3, kind: "bad_json" },
      ],
    },
    done: budgetRead,
    paths: [
      ideal([openBudget, readBudget]),
      wrong("done without opening it", [readBudget]),
    ],
  },
  {
    id: "a window that moves, then settles",
    app: "invoices",
    goal: "Open the invoice of Granite Tools and tell me its amount.",
    // Ten links named View: a moved one cannot be found again by its place, so the worker holds the click.
    faults: { hands: { moving: { looks: 4, dx: 14, dy: 10 } } },
    done: (state, said) =>
      state.opened === "Granite Tools" && /734\.90/.test(said),
    paths: [
      ideal([
        (v) => act.click(inRow(v, "Granite Tools", "View")),
        doneStep("The invoice of Granite Tools is $734.90."),
      ]),
      wrong("the first row", [
        (v) => act.click(inRow(v, "Amber Mill", "View")),
        doneStep("The invoice of Granite Tools is $734.90."),
      ]),
    ],
  },
  {
    id: "the button does not work, the shortcut does",
    app: "notes",
    goal: "Make a new note that says 'Buy stamps'.",
    faults: { hands: { deaf: { selector: "#new", times: 1000 } } },
    done: newNote,
    paths: [
      ideal([
        clickNamed("New note"),
        // The button did nothing: the screen shows no new note. Command-N does what it should.
        async (v) =>
          ((await stateOf(v)) as unknown as NotesState).notes.length === 16
            ? "next"
            : act.key("cmd+n"),
        () => act.type("Buy stamps"),
        doneStep("A new note says Buy stamps."),
      ]),
      wrong("trusts the button", [
        clickNamed("New note"),
        () => act.type("Buy stamps"),
        doneStep("A new note says Buy stamps."),
      ]),
    ],
  },
  {
    id: "only the person knows: ask, do not give up",
    app: "login",
    goal: "Sign in to Ledger with my work email. I type the password myself.",
    person: knowsEmail,
    done: (state, _said, _final, talk) =>
      state.signedIn === "ada@example.com" &&
      talk.asked.some((question) => /e-?mail/i.test(question)),
    paths: [
      ideal([
        () => act.ask("What is your work email address?"),
        // The answer must reach the planner: the step types what it reads there.
        (v) => {
          const email = /the person answered: ([^\s()]+@[^\s()]+)/.exec(
            v.ask.brief,
          )?.[1];
          if (!email) throw new Error("the answer did not reach the planner");
          return act.type(email, named(v, "Email"));
        },
        askPassword,
        clickNamed("Sign in", "AXButton"),
        doneStep("You are signed in with your work email."),
      ]),
      wrong("gives up", [() => act.giveUp("I do not know your work email.")]),
      wrong("guesses the email", [
        (v) => act.type("work@example.com", named(v, "Email")),
        askPassword,
        clickNamed("Sign in", "AXButton"),
        doneStep("You are signed in with your work email."),
      ]),
    ],
  },
  {
    id: "a click that the app does not take",
    app: "settings",
    goal: "Turn off notifications.",
    faults: { hands: { deaf: { times: 1 } } },
    done: notificationsOff,
    paths: [
      ideal([
        clickNamed("Notifications"),
        // The switch did not turn: the same click again, once.
        async (v) =>
          switches(await stateOf(v)).Notifications === false
            ? "next"
            : act.click(named(v, "Notifications")),
        doneStep("Notifications are off."),
      ]),
      wrong("trusts the first click", [
        clickNamed("Notifications"),
        doneStep("Notifications are off."),
      ]),
    ],
  },

  // The new kinds of action.
  {
    id: "a menu that opens only on hover",
    app: "reports",
    goal: "Export the report as a PDF from the Export menu.",
    newActions: true,
    done: (state) => state.exported === "PDF",
    paths: [
      {
        ...ideal([
          (v) => newAction.hover({ element: named(v, "Export") }),
          clickNamed("PDF"),
          doneStep("The report is exported as a PDF."),
        ]),
        needs: ["hover"],
      },
      wrong("clicks the title", [
        clickNamed("Export"),
        doneStep("The report is exported as a PDF."),
      ]),
    ],
  },
  {
    id: "a card dragged to another column",
    app: "tasks",
    goal: "Move the card Write the invoice to the Done column.",
    newActions: true,
    done: (state) => {
      const now = columns(state);
      return (
        now.Done?.includes("Write the invoice") === true &&
        now.Done.includes("Book the venue") &&
        JSON.stringify(now["To do"]) === '["Call the printer"]' &&
        JSON.stringify(now.Doing) === '["Plan the launch"]'
      );
    },
    paths: [
      {
        ...ideal([
          (v) =>
            newAction.drag(
              { element: named(v, "Write the invoice") },
              { element: named(v, "Done", "AXList") },
            ),
          doneStep("The card Write the invoice is in Done."),
        ]),
        needs: ["drag"],
      },
      wrong("clicks the card", [
        clickNamed("Write the invoice"),
        doneStep("The card Write the invoice is in Done."),
      ]),
      wrong(
        "drags it to Doing",
        [
          (v) =>
            newAction.drag(
              { element: named(v, "Write the invoice") },
              { element: named(v, "Doing", "AXList") },
            ),
          doneStep("The card Write the invoice is in Done."),
        ],
        ["drag"],
      ),
    ],
  },
  {
    id: "a slider dragged to a value",
    app: "sound",
    goal: "Set the output volume to 80 percent.",
    newActions: true,
    done: (state) =>
      Number(state.volume) >= 77 &&
      Number(state.volume) <= 83 &&
      state.alert === 50,
    paths: [
      {
        ...ideal([
          async (v) =>
            newAction.drag(
              await pointIn(v, "#volume .knob"),
              await pointIn(v, "#volume", 0.8),
            ),
          doneStep("The output volume is at 80 percent."),
        ]),
        needs: ["drag"],
      },
      wrong("clicks the track", [
        async (v) => act.clickAt(await pointIn(v, "#volume", 0.8)),
        doneStep("The output volume is at 80 percent."),
      ]),
    ],
  },
  {
    id: "a note far down the list, with one long scroll",
    app: "notes",
    goal: "Open the note named Zebra crossing and tell me what it says.",
    newActions: true,
    done: zebraRead,
    paths: [
      {
        ...ideal([
          (v) => newAction.scroll("down", 10, named(v, "Budget 2027")),
          clickNamed("Zebra crossing"),
          doneStep(
            "The note Zebra crossing says: The council answered: next spring.",
          ),
        ]),
        needs: ["scroll_amount"],
      },
      wrong("scrolls up", [
        (v) => act.scroll("up", named(v, "Budget 2027")),
        doneStep("The note says: The council answered: next spring."),
      ]),
    ],
  },
  {
    id: "a list of choices on a page",
    tabs: { urls: ["https://shop.example/checkout"] },
    goal: "On the checkout page, choose Portugal as the country and save.",
    newActions: true,
    done: (state) => state.saved === "Portugal",
    paths: [
      {
        ...ideal([
          () => act.read(),
          (v) => newAction.browserSelect(onPage(v, "Country"), "Portugal"),
          (v) => act.pageClick(onPage(v, "Save")),
          doneWhenShown(/Saved\. Country: Portugal/, "Portugal is saved."),
        ]),
        needs: ["browser_select"],
      },
      ideal(
        [
          () => act.read(),
          (v) => act.pageType(onPage(v, "Country"), "Portugal"),
          (v) => act.pageClick(onPage(v, "Save")),
          doneWhenShown(/Saved\. Country: Portugal/, "Portugal is saved."),
        ],
        "today's way: type the choice",
      ),
      wrong("saves with no choice", [
        () => act.read(),
        (v) => act.pageClick(onPage(v, "Save")),
        doneStep("Portugal is saved."),
      ]),
    ],
  },
  {
    id: "a page that shows its result after a moment",
    tabs: { urls: ["https://travel.example/"] },
    goal: "Search this travel page for flights to Lisbon and tell me the cheapest price.",
    newActions: true,
    done: (state, said) =>
      /lisbon/i.test(String(state.searched)) && /\b89\b/.test(said),
    paths: [
      {
        ...ideal([
          () => act.read(),
          (v) => act.pageType(onPage(v, "Where to"), "Lisbon", true),
          () => newAction.browserWait(5000, "EUR"),
          doneWhenShown(
            /89 EUR/,
            "The cheapest flight to Lisbon costs 89 EUR, on Wednesday.",
          ),
        ]),
        needs: ["browser_wait"],
      },
      ideal(
        [
          () => act.read(),
          (v) => act.pageType(onPage(v, "Where to"), "Lisbon", true),
          () => act.wait(1500),
          () => act.read(),
          doneWhenShown(
            /89 EUR/,
            "The cheapest flight to Lisbon costs 89 EUR, on Wednesday.",
          ),
        ],
        "today's way: wait, then read",
      ),
      wrong("done before the result", [
        () => act.read(),
        (v) => act.pageType(onPage(v, "Where to"), "Lisbon", true),
        doneStep("I found no flight to Lisbon."),
      ]),
    ],
  },
  {
    id: "the right one of three tabs",
    tabs: {
      urls: [
        "https://mail.example/",
        "https://docs.example/plan",
        "https://travel.example/",
      ],
    },
    goal: "Go to the tab with the quarterly plan and tell me its first goal.",
    newActions: true,
    done: (state, said) =>
      /docs\.example\/plan/.test(String(state.activeUrl)) &&
      /grow the north/i.test(said),
    paths: [
      {
        ...ideal([
          () => newAction.browserTabs(),
          async (v) =>
            newAction.browserSwitchTab(
              await v.browser!.tabNumber(/quarterly plan/i),
            ),
          () => act.read(),
          doneWhenShown(
            /Grow the north/,
            "The first goal is: Grow the north by 8 percent.",
          ),
        ]),
        needs: ["browser_tabs", "browser_switch_tab"],
      },
      wrong("reads the tab in front", [
        () => act.read(),
        doneStep("The first goal is: Welcome to your inbox."),
      ]),
    ],
  },
  // Requests of several steps. The worker plans them first (plan.ts).
  {
    id: "find a note by a word, copy a number from it into another note, confirm",
    app: "invoiceNotes",
    goal: "Find the note whose name has the word invoice, copy its invoice number into the note named Call list as a new line, then tell me the number.",
    done: (state, said) => {
      const held = state as unknown as NotesState;
      return (
        /Dentist on Monday\.[\s\S]*30417/.test(
          noteOf(state, "Call list")?.text ?? "",
        ) &&
        noteOf(state, "Workshop invoice")?.text ===
          "From the print shop. Invoice number 30417, due on Friday." &&
        held.notes.length === 16 &&
        held.notes.filter((note) => note.text.includes("30417")).length === 2 &&
        /30417/.test(said)
      );
    },
    paths: [
      ideal([...findInvoice, ...openCallList, ...addKeptNumber, tellInvoice]),
      wrong("into the invoice note", [
        ...findInvoice,
        ...addKeptNumber,
        tellInvoice,
      ]),
      wrong("tells the number and copies nothing", [
        ...findInvoice,
        tellInvoice,
      ]),
    ],
  },
  {
    id: "sign in, the person types the password, then change a setting",
    app: "ledger",
    goal: "Sign in to Ledger with the email ada@example.com, I type the password myself. Then turn on Weekly summary in its settings.",
    // At a question with an empty password field, the person types into it, then says yes.
    person: async (_question, page) => {
      const field = page.locator("#password");
      if ((await field.isVisible()) && !(await field.inputValue())) {
        await field.click();
        await page.keyboard.type("a-test-password");
      }
      return "yes";
    },
    done: (state) => {
      const now = switches(state);
      return (
        state.signedIn === "ada@example.com" &&
        (state.passwordLength as number) > 0 &&
        now["Weekly summary"] === true &&
        now["Email receipts"] === true &&
        now["Paper statements"] === false &&
        JSON.stringify(state.changes) === JSON.stringify(["Weekly summary"])
      );
    },
    paths: [
      ideal([
        ...signInLedger,
        clickNamed("Settings", "AXButton"),
        clickNamed("Weekly summary"),
        doneStep("You are signed in, and Weekly summary is on."),
      ]),
      wrong("the switch next to it", [
        ...signInLedger,
        clickNamed("Settings", "AXButton"),
        clickNamed("Paper statements"),
        doneStep("You are signed in, and Weekly summary is on."),
      ]),
      wrong("done after the sign-in", [
        ...signInLedger,
        doneStep("You are signed in, and Weekly summary is on."),
      ]),
    ],
  },
  {
    id: "a form of three pages, sent, and its reference read",
    app: "trip",
    goal: "Fill in the trip request: the name Ada Lovelace on the first page, the date 12 March on the second, a window seat on the third. Then send it and tell me its reference.",
    person: yes,
    done: (state, said, final) =>
      state.sent === true &&
      state.name === "Ada Lovelace" &&
      state.date === "12 March" &&
      state.seat === "Window" &&
      final === "completed" &&
      /TR-5521/.test(said),
    paths: [
      ideal([...fillTrip("Window"), clickNamed("Send request"), tellReference]),
      wrong("the aisle seat", [
        ...fillTrip("Aisle"),
        clickNamed("Send request"),
        tellReference,
      ]),
      wrong("a reference before it is sent", [
        ...fillTrip("Window"),
        doneStep("The trip request is sent. Its reference is TR-5521."),
      ]),
    ],
  },
];

// Each argument is provider/model, or a bare model of OpenAI.
const planners = new Map<string, PlannerOptions>(
  checking
    ? []
    : (words.some((word) => !word.startsWith("--"))
        ? words.filter((word) => !word.startsWith("--"))
        : [null]
      ).map((word) => {
        const chosen = keyFor(word);
        return [word ?? chosen.name, chosen.options];
      }),
);
const models = [...planners.keys()];
const repeats = Math.max(1, Math.floor(Number(process.env.REPEATS ?? "1")));
const only = process.env.ONLY;
const chosen = requests.filter(
  (request) =>
    (withNew || !request.newActions) && (!only || request.id.includes(only)),
);

interface Row {
  model: string;
  request: string;
  /** The scripted path, in the check mode. */
  path?: string;
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
  /** The faults that were given, in order. */
  faults: string[];
  /** Why a scripted path could not go on, when it could not. */
  trouble?: string;
}
const browser = await chromium.launch({ headless: true });

/** Who chooses the actions: a model by its name, or a scripted path. */
type Chooser = { model: string } | { path: Path };

async function one(
  request: Request,
  run: number,
  chooser: Chooser,
): Promise<Row> {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-request-eval-"));
  const context = await browser.newContext({
    viewport: picture,
    deviceScaleFactor: 1,
  });
  try {
    let desk: Desk;
    let port: EvalBrowser | undefined;
    if (request.tabs) {
      await serveSites(context, sites);
      const tabs = new EvalBrowser(context);
      await tabs.start(request.tabs.urls, request.tabs.active ?? 0);
      port = tabs;
      desk = {
        page: () => tabs.active,
        app: async () => ({ ...browserApp, window: await tabs.active.title() }),
      };
    } else {
      const app = apps[request.app!];
      const page = await context.newPage();
      await page.setContent(app.html);
      desk = { page: () => page, app: async () => app.app };
    }
    const applied: string[] = [];
    const pageHands = new PageHands(desk);
    const hands: Hands = request.faults?.hands
      ? new FaultyHands(pageHands, desk, request.faults.hands, applied)
      : pageHands;
    const journal = new ComputerJournal(root);
    const id = `r${run}`;
    const script =
      "path" in chooser
        ? player(chooser.path.steps, {
            app: () => desk.page(),
            ...(port ? { browser: port } : {}),
            steps: () => journal.get(id)?.steps ?? [],
            always: !chooser.path.ideal,
          })
        : null;
    const planner = new ModelPlanner({
      ...(script || !("model" in chooser)
        ? { key: "no-key-scripted", model: "scripted" }
        : planners.get(chooser.model)!),
      request: withModelFaults(
        script ? scriptedModel(script.choose) : fetch,
        request.faults?.model ?? [],
        applied,
      ),
      ...(port ? { browser: true, browserMethods: browserMethods(port) } : {}),
    });
    const said: string[] = [];
    const timed: StepTiming[] = [];
    const worker = new ComputerWorker({
      hands,
      planner,
      journal,
      ...(port ? { browser: port } : {}),
      notify: (text) => said.push(text),
      timing: (entry) => timed.push(entry),
      maxMs: script ? 60_000 : 180_000,
    });
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
        const reply = await (request.person ?? yes)(now.message, desk.page());
        await worker.answer(reply);
      } else if (now.state !== "running" && now.state !== "stopping") break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await worker.idle();
    const seconds = (performance.now() - from) / 1000;
    const record = journal.get(id);
    const final = record?.state ?? "unknown";
    const last = said.at(-1) ?? "";
    const state = port
      ? await port.state()
      : ((await desk.page().evaluate("window.state()")) as Record<
          string,
          unknown
        >);
    const sum = (pick: (entry: StepTiming) => number) =>
      Math.round(timed.reduce((total, entry) => total + pick(entry), 0));
    const trouble = script?.trouble();
    return {
      model: "model" in chooser ? chooser.model : "check",
      request: request.id,
      ...("path" in chooser ? { path: chooser.path.name } : {}),
      run,
      done: request.done(state, last, final, { asked }),
      state: final,
      reason: record?.reason ?? "",
      steps: timed.length,
      inputs: pageHands.sent.length,
      questions,
      seconds: Math.round(seconds * 10) / 10,
      lookMs: sum((entry) => entry.lookMs),
      planMs: sum((entry) => entry.planMs),
      actMs: sum((entry) => entry.actMs),
      said: last.slice(0, 200),
      kinds: timed.map((entry) => entry.kind).join(" "),
      asked,
      // A point is given in pixels of the picture, as the planner sees it.
      sent: pageHands.sent.map((command) =>
        command.kind === "click"
          ? `click ${Math.round(command.x / toScreen)},${Math.round(command.y / toScreen)}`
          : command.kind === "type"
            ? `type ${JSON.stringify(command.text.slice(0, 40))}`
            : command.kind === "key"
              ? `key ${command.combo}`
              : command.kind,
      ),
      faults: applied,
      ...(trouble ? { trouble } : {}),
    };
  } finally {
    await context.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** A row for a request that failed inside the test itself. */
const faultRow = (
  model: string,
  request: Request,
  run: number,
  error: unknown,
  path?: Path,
): Row => ({
  model,
  request: request.id,
  ...(path ? { path: path.name } : {}),
  run,
  done: false,
  state: "fault",
  reason: String(error instanceof Error ? error.message : error).slice(0, 160),
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
  faults: [],
});

/** Runs `work` on each item, at most `size` at a time, and keeps the order. */
async function pool<T, R>(
  items: T[],
  size: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await work(items[index]!);
      }
    }),
  );
  return out;
}

/** The check mode: every path of every chosen request, and one line for each request. */
async function check() {
  const offered = await newKindsOffered();
  const jobs = chosen.flatMap((request) =>
    request.paths.map((path) => ({ request, path })),
  );
  const results = await pool(jobs, 6, async ({ request, path }) => {
    const lack = missing(path.needs, offered);
    if (lack.length) return { request, path, lack, row: null };
    const row = await one(request, 1, { path }).catch((error) =>
      faultRow("check", request, 1, error, path),
    );
    return { request, path, lack, row };
  });
  let failed = 0;
  let skippedPaths = 0;
  let unproven = 0;
  const lacking = new Set<NewKind>();
  for (const request of chosen) {
    const mine = results.filter((result) => result.request === request);
    const problems: string[] = [];
    const notes: string[] = [];
    let proven = 0;
    let refused = 0;
    let wrongRan = 0;
    for (const { path, lack, row } of mine) {
      if (!row) {
        skippedPaths += 1;
        for (const kind of lack) lacking.add(kind);
        notes.push(`"${path.name}" skipped: needs ${lack.join(", ")}`);
        continue;
      }
      const end = `${row.state}${row.reason && row.state !== "completed" ? `: ${row.reason}` : ""}`;
      if (path.ideal) {
        if (row.done) {
          proven += 1;
          notes.push(
            `"${path.name}" done in ${row.steps} steps${row.faults.length ? ` through ${row.faults.join(", ")}` : ""}`,
          );
        } else
          problems.push(
            `ideal "${path.name}" was not done (${end})${row.trouble ? `, script ${row.trouble}` : ""}${row.said ? `: ${row.said}` : ""}`,
          );
      } else {
        wrongRan += 1;
        if (row.done)
          problems.push(`wrong "${path.name}" was taken as done (${end})`);
        else refused += 1;
      }
    }
    if (wrongRan) notes.push(`${refused} of ${wrongRan} wrong paths not done`);
    if (problems.length) failed += 1;
    else if (!proven) unproven += 1;
    const mark = problems.length ? "FAIL" : proven ? "ok  " : "skip";
    console.log(`${mark} ${request.id}: ${[...problems, ...notes].join("; ")}`);
  }
  console.log(
    `\n${chosen.length} requests: ${chosen.length - failed - unproven} ok, ${failed} failed, ${unproven} with no ideal path run. ${skippedPaths} of ${jobs.length} paths skipped${lacking.size ? `: this build does not offer ${[...lacking].join(", ")}` : ""}.`,
  );
  if (process.env.OUT)
    writeFileSync(
      process.env.OUT,
      `${JSON.stringify({ at: new Date().toISOString(), check: true, rows: results.map((result) => result.row).filter(Boolean) }, null, 1)}\n`,
    );
  return failed;
}

/** The model mode: every chosen request with each model, as often as REPEATS says. */
async function measure() {
  const rows: Row[] = [];
  for (const model of models)
    for (let run = 1; run <= repeats; run++) {
      // Requests of one model run side by side: each has its own page, worker and journal.
      const batch = await Promise.all(
        chosen.map((request) =>
          one(request, run, { model }).catch((error) =>
            faultRow(model, request, run, error),
          ),
        ),
      );
      rows.push(...batch);
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
      "request | done | end | steps | inputs | questions | seconds | actions | faults",
    );
    for (const row of mine)
      console.log(
        `${row.request} | ${row.done ? "yes" : "NO"} | ${row.state}${row.reason && row.state !== "completed" ? ` (${row.reason})` : ""} | ${row.steps} | ${row.inputs} | ${row.questions} | ${row.seconds} | ${row.kinds} | ${row.faults.join(", ")}`,
      );
    for (const row of mine.filter((item) => !item.done))
      console.log(`  not done: ${row.request}: ${row.said}`);
  }
}

let failed = 0;
try {
  if (checking) failed = await check();
  else await measure();
} finally {
  await browser.close();
}
if (failed) process.exitCode = 1;
