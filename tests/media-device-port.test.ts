import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MediaDevicePort, mediaSessionId } from "../media/device-port.js";
import type { ControlLease } from "../src/contracts.js";
import {
  CAMERA_ERROR_CODES,
  CameraOperationError,
} from "../src/camera-errors.js";

const lease = (): ControlLease => ({
  id: "lease_a",
  requestId: "request_a",
  sessionId: "agent_a",
  pairingId: "pair_a",
  callId: mediaSessionId("request_a"),
  deviceId: "device_a",
  displayId: "123",
  memberId: "member_a",
  mode: "control",
  epoch: 1,
  expiresAt: Date.now() + 20_000,
  state: "active",
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

describe("media device port", () => {
  const cameraCommand = {
    version: 1 as const,
    commandId: "overview",
    op: "overview" as const,
    expectedRevision: 2,
    sourceFrameId: "frame",
    geometryGeneration: "geometry",
  };

  it.each(CAMERA_ERROR_CODES)(
    "preserves only bounded camera rejection %s without retry",
    async (code) => {
      for (const method of ["status", "command"]) {
        let calls = 0;
        const port = new MediaDevicePort(
          "http://127.0.0.1:4212",
          "k".repeat(32),
          (async () => {
            calls++;
            return json(
              { errorCode: code, privateReason: "PRIVATE_TARGET_CONTENT" },
              409,
            );
          }) as typeof fetch,
        );
        const error = await (
          method === "status"
            ? port.cameraStatus(lease())
            : port.cameraCommand(lease(), cameraCommand)
        ).catch((error) => error);
        expect(error).toBeInstanceOf(CameraOperationError);
        expect(error.code).toBe(code);
        expect(String(error)).not.toContain("PRIVATE");
        expect(Object.keys(error)).toEqual(["code"]);
        expect(calls).toBe(1);
      }
    },
  );

  it.each(["plain", "unknown", "large", "malformed-success", "transport"])(
    "sanitizes %s camera failure and preserves unknown outcome",
    async (kind) => {
      let calls = 0;
      const port = new MediaDevicePort(
        "http://127.0.0.1:4212",
        "k".repeat(32),
        (async () => {
          calls++;
          if (kind === "transport") throw new Error("PRIVATE_PROVIDER_BODY");
          if (kind === "plain")
            return new Response("PRIVATE_PROVIDER_BODY", { status: 409 });
          if (kind === "large")
            return json(
              {
                errorCode: "camera_frame_stale",
                privateReason: "x".repeat(1024),
              },
              409,
            );
          if (kind === "malformed-success")
            return json({ privateReason: "PRIVATE_PROVIDER_BODY" });
          return json({ errorCode: "PRIVATE_PROVIDER_BODY" }, 409);
        }) as typeof fetch,
      );
      const error = await port
        .cameraCommand(lease(), cameraCommand)
        .catch((error) => error);
      expect(error).toBeInstanceOf(CameraOperationError);
      expect(error.code).toBe("camera_transport_failed");
      expect(String(error)).not.toContain("PRIVATE");
      expect(calls).toBe(1);
    },
  );

  it("refuses invalid camera command before any transport", async () => {
    let calls = 0;
    const port = new MediaDevicePort(
      "http://127.0.0.1:4212",
      "k".repeat(32),
      (async () => {
        calls++;
        return json({});
      }) as typeof fetch,
    );
    await expect(
      port.cameraCommand(lease(), { ...cameraCommand, expectedRevision: -1 }),
    ).rejects.toMatchObject({ code: "camera_invalid_command" });
    expect(calls).toBe(0);
  });

  it("uses stable attention identity and exact media lease/action wire shapes", async () => {
    const current = lease();
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const port = new MediaDevicePort(
      "http://127.0.0.1:4212",
      "k".repeat(32),
      (async (url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url: String(url), body });
        if (String(url).endsWith("/lease"))
          return json({ accepted: true, leaseId: current.id });
        if (String(url).endsWith("/stop"))
          return json({ released: true, leaseId: current.id });
        return json({
          id: "action_a",
          sessionId: mediaSessionId(current.requestId),
          leaseId: current.id,
          state: "submitted",
        });
      }) as typeof fetch,
    );
    await port.createLease(current);
    await port.action(
      current,
      { id: "frame_a", capturedAt: Date.now(), width: 100, height: 100 },
      { kind: "scroll", x: 0.5, y: 0.5, deltaY: 100 },
      "action_a",
    );
    await port.release(current);
    expect(calls[1]?.body).toEqual({
      id: "action_a",
      leaseId: current.id,
      callId: current.callId,
      memberId: "member_a",
      deviceId: "device_a",
      displayId: 123,
      frameId: "frame_a",
      type: "scroll",
      x: 0.5,
      y: 0.5,
      deltaY: 100,
    });
    expect(calls[0]?.url).toContain(
      `/sessions/${mediaSessionId(current.requestId)}/screen/lease`,
    );
    expect(mediaSessionId("request_a")).not.toEqual(
      mediaSessionId("request_b"),
    );
  });

  it("never repeats an unknown input and rejects foreign receipts", async () => {
    let calls = 0;
    const port = new MediaDevicePort(
      "http://127.0.0.1:4212",
      "k".repeat(32),
      (async () => {
        calls++;
        return json({
          id: "action_a",
          sessionId: "foreign",
          leaseId: "lease_a",
          state: "submitted",
        });
      }) as typeof fetch,
    );
    await expect(
      port.action(
        lease(),
        { id: "frame_a", capturedAt: Date.now(), width: 100, height: 100 },
        { kind: "type", text: "Fixture" },
        "action_a",
      ),
    ).rejects.toThrow("binding mismatch");
    expect(calls).toBe(1);
  });

  it("returns only fresh correctly bound verified frame bytes", async () => {
    const current = lease();
    const pixels = Buffer.from("synthetic-jpeg");
    const observed = {
      leaseId: current.id,
      deviceId: current.deviceId,
      displayId: 123,
      mode: "control",
      state: "viewing",
      frameId: "frame_a",
      capturedAt: new Date().toISOString(),
      width: 100,
      height: 100,
      jpegBase64: pixels.toString("base64"),
      sha256: createHash("sha256").update(pixels).digest("hex"),
    };
    const port = new MediaDevicePort(
      "http://127.0.0.1:4212",
      "k".repeat(32),
      (async () => json(observed)) as typeof fetch,
    );
    expect((await port.frameImage(current)).dataUrl).toBe(
      `data:image/jpeg;base64,${pixels.toString("base64")}`,
    );
    observed.deviceId = "wrong";
    current.expiresAt = Date.now() - 1;
    await expect(port.frame(current)).rejects.toThrow("bound screen");
  });

  it("rejects public plaintext origin and uncertain release", async () => {
    expect(
      () => new MediaDevicePort("http://example.com", "k".repeat(32)),
    ).toThrow("HTTPS");
    const port = new MediaDevicePort(
      "http://127.0.0.1:4212",
      "k".repeat(32),
      (async () => json({ released: false })) as typeof fetch,
    );
    await expect(port.release(lease())).rejects.toThrow("not confirmed");
  });
  it("readiness reads exact device/member/display metadata without a lease", async () => {
    const paths: string[] = [];
    let memberId = "member_a";
    const port = new MediaDevicePort(
      "http://127.0.0.1:4212",
      "k".repeat(32),
      (async (url, init) => {
        paths.push(String(url));
        expect(init?.method).toBe("GET");
        expect(init?.body).toBeUndefined();
        return json({
          deviceId: "device_a",
          memberId,
          displayId: "123",
          viewAllowed: false,
          controlAllowed: false,
        });
      }) as typeof fetch,
    );
    expect(
      (await port.readiness("device_a", "member_a", "123")).viewAllowed,
    ).toBe(false);
    expect(paths).toEqual([
      "http://127.0.0.1:4212/devices/device_a/readiness/member_a/123",
    ]);
    memberId = "other";
    await expect(port.readiness("device_a", "member_a", "123")).rejects.toThrow(
      "member/display",
    );
    await expect(
      port.readiness("device_a", "member_a", "../123"),
    ).rejects.toThrow("binding");
  });
});
