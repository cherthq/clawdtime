import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSharedByor } from "./shared-byor.mjs";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

function fixture(
  prepare = async () => ({
    url: "wss://media.example",
    token: "test-token",
    expiresAt: 60000,
  }),
) {
  const directory = mkdtempSync(join(tmpdir(), "shared-byor-"));
  const events = [],
    effects = [];
  const options = {
    directory,
    lineId: "line",
    projectId: "project",
    now: () => 1000,
    coordinator: async (_path, body) => {
      events.push(body);
      return { state: body.kind === "incoming" ? "unknown_identity" : "ended" };
    },
    media: {
      prepare: async (input) => {
        effects.push("prepare");
        return prepare(input);
      },
      cleanup: async () => {
        effects.push("cleanup");
        return true;
      },
    },
  };
  const call = {
    operation_id: "operation",
    call_id: "provider-call",
    line_id: "line",
    project_id: "project",
    prepare_deadline_at: 10000,
    maximum_session_expires_at: 60000,
    media: { audio: true, video: true },
  };
  const context = { remaining_ms: 9000, signal: new AbortController().signal };
  return {
    directory,
    options,
    call,
    context,
    events,
    effects,
    handler: createSharedByor(options),
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test("shared provider prepares once, pins bridge identity, and releases only after cleanup", async () => {
  const f = fixture();
  try {
    const decision = await f.handler.prepare(f.call, f.context);
    assert.equal(decision.action, "accept");
    assert.equal(decision.remote_participant_identity, "shared-agent");
    assert.equal(f.events[0].participantId, "shared-bridge");
    assert.deepEqual(await f.handler.prepare(f.call, f.context), {
      action: "decline",
    });
    assert.deepEqual(f.effects, ["prepare"]);
    assert.equal(
      (await f.handler.recover(f.call, { authoritative_terminal: false }))
        .cleanup,
      "pending",
    );
    assert.equal(f.events.length, 1);
    await f.handler.lifecycle(
      f.call,
      { event_id: "end", transition: "ended" },
      { authoritative_terminal: true },
    );
    assert.equal(f.events.length, 1);
    assert.equal(
      (await f.handler.recover(f.call, { authoritative_terminal: true }))
        .cleanup,
      "clean",
    );
    assert.deepEqual(f.effects, ["prepare", "cleanup"]);
    assert.equal(f.events[1].kind, "cleanup_complete");
    const recovered = createSharedByor(f.options);
    assert.equal(
      (await recovered.recover(f.call, { authoritative_terminal: true }))
        .cleanup,
      "clean",
    );
    assert.deepEqual(f.effects, ["prepare", "cleanup"]);
  } finally {
    f.close();
  }
});
test("shared provider never retries allocation with an unknown result, including after restart", async () => {
  const f = fixture(async () => {
    throw Error("lost response");
  });
  try {
    assert.equal(
      (await f.handler.prepare(f.call, f.context)).action,
      "decline",
    );
    const recovered = createSharedByor(f.options);
    assert.equal(
      (await recovered.prepare(f.call, f.context)).action,
      "decline",
    );
    assert.equal(
      (await recovered.recover(f.call, { authoritative_terminal: true }))
        .cleanup,
      "unknown",
    );
    assert.deepEqual(f.effects, ["prepare"]);
    assert.equal(f.events.length, 1);
  } finally {
    f.close();
  }
});
test("shared provider rejects another line and cancels before any allocation", async () => {
  const f = fixture();
  try {
    await assert.rejects(() =>
      f.handler.prepare({ ...f.call, line_id: "other" }, f.context),
    );
    const abort = new AbortController();
    abort.abort();
    assert.equal(
      (await f.handler.prepare(f.call, { ...f.context, signal: abort.signal }))
        .action,
      "decline",
    );
    assert.equal(f.effects.length, 0);
  } finally {
    f.close();
  }
});

test("shared provider preserves requested video readiness and refuses an exhausted preparation budget", async () => {
  let received;
  const f = fixture(async (input) => {
    received = input;
    return { url: "wss://media.example", token: "test", expiresAt: 60000 };
  });
  try {
    assert.equal(
      (await f.handler.prepare(f.call, { ...f.context, remaining_ms: 0 }))
        .action,
      "decline",
    );
    assert.equal(f.effects.length, 0);
    await f.handler.prepare(f.call, f.context);
    assert.equal(received.video, true);
    assert.equal(received.deadlineAt, 10000);
  } finally {
    f.close();
  }
});
