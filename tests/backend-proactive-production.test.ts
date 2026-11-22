import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { Vault, hash } from "../src/storage/security.js";
import { ProactiveCallCoordinator } from "../src/attention/proactive-coordinator.js";
import { ProactivePolicyAuthority } from "../src/attention/proactive-policy.js";
import { ProactiveLineSessions } from "../src/control/proactive-line.js";
import {
  createProductionDelivery,
  type ProductionDeliveryDependencies,
  type ProactiveProductionConfig,
} from "../src/control/proactive-production.js";
import type { ProactiveReviewPacket } from "../src/control/proactive-preparation.js";
import {
  createProactiveOutboundMedia,
  type ProactiveConfig,
} from "../line/proactive-outbound.mjs";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const lineId = "11111111-1111-4111-8111-111111111111",
  projectId = "22222222-2222-4222-8222-222222222222",
  providerCallId = "33333333-3333-4333-8333-333333333333",
  digest = "ab".repeat(32);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "proactive-production-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const directory = (name: string) => {
    const path = join(root, name);
    mkdirSync(path, { mode: 0o700 });
    return path;
  };
  const project = directory("project"),
    protectedRoot = directory("private"),
    lineDirectory = directory("line"),
    attempts = directory("attempts");
  const file = (name: string, value: unknown, mode = 0o600) => {
    const path = join(protectedRoot, name);
    writeFileSync(
      path,
      typeof value === "string" ? value : JSON.stringify(value),
      { mode },
    );
    return path;
  };
  for (const name of [
    "proactive-agent.mjs",
    "proactive-outbound.mjs",
    "proactive-owner.mjs",
    "provider-retention.mjs",
    "agent.mjs",
    "warm-media.mjs",
    "package.json",
    "package-lock.json",
  ])
    writeFileSync(join(lineDirectory, name), "synthetic protected source", {
      mode: 0o600,
    });
  let now = Date.now();
  const clock = () => now;
  const native = {
    callsOrigin: "https://calls.example.test",
    projectId,
    projectKey: "synthetic-project-credential",
    recipient: "+15555550123",
    lineId,
  };
  const config: ProactiveProductionConfig = {
    version: 1,
    nodeBinary: file("node", "synthetic executable", 0o700),
    lineDirectory,
    lineEnvironmentFile: file(
      "line.env",
      "LIVEKIT_URL=wss://media.example.test\nLIVEKIT_API_KEY=synthetic-key\nLIVEKIT_API_SECRET=synthetic-media-secret\nOPENAI_API_KEY=synthetic-openai-secret\nCLAWDTIME_LINE_VOICE=fixture-voice\nNODE_OPTIONS=--require=/unsafe\nCLAWDTIME_DESKTOP_ORIGIN=https://wrong.invalid\nAGENT_NAME=wrong-agent\n",
    ),
    providerConfigFile: file("provider.json", native),
    connectorCredentialFile: file("connector.json", {
      access_token: "synthetic-connector-credential",
      expires_at: now + 60000,
    }),
    attemptDirectory: attempts,
    workerPort: 13429,
    destination: {
      personId: "person",
      deviceId: "device",
      projectRoot: project,
      lineId,
      recipientHash: hash(native.recipient),
    },
    owner: {
      hostScript: file("host.sh", "synthetic host script", 0o700),
      hostStateDirectory: directory("host"),
      hostSession: "fixture-host",
      agentName: "fixture-agent",
      retentionConfigFile: file("retention.json", {}),
      providerStateDirectory: directory("provider"),
      initialJournal: file("journal.json", {}),
      stateFile: join(protectedRoot, "owner.json"),
    },
  };
  const configFile = file("production.json", config);
  const store = new Store(),
    vault = new Vault("ad".repeat(32));
  cleanups.push(() => store.close());
  const authority = new ProactivePolicyAuthority(store, vault, clock),
    coordinator = new ProactiveCallCoordinator(store, vault, authority, clock);
  authority.register({
    version: 2,
    id: "policy",
    scope: { personId: "person", deviceId: "device", projectRoot: project },
    triggers: ["completion"],
    channels: ["phone_alert"],
    expiresAt: now + 60000,
    maxAttempts: 1,
    minIntervalMs: 0,
    attemptLifetimeMs: 30000,
    viewScope: [],
    alertFallback: false,
    consent: {
      actorId: "person",
      recordedAt: now,
      source: "operator",
      statement: "Synthetic test only.",
    },
  });
  const enqueued = coordinator.enqueue({
    source: {
      kind: "session",
      sessionId: "session",
      runId: "run",
      enrollmentId: "enrollment",
    },
    scope: {
      personId: "person",
      deviceId: "device",
      projectRoot: project,
      sessionId: "session",
    },
    policyId: "policy",
    trigger: "completion",
    channel: "phone_alert",
    expiresAt: now + 60000,
    brief: "Fixture observed completion.",
  }).record;
  coordinator.prepare(enqueued.id);
  coordinator.ready(enqueued.id, digest);
  const { record: intent, grant } = coordinator.reserve(enqueued.id, {
    sourceCurrent: true,
    lineAvailable: true,
    packetFingerprint: digest,
  });
  const packet: ProactiveReviewPacket = {
    id: intent.id,
    version: 1,
    intentId: intent.id,
    source: intent.source,
    sourceFingerprint: digest,
    policyId: "policy",
    policyRevision: 1,
    channel: "phone_alert",
    goal: "Fixture",
    status: "unverified",
    summary: "Observed completion.",
    choices: [],
    checks: [],
    artifacts: [],
    narration: "Unverified fixture.",
    views: [],
    walkthroughOrder: [],
    createdAt: now,
    expiresAt: now + 1000,
    fingerprint: digest,
  };
  const sessions = new ProactiveLineSessions(
    authority,
    {
      sourceCurrent: () => true,
      answer: async () => "fixture",
      stopSharing: async () => ({ confirmed: true }),
    },
    clock,
  );
  const events: string[] = [];
  let alive = false,
    joinConfirmed = true,
    runtime: ProactiveConfig | undefined;
  const owner = {
    readiness: vi.fn(async () => ({ ready: true })),
    acquire: vi.fn(async () => {
      events.push("handoff");
      return { exclusive: true as const };
    }),
    verify: vi.fn(async () => true),
    restore: vi.fn(async () => {
      events.push("restore");
      return { confirmed: true };
    }),
  };
  const roomService = {
    createRoom: vi.fn(async () => {
      events.push("room-create");
      const {
        version: _v,
        origin: _o,
        token,
        expiresAt: _e,
        providerCallerIdentity: _c,
        ...binding
      } = runtime!;
      await sessions.command(intent.attemptId!, token, {
        action: "prepared",
        binding,
        media: { audioReady: true, videoReady: true },
      });
      return {};
    }),
    listParticipants: vi.fn(async () => [
      {
        identity: runtime!.agentIdentity,
        tracks: [
          { type: 0, sid: "audio", muted: false },
          { type: 1, sid: "video", muted: false },
        ],
      },
    ]),
    deleteRoom: vi.fn(async () => {
      events.push("room-delete");
    }),
    listRooms: vi.fn(async () => []),
  };
  const worker = {
    pid: 12345,
    alive: () => alive,
    stop: vi.fn(async () => {
      events.push("worker-stop");
      if (joinConfirmed) alive = false;
      return { joined: joinConfirmed };
    }),
  };
  const launch = vi.fn<
    NonNullable<ProductionDeliveryDependencies["launchWorker"]>
  >(async (input) => {
    events.push("worker-start");
    alive = true;
    runtime = JSON.parse(
      readFileSync(input.env.CLAWDTIME_PROACTIVE_CONFIG!, "utf8"),
    ) as ProactiveConfig;
    return worker;
  });
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/api/v1/calls")) {
      events.push("dial");
      expect(coordinator.transport.get(grant!.attemptId, "dial")?.state).toBe(
        "running",
      );
      return new Response(
        JSON.stringify({ data: { id: providerCallId, line_id: lineId } }),
      );
    }
    if (String(url).endsWith("/events"))
      return new Response(
        JSON.stringify({
          data: {
            call_id: providerCallId,
            events: [
              { id: "cleanup", type: "cleanup_complete", source: "worker" },
            ],
          },
        }),
      );
    throw Error(`unexpected fixture route ${init?.method}`);
  });
  const loadMedia = vi.fn(
    async () =>
      async (
        mediaConfig: Parameters<typeof createProactiveOutboundMedia>[0],
        ports: Parameters<typeof createProactiveOutboundMedia>[1],
      ) =>
        createProactiveOutboundMedia(mediaConfig, { ...ports, roomService }),
  );
  const create = (overrides: ProductionDeliveryDependencies = {}) =>
    createProductionDelivery(
      configFile,
      {
        projectRoot: project,
        origin: "http://127.0.0.1:13416",
        coordinator,
        sessions,
        packet: () => packet,
        current: () => true,
        sourceFingerprint: () => digest,
        cleanupViews: async () => {
          events.push("views-close");
          return { confirmed: true };
        },
      },
      {
        loadOwner: async () => owner,
        loadMedia,
        launchWorker: launch,
        request,
        now: clock,
        pause: async (ms) => {
          now += ms;
        },
        ...overrides,
      },
    );
  return {
    root,
    config,
    configFile,
    native,
    intent,
    grant: grant!,
    coordinator,
    authority,
    sessions,
    owner,
    roomService,
    worker,
    launch,
    request,
    loadMedia,
    events,
    create,
    setAlive: (value: boolean) => (alive = value),
    setJoin: (value: boolean) => (joinConfirmed = value),
  };
}

it("loads protected production config and probes without allocating, spawning or calling", async () => {
  const f = fixture(),
    delivery = f.create();
  expect(await delivery.probe()).toMatchObject({ ready: true });
  expect(f.events).toEqual([]);
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
  expect(delivery.diagnostics()).toMatchObject({
    configured: true,
    physicalAcceptance: false,
  });
  expect(JSON.stringify(delivery.diagnostics())).not.toContain(
    "synthetic-project-credential",
  );
});

it("delivers through real room and native adapters with allowlisted environment and joins worker before restoring incoming ownership", async () => {
  const f = fixture(),
    delivery = f.create();
  expect(await delivery.deliver(f.intent, f.grant)).toEqual({
    state: "ended",
    cleanupConfirmed: true,
  });
  expect(f.events).toEqual([
    "handoff",
    "worker-start",
    "room-create",
    "dial",
    "views-close",
    "room-delete",
    "worker-stop",
    "restore",
  ]);
  const input = f.launch.mock.calls[0]![0];
  expect(input.env).toMatchObject({
    AGENT_NAME: `review_${f.grant.attemptId}`,
    CLAWDTIME_LINE_PORT: "13429",
    CLAWDTIME_LINE_VOICE: "fixture-voice",
  });
  expect(input.env).not.toHaveProperty("NODE_OPTIONS");
  expect(input.env).not.toHaveProperty("CLAWDTIME_DESKTOP_ORIGIN");
  expect(input.env).not.toHaveProperty("CHERT_API_KEY");
  expect([input.nodeBinary, input.program, input.cwd].join(" ")).not.toContain(
    "secret",
  );
  expect(existsSync(input.env.CLAWDTIME_PROACTIVE_CONFIG!)).toBe(false);
  expect(
    f.coordinator.transport
      .list(f.grant.attemptId)
      .every((effect) => effect.state === "done"),
  ).toBe(true);
  expect(f.sessions.status(f.grant.attemptId)).toBeNull();
});

it("retains an unacknowledged worker launch and never retries or restores over its uncertain process", async () => {
  const f = fixture(),
    launch = vi.fn(async () => {
      throw Error("lost worker response");
    });
  const delivery = f.create({ launchWorker: launch });
  expect(await delivery.deliver(f.intent, f.grant)).toMatchObject({
    state: "unknown",
    cleanupConfirmed: false,
  });
  expect(f.owner.restore).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
  await delivery.deliver(f.intent, f.grant);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(
    f.coordinator.transport.get(f.grant.attemptId, "worker_start")?.state,
  ).toBe("unknown");
});

it("waits for the exact worker acknowledgement when publications appear first", async () => {
  const f = fixture();
  const acknowledge = f.roomService.createRoom.getMockImplementation()!;
  f.roomService.createRoom.mockResolvedValue({});
  let waited = false;
  const delivery = f.create({
    pause: async () => {
      expect(f.request).not.toHaveBeenCalled();
      expect(f.sessions.status(f.grant.attemptId)?.prepared).toBe(false);
      waited = true;
      await acknowledge();
    },
  });
  expect(await delivery.deliver(f.intent, f.grant)).toMatchObject({
    state: "ended",
    cleanupConfirmed: true,
  });
  expect(waited).toBe(true);
  expect(f.roomService.createRoom).toHaveBeenCalledTimes(1);
  expect(f.launch).toHaveBeenCalledTimes(1);
  expect(f.events.filter((event) => event === "dial")).toHaveLength(1);
});

it("cleans up without dialing when the worker never acknowledges published media", async () => {
  const f = fixture();
  f.roomService.createRoom.mockResolvedValue({});
  expect(await f.create().deliver(f.intent, f.grant)).toMatchObject({
    state: "refused",
    cleanupConfirmed: true,
    reason: "production_worker_prepare_timeout",
  });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.worker.stop).toHaveBeenCalledTimes(1);
  expect(f.owner.restore).toHaveBeenCalledTimes(1);
});

it("does not wait or dial after an unacknowledged worker exits", async () => {
  const f = fixture();
  f.roomService.createRoom.mockImplementation(async () => {
    f.setAlive(false);
    return {};
  });
  expect(await f.create().deliver(f.intent, f.grant)).toMatchObject({
    state: "refused",
    cleanupConfirmed: true,
    reason: "production_worker_retired_during_prepare",
  });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.owner.restore).toHaveBeenCalledTimes(1);
});

it("stops waiting without dialing when authority is revoked before the worker acknowledgement", async () => {
  const f = fixture();
  f.roomService.createRoom.mockResolvedValue({});
  const delivery = f.create({
    pause: async () => {
      f.authority.revoke("policy");
    },
  });
  expect(await delivery.deliver(f.intent, f.grant)).toMatchObject({
    state: "refused",
    cleanupConfirmed: true,
  });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.worker.stop).toHaveBeenCalledTimes(1);
  expect(f.owner.restore).toHaveBeenCalledTimes(1);
});

it("retains failed worker join even after provider call and room cleanup", async () => {
  const f = fixture(),
    delivery = f.create();
  f.setJoin(false);
  expect(await delivery.deliver(f.intent, f.grant)).toMatchObject({
    state: "unknown",
    cleanupConfirmed: false,
  });
  expect(f.owner.restore).not.toHaveBeenCalled();
  expect(f.worker.stop).toHaveBeenCalledTimes(1);
  expect(
    f.coordinator.transport.get(f.grant.attemptId, "worker_stop")?.state,
  ).toBe("unknown");
  expect(
    existsSync(f.launch.mock.calls[0]![0].env.CLAWDTIME_PROACTIVE_CONFIG!),
  ).toBe(true);
});

it("refuses changed protected source before any ownership or worker effect", async () => {
  const f = fixture(),
    delivery = f.create();
  writeFileSync(join(f.config.lineDirectory, "agent.mjs"), "changed source");
  expect(await delivery.readiness(f.intent)).toMatchObject({
    ready: false,
    reason: "production_source_changed",
  });
  expect(f.events).toEqual([]);
});

it("rechecks worker liveness after room inspection and never dials a dead prepared worker", async () => {
  const f = fixture(),
    delivery = f.create();
  let inspected = 0;
  const read = f.roomService.listParticipants.getMockImplementation()!;
  f.roomService.listParticipants.mockImplementation(async () => {
    const result = await read();
    if (++inspected > 1) f.setAlive(false);
    return result;
  });
  expect(await delivery.deliver(f.intent, f.grant)).toMatchObject({
    state: "refused",
    cleanupConfirmed: true,
  });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.owner.restore).toHaveBeenCalledTimes(1);
});

it.each(["environment", "configuration", "native"] as const)(
  "rejects changed protected %s before handoff or media effects",
  async (kind) => {
    const f = fixture(),
      delivery = f.create();
    expect(await delivery.probe()).toMatchObject({ ready: true });
    if (kind === "environment")
      writeFileSync(
        f.config.lineEnvironmentFile,
        readFileSync(f.config.lineEnvironmentFile, "utf8") +
          "CLAWDTIME_LINE_VOICE=changed\n",
      );
    if (kind === "configuration")
      writeFileSync(
        f.configFile,
        JSON.stringify({ ...f.config, workerPort: 13430 }),
      );
    if (kind === "native")
      writeFileSync(
        f.config.providerConfigFile,
        JSON.stringify({
          ...f.native,
          projectKey: "rotated-native-project-key",
        }),
      );
    expect(await delivery.readiness(f.intent)).toMatchObject({
      ready: false,
      reason: "production_source_changed",
    });
    await expect(delivery.deliver(f.intent, f.grant)).rejects.toThrow(
      "production_source_changed",
    );
    expect(f.owner.acquire).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  },
);

it("supplies the owner current protected connector credentials without caching expired authority", async () => {
  const f = fixture();
  let readCredential: (() => string) | undefined;
  const delivery = f.create({
    loadOwner: async (ownerConfig) => {
      readCredential = ownerConfig.getConnectorToken;
      return f.owner;
    },
  });
  expect(await delivery.probe()).toMatchObject({ ready: true });
  expect(readCredential?.()).toBe("synthetic-connector-credential");
  writeFileSync(
    f.config.connectorCredentialFile,
    JSON.stringify({
      access_token: "rotated-synthetic-connector-credential",
      expires_at: Date.now() + 60000,
    }),
  );
  expect(readCredential?.()).toBe("rotated-synthetic-connector-credential");
  expect(await delivery.probe()).toMatchObject({ ready: true });
  writeFileSync(
    f.config.connectorCredentialFile,
    JSON.stringify({
      access_token: "expired-synthetic-connector-credential",
      expires_at: 1,
    }),
  );
  expect(() => readCredential?.()).toThrow("credential_expired");
  expect(await delivery.probe()).toMatchObject({
    ready: false,
    reason: "production_connector_credential_expired",
  });
  expect(f.events).toEqual([]);
});

it("local Stop aborts pending media preparation before dial and joins its worker", async () => {
  const f = fixture(),
    delivery = f.create();
  const read = f.roomService.listParticipants.getMockImplementation()!;
  f.roomService.listParticipants.mockImplementation(async () => {
    await delivery.stop(f.intent);
    return read();
  });
  expect(await delivery.deliver(f.intent, f.grant)).toMatchObject({
    state: "refused",
    cleanupConfirmed: true,
  });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.worker.stop).toHaveBeenCalledTimes(1);
  expect(f.owner.restore).toHaveBeenCalledTimes(1);
});
