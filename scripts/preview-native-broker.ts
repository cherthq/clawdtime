/** Local review only. OS effects are triggered by the qualified preview UI control. */
import { timingSafeEqual } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { FileNativeSceneJournal } from "../connectors/shared/native-scene-journal.js";
import {
  NativePresentationExecutor,
  validateNativePresentationAuthority,
} from "../connectors/shared/native-presentation-executor.js";
import {
  nativePresentationOperationSchema,
  nativePresentationWindowSchema,
  nativeQualificationReasonSchema,
  type NativePresentationOperation,
} from "../src/native-presentation-contracts.js";
import type { PresentationSceneController } from "../connectors/shared/presentation-scenes.js";

const prepareSchema = z
  .object({
    operationId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    sceneId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    action: z.enum(["activate_app", "raise_window"]),
    window: nativePresentationWindowSchema,
  })
  .strict();

export class PreviewNativeBroker {
  readonly journalPath: string;
  readonly nativeReceiptPath: string;
  private readonly journal: FileNativeSceneJournal;
  private readonly executor: NativePresentationExecutor;
  private readonly operations = new Map<string, NativePresentationOperation>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(
    private readonly options: {
      app: Hono;
      mediaSessionId: string;
      token: string;
      nativeHostToken: string;
      requestId: string;
      sessionId: string;
      displayId: number;
      scenes: () => PresentationSceneController | undefined;
      executionStatus: () => Promise<unknown>;
      cameraStatus: () => Promise<unknown>;
      mediaOrigin: () => string | undefined;
      shuttingDown: () => boolean;
    },
  ) {
    if (
      options.nativeHostToken.length < 32 ||
      options.nativeHostToken === options.token
    )
      throw new Error("A separate native host credential is required.");
    const directory = mkdtempSync(join(tmpdir(), "clawdtime-native-review-"));
    this.journalPath = join(directory, "receipts.json");
    this.nativeReceiptPath = join(directory, "host-receipts.sqlite");
    this.journal = new FileNativeSceneJournal(this.journalPath);
    this.executor = new NativePresentationExecutor({
      journal: this.journal,
      executionStatus: options.executionStatus,
      cameraStatus: options.cameraStatus,
      host: {
        capabilities: () => ({
          hostId: "clawdtime-local-native",
          actions: ["activate_app", "raise_window"],
          activationObserved: false,
          terminalEvidence: true,
        }),
        qualify: (operation) => this.media("qualify", { operation }),
        dispatch: (operation, fingerprint) =>
          this.media("execute", { operation, fingerprint }),
        receipt: (operationId) =>
          this.media(`receipts/${encodeURIComponent(operationId)}`),
      },
    });
    const prefix = `/local-native/${options.mediaSessionId}`;
    options.app.use(`${prefix}/*`, async (c, next) => {
      const actual = Buffer.from(c.req.header("Authorization") ?? "");
      const expected = Buffer.from(`Bearer ${options.token}`);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        return c.json({ error: "unauthorized" }, 401);
      if (c.req.header("Origin"))
        return c.json({ error: "server_bridge_only" }, 403);
      await next();
    });
    options.app.use(`${prefix}/*`, bodyLimit({ maxSize: 16384 }));
    options.app.get(`${prefix}/status`, (c) => c.json(this.status()));
    options.app.post(`${prefix}/authority`, async (c) => {
      try {
        const body = await c.req.json();
        const operation = nativePresentationOperationSchema.parse(
          body.operation,
        );
        return c.json(await this.authority(operation));
      } catch {
        return c.json({ error: "native_authority_unavailable" }, 409);
      }
    });
    options.app.post(`${prefix}/execute`, async (c) => {
      try {
        const body = z
          .object({ operationId: z.string().max(160) })
          .strict()
          .parse(await c.req.json());
        const operation = this.operations.get(body.operationId);
        if (!operation) throw new Error("Unknown prepared operation.");
        return c.json(
          await this.track(async () => {
            await this.authority(operation);
            return this.executor.executePrepared(body.operationId);
          }),
        );
      } catch {
        return c.json(
          { error: "native_operation_refused_inspect_receipt" },
          409,
        );
      }
    });
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.options.shuttingDown())
      return Promise.reject(new Error("Native review is closed."));
    const pending = Promise.resolve().then(work);
    this.pending.add(pending);
    return pending.then(
      (result) => {
        this.pending.delete(pending);
        return result;
      },
      (error) => {
        this.pending.delete(pending);
        throw error;
      },
    );
  }
  private sceneMatches(operation: NativePresentationOperation) {
    const state = this.options.scenes()?.status();
    return (
      state?.generation === operation.generation &&
      state.scene?.id === operation.sceneId &&
      state.phase === "awaiting_verification" &&
      JSON.stringify(state.scene.window) === JSON.stringify(operation.window)
    );
  }
  private async media(path: string, body?: unknown): Promise<any> {
    const origin = this.options.mediaOrigin();
    if (!origin || this.closed || this.options.shuttingDown())
      throw new Error("Native review is unavailable.");
    const response = await fetch(
      `${origin}/sessions/${this.options.mediaSessionId}/native/${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.options.nativeHostToken}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      },
    );
    if (!response.ok) {
      if (path === "qualify") {
        const body = await response.json().catch(() => null);
        const reason = nativeQualificationReasonSchema.safeParse(body?.reason);
        if (
          body?.error === "native_qualification_unavailable" &&
          reason.success
        )
          throw new Error(
            `Native qualification refused (${reason.data}); no input dispatched.`,
          );
      }
      throw new Error(
        "Native host request refused; inspect the original receipt.",
      );
    }
    return response.json();
  }
  async authority(operation: NativePresentationOperation) {
    const known = this.operations.get(operation.operationId);
    if (
      this.closed ||
      this.options.shuttingDown() ||
      !known ||
      JSON.stringify(known) !== JSON.stringify(operation) ||
      !this.sceneMatches(operation) ||
      operation.expected.requestId !== this.options.requestId ||
      operation.expected.sessionId !== this.options.sessionId ||
      operation.expected.displayId !== this.options.displayId
    )
      throw new Error("Prepared native operation is no longer current.");
    const before: any = await this.options.executionStatus();
    const camera = await this.options.cameraStatus();
    const after: any = await this.options.executionStatus();
    if (
      before.epoch !== after.epoch ||
      before.cursor !== after.cursor ||
      !this.sceneMatches(operation) ||
      this.closed ||
      this.options.shuttingDown()
    )
      throw new Error("Native authority changed.");
    validateNativePresentationAuthority(operation, before, camera, Date.now());
    return validateNativePresentationAuthority(
      operation,
      after,
      camera,
      Date.now(),
    );
  }
  prepare(raw: unknown) {
    return this.track(() => this.prepareOperation(raw));
  }
  private async prepareOperation(raw: unknown) {
    const input = prepareSchema.parse(raw);
    const state = this.options.scenes()?.status();
    const owner: any = await this.options.executionStatus();
    const camera: any = await this.options.cameraStatus();
    const operation = nativePresentationOperationSchema.parse({
      version: 1,
      ...input,
      generation: state?.generation,
      expected: {
        requestId: this.options.requestId,
        sessionId: this.options.sessionId,
        leaseId: camera.leaseId,
        epoch: owner.epoch,
        cursor: owner.cursor,
        policyRevision: owner.policyRevision,
        displayId: this.options.displayId,
      },
    });
    const old = this.operations.get(operation.operationId);
    if (!old && this.operations.size >= 256)
      throw new Error("Native review operation limit reached.");
    if (old && JSON.stringify(old) !== JSON.stringify(operation))
      throw new Error("Native operation ID already bound.");
    this.operations.set(operation.operationId, operation);
    await this.authority(operation);
    return this.executor.prepare(operation);
  }
  status() {
    const receipts: any = this.executor.status();
    const prepared = this.closed
      ? null
      : ([...this.operations.values()]
          .reverse()
          .find(
            (operation) =>
              this.sceneMatches(operation) &&
              receipts.operations.some(
                (receipt: any) =>
                  receipt.operation.operationId === operation.operationId &&
                  receipt.phase === "prepared",
              ),
          ) ?? null);
    // The UI receives bounded metadata, never arbitrary action payloads or scripts.
    return {
      enabled: true,
      state: this.closed ? "stopped" : prepared ? "prepared" : "ready",
      receipts,
      prepared,
    };
  }
  reconcile(operationId: string) {
    return this.track(() => this.executor.reconcile(operationId));
  }
  verifiedProcessIdentity(
    window: NativePresentationOperation["window"],
  ): string | undefined {
    const state: any = this.executor.status();
    return [...state.operations]
      .reverse()
      .find(
        (r: any) =>
          r.phase === "verified" &&
          JSON.stringify(r.operation.window) === JSON.stringify(window),
      )?.hostResult?.observation?.processIdentity;
  }
  hasUnresolvedActor() {
    const state: any = this.executor.status();
    return (
      this.pending.size > 0 ||
      state.fatal ||
      state.operations.some(
        (receipt: any) =>
          receipt.phase === "uncertain" ||
          (["dispatching", "submitted"].includes(receipt.phase) &&
            !receipt.hostResult?.terminalEvidence),
      )
    );
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    this.journal.close();
  }
}
