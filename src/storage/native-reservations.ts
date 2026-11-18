import { isDeepStrictEqual } from "node:util";
import {
  productionNativeEnvelopeSchema,
  productionNativeRecordSchema,
  productionNativeRejectionReasonSchema,
  type ProductionNativeEnvelope,
  type ProductionNativeRecord,
  type ProductionNativeRejectionReason,
} from "../production-native-contracts.js";
import {
  nativePresentationHostResultSchema,
  nativePresentationObservationSchema,
  type NativePresentationHostResult,
  type NativePresentationObservation,
} from "../native-presentation-contracts.js";
import { Store } from "./store.js";
import { DomainError, hash } from "./security.js";

export const nativeReservationKind = "native-activation";
export type NativeReservation = ProductionNativeRecord;
const unresolved = new Set([
  "prepared",
  "dispatching",
  "submitted",
  "uncertain",
]);
export function unresolvedNativeReservations(
  store: Store,
  deviceId: string,
  now: number,
) {
  return store
    .all<NativeReservation>(nativeReservationKind)
    .filter(
      (record) =>
        record.envelope.binding.deviceId === deviceId &&
        unresolved.has(record.phase) &&
        (record.phase !== "prepared" ||
          record.envelope.binding.expiresAt > now),
    );
}
export function hasUnresolvedNativeDevice(
  store: Store,
  deviceId: string,
  now: number,
  exceptOperationId?: string,
) {
  return unresolvedNativeReservations(store, deviceId, now).some(
    (record) => record.id !== exceptOperationId,
  );
}

/** Durable single-process pilot reservations. Never reconstruct authority from a new session. */
export class NativeReservationStore {
  constructor(
    readonly store: Store,
    readonly clock: () => number = Date.now,
  ) {
    this.recover();
  }
  recover() {
    this.store.transaction(() => {
      for (const record of this.all()) {
        if (["dispatching", "submitted"].includes(record.phase))
          this.store.put(nativeReservationKind, {
            ...record,
            phase: "uncertain",
            updatedAt: this.clock(),
          });
      }
    });
  }
  get(operationId: string) {
    const raw = this.store.get<NativeReservation>(
      nativeReservationKind,
      operationId,
    );
    return raw === undefined ? undefined : this.validateStored(raw);
  }
  all(requestId?: string) {
    return this.store
      .all<NativeReservation>(nativeReservationKind)
      .map((record) => this.validateStored(record))
      .filter(
        (record) =>
          requestId === undefined ||
          record.envelope.operation.expected.requestId === requestId,
      );
  }
  hasUnresolvedDevice(deviceId: string, exceptOperationId?: string) {
    return hasUnresolvedNativeDevice(
      this.store,
      deviceId,
      this.clock(),
      exceptOperationId,
    );
  }
  reserve(raw: ProductionNativeEnvelope) {
    const envelope = productionNativeEnvelopeSchema.parse(raw);
    if (hash(JSON.stringify(envelope.operation)) !== envelope.fingerprint)
      throw new DomainError(409, "Native operation fingerprint differs.");
    return this.store.transaction(() => {
      const old = this.get(envelope.operation.operationId);
      if (old) {
        // Dispatch-only fields are set once by beginDispatch, not supplied by a retry.
        const {
          nativeExpiresAt: _deadline,
          preparedObservation: _observation,
          ...original
        } = old.envelope;
        if (!isDeepStrictEqual(original, envelope))
          throw new DomainError(409, "Native operation ID is already bound.");
        return old;
      }
      if (
        envelope.nativeExpiresAt !== undefined ||
        envelope.preparedObservation !== undefined ||
        !Number.isFinite(envelope.binding.expiresAt) ||
        envelope.binding.expiresAt <= this.clock()
      )
        throw new DomainError(
          409,
          "Fresh original native reservation required.",
        );
      if (this.hasUnresolvedDevice(envelope.binding.deviceId))
        throw new DomainError(
          409,
          "Unresolved native input reserves this device.",
        );
      if (this.all(envelope.operation.expected.requestId).length >= 256)
        throw new DomainError(409, "Native reservation limit reached.");
      const now = this.clock();
      return this.store.put<NativeReservation>(nativeReservationKind, {
        id: envelope.operation.operationId,
        envelope,
        phase: "prepared",
        createdAt: now,
        updatedAt: now,
      });
    });
  }
  setPreparedObservation(
    operationId: string,
    raw: NativePresentationObservation,
  ) {
    const observation = nativePresentationObservationSchema.parse(raw);
    return this.store.transaction(() => {
      const record = this.require(operationId);
      if (
        record.phase !== "prepared" ||
        record.envelope.binding.expiresAt <= this.clock()
      )
        throw new DomainError(
          409,
          "Fresh undispatched native preparation required.",
        );
      if (
        !isDeepStrictEqual(observation.window, record.envelope.operation.window)
      )
        throw new DomainError(409, "Prepared native target differs.");
      if (record.envelope.preparedObservation) {
        if (
          !isDeepStrictEqual(record.envelope.preparedObservation, observation)
        )
          throw new DomainError(
            409,
            "Native prepared observation is already bound.",
          );
        return record;
      }
      return this.store.put<NativeReservation>(nativeReservationKind, {
        ...record,
        envelope: { ...record.envelope, preparedObservation: observation },
        updatedAt: this.clock(),
      });
    });
  }
  beginDispatch(
    operationId: string,
    nativeExpiresAt: number,
    preparedObservation: NativePresentationObservation,
  ) {
    return this.store.transaction(() => {
      const record = this.require(operationId),
        now = this.clock();
      if (record.phase !== "prepared")
        throw new DomainError(
          409,
          "Native operation has already left preparation.",
        );
      if (
        record.envelope.binding.expiresAt <= now ||
        !Number.isFinite(nativeExpiresAt) ||
        nativeExpiresAt <= now ||
        nativeExpiresAt > now + 2000 ||
        nativeExpiresAt > record.envelope.binding.expiresAt
      )
        throw new DomainError(
          409,
          "Original native operation deadline expired or changed.",
        );
      if (
        !record.envelope.preparedObservation ||
        !isDeepStrictEqual(
          record.envelope.preparedObservation,
          preparedObservation,
        )
      )
        throw new DomainError(
          409,
          "Native dispatch requires the original prepared observation.",
        );
      if (
        this.hasUnresolvedDevice(record.envelope.binding.deviceId, operationId)
      )
        throw new DomainError(
          409,
          "Conflicting native input reserves this device.",
        );
      return this.store.put<NativeReservation>(nativeReservationKind, {
        ...record,
        envelope: { ...record.envelope, nativeExpiresAt, preparedObservation },
        phase: "dispatching",
        updatedAt: now,
      });
    });
  }
  finish(operationId: string, raw: NativePresentationHostResult) {
    const result = nativePresentationHostResultSchema.parse(raw);
    return this.store.transaction(() => {
      const record = this.require(operationId);
      if (
        result.operationId !== operationId ||
        (result.terminalEvidence &&
          (result.terminalEvidence.operationId !== operationId ||
            result.terminalEvidence.fingerprint !==
              record.envelope.fingerprint))
      )
        throw new DomainError(409, "Native receipt binding differs.");
      if (!["dispatching", "submitted", "uncertain"].includes(record.phase)) {
        if (isDeepStrictEqual(record.result, result)) return record;
        throw new DomainError(
          409,
          "Native receipt is already terminal or undispatched.",
        );
      }
      if (
        ["returned", "verified", "rejected"].includes(result.state) &&
        !result.terminalEvidence
      )
        throw new DomainError(
          409,
          "Native terminal evidence required before releasing reservation.",
        );
      if (result.state === "verified" && !result.observation)
        throw new DomainError(409, "Verified native observation required.");
      return this.store.put<NativeReservation>(nativeReservationKind, {
        ...record,
        phase: result.state,
        result,
        updatedAt: this.clock(),
      });
    });
  }
  cancelPrepared(
    operationId: string,
    reason: ProductionNativeRejectionReason = "preparation_canceled",
  ) {
    const safeReason = productionNativeRejectionReasonSchema.parse(reason);
    return this.store.transaction(() => {
      const record = this.require(operationId);
      if (record.phase !== "prepared")
        throw new DomainError(
          409,
          "Only an undispatched native preparation may be canceled.",
        );
      return this.store.put<NativeReservation>(nativeReservationKind, {
        ...record,
        phase: "rejected",
        result: {
          operationId,
          state: "rejected",
          reason: safeReason,
        },
        updatedAt: this.clock(),
      });
    });
  }
  private validateStored(raw: NativeReservation) {
    const record = productionNativeRecordSchema.parse(raw);
    if (
      record.id !== record.envelope.operation.operationId ||
      record.envelope.fingerprint !==
        hash(JSON.stringify(record.envelope.operation))
    )
      throw new DomainError(
        409,
        "Retained native reservation is invalid; preserve it for recovery.",
      );
    return record;
  }
  private require(operationId: string) {
    const record = this.get(operationId);
    if (!record) throw new DomainError(404, "Unknown native reservation.");
    return record;
  }
}
