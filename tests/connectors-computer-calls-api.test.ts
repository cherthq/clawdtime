import { createHmac } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { computerCli } from "../cli/computer.js";
import {
  ChertReachCalls,
  callTimes,
  callsSettings,
  mountReachCalls,
  reachCallsFolder,
  writeCallsRecord,
  type CallsSettings,
} from "../connectors/computer/calls-api.js";
import {
  LiveKitRooms,
  liveKitToken,
  type LiveKitPort,
  type RoomParticipant,
} from "../connectors/computer/livekit.js";
import { computerDirectory } from "../connectors/computer/journal.js";
import {
  OwnerReach,
  reachReplies,
  readReach,
  type ReachTextPort,
  type ReachWorker,
  type TextOutcome,
} from "../connectors/computer/reach.js";
import { buildOwnerReach } from "../connectors/computer/service.js";
import type { ComputerWorker } from "../connectors/computer/worker.js";
import { writeChertKey, writeOwner } from "../connectors/shared/owner.js";
import type { DesktopExecutionSnapshot } from "../src/control/desktop-executor.js";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const home = () => {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-calls-api-"));
  roots.push(path);
  return path;
};

const base = "https://calls.example.test/api/v1";
const origin = "http://127.0.0.1:13326";
const projectId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const lineId = "fedcbafe-dcba-4fed-8cba-fedcbafedcba";
const callId = "11112222-3333-4444-8555-666677778888";
const owner = "+15550100123";
const apiKey = "ftk_fixture_project_key_abcdefghij";
const liveKit = {
  url: "wss://fixture.livekit.example",
  apiKey: "fixture-livekit-key",
  apiSecret: "fixture-livekit-secret-abcdefghijklmnop",
};
const settings = (video = false): CallsSettings => ({
  base,
  apiKey,
  projectId,
  lineId,
  video,
  owner,
  liveKit,
  agentName: "clawdtime",
});
const question =
  'Click "Send" in Notes? It sends as you to other people. Say yes or no.';

/** The claims of a token, after its signature is checked with the secret. */
function claims(token: string, secret = liveKit.apiSecret) {
  const [head, body, signature] = token.split(".");
  expect(
    createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url"),
  ).toBe(signature);
  expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({
    alg: "HS256",
    typ: "JWT",
  });
  return JSON.parse(Buffer.from(body!, "base64url").toString()) as Record<
    string,
    unknown
  >;
}

interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}
/** The Calls API of Chert, as a list. Nothing here dials. */
class FakeChert {
  readonly sent: Sent[] = [];
  /** Calls by idempotency key: the same key gives the first call. */
  readonly byKey = new Map<string, string>();
  events: string[] = [];
  status = "active";
  terminalReason: string | null = null;
  terminalDetail: string | null = null;
  /** GET of the events never answers once the call is allocated. */
  hangEvents = false;
  /** Sends of POST /calls that get no answer: "before" never reach Chert, "after" lose their answer. */
  lose: ("before" | "after")[] = [];
  /** The status of POST /calls, in place of 201. */
  placeStatus: number | null = null;
  /** POST /calls never answers. */
  hang = false;
  /** Events that the end request adds. */
  endEvents = ["ended", "cleanup_complete"];
  onEvents?: () => void;
  readonly fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const href = String(url);
    expect(href.startsWith(base)).toBe(true);
    const path = href.slice(base.length);
    const headers = { ...(init.headers as Record<string, string>) };
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.sent.push({ method: init.method ?? "GET", path, headers, body });
    if (path === "/calls" && init.method === "POST") {
      if (this.hang) return new Promise<Response>(() => {});
      const lost = this.lose.shift();
      if (lost === "before") throw new TypeError("fetch failed");
      if (this.placeStatus !== null)
        return new Response(JSON.stringify({ error: "refused" }), {
          status: this.placeStatus,
        });
      const key = headers["Idempotency-Key"]!;
      if (!this.byKey.has(key)) this.byKey.set(key, callId);
      if (lost === "after") throw new TypeError("fetch failed");
      return new Response(
        JSON.stringify({ data: { id: this.byKey.get(key), line_id: lineId } }),
        { status: 201 },
      );
    }
    if (path === `/calls/${callId}/events`) {
      if (this.hangEvents) return new Promise<Response>(() => {});
      this.onEvents?.();
      return new Response(
        JSON.stringify({
          data: {
            call_id: callId,
            events: this.events.map((type, index) => ({
              id: `e${index}`,
              type,
              source: "worker",
            })),
          },
        }),
        { status: 200 },
      );
    }
    if (path === `/calls/${callId}`)
      return new Response(
        JSON.stringify({
          data: {
            id: callId,
            status: this.status,
            ...(this.terminalReason
              ? { terminal_reason: this.terminalReason }
              : {}),
            ...(this.terminalDetail
              ? { terminal_detail: this.terminalDetail }
              : {}),
          },
        }),
        { status: 200 },
      );
    if (path === `/calls/${callId}/end`) {
      this.events.push(...this.endEvents);
      this.status = "ended";
      return new Response("{}", { status: 202 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  calls() {
    return this.sent.filter((s) => s.method === "POST" && s.path === "/calls");
  }
  ends() {
    return this.sent.filter((s) => s.path.endsWith("/end"));
  }
}

/** LiveKit, as a list, with the line agent that joins when it is sent in. */
class FakeLiveKit implements LiveKitPort {
  readonly rooms: { room: string; options: unknown }[] = [];
  readonly dispatched: { room: string; agentName: string; metadata: string }[] =
    [];
  readonly metadata: { room: string; metadata: string }[] = [];
  readonly deleted: string[] = [];
  /** Who is in the room once the agent joined. */
  roster: RoomParticipant[] = [
    {
      identity: "agent-AJ_1",
      tracks: [
        { type: "audio", muted: false },
        { type: "video", muted: false },
      ],
    },
  ];
  /** The agent joins and says it is ready. Off: it never comes. */
  joins = true;
  onReady?: (room: string, metadata: string) => void;
  constructor(private readonly line: () => FakeLine) {}
  async createRoom(room: string, options: unknown) {
    this.rooms.push({ room, options });
  }
  async dispatch(room: string, agentName: string, metadata: string) {
    this.dispatched.push({ room, agentName, metadata });
    if (this.joins) setImmediate(() => void this.line().join(room, metadata));
  }
  async participants() {
    return this.roster;
  }
  async setMetadata(room: string, metadata: string) {
    this.metadata.push({ room, metadata });
    this.onReady?.(room, metadata);
  }
  async deleteRoom(room: string) {
    this.deleted.push(room);
  }
}

/** The line agent: it reads its capability from the file, then talks to the desktop service. */
class FakeLine {
  token = "";
  questionId = "";
  readonly replies: unknown[] = [];
  constructor(
    private readonly root: string,
    private readonly calls: () => ChertReachCalls,
  ) {}
  async join(room: string, metadata: string) {
    const job = JSON.parse(metadata) as { questionId: string };
    const file = join(reachCallsFolder(this.root), `${job.questionId}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const capability = JSON.parse(readFileSync(file, "utf8")) as {
      token: string;
      roomName: string;
    };
    expect(capability.roomName).toBe(room);
    this.token = capability.token;
    this.questionId = job.questionId;
    this.replies.push(
      await this.calls().lineCommand(job.questionId, this.token, {
        action: "prepared",
        roomName: room,
        agentIdentity: "agent-AJ_1",
      }),
    );
  }
  async say(text: string, turnId = "turn_1") {
    const reply = await this.calls().lineCommand(this.questionId, this.token, {
      action: "answer",
      turnId,
      text,
    });
    this.replies.push(reply);
    return reply;
  }
}

/** A worker whose state the test sets. */
class FakeWorker implements ReachWorker {
  now: DesktopExecutionSnapshot = {
    configured: true,
    mode: "native",
    state: "idle",
    canStop: false,
    message: "Computer use is on.",
  };
  readonly answers: string[] = [];
  stops = 0;
  snapshot() {
    return this.now;
  }
  ask(message: string, waiting: "approval" | "question" = "approval") {
    this.now = {
      requestId: "req_1",
      configured: true,
      mode: "native",
      state: "waiting_for_person",
      canStop: true,
      message,
      goal: "Finish the draft",
      waiting,
    };
  }
  move(state: string, message: string) {
    this.now = {
      requestId: "req_1",
      configured: true,
      mode: "native",
      state,
      canStop: false,
      message,
    };
  }
  async answer(text: string) {
    this.answers.push(text);
    this.move("running", "Working.");
    return { message: "Continuing." };
  }
  stop() {
    this.stops++;
    this.move("canceled", "Stopped.");
    return this.now;
  }
}
class FakeText implements ReachTextPort {
  readonly sent: { key: string; text: string }[] = [];
  readiness() {
    return { ready: true, reason: "ready" };
  }
  async send(key: string, text: string): Promise<TextOutcome> {
    this.sent.push({ key, text });
    return "sent";
  }
}

/** A reach over the Calls API path, with fakes for Chert, LiveKit and the line. */
function setup(options: { video?: boolean; root?: string } = {}) {
  const root = options.root ?? home();
  const clock = { now: 1_800_000_000_000 };
  const sleep = async (ms: number) => {
    clock.now += ms;
    await new Promise((resolve) => setImmediate(resolve));
  };
  const chert = new FakeChert();
  const worker = new FakeWorker();
  const text = new FakeText();
  let calls!: ChertReachCalls;
  const line = new FakeLine(root, () => calls);
  const rooms = new FakeLiveKit(() => line);
  let reach!: OwnerReach;
  calls = new ChertReachCalls({
    root,
    env: {},
    origin,
    answer: (id, words) => reach.callAnswer(id, words),
    stop: (id) => reach.stopFromCall(id),
    request: chert.fetch,
    liveKit: (keys) => {
      expect(keys).toEqual(liveKit);
      return rooms;
    },
    now: () => clock.now,
    sleep,
    settings: () => ({ settings: settings(options.video) }),
  });
  reach = new OwnerReach({
    root,
    worker,
    call: calls,
    text,
    delayMs: 0,
    now: () => clock.now,
  });
  /** Waits until the request to place the call is out. */
  const outgoing = async () => {
    for (let i = 0; i < 200 && chert.calls().length === 0; i++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(chert.calls()).toHaveLength(1);
  };
  /** Asks, places the one call, and gives its id. */
  const place = async (words = question) => {
    worker.ask(words);
    await reach.tick();
    const id = reach.current()!.id;
    return id;
  };
  return {
    root,
    clock,
    chert,
    worker,
    text,
    rooms,
    line,
    reach,
    place,
    outgoing,
    get calls() {
      return calls;
    },
  };
}

describe("LiveKit tokens and the server API", () => {
  it("signs a token with the claims of LiveKit, and an end of at most two hours", () => {
    const token = liveKitToken({
      apiKey: liveKit.apiKey,
      apiSecret: liveKit.apiSecret,
      identity: "clawdtime-bridge-x",
      grant: {
        roomJoin: true,
        room: "room-1",
        canPublish: true,
        canSubscribe: true,
      },
      ttlSeconds: 900,
      now: 1_800_000_000_000,
    });
    expect(claims(token)).toEqual({
      iss: liveKit.apiKey,
      sub: "clawdtime-bridge-x",
      // It starts 30 seconds early, for a server whose clock is behind.
      nbf: 1_800_000_000 - 30,
      exp: 1_800_000_900,
      video: {
        roomJoin: true,
        room: "room-1",
        canPublish: true,
        canSubscribe: true,
      },
    });
    // At most two hours from its start to its end.
    for (const ttlSeconds of [0, 7171, 1.5])
      expect(() => liveKitToken({ ...liveKit, grant: {}, ttlSeconds })).toThrow(
        /livekit_token_lifetime_invalid/,
      );
    // A token to join names who joins.
    expect(() =>
      liveKitToken({ ...liveKit, grant: { roomJoin: true }, ttlSeconds: 60 }),
    ).toThrow(/identity/);
  });

  it("sends the agent into a room through the dispatch API, with a token for that room only", async () => {
    const sent: { url: string; auth: string; body: unknown }[] = [];
    const request = (async (url: string | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string>;
      sent.push({
        url: String(url),
        auth: headers.authorization!,
        body: JSON.parse(String(init.body)),
      });
      return new Response(
        String(url).endsWith("ListParticipants")
          ? JSON.stringify({
              participants: [
                {
                  identity: "agent-AJ_1",
                  tracks: [{ sid: "a" }, { type: "VIDEO", muted: true }],
                },
              ],
            })
          : "{}",
        { status: 200 },
      );
    }) as typeof fetch;
    const rooms = new LiveKitRooms(liveKit, request, () => 1_800_000_000_000);
    await rooms.dispatch("room-1", "clawdtime", '{"kind":"reach"}');
    expect(sent[0]!.url).toBe(
      "https://fixture.livekit.example/twirp/livekit.AgentDispatchService/CreateDispatch",
    );
    expect(sent[0]!.body).toEqual({
      room: "room-1",
      agentName: "clawdtime",
      metadata: '{"kind":"reach"}',
    });
    const token = claims(sent[0]!.auth.slice("Bearer ".length));
    expect(token.video).toEqual({ roomAdmin: true, room: "room-1" });
    expect(Number(token.exp) - Number(token.nbf)).toBe(90);
    expect(await rooms.participants("room-1")).toEqual([
      {
        identity: "agent-AJ_1",
        tracks: [
          { type: "audio", muted: false },
          { type: "video", muted: true },
        ],
      },
    ]);
    expect(
      () => new LiveKitRooms({ ...liveKit, url: "ws://plain.example" }),
    ).toThrow(/livekit_url_not_encrypted/);
  });
});

describe("the Calls API call of the reach", () => {
  it("dispatches the line agent, places one call with the exact body, and goes from 201 and its events to answered", async () => {
    const f = setup();
    f.rooms.onReady = () => {
      // FaceTime is ready: the owner hears the question and says yes.
      setImmediate(() => void f.line.say("yes"));
    };
    let polls = 0;
    f.chert.onEvents = () => {
      if (++polls === 2) f.chert.events = ["bridge_ready"];
    };
    const id = await f.place();
    expect(f.calls.phase(id).phase).toBe("unsent");
    await f.calls.settled(id);

    // The room and the dispatch of the line agent.
    const room = `clawdtime-reach-${id}`;
    expect(f.rooms.rooms).toEqual([
      {
        room,
        options: {
          emptyTimeout: 120,
          departureTimeout: 5,
          maxParticipants: 2,
          metadata: JSON.stringify({ clawdtime_reach: id }),
        },
      },
    ]);
    expect(f.rooms.dispatched).toHaveLength(1);
    expect(f.rooms.dispatched[0]!.agentName).toBe("clawdtime");
    const metadata = JSON.parse(f.rooms.dispatched[0]!.metadata);
    expect(metadata).toEqual({
      kind: "reach",
      requestId: "req_1",
      questionId: id,
      question: `ClawdTime on your Mac needs your yes. ${question}`,
      answerOrigin: origin,
    });
    // No key, no token and no number travel in the job.
    expect(f.rooms.dispatched[0]!.metadata).not.toContain(f.line.token);
    expect(f.rooms.dispatched[0]!.metadata).not.toContain(owner);

    // One request to place the call: the exact body, the key of the question.
    const placed = f.chert.calls();
    expect(placed).toHaveLength(1);
    expect(placed[0]!.headers).toMatchObject({
      authorization: `Bearer ${apiKey}`,
      "X-Chert-Project-Id": projectId,
      "Idempotency-Key": `clawdtime-reach-${id}`,
      "content-type": "application/json",
    });
    const body = placed[0]!.body!;
    expect(Object.keys(body).sort()).toEqual([
      "destination",
      "destination_type",
      "direction",
      "line_id",
      "livekit_url",
      "media",
      "mode",
      "participant_token",
      "remote_participant_identity",
    ]);
    expect(body).toMatchObject({
      direction: "outbound",
      mode: "customer_managed",
      line_id: lineId,
      destination: owner,
      destination_type: "phone",
      media: { audio: true, video: false },
      livekit_url: liveKit.url,
      remote_participant_identity: "agent-AJ_1",
    });
    // The bridge token: its own identity, this one room, more than 90 seconds and at most two hours.
    const bridge = claims(String(body.participant_token));
    expect(bridge.sub).toBe(`clawdtime-bridge-${id}`);
    expect(bridge.video).toEqual({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    const life = Number(bridge.exp) - Number(bridge.nbf);
    expect(life).toBeGreaterThan(90);
    expect(life).toBeLessThanOrEqual(7200);

    // FaceTime ready: the room gets its mark, and the owner's yes reached the worker.
    expect(f.rooms.metadata).toEqual([
      {
        room,
        metadata: JSON.stringify({
          chert_bridge_ready: true,
          clawdtime_reach: id,
        }),
      },
    ]);
    expect(f.worker.answers).toEqual(["yes"]);
    expect(f.line.replies.at(-1)).toMatchObject({
      done: true,
      message: "Continuing.",
    });
    // The call ended after the goodbye, with its own key, and the room went away.
    expect(f.chert.ends()).toHaveLength(1);
    expect(f.chert.ends()[0]!.headers["Idempotency-Key"]).toBe(
      `clawdtime-reach-end-${id}`,
    );
    expect(f.rooms.deleted).toEqual([room]);
    expect(f.calls.phase(id)).toEqual({
      phase: "over",
      result: "answered",
      reason: "call_ended",
    });
    // The capability of the line agent is gone with the call.
    expect(() =>
      statSync(join(reachCallsFolder(f.root), `${id}.json`)),
    ).toThrow();
    // The answer came on the call: the question is closed, and no text goes.
    await f.reach.tick();
    await f.reach.tick();
    const events = f.reach.records()[0]!.events.map((e) => e.what);
    expect(events).toEqual(["asked", "call_placed", "answered_by_call"]);
    expect(f.reach.current()).toBeNull();
    expect(f.text.sent).toEqual([]);
    // The record holds no number, key, token or word of the question.
    const record = readFileSync(
      join(computerDirectory(f.root), "reach-calls.json"),
      "utf8",
    );
    for (const secret of [owner, apiKey, f.line.token, "Notes"])
      expect(record).not.toContain(secret);
  });

  it("puts video in the call only when the line has it", async () => {
    const f = setup({ video: true });
    f.chert.onEvents = () => (f.chert.events = ["ended"]);
    f.chert.terminalReason = "outbound_failed";
    const id = await f.place();
    await f.calls.settled(id);
    expect(f.chert.calls()[0]!.body!.media).toEqual({
      audio: true,
      video: true,
    });
  });

  it("a call with no answer ends as not answered, and the text goes", async () => {
    const f = setup();
    f.chert.onEvents = () => (f.chert.events = ["ended"]);
    // The code of the line is in the detail of a reason that says only "unknown".
    f.chert.terminalReason = "unknown";
    f.chert.terminalDetail = "outbound_not_answered";
    const id = await f.place();
    await f.calls.settled(id);
    expect(f.calls.phase(id)).toEqual({
      phase: "over",
      result: "not_answered",
      reason: "outbound_not_answered",
    });
    await f.reach.tick();
    expect(f.text.sent).toHaveLength(1);
    expect(f.text.sent[0]!.key).toBe(`clawdtime-reach:${id}`);
  });

  it("a call that rings too long is ended by the reach's own clock, and texts", async () => {
    const f = setup();
    const id = await f.place();
    await f.calls.settled(id);
    expect(f.chert.ends()).toHaveLength(1);
    expect(f.calls.phase(id)).toMatchObject({
      phase: "over",
      result: "not_answered",
    });
    await f.reach.tick();
    expect(f.text.sent).toHaveLength(1);
  });

  it("a refused request places no call, fails, and texts; a failed call fails too", async () => {
    const f = setup();
    f.chert.placeStatus = 403;
    const id = await f.place();
    await f.calls.settled(id);
    expect(f.chert.calls()).toHaveLength(1);
    expect(f.calls.phase(id)).toEqual({
      phase: "over",
      result: "failed",
      reason: "call_refused_403",
    });
    await f.reach.tick();
    expect(f.text.sent).toHaveLength(1);

    const g = setup();
    g.chert.onEvents = () => (g.chert.events = ["failed"]);
    g.chert.terminalReason = "line_not_accepting";
    const other = await g.place();
    await g.calls.settled(other);
    expect(g.calls.phase(other)).toEqual({
      phase: "over",
      result: "failed",
      reason: "line_not_accepting",
    });
  });

  it("sends a request that got no answer again with the same key and body, and never places a second call", async () => {
    const f = setup();
    // The first send reached Chert and its answer was lost; the second gets the same call.
    f.chert.lose = ["after"];
    f.chert.onEvents = () => (f.chert.events = ["ended"]);
    f.chert.terminalReason = "outbound_not_answered";
    const id = await f.place();
    await f.calls.settled(id);
    const sends = f.chert.calls();
    expect(sends).toHaveLength(2);
    expect(sends[1]!.headers["Idempotency-Key"]).toBe(
      sends[0]!.headers["Idempotency-Key"],
    );
    expect(sends[1]!.body).toEqual(sends[0]!.body);
    expect(f.chert.byKey.size).toBe(1);
    expect(f.calls.phase(id)).toMatchObject({ result: "not_answered" });
  });

  it("keeps an unknown outcome unknown and never places it again", async () => {
    // No answer to three sends: a call may exist.
    const f = setup();
    f.chert.lose = ["before", "before", "before"];
    const id = await f.place();
    await f.calls.settled(id);
    expect(f.chert.calls()).toHaveLength(3);
    expect(f.calls.phase(id)).toEqual({
      phase: "over",
      result: "unknown",
      reason: "call_request_lost",
    });
    expect(
      f.calls.place({
        key: id,
        requestId: "req_1",
        kind: "approval",
        spoken: "x",
      }),
    ).toEqual({ refused: "call_already_placed" });
    await f.reach.tick();
    expect(f.reach.records()[0]!.events.map((e) => e.what)).toContain(
      "call_unknown",
    );
    expect(f.chert.calls()).toHaveLength(3);

    // A refusal after a send that got no answer: that send may have placed it.
    const h = setup();
    h.chert.lose = ["before"];
    h.chert.placeStatus = 429;
    const third = await h.place();
    await h.calls.settled(third);
    expect(h.chert.calls()).toHaveLength(2);
    expect(h.calls.phase(third)).toEqual({
      phase: "over",
      result: "unknown",
      reason: "call_refused_after_loss_429",
    });

    // An error of the server is an answer: not sent again, and not known.
    const g = setup();
    g.chert.placeStatus = 503;
    const other = await g.place();
    await g.calls.settled(other);
    expect(g.chert.calls()).toHaveLength(1);
    expect(g.calls.phase(other)).toMatchObject({ result: "unknown" });
  });

  it("a call on its way when the service stops is unknown after the restart, and never placed again", async () => {
    const f = setup();
    f.chert.hang = true;
    const id = await f.place();
    await f.outgoing();
    expect(f.calls.phase(id)).toEqual({ phase: "live", connected: false });
    const after = new ChertReachCalls({
      root: f.root,
      env: {},
      origin,
      answer: async () => ({ message: "", done: true }),
      stop: () => "",
      request: f.chert.fetch,
      settings: () => ({ settings: settings() }),
    });
    expect(after.phase(id)).toEqual({
      phase: "over",
      result: "unknown",
      reason: "service_restarted",
    });
    expect(
      after.place({
        key: id,
        requestId: "req_1",
        kind: "approval",
        spoken: "x",
      }),
    ).toEqual({ refused: "call_already_placed" });
    expect(after.readiness()).toEqual({
      ready: true,
      reason: "ready_chert_calls_api",
    });
  });

  it("ends a call that Chert had allocated when the service stopped, once, with its own key", async () => {
    const f = setup();
    f.chert.hangEvents = true;
    const id = await f.place();
    for (let i = 0; i < 200 && f.calls.phase(id).phase !== "live"; i++)
      await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 50; i++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(f.chert.calls()).toHaveLength(1);
    const deleted: string[] = [];
    const after = new ChertReachCalls({
      root: f.root,
      env: {},
      origin,
      answer: async () => ({ message: "", done: true }),
      stop: () => "",
      request: f.chert.fetch,
      liveKit: () =>
        ({
          ...f.rooms,
          deleteRoom: async (room: string) => {
            deleted.push(room);
          },
        }) as unknown as LiveKitPort,
      settings: () => ({ settings: settings() }),
    });
    await after.restored;
    expect(after.phase(id)).toMatchObject({
      phase: "over",
      result: "unknown",
      reason: "service_restarted",
    });
    expect(f.chert.ends()).toHaveLength(1);
    expect(f.chert.ends()[0]!.headers["Idempotency-Key"]).toBe(
      `clawdtime-reach-end-${id}`,
    );
    expect(deleted).toEqual([`clawdtime-reach-${id}`]);
    expect(f.chert.calls()).toHaveLength(1);
  });

  it("keeps long numbers of the question out of the job metadata in LiveKit", async () => {
    const f = setup();
    f.chert.placeStatus = 403;
    const asked =
      "The task asks: Should I call the shop at +1 (415) 555-0100 or 4155550101? ";
    const id = await f.place(asked);
    await f.calls.settled(id);
    const metadata = f.rooms.dispatched[0]!.metadata;
    expect(metadata).not.toMatch(/555|0100/);
    expect(JSON.parse(metadata).question).toContain("[number]");
    // The line agent gets the whole question from the desktop service, with its capability.
    expect(f.line.replies[0]).toMatchObject({
      question: expect.stringContaining("+1 (415) 555-0100"),
    });
  });

  it("ends the call when the question goes away while it rings", async () => {
    const f = setup();
    let polls = 0;
    f.chert.onEvents = () => {
      // The owner answers in the chat while the phone rings.
      if (++polls === 3) {
        f.worker.move("running", "Working.");
        void f.reach.tick();
      }
    };
    const id = await f.place();
    await f.calls.settled(id);
    expect(f.chert.ends()).toHaveLength(1);
    expect(f.chert.ends()[0]!.body).toEqual({
      reason: "ClawdTime reach call ended",
    });
    expect(f.reach.records()[0]!.events.map((e) => e.what)).toContain(
      "call_ended",
    );
  });

  it("places one call for one question, and one call at a time", async () => {
    const f = setup();
    f.chert.hang = true;
    const id = await f.place();
    await f.outgoing();
    for (let tick = 0; tick < 5; tick++) await f.reach.tick();
    expect(f.calls.readiness()).toEqual({
      ready: false,
      reason: "line_in_a_call",
    });
    expect(
      f.calls.place({
        key: id,
        requestId: "req_1",
        kind: "approval",
        spoken: "x",
      }),
    ).toEqual({ refused: "call_already_placed" });
    expect(
      f.calls.place({
        key: "aaaaaaaaaaaaaaaaaaaaaaaa",
        requestId: "req_2",
        kind: "approval",
        spoken: "x",
      }),
    ).toEqual({ refused: "line_in_a_call" });
    expect(f.rooms.dispatched).toHaveLength(1);
  });

  it("takes a call back before it goes out, and places nothing when the line agent never comes", async () => {
    const f = setup();
    f.rooms.joins = false;
    const id = await f.place();
    expect(f.calls.cancel(id)).toBe(true);
    await f.calls.settled(id);
    expect(f.chert.calls()).toEqual([]);
    expect(f.calls.phase(id)).toMatchObject({
      result: "failed",
      reason: "taken_back",
    });

    const g = setup();
    g.rooms.joins = false;
    const other = await g.place();
    await g.calls.settled(other);
    expect(g.chert.calls()).toEqual([]);
    expect(g.calls.phase(other)).toMatchObject({
      result: "failed",
      reason: "agent_not_ready",
    });
    expect(g.clock.now - 1_800_000_000_000).toBeGreaterThanOrEqual(
      callTimes.agentMs,
    );
    await g.reach.tick();
    expect(g.text.sent).toHaveLength(1);
  });

  it("places no call when LiveKit shows another participant or a muted agent", async () => {
    const f = setup();
    f.rooms.roster = [
      { identity: "agent-AJ_1", tracks: [{ type: "audio", muted: true }] },
    ];
    const id = await f.place();
    await f.calls.settled(id);
    expect(f.chert.calls()).toEqual([]);
    expect(f.calls.phase(id)).toMatchObject({
      reason: "agent_media_not_ready",
    });
  });

  it("refuses the line agent without the exact capability, and before FaceTime is ready", async () => {
    const f = setup();
    f.chert.hang = true;
    const id = await f.place();
    await f.outgoing();
    await expect(
      f.calls.lineCommand(id, "wrong-token", { action: "status" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      f.calls.lineCommand(id, f.line.token, {
        action: "answer",
        turnId: "turn_1",
        text: "yes",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.worker.answers).toEqual([]);
    // The route passes the credential and the body through, and refuses a wrong one.
    const app = new Hono();
    app.onError((error, c) =>
      c.json({ error: "refused" }, (error as { status?: 403 }).status ?? 400),
    );
    mountReachCalls(app, f.calls);
    const answer = await app.request(`/computer/reach/call/${id}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.line.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "status" }),
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({
      open: true,
      callerIdentity: `clawdtime-bridge-${id}`,
      connected: false,
    });
    const refused = await app.request(`/computer/reach/call/${id}`, {
      method: "POST",
      headers: {
        authorization: "Bearer nope",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "status" }),
    });
    expect(refused.status).toBe(403);
  });

  it("a secret said on the call is not passed on, and stop on the call stops the task", async () => {
    const f = setup();
    let polls = 0;
    const said: unknown[] = [];
    f.chert.onEvents = () => {
      if (++polls === 2) f.chert.events = ["bridge_ready"];
    };
    f.rooms.onReady = () =>
      setImmediate(async () => {
        said.push(await f.line.say("my password is hunter2", "turn_1"));
        said.push(
          await f.calls.lineCommand(f.line.questionId, f.line.token, {
            action: "stop",
          }),
        );
      });
    const id = await f.place();
    await f.calls.settled(id);
    expect(said[0]).toMatchObject({
      done: false,
      message: reachReplies.secret,
    });
    expect(said[1]).toMatchObject({ done: true, message: "Stopped." });
    expect(f.worker.answers).toEqual([]);
    expect(f.worker.stops).toBe(1);
    expect(f.calls.phase(id)).toMatchObject({ result: "answered" });
  });
});

describe("choosing the Calls API path and what the doctor says", () => {
  /** A state folder with everything the Calls API path needs. */
  function complete(root: string) {
    const line = join(root, "line");
    mkdirSync(line, { mode: 0o755 });
    writeFileSync(
      join(line, ".env.local"),
      [
        `LIVEKIT_URL=${liveKit.url}`,
        `LIVEKIT_API_KEY=${liveKit.apiKey}`,
        `LIVEKIT_API_SECRET=${liveKit.apiSecret}`,
        "OPENAI_API_KEY=fixture-openai-key",
        "AGENT_NAME=clawdtime",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeChertKey(root, { version: 1, projectId, apiKey });
    writeOwner(root, {
      version: 1,
      phone: owner,
      consent: { answer: "yes", at: 1 },
    });
    writeCallsRecord(root, {
      version: 1,
      provider: "chert-calls-api",
      projectId,
      lineId,
      video: true,
      lineDirectory: line,
    });
    return line;
  }

  it("reads the key, the line, the owner's number with the yes and the LiveKit keys, and names the first that is missing", () => {
    const root = home();
    chmodSync(root, 0o700);
    expect(callsSettings({}, root)).toEqual({ missing: "project_api_key" });
    const line = complete(root);
    const found = callsSettings({}, root);
    expect(found).toEqual({
      settings: {
        base: "https://facetime.trychert.com/api/v1",
        apiKey,
        projectId,
        lineId,
        video: true,
        owner,
        liveKit,
        agentName: "clawdtime",
      },
    });
    writeOwner(root, { version: 1, phone: owner });
    expect(callsSettings({}, root)).toEqual({ missing: "consent" });
    writeOwner(root, {
      version: 1,
      phone: owner,
      consent: { answer: "yes", at: 1 },
    });
    writeFileSync(
      join(line, ".env.local"),
      "LIVEKIT_URL=wss://YOUR_PROJECT.livekit.cloud\n",
      {
        mode: 0o600,
      },
    );
    expect(callsSettings({}, root)).toEqual({ missing: "livekit_settings" });
  });

  it("the reach calls through the Calls API without a retained provider, and through the retained one when it is there", () => {
    const root = home();
    chmodSync(root, 0o700);
    complete(root);
    const worker = new FakeWorker() as unknown as ComputerWorker;
    const built = buildOwnerReach({
      worker,
      root,
      env: {},
      projectRoot: "/project",
      liveCall: () => false,
      origin,
    });
    expect(built.calls).toBeInstanceOf(ChertReachCalls);
    expect(built.reach!.readiness().calls).toEqual({
      ready: true,
      reason: "ready_chert_calls_api",
    });
    const retained = buildOwnerReach({
      worker,
      root,
      env: {},
      projectRoot: "/project",
      liveCall: () => false,
      origin,
      proactive: {
        coordinator: {
          enqueue: () => {
            throw Error("no call in this test");
          },
          get: () => {
            throw Error("no call in this test");
          },
          cancel: () => {
            throw Error("no call in this test");
          },
          list: () => [],
          authority: { list: () => [] },
        },
        configured: () => true,
        pump: () => {},
        stop: () => {},
      },
    });
    expect(retained.calls).toBeUndefined();
    expect(retained.reach!.readiness().calls).toEqual({
      ready: false,
      reason: "no_policy",
    });
  });

  it("doctor says the Calls API path is ready, or names the exact missing piece", async () => {
    const root = home();
    chmodSync(root, 0o700);
    mkdirSync(computerDirectory(root), { mode: 0o700 });
    const report = (calls: { ready: boolean; reason: string }) =>
      writeFileSync(
        join(computerDirectory(root), "reach.json"),
        JSON.stringify({
          version: 1,
          items: [],
          readiness: {
            at: Date.now(),
            calls,
            texts: { ready: true, reason: "ready" },
          },
        }),
        { mode: 0o600 },
      );
    const doctor = async () => {
      const lines: string[] = [];
      await computerCli(["doctor", "--json"], {
        env: { CLAWDTIME_CONFIG_HOME: root },
        home: root,
        print: (text) => lines.push(text),
      });
      const value = JSON.parse(lines.join("\n")) as {
        checks: { name: string; detail: string }[];
      };
      return value.checks.find((check) => check.name === "calls to you")!
        .detail;
    };
    report({ ready: true, reason: "ready_chert_calls_api" });
    expect(await doctor()).toBe(
      "ready (Chert Calls API). When a question waits, ClawdTime reaches you this way",
    );
    report({ ready: false, reason: "calls_api_missing:line_id" });
    expect(await doctor()).toBe(
      "not ready: the Chert Calls API path needs the line of the project. Run clawdtime connect (step 9)",
    );
    report({ ready: false, reason: "calls_api_missing:livekit_settings" });
    expect(await doctor()).toMatch(
      /needs the LiveKit keys in line\/\.env\.local/,
    );
    // Without a report, the files of this Mac say what the path lacks.
    rmSync(join(computerDirectory(root), "reach.json"));
    expect(await doctor()).toMatch(
      /^not reported: .*Chert Calls API, which needs the project API key of Chert/,
    );
    expect(readReach(root)).toEqual({ version: 1, items: [] });
  });
});
