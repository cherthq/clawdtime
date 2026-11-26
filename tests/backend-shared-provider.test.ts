import { createHmac, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { createSharedNumberApp } from "../src/shared-number-app.js";
import { SharedProvider } from "../src/control/shared-provider.js";
import { SharedProviderAPI } from "../src/transport/shared-provider-api.js";
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  vi.useRealTimers();
});
function setup() {
  const store = new Store();
  const lineId = randomUUID(),
    secret = "s".repeat(32);
  const service = createSharedNumberApp({
    store,
    lineId,
    proofKey: "aa".repeat(32),
    identityKey: "bb".repeat(32),
    lineToken: "t".repeat(32),
    sendCode: async () => true,
  });
  cleanup.push(() => {
    service.close();
    store.close();
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
  });
  const event = {
    event_id: randomUUID(),
    type: "call.incoming",
    created_at: new Date().toISOString(),
    data: {
      call_id: randomUUID(),
      line_id: lineId,
      media: { audio: true, video: true },
      from: "untrusted caller",
    },
  };
  const send = (value = event) => {
    const raw = JSON.stringify(value);
    return provider.webhook(
      raw,
      `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
    );
  };
  return { store, service, provider, media, api, event, send, credentials };
}
it("requires exact signed raw bytes, pins the line, and never persists or replays bearer media credentials", async () => {
  const f = setup();
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
    /transient-token|untrusted caller/,
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
  const f = setup();
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
  const f = setup();
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
