import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { ProactiveCallCoordinator } from "../src/attention/proactive-coordinator.js";
import { ProactivePolicyAuthority } from "../src/attention/proactive-policy.js";
import {
  ProactiveSourceAdapter,
  requestedWatchChannel,
} from "../connectors/agents/proactive.js";
import {
  ProactiveSessions,
  ScopedSupervision,
  sessionKey,
} from "../connectors/agents/proactive-sessions.js";
import { SessionNews } from "../connectors/agents/sessionnews.js";
import { ChatLog } from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { JobReviews } from "../connectors/agents/job-review.js";
import type { JobFacts } from "../connectors/agents/jobs.js";
import type { AgentSession } from "../connectors/agents/types.js";

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-proactive-connectors-"));
  roots.push(root);
  let now = 1000;
  const clock = () => now;
  const store = new Store(":memory:");
  stores.push(store);
  const vault = new Vault("ab".repeat(32));
  const authority = new ProactivePolicyAuthority(store, vault, clock);
  const coordinator = new ProactiveCallCoordinator(
    store,
    vault,
    authority,
    clock,
  );
  authority.register({
    version: 2,
    id: "policy",
    scope: { personId: "person", deviceId: "device", projectRoot: "/fixture" },
    triggers: ["decision", "waiting", "failure", "completion", "review"],
    channels: ["phone_alert", "phone_walkthrough"],
    expiresAt: 100000,
    maxAttempts: 20,
    minIntervalMs: 0,
    attemptLifetimeMs: 10000,
    viewScope: ["presentation:result"],
    alertFallback: false,
    consent: {
      actorId: "person",
      recordedAt: 1000,
      source: "human_request",
      statement: "Call me about this project.",
    },
  });
  const make = () =>
    new ProactiveSourceAdapter({ root, coordinator, authority, now: clock });
  const adapter = make();
  const session: AgentSession = {
    id: "100-run",
    pid: 100,
    agent: "claude-code",
    agentLabel: "Claude Code",
    agentVersion: null,
    name: "fixture",
    project: "fixture",
    cwd: "/fixture",
    mode: "interactive",
    state: "working",
    detail: "turn_running",
    since: 1000,
    source: "hook",
    startedAt: 900,
    spawnedBy: null,
    terminal: {
      tty: null,
      app: null,
      appPath: null,
      tmux: null,
      remote: false,
    },
    focus: "none",
  };
  const hook = (event: string) =>
    adapter.sessions.observe(
      "claude-code",
      { session_id: "raw-session", cwd: "/fixture", hook_event_name: event },
      now,
      [100],
    );
  const pump = (a = adapter) =>
    a.pump({ pending: [], incidents: [], sessions: [session], away: false });
  return {
    root,
    clock,
    coordinator,
    authority,
    adapter,
    make,
    session,
    hook,
    pump,
    time: (n: number) => (now = n),
  };
}

describe("exact-channel proactive source integration", () => {
  it("retains a short completion phone watch across restart without chat consuming it", () => {
    const f = fixture();
    f.hook("UserPromptSubmit");
    const log = new ChatLog(f.root);
    const news = new SessionNews(f.root, {
      board: () => null,
      log,
      now: f.clock,
      proactive: f.adapter,
    });
    expect(news.watch(f.session, { channel: "phone_alert" }).ok).toBe(true);
    expect(news.tell()).toEqual([]);
    f.time(2000);
    f.hook("Stop");
    f.pump(f.make());
    f.pump(f.make());
    expect(f.coordinator.list()).toHaveLength(1);
    expect(f.coordinator.list()[0]).toMatchObject({
      channel: "phone_alert",
      trigger: "completion",
      state: "queued",
    });
    expect(log.recent()).toEqual([]);
  });
  it("keeps legacy chat watches chat-only and parses channels from human words", () => {
    const f = fixture();
    mkdirSync(join(f.root, "agents"), { recursive: true });
    writeFileSync(
      join(f.root, "agents", "chat-watches.json"),
      JSON.stringify({
        version: 1,
        watches: [
          {
            sessionId: f.session.id,
            title: "fixture",
            askedAt: 1000,
            quiet: null,
          },
        ],
      }),
    );
    expect(requestedWatchChannel("call me when fixture finishes")).toBe(
      "phone_alert",
    );
    expect(
      requestedWatchChannel(
        "call me and show the screen when fixture finishes",
      ),
    ).toBe("phone_walkthrough");
    expect(requestedWatchChannel("tell me here when fixture finishes")).toBe(
      "chat",
    );
    f.hook("UserPromptSubmit");
    f.time(2000);
    f.hook("Stop");
    f.pump();
    expect(f.coordinator.list()).toEqual([]);
  });
  it("retains an unsupported phone request visibly instead of changing it to chat", () => {
    const f = fixture();
    expect(f.adapter.watch(f.session, "phone_walkthrough").said).toContain(
      "needs setup",
    );
    expect(f.make().watches()[0]).toMatchObject({
      channel: "phone_walkthrough",
      state: "needs_setup",
      runId: null,
    });
    f.pump();
    expect(f.coordinator.list()).toEqual([]);
  });
  it("does not treat board idle, missing process, timeout, or a new run as completion", () => {
    const f = fixture();
    f.hook("UserPromptSubmit");
    f.adapter.watch(f.session, "phone_alert");
    f.session.state = "idle";
    f.session.detail = "turn_complete";
    f.pump();
    expect(f.coordinator.list()).toEqual([]);
    f.time(2000);
    f.hook("UserPromptSubmit");
    f.hook("Stop");
    f.pump();
    expect(f.coordinator.list()).toEqual([]);
    expect(f.adapter.watches()[0]?.state).toBe("canceled");
  });
  it("cancels an unsent completion call when explicitly unwatched", () => {
    const f = fixture();
    f.hook("UserPromptSubmit");
    f.adapter.watch(f.session, "phone_alert");
    f.time(2000);
    f.hook("Stop");
    f.pump();
    expect(f.adapter.unwatch(f.session)).toBe(true);
    expect(f.coordinator.list()[0]?.state).toBe("canceled");
  });
  it("keeps task-scoped hook attendance with Away off and releases it on revoke or heartbeat loss", () => {
    const f = fixture();
    f.hook("UserPromptSubmit");
    f.adapter.enroll({
      policyId: "policy",
      projectRoot: "/fixture",
      sessionKey: sessionKey("raw-session"),
      expiresAt: 90000,
    });
    const supervision = new ScopedSupervision(f.root, f.clock);
    expect(
      supervision.match("/fixture", sessionKey("raw-session")),
    ).not.toBeNull();
    expect(supervision.match("/other", sessionKey("raw-session"))).toBeNull();
    f.time(8000);
    expect(supervision.match("/fixture", sessionKey("raw-session"))).toBeNull();
    f.adapter.heartbeat();
    expect(
      supervision.match("/fixture", sessionKey("raw-session")),
    ).not.toBeNull();
    f.authority.revoke("policy");
    f.adapter.heartbeat();
    expect(supervision.match("/fixture", sessionKey("raw-session"))).toBeNull();
  });
  it("a project policy supervises two distinct launched runs without overwriting either", () => {
    const f = fixture();
    f.adapter.beforeLaunch({
      jobId: "one",
      runId: "one",
      launchId: "launch-one",
      projectRoot: "/fixture",
      agent: "claude",
    });
    f.adapter.beforeLaunch({
      jobId: "two",
      runId: "two",
      launchId: "launch-two",
      projectRoot: "/fixture",
      agent: "claude",
    });
    expect(
      f.adapter.supervision.match("/fixture", "session", "one"),
    ).not.toBeNull();
    expect(
      f.adapter.supervision.match("/fixture", "session", "two"),
    ).not.toBeNull();
    expect(
      f.adapter.supervision.match("/fixture", "session", "three"),
    ).toBeNull();
  });
  it("prioritizes an exact scoped decision and cancels it after local resolution", () => {
    const f = fixture();
    f.hook("UserPromptSubmit");
    f.adapter.enroll({
      policyId: "policy",
      projectRoot: "/fixture",
      sessionKey: sessionKey("raw-session"),
      expiresAt: 90000,
    });
    const desk = new DecisionDesk(f.root, f.clock);
    const request = desk.open({
      agent: "claude-code",
      sessionId: "raw-session",
      cwd: "/fixture",
      pids: [100],
      described: {
        kind: "permission",
        tool: "Bash",
        summary: "Run a check",
        options: [],
      },
      holdSeconds: 45,
    });
    f.adapter.pump({
      pending: [request],
      incidents: [],
      sessions: [f.session],
      away: false,
    });
    const intent = f.coordinator.list()[0]!;
    expect(intent.source).toMatchObject({
      kind: "decision",
      decisionId: request.id,
    });
    expect(f.adapter.validate(intent, [request])).toBe(true);
    f.pump();
    expect(f.coordinator.list()[0]?.state).toBe("canceled");
    expect(f.adapter.validate(intent, [])).toBe(false);
  });
});

describe("independent external Claude Job review", () => {
  it("requires launch provenance and terminal receipt before checks, and invalidates a changed result", async () => {
    const f = fixture();
    let calls = 0;
    const job: JobFacts = {
      id: "job",
      job: "Create fixture",
      startedAt: 1000,
      done: true,
      result: "An answer",
      provenance: {
        version: 1,
        runId: "job-run",
        launchId: "launch",
        agent: "claude",
        projectRoot: "/fixture",
        launcherPid: 100,
        exitCode: null,
        resultDigest: "ab".repeat(32),
      },
    };
    const reviews = new JobReviews({
      root: f.root,
      projectRoot: "/fixture",
      plan: [{ name: "check", command: ["test"] }],
      authorize: () => {},
      jobs: () => [job],
      verify: async () => {
        calls++;
        job.provenance!.resultDigest = "cd".repeat(32);
        return {
          id: "verification",
          runId: "job-run",
          state: "passed",
          checks: [],
          completedAt: 2000,
        };
      },
    });
    await reviews.pump();
    expect(calls).toBe(0);
    job.provenance!.exitCode = 0;
    await reviews.pump();
    expect(calls).toBe(1);
    job.provenance!.resultDigest = "ab".repeat(32);
    expect(reviews.get(job)?.state).toBe("invalidated");
    await reviews.pump();
    expect(calls).toBe(1);
  });
  it("retains lost independent-check outcomes and never reruns the effect", async () => {
    const f = fixture();
    let calls = 0;
    const job: JobFacts = {
      id: "job",
      job: "Create fixture",
      startedAt: 1000,
      done: true,
      result: "An answer",
      provenance: {
        version: 1,
        runId: "job-run",
        launchId: "launch",
        agent: "claude",
        projectRoot: "/fixture",
        launcherPid: 100,
        exitCode: 0,
        resultDigest: "ab".repeat(32),
      },
    };
    const reviews = new JobReviews({
      root: f.root,
      projectRoot: "/fixture",
      plan: [{ name: "check", command: ["test"] }],
      authorize: () => {},
      jobs: () => [job],
      verify: async () => {
        calls++;
        throw new Error("lost");
      },
    });
    await reviews.pump();
    await reviews.pump();
    expect(calls).toBe(1);
    expect(reviews.get(job)?.state).toBe("unknown");
  });
});

it("uses registered headless launch/exit receipts for a missing-result failure and reports exact evidence", () => {
  const f = fixture();
  const job: JobFacts = {
    id: "headless-job",
    job: "Run a fixture",
    startedAt: 1000,
    done: false,
    result: null,
    status: "exited_without_result",
    provenance: {
      version: 1,
      launchId: "launch",
      runId: "run",
      projectRoot: "/fixture",
      agent: "claude",
      launcherPid: 100,
      exitCode: 2,
      resultDigest: null,
    },
  };
  f.adapter.attachJobs(() => [job]);
  f.pump();
  f.pump();
  const intents = f.coordinator.list();
  expect(intents).toHaveLength(1);
  const intent = intents[0]!;
  expect(intent.source).toMatchObject({
    kind: "job",
    jobId: job.id,
    launchId: "launch",
  });
  expect(f.adapter.validate(intent, [])).toBe(true);
  expect(f.adapter.inspectSource(intent)).toMatchObject({
    current: true,
    status: "failed",
    views: [],
    checks: [],
  });
  job.provenance!.launchId = "new-launch";
  expect(f.adapter.validate(intent, [])).toBe(false);
});
