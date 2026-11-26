import { z } from "zod";
import type { Frame, InputAction, TextControlGrant } from "../contracts.js";
export interface TextLease {
  leaseId: string;
  deviceId: string;
  memberId: string;
  displayId: number;
  protocolVersion: 3;
  sessionId: string;
  executor: "native" | "clawdtime";
  executorEpoch: number;
  policyRevision: number;
  mode: "view" | "control";
  expiresAt: string;
  authority: { kind: "text_session"; grantId: string; projectId: string };
}
export interface DesktopObservation {
  frame: Frame;
  dataUrl: string;
}
export interface TextDesktopPort {
  proposeGrant(grant: TextControlGrant): Promise<unknown>;
  grantStatus(
    deviceId: string,
    grantId: string,
  ): Promise<{ state: string; grant?: TextControlGrant }>;
  revokeGrant?(deviceId: string, grantId: string): Promise<void>;
  acquire(lease: TextLease): Promise<void>;
  observe(lease: TextLease): Promise<DesktopObservation>;
  input(
    lease: TextLease,
    frame: Frame,
    action: InputAction,
    actionId: string,
  ): Promise<{ submitted: boolean }>;
  release(lease: TextLease): Promise<void>;
}
const id = (value: string) => {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value))
    throw new Error("Invalid scoped identifier.");
  return value;
};
export class MediaTextDevicePort implements TextDesktopPort {
  constructor(
    private origin: string,
    private key: string,
    private request: typeof fetch = fetch,
  ) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && url.hostname === "127.0.0.1")
      ) ||
      key.length < 32
    )
      throw new Error("Invalid media connection.");
  }
  private async api(path: string, method = "GET", body?: unknown) {
    const r = await this.request(this.origin + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(4000),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok)
      throw new Error(
        "Text device operation refused; reconcile original receipts.",
      );
    const reader = r.body?.getReader();
    if (!reader) throw new Error("Missing response.");
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 3 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Oversize device response.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
  }
  proposeGrant(grant: TextControlGrant) {
    return this.api(
      `/devices/${id(grant.deviceId)}/text-grants`,
      "POST",
      grant,
    );
  }
  async grantStatus(deviceId: string, grantId: string) {
    const result = await this.api(
      `/devices/${id(deviceId)}/text-grants/${id(grantId)}`,
    );
    return {
      state: String(result.state),
      ...(result.grant ? { grant: result.grant as TextControlGrant } : {}),
    };
  }
  async revokeGrant(deviceId: string, grantId: string) {
    const r = await this.api(
      `/devices/${id(deviceId)}/text-grants/${id(grantId)}`,
      "DELETE",
    );
    if (r.revoked !== true) throw new Error("Grant revocation unconfirmed.");
  }
  async acquire(lease: TextLease) {
    const { leaseId, ...body } = lease;
    const r = await this.api("/text-leases", "POST", { id: leaseId, ...body });
    if (r.id !== leaseId || r.state !== "active")
      throw new Error("Lease acknowledgement missing.");
  }
  async observe(lease: TextLease) {
    const r = await this.api(`/text-leases/${id(lease.leaseId)}/frame`);
    const image = z
      .object({
        frameId: z.string().min(1).max(160),
        capturedAt: z.string(),
        width: z.number().int().min(1).max(1280),
        height: z.number().int().min(1).max(720),
        jpegBase64: z.string().max(3_000_000),
      })
      .parse(r);
    const capturedAt = Date.parse(image.capturedAt);
    if (
      !Number.isFinite(capturedAt) ||
      Date.now() - capturedAt > 2000 ||
      capturedAt > Date.now() + 500
    )
      throw new Error("Stale observation.");
    return {
      frame: {
        id: image.frameId,
        capturedAt,
        width: image.width,
        height: image.height,
      },
      dataUrl: `data:image/jpeg;base64,${image.jpegBase64}`,
    };
  }
  async input(
    lease: TextLease,
    frame: Frame,
    action: InputAction,
    actionId: string,
  ) {
    const { kind, ...parameters } = action;
    const r = await this.api(
      `/text-leases/${id(lease.leaseId)}/actions`,
      "POST",
      {
        id: id(actionId),
        frameId: frame.id,
        type: kind,
        ...parameters,
        sessionId: lease.sessionId,
        executorEpoch: lease.executorEpoch,
        policyRevision: lease.policyRevision,
      },
    );
    if (
      r.id !== actionId ||
      r.leaseId !== lease.leaseId ||
      r.state !== "submitted"
    )
      throw new Error("Input outcome unconfirmed.");
    return { submitted: true };
  }
  async release(lease: TextLease) {
    const r = await this.api(`/text-leases/${id(lease.leaseId)}`, "DELETE");
    if (r.released !== true) throw new Error("Release outcome unconfirmed.");
  }
}
