import { createHmac, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { createSharedNumberApp } from "../src/shared-number-app.js";
import { SharedProvider } from "../src/control/shared-provider.js";
import { UNVERIFIED_LIMIT_MS } from "../src/control/shared-number.js";
import { SharedProviderAPI } from "../src/transport/shared-provider-api.js";
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  vi.useRealTimers();
});
// Made-up numbers. The member has a paired Mac; the stranger is no member.
const member = "+14155550100";
const stranger = "+13125550100";
async function setup(
  options: { now?: () => number; store?: Store; lineId?: string } = {},
) {
  // Passing a prior store and line restarts the coordinator on that database.
  const store = options.store ?? new Store();
  const lineId = options.lineId ?? randomUUID(),
    secret = "s".repeat(32);
  const codes = new Map<string, string>();
  const service = createSharedNumberApp({
    store,
    lineId,
    proofKey: "aa".repeat(32),
    identityKey: "bb".repeat(32),
    lineToken: "t".repeat(32),
    invited: [member],
    sendCode: async (recipient, code) => {
      codes.set(recipient, code);
      return true;
    },
    now: options.now,
  });
  cleanup.push(() => {
    service.close();
    if (!options.store) store.close();
  });
  const credentials = {
    livekit_url: "wss://media.example",
    participant_token: "transient-token",
    remote_participant_identity: "shared-agent",
  };
  const media = {
    prepare: vi.fn(async () => credentials),
    activate: vi.fn(async () => {}),
    cleanup: vi.fn(async () => true),
  };
  const api = {
    ready: vi.fn(async () => true),
    observe: vi.fn(async () => ({
      answered: false,
      terminal: false,
      cleanupComplete: false,
    })),
    dial: vi.fn(async () => ({ providerCallId: randomUUID() })),
  };
  const provider = new SharedProvider({
    store,
    router: service.router,
    lineId,
    webhookSecret: secret,
    media,
    api,
    event: service.providerEvent,
    now: options.now,
  });
  const event = {
    event_id: randomUUID(),
    type: "call.incoming",
    created_at: new Date().toISOString(),
    data: {
      call_id: randomUUID(),
      line_id: lineId,
      media: { audio: true, video: true },
      from: member as string | null,
    },
  };
  // The member signs in and pairs a Mac, so a call from the member's number
  // can wait for a code. A restart reuses the earlier pairing.
  if (!options.store) {
    const post = async (path: string, body: unknown, token = "") =>
      (await (
        await service.app.fetch(
          new Request(`https://coordinator.example${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(body),
          }),
        )
      ).json()) as any;
    const challenge = await post("/auth/start", { recipient: member });
    const { token } = await post("/auth/verify", {
      challengeId: challenge.challengeId,
      code: codes.get(member),
    });
    const { invitation } = await post("/account/invite", {}, token);
    await post("/pair/accept", {
      invitation,
      acceptance: {
        localAccepted: true,
        displayId: "display",
        allowView: true,
        allowControl: true,
      },
    });
  }
  const send = (value = event) => {
    const raw = JSON.stringify(value);
    return provider.webhook(
      raw,
      `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
    );
  };
  // A fresh signed incoming call on the same line, inside the replay window.
  const next = () => ({
    ...event,
    event_id: randomUUID(),
    created_at: new Date((options.now ?? Date.now)()).toISOString(),
    data: { ...event.data, call_id: randomUUID() },
  });
  const phase = (callId: string) =>
    store.get<{ phase: string }>("shared_provider_incoming", callId)?.phase;
  const room = (callId: string) =>
    store.get<{ roomId: string }>("shared_provider_incoming", callId)!.roomId;
  return {
    store,
    lineId,
    service,
    provider,
    media,
    api,
    event,
    next,
    send,
    phase,
    room,
    credentials,
  };
}
const live = { answered: true, terminal: false, cleanupComplete: false };
const terminal = { answered: true, terminal: true, cleanupComplete: false };
const cleaned = { answered: true, terminal: true, cleanupComplete: true };
it("requires exact signed raw bytes, pins the line, and never persists or replays bearer media credentials", async () => {
  const f = await setup();
  await expect(
    f.provider.webhook(JSON.stringify(f.event), "sha256=bad"),
  ).rejects.toThrow();
  await expect(
    f.send({ ...f.event, data: { ...f.event.data, line_id: randomUUID() } }),
  ).rejects.toThrow();
  expect(f.media.prepare).not.toHaveBeenCalled();
  expect(await f.send()).toEqual({ action: "accept", ...f.credentials });
  expect(await f.send()).toEqual({ action: "decline" });
  expect(f.media.prepare).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.store.all("shared_provider_incoming"))).not.toMatch(
    new RegExp(`transient-token|\\${member}`),
  );
  await f.provider.pump();
  expect(f.media.activate).not.toHaveBeenCalled();
  f.api.observe.mockResolvedValue({
    answered: true,
    terminal: false,
    cleanupComplete: false,
  });
  await f.provider.pump();
  await f.provider.pump();
  expect(f.media.activate).toHaveBeenCalledOnce();
  f.api.observe.mockResolvedValue({
    answered: true,
    terminal: true,
    cleanupComplete: false,
  });
  await f.provider.pump();
  expect(f.media.cleanup).not.toHaveBeenCalled();
  f.api.observe.mockResolvedValue({
    answered: true,
    terminal: true,
    cleanupComplete: true,
  });
  await f.provider.pump();
  expect(f.media.cleanup).toHaveBeenCalledOnce();
  expect(f.store.all<any>("shared_provider_incoming")[0].phase).toBe("ended");
  expect(f.api.ready).not.toHaveBeenCalled(); // No queue means no provider readiness storm.
});
it("declines missed incoming deadlines while retaining and draining a late media allocation", async () => {
  vi.useFakeTimers();
  const f = await setup();
  let finish!: (value: typeof f.credentials) => void;
  f.media.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const result = f.send();
  await vi.advanceTimersByTimeAsync(4501);
  expect(await result).toEqual({ action: "decline" });
  expect(f.store.all<any>("shared_provider_incoming")[0].phase).toBe(
    "preparing",
  );
  let drained = false;
  const drain = f.provider.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  finish(f.credentials);
  await drain;
  expect(drained).toBe(true);
  expect(f.store.all<any>("shared_provider_incoming")[0].phase).toBe(
    "prepared",
  );
  expect(await f.send()).toEqual({ action: "decline" });
  expect(f.media.prepare).toHaveBeenCalledOnce();
});
it("retains unknown room creation and declines stale events without allocation", async () => {
  const f = await setup();
  expect(
    await f.send({
      ...f.event,
      created_at: new Date(Date.now() - 10000).toISOString(),
    }),
  ).toEqual({ action: "decline" });
  f.media.prepare.mockRejectedValue(Error("lost response"));
  expect(await f.send()).toEqual({ action: "decline" });
  await f.provider.pump();
  expect(f.media.cleanup).not.toHaveBeenCalled();
  expect(f.store.all<any>("shared_provider_incoming")[0].phase).toBe("unknown");
});
it("frees the slot of a failed media preparation only after the provider reports the call ended and cleaned up", async () => {
  let clock = Date.now();
  const f = await setup({ now: () => clock });
  const first = f.next();
  f.media.prepare.mockRejectedValueOnce(Error("lost response"));
  expect(await f.send(first)).toEqual({ action: "decline" });
  expect(f.phase(first.data.call_id)).toBe("unknown");
  // Fail closed: the first call may still be live, so the slot stays held.
  expect(await f.send(f.next())).toEqual({ action: "decline" });
  f.api.observe.mockResolvedValue(live);
  await f.provider.pump();
  expect(f.api.observe).toHaveBeenCalledWith(first.data.call_id);
  expect(await f.send(f.next())).toEqual({ action: "decline" });
  clock += 60_000;
  f.api.observe.mockResolvedValue(terminal);
  await f.provider.pump();
  expect(await f.send(f.next())).toEqual({ action: "decline" });
  expect(f.media.cleanup).not.toHaveBeenCalled();
  expect(f.media.activate).not.toHaveBeenCalled(); // never answered by us
  clock += 60_000;
  f.api.observe.mockResolvedValue(cleaned);
  await f.provider.pump();
  expect(f.media.cleanup).toHaveBeenCalledWith(f.room(first.data.call_id));
  expect(f.phase(first.data.call_id)).toBe("ended");
  expect(f.media.prepare).toHaveBeenCalledOnce();
  expect(await f.send(f.next())).toEqual({
    action: "accept",
    ...f.credentials,
  });
});
it("reconciles a call left preparing by a coordinator restart before admitting the next call", async () => {
  vi.useFakeTimers();
  const f = await setup();
  f.media.prepare.mockImplementation(() => new Promise(() => {}));
  const first = f.next();
  const answer = f.send(first);
  await vi.advanceTimersByTimeAsync(4501);
  expect(await answer).toEqual({ action: "decline" });
  expect(f.phase(first.data.call_id)).toBe("preparing");
  // The process stops here. A new coordinator opens the same database.
  const g = await setup({ store: f.store, lineId: f.lineId });
  expect(g.phase(first.data.call_id)).toBe("unknown");
  expect(await g.send(g.next())).toEqual({ action: "decline" });
  await g.provider.pump();
  expect(g.media.cleanup).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  g.api.observe.mockResolvedValue(cleaned);
  await g.provider.pump();
  expect(g.media.cleanup).toHaveBeenCalledWith(g.room(first.data.call_id));
  expect(g.phase(first.data.call_id)).toBe("ended");
  expect(await g.send(g.next())).toEqual({
    action: "accept",
    ...g.credentials,
  });
});
it("bounds unknown reconciliation retries and keeps the slot until room cleanup is verified", async () => {
  let clock = Date.now();
  const f = await setup({ now: () => clock });
  const first = f.next();
  f.media.prepare.mockRejectedValueOnce(Error("lost response"));
  await f.send(first);
  f.api.observe.mockRejectedValue(Error("provider unavailable"));
  for (let i = 0; i < 20; i++) await f.provider.pump();
  expect(f.api.observe).toHaveBeenCalledOnce();
  for (let second = 0; second < 600; second++) {
    clock += 1000;
    await f.provider.pump();
  }
  // Ten minutes of one-second ticks: backoff caps reads near one per 30 s.
  expect(f.api.observe.mock.calls.length).toBeGreaterThan(10);
  expect(f.api.observe.mock.calls.length).toBeLessThanOrEqual(30);
  expect(await f.send(f.next())).toEqual({ action: "decline" });
  // The unverified call's room was removed once, after 90 s. The slot stayed.
  expect(f.media.cleanup).toHaveBeenCalledOnce();
  f.api.observe.mockResolvedValue(cleaned);
  f.media.cleanup.mockResolvedValueOnce(false); // room still listed
  clock += 30_000;
  await f.provider.pump();
  expect(f.media.cleanup).toHaveBeenCalledTimes(2);
  expect(f.phase(first.data.call_id)).toBe("unknown");
  expect(await f.send(f.next())).toEqual({ action: "decline" });
  clock += 30_000;
  await f.provider.pump();
  expect(f.phase(first.data.call_id)).toBe("ended");
  expect(await f.send(f.next())).toEqual({
    action: "accept",
    ...f.credentials,
  });
});
it("checks the real provider response contract and does not confuse room connection with answered or terminal cleanup", async () => {
  const lineId = randomUUID(),
    projectId = randomUUID(),
    integrationId = randomUUID(),
    callId = randomUUID(),
    workerId = randomUUID();
  const line = {
    id: lineId,
    worker_id: workerId,
    integration_id: integrationId,
    inbound_policy: "customer_decides",
    current_call_id: null,
    worker_occupied: false,
    status: "available",
  };
  const integration = {
    id: integrationId,
    project_id: projectId,
    enabled: true,
    signing_enabled: true,
    endpoint_url: "https://coordinator.example/provider/webhook",
  };
  let events: any[] = [
    { id: "1", source: "api", type: "bridge_ready" },
    { id: "2", source: "worker", type: "connected" },
  ];
  let connectors: any[] = [];
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    expect(init?.redirect).toBe("error");
    let data: unknown;
    if (path.endsWith("/lines"))
      data = { items: [line], total: 1, offset: 0, limit: 100 };
    else if (path.endsWith("/workers"))
      data = { items: [{ id: workerId }], total: 1, offset: 0, limit: 100 };
    else if (path.endsWith("/integrations")) data = { items: [integration] };
    else if (path.endsWith("/connectors")) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer control-token",
      );
      data = connectors;
    } else if (path.endsWith("/events")) data = { call_id: callId, events };
    else data = { id: callId, line_id: lineId };
    return Response.json({ data });
  });
  const api = new SharedProviderAPI(
    {
      callsOrigin: "https://calls.example",
      projectId,
      projectKey: "project-key",
      lineId,
      integrationId,
      endpoint: integration.endpoint_url,
      controlToken: () => "control-token",
      transportReady: () => ({ audioReady: true, videoReady: true }),
    },
    request,
  );
  expect(await api.ready()).toBe(true);
  connectors = [{ scope: { line_id: lineId }, connected: true }];
  expect(await api.ready()).toBe(false);
  connectors = [];
  integration.signing_enabled = false;
  expect(await api.ready()).toBe(false);
  integration.signing_enabled = true;
  expect(await api.observe(callId)).toEqual({
    answered: false,
    terminal: false,
    cleanupComplete: false,
  });
  events = [{ id: "3", source: "worker", type: "bridge_ready" }];
  expect((await api.observe(callId)).answered).toBe(true);
  events.push({ id: "4", source: "worker", type: "ended" });
  expect((await api.observe(callId)).cleanupComplete).toBe(false);
  events.push({ id: "5", source: "worker", type: "cleanup_complete" });
  expect((await api.observe(callId)).cleanupComplete).toBe(true);
  events.push(events[0]);
  await expect(api.observe(callId)).rejects.toThrow("event_conflict");
});
it("declines a call that no Mac can verify at once, without preparing a room or holding the slot", async () => {
  const f = await setup();
  for (const from of [stranger, null]) {
    const call = f.next();
    call.data.from = from;
    expect(await f.send(call)).toEqual({ action: "decline" });
    expect(f.phase(call.data.call_id)).toBe("ended");
  }
  expect(f.media.prepare).not.toHaveBeenCalled();
  expect(await f.send(f.next())).toEqual({
    action: "accept",
    ...f.credentials,
  });
  expect(JSON.stringify(f.store.all("shared_number_call"))).not.toContain(
    stranger,
  );
});
it("passes the observed caller to the router only as a digest, and ends an unverified call by removing its room", async () => {
  let clock = Date.now();
  const f = await setup({ now: () => clock });
  const first = f.next();
  expect(await f.send(first)).toEqual({ action: "accept", ...f.credentials });
  const calls = f.store.all<any>("shared_number_call");
  expect(calls).toHaveLength(1);
  expect(calls[0].callerDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(f.store.all("shared_number_call"))).not.toContain(
    member,
  );
  f.api.observe.mockResolvedValue(live);
  await f.provider.pump();
  expect(f.media.cleanup).not.toHaveBeenCalled();
  clock += UNVERIFIED_LIMIT_MS;
  await f.provider.pump();
  expect(f.media.cleanup).toHaveBeenCalledWith(f.room(first.data.call_id));
  await f.provider.pump();
  expect(f.media.cleanup).toHaveBeenCalledOnce();
  // Fail closed: the provider has not reported the call ended yet.
  expect(await f.send(f.next())).toEqual({ action: "decline" });
  f.api.observe.mockResolvedValue(cleaned);
  clock += 1000;
  await f.provider.pump();
  expect(f.phase(first.data.call_id)).toBe("ended");
  expect(await f.send(f.next())).toEqual({
    action: "accept",
    ...f.credentials,
  });
});
it("retries a room removal that did not take, without freeing the slot", async () => {
  let clock = Date.now();
  const f = await setup({ now: () => clock });
  const first = f.next();
  await f.send(first);
  clock += UNVERIFIED_LIMIT_MS;
  f.media.cleanup.mockRejectedValueOnce(Error("media unavailable"));
  await f.provider.pump();
  await f.provider.pump();
  expect(f.media.cleanup).toHaveBeenCalledOnce();
  clock += 5000;
  await f.provider.pump();
  expect(f.media.cleanup).toHaveBeenCalledTimes(2);
  expect(await f.send(f.next())).toEqual({ action: "decline" });
});
const hour = 60 * 60_000;
it("prunes ended webhook records, calls and their receipts after a retention window", async () => {
  let clock = Date.now();
  const f = await setup({ now: () => clock });
  const count = (kind: string) =>
    (
      f.store.db
        .prepare("SELECT count(*) AS n FROM entities WHERE kind = ?")
        .get(kind) as { n: number }
    ).n;
  const receipts = () =>
    (
      f.store.db
        .prepare("SELECT count(*) AS n FROM events WHERE id LIKE 'shared-%'")
        .get() as { n: number }
    ).n;
  // One call holds the slot. Strangers are declined and the member is busy.
  const held = f.next();
  expect(await f.send(held)).toEqual({ action: "accept", ...f.credentials });
  for (let i = 0; i < 100; i++) {
    const call = f.next();
    call.data.from = stranger;
    await f.send(call);
  }
  for (let i = 0; i < 20; i++) await f.send(f.next());
  expect(count("shared_provider_incoming")).toBe(121);
  expect(count("shared_number_call")).toBe(121);
  // The held call ends and its room is removed.
  f.api.observe.mockResolvedValue(cleaned);
  await f.provider.pump();
  expect(f.phase(held.data.call_id)).toBe("ended");
  // Inside the window every record stays.
  clock += 23 * hour;
  await f.provider.pump();
  expect(count("shared_provider_incoming")).toBe(121);
  // After the window the ended records go, with their event receipts.
  clock += 2 * hour;
  await f.provider.pump();
  expect(count("shared_provider_incoming")).toBe(0);
  expect(count("shared_number_call")).toBe(0);
  expect(receipts()).toBe(0);
  // The line still admits a member's call, and keeps it while it is open.
  const next = f.next();
  expect(await f.send(next)).toEqual({ action: "accept", ...f.credentials });
  f.api.observe.mockResolvedValue(live);
  clock += 2 * hour;
  await f.provider.pump();
  expect(f.phase(next.data.call_id)).toBe("prepared");
  expect(count("shared_number_call")).toBe(1);
});
it("reads only open records on each pass, and finds a call's room by an index", async () => {
  const f = await setup();
  for (let i = 0; i < 20; i++) {
    const call = f.next();
    call.data.from = stranger;
    await f.send(call);
  }
  const held = f.next();
  expect(await f.send(held)).toEqual({ action: "accept", ...f.credentials });
  // Every statement on the records table during a pass, webhooks and a
  // room lookup.
  const statements: string[] = [];
  const prepare = f.store.db.prepare.bind(f.store.db);
  vi.spyOn(f.store.db, "prepare").mockImplementation((sql: string) => {
    statements.push(sql);
    return prepare(sql);
  });
  await f.provider.pump();
  // Webhooks while the line is busy: a stranger and the member again.
  const another = f.next();
  another.data.from = stranger;
  expect(await f.send(another)).toEqual({ action: "decline" });
  expect(await f.send(f.next())).toEqual({ action: "decline" });
  const room = await f.service.app.fetch(
    new Request("https://coordinator.example/line/room", {
      method: "POST",
      headers: {
        authorization: `Bearer ${"t".repeat(32)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ roomId: f.room(held.data.call_id) }),
    }),
  );
  expect(room.status).toBe(200);
  vi.mocked(f.store.db.prepare).mockRestore();
  const reads = statements.filter((sql) =>
    /^\s*SELECT[\s\S]*FROM entities/i.test(sql),
  );
  expect(reads.length).toBeGreaterThan(0);
  for (const sql of reads) {
    const plan = f.store.db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((row) => String(row.detail));
    // A full scan, or a read of every record of a kind, does not scale.
    expect(
      plan.some(
        (step) =>
          /^SCAN entities/.test(step) ||
          /USING INDEX sqlite_autoindex_entities_1 \(kind=\?\)$/.test(step),
      ),
      `${sql}\n${plan.join("\n")}`,
    ).toBe(false);
  }
});
