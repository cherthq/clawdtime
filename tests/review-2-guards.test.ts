import { describe, expect, it } from "vitest";
import {
  check,
  type AskKind,
  type View,
} from "../connectors/computer/guards.js";
import type {
  BrowserElement,
  Observation,
  ScreenElement,
} from "../connectors/computer/ports.js";
import {
  element,
  observation,
  page,
  pageElement,
  terminalApp,
} from "./connectors-computer-fixture.js";

// Review 2: actions that pay, delete for good, send as the owner or grant
// access, and that go out with no yes. Each test is red on 461f812.

const view = (
  seen: Observation | null = observation(),
  values: Partial<View> = {},
): View => ({
  observation: seen,
  page: null,
  fresh: true,
  browser: true,
  ...values,
});
/** The row of the policy that an action asks for. Null: it goes with no yes. */
const asked = (raw: unknown, at: View, why = ""): AskKind | null => {
  const result = check(raw, at, why);
  if (result.verdict !== "run")
    throw new Error(`Expected an action that can run: ${result.verdict}`);
  return result.policy;
};
const text = (title: string): Partial<ScreenElement> => ({
  role: "AXStaticText",
  title,
});
const screen = (items: (string | Partial<ScreenElement>)[]) =>
  observation(
    items.map((item, index) =>
      element(index + 1, typeof item === "string" ? { title: item } : item),
    ),
  );
/** The row that a click on the first element of this screen asks for. */
const clicked = (items: (string | Partial<ScreenElement>)[], goal?: string) =>
  asked(
    { kind: "click_element", element: 1 },
    view(screen(items), goal === undefined ? {} : { goal }),
  );
/** The row that a click on the first element of this page asks for. */
const pageClicked = (
  label: string,
  words: string,
  goal?: string,
  values: Partial<BrowserElement> = {},
  why = "",
) =>
  asked(
    { kind: "browser_click", index: 0 },
    view(null, {
      fresh: false,
      page: page([pageElement(0, { label, ...values })], {
        url: "https://shop.example/checkout",
        text: words,
      }),
      ...(goal === undefined ? {} : { goal }),
    }),
    why,
  );

describe("review 2: a payment with no yes", () => {
  it("asks before Continue on the last step of a checkout that says the card is charged on that click", () => {
    expect(
      clicked([
        "Continue",
        text("Review your order"),
        text("Order total: $48.00"),
        text("Card ending in 4242"),
        text("By clicking Continue, your card will be charged $48.00."),
      ]),
    ).toBe("pay");
  });

  it("asks before a bare Transfer of money, which the policy row names", () => {
    expect(
      clicked([
        "Transfer",
        text("From: Checking"),
        text("To: Savings"),
        text("Amount: $500.00"),
      ]),
    ).toBe("pay");
    expect(
      pageClicked("Transfer", "From Checking to Savings. Amount $500.00"),
    ).toBe("pay");
  });

  it("asks before a buy or a pay in another language", () => {
    for (const name of [
      "Jetzt kaufen",
      "Zahlungspflichtig bestellen",
      "Comprar ahora",
      "Pagar",
      "Payer",
      "Acheter",
    ])
      expect(clicked([name, text("Total: 48,00 EUR")]), name).toBe("pay");
  });

  it("asks before a page button whose label ends with an ellipsis: the page, not macOS, wrote that label", () => {
    expect(pageClicked("Place order…", "Order total $48.00")).toBe("pay");
    expect(pageClicked("Pay now...", "Order total $48.00")).toBe("pay");
    expect(pageClicked("Delete forever…", "Your files")).toBe("loss");
  });
});

describe("review 2: an icon or a point with no name of its own", () => {
  it("reads the planner's own words for an unnamed button, as it does for a point", () => {
    const seen = screen([{ title: "" }]);
    const why = "Click the paper plane icon to send the reply to everyone.";
    // The same point by its coordinates asks: the words of the planner count.
    expect(asked({ kind: "click_at", x: 120, y: 189 }, view(seen), why)).toBe(
      "send",
    );
    // By the number of the element it does not.
    expect(asked({ kind: "click_element", element: 1 }, view(seen), why)).toBe(
      "send",
    );
  });

  it("reads the planner's own words for an unnamed page button", () => {
    expect(
      pageClicked(
        "",
        "Order total $48.00. Card ending in 4242.",
        undefined,
        {},
        "Click the Buy now icon to place the order.",
      ),
    ).toBe("pay");
  });

  it("does not let a large named container under a point hide what the planner says it clicks", () => {
    const seen = observation([
      element(1, {
        role: "AXGroup",
        title: "Checkout",
        x: 0,
        y: 0,
        w: 1440,
        h: 900,
      }),
      element(2, { role: "AXStaticText", title: "Order total: $48.00" }),
    ]);
    expect(
      asked(
        { kind: "click_at", x: 640, y: 400 },
        view(seen),
        "Click Place order to buy the mug.",
      ),
    ).toBe("pay");
  });
});

describe("review 2: a send that the request lifts for more than it asked", () => {
  it("asks before Reply All when the request asks to reply to one person", () => {
    expect(clicked(["Reply All"], "Reply to Sam")).toBe("send");
  });

  it("asks before Send to someone else when the request only asks to be told", () => {
    for (const goal of [
      "Text me when it is done",
      "Message me the total",
      "Answer the question: what is on my screen",
    ])
      expect(clicked(["Send", text("To: Jane")], goal), goal).toBe("send");
  });
});

describe("review 2: a grant with no yes", () => {
  it("asks before Allow on a sign-in consent page that gives an app access to the account", () => {
    expect(
      pageClicked(
        "Allow",
        "ClawdTest wants access to your Google Account. This will allow ClawdTest to read, compose and send emails from your Gmail account.",
      ),
    ).toBe("grant");
    expect(
      pageClicked(
        "Accept",
        "Permissions requested. ClawdTest would like to: Read your mail. Send mail as you.",
      ),
    ).toBe("grant");
  });
});

describe("review 2: words on the screen that lift a guard", () => {
  it("asks before I agree to binding terms also while the page mentions cookies elsewhere", () => {
    expect(
      clicked([
        "I agree",
        text("Terms of Service"),
        text("You agree to binding arbitration and waive class actions."),
        text("This site uses cookies."),
      ]),
    ).toBe("terms");
  });
});

describe("review 2: a terminal command that deletes for good", () => {
  const shell = observation([], { app: terminalApp });
  const goal = "Run the tests";
  const typed = (words: string) =>
    asked({ kind: "type", text: words }, view(shell, { goal }));
  it("asks before a delete by find, by a script or by a move to /dev/null, while the request asks for terminal work", () => {
    for (const command of [
      "find . -name '*.log' -delete",
      "find ~ -delete",
      "python3 -c 'import shutil; shutil.rmtree(\"/Users\")'",
      "mv ~/Documents /dev/null",
    ])
      expect(typed(command), command).toBe("loss");
  });

  it("asks before Return runs a delete that was typed in two parts", () => {
    // rm is caught when it is typed in one piece.
    expect(typed("rm -rf ~")).toBe("loss");
    const parts = [typed("r"), typed("m -rf ~")];
    const enter = asked(
      { kind: "key", combo: "return" },
      view(shell, { goal }),
    );
    // Some step of the three must ask: together they run rm -rf ~.
    expect([...parts, enter].some((row) => row === "loss")).toBe(true);
  });
});
