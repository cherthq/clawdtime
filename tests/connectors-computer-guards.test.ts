import { describe, expect, it } from "vitest";
import {
  check,
  dangerWords,
  parseCombo,
  retarget,
  type View,
} from "../connectors/computer/guards.js";
import type { Observation } from "../connectors/computer/ports.js";
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
    expect(dangerWords).toContain("close");
    expect(dangerWords).toContain("terminate");
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
  it("opens only http and https", () => {
    for (const kind of ["open_url", "browser_open"]) {
      expect(run({ kind, url: "https://example.com/a?b=1" }).risk).toBeNull();
      expect(run({ kind, url: "http://example.com" }).risk).toBeNull();
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
    const opened = run({ kind: "open_url", url: "https://example.com/a?b=1" });
    // The record keeps the site, not the path or the query.
    expect(opened.target).toBe("example.com");
    expect(opened.send).toEqual({
      via: "hands",
      look: false,
      command: { kind: "open_url", url: "https://example.com/a?b=1" },
    });
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
