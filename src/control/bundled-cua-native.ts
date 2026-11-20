import { createHash } from "node:crypto";
import { z } from "zod";
import {
  cuaActionSchema,
  type BundledCuaConfig,
  type CuaAction,
  type CuaDevice,
  type CuaObservation,
} from "./cua-contracts.js";

type Config = NonNullable<BundledCuaConfig["native"]>;
const statusSchema = z.object({
  deviceId: z.string(),
  localEnabled: z.boolean(),
  armed: z.boolean(),
  available: z.boolean(),
  screenPermission: z.boolean(),
  controlPermission: z.boolean(),
  policyRevision: z.number().int().nonnegative(),
  activeSessionId: z.string().nullable().optional(),
  unresolvedActions: z.number().int().nonnegative(),
});
interface Lease {
  id: string;
  deviceId: string;
  sessionId: string;
  taskId: string;
  executorId: string;
  executorEpoch: number;
  policyRevision: number;
  displayId: number;
  expiresAt: string;
}

/** Local-only native adapter. It neither arms the helper nor requests macOS permissions. */
export class BundledCuaNative implements CuaDevice {
  private lease?: Lease;
  private last?: CuaObservation;
  private expiresAt = 0;
  private stopped = true;
  private fault = false;
  private timer?: NodeJS.Timeout;
  private renewal?: Promise<void>;
  private lastCapture = 0;
  private attempted = new Set<string>();
  private generation = 0;
  constructor(
    private config: Config,
    private request: typeof fetch = fetch,
    private now = Date.now,
  ) {
    if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(config.origin))
      throw Error("Native runtime requires loopback.");
  }
  private guard(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (
      this.stopped ||
      this.fault ||
      !this.lease ||
      this.now() >= this.expiresAt
    )
      throw Error("Native computer authority unavailable.");
    return this.lease;
  }
  private async response(
    path: string,
    method: string,
    body: unknown,
    signal?: AbortSignal,
  ) {
    const response = await this.request(
      `${this.config.origin}/local/v1${path}`,
      {
        method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.config.token}`,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      },
    );
    if (!response.ok)
      throw Error(`Native helper refused (${response.status}).`);
    return response;
  }
  private async bytes(response: Response, max: number) {
    if (!response.body) throw Error("Native helper response unavailable.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.length;
        if (length > max) throw Error("Native helper response exceeded limit.");
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks);
  }
  private async json(
    path: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<any> {
    return JSON.parse(
      (
        await this.bytes(await this.response(path, method, body, signal), 65536)
      ).toString("utf8"),
    );
  }
  async open(task: Parameters<CuaDevice["open"]>[0], signal: AbortSignal) {
    const generation = ++this.generation;
    if (this.lease) throw Error("Native executor was already used.");
    signal.throwIfAborted();
    const status = statusSchema.parse(
      await this.json("/status", "GET", undefined, signal),
    );
    if (generation !== this.generation)
      throw Error("Native opening was stopped.");
    if (
      status.deviceId !== this.config.deviceId ||
      !status.localEnabled ||
      !status.armed ||
      !status.available ||
      !status.screenPermission ||
      !status.controlPermission ||
      status.activeSessionId ||
      status.unresolvedActions
    )
      throw Error(
        "Native helper needs explicit local configuration, permissions, Enable and idle ownership.",
      );
    signal.throwIfAborted();
    this.expiresAt = task.expiresAt;
    this.stopped = false;
    this.lease = {
      id: `local_${task.sessionId}`,
      deviceId: this.config.deviceId,
      sessionId: task.sessionId,
      taskId: task.taskId,
      executorId: this.config.executorId,
      executorEpoch: 0,
      policyRevision: status.policyRevision,
      displayId: this.config.displayId,
      expiresAt: new Date(
        Math.min(task.expiresAt, this.now() + 25000),
      ).toISOString(),
    };
    const accepted = await this.json("/sessions", "POST", this.lease, signal);
    this.validateLease(accepted, this.lease);
    if (generation !== this.generation)
      throw Error("Native opening was stopped.");
    this.guard(signal);
    this.timer = setInterval(() => {
      if (this.renewal || this.stopped) return;
      this.renewal = this.renew()
        .catch(() => {
          this.fault = true;
        })
        .finally(() => {
          this.renewal = undefined;
        });
    }, 10000);
    this.timer.unref();
  }
  private async renew() {
    const current = this.guard();
    const next = {
      ...current,
      expiresAt: new Date(
        Math.min(this.expiresAt, this.now() + 25000),
      ).toISOString(),
    };
    const renewed = await this.json(
      `/sessions/${current.id}/renew`,
      "POST",
      next,
    );
    this.validateLease(renewed, next);
    this.guard();
    this.lease = next;
  }
  private validateLease(value: any, expected: Lease) {
    if (
      !value ||
      Object.entries(expected).some(([key, item]) =>
        key === "expiresAt"
          ? Math.abs(Date.parse(value.expiresAt) - Date.parse(String(item))) >=
              1000 || !Number.isFinite(Date.parse(value.expiresAt))
          : value[key] !== item,
      )
    )
      throw Error("Native helper returned another lease binding.");
  }
  async observe(signal: AbortSignal) {
    const lease = this.guard(signal);
    const delay = Math.max(0, 220 - (this.now() - this.lastCapture));
    if (delay)
      await new Promise<void>((resolve, reject) => {
        const aborted = () => {
          clearTimeout(timer);
          reject(Error("Native capture stopped."));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", aborted);
          resolve();
        }, delay);
        signal.addEventListener("abort", aborted, { once: true });
      });
    this.guard(signal);
    this.lastCapture = this.now();
    const response = await this.response(
      `/sessions/${lease.id}/frame`,
      "GET",
      undefined,
      signal,
    );
    const image = await this.bytes(response, 2 * 1024 * 1024);
    this.guard(signal);
    const id = response.headers.get("x-frame-id"),
      capturedAt = Date.parse(response.headers.get("x-captured-at") ?? ""),
      width = Number(response.headers.get("x-frame-width")),
      height = Number(response.headers.get("x-frame-height"));
    const focus = response.headers.get("x-focus-identity");
    if (
      !id ||
      !/^(?:[a-f0-9]{64}|none)$/.test(focus ?? "") ||
      !Number.isFinite(capturedAt) ||
      this.now() - capturedAt > 2000 ||
      capturedAt > this.now() + 1000 ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      !response.headers.get("content-type")?.startsWith("image/jpeg")
    )
      throw Error("Native frame identity or freshness unavailable.");
    const context = JSON.stringify({
      deviceId: lease.deviceId,
      displayId: lease.displayId,
      focus,
      policyRevision: lease.policyRevision,
    });
    const observation: CuaObservation = {
      id,
      capturedAt,
      width,
      height,
      imageDataUrl: `data:image/jpeg;base64,${image.toString("base64")}`,
      fingerprint: createHash("sha256")
        .update(image)
        .update(context)
        .digest("hex"),
      context,
    };
    this.last = observation;
    return observation;
  }
  async authorize(
    action: CuaAction,
    observation: CuaObservation,
  ): Promise<"confirm" | "refused"> {
    this.guard();
    cuaActionSchema.parse(action);
    if (
      action.type === "type" &&
      JSON.parse(observation.context).focus === "none"
    )
      return "refused";
    return observation.id === this.last?.id &&
      this.now() - observation.capturedAt <= 2000
      ? "confirm"
      : "refused";
  }
  async execute(
    input: Parameters<CuaDevice["execute"]>[0],
    signal: AbortSignal,
  ) {
    const lease = this.guard(signal);
    cuaActionSchema.parse(input.action);
    if (
      input.action.type === "type" &&
      this.last &&
      JSON.parse(this.last.context).focus === "none"
    )
      throw Error("Native typing requires a focused target.");
    if (
      this.attempted.has(input.actionId) ||
      input.observationId !== this.last?.id ||
      this.now() - this.last.capturedAt > 2000
    )
      throw Error("Native action is duplicate or stale.");
    this.attempted.add(input.actionId);
    this.last = undefined;
    const result = await this.json(
      `/sessions/${lease.id}/actions`,
      "POST",
      {
        id: input.actionId,
        frameId: input.observationId,
        ...input.action,
        sessionId: lease.sessionId,
        executorEpoch: lease.executorEpoch,
        policyRevision: lease.policyRevision,
      },
      signal,
    );
    this.guard(signal);
    if (
      result.id !== input.actionId ||
      result.leaseId !== lease.id ||
      result.deviceId !== lease.deviceId ||
      result.sessionId !== lease.sessionId ||
      result.taskId !== lease.taskId ||
      result.executorId !== lease.executorId ||
      result.executorEpoch !== lease.executorEpoch ||
      result.policyRevision !== lease.policyRevision ||
      result.state !== "submitted"
    )
      throw Error("Native input outcome is uncertain.");
  }
  async stop() {
    this.generation++;
    this.stopped = true;
    this.last = undefined;
    if (this.timer) clearInterval(this.timer);
    await this.renewal;
    if (this.lease) {
      const result = await this.json(
        `/sessions/${this.lease.id}/stop`,
        "POST",
        {},
      );
      if (result.stopped !== true) throw Error("Native cleanup is uncertain.");
    }
  }
}
