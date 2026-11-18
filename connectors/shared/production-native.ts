import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ClawdTimeClient } from "./client.js";
import { PresentationSceneController } from "./presentation-scenes.js";
import { validateNativePresentationAuthority } from "./native-presentation-executor.js";
import { cameraStatusSchema } from "../../src/camera-contracts.js";
import {
  nativePresentationOperationSchema,
  type NativePresentationOperation,
} from "../../src/native-presentation-contracts.js";
import {
  productionNativeRecordSchema,
  productionNativeReferenceSchema,
  type ProductionNativeRecord,
} from "../../src/production-native-contracts.js";

const statusSchema = z
  .object({
    enabled: z.literal(true),
    operations: z.array(productionNativeRecordSchema).max(256),
  })
  .strict();
const fingerprint = (operation: NativePresentationOperation) =>
  createHash("sha256").update(JSON.stringify(operation)).digest("hex");

/** Production receipts are authoritative. This adapter never retries a mutation. */
export class ProductionNativeClient {
  constructor(
    readonly client: ClawdTimeClient,
    readonly requestId: string,
  ) {}
  private path(suffix = "") {
    return `/api/attention/${encodeURIComponent(this.requestId)}/conversation/native-activation${suffix}`;
  }
  private record(
    raw: unknown,
    operationId?: string,
    expectedFingerprint?: string,
  ) {
    const record = productionNativeRecordSchema.parse(raw);
    const operation = record.envelope.operation;
    const result = record.result;
    if (
      operation.expected.requestId !== this.requestId ||
      record.id !== operation.operationId ||
      (operationId !== undefined && operation.operationId !== operationId) ||
      record.envelope.fingerprint !== fingerprint(operation) ||
      (expectedFingerprint !== undefined &&
        record.envelope.fingerprint !== expectedFingerprint) ||
      (result && result.operationId !== operation.operationId) ||
      (result &&
        ["returned", "verified", "rejected"].includes(record.phase) &&
        result.state !== record.phase) ||
      (result?.terminalEvidence &&
        (result.terminalEvidence.operationId !== operation.operationId ||
          result.terminalEvidence.fingerprint !==
            record.envelope.fingerprint)) ||
      (["returned", "verified"].includes(record.phase) &&
        !result?.terminalEvidence)
    )
      throw new Error(
        "Native activation receipt identity mismatch; preserve the original operation.",
      );
    return record;
  }
  async status() {
    const status = statusSchema.parse(await this.client.api(this.path()));
    for (const record of status.operations) this.record(record);
    return status;
  }
  async prepare(rawOperation: unknown) {
    const operation = nativePresentationOperationSchema.parse(rawOperation);
    if (operation.expected.requestId !== this.requestId)
      throw new Error("Native activation requires its exact request.");
    await this.status();
    return this.mutate(
      "prepare",
      operation,
      operation.operationId,
      fingerprint(operation),
    );
  }
  async receipt(operationId: string, expectedFingerprint?: string) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(operationId))
      throw new Error("Invalid operation ID.");
    return this.record(
      await this.client.api(
        this.path(`/receipts/${encodeURIComponent(operationId)}`),
      ),
      operationId,
      expectedFingerprint,
    );
  }
  private async mutate(
    path: string,
    body: unknown,
    operationId: string,
    hash: string,
  ) {
    try {
      return this.record(
        await this.client.api(this.path(`/${path}`), body),
        operationId,
        hash,
      );
    } catch {
      throw new Error(
        "Native activation outcome is unknown. Read the original operation receipt; do not retry, replace its ID or release ownership.",
      );
    }
  }
  /** Only the fixed-operation CUA trigger calls dispatch; no MCP command exposes it. */
  dispatch(raw: unknown) {
    const reference = productionNativeReferenceSchema.parse(raw);
    return this.mutate(
      "dispatch",
      reference,
      reference.operationId,
      reference.fingerprint,
    );
  }
  cancel(raw: unknown) {
    const reference = productionNativeReferenceSchema.parse(raw);
    return this.mutate(
      "cancel",
      reference,
      reference.operationId,
      reference.fingerprint,
    );
  }
  reconcile(raw: unknown) {
    const reference = productionNativeReferenceSchema.parse(raw);
    return this.mutate(
      "reconcile",
      reference,
      reference.operationId,
      reference.fingerprint,
    );
  }
}

const ownershipSchema = z
  .object({
    requestId: z.string(),
    sessionId: z.string(),
    executor: z.string(),
    state: z.string(),
    epoch: z.number().int().nonnegative(),
    policyRevision: z.number().int().positive().optional(),
    cursor: z.number().int().nonnegative(),
    acknowledgedCursor: z.number().int().nonnegative(),
    pendingDelivery: z.boolean(),
    hold: z.object({ active: z.boolean() }),
  })
  .refine(
    (owner) =>
      owner.policyRevision !== undefined ||
      (owner.executor === "none" &&
        owner.state === "idle" &&
        owner.epoch === 0),
    "Claimed ownership requires its concrete policy revision.",
  );
const ownershipReceiptSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  executor: z.enum(["native", "none"]),
  state: z.enum(["working", "idle"]),
  epoch: z.number().int().positive(),
  policyRevision: z.number().int().positive(),
});

/** Original-chat choreography. Bounded edits/moves still use that chat's native CUA. */
export class ProductionWalkthroughController {
  readonly scenes: PresentationSceneController;
  readonly native: ProductionNativeClient;
  private pending?: {
    operation: NativePresentationOperation;
    fingerprint: string;
  };
  private last?: ProductionNativeRecord;
  private activationReceipt?: ProductionNativeRecord;
  private busy = false;
  private stopped = false;
  private dispatchAttempted = false;
  constructor(
    readonly options: {
      client: ClawdTimeClient;
      requestId: string;
      sessionId: string;
      plan: unknown;
      clock?: () => number;
      backgroundActorsStopped: () => boolean;
    },
  ) {
    const { client, requestId } = options;
    this.native = new ProductionNativeClient(client, requestId);
    this.scenes = new PresentationSceneController(
      options.plan,
      {
        executionStatus: () => client.conversationExecution(requestId),
        cameraStatus: () => client.screenCamera(requestId),
        cameraCommand: (command) => client.screenCamera(requestId, command),
        presentLive: (intent) => client.presentPreparedScene(requestId, intent),
      },
      options.clock,
    );
  }
  status() {
    const preparedExpiresAt =
      this.pending &&
      this.last?.phase === "prepared" &&
      this.last.id === this.pending.operation.operationId &&
      this.last.envelope.fingerprint === this.pending.fingerprint
        ? this.last.envelope.binding.expiresAt
        : null;
    return {
      stopped: this.stopped,
      dispatchAttempted: this.dispatchAttempted,
      busy: this.busy,
      scene: this.scenes.status(),
      prepared: this.pending ? structuredClone(this.pending) : null,
      preparedExpiresAt,
      preparedExpired:
        preparedExpiresAt !== null &&
        preparedExpiresAt <= (this.options.clock ?? Date.now)(),
      receipt: this.last ? structuredClone(this.last) : null,
      activationReceipt: this.activationReceipt
        ? structuredClone(this.activationReceipt)
        : null,
    };
  }
  private valid() {
    if (this.stopped)
      throw new Error(
        "Walkthrough stopped; preserve receipts and use local Stop.",
      );
  }
  private async exclusive<T>(work: () => Promise<T>) {
    this.valid();
    if (this.busy)
      throw new Error("A walkthrough operation is already in progress.");
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }
  private async owner() {
    const owner = ownershipSchema.parse(
      await this.options.client.conversationExecution(this.options.requestId),
    );
    this.valid();
    if (
      owner.requestId !== this.options.requestId ||
      owner.sessionId !== this.options.sessionId ||
      owner.cursor !== owner.acknowledgedCursor ||
      owner.pendingDelivery ||
      owner.hold.active
    )
      throw new Error(
        "Current exact acknowledged walkthrough ownership required.",
      );
    return owner;
  }
  private async transfer(
    executor: "native" | "none",
    previousOutcome: "idle" | "completed",
    expected?: NativePresentationOperation["expected"],
  ) {
    if (!this.options.backgroundActorsStopped())
      throw new Error(
        "Stop and join conflicting input actors before transferring ownership.",
      );
    const owner = await this.owner();
    const expectedOwner = executor === "native" ? "none" : "native";
    if (
      owner.executor !== expectedOwner ||
      owner.state !== (executor === "native" ? "idle" : "working") ||
      (executor === "none" &&
        (!expected ||
          expected.requestId !== owner.requestId ||
          expected.sessionId !== owner.sessionId ||
          expected.epoch !== owner.epoch ||
          expected.policyRevision !== owner.policyRevision ||
          expected.cursor !== owner.cursor))
    )
      throw new Error(
        "Walkthrough ownership changed; do not transfer it automatically.",
      );
    const receipt = ownershipReceiptSchema.parse(
      await this.options.client.conversationOperation(
        this.options.requestId,
        "execution",
        {
          expectedEpoch: owner.epoch,
          executor,
          previousOutcome,
          backgroundActorsStopped: true,
          expectedCursor: owner.cursor,
        },
      ),
    );
    this.valid();
    if (
      receipt.requestId !== owner.requestId ||
      receipt.sessionId !== owner.sessionId ||
      receipt.executor !== executor ||
      receipt.epoch !== owner.epoch + 1 ||
      receipt.state !== (executor === "native" ? "working" : "idle")
    )
      throw new Error(
        "Ownership acknowledgement changed; inspect the original transfer without retry.",
      );
    return receipt;
  }
  /** A returned activation may precede one separately prepared raise, never a replay. */
  private async prepareRaise(
    sceneId: string,
    operationId: string,
    action: NativePresentationOperation["action"],
  ) {
    const previous = this.pending!;
    const last = this.last;
    const scene = this.scenes.status();
    if (
      action !== "raise_window" ||
      previous.operation.action !== "activate_app" ||
      operationId === previous.operation.operationId ||
      sceneId !== previous.operation.sceneId ||
      scene.generation !== previous.operation.generation ||
      scene.scene?.id !== sceneId ||
      !isDeepStrictEqual(scene.scene.window, previous.operation.window) ||
      scene.phase !== "awaiting_verification" ||
      !this.dispatchAttempted ||
      last?.phase !== "returned" ||
      last.result?.state !== "returned" ||
      !last.result.terminalEvidence
    )
      throw new Error(
        "Only an exact terminal returned activation permits a separately prepared raise for the same scene.",
      );
    if (!this.options.backgroundActorsStopped())
      throw new Error(
        "Stop and join conflicting input actors before preparing a raise.",
      );
    const receipt = await this.native.receipt(
      previous.operation.operationId,
      previous.fingerprint,
    );
    this.valid();
    if (!isDeepStrictEqual(receipt, last))
      throw new Error(
        "Original activation receipt changed; preserve ownership and inspect it without replay.",
      );
    // Preserve the original binding, including epoch, cursor and lease. A newer
    // owner or acknowledged turn cannot silently authorize this scene's raise.
    const operation = nativePresentationOperationSchema.parse({
      ...previous.operation,
      operationId,
      action,
    });
    await this.owner();
    const camera = cameraStatusSchema.parse(
      await this.options.client.screenCamera(this.options.requestId),
    );
    this.valid();
    const owner = await this.options.client.conversationExecution(
      this.options.requestId,
    );
    this.valid();
    validateNativePresentationAuthority(
      operation,
      owner,
      camera,
      (this.options.clock ?? Date.now)(),
    );
    this.activationReceipt = receipt;
    return this.reserve(operation);
  }
  private async reserve(operation: NativePresentationOperation) {
    this.pending = { operation, fingerprint: fingerprint(operation) };
    this.last = undefined;
    this.dispatchAttempted = false;
    this.last = await this.native.prepare(operation);
    this.valid();
    if (this.last.phase !== "prepared")
      throw new Error(
        "Native operation did not prepare; inspect its original receipt.",
      );
    return this.status();
  }
  /** No native effect: reset scene, claim native, resolve and reserve exactly one operation. */
  prepare(
    sceneId: string,
    operationId: string,
    action: NativePresentationOperation["action"] = "activate_app",
  ) {
    return this.exclusive(async () => {
      if (this.pending) return this.prepareRaise(sceneId, operationId, action);
      await this.scenes.begin(sceneId);
      this.valid();
      const claim = await this.transfer("native", "idle");
      const owner = await this.owner();
      if (
        owner.executor !== "native" ||
        owner.state !== "working" ||
        owner.epoch !== claim.epoch ||
        owner.policyRevision !== claim.policyRevision
      )
        throw new Error("Claimed native ownership changed before preparation.");
      const camera = cameraStatusSchema.parse(
        await this.options.client.screenCamera(this.options.requestId),
      );
      this.valid();
      const state = this.scenes.status();
      const operation = nativePresentationOperationSchema.parse({
        version: 1,
        operationId,
        sceneId,
        generation: state.generation,
        action,
        window: state.scene?.window,
        expected: {
          requestId: this.options.requestId,
          sessionId: this.options.sessionId,
          leaseId: camera.leaseId,
          epoch: owner.epoch,
          cursor: owner.cursor,
          policyRevision: owner.policyRevision,
          displayId: camera.surface.displayId,
        },
      });
      const rawOwner = await this.options.client.conversationExecution(
        this.options.requestId,
      );
      this.valid();
      validateNativePresentationAuthority(
        operation,
        rawOwner,
        camera,
        (this.options.clock ?? Date.now)(),
      );
      this.activationReceipt = undefined;
      return this.reserve(operation);
    });
  }
  /** Fixed browser button invocation only, with immutable reference to the current scene. */
  executePrepared(rawReference: unknown) {
    return this.exclusive(async () => {
      if (this.dispatchAttempted)
        throw new Error(
          "Dispatch was already attempted; read the original receipt without replay.",
        );
      const reference = productionNativeReferenceSchema.parse(rawReference);
      const pending = this.pending;
      const scene = this.scenes.status();
      if (
        !pending ||
        this.last?.phase !== "prepared" ||
        this.last.id !== pending.operation.operationId ||
        this.last.envelope.fingerprint !== pending.fingerprint ||
        reference.operationId !== pending.operation.operationId ||
        reference.fingerprint !== pending.fingerprint ||
        scene.generation !== pending.operation.generation ||
        scene.scene?.id !== pending.operation.sceneId ||
        scene.phase !== "awaiting_verification"
      )
        throw new Error(
          "Only the current fixed prepared operation may execute.",
        );
      this.dispatchAttempted = true;
      this.last = await this.native.dispatch(reference);
      this.valid();
      const result = this.last.result;
      const observed = result?.observation;
      const now = (this.options.clock ?? Date.now)();
      if (
        this.last.phase !== "verified" ||
        result?.state !== "verified" ||
        !result.terminalEvidence ||
        !observed ||
        !isDeepStrictEqual(observed.window, pending.operation.window) ||
        !observed.appActive ||
        !observed.windowFocused ||
        !observed.windowOnScreen ||
        observed.observedAt > now ||
        now - observed.observedAt > 2000
      )
        throw new Error(
          "Exact native window was not verified; retain ownership and inspect the receipt.",
        );
      await this.transfer("none", "completed", pending.operation.expected);
      this.pending = undefined;
      await this.scenes.presentLive();
      this.valid();
      return this.status();
    });
  }
  /** Follow-up invalidates the old plan only after proven non-dispatched cancellation. */
  replan(plan: unknown, expectedGeneration: number) {
    return this.exclusive(async () => {
      if (this.scenes.status().generation !== expectedGeneration)
        throw new Error("Follow-up generation changed.");
      if (this.dispatchAttempted && this.pending)
        throw new Error(
          "Reconcile the attempted operation before replacing the plan.",
        );
      if (this.pending) {
        const reference = {
          operationId: this.pending.operation.operationId,
          fingerprint: this.pending.fingerprint,
        };
        const current = await this.native.receipt(
          reference.operationId,
          reference.fingerprint,
        );
        this.valid();
        if (current.phase !== "prepared")
          throw new Error(
            "Reconcile the original native effect before a follow-up plan.",
          );
        this.last = await this.native.cancel(reference);
        this.valid();
        if (this.last.phase !== "rejected")
          throw new Error(
            "Prepared cancellation is unconfirmed; preserve ownership.",
          );
        await this.transfer(
          "none",
          "completed",
          this.pending.operation.expected,
        );
        this.pending = undefined;
      }
      if (this.scenes.status().generation !== expectedGeneration)
        throw new Error("Follow-up generation changed.");
      if (
        this.scenes.status().phase !== "completed" &&
        this.scenes.status().phase !== "interrupted"
      )
        await this.scenes.interrupt();
      this.valid();
      return this.scenes.replan(plan, this.scenes.status().generation);
    });
  }
  /** Immediate local invalidation; actual helper Stop remains independently authoritative. */
  stop() {
    this.stopped = true;
    this.scenes.stop();
  }
}
