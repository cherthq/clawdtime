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
}
export async function runTargetingProbe(
  model: LanguageModel,
  options: TargetingProbeOptions = {},
) {
  const width = options.width ?? 1108;
  const height = options.height ?? 720;
  const text = options.text ?? "Hello ClawdTime";
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
      #notes{position:absolute;left:30px;top:245px;width:220px;background:white}
      #notesLabel{position:absolute;left:30px;top:192px}
      #titleLabel{position:absolute;right:60px;top:192px;width:180px}
      #title{position:absolute;right:60px;top:245px;width:180px;background:rgb(232,16,169)}
      #title:focus{background:rgb(60,220,80);border-color:#0a6020}
    </style></head><body><header>Disposable ClawdTime targeting fixture</header>
      <aside>Workspace<br><br>Draft settings</aside><main><h2>Edit this draft</h2><p>Choose the Title field on the right.</p></main>
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
            (kind) => ({
              kind,
              focusedField: document.activeElement?.id ?? "",
              targetValue: (
                document.getElementById("title") as HTMLInputElement
              ).value,
              otherValue: (document.getElementById("notes") as HTMLInputElement)
                .value,
            }),
            action.kind,
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
    try {
      const result = await new ScreenConversationAgent(
        { frameImage: async () => observe() },
        model,
      ).run({
        text: `Click the Title textbox on the right and type ${JSON.stringify(text)}. Leave Notes unchanged, inspect the result, and tell me what you see.`,
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
    return {
      passed:
        !error &&
        targetValue === text &&
        otherValue === "" &&
        events.some((e) => e.target === "title" && e.event === "click"),
      width,
      height,
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
