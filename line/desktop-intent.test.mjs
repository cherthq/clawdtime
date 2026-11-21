import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { llm, voice, initializeLogger } from "@livekit/agents";
import {
  makeCallerRequestBinding,
  makeCallerRealtimeModel,
} from "./desktop-intent.mjs";
import { makeCallerTools } from "./caller-tools.mjs";
import { bindCallEnd } from "./call-end.mjs";
import { RoomEvent } from "@livekit/rtc-node";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

// Reproduce the installed SDK's event ordering: raw provider event first,
// session transcript event next, then the SDK inserts its user ChatMessage.
initializeLogger({ pretty: false, level: "silent" });

function runtime(options = {}) {
  let clock = 1000,
    ended = false;
  const codes = [],
    calls = [],
    replies = [],
    sharing = [],
    zoom = [],
    shapes = [];
  const microtasks = [],
    timers = new Map();
  let timerId = 0;
  const binding = makeCallerRequestBinding({
    now: () => clock,
    diagnostic: (code) => codes.push(code),
    defer: (fn) => microtasks.push(fn),
    setTimer: (fn) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimer: (id) => timers.delete(id),
    ...options,
  });
  class Base {
    constructor(opts) {
      this.options = opts;
    }
    session() {
      return new EventEmitter();
    }
  }
  const model = makeCallerRealtimeModel(
    Base,
    { turnDetection: { type: "server_vad", create_response: true } },
    binding,
  );
  const session = new EventEmitter();
  session.chatCtx = { items: [] };
  session.generateReply = (opts) => {
    const handle = voice.SpeechHandle.create();
    handle.then = () => {
      throw Error("SpeechHandle must not be awaited");
    };
    replies.push({ opts, handle, items: [...session.chatCtx.items] });
    return handle;
  };
  binding.bindSession(session);
  const provider = model.session();
  const tools = makeCallerTools({
    tool: llm.tool,
    binding,
    ended: () => ended,
    ask: async (text) => {
      calls.push(text);
      return options.ask ? options.ask(text) : "accepted";
    },
    showScreen: (on) => {
      sharing.push(on);
      return "sharing changed";
    },
    setZoom: (action) => {
      zoom.push(action);
      return true;
    },
    zoomStatus: () => ({ overview: true }),
    reshape: (wide) => {
      shapes.push(wide);
      return "shape changed";
    },
    allowShape: true,
  });
  const raw = (event) => provider.emit("openai_server_event_received", event);
  const start = (id = "one") =>
    raw({
      type: "input_audio_buffer.speech_started",
      item_id: id,
      audio_start_ms: clock,
    });
  const stop = (id = "one") =>
    raw({
      type: "input_audio_buffer.speech_stopped",
      item_id: id,
      audio_end_ms: clock,
    });
  const item = (id = "one") => {
    const entry = { type: "message", role: "user", id };
    session.chatCtx.items.push(entry);
    session.emit("conversation_item_added", { item: entry });
  };
  const final = (text, id = "one", extra = {}) =>
    raw({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: id,
      transcript: text,
      ...extra,
    });
  const flush = () => {
    while (microtasks.length) microtasks.shift()();
  };
  const turn = (text = "Please open Messages.", id = "one") => {
    start(id);
    stop(id);
    final(text, id);
    item(id);
    flush();
    return replies.at(-1)?.handle;
  };
  const context = (handle = replies.at(-1)?.handle, extra = {}) => ({
    ctx: { session, speechHandle: handle },
    abortSignal: new AbortController().signal,
    ...extra,
  });
  const invoke = (name, args = {}, ctx = context()) =>
    tools
      .find((tool) => tool.id === name || tool.name === name)
      .execute(args, ctx);
  return {
    binding,
    model,
    session,
    provider,
    tools,
    raw,
    start,
    stop,
    item,
    final,
    flush,
    turn,
    context,
    invoke,
    calls,
    replies,
    codes,
    sharing,
    zoom,
    shapes,
    timers,
    advance: (ms) => {
      clock += ms;
    },
    end: () => {
      ended = true;
      binding.stop();
    },
    timeout: () => {
      for (const fn of [...timers.values()]) fn();
    },
  };
}

test("actual tool has no model request argument and forwards full original words without matching", async () => {
  for (const text of [
    "type Zoom in text in the Codex textbox",
    "Type ZOOM in text in the CODEX textbox!",
    "  Bring TextEdit\n forward, please.  ",
    "Do not switch apps; tell me what the task is doing.",
    'Explain what "move one desktop right" means, without doing it.',
    "Passe au bureau à gauche, s’il te plaît.",
    "Move two desktops and open Safari, but don't type anything.",
  ]) {
    const r = runtime();
    r.turn(text);
    assert.equal(await r.invoke("ask_clawdtime"), "accepted");
    assert.deepEqual(r.calls, [text]);
    await r.invoke("ask_clawdtime");
    assert.deepEqual(r.calls, [text]);
    r.end();
  }
});

test("factory disables automatic responses and binds only after SDK user item insertion", () => {
  const r = runtime();
  assert.equal(r.model.options.turnDetection.create_response, false);
  assert.equal(r.provider.listenerCount("openai_server_event_received"), 1);
  r.start();
  r.stop();
  r.final("Please open Messages.");
  assert.equal(r.replies.length, 0);
  r.session.emit("user_input_transcribed", {
    isFinal: true,
    transcript: "different model wording",
    itemId: "one",
  });
  r.flush();
  assert.equal(r.replies.length, 0);
  r.item();
  r.flush();
  assert.equal(r.replies.length, 1);
  assert.equal(r.replies[0].items.at(-1).id, "one");
  assert.equal(r.binding.take(r.context()).ok, true);
  r.end();
});

test("new successful turn is not dropped behind a superseded queued callback", async () => {
  const r = runtime();
  r.start("a");
  r.stop("a");
  r.final("old", "a");
  r.item("a");
  r.start("b");
  r.stop("b");
  r.final("new", "b");
  r.item("b");
  r.flush();
  assert.equal(r.replies.length, 1);
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, ["new"]);
  r.end();
});

test("late successful transcription needs no transcript-matching wait and is not dropped", async () => {
  const r = runtime();
  r.start();
  r.stop();
  r.advance(8000);
  r.final("Could we revisit the prior app?");
  r.item();
  r.flush();
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, ["Could we revisit the prior app?"]);
  assert.equal(r.timers.size, 0);
  r.end();
});

test("successful final before speech-stopped waits for the same provider boundary", () => {
  const r = runtime();
  r.start();
  r.final("hello");
  r.item();
  r.flush();
  assert.equal(r.replies.length, 0);
  r.stop();
  r.flush();
  assert.equal(r.replies.length, 1);
  r.end();
});

test("older completion and duplicate events cannot authorize or replay", async () => {
  const r = runtime();
  r.start("a");
  r.start("b");
  r.stop("b");
  r.final("old", "a");
  r.item("a");
  r.flush();
  assert.equal(r.replies.length, 0);
  r.final("new", "b");
  r.item("b");
  r.flush();
  await r.invoke("ask_clawdtime");
  r.start("b");
  r.final("changed", "b");
  r.item("b");
  r.flush();
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, ["new"]);
  assert.equal(r.replies.length, 1);
  r.end();
});

test("provider failure cannot be promoted by SDK synthesized final and gives unbound notice", async () => {
  const r = runtime();
  r.start();
  r.stop();
  r.raw({
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "one",
  });
  r.session.emit("user_input_transcribed", {
    isFinal: true,
    transcript: "partial imperative",
    itemId: "one",
  });
  r.item();
  r.final("late success after failure");
  r.flush();
  assert.equal(r.replies.length, 1);
  assert.equal(r.replies[0].opts.toolChoice, "none");
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, []);
  assert.ok(r.codes.includes("transcription_failed"));
  r.end();
});

test("missing final times out once, rejects late completion, and cancels on newer speech/end", async () => {
  const r = runtime();
  r.start();
  r.stop();
  r.timeout();
  r.flush();
  r.final("too late");
  r.item();
  r.flush();
  await r.invoke("ask_clawdtime");
  assert.equal(r.replies.length, 1);
  assert.deepEqual(r.calls, []);
  assert.ok(r.codes.includes("transcription_timeout"));
  r.start("two");
  r.stop("two");
  assert.equal(r.timers.size, 1);
  r.start("three");
  assert.equal(r.timers.size, 0);
  r.stop("three");
  r.end();
  assert.equal(r.timers.size, 0);
});

test("failed notice queued for an old turn cannot speak over a newer turn", () => {
  const r = runtime();
  r.start();
  r.stop();
  r.timeout();
  r.start("two");
  r.flush();
  assert.equal(r.replies.length, 0);
  r.end();
});

test("partial provider completed events and missing start identities grant no authority", () => {
  const r = runtime();
  r.final("without start");
  r.item();
  r.flush();
  r.start();
  r.stop();
  r.final("partial", "one", { status: "in_progress" });
  r.flush();
  assert.equal(r.replies.length, 0);
  r.end();
});

test("same-turn sharing and nested computer continuation have independent one-use lanes", async () => {
  const r = runtime();
  const root = r.turn("Show the screen and bring Messages forward.");
  await r.invoke("show_screen", { on: true });
  const child = voice.SpeechHandle.create({ parent: root });
  await r.invoke("ask_clawdtime", {}, r.context(child));
  await r.invoke("ask_clawdtime", {}, r.context(root));
  await r.invoke("show_screen", { on: true }, r.context(child));
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.sharing, [true]);
  r.end();
});

test("proactive, foreign, interrupted, aborted, superseded and expired tool handles fail closed", async () => {
  for (const mode of [
    "proactive",
    "foreign",
    "interrupted",
    "aborted",
    "superseded",
    "expired",
    "sdk_newer",
    "cycle",
  ]) {
    const r = runtime();
    const root = r.turn();
    let ctx = r.context(root);
    if (mode === "proactive") ctx = r.context({ parent: null });
    if (mode === "foreign") ctx.ctx.session = {};
    if (mode === "interrupted") {
      root.interrupt();
      ctx = r.context(voice.SpeechHandle.create({ parent: root }));
    }
    if (mode === "aborted") ctx.abortSignal = AbortSignal.abort();
    if (mode === "superseded") r.start("new");
    if (mode === "expired") r.advance(20001);
    if (mode === "sdk_newer") r.item("other");
    if (mode === "cycle") root.parent = root;
    await r.invoke("ask_clawdtime", {}, ctx);
    assert.deepEqual(r.calls, [], mode);
    r.end();
  }
});

test("provider reconnect/error invalidates even an already bound response", async () => {
  for (const event of ["session_reconnected", "error", "close"]) {
    const r = runtime();
    r.turn();
    r.provider.emit(event, {});
    await r.invoke("ask_clawdtime");
    assert.deepEqual(r.calls, []);
    r.end();
  }
});

test("stop and hide reduce authority without binding; ended calls permit neither", async () => {
  const r = runtime();
  r.turn();
  const ctx = r.context({ parent: null });
  await r.invoke("show_screen", { on: true }, ctx);
  assert.deepEqual(r.sharing, []);
  await r.invoke("show_screen", { on: false }, ctx);
  assert.deepEqual(r.sharing, [false]);
  await r.invoke("stop_computer", {}, ctx);
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, ["stop"]);
  r.end();
  await r.invoke("stop_computer", {}, ctx);
  await r.invoke("show_screen", { on: false }, ctx);
  assert.deepEqual(r.calls, ["stop"]);
  assert.deepEqual(r.sharing, [false]);
});

test("presentation tools use provider provenance without zoom/shape keyword matching", async () => {
  const r = runtime();
  r.turn(
    "Could you pull back so I can take everything in, and make it landscape?",
  );
  assert.match(
    await r.invoke("call_zoom", { action: "overview" }),
    /until you resume/,
  );
  await r.invoke("picture_shape", { wide: true });
  await r.invoke("call_zoom", { action: "resume" });
  assert.deepEqual(r.zoom, ["overview"]);
  assert.deepEqual(r.shapes, [true]);
  r.turn("I would like the automatic behavior switched on.", "two");
  assert.match(
    await r.invoke("call_zoom", { action: "enable" }),
    /overview stays on/,
  );
  const ctx = r.context({ parent: null });
  await r.invoke("picture_shape", { wide: false }, ctx);
  assert.deepEqual(r.shapes, [true]);
  r.end();
});

test("oversized original request is preserved for downstream rejection, never truncated", async () => {
  const r = runtime();
  const text = "a".repeat(2000) + "; do not switch desktops";
  r.turn(text);
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, [text]);
  r.end();
});

test("diagnostics contain only bounded reason codes, never words or provider IDs", () => {
  const r = runtime();
  r.turn("private test sentence", "private-provider-id");
  r.binding.take(r.context());
  r.binding.take(r.context());
  r.end();
  assert.ok(r.codes.length > 2);
  for (const code of r.codes) assert.match(code, /^[a-z_]{1,40}$/);
  assert.equal(JSON.stringify(r.codes).includes("private"), false);
});

test("late failed provider event never claims nothing happened after tool dispatch", async () => {
  const r = runtime();
  r.turn();
  await r.invoke("ask_clawdtime");
  r.raw({
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "one",
  });
  r.flush();
  assert.equal(r.replies.length, 1);
  assert.equal(r.calls.length, 1);
  assert.ok(r.codes.includes("transcription_failed"));
  r.end();
});

test("computer tool schema rejects model-authored request text", () => {
  const r = runtime();
  const tool = r.tools.find((t) => t.name === "ask_clawdtime");
  assert.equal(tool.parameters.safeParse({}).success, true);
  assert.equal(
    tool.parameters.safeParse({ request: "model paraphrase" }).success,
    false,
  );
  r.end();
});

test("unknown delivery failure never retries through root or nested response", async () => {
  const r = runtime({
    ask: async () => {
      throw Error("unknown delivery");
    },
  });
  const root = r.turn();
  await assert.rejects(r.invoke("ask_clawdtime"), /unknown delivery/);
  await r.invoke("ask_clawdtime", {}, r.context(root));
  await r.invoke(
    "ask_clawdtime",
    {},
    r.context(voice.SpeechHandle.create({ parent: root })),
  );
  assert.equal(r.calls.length, 1);
  r.end();
});

test("call end removes listeners and cancels a queued successful response", () => {
  const r = runtime();
  r.start();
  r.stop();
  r.final("pending");
  r.item();
  r.end();
  r.flush();
  assert.equal(r.replies.length, 0);
  assert.equal(r.provider.listenerCount("openai_server_event_received"), 0);
  assert.equal(r.provider.listenerCount("session_reconnected"), 0);
  assert.equal(r.session.listenerCount("conversation_item_added"), 0);
  assert.equal(r.timers.size, 0);
});

test("actual room/session close events synchronously retire queued speech and tools", async () => {
  for (const event of ["caller", "room", "session"]) {
    const r = runtime();
    const room = new EventEmitter();
    let cleanups = 0;
    const guard = bindCallEnd({
      room,
      callerIdentity: "fixture-caller",
      roomEvents: RoomEvent,
      sessionCloseEvent: voice.AgentSessionEventTypes.Close,
      binding: r.binding,
      cleanup: async () => {
        cleanups++;
        r.end();
      },
    });
    guard.attachSession(r.session);
    r.start();
    r.stop();
    r.final("queued computer request");
    r.item();
    room.emit(RoomEvent.ParticipantDisconnected, { identity: "unrelated" });
    assert.equal(cleanups, 0);
    if (event === "caller")
      room.emit(RoomEvent.ParticipantDisconnected, {
        identity: "fixture-caller",
      });
    if (event === "room") room.emit(RoomEvent.Disconnected);
    if (event === "session")
      r.session.emit(voice.AgentSessionEventTypes.Close, {});
    r.flush();
    await r.invoke("ask_clawdtime");
    assert.equal(cleanups, 1);
    assert.equal(r.replies.length, 0);
    assert.deepEqual(r.calls, []);
    assert.equal(room.listenerCount(RoomEvent.ParticipantDisconnected), 0);
    assert.equal(room.listenerCount(RoomEvent.Disconnected), 0);
    assert.equal(
      r.session.listenerCount(voice.AgentSessionEventTypes.Close),
      0,
    );
  }
});
