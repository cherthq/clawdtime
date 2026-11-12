import { expect, it } from "vitest";
import { ClawdTimeClient } from "../connectors/shared/client.js";

it("explains only allowlisted structured conflicts and redacts arbitrary error text", async () => {
  for (const [errorCode, expected] of [
    ["setup_reserved", "setup reservation"],
    ["reply_context_stale", "Newer speech arrived"],
    ["reply_exists", "already has a spoken reply"],
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
