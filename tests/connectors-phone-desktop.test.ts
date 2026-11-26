import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { callPhoneDesktop } from "../connectors/agents/phone-desktop.js";
import { phoneCli } from "../cli/phone.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-phone-cli-"));
  roots.push(root);
  const folder = join(root, "desktop");
  mkdirSync(folder, { mode: 0o700 });
  const origin = "http://127.0.0.1:12345",
    token = "synthetic-private-token".repeat(3);
  const base = { version: 1, origin, configurationFingerprint: "a".repeat(64) };
  const write = (name: string, data: unknown) =>
    writeFileSync(join(folder, name), JSON.stringify(data), { mode: 0o600 });
  write("desktop-service.json", {
    ...base,
    instanceId: "expected",
    pid: process.pid,
  });
  write("desktop-panel.json", { ...base, token });
  write("owner.lock", { pid: process.pid });
  const request = vi.fn<typeof fetch>(async (_url, init) =>
    init?.method === "GET"
      ? Response.json({ instanceId: "expected" })
      : Response.json({
          ok: true,
          reply: { text: "Requested a launch; not verified yet." },
        }),
  );
  const system = { env: { CLAWDTIME_DESKTOP_STATE: folder }, home: "/nowhere" };
  return { folder, token, system, request };
}
const chat = {
  action: "chat" as const,
  callId: "call-1",
  requestId: "turn-1",
  payload: {
    text: "Show the screen and open Messages.",
    presentation: {
      kind: "sharing" as const,
      action: "show" as const,
      applied: true,
    },
  },
};

it("refuses a replaced pinned desktop and cancellation before sending input", async () => {
  const f = fixture();
  expect(
    await callPhoneDesktop(f.system, chat, {
      request: f.request,
      expectedInstanceId: "previous",
    }),
  ).toEqual({ ok: false, code: "desktop_unavailable" });
  expect(f.request).not.toHaveBeenCalled();
  const abort = new AbortController();
  f.request.mockImplementationOnce(async () => {
    abort.abort();
    return Response.json({ instanceId: "expected" });
  });
  expect(
    await callPhoneDesktop(f.system, chat, {
      request: f.request,
      signal: abort.signal,
      expectedInstanceId: "expected",
    }),
  ).toEqual({ ok: false, code: "phone_request_cancelled" });
  expect(f.request).toHaveBeenCalledOnce();
});

it("verifies the instance then forwards one exact text and trusted presentation with its call identity", async () => {
  const f = fixture();
  expect(
    await callPhoneDesktop(f.system, chat, { request: f.request }),
  ).toEqual({
    ok: true,
    reply: { text: "Requested a launch; not verified yet." },
  });
  expect(f.request).toHaveBeenCalledTimes(2);
  const [url, init] = f.request.mock.calls[1]!;
  expect(String(url).endsWith("/desktop/phone/chat")).toBe(true);
  expect(init?.method).toBe("POST");
  expect(init?.redirect).toBe("error");
  expect(JSON.parse(String(init?.body))).toEqual({
    instanceId: "expected",
    callId: "call-1",
    requestId: "turn-1",
    ...chat.payload,
  });
  expect(init?.headers).toEqual({
    authorization: `Bearer ${f.token}`,
    "content-type": "application/json",
  });
});

it("does not post to missing, dead or replaced services and has no standalone fallback", async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce(Response.json({ instanceId: "replacement" }));
  expect(
    await callPhoneDesktop(f.system, chat, { request: f.request }),
  ).toEqual({ ok: false, code: "desktop_unavailable" });
  expect(f.request).toHaveBeenCalledTimes(1);
  f.request.mockClear();
  rmSync(f.folder, { recursive: true });
  expect(
    await callPhoneDesktop(f.system, chat, { request: f.request }),
  ).toEqual({ ok: false, code: "desktop_unavailable" });
  expect(f.request).not.toHaveBeenCalled();
});

it("never retries a dispatched operation with a lost or malformed result", async () => {
  for (const malformed of [false, true]) {
    const f = fixture();
    f.request.mockImplementationOnce(async () =>
      Response.json({ instanceId: "expected" }),
    );
    if (malformed) f.request.mockResolvedValueOnce(Response.json({ ok: true }));
    else f.request.mockRejectedValueOnce(Error("untrusted secret error"));
    expect(
      await callPhoneDesktop(f.system, chat, { request: f.request }),
    ).toEqual({ ok: false, code: "outcome_unknown" });
    expect(f.request).toHaveBeenCalledTimes(2);
  }
});

it("returns known refused call outcomes without reopening or redispatching", async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce(Response.json({ instanceId: "expected" }));
  f.request.mockResolvedValueOnce(
    Response.json({ ok: false, code: "phone_call_expired" }, { status: 403 }),
  );
  expect(
    await callPhoneDesktop(f.system, chat, { request: f.request }),
  ).toEqual({ ok: false, code: "phone_call_expired" });
  expect(f.request).toHaveBeenCalledTimes(2);
});

it("opens, renews and closes only the named call with one operation each", async () => {
  for (const action of ["open", "renew", "close", "stop"] as const) {
    const f = fixture();
    f.request.mockResolvedValueOnce(Response.json({ instanceId: "expected" }));
    f.request.mockResolvedValueOnce(Response.json({ ok: true }));
    await callPhoneDesktop(
      f.system,
      { action, callId: "call-1" },
      { request: f.request },
    );
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(
      String(f.request.mock.calls[1]![0]).endsWith(`/desktop/phone/${action}`),
    ).toBe(true);
    expect(JSON.parse(String(f.request.mock.calls[1]![1]?.body))).toEqual({
      instanceId: "expected",
      callId: "call-1",
    });
  }
});

it("CLI refuses invalid IDs and payloads before transport and emits credential-free JSON", async () => {
  const f = fixture(),
    lines: string[] = [];
  for (const args of [
    ["chat", "bad id", "turn", JSON.stringify(chat.payload)],
    ["chat", "call", "turn", "bad-json"],
    [
      "chat",
      "call",
      "turn",
      JSON.stringify({
        ...chat.payload,
        presentation: { kind: "sharing", action: "click", applied: true },
      }),
    ],
  ]) {
    await phoneCli(args, {
      ...f.system,
      request: f.request,
      print: (text) => lines.push(text),
    });
  }
  expect(f.request).not.toHaveBeenCalled();
  expect(lines.map((line) => JSON.parse(line))).toEqual(
    Array(3).fill({ ok: false, code: "invalid_request" }),
  );
});
