import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { chromium, type Browser } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BundledCuaBrowser } from "../connectors/agents/bundled-cua-browser.js";
import type {
  BundledCuaConfig,
  CuaAction,
} from "../src/control/cua-contracts.js";

type Config = NonNullable<BundledCuaConfig["browser"]>;
const fixture = `<!doctype html><html><body style="margin:0;background:white">
<button data-testid="demo" style="position:absolute;left:100px;top:100px;width:100px;height:40px" onclick="this.textContent='Observed'">Demo</button>
<input data-testid="entry" aria-label="Fixture input" style="position:absolute;left:100px;top:200px;width:240px;height:40px">
<label style="position:absolute;left:100px;top:300px">Password<input data-testid="credential" type="text"></label>
<div data-testid="scroller" style="position:absolute;left:500px;top:100px;width:200px;height:150px;overflow:auto"><div style="height:800px">Scroll fixture</div></div>
</body></html>`;
const click: CuaAction = { type: "click", x: 150 / 1280, y: 120 / 800 };
const focus: CuaAction = { type: "click", x: 150 / 1280, y: 220 / 800 };
const signal = () => new AbortController().signal;

describe("browser configuration boundaries", () => {
  it("refuses external automatic fixture grants and unlisted or credential-bearing URLs", () => {
    const config: Config = {
      startUrl: "https://example.test/",
      allowedOrigins: ["https://example.test"],
      headless: true,
      fixtureGrants: [{ testId: "send", type: "click" }],
    };
    expect(() => new BundledCuaBrowser(config)).toThrow("loopback");
    expect(
      () =>
        new BundledCuaBrowser({
          ...config,
          fixtureGrants: [],
          allowedOrigins: ["https://other.test"],
        }),
    ).toThrow("outside");
    expect(
      () =>
        new BundledCuaBrowser({
          ...config,
          fixtureGrants: [],
          startUrl: "https://user:password@example.test",
        }),
    ).toThrow("without credentials");
  });
});

// These tests launch only an isolated bundled headless Chromium and loopback fixture.
// Install the pinned browser with `npm exec playwright install chromium` first.
describe.skipIf(!existsSync(chromium.executablePath()))(
  "bundled Chromium loopback qualification",
  () => {
    let server: Server;
    let origin: string;
    let runtime: BundledCuaBrowser | undefined;
    let browser: Browser | undefined;
    let requests: string[];
    let clock: number;
    beforeEach(async () => {
      clock = Date.now();
      requests = [];
      server = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "http://127.0.0.1:1/not-allowed" });
          res.end();
          return;
        }
        res.setHeader("content-type", "text/html");
        res.end(fixture);
      });
      server.on("upgrade", (_request, socket) => {
        requests.push("WS upgrade");
        socket.destroy();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw Error("Fixture did not bind");
      origin = `http://127.0.0.1:${address.port}`;
    });
    afterEach(async () => {
      await runtime?.stop();
      await browser?.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    async function open(grants: Config["fixtureGrants"] = [], path = "/") {
      runtime = new BundledCuaBrowser(
        {
          startUrl: origin + path,
          allowedOrigins: [origin],
          headless: true,
          fixtureGrants: grants,
        },
        async (options) => {
          browser = await chromium.launch(options);
          return browser;
        },
        () => clock,
      );
      await runtime.open(
        {
          taskId: "fixture-task",
          sessionId: "fixture-session",
          expiresAt: clock + 60_000,
        },
        signal(),
      );
      return runtime;
    }
    const page = () => browser!.contexts()[0]!.pages()[0]!;

    it("defaults to confirmation, executes exact fixture click/type grants, and observes result", async () => {
      const device = await open([
        { testId: "demo", type: "click" },
        { testId: "entry", type: "click" },
        { testId: "entry", type: "type", text: "Fixture only" },
      ]);
      let observation = await device.observe(signal());
      expect(observation.imageDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(await device.authorize(click, observation)).toBe("allowed");
      await device.execute(
        {
          actionId: "click-once",
          observationId: observation.id,
          action: click,
        },
        signal(),
      );
      expect(await page().getByTestId("demo").innerText()).toBe("Observed");
      observation = await device.observe(signal());
      await device.execute(
        {
          actionId: "focus-once",
          observationId: observation.id,
          action: focus,
        },
        signal(),
      );
      observation = await device.observe(signal());
      expect(
        await device.authorize(
          { type: "type", text: "Other text" },
          observation,
        ),
      ).toBe("confirm");
      expect(
        await device.authorize(
          { type: "type", text: "Fixture only" },
          observation,
        ),
      ).toBe("allowed");
      await device.execute(
        {
          actionId: "type-once",
          observationId: observation.id,
          action: { type: "type", text: "Fixture only" },
        },
        signal(),
      );
      expect(await page().getByTestId("entry").inputValue()).toBe(
        "Fixture only",
      );
      observation = await device.observe(signal());
      await expect(
        device.execute(
          {
            actionId: "type-once",
            observationId: observation.id,
            action: { type: "type", text: "Fixture only" },
          },
          signal(),
        ),
      ).rejects.toThrow("already attempted");
    });
    it("grounds visible controls with bounded centers without exporting field values or page text", async () => {
      const device = await open();
      await page().getByTestId("entry").fill("synthetic private field value");
      await page().evaluate(() => {
        const paragraph = document.createElement("p");
        paragraph.textContent = "arbitrary page prose should not be in context";
        paragraph.style.cssText = "position:absolute;top:500px";
        document.body.append(paragraph);
        const privateLabel = document.createElement("label");
        privateLabel.style.cssText = "position:absolute;left:100px;top:600px";
        privateLabel.innerHTML =
          "Notes<textarea>synthetic textarea content</textarea><select><option>synthetic selected option</option></select>";
        document.body.append(privateLabel);
        const hidden = document.createElement("button");
        hidden.textContent = "Hidden target";
        hidden.style.display = "none";
        document.body.append(hidden);
        const offscreen = document.createElement("button");
        offscreen.textContent = "Offscreen target";
        offscreen.style.cssText = "position:absolute;top:2000px";
        document.body.append(offscreen);
      });
      const observation = await device.observe(signal());
      const grounding = JSON.parse(observation.context).visibleControls;
      expect(grounding.untrusted).toBe(true);
      expect(grounding.targets).toContainEqual({
        label: "Demo",
        tag: "button",
        type: "",
        x: Number((150 / 1280).toFixed(6)),
        y: 120 / 800,
        focused: false,
      });
      expect(
        grounding.targets.some(
          (target: { label: string }) => target.label === "Fixture input",
        ),
      ).toBe(true);
      expect(observation.context).not.toContain(
        "synthetic private field value",
      );
      expect(observation.context).not.toContain("arbitrary page prose");
      expect(observation.context).not.toContain("synthetic textarea content");
      expect(observation.context).not.toContain("synthetic selected option");
      expect(observation.context).not.toContain("Hidden target");
      expect(observation.context).not.toContain("Offscreen target");
      await page()
        .getByTestId("demo")
        .evaluate((el) => {
          el.setAttribute("aria-label", "Relabeled target");
        });
      await expect(
        device.execute(
          {
            actionId: "grounding-changed",
            observationId: observation.id,
            action: click,
          },
          signal(),
        ),
      ).rejects.toThrow("changed");
    });
    it("caps visible grounding at forty controls", async () => {
      const device = await open();
      await page().evaluate(() => {
        document.body.innerHTML = "";
        for (let i = 0; i < 60; i++) {
          const button = document.createElement("button");
          button.textContent = "Synthetic target " + i;
          button.style.cssText = `position:absolute;left:${(i % 10) * 120}px;top:${Math.floor(i / 10) * 60}px;width:110px;height:40px`;
          document.body.append(button);
        }
      });
      const observation = await device.observe(signal());
      const targets = JSON.parse(observation.context).visibleControls.targets;
      expect(targets).toHaveLength(40);
      expect(
        targets.every(
          (target: { x: number; y: number; label: string }) =>
            target.x >= 0 &&
            target.x <= 1 &&
            target.y >= 0 &&
            target.y <= 1 &&
            target.label.length <= 80,
        ),
      ).toBe(true);
    });
    it("refuses native window activation without affecting its owned browser", async () => {
      const device = await open();
      const observation = await device.observe(signal());
      const action: CuaAction = { type: "activate", targetId: "native-window" };
      expect(await device.authorize(action, observation)).toBe("refused");
      await expect(
        device.execute(
          {
            actionId: "not-a-browser-action",
            observationId: observation.id,
            action,
          },
          signal(),
        ),
      ).rejects.toThrow("unavailable in the isolated browser");
      expect(browser!.isConnected()).toBe(true);
      expect(await page().getByTestId("demo").innerText()).toBe("Demo");
    });
    it("requires confirmation without a fixture grant and refuses credential controls", async () => {
      const device = await open();
      const observation = await device.observe(signal());
      expect(await device.authorize(click, observation)).toBe("confirm");
      await page().getByTestId("credential").focus();
      const focused = await device.observe(signal());
      expect(
        await device.authorize({ type: "type", text: "never enter" }, focused),
      ).toBe("refused");
    });
    it("rejects changed pixels, focus, navigation, stale observations and post-Stop actions", async () => {
      const device = await open();
      let observation = await device.observe(signal());
      await page()
        .getByTestId("demo")
        .evaluate((el) => {
          el.textContent = "Changed";
        });
      await expect(
        device.execute(
          { actionId: "changed", observationId: observation.id, action: click },
          signal(),
        ),
      ).rejects.toThrow("changed");
      observation = await device.observe(signal());
      await page().getByTestId("entry").focus();
      await expect(
        device.execute(
          {
            actionId: "focus-changed",
            observationId: observation.id,
            action: click,
          },
          signal(),
        ),
      ).rejects.toThrow("changed");
      observation = await device.observe(signal());
      await page()
        .getByTestId("demo")
        .evaluate((el) => {
          el.setAttribute("data-testid", "different-control");
        });
      await expect(
        device.execute(
          {
            actionId: "same-pixels-new-target",
            observationId: observation.id,
            action: click,
          },
          signal(),
        ),
      ).rejects.toThrow("changed");
      observation = await device.observe(signal());
      clock += 2001;
      await expect(
        device.execute(
          { actionId: "stale", observationId: observation.id, action: click },
          signal(),
        ),
      ).rejects.toThrow("stale");
      await device.stop();
      await expect(device.observe(signal())).rejects.toThrow("stopped");
    });
    it("blocks network writes, popup pages, websocket connections and off-origin redirects", async () => {
      const device = await open();
      const result = await page().evaluate(async () => {
        try {
          await fetch("/write", { method: "POST", body: "synthetic" });
          return "sent";
        } catch {
          return "blocked";
        }
      });
      expect(result).toBe("blocked");
      expect(requests).not.toContain("POST /write");
      const websocket = await page().evaluate(
        () =>
          new Promise<string>((resolve) => {
            const socket = new WebSocket(
              location.origin.replace("http:", "ws:") + "/socket",
            );
            socket.onopen = () => {
              resolve("opened");
              socket.close();
            };
            socket.onclose = () => resolve("blocked");
            socket.onerror = () => resolve("blocked");
            setTimeout(() => resolve("unanswered"), 1000);
          }),
      );
      expect(websocket).toBe("blocked");
      expect(requests).not.toContain("WS upgrade");
      await page().evaluate(() => {
        window.open("/popup");
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(browser!.contexts()[0]!.pages()).toHaveLength(1);
      expect(requests).not.toContain("GET /popup");
      await expect(page().goto(origin + "/redirect")).rejects.toThrow();
      await expect(device.observe(signal())).rejects.toThrow("outside");
    });
    it("releases the owned browser process on Stop", async () => {
      const device = await open();
      expect(browser!.isConnected()).toBe(true);
      await device.stop();
      expect(browser!.isConnected()).toBe(false);
    });
  },
);
