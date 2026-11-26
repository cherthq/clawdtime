/** Synthetic browser QA; uses an isolated backend and never captures the desktop. */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const output = resolve(process.argv[2] ?? "/tmp/clawdtime-argos-review");
await mkdir(output, { recursive: true });
const child = spawn(
  process.execPath,
  [
    "node_modules/tsx/dist/cli.mjs",
    "scripts/preview-camera.ts",
    "--port",
    "3349",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const lines = createInterface({ input: child.stdout });
const ready = new Promise<string>((resolveReady, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("Preview did not start.")),
    30000,
  );
  child.once("exit", (code) => {
    clearTimeout(timeout);
    reject(new Error(`Preview exited ${code}.`));
  });
  lines.on("line", (line) => {
    if (line.startsWith("Synthetic camera preview: ")) {
      clearTimeout(timeout);
      resolveReady(line.slice(26));
    }
  });
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const url = await ready;
  assert.equal(new URL(url).hostname, "127.0.0.1");
  // Reuse installed Chrome with a disposable profile; no browser download required.
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1360, height: 1080 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLImageElement>("#frame")?.naturalWidth === 1280,
  );
  assert.equal(
    new URL(page.url()).hash,
    "",
    "Credential leaves the address bar",
  );
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLImageElement>("#frame")?.naturalWidth === 1280,
  );
  // A separate browser context cannot inherit this tab's temporary access.
  const unauthenticated = await browser.newPage();
  let unauthenticatedRequests = 0;
  unauthenticated.on("request", (request) => {
    if (/^\/(preview|sessions)\//.test(new URL(request.url()).pathname))
      unauthenticatedRequests++;
  });
  await unauthenticated.goto(new URL("/", url).href);
  await unauthenticated.waitForTimeout(600);
  assert.equal(
    await unauthenticated.locator("#frame").getAttribute("src"),
    null,
  );
  assert.equal(await unauthenticated.locator("#start").isEnabled(), false);
  assert.equal(
    unauthenticatedRequests,
    0,
    "Missing credentials must not poll the API",
  );
  await unauthenticated.close();

  for (const status of [401, 403, 410]) {
    const rejected = await browser.newPage();
    let rejectedRequests = 0;
    await rejected.route("**/preview/info", async (route) => {
      rejectedRequests++;
      await route.fulfill({ status, body: "Preview access ended" });
    });
    await rejected.goto(url);
    await rejected.waitForTimeout(600);
    assert.equal(
      rejectedRequests,
      1,
      "Rejected credentials must not retry automatically",
    );
    assert.equal(await rejected.evaluate(() => sessionStorage.length), 0);
    assert.equal(await rejected.locator("#start").isEnabled(), false);
    await rejected.close();
  }
  await page.screenshot({
    path: resolve(output, "overview.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Focus region", exact: true }).click();
  await page.waitForTimeout(700);
  await page
    .getByRole("button", { name: "Add / update mark", exact: true })
    .click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Context card", exact: true }).click();
  await page.waitForTimeout(200);
  await page.screenshot({
    path: resolve(output, "focus-annotated.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Freeze", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector("#status")?.textContent?.includes("paused"),
  );
  await page.screenshot({
    path: resolve(output, "paused.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector("#status")?.textContent?.includes("live"),
  );
  await page.getByRole("button", { name: "Clear marks", exact: true }).click();
  await page.getByRole("button", { name: "STOP sharing", exact: true }).click();
  await page.waitForTimeout(600);
  assert.equal(
    await page.locator("#frame").getAttribute("src"),
    null,
    "Stop must clear the displayed image, including in-flight fetches",
  );
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  await page.reload();
  await page.waitForTimeout(600);
  assert.equal(await page.locator("#frame").getAttribute("src"), null);
  assert.equal(await page.locator("#start").isEnabled(), false);
  await page.screenshot({
    path: resolve(output, "stopped.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    `PASS synthetic browser: reload authentication, missing/rejected credentials, focus, marks/context, freeze/resume, clear, Stop/reload, no script errors. Images: ${output}`,
  );
} finally {
  await browser?.close();
  lines.close();
  child.kill("SIGINT");
  await new Promise<void>((resolveExit) => {
    if (child.exitCode !== null) resolveExit();
    else child.once("exit", () => resolveExit());
  });
}
