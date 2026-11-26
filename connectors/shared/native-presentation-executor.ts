import { createHash } from "node:crypto";
import { z } from "zod";
import {
  cameraStatusSchema,
  type CameraStatus,
} from "../../src/camera-contracts.js";
import {
  nativePresentationHostResultSchema,
  nativePresentationObservationSchema,
  nativePresentationOperationSchema,
  type NativePresentationHostResult,
  type NativePresentationObservation,
  type NativePresentationOperation,
} from "../../src/native-presentation-contracts.js";
import type { NativeSceneJournal } from "./native-scene-journal.js";

const capabilitiesSchema = z
  .object({
    hostId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    actions: z
      .array(z.enum(["activate_app", "raise_window"]))
      .min(1)
      .max(2),
    activationObserved: z.boolean(),
    terminalEvidence: z.boolean(),
  })
  .strict();
const receiptSchema = z
  .object({
    operation: nativePresentationOperationSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    hostId: z.string(),
    phase: z.enum([
      "prepared",
      "dispatching",
      "rejected",
      "submitted",
      "returned",
      "verified",
      "uncertain",
    ]),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    preparedObservation: nativePresentationObservationSchema,
    hostResult: nativePresentationHostResultSchema.optional(),
    reason: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  })
  .strict();
type Receipt = z.infer<typeof receiptSchema>;
const executionSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  executor: z.string(),
  state: z.string(),
  epoch: z.number().int(),
  policyRevision: z.number().int(),
  cursor: z.number().int(),
  acknowledgedCursor: z.number().int(),
  pendingDelivery: z.boolean(),
  viewingStopped: z.boolean().optional(),
  hold: z.object({ active: z.boolean() }),
  leases: z.array(
    z.object({
      id: z.string(),
      state: z.string(),
      expiresAt: z.number().finite(),
      sessionId: z.string().optional(),
      requestId: z.string().optional(),
      executor: z.string().optional(),
      executorEpoch: z.number().optional(),
      policyRevision: z.number().optional(),
      displayId: z.union([z.string(), z.number()]).optional(),
    }),
  ),
  actions: z.array(z.object({ state: z.string() })),
});
export interface NativePresentationHost {
  capabilities(): z.infer<typeof capabilitiesSchema>;
  qualify(operation: NativePresentationOperation): Promise<unknown>;
  dispatch(
    operation: NativePresentationOperation,
    fingerprint: string,
  ): Promise<unknown>;
  receipt(operationId: string, fingerprint: string): Promise<unknown | null>;
}

/** Shared read-only guard; callers must read execution on both sides of awaited camera status. */
export function validateNativePresentationAuthority(
  rawOperation: unknown,
  rawExecution: unknown,
  rawCamera: unknown,
  now: number,
) {
  const operation = nativePresentationOperationSchema.parse(rawOperation);
  const expected = operation.expected;
  const state = executionSchema.parse(rawExecution);
  const camera = cameraStatusSchema.parse(rawCamera);
  const lease = state.leases.find((l) => l.id === expected.leaseId);
  if (
    state.requestId !== expected.requestId ||
    state.sessionId !== expected.sessionId ||
    state.executor !== "native" ||
    state.state !== "working" ||
    state.epoch !== expected.epoch ||
    state.policyRevision !== expected.policyRevision ||
    state.cursor !== expected.cursor ||
    state.acknowledgedCursor !== expected.cursor ||
    state.pendingDelivery ||
    state.viewingStopped ||
    state.hold.active ||
    state.leases.some((l) => l.state === "unknown") ||
    state.actions.some((a) =>
      ["pending", "submitted", "unknown"].includes(a.state),
    ) ||
    !lease ||
    lease.state !== "active" ||
    lease.expiresAt <= now ||
    lease.sessionId !== expected.sessionId ||
    lease.requestId !== expected.requestId ||
    lease.executor !== "native" ||
    lease.executorEpoch !== expected.epoch ||
    lease.policyRevision !== expected.policyRevision ||
    String(lease.displayId) !== String(expected.displayId)
  )
    throw new Error(
      "Exact live native ownership and acknowledged context are required.",
    );
  if (
    camera.state !== "live" ||
    camera.sessionId !== expected.sessionId ||
    camera.leaseId !== expected.leaseId ||
    camera.surface.kind !== "display" ||
    camera.surface.displayId !== expected.displayId ||
    !camera.source ||
    camera.capturedAt === null ||
    now - camera.capturedAt > 2000 ||
    camera.capturedAt > now + 1000
  )
    throw new Error(
      "Native operation requires its fresh explicitly selected display.",
    );
  return { ...expected, expiresAt: Math.min(lease!.expiresAt, now + 2000) };
}

/** Activation-only adapter. Only the lead's qualified local UI endpoint invokes executePrepared. */
export class NativePresentationExecutor {
  private readonly receipts = new Map<string, Receipt>();
  private readonly capabilities: z.infer<typeof capabilitiesSchema>;
  private readonly clock: () => number;
  private busy = false;
  private fatal = false;
  constructor(
    private readonly options: {
      journal: NativeSceneJournal;
      host: NativePresentationHost;
      executionStatus(): Promise<unknown>;
      cameraStatus(): Promise<unknown>;
      clock?: () => number;
    },
  ) {
    this.clock = options.clock ?? Date.now;
    this.capabilities = capabilitiesSchema.parse(options.host.capabilities());
    for (const raw of options.journal.read()) {
      const receipt = receiptSchema.parse(raw);
      if (
        receipt.hostId !== this.capabilities.hostId ||
        this.receipts.has(receipt.operation.operationId) ||
        receipt.fingerprint !== this.fingerprint(receipt.operation)
      )
        throw new Error(
          "Native journal identity mismatch; preserve its records.",
        );
      if (receipt.hostResult) this.result(receipt.hostResult, receipt);
      if (
        ["returned", "verified"].includes(receipt.phase) &&
        !receipt.hostResult?.terminalEvidence
      )
        throw new Error(
          "Native journal completion lacks bound terminal evidence; preserve its records.",
        );
      if (["dispatching", "submitted"].includes(receipt.phase)) {
        receipt.phase = "uncertain";
        receipt.reason = "host_interrupted";
        receipt.updatedAt = this.clock();
      }
      this.receipts.set(receipt.operation.operationId, receipt);
    }
    if (this.receipts.size > 256)
      throw new Error("Native operation bound exceeded.");
    this.save();
  }
  private fingerprint(operation: NativePresentationOperation) {
    return createHash("sha256").update(JSON.stringify(operation)).digest("hex");
  }
  private save() {
    try {
      this.options.journal.write([...this.receipts.values()]);
    } catch {
      this.fatal = true;
      throw new Error(
        "Native operation journal persistence failed; no further dispatch is permitted.",
      );
    }
  }
  status(operationId?: string) {
    return structuredClone(
      operationId
        ? this.get(operationId)
        : {
            capabilities: this.capabilities,
            fatal: this.fatal,
            operations: [...this.receipts.values()],
          },
    );
  }
  private get(operationId: string) {
    const receipt = this.receipts.get(operationId);
    if (!receipt) throw new Error("Unknown prepared native operation.");
    return receipt;
  }
  private open() {
    if (this.fatal)
      throw new Error("Native journal is unavailable; do not dispatch.");
  }
  private unresolved(except?: string) {
    if (
      [...this.receipts.values()].some(
        (r) =>
          r.operation.operationId !== except &&
          ["dispatching", "submitted", "uncertain"].includes(r.phase),
      )
    )
      throw new Error(
        "A prior native operation is unresolved; reconcile its original receipt.",
      );
  }
  private async guard(
    operation: NativePresentationOperation,
  ): Promise<CameraStatus> {
    const before = await this.options.executionStatus();
    const camera = cameraStatusSchema.parse(await this.options.cameraStatus());
    const after = await this.options.executionStatus();
    validateNativePresentationAuthority(
      operation,
      before,
      camera,
      this.clock(),
    );
    validateNativePresentationAuthority(operation, after, camera, this.clock());
    return camera;
  }
  private observation(
    raw: unknown,
    operation: NativePresentationOperation,
    camera: CameraStatus,
    previous?: NativePresentationObservation,
  ) {
    const value = nativePresentationObservationSchema.parse(raw);
    const bounds = camera.source!;
    if (
      JSON.stringify(value.window) !== JSON.stringify(operation.window) ||
      this.clock() - value.observedAt > 2000 ||
      value.observedAt > this.clock() ||
      value.windowBounds.x < bounds.displayOriginX ||
      value.windowBounds.x + value.windowBounds.width >
        bounds.displayOriginX + bounds.displayPointWidth ||
      value.windowBounds.y < bounds.displayOriginY ||
      value.windowBounds.y + value.windowBounds.height >
        bounds.displayOriginY + bounds.displayPointHeight ||
      (previous &&
        (previous.processIdentity !== value.processIdentity ||
          JSON.stringify(previous.windowBounds) !==
            JSON.stringify(value.windowBounds)))
    )
      throw new Error(
        "Native target identity, lifecycle or geometry changed; no dispatch is permitted.",
      );
    return value;
  }
  private qualifiedTarget(
    raw: unknown,
    operation: NativePresentationOperation,
    camera: CameraStatus,
    previous?: NativePresentationObservation,
  ) {
    const observation = this.observation(raw, operation, camera, previous);
    if (operation.action === "raise_window" && !observation.appActive)
      throw new Error(
        "Raising a window requires its app to be currently frontmost; no dispatch is permitted.",
      );
    return observation;
  }
  async prepare(raw: unknown) {
    this.open();
    const operation = nativePresentationOperationSchema.parse(raw);
    const fingerprint = this.fingerprint(operation);
    const old = this.receipts.get(operation.operationId);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new Error(
          "Native operation ID belongs to different immutable arguments.",
        );
      return structuredClone(old);
    }
    this.unresolved();
    if (this.busy || this.receipts.size >= 256)
      throw new Error("Native executor is busy or its journal is full.");
    if (
      !this.capabilities.actions.includes(operation.action) ||
      !this.capabilities.terminalEvidence
    )
      throw new Error(
        "Qualified native action and terminal evidence capabilities are required.",
      );
    this.busy = true;
    try {
      await this.guard(operation);
      const rawObservation = await this.options.host.qualify(operation);
      const camera = await this.guard(operation);
      const preparedObservation = this.qualifiedTarget(
        rawObservation,
        operation,
        camera,
      );
      const receipt: Receipt = {
        operation,
        fingerprint,
        hostId: this.capabilities.hostId,
        phase: "prepared",
        createdAt: this.clock(),
        updatedAt: this.clock(),
        preparedObservation,
        reason: "prepared_not_submitted",
      };
      this.receipts.set(operation.operationId, receipt);
      this.save();
      return structuredClone(receipt);
    } finally {
      this.busy = false;
    }
  }
  private result(raw: unknown, receipt: Receipt) {
    const result = nativePresentationHostResultSchema.parse(raw);
    const terminal = result.terminalEvidence;
    if (
      result.operationId !== receipt.operation.operationId ||
      (result.state === "submitted" && !!terminal) ||
      (terminal &&
        (terminal.operationId !== result.operationId ||
          terminal.fingerprint !== receipt.fingerprint ||
          terminal.hostId !== receipt.hostId ||
          terminal.completedAt < receipt.createdAt ||
          terminal.completedAt > this.clock() + 1000)) ||
      (["returned", "verified", "rejected"].includes(result.state) && !terminal)
    )
      throw new Error("Native result lacks matching host terminal evidence.");
    return result;
  }
  async executePrepared(operationId: string) {
    this.open();
    const receipt = this.get(operationId);
    if (receipt.phase !== "prepared") return structuredClone(receipt);
    this.unresolved(operationId);
    if (this.busy)
      throw new Error("Native executor is busy; no operation was queued.");
    this.busy = true;
    try {
      try {
        await this.guard(receipt.operation);
        const target = await this.options.host.qualify(receipt.operation);
        const camera = await this.guard(receipt.operation);
        this.qualifiedTarget(
          target,
          receipt.operation,
          camera,
          receipt.preparedObservation,
        );
      } catch {
        receipt.phase = "rejected";
        receipt.reason = "pre_dispatch_guard_rejected";
        receipt.updatedAt = this.clock();
        this.save();
        return structuredClone(receipt);
      }
      receipt.phase = "dispatching";
      receipt.reason = "dispatch_intent_reserved";
      receipt.updatedAt = this.clock();
      this.save();
      try {
        const result = this.result(
          await this.options.host.dispatch(
            receipt.operation,
            receipt.fingerprint,
          ),
          receipt,
        );
        receipt.hostResult = result;
        receipt.phase = result.state;
        receipt.reason = result.reason;
        if (result.state === "submitted") await this.guard(receipt.operation);
        if (result.state === "verified" || result.state === "returned") {
          const camera = await this.guard(receipt.operation);
          const observation = result.observation
            ? this.observation(
                result.observation,
                receipt.operation,
                camera,
                receipt.preparedObservation,
              )
            : undefined;
          receipt.phase =
            observation?.appActive &&
            observation.windowFocused &&
            observation.windowOnScreen
              ? "verified"
              : "returned";
          receipt.reason =
            receipt.phase === "verified"
              ? "exact_window_observed"
              : "host_returned_target_unverified";
        }
      } catch {
        receipt.phase = "uncertain";
        receipt.reason = "native_outcome_unconfirmed";
      }
      receipt.updatedAt = this.clock();
      this.save();
      return structuredClone(receipt);
    } finally {
      this.busy = false;
    }
  }
  async reconcile(operationId: string) {
    this.open();
    const receipt = this.get(operationId);
    if (
      receipt.phase === "prepared" ||
      receipt.reason === "pre_dispatch_guard_rejected"
    )
      return structuredClone(receipt);
    if (this.busy)
      throw new Error(
        "Wait for the current native operation to settle before reconciliation.",
      );
    this.busy = true;
    try {
      const raw = await this.options.host.receipt(
        operationId,
        receipt.fingerprint,
      );
      if (raw === null) return structuredClone(receipt);
      const result = this.result(raw, receipt);
      receipt.hostResult = result;
      // Cleanup evidence may arrive after Stop. It settles the host call, not UI success or authority.
      if (result.terminalEvidence) {
        receipt.phase = result.state === "rejected" ? "rejected" : "returned";
        receipt.reason = "host_terminal_reconciled_not_ui_verified";
      }
      receipt.updatedAt = this.clock();
      this.save();
      return structuredClone(receipt);
    } finally {
      this.busy = false;
    }
  }
}
