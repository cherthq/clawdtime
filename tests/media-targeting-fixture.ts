/** In-memory synthetic screenshots and input inside a fresh headless browser only. */
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import type { LanguageModel } from "ai";
import jpegCodec from "jpeg-js";
import {
  ScreenConversationAgent,
  type Observation,
  type ConversationTurn,
} from "../src/control/conversation.js";
import type { Frame, InputAction } from "../src/contracts.js";
import {
  ControlPreflightError,
  sanitizeControlPreflightDiagnostics,
  type ConversationPreflightDiagnostics,
} from "../src/control/errors.js";

export interface TargetingProbeOptions {
  width?: number;
  height?: number;
  text?: string;
  captureScale?: number;
  layout?: "right" | "mirrored" | "compact";
}

/** Fixed offline cases; geometry is visible only through the screenshot. */
export const targetingEvaluationCases: {
  name: string;
  options: TargetingProbeOptions;
}[] = [
  { name: "right-native", options: { width: 1108, height: 720 } },
  {
    name: "right-scaled",
    options: { width: 1477, height: 960, captureScale: 0.75 },
  },
  {
    name: "mirrored",
    options: { width: 1108, height: 720, layout: "mirrored" },
  },
  {
    name: "compact",
    options: { width: 1280, height: 720, layout: "compact", text: "Draft" },
  },
];
export async function runTargetingProbe(
  model: LanguageModel,
  options: TargetingProbeOptions = {},
) {
  const width = options.width ?? 1108;
  const height = options.height ?? 720;
  const text = options.text ?? "Hello ClawdTime";
  const layout = options.layout ?? "right";
  const target =
    layout === "mirrored"
      ? { left: 330, top: 360, width: 180, height: 54 }
      : layout === "compact"
        ? {
            left: Math.floor(width * 0.6) - 70,
            top: 420,
            width: 140,
            height: 36,
          }
        : { left: width - 240, top: 245, width: 180, height: 54 };
  const notesLeft = layout === "mirrored" ? width - 280 : 30;
  const direction = layout === "right" ? " on the right" : "";
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync("/Applications/Google Chrome.app")
      ? { channel: "chrome" }
      : {}),
  });
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: options.captureScale ?? 1,
    });
    // This fixture cannot load remote pages or reach any application account.
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><style>
      *{box-sizing:border-box}body{margin:0;background:#edf0f5;font:18px Arial;color:#172237}
      header{height:100px;background:#16263f;color:white;padding:30px}
      aside{position:absolute;left:0;top:100px;bottom:0;width:280px;background:#d4dce9;padding:30px}
      main{position:absolute;left:310px;top:135px;right:30px}
      label{display:block;margin:18px 0 10px;font-weight:bold}
      input{font:20px Arial;border:3px solid #485670;border-radius:6px;padding:10px;height:54px;outline:none}
      #notes{position:absolute;left:${notesLeft}px;top:245px;width:220px;background:white}
      #notesLabel{position:absolute;left:${notesLeft}px;top:192px}
      #titleLabel{position:absolute;left:${target.left}px;top:${target.top - 53}px;width:${target.width}px}
      #title{position:absolute;left:${target.left}px;top:${target.top}px;width:${target.width}px;height:${target.height}px;background:rgb(232,16,169);${layout === "compact" ? "font-size:18px;padding:4px 8px;line-height:20px;" : ""}}
      #title:focus{background:rgb(60,220,80);border-color:#0a6020}
    </style></head><body><header>Disposable ClawdTime targeting fixture</header>
      <aside>Workspace<br><br>Draft settings</aside><main><h2>Edit this draft</h2><p>Choose the Title field${direction}.</p></main>
      <label id="notesLabel" for="notes">Notes</label><input id="notes" aria-label="Notes" value="">
      <label id="titleLabel" for="title">Title</label><input id="title" aria-label="Title" value="">
      <script>window.fixtureEvents=[];for(const id of ['title','notes']){const e=document.getElementById(id);for(const event of ['click','input'])e.addEventListener(event,()=>window.fixtureEvents.push({target:id,event}));}</script>
    </body></html>`);
    let sequence = 0;
    let latest: Frame | undefined;
    const actions: InputAction[] = [];
    const afterActions: {
      kind: InputAction["kind"];
      focusedField: string;
      focusedFieldBeforeAction: string;
      targetValue: string;
      otherValue: string;
    }[] = [];
    const observe = async (): Promise<Observation> => {
      const jpeg = await page.screenshot({
        type: "jpeg",
        quality: 90,
        caret: "hide",
      });
      const dimensions = jpegCodec.decode(jpeg, { useTArray: true });
      latest = {
        id: `fixture-frame-${++sequence}`,
        capturedAt: Date.now(),
        width: dimensions.width,
        height: dimensions.height,
      };
      const rawDataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
      return {
        frame: latest,
        dataUrl: rawDataUrl,
      };
    };
    const tools: ConversationTurn["tools"] = {
      observe,
      act: async (frameId, action) => {
        if (!latest || latest.id !== frameId)
          throw new Error("Fixture requires exact latest screenshot identity");
        const sourceFrameId = latest.id;
        // Held-back grading only; this focus value never enters a tool result.
        const focusedFieldBeforeAction = await page.evaluate(
          () => document.activeElement?.id ?? "",
        );
        actions.push(action);
        if (action.kind === "click") {
          // Match the helper's normalized full-display mapping. The screenshot
          // has no FaceTime video header or letterboxing to subtract.
          await page.mouse.click(
            action.x * (width - 1),
            action.y * (height - 1),
          );
        } else if (action.kind === "type") {
          await page.keyboard.insertText(action.text);
        } else {
          throw new Error(
            "This fixture authorizes only requested click and typing",
          );
        }
        afterActions.push(
          await page.evaluate(
            ({ kind, focusedFieldBeforeAction }) => ({
              kind,
              focusedFieldBeforeAction,
              focusedField: document.activeElement?.id ?? "",
              targetValue: (
                document.getElementById("title") as HTMLInputElement
              ).value,
              otherValue: (document.getElementById("notes") as HTMLInputElement)
                .value,
            }),
            { kind: action.kind, focusedFieldBeforeAction },
          ),
        );
        return {
          ...(await observe()),
          receipt: {
            id: `fixture-action-${actions.length}`,
            leaseId: "fixture-lease",
            frameId: sourceFrameId,
            state: "observed" as const,
            createdAt: Date.now(),
          },
        };
      },
      feedback: async () => {
        throw new Error("Fixture never resumes a coding session");
      },
      screenFeedback: async () => {
        throw new Error("Fixture is not handset visibility evidence");
      },
      stop: async () => ({ stopped: true }),
    };
    let reply: string | undefined;
    let error: string | undefined;
    let diagnostics: ConversationPreflightDiagnostics | undefined;
    // Match the agent budget, excluding disposable browser startup and grading.
    const startedAt = performance.now();
    try {
      const result = await new ScreenConversationAgent(
        { frameImage: async () => observe() },
        model,
      ).run({
        text: `Click the Title textbox${direction} and type ${JSON.stringify(text)}. Leave Notes unchanged, inspect the result, and tell me what you see.`,
        question: "Review the draft title.",
        history: [],
        capabilities: { control: true },
        signal: AbortSignal.timeout(50_000),
        tools,
      });
      reply = result.reply;
    } catch (failure) {
      if (failure instanceof ControlPreflightError) {
        const safe = sanitizeControlPreflightDiagnostics(failure.diagnostics);
        if (safe?.phase === "conversation") diagnostics = safe;
      }
      const code =
        failure && typeof failure === "object" && "code" in failure
          ? failure.code
          : undefined;
      error =
        typeof code === "string" && /^[a-z_]{1,64}$/.test(code)
          ? code
          : "fixture_failed";
    }
    const elapsedMs = Math.ceil(performance.now() - startedAt);
    const targetValue = await page
      .getByRole("textbox", { name: "Title", exact: true })
      .inputValue();
    const otherValue = await page
      .getByRole("textbox", { name: "Notes", exact: true })
      .inputValue();
    const events = await page.evaluate(
      () =>
        (
          window as unknown as {
            fixtureEvents: { target: string; event: string }[];
          }
        ).fixtureEvents,
    );
    const grading = {
      withinActionBudget: actions.length <= 4,
      withinTimeBudget: elapsedMs < 45_000,
      completeActionObservations: afterActions.length === actions.length,
      notesUntouched:
        otherValue === "" &&
        afterActions.every((action) => action.otherValue === "") &&
        !events.some(
          (event) => event.target === "notes" && event.event === "input",
        ),
      typingFocusVerified: actions.every(
        (action, index) =>
          action.kind !== "type" ||
          (afterActions[index - 1]?.focusedField === "title" &&
            afterActions[index]?.focusedFieldBeforeAction === "title"),
      ),
    };
    return {
      passed:
        !error &&
        targetValue === text &&
        Object.values(grading).every(Boolean) &&
        events.some((e) => e.target === "title" && e.event === "click"),
      width,
      height,
      layout,
      elapsedMs,
      grading,
      captureWidth: latest?.width,
      captureHeight: latest?.height,
      observations: sequence,
      actions,
      afterActions,
      targetValue,
      otherValue,
      events,
      reply,
      error,
      ...(diagnostics ? { diagnostics } : {}),
      evidence: "synthetic_headless_browser_only" as const,
    };
  } finally {
    await browser.close();
  }
}
