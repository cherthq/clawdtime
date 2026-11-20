import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { openAiBundledCuaPlanner } from "../connectors/agents/bundled-cua-planner.js";
import type {
  CuaAction,
  CuaObservation,
} from "../src/control/cua-contracts.js";

// Paid-model planning check on synthetic windows in isolated headless Chromium.
// No native input, personal screens, accounts or network requests from the fixture.
const model = process.argv[2];
const effort = process.argv[3] === "none" ? ("none" as const) : undefined;
const apiKey = process.env.CLAWDTIME_OPENAI_API_KEY;
if (!model || !apiKey)
  throw Error("Supply an explicit model and protected API key.");
const planner = openAiBundledCuaPlanner({
  apiKey,
  model,
  reasoningEffort: effort,
});
const browser = await chromium.launch({ headless: true });
const previousActions: CuaAction[] = [];
const started = Date.now();
try {
  const context = await browser.newContext({
    viewport: { width: 1108, height: 720 },
  });
  await context.route("**/*", (route) => route.abort());
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><style>
  *{box-sizing:border-box}body{margin:0;background:#fafafa;font:20px system-ui;color:#222;display:flex;gap:40px;padding:70px 20px}section{width:510px;height:550px;background:#ededed;border:1px solid #aaa;border-radius:12px;padding:25px}h1{font-size:26px}header{font-size:14px;margin:-15px -15px 40px;border-bottom:1px solid #ccc;padding:10px}input{font:22px system-ui;width:100%;height:48px;margin:35px 0 28px}input:focus{outline:3px solid #4285f4}button{font:22px system-ui;border:1px solid #bbb;border-radius:5px;background:white;padding:4px 25px}p.result{font-size:24px;font-weight:600;margin-top:65px}</style></head><body>${["Alpha", "Beta"].map((name) => `<section id="${name}"><header>ClawdTime Native Fixture ${name}</header><h1>Native fixture ${name}</h1><p>Disposable local test. Enter the requested note and save it.</p><input id="note${name}" aria-label="${name} note" placeholder="${name} note"><button id="save${name}" onclick="document.querySelector('#result${name}').textContent='Saved ${name}: '+document.querySelector('#note${name}').value">Save ${name}</button><p class="result" id="result${name}">No note saved</p></section>`).join("")}</body></html>`);
  await page.locator("#noteAlpha").focus();
  const goal =
    "Use only ClawdTime Native Fixture Alpha and Beta. In Alpha enter exactly alpha ready and click Save Alpha. Then in Beta enter exactly beta ready and click Save Beta. Verify both saved notes.";
  const signal = AbortSignal.timeout(120_000);
  const observe = async (): Promise<CuaObservation> => {
    const targets = await page.locator("input,button").evaluateAll((elements) =>
      elements.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.id,
          role: el.tagName === "INPUT" ? "AXTextField" : "AXButton",
          x: Number(((r.x + r.width / 2) / innerWidth).toFixed(6)),
          y: Number(((r.y + r.height / 2) / innerHeight).toFixed(6)),
        };
      }),
    );
    const image = await page.screenshot({ type: "png", caret: "hide" });
    return {
      id: `fixture_${previousActions.length}_${Date.now()}`,
      capturedAt: Date.now(),
      width: 1108,
      height: 720,
      imageDataUrl: `data:image/png;base64,${image.toString("base64")}`,
      fingerprint: createHash("sha256").update(image).digest("hex"),
      context: JSON.stringify({
        deviceId: "synthetic_fixture",
        displayId: 1,
        focus: "fixture_focus_witness",
        targets: { untrusted: true, targets },
        windows: {
          untrusted: true,
          windows: ["Alpha", "Beta"].map((name) => ({
            id: `window${name}`,
            app: `com.clawdtime.fixture.${name.toLowerCase()}`,
            title: `ClawdTime Native Fixture ${name}`,
          })),
        },
      }),
    };
  };
  let completed = false;
  for (let step = 0; step < 12; step++) {
    const observation = await observe();
    const plan = await planner.plan(
      { goal, observation, previousActions },
      signal,
    );
    if (plan.kind === "pause") throw Error(`Planner paused: ${plan.reason}`);
    if (plan.kind === "done") {
      const actual = await page.locator(".result").allTextContents();
      if (
        JSON.stringify(actual) !==
        JSON.stringify(["Saved Alpha: alpha ready", "Saved Beta: beta ready"])
      )
        throw Error(
          "Premature completion refused by independent fixture state.",
        );
      const verified = await planner.verify(
        { goal, observation: await observe(), proposedSummary: plan.summary },
        signal,
      );
      if (!verified.verified)
        throw Error(
          "Separate verification did not establish the fixture result.",
        );
      completed = true;
      break;
    }
    const action = plan.action;
    if (action.type === "activate") {
      if (!["windowAlpha", "windowBeta"].includes(action.targetId))
        throw Error("Unknown fixture window.");
      await page.locator(`#note${action.targetId.slice(6)}`).focus();
    } else if (action.type === "click") {
      const targets = JSON.parse(observation.context).targets.targets as {
        id: string;
        x: number;
        y: number;
      }[];
      const target = targets.find((t) => t.x === action.x && t.y === action.y);
      if (!target) throw Error("Click was not an exact fixture target.");
      await page.locator(`#${target.id}`).click();
    } else if (action.type === "type") {
      const focused = await page.evaluate(() => document.activeElement?.id);
      const expected =
        focused === "noteAlpha"
          ? "alpha ready"
          : focused === "noteBeta"
            ? "beta ready"
            : undefined;
      if (!expected || action.text !== expected)
        throw Error("Typing was outside exact disposable fixture permission.");
      await page.keyboard.insertText(action.text);
    } else throw Error("This fixture does not grant scrolling.");
    previousActions.push(action);
    console.log(JSON.stringify({ model, step: step + 1, type: action.type }));
  }
  if (!completed) throw Error("Fixture step bound reached.");
  console.log(
    JSON.stringify({
      model,
      completed: true,
      independentFixtureVerified: true,
      steps: previousActions.length,
      elapsedMs: Date.now() - started,
      nativeInput: false,
    }),
  );
} finally {
  await browser.close();
}
