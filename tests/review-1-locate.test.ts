import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  pageScript,
  type PageCall,
} from "../connectors/computer/browser-script.js";

/**
 * Review 1: the locate step of the page script, which ClawdTime's own
 * browser runs before each real click (own-browser.ts). The browser then
 * presses the mouse at the centre that locate gave, when locate says that a
 * pointer there reaches the element ("hit"). The page script runs in Node,
 * against the small hand-made document of
 * tests/connectors-computer-browser-script.test.ts, which this file copies
 * (from `type Child` to `class FakePage`).
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
  /** As in a browser: the parent of an element. The copied document had none. */
  get parentNode(): FakeElement | null {
    return this.parentElement;
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

  /** The elements that the script keeps hold of in this page, by number. */
  kept() {
    const state = this.evaluate(
      'window[Symbol.for("clawdtime.browser.state")]',
    ) as { known?: Record<string, FakeElement> } | undefined;
    return { ...state?.known };
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

/** Locate the element with this id, by the number that a reading gave it. */
const located = (page: FakePage, id: string) => {
  page.read();
  const found = Object.entries(page.kept()).find(([, item]) => item.id === id);
  if (!found) throw new Error(`No element #${id} in the reading.`);
  return page.run({
    do: "locate",
    index: Number(found[0]),
  } as PageCall) as Answer & Record<string, unknown>;
};

describe("review 1: locate says a pointer reaches the element, and it does not", () => {
  it("when a frame of another site lies inside the element, under its centre", () => {
    // A transparent frame of the bank, inside the page's own "Next" button.
    // The real click at the centre goes into the bank's page, where the
    // person is signed in with ClawdTime's own profile.
    const frame = h("iframe", {
      id: "bank",
      src: "https://bank.test/transfer",
    }).at(100, 100, 200, 40);
    const next = h(
      "div",
      { id: "next", role: "button", "aria-label": "Next" },
      "Next",
      frame,
    ).at(100, 100, 200, 40);
    const page = new FakePage(next);
    const answer = located(page, "next");
    expect(answer.ok).toBe(true);
    expect(answer.hit).toBe(false);
  });

  it("when another control of the page lies inside the element, under its centre", () => {
    const remove = h("button", { id: "delete" }, "Delete").at(110, 140, 60, 20);
    const note = h(
      "div",
      { id: "note", role: "button", "aria-label": "Open note" },
      "Groceries",
      remove,
    ).at(100, 40, 200, 40);
    const page = new FakePage(note);
    const answer = located(page, "note");
    expect(answer.ok).toBe(true);
    expect(answer.hit).toBe(false);
  });

  it("when the page replaced document.elementFromPoint", () => {
    const next = h("button", { id: "next" }, "Next").at(100, 100, 200, 40);
    const cover = h("iframe", {
      id: "cover",
      src: "https://bank.test/transfer",
    }).at(100, 100, 200, 40);
    const page = new FakePage(next, cover);
    // As it is, the frame on top is seen.
    expect(located(page, "next").hit).toBe(false);
    // The page script runs in the page's own world, so the page can answer
    // for the browser.
    page.evaluate(
      'document.elementFromPoint = function () { return document.getElementById("next"); }',
    );
    expect(located(page, "next").hit).toBe(false);
  });
});
