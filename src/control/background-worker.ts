import { execFileSync } from "node:child_process";
import { z } from "zod";
import type {
  BackgroundTaskContext,
  BackgroundTaskWorker,
} from "./background-runtime.js";
import type { BackgroundConfig } from "./background-config.js";
import { BackgroundLifecycle } from "./background-lifecycle.js";
import {
  BackgroundOwnership,
  backgroundTargetSchema,
} from "./background-ownership.js";
import {
  connectPinnedBackgroundDaemon,
  type BackgroundPortLeaseScope,
  type BackgroundWindowScope,
  type CuaDriverBackgroundPort,
} from "../../connectors/agents/cua-driver-background-port.js";
import {
  QualifiedBackgroundWorkflow,
  admitQualifiedGrant,
  type QualifiedBackgroundGrant,
  type QualifiedBackgroundWorkflowHost,
} from "../../connectors/agents/background-qualified-workflow.js";
import { openAiBackgroundIntentPlanner, type BackgroundSurfaceDiagnostic } from "../../connectors/agents/background-intent-planner.js";
import { BackgroundWindowVideo } from "../../media/background-window-video.mjs";
import type { CaptureBinding } from "../../media/driver-window-source.mjs";
import type { BackgroundPreview } from "./background-preview.js";

type Target = z.infer<typeof backgroundTargetSchema>;
/** Owns one whole driver session under a durable shared helper fence. */
export class QualifiedBackgroundWorker implements BackgroundTaskWorker {
  private stopped = new AbortController();
  private context?: BackgroundTaskContext;
  private ownership: BackgroundOwnership;
  private lifecycle: BackgroundLifecycle;
  private port?: CuaDriverBackgroundPort;
  private runner?: QualifiedBackgroundWorkflow;
  private grant?: QualifiedBackgroundGrant;
  private driverGeneration?: string;
  private target?: Target;
  private scope?: BackgroundWindowScope;
  private video?: BackgroundWindowVideo;
  private captureBinding?: CaptureBinding;
  private lastCaptureStatus = "no_target";
  private surfaceDiagnostic?: BackgroundSurfaceDiagnostic;
  verificationStatus() {
    return this.surfaceDiagnostic ? { ...this.surfaceDiagnostic } : null;
  }
  captureStatus() {
    return this.lastCaptureStatus;
  }
  private async captureTick() {
    if (!this.video) return;
    const result = await this.video.tick();
    this.lastCaptureStatus =
      result.status === "capture_error" ? result.code : result.status;
  }
  private effects = new Map<string, string>();
  private acquired = false;
  private portTail: Promise<unknown> = Promise.resolve();
  private flowPending = 0;
  private serialized<T>(
    workflow: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (workflow) this.flowPending++;
    const task = this.portTail.then(operation);
    this.portTail = task.catch(() => {});
    return task.finally(() => {
      if (workflow) this.flowPending--;
    });
  }
  private closing?: Promise<{ quiescence: "known" | "unknown" }>;
  constructor(
    private config: BackgroundConfig,
    ownerPath: string,
    private apiKey: string,
  ) {
    this.lifecycle = new BackgroundLifecycle(ownerPath);
    this.ownership = new BackgroundOwnership(config.native, () => this.stop());
  }
  private live(signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.stopped.signal.throwIfAborted();
    if (!this.context?.isLive()) throw Error("Background caller ended");
    this.lifecycle.assert(
      this.context.taskId,
      this.context.sessionId,
      this.config.driver.expectedPid,
    );
  }
  private app(bundleId: string) {
    const app = [this.config.messages, this.config.codex].find(
      (a) => a.bundleId === bundleId,
    );
    if (!app) throw Error("Unqualified application");
    return app;
  }
  private validateTarget(target: Target) {
    const app = this.app(target.bundleId);
    if (
      !target.onCurrentSpace ||
      target.executablePath !== app.executablePath ||
      target.bundleVersion !== app.bundleVersion
    )
      throw Error(
        "Qualified app must be nonminimized on the current desktop at its tested version",
      );
  }
  private async checkTarget(scope: BackgroundWindowScope, signal: AbortSignal) {
    const target = await this.ownership.target(
      scope.bundleId,
      scope.pid,
      scope.windowId,
      signal,
    );
    this.validateTarget(target);
    if (
      target.processStart !== scope.processStartIdentity ||
      !this.target ||
      target.geometryGeneration !== this.target.geometryGeneration ||
      target.windowId !== this.target.windowId
    )
      throw Error("Background target changed");
    return target;
  }
  private async withLease<T>(
    scope: BackgroundPortLeaseScope,
    signal: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T> {
    if (scope.operation === "end_session") {
      if (!this.context || scope.driverGeneration !== this.driverGeneration)
        throw Error("Cleanup identity changed");
      this.lifecycle.assert(
        this.context.taskId,
        this.context.sessionId,
        this.config.driver.expectedPid,
      );
      await this.ownership.verifyCleanupDriver(signal);
      return run();
    }
    this.live(signal);
    if (scope.driverGeneration !== this.driverGeneration)
      throw Error("Driver ownership changed");
    if (scope.operation === "launch_app") {
      const app = this.app(scope.bundleId ?? "");
      const witness = await this.ownership.application(app.bundleId, signal);
      if (
        witness.bundleVersion !== app.bundleVersion ||
        witness.executablePath !== app.executablePath ||
        scope.expectedExecutablePath !== app.executablePath ||
        !scope.actionId ||
        this.effects.get(scope.actionId) !== "reserved"
      )
        throw Error("Launch is not qualified or reserved");
    } else if (scope.target) {
      await this.checkTarget(scope.target, signal);
      if (!scope.action && scope.operation !== "get_window_state")
        throw Error("Unsupported background operation");
    } else if (scope.operation !== "start_session")
      throw Error("Missing exact target");
    await this.ownership.beforeDispatch(signal);
    if (
      scope.action &&
      (!this.grant ||
        !admitQualifiedGrant(this.grant, scope, Date.now()) ||
        this.effects.get(scope.actionId!) !== "reserved" ||
        !scope.target ||
        this.grant.appVersion !== this.app(scope.target.bundleId).bundleVersion)
    )
      throw Error("No exact qualified action grant");
    this.live(signal);
    return run();
  }
  async run(goal: string, context: BackgroundTaskContext, signal: AbortSignal) {
    this.context = context;
    const bounded = AbortSignal.any([signal, this.stopped.signal]);
    this.lifecycle.acquire({
      taskId: context.taskId,
      sessionId: context.sessionId,
      driverPid: this.config.driver.expectedPid,
    });
    this.acquired = true;
    const owned = await this.ownership.open(
      context,
      this.config.driver.expectedPid,
      bounded,
    );
    this.driverGeneration = owned.driverGeneration;
    this.live(bounded);
    this.port = await connectPinnedBackgroundDaemon(
      {
        ...this.config.driver,
        targets: [],
        allowedApps: [this.config.messages, this.config.codex].map(
          ({ bundleId, executablePath }) => ({ bundleId, executablePath }),
        ),
        driverGeneration: owned.driverGeneration,
        session: context.sessionId,
      },
      { withLease: this.withLease.bind(this) },
      bounded,
    );
    const planner = openAiBackgroundIntentPlanner({
      apiKey: this.apiKey,
      model: this.config.model,
      reasoningEffort: this.config.reasoningEffort,
      onSurfaceDiagnostic: (event) => { this.surfaceDiagnostic = event; },
    });
    const tracked: BackgroundTaskContext = {
      ...context,
      reserve: (action) => {
        const id = context.reserve(action);
        this.effects.set(id, "reserved");
        return id;
      },
      returned: (id, state) => {
        context.returned(id, state);
        this.effects.set(id, state);
      },
      verified: (id) => {
        context.verified(id);
        this.effects.set(id, "verified");
      },
    };
    const host: QualifiedBackgroundWorkflowHost = {
      verifyLaunchedApplication: async (workflow, _ctx, readSignal, candidate) => {
        this.live(readSignal);
        const app = workflow === "messages-read" ? this.config.messages : this.config.codex;
        if (!candidate || candidate.bundleId !== app.bundleId)
          throw Error("App launch identity changed");
        for (const id of candidate.windowIds) {
          try {
            const witness = await this.ownership.target(app.bundleId, candidate.pid, id, readSignal);
            this.live(readSignal);
            if (witness.executablePath === app.executablePath && witness.bundleVersion === app.bundleVersion)
              return;
          } catch {
            this.live(readSignal);
          }
        }
        throw Error("No independently verified running application after launch");
      },
      bindFreshTarget: async (workflow, ctx, readSignal, candidate) => {
        this.live(readSignal);
        const app =
          workflow === "messages-read"
            ? this.config.messages
            : this.config.codex;
        let next: Target;
        if (candidate) {
          if (candidate.bundleId !== app.bundleId)
            throw Error("App launch target changed");
          const valid: Target[] = [];
          for (const id of candidate.windowIds) {
            try {
              const target = await this.ownership.target(
                app.bundleId,
                candidate.pid,
                id,
                readSignal,
              );
              this.validateTarget(target);
              valid.push(target);
            } catch {
              this.live(readSignal);
            }
          }
          if (valid.length !== 1)
            throw Error("Expected exactly one qualified application window");
          next = valid[0]!;
        } else {
          if (!this.scope) throw Error("No application window");
          next = await this.checkTarget(this.scope, readSignal);
        }
        this.target = next;
        this.scope = {
          callId: ctx.callId,
          taskId: ctx.taskId,
          toolCallId: ctx.toolCallId,
          driverInstanceId: owned.driverProcessStart,
          driverGeneration: owned.driverGeneration,
          driverVersion: "0.55.0",
          bundleId: next.bundleId,
          pid: next.pid,
          processStartIdentity: next.processStart,
          windowId: String(next.windowId),
        };
        if (!this.captureBinding) {
          this.captureBinding = {
            callId: ctx.callId,
            taskId: ctx.taskId,
            driverGeneration: owned.driverGeneration,
            processIdentity: next.processStart,
            windowId: String(next.windowId),
            geometryGeneration: next.geometryGeneration,
            expiresAt: ctx.expiresAt,
            pid: next.pid,
            session: ctx.sessionId,
          };
          const overlay = this.config.overlayQualification;
          const overlayQualification =
            overlay &&
            overlay.driverGeneration === owned.driverGeneration &&
            overlay.osBuild ===
              execFileSync("/usr/bin/sw_vers", ["-buildVersion"], {
                encoding: "utf8",
                timeout: 2000,
              }).trim()
              ? overlay
              : undefined;
          this.video = new BackgroundWindowVideo({
            overlayQualification,
            captureWindow: async (request) => {
              this.live();
              if (
                !this.scope ||
                request.session !== ctx.sessionId ||
                request.pid !== this.scope.pid ||
                String(request.window_id) !== this.scope.windowId
              )
                throw Error("Capture target changed");
              const result = await this.serialized(false, () =>
                this.port!.capturePreview(this.scope!, bounded),
              );
              return { ...result, images: result.images ?? [] };
            },
            verifyBinding: async (binding) => {
              try {
                this.live();
                if (
                  !this.scope ||
                  binding.taskId !== ctx.taskId ||
                  binding.callId !== ctx.callId ||
                  binding.driverGeneration !== owned.driverGeneration ||
                  binding.processIdentity !== this.scope.processStartIdentity ||
                  binding.windowId !== this.scope.windowId
                )
                  return { valid: false, onCurrentSpace: false };
                await this.checkTarget(this.scope, bounded);
                this.live();
                return { valid: true, onCurrentSpace: true };
              } catch {
                return { valid: false, onCurrentSpace: false };
              }
            },
          });
          this.video.bind(this.captureBinding);
        }
        return { scope: this.scope, appVersion: next.bundleVersion };
      },
      present: async (observation, focus, phase = "action") => {
        this.live(bounded);
        if (!this.video || !this.captureBinding || !this.target) return;
        await this.captureTick();
        const view = this.video.latest({ width: 1280, height: 720 });
        if (focus && view && this.video.isCurrent(view)) {
          const x = this.target.geometry.width / observation.observation.width;
          const y =
            this.target.geometry.height / observation.observation.height;
          const rect = {
            x: focus.bounds.x * x,
            y: focus.bounds.y * y,
            width: focus.bounds.width * x,
            height: focus.bounds.height * y,
          };
          this.video.focus({
            ...this.captureBinding,
            observationId: view.frameId,
            coordinates: "points",
            phase,
            bounds: rect,
            cursor: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
          });
        }
      },
      verifySurface: (input, s) => planner.verifySurface(input, s),
      armGrant: (grant) => {
        this.live(bounded);
        if (this.grant) throw Error("Another action grant is active");
        const qualified =
          grant.workflow === "messages-read"
            ? { app: this.config.messages, id: "messages-same-desktop-055" }
            : { app: this.config.codex, id: "codex-unsent-same-desktop-055" };
        if (
          grant.qualificationId !== qualified.id ||
          grant.binding.bundleId !== qualified.app.bundleId ||
          grant.appVersion !== qualified.app.bundleVersion ||
          grant.destination !== qualified.app.destination
        )
          throw Error("Workflow qualification changed");
        this.grant = grant;
        return () => {
          if (this.grant === grant) this.grant = undefined;
        };
      },
    };
    this.runner = new QualifiedBackgroundWorkflow(
      {
        driverVersion: "0.55.0",
        messages: {
          bundleId: this.config.messages.bundleId,
          appVersion: this.config.messages.bundleVersion,
          qualificationId: "messages-same-desktop-055",
          contact: this.config.messages.destination,
        },
        codex: {
          bundleId: this.config.codex.bundleId,
          appVersion: this.config.codex.bundleVersion,
          qualificationId: "codex-unsent-same-desktop-055",
          destination: this.config.codex.destination,
        },
      },
      {
        startSession: (s) =>
          this.serialized(true, () => this.port!.startSession(s)),
        endSession: () => this.port!.endSession(),
        launchQualifiedApp: (i, s) =>
          this.serialized(true, () => this.port!.launchQualifiedApp(i, s)),
        observe: (i, s) =>
          this.serialized(true, () => this.port!.observe(i, s)),
        clickElement: (i, s) =>
          this.serialized(true, () => this.port!.clickElement(i, s)),
        clickQualifiedPoint: (i, s) =>
          this.serialized(true, () => this.port!.clickQualifiedPoint(i, s)),
        typePixelDraft: (i, s) =>
          this.serialized(true, () => this.port!.typePixelDraft(i, s)),
      },
      planner,
      host,
    );
    return this.runner.run(goal, tracked, bounded);
  }
  async preview(
    callId: string,
    taskId: string,
  ): Promise<BackgroundPreview | null> {
    try {
      this.live();
      if (
        this.context?.callId !== callId ||
        this.context.taskId !== taskId ||
        !this.video
      )
        return null;
      if (this.flowPending) return null;
      await this.captureTick();
      this.live();
      const view = this.video.latest({ width: 1280, height: 720 });
      if (!view || !this.video.isCurrent(view)) return null;
      return {
        ...view,
        valid: () => {
          try {
            this.live();
            return (
              this.context?.callId === callId &&
              this.context.taskId === taskId &&
              this.video?.isCurrent(view) === true
            );
          } catch {
            return false;
          }
        },
        expiresAt: Math.min(
          view.capturedAt + 1000,
          view.layout.validUntil,
          this.context.expiresAt,
        ),
      };
    } catch {
      return null;
    }
  }
  overview(callId: string, taskId: string, enabled: boolean) {
    this.live();
    if (this.context?.callId !== callId || this.context.taskId !== taskId)
      throw Error("Another call owns video");
    this.video?.overview(enabled);
  }
  stop() {
    this.stopped.abort();
    this.grant = undefined;
    this.video?.revoke();
    this.runner?.stop();
    this.port?.stop();
    this.ownership.stop();
  }
  close() {
    return (this.closing ??= this.closeOnce());
  }
  private async closeOnce(): Promise<{ quiescence: "known" | "unknown" }> {
    this.stop();
    if (!this.acquired) return { quiescence: "known" };
    let known = false;
    try {
      const ended = this.port
        ? await this.port.endSession()
        : { quiescence: "known" };
      const reconciled = [...this.effects.values()].every(
        (s) => s === "verified" || s === "not_started",
      );
      known = await this.ownership.close(
        ended.quiescence === "known",
        reconciled,
      );
      this.lifecycle.release(known);
    } catch {
      known = false;
    }
    return { quiescence: known ? "known" : "unknown" };
  }
}
