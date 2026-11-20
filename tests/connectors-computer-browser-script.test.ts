import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  AppleEventsBrowser,
  probeScript,
} from "../connectors/computer/browser.js";
import {
  pageHelpers,
  pageLimits,
  pageScript,
  type PageCall,
} from "../connectors/computer/browser-script.js";

/**
 * No test here touches a browser. The page script runs in Node, in its own
 * context, against a small hand-made document. That document holds only the
 * few calls that the script uses, each with the behavior that a browser gives
 * it: layout boxes, computed style, event dispatch with bubbling, the value
 * setter on the prototype, and what a click does to a checkbox or a link.
 */
type Child = FakeElement | string;
type Listener = (event: FakeEvent) => void;

class FakeEvent {
  defaultPrevented = false;
  target: FakeElement | null = null;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  constructor(
    readonly type: string,
    readonly init: Record<string, unknown> = {},
  ) {
    this.bubbles = init.bubbles === true;
    this.cancelable = init.cancelable === true;
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
}
class FakeMouseEvent extends FakeEvent {}
class FakePointerEvent extends FakeMouseEvent {}
class FakeInputEvent extends FakeEvent {}
class FakeKeyboardEvent extends FakeEvent {}

/** Tags that sit in a line of text, and tags of a drawing, which have no click of their own. */
const inlineTags = new Set(["a", "span", "b", "img", "input", "button"]);
const drawingTags = new Set(["svg", "title", "path"]);
const noBox = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  /** The element that carries the shadow tree which this element is in. */
  host: FakeElement | null = null;
  /** Set on the body only. */
  page: FakePage | null = null;
  ownText = "";
  /** Where it lies on the page, before any scrolling. */
  box = { left: 0, top: 0, width: 120, height: 20 };
  display = "block";
  /** Empty: as its parent. */
  visibility = "";
  overflowY = "visible";
  textSecurity = "none";
  shadowRoot: FakeShadow | null = null;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  /** Absent on the elements of a drawing, as in a browser. */
  click?: () => void;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly localName: string,
    attributes: Record<string, string> = {},
    children: Child[] = [],
  ) {
    for (const [name, value] of Object.entries(attributes))
      this.attributes.set(name, value);
    for (const child of children) this.append(child);
    if (!drawingTags.has(localName)) this.click = () => this.press();
  }

  append(child: Child) {
    if (typeof child === "string") this.ownText += child;
    else {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }
  appendChild(node: FakeElement | { text: string }) {
    if (node instanceof FakeElement) this.append(node);
    else this.ownText += node.text;
    return node;
  }
  remove() {
    const siblings = this.parentElement?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  at(top: number, left = 0, width = 120, height = 20) {
    this.box = { left, top, width, height };
    return this;
  }
  set(change: (element: this) => void) {
    change(this);
    return this;
  }

  get id() {
    return this.attributes.get("id") ?? "";
  }
  /** The name that the log of a test uses. */
  get called() {
    return this.id || this.localName;
  }
  get href() {
    return this.localName === "a" ? this.attributes.get("href") : undefined;
  }
  get up(): FakeElement | null {
    return this.parentElement ?? this.host;
  }
  get owner(): FakePage | null {
    let top: FakeElement = this;
    while (top.up) top = top.up;
    return top.page;
  }
  get isConnected() {
    return this.owner !== null;
  }
  get isContentEditable(): boolean {
    const own = this.attributes.get("contenteditable");
    if (own !== undefined) return own !== "false";
    return this.parentElement?.isContentEditable ?? false;
  }
  rendered() {
    for (let at: FakeElement | null = this; at; at = at.up)
      if (at.display === "none") return false;
    return this.isConnected;
  }
  shownVisibility() {
    for (let at: FakeElement | null = this; at; at = at.up)
      if (at.visibility) return at.visibility;
    return "visible";
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  getBoundingClientRect() {
    const page = this.owner;
    if (!page || !this.rendered()) return noBox;
    const top = this.box.top - page.scrollY;
    return {
      left: this.box.left,
      top,
      right: this.box.left + this.box.width,
      bottom: top + this.box.height,
      width: this.box.width,
      height: this.box.height,
    };
  }
  /** The text that shows. A drawing has none of its own, as in a browser. */
  get innerText(): string | undefined {
    if (drawingTags.has(this.localName)) return undefined;
    if (!this.rendered() || this.shownVisibility() === "hidden") return "";
    let text = this.ownText;
    for (const child of this.children) {
      const part = child.innerText;
      if (!part) continue;
      text +=
        (text ? (inlineTags.has(child.localName) ? " " : "\n") : "") + part;
    }
    return text;
  }
  get textContent(): string {
    return [this.ownText, ...this.children.map((child) => child.textContent)]
      .filter(Boolean)
      .join(" ");
  }
  contains(other: FakeElement | null) {
    for (let at = other; at; at = at.parentElement)
      if (at === this) return true;
    return false;
  }
  fits(selector: string) {
    const attribute = /^\[([a-z-]+)\]$/.exec(selector);
    if (attribute) return this.attributes.has(attribute[1]!);
    if (!/^(\*|[a-z0-9-]+)$/.test(selector))
      throw new Error(`The hand-made document does not know ${selector}`);
    return selector === "*" || selector === this.localName;
  }
  closest(selector: string) {
    for (let at: FakeElement | null = this; at; at = at.parentElement)
      if (at.fits(selector)) return at;
    return null;
  }
  matches(selector: string) {
    if (selector !== ":disabled")
      throw new Error(`The hand-made document does not know ${selector}`);
    return this.unusable();
  }
  unusable() {
    return false;
  }
  querySelectorAll(selector: string) {
    const found: FakeElement[] = [];
    const walk = (element: FakeElement) => {
      for (const child of element.children) {
        if (child.fits(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  getRootNode() {
    return this.owner;
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatchEvent(event: FakeEvent) {
    event.target ??= this;
    this.owner?.record(event, this);
    for (
      let at: FakeElement | null = this;
      at;
      at = event.bubbles ? at.up : null
    )
      for (const listener of at.listeners.get(event.type) ?? [])
        listener(event);
    return !event.defaultPrevented;
  }
  focus() {
    const page = this.owner;
    if (!page) return;
    page.activeElement = this;
    page.log.push(`focus@${this.called}`);
  }
  scrollIntoView() {
    const page = this.owner;
    if (!page) return;
    page.log.push(`scrollIntoView@${this.called}`);
    page.scrollTo(this.box.top + this.box.height / 2 - page.innerHeight / 2);
  }
  scrollBy(move: { top: number }) {
    this.owner?.log.push(`scrollBy@${this.called} ${move.top}`);
    this.scrollTop = Math.max(
      0,
      Math.min(
        this.scrollHeight - this.clientHeight,
        this.scrollTop + move.top,
      ),
    );
  }
  /** What a browser does for click(): the event, then what the element does. */
  press() {
    if (this.dispatchEvent(new FakeMouseEvent("click", clickInit)))
      this.activate();
  }
  activate() {
    const link = this.closest("a");
    if (link?.href) this.owner?.followed.push(link.href);
  }
}
const clickInit = { bubbles: true, cancelable: true };

class FakeShadow {
  constructor(
    host: FakeElement,
    private readonly children: FakeElement[],
  ) {
    for (const child of children) child.host = host;
    host.shadowRoot = this;
  }
  querySelectorAll(selector: string) {
    return this.children.flatMap((child) => [
      ...(child.fits(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

/** A button, a field or a select: it can be disabled, and it knows its form and its labels. */
class FakeControl extends FakeElement {
  get disabled() {
    return this.hasAttribute("disabled");
  }
  override unusable() {
    return (
      this.disabled ||
      this.closest("fieldset")?.hasAttribute("disabled") === true
    );
  }
  get form() {
    return this.closest("form");
  }
  get labels() {
    return (this.owner?.all() ?? []).filter(
      (element) =>
        element.localName === "label" &&
        ((this.id !== "" && element.getAttribute("for") === this.id) ||
          element.contains(this)),
    );
  }
}

const inputTypes = new Set([
  "button",
  "checkbox",
  "date",
  "email",
  "file",
  "hidden",
  "image",
  "number",
  "password",
  "radio",
  "range",
  "reset",
  "search",
  "submit",
  "tel",
  "text",
  "url",
]);

class FakeInput extends FakeControl {
  held: string;
  checked: boolean;
  constructor(attributes: Record<string, string> = {}) {
    super("input", attributes);
    this.held = attributes.value ?? "";
    this.checked = "checked" in attributes;
  }
  get type() {
    const given = (this.getAttribute("type") ?? "").toLowerCase();
    return inputTypes.has(given) ? given : "text";
  }
  /** The value lives on the prototype, as in a browser, so a page can shadow it on one element. */
  get value() {
    return this.held;
  }
  set value(next: string) {
    const text = String(next);
    // A number field drops what is not a number.
    this.held =
      this.type === "number" && !/^-?\d+(\.\d+)?$/.test(text) ? "" : text;
  }
  get readOnly() {
    return this.hasAttribute("readonly");
  }
  override press() {
    if (this.type !== "checkbox") return super.press();
    this.checked = !this.checked;
    if (!this.dispatchEvent(new FakeMouseEvent("click", clickInit))) {
      this.checked = !this.checked;
      return;
    }
    this.dispatchEvent(new FakeEvent("input", { bubbles: true }));
    this.dispatchEvent(new FakeEvent("change", { bubbles: true }));
  }
}

class FakeTextArea extends FakeControl {
  held: string;
  constructor(attributes: Record<string, string> = {}, text = "") {
    super("textarea", attributes);
    this.held = text;
  }
  get value() {
    return this.held;
  }
  set value(next: string) {
    this.held = String(next);
  }
  get readOnly() {
    return this.hasAttribute("readonly");
  }
}

class FakeOption extends FakeElement {
  constructor(text: string, attributes: Record<string, string> = {}) {
    super("option", attributes, [text]);
  }
  get text() {
    return this.ownText;
  }
  get value() {
    return this.getAttribute("value") ?? this.ownText;
  }
  get disabled() {
    return this.hasAttribute("disabled");
  }
}

class FakeSelect extends FakeControl {
  selectedIndex: number;
  constructor(attributes: Record<string, string>, options: FakeOption[]) {
    super("select", attributes, options);
    this.selectedIndex = Math.max(
      0,
      options.findIndex((option) => option.hasAttribute("selected")),
    );
  }
  get options() {
    return this.children as FakeOption[];
  }
  get multiple() {
    return this.hasAttribute("multiple");
  }
  get size() {
    return Number(this.getAttribute("size") ?? 0);
  }
  get value() {
    return this.options[this.selectedIndex]?.value ?? "";
  }
  // The choices of a closed select do not show as text.
  override get innerText() {
    return "";
  }
}

class FakeForm extends FakeElement {
  requestSubmit?: () => void = () => {
    this.owner?.log.push(`requestSubmit@${this.called}`);
    this.dispatchEvent(
      new FakeEvent("submit", { bubbles: true, cancelable: true }),
    );
  };
  submit() {
    this.owner?.log.push(`submit()@${this.called}`);
  }
}

const h = (
  tag: string,
  attributes: Record<string, string> = {},
  ...children: Child[]
): FakeElement =>
  tag === "button" || tag === "fieldset"
    ? new FakeControl(tag, attributes, children)
    : new FakeElement(tag, attributes, children);
const input = (attributes: Record<string, string> = {}) =>
  new FakeInput(attributes);
const textarea = (attributes: Record<string, string> = {}, text = "") =>
  new FakeTextArea(attributes, text);
const select = (attributes: Record<string, string>, ...options: FakeOption[]) =>
  new FakeSelect(attributes, options);
const option = (text: string, attributes: Record<string, string> = {}) =>
  new FakeOption(text, attributes);
const form = (attributes: Record<string, string>, ...children: Child[]) =>
  new FakeForm("form", attributes, children);

interface Entry {
  index: number;
  tag: string;
  role: string;
  label: string;
  value?: string;
  href?: string;
  disabled: boolean;
  password: boolean;
}
interface Answer {
  ok: boolean;
  error?: string;
  ready?: boolean;
  next?: number;
  page?: { title: string; url: string; text: string; elements: Entry[] };
}

/** The document and its window. */
class FakePage {
  title = "A page";
  url = "https://example.test/start";
  readyState = "complete";
  innerWidth = 1000;
  innerHeight = 600;
  /** The height of the whole document. */
  height = 600;
  scrollY = 0;
  historyLength = 3;
  activeElement: FakeElement | null = null;
  /** Whether the browser's own command to insert text works here. */
  insertTextWorks = true;
  readonly log: string[] = [];
  readonly events: FakeEvent[] = [];
  /** The addresses of the links that a click followed. */
  readonly followed: string[] = [];
  readonly body: FakeElement;
  readonly scrollingElement: object;
  private readonly onWindow = new Map<string, Listener[]>();
  private readonly context: vm.Context;

  constructor(...children: Child[]) {
    this.body = new FakeElement("body", {}, children).at(0, 0, 1000, 600);
    this.body.page = this;
    const page = this;
    this.scrollingElement = {
      get scrollTop() {
        return page.scrollY;
      },
      get clientHeight() {
        return page.innerHeight;
      },
      get scrollHeight() {
        return page.height;
      },
    };
    const window: Record<string, unknown> = {
      document: this,
      get innerWidth() {
        return page.innerWidth;
      },
      get innerHeight() {
        return page.innerHeight;
      },
      location: {
        get href() {
          return page.url;
        },
      },
      history: {
        get length() {
          return page.historyLength;
        },
        back: () => this.log.push("history.back"),
      },
      getComputedStyle: (element: FakeElement) => ({
        display: element.display,
        visibility: element.shownVisibility(),
        overflowY: element.overflowY,
        webkitTextSecurity: element.textSecurity,
      }),
      getSelection: () => ({
        selectAllChildren: (element: FakeElement) =>
          this.log.push(`selectAllChildren@${element.called}`),
        collapseToEnd: () => this.log.push("collapseToEnd"),
      }),
      scrollBy: (move: { top: number }) => {
        this.log.push(`scrollBy ${move.top}`);
        this.scrollTo(this.scrollY + move.top);
      },
      addEventListener: (type: string, listener: Listener) =>
        this.onWindow.set(type, [...(this.onWindow.get(type) ?? []), listener]),
      Event: FakeEvent,
      MouseEvent: FakeMouseEvent,
      PointerEvent: FakePointerEvent,
      InputEvent: FakeInputEvent,
      KeyboardEvent: FakeKeyboardEvent,
      HTMLInputElement: FakeInput,
      HTMLTextAreaElement: FakeTextArea,
    };
    window.window = window;
    this.context = vm.createContext(window);
  }

  get documentElement() {
    return { clientWidth: this.innerWidth, clientHeight: this.innerHeight };
  }
  all() {
    return [this.body, ...this.body.querySelectorAll("*")];
  }
  querySelectorAll(selector: string) {
    return this.all().filter((element) => element.fits(selector));
  }
  getElementById(id: string) {
    return this.all().find((element) => element.id === id) ?? null;
  }
  /** The last element in page order whose box holds the point: the one on top. */
  elementFromPoint(x: number, y: number) {
    let hit: FakeElement | null = null;
    for (const element of this.all()) {
      const box = element.getBoundingClientRect();
      if (
        box.width > 0 &&
        x >= box.left &&
        x <= box.right &&
        y >= box.top &&
        y <= box.bottom
      )
        hit = element;
    }
    return hit;
  }
  execCommand(command: string, _show: boolean, text: string) {
    this.log.push(`execCommand ${command}`);
    const into = this.activeElement;
    if (!this.insertTextWorks || command !== "insertText" || !into)
      return false;
    into.ownText += text;
    into.dispatchEvent(
      new FakeInputEvent("input", { bubbles: true, data: text }),
    );
    return true;
  }
  createTextNode(text: string) {
    return { text };
  }
  scrollTo(top: number) {
    this.scrollY = Math.max(0, Math.min(this.height - this.innerHeight, top));
  }
  record(event: FakeEvent, target: FakeElement) {
    this.events.push(event);
    this.log.push(`${event.type}@${target.called}`);
  }
  /** An event of the window, for example beforeunload when the page starts to leave. */
  fire(type: string) {
    for (const listener of this.onWindow.get(type) ?? [])
      listener(new FakeEvent(type));
  }
  /** Runs one script as the browser does: the value of its last expression comes back. */
  evaluate(script: string) {
    return vm.runInContext(script, this.context) as unknown;
  }
  run(call: PageCall, session = { session: "s1", start: 1 }) {
    return JSON.parse(
      String(this.evaluate(pageScript(call, session))),
    ) as Answer;
  }
  /** One reading, which must work. */
  read(session = { session: "s1", start: 1 }) {
    const answer = this.run({ do: "read" }, session);
    if (!answer.ok || !answer.page)
      throw new Error(`The reading failed: ${answer.error}`);
    return answer.page;
  }
  labels() {
    return this.read().elements.map((element) => element.label);
  }
}

const entry = (values: Partial<Entry>): Entry => ({
  index: 1,
  tag: "button",
  role: "button",
  label: "",
  disabled: false,
  password: false,
  ...values,
});

describe("the page script: its pure helpers", () => {
  it("makes one clean line and never cuts a character in half", () => {
    const { oneLine } = pageHelpers;
    expect(oneLine("  Save\n\tthe   file\u00a0now\u200b ", 120)).toBe(
      "Save the file now",
    );
    expect(oneLine("a\u0000b\u0007c\u202ed", 120)).toBe("a b c d");
    expect(oneLine(null, 10)).toBe("");
    expect(oneLine(undefined, 10)).toBe("");
    expect(oneLine(42, 10)).toBe("42");
    expect(oneLine("x".repeat(200), 120)).toBe("x".repeat(120));
    expect(oneLine("one two three", 4)).toBe("one");
    // A character of two units stays whole or goes.
    expect(oneLine("ab\u{1f600}", 3)).toBe("ab");
    expect(oneLine("ab\u{1f600}", 4)).toBe("ab\u{1f600}");
  });

  it("keeps the lines of a text, each one clean, up to the limit", () => {
    const { textBlock } = pageHelpers;
    expect(textBlock(" Orders \r\n\r\n\n  Three   wait.\u2028End ", 100)).toBe(
      "Orders\nThree wait.\nEnd",
    );
    expect(textBlock("word ".repeat(3000), 6000)).toHaveLength(5999);
    expect(textBlock(null, 10)).toBe("");
  });

  it("writes an answer in plain characters only, and it reads back the same", () => {
    const { encode } = pageHelpers;
    const awkward =
      "He said \"hi\" \\ 'yes' \\n\n\r\ttab \u2028\u2029 \u0000 \u00e9 \u65e5\u672c \u{1f600} </script> ${x} `tick` \ud83d";
    const written = encode({
      text: awkward,
      count: 3,
      list: [true, false, null, 1.5, "a"],
      none: undefined,
      not: Number.NaN,
      inner: { "a key": "v" },
    });
    expect(written).toMatch(/^[\x20-\x7e]*$/);
    expect(JSON.parse(written)).toEqual({
      text: awkward,
      count: 3,
      list: [true, false, null, 1.5, "a"],
      not: null,
      inner: { "a key": "v" },
    });
    // It is also an expression of JavaScript, which is how it reaches the page.
    expect(vm.runInNewContext(`(${written}).text`)).toBe(awkward);
    expect(encode("x")).toBe('"x"');
    expect(encode(null)).toBe("null");
    expect(encode(undefined)).toBe("null");
  });

  it("takes the first label that is not empty", () => {
    const { firstLine } = pageHelpers;
    expect(
      firstLine(["", " \n ", null, " Close\n dialog ", "Other"], 120),
    ).toBe("Close dialog");
    expect(firstLine([], 120)).toBe("");
    expect(firstLine(["x".repeat(300)], 120)).toHaveLength(120);
  });

  it("names the role of an element, or says that it is not one to list", () => {
    const { roleFor } = pageHelpers;
    const facts = {
      tag: "div",
      type: "",
      role: "",
      href: false,
      editable: false,
      list: false,
    };
    expect(roleFor({ ...facts, tag: "a", href: true })).toBe("link");
    expect(roleFor({ ...facts, tag: "a" })).toBeNull();
    expect(roleFor({ ...facts, tag: "button" })).toBe("button");
    expect(roleFor({ ...facts, tag: "textarea" })).toBe("textbox");
    expect(roleFor({ ...facts, tag: "select" })).toBe("combobox");
    expect(roleFor({ ...facts, tag: "select", list: true })).toBe("listbox");
    expect(roleFor({ ...facts, editable: true })).toBe("textbox");
    expect(roleFor(facts)).toBeNull();
    const types: Record<string, string | null> = {
      text: "textbox",
      email: "textbox",
      password: "textbox",
      search: "searchbox",
      number: "spinbutton",
      range: "slider",
      checkbox: "checkbox",
      radio: "radio",
      submit: "button",
      button: "button",
      reset: "button",
      image: "button",
      file: "button",
      hidden: null,
    };
    for (const [type, role] of Object.entries(types))
      expect(roleFor({ ...facts, tag: "input", type })).toBe(role);
    for (const role of [
      "button",
      "link",
      "checkbox",
      "radio",
      "tab",
      "menuitem",
      "option",
      "switch",
    ])
      expect(roleFor({ ...facts, role })).toBe(role);
    expect(roleFor({ ...facts, role: " TAB  extra" })).toBe("tab");
    for (const role of ["heading", "textbox", "constructor", "x y", "b<u>"])
      expect(roleFor({ ...facts, role })).toBeNull();
    // A role that the page gives wins over the role of the tag.
    expect(roleFor({ ...facts, tag: "a", href: true, role: "button" })).toBe(
      "button",
    );
    expect(roleFor({ ...facts, tag: "button", role: "b<u>" })).toBe("button");
  });

  it("knows what lies in the viewport, and puts that first", () => {
    const { inView, arrange } = pageHelpers;
    const box = (top: number, left = 0) => ({
      top,
      left,
      bottom: top + 20,
      right: left + 100,
    });
    expect(inView(box(0), 1000, 600)).toBe(true);
    expect(inView(box(599), 1000, 600)).toBe(true);
    expect(inView(box(600), 1000, 600)).toBe(false);
    expect(inView(box(-20), 1000, 600)).toBe(false);
    expect(inView(box(-19), 1000, 600)).toBe(true);
    expect(inView(box(10, 1000), 1000, 600)).toBe(false);
    expect(inView(box(10, -100), 1000, 600)).toBe(false);
    const items = [
      { name: "a", near: false },
      { name: "b", near: true },
      { name: "c", near: false },
      { name: "d", near: true },
    ];
    expect(arrange(items, 10).map((item) => item.name)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
    expect(arrange(items, 3).map((item) => item.name)).toEqual(["b", "d", "a"]);
  });
});

describe("the page script: one call is one script", () => {
  it("is one expression of plain characters, whatever the call holds", () => {
    const script = pageScript(
      {
        do: "type",
        index: 3,
        text: '\u65e5\u672c "q" \\ \n ` ${x} \u2028 \u{1f600}',
        submit: true,
      },
      { session: 's"1', start: 7 },
    );
    expect(script).toMatch(/^[\x20-\x7e\n]*$/);
    expect(script.startsWith("(function (call) {")).toBe(true);
    expect(script.endsWith(")")).toBe(true);
    expect(script.startsWith("-")).toBe(false);
  });

  it("answers with one line of plain characters", () => {
    const page = new FakePage(h("button", {}, "\u65e5\u672c\n\u{1f600}"));
    const raw = page.evaluate(
      pageScript({ do: "read" }, { session: "s1", start: 1 }),
    );
    expect(typeof raw).toBe("string");
    expect(raw).toMatch(/^[\x20-\x7e]*$/);
    expect(page.labels()).toEqual(["\u65e5\u672c \u{1f600}"]);
  });

  it("answers a call that it does not know, and a failure, without page content", () => {
    const page = new FakePage(
      h("button", { id: "b" }, "Secret plan").set((element) => {
        element.getBoundingClientRect = () => {
          throw new TypeError("Secret plan cannot be measured");
        };
      }),
    );
    expect(page.run({ do: "dance" } as unknown as PageCall)).toEqual({
      ok: false,
      error: "The page was asked for a step that it does not know.",
    });
    expect(page.run({ do: "read" })).toEqual({
      ok: false,
      error: "The page script stopped with TypeError. Read the page again.",
    });
    expect(page.run({ do: "ping" } as PageCall)).toEqual({ ok: true });
  });
});

describe("the page script: read", () => {
  it("reads the title, the address, the visible text and the elements", () => {
    const page = new FakePage(
      h("h1", {}, "Orders"),
      h("p", {}, "Three   orders wait."),
      h("p", {}, "A hidden note").set((element) => {
        element.display = "none";
      }),
      h("a", { id: "home", href: "https://example.test/home" }, "Home"),
      h("button", { id: "save" }, "Save"),
      input({ type: "search", placeholder: "Search orders", value: "tea" }),
    );
    page.title = "  Orders\n today ";
    expect(page.run({ do: "read" })).toEqual({
      ok: true,
      ready: true,
      next: 4,
      page: {
        title: "Orders today",
        url: "https://example.test/start",
        text: "Orders\nThree orders wait. Home Save",
        elements: [
          entry({
            index: 1,
            tag: "a",
            role: "link",
            label: "Home",
            href: "https://example.test/home",
          }),
          entry({ index: 2, label: "Save" }),
          entry({
            index: 3,
            tag: "input",
            role: "searchbox",
            label: "Search orders",
            value: "tea",
          }),
        ],
      },
    });
  });

  it("lists what a person could click or fill, and nothing else", () => {
    const page = new FakePage(
      h("a", { href: "/a" }, "A link"),
      h("a", {}, "An anchor with no address"),
      h("button", {}, "A button"),
      input({ type: "text", "aria-label": "A field" }),
      input({ type: "hidden", name: "token", value: "t0k3n" }),
      textarea({ "aria-label": "A text area" }, "notes"),
      select({ "aria-label": "A select" }, option("One"), option("Two")),
      h(
        "div",
        { contenteditable: "true", "aria-label": "A region" },
        "Dear all",
        h("b", {}, "bold"),
      ),
      h("div", { contenteditable: "false" }, "Not editable"),
      h("div", { role: "button" }, "Role button"),
      h("span", { role: "link" }, "Role link"),
      h("div", { role: "checkbox", "aria-checked": "true" }, "Role checkbox"),
      h("div", { role: "radio", "aria-checked": "false" }, "Role radio"),
      h("div", { role: "tab", "aria-selected": "true" }, "Role tab"),
      h("li", { role: "menuitem" }, "Role menu item"),
      h("li", { role: "option" }, "Role option"),
      h("div", { role: "switch", "aria-checked": "mixed" }, "Role switch"),
      h("my-button", { role: " BUTTON " }, "Custom"),
      h("div", { role: "heading" }, "A heading"),
      h("span", {}, "Plain text"),
      h("label", {}, "A label alone"),
    );
    expect(
      page
        .read()
        .elements.map((element) => [
          element.tag,
          element.role,
          element.label,
          element.value,
        ]),
    ).toEqual([
      ["a", "link", "A link", undefined],
      ["button", "button", "A button", undefined],
      ["input", "textbox", "A field", ""],
      ["textarea", "textbox", "A text area", "notes"],
      ["select", "combobox", "A select", "One"],
      ["div", "textbox", "A region", "Dear all bold"],
      ["div", "button", "Role button", undefined],
      ["span", "link", "Role link", undefined],
      ["div", "checkbox", "Role checkbox", "checked"],
      ["div", "radio", "Role radio", "not checked"],
      ["div", "tab", "Role tab", "selected"],
      ["li", "menuitem", "Role menu item", undefined],
      ["li", "option", "Role option", undefined],
      ["div", "switch", "Role switch", "partly checked"],
      ["my-button", "button", "Custom", undefined],
    ]);
  });

  it("finds elements inside an open shadow tree", () => {
    const host = h("my-card", {});
    new FakeShadow(host, [h("button", { id: "inner" }, "Inside the card")]);
    const page = new FakePage(host, h("button", {}, "Outside"));
    expect(page.labels()).toEqual(["Inside the card", "Outside"]);
    expect(page.run({ do: "click", index: 1 })).toEqual({ ok: true });
    expect(page.log).toContain("click@inner");
  });

  it("leaves out what is hidden, without size, inert or disabled", () => {
    const page = new FakePage(
      h("button", {}, "Shown"),
      h("button", {}, "No display").set((element) => {
        element.display = "none";
      }),
      h("div", {}, h("button", {}, "In a closed part")).set((element) => {
        element.display = "none";
      }),
      h("div", {}, h("button", {}, "In a hidden part")).set((element) => {
        element.visibility = "hidden";
      }),
      h("button", {}, "Collapsed").set((element) => {
        element.visibility = "collapse";
      }),
      h("button", {}, "No size").at(0, 0, 0, 0),
      h("button", {}, "No height").at(0, 0, 100, 0),
      h("div", { inert: "" }, h("button", {}, "Behind a dialog")),
      h("button", { disabled: "" }, "Disabled"),
      h(
        "fieldset",
        { disabled: "" },
        input({ "aria-label": "In a disabled group" }),
      ),
      input({ disabled: "", "aria-label": "Disabled field" }),
      h("button", { "aria-disabled": "true" }, "Said to be disabled"),
      input({ readonly: "", "aria-label": "Read only", value: "fixed" }),
      // One point wide: the hidden box of a styled checkbox still works.
      input({ type: "checkbox", "aria-label": "Styled box" }).at(0, 0, 1, 1),
    );
    expect(
      page.read().elements.map((element) => [element.label, element.disabled]),
    ).toEqual([
      ["Shown", false],
      ["Said to be disabled", true],
      ["Read only", true],
      ["Styled box", false],
    ]);
  });

  it("puts what is in the viewport first, in page order inside each group", () => {
    const page = new FakePage(
      h("button", {}, "A below").at(700),
      h("button", {}, "B in view").at(100),
      h("button", {}, "C far below").at(1500),
      h("button", {}, "D in view").at(580),
      h("button", {}, "E above").at(-40),
      h("button", {}, "F to the right").at(100, 1200),
    );
    page.height = 2000;
    expect(page.labels()).toEqual([
      "B in view",
      "D in view",
      "A below",
      "C far below",
      "E above",
      "F to the right",
    ]);
    // After a scroll, other elements are in the viewport, and each keeps its number.
    const before = page.read().elements;
    page.scrollTo(650);
    const after = page.read().elements;
    expect(after.map((element) => element.label)).toEqual([
      "A below",
      "B in view",
      "C far below",
      "D in view",
      "E above",
      "F to the right",
    ]);
    for (const element of after)
      expect(element.index).toBe(
        before.find((other) => other.label === element.label)!.index,
      );
  });

  it("stops at 200 elements, and the ones out of view go first", () => {
    const buttons = Array.from({ length: 250 }, (_, at) =>
      h("button", {}, `Button ${at}`).at(at < 30 ? 900 : 100),
    );
    const page = new FakePage(...buttons);
    page.height = 2000;
    const answer = page.run({ do: "read" });
    const elements = answer.page!.elements;
    expect(elements).toHaveLength(pageLimits.elements);
    expect(pageLimits.elements).toBe(200);
    expect(elements[0]!.label).toBe("Button 30");
    expect(elements.at(-1)!.label).toBe("Button 229");
    // Only a listed element takes a number.
    expect(elements.map((element) => element.index)).toEqual(
      Array.from({ length: 200 }, (_, at) => at + 1),
    );
    expect(answer.next).toBe(201);
  });

  it("keeps every text inside its limit", () => {
    const page = new FakePage(
      h("p", {}, "word ".repeat(3000)),
      h("button", {}, "long label ".repeat(40)),
      input({ "aria-label": "Notes", value: "v".repeat(500) }),
      h("a", { href: `https://example.test/${"p".repeat(900)}` }, "Far"),
    );
    page.title = "t".repeat(500);
    page.url = `https://example.test/${"q".repeat(3000)}`;
    const reading = page.read();
    expect(pageLimits).toEqual({
      text: 6000,
      elements: 200,
      label: 120,
      value: 200,
      title: 200,
      address: 2000,
      link: 500,
    });
    expect(reading.text.length).toBeLessThanOrEqual(6000);
    expect(reading.text.length).toBeGreaterThan(5900);
    expect(reading.title).toHaveLength(200);
    expect(reading.url).toHaveLength(2000);
    expect(reading.elements[0]!.label.length).toBeLessThanOrEqual(120);
    expect(reading.elements[0]!.label.length).toBeGreaterThan(110);
    expect(reading.elements[1]!.value).toHaveLength(200);
    expect(reading.elements[2]!.href).toHaveLength(500);
  });

  it("says whether the page is ready: loaded, and not on its way out", () => {
    const page = new FakePage(h("a", { href: "/next" }, "Next"));
    page.readyState = "interactive";
    expect(page.run({ do: "read" }).ready).toBe(false);
    page.readyState = "complete";
    expect(page.run({ do: "read" }).ready).toBe(true);
    // The page starts to leave: until the next one is there, it is not ready.
    page.fire("beforeunload");
    expect(page.run({ do: "read" }).ready).toBe(false);
    // The person came back to it.
    page.fire("pageshow");
    expect(page.run({ do: "read" }).ready).toBe(true);
    // A new step starts from a clean state, for a page that stayed after all.
    page.fire("beforeunload");
    expect(page.run({ do: "click", index: 1 }).ok).toBe(true);
    expect(page.run({ do: "read" }).ready).toBe(true);
  });
});

describe("the page script: labels", () => {
  const label = (...children: Child[]) => new FakePage(...children).labels();

  it("prefers the visible text, then the accessible name, then the label, then the placeholder", () => {
    expect(
      label(h("button", { "aria-label": "Close dialog" }, "Close")),
    ).toEqual(["Close"]);
    expect(label(h("button", { "aria-label": "Close dialog" }))).toEqual([
      "Close dialog",
    ]);
    expect(
      label(
        h("span", { id: "one" }, "Billing"),
        h("span", { id: "two" }, "address"),
        input({ "aria-labelledby": "one  missing two", "aria-label": "No" }),
      ),
    ).toEqual(["Billing address"]);
    expect(
      label(h("a", { href: "/" }, h("img", { alt: "Chert home" }))),
    ).toEqual(["Chert home"]);
    expect(
      label(h("button", {}, h("svg", {}, h("title", {}, "Search")))),
    ).toEqual(["Search"]);
    expect(label(input({ type: "image", alt: "Send" }))).toEqual(["Send"]);
    expect(label(h("button", { title: "More actions" }))).toEqual([
      "More actions",
    ]);
    expect(
      label(
        h("label", { for: "email" }, "Email address"),
        input({ id: "email", placeholder: "you@example.test" }),
      ),
    ).toEqual(["Email address"]);
    expect(
      label(h("label", {}, "Remember me", input({ type: "checkbox" }))),
    ).toEqual(["Remember me"]);
    expect(
      label(
        h("label", { for: "city" }, "City"),
        input({ id: "city", "aria-label": "Town or city" }),
      ),
    ).toEqual(["Town or city"]);
    expect(label(input({ placeholder: "Your name" }))).toEqual(["Your name"]);
    expect(label(textarea({ placeholder: "Write a note" }))).toEqual([
      "Write a note",
    ]);
    expect(
      label(h("div", { contenteditable: "", "data-placeholder": "Reply" })),
    ).toEqual(["Reply"]);
    // With nothing else, the name of the field says what it is for.
    expect(label(input({ name: "coupon" }))).toEqual(["coupon"]);
    expect(label(input({}))).toEqual([""]);
  });

  it("never uses what a field holds as its label", () => {
    expect(label(input({ value: "what I typed" }))).toEqual([""]);
    expect(label(textarea({}, "a draft"))).toEqual([""]);
    expect(
      label(h("div", { contenteditable: "true" }, "a private draft")),
    ).toEqual([""]);
    expect(label(select({}, option("Japan"), option("Nepal")))).toEqual([""]);
    // A button made of an input shows its value: that is its text.
    expect(label(input({ type: "submit", value: "Place order" }))).toEqual([
      "Place order",
    ]);
    expect(label(input({ type: "submit" }))).toEqual(["Submit"]);
    expect(label(input({ type: "reset" }))).toEqual(["Reset"]);
  });

  it("gives one clean line of at most 120 characters", () => {
    expect(label(h("button", {}, "  Buy\n\n now\u00a0\u200b\t "))).toEqual([
      "Buy now",
    ]);
    expect(
      label(
        h("a", { href: "/" }, h("span", {}, "Read"), h("span", {}, "more")),
      ),
    ).toEqual(["Read more"]);
    const [long] = label(h("button", {}, "word ".repeat(100)));
    expect(long).toBe("word ".repeat(24).trim());
    expect(long!.length).toBeLessThanOrEqual(pageLimits.label);
  });
});

describe("the page script: passwords", () => {
  const make = () => {
    const secret = input({
      id: "pw",
      type: "password",
      value: "hunter2",
      placeholder: "Password",
    });
    const page = new FakePage(
      input({ id: "user", type: "text", "aria-label": "User", value: "anish" }),
      secret,
      input({ type: "text", name: "confirmPassword", value: "hunter3" }),
      input({
        type: "text",
        autocomplete: "current-password",
        value: "hunter4",
      }),
      input({ type: "text", "aria-label": "Code", value: "hunter5" }).set(
        (element) => {
          element.textSecurity = "disc";
        },
      ),
      input({ type: "text", name: "passwordless_email", value: "a@b.test" }),
    );
    return { page, secret };
  };

  it("marks a password field and never carries its value", () => {
    const { page } = make();
    const answer = page.run({ do: "read" });
    expect(
      answer.page!.elements.map((element) => [
        element.label,
        element.password,
        "value" in element,
      ]),
    ).toEqual([
      ["User", false, true],
      ["Password", true, false],
      ["confirmPassword", true, false],
      ["", true, false],
      ["Code", true, false],
      ["passwordless_email", false, true],
    ]);
    expect(JSON.stringify(answer)).not.toMatch(/hunter/);
  });

  it("keeps a field secret after the page shows its password as text", () => {
    const { page, secret } = make();
    page.read();
    secret.attributes.set("type", "text");
    const answer = page.run({ do: "read" });
    expect(answer.page!.elements[1]).toEqual(
      entry({
        index: 2,
        tag: "input",
        role: "textbox",
        label: "Password",
        password: true,
      }),
    );
    expect(JSON.stringify(answer)).not.toMatch(/hunter/);
  });

  it("refuses to type into a password field: the worker must ask the person", () => {
    const { page, secret } = make();
    page.read();
    page.log.length = 0;
    for (const index of [2, 3, 4, 5]) {
      const answer = page.run({
        do: "type",
        index,
        text: "guess",
        submit: true,
      });
      expect(answer.ok).toBe(false);
      expect(answer.error).toMatch(
        / is a password field\. The worker never types a password: ask the person to type it\.$/,
      );
    }
    expect(
      page.run({ do: "type", index: 2, text: "guess", submit: false }).error,
    ).toBe(
      'Number 2, "Password", is a password field. The worker never types a password: ask the person to type it.',
    );
    expect(secret.value).toBe("hunter2");
    expect(page.log).toEqual([]);
  });
});

describe("the page script: numbers", () => {
  it("keeps the number of an element from one reading to the next", () => {
    const first = h("button", {}, "First");
    const second = h("button", {}, "Second");
    const page = new FakePage(first, second);
    expect(page.read().elements.map((element) => element.index)).toEqual([
      1, 2,
    ]);
    const added = h("button", { id: "added" }, "Added");
    added.parentElement = page.body;
    page.body.children.unshift(added);
    expect(
      page.read().elements.map((element) => [element.label, element.index]),
    ).toEqual([
      ["Added", 3],
      ["First", 1],
      ["Second", 2],
    ]);
    expect(page.run({ do: "click", index: 3 })).toEqual({ ok: true });
    expect(page.log).toContain("click@added");
  });

  it("answers a number that is gone with a clear error, and clicks nothing", () => {
    const first = h("button", {}, "First");
    const second = h("button", {}, "Second");
    const page = new FakePage(first, second);
    page.read();
    second.remove();
    // The page puts another button in the same place.
    page.body.append(h("button", {}, "Delete everything"));
    page.log.length = 0;
    const gone =
      "Number 2 is not on the page any more. Read the page again and use a number from that reading.";
    expect(page.run({ do: "click", index: 2 })).toEqual({
      ok: false,
      error: gone,
    });
    expect(page.run({ do: "type", index: 2, text: "x", submit: true })).toEqual(
      {
        ok: false,
        error: gone,
      },
    );
    expect(page.run({ do: "click", index: 99 }).error).toBe(
      gone.replace("2", "99"),
    );
    expect(page.log).toEqual([]);
    expect(
      page.read().elements.map((element) => [element.label, element.index]),
    ).toEqual([
      ["First", 1],
      ["Delete everything", 3],
    ]);
  });

  it("starts above the numbers that the driver gave out before, on a new document", () => {
    const page = new FakePage(h("button", {}, "A"), h("button", {}, "B"));
    const answer = page.run({ do: "read" }, { session: "s1", start: 41 });
    expect(answer.page!.elements.map((element) => element.index)).toEqual([
      41, 42,
    ]);
    expect(answer.next).toBe(43);
    // A lower start never brings a number back.
    page.body.append(h("button", {}, "C"));
    expect(
      page
        .run({ do: "read" }, { session: "s1", start: 1 })
        .page!.elements.map((element) => element.index),
    ).toEqual([41, 42, 43]);
  });

  it("does not know the numbers of another driver", () => {
    const page = new FakePage(h("button", {}, "A"), h("button", {}, "B"));
    page.read({ session: "old", start: 1 });
    page.log.length = 0;
    expect(
      page.run({ do: "click", index: 2 }, { session: "new", start: 1 }).ok,
    ).toBe(false);
    expect(page.log).toEqual([]);
    expect(
      page
        .read({ session: "new", start: 5 })
        .elements.map((element) => element.index),
    ).toEqual([5, 6]);
  });
});

describe("the page script: click", () => {
  it("scrolls the element into view, then clicks as a person does", () => {
    const save = h("button", { id: "save" }, h("span", { id: "face" }, "Save"));
    save.at(900);
    save.children[0]!.at(900);
    const page = new FakePage(h("p", {}, "Far above"), save);
    page.height = 2000;
    page.read();
    expect(page.run({ do: "click", index: 1 })).toEqual({ ok: true });
    // The events go to what lies under the pointer, inside the element.
    expect(page.log).toEqual([
      "scrollIntoView@save",
      "pointerover@face",
      "mouseover@face",
      "pointermove@face",
      "mousemove@face",
      "pointerdown@face",
      "mousedown@face",
      "focus@save",
      "pointerup@face",
      "mouseup@face",
      "click@face",
    ]);
    const kinds = page.events.map((event) =>
      event instanceof FakePointerEvent
        ? "pointer"
        : event instanceof FakeMouseEvent
          ? "mouse"
          : "other",
    );
    expect(kinds).toEqual([
      "pointer",
      "mouse",
      "pointer",
      "mouse",
      "pointer",
      "mouse",
      "pointer",
      "mouse",
      "mouse",
    ]);
    // The point is the middle of the element, where it lies after the scroll.
    expect(page.scrollY).toBe(610);
    for (const event of page.events.slice(0, 8)) {
      expect(event.init).toMatchObject({
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: 60,
        clientY: 300,
        button: 0,
      });
    }
    expect(page.events[4]!.init.buttons).toBe(1);
    expect(page.events[7]!.init.buttons).toBe(0);
  });

  it("clicks the element itself when something else lies over its middle", () => {
    const page = new FakePage(
      h("button", { id: "under" }, "Under"),
      h("div", { id: "banner" }, "A banner"),
    );
    page.read();
    page.run({ do: "click", index: 1 });
    expect(page.log.filter((line) => !line.endsWith("@under"))).toEqual([]);
    expect(page.log.at(-1)).toBe("click@under");
  });

  it("does what a click does: follows a link, sets a checkbox", () => {
    const box = input({ id: "agree", type: "checkbox", "aria-label": "Agree" });
    const page = new FakePage(
      h("a", { id: "next", href: "https://example.test/next" }, "Next"),
      box,
    );
    page.read();
    page.run({ do: "click", index: 1 });
    expect(page.followed).toEqual(["https://example.test/next"]);
    page.run({ do: "click", index: 2 });
    expect(box.checked).toBe(true);
    expect(page.log.slice(-3)).toEqual([
      "click@agree",
      "input@agree",
      "change@agree",
    ]);
    expect(page.read().elements[1]!.value).toBe("checked");
  });

  it("sends a click event to an element that has no click of its own", () => {
    const page = new FakePage(
      h("svg", { id: "zoom", role: "button", "aria-label": "Zoom in" }),
    );
    expect(page.labels()).toEqual(["Zoom in"]);
    expect(page.run({ do: "click", index: 1 })).toEqual({ ok: true });
    expect(page.log.at(-1)).toBe("click@zoom");
    expect(page.events.at(-1)).toBeInstanceOf(FakeMouseEvent);
  });

  it("does not focus when the page stops the press, and does not click what the page took away", () => {
    const menu = h("button", { id: "menu" }, "Menu");
    menu.addEventListener("mousedown", (event) => event.preventDefault());
    const item = h("button", { id: "item" }, "Item");
    item.addEventListener("mouseup", () => item.remove());
    const page = new FakePage(menu, item);
    page.read();
    page.run({ do: "click", index: 1 });
    expect(page.log).not.toContain("focus@menu");
    expect(page.log.at(-1)).toBe("click@menu");
    page.log.length = 0;
    expect(page.run({ do: "click", index: 2 })).toEqual({ ok: true });
    expect(page.log).toContain("mouseup@item");
    expect(page.log).not.toContain("click@item");
  });

  it("refuses an element that is disabled or hidden now, or that is a select", () => {
    const save = h("button", { id: "save" }, "Save");
    const more = h("button", { id: "more" }, "More");
    const page = new FakePage(
      save,
      more,
      select({ "aria-label": "Country" }, option("Japan"), option("Nepal")),
    );
    page.read();
    save.attributes.set("disabled", "");
    more.display = "none";
    page.log.length = 0;
    expect(page.run({ do: "click", index: 1 })).toEqual({
      ok: false,
      error: 'Number 1, "Save", is disabled now.',
    });
    expect(page.run({ do: "click", index: 2 })).toEqual({
      ok: false,
      error: 'Number 2, "More", is hidden now. Read the page again.',
    });
    expect(page.run({ do: "click", index: 3 })).toEqual({
      ok: false,
      error:
        'Number 3, "Country", is a list of choices. Use type with the text of one choice.',
    });
    expect(
      page.log.filter((line) => !line.startsWith("scrollIntoView")),
    ).toEqual([]);
  });
});

describe("the page script: type", () => {
  /** What a framework that keeps its own state does to a field. */
  const track = (field: FakeInput | FakeTextArea) => {
    const own = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(field) as object,
      "value",
    )!;
    let known = field.value;
    const seen: string[] = [];
    Object.defineProperty(field, "value", {
      configurable: true,
      get: () => own.get!.call(field) as string,
      set: (next: string) => {
        known = String(next);
        own.set!.call(field, next);
      },
    });
    field.addEventListener("input", () => {
      // It acts only when the field holds something that it has not seen.
      if (field.value !== known) {
        known = field.value;
        seen.push(known);
      }
    });
    return seen;
  };

  it("focuses the field, sets the text with the native setter, then fires input and change", () => {
    const name = input({ id: "name", "aria-label": "Name", value: "old" });
    const page = new FakePage(form({ id: "f" }, name));
    const seen = track(name);
    page.read();
    expect(
      page.run({ do: "type", index: 1, text: "New name", submit: false }),
    ).toEqual({ ok: true });
    expect(page.log).toEqual([
      "scrollIntoView@name",
      "focus@name",
      "input@name",
      "change@name",
    ]);
    expect(name.value).toBe("New name");
    // The framework saw the change, which a plain assignment would hide from it.
    expect(seen).toEqual(["New name"]);
    const [typed, changed] = page.events;
    expect(typed).toBeInstanceOf(FakeInputEvent);
    expect(typed!.init).toMatchObject({
      bubbles: true,
      inputType: "insertText",
      data: "New name",
    });
    expect(changed!.bubbles).toBe(true);
    expect(page.read().elements[0]!.value).toBe("New name");
  });

  it("types into a text area the same way, with its own setter", () => {
    const notes = textarea({ id: "notes", "aria-label": "Notes" }, "old");
    const page = new FakePage(notes);
    const seen = track(notes);
    page.read();
    const text = 'line one\nline "two"\n\ttab \\ \u65e5\u672c \u{1f600}';
    page.run({ do: "type", index: 1, text, submit: false });
    expect(notes.value).toBe(text);
    expect(seen).toEqual([text]);
    expect(page.log.slice(-2)).toEqual(["input@notes", "change@notes"]);
  });

  it("submits the form after the text, as Return in the field does", () => {
    const query = input({ id: "q", "aria-label": "Search" });
    const search = form({ id: "search" }, query);
    const page = new FakePage(search);
    page.read();
    page.run({ do: "type", index: 1, text: "tea", submit: true });
    expect(page.log).toEqual([
      "scrollIntoView@q",
      "focus@q",
      "input@q",
      "change@q",
      "requestSubmit@search",
      "submit@search",
    ]);
    // An older browser has no requestSubmit: the event first, then the form itself.
    search.requestSubmit = undefined;
    page.log.length = 0;
    page.run({ do: "type", index: 1, text: "tea", submit: true });
    expect(page.log.slice(-2)).toEqual(["submit@search", "submit()@search"]);
    // A page that handles the event itself keeps the form from leaving.
    search.addEventListener("submit", (event) => event.preventDefault());
    page.log.length = 0;
    page.run({ do: "type", index: 1, text: "tea", submit: true });
    expect(page.log.at(-1)).toBe("submit@search");
  });

  it("sends Return when the field has no form", () => {
    const query = input({ id: "q", "aria-label": "Search" });
    const page = new FakePage(query);
    page.read();
    page.run({ do: "type", index: 1, text: "tea", submit: true });
    expect(page.log.slice(-3)).toEqual(["keydown@q", "keypress@q", "keyup@q"]);
    for (const event of page.events.slice(-3)) {
      expect(event).toBeInstanceOf(FakeKeyboardEvent);
      expect(event.init).toMatchObject({
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      });
    }
    // Without submit, no key is sent.
    page.log.length = 0;
    page.run({ do: "type", index: 1, text: "tea", submit: false });
    expect(page.log.some((line) => line.startsWith("key"))).toBe(false);
  });

  it("inserts the text into an editable region, at its end", () => {
    const editor = h(
      "div",
      { id: "editor", contenteditable: "true", "aria-label": "Message" },
      "Hi ",
    );
    const page = new FakePage(editor);
    expect(page.read().elements[0]).toEqual(
      entry({ tag: "div", role: "textbox", label: "Message", value: "Hi" }),
    );
    expect(
      page.run({ do: "type", index: 1, text: "there", submit: true }),
    ).toEqual({ ok: true });
    expect(page.log).toEqual([
      "scrollIntoView@editor",
      "focus@editor",
      "selectAllChildren@editor",
      "collapseToEnd",
      "execCommand insertText",
      "input@editor",
      "keydown@editor",
      "keypress@editor",
      "keyup@editor",
    ]);
    expect(editor.ownText).toBe("Hi there");
    // A browser that refuses the command: the text is added and the event is sent.
    page.insertTextWorks = false;
    page.log.length = 0;
    page.run({ do: "type", index: 1, text: "!", submit: false });
    expect(editor.ownText).toBe("Hi there!");
    expect(page.log.slice(-2)).toEqual([
      "execCommand insertText",
      "input@editor",
    ]);
    expect(page.events.at(-1)!.init).toMatchObject({
      data: "!",
      bubbles: true,
    });
  });

  it("chooses in a select by the text or the value of a choice", () => {
    const country = select(
      { id: "country", "aria-label": "Country" },
      option("Choose one", { value: "" }),
      option("Japan", { value: "jp" }),
      option("  Nepal ", { value: "np" }),
      option("Atlantis", { value: "at", disabled: "" }),
    );
    const page = new FakePage(country);
    expect(page.read().elements[0]!.value).toBe("Choose one");
    expect(
      page.run({ do: "type", index: 1, text: "nepal", submit: false }),
    ).toEqual({ ok: true });
    expect(country.value).toBe("np");
    expect(page.log).toEqual([
      "scrollIntoView@country",
      "focus@country",
      "input@country",
      "change@country",
    ]);
    page.run({ do: "type", index: 1, text: "jp", submit: false });
    expect(country.value).toBe("jp");
    expect(page.read().elements[0]!.value).toBe("Japan");
    page.log.length = 0;
    for (const text of ["Mars", "Atlantis"])
      expect(page.run({ do: "type", index: 1, text, submit: false })).toEqual({
        ok: false,
        error: 'Number 1, "Country", has no choice with that text.',
      });
    expect(country.value).toBe("jp");
    expect(page.log.some((line) => line.startsWith("change"))).toBe(false);
  });

  it("refuses what cannot take text, each with a clear sentence", () => {
    const name = input({ id: "name", "aria-label": "Name" });
    const page = new FakePage(
      h("button", {}, "Save"),
      input({ type: "checkbox", "aria-label": "Agree" }),
      input({ readonly: "", "aria-label": "Order number", value: "A-1" }),
      input({ type: "number", "aria-label": "Amount" }),
      name,
      input({ type: "file", "aria-label": "Photo" }),
    );
    page.read();
    const type = (index: number, text = "x") =>
      page.run({ do: "type", index, text, submit: false });
    expect(type(1).error).toBe(
      'Number 1, "Save", does not take text. Click it instead.',
    );
    expect(type(2).error).toBe(
      'Number 2, "Agree", does not take text. Click it instead.',
    );
    expect(type(3).error).toBe('Number 3, "Order number", is read only.');
    expect(type(4, "a lot").error).toBe(
      'Number 4, "Amount", did not take that text. A number or a date field takes only its own form.',
    );
    expect(type(4, "12.5")).toEqual({ ok: true });
    expect(type(6).error).toBe(
      'Number 6, "Photo", does not take text. Click it instead.',
    );
    name.attributes.set("disabled", "");
    expect(type(5).error).toBe('Number 5, "Name", is disabled now.');
    name.attributes.delete("disabled");
    name.display = "none";
    expect(type(5).error).toBe(
      'Number 5, "Name", is hidden now. Read the page again.',
    );
    // An empty text clears a field, and that is not a refusal.
    name.display = "block";
    name.value = "something";
    expect(type(5, "")).toEqual({ ok: true });
    expect(name.value).toBe("");
  });
});

describe("the page script: scroll and back", () => {
  it("scrolls the page by most of a viewport, and says when it cannot", () => {
    const page = new FakePage(h("p", {}, "Long"));
    page.height = 2000;
    expect(page.run({ do: "scroll", direction: "down" })).toEqual({ ok: true });
    expect(page.scrollY).toBe(510);
    expect(page.run({ do: "scroll", direction: "up" })).toEqual({ ok: true });
    expect(page.scrollY).toBe(0);
    expect(page.log).toEqual(["scrollBy 510", "scrollBy -510"]);
    expect(page.run({ do: "scroll", direction: "up" })).toEqual({
      ok: false,
      error: "The page is already at its top.",
    });
    page.scrollTo(1400);
    expect(page.run({ do: "scroll", direction: "down" })).toEqual({
      ok: false,
      error: "The page does not scroll further down.",
    });
    expect(page.log).toHaveLength(2);
  });

  it("scrolls the largest scrolling part when the page itself does not move", () => {
    const part = (id: string, width: number, flow: string) =>
      h("div", { id }, "rows")
        .at(100, 0, width, 400)
        .set((element) => {
          element.overflowY = flow;
          element.scrollHeight = 3000;
          element.clientHeight = 400;
        });
    const page = new FakePage(
      part("side", 200, "auto"),
      part("main", 700, "scroll"),
      part("wide-but-fixed", 900, "visible"),
      part("out-of-view", 950, "auto").at(5000, 0, 950, 400),
    );
    expect(page.run({ do: "scroll", direction: "down" })).toEqual({ ok: true });
    expect(page.log).toEqual(["scrollBy@main 340"]);
    expect(page.getElementById("main")!.scrollTop).toBe(340);
    expect(page.run({ do: "scroll", direction: "up" })).toEqual({ ok: true });
    expect(page.getElementById("main")!.scrollTop).toBe(0);
  });

  it("goes back one page, and says when the tab has no earlier page", () => {
    const page = new FakePage();
    expect(page.run({ do: "back" })).toEqual({ ok: true });
    expect(page.log).toEqual(["history.back"]);
    page.historyLength = 1;
    expect(page.run({ do: "back" })).toEqual({
      ok: false,
      error: "This tab has no earlier page.",
    });
    expect(page.log).toHaveLength(1);
  });
});

/**
 * The driver with a browser on paper that holds a hand-made page. The runner
 * does what the browser does with the command: it runs the last argument, the
 * page script, in the page that is in front, and prints its value.
 */
function world(first: FakePage) {
  const state = {
    page: first,
    /** Called after each wait of the driver, with the count of waits so far. */
    afterWait: (_count: number) => {},
  };
  const commands: string[][] = [];
  const slept: number[] = [];
  let time = 0;
  const browser = new AppleEventsBrowser(
    async (command, args) => {
      commands.push([command, ...args]);
      if (args[1] === probeScript)
        return { status: 0, stdout: "front com.google.Chrome\n" };
      return {
        status: 0,
        stdout: `${String(state.page.evaluate(args[2]!))}\n`,
      };
    },
    {
      now: () => time,
      sleep: async (ms) => {
        slept.push(ms);
        time += ms;
        state.afterWait(slept.length);
      },
    },
  );
  return { browser, state, commands, slept };
}

describe("the driver and the page script together", () => {
  it("brings what the worker types to the field unchanged, whatever it holds", async () => {
    const notes = textarea({ id: "notes", "aria-label": "Notes" });
    const { browser, commands } = world(new FakePage(notes));
    const text = `He said "hi" \\ 'yes'\nline two\r\n\ttab \u2028 \u00e9 \u65e5\u672c \u{1f600} \`tick\` \${x} $(id) " & quit & " </script> ${String.fromCharCode(0)} end`;
    const [field] = (await browser.read()).elements;
    const after = await browser.type(field!.index, text, false);
    expect(notes.value).toBe(text);
    expect(after.elements[0]!.value).toBe(pageHelpers.oneLine(text, 200));
    // Every argument of every command holds plain characters only.
    expect(commands.length).toBeGreaterThan(3);
    for (const [command, ...args] of commands) {
      expect(command).toBe("/usr/bin/osascript");
      for (const arg of args) expect(arg).toMatch(/^[\x20-\x7e\n]*$/);
    }
  });

  it("brings a very long text whole", async () => {
    const notes = textarea({ "aria-label": "Notes" });
    const { browser } = world(new FakePage(notes));
    const text = "row \u65e5 ".repeat(20_000);
    await browser.read();
    await browser.type(1, text, false);
    expect(notes.value).toHaveLength(120_000);
    expect(notes.value).toBe(text);
  });

  it("never lets a number of an older page name an element of the page now", async () => {
    const first = new FakePage(
      h("button", { id: "archive" }, "Archive"),
      h("button", { id: "keep" }, "Keep"),
    );
    const { browser, state } = world(first);
    const before = await browser.read();
    expect(before.elements.map((element) => element.index)).toEqual([1, 2]);
    // The browser shows another document now.
    const second = new FakePage(
      h("button", { id: "delete" }, "Delete everything"),
      h("button", { id: "cancel" }, "Cancel"),
    );
    state.page = second;
    await expect(browser.click(1)).rejects.toThrow(
      "Number 1 is not on the page any more. Read the page again and use a number from that reading.",
    );
    await expect(browser.type(2, "x", true)).rejects.toThrow(
      "Number 2 is not on the page any more.",
    );
    expect(second.log).toEqual([]);
    const after = await browser.read();
    expect(
      after.elements.map((element) => [element.label, element.index]),
    ).toEqual([
      ["Delete everything", 3],
      ["Cancel", 4],
    ]);
    // Back on the first document, its elements still carry their numbers.
    state.page = first;
    await browser.click(2);
    expect(first.log).toContain("click@keep");
    await expect(browser.click(3)).rejects.toThrow(
      "Number 3 is not on the page any more.",
    );
  });

  it("returns the page that a link leads to, once it is there and loaded", async () => {
    const link = h(
      "a",
      { id: "next", href: "https://example.test/next" },
      "Next",
    );
    const first = new FakePage(link);
    // A real page starts to leave when its link is followed.
    link.addEventListener("click", () => first.fire("beforeunload"));
    const second = new FakePage(
      h("h1", {}, "Arrived"),
      h("button", {}, "Continue"),
    );
    second.url = "https://example.test/next";
    second.title = "The next page";
    second.readyState = "loading";
    const { browser, state, slept } = world(first);
    await browser.read();
    state.afterWait = (count) => {
      // The old page stays for two looks. Then the new one is there, and loads.
      if (count === 3) state.page = second;
      if (count === 4) second.readyState = "complete";
    };
    expect(await browser.click(1)).toEqual({
      browser: "chrome",
      title: "The next page",
      url: "https://example.test/next",
      text: "Arrived Continue",
      elements: [entry({ index: 2, label: "Continue" })],
    });
    expect(first.followed).toEqual(["https://example.test/next"]);
    expect(slept).toEqual([150, 250, 250, 250]);
  });

  it("refuses a password field through the driver, and never shows what it holds", async () => {
    const secret = input({
      type: "password",
      "aria-label": "Password",
      value: "hunter2",
    });
    const { browser, commands } = world(new FakePage(secret));
    expect(await browser.doctor()).toEqual({
      ok: true,
      browser: "Google Chrome",
      reason: "Google Chrome can be read and operated.",
    });
    expect((await browser.read()).elements).toEqual([
      entry({
        tag: "input",
        role: "textbox",
        label: "Password",
        password: true,
      }),
    ]);
    await expect(browser.type(1, "guess", true)).rejects.toThrow(
      'Number 1, "Password", is a password field. The worker never types a password: ask the person to type it.',
    );
    expect(secret.value).toBe("hunter2");
    expect(secret.owner!.log).toEqual([]);
    expect(commands.length).toBeGreaterThan(0);
  });
});
