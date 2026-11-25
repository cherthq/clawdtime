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
import { OwnBrowser } from "../connectors/computer/own-browser.js";
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

function serve() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const html = (body: string) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    };
    if (url.pathname === "/") return html(desk);
    if (url.pathname === "/next") return html(second);
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

const site = await serve();
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
    console.log(`Own browser: FAILED: ${title}`);
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
      await driver.type(number(seen, "Your name"), "Ada Lovelace", false);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const after = await driver.read();
      assert.equal(
        after.elements.find((item) => item.label === "Your name")!.value,
        "Ada Lovelace",
      );
      assert.match(after.text, /\nAda Lovelace\n/);
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
  rmSync(root, { recursive: true, force: true });
}
console.log(`Own browser: ${checks} checks passed`);
