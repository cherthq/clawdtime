import { serve } from "@hono/node-server";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { createTaskAudioStopApp } from "../src/control/task-audio-stop.js";

let stopped = 0;
const origin = "http://127.0.0.1:14324";
const app = createTaskAudioStopApp({
  origin,
  stop: async () => {
    stopped++;
  },
  status: () => ({ state: stopped ? "stopping" : "ready", ended: false }),
});
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 14324 });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage();
  await page.goto(origin);
  await page.getByRole("button", { name: "Stop call", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector("#stop")?.hasAttribute("disabled"),
  );
  await page.waitForFunction(() =>
    /Stopping|stopping/.test(
      document.querySelector("#state")?.textContent ?? "",
    ),
  );
  assert.equal(stopped, 1);
  console.log(
    "Local Stop browser check passed: real button click reached authenticated stop exactly once; no call or media.",
  );
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}
