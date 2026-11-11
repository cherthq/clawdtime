/** Built-app onboarding verification, isolated synthetic data only. */
import assert from "node:assert/strict";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { chromium } from "@playwright/test";

const { createRuntime } = await import(
  pathToFileURL(resolve("dist/src/runtime.js")).href
);
let runtime: ReturnType<typeof createRuntime>;
const server = serve({
  fetch: (request) => runtime.app.fetch(request),
  hostname: "127.0.0.1",
  port: 0,
});
await new Promise<void>((r) => server.on("listening", r));
const address = server.address();
assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
runtime = createRuntime({
  CLAWDTIME_MODE: "simulation",
  CLAWDTIME_DATABASE: ":memory:",
  CLAWDTIME_ORIGIN: origin,
});
const fixture = {
  memberId: "onboarding-fixture-member",
  recipient: "fixture-recipient",
  conversationId: "fixture-conversation",
  lineId: "fixture-line",
  deviceId: "fixture-mac",
  displayId: "1",
};
const invite = () => runtime.service.createPairingInvite(fixture);
const url = (token: string) =>
  `${origin}/pair#token=${encodeURIComponent(token)}&device=fixture-mac&display=1`;
const folder = resolve("artifacts/onboarding");
mkdirSync(folder, { recursive: true });
const local = mkdtempSync(join(tmpdir(), "clawdtime-onboarding-"));
const browser = await chromium.launch({
  headless: true,
  ...(existsSync("/Applications/Google Chrome.app")
    ? { channel: "chrome" }
    : {}),
});
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let response = await page.goto(origin);
  assert.equal(response?.status(), 200);
  await page
    .getByRole("heading", { name: "Your agent can FaceTime you." })
    .waitFor();
  await page.screenshot({
    path: resolve(folder, "landing-desktop.png"),
    fullPage: true,
  });
  await page.goto(`${origin}/pair`);
  await page
    .getByRole("status")
    .filter({ hasText: "Open the private pairing link" })
    .waitFor();
  assert(
    await page.getByRole("button", { name: "Pair this Mac" }).isDisabled(),
  );
  const first = invite();
  await page.goto(url(first.token));
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent === "",
  );
  await page.waitForFunction(() => location.hash === "");
  assert.equal(page.url(), `${origin}/pair`);
  assert.equal(await page.locator("#device").inputValue(), "fixture-mac");
  assert.equal(await page.locator("#view").isChecked(), false);
  assert.equal(await page.locator("#control").isChecked(), false);
  await page.getByRole("button", { name: "Pair this Mac" }).click();
  assert.equal(runtime.store.all("pairing").length, 0);
  await page.locator("#view").check();
  await page.locator("#control").check();
  await page.getByRole("button", { name: "Pair this Mac" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Paired. Download" })
    .waitFor();
  assert.equal(runtime.store.all("pairing").length, 1);
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Download private pairing file" })
    .click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  assert(stream);
  let raw = "";
  for await (const chunk of stream) raw += chunk.toString();
  const grant = JSON.parse(raw);
  assert.equal(grant.baseUrl, origin);
  assert.equal(grant.pairing.deviceId, "fixture-mac");
  assert.equal(grant.pairing.allowControl, true);
  assert(grant.token.length >= 32);
  assert(!(await page.locator("body").innerText()).includes(grant.token));
  await page.screenshot({
    path: resolve(folder, "paired-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(folder, "paired-mobile.png"),
    fullPage: true,
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Mobile page overflows viewport",
  );
  await page.goto("about:blank");
  await page.goto(url(first.token));
  await page.locator("#view").check();
  await page.getByRole("button", { name: "Pair this Mac" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "expired or already used" })
    .waitFor();
  const expired = invite();
  const latest = runtime.store.all("invite").at(-1);
  runtime.store.put("invite", { ...latest, expiresAt: Date.now() - 1 });
  await page.goto("about:blank");
  await page.goto(url(expired.token));
  await page.locator("#view").check();
  await page.getByRole("button", { name: "Pair this Mac" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "expired or already used" })
    .waitFor();
  assert.equal(runtime.store.all("pairing").length, 1);
  assert.deepEqual(errors, []);
  const project = join(local, "project"),
    grantPath = join(local, "grant.json");
  mkdirSync(join(project, ".codex"), { recursive: true });
  writeFileSync(
    join(project, ".codex/config.toml"),
    "# unrelated config preserved\n",
  );
  writeFileSync(grantPath, JSON.stringify(grant), { mode: 0o644 });
  const cli = async (command: string, extra: string[] = []) => {
    const child = spawn(
      process.execPath,
      [
        resolve("dist/cli/main.js"),
        command,
        "--agent",
        "codex",
        "--project",
        project,
        ...extra,
      ],
      {
        env: {
          ...process.env,
          CLAWDTIME_CONFIG_HOME: join(local, "private-state"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      error = "";
    child.stdout.on("data", (b) => (output += String(b)));
    child.stderr.on("data", (b) => (error += String(b)));
    const exit = await new Promise<number | null>((r) => child.on("exit", r));
    assert.equal(exit, 0, error);
    return output;
  };
  const connected = JSON.parse(
    await cli("connect", ["--pairing-file", grantPath]),
  );
  assert.equal(connected.connected, true);
  assert.equal(statSync(grantPath).mode & 0o777, 0o600);
  assert(
    readFileSync(join(project, ".codex/config.toml"), "utf8").includes(
      "# unrelated config preserved",
    ),
  );
  const doctor = JSON.parse(await cli("doctor"));
  assert.equal(doctor.configurationPresent, true);
  await cli("disconnect");
  assert(
    !readFileSync(join(project, ".codex/config.toml"), "utf8").includes(
      "mcp_servers.clawdtime",
    ),
  );
  assert(
    readFileSync(join(project, ".codex/config.toml"), "utf8").includes(
      "# unrelated config preserved",
    ),
  );
  assert(!existsSync(join(project, ".agents/skills/clawdtime/SKILL.md")));
  assert(runtime.store.get("pairing", grant.pairing.id).revokedAt);

  await context.close();
  console.log(
    JSON.stringify({
      passed: true,
      builtApp: true,
      checks: [
        "landing",
        "fragment-cleared",
        "same-tab-invite",
        "explicit-view-consent",
        "private-download",
        "reused-link-rejected",
        "expired-link-rejected",
        "mobile-layout",
        "no-browser-errors",
        "compiled-cli-connect-doctor-disconnect",
        "config-preservation",
      ],
      screenshots: folder,
    }),
  );
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  runtime.store.close();
  rmSync(local, { recursive: true, force: true });
}
