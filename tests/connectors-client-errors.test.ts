import { expect, it } from "vitest";
import { ApiError, ClawdTimeClient } from "../connectors/shared/client.js";
import { CAMERA_ERROR_CODES } from "../src/camera-errors.js";

it("explains only allowlisted structured conflicts and redacts arbitrary error text", async () => {
  for (const [errorCode, expected] of [
    ["setup_reserved", "setup reservation"],
    ["reply_context_stale", "Newer input arrived"],
    ["reply_exists", "already has a reply"],
    ["input_context_stale", "Newer input must be read"],
    ["input_held", "Incoming speech temporarily holds"],
    ["private-provider-details", "request rejected (409)"],
    ["toString", "request rejected (409)"],
  ]) {
    const request = (async () =>
      new Response(
        JSON.stringify({ errorCode, error: "private-provider-details" }),
        { status: 409 },
      )) as typeof fetch;
    const client = new ClawdTimeClient(
      "http://127.0.0.1:3310",
      "synthetic",
      request,
    );
    await expect(client.setupInvite()).rejects.toThrow(expected);
    await expect(client.setupInvite()).rejects.not.toThrow(
      "private-provider-details",
    );
  }
});

it("preserves only closed camera codes across HTTP failures without retrying or exposing peer text", async () => {
  for (const code of CAMERA_ERROR_CODES) {
    let attempts = 0;
    const client = new ClawdTimeClient(
      "http://127.0.0.1:3310",
      "synthetic",
      (async () => {
        attempts++;
        return new Response(
          JSON.stringify({
            errorCode: code,
            error: "private-provider-details",
          }),
          {
            status:
              code === "camera_rate_limited"
                ? 429
                : code === "camera_transport_failed"
                  ? 503
                  : 409,
          },
        );
      }) as typeof fetch,
    );
    const failure = await client
      .api("/api/attention/request/conversation/camera", {
        commandId: "original",
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe(code);
    expect((failure as ApiError).message).toContain(code);
    expect(JSON.stringify(failure)).not.toContain("private-provider-details");
    expect(attempts).toBe(1);
  }
});

it("drops unknown, malformed and prototype-looking camera codes", async () => {
  for (const code of [
    "private-provider-details",
    "camera_content_changed private-provider-details",
    "__proto__",
    "toString",
    { value: "camera_content_changed", secret: "private-provider-details" },
    ["camera_content_changed"],
    null,
  ]) {
    const client = new ClawdTimeClient(
      "http://127.0.0.1:3310",
      "synthetic",
      (async () =>
        new Response(
          JSON.stringify({
            errorCode: code,
            error: "private-provider-details",
          }),
          { status: 409 },
        )) as typeof fetch,
    );
    const failure = await client
      .api("/api/attention/request/conversation/camera", {
        commandId: "original",
      })
      .catch((error: unknown) => error);
    expect((failure as ApiError).code).toBeUndefined();
    expect((failure as ApiError).message).not.toContain(
      "private-provider-details",
    );
    expect(new ApiError(409, "synthetic", code).code).toBeUndefined();
  }
});
