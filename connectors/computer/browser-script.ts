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
  | { do: "back" };

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

var LISTED_ROLES = { button: 1, link: 1, checkbox: 1, radio: 1, tab: 1, menuitem: 1, option: 1, "switch": 1 };

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
function shown(el, rect) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return false;
  var style = styleOf(el);
  if (style && (style.visibility === "hidden" || style.visibility === "collapse" || style.display === "none")) return false;
  if (typeof el.closest === "function" && el.closest("[inert]")) return false;
  return true;
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
  var checked = attr(el, "aria-checked");
  if (checked) return checked === "true" ? "checked" : checked === "mixed" ? "partly checked" : "not checked";
  if (attr(el, "aria-selected") === "true") return "selected";
  return null;
}

// The state of this document for this driver. A document that starts to
// leave is not ready, until the next one is there or a new step starts.
// "known" holds every numbered element that is on the page, by its number:
// a browser may drop what a script wrote on an element that no script holds.
function held() {
  var state = win[STATE];
  if (!state || state.session !== call.session) {
    state = { session: call.session, next: 1, leaving: false, known: Object.create(null) };
    win[STATE] = state;
    if (typeof win.addEventListener === "function") {
      win.addEventListener("beforeunload", function () { state.leaving = true; });
      win.addEventListener("pageshow", function () { state.leaving = false; });
    }
  }
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
    found.push({ el: el, facts: facts, near: inView(rect, width, height) });
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
  var state = held();
  var el = find(index);
  var name = nameOf(index, el);
  if (off(el)) fail(name + " is disabled now.");
  if (tagOf(el) === "select") fail(name + " is a list of choices. Use type with the text of one choice.");
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

var answer;
try {
  if (call.do === "read") answer = read();
  else if (call.do === "click") answer = click(call.index);
  else if (call.do === "type") answer = type(call.index, String(call.text), call.submit === true);
  else if (call.do === "scroll") answer = scroll(call.direction);
  else if (call.do === "back") answer = back();
  else if (call.do === "ping") answer = { ok: true };
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
