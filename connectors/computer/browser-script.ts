/**
 * The script that runs inside the web page.
 *
 * A browser takes one string of JavaScript through its scripting door and
 * gives back the value of the last expression. So each call is one script
 * that stands alone: the text below, called with one argument that says what
 * to do. It answers with one line of JavaScript Object Notation (JSON).
 *
 * The script and its answer hold plain characters only, from the space to the
 * tilde. Every other character travels as a \uXXXX escape. No step between
 * this process and the page can then change a quote, a backslash, a line
 * break or a character of another alphabet.
 *
 * The text is plain JavaScript in a string, not a function of this file,
 * because the page gets the text and nothing else of this program.
 */

/** The limits of one reading. */
export const pageLimits = {
  /** Characters of visible text. */
  text: 6000,
  elements: 200,
  label: 120,
  value: 200,
  title: 200,
  address: 2000,
  /** The address that a link leads to. */
  link: 500,
} as const;

/** One call into the page. */
export type PageCall =
  | { do: "ping" }
  | { do: "read" }
  | { do: "click"; index: number }
  | { do: "type"; index: number; text: string; submit: boolean }
  | { do: "scroll"; direction: "down" | "up" }
  | { do: "back" }
  | { do: "hover"; index: number }
  | { do: "select"; index: number; option: string }
  | { do: "key"; combo: PageKey }
  /** Where element N is, for a driver that sends real input. It sends no event. */
  | { do: "locate"; index: number }
  /** Whether the focus may take a real key: not in a password field, not in a frame. It sends no event. */
  | { do: "focus"; child?: boolean }
  /** Lightweight readiness and DOM mutation quiescence check in the isolated world. */
  | { do: "settle" }
  /** Paginated visible text extraction without script, style, or password values. */
  | { do: "extract"; offset: number; maxChars: number }
  /** Scrolls element N into view inside its document. */
  | { do: "scroll_to"; index: number };

/** The keys that a page takes, as the planner names them. */
export const pageKeys = [
  "Enter",
  "Escape",
  "Tab",
  "Shift+Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Backspace",
  "Space",
] as const;
export type PageKey = (typeof pageKeys)[number];
const otherKeyNames: Record<string, PageKey> = {
  return: "Enter",
  esc: "Escape",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};
/** One key of `pageKeys`, however a person or a model writes it. Null for any other key. */
export function parsePageKey(raw: string): PageKey | null {
  const said = String(raw)
    .trim()
    .toLowerCase()
    .replace(/\s*\+\s*/g, "+");
  return (
    pageKeys.find((key) => key.toLowerCase() === said) ??
    otherKeyNames[said] ??
    null
  );
}
/** What a key event of the page carries for each key. */
const keyEvents: Record<
  PageKey,
  { key: string; code: string; keyCode: number; shift?: true; press?: true }
> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, press: true },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  "Shift+Tab": { key: "Tab", code: "Tab", keyCode: 9, shift: true },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Space: { key: " ", code: "Space", keyCode: 32, press: true },
};

/**
 * Who calls. The page keeps the numbers of one driver apart from those of
 * another, and gives no number below `start`, so a number that the driver
 * gave out for an earlier document never names an element of this one.
 */
export interface PageSession {
  session: string;
  start: number;
}

/**
 * The small helpers that need no page. They are part of the script, and they
 * are also built here, from the same text, for the driver and for tests.
 */
const helperSource = String.raw`
function cut(text, max) {
  if (text.length <= max) return text;
  var end = max;
  var last = text.charCodeAt(end - 1);
  // A character of two units stays whole or goes.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end).replace(/\s+$/, "");
}

// One clean line: no control or invisible character, single spaces, no space at an end.
function oneLine(value, max) {
  var text = value === null || value === undefined ? "" : String(value);
  return cut(text.replace(/[\p{C}\s]+/gu, " ").replace(/^ | $/g, ""), max);
}

// The lines of a text, each one clean, without the empty ones.
function textBlock(value, max) {
  var rows = (value === null || value === undefined ? "" : String(value)).split(/\r\n|\r|\n|\u2028|\u2029/);
  var kept = [];
  for (var i = 0; i < rows.length; i++) {
    var row = oneLine(rows[i], max);
    if (row) kept.push(row);
  }
  return cut(kept.join("\n"), max);
}

// JavaScript Object Notation in plain characters only. It does not use the
// page's own JSON object, which a page can change.
function encode(value) {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  var kind = typeof value;
  if (kind === "number") return isFinite(value) ? String(value) : "null";
  if (kind === "string") {
    var out = "\"";
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (code === 34) out += "\\\"";
      else if (code === 92) out += "\\\\";
      else if (code >= 32 && code < 127) out += value.charAt(i);
      else out += "\\u" + ("0000" + code.toString(16)).slice(-4);
    }
    return out + "\"";
  }
  var parts = [];
  if (Array.isArray(value)) {
    for (var j = 0; j < value.length; j++) parts.push(encode(value[j]));
    return "[" + parts.join(",") + "]";
  }
  if (kind === "object") {
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      if (value[keys[k]] === undefined) continue;
      parts.push(encode(keys[k]) + ":" + encode(value[keys[k]]));
    }
    return "{" + parts.join(",") + "}";
  }
  return "null";
}

// The first candidate that is not empty, as one clean line.
function firstLine(candidates, max) {
  for (var i = 0; i < candidates.length; i++) {
    var line = oneLine(candidates[i], max);
    if (line) return line;
  }
  return "";
}

var LISTED_ROLES = {
  button: 1,
  link: 1,
  checkbox: 1,
  radio: 1,
  tab: 1,
  menuitem: 1,
  option: 1,
  "switch": 1,
  combobox: 1,
  listbox: 1,
  slider: 1,
  spinbutton: 1,
  treeitem: 1,
  searchbox: 1
};

// The role of an element that a person could click or fill, or null for any
// other element. A role that the page gives wins over the role of the tag.
function roleFor(facts) {
  var tag = facts.tag;
  var type = facts.type;
  var given = String(facts.role || "").replace(/^\s+/, "").toLowerCase().split(/\s+/)[0] || "";
  if (!/^[a-z]{1,30}$/.test(given)) given = "";
  var natural = "";
  if (tag === "a") natural = facts.href ? "link" : "";
  else if (tag === "button") natural = "button";
  else if (tag === "textarea") natural = "textbox";
  else if (tag === "select") natural = facts.list ? "listbox" : "combobox";
  else if (tag === "input") {
    if (type === "hidden") return null;
    if (type === "checkbox" || type === "radio") natural = type;
    else if (type === "button" || type === "submit" || type === "reset" || type === "image" || type === "file") natural = "button";
    else if (type === "search") natural = "searchbox";
    else if (type === "number") natural = "spinbutton";
    else if (type === "range") natural = "slider";
    else natural = "textbox";
  } else if (facts.editable) natural = "textbox";
  if (natural) return given || natural;
  return LISTED_ROLES[given] === 1 ? given : null;
}

function inView(rect, width, height) {
  return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
}

// What is in the viewport first, then the rest, each group in page order.
function arrange(items, max) {
  var near = [];
  var far = [];
  for (var i = 0; i < items.length; i++) (items[i].near ? near : far).push(items[i]);
  return near.concat(far).slice(0, max);
}
`;

export interface PageHelpers {
  cut(text: string, max: number): string;
  oneLine(value: unknown, max: number): string;
  textBlock(value: unknown, max: number): string;
  encode(value: unknown): string;
  firstLine(candidates: unknown[], max: number): string;
  roleFor(facts: {
    tag: string;
    type: string;
    role: string;
    href: boolean;
    editable: boolean;
    list: boolean;
  }): string | null;
  inView(
    rect: { top: number; left: number; bottom: number; right: number },
    width: number,
    height: number,
  ): boolean;
  arrange<T extends { near: boolean }>(items: T[], max: number): T[];
}

export const pageHelpers = new Function(
  `"use strict";${helperSource}
return { cut: cut, oneLine: oneLine, textBlock: textBlock, encode: encode, firstLine: firstLine, roleFor: roleFor, inView: inView, arrange: arrange };`,
)() as PageHelpers;

/**
 * The part that works on the page. `call` is the argument of the script:
 * what to do, and who asks.
 */
const pageSource = String.raw`
var win = window;
var doc = document;
// What the script keeps: the state on the window, a number on each element
// that a reading listed, and a mark on each password field.
var STATE = Symbol.for("clawdtime.browser.state");
var NUMBER = Symbol.for("clawdtime.browser.number");
var SECRET = Symbol.for("clawdtime.browser.secret");

// A refusal in words for the worker. It holds no page content but a label.
function fail(sentence) {
  throw { told: sentence };
}

function attr(el, name) {
  var value = typeof el.getAttribute === "function" ? el.getAttribute(name) : null;
  return value === null || value === undefined ? "" : String(value);
}
function tagOf(el) {
  return String(el.localName || "").toLowerCase();
}
function typeOf(el) {
  return tagOf(el) === "input" ? String(el.type || "text").toLowerCase() : "";
}
// An editable region is the outermost element that the person can edit.
function editable(el) {
  if (el.isContentEditable !== true) return false;
  var parent = el.parentElement;
  return !(parent && parent.isContentEditable === true);
}
// How the element is used: text and choice and region take text, check and press take a click.
function kindOf(el) {
  var tag = tagOf(el);
  var type = typeOf(el);
  if (tag === "textarea") return "text";
  if (tag === "select") return "choice";
  if (tag === "input") {
    if (type === "checkbox" || type === "radio") return "check";
    if (type === "button" || type === "submit" || type === "reset" || type === "image" || type === "file") return "press";
    return "text";
  }
  return editable(el) ? "region" : "press";
}
function factsOf(el) {
  var tag = tagOf(el);
  var role = roleFor({
    tag: tag,
    type: typeOf(el),
    role: attr(el, "role"),
    href: tag === "a" && el.hasAttribute("href"),
    editable: editable(el),
    list: tag === "select" && (el.multiple === true || el.size > 1)
  });
  return role ? { tag: tag, role: role, kind: kindOf(el) } : null;
}

function styleOf(el) {
  try {
    return win.getComputedStyle(el);
  } catch (problem) {
    return null;
  }
}
function isChoiceInput(el) {
  if (tagOf(el) !== "input") return false;
  var t = typeOf(el);
  return t === "checkbox" || t === "radio";
}
function visibleLabelOf(el) {
  var labels = el.labels;
  if (labels && labels.length) {
    for (var i = 0; i < labels.length; i++) {
      var lab = labels[i];
      if (lab && typeof lab.getBoundingClientRect === "function" && shown(lab, lab.getBoundingClientRect())) return lab;
    }
  }
  if (typeof el.closest === "function") {
    var wrap = el.closest("label");
    if (wrap && typeof wrap.getBoundingClientRect === "function" && shown(wrap, wrap.getBoundingClientRect())) return wrap;
  }
  return null;
}
function shown(el, rect) {
  if (typeof el.closest === "function" && el.closest("[inert]")) return false;
  var style = styleOf(el);
  if (style && (style.visibility === "hidden" || style.visibility === "collapse" || style.display === "none")) return false;
  var opacityZero = style && style.opacity === "0";
  if (isChoiceInput(el) && opacityZero) {
    if (typeof el.checkVisibility === "function") {
      try {
        if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
      } catch (problem) {}
    }
    return visibleLabelOf(el) !== null;
  }
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return false;
  if (typeof el.checkVisibility === "function") {
    try {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } catch (problem) {}
  }
  if (opacityZero) return false;
  return true;
}
function checkOperablePage() {
  var href = win.location && typeof win.location.href === "string" ? win.location.href : "";
  if (/^chrome-error:/i.test(href)) {
    fail("ClawdTime's browser shows one of its own pages, which ClawdTime does not read or operate: open a web page, then try again.");
  }
}
// Disabled by the browser itself: it takes no click and no text.
function off(el) {
  try {
    if (typeof el.matches === "function" && el.matches(":disabled")) return true;
  } catch (problem) {}
  return el.disabled === true;
}
// Present and shown, but the page says that it is not for use.
function hindered(el) {
  return attr(el, "aria-disabled") === "true" || el.readOnly === true || attr(el, "aria-readonly") === "true";
}
// A password field, by its type, by what the page says about it, or by the
// dots that hide its text. Once a password field, always one: a page that
// shows the password as text changes the type of the same field.
function secret(el) {
  if (el[SECRET] === true) return true;
  var tag = tagOf(el);
  if (tag !== "input" && tag !== "textarea") return false;
  var said = attr(el, "autocomplete") + " " + attr(el, "name") + " " + attr(el, "id");
  var found = typeOf(el) === "password" || /password(?!less)|passwd|passcode|passphrase|pwd/i.test(said);
  if (!found) {
    var style = styleOf(el);
    var mask = style ? style.webkitTextSecurity : "";
    found = typeof mask === "string" && mask !== "" && mask !== "none";
  }
  if (found) el[SECRET] = true;
  return found;
}

function textOf(node) {
  if (!node) return "";
  var text = node.innerText;
  if (typeof text !== "string" || text === "") text = node.textContent;
  return typeof text === "string" ? text : "";
}
// The text of the elements that aria-labelledby names.
function byIds(el, list) {
  var ids = String(list).split(/\s+/);
  var root = typeof el.getRootNode === "function" ? el.getRootNode() : null;
  var out = "";
  for (var i = 0; i < ids.length; i++) {
    if (!ids[i]) continue;
    var found = root && typeof root.getElementById === "function" ? root.getElementById(ids[i]) : null;
    if (!found) found = doc.getElementById(ids[i]);
    if (found) out += " " + textOf(found);
  }
  return out;
}
// The name of a picture inside the element.
function pictured(el) {
  if (typeof el.querySelectorAll !== "function") return "";
  var pictures = el.querySelectorAll("img");
  for (var i = 0; i < pictures.length; i++) {
    var alt = attr(pictures[i], "alt");
    if (alt) return alt;
  }
  var titles = el.querySelectorAll("title");
  for (var j = 0; j < titles.length; j++) {
    var title = textOf(titles[j]);
    if (title) return title;
  }
  return "";
}
// The label: the visible text, then the accessible name, then the associated
// label, then the placeholder. What a field holds is never its label.
function labelOf(el, kind) {
  var tag = tagOf(el);
  var type = typeOf(el);
  var own = "";
  if (tag === "input") {
    if (type === "button" || type === "submit" || type === "reset") own = el.value || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "");
  } else if (kind === "press") own = textOf(el);
  var related = "";
  var labels = el.labels;
  if (labels && labels.length) {
    for (var i = 0; i < labels.length; i++) related += " " + textOf(labels[i]);
  } else if (typeof el.closest === "function") related = textOf(el.closest("label"));
  return firstLine([
    own,
    byIds(el, attr(el, "aria-labelledby")),
    attr(el, "aria-label"),
    attr(el, "alt"),
    pictured(el),
    attr(el, "title"),
    related,
    attr(el, "placeholder"),
    attr(el, "aria-placeholder"),
    attr(el, "data-placeholder"),
    attr(el, "name")
  ], ${pageLimits.label});
}
// What a field holds, or the state of a box. null for an element with neither.
function valueOf(el, kind) {
  if (kind === "text") return oneLine(el.value, ${pageLimits.value});
  if (kind === "region") return oneLine(textOf(el), ${pageLimits.value});
  if (kind === "choice") {
    var options = el.options;
    var chosen = options && el.selectedIndex >= 0 ? options[el.selectedIndex] : null;
    return chosen ? oneLine(chosen.text, ${pageLimits.value}) : "";
  }
  if (kind === "check") return el.checked === true ? "checked" : "not checked";
  var states = [];
  var checked = attr(el, "aria-checked");
  if (checked) states.push(checked === "true" ? "checked" : checked === "mixed" ? "partly checked" : "not checked");
  if (attr(el, "aria-selected") === "true") states.push("selected");
  var expanded = attr(el, "aria-expanded");
  if (expanded === "true") states.push("expanded");
  else if (expanded === "false") states.push("collapsed");
  if (states.length) return oneLine(states.join(", "), ${pageLimits.value});
  var valueText = attr(el, "aria-valuetext");
  if (valueText) return oneLine(valueText, ${pageLimits.value});
  var valueNow = attr(el, "aria-valuenow");
  if (valueNow) return oneLine(valueNow, ${pageLimits.value});
  return null;
}
function optionsOf(el) {
  var list = el.options;
  if (!list || !list.length) return null;
  var out = [];
  for (var i = 0; i < list.length && out.length < 12; i++) {
    if (list[i].disabled === true) continue;
    var label = oneLine(list[i].text, ${pageLimits.label});
    if (label) out.push(label);
  }
  return out.length ? out : null;
}

// Lightweight DOM mutation quiescence tracker in the script's world.
// Ignores unchanged attribute writes and debounces per-element style/class flicker (200ms).
function ensureObserver(state) {
  if (state.observer || typeof win.MutationObserver !== "function") return;
  var root = doc.documentElement || doc.body;
  if (!root) return;
  var styleStamp = typeof win.WeakMap === "function" ? new win.WeakMap() : null;
  var observer = new win.MutationObserver(function (records) {
    var now = Date.now();
    var meaningful = false;
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      if (rec.type === "attributes") {
        var el = rec.target;
        var name = rec.attributeName;
        if (name && el && typeof el.getAttribute === "function") {
          if (el.getAttribute(name) === rec.oldValue) continue;
        }
        if (name === "style" || name === "class") {
          if (styleStamp && el && typeof el === "object") {
            var prev = styleStamp.get(el) || 0;
            if (now - prev < 200) continue;
            styleStamp.set(el, now);
          }
        }
        meaningful = true;
        break;
      }
      if (rec.type === "childList") {
        if ((rec.addedNodes && rec.addedNodes.length > 0) || (rec.removedNodes && rec.removedNodes.length > 0)) {
          meaningful = true;
          break;
        }
      } else if (rec.type === "characterData") {
        if (rec.target && rec.target.nodeValue !== rec.oldValue) {
          meaningful = true;
          break;
        }
      }
    }
    if (meaningful) state.lastMutation = now;
  });
  try {
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      attributes: true,
      attributeOldValue: true
    });
    state.observer = observer;
    if (!state.lastMutation) state.lastMutation = Date.now();
  } catch (problem) {}
}

// The state of this document for this driver. A document that starts to
// leave is not ready, until the next one is there or a new step starts.
// "known" holds every numbered element that is on the page, by its number:
// a browser may drop what a script wrote on an element that no script holds.
function held() {
  var state = win[STATE];
  if (!state || state.session !== call.session) {
    state = { session: call.session, next: 1, leaving: false, known: Object.create(null), lastMutation: 0, observer: null };
    win[STATE] = state;
    if (typeof win.addEventListener === "function") {
      win.addEventListener("beforeunload", function () { state.leaving = true; });
      win.addEventListener("pageshow", function () { state.leaving = false; });
    }
  }
  ensureObserver(state);
  if (!(state.next >= call.start)) state.next = call.start;
  return state;
}
function numberOf(el) {
  var mark = el[NUMBER];
  return mark && mark.session === call.session ? mark.index : 0;
}
// Every element in page order, with the ones inside open shadow trees.
// A visit that returns false stops the walk.
function each(root, visit) {
  var all = root.querySelectorAll("*");
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (visit(el) === false) return false;
    if (el.shadowRoot && each(el.shadowRoot, visit) === false) return false;
  }
  return true;
}

function read() {
  var state = held();
  var width = win.innerWidth || 0;
  var height = win.innerHeight || 0;
  // An element that left the page is let go, so the page can free it.
  for (var number in state.known) {
    if (state.known[number].isConnected === false) delete state.known[number];
  }
  var found = [];
  each(doc, function (el) {
    var facts = factsOf(el);
    if (!facts) return;
    var rect = el.getBoundingClientRect();
    // A control that the browser disabled stays in the reading, marked: "Send
    // is there and cannot be used yet" tells the planner to fill the form
    // first. Left out, the planner looked for a button that the page shows.
    if (!shown(el, rect)) return;
    var near = inView(rect, width, height);
    if (!near && isChoiceInput(el)) {
      var lab = visibleLabelOf(el);
      if (lab) near = inView(lab.getBoundingClientRect(), width, height);
    }
    found.push({ el: el, facts: facts, near: near });
  });
  var kept = arrange(found, ${pageLimits.elements});
  var elements = [];
  for (var i = 0; i < kept.length; i++) {
    var el = kept[i].el;
    var facts = kept[i].facts;
    var index = numberOf(el);
    if (!index) {
      index = state.next;
      state.next += 1;
      el[NUMBER] = { session: call.session, index: index };
    }
    state.known[index] = el;
    var hidden = secret(el);
    var entry = { index: index, tag: cut(facts.tag, 40), role: facts.role, label: labelOf(el, facts.kind) };
    if (!hidden) {
      var value = valueOf(el, facts.kind);
      if (value !== null) entry.value = value;
      if (facts.tag === "select") {
        var opts = optionsOf(el);
        if (opts) entry.options = opts;
      }
    }
    if (facts.tag === "a" && typeof el.href === "string") entry.href = oneLine(el.href, ${pageLimits.link});
    entry.disabled = off(el) || hindered(el);
    entry.password = hidden;
    elements.push(entry);
  }
  return {
    ok: true,
    ready: doc.readyState === "complete" && !state.leaving,
    next: state.next,
    page: {
      title: oneLine(doc.title, ${pageLimits.title}),
      url: oneLine(win.location.href, ${pageLimits.address}),
      text: textBlock(doc.body ? doc.body.innerText : "", ${pageLimits.text}),
      elements: elements
    }
  };
}

// The element that carries this number. A number that no element carries
// is an error: the script never picks another element in its place.
function find(index) {
  var hit = held().known[index] || null;
  if (hit && (hit.isConnected === false || numberOf(hit) !== index)) hit = null;
  // An element that left the page and came back still carries its number.
  if (!hit) {
    each(doc, function (el) {
      if (numberOf(el) !== index) return;
      hit = el;
      return false;
    });
  }
  if (!hit) fail("Number " + index + " is not on the page any more. Read the page again and use a number from that reading.");
  return hit;
}
function nameOf(index, el) {
  var label = labelOf(el, kindOf(el));
  return "Number " + index + (label ? ", \"" + label + "\"," : "");
}
function bring(el) {
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
}

function click(index) {
  checkOperablePage();
  var state = held();
  var el = find(index);
  var name = nameOf(index, el);
  if (off(el)) fail(name + " is disabled now.");
  if (tagOf(el) === "select") fail(name + " is a list of choices. Use type with the text of one choice.");
  if (tagOf(el) === "input" && typeOf(el) === "file") fail(name + " is a file upload input. Clicking it opens a native file picker dialog, which ClawdTime cannot operate automatically. Ask the person to choose the file.");
  bring(el);
  var rect = el.getBoundingClientRect();
  if (!shown(el, rect)) fail(name + " is hidden now. Read the page again.");
  state.leaving = false;
  var x = rect.left + rect.width / 2;
  var y = rect.top + rect.height / 2;
  // The events go to what lies under the pointer when that is a part of the
  // element, as with a real pointer, and to the element itself otherwise.
  var target = el;
  var top = typeof doc.elementFromPoint === "function" ? doc.elementFromPoint(x, y) : null;
  if (top && top !== el && typeof el.contains === "function" && el.contains(top)) target = top;
  function send(Kind, type, buttons) {
    if (typeof Kind !== "function") return true;
    return target.dispatchEvent(new Kind(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      detail: 1,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: buttons,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true
    }));
  }
  send(win.PointerEvent, "pointerover", 0);
  send(win.MouseEvent, "mouseover", 0);
  send(win.PointerEvent, "pointermove", 0);
  send(win.MouseEvent, "mousemove", 0);
  send(win.PointerEvent, "pointerdown", 1);
  var pressed = send(win.MouseEvent, "mousedown", 1);
  if (pressed && typeof el.focus === "function") el.focus({ preventScroll: true });
  send(win.PointerEvent, "pointerup", 0);
  send(win.MouseEvent, "mouseup", 0);
  // A page can take the element away while the button is down. Then no click follows.
  if (target.isConnected === false) target = el;
  if (target.isConnected === false) return { ok: true };
  if (typeof target.click === "function") target.click();
  else send(win.MouseEvent, "click", 0);
  return { ok: true };
}

function fire(el, type, text) {
  var event;
  if (typeof text === "string" && typeof win.InputEvent === "function") event = new win.InputEvent(type, { bubbles: true, composed: true, inputType: "insertText", data: text });
  else event = new win.Event(type, { bubbles: true });
  el.dispatchEvent(event);
}
// The setter of the prototype, not of the element: a framework that keeps
// its own state puts a setter on the element to follow it, and would then
// take the new text for its own and tell nobody.
function fill(el, text, name) {
  var home = tagOf(el) === "textarea" ? win.HTMLTextAreaElement : win.HTMLInputElement;
  var own = home && home.prototype ? Object.getOwnPropertyDescriptor(home.prototype, "value") : null;
  if (own && typeof own.set === "function") own.set.call(el, text);
  else el.value = text;
  fire(el, "input", text);
  fire(el, "change", null);
  if (text !== "" && el.value === "") fail(name + " did not take that text. A number or a date field takes only its own form.");
}
function choose(el, text, name) {
  var want = oneLine(text, 400).toLowerCase();
  var options = el.options || [];
  var pick = -1;
  for (var i = 0; i < options.length; i++) {
    if (options[i].disabled === true) continue;
    if (oneLine(options[i].text, 400).toLowerCase() === want || String(options[i].value) === text) {
      pick = i;
      break;
    }
  }
  if (pick < 0) fail(name + " has no choice with that text.");
  if (el.multiple === true) options[pick].selected = true;
  else el.selectedIndex = pick;
  fire(el, "input", null);
  fire(el, "change", null);
}
// The browser's own command inserts the text as typing does, so the editor
// of the page sees it. The text goes to the end of the region.
function insert(el, text) {
  var selection = typeof win.getSelection === "function" ? win.getSelection() : null;
  if (selection && typeof selection.selectAllChildren === "function") {
    selection.selectAllChildren(el);
    selection.collapseToEnd();
  }
  var done = false;
  try {
    done = doc.execCommand("insertText", false, text) === true;
  } catch (problem) {
    done = false;
  }
  if (done) return;
  el.appendChild(doc.createTextNode(text));
  fire(el, "input", text);
}
// Submits the form of the field, or sends Return when it has no form.
function sendForm(el) {
  var form = el.form || (typeof el.closest === "function" ? el.closest("form") : null);
  if (form) {
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else if (form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }))) form.submit();
    return;
  }
  var steps = ["keydown", "keypress", "keyup"];
  for (var i = 0; i < steps.length; i++) {
    el.dispatchEvent(new win.KeyboardEvent(steps[i], {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      charCode: steps[i] === "keypress" ? 13 : 0
    }));
  }
}
function type(index, text, submit) {
  checkOperablePage();
  var state = held();
  var el = find(index);
  var kind = kindOf(el);
  var name = nameOf(index, el);
  if (secret(el)) fail(name + " is a password field. The worker never types a password: ask the person to type it.");
  if (off(el)) fail(name + " is disabled now.");
  if (kind === "press" || kind === "check") fail(name + " does not take text. Click it instead.");
  if (el.readOnly === true || attr(el, "aria-readonly") === "true") fail(name + " is read only.");
  bring(el);
  if (!shown(el, el.getBoundingClientRect())) fail(name + " is hidden now. Read the page again.");
  state.leaving = false;
  if (typeof el.focus === "function") el.focus({ preventScroll: true });
  if (kind === "text") fill(el, text, name);
  else if (kind === "choice") choose(el, text, name);
  else insert(el, text);
  if (submit) sendForm(el);
  return { ok: true };
}

function canMove(el, sign) {
  return sign > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0;
}
// Scrolls the page, or the largest scrolling part in view when the page itself does not move.
function scroll(direction) {
  checkOperablePage();
  var state = held();
  var sign = direction === "up" ? -1 : 1;
  var width = win.innerWidth || 0;
  var height = win.innerHeight || 0;
  var root = doc.scrollingElement || doc.documentElement;
  var target = root && canMove(root, sign) ? root : null;
  if (!target) {
    var most = 0;
    each(doc, function (el) {
      if (el === root || !(el.scrollHeight > el.clientHeight + 1) || !canMove(el, sign)) return;
      var style = styleOf(el);
      var flow = style ? style.overflowY : "";
      if (flow !== "auto" && flow !== "scroll" && flow !== "overlay") return;
      var rect = el.getBoundingClientRect();
      if (!shown(el, rect) || !inView(rect, width, height)) return;
      if (rect.width * rect.height > most) {
        most = rect.width * rect.height;
        target = el;
      }
    });
  }
  if (!target) fail(sign > 0 ? "The page does not scroll further down." : "The page is already at its top.");
  state.leaving = false;
  var step = sign * Math.max(80, Math.round((target === root ? height : target.clientHeight) * 0.85));
  if (target === root && typeof win.scrollBy === "function") win.scrollBy({ top: step, left: 0, behavior: "instant" });
  else if (typeof target.scrollBy === "function") target.scrollBy({ top: step, left: 0, behavior: "instant" });
  else target.scrollTop += step;
  return { ok: true };
}

function back() {
  var state = held();
  if (!(win.history.length > 1)) fail("This tab has no earlier page.");
  state.leaving = false;
  win.history.back();
  return { ok: true };
}

// Hover, choose and key. Each is a step of its own, and each says no when
// its element or its focus cannot take it.
var KEYS = ${JSON.stringify(keyEvents)};

function has(list, item) {
  for (var i = 0; i < list.length; i++) if (list[i] === item) return true;
  return false;
}
// The element and the elements that hold it, up to the body, also out of a shadow tree.
function holders(from) {
  var list = [];
  var at = from;
  while (at && at !== doc.body && at !== doc.documentElement) {
    list[list.length] = at;
    var root = at.parentElement ? null : typeof at.getRootNode === "function" ? at.getRootNode() : null;
    at = at.parentElement || (root && root.host) || null;
  }
  return list;
}
// What a pointer that comes to rest over the element tells the page: what it
// left hears out and leave, what it reaches hears over, enter and move. No
// button goes down, so nothing is clicked.
function hover(index) {
  checkOperablePage();
  var state = held();
  var el = find(index);
  var name = nameOf(index, el);
  bring(el);
  var rect = el.getBoundingClientRect();
  if (!shown(el, rect)) fail(name + " is hidden now. Read the page again.");
  state.leaving = false;
  var x = rect.left + rect.width / 2;
  var y = rect.top + rect.height / 2;
  var target = el;
  var top = typeof doc.elementFromPoint === "function" ? doc.elementFromPoint(x, y) : null;
  if (top && top !== el && typeof el.contains === "function" && el.contains(top)) target = top;
  function send(on, Kind, type, bubbles) {
    if (typeof Kind !== "function") return;
    on.dispatchEvent(new Kind(type, {
      bubbles: bubbles,
      cancelable: bubbles,
      composed: true,
      view: win,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 0,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true
    }));
  }
  var before = state.hovered && state.hovered.isConnected !== false ? state.hovered : null;
  if (before !== target) {
    var left = before ? holders(before) : [];
    var reached = holders(target);
    // Out goes to what the pointer left, then leave to each holder that it
    // left, the inner one first. Over goes to what it reached, then enter to
    // each new holder, the outer one first. Pointer events come before mouse events.
    var kinds = [[win.PointerEvent, "pointer"], [win.MouseEvent, "mouse"]];
    if (before) {
      for (var a = 0; a < kinds.length; a++) {
        send(before, kinds[a][0], kinds[a][1] + "out", true);
        for (var i = 0; i < left.length; i++) {
          if (!has(reached, left[i])) send(left[i], kinds[a][0], kinds[a][1] + "leave", false);
        }
      }
    }
    for (var b = 0; b < kinds.length; b++) {
      send(target, kinds[b][0], kinds[b][1] + "over", true);
      for (var j = reached.length - 1; j >= 0; j--) {
        if (!has(left, reached[j])) send(reached[j], kinds[b][0], kinds[b][1] + "enter", false);
      }
    }
  }
  send(target, win.PointerEvent, "pointermove", true);
  send(target, win.MouseEvent, "mousemove", true);
  state.hovered = target;
  return { ok: true };
}

// A press as a pointer does it, on an element that has no number of its own.
function press(target) {
  bring(target);
  var rect = target.getBoundingClientRect();
  var x = rect.left + rect.width / 2;
  var y = rect.top + rect.height / 2;
  function send(Kind, type, buttons) {
    if (typeof Kind !== "function") return;
    target.dispatchEvent(new Kind(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      detail: 1,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: buttons,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true
    }));
  }
  send(win.PointerEvent, "pointerdown", 1);
  send(win.MouseEvent, "mousedown", 1);
  send(win.PointerEvent, "pointerup", 0);
  send(win.MouseEvent, "mouseup", 0);
  if (typeof target.click === "function") target.click();
  else send(win.MouseEvent, "click", 0);
}
// Chooses one option by the text that it shows, as a person picks it from
// the list. A select of the browser gets the choice and hears input and
// change. An option of a list that the page draws is pressed.
function select(index, wanted) {
  checkOperablePage();
  var state = held();
  var el = find(index);
  var name = nameOf(index, el);
  if (secret(el)) fail(name + " is a password field.");
  if (off(el) || hindered(el)) fail(name + " is disabled now.");
  var want = oneLine(wanted, 400).toLowerCase();
  if (!want) fail("Name the option by the text that it shows.");
  var asked = "\"" + oneLine(wanted, 80) + "\"";
  bring(el);
  if (!shown(el, el.getBoundingClientRect())) fail(name + " is hidden now. Read the page again.");
  state.leaving = false;
  if (tagOf(el) === "select") {
    var options = el.options || [];
    var pick = -1;
    for (var i = 0; i < options.length; i++) {
      if (oneLine(options[i].text, 400).toLowerCase() !== want) continue;
      if (options[i].disabled === true) fail(name + " has the option " + asked + ", but it cannot be chosen now.");
      pick = i;
      break;
    }
    if (pick < 0) fail(name + " has no option " + asked + ". Use the text of an option as the page shows it.");
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    if (el.multiple === true) options[pick].selected = true;
    else {
      // The setter of the prototype, as for text: a framework may follow the element's own.
      var home = win.HTMLSelectElement;
      var own = home && home.prototype ? Object.getOwnPropertyDescriptor(home.prototype, "selectedIndex") : null;
      if (own && typeof own.set === "function") own.set.call(el, pick);
      else el.selectedIndex = pick;
    }
    fire(el, "input", null);
    fire(el, "change", null);
    return { ok: true };
  }
  if (kindOf(el) !== "press" && kindOf(el) !== "text") fail(name + " is not a list of choices.");
  // A list that the page draws: its options are inside it, or in the element that it names.
  var lists = [el];
  var named = (attr(el, "aria-controls") + " " + attr(el, "aria-owns")).split(/\s+/);
  var root = typeof el.getRootNode === "function" ? el.getRootNode() : null;
  for (var k = 0; k < named.length; k++) {
    if (!named[k]) continue;
    var other = root && typeof root.getElementById === "function" ? root.getElementById(named[k]) : null;
    if (!other) other = doc.getElementById(named[k]);
    if (other) lists[lists.length] = other;
  }
  var match = null;
  for (var m = 0; m < lists.length && !match; m++) {
    each(lists[m], function (item) {
      if (attr(item, "role").toLowerCase() !== "option") return;
      if (labelOf(item, "press").toLowerCase() !== want) return;
      if (!shown(item, item.getBoundingClientRect())) return;
      match = item;
      return false;
    });
  }
  if (!match) fail(name + " shows no option " + asked + " now. Click it to open its list, read the page, then click the option.");
  if (attr(match, "aria-disabled") === "true") fail(name + " has the option " + asked + ", but it cannot be chosen now.");
  press(match);
  return { ok: true };
}

// The element that has the focus, inside open shadow trees too. The body when none has it.
function focusedElement() {
  var at = doc.activeElement || null;
  while (at && at.shadowRoot && at.shadowRoot.activeElement) at = at.shadowRoot.activeElement;
  return at && at !== doc.documentElement ? at : doc.body;
}
function canFocus(el) {
  if (off(el)) return false;
  var given = attr(el, "tabindex");
  var tag = tagOf(el);
  var natural = (tag === "a" && el.hasAttribute("href")) || tag === "button" || tag === "select" || tag === "textarea" || (tag === "input" && typeOf(el) !== "hidden") || editable(el);
  if (/^-?\d+$/.test(given)) natural = Number(given) >= 0;
  return natural && shown(el, el.getBoundingClientRect());
}
// Tab moves the focus to the next element that takes it, in page order; Shift+Tab to the one before.
function moveFocus(from, sign) {
  var list = [];
  each(doc, function (el) {
    if (canFocus(el)) list[list.length] = el;
  });
  var at = -1;
  for (var i = 0; i < list.length; i++) if (list[i] === from) at = i;
  var next = at < 0 ? (sign > 0 ? 0 : list.length - 1) : at + sign;
  if (next < 0 || next >= list.length) return;
  if (typeof list[next].focus === "function") list[next].focus();
}
// Backspace takes away the character before the caret, or what is selected.
function erase(el, kind) {
  var done = false;
  try {
    done = doc.execCommand("delete", false) === true;
  } catch (problem) {
    done = false;
  }
  if (done || kind !== "text") return;
  var text = String(el.value);
  var start = typeof el.selectionStart === "number" ? el.selectionStart : text.length;
  var end = typeof el.selectionEnd === "number" ? el.selectionEnd : text.length;
  if (start === end) {
    if (start === 0) return;
    var low = text.charCodeAt(start - 1);
    var high = start > 1 ? text.charCodeAt(start - 2) : 0;
    start -= low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? 2 : 1;
  }
  var home = tagOf(el) === "textarea" ? win.HTMLTextAreaElement : win.HTMLInputElement;
  var own = home && home.prototype ? Object.getOwnPropertyDescriptor(home.prototype, "value") : null;
  var next = text.slice(0, start) + text.slice(end);
  if (own && typeof own.set === "function") own.set.call(el, next);
  else el.value = next;
  var event = typeof win.InputEvent === "function" ? new win.InputEvent("input", { bubbles: true, composed: true, inputType: "deleteContentBackward" }) : new win.Event("input", { bubbles: true });
  el.dispatchEvent(event);
}
function slide(top) {
  if (typeof win.scrollBy === "function") win.scrollBy({ top: top, left: 0, behavior: "instant" });
}
// What the browser itself does with a key that the page did not stop. A key
// event of a script does none of it, so the script does it here. A key that
// is not named here is left to the page.
function keyAction(el, combo) {
  var kind = kindOf(el);
  var tag = tagOf(el);
  var role = attr(el, "role").toLowerCase();
  var writing = kind === "text" || kind === "region" || kind === "choice";
  var page = el === doc.body;
  var height = win.innerHeight || 0;
  var root = doc.scrollingElement || doc.documentElement;
  if (combo === "Enter") {
    // Return in a field of a form submits the form, as a person's Return does.
    if (kind === "text" && tag === "input") {
      if (el.form || (typeof el.closest === "function" && el.closest("form"))) sendForm(el);
      return;
    }
    var presses = tag === "a" || tag === "button" || (kind === "press" && tag === "input") || /^(?:button|link|menuitem|option|tab)$/.test(role);
    if (!page && !writing && kind !== "check" && presses && typeof el.click === "function") el.click();
    return;
  }
  if (combo === "Space") {
    if (writing) return;
    if (!page && (tag === "button" || kind === "check" || (kind === "press" && tag === "input") || /^(?:button|checkbox|switch|radio|menuitem|option|tab)$/.test(role))) {
      if (typeof el.click === "function") el.click();
      return;
    }
    if (page) slide(Math.max(80, Math.round(height * 0.85)));
    return;
  }
  if (combo === "Tab" || combo === "Shift+Tab") return moveFocus(el, combo === "Tab" ? 1 : -1);
  if (combo === "Backspace") {
    if (kind === "text" || kind === "region") erase(el, kind);
    return;
  }
  if (!page) return;
  if (combo === "ArrowDown") slide(40);
  else if (combo === "ArrowUp") slide(-40);
  else if (combo === "PageDown") slide(Math.max(80, Math.round(height * 0.85)));
  else if (combo === "PageUp") slide(-Math.max(80, Math.round(height * 0.85)));
  else if (combo === "Home") slide(-(root ? root.scrollTop : 0) - 1);
  else if (combo === "End") slide(root ? root.scrollHeight : 0);
}
// One key in the element that has the focus: down, press for a key that
// writes, the browser's own action when the page did not stop it, up.
function key(combo) {
  checkOperablePage();
  var state = held();
  var spec = Object.prototype.hasOwnProperty.call(KEYS, combo) ? KEYS[combo] : null;
  if (!spec) fail("The page was asked for a key that it does not take.");
  var el = focusedElement();
  if (!el) fail("The page has nothing that could take a key.");
  if (secret(el)) fail("The focus is in a password field. The worker never presses a key there: ask the person.");
  state.leaving = false;
  function send(on, type) {
    if (typeof win.KeyboardEvent !== "function") return true;
    return on.dispatchEvent(new win.KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      key: spec.key,
      code: spec.code,
      keyCode: spec.keyCode,
      which: spec.keyCode,
      shiftKey: spec.shift === true,
      charCode: type === "keypress" ? spec.keyCode : 0
    }));
  }
  var go = send(el, "keydown");
  if (go && spec.press === true) go = send(el, "keypress");
  if (go) keyAction(el, combo);
  var now = focusedElement();
  if (now && now.isConnected !== false) send(now, "keyup");
  return { ok: true };
}

// Locate: for a driver that sends real input events at a point. It brings
// element N into view and says where its centre is, what kind of element it
// is, and whether a pointer at its centre reaches it and nothing else. It
// sends no event and reads no value: of a password field it says only that
// it is one.
//
// A pointer there does not reach the element when another element lies on
// top of it, when a frame lies there (inside it or on top: the click would
// land in another page, maybe of a site where the person is signed in), or
// when another control lies inside it there (the click would press that
// control). When the page put its own function in place of the browser's
// hit test, the answer cannot be told: that is a no too.
var FRAMES = { iframe: 1, frame: 1, object: 1, embed: 1, fencedframe: 1, portal: 1 };

// The browser's own hit test of a document or a shadow tree, or null when
// the page replaced it, on the object or on its prototype.
function hitTest(root, Home) {
  var own;
  try {
    own = Object.getOwnPropertyDescriptor(root, "elementFromPoint");
  } catch (problem) {
    return null;
  }
  if (own) return null;
  var test = root.elementFromPoint;
  if (typeof test !== "function") return null;
  if (Home && Home.prototype && Home.prototype.elementFromPoint !== test) return null;
  return test;
}
// The element on top at the point, also inside open shadow trees, null when
// none is there, or undefined when the hit test was replaced.
function topAt(x, y) {
  var test = hitTest(doc, win.Document);
  if (!test) return undefined;
  var top = test.call(doc, x, y);
  // A pointer goes into open shadow trees.
  for (var depth = 0; top && top.shadowRoot && depth < 30; depth++) {
    var root = top.shadowRoot;
    if (typeof root.elementFromPoint !== "function") break;
    var inner = hitTest(root, win.ShadowRoot);
    if (!inner) return undefined;
    var below = inner.call(root, x, y);
    if (!below || below === top) break;
    top = below;
  }
  return top || null;
}
// What is in the way of a pointer at the point, from the element on top up
// to the element: null when the pointer reaches the element, a part of it
// that takes no click of its own, or a label of it. Otherwise the element in
// the way: a frame, another control inside it, or what lies on top of it.
function inTheWay(top, el) {
  var control = null;
  for (var node = top, depth = 0; node && depth < 1000; depth++) {
    var element = typeof node.getAttribute === "function";
    if (element && FRAMES[tagOf(node)] === 1) return { node: node, why: "frame" };
    if (node === el) return control ? { node: control, why: "control" } : null;
    if (element && !control) {
      // A click on the label of a field reaches the field.
      if (tagOf(node) === "label" && node.control === el) return null;
      if (factsOf(node)) control = node;
    }
    node = node.parentNode || (node.nodeType === 11 ? node.host : null);
  }
  return { node: top, why: "" };
}
// Whether the node is the element or inside it, also across a shadow tree.
function within(node, el) {
  for (var depth = 0; node && depth < 1000; depth++) {
    if (node === el) return true;
    node = node.parentNode || (node.nodeType === 11 ? node.host : null);
  }
  return false;
}
function focusedNow() {
  var active = doc.activeElement;
  for (var depth = 0; active && active.shadowRoot && active.shadowRoot.activeElement && depth < 30; depth++) active = active.shadowRoot.activeElement;
  return active;
}
function locate(index) {
  checkOperablePage();
  var state = held();
  var el = find(index);
  var facts = factsOf(el);
  var name = nameOf(index, el);
  bring(el);
  var rect = el.getBoundingClientRect();
  if (!shown(el, rect)) fail(name + " is hidden now. Read the page again.");
  state.leaving = false;
  var x = rect.left + rect.width / 2;
  var y = rect.top + rect.height / 2;
  var inside = x >= 0 && y >= 0 && x < (win.innerWidth || 0) && y < (win.innerHeight || 0);
  var top = topAt(x, y);
  var way = top === undefined ? { node: null, why: "unsure" } : top ? inTheWay(top, el) : { node: null, why: "" };
  var hit = way === null;
  if ((!hit || !inside) && isChoiceInput(el)) {
    var elStyle = styleOf(el);
    if (elStyle && elStyle.opacity === "0") {
      var visLabel = visibleLabelOf(el);
      if (visLabel) {
        bring(visLabel);
        var lRect = visLabel.getBoundingClientRect();
        var lx = lRect.left + lRect.width / 2;
        var ly = lRect.top + lRect.height / 2;
        var lInside = lx >= 0 && ly >= 0 && lx < (win.innerWidth || 0) && ly < (win.innerHeight || 0);
        var lTop = topAt(lx, ly);
        var lWay = lTop === undefined ? { node: null, why: "unsure" } : lTop ? inTheWay(lTop, el) : { node: null, why: "" };
        if (lInside && lWay === null) {
          x = lx;
          y = ly;
          inside = true;
          hit = true;
          way = null;
        }
      }
    }
  }
  var answer = {
    ok: true,
    x: x,
    y: y,
    inside: inside,
    hit: hit,
    tag: cut(tagOf(el), 40),
    role: facts ? facts.role : "",
    kind: kindOf(el),
    name: name,
    disabled: off(el),
    readOnly: el.readOnly === true || attr(el, "aria-readonly") === "true",
    password: secret(el),
    focused: within(focusedNow(), el)
  };
  if (tagOf(el) === "input") {
    var inputType = typeOf(el);
    if (inputType === "file") answer.file = true;
    if (inputType) answer.inputType = cut(inputType, 30);
  }
  if (way && way.node) answer.cover = cut(tagOf(way.node), 40);
  if (way && way.why) answer.blocked = way.why;
  return answer;
}
function settleCheck() {
  var state = held();
  var now = Date.now();
  var domIdleMs = state.lastMutation ? Math.max(0, now - state.lastMutation) : 1000;
  return {
    ok: true,
    readyState: String(doc.readyState || "complete"),
    leaving: state.leaving === true,
    domIdleMs: domIdleMs,
    url: oneLine(win.location.href, ${pageLimits.address})
  };
}
var SKIP_TEXT_TAGS = {
  script: 1,
  style: 1,
  noscript: 1,
  template: 1,
  svg: 1,
  iframe: 1,
  frame: 1,
  object: 1,
  embed: 1
};
var BLOCK_TEXT_TAGS = {
  address: 1,
  article: 1,
  aside: 1,
  blockquote: 1,
  dd: 1,
  details: 1,
  dialog: 1,
  div: 1,
  dl: 1,
  dt: 1,
  fieldset: 1,
  figcaption: 1,
  figure: 1,
  footer: 1,
  form: 1,
  h1: 1,
  h2: 1,
  h3: 1,
  h4: 1,
  h5: 1,
  h6: 1,
  header: 1,
  hgroup: 1,
  hr: 1,
  li: 1,
  main: 1,
  nav: 1,
  ol: 1,
  p: 1,
  pre: 1,
  section: 1,
  summary: 1,
  table: 1,
  tbody: 1,
  td: 1,
  tfoot: 1,
  th: 1,
  thead: 1,
  tr: 1,
  ul: 1
};
var MAX_EXTRACT_NODES = 50000;
var MAX_EXTRACT_DEPTH = 256;
var MAX_EXTRACT_TOTAL_CHARS = 500000;
function isOpacityZero(style) {
  if (!style) return false;
  var op = style.opacity;
  return op === "0" || (typeof op === "string" && op !== "" && parseFloat(op) === 0);
}
function collectVisibleText(root, startReq, limit) {
  var needEnd = startReq + limit;
  var chunkParts = [];
  var lineBuf = "";
  var total = 0;
  function flushLine() {
    if (!lineBuf) return;
    var row = lineBuf.replace(/[\p{C}\s]+/gu, " ").replace(/^ | $/g, "");
    lineBuf = "";
    if (!row || total >= MAX_EXTRACT_TOTAL_CHARS) return;
    var piece = total > 0 ? "\n" + row : row;
    var remaining = MAX_EXTRACT_TOTAL_CHARS - total;
    if (piece.length > remaining) piece = cut(piece, remaining);
    if (!piece) return;
    var pieceStart = total;
    var pieceEnd = total + piece.length;
    if (pieceStart < needEnd && pieceEnd > startReq) {
      var from = pieceStart < startReq ? startReq - pieceStart : 0;
      var to = pieceEnd > needEnd ? needEnd - pieceStart : piece.length;
      chunkParts.push(piece.slice(from, to));
    }
    total = pieceEnd;
  }
  function appendText(raw) {
    if (!raw || total >= MAX_EXTRACT_TOTAL_CHARS) return;
    var parts = String(raw).split(/\r\n|\r|\n|\u2028|\u2029/);
    for (var p = 0; p < parts.length; p++) {
      if (p > 0) flushLine();
      if (total >= MAX_EXTRACT_TOTAL_CHARS) break;
      var part = parts[p];
      if (!part) continue;
      lineBuf += part;
      if (lineBuf.length > 100000) {
        lineBuf = lineBuf.replace(/[\p{C}\s]+/gu, " ");
        if (lineBuf.length > MAX_EXTRACT_TOTAL_CHARS) {
          lineBuf = lineBuf.slice(0, MAX_EXTRACT_TOTAL_CHARS);
        }
      }
    }
  }
  var stack = [{ node: root, depth: 0 }];
  var visited = 0;
  while (stack.length > 0 && visited < MAX_EXTRACT_NODES && total < MAX_EXTRACT_TOTAL_CHARS) {
    var item = stack.pop();
    if (item.br === true) {
      flushLine();
      continue;
    }
    if (typeof item.text === "string") {
      appendText(item.text);
      continue;
    }
    var node = item.node;
    if (!node) continue;
    visited += 1;
    if (node.nodeType === 3) {
      if (node.nodeValue) appendText(node.nodeValue);
      continue;
    }
    if (node.nodeType !== undefined && node.nodeType !== 1 && node.nodeType !== 11) continue;
    var isEl = node.nodeType === 1 || (node.nodeType === undefined && typeof node.localName === "string");
    if (isEl) {
      var tag = tagOf(node);
      if (SKIP_TEXT_TAGS[tag] === 1) continue;
      if (tag === "input" || tag === "textarea" || secret(node)) continue;
      if (attr(node, "aria-hidden").toLowerCase() === "true") continue;
      if (typeof node.hasAttribute === "function" && node.hasAttribute("inert")) continue;
      var style = styleOf(node);
      if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || isOpacityZero(style))) continue;
      if (tag === "br") {
        flushLine();
        continue;
      }
      if (BLOCK_TEXT_TAGS[tag] === 1) {
        flushLine();
        stack.push({ br: true });
      }
    }
    var depth = item.depth;
    if (depth >= MAX_EXTRACT_DEPTH) continue;
    var kids = node.childNodes;
    if (kids && kids.length) {
      for (var i = kids.length - 1; i >= 0; i--) {
        stack.push({ node: kids[i], depth: depth + 1 });
      }
    } else if (!kids && isEl) {
      var ch = node.children;
      if (ch && ch.length) {
        for (var j = ch.length - 1; j >= 0; j--) {
          stack.push({ node: ch[j], depth: depth + 1 });
        }
      }
      if (typeof node.ownText === "string" && node.ownText) {
        stack.push({ text: node.ownText, depth: depth + 1 });
      }
    }
    if (node.shadowRoot) {
      stack.push({ node: node.shadowRoot, depth: depth + 1 });
    }
  }
  flushLine();
  var start = Math.min(startReq, total);
  var chunk = chunkParts.join("");
  var end = start + chunk.length;
  if (chunk.length > 0 && end < total) {
    var last = chunk.charCodeAt(chunk.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      chunk = chunk.slice(0, -1);
      end -= 1;
    }
  }
  return { text: chunk, offset: start, totalChars: total, hasMore: end < total };
}
function extractText(offset, maxChars) {
  var limit = typeof maxChars === "number" && isFinite(maxChars) ? Math.min(16000, Math.max(1, Math.floor(maxChars))) : 8000;
  var startReq = typeof offset === "number" && isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  var result = doc.body
    ? collectVisibleText(doc.body, startReq, limit)
    : { text: "", offset: 0, totalChars: 0, hasMore: false };
  return {
    ok: true,
    url: oneLine(win.location.href, ${pageLimits.address}),
    title: oneLine(doc.title, ${pageLimits.title}),
    text: result.text,
    offset: result.offset,
    totalChars: result.totalChars,
    hasMore: result.hasMore
  };
}
function scrollToEl(index) {
  checkOperablePage();
  var state = held();
  var el = find(index);
  var name = nameOf(index, el);
  var target = el;
  var rect = el.getBoundingClientRect();
  if (isChoiceInput(el) && !(rect.width > 0 && rect.height > 0)) {
    var lab = visibleLabelOf(el);
    if (lab) target = lab;
  }
  bring(target);
  rect = el.getBoundingClientRect();
  if (!shown(el, rect)) fail(name + " is hidden now. Read the page again.");
  state.leaving = false;
  return { ok: true };
}
// Focus: for a driver that sends real keys. A key goes to the element that
// has the focus, so the step says no when that is a password field, or a
// frame, whose inside this script cannot see.
function focusCheck(isChild) {
  checkOperablePage();
  if (isChild && typeof doc.hasFocus === "function" && !doc.hasFocus()) {
    fail("The focus is not in this frame.");
  }
  var el = focusedElement();
  if (!el) fail("The page has nothing that could take a key.");
  if (secret(el)) fail("The focus is in a password field. The worker never presses a key there: ask the person.");
  if (FRAMES[tagOf(el)] === 1) fail("The focus is in a frame of the page, which ClawdTime cannot see into. No key was pressed. Click into the page itself, or use the screen.");
  return { ok: true };
}
// End of locate.

var answer;
try {
  if (call.do === "read") answer = read();
  else if (call.do === "click") answer = click(call.index);
  else if (call.do === "type") answer = type(call.index, String(call.text), call.submit === true);
  else if (call.do === "scroll") answer = scroll(call.direction);
  else if (call.do === "back") answer = back();
  else if (call.do === "hover") answer = hover(call.index);
  else if (call.do === "select") answer = select(call.index, String(call.option));
  else if (call.do === "key") answer = key(String(call.combo));
  else if (call.do === "ping") answer = { ok: true };
  else if (call.do === "locate") answer = locate(call.index);
  else if (call.do === "focus") answer = focusCheck(call.child === true);
  else if (call.do === "settle") answer = settleCheck();
  else if (call.do === "extract") answer = extractText(call.offset, call.maxChars);
  else if (call.do === "scroll_to") answer = scrollToEl(call.index);
  else fail("The page was asked for a step that it does not know.");
} catch (problem) {
  if (problem && typeof problem.told === "string") answer = { ok: false, error: problem.told };
  else {
    // The words of an unexpected failure can hold page content. Its kind cannot.
    var kind = problem && typeof problem.name === "string" && /^[A-Za-z]{1,40}$/.test(problem.name) ? problem.name : "an error";
    answer = { ok: false, error: "The page script stopped with " + kind + ". Read the page again." };
  }
}
return encode(answer);
`;

const scriptSource = `(function (call) {\n"use strict";${helperSource}${pageSource}})`;

/** The script for one call. Its value in the page is the answer, as one line. */
export function pageScript(call: PageCall, session: PageSession): string {
  return `${scriptSource}(${pageHelpers.encode({ ...call, session: session.session, start: session.start })})`;
}
