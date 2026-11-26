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
 * The long requests (their names start with "long:") have ideal paths of
 * 31 to 47 steps, most of them across two apps on one desk: a form of
 * twelve fields, prices of four products, ten rows of a sheet, five
 * messages and a note, a way that failed early, a sign-in in the middle, and
 * a list that another person changes halfway. Each has a step limit and a time limit of its own, under
 * the limits of the service, and the result of every request says its steps
 * and its seconds.
 *
 *   npm run eval:computer:request -- gpt-5.4
 *   npm run eval:computer:request -- gpt-5.4 --repeat 3 --split held --out b.json
 *   npx tsx tests/computer-request.eval.ts --compare a.json b.json
 *   npx tsx tests/computer-request.eval.ts --check
 *   npx tsx tests/computer-request.eval.ts --check --new-actions
 *   npx tsx tests/computer-request.eval.ts gpt-5.4 --only long: --repeat 2
 *
 * Each argument is provider/model, or a bare model of OpenAI, with "@effort"
 * for a reasoning effort (`gpt-6.2-astra@low`). With none it uses the model
 * that the service would use. `--repeat N` (default 1, or REPEATS) is how
 * often each request runs. It prints, for each request, the runs that were
 * done out of N with a 95 percent interval and the median and 90th
 * percentile seconds, and the requests that were done in some runs and not
 * in all. `--split dev|held|all` (default all) takes the dev requests, the
 * held requests (`held: true`, a fixed quarter) or all. `--out FILE.json`
 * (or OUT) writes the result of each request and every run; `--compare
 * A.json B.json` prints what changed from A to B and runs nothing. `--only
 * WORDS` (or ONLY) names a part of a request's name: `--only long:` runs the
 * long requests.
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
 * exits with status 1 when one fails. It takes `--repeat`, `--split` and
 * `--out` too, with no network: a request whose paths do not give the same
 * verdict in every run fails.
 *
 * --new-actions adds the requests for hover, drag, scroll with an amount and
 * the new browser actions. A path that needs a kind that this build does not
 * offer is skipped, with a line that says so.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
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
  withEvalRequest,
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
import {
  compareFiles,
  evalFlags,
  printResults,
  repeatsOf,
  results as toResults,
  writeResults,
  type CaseRun,
} from "./computer-eval-report.js";
import { inSplit } from "./computer-eval-stats.js";
import {
  apps,
  bookInvoices,
  browserApp,
  people,
  receiptRows,
  rotaNewcomers,
  rotaPeople,
  sites,
} from "./computer-request-apps.js";

const flags = evalFlags(process.argv.slice(2));
const checking = flags.check;
const comparing = flags.compare;
const withNew = flags.newActions;
const outFile = flags.out ?? process.env.OUT;
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

/** What the worker said to the person in the request, and the faults that were given on the way. */
interface Talk {
  asked: string[];
  faults: string[];
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
  /**
   * A held request: judge a change on it, never design one on it. The held
   * requests are a quarter of the requests without --new-actions and a
   * quarter of those with it, chosen once by the split hash of their names
   * (pickHeld in computer-eval-stats.ts). A new request is held when
   * heldByHash says so. The long requests are held by choice, five of seven,
   * so that a fault after step 30 is judged on requests that no rule was
   * made on.
   */
  held?: true;
  /** The app on the screen. */
  app?: keyof typeof apps;
  /** Or a desk of several apps, the first one in front: open_app brings another one forward. */
  desk?: (keyof typeof apps)[];
  /** Or a browser with these tabs, the first one in front unless `active` says another. */
  tabs?: { urls: string[]; active?: number };
  goal: string;
  person?: Person;
  faults?: Faults;
  /** It is about the new kinds of action: only with --new-actions. */
  newActions?: true;
  /** The subgoals of the scripted plan in --check. Without them the plan is one subgoal, the goal itself. */
  subgoals?: string[];
  /**
   * The most actions and minutes for this request. The service's own limits
   * stay above them: 40 actions, or 80 with a plan of 3 subgoals or more.
   * Without it the request has the service's step limit and 3 minutes (1 in
   * --check).
   */
  limit?: { steps: number; minutes: number };
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
  typeInto("Ada Brook", "Full name"),
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

/*
 * Long requests: 30 to 60 steps each, most of them across two apps. Each
 * has a step limit of its own, about one and a half times its ideal path,
 * and the scripted plan of --check has several subgoals, as a long plan of
 * a model has. Most of them are held.
 */

/** The limits of the service for one request (worker.ts): 40 actions, 80 with a plan of 3 subgoals or more. */
const serviceLimits = { steps: 40, plannedSteps: 80 };
/** The limit of a long request: its steps, and 12 minutes with a model. */
const longLimit = (steps: number) => ({ steps, minutes: 12 });

/** A click on a field by its name, then the text: the field takes the focus first, as a person does it. */
const fill = (title: string, text: string): Step[] => [
  clickNamed(title),
  () => act.type(text),
];
/** A choice in a pop-up button, both by their names. */
const pick = (popup: string, choice: string): Step[] => [
  clickNamed(popup, "AXPopUpButton"),
  clickNamed(choice, "AXMenuItem"),
];
const openApp =
  (name: string): Step =>
  () =>
    act.openApp(name);
/** The facts that the plan kept, oldest first, as the planner reads them in its brief. */
const keptFacts = (v: ScriptView) =>
  [...v.ask.brief.matchAll(/^- "(.*)"$/gm)].map((found) => found[1]!);
/**
 * Keeps facts that the screen shows now in the plan. Once the brief shows
 * them, the turn goes to the next step. A later step reads them from the
 * brief, as a model does after the screen is gone.
 */
const keep =
  (facts: (v: ScriptView) => string[]): Step =>
  (v) => {
    const wanted = facts(v);
    const kept = keptFacts(v);
    return wanted.every((fact) => kept.includes(fact))
      ? "next"
      : act.planNote(wanted);
  };
/** The names of the elements of the screen, in the order of the screen. */
const titlesOf = (v: ScriptView) => v.screen.map((item) => item.title);
/** The value of the one element with this name. */
const valueOf = (v: ScriptView, title: string, role?: string) =>
  v.screen.find((item) => item.id === named(v, title, role))?.value ?? "";
/** A number as a sheet or a person writes it: "$1,240.00" is 1240. */
const amountOf = (text: string | undefined) =>
  Number((text ?? "").replace(/[$,\s]/g, "")) || 0;
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item) => b.includes(item));

// A form of twelve fields on three pages, sent, and its reference typed back.
const leaseWanted: Record<string, string> = {
  first: "Ada",
  last: "Brook",
  email: "ada@example.com",
  phone: "+1 415 555 0100",
  street: "12 Harbor Road",
  city: "Lisbon",
  postcode: "1100-148",
  movein: "1 March 2027",
  occupants: "2 people",
  pets: "A cat",
  contact: "Mornings",
};
/** The three pages, their review and the send, with the contact time that is given. */
const fillLease = (contact: string): Step[] => [
  ...fill("First name", "Ada"),
  ...fill("Last name", "Brook"),
  ...fill("Email", "ada@example.com"),
  ...fill("Phone", "+1 415 555 0100"),
  clickNamed("Next"),
  ...fill("Street", "12 Harbor Road"),
  ...fill("City", "Lisbon"),
  ...fill("Postcode", "1100-148"),
  ...fill("Move-in date", "1 March 2027"),
  clickNamed("Next"),
  ...pick("Occupants", "2 people"),
  ...pick("Pets", "A cat"),
  ...pick("Contact time", contact),
  ...fill("Note to the landlord", "We are quiet tenants."),
  clickNamed("Review"),
  clickNamed("Send application"),
];
/** The reference that the screen shows, as the planner reads it. */
const shownLease = (v: ScriptView) => {
  const reference = /Your reference is (HA-\d+)/.exec(v.ask.brief)?.[1];
  if (!reference) throw new Error("the screen shows no reference");
  return reference;
};
const confirmLease: Step[] = [
  clickNamed("Reference"),
  (v) => act.type(shownLease(v)),
  clickNamed("Confirm"),
  (v) =>
    /Confirmed\. Application HA-\d+ is complete/.test(v.ask.brief)
      ? act.done(
          `The application is sent and confirmed. Its reference is ${shownLease(v)}.`,
        )
      : act.giveUp("The screen does not confirm the application."),
];
const tellLease: Step = (v) =>
  act.done(`The application is sent. Its reference is ${shownLease(v)}.`);

// Prices of four products in one app, and the cheapest added to a list in another.
const kettles = [
  "Brightwave K2 kettle",
  "Stonepad Steel kettle",
  "Cobalt One kettle",
  "Riverstone Mini kettle",
];
/** One fact for each product: "Cobalt One kettle: 31.00 plus 3.50 delivery, 34.50 in all". */
const priceFact = (v: ScriptView, name: string) => {
  const text = titlesOf(v).join("\n");
  const price = /^Price \$(\d+\.\d\d)$/m.exec(text)?.[1];
  const fee = /^Free delivery$/m.test(text)
    ? "0.00"
    : /^Delivery \$(\d+\.\d\d)$/m.exec(text)?.[1];
  if (!price || !fee)
    throw new Error(`the screen shows no price or delivery of ${name}`);
  const total = (Number(price) + Number(fee)).toFixed(2);
  return `${name}: ${price} plus ${fee} delivery, ${total} in all`;
};
/** A search for one product, its page and its Delivery tab, a fact of its prices, and back. */
const lookUp = (name: string): Step[] => [
  clickNamed("Search"),
  () => act.key("cmd+a"),
  () => act.type(name),
  clickNamed(name, "AXLink"),
  clickNamed("Delivery", "AXRadioButton"),
  keep((v) => [priceFact(v, name)]),
  clickNamed("Back to results"),
];
/** The product of the kept facts with the lowest price, with delivery or without it. */
const cheapestKept = (v: ScriptView, withDelivery: boolean) => {
  const found = keptFacts(v)
    .map((fact) =>
      /^(.*): (\d+\.\d\d) plus (\d+\.\d\d) delivery, (\d+\.\d\d) in all$/.exec(
        fact,
      ),
    )
    .filter((match) => match !== null)
    .map((match) => ({
      name: match[1]!,
      price: withDelivery ? match[4]! : match[2]!,
    }))
    .sort((a, b) => Number(a.price) - Number(b.price));
  if (!found[0]) throw new Error("the plan kept no prices");
  return found[0];
};
const addCheapest = (withDelivery: boolean): Step[] => [
  openApp("Lists"),
  clickNamed("Kitchen"),
  clickNamed("New item"),
  (v) => act.type(cheapestKept(v, withDelivery).name, named(v, "Item")),
  (v) =>
    act.type(
      `${cheapestKept(v, withDelivery).price} with delivery`,
      named(v, "Note"),
    ),
  clickNamed("Add"),
  (v) =>
    act.done(
      `The ${cheapestKept(v, withDelivery).name} costs least with delivery, ${cheapestKept(v, withDelivery).price}. It is on your Kitchen list now.`,
    ),
];

// Ten rows of one sheet into another, and their total.
const november = receiptRows.filter((row) => row[0]!.endsWith("Nov"));
const novemberTotal = november
  .reduce((sum, row) => sum + Number(row[2]), 0)
  .toFixed(2);
/** The receipts of November that the screen of Receipts shows, as two facts of five: "Paper Mill 12.40; Ink House 31.00; ...". */
const receiptFacts = (v: ScriptView) => {
  const titles = titlesOf(v);
  const rows: string[] = [];
  titles.forEach((title, at) => {
    if (/^\d+ Nov$/.test(title))
      rows.push(`${titles[at + 1]} ${titles[at + 2]}`);
  });
  if (rows.length !== 10)
    throw new Error(`the screen shows ${rows.length} receipts of November`);
  return [rows.slice(0, 5).join("; "), rows.slice(5).join("; ")];
};
/** The rows that the plan kept, in their order. */
const keptRows = (v: ScriptView) =>
  keptFacts(v)
    .flatMap((fact) => fact.split("; "))
    .map((row) => /^(.*) (\d+\.\d\d)$/.exec(row))
    .filter((match) => match !== null)
    .map((match) => ({ shop: match[1]!, amount: match[2]! }));
/** Each kept row typed into the sheet from the selected cell down: the shop, Tab, the amount, Return. One row can be left out. */
const typeRows = (leaveOut?: number): Step[] =>
  november
    .map((_, at) => at)
    .filter((at) => at !== leaveOut)
    .flatMap((at): Step[] => [
      (v) => act.type(keptRows(v)[at]!.shop),
      () => act.key("tab"),
      (v) => act.type(keptRows(v)[at]!.amount),
      () => act.key("return"),
    ]);
const totalRow = (formula: string): Step[] => [
  () => act.type("Total"),
  () => act.key("tab"),
  () => act.type(formula),
  () => act.key("return"),
];
/** Done with the total that the sheet shows in B12. */
const tellTotal: Step = (v) =>
  act.done(
    `The ten receipts are in the sheet. Their total is ${valueOf(v, "B12", "AXCell")}.`,
  );

// Five messages read and flagged, and a note that sums them up.
const offsite = [
  "Offsite: sign-up",
  "Offsite: the bus",
  "Offsite: budget",
  "Offsite: new date",
  "Offsite: the venue",
];
/** The main point of the open message: the part that Show the rest opens, the line after its first one. */
const restOf = (v: ScriptView) => {
  const titles = titlesOf(v);
  const from = titles.findIndex((title) => title.startsWith("From "));
  const rest = from >= 0 ? titles[from + 2] : undefined;
  if (!rest || rest === "Show the rest" || rest === "Flag")
    throw new Error("the screen shows no rest of the message");
  return rest;
};
/** Opens one message and the rest of it, keeps its main point, flags it. Without the rest it only flags it. */
const readMessage = (subject: string, rest = true): Step[] => [
  clickNamed(subject),
  ...(rest
    ? [clickNamed("Show the rest"), keep((v) => [`${subject}: ${restOf(v)}`])]
    : []),
  clickNamed("Flag"),
];
/** A new note named Offsite summary, with one line for each line that is given. */
const writeSummary = (lines: (v: ScriptView) => string[]): Step[] => [
  openApp("Notes"),
  clickNamed("New note"),
  () => act.type("Offsite summary"),
  () => act.key("return"),
  ...[0, 1, 2, 3, 4].flatMap((at): Step[] => [
    (v) => {
      const line = lines(v)[at];
      return line === undefined ? "next" : act.type(line);
    },
    () => act.key("return"),
  ]),
  doneStep("The note Offsite summary sums up the five messages."),
];

// A way that failed early: the New note button never works, Command-N does.
const designers = people.filter((person) => person[1] === "Design");
/** The people of the Design team that the directory shows: "Ada Brook 4021; Lena Ortiz 4022; ...". */
const designFact = (v: ScriptView) => {
  const titles = titlesOf(v);
  const found: string[] = [];
  titles.forEach((title, at) => {
    if (title === "Design") found.push(`${titles[at - 1]} ${titles[at + 1]}`);
  });
  if (found.length !== 7)
    throw new Error(`the screen shows ${found.length} people of Design`);
  return [`Design team: ${found.join("; ")}`];
};
const keptDesigners = (v: ScriptView) =>
  (
    keptFacts(v)
      .find((fact) => fact.startsWith("Design team: "))
      ?.slice("Design team: ".length)
      .split("; ") ?? []
  ).map((person) => {
    const [, name, extension] = /^(.*) (\d+)$/.exec(person) ?? [];
    return { name: name!, extension: extension! };
  });
/** One new note for one person: a new note, the name, Return, the extension. With `button` the New note button comes first, every time. */
const noteFor = (at: number, button = false): Step[] => [
  ...(button ? [clickNamed("New note")] : []),
  () => act.key("cmd+n"),
  (v) => act.type(keptDesigners(v)[at]!.name),
  () => act.key("return"),
  (v) => act.type(`Extension ${keptDesigners(v)[at]!.extension}`),
];

// A sign-in in the middle: the session ends after the third save.
const fjord = bookInvoices
  .filter((row) => row[1] === "Fjord Logistics")
  .map((row) => row[0]!);
const toFreight = (number: string): Step[] => [
  (v) => act.click(inRow(v, number, "Edit")),
  ...pick("Category", "Freight"),
  clickNamed("Save"),
];
/** The person gives their email when asked for it, and types the password into the field when asked for that. */
const signsInAgain: Person = async (question, page) => {
  const field = page.locator("#password");
  const typed =
    /password/i.test(question) &&
    (await field.isVisible()) &&
    !(await field.inputValue());
  if (typed) {
    await field.click();
    await page.keyboard.type("a-test-password");
  }
  if (/e-?mail/i.test(question))
    return typed
      ? "I typed the password. My email is ada@example.com."
      : "ada@example.com";
  return "yes";
};
/** The email that the person gave, as the planner reads it in its brief. */
const answeredEmail = (v: ScriptView) => {
  const email = /the person answered: ([^\s()]+@[^\s()]+)/.exec(
    v.ask.brief,
  )?.[1];
  if (!email) throw new Error("the answer did not reach the planner");
  return email;
};
const askEmail: Step = () =>
  act.ask(
    "Ledger ended the session and asks to sign in again. What is your Ledger email address?",
  );

// A list that another person changes halfway: three people more, and another order.
const weekend = [
  "Ada Brook",
  "Ivy Laurent",
  "Lena Ortiz",
  "Mia Chen",
  "Noah Grant",
  "Omar Diaz",
  "Sam Reed",
  "Theo Park",
];
const toWeekend = (name: string): Step[] => [
  clickNamed(name),
  ...pick("Shift", "Weekend"),
  clickNamed("Save"),
];
/** The same steps, but by the place where the person was in the first list: after the change another person is there. */
const toWeekendByPlace = (name: string): Step[] => [
  clickAtIn(`#list .person:nth-child(${rotaPeople.indexOf(name) + 1})`),
  ...pick("Shift", "Weekend"),
  clickNamed("Save"),
];

const requests: Request[] = [
  {
    id: "open a note and read it",
    held: true,
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
    held: true,
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
    held: true,
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
    held: true,
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
    held: true,
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
    held: true,
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
    held: true,
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
    held: true,
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
    goal: "Fill in the trip request: the name Ada Brook on the first page, the date 12 March on the second, a window seat on the third. Then send it and tell me its reference.",
    person: yes,
    done: (state, said, final) =>
      state.sent === true &&
      state.name === "Ada Brook" &&
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
  // Long requests: 30 to 60 steps. Most are held.
  {
    id: "long: a lease form of twelve fields on three pages, sent, and its reference confirmed",
    app: "lease",
    goal: "In Homes, fill in the lease application. Page 1: first name Ada, last name Brook, email ada@example.com, phone +1 415 555 0100. Page 2: street 12 Harbor Road, city Lisbon, postcode 1100-148, move-in date 1 March 2027. Page 3: 2 people, a cat, contact time mornings, and the note to the landlord 'We are quiet tenants.' Check it and send it. Then type its reference into the confirm field, confirm it, and tell me the reference.",
    person: yes,
    subgoals: [
      "Fill in page 1 and go on.",
      "Fill in page 2 and go on.",
      "Fill in page 3 and check the review.",
      "Send the application.",
      "Type the reference back, confirm it and say it.",
    ],
    limit: longLimit(48),
    done: (state, said, final) =>
      Object.entries(leaseWanted).every(
        ([key, value]) =>
          String(state[key]).trim().toLowerCase() === value.toLowerCase(),
      ) &&
      /we are quiet tenants/i.test(String(state.note)) &&
      state.sent === true &&
      state.confirmed === true &&
      final === "completed" &&
      /HA-48213/.test(said),
    paths: [
      ideal([...fillLease("Mornings"), ...confirmLease]),
      wrong("the evening contact time", [
        ...fillLease("Evenings"),
        ...confirmLease,
      ]),
      wrong("tells the reference and never confirms it", [
        ...fillLease("Mornings"),
        tellLease,
      ]),
    ],
  },
  {
    id: "long: four product pages compared, and the cheapest added to a list in another app",
    desk: ["market", "lists"],
    goal: "In Market, compare the price with delivery of these four kettles: Brightwave K2 kettle, Stonepad Steel kettle, Cobalt One kettle and Riverstone Mini kettle. Add the one that costs least with delivery to my Kitchen list in the Lists app, with its price with delivery as the note. Then tell me which one it is.",
    subgoals: [
      ...kettles.map((name) => `Find the price with delivery of the ${name}.`),
      "Add the cheapest to the Kitchen list in Lists, and say which one.",
    ],
    limit: longLimit(48),
    done: (state, said) => {
      const held = (
        state.lists as {
          lists: Record<string, { name: string; note: string }[]>;
        }
      ).lists;
      const added = held.Kitchen?.[1];
      return (
        held.Kitchen?.length === 2 &&
        /cobalt one/i.test(added?.name ?? "") &&
        /34[.,]50/.test(`${added?.name} ${added?.note}`) &&
        held.Garden?.length === 1 &&
        held.Gifts?.length === 1 &&
        /cobalt one/i.test(said)
      );
    },
    paths: [
      ideal([...kettles.flatMap(lookUp), ...addCheapest(true)]),
      wrong("the lowest price without delivery", [
        ...kettles.flatMap(lookUp),
        ...addCheapest(false),
      ]),
      wrong("three of the four", [
        ...kettles.filter((name) => !/Cobalt/.test(name)).flatMap(lookUp),
        ...addCheapest(true),
      ]),
    ],
  },
  {
    id: "long: ten rows copied from one sheet into another, and their total",
    held: true,
    desk: ["receipts", "sheets"],
    goal: "Copy the ten receipts of November from the Receipts app into the sheet Expenses November in Sheets, one receipt per row from row 2 down, in the order of the list: the shop in column A, the amount in column B. Then write Total in A12 and the total of the ten amounts in B12, and tell me the total.",
    subgoals: [
      "Read the ten receipts of November in Receipts.",
      "Type the first five rows into the sheet from row 2.",
      "Type the last five rows.",
      "Write the total in row 12 and say it.",
    ],
    limit: longLimit(70),
    done: (state, said) => {
      const values = (state.sheets as { values: Record<string, string> })
        .values;
      const allowed = new Set(["A1", "B1"]);
      for (let row = 2; row <= 12; row++) {
        allowed.add(`A${row}`);
        allowed.add(`B${row}`);
      }
      return (
        november.every(
          ([, shop, amount], at) =>
            (values[`A${at + 2}`] ?? "").trim().toLowerCase() ===
              shop!.toLowerCase() &&
            Math.abs(amountOf(values[`B${at + 2}`]) - Number(amount)) < 0.005,
        ) &&
        /^total$/i.test((values.A12 ?? "").trim()) &&
        Math.abs(amountOf(values.B12) - Number(novemberTotal)) < 0.005 &&
        Object.keys(values).every((address) => allowed.has(address)) &&
        said.includes(novemberTotal)
      );
    },
    paths: [
      ideal([
        keep(receiptFacts),
        openApp("Sheets"),
        clickNamed("A2", "AXCell"),
        ...typeRows(),
        ...totalRow("=SUM(B2:B11)"),
        tellTotal,
      ]),
      wrong("a row left out", [
        keep(receiptFacts),
        openApp("Sheets"),
        clickNamed("A2", "AXCell"),
        ...typeRows(5),
        ...totalRow("=SUM(B2:B11)"),
        tellTotal,
      ]),
      wrong("the total of nine rows", [
        keep(receiptFacts),
        openApp("Sheets"),
        clickNamed("A2", "AXCell"),
        ...typeRows(),
        ...totalRow("=SUM(B2:B10)"),
        tellTotal,
      ]),
    ],
  },
  {
    id: "long: five messages read and flagged, and a summary note drafted",
    held: true,
    desk: ["mailbox", "notes"],
    goal: "Read the five messages about the offsite in Mailbox, and flag each of them. Then make a new note in Notes named Offsite summary, with one short line for each message that gives its main point.",
    subgoals: [
      "Read and flag the first two offsite messages.",
      "Read and flag the other three.",
      "Make the note Offsite summary in Notes.",
      "Write one line for each message.",
    ],
    limit: longLimit(48),
    done: (state) => {
      const notes = (state.notes as NotesState).notes;
      const summary = notes.filter((note) =>
        /^offsite summary/i.test(note.name.trim()),
      );
      return (
        notes.length === 16 &&
        summary.length === 1 &&
        [/Hall B/i, /14 May/i, /900/, /8[:.]15/, /2 May/i].every((point) =>
          point.test(summary[0]!.text),
        ) &&
        notes.filter((note) => /Hall B/i.test(note.text)).length === 1 &&
        sameSet((state.mailbox as { flagged: string[] }).flagged, offsite)
      );
    },
    paths: [
      ideal([
        ...offsite.flatMap((subject) => readMessage(subject)),
        ...writeSummary((v) =>
          keptFacts(v).filter((fact) => fact.startsWith("Offsite")),
        ),
      ]),
      wrong("lines from the subjects alone", [
        ...offsite.flatMap((subject) => readMessage(subject, false)),
        ...writeSummary(() =>
          offsite.map((subject) => subject.replace("Offsite: ", "")),
        ),
      ]),
      wrong("a message left out", [
        ...offsite
          .filter((subject) => subject !== "Offsite: the bus")
          .flatMap((subject) => readMessage(subject)),
        ...writeSummary((v) =>
          keptFacts(v).filter((fact) => fact.startsWith("Offsite")),
        ),
      ]),
    ],
  },
  {
    id: "long: a way that failed early is not tried again, seven notes later",
    held: true,
    desk: ["directory", "notes"],
    goal: "In Directory, find the seven people of the Design team. Then in Notes, make one new note for each of them: the first line is the name, the second line is the word Extension and their number, for example Extension 4021.",
    // The New note button never works. Command-N does. A way that did not work stays in the list of failed ways.
    faults: { hands: { deaf: { selector: "#new", times: 1000 } } },
    subgoals: [
      "Read the people of the Design team in Directory.",
      "Make the notes of the first three people in Notes.",
      "Make the notes of the other four.",
    ],
    limit: longLimit(48),
    done: (state, _said, _final, talk) => {
      const notes = (state.notes as NotesState).notes;
      return (
        notes.length === 22 &&
        designers.every(([name, , extension]) => {
          const mine = notes.filter((note) => note.name.trim() === name);
          return (
            mine.length === 1 &&
            new RegExp(
              `^${name}\\s*\\n\\s*extension:?\\s*${extension}$`,
              "i",
            ).test(mine[0]!.text.trim())
          );
        }) &&
        // The button may be tried twice in a row, never again later.
        talk.faults.filter((fault) => fault === "a click was not taken")
          .length <= 2
      );
    },
    paths: [
      ideal([
        keep(designFact),
        openApp("Notes"),
        // The button does nothing: the screen shows no new note. Command-N does what it should.
        clickNamed("New note"),
        ...designers.flatMap((_, at) => noteFor(at)),
        doneStep("Each of the seven people has a note with their extension."),
      ]),
      wrong("tries the button again before every note", [
        keep(designFact),
        openApp("Notes"),
        ...designers.flatMap((_, at) => noteFor(at, true)),
        doneStep("Each of the seven people has a note with their extension."),
      ]),
      wrong("everything into the open note", [
        keep(designFact),
        openApp("Notes"),
        clickIn("#editor"),
        (v) =>
          act.type(
            keptDesigners(v)
              .map((person) => `${person.name}\nExtension ${person.extension}`)
              .join("\n"),
          ),
        doneStep("Each of the seven people has a note with their extension."),
      ]),
    ],
  },
  {
    id: "long: a sign-in in the middle, where the owner types the password",
    held: true,
    app: "books",
    goal: "In Ledger, change the category of every invoice of Fjord Logistics to Freight, and save each one. Then tell me how many you changed.",
    person: signsInAgain,
    subgoals: [
      "Change the first invoices of Fjord Logistics to Freight.",
      "Change the rest of them.",
      "Say how many were changed.",
    ],
    limit: longLimit(50),
    // The password in the app is the one that the person typed: the planner left it to them.
    done: (state, said, final) => {
      const held = state as {
        categories: Record<string, string>;
        signIns: number;
        email: string;
        password: string;
      };
      return (
        bookInvoices.every(
          ([number, customer, , category]) =>
            held.categories[number!] ===
            (customer === "Fjord Logistics" ? "Freight" : category),
        ) &&
        held.signIns === 1 &&
        held.email === "ada@example.com" &&
        held.password === "a-test-password" &&
        /\b(?:7|seven)\b/i.test(said) &&
        final === "completed"
      );
    },
    paths: [
      ideal([
        ...fjord.slice(0, 3).flatMap(toFreight),
        askEmail,
        (v) => act.type(answeredEmail(v), named(v, "Email")),
        askPassword,
        clickNamed("Sign in", "AXButton"),
        ...fjord.slice(3).flatMap(toFreight),
        doneStep("I changed 7 invoices of Fjord Logistics to Freight."),
      ]),
      wrong("gives up at the sign-in", [
        ...fjord.slice(0, 3).flatMap(toFreight),
        () => act.giveUp("Ledger asks me to sign in, and I cannot do that."),
      ]),
      wrong("says done at the sign-in", [
        ...fjord.slice(0, 3).flatMap(toFreight),
        doneStep("I changed 7 invoices of Fjord Logistics to Freight."),
      ]),
      // The worker never types into a password field: it hands the field to the person.
      ideal(
        [
          ...fjord.slice(0, 3).flatMap(toFreight),
          askEmail,
          (v) => act.type(answeredEmail(v), named(v, "Email")),
          (v) => act.type("guessed-pass-1", named(v, "Password")),
          clickNamed("Sign in", "AXButton"),
          ...fjord.slice(3).flatMap(toFreight),
          doneStep("I changed 7 invoices of Fjord Logistics to Freight."),
        ],
        "tries to type the password, and the person types it",
      ),
    ],
  },
  {
    id: "long: a list that another person changes halfway",
    held: true,
    app: "rota",
    goal: "In Rota, give these eight people the Weekend shift, and save each one: Ada Brook, Ivy Laurent, Lena Ortiz, Mia Chen, Noah Grant, Omar Diaz, Sam Reed and Theo Park.",
    // After the fourth save another person adds three people and sorts the list by last name, between two looks.
    faults: {
      hands: {
        change: {
          when: "window.state().saves >= 4",
          run: "window.sync()",
          label: "the list changed after the fourth save",
        },
      },
    },
    subgoals: [
      "Give the first four people the Weekend shift.",
      "Give the other four the Weekend shift.",
      "Check the list and say it is done.",
    ],
    limit: longLimit(50),
    done: (state) => {
      const held = state as {
        shifts: Record<string, string>;
        synced: boolean;
        changes: string[];
      };
      return (
        held.synced &&
        Object.keys(held.shifts).length ===
          rotaPeople.length + rotaNewcomers.length &&
        Object.entries(held.shifts).every(
          ([name, shift]) =>
            shift === (weekend.includes(name) ? "Weekend" : "Weekday"),
        ) &&
        held.changes.every((name) => weekend.includes(name))
      );
    },
    paths: [
      ideal([
        ...weekend.flatMap(toWeekend),
        doneStep("The eight people have the Weekend shift now."),
      ]),
      wrong("waits, then goes on by the places of the first list", [
        ...weekend.slice(0, 4).flatMap(toWeekend),
        () => act.wait(500),
        ...weekend.slice(4).flatMap(toWeekendByPlace),
        doneStep("The eight people have the Weekend shift now."),
      ]),
    ],
  },
];

// Each argument is provider/model, or a bare model of OpenAI, with "@effort"
// for a reasoning effort: an effort of Anthropic is a setting of its
// request, any other goes into the body on its way out (`withEvalRequest`).
const efforts = new Map<string, string>();
const planners = new Map<string, PlannerOptions>(
  checking || comparing
    ? []
    : (flags.models.length ? flags.models : [null]).map((word) => {
        const [model, effort, ...rest] = (word ?? "").split("@");
        if (
          rest.length ||
          (word !== null && !model) ||
          (effort !== undefined && !/^[a-z]+$/.test(effort))
        )
          throw new Error(
            `Use provider/model, with @effort for a reasoning effort. Got: ${word}`,
          );
        const chosen = keyFor(model || null);
        const label = word ?? chosen.name;
        if (effort === undefined) return [label, chosen.options];
        if (chosen.options.provider !== "anthropic") {
          efforts.set(label, effort);
          return [label, chosen.options];
        }
        if (!["low", "medium", "high"].includes(effort))
          throw new Error(
            `Anthropic takes @low, @medium or @high. Got: ${word}`,
          );
        return [
          label,
          { ...chosen.options, effort: effort as "low" | "medium" | "high" },
        ];
      }),
);
const models = [...planners.keys()];
const repeats = repeatsOf(flags, process.env, 1);
const only = flags.only ?? process.env.ONLY;
const chosen = requests.filter(
  (request) =>
    (withNew || !request.newActions) &&
    inSplit(request.held === true, flags.split) &&
    (!only || request.id.includes(only)),
);
const heldCount = chosen.filter((request) => request.held).length;
const splitText = `split ${flags.split}: ${chosen.length - heldCount} dev, ${heldCount} held`;
/** The runs of each request in the order of the requests, as the result lists them. */
const inOrder = (runs: CaseRun[]) => {
  const order = new Map(chosen.map((request, index) => [request.id, index]));
  return runs.sort(
    (a, b) =>
      models.indexOf(a.model) - models.indexOf(b.model) ||
      order.get(a.name)! - order.get(b.name)! ||
      a.run - b.run,
  );
};
const isHeld = (id: string) =>
  chosen.find((request) => request.id === id)?.held === true;

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
  /** The step limit of the request, when it has one of its own. */
  limit?: number;
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
// Launched only when the eval runs: --compare reads files and needs no browser.
let browser: Browser;

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
    /** What the apps hold: the one app, or each app of the desk by its key. */
    let holds: () => Promise<Record<string, unknown>>;
    if (request.tabs) {
      await serveSites(context, sites);
      const tabs = new EvalBrowser(context);
      await tabs.start(request.tabs.urls, request.tabs.active ?? 0);
      port = tabs;
      desk = {
        page: () => tabs.active,
        app: async () => ({ ...browserApp, window: await tabs.active.title() }),
      };
      holds = () => tabs.state();
    } else if (request.desk) {
      // One page for each app. The first is in front, open_app brings another one forward.
      const shown = await Promise.all(
        request.desk.map(async (key) => {
          const page = await context.newPage();
          await page.setContent(apps[key].html);
          return { key, app: apps[key].app, page };
        }),
      );
      let front = 0;
      desk = {
        page: () => shown[front]!.page,
        app: async () => shown[front]!.app,
        open: async (name) => {
          const at = shown.findIndex(
            (item) => item.app.name.toLowerCase() === name.trim().toLowerCase(),
          );
          if (at < 0) return false;
          front = at;
          await shown[at]!.page.bringToFront();
          return true;
        },
      };
      holds = async () =>
        Object.fromEntries(
          await Promise.all(
            shown.map(async (item) => [
              item.key,
              await item.page.evaluate("window.state()"),
            ]),
          ),
        );
    } else {
      const app = apps[request.app!];
      const page = await context.newPage();
      await page.setContent(app.html);
      desk = { page: () => page, app: async () => app.app };
      holds = async () =>
        (await page.evaluate("window.state()")) as Record<string, unknown>;
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
        script
          ? scriptedModel(script.choose, request.subgoals)
          : withEvalRequest(fetch, {
              effort:
                "model" in chooser ? efforts.get(chooser.model) : undefined,
            }),
        request.faults?.model ?? [],
        applied,
      ),
      ...(port ? { browser: true, browserMethods: browserMethods(port) } : {}),
    });
    const said: string[] = [];
    const timed: StepTiming[] = [];
    const limit = request.limit;
    const worker = new ComputerWorker({
      unchangedDone: true,
      failedWays: true,
      hands,
      planner,
      journal,
      ...(port ? { browser: port } : {}),
      notify: (text) => said.push(text),
      timing: (entry) => timed.push(entry),
      // A long request has its own limits, under those of the service.
      ...(limit
        ? {
            maxSteps: Math.min(limit.steps, serviceLimits.steps),
            plannedMaxSteps: Math.min(limit.steps, serviceLimits.plannedSteps),
          }
        : {}),
      maxMs: script
        ? limit
          ? 180_000
          : 60_000
        : limit
          ? limit.minutes * 60_000
          : 180_000,
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
    const state = await holds();
    const sum = (pick: (entry: StepTiming) => number) =>
      Math.round(timed.reduce((total, entry) => total + pick(entry), 0));
    const trouble = script?.trouble();
    return {
      model: "model" in chooser ? chooser.model : "check",
      request: request.id,
      ...("path" in chooser ? { path: chooser.path.name } : {}),
      run,
      done: request.done(state, last, final, { asked, faults: applied }),
      state: final,
      reason: record?.reason ?? "",
      // An entry of the kind end says what the worker did after the last step: no step of its own.
      steps: timed.filter((entry) => entry.kind !== "end").length,
      ...(limit ? { limit: limit.steps } : {}),
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
              : command.kind === "open_app"
                ? `open_app ${JSON.stringify(command.name.slice(0, 40))}`
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

/** The steps of a request, with its own limit when it has one: "32 of 48 steps". */
const stepsText = (row: Row) =>
  row.limit === undefined
    ? `${row.steps} steps`
    : `${row.steps} of ${row.limit} steps`;
/** The least and the most of some numbers, with the median: "31 to 52, median 40". */
const spread = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted[Math.floor((sorted.length - 1) / 2)]!;
  return sorted.length === 1
    ? `${sorted[0]}`
    : `${sorted[0]} to ${sorted.at(-1)}, median ${middle}`;
};

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
  ...(request.limit ? { limit: request.limit.steps } : {}),
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
  const runNumbers = Array.from({ length: repeats }, (_, index) => index + 1);
  const jobs = runNumbers.flatMap((run) =>
    chosen.flatMap((request) =>
      request.paths.map((path) => ({ request, path, run })),
    ),
  );
  const done = await pool(jobs, 6, async ({ request, path, run }) => {
    const lack = missing(path.needs, offered);
    if (lack.length) return { request, path, run, lack, row: null };
    const row = await one(request, run, { path }).catch((error) =>
      faultRow("check", request, run, error, path),
    );
    return { request, path, run, lack, row };
  });
  /** What the paths of one request in one run say: an ideal path must be done, a wrong one must not. */
  const verdict = (mine: typeof done) => {
    const problems: string[] = [];
    const notes: string[] = [];
    const lack = new Set<NewKind>();
    let proven = 0;
    let refused = 0;
    let wrongRan = 0;
    let skipped = 0;
    for (const { path, lack: needs, row } of mine) {
      if (!row) {
        skipped += 1;
        for (const kind of needs) lack.add(kind);
        notes.push(`"${path.name}" skipped: needs ${needs.join(", ")}`);
        continue;
      }
      const end = `${row.state}${row.reason && row.state !== "completed" ? `: ${row.reason}` : ""}`;
      if (path.ideal) {
        if (row.done) {
          proven += 1;
          notes.push(
            `"${path.name}" done in ${stepsText(row)}, ${row.seconds} s${row.faults.length ? `, through ${[...new Set(row.faults)].join(", ")}` : ""}`,
          );
        } else
          problems.push(
            `ideal "${path.name}" was not done (${end})${row.trouble ? `, script ${row.trouble}` : ""}${row.said ? `: ${row.said}` : ""}`,
          );
      } else {
        wrongRan += 1;
        if (row.done)
          problems.push(
            `wrong "${path.name}" was taken as done (${end}, ${stepsText(row)})`,
          );
        else refused += 1;
      }
    }
    if (wrongRan) notes.push(`${refused} of ${wrongRan} wrong paths not done`);
    const seconds = mine.reduce((sum, { row }) => sum + (row?.seconds ?? 0), 0);
    return { problems, notes, lack, proven, skipped, seconds };
  };
  let failed = 0;
  let skippedPaths = 0;
  let unproven = 0;
  const lacking = new Set<NewKind>();
  const runs: CaseRun[] = [];
  for (const request of chosen) {
    const each = runNumbers.map((run) =>
      verdict(
        done.filter(
          (result) => result.request === request && result.run === run,
        ),
      ),
    );
    for (const [index, item] of each.entries())
      runs.push({
        model: "check",
        name: request.id,
        held: request.held === true,
        run: index + 1,
        pass: !item.problems.length,
        ms: Math.round(item.seconds * 1000),
      });
    const first = each[0]!;
    const clean = each.filter((item) => !item.problems.length).length;
    // A path that this build cannot play is skipped in every run: count it once.
    skippedPaths += first.skipped;
    for (const item of each) for (const kind of item.lack) lacking.add(kind);
    // A check gives the same verdict in every run, or it fails.
    const problems =
      clean > 0 && clean < each.length
        ? [`ok in ${clean} of ${each.length} runs`]
        : first.problems;
    if (problems.length) failed += 1;
    else if (!first.proven) unproven += 1;
    const mark = problems.length ? "FAIL" : first.proven ? "ok  " : "skip";
    console.log(
      `${mark} ${request.id}: ${[...problems, ...first.notes].join("; ")}${repeats > 1 ? ` (${clean} of ${each.length} runs)` : ""}`,
    );
  }
  console.log(
    `\n${chosen.length} requests (${splitText}), ${repeats} ${repeats === 1 ? "run" : "runs"} of each: ${chosen.length - failed - unproven} ok, ${failed} failed, ${unproven} with no ideal path run. ${skippedPaths} of ${jobs.length / repeats} paths skipped${lacking.size ? `: this build does not offer ${[...lacking].join(", ")}` : ""}.`,
  );
  if (outFile) {
    writeResults(
      outFile,
      toResults(
        "request",
        { check: true, split: flags.split, repeats },
        inOrder(runs),
        done.flatMap((result) => (result.row ? [result.row] : [])),
      ),
    );
    console.log(`The result of each request is in ${outFile}.`);
  }
  return failed;
}

/** The model mode: every chosen request with each model, as often as --repeat says. */
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
  const out = toResults(
    "request",
    { check: false, split: flags.split, repeats },
    inOrder(
      rows.map((row) => ({
        model: row.model,
        name: row.request,
        held: isHeld(row.request),
        run: row.run,
        pass: row.done,
        // A request that failed inside the test has no time of its own.
        ms: row.state === "fault" ? null : Math.round(row.seconds * 1000),
      })),
    ),
    rows,
  );
  if (outFile) writeResults(outFile, out);
  console.log(
    `${chosen.length} requests (${splitText}), ${repeats} runs of each.`,
  );
  for (const model of models) {
    const mine = rows.filter((row) => row.model === model);
    const total = (pick: (row: Row) => number) =>
      mine.reduce((sum, row) => sum + pick(row), 0);
    console.log(
      `\n${model}: ${mine.filter((row) => row.done).length} of ${mine.length} done | ${total((row) => row.steps)} steps | ${Math.round(total((row) => row.seconds))} s in all | plan ${Math.round(total((row) => row.planMs) / 1000)} s, look ${Math.round(total((row) => row.lookMs) / 1000)} s, act ${Math.round(total((row) => row.actMs) / 1000)} s`,
    );
    console.log(
      "request | run | done | end | steps | inputs | questions | seconds | actions | faults",
    );
    for (const row of mine)
      console.log(
        `${row.request} | ${row.run} | ${row.done ? "yes" : "NO"} | ${row.state}${row.reason && row.state !== "completed" ? ` (${row.reason})` : ""} | ${row.limit === undefined ? row.steps : `${row.steps} of ${row.limit}`} | ${row.inputs} | ${row.questions} | ${row.seconds} | ${row.kinds} | ${[...new Set(row.faults)].join(", ")}`,
      );
    for (const row of mine.filter((item) => !item.done))
      console.log(`  not done: ${row.request}, run ${row.run}: ${row.said}`);
    // The long requests: how far they went, and how long it took.
    const long = mine.filter((row) => row.limit !== undefined);
    if (long.length)
      console.log(
        `  long requests: ${long.filter((row) => row.done).length} of ${long.length} done | steps ${spread(long.map((row) => row.steps))} | seconds ${spread(long.map((row) => row.seconds))} | ${long.filter((row) => row.reason === "step_limit").length} at the step limit, ${long.filter((row) => row.reason === "time_limit").length} at the time limit`,
      );
  }
  printResults(out, { word: "done", cases: true });
  if (outFile) console.log(`\nThe result of each request is in ${outFile}.`);
}

let failed = 0;
if (comparing) compareFiles(comparing, flags.split);
else {
  browser = await chromium.launch({ headless: true });
  try {
    if (checking) failed = await check();
    else await measure();
  } finally {
    await browser.close();
  }
}
if (failed) process.exitCode = 1;
