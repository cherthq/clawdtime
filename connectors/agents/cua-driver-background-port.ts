import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  backgroundEditorGeometrySchema,
  backgroundWorkflowBindingSchema,
  type BackgroundWorkflowBinding,
} from "./background-workflow-policy.js";
import {
  CUA_DRIVER_PROBE_VERSION,
  cuaDriverProbeConfigSchema,
  probePinnedCuaDaemon,
} from "./cua-driver-probe.js";

const id = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
const safeText = z
  .string()
  .min(1)
  .max(512)
  .refine((s) => !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(s));
const token = z.string().min(1).max(4096);
const windowScopeSchema = backgroundWorkflowBindingSchema.omit({
  observationId: true,
  observationFingerprint: true,
});
export type BackgroundWindowScope = z.infer<typeof windowScopeSchema>;
export const pinnedBackgroundPortConfigSchema =
  cuaDriverProbeConfigSchema.extend({
    allowedApps: z
      .array(
        z
          .object({
            bundleId: z.string().regex(/^[A-Za-z0-9.-]+$/),
            executablePath: z.string().startsWith("/"),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    driverGeneration: id,
    session: id,
    callTimeoutMs: z.number().int().min(100).max(15000).default(10000),
  });
export type PinnedBackgroundPortConfig = z.infer<
  typeof pinnedBackgroundPortConfigSchema
>;
export type BackgroundPortLeaseScope = {
  driverGeneration: string;
  operation:
    | "start_session"
    | "end_session"
    | "launch_app"
    | "get_window_state"
    | "click"
    | "type_text"
    | "scroll";
  target?: BackgroundWindowScope | BackgroundWorkflowBinding;
  actionId?: string;
  bundleId?: string;
  expectedExecutablePath?: string;
  /** Transient exact action for positive workflow admission; never log/persist here. */
  action?: {
    type:
      | "click-element"
      | "click-point"
      | "type-element"
      | "type-pixel-draft"
      | "scroll-element";
    elementToken?: string;
    text?: string;
    geometry?: z.infer<typeof backgroundEditorGeometrySchema>;
    direction?: "up" | "down";
    amount?: number;
  };
};
/**
 * The supervisor MUST hold its generation/execution lease through `run`, verify
 * the exact live call, process/window/observation and qualified workflow, and
 * reserve an encrypted receipt before input. Cleanup end_session must remain
 * admissible for this exact reserved session after revocation; it cannot grant
 * new input or release an unresolved receipt. A callback alone is not atomic OS
 * target protection. This port cannot independently establish that guarantee.
 */
export interface BackgroundPortHostWitness {
  withLease<T>(
    scope: BackgroundPortLeaseScope,
    signal: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T>;
}
type FixedTool = BackgroundPortLeaseScope["operation"];
export interface BackgroundDriverObservation {
  isError: boolean;
  degraded: boolean;
  structuredJson?: string;
  images?: { dataBase64: string; mimeType: string }[];
  text?: string;
}
interface DriverSdk {
  executionMode(): number;
  socketPath(): string;
  metadata(options: {
    signal: AbortSignal;
  }): Promise<{ driverVersion: string; pid: number; embedded: boolean }>;
  callTool(
    tool: FixedTool,
    argumentsJson: string,
    options: { signal: AbortSignal },
  ): Promise<BackgroundDriverObservation>;
  shutdown(options: { signal: AbortSignal }): Promise<void>;
  uniffiDestroy(): void;
}
export type BackgroundPortOutcome = {
  dispatch: "not_started" | "returned" | "unknown";
  effect:
    | "confirmed"
    | "unverifiable"
    | "suspected_noop"
    | "partial"
    | "refused"
    | "unknown";
  driverVerified: boolean;
  workflowVerified: false;
  /** Unverified launch candidates; host must independently bind their lifetimes. */
  launched?: {
    pid: number;
    bundleId: string;
    windowIds: string[];
    selfActivationSuppressed?: boolean;
  };
  code:
    | "returned"
    | "invalid_request"
    | "admission_closed"
    | "duplicate_attempt"
    | "not_started"
    | "interrupted_completed"
    | "unknown";
};
const outcome = (
  dispatch: BackgroundPortOutcome["dispatch"],
  code: BackgroundPortOutcome["code"],
  effect: BackgroundPortOutcome["effect"] = "unknown",
  driverVerified = false,
): BackgroundPortOutcome => ({
  dispatch,
  effect,
  driverVerified,
  workflowVerified: false,
  code,
});
const returnedEffectSchema = z.object({
  effect: z
    .enum(["confirmed", "unverifiable", "suspected_noop", "partial", "refused"])
    .optional(),
  verified: z.boolean().optional(),
});
const mutationBase = z
  .object({ actionId: id, binding: backgroundWorkflowBindingSchema })
  .strict();
const elementInput = mutationBase.extend({ elementToken: token });
const geometryInput = mutationBase.extend({
  geometry: backgroundEditorGeometrySchema,
});

/** Fixed 0.55.0 daemon calls. No planner receives the SDK or a generic tool call. */
export class CuaDriverBackgroundPort {
  private closed = false;
  private stopSignal = new AbortController();
  private poisoned = false;
  private busy = false;
  private started = false;
  private attempts = new Set<string>();
  private active: { promise: Promise<unknown>; readOnly: boolean } | undefined;
  private closing: Promise<{ quiescence: "known" | "unknown" }> | undefined;
  private readonly config: PinnedBackgroundPortConfig;
  constructor(
    config: PinnedBackgroundPortConfig,
    private readonly sdk: DriverSdk,
    private readonly host: BackgroundPortHostWitness,
    private readonly socketUnchanged: () => Promise<boolean>,
    private readonly daemonMode = 1,
  ) {
    this.config = pinnedBackgroundPortConfigSchema.parse(config);
  }

  private async invoke(
    tool: FixedTool,
    args: Record<string, unknown>,
    scope: Omit<BackgroundPortLeaseScope, "operation" | "driverGeneration">,
    signal: AbortSignal,
    allowClosed = false,
    onDispatch: () => void = () => {},
  ): Promise<BackgroundDriverObservation> {
    const bounded = AbortSignal.any([
      signal,
      ...(!allowClosed ? [this.stopSignal.signal] : []),
      AbortSignal.timeout(this.config.callTimeoutMs),
    ]);
    const app =
      scope.target || scope.bundleId
        ? this.config.allowedApps.find(
            (item) =>
              item.bundleId === (scope.target?.bundleId ?? scope.bundleId),
          )
        : undefined;
    if ((scope.target || scope.bundleId) && !app)
      throw Error("target_outside_configured_scope");
    // Diagnostics precede the host's final witness. No awaited work remains
    // between its admitted run callback and the one native SDK dispatch.
    bounded.throwIfAborted();
    if (
      (!allowClosed && (this.closed || this.poisoned)) ||
      !(await this.socketUnchanged())
    )
      throw Error("driver_generation_changed");
    const metadata = await this.sdk.metadata({ signal: bounded });
    if (
      metadata.driverVersion !== CUA_DRIVER_PROBE_VERSION ||
      metadata.pid !== this.config.expectedPid ||
      metadata.embedded ||
      this.sdk.executionMode() !== this.daemonMode ||
      this.sdk.socketPath() !== this.config.socketPath ||
      !(await this.socketUnchanged())
    )
      throw Error("driver_generation_changed");
    if (
      scope.target &&
      (scope.target.driverGeneration !== this.config.driverGeneration ||
        scope.target.driverVersion !== CUA_DRIVER_PROBE_VERSION ||
        !this.config.allowedApps.some(
          (app) => app.bundleId === scope.target!.bundleId,
        ))
    )
      throw Error("target_outside_configured_scope");
    let invoked = false;
    const result = await this.host.withLease(
      {
        ...scope,
        ...(app ? { expectedExecutablePath: app.executablePath } : {}),
        driverGeneration: this.config.driverGeneration,
        operation: tool,
      },
      bounded,
      async () => {
        if (invoked) throw Error("duplicate_host_dispatch");
        invoked = true;
        bounded.throwIfAborted();
        if (!allowClosed && (this.closed || this.poisoned))
          throw Error("admission_closed");
        onDispatch();
        return this.sdk.callTool(tool, JSON.stringify(args), {
          signal: bounded,
        });
      },
    );
    if (!invoked) throw Error("host_did_not_dispatch");
    return result;
  }

  async startSession(signal: AbortSignal): Promise<boolean> {
    if (this.closed || this.poisoned || this.busy || this.started) return false;
    this.busy = true;
    try {
      const operation = this.invoke(
        "start_session",
        { session: this.config.session },
        {},
        signal,
      );
      this.active = { promise: operation, readOnly: false };
      const result = await operation;
      const started = z
        .object({
          session: z.literal(this.config.session),
          active: z.literal(true),
          revived: z.literal(false),
        })
        .safeParse(JSON.parse(result.structuredJson ?? "null"));
      this.started = !result.isError && started.success && !this.closed;
      if (!this.started) this.poisoned = true;
      return this.started;
    } catch {
      this.poisoned = true;
      return false;
    } finally {
      this.active = undefined;
      this.busy = false;
    }
  }

  /** No output files; caller must keep the screenshot/tree transient. */
  observe(
    raw: unknown,
    signal: AbortSignal,
  ): Promise<BackgroundDriverObservation> {
    return this.readWindow(raw, false, signal);
  }
  /** Presentation-only frames preserve planner tokens and its pixel frame. */
  capturePreview(
    raw: unknown,
    signal: AbortSignal,
  ): Promise<BackgroundDriverObservation> {
    return this.readWindow(raw, true, signal);
  }
  private async readWindow(
    raw: unknown,
    displayOnly: boolean,
    signal: AbortSignal,
  ): Promise<BackgroundDriverObservation> {
    const target = windowScopeSchema.parse(raw);
    if (!this.started || this.closed || this.poisoned || this.busy)
      throw Error("Background observation admission closed.");
    this.busy = true;
    const operation = this.invoke(
      "get_window_state",
      {
        ...this.targetArgs(target),
        include_accessibility_tree: !displayOnly,
        include_screenshot: true,
        ...(displayOnly ? { display_only: true } : {}),
        tree_format: "both",
        verbose: true,
        full_output: true,
        max_elements: 10000,
        max_depth: 40,
        timeout_ms: 2000,
        ...(displayOnly
          ? { max_dimension: 1280 }
          : { max_image_dimension: 2400 }),
        ...(displayOnly
          ? { screenshot_format: "jpeg", screenshot_quality: 85 }
          : {}),
      },
      { target },
      signal,
    );
    this.active = { promise: operation, readOnly: true };
    try {
      const result = await operation;
      if (result.isError) throw Error("Background observation unavailable.");
      return result;
    } catch {
      throw Error("Background observation unavailable.");
    } finally {
      this.active = undefined;
      this.busy = false;
    }
  }

  private targetArgs(target: BackgroundWindowScope) {
    const windowId = Number(target.windowId);
    if (
      !Number.isSafeInteger(windowId) ||
      windowId <= 0 ||
      String(windowId) !== target.windowId
    )
      throw Error("invalid_window_id");
    return {
      session: this.config.session,
      pid: target.pid,
      window_id: windowId,
    };
  }
  private async action(
    raw: unknown,
    schema: z.ZodType,
    tool: "click" | "type_text" | "scroll",
    argsFor: (input: any) => Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<BackgroundPortOutcome> {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return outcome("not_started", "invalid_request");
    const input = parsed.data as {
      actionId: string;
      binding: BackgroundWorkflowBinding;
    };
    if (
      !this.started ||
      this.closed ||
      this.poisoned ||
      this.busy ||
      signal.aborted
    )
      return outcome("not_started", "admission_closed");
    if (this.attempts.has(input.actionId))
      return outcome("not_started", "duplicate_attempt");
    this.attempts.add(input.actionId);
    this.busy = true;
    let args: Record<string, unknown>;
    try {
      args = {
        ...this.targetArgs(input.binding),
        scope: "window",
        delivery_mode: "background",
        ...argsFor(parsed.data),
      };
    } catch {
      this.busy = false;
      return outcome("not_started", "invalid_request");
    }
    let dispatched = false;
    const exact = parsed.data as any;
    const action: NonNullable<BackgroundPortLeaseScope["action"]> =
      tool === "click"
        ? exact.geometry
          ? { type: "click-point", geometry: exact.geometry }
          : { type: "click-element", elementToken: exact.elementToken }
        : tool === "type_text"
          ? exact.geometry
            ? {
                type: "type-pixel-draft",
                geometry: exact.geometry,
                text: exact.text,
              }
            : {
                type: "type-element",
                elementToken: exact.elementToken,
                text: exact.text,
              }
          : {
              type: "scroll-element",
              elementToken: exact.elementToken,
              direction: exact.direction,
              amount: exact.amount,
            };
    const operation = this.invoke(
      tool,
      args,
      { target: input.binding, actionId: input.actionId, action },
      signal,
      false,
      () => {
        dispatched = true;
      },
    );
    this.active = { promise: operation, readOnly: false };
    try {
      const result = await operation;
      // A refusal after a pixel focus step may already have posted input. Only
      // explicit SDK NotStarted proves zero dispatch, not generic Tool errors.
      if (result.isError) {
        this.poisoned = true;
        return outcome("unknown", "unknown");
      }
      let parsedEffect;
      try {
        parsedEffect = returnedEffectSchema.safeParse(
          JSON.parse(result.structuredJson ?? "{}"),
        );
      } catch {
        /* no trustworthy effect */
      }
      const effect = parsedEffect?.success
        ? (parsedEffect.data.effect ?? "unknown")
        : "unknown";
      if (effect === "refused" || effect === "partial") this.poisoned = true;
      return outcome(
        "returned",
        "returned",
        effect,
        effect === "confirmed" &&
          parsedEffect?.success === true &&
          parsedEffect.data.verified === true,
      );
    } catch (error) {
      if (!dispatched) return outcome("not_started", "not_started");
      const interrupted = z
        .object({
          tag: z.literal("ActionInterrupted"),
          inner: z.object({ completion: z.number().int() }),
        })
        .safeParse(error);
      if (interrupted.success && interrupted.data.inner.completion === 0)
        return outcome("not_started", "not_started");
      this.poisoned = true;
      if (interrupted.success && interrupted.data.inner.completion === 1)
        return outcome("returned", "interrupted_completed");
      return outcome("unknown", "unknown");
    } finally {
      this.active = undefined;
      this.busy = false;
    }
  }

  clickElement(input: unknown, signal: AbortSignal) {
    return this.action(
      input,
      elementInput,
      "click",
      (i) => ({ element_token: i.elementToken, button: "left", count: 1 }),
      signal,
    );
  }
  /** Geometry must be independently validated and approved by host.withLease. */
  clickQualifiedPoint(input: unknown, signal: AbortSignal) {
    return this.action(
      input,
      geometryInput,
      "click",
      (i) => ({
        x: i.geometry.bounds.x + i.geometry.bounds.width / 2,
        y: i.geometry.bounds.y + i.geometry.bounds.height / 2,
        button: "left",
        count: 1,
      }),
      signal,
    );
  }
  typeElement(input: unknown, signal: AbortSignal) {
    return this.action(
      input,
      elementInput.extend({ text: safeText }),
      "type_text",
      (i) => ({ element_token: i.elementToken, text: i.text }),
      signal,
    );
  }
  typePixelDraft(input: unknown, signal: AbortSignal) {
    return this.action(
      input,
      geometryInput.extend({ text: safeText }),
      "type_text",
      (i) => ({
        x: i.geometry.bounds.x + i.geometry.bounds.width / 2,
        y: i.geometry.bounds.y + i.geometry.bounds.height / 2,
        text: i.text,
      }),
      signal,
    );
  }
  /** Amount is wheel notches (not screenshot pixels), fixed to line granularity. */
  scrollElement(input: unknown, signal: AbortSignal) {
    return this.action(
      input,
      elementInput.extend({
        direction: z.enum(["up", "down"]),
        amount: z.number().int().min(1).max(5),
      }),
      "scroll",
      (i) => ({
        element_token: i.elementToken,
        direction: i.direction,
        amount: i.amount,
        by: "line",
      }),
      signal,
    );
  }

  /** App launch is a separately reserved effect; exact configured bundle only. */
  async launchQualifiedApp(
    raw: unknown,
    signal: AbortSignal,
  ): Promise<BackgroundPortOutcome> {
    const input = z
      .object({ actionId: id, bundleId: z.string().min(1) })
      .strict()
      .safeParse(raw);
    if (
      !input.success ||
      !this.config.allowedApps.some(
        (app) => app.bundleId === input.data.bundleId,
      )
    )
      return outcome("not_started", "invalid_request");
    if (this.closed || this.poisoned || this.busy || signal.aborted)
      return outcome("not_started", "admission_closed");
    if (this.attempts.has(input.data.actionId))
      return outcome("not_started", "duplicate_attempt");
    this.attempts.add(input.data.actionId);
    this.busy = true;
    let dispatched = false;
    const operation = this.invoke(
      "launch_app",
      { bundle_id: input.data.bundleId },
      input.data,
      signal,
      false,
      () => {
        dispatched = true;
      },
    );
    this.active = { promise: operation, readOnly: false };
    try {
      const result = await operation;
      if (result.isError) {
        this.poisoned = true;
        return outcome("unknown", "unknown");
      }
      let launched;
      try {
        const candidate = z
          .object({
            pid: z.number().int().positive(),
            bundle_id: z.literal(input.data.bundleId),
            windows: z
              .array(
                z.object({ window_id: z.number().int().positive().safe() }),
              )
              .max(128),
            self_activation_suppressed: z.boolean().optional(),
          })
          .safeParse(JSON.parse(result.structuredJson ?? "null"));
        if (candidate.success)
          launched = {
            pid: candidate.data.pid,
            bundleId: candidate.data.bundle_id,
            windowIds: candidate.data.windows.map((window) =>
              String(window.window_id),
            ),
            ...(candidate.data.self_activation_suppressed !== undefined
              ? {
                  selfActivationSuppressed:
                    candidate.data.self_activation_suppressed,
                }
              : {}),
          };
      } catch {
        /* An unavailable identity cannot be promoted to verified launch. */
      }
      return {
        ...outcome("returned", "returned"),
        ...(launched ? { launched } : {}),
      };
    } catch {
      if (!dispatched) return outcome("not_started", "not_started");
      this.poisoned = true;
      return outcome("unknown", "unknown");
    } finally {
      this.active = undefined;
      this.busy = false;
    }
  }

  /** Revoke new input synchronously; cancellation does not prove OS quiescence. */
  stop(): void {
    this.closed = true;
    this.stopSignal.abort();
  }

  /** Close admission synchronously; cleanup never certifies an unknown input. */
  endSession(): Promise<{ quiescence: "known" | "unknown" }> {
    this.stop();
    return (this.closing ??= (async () => {
      const pending = this.active;
      if (pending) {
        try {
          await pending.promise;
        } catch {
          // A canceled observation sent no native input. Exact session cleanup
          // and SDK shutdown below must still succeed before quiescence is known.
          if (!pending.readOnly) this.poisoned = true;
        }
      }
      try {
        const result = await this.invoke(
          "end_session",
          { session: this.config.session },
          {},
          AbortSignal.timeout(5000),
          true,
        );
        const ended = z
          .object({
            session: z.literal(this.config.session),
            active: z.literal(false),
          })
          .safeParse(JSON.parse(result.structuredJson ?? "null"));
        if (result.isError || !ended.success) this.poisoned = true;
      } catch {
        this.poisoned = true;
      }
      try {
        await this.sdk.shutdown({ signal: AbortSignal.timeout(5000) });
      } catch {
        this.poisoned = true;
      } finally {
        this.sdk.uniffiDestroy();
      }
      return { quiescence: this.poisoned ? "unknown" : "known" };
    })());
  }
}

/** Preflight does not grant workflow authority. Host witness remains mandatory. */
export async function connectPinnedBackgroundDaemon(
  raw: unknown,
  host: BackgroundPortHostWitness,
  signal: AbortSignal,
) {
  const config = pinnedBackgroundPortConfigSchema.parse(raw);
  const probe = await probePinnedCuaDaemon(
    cuaDriverProbeConfigSchema.parse({
      sdkDirectory: config.sdkDirectory,
      socketPath: config.socketPath,
      executablePath: config.executablePath,
      expectedPid: config.expectedPid,
      manifestSha256: config.manifestSha256,
      policySha256: config.policySha256,
      targets: config.targets,
    }),
    signal,
  );
  if (probe.status !== "inventory_only")
    throw Error("Pinned background daemon is not ready.");
  const baseline = await lstat(config.socketPath);
  const stamp = (stat: Awaited<ReturnType<typeof lstat>>) =>
    `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.uid}:${stat.mode}`;
  const socketUnchanged = async () => {
    try {
      const now = await lstat(config.socketPath);
      return now.isSocket() && stamp(now) === stamp(baseline);
    } catch {
      return false;
    }
  };
  const root = join(
    config.sdkDirectory,
    "node_modules",
    "@trycua",
    "cua-driver",
  );
  const packageInfo = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  if (packageInfo.version !== CUA_DRIVER_PROBE_VERSION)
    throw Error("Pinned driver SDK changed.");
  const sdk = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  const driver = sdk.CuaDriver.connect(config.socketPath);
  return new CuaDriverBackgroundPort(
    config,
    driver,
    host,
    socketUnchanged,
    sdk.DriverExecutionMode.Daemon,
  );
}
