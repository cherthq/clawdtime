import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as settleDelay } from "node:timers/promises";
import { z } from "zod";
import type { CuaObservation } from "../../src/control/cua-contracts.js";
import type { BackgroundTaskContext } from "../../src/control/background-runtime.js";
import {
  backgroundIntentSchema,
  type BackgroundIntentPlanner,
} from "./background-intent-planner.js";
import {
  backgroundEditorGeometrySchema,
  backgroundWorkflowBindingSchema,
  type BackgroundWorkflowBinding,
} from "./background-workflow-policy.js";
import type {
  BackgroundDriverObservation,
  BackgroundPortLeaseScope,
  BackgroundPortOutcome,
  BackgroundWindowScope,
  CuaDriverBackgroundPort,
} from "./cua-driver-background-port.js";

const name = z.string().min(1).max(256);
const app = z
  .object({ bundleId: name, appVersion: name, qualificationId: name })
  .strict();
export const qualifiedBackgroundWorkflowConfigSchema = z
  .object({
    driverVersion: z.literal("0.55.0"),
    messages: app.extend({ contact: name }),
    codex: app.extend({ destination: name }),
  })
  .strict();
export type QualifiedBackgroundWorkflowConfig = z.infer<
  typeof qualifiedBackgroundWorkflowConfigSchema
>;
type Workflow = "messages-read" | "codex-draft";
type Geometry = z.infer<typeof backgroundEditorGeometrySchema>;
const frameSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().positive(),
  h: z.number().finite().positive(),
});
const elementSchema = z
  .object({
    role: z.string(),
    label: z.string().optional(),
    value: z.string().optional(),
    element_token: z.string().optional(),
    element_index: z.number().int().nonnegative().optional(),
    parent_index: z.number().int().nonnegative().optional(),
    enabled: z.boolean().optional(),
    actions: z.array(z.string()).optional(),
    frame: frameSchema.optional(),
    screenshot_frame: frameSchema.optional(),
  })
  .passthrough();
export type QualifiedBackgroundElement = z.infer<typeof elementSchema>;
export interface QualifiedBackgroundObservation {
  binding: BackgroundWorkflowBinding;
  observation: CuaObservation;
  elements: QualifiedBackgroundElement[];
  appVersion: string;
}
export interface QualifiedBackgroundGrant {
  workflow: Workflow;
  qualificationId: string;
  appVersion: string;
  destination: string;
  actionId: string;
  binding: BackgroundWorkflowBinding;
  observedAt: number;
  expiresAt: number;
  action: NonNullable<BackgroundPortLeaseScope["action"]>;
}
export interface QualifiedBackgroundWorkflowHost {
  /** Verify the signed running app/version/path and a correctly owned returned window.
   * This proves launch only; current Space, visibility and unique input eligibility
   * are separate bindFreshTarget requirements and must not be required here.
   */
  verifyLaunchedApplication(
    workflow: Workflow,
    context: BackgroundTaskContext,
    signal: AbortSignal,
    candidate: NonNullable<BackgroundPortOutcome["launched"]>,
  ): Promise<void>;
  /** Independently verify process lifetime, executable, app version and exact window. */
  bindFreshTarget(
    workflow: Workflow,
    context: BackgroundTaskContext,
    signal: AbortSignal,
    candidate?: BackgroundPortOutcome["launched"],
  ): Promise<{ scope: BackgroundWindowScope; appVersion: string }>;
  /** Keep original frames transient. Optional focus is in this screenshot's pixels. */
  present(
    observation: QualifiedBackgroundObservation,
    focus?: Geometry,
    phase?: "action" | "typing",
  ): Promise<void>;
  /** Corroborate exact mapped control/destination in the ORIGINAL screenshot; fail closed. */
  verifySurface(
    input: {
      phase:
        | "messages-row"
        | "messages-selected"
        | "codex-new-chat"
        | "codex-empty"
        | "codex-draft";
      observation: QualifiedBackgroundObservation;
      destination: string;
      control?: QualifiedBackgroundElement;
      geometry?: Geometry;
      text?: string;
    },
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Install one exact ephemeral capability for host.withLease; disarm in finally. */
  armGrant(grant: QualifiedBackgroundGrant): () => void;
}
export type QualifiedWorkflowPort = Pick<
  CuaDriverBackgroundPort,
  | "startSession"
  | "endSession"
  | "launchQualifiedApp"
  | "observe"
  | "clickElement"
  | "clickQualifiedPoint"
  | "typePixelDraft"
>;

/** Additional host boundary, not a replacement for the live/helper/generation fence. */
export function admitQualifiedGrant(
  grant: QualifiedBackgroundGrant,
  scope: BackgroundPortLeaseScope,
  now: number,
): boolean {
  if (
    !Number.isFinite(grant.observedAt) ||
    !Number.isFinite(grant.expiresAt) ||
    !grant.qualificationId ||
    !grant.appVersion ||
    !grant.destination ||
    !backgroundWorkflowBindingSchema.safeParse(grant.binding).success ||
    !(grant.workflow === "messages-read"
      ? grant.action.type === "click-point"
      : grant.workflow === "codex-draft" &&
        ["click-element", "type-pixel-draft"].includes(grant.action.type)) ||
    !Number.isFinite(now) ||
    now < grant.observedAt ||
    now >= grant.expiresAt ||
    grant.expiresAt - grant.observedAt > 5000 ||
    grant.binding.driverVersion !== "0.55.0"
  )
    return false;
  if (
    scope.actionId !== grant.actionId ||
    scope.driverGeneration !== grant.binding.driverGeneration ||
    !scope.target ||
    !scope.action
  )
    return false;
  const operation =
    grant.action.type === "type-pixel-draft" ? "type_text" : "click";
  return (
    scope.operation === operation &&
    isDeepStrictEqual(scope.target, grant.binding) &&
    isDeepStrictEqual(scope.action, grant.action)
  );
}
const stateSchema = z
  .object({
    pid: z.number().int().positive(),
    window_id: z.number().int().positive(),
    snapshot_id: z.string().min(1),
    screenshot_width: z.number().int().positive().max(2400),
    screenshot_height: z.number().int().positive().max(2400),
    screenshot_frame_valid: z.literal(true),
    screenshot_mime_type: z.enum(["image/png", "image/jpeg"]),
    window_bounds: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
    }),
    elements: z.array(elementSchema).max(10000),
    degraded: z.boolean().optional(),
    truncated: z.boolean().optional(),
  })
  .passthrough();
/** Fixed booleans only: safe to report without screenshots, app labels or tree data. */
export function summarizeBackgroundObservation(
  raw: BackgroundDriverObservation,
  expected: {
    pid: number;
    windowId: string;
    capturedAt: number;
    now: number;
    snapshotAlreadySeen?: boolean;
  },
) {
  let value: unknown;
  const oversized =
    typeof raw.structuredJson === "string" &&
    raw.structuredJson.length > 4 * 1024 * 1024;
  if (!oversized && typeof raw.structuredJson === "string") {
    try {
      value = JSON.parse(raw.structuredJson);
    } catch {
      /* malformed only */
    }
  }
  const parsed = stateSchema.safeParse(value);
  const state = parsed.success ? parsed.data : undefined;
  const object =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const image = raw.images?.length === 1 ? raw.images[0] : undefined;
  return {
    toolError: raw.isError === true,
    degraded: raw.degraded === true || object.degraded === true,
    structuredOversized: oversized,
    malformedStructure: !parsed.success,
    truncated: object.truncated === true,
    frameInvalid: object.screenshot_frame_valid !== true,
    identityMismatch:
      !!state &&
      (state.pid !== expected.pid ||
        String(state.window_id) !== expected.windowId),
    repeatedSnapshot: expected.snapshotAlreadySeen === true,
    staleFrame:
      !Number.isFinite(expected.capturedAt) ||
      !Number.isFinite(expected.now) ||
      expected.now < expected.capturedAt ||
      expected.now - expected.capturedAt >= 5000,
    imageInvalid:
      !image ||
      !state ||
      image.mimeType !== state.screenshot_mime_type ||
      typeof image.dataBase64 !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64) ||
      image.dataBase64.length > 12 * 1024 * 1024,
    aspectMismatch:
      !!state &&
      Math.abs(
        state.screenshot_height -
          (state.window_bounds.height * state.screenshot_width) /
            state.window_bounds.width,
      ) > 2,
  };
}
export class QualifiedBackgroundObservationError extends Error {
  constructor(
    readonly flags: ReturnType<typeof summarizeBackgroundObservation>,
  ) {
    super("Observation identity or frame is unproven.");
    this.name = "QualifiedBackgroundObservationError";
  }
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const sameScope = (a: BackgroundWindowScope, b: BackgroundWindowScope) =>
  Object.keys(a).every(
    (k) => a[k as keyof typeof a] === b[k as keyof typeof b],
  );
const one = (
  elements: QualifiedBackgroundElement[],
  predicate: (e: QualifiedBackgroundElement) => boolean,
) => {
  const matches = elements.filter(predicate);
  if (matches.length !== 1)
    throw Error("Qualified control is absent or ambiguous.");
  return matches[0]!;
};

const namedNewChat = (e: QualifiedBackgroundElement) =>
  e.role === "AXMenuItem" && e.label === "New Chat";
const menuSemantic = (e: QualifiedBackgroundElement) => {
  const {
    element_token: _token,
    element_index: _index,
    parent_index: _parent,
    ...semantic
  } = e;
  return semantic;
};
/** Exact qualified native shape: New Chat -> unlabeled AXMenu -> File -> AXMenuBar. */
function nativeNewChatPath(
  elements: QualifiedBackgroundElement[],
  menu: QualifiedBackgroundElement,
): QualifiedBackgroundElement[] | undefined {
  const indexed = new Map<number, QualifiedBackgroundElement>();
  for (const e of elements) {
    if (e.element_index === undefined) continue;
    if (indexed.has(e.element_index)) return undefined;
    indexed.set(e.element_index, e);
  }
  const path: QualifiedBackgroundElement[] = [];
  const visited = new Set<number>();
  let current: QualifiedBackgroundElement | undefined = menu;
  while (current) {
    if (
      current.element_index === undefined ||
      visited.has(current.element_index) ||
      path.length >= 4
    )
      return undefined;
    visited.add(current.element_index);
    path.push(current);
    if (current.parent_index === undefined) break;
    current = indexed.get(current.parent_index);
    if (!current) return undefined;
  }
  if (path.length !== 4) return undefined;
  const [item, container, file, bar] = path;
  if (
    !namedNewChat(item!) ||
    item!.title !== "New Chat" ||
    item!.enabled !== true ||
    item!.actions?.includes("AXPress") !== true ||
    container!.role !== "AXMenu" ||
    container!.label ||
    container!.title ||
    file!.role !== "AXMenuBarItem" ||
    file!.label !== "File" ||
    file!.title !== "File" ||
    bar!.role !== "AXMenuBar" ||
    bar!.label ||
    bar!.title ||
    bar!.parent_index !== undefined
  )
    return undefined;
  return path;
}
const diagnosticMenuKeys = new Set([
  "role",
  "label",
  "title",
  "description",
  "placeholder",
  "subrole",
  "value",
  "value_description",
  "enabled",
  "selected",
  "actions",
  "custom_actions",
  "frame",
  "screenshot_frame",
  "depth",
  "in_web_content",
  "identifier",
  "min",
  "max",
]);
export class QualifiedNativeMenuError extends Error {
  constructor(
    readonly diagnostics: {
      ancestryInvalid: boolean;
      ambiguousControl: boolean;
      changedKeys: string[];
    },
  ) {
    super("Qualified native New Chat control changed before dispatch.");
    this.name = "QualifiedNativeMenuError";
  }
}
function changedMenuKeys(
  oldPath: QualifiedBackgroundElement[],
  freshPath: QualifiedBackgroundElement[],
): string[] {
  const changed = new Set<string>();
  oldPath.forEach((entry, index) => {
    const before = menuSemantic(entry),
      after = menuSemantic(freshPath[index]!);
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      if (!isDeepStrictEqual(before[key], after[key]))
        changed.add(diagnosticMenuKeys.has(key) ? key : "otherAttribute");
  });
  return [...changed].sort();
}

/** Complete, single-use deterministic worker. No retries, sends, keys or generic actions. */
export class QualifiedBackgroundWorkflow {
  private readonly config: QualifiedBackgroundWorkflowConfig;
  private readonly stopped = new AbortController();
  private used = false;
  private snapshots = new Set<string>();
  private currentScope: BackgroundWindowScope | undefined;
  private frames = new WeakMap<
    QualifiedBackgroundObservation,
    z.infer<typeof stateSchema>
  >();
  constructor(
    config: QualifiedBackgroundWorkflowConfig,
    private readonly port: QualifiedWorkflowPort,
    private readonly planner: Pick<BackgroundIntentPlanner, "plan" | "verify">,
    private readonly host: QualifiedBackgroundWorkflowHost,
    private readonly now: () => number = Date.now,
    private readonly waitForSettle: (
      delayMs: number,
      signal: AbortSignal,
    ) => Promise<void> = (delayMs, signal) =>
      settleDelay(delayMs, undefined, { signal }),
  ) {
    this.config = qualifiedBackgroundWorkflowConfigSchema.parse(config);
  }
  stop() {
    this.stopped.abort();
  }
  close() {
    this.stop();
    return this.port.endSession();
  }
  private live(context: BackgroundTaskContext, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!context.isLive() || this.now() >= context.expiresAt)
      throw Error("Background authority expired.");
  }
  private async bind(
    workflow: Workflow,
    context: BackgroundTaskContext,
    signal: AbortSignal,
    candidate?: BackgroundPortOutcome["launched"],
  ): Promise<{ scope: BackgroundWindowScope; appVersion: string }> {
    this.live(context, signal);
    const bound = await this.host.bindFreshTarget(
      workflow,
      context,
      signal,
      candidate,
    );
    const configured =
      workflow === "messages-read" ? this.config.messages : this.config.codex;
    const scope = backgroundWorkflowBindingSchema
      .omit({ observationId: true, observationFingerprint: true })
      .parse(bound.scope);
    if (
      scope.callId !== context.callId ||
      scope.toolCallId !== context.toolCallId ||
      scope.taskId !== context.taskId ||
      scope.driverVersion !== this.config.driverVersion ||
      scope.bundleId !== configured.bundleId ||
      bound.appVersion !== configured.appVersion ||
      (this.currentScope && !sameScope(this.currentScope, scope)) ||
      (candidate &&
        (candidate.pid !== scope.pid ||
          candidate.bundleId !== scope.bundleId ||
          !candidate.windowIds.includes(scope.windowId)))
    )
      throw Error("Qualified application binding changed.");
    this.live(context, signal);
    this.currentScope = scope;
    return { scope, appVersion: bound.appVersion };
  }
  private async observe(
    workflow: Workflow,
    context: BackgroundTaskContext,
    signal: AbortSignal,
  ): Promise<QualifiedBackgroundObservation> {
    const bound = await this.bind(workflow, context, signal);
    const scope = bound.scope;
    const capturedAt = this.now();
    const raw: BackgroundDriverObservation = await this.port.observe(
      scope,
      signal,
    );
    this.live(context, signal);
    const flags = summarizeBackgroundObservation(raw, {
      ...scope,
      capturedAt,
      now: this.now(),
    });
    if (Object.values(flags).some(Boolean))
      throw new QualifiedBackgroundObservationError(flags);
    const state = stateSchema.parse(JSON.parse(raw.structuredJson!));
    const image = raw.images![0]!;
    const snapshotKey = `${scope.pid}:${state.snapshot_id}`;
    if (this.snapshots.has(snapshotKey))
      throw new QualifiedBackgroundObservationError({
        ...flags,
        repeatedSnapshot: true,
      });
    this.snapshots.add(snapshotKey);
    const fingerprint = digest(
      JSON.stringify(scope) + raw.structuredJson + image.dataBase64,
    );
    const observation: CuaObservation = {
      id: randomUUID(),
      capturedAt,
      width: state.screenshot_width,
      height: state.screenshot_height,
      imageDataUrl: `data:${image.mimeType};base64,${image.dataBase64}`,
      fingerprint,
      context: JSON.stringify({ elements: state.elements }),
    };
    const result = {
      binding: {
        ...scope,
        observationId: observation.id,
        observationFingerprint: fingerprint,
      },
      observation,
      elements: state.elements,
      appVersion: bound.appVersion,
    };
    this.frames.set(result, state);
    await this.host.present(result);
    return result;
  }
  private geometry(
    observation: QualifiedBackgroundObservation,
    element: QualifiedBackgroundElement,
  ): Geometry {
    const state = this.frames.get(observation)!;
    const s = element.screenshot_frame,
      f = element.frame;
    if (!s || !f || s.w <= 1 || s.h <= 1)
      throw Error("Qualified pixel geometry unavailable.");
    const scale = state.screenshot_width / state.window_bounds.width;
    if (
      s.x !== Math.round((f.x - state.window_bounds.x) * scale) ||
      s.y !== Math.round((f.y - state.window_bounds.y) * scale) ||
      s.w !== Math.round(f.w * scale) ||
      s.h !== Math.round(f.h * scale)
    )
      throw Error("Qualified geometry disagrees with original capture.");
    return backgroundEditorGeometrySchema.parse({
      editorId: element.element_token ?? digest(JSON.stringify(element)),
      screenshotWidth: state.screenshot_width,
      screenshotHeight: state.screenshot_height,
      bounds: { x: s.x, y: s.y, width: s.w, height: s.h },
    });
  }
  private async surface(
    phase: Parameters<
      QualifiedBackgroundWorkflowHost["verifySurface"]
    >[0]["phase"],
    observation: QualifiedBackgroundObservation,
    destination: string,
    signal: AbortSignal,
    control?: QualifiedBackgroundElement,
    geometry?: Geometry,
    text?: string,
  ) {
    if (
      !(await this.host.verifySurface(
        { phase, observation, destination, control, geometry, text },
        signal,
      ))
    )
      throw Error(
        "Original screenshot did not corroborate the qualified surface.",
      );
  }
  /** Observe asynchronous navigation only; never re-dispatch New Chat. */
  private async settleNewChat(
    context: BackgroundTaskContext,
    signal: AbortSignal,
  ) {
    const deadline = this.now() + 3000;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
    for (let attempt = 0; attempt < 4; attempt++) {
      this.live(context, bounded);
      if (this.now() >= deadline) break;
      const observed = await this.observe("codex-draft", context, bounded);
      this.live(context, bounded);
      if (this.now() >= deadline) break;
      const editors = observed.elements.filter(
        (e) =>
          e.role === "AXTextArea" &&
          e.label === "Do anything" &&
          (!e.value || e.value === "Do anything") &&
          e.enabled !== false,
      );
      if (editors.length > 1)
        throw Error(
          "Qualified empty composer is ambiguous; observation settling stopped.",
        );
      if (editors.length === 1) return { observed, editor: editors[0]! };
      if (attempt < 3) {
        const remaining = deadline - this.now();
        if (remaining <= 0) break;
        await this.waitForSettle(
          Math.min((attempt + 1) * 250, remaining),
          bounded,
        );
      }
    }
    throw Error(
      "Qualified empty composer is absent or ambiguous after bounded observation settling.",
    );
  }

  private async act(
    workflow: Workflow,
    context: BackgroundTaskContext,
    observed: QualifiedBackgroundObservation,
    destination: string,
    action: QualifiedBackgroundGrant["action"],
    signal: AbortSignal,
  ): Promise<string> {
    this.live(context, signal);
    // Rebind after vision. Coordinate actions require unchanged original pixels.
    // Only the qualified native New Chat menu can survive unrelated pixel changes;
    // its exact enabled native control and full non-token signature must persist.
    const oldControl = one(observed.elements, (e) =>
      action.type === "click-element"
        ? e.element_token === action.elementToken
        : (e.element_token ?? digest(JSON.stringify(e))) ===
          action.geometry?.editorId,
    );
    const signature = (e: QualifiedBackgroundElement) => {
      const { element_token: _token, ...rest } = e;
      return JSON.stringify(rest);
    };
    const fresh = await this.observe(workflow, context, signal);
    const nativeWorkflow =
      workflow === "codex-draft" &&
      action.type === "click-element" &&
      destination === this.config.codex.destination &&
      observed.binding.bundleId === this.config.codex.bundleId &&
      fresh.binding.bundleId === this.config.codex.bundleId &&
      observed.appVersion === this.config.codex.appVersion &&
      fresh.appVersion === this.config.codex.appVersion;
    let freshControl: QualifiedBackgroundElement;
    let qualifiedNativeNewChat = false;
    if (nativeWorkflow) {
      const oldMenus = observed.elements.filter(namedNewChat),
        freshMenus = fresh.elements.filter(namedNewChat);
      if (
        oldMenus.length !== 1 ||
        freshMenus.length !== 1 ||
        oldMenus[0] !== oldControl
      )
        throw new QualifiedNativeMenuError({
          ancestryInvalid: false,
          ambiguousControl: true,
          changedKeys: [],
        });
      freshControl = freshMenus[0]!;
      const oldPath = nativeNewChatPath(observed.elements, oldControl),
        freshPath = nativeNewChatPath(fresh.elements, freshControl);
      if (!oldPath || !freshPath)
        throw new QualifiedNativeMenuError({
          ancestryInvalid: true,
          ambiguousControl: false,
          changedKeys: changedMenuKeys([oldControl], [freshControl]),
        });
      const changedKeys = changedMenuKeys(oldPath, freshPath);
      if (changedKeys.length)
        throw new QualifiedNativeMenuError({
          ancestryInvalid: false,
          ambiguousControl: false,
          changedKeys,
        });
      qualifiedNativeNewChat = true;
    } else {
      freshControl = one(
        fresh.elements,
        (e) => signature(e) === signature(oldControl),
      );
    }
    if (
      !qualifiedNativeNewChat &&
      fresh.observation.imageDataUrl !== observed.observation.imageDataUrl
    )
      throw Error("Corroborated screenshot changed before dispatch.");
    // A duplicated or newly disabled native menu also blocks on static frames.
    if (
      workflow === "codex-draft" &&
      action.type === "click-element" &&
      !qualifiedNativeNewChat
    )
      throw Error("Qualified native New Chat control changed before dispatch.");
    action =
      action.type === "click-element"
        ? { type: "click-element", elementToken: freshControl.element_token }
        : { ...action, geometry: this.geometry(fresh, freshControl) };
    observed = fresh;
    if (action.type === "click-element" && !action.elementToken)
      throw Error("Fresh native control token unavailable.");
    await this.host.present(
      observed,
      action.geometry,
      action.type === "type-pixel-draft" ? "typing" : "action",
    );
    this.live(context, signal);
    if (this.now() - observed.observation.capturedAt > 5000)
      throw Error("Action observation expired.");
    const cfg =
      workflow === "messages-read" ? this.config.messages : this.config.codex;
    const receipt = context.reserve({
      workflow,
      operation: qualifiedNativeNewChat
        ? "codex_new_chat_navigation"
        : action.type,
      qualificationId: cfg.qualificationId,
      binding: observed.binding,
      action,
    });
    const grant: QualifiedBackgroundGrant = {
      workflow,
      qualificationId: cfg.qualificationId,
      appVersion: observed.appVersion,
      destination,
      actionId: receipt,
      binding: observed.binding,
      observedAt: observed.observation.capturedAt,
      expiresAt: Math.min(
        context.expiresAt,
        observed.observation.capturedAt + 5000,
      ),
      action,
    };
    let disarm: (() => void) | undefined;
    let invoked = false;
    let recorded = false;
    try {
      disarm = this.host.armGrant(grant);
      this.live(context, signal);
      const input = { actionId: receipt, binding: observed.binding };
      invoked = true;
      const result =
        action.type === "click-element"
          ? await this.port.clickElement(
              { ...input, elementToken: action.elementToken },
              signal,
            )
          : action.type === "click-point"
            ? await this.port.clickQualifiedPoint(
                { ...input, geometry: action.geometry },
                signal,
              )
            : await this.port.typePixelDraft(
                { ...input, geometry: action.geometry, text: action.text },
                signal,
              );
      context.returned(receipt, result.dispatch);
      recorded = true;
      if (
        result.dispatch !== "returned" ||
        result.code !== "returned" ||
        ["refused", "partial"].includes(result.effect)
      )
        throw Error("Background action outcome remains unverified.");
      return receipt;
    } catch (error) {
      if (!recorded)
        context.returned(receipt, invoked ? "unknown" : "not_started");
      throw error;
    } finally {
      disarm?.();
    }
  }
  async run(
    goal: string,
    context: BackgroundTaskContext,
    signal: AbortSignal,
  ): Promise<{ verified: boolean; summary: string }> {
    if (this.used) throw Error("Qualified worker cannot replay a workflow.");
    this.used = true;
    const bounded = AbortSignal.any([signal, this.stopped.signal]);
    this.live(context, bounded);
    const intent = backgroundIntentSchema.parse(
      await this.planner.plan(
        {
          goal,
          authorizedMessagesContact: this.config.messages.contact,
          authorizedCodexDestination: this.config.codex.destination,
        },
        bounded,
      ),
    );
    if (intent.kind === "blocked")
      return { verified: false, summary: intent.reason };
    if (!(await this.port.startSession(bounded)))
      throw Error("Background driver session unavailable.");
    this.live(context, bounded);
    const workflow = intent.kind;
    const cfg =
      workflow === "messages-read" ? this.config.messages : this.config.codex;
    const launchReceipt = context.reserve({
      workflow,
      operation: "launch_app",
      bundleId: cfg.bundleId,
    });
    const launch = await this.port.launchQualifiedApp(
      { actionId: launchReceipt, bundleId: cfg.bundleId },
      bounded,
    );
    context.returned(launchReceipt, launch.dispatch);
    if (
      launch.dispatch !== "returned" ||
      launch.code !== "returned" ||
      !launch.launched ||
      ["partial", "refused"].includes(launch.effect)
    )
      throw Error("Qualified launch remains unverified.");
    const candidate = z
      .object({
        pid: z.number().int().positive(),
        bundleId: z.literal(cfg.bundleId),
        windowIds: z
          .array(z.string().regex(/^[1-9][0-9]*$/))
          .min(1)
          .max(128),
        selfActivationSuppressed: z.boolean().optional(),
      })
      .strict()
      .safeParse(launch.launched);
    if (!candidate.success)
      throw Error("Qualified application binding changed.");
    // Launch is resolved by an independent signed running-app witness. Being on
    // another Space or having no unique input target does not undo that fact.
    this.live(context, bounded);
    await this.host.verifyLaunchedApplication(
      workflow,
      context,
      bounded,
      candidate.data,
    );
    this.live(context, bounded);
    context.verified(launchReceipt);
    // Current-Space/window eligibility remains mandatory before any observation
    // used for input and before every subsequent action's fresh target binding.
    await this.bind(workflow, context, bounded, candidate.data);
    let observed = await this.observe(workflow, context, bounded);
    const destination =
      workflow === "messages-read"
        ? this.config.messages.contact
        : this.config.codex.destination;
    let receipt: string | undefined;
    if (intent.kind === "messages-read") {
      // The selected conversation can remain visible after its sidebar row
      // scrolls out of view. Only the exact native window title plus its unique
      // enabled conversation header qualify this read-only shortcut.
      const windows = observed.elements.filter(
        (e) => e.role === "AXWindow" && e.label === destination,
      );
      const headers = observed.elements.filter(
        (e) =>
          e.role === "AXPopUpButton" &&
          e.label?.startsWith(`${destination}, `) === true &&
          e.enabled === true,
      );
      if (windows.length === 1 && headers.length === 1) {
        const header = headers[0]!;
        const geometry = this.geometry(observed, header);
        if (
          geometry.bounds.y + geometry.bounds.height >
          observed.observation.height / 4
        )
          throw Error(
            "Selected conversation header is outside the qualified header area.",
          );
        await this.surface(
          "messages-selected",
          observed,
          destination,
          bounded,
          header,
          geometry,
        );
      } else {
        const row = one(
          observed.elements,
          (e) =>
            e.role === "AXStaticText" &&
            e.label?.startsWith(`${destination},`) === true &&
            e.enabled !== false,
        );
        const geometry = this.geometry(observed, row);
        await this.surface(
          "messages-row",
          observed,
          destination,
          bounded,
          row,
          geometry,
        );
        await this.host.present(observed, geometry);
        receipt = await this.act(
          workflow,
          context,
          observed,
          destination,
          { type: "click-point", geometry },
          bounded,
        );
        observed = await this.observe(workflow, context, bounded);
        await this.surface("messages-selected", observed, destination, bounded);
      }
    } else {
      const menu = one(
        observed.elements,
        (e) => e.role === "AXMenuItem" && e.label === "New Chat",
      );
      if (
        menu.enabled !== true ||
        !menu.element_token ||
        menu.actions?.includes("AXPress") !== true
      )
        throw Error("Qualified native New Chat control is not enabled.");
      if (!nativeNewChatPath(observed.elements, menu))
        throw new QualifiedNativeMenuError({
          ancestryInvalid: true,
          ambiguousControl: false,
          changedKeys: [],
        });
      await this.surface(
        "codex-new-chat",
        observed,
        destination,
        bounded,
        menu,
      );
      const newChatReceipt = await this.act(
        workflow,
        context,
        observed,
        destination,
        { type: "click-element", elementToken: menu.element_token! },
        bounded,
      );
      const settled = await this.settleNewChat(context, bounded);
      observed = settled.observed;
      const editor = settled.editor;
      const geometry = this.geometry(observed, editor);
      await this.surface(
        "codex-empty",
        observed,
        destination,
        bounded,
        editor,
        geometry,
      );
      context.verified(newChatReceipt);
      await this.host.present(observed, geometry);
      receipt = await this.act(
        workflow,
        context,
        observed,
        destination,
        { type: "type-pixel-draft", geometry, text: intent.text },
        bounded,
      );
      observed = await this.observe(workflow, context, bounded);
      const populated = one(
        observed.elements,
        (e) =>
          e.role === "AXTextArea" &&
          e.value === intent.text &&
          e.enabled !== false,
      );
      await this.surface(
        "codex-draft",
        observed,
        destination,
        bounded,
        populated,
        this.geometry(observed, populated),
        intent.text,
      );
    }
    const result = await this.planner.verify(
      {
        goal,
        kind: workflow,
        observation: observed.observation,
        expectedDestination: destination,
        ...(intent.kind === "codex-draft" ? { expectedText: intent.text } : {}),
      },
      bounded,
    );
    this.live(context, bounded);
    if (!result.verified)
      throw Error("Independent workflow verification did not pass.");
    if (receipt !== undefined) context.verified(receipt);
    return result;
  }
}
