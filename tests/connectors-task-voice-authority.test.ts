import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskVoiceLedger } from "../src/attention/task-voice-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { TaskVoiceService } from "../src/control/task-voice-service.js";
import { createTaskApp } from "../src/control/task-app.js";
import type { TaskEngine } from "../src/control/task-engine.js";
import type { TaskCommand } from "../src/contracts.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const project = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-voice-authority-")),
  );
  const store = new Store();
  cleanups.push(() => {
    store.close();
    rmSync(project, { recursive: true, force: true });
  });
  store.put("pairing", {
    id: "pair",
    memberId: "member",
    deviceId: "device",
    recipient: "fixture",
    conversationId: "fixture",
    lineId: "fixture",
    displayId: "none",
    allowView: false,
    allowControl: false,
    createdAt: Date.now(),
  });
  const vault = new Vault("cd".repeat(32));
  const ledger = new TaskLedger(store, vault);
  const tasks = new TaskService(store, vault, ledger, {
    projectRoots: [project],
    simulation: false,
  });
  const session = tasks.register({
    eventId: "session",
    pairingId: "pair",
    hostId: "host",
    projectRoot: project,
    voice: true,
  });
  const taskId = tasks.create(session.token, {
    eventId: "task",
    goal: "Implement the fixture filter.",
  }).task.id;
  const get = () => ledger.get(session.session.id, taskId);
  let event = 0;
  const transition = (command: Record<string, unknown>) =>
    ledger.transition(session.session.id, taskId, {
      eventId: `event-${++event}`,
      expectedRevision: get().revision,
      ...command,
    } as TaskCommand).task;
  const terminal = (outcome = "completed", verification = "passed") => {
    const run = get().runs.at(-1)!;
    transition({
      action: "run_result",
      runId: run.id,
      dispatchId: run.dispatchId,
      outcome,
      summary: "Synthetic worker terminal receipt.",
    });
    if (outcome !== "unknown")
      transition({
        action: "verify_result",
        verification: {
          id: `verification-${event}`,
          runId: run.id,
          completedAt: Date.now(),
          state: verification,
          checks: [
            {
              name: "Fixture assertions",
              command: ["fixture-test"],
              state: verification,
              exitCode: verification === "passed" ? 0 : 1,
              summary: "Synthetic check outcome.",
            },
          ],
        },
      });
  };
  transition({ action: "claim_run", runId: get().runs.at(-1)!.id });
  terminal();
  const voiceLedger = new TaskVoiceLedger(store, vault, ledger);
  let onSettled: (id: string) => void = () => {};
  const engine = {
    onSettled: (fn: (id: string) => void) => {
      onSettled = fn;
    },
    start: vi.fn(),
    cancel: vi.fn(),
  };
  const voice = new TaskVoiceService(
    tasks,
    voiceLedger,
    engine as unknown as TaskEngine,
  );
  const opened = voice.open(session.token, taskId, {
    eventId: "opening",
    runId: get().runs.at(-1)!.id,
    expectedRevision: get().revision,
  });
  const voiceId = opened.voice.id;
  const base = `/tasks/${taskId}/voice/${voiceId}`;
  const app = createTaskApp(
    tasks,
    "operator".repeat(8),
    engine as unknown as TaskEngine,
    voice,
  );
  const api = (path: string, token = opened.token, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const bind = () =>
    api(`${base}/bind`, opened.token, {
      providerConversationId: "provider-one",
    });
  const utterance = (
    utteranceId = "speech-one",
    extra: Record<string, unknown> = {},
  ) =>
    api(`${base}/utterances`, opened.token, {
      providerConversationId: "provider-one",
      utteranceId,
      runId: get().runs.at(-1)!.id,
      expectedRevision: get().revision,
      text: "Show the empty state with a Clear filters button.",
      ...extra,
    });
  return {
    get,
    transition,
    terminal,
    opened,
    tasks,
    project,
    session,
    taskId,
    voiceId,
    base,
    api,
    bind,
    utterance,
    engine,
    settle: () => onSettled(taskId),
  };
}

describe("independent review: task voice authority", () => {
  it.each(["canceled", "unknown"])(
    "allows status/hangup speech registration after %s without granting new execution",
    async (state) => {
      const f = fixture();
      await f.bind();
      if (state === "canceled") f.transition({ action: "cancel" });
      else {
        f.transition({
          action: "prepare_call",
          callId: "simulated-unknown",
          opening: "Review the result.",
          simulated: true,
        });
        f.transition({
          action: "call_state",
          callId: "simulated-unknown",
          state: "unknown",
        });
      }
      expect(f.get().state).toBe(state);
      expect(
        (await f.utterance("hangup", { text: "End this conversation." }))
          .status,
      ).toBe(200);
      expect(
        (
          await f.api(`${f.base}/instructions`, f.opened.token, {
            eventId: "not-execution",
            utteranceId: "hangup",
          })
        ).status,
      ).toBe(409);
      expect((await f.api(`${f.base}/context`)).status).toBe(200);
      expect(
        (await f.api(`${f.base}/end`, f.opened.token, { eventId: "end" }))
          .status,
      ).toBe(200);
      expect(f.get().state).toBe(state);
      expect(f.get().runs).toHaveLength(1);
      expect(f.engine.start).not.toHaveBeenCalled();
    },
  );
  it("preserves same-run finalized speech across monotonic state changes without rebinding it to a newer run", async () => {
    const f = fixture();
    await f.bind();
    const sourceRevision = f.get().revision;
    const originalRun = f.get().runs.at(-1)!.id;
    f.transition({
      action: "prepare_call",
      callId: "simulated-call",
      opening: "The result is ready for review.",
      simulated: true,
    });
    expect(f.get().revision).toBeGreaterThan(sourceRevision);
    expect(
      (await f.utterance("before-call", { expectedRevision: sourceRevision }))
        .status,
    ).toBe(200);
    expect(
      (await f.utterance("future", { expectedRevision: f.get().revision + 1 }))
        .status,
    ).toBe(409);
    expect(
      (
        await f.utterance("before-open", {
          expectedRevision: sourceRevision - 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.api(`${f.base}/instructions`, f.opened.token, {
          eventId: "current-revision-forgery",
          utteranceId: "before-call",
          currentRevision: f.get().revision,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.api(`${f.base}/instructions`, f.opened.token, {
          eventId: "apply",
          utteranceId: "before-call",
        })
      ).status,
    ).toBe(200);
    expect(f.get().runs).toHaveLength(2);
    expect(f.engine.start).toHaveBeenCalledTimes(1);
    expect(
      (
        await f.utterance("obsolete-run", {
          runId: originalRun,
          expectedRevision: sourceRevision,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.api(`${f.base}/instructions`, f.opened.token, {
          eventId: "retry-original",
          utteranceId: "before-call",
        })
      ).status,
    ).toBe(200);
    expect(f.get().runs).toHaveLength(2);
    expect(f.engine.start).toHaveBeenCalledTimes(1);
  });
  it("keeps task and voice credentials separate and binds exact task/session", async () => {
    const f = fixture();
    expect((await f.api(`${f.base}/context`, f.session.token)).status).toBe(
      403,
    );
    expect(
      (
        await f.api(`/tasks/${f.taskId}/commands`, f.opened.token, {
          action: "cancel",
          eventId: "cancel",
          expectedRevision: f.get().revision,
        })
      ).status,
    ).toBe(401);
    expect(
      (await f.api(`/tasks/wrong/voice/${f.voiceId}/context`)).status,
    ).toBe(403);
    expect((await f.api(`/tasks/${f.taskId}/voice/wrong/context`)).status).toBe(
      403,
    );
    const context = (await (await f.api(`${f.base}/context`)).json()) as any;
    expect(context.permissions).toEqual({
      presentation: false,
      control: false,
      screen: false,
    });
    expect(f.get().state).toBe("review_ready");
    const noVoice = f.tasks.register({
      eventId: "without-voice",
      pairingId: "pair",
      hostId: "host",
      projectRoot: f.project,
      voice: false,
    });
    expect(
      (
        await f.api(`/tasks/${f.taskId}/voice-sessions`, noVoice.token, {
          eventId: "not-authorized",
          runId: f.get().runs.at(-1)!.id,
          expectedRevision: f.get().revision,
        })
      ).status,
    ).toBe(403);
  });
  it("requires exact bound provider and a finalized recorded utterance, never model-supplied text", async () => {
    const f = fixture();
    expect((await f.utterance()).status).toBe(403);
    expect((await f.bind()).status).toBe(200);
    expect(
      (
        await f.utterance("wrong-provider", {
          providerConversationId: "other-provider",
        })
      ).status,
    ).toBe(403);
    expect((await f.utterance("stale", { expectedRevision: 0 })).status).toBe(
      409,
    );
    expect(
      (
        await f.api(`${f.base}/instructions`, f.opened.token, {
          eventId: "tool",
          utteranceId: "missing",
        })
      ).status,
    ).toBe(409);
    expect((await f.utterance()).status).toBe(200);
    expect(
      (
        await f.api(`${f.base}/instructions`, f.opened.token, {
          eventId: "tool",
          utteranceId: "speech-one",
          text: "Replace user instruction.",
        })
      ).status,
    ).toBe(400);
    expect(f.get().runs).toHaveLength(1);
    expect(f.engine.start).not.toHaveBeenCalled();
  });
  it("deduplicates finalized instruction tools and keeps ending voice separate from task cancellation", async () => {
    const f = fixture();
    await f.bind();
    await f.utterance();
    const submit = (eventId: string) =>
      f.api(`${f.base}/instructions`, f.opened.token, {
        eventId,
        utteranceId: "speech-one",
      });
    expect((await submit("tool-one")).status).toBe(200);
    expect(((await (await submit("tool-two")).json()) as any).replayed).toBe(
      true,
    );
    expect(f.get().runs).toHaveLength(2);
    expect(f.get().runs.at(-1)!.instruction).toBe(
      "Show the empty state with a Clear filters button.",
    );
    expect(f.engine.start).toHaveBeenCalledTimes(1);
    expect(
      (await f.api(`${f.base}/end`, f.opened.token, { eventId: "end" })).status,
    ).toBe(200);
    expect(f.get().state).toBe("queued");
    expect(f.engine.cancel).not.toHaveBeenCalled();
    expect((await f.utterance("after-end")).status).toBe(403);
  });
  it("holds a new spoken revision through execution, then releases once after verification even if voice ended", async () => {
    const f = fixture();
    await f.bind();
    await f.utterance();
    await f.api(`${f.base}/instructions`, f.opened.token, {
      eventId: "first",
      utteranceId: "speech-one",
    });
    f.transition({ action: "claim_run", runId: f.get().runs.at(-1)!.id });
    await f.utterance("speech-two", { text: "Use a shorter label." });
    const held = (await (
      await f.api(`${f.base}/instructions`, f.opened.token, {
        eventId: "second",
        utteranceId: "speech-two",
      })
    ).json()) as any;
    expect(held.state).toBe("held");
    expect(f.get().runs).toHaveLength(2);
    expect(() => f.settle()).toThrow("terminal run");
    expect(f.get().runs).toHaveLength(2);
    await f.api(`${f.base}/end`, f.opened.token, { eventId: "end" });
    f.terminal();
    f.settle();
    f.settle();
    expect(f.get().runs).toHaveLength(3);
    expect(f.get().runs.at(-1)!.instruction).toBe("Use a shorter label.");
    expect(f.engine.start).toHaveBeenCalledTimes(2);
  });
  it("never releases held work after an unknown worker outcome", async () => {
    const f = fixture();
    await f.bind();
    await f.utterance();
    await f.api(`${f.base}/instructions`, f.opened.token, {
      eventId: "first",
      utteranceId: "speech-one",
    });
    f.transition({ action: "claim_run", runId: f.get().runs.at(-1)!.id });
    await f.utterance("speech-two", { text: "Use a shorter label." });
    await f.api(`${f.base}/instructions`, f.opened.token, {
      eventId: "second",
      utteranceId: "speech-two",
    });
    f.terminal("unknown");
    expect(() => f.settle()).toThrow("terminal run");
    expect(f.get().state).toBe("unknown");
    expect(f.get().runs).toHaveLength(2);
    expect(f.engine.start).toHaveBeenCalledTimes(1);
  });
});
