import { describe, expect, it } from "vitest";
import {
  againstPage,
  askedToClose,
  browserCan,
  browserMethodNames,
  browserMethods,
  check,
  dangerWords,
  parseCombo,
  quietCall,
  readsBeforeCall,
  retarget,
  sameTab,
  type BrowserCall,
  type View,
} from "../connectors/computer/guards.js";
import type {
  BrowserPort,
  BrowserTab,
  Observation,
} from "../connectors/computer/ports.js";
import {
  element,
  observation,
  page,
  pageElement,
  terminalApp,
} from "./connectors-computer-fixture.js";

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
const run = (raw: unknown, at: View = view(), why = "") => {
  const result = check(raw, at, why);
  if (result.verdict !== "run")
    throw new Error(`Expected an action that can run: ${result.verdict}`);
  return result;
};
const refused = (raw: unknown, at: View = view(), why = "") => {
  const result = check(raw, at, why);
  if (result.verdict !== "refuse")
    throw new Error(`Expected a refusal: ${result.verdict}`);
  return result.reason;
};

describe("the shape of an action", () => {
  it("refuses what is not one known action", () => {
    for (const raw of [
      null,
      "click",
      {},
      { kind: "format_disk" },
      { kind: "click_element" },
      { kind: "click_element", element: -1 },
      { kind: "click_element", element: 1.5 },
      { kind: "click_element", element: 1, extra: true },
      { kind: "type", text: 5 },
      { kind: "wait", ms: 60_000 },
      { kind: "scroll", direction: "sideways" },
    ])
      expect(check(raw, view(), "").verdict).toBe("refuse");
  });
});

describe("an element or a point of the last observation", () => {
  const seen = observation([
    element(1, { title: "Save", x: 100, y: 200, w: 80, h: 24 }),
    element(2, { title: "Off", enabled: false }),
    element(3, { title: "Far", x: 5000, y: 200 }),
  ]);
  it("clicks the middle of a named element", () => {
    const result = run({ kind: "click_element", element: 1 }, view(seen));
    expect(result.label).toBe('Click "Save"');
    expect(result.target).toBe("Save");
    expect(result.risk).toBeNull();
    expect(result.send).toEqual({
      via: "hands",
      look: true,
      command: { kind: "click", x: 140, y: 212, button: "left", count: 1 },
    });
    expect(
      run({ kind: "click_element", element: 1, double: true }, view(seen)).send,
    ).toMatchObject({ command: { count: 2 } });
    expect(
      run({ kind: "click_element", element: 1, right: true }, view(seen)).send,
    ).toMatchObject({ command: { button: "right" } });
  });
  it("refuses a number that the last observation does not hold", () => {
    expect(refused({ kind: "click_element", element: 9 }, view(seen))).toMatch(
      /no element 9/,
    );
    expect(
      refused({ kind: "type", text: "a", element: 9 }, view(seen)),
    ).toMatch(/no element 9/);
    expect(
      refused({ kind: "scroll", direction: "down", element: 9 }, view(seen)),
    ).toMatch(/no element 9/);
  });
  it("refuses a disabled element and one that is off the screen", () => {
    expect(refused({ kind: "click_element", element: 2 }, view(seen))).toMatch(
      /disabled/,
    );
    expect(refused({ kind: "click_element", element: 3 }, view(seen))).toMatch(
      /off the screen/,
    );
  });
  it("refuses every screen action with no observation, or with a stale one", () => {
    for (const at of [view(null), view(seen, { fresh: false })])
      for (const raw of [
        { kind: "click_element", element: 1 },
        { kind: "click_at", x: 10, y: 10 },
        { kind: "type", text: "a" },
        { kind: "key", combo: "tab" },
        { kind: "scroll", direction: "down" },
      ])
        expect(refused(raw, at)).toMatch(/no fresh view/);
  });
  it("maps a point of the image to a point of the screen", () => {
    const result = run({ kind: "click_at", x: 640, y: 400 }, view(seen));
    expect(result.send).toMatchObject({
      command: { kind: "click", x: 720, y: 450, button: "left", count: 1 },
    });
    expect(result.label).toBe("Click at a point");
  });
  it("refuses a point outside the last image, and any point with no image", () => {
    for (const [x, y] of [
      [-1, 10],
      [10, -1],
      [1280, 10],
      [10, 800],
      [99_999, 99_999],
    ])
      expect(refused({ kind: "click_at", x, y }, view(seen))).toMatch(
        /outside the last image/,
      );
    const { image, imageWidth, imageHeight, ...bare } = seen;
    expect(refused({ kind: "click_at", x: 10, y: 10 }, view(bare))).toMatch(
      /no image/,
    );
  });
  it("names a point by the element under it", () => {
    // Image point (125, 190) is screen point (140.6, 213.75): inside Save.
    const result = run({ kind: "click_at", x: 125, y: 190 }, view(seen));
    expect(result.label).toBe('Click "Save"');
    expect(result.target).toBe("Save");
  });
});

describe("a secure field", () => {
  const seen = observation([
    element(1, { role: "AXTextField", title: "Name" }),
    element(2, { role: "AXSecureTextField", title: "Password", secure: true }),
  ]);
  it("is never typed into: the person types it", () => {
    expect(
      check({ kind: "type", text: "hunter2", element: 2 }, view(seen), ""),
    ).toMatchObject({ verdict: "person_types", target: "Password" });
  });
  it("is never typed into when it has the focus", () => {
    const focused = observation([
      element(1, { role: "AXTextField", title: "Name" }),
      element(2, {
        role: "AXSecureTextField",
        title: "Password",
        secure: true,
        focused: true,
      }),
    ]);
    expect(
      check({ kind: "type", text: "hunter2" }, view(focused), "").verdict,
    ).toBe("person_types");
    // Typing into another field does not need the secure one.
    expect(
      check({ kind: "type", text: "Ada", element: 1 }, view(focused), "")
        .verdict,
    ).toBe("run");
  });
  it("takes a click, which only gives it the focus", () => {
    expect(run({ kind: "click_element", element: 2 }, view(seen)).risk).toBe(
      null,
    );
  });
  it("types into a plain field after a click on it", () => {
    const result = run({ kind: "type", text: "Ada", element: 1 }, view(seen));
    expect(result.label).toBe('Type in "Name"');
    expect(result.send).toMatchObject({
      via: "hands",
      focus: { kind: "click", button: "left", count: 1 },
      command: { kind: "type", text: "Ada" },
    });
  });
  it("does not click a field again that has the focus, so that a selection stays", () => {
    const focused = observation([
      element(1, { role: "AXTextArea", title: "Note", focused: true }),
    ]);
    const result = run(
      { kind: "type", text: "finished", element: 1 },
      view(focused),
    );
    expect(result.label).toBe('Type in "Note"');
    expect(result.send).toEqual({
      via: "hands",
      look: true,
      command: { kind: "type", text: "finished" },
    });
  });
  it("quits an app by its name, and always asks first", () => {
    const quit = run({ kind: "quit_app", name: " TextEdit " }, view(seen));
    expect(quit.label).toBe("Quit TextEdit");
    expect(quit.risk).toMatch(/quits the app.*not saved can be lost/);
    expect(quit.send).toEqual({
      via: "hands",
      look: false,
      command: { kind: "quit_app", name: "TextEdit" },
    });
    // It needs no window and no look at the screen: it also runs when the screen could not be read.
    expect(
      check({ kind: "quit_app", name: "TextEdit" }, view(null), "").verdict,
    ).toBe("run");
    for (const name of ["", "  ", ".hidden", "a/b", "a:b", "a\\b"])
      expect(refused({ kind: "quit_app", name }, view(seen))).toMatch(
        /plain name of an app/,
      );
  });
  it("refuses text with a line break or another control character", () => {
    expect(refused({ kind: "type", text: "ls\n" }, view(seen))).toMatch(
      /one line/,
    );
    expect(refused({ kind: "type", text: "a\tb" }, view(seen))).toMatch(
      /one line/,
    );
    expect(refused({ kind: "type", text: "" }, view(seen))).toMatch(/no text/);
  });
});

describe("an action that needs the person's yes", () => {
  it.each(dangerWords)("asks before a click on a name with: %s", (word) => {
    const name = word.replace(/^./, (first) => first.toUpperCase());
    const seen = observation([element(1, { title: `${name} now` })]);
    const result = run({ kind: "click_element", element: 1 }, view(seen));
    expect(result.risk).toMatch(/cannot be undone|speaks for you/);
  });
  it("holds every word that the rule names", () => {
    for (const word of "send delete remove erase pay buy order submit post publish share transfer confirm reset format"
      .split(" ")
      .concat(["sign out", "log out", "empty trash"]))
      expect(dangerWords).toContain(word);
  });
  it("asks before a click that gives a yes in the person's place", () => {
    for (const [role, title] of [
      ["AXButton", "Approve"],
      ["AXButton", "Allow"],
      ["AXButton", "Don\u2019t Allow"],
      ["AXButton", "Always Allow"],
      ["AXButton", "Accept All"],
      ["AXButton", "Authorize"],
      ["AXButton", "Authorise app"],
      ["AXButton", "Grant Access"],
      ["AXCheckBox", "I agree"],
      ["AXButton", "Permit"],
      ["AXButton", "Trust"],
    ]) {
      const seen = observation([element(1, { role: role!, title: title! })]);
      expect(
        run({ kind: "click_element", element: 1 }, view(seen)).risk,
        title,
      ).toMatch(/speaks for you/);
    }
    // A word that only holds one of them inside is not asked about.
    for (const title of ["Allowance", "Acceptance report", "Approved items"]) {
      const seen = observation([element(1, { title })]);
      expect(
        run({ kind: "click_element", element: 1 }, view(seen)).risk,
        title,
      ).toBeNull();
    }
  });
  it("asks for a menu item, a link and a name in capitals", () => {
    for (const [role, title] of [
      ["AXMenuItem", "Empty Trash…"],
      ["AXLink", "Sign out"],
      ["AXButton", "SEND"],
      ["AXButton", "Logout"],
      ["AXButton", "Place Order"],
      ["AXMenuItem", "Quit Notes"],
      ["AXButton", "Replace"],
      ["AXButton", "Don’t Save"],
      ["AXButton", "Don't Save"],
      ["AXMenuItem", "Revert to Saved"],
      ["AXButton", "Overwrite"],
    ]) {
      const seen = observation([element(1, { role: role!, title: title! })]);
      expect(
        run({ kind: "click_element", element: 1 }, view(seen)).risk,
      ).not.toBeNull();
    }
  });
  it("does not ask for a name that only holds such a word inside another word", () => {
    for (const title of [
      "Save",
      "Sender",
      "Reorder list",
      "Postpone",
      "Formatting",
      "Shared",
      "Preset",
      "Buyer",
    ]) {
      const seen = observation([element(1, { title })]);
      expect(run({ kind: "click_element", element: 1 }, view(seen)).risk).toBe(
        null,
      );
    }
  });
  it("does not ask for a click that gives a text field the focus", () => {
    const seen = observation([
      element(1, { role: "AXTextField", title: "Send a message" }),
    ]);
    expect(run({ kind: "click_element", element: 1 }, view(seen)).risk).toBe(
      null,
    );
  });
  it("asks for a point when the element under it has such a name, or the planner's own words do", () => {
    const seen = observation([
      element(1, { title: "Delete", x: 100, y: 200, w: 80, h: 24 }),
    ]);
    expect(
      run({ kind: "click_at", x: 125, y: 190 }, view(seen)).risk,
    ).not.toBeNull();
    expect(
      run({ kind: "click_at", x: 900, y: 700 }, view(seen), "Press Send").risk,
    ).not.toBeNull();
    expect(
      run({ kind: "click_at", x: 900, y: 700 }, view(seen), "Open the menu")
        .risk,
    ).toBeNull();
  });
  it("asks before typing and before any key in a terminal", () => {
    const seen = observation([], { app: terminalApp });
    expect(run({ kind: "type", text: "ls" }, view(seen)).risk).toMatch(
      /terminal/,
    );
    expect(run({ kind: "key", combo: "return" }, view(seen)).risk).toMatch(
      /terminal/,
    );
    for (const app of [
      { name: "iTerm2", bundleId: "com.googlecode.iterm2", window: "" },
      { name: "Ghostty", bundleId: "com.mitchellh.ghostty", window: "" },
      { name: "Warp", bundleId: "dev.warp.Warp-Stable", window: "" },
    ])
      expect(
        run({ kind: "type", text: "ls" }, view(observation([], { app }))).risk,
      ).toMatch(/terminal/);
    // The terminal inside an editor has the focus.
    const editor = observation(
      [
        element(1, {
          role: "AXTextArea",
          title: "Terminal 1, zsh",
          focused: true,
        }),
      ],
      { app: { name: "Code", bundleId: "com.microsoft.VSCode", window: "x" } },
    );
    expect(run({ kind: "type", text: "ls" }, view(editor)).risk).toMatch(
      /terminal/,
    );
    // Plain typing and Return in a notes app need no yes.
    expect(run({ kind: "type", text: "milk" }).risk).toBeNull();
    expect(run({ kind: "key", combo: "return" }).risk).toBeNull();
  });
  it("asks before a key combination that quits, logs out or locks", () => {
    for (const combo of [
      "cmd+q",
      "cmd+shift+q",
      "cmd+opt+shift+q",
      "ctrl+cmd+q",
      "command+Q",
      "cmd+alt+esc",
    ])
      expect(run({ kind: "key", combo }).risk).toMatch(/quit|log out|lock/);
    for (const combo of ["cmd+s", "cmd+c", "tab", "escape", "shift+tab", "q"])
      expect(run({ kind: "key", combo }).risk).toBeNull();
  });
  it("asks before a key combination that closes a window or a tab", () => {
    for (const combo of ["cmd+w", "cmd+shift+w", "cmd+opt+w", "command+W"])
      expect(run({ kind: "key", combo }).risk).toMatch(/closes a window/);
    // The letter alone, and other keys with Command, close nothing.
    for (const combo of ["w", "shift+w", "cmd+e", "cmd+r"])
      expect(run({ kind: "key", combo }).risk).toBeNull();
    expect(dangerWords).toContain("terminate");
  });
  it("asks before a close, except when the person's own request says to close", () => {
    const screen = observation([
      element(1, { title: "Close" }),
      element(2, { title: "Don't Save" }),
      element(3, { title: "Closet" }),
    ]);
    const asked = (goal?: string) => view(screen, goal ? { goal } : {});
    // No request, or a request that does not say it: the close asks.
    for (const goal of [undefined, "Tidy up the screen.", "Save the report."]) {
      expect(
        run({ kind: "click_element", element: 1 }, asked(goal)).risk,
      ).toMatch(/"Close" may be something that cannot be undone/);
      expect(run({ kind: "key", combo: "cmd+w" }, asked(goal)).risk).toMatch(
        /closes a window/,
      );
    }
    // The person said it: a click on Close, a point that the planner calls a close, and the key need no question.
    for (const goal of [
      "Close the yellow banner at the top.",
      "please dismiss that popup",
      "Close this tab and open the report.",
    ]) {
      expect(
        run({ kind: "click_element", element: 1 }, asked(goal)).risk,
      ).toBeNull();
      expect(
        run(
          { kind: "click_at", x: 600, y: 700 },
          asked(goal),
          "Close the banner",
        ).risk,
      ).toBeNull();
      expect(run({ kind: "key", combo: "cmd+w" }, asked(goal)).risk).toBeNull();
    }
    // A request that says not to close asks as before.
    for (const goal of [
      "Do not close the window, only save.",
      "don't close anything",
      "Save it without ever having to close the tab",
      "never dismiss the alert",
    ])
      expect(
        run({ kind: "click_element", element: 1 }, asked(goal)).risk,
      ).not.toBeNull();
    // What can be lost with a close keeps its question, whatever the request says.
    expect(
      run(
        { kind: "click_element", element: 2 },
        asked("Close the document without saving it."),
      ).risk,
    ).toMatch(/Don't Save/);
    // Only a plain close control goes without the question. What ends more than a view asks, whatever the request says.
    const named = (title: string, goal: string) =>
      run(
        { kind: "click_element", element: 1 },
        view(observation([element(1, { title })]), { goal }),
      ).risk;
    for (const title of [
      "Close",
      "close button",
      "Close tab",
      "Close this window",
      "Close the sidebar",
    ])
      expect(named(title, "Close it, please.")).toBeNull();
    for (const title of [
      "Close account",
      "Close issue",
      "Close project and archive",
      "Close all",
    ])
      expect(named(title, "Close my account.")).toMatch(/"Close" may be/);
    // A whole word only.
    expect(run({ kind: "click_element", element: 3 }, asked()).risk).toBeNull();
    expect(askedToClose("Close it")).toBe(true);
    expect(askedToClose("Open the note")).toBe(false);
    expect(askedToClose(undefined)).toBe(false);
  });
  it("asks before a key that sends or removes", () => {
    for (const combo of ["cmd+return", "ctrl+enter", "cmd+delete"])
      expect(run({ kind: "key", combo }).risk).not.toBeNull();
    const messages = observation([], {
      app: { name: "Messages", bundleId: "com.apple.MobileSMS", window: "" },
    });
    expect(run({ kind: "key", combo: "return" }, view(messages)).risk).toMatch(
      /sends/,
    );
    // A new line in a message is not a send.
    expect(
      run({ kind: "key", combo: "shift+return" }, view(messages)).risk,
    ).toBeNull();
    const mail = observation([], {
      app: { name: "Mail", bundleId: "com.apple.mail", window: "New Message" },
    });
    expect(run({ kind: "key", combo: "cmd+shift+d" }, view(mail)).risk).toMatch(
      /sends/,
    );
    expect(run({ kind: "key", combo: "cmd+shift+d" }).risk).toBeNull();
  });
  it("asks before Return or Space can press a button that cannot be undone", () => {
    // A dialog: Cancel and Delete, and no text field has the focus.
    const dialog = observation([
      element(1, { title: "Cancel" }),
      element(2, { title: "Delete" }),
    ]);
    for (const combo of ["return", "enter", "space"])
      expect(run({ kind: "key", combo }, view(dialog)).risk).toBe(
        'This key can press "Delete", which may be something that cannot be undone, or that speaks for you.',
      );
    // Other keys do not press a button.
    for (const combo of ["escape", "tab", "down", "a"])
      expect(run({ kind: "key", combo }, view(dialog)).risk).toBeNull();
    // With the focus in a text field, the key goes to the text.
    const writing = observation([
      element(1, { title: "Send" }),
      element(2, { role: "AXTextArea", title: "Message", focused: true }),
    ]);
    expect(
      run({ kind: "key", combo: "return" }, view(writing)).risk,
    ).toBeNull();
    expect(run({ kind: "key", combo: "space" }, view(writing)).risk).toBeNull();
    // A button that is disabled, or that has a plain name, is not pressed into a question.
    const plain = observation([
      element(1, { title: "Delete", enabled: false }),
      element(2, { title: "OK" }),
    ]);
    expect(run({ kind: "key", combo: "return" }, view(plain)).risk).toBeNull();
    // An open menu with such an item, and a link with such a name that has the focus.
    const menu = observation([
      element(1, { role: "AXMenuItem", title: "Rename" }),
      element(2, { role: "AXMenuItem", title: "Move to Trash" }),
    ]);
    expect(run({ kind: "key", combo: "return" }, view(menu)).risk).toMatch(
      /can press "Move to Trash"/,
    );
    const link = observation([
      element(1, { role: "AXLink", title: "Delete account", focused: true }),
    ]);
    expect(run({ kind: "key", combo: "space" }, view(link)).risk).toMatch(
      /can press "Delete account"/,
    );
    // A link with such a name that does not have the focus is not pressed by a key.
    const page = observation([
      element(1, { role: "AXLink", title: "Delete account" }),
    ]);
    expect(run({ kind: "key", combo: "return" }, view(page)).risk).toBeNull();
  });
});

describe("key combinations", () => {
  it("writes them one way, modifiers first", () => {
    expect(parseCombo("Shift+Command+4")?.combo).toBe("cmd+shift+4");
    expect(parseCombo("enter")?.combo).toBe("return");
    expect(parseCombo("ctrl+alt+Delete")?.combo).toBe("ctrl+opt+delete");
    expect(parseCombo("esc")?.combo).toBe("escape");
    expect(run({ kind: "key", combo: "Command+S" }).send).toMatchObject({
      command: { kind: "key", combo: "cmd+s" },
    });
  });
  it("refuses what is not one key with known modifiers", () => {
    for (const combo of [
      "",
      "cmd+",
      "cmd",
      "hello world",
      "cmd+s+t",
      "power",
      "cmd+power",
      "hyper+x",
      "cmd+cmd+s",
    ]) {
      expect(parseCombo(combo)).toBeNull();
      expect(refused({ kind: "key", combo })).toMatch(/key/);
    }
  });
});

describe("links, apps and waits", () => {
  // The person's own request names the site of the links below.
  const asked = view(observation(), {
    goal: "Open the page of example.com that the note names",
  });
  it("opens only http and https", () => {
    for (const kind of ["open_url", "browser_open"]) {
      expect(
        run({ kind, url: "https://example.com/a?b=1" }, asked).risk,
      ).toBeNull();
      // Plain http only when the person wrote it: here they did not.
      expect(run({ kind, url: "http://example.com" }, asked).risk).toMatch(
        /plain http/,
      );
      for (const url of [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "ftp://example.com",
        "x-apple.systempreferences:com.apple.preference.security",
        "example.com",
        "",
        " https://example.com",
        "https://user:secret@example.com/",
      ])
        expect(refused({ kind, url })).toMatch(/http/);
    }
    const opened = run(
      { kind: "open_url", url: "https://example.com/a?b=1" },
      asked,
    );
    // The record keeps the site, not the path or the query.
    expect(opened.target).toBe("example.com");
    expect(opened.send).toEqual({
      via: "hands",
      look: false,
      command: { kind: "open_url", url: "https://example.com/a?b=1" },
    });
  });
  it("opens with no question only the site that the person wrote, with its port, its scheme and no long hidden part", () => {
    const words = (goal: string) => view(observation(), { goal });
    for (const kind of ["open_url", "browser_open"]) {
      const risk = (url: string, goal: string) =>
        run({ kind, url }, words(goal)).risk;
      // A common word of the request names no site: no site with that name opens unasked.
      for (const [url, goal] of [
        ["https://open.ai/x?d=1", "open my notes and summarize them"],
        ["https://open.so/", "open Notes"],
        ["https://the.com/", "add the milk to the list"],
        ["https://mail.com/", "check my mail"],
        ["https://bank.com/", "open my bank and pay rent"],
        ["https://www.quillboard.so/", "Open Quillboard in Fixture Browser"],
      ] as const)
        expect(risk(url, goal)).toMatch(/not in your request/);
      // A file name, a mail address, a word in another script and a "dot" phrase name no site.
      for (const [url, goal] of [
        ["https://readme.md/?d=1", "open README.md and follow its steps"],
        ["https://photos.zip/", "unzip photos.zip in Downloads"],
        ["https://install.sh/", "run install.sh"],
        ["https://example.com/", "email bob@example.com the report"],
        ["https://nchen.de/", "open münchen.de"],
        ["https://the.com/", "an article on the dot com bubble"],
      ] as const)
        expect(risk(url, goal)).toMatch(/not in your request/);
      // The site as written opens, also a search on it.
      expect(
        risk(
          "https://www.example-shop.in/s?k=wireless+earbuds",
          "find wireless earbuds on example-shop.in",
        ),
      ).toBeNull();
      expect(
        risk(
          "https://app.example.com/",
          "Bro, just open app.example.com on Fixture Browser.",
        ),
      ).toBeNull();
      // The port of the request, and no other.
      expect(
        risk("http://localhost:3000/board", "open localhost:3000"),
      ).toBeNull();
      expect(risk("http://localhost:8080/", "open localhost:3000")).toMatch(
        /not in your request/,
      );
      // Plain http only when the person wrote it.
      expect(risk("http://example.com/", "open example.com")).toMatch(
        /plain http/,
      );
      expect(risk("http://example.com/", "open http://example.com")).toBeNull();
      // A long path or query that the person did not write can carry the screen to the site.
      const long = `https://example.com/form?entry=${"a".repeat(140)}`;
      expect(risk(long, "open example.com and copy my notes")).toMatch(
        /long part/,
      );
      expect(risk(long, `open ${long}`)).toBeNull();
    }
  });

  it("asks before a browser that the person did not name opens the address", () => {
    const risk = (browser: string, goal: string) =>
      run(
        { kind: "open_url", url: "https://example.org/n", browser },
        view(observation(), { goal }),
      ).risk;
    expect(
      risk("Chatbox Assistant", "open example.org and check my notifications"),
    ).toBe("The browser Chatbox Assistant is not in your request.");
    expect(risk("Fixture Browser", "open example.org in Fixture")).toBeNull();
    expect(risk("Fixture", "open example.org on Fixture Browser")).toBeNull();
    expect(
      risk("the Fixture browser", "open example.org in fixture"),
    ).toBeNull();
    // "browser" alone names no app.
    expect(risk("browser", "open example.org in the browser")).toMatch(
      /not in your request/,
    );
    // After words that the person added, the checks have no request: they ask.
    expect(risk("Fixture", "")).toMatch(/not in your request/);
  });

  it("asks before it opens an address that the person's own words do not hold", () => {
    const words = (goal?: string) =>
      view(observation(), goal === undefined ? {} : { goal });
    for (const kind of ["open_url", "browser_open"]) {
      const risk = (url: string, goal?: string) =>
        run({ kind, url }, words(goal)).risk;
      // The planner chose the address: the person says yes first.
      expect(risk("https://example.net/login", "Open my mail")).toBe(
        "The address example.net is not in your request.",
      );
      expect(risk("https://example.com/")).toMatch(/not in your request/);
      // The person's words hold the site, in the forms that people write and say.
      for (const goal of [
        "open example.com and log in",
        "Go to https://Example.com/board, then read it",
        "open www.example.com.",
      ])
        expect(risk("https://www.example.com/a?b=1", goal)).toBeNull();
      expect(
        risk("http://localhost:3000/", "open localhost:3000 and reload"),
      ).toBeNull();
      // Another site is another site, however alike its name is.
      const goal = "open app.example.com and find the board";
      expect(risk("https://app.example.com/board", goal)).toBeNull();
      for (const url of [
        "https://example.com/",
        "https://login.app.example.com/",
        "https://app.example.com.example.net/",
        "https://myapp.example.com/",
        "https://app.example.co/",
      ])
        expect(risk(url, goal)).toMatch(/not in your request/);
    }
  });
  it("opens an address in a browser that is named by a plain name", () => {
    const opened = run(
      {
        kind: "open_url",
        url: "https://example.com/a?b=1",
        browser: "Fixture Browser",
      },
      view(observation(), {
        goal: "Open the page of example.com that the note names in Fixture Browser",
      }),
    );
    expect(opened.label).toBe("Open example.com in Fixture Browser");
    expect(opened.target).toBe("example.com");
    expect(opened.risk).toBeNull();
    expect(opened.send).toEqual({
      via: "hands",
      look: false,
      command: {
        kind: "open_url",
        url: "https://example.com/a?b=1",
        browser: "Fixture Browser",
      },
    });
    // The hands get the address as it was checked, written one way.
    expect(
      run({ kind: "open_url", url: "HTTP://Example.COM\\@example.net/" }, asked)
        .send,
    ).toMatchObject({
      command: { kind: "open_url", url: "http://example.com/@example.net/" },
    });
    // The same address in another browser is another action.
    expect(opened.signature).not.toBe(
      run({ kind: "open_url", url: "https://example.com/a?b=1" }, asked)
        .signature,
    );
    expect(
      run({ kind: "open_url", url: "https://example.com/" }, asked).label,
    ).toBe("Open example.com");
    for (const browser of [
      "",
      "  ",
      "../../bin/sh",
      "/Applications/Fixture.app",
      "a\nb",
      ".hidden",
    ])
      expect(
        refused(
          { kind: "open_url", url: "https://example.com/", browser },
          asked,
        ),
      ).toMatch(/name/);
    // The browser that the page is read through has no name to choose.
    expect(
      check(
        {
          kind: "browser_open",
          url: "https://example.com/",
          browser: "Fixture Browser",
        },
        asked,
        "",
      ).verdict,
    ).toBe("refuse");
  });
  it("opens an app by a plain name", () => {
    expect(run({ kind: "open_app", name: "Notes" }).send).toEqual({
      via: "hands",
      look: false,
      command: { kind: "open_app", name: "Notes" },
    });
    for (const name of ["", "../../bin/sh", "/Applications/Notes.app", "a\nb"])
      expect(refused({ kind: "open_app", name })).toMatch(/name/);
  });
  it("scrolls at an element or at the middle of the screen", () => {
    const seen = observation([element(1, { x: 100, y: 200, w: 80, h: 24 })]);
    expect(run({ kind: "scroll", direction: "down" }, view(seen)).send).toEqual(
      {
        via: "hands",
        look: true,
        command: { kind: "scroll", x: 720, y: 450, dx: 0, dy: 5 },
      },
    );
    expect(
      run({ kind: "scroll", direction: "up", element: 1 }, view(seen)).send,
    ).toMatchObject({ command: { x: 140, y: 212, dy: -5 } });
  });
  it("waits through the hands", () => {
    expect(run({ kind: "wait", ms: 500 }).send).toEqual({
      via: "hands",
      look: false,
      command: { kind: "wait", ms: 500 },
    });
  });
});

describe("done, a question and giving up", () => {
  it("counts done only after an observation that came after the last action", () => {
    expect(check({ kind: "done", summary: "Saved." }, view(), "")).toEqual({
      verdict: "done",
      summary: "Saved.",
    });
    expect(
      refused(
        { kind: "done", summary: "Saved." },
        view(observation(), { fresh: false }),
      ),
    ).toMatch(/newer than the last action/);
    expect(refused({ kind: "done", summary: "Saved." }, view(null))).toMatch(
      /newer than the last action/,
    );
  });
  it("passes a question and a reason on", () => {
    expect(check({ kind: "ask", question: "Which one?" }, view(), "")).toEqual({
      verdict: "ask",
      question: "Which one?",
    });
    expect(
      check({ kind: "give_up", reason: "No such app." }, view(null), ""),
    ).toEqual({ verdict: "give_up", reason: "No such app." });
  });
});

describe("the browser", () => {
  const read = page([
    pageElement(0, { label: "Search", tag: "input", role: "searchbox" }),
    pageElement(1, { label: "Buy now" }),
    pageElement(2, { label: "Password", tag: "input", password: true }),
    pageElement(3, { label: "Off", disabled: true }),
    pageElement(4, { label: "Comment", tag: "textarea", role: "textbox" }),
    pageElement(5, { label: "Next" }),
  ]);
  const at = view(observation(), { page: read });
  it("clicks an element of the last page by its number", () => {
    const result = run({ kind: "browser_click", index: 5 }, at);
    expect(result.label).toBe('Click "Next" on the page');
    expect(result.send).toMatchObject({
      via: "browser",
      call: { name: "click", index: 5 },
    });
    expect(result.risk).toBeNull();
  });
  it("refuses a number that the last page does not hold, and any number with no page", () => {
    expect(refused({ kind: "browser_click", index: 9 }, at)).toMatch(
      /no element 9/,
    );
    expect(refused({ kind: "browser_click", index: 1 }, view())).toMatch(
      /read the page first/i,
    );
    expect(
      refused({ kind: "browser_type", index: 0, text: "a" }, view()),
    ).toMatch(/read the page first/i);
    expect(refused({ kind: "browser_click", index: 3 }, at)).toMatch(
      /disabled/,
    );
  });
  it("asks before a click on a name that cannot be undone", () => {
    expect(run({ kind: "browser_click", index: 1 }, at).risk).not.toBeNull();
  });
  it("never types into a password field", () => {
    expect(
      check({ kind: "browser_type", index: 2, text: "hunter2" }, at, ""),
    ).toMatchObject({ verdict: "person_types", target: "Password" });
  });
  it("refuses a disabled password field, and does not ask the person to type in it", () => {
    const locked = view(observation(), {
      page: page([
        pageElement(0, {
          label: "Password",
          tag: "input",
          password: true,
          disabled: true,
        }),
      ]),
    });
    expect(
      refused({ kind: "browser_type", index: 0, text: "hunter2" }, locked),
    ).toMatch(/disabled/);
  });
  it("asks before it submits a form, but not a search", () => {
    expect(
      run({ kind: "browser_type", index: 4, text: "hi", submit: true }, at)
        .risk,
    ).toMatch(/submits/);
    expect(
      run({ kind: "browser_type", index: 4, text: "hi" }, at).risk,
    ).toBeNull();
    expect(
      run({ kind: "browser_type", index: 0, text: "cats", submit: true }, at)
        .risk,
    ).toBeNull();
  });
  it("refuses every browser action where no browser is connected", () => {
    const none = view(observation(), { browser: false, page: read });
    for (const raw of [
      { kind: "browser_read" },
      { kind: "browser_open", url: "https://example.com" },
      { kind: "browser_click", index: 5 },
      { kind: "browser_type", index: 0, text: "a" },
      { kind: "browser_scroll", direction: "down" },
      { kind: "browser_back" },
    ])
      expect(refused(raw, none)).toMatch(/no browser/i);
  });
  it("reads, scrolls and goes back with no page yet", () => {
    for (const raw of [
      { kind: "browser_read" },
      { kind: "browser_scroll", direction: "down" },
      { kind: "browser_back" },
    ])
      expect(run(raw, view()).send).toMatchObject({ via: "browser" });
  });
});

describe("the same action in a row", () => {
  it("has one signature for one target, whatever its number is", () => {
    const first = observation([element(4, { title: "Save" })]);
    const second = observation([
      element(1, { title: "Other" }),
      element(7, { title: "Save" }),
    ]);
    const a = run({ kind: "click_element", element: 4 }, view(first));
    const b = run({ kind: "click_element", element: 7 }, view(second));
    const c = run({ kind: "click_element", element: 1 }, view(second));
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
    expect(run({ kind: "type", text: "a" }).signature).not.toBe(
      run({ kind: "type", text: "b" }).signature,
    );
  });
  it("does not count a scroll, a wait or a reading of the page", () => {
    expect(run({ kind: "scroll", direction: "down" }).signature).toBeNull();
    expect(run({ kind: "wait", ms: 100 }).signature).toBeNull();
    expect(run({ kind: "browser_read" }).signature).toBeNull();
    expect(
      run({ kind: "browser_scroll", direction: "down" }).signature,
    ).toBeNull();
  });
});

describe("the look just before an action", () => {
  const before = observation([
    element(1, { title: "Other" }),
    element(2, { title: "Save", x: 300, y: 400 }),
  ]);
  it("finds the same element again under a new number", () => {
    const after = observation([
      element(5, { title: "Save", x: 300, y: 400 }),
      element(6, { title: "Other" }),
    ]);
    expect(
      retarget({ kind: "click_element", element: 2 }, before, after),
    ).toMatchObject({ ok: true, action: { element: 5 } });
  });
  it("follows an element that moved, when only one has its role and name", () => {
    const after = observation([element(9, { title: "Save", x: 320, y: 460 })]);
    expect(
      retarget({ kind: "click_element", element: 2 }, before, after),
    ).toMatchObject({ ok: true, action: { element: 9 } });
  });
  it("refuses when the element is gone, or when two could be it", () => {
    expect(
      retarget(
        { kind: "click_element", element: 2 },
        before,
        observation([element(1, { title: "Other" })]),
      ),
    ).toMatchObject({ ok: false });
    const twins = observation([
      element(1, { title: "Save", x: 10, y: 10 }),
      element(2, { title: "Save", x: 600, y: 10 }),
    ]);
    expect(
      retarget({ kind: "click_element", element: 2 }, before, twins),
    ).toMatchObject({ ok: false });
  });
  it("refuses when another app or window came to the front", () => {
    for (const app of [
      { ...before.app, bundleId: "com.apple.mail" },
      { ...before.app, window: "Another window" },
    ])
      for (const action of [
        { kind: "click_element", element: 2 } as const,
        { kind: "type", text: "a" } as const,
        { kind: "key", combo: "return" } as const,
      ])
        expect(retarget(action, before, { ...before, app })).toMatchObject({
          ok: false,
          reason: expect.stringMatching(/front/),
        });
  });
  it("refuses a point when what is under it changed", () => {
    // Image point (275, 365) is inside Save at (300..380, 400..424) on the screen.
    const action = { kind: "click_at", x: 275, y: 365 } as const;
    expect(retarget(action, before, before)).toMatchObject({ ok: true });
    const replaced = observation([
      element(1, { title: "Delete all", x: 300, y: 400 }),
    ]);
    expect(retarget(action, before, replaced)).toMatchObject({ ok: false });
  });
  it("keeps the size of the last image for a look that took no image", () => {
    const { image, imageWidth, imageHeight, ...bare } = before;
    const result = retarget({ kind: "click_at", x: 275, y: 365 }, before, bare);
    expect(result).toMatchObject({
      ok: true,
      observation: { imageWidth: 1280, imageHeight: 800 },
    });
  });
});

/** A view where the browser has every optional method. */
const able = (values: Partial<View> = {}, seen = observation()) =>
  view(seen, { browserMethods: [...browserMethodNames], ...values });

describe("the shape of the newer actions", () => {
  it("takes a hover at exactly one of an element or a whole point", () => {
    for (const raw of [
      { kind: "hover", element: 1 },
      { kind: "hover", x: 10, y: 20 },
    ])
      expect(check(raw, view(observation([element(1)])), "").verdict).toBe(
        "run",
      );
    for (const raw of [
      { kind: "hover" },
      { kind: "hover", element: 1, x: 10, y: 20 },
      { kind: "hover", element: 1, x: 10 },
      { kind: "hover", x: 10 },
      { kind: "hover", y: 10 },
      { kind: "hover", element: -1 },
      { kind: "hover", element: 1, extra: true },
    ])
      expect(refused(raw, view(observation([element(1)])))).toMatch(
        /not one known action/,
      );
  });
  it("takes a drag only with two whole ends, each an element or a point", () => {
    const seen = observation([
      element(1, { x: 100, y: 100 }),
      element(2, { x: 600, y: 100 }),
    ]);
    for (const raw of [
      { kind: "drag", from: { element: 1 }, to: { element: 2 } },
      { kind: "drag", from: { x: 100, y: 100 }, to: { element: 2 } },
      { kind: "drag", from: { element: 1 }, to: { x: 700, y: 500 } },
    ])
      expect(check(raw, view(seen), "").verdict).toBe("run");
    for (const raw of [
      { kind: "drag" },
      { kind: "drag", from: { element: 1 } },
      { kind: "drag", to: { element: 2 } },
      { kind: "drag", from: { element: 1, x: 1, y: 1 }, to: { element: 2 } },
      { kind: "drag", from: { x: 1 }, to: { element: 2 } },
      { kind: "drag", from: {}, to: { element: 2 } },
      { kind: "drag", from: 1, to: 2 },
      { kind: "drag", from: { element: 1 }, to: { element: 2 }, fast: true },
      { kind: "drag", from: { element: 1 }, to: { element: 2, extra: 1 } },
    ])
      expect(refused(raw, view(seen))).toMatch(/not one known action/);
  });
  it("takes a scroll amount of whole notches from 1 to 10 only", () => {
    for (const amount of [1, 5, 10])
      expect(
        check({ kind: "scroll", direction: "down", amount }, view(), "")
          .verdict,
      ).toBe("run");
    for (const amount of [0, 11, -1, 2.5, "3"])
      expect(
        refused({ kind: "scroll", direction: "down", amount }, view()),
      ).toMatch(/not one known action/);
  });
  it("takes a wait of the page from 100 to 10000 milliseconds only", () => {
    for (const ms of [100, 2500, 10_000])
      expect(check({ kind: "browser_wait", ms }, able(), "").verdict).toBe(
        "run",
      );
    for (const raw of [
      { kind: "browser_wait", ms: 99 },
      { kind: "browser_wait", ms: 10_001 },
      { kind: "browser_wait", ms: 1.5 },
      { kind: "browser_wait" },
      { kind: "browser_wait", ms: 500, text: 7 },
      { kind: "browser_wait", ms: 500, text: "x".repeat(201) },
    ])
      expect(refused(raw, able())).toMatch(/not one known action/);
  });
  it("refuses the other new browser actions out of shape", () => {
    for (const raw of [
      { kind: "browser_hover" },
      { kind: "browser_hover", index: -1 },
      { kind: "browser_select", index: 1 },
      { kind: "browser_select", index: 1, option: 3 },
      { kind: "browser_key" },
      { kind: "browser_key", combo: "x".repeat(41) },
      { kind: "browser_tabs", all: true },
      { kind: "browser_switch_tab" },
      { kind: "browser_switch_tab", tab: 0 },
      { kind: "browser_switch_tab", tab: 1.5 },
    ])
      expect(refused(raw, able())).toMatch(/not one known action/);
  });
});

describe("a hover", () => {
  const seen = observation([
    element(1, { title: "File", x: 100, y: 100, w: 60, h: 20 }),
    element(2, { title: "Delete all", x: 300, y: 100, w: 80, h: 20 }),
    element(3, { title: "Greyed", enabled: false, x: 500, y: 100 }),
  ]);
  it("moves the pointer to the middle of an element, and needs no yes", () => {
    const result = run({ kind: "hover", element: 1 }, view(seen));
    expect(result).toMatchObject({
      label: 'Hover over "File"',
      target: "File",
      risk: null,
      send: {
        via: "hands",
        look: true,
        command: { kind: "move", x: 130, y: 110 },
      },
    });
    // No click goes out, so even a name that a click asks about needs no yes.
    expect(run({ kind: "hover", element: 2 }, view(seen)).risk).toBeNull();
  });
  it("may rest on a disabled element, which can explain itself in a tooltip", () => {
    expect(run({ kind: "hover", element: 3 }, view(seen)).send).toMatchObject({
      command: { kind: "move" },
    });
  });
  it("maps a point of the picture to the screen and names what is under it", () => {
    // Image point (120, 98) is screen point (135, 110.25): inside File.
    expect(run({ kind: "hover", x: 120, y: 98 }, view(seen))).toMatchObject({
      label: 'Hover over "File"',
      send: { command: { kind: "move", x: 135, y: 110.25 } },
    });
    expect(run({ kind: "hover", x: 1000, y: 700 }, view(seen)).label).toBe(
      "Hover at a point",
    );
  });
  it("refuses a missing element, a point outside the picture, and a stale view", () => {
    expect(refused({ kind: "hover", element: 9 }, view(seen))).toMatch(
      /no element 9/,
    );
    expect(refused({ kind: "hover", x: 1280, y: 10 }, view(seen))).toMatch(
      /outside the last image/,
    );
    const { image, imageWidth, imageHeight, ...bare } = seen;
    expect(refused({ kind: "hover", x: 10, y: 10 }, view(bare))).toMatch(
      /no image/,
    );
    expect(
      refused({ kind: "hover", element: 1 }, view(seen, { fresh: false })),
    ).toMatch(/no fresh view/);
  });
  it("counts as a repeat when it rests on the same element again", () => {
    const moved = observation([element(7, { title: "File", x: 10, y: 10 })]);
    expect(run({ kind: "hover", element: 1 }, view(seen)).signature).toBe(
      run({ kind: "hover", element: 7 }, view(moved)).signature,
    );
  });
});

describe("a drag", () => {
  const card = element(1, { title: "Card", x: 100, y: 100, w: 100, h: 40 });
  const done = element(2, { title: "Done", x: 600, y: 100, w: 200, h: 300 });
  const seen = observation([card, done]);
  it("presses at the middle of one end and lets go at the other", () => {
    const result = run(
      { kind: "drag", from: { element: 1 }, to: { element: 2 } },
      view(seen),
    );
    expect(result).toMatchObject({
      label: 'Drag "Card" to "Done"',
      target: "Card to Done",
      risk: null,
      send: {
        via: "hands",
        look: true,
        command: { kind: "drag", fromX: 150, fromY: 120, toX: 700, toY: 250 },
      },
    });
  });
  it("maps a point end of the picture to the screen", () => {
    // Image point (800, 400) is screen point (900, 450): under no element.
    const result = run(
      { kind: "drag", from: { element: 1 }, to: { x: 800, y: 400 } },
      view(seen),
    );
    expect(result.label).toBe('Drag "Card" to a point');
    expect(result.send).toMatchObject({
      command: { kind: "drag", fromX: 150, fromY: 120, toX: 900, toY: 450 },
    });
    expect(
      run(
        { kind: "drag", from: { x: 800, y: 400 }, to: { element: 2 } },
        view(seen),
      ).label,
    ).toBe('Drag from a point to "Done"');
  });
  it("checks both ends as a click: a missing, disabled or off-screen element, or a point outside the picture", () => {
    const more = observation([
      card,
      done,
      element(3, { title: "Off", enabled: false }),
      element(4, { title: "Far", x: 5000 }),
    ]);
    for (const [raw, reason] of [
      [{ from: { element: 9 }, to: { element: 2 } }, /no element 9/],
      [{ from: { element: 1 }, to: { element: 9 } }, /no element 9/],
      [{ from: { element: 3 }, to: { element: 2 } }, /disabled/],
      [{ from: { element: 1 }, to: { element: 4 } }, /off the screen/],
      [
        { from: { element: 1 }, to: { x: 1280, y: 10 } },
        /outside the last image/,
      ],
    ] as const)
      expect(refused({ kind: "drag", ...raw }, view(more))).toMatch(reason);
    expect(
      refused(
        { kind: "drag", from: { element: 1 }, to: { element: 2 } },
        view(seen, { fresh: false }),
      ),
    ).toMatch(/no fresh view/);
  });
  it("refuses two ends at one place: that is a click", () => {
    expect(
      refused(
        { kind: "drag", from: { element: 1 }, to: { element: 1 } },
        view(seen),
      ),
    ).toMatch(/two places apart/);
  });
  it("asks before it drops onto Trash or another name that a click asks about, and before it drags such a name", () => {
    const desk = observation([
      card,
      element(2, { role: "AXDockItem", title: "Trash", x: 1300, y: 860 }),
      element(3, { title: "Delete", x: 400, y: 400 }),
    ]);
    expect(
      run(
        { kind: "drag", from: { element: 1 }, to: { element: 2 } },
        view(desk),
      ).risk,
    ).toMatch(/"Trash" may be something that cannot be undone/);
    expect(
      run(
        { kind: "drag", from: { element: 3 }, to: { element: 1 } },
        view(desk),
      ).risk,
    ).toMatch(/"Delete" may be/);
  });
  it("asks before it drops onto a terminal app, or while a terminal is in front", () => {
    const dock = observation([
      card,
      element(2, { role: "AXDockItem", title: "Terminal", x: 1200, y: 860 }),
    ]);
    expect(
      run(
        { kind: "drag", from: { element: 1 }, to: { element: 2 } },
        view(dock),
      ).risk,
    ).toMatch(/terminal/);
    const front = observation([card, done], { app: terminalApp });
    expect(
      run(
        { kind: "drag", from: { element: 1 }, to: { element: 2 } },
        view(front),
      ).risk,
    ).toMatch(/terminal/);
  });
  it("asks before it drags out of a password field, and never drops onto one", () => {
    const form = observation([
      element(1, {
        role: "AXSecureTextField",
        title: "Password",
        secure: true,
        x: 100,
        y: 100,
        w: 200,
        h: 24,
      }),
      element(2, { role: "AXTextField", title: "Notes", x: 100, y: 300 }),
    ]);
    expect(
      run(
        { kind: "drag", from: { element: 1 }, to: { element: 2 } },
        view(form),
      ).risk,
    ).toMatch(/starts in a password field/);
    expect(
      refused(
        { kind: "drag", from: { element: 2 }, to: { element: 1 } },
        view(form),
      ),
    ).toMatch(/never drops onto a password field/);
    // A point over the field is the field too.
    expect(
      refused(
        { kind: "drag", from: { element: 2 }, to: { x: 100, y: 95 } },
        view(form),
      ),
    ).toMatch(/never drops onto a password field/);
  });
  it("does not ask for a field at either end, which only takes what is dropped", () => {
    const fields = observation([
      element(1, { role: "AXTextField", title: "Delete reason", x: 100 }),
      element(2, { role: "AXTextArea", title: "Remove notes", x: 600 }),
    ]);
    expect(
      run(
        { kind: "drag", from: { element: 1 }, to: { element: 2 } },
        view(fields),
      ).risk,
    ).toBeNull();
  });
  it("reads the planner's own words for an end with no named element", () => {
    const at = { kind: "drag", from: { element: 1 }, to: { x: 800, y: 400 } };
    expect(run(at, view(seen), "move the card to the trash").risk).toMatch(
      /"trash" may be/,
    );
    expect(run(at, view(seen), "move the card right").risk).toBeNull();
    // Named ends do not read those words.
    expect(
      run(
        { kind: "drag", from: { element: 1 }, to: { element: 2 } },
        view(seen),
        "delete it",
      ).risk,
    ).toBeNull();
  });
  it("has one signature for the same two ends, whatever their numbers", () => {
    const again = observation([
      element(5, { title: "Done", x: 600, y: 100, w: 200, h: 300 }),
      element(6, { title: "Card", x: 100, y: 100, w: 100, h: 40 }),
    ]);
    const a = run(
      { kind: "drag", from: { element: 1 }, to: { element: 2 } },
      view(seen),
    );
    const b = run(
      { kind: "drag", from: { element: 6 }, to: { element: 5 } },
      view(again),
    );
    const c = run(
      { kind: "drag", from: { element: 5 }, to: { element: 6 } },
      view(again),
    );
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
  });
});

describe("a scroll by an amount", () => {
  it("turns the wheel by that many notches, and by 5 without one", () => {
    expect(
      run({ kind: "scroll", direction: "down", amount: 2 }).send,
    ).toMatchObject({ command: { kind: "scroll", dx: 0, dy: 2 } });
    expect(
      run({ kind: "scroll", direction: "up", amount: 10 }).send,
    ).toMatchObject({ command: { dy: -10 } });
    expect(run({ kind: "scroll", direction: "up" }).send).toMatchObject({
      command: { dy: -5 },
    });
    expect(
      run({ kind: "scroll", direction: "up", amount: 3 }).signature,
    ).toBeNull();
  });
});

describe("the newer browser actions", () => {
  const read = page([
    pageElement(0, { label: "Search", tag: "input", role: "searchbox" }),
    pageElement(1, { label: "Menu" }),
    pageElement(2, { label: "Size", tag: "select", role: "combobox" }),
    pageElement(3, { label: "Password", tag: "input", password: true }),
    pageElement(4, { label: "Off", tag: "select", disabled: true }),
    pageElement(5, { label: "Colors", tag: "div", role: "listbox" }),
    pageElement(6, { label: "Next", tag: "a", role: "link" }),
  ]);
  const shop = page([...read.elements, pageElement(7, { label: "Pay now" })]);
  const tabs: BrowserTab[] = [
    { index: 1, title: "Inbox", url: "https://mail.example/", active: false },
    { index: 2, title: "Example", url: "https://example.com/", active: true },
  ];
  const listed = page([], { tabs });
  it("refuses each one where no browser is connected, or where its driver lacks the method", () => {
    const none = view(observation(), { browser: false, page: shop });
    const lacking = view(observation(), { page: { ...shop, tabs } });
    for (const raw of [
      { kind: "browser_hover", index: 1 },
      { kind: "browser_select", index: 2, option: "Large" },
      { kind: "browser_key", combo: "Escape" },
      { kind: "browser_wait", ms: 500 },
      { kind: "browser_tabs" },
      { kind: "browser_switch_tab", tab: 1 },
    ]) {
      expect(refused(raw, none)).toMatch(/no browser/i);
      expect(refused(raw, lacking)).toMatch(/cannot do that/);
    }
    // A switch needs the list of the tabs too.
    expect(
      refused(
        { kind: "browser_switch_tab", tab: 1 },
        able({ page: listed, browserMethods: ["switchTab"] }),
      ),
    ).toMatch(/cannot do that/);
    expect(browserCan("browser_switch_tab", ["tabs", "switchTab"])).toBe(true);
    expect(browserCan("browser_read")).toBe(true);
  });
  it("hovers an element of the last page with no yes, also a disabled one", () => {
    const at = able({ page: shop });
    expect(run({ kind: "browser_hover", index: 1 }, at)).toMatchObject({
      label: 'Hover over "Menu" on the page',
      target: "Menu",
      risk: null,
      send: { via: "browser", call: { name: "hover", index: 1 } },
    });
    expect(run({ kind: "browser_hover", index: 7 }, at).risk).toBeNull();
    expect(run({ kind: "browser_hover", index: 4 }, at).send).toMatchObject({
      call: { name: "hover" },
    });
    expect(refused({ kind: "browser_hover", index: 9 }, at)).toMatch(
      /no element 9/,
    );
    expect(refused({ kind: "browser_hover", index: 1 }, able())).toMatch(
      /read the page first/i,
    );
  });
  it("chooses an option of a list of choices by its text", () => {
    const at = able({ page: shop });
    expect(
      run({ kind: "browser_select", index: 2, option: " Large " }, at),
    ).toMatchObject({
      label: 'Choose "Large" in "Size" on the page',
      target: "Size",
      risk: null,
      send: {
        via: "browser",
        call: { name: "select", index: 2, option: "Large" },
      },
    });
    expect(
      run({ kind: "browser_select", index: 5, option: "Blue" }, at).send,
    ).toMatchObject({ call: { name: "select", index: 5 } });
  });
  it("asks before an option that a click would ask about", () => {
    const at = able({ page: shop });
    expect(
      run({ kind: "browser_select", index: 2, option: "Delete selected" }, at)
        .risk,
    ).toMatch(/"Delete" may be/);
  });
  it("refuses an element that is no list of choices, a disabled one, a password field, and an option that is not one line", () => {
    const at = able({ page: shop });
    expect(
      refused({ kind: "browser_select", index: 1, option: "A" }, at),
    ).toMatch(/not a list of choices/);
    expect(
      refused({ kind: "browser_select", index: 3, option: "A" }, at),
    ).toMatch(/not a list of choices/);
    expect(
      refused({ kind: "browser_select", index: 4, option: "A" }, at),
    ).toMatch(/disabled/);
    for (const option of ["", "  ", "Large\nSmall"])
      expect(refused({ kind: "browser_select", index: 2, option }, at)).toMatch(
        /on one line/,
      );
  });
  it("presses a key of the page, written one way", () => {
    const at = able({ page: read });
    for (const [said, key] of [
      ["Enter", "Enter"],
      ["return", "Enter"],
      ["esc", "Escape"],
      ["shift + tab", "Shift+Tab"],
      ["arrowdown", "ArrowDown"],
      ["Down", "ArrowDown"],
      ["PAGEUP", "PageUp"],
      ["space", "Space"],
    ])
      expect(run({ kind: "browser_key", combo: said! }, at)).toMatchObject({
        label: `Press ${key} on the page`,
        target: key,
        signature: `browser_key|${key}`,
        send: { via: "browser", call: { name: "key", combo: key } },
      });
    for (const combo of ["cmd+q", "a", "Delete", "F5", "ctrl+Enter", ""])
      expect(refused({ kind: "browser_key", combo }, at)).toMatch(
        /not a key that a page takes/,
      );
    expect(refused({ kind: "browser_key", combo: "Enter" }, able())).toMatch(
      /read the page first/i,
    );
  });
  it("asks before Enter or Space while the page has a control that a click asks about", () => {
    const at = able({ page: shop });
    for (const combo of ["Enter", "Space"])
      expect(run({ kind: "browser_key", combo }, at).risk).toMatch(
        /This key can press "Pay now"/,
      );
    for (const combo of ["Enter", "Space"])
      expect(
        run({ kind: "browser_key", combo }, able({ page: read })).risk,
      ).toBeNull();
    // Keys that press nothing do not ask.
    for (const combo of ["Tab", "Escape", "ArrowDown", "PageDown", "Backspace"])
      expect(run({ kind: "browser_key", combo }, at).risk).toBeNull();
    // A plain close control only takes a view away; a close of something else asks.
    const banner = page([pageElement(0, { label: "Close" })]);
    expect(
      run({ kind: "browser_key", combo: "Enter" }, able({ page: banner })).risk,
    ).toBeNull();
    const account = page([pageElement(0, { label: "Close account" })]);
    expect(
      run({ kind: "browser_key", combo: "Enter" }, able({ page: account }))
        .risk,
    ).toMatch(/This key can press "Close account"/);
    // A field and a disabled control are not pressed by a key.
    const fields = page([
      pageElement(0, { label: "Delete reason", tag: "input", role: "textbox" }),
      pageElement(1, { label: "Send", disabled: true }),
    ]);
    expect(
      run({ kind: "browser_key", combo: "Enter" }, able({ page: fields })).risk,
    ).toBeNull();
  });
  it("waits and lists the tabs with no effect: no yes, no row, no page needed", () => {
    for (const raw of [
      { kind: "browser_wait", ms: 2000 },
      { kind: "browser_wait", ms: 2000, text: "Order placed" },
      { kind: "browser_tabs" },
    ]) {
      const result = run(raw, able());
      expect(result.risk).toBeNull();
      expect(result.signature).toBeNull();
      expect(result.target).toBe("");
    }
    expect(
      run({ kind: "browser_wait", ms: 2000, text: " Order  placed " }, able())
        .send,
    ).toEqual({
      via: "browser",
      call: { name: "wait", text: "Order placed", ms: 2000 },
    });
    expect(run({ kind: "browser_wait", ms: 300 }, able()).send).toEqual({
      via: "browser",
      call: { name: "wait", text: null, ms: 300 },
    });
    for (const text of ["", " ", "a\nb"])
      expect(refused({ kind: "browser_wait", ms: 300, text }, able())).toMatch(
        /one line/,
      );
  });
  it("switches to a tab of the last list, with no yes", () => {
    expect(
      run({ kind: "browser_switch_tab", tab: 1 }, able({ page: listed })),
    ).toMatchObject({
      label: 'Switch to the tab "Inbox"',
      target: "Inbox",
      risk: null,
      send: {
        via: "browser",
        call: { name: "switch_tab", tab: 1, listed: tabs[0] },
      },
    });
    expect(
      refused({ kind: "browser_switch_tab", tab: 3 }, able({ page: listed })),
    ).toMatch(/no tab 3/);
    expect(
      refused({ kind: "browser_switch_tab", tab: 1 }, able({ page: read })),
    ).toMatch(/list the tabs first/i);
  });
  it("knows which calls change nothing, and which are checked against a new reading first", () => {
    const element = pageElement(1);
    const calls: [BrowserCall, boolean, boolean][] = [
      [{ name: "read" }, true, false],
      [{ name: "wait", text: null, ms: 100 }, true, false],
      [{ name: "tabs" }, true, false],
      [{ name: "scroll", direction: "down" }, false, false],
      [{ name: "back" }, false, false],
      [{ name: "open", url: "https://example.com" }, false, false],
      [{ name: "click", index: 1, element }, false, true],
      [
        { name: "type", index: 1, text: "a", submit: false, element },
        false,
        true,
      ],
      [{ name: "hover", index: 1, element }, false, true],
      [{ name: "select", index: 1, option: "A", element }, false, true],
      [{ name: "key", combo: "Enter" }, false, true],
      [{ name: "switch_tab", tab: 1, listed: tabs[0]! }, false, true],
    ];
    for (const [call, quiet, reads] of calls) {
      expect(quietCall(call)).toBe(quiet);
      expect(readsBeforeCall(call)).toBe(reads);
    }
  });
  it("finds the target again in a newer reading, or says that it is gone", () => {
    const menu = pageElement(1, { label: "Menu" });
    const hover = { kind: "browser_hover", index: 1 } as const;
    expect(
      againstPage(
        hover,
        { name: "hover", index: 1, element: menu },
        page([pageElement(4, { label: "Menu" })]),
      ),
    ).toEqual({ kind: "browser_hover", index: 4 });
    expect(
      againstPage(
        hover,
        { name: "hover", index: 1, element: menu },
        page([pageElement(4, { label: "Other" })]),
      ),
    ).toBeNull();
    const switching = { kind: "browser_switch_tab", tab: 1 } as const;
    const call: BrowserCall = { name: "switch_tab", tab: 1, listed: tabs[0]! };
    // The tab moved to another place: it is found by its address and title.
    const moved = [
      { ...tabs[1]!, index: 1 },
      { ...tabs[0]!, index: 2 },
    ];
    expect(againstPage(switching, call, page([], { tabs: moved }))).toEqual({
      kind: "browser_switch_tab",
      tab: 2,
    });
    expect(
      againstPage(switching, call, page([], { tabs: [tabs[1]!] })),
    ).toBeNull();
    expect(againstPage(switching, call, page([]))).toBeNull();
    const twins = [
      { ...tabs[0]!, index: 3 },
      { ...tabs[0]!, index: 4 },
    ];
    expect(sameTab(tabs[0]!, twins)).toBeNull();
    expect(sameTab(tabs[0]!, [...twins, tabs[0]!])).toEqual(tabs[0]);
    // A key has no target: it is checked again against the newer reading.
    const key = { kind: "browser_key", combo: "Enter" } as const;
    expect(againstPage(key, { name: "key", combo: "Enter" }, page())).toBe(key);
  });
  it("reads which optional methods a driver has", () => {
    const base = {
      doctor: async () => ({ ok: true, browser: null, reason: "" }),
      open: async () => page(),
      read: async () => page(),
      click: async () => page(),
      type: async () => page(),
      scroll: async () => page(),
      back: async () => page(),
    } satisfies BrowserPort;
    expect(browserMethods(undefined)).toEqual([]);
    expect(browserMethods(base)).toEqual([]);
    expect(
      browserMethods({
        ...base,
        tabs: async () => page(),
        key: async () => page(),
      }),
    ).toEqual(["key", "tabs"]);
  });
});

describe("the look just before a hover or a drag", () => {
  const before = observation([
    element(1, { title: "Card", x: 100, y: 100, w: 100, h: 40 }),
    element(2, { title: "Done", x: 600, y: 100, w: 200, h: 300 }),
  ]);
  const drag = {
    kind: "drag",
    from: { element: 1 },
    to: { element: 2 },
  } as const;
  it("finds both ends of a drag again under new numbers", () => {
    const after = observation([
      element(7, { title: "Done", x: 600, y: 100, w: 200, h: 300 }),
      element(8, { title: "Card", x: 100, y: 100, w: 100, h: 40 }),
    ]);
    expect(retarget(drag, before, after)).toMatchObject({
      ok: true,
      action: { from: { element: 8 }, to: { element: 7 } },
    });
  });
  it("refuses a drag when either end is gone, or when two could be it", () => {
    for (const after of [
      observation([
        element(1, { title: "Card", x: 100, y: 100, w: 100, h: 40 }),
      ]),
      observation([
        element(2, { title: "Done", x: 600, y: 100, w: 200, h: 300 }),
      ]),
      observation([
        element(1, { title: "Card", x: 10, y: 500 }),
        element(3, { title: "Card", x: 900, y: 500 }),
        element(2, { title: "Done", x: 600, y: 100, w: 200, h: 300 }),
      ]),
    ])
      expect(retarget(drag, before, after)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/no longer there/),
      });
  });
  it("refuses a drag to a point when what lies there changed", () => {
    // Image point (600, 200) is screen point (675, 225): inside Done.
    const toPoint = {
      kind: "drag",
      from: { element: 1 },
      to: { x: 600, y: 200 },
    } as const;
    expect(retarget(toPoint, before, before)).toMatchObject({ ok: true });
    const replaced = observation([
      element(1, { title: "Card", x: 100, y: 100, w: 100, h: 40 }),
      element(2, { title: "Trash", x: 600, y: 100, w: 200, h: 300 }),
    ]);
    expect(retarget(toPoint, before, replaced)).toMatchObject({ ok: false });
  });
  it("finds the element of a hover again, and refuses one that is gone", () => {
    const after = observation([
      element(5, { title: "Card", x: 100, y: 100, w: 100, h: 40 }),
    ]);
    expect(
      retarget({ kind: "hover", element: 1 }, before, after),
    ).toMatchObject({ ok: true, action: { kind: "hover", element: 5 } });
    expect(
      retarget(
        { kind: "hover", element: 1 },
        before,
        observation([element(5, { title: "Other" })]),
      ),
    ).toMatchObject({ ok: false });
  });
  it("refuses a hover at a point when what lies there changed", () => {
    const hover = { kind: "hover", x: 120, y: 98 } as const;
    expect(retarget(hover, before, before)).toMatchObject({ ok: true });
    expect(
      retarget(
        hover,
        before,
        observation([
          element(1, { title: "Delete", x: 100, y: 100, w: 100, h: 40 }),
        ]),
      ),
    ).toMatchObject({ ok: false });
  });
  it("refuses a hover and a drag when another window came to the front", () => {
    const other = { ...before, app: { ...before.app, window: "Other" } };
    for (const action of [drag, { kind: "hover", element: 1 } as const])
      expect(retarget(action, before, other)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/front/),
      });
  });
});
