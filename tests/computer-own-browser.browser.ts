/**
 * ClawdTime's own browser against a real browser.
 *
 * The unit tests prove the driver with a browser on paper. This check starts
 * the driver itself with the Chromium of Playwright, with no window
 * (`--headless=new`), in a profile folder of its own that it removes at the
 * end. The pages come from a server on 127.0.0.1 that this check starts. It
 * opens no window, uses no browser of the person and sends nothing out.
 *
 * It needs the Chromium of Playwright (`npm run cua:install-browser`).
 * CLAWDTIME_CHECK_CHROMIUM names another program of the same engine.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { pageError } from "../connectors/computer/error-page.js";
import {
  BrowserInputUnknown,
  OwnBrowser,
} from "../connectors/computer/own-browser.js";
import type { BrowserPage } from "../connectors/computer/ports.js";

const desk = `<!doctype html>
<html><head><meta charset="utf-8"><title>Shop desk</title>
<style>
  .menu .sub { display: none; }
  .menu:hover .sub { display: block; }
  .pile { position: relative; display: inline-block; }
  .veil { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.1); }
</style></head><body>
<h1>Shop desk</h1>
<button id="trust">Check the click</button> <span id="trusted">none</span>
<p><label for="name">Your name</label> <input id="name" type="text" value="Old name"></p>
<div id="mirror">Old name</div>
<p><label for="size">Size</label>
<select id="size"><option>Small</option><option>Medium</option><option>Large</option></select>
<span id="heard"></span></p>
<div class="menu"><button id="products">Products</button><div class="sub"><a href="/next">Kettles</a></div></div>
<p><button id="later">Show later</button> <span id="later-text"></span></p>
<p><span class="pile"><button id="covered">Covered button</button><span class="veil"></span></span> <span id="covers">0</span></p>
<p><label>Secret <input id="secret" type="password"></label></p>
<div id="rich" contenteditable="true" aria-label="Message">Hello</div>
<form action="/search" method="get"><input type="search" name="q" aria-label="Search the shop"></form>
<p><a href="/next">Next page</a></p>
<script>
  var byId = function (id) { return document.getElementById(id); };
  byId("trust").addEventListener("click", function (event) {
    byId("trusted").textContent = event.isTrusted ? "trusted" : "untrusted";
  });
  byId("covered").addEventListener("click", function () {
    byId("covers").textContent = String(Number(byId("covers").textContent) + 1);
  });
  ["input", "change"].forEach(function (type) {
    byId("size").addEventListener(type, function () { byId("heard").textContent += type + " "; });
  });
  byId("later").addEventListener("click", function () {
    setTimeout(function () { byId("later-text").textContent = "Ready now"; }, 700);
  });
  // A field that a framework controls: it follows the value through a
  // setter on the element, takes an input event only when it brings a new
  // value, and writes its own state back into the field all the time.
  (function () {
    var field = byId("name");
    var native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    var tracked = native.get.call(field);
    var state = tracked;
    Object.defineProperty(field, "value", {
      configurable: true,
      get: function () { return native.get.call(this); },
      set: function (text) { tracked = String(text); native.set.call(this, text); }
    });
    field.addEventListener("input", function () {
      var now = native.get.call(field);
      if (now === tracked) return;
      tracked = now;
      state = now;
      byId("mirror").textContent = state;
    });
    setInterval(function () {
      if (native.get.call(field) !== state) { native.set.call(field, state); tracked = state; }
    }, 30);
  })();
</script>
</body></html>`;

const second = `<!doctype html>
<html><head><meta charset="utf-8"><title>Second page</title></head><body>
<h1>Second page</h1><a href="/">Back to the desk</a>
</body></html>`;

/**
 * A page that works against the driver: it replaces the browser's hit test
 * on the prototype, where a check in its own world cannot see it, hides a
 * frame inside a button, and has a password field.
 */
const hostile = `<!doctype html>
<html><head><meta charset="utf-8"><title>Hostile page</title>
<style>
  .pile { position: relative; display: inline-block; }
  .veil { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.1); }
  #framed { position: relative; width: 200px; height: 60px; }
  #framed iframe { position: absolute; inset: 0; width: 200px; height: 60px; border: 0; opacity: 0; }
</style></head><body>
<p><span class="pile"><button id="covered">Covered button</button><span class="veil"></span></span> <span id="covers">0</span></p>
<div id="framed" role="button" aria-label="Framed">Framed<iframe src="/inner"></iframe></div>
<p><label>Secret <input id="secret" type="password"></label></p>
<script>
  var covered = document.getElementById("covered");
  covered.addEventListener("click", function () {
    var count = document.getElementById("covers");
    count.textContent = String(Number(count.textContent) + 1);
  });
  var real = Document.prototype.elementFromPoint;
  Document.prototype.elementFromPoint = function (x, y) {
    var hit = real.call(this, x, y);
    return hit && hit.className === "veil" ? covered : hit;
  };
</script>
</body></html>`;

/** The results load their prices after the page itself, from a slow address. */
const results = (asked: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Results</title></head><body>
<h1>Results for ${asked}</h1><p id="prices">Prices are loading</p>
<script>
  fetch("/slow").then(function (answer) { return answer.text(); }).then(function (text) {
    document.getElementById("prices").textContent = text;
  });
</script>
</body></html>`;

const peak = (crossOrigin: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Peak controls</title>
<style>
  #ghost { opacity: 0; }
  #custom-cb { opacity: 0; position: absolute; }
  #custom-radio { opacity: 0; width: 0; height: 0; position: absolute; }
  #orphan-cb { opacity: 0; }
  iframe { display: block; margin: 24px 0 0 36px; border: 4px solid #333; padding: 6px; width: 360px; height: 220px; }
</style></head><body>
<h1>Peak controls</h1>
<div id="spinner">spinning</div>
<button id="mutate">Trigger dynamic DOM</button> <span id="dyn">initial</span>
<p><a id="popup-link" href="/popup" target="_blank">Open popup</a></p>
<div role="combobox" aria-label="Country picker" aria-expanded="false" tabindex="0">Country picker</div>
<div role="switch" aria-label="Dark mode" aria-checked="true" tabindex="0">Dark mode</div>
<div role="slider" aria-label="Volume" aria-valuenow="42" tabindex="0">Volume</div>
<button id="ghost">Ghost button</button>
<p><label id="custom-cb-label"><input id="custom-cb" type="checkbox"><span>Accept terms</span></label></p>
<p><input id="custom-radio" type="radio" name="ship"><label for="custom-radio">Express shipping</label></p>
<p><input id="orphan-cb" type="checkbox" aria-label="Orphan hidden checkbox"></p>
<p><label for="phone">Phone number</label> <input id="phone" type="text" value=""> <span id="phone-events">0</span></p>
<p><label for="color">Color</label> <select id="color"><option>Red</option><option>Blue</option><option>Green</option></select></p>
<p><label>Upload file <input id="upload" type="file"></label></p>
<p><label for="date">Delivery date</label> <input id="date" type="date"></p>
<p><label for="editbox">Edit box</label> <input id="editbox" type="text" value="Hello World"></p>
<p><a id="broken-link" href="http://127.0.0.1:1/">Broken link</a></p>
<iframe id="same-frame" src="/frame"></iframe>
<iframe id="cross-frame" src="${crossOrigin}/xframe"></iframe>
<iframe id="nested-outer" src="/nested-outer"></iframe>
<script>
  // Rapid CSS/style flicker every 15ms: must NOT stall MutationObserver settle.
  var deg = 0;
  setInterval(function () {
    deg = (deg + 10) % 360;
    document.getElementById("spinner").style.transform = "rotate(" + deg + "deg)";
  }, 15);
  document.getElementById("mutate").addEventListener("click", function () {
    setTimeout(function () { document.getElementById("dyn").textContent = "step 1"; }, 30);
    setTimeout(function () { document.getElementById("dyn").textContent = "Settled after mutations"; }, 70);
  });
  // Masked phone input: reformats 10 digits to (XXX) XXX-XXXX and counts input events.
  var phone = document.getElementById("phone");
  var phoneCount = 0;
  phone.addEventListener("input", function () {
    phoneCount += 1;
    var digits = phone.value.replace(/\\D/g, "").slice(0, 10);
    if (digits.length === 10) {
      phone.value = "(" + digits.slice(0, 3) + ") " + digits.slice(3, 6) + "-" + digits.slice(6);
    }
    document.getElementById("phone-events").textContent = String(phoneCount);
  });
</script>
</body></html>`;

const popupHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Popup page</title></head><body>
<h1>Popup page</h1><button id="ok">Popup OK</button>
</body></html>`;

const sameFrameHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Same frame</title></head><body>
<button id="fbtn">Frame action</button> <span id="fcount">0</span>
<p><label for="fnote">Frame note</label> <input id="fnote" type="text" value="init"></p>
<p><label>Frame secret <input id="fpw" type="password" value="top-secret"></label></p>
<script>
  document.getElementById("fbtn").addEventListener("click", function () {
    var c = document.getElementById("fcount");
    c.textContent = String(Number(c.textContent) + 1);
  });
</script>
</body></html>`;

const crossFrameHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Cross frame</title>
<style>iframe { display: block; margin-top: 8px; width: 280px; height: 90px; border: 2px solid #555; }</style>
</head><body>
<button id="xbtn">Cross frame action</button> <span id="xcount">0</span>
<p><label>Cross secret <input id="xpw" type="password" value="x-secret"></label></p>
<iframe id="xinner-frame" src="/xinner"></iframe>
<script>
  document.getElementById("xbtn").addEventListener("click", function () {
    var c = document.getElementById("xcount");
    c.textContent = String(Number(c.textContent) + 1);
  });
</script>
</body></html>`;

const crossInnerHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Cross inner</title></head><body>
<button id="xinner-btn">Nested OOPIF action</button> <span id="xinner-count">0</span>
<script>
  document.getElementById("xinner-btn").addEventListener("click", function () {
    var c = document.getElementById("xinner-count");
    c.textContent = String(Number(c.textContent) + 1);
  });
</script>
</body></html>`;

const nestedOuterHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Nested outer</title>
<style>
  .wrap { position: relative; width: 280px; height: 110px; }
  .wrap iframe { width: 280px; height: 110px; border: 0; }
  .veil { position: absolute; top: 0; left: 0; width: 280px; height: 48px; background: rgba(0,0,0,0.05); }
</style>
</head><body>
<div class="wrap">
  <iframe id="nested-inner" src="/nested-inner"></iframe>
  <div class="veil"></div>
</div>
</body></html>`;

const nestedInnerHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Nested inner</title>
<style>body { margin: 0; } #nbtn { height: 40px; } #npw-row { margin-top: 16px; }</style>
</head><body>
<div><button id="nbtn">Covered nested button</button> <span id="ncount">0</span></div>
<div id="npw-row"><label>Nested secret <input id="npw" type="password" value="nested-secret"></label></div>
<script>
  document.getElementById("nbtn").addEventListener("click", function () {
    var c = document.getElementById("ncount");
    c.textContent = String(Number(c.textContent) + 1);
  });
</script>
</body></html>`;

const hydrateHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Hydrate page</title></head><body>
<h1>Hydrate page</h1><p id="status">Booting</p>
<script>
  setTimeout(function () {
    document.getElementById("status").textContent = "Hydrated after 35ms";
  }, 35);
</script>
</body></html>`;

const wave2Html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Wave 2 desk</title>
<style>
  .spacer { height: 2800px; }
</style></head><body>
<h1>Wave 2 desk</h1>
<p><button id="confirm-btn">Ask confirm</button> <span id="confirm-out">Confirm result: none</span></p>
<p><button id="prompt-btn">Ask prompt</button> <span id="prompt-out">Prompt result: none</span></p>
<form id="batch-form">
  <p><label for="f-name">Customer name</label> <input id="f-name" type="text" value=""></p>
  <p><label for="f-tier">Plan tier</label>
    <select id="f-tier"><option>Starter</option><option>Pro</option><option>Team</option></select></p>
  <p><label for="f-notes">Delivery notes</label> <textarea id="f-notes"></textarea></p>
  <p id="notes-lines">lines:0</p>
  <p><label for="f-pw">Account password</label> <input id="f-pw" type="password" value=""></p>
  <p><label for="f-lock-a">Lock trigger</label> <input id="f-lock-a" type="text" value=""></p>
  <p><label for="f-lock-b">Locked target</label> <input id="f-lock-b" type="text" value=""></p>
</form>
<div class="spacer">Spacer content</div>
<p><button id="far-btn">Far below button</button> <span id="far-out">far:0</span></p>
<script>
  var byId = function (id) { return document.getElementById(id); };
  byId("confirm-btn").addEventListener("click", function () {
    byId("confirm-out").textContent = "Confirm result: " + (window.confirm("Proceed with order?") ? "confirmed" : "cancelled");
  });
  byId("prompt-btn").addEventListener("click", function () {
    var val = window.prompt("Order tag?");
    byId("prompt-out").textContent = "Prompt result: tag=" + String(val);
  });
  byId("f-notes").addEventListener("input", function () {
    var val = byId("f-notes").value;
    var parts = val.split("\\n");
    byId("notes-lines").textContent = "lines:" + parts.length + "|" + parts.join(" / ");
  });
  byId("f-lock-a").addEventListener("input", function () {
    if (byId("f-lock-a").value) byId("f-lock-b").disabled = true;
  });
  byId("far-btn").addEventListener("click", function () {
    byId("far-out").textContent = "far:" + (window.scrollY > 1000 ? "scrolled" : "top");
  });
</script>
</body></html>`;

const longTextParagraphs = Array.from(
  { length: 120 },
  (_, i) =>
    `<p>Section ${i + 1}: Riverchat order handbook entry number ${i + 1} with plain prose for pagination verification.</p>`,
).join("\n");

const longHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Long handbook</title>
<style>.hidden-css-marker { display: none; }</style></head><body>
<h1>Long handbook</h1>
<script>var SECRET_SCRIPT_MARKER = "do-not-extract";</script>
<div class="hidden-css-marker">HIDDEN_DIV_MARKER</div>
<div style="opacity: 0">HIDDEN_OPACITY_INJECTION</div>
<div aria-hidden="true"><span>HIDDEN_ARIA_INJECTION</span></div>
<input type="password" value="HIDDEN_PW_MARKER">
${longTextParagraphs}
</body></html>`;

function serve(crossOrigin = "") {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const html = (body: string) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    };
    if (url.pathname === "/") return html(desk);
    if (url.pathname === "/next") return html(second);
    if (url.pathname === "/hostile") return html(hostile);
    if (url.pathname === "/inner") return html("<button>Inner</button>");
    if (url.pathname === "/peak") return html(peak(crossOrigin));
    if (url.pathname === "/popup") return html(popupHtml);
    if (url.pathname === "/frame") return html(sameFrameHtml);
    if (url.pathname === "/xframe") return html(crossFrameHtml);
    if (url.pathname === "/xinner") return html(crossInnerHtml);
    if (url.pathname === "/nested-outer") return html(nestedOuterHtml);
    if (url.pathname === "/nested-inner") return html(nestedInnerHtml);
    if (url.pathname === "/hydrate") return html(hydrateHtml);
    if (url.pathname === "/wave2") return html(wave2Html);
    if (url.pathname === "/long") return html(longHtml);
    if (url.pathname === "/search")
      return html(
        results((url.searchParams.get("q") ?? "").replace(/[^\w ]/g, "")),
      );
    if (url.pathname === "/slow") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("Prices loaded");
      }, 600);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise<{ origin: string; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => server.close(),
      }),
    ),
  );
}

const number = (page: BrowserPage, label: string) => {
  const found = page.elements.filter((item) => item.label === label);
  assert.equal(found.length, 1, `one element named "${label}"`);
  return found[0]!.index;
};

const program =
  process.env.CLAWDTIME_CHECK_CHROMIUM || chromium.executablePath();
if (!existsSync(program)) {
  console.log(
    `Chromium: skipped, the engine is not installed at ${program}. Run: npm run cua:install-browser`,
  );
  process.exit(0);
}

const crossSite = await serve();
const site = await serve(crossSite.origin);
const root = mkdtempSync(join(tmpdir(), "clawdtime-own-browser-"));
const profile = join(root, "computer", "browser-profile");
const driver = new OwnBrowser({
  env: { CLAWDTIME_CONFIG_HOME: root },
  home: root,
  executable: program,
  headless: true,
});
let checks = 0;
const step = async (title: string, run: () => Promise<void>) => {
  try {
    await run();
    checks += 1;
  } catch (error) {
    console.log(`Own browser: FAILED: ${title}`, error);
    throw error;
  }
};
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const holder = () =>
  Number(/-(\d+)$/.exec(readlinkSync(join(profile, "SingletonLock")))![1]);

try {
  const { origin } = site;
  await step("the doctor starts nothing and writes nothing", async () => {
    const said = await driver.doctor();
    assert.equal(said.ok, true, said.reason);
    assert.match(said.reason, /starts at the first browser step/);
    assert.equal(existsSync(profile), false);
  });

  let seen = await driver.open(`${origin}/`);
  await step(
    "the first open starts the browser in its own private profile and reads the page",
    async () => {
      assert.equal(seen.browser, "own");
      assert.equal(seen.title, "Shop desk");
      assert.equal(seen.url, `${origin}/`);
      assert.match(seen.text, /Shop desk/);
      assert.equal(statSync(profile).mode & 0o777, 0o700);
      assert.ok(existsSync(join(profile, "DevToolsActivePort")));
      const said = await driver.doctor();
      assert.equal(said.ok, true, said.reason);
      assert.match(said.reason, /runs and answers on its own port/);
    },
  );
  await step(
    "a second reading gives each element the same number, and a password field shows no value",
    async () => {
      const again = await driver.read();
      assert.deepEqual(
        again.elements.map((item) => [item.index, item.label]),
        seen.elements.map((item) => [item.index, item.label]),
      );
      const secret = again.elements.find((item) => item.password);
      assert.ok(secret, "the password field is listed");
      assert.equal("value" in secret!, false);
    },
  );
  await step("a click is a trusted event of the browser", async () => {
    const after = await driver.click(number(seen, "Check the click"));
    assert.match(after.text, /Check the click trusted/);
  });
  await step(
    "a click whose centre is covered is refused, and nothing reaches the page",
    async () => {
      await assert.rejects(
        driver.click(number(seen, "Covered button")),
        /under another element at its centre \(span\)\. Nothing was sent/,
      );
      assert.match((await driver.read()).text, /Covered button\n0\n/);
    },
  );
  await step(
    "typed text replaces the old text of a field that a framework controls, and stays",
    async () => {
      await driver.type(number(seen, "Your name"), "Ada Brook", false);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const after = await driver.read();
      assert.equal(
        after.elements.find((item) => item.label === "Your name")!.value,
        "Ada Brook",
      );
      assert.match(after.text, /\nAda Brook\n/);
    },
  );
  await step("no text goes into a password field", async () => {
    const secret = seen.elements.find((item) => item.password)!;
    await assert.rejects(
      driver.type(secret.index, "not-a-real-secret", false),
      /password field\. The worker never types a password/,
    );
    const after = await driver.read();
    assert.ok(!JSON.stringify(after).includes("not-a-real-secret"));
  });
  await step("text goes at the end of an editable region", async () => {
    const after = await driver.type(number(seen, "Message"), " there", false);
    assert.equal(
      after.elements.find((item) => item.label === "Message")!.value,
      "Hello there",
    );
  });
  await step(
    "select picks an option by its label, and the page hears input and change",
    async () => {
      const after = await driver.select(number(seen, "Size"), "Large");
      assert.equal(
        after.elements.find((item) => item.label === "Size")!.value,
        "Large",
      );
      assert.match(after.text, /input change/);
    },
  );
  await step("hover opens a menu that only a pointer opens", async () => {
    assert.ok(!seen.elements.some((item) => item.label === "Kettles"));
    const after = await driver.hover(number(seen, "Products"));
    assert.ok(after.elements.some((item) => item.label === "Kettles"));
  });
  await step(
    "waitFor waits for text that comes later, and says when it never came",
    async () => {
      await driver.click(number(seen, "Show later"));
      const from = Date.now();
      const after = await driver.waitFor("Ready now", 3000);
      assert.equal(after.found, true);
      assert.match(after.text, /Ready now/);
      assert.ok(Date.now() - from < 3000);
      const none = await driver.waitFor("Never on this page", 300);
      assert.equal(none.found, false);
    },
  );
  await step(
    "Enter submits a form, and the next page is read when it finished loading",
    async () => {
      await driver.type(number(seen, "Search the shop"), "blue kettle", false);
      const after = await driver.key("Enter");
      assert.equal(after.title, "Results");
      assert.equal(after.url, `${origin}/search?q=blue+kettle`);
      assert.match(after.text, /Results for blue kettle/);
      // The prices come from a slow request after the page loaded.
      assert.match(after.text, /Prices loaded/);
    },
  );
  await step("back returns to the page before", async () => {
    const after = await driver.back();
    assert.equal(after.title, "Shop desk");
  });
  await step(
    "two tabs are listed, and a switch reads the other one",
    async () => {
      const next = await driver.open(`${origin}/next`);
      assert.equal(next.title, "Second page");
      const listed = await driver.tabs();
      assert.equal(listed.title, "Second page");
      const tabs = listed.tabs ?? [];
      assert.equal(tabs.length, 2);
      assert.deepEqual(tabs.map((tab) => [tab.title, tab.active]).sort(), [
        ["Second page", true],
        ["Shop desk", false],
      ]);
      const desk = tabs.find((tab) => tab.title === "Shop desk")!;
      const switched = await driver.switchTab(desk.index);
      assert.equal(switched.title, "Shop desk");
      const again = await driver.tabs();
      assert.equal(again.tabs!.find((tab) => tab.active)!.title, "Shop desk");
    },
  );
  await step(
    "a page that replaces the hit test, a frame inside a button and a key in a password field are refused",
    async () => {
      const page = await driver.open(`${origin}/hostile`);
      // The script runs in a world of its own, which the page cannot change.
      await assert.rejects(
        driver.click(number(page, "Covered button")),
        /under another element at its centre \(span\)\. Nothing was sent/,
      );
      await assert.rejects(
        driver.click(number(page, "Framed")),
        /has a frame at its centre \(iframe\)/,
      );
      const secret = page.elements.find((item) => item.password)!;
      await driver.click(secret.index);
      await assert.rejects(
        driver.key("Space"),
        /The focus is in a password field\. The worker never presses a key there/,
      );
      assert.match((await driver.read()).text, /Covered button\n0\n/);
    },
  );
  await step(
    "extended ARIA roles, opacity: 0 filtering, select options preview, and file input guard work in real Chromium",
    async () => {
      const page = await driver.open(`${origin}/peak`);
      const byLabel = (label: string) =>
        page.elements.find((item) => item.label === label);
      assert.equal(byLabel("Country picker")?.role, "combobox");
      assert.equal(byLabel("Country picker")?.value, "collapsed");
      assert.equal(byLabel("Dark mode")?.role, "switch");
      assert.equal(byLabel("Dark mode")?.value, "checked");
      assert.equal(byLabel("Volume")?.role, "slider");
      assert.equal(byLabel("Volume")?.value, "42");
      // opacity: 0 ghost button and unlabeled opacity: 0 checkbox are dropped cleanly.
      assert.equal(byLabel("Ghost button"), undefined);
      assert.equal(byLabel("Orphan hidden checkbox"), undefined);
      // opacity: 0 custom checkbox/radio WITH visible <label> stay visible and clickable!
      const customCb = byLabel("Accept terms");
      assert.ok(customCb, "opacity: 0 checkbox with visible label is listed");
      assert.equal(customCb?.value, "not checked");
      const afterCb = await driver.click(customCb!.index);
      assert.equal(
        afterCb.elements.find((item) => item.label === "Accept terms")?.value,
        "checked",
      );
      const customRadio = afterCb.elements.find(
        (item) => item.label === "Express shipping",
      );
      assert.ok(customRadio, "opacity: 0 radio with visible label is listed");
      const afterRadio = await driver.click(customRadio!.index);
      assert.equal(
        afterRadio.elements.find((item) => item.label === "Express shipping")
          ?.value,
        "checked",
      );
      // Masked phone input is formatted once without fallback clobbering it.
      const afterPhone = await driver.type(
        number(afterRadio, "Phone number"),
        "5551234567",
        false,
      );
      assert.equal(
        afterPhone.elements.find((item) => item.label === "Phone number")
          ?.value,
        "(555) 123-4567",
      );
      assert.match(afterPhone.text, /Phone number 1\b/);
      // <select> surfaces option preview metadata without altering label/value.
      const color = afterPhone.elements.find(
        (item) => item.label === "Color",
      ) as
        (BrowserPage["elements"][number] & { options?: string[] }) | undefined;
      assert.equal(color?.value, "Red");
      assert.deepEqual(color?.options, ["Red", "Blue", "Green"]);
      // Clicking <input type="file"> refuses cleanly instead of hanging on native dialog.
      await assert.rejects(
        driver.click(number(afterPhone, "Upload file")),
        /file upload input.*native file picker dialog/i,
      );
    },
  );
  await step(
    "MutationObserver quiescence settles after dynamic DOM updates while ignoring rapid CSS style flicker",
    async () => {
      const page = await driver.read();
      const from = Date.now();
      const after = await driver.click(number(page, "Trigger dynamic DOM"));
      const elapsed = Date.now() - from;
      assert.match(after.text, /Settled after mutations/);
      // Must not hit the 3s navigation cap despite 15ms inline style spinner.
      assert.ok(elapsed < 1200, `expected fast settle, got ${elapsed}ms`);
    },
  );
  await step(
    "same-origin and cross-origin (OOPIF) iframes are read, translated, clicked, typed, and password-masked",
    async () => {
      const page = await driver.read();
      // Same-origin iframe elements appear with password value masked.
      const frameBtn = page.elements.find(
        (item) => item.label === "Frame action",
      );
      assert.ok(frameBtn, "same-origin iframe button listed");
      const framePw = page.elements.find(
        (item) => item.label === "Frame secret",
      );
      assert.ok(framePw?.password, "iframe password field marked");
      assert.equal("value" in framePw!, false);
      assert.ok(!JSON.stringify(page).includes("top-secret"));
      // Clicking inside same-origin iframe translates coordinates accurately.
      const afterClick = await driver.click(frameBtn!.index);
      assert.match(afterClick.text, /Frame action 1/);
      // Typing inside same-origin iframe works.
      const afterType = await driver.type(
        number(afterClick, "Frame note"),
        "hello frame",
        false,
      );
      assert.equal(
        afterType.elements.find((item) => item.label === "Frame note")?.value,
        "hello frame",
      );
      // Cross-origin OOPIF iframe button is read and clicked!
      const xBtn = afterType.elements.find(
        (item) => item.label === "Cross frame action",
      );
      assert.ok(xBtn, "cross-origin OOPIF button listed");
      const afterCross = await driver.click(xBtn!.index);
      assert.match(afterCross.text, /Cross frame action 1/);

      // Nested same-origin iframe INSIDE cross-origin OOPIF inherits OOPIF session and works!
      const nestedOopifBtn = afterCross.elements.find(
        (item) => item.label === "Nested OOPIF action",
      );
      assert.ok(
        nestedOopifBtn,
        "nested same-origin-inside-OOPIF button listed",
      );
      const afterNestedOopif = await driver.click(nestedOopifBtn!.index);
      assert.match(afterNestedOopif.text, /Nested OOPIF action 1/);

      // Nested-iframe clickjacking overlay inside outer iframe is caught and refused!
      const coveredNested = afterNestedOopif.elements.find(
        (item) => item.label === "Covered nested button",
      );
      assert.ok(coveredNested, "nested covered button listed");
      await assert.rejects(
        driver.click(coveredNested!.index),
        /under another element at its centre \(div\)\. Nothing was sent/,
      );
      assert.match((await driver.read()).text, /Covered nested button 0/);

      // Deterministic key() focus walk: refuses password in same-origin iframe,
      // cross-origin OOPIF, and nested 2-level iframe, while allowing normal iframe inputs!
      const latest = await driver.read();
      await driver.click(number(latest, "Frame secret"));
      await assert.rejects(
        driver.key("Space"),
        /password field\. The worker never presses a key there/,
      );
      await driver.click(number(latest, "Cross secret"));
      await assert.rejects(
        driver.key("Space"),
        /password field\. The worker never presses a key there/,
      );
      await driver.click(number(latest, "Nested secret"));
      await assert.rejects(
        driver.key("Space"),
        /password field\. The worker never presses a key there/,
      );
      await driver.click(number(latest, "Frame note"));
      await driver.key("Cmd+A");
      const clearedFrameNote = await driver.key("Delete");
      assert.equal(
        clearedFrameNote.elements.find((item) => item.label === "Frame note")
          ?.value,
        "",
      );
    },
  );
  await step(
    "fresh navigation waits real 80ms MutationObserver quiet window to capture post-load hydration",
    async () => {
      const hydrated = await driver.open(`${origin}/hydrate`);
      assert.match(hydrated.text, /Hydrated after 35ms/);
      const listed = await driver.tabs();
      const peakTab = listed.tabs!.find(
        (tab) => tab.title === "Peak controls",
      )!;
      await driver.switchTab(peakTab.index);
    },
  );
  await step(
    "native date input, Cmd+A and Delete keys work cleanly",
    async () => {
      const page = await driver.read();
      const afterDate = await driver.type(
        number(page, "Delivery date"),
        "2026-11-14",
        false,
      );
      assert.equal(
        afterDate.elements.find((item) => item.label === "Delivery date")
          ?.value,
        "2026-11-14",
      );
      await driver.click(number(afterDate, "Edit box"));
      await driver.key("Cmd+A");
      const afterDel = await driver.key("Delete");
      assert.equal(
        afterDel.elements.find((item) => item.label === "Edit box")?.value,
        "",
      );
    },
  );
  await step(
    "clicking a target='_blank' link auto-tracks and switches to the popup tab",
    async () => {
      const page = await driver.read();
      const popup = await driver.click(number(page, "Open popup"));
      assert.equal(popup.title, "Popup page");
      assert.equal(popup.url, `${origin}/popup`);
      const listed = await driver.tabs();
      assert.equal(listed.tabs?.find((tab) => tab.active)?.title, "Popup page");
      assert.ok(
        listed.tabs?.some((tab) => tab.title === "Peak controls"),
        "opener tab still listed",
      );
      // Switch back to Peak controls to test nav error capture.
      const peakTab = listed.tabs!.find(
        (tab) => tab.title === "Peak controls",
      )!;
      const backToPeak = await driver.switchTab(peakTab.index);
      const failed = await driver.click(number(backToPeak, "Broken link"));
      assert.match(
        pageError(failed) ?? "",
        /ERR_CONNECTION_REFUSED|ERR_UNSAFE_PORT|ERR_/,
      );
      // chrome-error: pages offer zero elements and refuse all input actions!
      assert.deepEqual(failed.elements, []);
      await assert.rejects(driver.click(1), /one of its own pages/);
      await assert.rejects(driver.key("Enter"), /one of its own pages/);
      await assert.rejects(driver.scroll("down"), /one of its own pages/);
    },
  );
  await step(
    "read() and tabs() still throw dialogText on open dialogs while handleDialog answers confirm() and prompt() cleanly in real Chromium",
    async () => {
      const page = await driver.open(`${origin}/wave2`);
      await assert.rejects(
        driver.click(number(page, "Ask confirm")),
        /Proceed with order\?/,
      );
      await assert.rejects(driver.read(), /Proceed with order\?/);
      await assert.rejects(driver.tabs(), /Proceed with order\?/);
      const acceptedConfirm = await driver.handleDialog(true);
      assert.equal(acceptedConfirm.dialog, undefined);
      assert.match(acceptedConfirm.text, /Confirm result: confirmed/);

      await assert.rejects(
        driver.click(number(acceptedConfirm, "Ask confirm")),
        /Proceed with order\?/,
      );
      const dismissedConfirm = await driver.handleDialog(false);
      assert.match(dismissedConfirm.text, /Confirm result: cancelled/);

      await assert.rejects(
        driver.click(number(dismissedConfirm, "Ask prompt")),
        /Order tag\?/,
      );
      await assert.rejects(driver.read(), /Order tag\?/);
      const answeredPrompt = await driver.handleDialog(true, "RUSH-9");
      assert.equal(answeredPrompt.dialog, undefined);
      assert.match(answeredPrompt.text, /Prompt result: tag=RUSH-9/);
    },
  );
  await step(
    "fillForm fills a 3-field form including multiline textarea, rejects single-line newlines, fails closed on password fields, and throws BrowserInputUnknown on mid-form failure",
    async () => {
      const page = await driver.read();
      const nameIdx = number(page, "Customer name");
      const tierIdx = number(page, "Plan tier");
      const notesIdx = number(page, "Delivery notes");
      const pwIdx = number(page, "Account password");
      const lockAIdx = number(page, "Lock trigger");
      const lockBIdx = number(page, "Locked target");

      // Single-line input rejects newlines with nothing typed.
      await assert.rejects(
        driver.type(nameIdx, "Ada\nBrook", false),
        /single-line field/,
      );

      // Batch form fill fails closed BEFORE any input when any field is a password field.
      await assert.rejects(
        driver.fillForm([
          { index: nameIdx, text: "ShouldNotWrite" },
          { index: pwIdx, text: "secret-pw" },
        ]),
        /password field/,
      );
      const stillEmpty = await driver.read();
      assert.equal(
        stillEmpty.elements.find((item) => item.label === "Customer name")
          ?.value,
        "",
      );

      // 3-field batch fill including multiline <textarea>.
      const filled = await driver.fillForm([
        { index: nameIdx, text: "Ada Brook" },
        { index: tierIdx, text: "Pro" },
        { index: notesIdx, text: "Line one\nLine two\nLine three" },
      ]);
      assert.equal(
        filled.elements.find((item) => item.label === "Customer name")?.value,
        "Ada Brook",
      );
      assert.equal(
        filled.elements.find((item) => item.label === "Plan tier")?.value,
        "Pro",
      );
      assert.match(filled.text, /lines:3\|Line one \/ Line two \/ Line three/);

      // Mid-form failure after field 1 was filled wraps in BrowserInputUnknown.
      await assert.rejects(
        driver.fillForm([
          { index: lockAIdx, text: "Trigger" },
          { index: lockBIdx, text: "Blocked" },
        ]),
        (error) =>
          error instanceof BrowserInputUnknown &&
          /already filling 1 field\(s\)/.test(error.message) &&
          /is disabled now/.test(error.message),
      );
    },
  );
  await step(
    "scrollToElement scrolls an off-screen button into view and lets it be clicked",
    async () => {
      const page = await driver.read();
      const farIdx = number(page, "Far below button");
      const scrolled = await driver.scrollToElement(farIdx);
      const clicked = await driver.click(number(scrolled, "Far below button"));
      assert.match(clicked.text, /far:scrolled/);
    },
  );
  await step(
    "newTab and closeTab manage tabs and extract paginates a long document without script, style, hidden or password text",
    async () => {
      const beforeTabs = (await driver.tabs()).tabs?.length ?? 0;
      const longTab = await driver.newTab(`${origin}/long`);
      assert.equal(longTab.title, "Long handbook");
      const afterNewTabs = (await driver.tabs()).tabs?.length ?? 0;
      assert.equal(afterNewTabs, beforeTabs + 1);

      let offset = 0;
      let combined = "";
      let chunks = 0;
      let totalChars = 0;
      for (;;) {
        const slice = await driver.extract({ offset, maxChars: 2000 });
        assert.equal(slice.title, "Long handbook");
        assert.equal(slice.url, `${origin}/long`);
        assert.equal(slice.offset, offset);
        assert.ok(slice.text.length <= 2000);
        totalChars = slice.totalChars;
        combined += slice.text;
        offset += slice.text.length;
        chunks += 1;
        if (!slice.hasMore) break;
        assert.ok(chunks < 20, "pagination terminates");
      }
      assert.ok(totalChars > 5000, `expected >5000 chars, got ${totalChars}`);
      assert.ok(chunks >= 3, `expected >=3 chunks, got ${chunks}`);
      assert.equal(combined.length, totalChars);
      assert.match(combined, /Section 1:/);
      assert.match(combined, /Section 120:/);
      assert.ok(!combined.includes("SECRET_SCRIPT_MARKER"));
      assert.ok(!combined.includes("hidden-css-marker"));
      assert.ok(!combined.includes("HIDDEN_DIV_MARKER"));
      assert.ok(!combined.includes("HIDDEN_OPACITY_INJECTION"));
      assert.ok(!combined.includes("HIDDEN_ARIA_INJECTION"));
      assert.ok(!combined.includes("HIDDEN_PW_MARKER"));

      // Close the newly opened /long tab and verify tab count drops cleanly and stale listing is cleared.
      const afterClose = await driver.closeTab();
      assert.notEqual(afterClose.title, "Long handbook");
      await assert.rejects(driver.switchTab(1), /from the last list of tabs/);
      const remainingCount = (await driver.tabs()).tabs?.length ?? 0;
      assert.equal(remainingCount, beforeTabs);
    },
  );
  await step(
    "a browser that ended takes no input, and a read starts it again",
    async () => {
      const before = holder();
      process.kill(before, "SIGKILL");
      for (let wait = 0; wait < 50 && running(before); wait++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await assert.rejects(
        driver.click(1),
        /closed\. Nothing was sent\. Read the page again/,
      );
      const fresh = await driver.read();
      assert.equal(fresh.browser, "own");
      assert.notEqual(holder(), before);
      const desk = await driver.open(`${origin}/`);
      assert.equal(desk.title, "Shop desk");
    },
  );
  await step(
    "close shuts the control port at once, and the browser ends",
    async () => {
      const pid = holder();
      const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8");
      await driver.close();
      const [number, path] = port.trim().split("\n");
      const answered = await new Promise<boolean>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${number}${path}`);
        socket.onopen = () => {
          socket.close();
          resolve(true);
        };
        socket.onerror = () => resolve(false);
      });
      assert.equal(answered, false, "the control port is closed");
      // The program ends by itself a little later.
      const until = Date.now() + 20_000;
      while (running(pid) && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(running(pid), false);
      const said = await driver.doctor();
      assert.match(said.reason, /starts at the first browser step/);
    },
  );
} finally {
  await driver.close();
  site.close();
  crossSite.close();
  try {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch {
    // Ignore cleanup race if browser is still exiting after an earlier failure.
  }
}
console.log(`Own browser: ${checks} checks passed`);
