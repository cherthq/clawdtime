import { expect, it, vi } from "vitest";
import { sharedCallProof } from "../cli/shared.js";

const credential = `credential_${"a".repeat(36)}.${"b".repeat(43)}`;

it("asks for the call code with this Mac's device credential and never sends a sign-in text", async () => {
  const request = vi.fn(async () =>
    Response.json({ callId: "call", code: "12345678", expiresAt: 1 }),
  );
  const proof = await sharedCallProof(
    { origin: "https://coordinator.example", credential },
    undefined,
    request as unknown as typeof fetch,
  );
  expect(proof.code).toBe("12345678");
  expect(request).toHaveBeenCalledOnce();
  const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://coordinator.example/device/call-proof");
  expect((init.headers as Record<string, string>).authorization).toBe(
    `Bearer ${credential}`,
  );
  expect(init.redirect).toBe("error");
  expect(JSON.parse(init.body as string)).toEqual({});
});

it("reports a refused call code without a code", async () => {
  const request = vi.fn(async () =>
    Response.json(
      { ok: false, code: "shared_call_not_waiting" },
      { status: 409 },
    ),
  );
  await expect(
    sharedCallProof(
      { origin: "https://coordinator.example", credential },
      "call",
      request as unknown as typeof fetch,
    ),
  ).rejects.toThrow("shared_call_not_waiting");
});
