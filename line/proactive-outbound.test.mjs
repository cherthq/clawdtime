const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
import assert from "node:assert/strict";
import {
  createProactiveCallClient,
  makeProactiveVideo,
  createProactiveOutboundMedia,
} from "./proactive-outbound.mjs";
const now = 1_800_000_000_000;
function fixture(channel = "phone_alert") {
  const config = {
    version: 1,
    origin: "http://127.0.0.1:13416",
    token: "synthetic-token-for-fixtures-only",
    attemptId: "attempt-one",
    roomName: "room-one",
    agentIdentity: "agent-one",
    providerCallerIdentity: "caller-one",
    sourceFingerprint: "a".repeat(64),
    packetFingerprint: "b".repeat(64),
    expiresAt: now + 60_000,
  };
  const binding = Object.fromEntries(
    [
      "attemptId",
      "roomName",
      "agentIdentity",
      "sourceFingerprint",
      "packetFingerprint",
    ].map((k) => [k, config[k]]),
  );
  const state = {
    ...binding,
    authorized: true,
    channel,
    providerCallerIdentity: config.providerCallerIdentity,
    narration: "Independent checks passed for the synthetic fixture.",
    question: "Which fixture choice?",
    message: "The exact pending request received the answer.",
    expiresAt: config.expiresAt,
    sharingAllowed: channel === "phone_walkthrough",
  };
  const requests = [];
  let failure = false,
    clock = now;
  const request = async (url, init) => {
    requests.push({ url, init });
    if (failure) throw Error("lost response");
    return new Response(JSON.stringify(state));
  };
  const client = createProactiveCallClient(config, {
    request,
    clock: () => clock,
  });
  return {
    config,
    state,
    requests,
    client,
    setFailure: () => {
      failure = true;
    },
    advance: (n) => {
      clock += n;
    },
    request,
  };
}
test("exact caller and packet forward original answer once", async () => {
  const f = fixture();
  await f.client.prepared("room-one", "agent-one");
  assert.equal(await f.client.bindCaller("caller-one"), true);
  const a = await f.client.answer("Original complete fixture answer", {
    requestId: "turn-one",
  });
  assert.equal(a, f.state.message);
  assert.equal(
    await f.client.answer("Original complete fixture answer", {
      requestId: "turn-one",
    }),
    a,
  );
  const effects = f.requests
    .map((r) => JSON.parse(r.init.body))
    .filter((r) => r.action === "answer");
  assert.equal(effects.length, 1);
  assert.equal(effects[0].text, "Original complete fixture answer");
  assert.equal(effects[0].callerIdentity, "caller-one");
  assert.equal(
    effects[0].binding.packetFingerprint,
    f.config.packetFingerprint,
  );
});
test("wrong participant cannot hear task greeting or submit answer", async () => {
  const f = fixture();
  assert.equal(await f.client.bindCaller("other-caller"), false);
  assert.throws(() => f.client.greeting());
  await f.client.answer("yes", { requestId: "turn" });
  assert.equal(f.requests.length, 0);
});
for (const [key, value] of [
  ["attemptId", "wrong"],
  ["packetFingerprint", "c".repeat(64)],
  ["sourceFingerprint", "c".repeat(64)],
  ["roomName", "other-room"],
  ["agentIdentity", "other-agent"],
  ["providerCallerIdentity", "other-caller"],
  ["authorized", false],
  ["ended", true],
])
  test(`changed ${key} retires call`, async () => {
    const f = fixture();
    f.state[key] = value;
    await assert.rejects(f.client.status());
    assert.equal(f.client.active(), false);
  });
test("revoked policy, resolved source or expired grant closes views", async () => {
  const f = fixture("phone_walkthrough");
  await f.client.bindCaller("caller-one");
  f.state.authorized = false;
  await assert.rejects(f.client.status());
  assert.equal(await f.client.windowFrame(), null);
});
test("shorter server expiry remains binding after response", async () => {
  const f = fixture();
  f.state.expiresAt = now + 10;
  await f.client.status();
  f.advance(11);
  assert.equal(f.client.active(), false);
});
test("lost answer response retained unknown without resend", async () => {
  const f = fixture();
  await f.client.bindCaller("caller-one");
  f.setFailure();
  const first = await f.client.answer("fixture answer", {
    requestId: "turn-one",
  });
  assert.match(first, /unknown/);
  assert.equal(
    await f.client.answer("fixture answer", { requestId: "turn-one" }),
    first,
  );
  assert.match(
    await f.client.answer("second answer", { requestId: "turn-two" }),
    /unknown/,
  );
  assert.equal(
    f.requests.filter((r) => JSON.parse(r.init.body).action === "answer")
      .length,
    1,
  );
});
test("alert never constructs capture or requests a frame", async () => {
  const f = fixture();
  await f.client.bindCaller("caller-one");
  let captures = 0;
  const video = makeProactiveVideo({
    client: f.client,
    width: 100,
    height: 100,
    startWindow: () => {
      captures++;
      throw Error();
    },
  });
  assert.equal(await video.show(), false);
  assert.equal(await f.client.windowFrame(), null);
  assert.equal(captures, 0);
  assert.equal(
    f.requests.some((r) => r.init.method === "GET"),
    false,
  );
});
test("Stop sharing is sticky without canceling work", async () => {
  const f = fixture("phone_walkthrough");
  await f.client.bindCaller("caller-one");
  await f.client.stopSharing();
  assert.equal(await f.client.windowFrame(), null);
  assert.equal(
    f.requests.some((r) => JSON.parse(r.init.body).action === "stop_work"),
    false,
  );
});
test("a walkthrough with computer control forwards computer words as their own action", async () => {
  const f = fixture("phone_walkthrough");
  f.state.computerAllowed = true;
  await f.client.bindCaller("caller-one");
  assert.equal(
    await f.client.computer("Click Save on the fixture page", {
      requestId: "turn-one",
    }),
    f.state.message,
  );
  // The same speech turn cannot also become an answer.
  assert.match(
    await f.client.answer("Click Save on the fixture page", {
      requestId: "turn-one",
    }),
    /conflicts/,
  );
  const sent = f.requests
    .map((r) => JSON.parse(r.init.body))
    .filter((r) => r.action === "computer" || r.action === "answer");
  assert.deepEqual(
    sent.map((r) => [r.action, r.text, r.turnId, r.callerIdentity]),
    [["computer", "Click Save on the fixture page", "turn-one", "caller-one"]],
  );
});
test("a walkthrough without computer control sends no computer words", async () => {
  const f = fixture("phone_walkthrough");
  await f.client.bindCaller("caller-one");
  assert.equal(
    await f.client.computer("Click Save", { requestId: "turn-one" }),
    "Computer control is not enabled for this walkthrough. No action was sent.",
  );
  assert.equal(
    f.requests.some((r) => JSON.parse(r.init.body).action === "computer"),
    false,
  );
});
test("stopComputer stops the call's computer work and leaves sharing on", async () => {
  const f = fixture("phone_walkthrough");
  f.state.computerAllowed = true;
  await f.client.bindCaller("caller-one");
  f.state.message = "Stop requested for this call's computer work.";
  assert.equal(
    await f.client.stopComputer(),
    "Stop requested for this call's computer work.",
  );
  const actions = f.requests.map((r) => JSON.parse(r.init.body).action);
  assert.equal(actions.includes("stop_computer"), true);
  assert.equal(actions.includes("stop_sharing"), false);
});
test("stopComputer of a call that had computer control never hides sharing, also after control ended", async () => {
  const f = fixture("phone_walkthrough");
  f.state.computerAllowed = true;
  await f.client.bindCaller("caller-one");
  // The server ends computer control, for example at an unknown outcome.
  f.state.computerAllowed = false;
  await f.client.status();
  await f.client.stopComputer();
  const actions = f.requests.map((r) => JSON.parse(r.init.body).action);
  assert.equal(actions.includes("stop_computer"), true);
  assert.equal(actions.includes("stop_sharing"), false);
});
test("stopComputer of a walkthrough without computer control stops sharing, as its words say", async () => {
  const f = fixture("phone_walkthrough");
  await f.client.bindCaller("caller-one");
  assert.match(await f.client.stopComputer(), /Sharing is stopped/);
  const actions = f.requests.map((r) => JSON.parse(r.init.body).action);
  assert.equal(actions.includes("stop_sharing"), true);
  assert.equal(actions.includes("stop_computer"), false);
  assert.equal(await f.client.windowFrame(), null);
});
test("hangup closes once and rejects later answers", async () => {
  const f = fixture();
  await f.client.bindCaller("caller-one");
  await f.client.close();
  await f.client.close();
  await f.client.answer("later", { requestId: "later" });
  assert.equal(
    f.requests.filter((r) => JSON.parse(r.init.body).action === "close").length,
    1,
  );
  assert.equal(f.client.active(), false);
});
test("fresh frame requires exact packet/view and bounded pixel length", async () => {
  const f = fixture("phone_walkthrough");
  let sent = 0;
  const frame = {
    attemptId: f.config.attemptId,
    sourceFingerprint: f.config.sourceFingerprint,
    packetFingerprint: f.config.packetFingerprint,
    viewId: "view-one",
    frameId: "frame-one",
    width: 2,
    height: 2,
    capturedAt: now,
    expiresAt: now + 500,
    layout: {
      visible: true,
      frameId: "frame-one",
      crop: { x: 0, y: 0, width: 2, height: 2 },
      contentRect: { x: 0, y: 0, width: 2, height: 2 },
    },
  };
  const client = createProactiveCallClient(f.config, {
    clock: () => now,
    request: async (url, init) => {
      if (init.method === "POST") return f.request(url, init);
      sent++;
      assert.equal(
        init.headers["X-ClawdTime-Packet"],
        f.config.packetFingerprint,
      );
      return new Response(Buffer.alloc(16), {
        headers: { "x-clawdtime-frame": JSON.stringify(frame) },
      });
    },
  });
  await client.bindCaller("caller-one");
  assert.equal((await client.windowFrame()).rgba.length, 16);
  frame.packetFingerprint = "c".repeat(64);
  await assert.rejects(client.windowFrame(), /frame_invalid/);
  assert.equal(sent, 2);
});

function mediaFixture() {
  const config = {
    url: "wss://livekit.example.test",
    apiKey: "fixture-key",
    apiSecret: "synthetic-secret-for-fixture-only",
    agentName: "fixture-agent",
    attemptId: "attempt-one",
    roomName: "room-one",
    agentIdentity: "agent-one",
    providerCallerIdentity: "caller-one",
    expiresAt: now + 60_000,
  };
  const effects = [],
    calls = [];
  let rooms = [],
    participants = [
      {
        identity: "agent-one",
        tracks: [
          { type: 0, sid: "audio-one", muted: false },
          { type: 1, sid: "video-one", muted: false },
        ],
      },
    ];
  const ports = {
    clock: () => now,
    sleep: async () => {},
    authorize: async () => {},
    reserveEffect: async (s) => effects.push([s, "reserved"]),
    recordEffect: async (s, o) => effects.push([s, o]),
    roomService: {
      createRoom: async (input) => {
        calls.push(["create", input]);
        rooms = [{ name: input.name }];
      },
      listParticipants: async () => participants,
      deleteRoom: async (name) => {
        calls.push(["delete", name]);
        rooms = [];
      },
      listRooms: async () => rooms,
    },
  };
  return {
    config,
    ports,
    effects,
    calls,
    setParticipants: (v) => {
      participants = v;
    },
  };
}
test("supported SDK prepares one exact publisher, token and room without dialing", async () => {
  const f = mediaFixture(),
    media = await createProactiveOutboundMedia(f.config, f.ports);
  const result = await media.prepare();
  assert.equal(result.credentials.remote_participant_identity, "agent-one");
  assert.equal(typeof result.credentials.participant_token, "string");
  await media.prepare();
  assert.equal(f.calls.filter((c) => c[0] === "create").length, 1);
  assert.equal(f.calls[0][1].maxParticipants, 2);
  assert.equal(f.calls[0][1].agents[0].agentName, "fixture-agent");
  assert.deepEqual(f.effects.slice(0, 2), [
    ["room_create", "reserved"],
    ["room_create", "confirmed"],
  ]);
  assert.equal((await media.close()).closed, true);
  assert.equal((await media.close()).closed, true);
  assert.equal(f.calls.filter((c) => c[0] === "delete").length, 1);
});
test("cold dedicated worker can publish after twenty seconds with only one room creation", async () => {
  const f = mediaFixture();
  let clock = now;
  const readyParticipants = f.ports.roomService.listParticipants;
  f.config.expiresAt = now + 90_000;
  f.ports.clock = () => clock;
  f.ports.sleep = async (ms) => {
    clock += ms;
  };
  f.ports.roomService.listParticipants = async () =>
    clock >= now + 25_000 ? readyParticipants() : [];
  const media = await createProactiveOutboundMedia(f.config, f.ports);
  const result = await media.prepare();
  assert.equal(clock, now + 25_000);
  assert.equal(result.publications.audio, "audio-one");
  await media.prepare();
  assert.equal(f.calls.filter((c) => c[0] === "create").length, 1);
  assert.equal((await media.close()).closed, true);
});

test("preparation stops at sixty seconds or the earlier grant expiry without recreating", async () => {
  for (const lifetime of [12_000, 90_000]) {
    const f = mediaFixture();
    let clock = now;
    f.config.expiresAt = now + lifetime;
    f.ports.clock = () => clock;
    f.ports.sleep = async (ms) => {
      clock += ms;
    };
    f.setParticipants([]);
    const media = await createProactiveOutboundMedia(f.config, f.ports);
    await assert.rejects(media.prepare(), /publications_not_ready/);
    assert.equal(clock, now + Math.min(lifetime, 60_000));
    await assert.rejects(media.prepare(), /publications_not_ready/);
    assert.equal(f.calls.filter((c) => c[0] === "create").length, 1);
    assert.equal((await media.close()).closed, true);
  }
});

test("revocation aborts cold-worker polling on the next bounded poll without recreating", async () => {
  const f = mediaFixture();
  let clock = now,
    revoked = false,
    polls = 0;
  f.config.expiresAt = now + 90_000;
  f.ports.clock = () => clock;
  f.ports.sleep = async (ms) => {
    clock += ms;
    if (clock >= now + 25_000) revoked = true;
  };
  f.ports.authorize = async () => {
    if (revoked) throw Error("grant_revoked");
  };
  f.ports.roomService.listParticipants = async () => {
    assert.equal(revoked, false);
    polls++;
    return [];
  };
  const media = await createProactiveOutboundMedia(f.config, f.ports);
  await assert.rejects(media.prepare(), /grant_revoked/);
  assert.equal(clock, now + 25_000);
  assert.equal(polls, 250);
  await assert.rejects(media.prepare(), /grant_revoked/);
  assert.equal(f.calls.filter((c) => c[0] === "create").length, 1);
  assert.equal((await media.close()).closed, true);
});

test("wrong publisher and duplicate tracks refuse prepared media", async () => {
  for (const participants of [
    [{ identity: "wrong", tracks: [] }],
    [
      {
        identity: "agent-one",
        tracks: [
          { type: 0, sid: "one" },
          { type: 0, sid: "two" },
        ],
      },
    ],
  ]) {
    const f = mediaFixture();
    f.setParticipants(participants);
    const media = await createProactiveOutboundMedia(f.config, f.ports);
    await assert.rejects(media.prepare());
    await media.close();
  }
});
test("lost room creation is unknown and never retried", async () => {
  const f = mediaFixture();
  let creates = 0;
  f.ports.roomService.createRoom = async () => {
    creates++;
    throw Error("lost");
  };
  const media = await createProactiveOutboundMedia(f.config, f.ports);
  await assert.rejects(media.prepare(), /unknown/);
  await assert.rejects(media.prepare(), /unknown/);
  assert.equal(creates, 1);
  assert.ok(
    f.effects.some((e) => e[0] === "room_create" && e[1] === "unknown"),
  );
  await media.close();
});
test("hangup during room create waits for late creation before cleanup", async () => {
  const f = mediaFixture(),
    gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const original = f.ports.roomService.createRoom;
  f.ports.roomService.createRoom = async (input) => {
    entered.resolve();
    await gate.promise;
    return original(input);
  };
  const media = await createProactiveOutboundMedia(f.config, f.ports),
    preparing = media.prepare();
  await entered.promise;
  const closed = media.close();
  gate.resolve();
  await assert.rejects(preparing, /expired/);
  assert.equal((await closed).closed, true);
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ["create", "delete"],
  );
});

test("prepared view is letterboxed without requiring server layout or opening another surface", async () => {
  let runtime;
  const client = {
    active: () => true,
    status: async () => ({
      channel: "phone_walkthrough",
      sharingAllowed: true,
    }),
    windowFrame: async () => ({
      frameId: "fresh",
      width: 200,
      height: 100,
      rgba: new Uint8Array(80000),
    }),
  };
  const video = makeProactiveVideo({
    client,
    width: 100,
    height: 100,
    startWindow: (ports) => {
      runtime = ports.runtime;
      return {
        stop() {},
        latest() {
          return null;
        },
      };
    },
  });
  assert.equal(await video.show(), true);
  const frame = await runtime.windowFrame();
  assert.deepEqual(frame.layout.crop, { x: 0, y: 0, width: 200, height: 100 });
  assert.deepEqual(frame.layout.contentRect, {
    x: 0,
    y: 25,
    width: 100,
    height: 50,
  });
  video.close();
  assert.equal(video.frame(), null);
});
