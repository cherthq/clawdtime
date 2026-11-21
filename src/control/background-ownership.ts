import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hash } from "../storage/security.js";
import type { BundledCuaConfig } from "./cua-contracts.js";
import type { BackgroundTaskContext } from "./background-runtime.js";

type Config = NonNullable<BundledCuaConfig["native"]>;
const statusSchema = z.object({
  backgroundProtocol: z.literal(1),
  deviceId: z.string(),
  localEnabled: z.boolean(),
  armed: z.boolean(),
  available: z.boolean(),
  screenPermission: z.boolean(),
  controlPermission: z.boolean(),
  policyRevision: z.number().int().nonnegative(),
  activeSessionId: z.string().nullable().optional(),
  unresolvedActions: z.number().int().nonnegative(),
  backgroundUnresolvedActions: z.number().int().nonnegative(),
});
const driverSchema = z.object({
  pid: z.number().int().positive(),
  bundleId: z.literal("com.trycua.driver"),
  processStart: z.string().regex(/^[a-f0-9]{64}$/),
});
export const backgroundTargetSchema = z.object({
  bundleId: z.string(),
  pid: z.number().int().positive(),
  windowId: z.number().int().positive(),
  processStart: z.string().regex(/^[a-f0-9]{64}$/),
  bundleVersion: z.string(),
  executablePath: z.string().startsWith("/"),
  onCurrentSpace: z.boolean(),
  geometryGeneration: z.string().regex(/^[a-f0-9]{64}$/),
  geometry: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().positive().finite(),
    height: z.number().positive().finite(),
  }),
});
type Lease = {
  id: string;
  deviceId: string;
  sessionId: string;
  taskId: string;
  executorId: string;
  executorEpoch: number;
  policyRevision: number;
  displayId: number;
  expiresAt: string;
};

/** Coordination only. Never requests native input or weakens native frame/focus checks. */
export class BackgroundOwnership {
  private lease?: Lease;
  private fence?: {
    id: string;
    fingerprint: string;
    driverGeneration: string;
    driverPid: number;
    driverProcessStart: string;
  };
  private polling?: NodeJS.Timeout;
  private checking = false;
  private stopped = false;
  private fault = false;
  private expiresAt = 0;
  private driver?: z.infer<typeof driverSchema>;
  private generation = 0;
  private closing?: Promise<boolean>;
  constructor(
    private config: Config,
    private onRevoked: () => void,
    private request: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}
  private async json(
    path: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<any> {
    const r = await this.request(`${this.config.origin}/local/v1${path}`, {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.config.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(2000),
      ]),
    });
    if (!r.ok || !r.body) throw Error("Background ownership request refused");
    const reader = r.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const x = await reader.read();
        if (x.done) break;
        size += x.value.length;
        if (size > 65536) throw Error("Ownership response too large");
        chunks.push(x.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  private guard(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (
      this.stopped ||
      this.fault ||
      !this.lease ||
      this.now() >= this.expiresAt
    )
      throw Error("Background execution ownership ended");
    return this.lease;
  }
  private revoke() {
    if (this.fault) return;
    this.fault = true;
    try {
      this.onRevoked();
    } catch {
      /* ownership remains revoked */
    }
  }
  async open(
    context: BackgroundTaskContext,
    driverPid: number,
    signal: AbortSignal,
  ) {
    if (this.lease || this.stopped)
      throw Error("Background ownership cannot be reused");
    const generation = ++this.generation;
    const status = statusSchema.parse(
      await this.json("/status", "GET", undefined, signal),
    );
    if (
      !status.armed ||
      !status.localEnabled ||
      !status.available ||
      !status.screenPermission ||
      !status.controlPermission ||
      status.deviceId !== this.config.deviceId ||
      status.activeSessionId ||
      status.unresolvedActions
    )
      throw Error(
        "Enable the updated local helper with idle ownership before background work",
      );
    this.driver = driverSchema.parse(
      await this.json("/background-driver", "POST", { pid: driverPid }, signal),
    );
    if (this.driver.pid !== driverPid) throw Error("Driver identity changed");
    signal.throwIfAborted();
    if (generation !== this.generation || this.stopped)
      throw Error("Opening stopped");
    this.expiresAt = context.expiresAt;
    this.lease = {
      id: `local_${context.sessionId}`,
      deviceId: this.config.deviceId,
      sessionId: context.sessionId,
      taskId: context.taskId,
      executorId: this.config.executorId,
      executorEpoch: 0,
      policyRevision: status.policyRevision,
      displayId: this.config.displayId,
      expiresAt: new Date(
        Math.min(context.expiresAt, this.now() + 25000),
      ).toISOString(),
    };
    this.validateLease(
      await this.json("/sessions", "POST", this.lease, signal),
      this.lease,
    );
    this.guard(signal);
    const driverGeneration = `driver_${hash(JSON.stringify(this.driver))}`;
    const id = `controller_${randomUUID()}`;
    this.fence = {
      id,
      fingerprint: hash(
        JSON.stringify([this.lease, this.driver, driverGeneration]),
      ),
      driverGeneration,
      driverPid,
      driverProcessStart: this.driver.processStart,
    };
    // Reserve the helper fence (and backward-compatible native ledger sentinel)
    // before creating any driver session or admitting even an application launch.
    const receipt = await this.json(
      `/sessions/${this.lease.id}/background-actions`,
      "POST",
      {
        kind: "controller",
        ...this.fence,
        observedAt: new Date(this.now()).toISOString(),
      },
      signal,
    );
    if (
      receipt.admitted !== true ||
      !this.matchesReceipt(receipt.receipt, "reserved")
    )
      throw Error("Wrong background fence receipt");
    this.guard(signal);
    this.polling = setInterval(() => {
      if (this.checking || this.stopped || this.fault) return;
      this.checking = true;
      this.check()
        .catch(() => this.revoke())
        .finally(() => {
          this.checking = false;
        });
    }, 250);
    this.polling.unref();
    return { driverGeneration, driverProcessStart: this.driver.processStart };
  }
  private matchesReceipt(receipt: any, state: string) {
    return (
      !!this.fence &&
      !!this.lease &&
      receipt?.state === state &&
      Object.entries(this.fence).every(
        ([key, value]) => receipt.reservation?.[key] === value,
      ) &&
      Object.entries(this.lease).every(
        ([key, value]) => key === "expiresAt" || receipt.lease?.[key] === value,
      )
    );
  }
  private validateLease(value: any, expected: Lease) {
    if (
      !value ||
      Object.entries(expected).some(([k, v]) =>
        k === "expiresAt"
          ? !Number.isFinite(Date.parse(value[k])) ||
            Math.abs(Date.parse(value[k]) - Date.parse(String(v))) >= 1000
          : value[k] !== v,
      )
    )
      throw Error("Helper returned another execution lease");
  }
  async check(signal?: AbortSignal) {
    const lease = this.guard(signal),
      generation = this.generation;
    const status = statusSchema.parse(
      await this.json("/status", "GET", undefined, signal),
    );
    this.guard(signal);
    if (
      generation !== this.generation ||
      status.activeSessionId !== lease.id ||
      !status.localEnabled ||
      !status.armed ||
      !status.available ||
      !status.screenPermission ||
      !status.controlPermission ||
      status.deviceId !== lease.deviceId ||
      status.policyRevision !== lease.policyRevision
    )
      throw Error("Local Stop or ownership changed");
    return lease;
  }
  async beforeDispatch(signal: AbortSignal) {
    const lease = await this.check(signal);
    const driver = driverSchema.parse(
      await this.json(
        "/background-driver",
        "POST",
        { pid: this.driver!.pid },
        signal,
      ),
    );
    if (JSON.stringify(driver) !== JSON.stringify(this.driver))
      throw Error("Driver generation changed");
    const next = {
      ...lease,
      expiresAt: new Date(
        Math.min(this.expiresAt, this.now() + 25000),
      ).toISOString(),
    };
    this.validateLease(
      await this.json(`/sessions/${lease.id}/renew`, "POST", next, signal),
      next,
    );
    this.guard(signal);
    this.lease = next;
  }
  async target(
    bundleId: string,
    pid: number,
    windowId: string,
    signal: AbortSignal,
  ) {
    const lease = await this.check(signal);
    const numericId = Number(windowId);
    if (
      !Number.isSafeInteger(numericId) ||
      numericId <= 0 ||
      numericId > 0xffffffff
    )
      throw Error("Invalid exact window identity");
    const result = backgroundTargetSchema.parse(
      await this.json(
        `/sessions/${lease.id}/background-target`,
        "POST",
        { bundleId, pid, windowId: numericId },
        signal,
      ),
    );
    if (
      result.bundleId !== bundleId ||
      result.pid !== pid ||
      result.windowId !== numericId
    )
      throw Error("Helper returned another background target");
    this.guard(signal);
    return result;
  }
  async application(bundleId: string, signal: AbortSignal) {
    const lease = await this.check(signal);
    const result = z
      .object({
        bundleId: z.string(),
        bundleVersion: z.string(),
        executablePath: z.string().startsWith("/"),
      })
      .parse(
        await this.json(
          `/sessions/${lease.id}/background-application`,
          "POST",
          { bundleId },
          signal,
        ),
      );
    if (result.bundleId !== bundleId)
      throw Error("Helper returned another application");
    this.guard(signal);
    return result;
  }
  async verifyCleanupDriver(signal: AbortSignal) {
    if (!this.driver) throw Error("No owned driver");
    const current = driverSchema.parse(
      await this.json(
        "/background-driver",
        "POST",
        { pid: this.driver.pid },
        signal,
      ),
    );
    if (
      current.pid !== this.driver.pid ||
      current.processStart !== this.driver.processStart
    )
      throw Error("Driver generation changed during cleanup");
  }
  stop() {
    this.stopped = true;
    this.generation++;
    if (this.polling) clearInterval(this.polling);
    this.polling =
      undefined; /* A local stop must never erase the durable external fence. */
  }
  close(quiescent: boolean, allActionsReconciled: boolean) {
    return (this.closing ??= this.closeOnce(quiescent, allActionsReconciled));
  }
  private async closeOnce(quiescent: boolean, allActionsReconciled: boolean) {
    this.stop();
    let resolved = !this.fence;
    try {
      if (this.lease && this.fence && quiescent && allActionsReconciled) {
        const evidence = {
          fingerprint: this.fence.fingerprint,
          driverGeneration: this.fence.driverGeneration,
          driverPid: this.fence.driverPid,
          driverProcessStart: this.fence.driverProcessStart,
          driverQuiescent: true,
          allActionsReconciled: true,
          observationId: `cleanup_${randomUUID()}`,
          observedAt: new Date(this.now()).toISOString(),
          outcome: "observed_completed",
        };
        const receipt = await this.json(
          `/sessions/${this.lease.id}/background-actions/${this.fence.id}/resolve`,
          "POST",
          evidence,
        );
        resolved =
          this.matchesReceipt(receipt, "resolved") &&
          Object.entries(evidence).every(([key, value]) =>
            key === "observedAt"
              ? Number.isFinite(Date.parse(receipt.resolution?.[key])) &&
                Math.abs(
                  Date.parse(receipt.resolution[key]) -
                    Date.parse(String(value)),
                ) < 1000
              : receipt.resolution?.[key] === value,
          );
      }
    } finally {
      if (this.lease)
        await this.json(`/sessions/${this.lease.id}/stop`, "POST", {});
    }
    return resolved;
  }
}
