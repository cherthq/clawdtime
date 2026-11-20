import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  answerByCall,
  converseByCall,
  openCall,
  saveCallLink,
  sayByCall,
  spokenQuestion,
  type CallLink,
} from "../connectors/agents/call.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import { canonicalProject, secureWrite } from "../connectors/shared/state.js";
import {
  ConversationService,
  type ConversationTurn,
} from "../src/attention/conversation.js";
import { ClawdTime } from "../src/attention/service.js";
import type { AttentionRequest, CallSession } from "../src/contracts.js";
import { DomainError } from "../src/storage/security.js";
import { Store } from "../src/storage/store.js";
import { SimulationTransport } from "../src/transport/simulation.js";

/**
 * The call flows of the supervisor against the real backend services, with
 * their simulated line, over real HTTP on a loopback port. The person on the
 * phone is played through the backend's own conversation service, as the voice
 * runtime plays them. No line is live and no call is placed.
 */
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
const root = () => mkdtempSync(join(tmpdir(), "clawdtime-call-desk-"));
const until = async (check: () => boolean, ms = 4000) => {
  const limit = Date.now() + ms;
  while (!check()) {
    if (Date.now() > limit) throw new Error("The expected state never came.");
    await new Promise((done) => setTimeout(done, 5));
  }
};
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function backend(options: { picksUp?: boolean } = {}) {
  const project = canonicalProject(
    mkdtempSync(join(tmpdir(), "clawdtime-call-project-")),
  );
  const store = new Store(),
    transport = new SimulationTransport(),
    service = new ClawdTime(store, transport),
    turns = new ConversationService(service),
    app = new Hono();
  const binding = {
    memberId: "fixture-member",
    recipient: "fixture-recipient",
    conversationId: "fixture-conversation",
    lineId: "fixture-line",
    deviceId: "fixture-device",
    displayId: "1",
  };
  const invite = service.createPairingInvite(binding),
    grant = service.claimPairing({
      token: invite.token,
      deviceId: binding.deviceId,
      displayId: binding.displayId,
      allowView: true,
      allowControl: true,
    });
  /** Every operation that the backend refused, as "METHOD path: reason". */
  const refused: string[] = [];
  let polls = 0;
  let last = "";
  const token = (c: { req: { header(name: string): string | undefined } }) =>
    String(c.req.header("authorization")).slice(7);
  // Errors leave the backend as they do in its own application: the status of
  // the refusal, its reason and its code.
  app.onError((error, c) => {
    refused.push(
      `${c.req.method} ${new URL(c.req.url).pathname.replace(/attention_[0-9a-f-]+/, "ID")}: ${error.message}`,
    );
    return c.json(
      {
        ...(error instanceof DomainError && error.code
          ? { errorCode: error.code }
          : {}),
        error: error.message,
      },
      error instanceof DomainError ? (error.status as 400) : 500,
    );
  });
  app.post("/api/sessions", async (c) =>
    c.json(service.registerSession(token(c), await c.req.json())),
  );
  app.post("/api/sessions/heartbeat", (c) =>
    c.json({ session: service.heartbeat(token(c)) }),
  );
  app.post("/api/attention", async (c) => {
    const before = store.all<AttentionRequest>("attention").length;
    const request = service.requestAttention(token(c), await c.req.json());
    last = request.id;
    // A new request: the backend's loop places the call on the simulated line,
    // and the person picks up.
    if (store.all<AttentionRequest>("attention").length > before) {
      await service.drain();
      if (options.picksUp ?? true)
        service.observeCall(request.id, "connected", true);
    }
    return c.json({ request: service.status(token(c), request.id) }, 202);
  });
  // As in the backend's application: this read answers at once. It does not
  // wait for the person to speak.
  app.get("/api/attention/:id/conversation/turns", async (c) => {
    polls++;
    await turns.reconcileReplies(token(c), c.req.param("id"));
    return c.json(
      turns.poll(
        token(c),
        c.req.param("id"),
        Number(c.req.query("after") ?? 0),
      ),
    );
  });
  app.post("/api/attention/:id/conversation/ack", async (c) =>
    c.json(
      turns.acknowledge(
        token(c),
        c.req.param("id"),
        (await c.req.json()).turnId,
      ),
    ),
  );
  app.post("/api/attention/:id/conversation/progress", async (c) => {
    const body = await c.req.json();
    return c.json(
      turns.progress(token(c), c.req.param("id"), body.turnId, body.state),
    );
  });
  app.post("/api/attention/:id/conversation/reply", async (c) =>
    c.json(await turns.reply(token(c), c.req.param("id"), await c.req.json())),
  );
  app.post("/api/attention/:id/conversation/end", async (c) => {
    const result = turns.end(token(c), c.req.param("id"));
    // The backend's loop then hangs up the line.
    await service.drain();
    return c.json(result);
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((done) => server.on("listening", () => done()));
  closers.push(() => new Promise<void>((done) => server.close(() => done())));
  const connection = join(project, "connection.json");
  secureWrite(connection, {
    schemaVersion: 1,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    ...grant,
    adapter: "claude-code",
    adapterVersion: "synthetic",
    projectRoot: project,
    hostId: "fixture-host",
  });
  const link: CallLink = {
    version: 1,
    connectionFile: connection,
    project,
    adapter: "claude-code",
    linkedAt: Date.now(),
  };
  const request = (id = last) => store.get<AttentionRequest>("attention", id)!;
  return {
    link,
    store,
    transport,
    service,
    refused,
    polls: () => polls,
    /** The attention request of the newest call, as the backend holds it. */
    request,
    requests: () => store.all<AttentionRequest>("attention"),
    connected: () => last !== "" && request().state === "awaiting_input",
    /** The person says something on the call. */
    speak(text: string) {
      return turns.receive({
        eventId: randomUUID(),
        requestId: last,
        memberId: binding.memberId,
        lineId: binding.lineId,
        conversationId: binding.conversationId,
        channel: "voice",
        text,
        qualifiedRemoteAudio: true,
        callId: request().callId!,
      });
    },
    /** The person ends the call on the phone. */
    hangUp: () => service.observeCall(last, "ended"),
    /** What the backend spoke to the person, in order. */
    spoken: () => transport.spoken.map((item) => item.text),
    turns: () =>
      store
        .all<ConversationTurn>("conversation_turn")
        .sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence),
    calls: () => store.all<CallSession>("call"),
  };
}

const ask = (
  desk: DecisionDesk,
  described: {
    kind: "permission" | "question" | "plan";
    tool: string;
    summary: string;
    options: string[];
  } = {
    kind: "permission",
    tool: "Bash",
    summary: "git push origin main",
    options: [],
  },
) =>
  desk.open({
    agent: "claude-code",
    sessionId: "s",
    cwd: "/work/app",
    pids: [],
    described,
    holdSeconds: 300,
  });
const timing = () => ({
  now: () => Date.now(),
  deadline: Date.now() + 120_000,
  pollMs: 3000,
  pauseMs: 15,
});

describe("a decision by phone, against the real backend in simulation", () => {
  it("asks, asks again when the words are unclear, takes a clear yes, and the backend refuses nothing", async () => {
    const line = await backend();
    const request = ask(new DecisionDesk(root()));
    const answering = answerByCall(
      await openCall(line.link, request.id),
      request,
      timing(),
    );
    await until(line.connected);
    // The backend holds the question as the call will say it, and placed one call.
    expect(line.request().question).toBe(spokenQuestion(request));
    expect(line.request().reason).toBe("approval");
    expect(line.transport.calls).toHaveLength(1);
    line.speak("what does it do");
    await until(() => line.spoken().length === 1);
    expect(line.spoken()).toEqual(["Say approve, or say deny."]);
    line.speak("yes, approve it");
    expect(await answering).toEqual({ decision: "allow", text: null });
    expect(line.spoken()).toEqual([
      "Say approve, or say deny.",
      "Approved. It continues now.",
    ]);
    // On the backend: the request is complete, every turn is done, and the line is free.
    expect(line.request().state).toBe("completed");
    expect(line.turns().map((turn) => turn.state)).toEqual([
      "completed",
      "completed",
    ]);
    expect(line.turns().every((turn) => turn.delivery === "acknowledged")).toBe(
      true,
    );
    expect(line.calls().map((call) => call.state)).toEqual(["ended"]);
    expect(line.transport.ended).toHaveLength(1);
    expect(line.refused).toEqual([]);
  });

  it("takes a spoken no, a choice by its number and a choice by its name, one call after the other", async () => {
    const line = await backend();
    const desk = new DecisionDesk(root());
    const push = ask(desk);
    let answering = answerByCall(
      await openCall(line.link, push.id),
      push,
      timing(),
    );
    await until(line.connected);
    line.speak("no, do not push that");
    expect(await answering).toEqual({
      decision: "deny",
      text: "no, do not push that",
    });
    expect(line.spoken().at(-1)).toBe("Denied. I told it.");
    expect(line.request().state).toBe("completed");

    const choices = {
      kind: "question" as const,
      tool: "AskUserQuestion",
      summary: "Which database first?",
      options: ["Staging", "Production"],
    };
    for (const [said, chosen] of [
      ["number two please", "Production"],
      ["staging", "Staging"],
    ] as const) {
      const question = ask(desk, choices);
      answering = answerByCall(
        await openCall(line.link, question.id),
        question,
        timing(),
      );
      await until(() => line.request().question === spokenQuestion(question));
      await until(line.connected);
      expect(line.request().reason).toBe("decision");
      line.speak(said);
      expect(await answering).toEqual({ decision: "answer", text: chosen });
      expect(line.spoken().at(-1)).toBe(`Answered: ${chosen}.`);
      expect(line.request().state).toBe("completed");
    }
    // Three calls, each on a free line, each ended.
    expect(line.transport.calls).toHaveLength(3);
    expect(line.calls().map((call) => call.state)).toEqual([
      "ended",
      "ended",
      "ended",
    ]);
    expect(line.refused).toEqual([]);
  });

  it("gives no answer when the person hangs up, and takes what they said just before", async () => {
    const line = await backend();
    const desk = new DecisionDesk(root());
    const first = ask(desk);
    let answering = answerByCall(
      await openCall(line.link, first.id),
      first,
      timing(),
    );
    await until(line.connected);
    line.hangUp();
    expect(await answering).toBeNull();
    expect(line.request().state).toBe("disconnected");
    expect(line.spoken()).toEqual([]);
    expect(line.refused).toEqual([]);

    // The person says yes and hangs up before the answer is read: it still counts,
    // and nothing is spoken into a call that is over.
    const second = ask(desk);
    const client = await openCall(line.link, second.id);
    // The flow starts reading only after the hangup.
    const held = { open: false };
    answering = answerByCall(
      {
        requestAttention: (input) => client.requestAttention(input),
        conversationTurns: async (id, after, timeoutMs) => {
          await until(() => held.open, 4000);
          return client.conversationTurns(id, after, timeoutMs);
        },
        conversationOperation: (id, operation, body) =>
          client.conversationOperation(id, operation, body),
        heartbeat: () => client.heartbeat(),
      },
      second,
      timing(),
    );
    await until(() => line.requests().length === 2 && line.connected());
    line.speak("approve");
    line.hangUp();
    held.open = true;
    expect(await answering).toEqual({ decision: "allow", text: null });
    expect(line.spoken()).toEqual([]);
    expect(line.refused).toEqual([]);
  });

  it("ends the call on the backend when nobody says a clear word before the time runs out", async () => {
    const line = await backend();
    const request = ask(new DecisionDesk(root()));
    // Each read of the clock is four seconds later: the time runs out after a few reads.
    let clock = Date.now();
    const answering = answerByCall(
      await openCall(line.link, request.id),
      request,
      {
        now: () => (clock += 4000),
        deadline: clock + 60_000,
        pollMs: 3000,
        pauseMs: 15,
      },
    );
    expect(await answering).toBeNull();
    expect(line.request().state).toBe("completed");
    expect(line.calls().map((call) => call.state)).toEqual(["ended"]);
    expect(line.refused).toEqual([]);
  });

  it("reads at a steady pace: a backend that answers at once is not flooded", async () => {
    const line = await backend();
    const request = ask(new DecisionDesk(root()));
    const answering = answerByCall(
      await openCall(line.link, request.id),
      request,
      { ...timing(), pauseMs: 50 },
    );
    await until(line.connected);
    const before = line.polls();
    await pause(500);
    const reads = line.polls() - before;
    // Half a second of silence at one read each 50 ms: about ten reads, not thousands.
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(reads).toBeLessThanOrEqual(14);
    line.speak("deny");
    expect(await answering).toMatchObject({ decision: "deny" });
    expect(line.refused).toEqual([]);
  });

  it("takes a very long sentence in its stride", async () => {
    const line = await backend();
    const request = ask(new DecisionDesk(root()));
    const answering = answerByCall(
      await openCall(line.link, request.id),
      request,
      timing(),
    );
    await until(line.connected);
    // The backend takes up to 8,000 characters in one turn.
    line.speak(`well ${"and then ".repeat(700)}hmm`);
    await until(() => line.spoken().length === 1);
    line.speak("approve");
    expect(await answering).toEqual({ decision: "allow", text: null });
    expect(line.spoken()).toEqual([
      "Say approve, or say deny.",
      "Approved. It continues now.",
    ]);
    expect(line.refused).toEqual([]);
  });

  it("gives up cleanly when the backend stops answering, and leaves no open call behind", async () => {
    const line = await backend();
    const request = ask(new DecisionDesk(root()));
    const client = await openCall(line.link, request.id);
    let broken = false,
      reads = 0;
    const started = Date.now();
    const answer = await answerByCall(
      {
        requestAttention: async (input) => {
          const made = await client.requestAttention(input);
          broken = true;
          return made;
        },
        conversationTurns: (id, after, timeoutMs) => {
          reads++;
          return broken
            ? Promise.reject(new Error("The backend did not answer."))
            : client.conversationTurns(id, after, timeoutMs);
        },
        conversationOperation: (id, operation, body) =>
          client.conversationOperation(id, operation, body),
        heartbeat: () => client.heartbeat(),
      },
      request,
      timing(),
    );
    // A few tries with a pause between them, then no answer: never an endless or a hot loop.
    expect(answer).toBeNull();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(reads).toBeLessThanOrEqual(6);
    expect(Date.now() - started).toBeLessThan(3000);
    // The call that was placed is ended on the backend, so the line is free again.
    expect(line.request().state).toBe("completed");
    expect(line.calls().map((call) => call.state)).toEqual(["ended"]);
  });
});

describe("a conversation by phone, against the real backend in simulation", () => {
  it("answers each thing the person says, fragments together, and ends on goodbye", async () => {
    const line = await backend();
    const heard: string[] = [];
    const talking = converseByCall(
      await openCall(line.link, "talk-1"),
      async (spoken) => {
        heard.push(spoken);
        return `Answer ${heard.length}.`;
      },
      { ...timing(), greeting: "ClawdTime here. What do you need?", key: "k1" },
    );
    await until(line.connected);
    expect(line.request().question).toBe("ClawdTime here. What do you need?");
    // Two fragments of one sentence, heard between two reads.
    line.speak("what needs");
    line.speak("me right now");
    await until(() => line.spoken().length === 1);
    line.speak("and what did I decide about pushes");
    await until(() => line.spoken().length === 2);
    line.speak("okay thanks, goodbye");
    expect(await talking).toEqual({ turns: 3, ended: "goodbye" });
    expect(heard).toEqual([
      "what needs me right now",
      "and what did I decide about pushes",
    ]);
    expect(line.spoken()).toEqual(["Answer 1.", "Answer 2.", "Goodbye."]);
    expect(line.request().state).toBe("completed");
    expect(line.turns().map((turn) => turn.state)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(line.calls().map((call) => call.state)).toEqual(["ended"]);
    expect(line.refused).toEqual([]);
  });

  it("stops when the person hangs up, and ends the call when the answer cannot be made", async () => {
    const line = await backend();
    const talking = converseByCall(
      await openCall(line.link, "talk-2"),
      async () => "x",
      { ...timing(), greeting: "Hello.", key: "k2" },
    );
    await until(line.connected);
    line.hangUp();
    expect(await talking).toEqual({ turns: 0, ended: "hung_up" });
    expect(line.refused).toEqual([]);

    // The answer fails (for example the language model is down): the call does not stay open.
    const failing = converseByCall(
      await openCall(line.link, "talk-3"),
      async () => {
        throw new Error("No answer could be made.");
      },
      { ...timing(), greeting: "Hello again.", key: "k3" },
    );
    await until(() => line.requests().length === 2 && line.connected());
    line.speak("what needs me");
    await expect(failing).rejects.toThrow("No answer could be made.");
    expect(line.request().state).toBe("completed");
    expect(line.calls().map((call) => call.state)).toEqual(["ended", "ended"]);
  });
});

describe("one sentence by phone, against the real backend in simulation", () => {
  it("says it, ends when the person has heard it, and never calls twice for the same news", async () => {
    const line = await backend();
    const sentence = "pratap has shown no sign of life for 12 minutes.";
    const telling = sayByCall(
      await openCall(line.link, "incident-abc"),
      sentence,
      { ...timing(), key: "abc" },
    );
    await until(line.connected);
    expect(line.request().question).toBe(
      `${sentence} Say okay when you have heard this.`,
    );
    line.speak("okay, got it");
    expect(await telling).toBe("heard");
    expect(line.spoken()).toEqual(["Okay."]);
    expect(line.request().state).toBe("completed");
    expect(line.refused).toEqual([]);

    // The same news again, later and with another deadline (as after a restart
    // of the service): the backend knows the key. No new request, no new call,
    // and nothing is refused.
    expect(
      await sayByCall(await openCall(line.link, "incident-abc"), sentence, {
        ...timing(),
        deadline: Date.now() + 45_000,
        key: "abc",
      }),
    ).toBe("ended");
    expect(line.requests()).toHaveLength(1);
    expect(line.transport.calls).toHaveLength(1);
    expect(line.spoken()).toEqual(["Okay."]);
    expect(line.refused).toEqual([]);
  });

  it("returns when the person hangs up without a word", async () => {
    const line = await backend();
    const telling = sayByCall(
      await openCall(line.link, "incident-def"),
      "chert-e7 is done after 12 minutes.",
      { ...timing(), key: "def" },
    );
    await until(line.connected);
    line.hangUp();
    expect(await telling).toBe("ended");
    expect(line.refused).toEqual([]);
  });
});

describe("away mode, end to end, against the real backend in simulation", () => {
  it("the service places the call by itself and the spoken answer reaches the desk and the trove", async () => {
    const line = await backend();
    const directory = root();
    saveCallLink(directory, {
      connectionFile: line.link.connectionFile,
      project: line.link.project,
      adapter: line.link.adapter,
      linkedAt: Date.now(),
    });
    // No stand-in for the call: the feed opens it through the link.
    const feed = new BoardFeed({ root: directory, model: null, speech: null });
    const waiting = ask(feed.desk);
    expect(feed.decisions()).toMatchObject({ away: false, callReady: true });
    expect(line.requests()).toHaveLength(0);
    feed.setAway(true);
    feed.decisions();
    await until(line.connected);
    expect(line.request().question).toBe(spokenQuestion(waiting));
    // The panel keeps reading while the call runs: still one call.
    feed.decisions();
    feed.decisions();
    line.speak("approve");
    await until(() => feed.desk.take(waiting.id) !== null);
    const answer = feed.desk.take(waiting.id)!;
    expect(answer).toMatchObject({ decision: "allow", via: "call" });
    expect(line.spoken()).toEqual(["Approved. It continues now."]);
    await until(() => line.request().state === "completed");
    expect(line.transport.calls).toHaveLength(1);
    // The hook takes the answer and closes the request: the trove keeps it.
    const kept = feed.desk.close(waiting, answer);
    expect(kept).toMatchObject({
      decision: "allow",
      via: "call",
      summary: "git push origin main",
    });
    expect(feed.desk.trove.decisions().map((entry) => entry.via)).toEqual([
      "call",
    ]);
    expect(line.refused).toEqual([]);
    feed.close();
  });
});
