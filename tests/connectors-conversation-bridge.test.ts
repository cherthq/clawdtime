import { it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalProject, secureWrite } from "../connectors/shared/state.js";
import { startSetupSession } from "../connectors/shared/setup-session.js";

it("foreground v2 retains same-session turns and minimal receipts while refusing screenshot fallback before dispatch", async () => {
  const root = canonicalProject(
      mkdtempSync(join(tmpdir(), "clawdtime-v2-bridge-")),
    ),
    connection = join(root, "connection.json"),
    runId = "synthetic-conversation-run";
  secureWrite(connection, {
    schemaVersion: 1,
    projectRoot: root,
    adapter: "codex",
    adapterVersion: "synthetic",
    hostId: "fixture-host",
    baseUrl: "https://fixture.invalid",
    token: "synthetic-pairing",
    pairing: { id: "pair" },
  });
  const requests: { path: string; body: any }[] = [];
  const session = {
    id: "session",
    protocolVersion: 2,
    state: "active",
    controlEpoch: 0,
  };
  const test = {
    id: "test",
    sessionId: "session",
    pairingId: "pair",
    requestId: "request",
    state: "call_requested",
  };
  const request = (async (url: any, init: any) => {
    const path = new URL(String(url)).pathname,
      body = init?.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, body });
    let result: any = {};
    if (path === "/api/sessions")
      result = { session, token: "synthetic-session" };
    else if (path === "/api/sessions/heartbeat") result = { session };
    else if (path === "/api/doctor") result = { mode: "simulation", session };
    else if (path === "/api/setup/test") result = { test };
    else if (path.endsWith("/conversation/turns"))
      result = {
        turns: [{ id: "turn", sequence: 1, text: "transient-human-text" }],
        cursor: 1,
        session,
      };
    else if (path.endsWith("/conversation/ack"))
      result = {
        id: "turn",
        delivery: "acknowledged",
        text: "transient-human-text",
      };
    else if (path.endsWith("/conversation/reply"))
      result = { id: "reply", state: "completed", text: "transient-speech" };
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  const input = new PassThrough(),
    output = new PassThrough();
  let buffer = "";
  const messages: any[] = [];
  output.on("data", (chunk) => {
    buffer += String(chunk);
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      messages.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  const done = startSetupSession({
    connection,
    project: root,
    adapter: "codex",
    runId,
    input,
    output,
    request,
  });
  const wait = async (id: string) => {
    await vi.waitFor(() =>
      expect(messages.some((m) => m.id === id)).toBe(true),
    );
    return messages.find((m) => m.id === id);
  };
  const send = async (id: string, command: string, args: any = {}) => {
    input.write(JSON.stringify({ id, command, args }) + "\n");
    return wait(id);
  };
  try {
    await vi.waitFor(() =>
      expect(messages.some((m) => m.event === "ready")).toBe(true),
    );
    expect(messages[0].protocolVersion).toBe(2);
    expect(requests[0]?.body.protocolVersion).toBe(2);
    await send("status", "status");
    const turns = await send("turns", "conversation_turns", {
      requestId: "request",
      after: 0,
    });
    expect(turns.result.turns[0].text).toBe("transient-human-text");
    await send("ack", "acknowledge_turn", {
      requestId: "request",
      turnId: "turn",
    });
    await send("reply", "conversation_reply", {
      requestId: "request",
      turnId: "turn",
      replyId: "reply",
      text: "transient-speech",
    });
    const checkpoint = readFileSync(
      join(root, "runs", `${runId}.setup.json`),
      "utf8",
    );
    expect(checkpoint).not.toContain("transient-human-text");
    expect(checkpoint).not.toContain("transient-speech");
    const count = requests.length;
    expect(
      (
        await send("observe", "observe_shared_screen", {
          requestId: "request",
          epoch: 0,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await send("fallback", "transfer_execution", {
          requestId: "request",
          expectedEpoch: 0,
          executor: "clawdtime",
          previousOutcome: "idle",
          backgroundActorsStopped: true,
        })
      ).ok,
    ).toBe(false);
    expect(
      (await send("yield", "yield", { backgroundActorsStopped: true })).ok,
    ).toBe(false);
    expect(requests).toHaveLength(count);
    input.write(
      JSON.stringify({
        id: "reply",
        command: "conversation_reply",
        args: {
          requestId: "request",
          turnId: "turn",
          replyId: "reply",
          text: "transient-speech",
        },
      }) + "\n",
    );
    await vi.waitFor(() =>
      expect(messages.filter((m) => m.id === "reply")).toHaveLength(2),
    );
    expect(messages.filter((m) => m.id === "reply")[1].result.recorded).toBe(
      true,
    );
    expect(
      requests.filter((r) => r.path.endsWith("/conversation/reply")),
    ).toHaveLength(1);
  } finally {
    input.end();
    await done;
    rmSync(root, { recursive: true, force: true });
  }
});
