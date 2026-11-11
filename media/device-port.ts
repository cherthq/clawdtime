import { createHash } from "node:crypto";
import type {
  ControlLease,
  DevicePort,
  Frame,
  InputAction,
} from "../src/contracts.js";

/** Stable namespacing; room IDs are never guessed from an active process/window. */
export const mediaSessionId = (requestId: string): string =>
  `ct_${createHash("sha256").update(requestId).digest("hex").slice(0, 40)}`;
export interface ScreenFrame extends Frame {
  jpegBase64: string;
  sha256: string;
}

type Wire = Record<string, unknown>;
export class MediaDevicePort implements DevicePort {
  constructor(
    readonly origin: string,
    private readonly key: string,
    private readonly request: typeof fetch = fetch,
  ) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      throw new Error("Media origin must be HTTPS or literal loopback.");
    if (key.length < 32)
      throw new Error("Media credential must contain at least 32 characters.");
  }
  private path(lease: ControlLease, suffix: string): string {
    return `/sessions/${mediaSessionId(lease.requestId)}/screen${suffix}`;
  }
  private async api(path: string, body?: Wire): Promise<Wire> {
    const response = await this.request(this.origin + path, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(4000),
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(
        `Media operation refused (${response.status}); reconcile before retrying.`,
      );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing media response.");
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 3 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Media response exceeds bound.");
      }
      chunks.push(value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Malformed media response.");
    return result as Wire;
  }
  /** Registered-helper metadata only: this does not grant, arm or capture. */
  async readiness(
    deviceId: string,
    memberId?: string,
    displayId?: string,
  ): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(deviceId))
      throw new Error("Invalid device identifier.");
    let suffix = "";
    if (memberId !== undefined || displayId !== undefined) {
      if (
        !memberId ||
        !/^[A-Za-z0-9_-]{1,160}$/.test(memberId) ||
        !displayId ||
        !/^[0-9]{1,10}$/.test(displayId) ||
        Number(displayId) < 1 ||
        Number(displayId) > 0xffffffff
      )
        throw new Error("Invalid readiness member/display binding.");
      suffix = `/${memberId}/${displayId}`;
    }
    const result = await this.api(`/devices/${deviceId}/readiness${suffix}`);
    if (
      suffix &&
      (result.memberId !== memberId || result.displayId !== displayId)
    )
      throw new Error("Readiness member/display identity mismatch.");
    if (result.deviceId !== deviceId)
      throw new Error("Readiness device identity mismatch.");
    return result;
  }
  async createLease(lease: ControlLease): Promise<void> {
    const result = await this.api(this.path(lease, "/lease"), {
      leaseId: lease.id,
    });
    if (result.accepted !== true || result.leaseId !== lease.id)
      throw new Error("Media lease binding mismatch.");
  }
  async frame(lease: ControlLease): Promise<ScreenFrame> {
    // Read-only retries allow the video capture loop to produce its next frame.
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const result = await this.api(this.path(lease, "/frame"));
        const at = Date.parse(String(result.capturedAt));
        if (
          result.leaseId !== lease.id ||
          result.deviceId !== lease.deviceId ||
          String(result.displayId) !== lease.displayId ||
          result.mode !== lease.mode ||
          result.state !== "viewing" ||
          typeof result.frameId !== "string" ||
          !/^[A-Za-z0-9_-]{1,160}$/.test(result.frameId) ||
          !Number.isFinite(at) ||
          Date.now() - at > 2000 ||
          at - Date.now() > 500 ||
          !Number.isInteger(result.width) ||
          !Number.isInteger(result.height) ||
          Number(result.width) < 1 ||
          Number(result.width) > 1280 ||
          Number(result.height) < 1 ||
          Number(result.height) > 720 ||
          typeof result.jpegBase64 !== "string" ||
          typeof result.sha256 !== "string"
        )
          throw new Error("Fresh bound screen frame required.");
        const image = Buffer.from(result.jpegBase64, "base64");
        if (
          image.length > 2 * 1024 * 1024 ||
          createHash("sha256").update(image).digest("hex") !== result.sha256
        )
          throw new Error("Screen frame integrity mismatch.");
        return {
          id: result.frameId,
          capturedAt: at,
          width: Number(result.width),
          height: Number(result.height),
          jpegBase64: result.jpegBase64,
          sha256: result.sha256,
        };
      } catch (error) {
        if (attempt === 7 || Date.now() >= lease.expiresAt) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error("Screen frame unavailable.");
  }
  /** Transient pixels for one bounded vision action; callers must never persist them. */
  async frameImage(
    lease: ControlLease,
  ): Promise<{ frame: Frame; dataUrl: string }> {
    const observed = await this.frame(lease);
    return {
      frame: {
        id: observed.id,
        capturedAt: observed.capturedAt,
        width: observed.width,
        height: observed.height,
      },
      dataUrl: `data:image/jpeg;base64,${observed.jpegBase64}`,
    };
  }
  async action(
    lease: ControlLease,
    frame: Frame,
    action: InputAction,
    actionId: string,
  ): Promise<{ submitted: boolean }> {
    const { kind, ...fields } = action;
    const result = await this.api(this.path(lease, "/actions"), {
      id: actionId,
      leaseId: lease.id,
      callId: lease.callId,
      memberId: lease.memberId,
      deviceId: lease.deviceId,
      displayId: Number(lease.displayId),
      frameId: frame.id,
      type: kind,
      ...fields,
    });
    if (
      result.id !== actionId ||
      result.leaseId !== lease.id ||
      result.sessionId !== mediaSessionId(lease.requestId)
    )
      throw new Error("Input receipt binding mismatch; outcome unknown.");
    if (result.state !== "submitted")
      throw new Error("Input outcome requires read-only reconciliation.");
    return { submitted: true };
  }
  async release(lease: ControlLease): Promise<void> {
    const result = await this.api(this.path(lease, "/stop"), {
      leaseId: lease.id,
    });
    if (result.released !== true || result.leaseId !== lease.id)
      throw new Error("Lease release is not confirmed.");
  }
  /** Read-only receipt reconciliation is safe even after call teardown/restart. */
  async receipt(lease: ControlLease, actionId: string): Promise<Wire> {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(actionId))
      throw new Error("Invalid action identifier.");
    return this.api(this.path(lease, `/actions/${actionId}`));
  }
}
