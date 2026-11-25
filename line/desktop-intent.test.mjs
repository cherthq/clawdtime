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
    zooms = [],
    shapes = [],
    requests = [];
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
    ask: async (text, context) => {
      calls.push(text);
      requests.push({ text, context });
      return options.ask ? options.ask(text, context) : "accepted";
    },
    stop: async () => {
      calls.push("stop");
      return "Stopped owned work.";
    },
    showScreen: (on) => {
      sharing.push(on);
      return { applied: true, message: "sharing changed" };
    },
    setZoom: (action) => {
      zoom.push(action);
      return true;
    },
    zoomStatus: () => ({ overview: true }),
    zoomTo: async (request) => {
      zooms.push(request);
      return options.zoomTo
        ? options.zoomTo(request)
        : { applied: true, message: "zoomed" };
    },
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
    requests,
    replies,
    codes,
    sharing,
    zoom,
    zooms,
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
  assert.equal(r.replies[0].opts.toolChoice, "required");
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
  // The first item was never answered, so it is a part of the request.
  assert.deepEqual(r.calls, ["old new"]);
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
  // The older final cannot start a reply, but its words belong to the request.
  assert.deepEqual(r.calls, ["old new"]);
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

test("call_zoom zoom carries a bounded target, level, times and move, and forwards the caller's words", async () => {
  const r = runtime();
  r.turn("Zoom on the address bar, a bit closer, and move right.");
  const answer = JSON.parse(
    await r.invoke("call_zoom", {
      action: "zoom",
      target: "  the address bar ",
      level: "in",
      times: null,
      move: "right",
      bit: true,
    }),
  );
  assert.deepEqual(r.zooms, [
    { target: "the address bar", level: "in", move: "right", bit: true },
  ]);
  assert.deepEqual(answer, { presentation: "zoomed", supervisor: "accepted" });
  assert.deepEqual(r.requests[0], {
    text: "Zoom on the address bar, a bit closer, and move right.",
    context: {
      requestId: r.requests[0].context.requestId,
      presentation: { kind: "zoom", action: "zoom", applied: true },
    },
  });
  // One zoom for one caller turn.
  assert.match(
    await r.invoke("call_zoom", { action: "zoom", level: "in" }),
    /could not use that caller turn/,
  );
  assert.equal(r.zooms.length, 1);
  assert.ok(r.codes.includes("request_already_used"));
  r.turn("Zoom on the\ttop\nright.", "three");
  await r.invoke("call_zoom", { action: "zoom", target: "the\ttop\nright" });
  assert.deepEqual(r.zooms.at(-1), { target: "the top right" });
  r.turn("2x please.", "two");
  await r.invoke("call_zoom", { action: "zoom", times: 2 });
  assert.deepEqual(r.zooms.at(-1), { times: 2 });
  r.end();
});

test("call_zoom refuses mixed or empty zoom arguments before it claims the turn", async () => {
  const r = runtime();
  r.turn("Follow what you do.");
  assert.match(
    await r.invoke("call_zoom", { action: "resume", target: "Stonepad" }),
    /only with action zoom/,
  );
  assert.match(
    await r.invoke("call_zoom", { action: "zoom", target: "  ", bit: true }),
    /needs a target/,
  );
  assert.deepEqual(r.zooms, []);
  // The corrected call still has the turn.
  await r.invoke("call_zoom", { action: "resume" });
  assert.deepEqual(r.zoom, ["resume"]);
  const schema = r.tools.find((tool) => tool.name === "call_zoom").parameters;
  for (const bad of [
    { action: "zoom", target: "x".repeat(121) },
    { action: "zoom", level: "closer" },
    { action: "zoom", move: "around" },
    { action: "zoom", times: 0 },
    { action: "zoom", target: "Stonepad", label: "private" },
  ])
    assert.equal(schema.safeParse(bad).success, false, JSON.stringify(bad));
  r.end();
});

test("a zoom that found nothing says so and tells the supervisor that nothing was applied", async () => {
  const r = runtime({
    zoomTo: async () => ({ applied: false, message: "Nothing matches." }),
  });
  r.turn("Zoom on the chart.");
  const answer = JSON.parse(
    await r.invoke("call_zoom", { action: "zoom", target: "the chart" }),
  );
  assert.equal(answer.presentation, "Nothing matches.");
  assert.deepEqual(r.requests[0].context.presentation, {
    kind: "zoom",
    action: "zoom",
    applied: false,
  });
  r.end();
  assert.equal(
    await r.invoke("call_zoom", { action: "zoom", target: "the chart" }),
    "The call has ended.",
  );
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
  assert.match(await r.invoke("ask_clawdtime"), /outcome is unknown/);
  await r.invoke("ask_clawdtime", {}, r.context(root));
  await r.invoke(
    "ask_clawdtime",
    {},
    r.context(voice.SpeechHandle.create({ parent: root })),
  );
  assert.equal(r.calls.length, 1);
  r.end();
});

test("a plain spoken acknowledgement without any dispatch is an explicit failure, never completion", async () => {
  const r = runtime();
  const handle = r.turn("Start a new Claude session.");
  assert.equal(r.replies[0].opts.toolChoice, "required");
  await said(handle); // Simulate a provider ignoring the tool requirement.
  r.flush();
  assert.deepEqual(r.calls, []);
  assert.equal(r.codes.includes("answer_finished"), false);
  assert.ok(r.codes.includes("dispatch_missing"));
  assert.equal(r.replies[1].opts.toolChoice, "none");
  assert.match(
    r.replies[1].opts.instructions,
    /did not reach the Mac supervisor/,
  );
  await r.invoke("ask_clawdtime", {}, r.context(handle));
  assert.deepEqual(r.calls, []);
  await said(r.replies[1].handle);
  assert.ok(r.codes.includes("answer_finished"));
  r.end();
});

test("showing the screen cannot consume a compound app request without supervisor dispatch", async () => {
  const r = runtime();
  const text =
    "Show the screen, open Messages and check the visible messages. Do not send anything.";
  const handle = r.turn(text);
  const result = JSON.parse(await r.invoke("show_screen", { on: true }));
  assert.deepEqual(r.calls, [text]);
  assert.deepEqual(r.sharing, [true]);
  assert.equal(result.supervisor, "accepted");
  assert.deepEqual(r.requests[0].context.presentation, {
    kind: "sharing",
    action: "show",
    applied: true,
  });
  assert.match(r.requests[0].context.requestId, /^[a-f0-9-]{36}$/);
  await r.invoke("ask_clawdtime", {}, r.context(followUp(r, handle)));
  assert.deepEqual(r.calls, [text]);
  r.end();
});

test("parallel root and child tools share pending delivery without an extra request", async () => {
  const pending = Promise.withResolvers();
  const r = runtime({ ask: () => pending.promise });
  const root = r.turn("Start a new Claude session.");
  const first = r.invoke("ask_clawdtime");
  const second = r.invoke("ask_clawdtime", {}, r.context(followUp(r, root)));
  assert.equal(r.calls.length, 1);
  pending.resolve("Launch requested; session launch has not been observed.");
  assert.equal(
    await first,
    "Launch requested; session launch has not been observed.",
  );
  assert.equal(await second, await first);
  r.end();
});

test("hide and Stop remain immediate while another supervisor request is pending", async () => {
  const pending = Promise.withResolvers();
  const r = runtime({
    ask: (text) => (text === "stop" ? "Stopped owned work." : pending.promise),
  });
  const root = r.turn("Read the screen.");
  const reading = r.invoke("ask_clawdtime");
  const hiding = r.invoke("show_screen", { on: false }, r.context(root));
  assert.deepEqual(r.sharing, [false]);
  assert.equal(await r.invoke("stop_computer"), "Stopped owned work.");
  assert.deepEqual(r.calls, ["Read the screen.", "stop"]);
  pending.resolve("The read was canceled.");
  await reading;
  await hiding;
  await r.invoke("ask_clawdtime", {}, r.context(root));
  assert.deepEqual(r.calls, ["Read the screen.", "stop"]);
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

// One request in several provider items. The provider ends an item at each
// pause, so the words of one request can arrive as two or more finals.
const tick = () => new Promise((resolve) => setImmediate(resolve));
// The voice library marks a reply done when it was said in full or cut.
const said = async (handle) => {
  handle._markDone();
  await tick();
};
const cut = async (handle) => {
  handle.interrupt();
  handle._markDone();
  await tick();
};
// The reply that says the answer of a tool, as the voice library creates it.
const followUp = (r, parent) => {
  const handle = voice.SpeechHandle.create({ parent });
  r.session.emit(voice.AgentSessionEventTypes.SpeechCreated, {
    type: "speech_created",
    userInitiated: false,
    source: "tool_response",
    speechHandle: handle,
  });
  return handle;
};
// One item whose final comes after the caller has gone on to speak.
const spoken = (r, id, text) => {
  r.start(id);
  r.stop(id);
  return () => {
    r.final(text, id);
    r.item(id);
  };
};

test("a request with a pause is forwarded whole, in the order spoken, once", async () => {
  for (const [first, second, whole] of [
    [
      "Please don't",
      "switch to the desktop on the right.",
      "Please don't switch to the desktop on the right.",
    ],
    [
      "Open the browser and",
      "type hello in the search box",
      "Open the browser and type hello in the search box",
    ],
  ]) {
    const r = runtime();
    const firstFinal = spoken(r, "a", first);
    // The caller goes on before the first final is there.
    r.start("b");
    firstFinal();
    r.flush();
    assert.equal(r.replies.length, 0);
    r.stop("b");
    r.final(second, "b");
    r.item("b");
    r.flush();
    assert.equal(r.replies.length, 1);
    assert.equal(await r.invoke("ask_clawdtime"), "accepted");
    assert.deepEqual(r.calls, [whole]);
    await r.invoke("ask_clawdtime");
    assert.deepEqual(r.calls, [whole]);
    r.end();
  }
});

test("a reply to the first part that new speech cut leaves that part in the request", async () => {
  const r = runtime();
  const early = r.turn("Please don't", "a");
  r.start("b");
  await cut(early);
  // The reply to the first part alone can no longer act.
  await r.invoke("ask_clawdtime", {}, r.context(early));
  assert.deepEqual(r.calls, []);
  r.stop("b");
  r.final("switch to the desktop on the right.", "b");
  r.item("b");
  r.flush();
  assert.equal(r.replies.length, 2);
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, [
    "Please don't switch to the desktop on the right.",
  ]);
  r.end();
});

test("three items make one request, with one space at each joint and the outer ends kept", async () => {
  const r = runtime();
  spoken(r, "a", "  Go to the session \n")();
  spoken(r, "b", "\tthat runs the tests ")();
  spoken(r, "c", " and show me its last lines.  ")();
  r.flush();
  assert.equal(r.replies.length, 1);
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, [
    "  Go to the session that runs the tests and show me its last lines.  ",
  ]);
  r.end();
});

test("finals that arrive out of order are still forwarded in the order spoken", async () => {
  const r = runtime();
  const firstFinal = spoken(r, "a", "Do not");
  spoken(r, "b", "close the window.")();
  r.flush();
  // The newest item is final, but a part of the request is still missing.
  assert.equal(r.replies.length, 0);
  firstFinal();
  r.flush();
  assert.equal(r.replies.length, 1);
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, ["Do not close the window."]);
  r.end();
});

test("one failed transcript in the middle refuses the whole request and asks for it again", async () => {
  const r = runtime();
  spoken(r, "a", "Please don't")();
  r.start("b");
  r.stop("b");
  r.raw({
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "b",
  });
  r.start("c");
  r.flush();
  // Nothing is said while the caller still speaks.
  assert.equal(r.replies.length, 0);
  r.stop("c");
  r.final("switch to the desktop on the right.", "c");
  r.item("c");
  r.flush();
  assert.equal(r.replies.length, 1);
  assert.equal(r.replies[0].opts.toolChoice, "none");
  assert.match(r.replies[0].opts.instructions, /whole request again/);
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, []);
  assert.ok(r.codes.includes("transcription_notice"));
  assert.equal(r.codes.includes("response_bound"), false);
  // The notice was said in full: what the caller says now is a new request.
  await said(r.replies[0].handle);
  r.turn("Please don't switch to the desktop on the right.", "d");
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, [
    "Please don't switch to the desktop on the right.",
  ]);
  r.end();
});

test("one missing transcript refuses the whole request after the wait", async () => {
  const r = runtime();
  spoken(r, "a", "Open the browser and")();
  r.start("b");
  r.stop("b");
  spoken(r, "c", "type hello in the search box")();
  r.flush();
  assert.equal(r.replies.length, 0);
  assert.equal(r.timers.size, 1);
  r.timeout();
  r.flush();
  assert.equal(r.timers.size, 0);
  assert.equal(r.replies.length, 1);
  assert.equal(r.replies[0].opts.toolChoice, "none");
  // A final that comes after the wait cannot repair the request.
  r.final("too late", "b");
  r.item("b");
  r.flush();
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, []);
  assert.equal(r.replies.length, 1);
  r.end();
});

test("a notice that the caller cut does not free the refused request", async () => {
  const r = runtime();
  r.start("a");
  r.stop("a");
  r.raw({
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "a",
  });
  r.flush();
  assert.equal(r.replies.length, 1);
  r.start("b");
  await cut(r.replies[0].handle);
  r.stop("b");
  r.final("switch to the desktop on the right.", "b");
  r.item("b");
  r.flush();
  // The first part is still lost, so this is the notice again and no forward.
  assert.equal(r.replies.length, 2);
  assert.equal(r.replies[1].opts.toolChoice, "none");
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, []);
  r.end();
});

test("an answer that was said in full ends the request: the next forward holds only the next request", async () => {
  const r = runtime();
  const first = r.turn("Hello, are you there?", "a");
  await r.invoke("ask_clawdtime");
  await said(first);
  assert.ok(r.codes.includes("answer_finished"));
  r.turn("Give me the status.", "b");
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, ["Hello, are you there?", "Give me the status."]);
  r.end();
});

test("an answer counts only when the reply after its tools was also said in full", async () => {
  for (const full of [true, false]) {
    const r = runtime();
    const root = r.turn("Hide the screen.", "a");
    await r.invoke("show_screen", { on: false });
    const answer = followUp(r, root);
    await said(root);
    assert.equal(r.codes.includes("answer_finished"), false);
    if (full) await said(answer);
    else {
      r.start("b");
      await cut(answer);
    }
    assert.equal(r.codes.includes("answer_finished"), full);
    r.turn("Give me the status.", "b");
    await r.invoke("ask_clawdtime");
    assert.deepEqual(r.calls, ["Hide the screen.", "Give me the status."]);
    r.end();
  }
});

test("a forwarded request is not forwarded again: new speech after it goes out alone", async () => {
  const r = runtime();
  r.turn("Go to the session about the payment tests.", "a");
  await r.invoke("ask_clawdtime");
  // The caller speaks again while the answer is still on its way.
  r.turn("And make its text bigger.", "b");
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, [
    "Go to the session about the payment tests.",
    "And make its text bigger.",
  ]);
  r.end();
});

test("a presentation tool forwards the complete request and shares that outcome with a continuation", async () => {
  const r = runtime();
  spoken(r, "a", "Show the whole screen and don't")();
  spoken(r, "b", "touch the terminal.")();
  r.flush();
  const first = r.replies.at(-1).handle;
  await r.invoke("call_zoom", { action: "overview" });
  const continuation = followUp(r, first);
  await r.invoke("ask_clawdtime", {}, r.context(continuation));
  assert.deepEqual(r.calls, [
    "Show the whole screen and don't touch the terminal.",
  ]);
  assert.deepEqual(r.zoom, ["overview"]);
  assert.deepEqual(r.requests[0].context.presentation, {
    kind: "zoom",
    action: "overview",
    applied: true,
  });
  r.end();
});

test("a greeting or a job notice cannot forward a request of several items", async () => {
  const r = runtime();
  spoken(r, "a", "Please don't")();
  spoken(r, "b", "switch to the desktop on the right.")();
  r.flush();
  const proactive = voice.SpeechHandle.create();
  r.session.emit(voice.AgentSessionEventTypes.SpeechCreated, {
    type: "speech_created",
    userInitiated: true,
    source: "generate_reply",
    speechHandle: proactive,
  });
  await r.invoke("ask_clawdtime", {}, r.context(proactive));
  assert.deepEqual(r.calls, []);
  // Its end is no answer to the caller: the request stays whole.
  await said(proactive);
  assert.equal(r.codes.includes("answer_finished"), false);
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, [
    "Please don't switch to the desktop on the right.",
  ]);
  r.end();
});

test("a request over the bounds is refused whole, never cut", async () => {
  // Too many items.
  const many = runtime({ maxItems: 3 });
  for (const id of ["a", "b", "c", "d"]) spoken(many, id, `part ${id}`)();
  many.flush();
  assert.equal(many.replies.length, 1);
  assert.equal(many.replies[0].opts.toolChoice, "none");
  assert.ok(many.codes.includes("request_too_long"));
  await many.invoke("ask_clawdtime");
  assert.deepEqual(many.calls, []);
  many.end();
  // Too many characters in all.
  const long = runtime({ maxChars: 30 });
  spoken(long, "a", "a".repeat(20))();
  spoken(long, "b", "b".repeat(20))();
  long.flush();
  assert.equal(long.replies.length, 1);
  assert.equal(long.replies[0].opts.toolChoice, "none");
  assert.ok(long.codes.includes("request_too_long"));
  await long.invoke("ask_clawdtime");
  assert.deepEqual(long.calls, []);
  long.end();
  // Longer than the transport takes, inside the bounds: it goes on complete,
  // and the transport refuses it.
  const r = runtime();
  spoken(r, "a", "a".repeat(1500))();
  spoken(r, "b", `${"b".repeat(1500)}; do not switch desktops`)();
  r.flush();
  await r.invoke("ask_clawdtime");
  assert.deepEqual(r.calls, [
    `${"a".repeat(1500)} ${"b".repeat(1500)}; do not switch desktops`,
  ]);
  r.end();
});

test("the codes of a request of several items hold no words, and the call end removes the speech listener", async () => {
  const r = runtime();
  assert.equal(
    r.session.listenerCount(voice.AgentSessionEventTypes.SpeechCreated),
    1,
  );
  spoken(r, "private-id-one", "private words one")();
  r.start("private-id-two");
  r.stop("private-id-two");
  r.raw({
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "private-id-two",
  });
  r.flush();
  await said(r.replies[0].handle);
  const answer = r.turn("private words three", "private-id-three");
  await r.invoke("ask_clawdtime");
  await said(answer);
  r.end();
  for (const code of r.codes) assert.match(code, /^[a-z_]{1,40}$/);
  assert.equal(JSON.stringify(r.codes).includes("private"), false);
  assert.equal(
    r.session.listenerCount(voice.AgentSessionEventTypes.SpeechCreated),
    0,
  );
});
