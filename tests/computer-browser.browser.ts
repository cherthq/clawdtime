/**
 * The browser driver against real browser engines.
 *
 * The unit tests prove the page script on a hand-made document. This check
 * runs the driver itself, with its real page script, in a real page of
 * Chromium and of WebKit, with no window. Only the command is replaced: where
 * the driver would start /usr/bin/osascript, the same script text is
 * evaluated in the page, and the answer is printed as osascript prints it.
 *
 * It needs the browsers of Playwright (`npm run cua:install-browser` for
 * Chromium). An engine that does not start is skipped, with the reason.
 * It opens no window, uses no browser of the person and sends nothing out:
 * the pages come from a server on this computer that this check starts.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chromium,
  webkit,
  type BrowserType,
  type Page,
} from "@playwright/test";
import {
  AppleEventsBrowser,
  openScript,
  probeScript,
  runScript,
  supportedBrowsers,
  type CommandRunner,
  type SupportedBrowser,
} from "../connectors/computer/browser.js";

const desk = `<!doctype html>
<html><head><meta charset="utf-8"><title>Order desk</title></head><body>
<h1>Order desk</h1>
<p id="intro">Welcome to the desk.</p>
<a id="next" href="/next">Next page</a>
<button id="count">Add one</button> <span id="counter">0</span>
<button id="unavailable" disabled>Unavailable</button>
<button id="later" aria-disabled="true">Not yet</button>
<label for="name">Your name</label> <input id="name" type="text">
<div id="mirror"></div>
<label>Secret <input id="secret" type="password" value="not-a-real-secret"></label>
<form id="find" action="/search" method="get">
  <input type="search" name="q" aria-label="Search the desk">
  <button type="submit">Search</button>
</form>
<textarea id="note" aria-label="Note"></textarea>
<select id="size" aria-label="Size"><option>Small</option><option>Large</option></select>
<input id="agree" type="checkbox"> <label for="agree">I agree</label>
<div id="rich" contenteditable="true" aria-label="Message"></div>
<div id="custom" role="button" tabindex="0">Custom button</div> <span id="customs">0</span>
<div style="display:none"><button>Hidden button</button></div>
<div id="host"></div>
<div style="height:3000px"></div>
<button id="far">Far button</button> <span id="fars">0</span>
<script>
  var bump = function (id) {
    var el = document.getElementById(id);
    el.textContent = String(Number(el.textContent) + 1);
  };
  document.getElementById("count").addEventListener("click", function () { bump("counter"); });
  document.getElementById("custom").addEventListener("click", function () { bump("customs"); });
  document.getElementById("far").addEventListener("click", function () { bump("fars"); });
  var shadow = document.getElementById("host").attachShadow({ mode: "open" });
  shadow.innerHTML = '<button id="inner">Shadow button</button>';
  shadow.getElementById("inner").addEventListener("click", function () {
    document.body.setAttribute("data-shadow", "clicked");
  });
  // A field that a framework controls, as a common one does: the framework
  // follows the value through a setter on the element, ignores an input event
  // that brings no new value, and writes its own state back into the field.
  (function () {
    var el = document.getElementById("name");
    var native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    var tracked = native.get.call(el);
    var state = "";
    Object.defineProperty(el, "value", {
      configurable: true,
      get: function () { return native.get.call(this); },
      set: function (text) { tracked = String(text); native.set.call(this, text); }
    });
    el.addEventListener("input", function () {
      var now = native.get.call(el);
      if (now === tracked) return;
      tracked = now;
      state = now;
      document.getElementById("mirror").textContent = state;
    });
    setInterval(function () {
      if (native.get.call(el) !== state) { native.set.call(el, state); tracked = state; }
    }, 30);
  })();
</script>
</body></html>`;

const page2 = `<!doctype html>
<html><head><meta charset="utf-8"><title>Second page</title></head><body>
<h1>Second page</h1><a href="/">Back to the desk</a><button>Only here</button>
</body></html>`;

/**
 * Pages that work against the script: each one changes built-in functions
 * that a script in the page could use, to forge the answer.
 */
const tampering: Record<string, string> = {
  json: `JSON.stringify = function () { return '{"ok":true,"page":{"title":"Forged","url":"https://bank.example/","text":"","elements":[]}}'; };
    JSON.parse = function () { return { ok: true }; };
    Object.prototype.toJSON = function () { return "forged"; };`,
  arrays: `Array.prototype.push = function () { return 0; };
    Array.prototype.join = function () { return "forged"; };
    Array.prototype.concat = function () { return []; };`,
  strings: `String.prototype.replace = function () { return "https://bank.example/"; };
    String.prototype.slice = function () { return "https://bank.example/"; };`,
};
const hostile = (set: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Hostile page</title></head><body>
<h1>Hostile page</h1>
<button id="honest">Honest button</button>
<script>${tampering[set] ?? ""}</script>
</body></html>`;

function serve() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const html = (body: string) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    };
    if (url.pathname === "/") return html(desk);
    if (url.pathname === "/next") return html(page2);
    if (url.pathname === "/hostile")
      return html(hostile(url.searchParams.get("set") ?? ""));
    if (url.pathname === "/search") {
      const asked = (url.searchParams.get("q") ?? "").replace(/[^\w ]/g, "");
      return html(
        `<!doctype html><html><head><title>Results</title></head><body><h1>Results for ${asked}</h1></body></html>`,
      );
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

/** The command of the driver, done in the page: what osascript would print. */
function inPage(page: Page, browser: SupportedBrowser): CommandRunner {
  const printed = (stdout: string) => ({ status: 0, stdout, stderr: "" });
  return async (_command, args) => {
    const [, script, argument] = args;
    if (script === probeScript) return printed(`front ${browser.id}\n`);
    if (script === openScript(browser)) {
      await page.goto(argument!, { waitUntil: "commit" });
      return printed("clawdtime:opened");
    }
    if (script === runScript(browser)) {
      try {
        const answer: unknown = await page.evaluate(argument!);
        return printed(
          answer === undefined || answer === null
            ? "clawdtime:no-answer"
            : String(answer),
        );
      } catch {
        // The document left while the script ran. The real browser gives no answer then.
        return printed("clawdtime:no-answer");
      }
    }
    throw new Error("The driver ran a command that this check does not know.");
  };
}

async function check(
  name: string,
  type: BrowserType,
  browser: SupportedBrowser,
  origin: string,
) {
  // CLAWDTIME_CHECK_CHROMIUM or CLAWDTIME_CHECK_WEBKIT names the program of
  // an engine that is on this computer, when it is not the one that this
  // version of Playwright looks for.
  const program = process.env[`CLAWDTIME_CHECK_${name.toUpperCase()}`];
  let engine;
  try {
    engine = await type.launch({
      headless: true,
      ...(program ? { executablePath: program } : {}),
    });
  } catch (error) {
    const why = String(error).split("\n")[0]!.slice(0, 200);
    console.log(`${name}: skipped, the engine did not start. ${why}`);
    return 0;
  }
  let checks = 0;
  const step = async (title: string, run: () => Promise<void>) => {
    try {
      await run();
      checks += 1;
    } catch (error) {
      console.log(`${name}: FAILED: ${title}`);
      throw error;
    }
  };
  try {
    const page = await engine.newPage();
    const driver = new AppleEventsBrowser(inPage(page, browser));
    const inThePage = <T>(expression: string) =>
      page.evaluate(expression) as Promise<T>;
    const number = (
      elements: { index: number; label: string; tag: string }[],
      label: string,
    ) => {
      const found = elements.filter((item) => item.label === label);
      assert.equal(found.length, 1, `one element named "${label}"`);
      return found[0]!.index;
    };

    let seen = await driver.open(`${origin}/`);
    await step(
      "a reading has the title, the address, the text and the controls",
      async () => {
        assert.equal(seen.title, "Order desk");
        assert.equal(seen.url, `${origin}/`);
        assert.match(seen.text, /Welcome to the desk\./);
        const labels = seen.elements.map((item) => item.label);
        for (const label of [
          "Next page",
          "Add one",
          "Unavailable",
          "Your name",
          "Search the desk",
          "Search",
          "Note",
          "Size",
          "I agree",
          "Message",
          "Custom button",
          "Shadow button",
          "Far button",
        ])
          assert.ok(labels.includes(label), `the reading lists "${label}"`);
        assert.ok(
          !labels.includes("Hidden button"),
          "a hidden control is left out",
        );
        for (const label of ["Unavailable", "Not yet"])
          assert.equal(
            seen.elements.find((item) => item.label === label)!.disabled,
            true,
            `"${label}" is marked as disabled`,
          );
      },
    );
    await step(
      "a password field is marked, and its text never leaves the page",
      async () => {
        const secret = seen.elements.find((item) => item.password);
        assert.ok(secret, "the password field is listed");
        assert.equal("value" in secret!, false);
        assert.ok(!JSON.stringify(seen).includes("not-a-real-secret"));
      },
    );
    await step(
      "a second reading gives each element the same number",
      async () => {
        const again = await driver.read();
        assert.deepEqual(
          again.elements.map((item) => [item.index, item.label]),
          seen.elements.map((item) => [item.index, item.label]),
        );
      },
    );
    await step("a click reaches the page's own handler, once", async () => {
      await driver.click(number(seen.elements, "Add one"));
      assert.equal(
        await inThePage("document.getElementById('counter').textContent"),
        "1",
      );
      await driver.click(number(seen.elements, "Custom button"));
      assert.equal(
        await inThePage("document.getElementById('customs').textContent"),
        "1",
      );
    });
    await step(
      "a click works on a control far down the page and inside a shadow tree",
      async () => {
        await driver.click(number(seen.elements, "Far button"));
        assert.equal(
          await inThePage("document.getElementById('fars').textContent"),
          "1",
        );
        await driver.click(number(seen.elements, "Shadow button"));
        assert.equal(
          await inThePage("document.body.getAttribute('data-shadow')"),
          "clicked",
        );
      },
    );
    await step(
      "typed text reaches a framework that controls the field, and stays",
      async () => {
        await driver.type(
          number(seen.elements, "Your name"),
          "Ada Lovelace",
          false,
        );
        await page.waitForTimeout(120);
        assert.equal(
          await inThePage("document.getElementById('mirror').textContent"),
          "Ada Lovelace",
        );
        const after = await driver.read();
        assert.equal(
          after.elements.find((item) => item.label === "Your name")!.value,
          "Ada Lovelace",
        );
      },
    );
    await step(
      "text goes into a text area, an editable region, a list of choices and a checkbox",
      async () => {
        await driver.type(
          number(seen.elements, "Note"),
          "Leave it at the door",
          false,
        );
        assert.equal(
          await inThePage("document.getElementById('note').value"),
          "Leave it at the door",
        );
        await driver.type(
          number(seen.elements, "Message"),
          "Hello there",
          false,
        );
        assert.equal(
          await inThePage("document.getElementById('rich').textContent"),
          "Hello there",
        );
        await driver.type(number(seen.elements, "Size"), "Large", false);
        assert.equal(
          await inThePage("document.getElementById('size').value"),
          "Large",
        );
        await driver.click(number(seen.elements, "I agree"));
        assert.equal(
          await inThePage("document.getElementById('agree').checked"),
          true,
        );
      },
    );
    await step(
      "a disabled control is refused, and a number that the page does not have is an error",
      async () => {
        await assert.rejects(
          driver.click(number(seen.elements, "Unavailable")),
          /disabled/,
        );
        await assert.rejects(driver.click(9999), /not on the page/);
      },
    );
    await step(
      "a search that is sent arrives on the next page, which is read when it is ready",
      async () => {
        const results = await driver.type(
          number(seen.elements, "Search the desk"),
          "blue kettle",
          true,
        );
        assert.equal(results.title, "Results");
        assert.equal(results.url, `${origin}/search?q=blue+kettle`);
        assert.match(results.text, /Results for blue kettle/);
      },
    );
    await step("going back returns to the page before", async () => {
      const back = await driver.back();
      assert.equal(back.title, "Order desk");
    });
    await step(
      "a link leads to a new document, whose numbers are all new",
      async () => {
        const before = await driver.read();
        const highest = Math.max(...before.elements.map((item) => item.index));
        const next = await driver.click(number(before.elements, "Next page"));
        assert.equal(next.title, "Second page");
        assert.ok(next.elements.length >= 2);
        for (const item of next.elements)
          assert.ok(
            item.index > highest,
            "no number of the first document is given again",
          );
        // A number of the page before names nothing here.
        await assert.rejects(
          driver.click(number(before.elements, "Add one")),
          /not on the page/,
        );
      },
    );
    // A page can break the script, and then the driver refuses the reading.
    // It can never make the driver report another page in place of itself.
    for (const set of Object.keys(tampering))
      await step(
        `a page that changes the built-in ${set} cannot forge the answer`,
        async () => {
          const address = `${origin}/hostile?set=${set}`;
          let outcome: string;
          try {
            const read = await driver.open(address);
            assert.equal(read.url, address);
            assert.equal(read.title, "Hostile page");
            assert.ok(
              read.elements.some((item) => item.label === "Honest button"),
            );
            outcome = "read truly";
          } catch (error) {
            assert.ok(!(error instanceof assert.AssertionError), String(error));
            assert.match(
              String(error),
              /could not read|did not answer|stopped with/,
            );
            outcome = "refused";
          }
          console.log(`${name}: tampering with ${set}: ${outcome}`);
        },
      );
  } finally {
    await engine.close();
  }
  console.log(`${name}: ${checks} checks passed`);
  return checks;
}

const site = await serve();
try {
  const chrome = supportedBrowsers.find((item) => item.family !== "safari")!;
  const safari = supportedBrowsers.find((item) => item.family === "safari")!;
  const total =
    (await check("Chromium", chromium, chrome, site.origin)) +
    (await check("WebKit", webkit, safari, site.origin));
  if (!total)
    throw new Error("No browser engine is installed. Nothing was checked.");
} finally {
  site.close();
}
