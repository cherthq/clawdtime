import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { ProactivePolicyAuthority } from "../src/attention/proactive-policy.js";
import { ProactiveCallCoordinator } from "../src/attention/proactive-coordinator.js";
import {
  ProactivePreparationService,
  type ProactiveReviewPacket,
} from "../src/control/proactive-preparation.js";
import {
  ProactiveService,
  type ProactiveDeliveryPort,
} from "../src/control/proactive-service.js";
import { ProactiveLineSessions } from "../src/control/proactive-line.js";
import { ProactiveSourceAdapter } from "../connectors/agents/proactive.js";
import { sessionKey } from "../connectors/agents/proactive-sessions.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import { Jobs } from "../connectors/agents/jobs.js";
import { SessionNews } from "../connectors/agents/sessionnews.js";
import { ChatLog } from "../connectors/agents/brain.js";
import type { AgentSession } from "../connectors/agents/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(walkthrough = false) {
  const root = mkdtempSync(join(tmpdir(), "proactive-source-service-"));
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot);
  const store = new Store(join(root, "fixture.sqlite")),
    vault = new Vault("df".repeat(32));
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  let now = Date.now();
  const clock = () => now;
  const authority = new ProactivePolicyAuthority(store, vault, clock);
  const coordinator = new ProactiveCallCoordinator(
    store,
    vault,
    authority,
    clock,
  );
  authority.register({
    version: 2,
    id: "explicit-fixture-policy",
    scope: {
      personId: "fixture-person",
      deviceId: "fixture-device",
      projectRoot,
    },
    triggers: ["decision", "completion", "review", "failure"],
    channels: walkthrough ? ["phone_walkthrough"] : ["phone_alert"],
    expiresAt: now + 60000,
    maxAttempts: 5,
    minIntervalMs: 0,
    attemptLifetimeMs: 30000,
    viewScope: walkthrough ? ["fixture-result"] : [],
    alertFallback: false,
    consent: {
      actorId: "fixture-person",
      recordedAt: now,
      source: "operator",
      statement: "Synthetic fixture authorizes no external provider.",
    },
  });
  let checkAuthorizations = 0;
  const adapter = new ProactiveSourceAdapter({
    root,
    coordinator,
    authority,
    now: clock,
    views: () =>
      walkthrough
        ? [{ id: "review", scope: "fixture-result", title: "Synthetic review" }]
        : [],
    jobVerification: {
      projectRoot,
      plan: [
        {
          name: "independent fixture artifact check",
          command: [
            process.execPath,
            "-e",
            "const fs=require('node:fs');if(fs.readFileSync('artifact.txt','utf8')!=='expected fixture')process.exit(1);fs.appendFileSync('checked.txt','checked\\n')",
          ],
          timeoutMs: 1000,
        },
      ],
      authorize: () => {
        checkAuthorizations++;
      },
    },
  });
  const session = {
    id: "fixture-board-session",
    pid: 34567,
    agent: "claude-code",
    agentLabel: "Claude Code",
    agentVersion: null,
    name: "fixture",
    project: "fixture",
    cwd: projectRoot,
    mode: "interactive",
    state: "working",
    detail: "turn_running",
    since: now,
    source: "hook",
    startedAt: now,
    spawnedBy: null,
    terminal: {
      tty: null,
      app: null,
      appPath: null,
      tmux: null,
      remote: false,
    },
    focus: "none",
  } satisfies AgentSession;
  const hook = (event: string) =>
    adapter.sessions.observe(
      "claude-code",
      {
        session_id: "fixture-native-session",
        cwd: projectRoot,
        hook_event_name: event,
      },
      now,
      [session.pid],
    );
  const pumpSources = () =>
    adapter.pump({
      pending: [],
      incidents: [],
      sessions: [session],
      away: false,
    });
  const packets: ProactiveReviewPacket[] = [];
  let resolvedViews = 0;
  const preparation = new ProactivePreparationService(
    store,
    vault,
    coordinator,
    {
      inspectSource: (intent) => adapter.inspectSource(intent),
      resolveViews: async (input) => {
        resolvedViews++;
        expect(input.policy.viewScope).toContain("fixture-result");
        return input.requests.map((request) => ({
          ...request,
          windowId: "synthetic-authorized-window",
          sourceFingerprint: input.sourceFingerprint,
          frameObservedAt: clock(),
        }));
      },
      releaseViews: async () => ({ confirmed: true }),
    },
    clock,
    1000,
  );
  const scheduler = (
    onDeliver?: ProactiveDeliveryPort["deliver"],
    readiness: ProactiveDeliveryPort["readiness"] = async () => ({
      ready: true,
    }),
  ) => {
    const service = new ProactiveService(coordinator, {
      sourceCurrent: (intent) => adapter.inspectSource(intent).current,
      preparation: {
        prepare: (intent) => preparation.prepare(intent.id),
        current: async (intent, fingerprint) =>
          (await preparation.resolve(intent.id))?.fingerprint === fingerprint,
        release: async () => ({ confirmed: true }),
      },
      delivery: {
        readiness,
        deliver: async (intent, grant) => {
          expect(coordinator.get(intent.id)).toMatchObject({
            state: "dispatching",
            attemptId: grant.attemptId,
            grantId: grant.id,
          });
          expect(authority.validateGrant(grant)).toBe(true);
          const packet = preparation.packetSnapshot(intent.id)!;
          expect(packet.fingerprint).toBe(grant.packetFingerprint);
          packets.push(packet);
          return onDeliver
            ? onDeliver(intent, grant)
            : { state: "ended", cleanupConfirmed: true };
        },
      },
    });
    cleanups.push(() => service.close());
    return service;
  };
  return {
    root,
    projectRoot,
    adapter,
    coordinator,
    authority,
    clock,
    session,
    hook,
    pumpSources,
    preparation,
    packets,
    scheduler,
    tick: () => now++,
    viewCount: () => resolvedViews,
    checkCount: () => checkAuthorizations,
  };
}

it("carries a pending decision through preparation and exact phone answer, while local resolution cancels an unsent call", async () => {
  const f = fixture();
  f.hook("UserPromptSubmit");
  f.adapter.enroll({
    policyId: "explicit-fixture-policy",
    projectRoot: f.projectRoot,
    sessionKey: sessionKey("fixture-native-session"),
    expiresAt: f.clock() + 50000,
  });
  const board = new BoardFeed({
    root: f.root,
    proactive: f.adapter,
    now: f.clock,
    model: null,
    speech: null,
  });
  cleanups.push(() => board.close());
  const open = () =>
    board.desk.open({
      agent: "claude-code",
      sessionId: "fixture-native-session",
      cwd: f.projectRoot,
      pids: [f.session.pid],
      described: {
        kind: "permission",
        tool: "Bash",
        summary: "Inspect fixture",
        options: [],
      },
      holdSeconds: 45,
    });
  const request = open();
  board.pumpProactive();
  const line = new ProactiveLineSessions(
    f.authority,
    {
      sourceCurrent: (intent) =>
        f.adapter.validate(intent, board.pendingDecisions()),
      answer: async (intent, words) =>
        board.applyProactiveAnswer(intent, {
          decision: words === "no" ? "deny" : "allow",
          text: null,
        })
          ? "Exact request answered."
          : "No answer applied.",
      stopSharing: async () => ({ confirmed: true }),
    },
    f.clock,
  );
  const service = f.scheduler(async (intent, grant) => {
    const capability = line.open(
      intent,
      grant,
      f.preparation.packetSnapshot(intent.id)!,
      { roomName: "synthetic-room", agentIdentity: "synthetic-agent" },
    );
    const { token, version: _v, expiresAt: _e, ...binding } = capability;
    line.bindCaller(grant.attemptId, "synthetic-paired-human");
    await line.command(grant.attemptId, token, {
      action: "prepared",
      binding,
      media: { audioReady: true, videoReady: true },
    });
    const response = await line.command(grant.attemptId, token, {
      action: "answer",
      binding,
      callerIdentity: "synthetic-paired-human",
      turnId: "speech-turn-1",
      text: "no",
    });
    expect(response.message).toBe("Exact request answered.");
    expect(board.pendingDecisions()).toEqual([]);
    line.confirmClosed(grant.attemptId, {
      captureCleanupConfirmed: true,
      mediaClosed: true,
      providerEnded: true,
    });
    return { state: "ended", cleanupConfirmed: true };
  });
  await service.pump();
  expect(f.packets[0]).toMatchObject({
    channel: "phone_alert",
    status: "decision",
    source: { kind: "decision", decisionId: request.id },
  });
  f.tick();
  f.hook("UserPromptSubmit");
  const next = open();
  board.pumpProactive();
  expect(
    board.desk.answer(next.id, { decision: "deny", text: null, via: "panel" }),
  ).toBe(true);
  board.pumpProactive();
  await service.pump();
  expect(
    f.coordinator.list().find((intent) => intent.source.decisionId === next.id)
      ?.state,
  ).toBe("canceled");
  expect(f.packets).toHaveLength(1);
});

it("delivers a one-millisecond explicit completion as phone with truthful unverified narration and no chat consumption", async () => {
  const f = fixture();
  f.hook("UserPromptSubmit");
  const log = new ChatLog(f.root),
    news = new SessionNews(f.root, {
      board: () => null,
      log,
      now: f.clock,
      proactive: f.adapter,
    });
  expect(news.watch(f.session, { channel: "phone_alert" }).ok).toBe(true);
  f.tick();
  f.hook("Stop");
  f.pumpSources();
  await f.scheduler().pump();
  expect(f.packets).toHaveLength(1);
  expect(f.packets[0]).toMatchObject({
    channel: "phone_alert",
    status: "unverified",
    checks: [],
    source: { kind: "session" },
  });
  expect(f.packets[0]!.narration).toContain("not been independently verified");
  expect(f.coordinator.list()[0]?.state).toBe("ended");
  expect(news.tell()).toEqual([]);
  expect(log.recent()).toEqual([]);
});

it("uses actual Claude Jobs receipts and an executed independent check to prepare the exact authorized walkthrough", async () => {
  const f = fixture(true);
  let launchedScript = "";
  const jobs = new Jobs(f.root, {
    project: f.projectRoot,
    agent: "claude",
    now: f.clock,
    beforeLaunch: (input) => f.adapter.beforeLaunch(input),
    run: async (_command, args) => {
      launchedScript = args.at(-1)!;
      return { status: 0, stdout: "" };
    },
  });
  f.adapter.attachJobs(() => jobs.recent(50));
  expect((await jobs.start("Create a fixture artifact.")).ok).toBe(true);
  expect(readFileSync(launchedScript, "utf8")).toContain("exec claude");
  const jobDirectory = dirname(launchedScript);
  // Synthetic launcher receipts stand in for the CLI here; no agent or provider is launched.
  writeFileSync(
    join(jobDirectory, "launched.json"),
    JSON.stringify({ version: 1, pid: 34567 }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(jobDirectory, "exited.json"),
    JSON.stringify({ version: 1, exitCode: 0 }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(jobDirectory, "result.md"),
    "The fixture artifact is ready.",
    { mode: 0o600 },
  );
  writeFileSync(join(f.projectRoot, "artifact.txt"), "expected fixture");
  const original = jobs.recent(1)[0]!;
  f.pumpSources();
  await expect
    .poll(
      () => {
        f.pumpSources();
        return f.coordinator.list().length;
      },
      { timeout: 3000 },
    )
    .toBe(1);
  const service = f.scheduler();
  await service.pump();
  expect(f.packets).toHaveLength(1);
  expect(f.packets[0]).toMatchObject({
    channel: "phone_walkthrough",
    status: "verified",
    source: {
      kind: "job",
      jobId: original.id,
      runId: original.provenance!.runId,
      launchId: original.provenance!.launchId,
      resultDigest: original.provenance!.resultDigest,
    },
    checks: [{ name: "independent fixture artifact check", status: "passed" }],
    walkthroughOrder: ["review"],
  });
  expect(f.viewCount()).toBe(1);
  expect(f.checkCount()).toBeGreaterThan(0);
  expect(readFileSync(join(f.projectRoot, "checked.txt"), "utf8")).toBe(
    "checked\n",
  );
  await service.pump();
  expect(f.packets).toHaveLength(1);
});
