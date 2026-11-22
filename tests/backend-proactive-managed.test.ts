import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { Vault, hash } from "../src/storage/security.js";
import { TaskLedger, buildTaskBrief } from "../src/attention/task-ledger.js";
import { TaskVoiceLedger } from "../src/attention/task-voice-ledger.js";
import { ProactivePolicyAuthority } from "../src/attention/proactive-policy.js";
import { ProactiveCallCoordinator } from "../src/attention/proactive-coordinator.js";
import { TaskService } from "../src/control/task-service.js";
import { TaskEngine } from "../src/control/task-engine.js";
import {
  TaskReviewService,
  managedReviewTrigger,
} from "../src/control/task-review-service.js";
import { TaskVoiceService } from "../src/control/task-voice-service.js";
import {
  TaskDesktopCalls,
  type DesktopAttemptFactory,
  type DesktopHandsetAttempt,
} from "../src/control/task-desktop-calls.js";
import {
  desktopCallRequestSchema,
  type DesktopCallsConfig,
} from "../src/control/task-desktop-calls-config.js";
import {
  taskPresentationFingerprint,
  type TaskPresentationManifest,
} from "../src/task-presentation-contracts.js";
import type { ProactiveReviewPacket } from "../src/control/proactive-preparation.js";
import {
  NativeTaskAudioCalls,
  type NativeProactiveCallBinding,
} from "../src/transport/task-audio.js";
import type { TaskCommand } from "../src/contracts.js";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const digest = "ab".repeat(32),
  lineId = "00000000-0000-4000-8000-000000000001";
function fixture(question = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "managed-proactive-"))),
    project = join(root, "project"),
    privateDir = join(root, "private");
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(privateDir, { mode: 0o700 });
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(),
    vault = new Vault("cd".repeat(32));
  cleanup.push(() => store.close());
  store.put("pairing", {
    id: "pair",
    memberId: "person",
    deviceId: "device",
    createdAt: Date.now(),
  });
  const tasks = new TaskService(store, vault, new TaskLedger(store, vault), {
    projectRoots: [project],
    simulation: false,
  });
  const session = tasks.register({
    eventId: "session",
    pairingId: "pair",
    hostId: "host",
    projectRoot: project,
    voice: true,
  });
  let task = tasks.create(session.token, {
    eventId: "create",
    goal: "Prepare a fixture; do not deploy.",
  }).task;
  let event = 0;
  const command = (value: Record<string, unknown>) => {
    task = tasks.ledger.transition(session.session.id, task.id, {
      eventId: `change-${event++}`,
      expectedRevision: task.revision,
      ...value,
    } as TaskCommand).task;
    return task;
  };
  command({ action: "claim_run", runId: task.runs[0]!.id });
  command({
    action: "run_result",
    runId: task.runs[0]!.id,
    dispatchId: task.runs[0]!.dispatchId,
    outcome: "completed",
    summary: "Fixture completed.",
    ...(question
      ? { decision: "Which heading?", decisionOptions: ["One", "Two"] }
      : {}),
  });
  command({
    action: "verify_result",
    verification: {
      id: "verification",
      runId: task.runs[0]!.id,
      state: "passed",
      completedAt: Date.now(),
      checks: [
        {
          name: "fixture",
          command: ["synthetic"],
          state: "passed",
          exitCode: 0,
          summary: "Checked.",
        },
      ],
    },
  });
  const worker = vi.fn(async () => ({
    outcome: "completed" as const,
    summary: "Revised fixture.",
  }));
  const engine = new TaskEngine(
    tasks,
    { run: worker },
    [{ name: "synthetic", command: ["synthetic"] }],
    async (_p, r) => ({
      id: "next-verification",
      runId: r,
      state: "passed",
      completedAt: Date.now(),
      checks: [
        {
          name: "fixture",
          command: ["synthetic"],
          state: "passed",
          exitCode: 0,
          summary: "Checked.",
        },
      ],
    }),
  );
  cleanup.push(() => engine.close());
  const authority = new ProactivePolicyAuthority(store, vault),
    coordinator = new ProactiveCallCoordinator(store, vault, authority);
  authority.register({
    version: 2,
    id: "policy",
    scope: {
      personId: "person",
      deviceId: "device",
      projectRoot: project,
      sessionId: session.session.id,
    },
    triggers: ["review", "failure", "decision"],
    channels: ["phone_walkthrough"],
    expiresAt: Date.now() + 300000,
    maxAttempts: 4,
    minIntervalMs: 0,
    attemptLifetimeMs: 60000,
    viewScope: ["prepared-review"],
    alertFallback: false,
    consent: {
      actorId: "person",
      recordedAt: Date.now(),
      source: "human_request",
      statement: "Call with checked review.",
    },
  });
  const reviews = new TaskReviewService(tasks, session.token, engine, true);
  cleanup.push(() => reviews.close());
  reviews.configureProactive({
    coordinator,
    policyFor: () => ({
      policyId: "policy",
      channel: "phone_walkthrough",
      expiresAt: Date.now() + 120000,
    }),
  });
  const intent = coordinator.list()[0]!;
  coordinator.prepare(intent.id);
  coordinator.ready(intent.id, digest);
  const grant = coordinator.reserve(intent.id, {
    sourceCurrent: true,
    lineAvailable: true,
    packetFingerprint: digest,
  }).grant!;
  const brief = buildTaskBrief(task),
    now = Date.now();
  const manifest: TaskPresentationManifest = {
    version: 1,
    id: "presentation",
    sessionId: session.session.id,
    taskId: task.id,
    runId: task.runs[0]!.id,
    taskRevision: task.revision,
    verificationId: "verification",
    kind: brief.kind,
    opening: brief.opening,
    fps: 15,
    scenes: [
      {
        id: "result",
        kind: "preview",
        title: "Fixture",
        narration: brief.opening,
        expectedOutcome: "Fixture visible",
        target: {
          appId: "com.clawdtime.review-view",
          windowId: "7",
          ownerPid: 7,
          processIdentity: digest,
          displayId: 1,
          titleHash: digest,
        },
        focus: { x: 0, y: 0, width: 1, height: 1 },
        transitionMs: 550,
      },
    ],
  };
  const request = {
    version: 2 as const,
    policyAttempt: grant,
    eventId: "dispatch",
    taskId: task.id,
    runId: task.runs[0]!.id,
    expectedRevision: task.revision,
    authorizationId: grant.id,
    authorizedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    callDurationMs: 30000,
    standby: { deploymentId: lineId, restoreRecord: "synthetic" },
    prepared: {
      manifest,
      grant: {
        version: 1 as const,
        id: "view-grant",
        manifestFingerprint: taskPresentationFingerprint(manifest),
        sessionId: session.session.id,
        taskId: task.id,
        runId: manifest.runId,
        taskRevision: task.revision,
        hostId: "host",
        authorizedAt: now,
        expiresAt: now + 120000,
        localOnly: true as const,
        capture: true as const,
        presentation: true as const,
        control: false as const,
        nativeActivation: false as const,
        calls: false as const,
        continuity: "call" as const,
      },
    },
  };
  const packet: ProactiveReviewPacket = {
    id: intent.id,
    version: 1,
    intentId: intent.id,
    source: intent.source,
    sourceFingerprint: digest,
    policyId: "policy",
    policyRevision: 1,
    channel: "phone_walkthrough",
    goal: task.goal,
    status: "verified",
    summary: "Fixture completed.",
    choices: [],
    checks: [],
    artifacts: [],
    narration: brief.opening,
    views: [
      {
        id: "result",
        scope: "prepared-review",
        windowId: "7",
        title: "Fixture",
        sourceFingerprint: digest,
        frameObservedAt: now,
      },
    ],
    walkthroughOrder: ["result"],
    createdAt: now,
    expiresAt: now + 5000,
    fingerprint: digest,
  };
  const file = (name: string) => {
    const path = join(privateDir, name);
    writeFileSync(path, "{}", { mode: 0o600 });
    return path;
  };
  const config: DesktopCallsConfig = {
    version: 1,
    providerFile: file("provider"),
    livekitFile: file("livekit"),
    inspectorBundle: file("inspector"),
    python: file("python"),
    helperBinary: file("helper"),
    attemptRoot: join(privateDir, "attempts"),
    native: {
      callsOrigin: "https://example.invalid",
      projectId: "project",
      projectKey: "synthetic-protected-key",
      recipient: "synthetic",
      lineId,
    },
    destination: {
      pairingId: "pair",
      memberId: "person",
      deviceId: "device",
      lineId,
      recipientHash: hash("synthetic"),
    },
    railway: {
      binary: file("railway"),
      projectId: lineId,
      environmentId: lineId,
      backendServiceId: lineId,
    },
  };
  mkdirSync(config.attemptRoot, { mode: 0o700 });
  const voices = new TaskVoiceLedger(store, vault, tasks.ledger),
    voice = new TaskVoiceService(tasks, voices, engine);
  const factory = vi.fn<DesktopAttemptFactory>(async (_c, _p, owner) => {
    owner.policy?.assertCurrent("initial");
    return {
      start: async () => {},
      stop: async () => {},
      finished: Promise.resolve({ cleanupConfirmed: true }),
      status: () => ({ connectedOnce: true }),
      controls: {
        snapshot: () => ({
          controlId: owner.attemptId,
          callActive: false,
          sharingActive: false,
          canStopCall: false,
          canStopSharing: false,
        }),
      },
    } as unknown as DesktopHandsetAttempt;
  });
  const calls = new TaskDesktopCalls(
    tasks,
    engine,
    voices,
    voice,
    {
      config,
      configPath: file("config"),
      stateDirectory: privateDir,
      projectRoot: project,
      sessionPath: file("session"),
      sessionToken: session.token,
      checksPath: file("checks"),
      operatorToken: "synthetic-operator",
    },
    factory,
  );
  calls.proactive = { coordinator, packet: () => packet };
  calls.selectedTaskId = () => "a-different-selected-task";
  return {
    store,
    tasks,
    session,
    task,
    command,
    engine,
    worker,
    authority,
    coordinator,
    reviews,
    intent,
    grant,
    manifest,
    request,
    packet,
    calls,
    factory,
  };
}

describe("managed policy callbacks", () => {
  it("distinguishes explicit task questions from failure fallback questions", () => {
    const f = fixture(true);
    expect(f.intent.trigger).toBe("decision");
    expect(f.intent.source.decisionId).toBe(f.task.decision?.id);
    expect(f.reviews.proactiveEvidence(f.intent)).toMatchObject({
      status: "decision",
      question: "Which heading?",
      choices: ["One", "Two"],
    });
    const failed = structuredClone(f.task);
    delete failed.runs.at(-1)!.decision;
    failed.runs.at(-1)!.state = "failed";
    expect(managedReviewTrigger(failed)).toBe("failure");
  });
  it("enrolls checked managed results in the common queue and keeps legacy delivery idle", async () => {
    const f = fixture(),
      delivery = vi.fn();
    f.reviews.configureDelivery({ request: delivery });
    await f.reviews.pump();
    expect(delivery).not.toHaveBeenCalled();
    expect(f.reviews.proactiveEvidence(f.intent)).toMatchObject({
      current: true,
      status: "verified",
    });
    expect(f.coordinator.list()).toHaveLength(1);
  });
  it("admits the exact policy task without changing panel selection and preserves version2 provenance", async () => {
    const f = fixture(),
      result = f.calls.requestPolicy(f.request);
    expect(result.attempt.attemptId).toBe(f.grant.attemptId);
    await expect(
      f.calls.waitForAttempt(f.grant.attemptId),
    ).resolves.toMatchObject({ state: "ended", cleanupConfirmed: true });
    expect(f.factory).toHaveBeenCalledTimes(1);
    const [config, , owner] = f.factory.mock.calls[0]!;
    expect(config.authorization).toMatchObject({
      version: 2,
      policyAttempt: { id: f.grant.id },
    });
    expect(config.authorization).not.toHaveProperty("userAuthorizedOneCall");
    expect(owner.policy?.grant).toEqual(f.grant);
    expect(f.calls.selectedTaskId?.()).toBe("a-different-selected-task");
    expect(f.calls.requestPolicy(f.request).replayed).toBe(true);
    expect(() =>
      f.calls.requestPolicy({ ...f.request, eventId: "redial" }),
    ).toThrow();
    expect(f.coordinator.get(f.intent.id).state).toBe("ended");
  });
  it("keeps manual selection checks and rejects fake legacy upgrades", () => {
    const f = fixture();
    const { version: _v, policyAttempt: _p, ...base } = f.request;
    const manual = {
      ...base,
      userAuthorizedOneCall: true,
      userAuthorizedPreparedWindowExport: true,
      userAuthorizedTaskInstructions: true,
    };
    expect(() => f.calls.request(manual)).toThrow(/Shared phone ownership/);
    f.calls.proactive = undefined;
    expect(() => f.calls.request(manual)).toThrow(/selected/);
    expect(() =>
      desktopCallRequestSchema.parse({
        ...f.request,
        userAuthorizedOneCall: true,
      }),
    ).toThrow();
  });
  it.each([
    "revoked",
    "wrong-window",
    "wrong-app",
    "stale-frame",
    "wrong-result",
  ])("fences %s before native dispatch", (reason) => {
    const f = fixture();
    if (reason === "revoked") f.authority.revoke("policy");
    if (reason === "wrong-window") f.packet.views[0]!.windowId = "8";
    if (reason === "wrong-app")
      f.request.prepared.manifest.scenes[0]!.target.appId = "arbitrary.app";
    if (reason === "stale-frame") f.packet.expiresAt = 0;
    if (reason === "wrong-result")
      f.packet.source = { ...f.intent.source, runId: "wrong" };
    expect(() => f.calls.requestPolicy(f.request)).toThrow();
    expect(f.factory).not.toHaveBeenCalled();
  });
  it("keeps allowed sharing on revision while invalidating exact-result answer claims", async () => {
    const f = fixture();
    let finish!: (value: { cleanupConfirmed: true }) => void;
    const finished = new Promise<{ cleanupConfirmed: true }>((resolve) => {
      finish = resolve;
    });
    const original = f.factory.getMockImplementation()!;
    f.factory.mockImplementation(async (...args) => ({
      ...(await original(...args)),
      finished,
    }));
    f.calls.requestPolicy(f.request);
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalledTimes(1));
    const owner = f.factory.mock.calls[0]![2];
    f.command({
      action: "decide",
      runId: f.task.runs[0]!.id,
      instruction: "Change heading",
    });
    expect(() => owner.policy!.assertCurrent("ongoing")).not.toThrow();
    expect(() => owner.policy!.assertCurrent("initial")).toThrow(
      /no longer current/,
    );
    expect(() =>
      f.reviews.applyProactiveAnswer(
        f.intent,
        "I accept this result",
        "answer",
      ),
    ).toThrow();
    f.authority.revoke("policy");
    expect(() => owner.policy!.assertCurrent("ongoing")).toThrow();
    finish({ cleanupConfirmed: true });
    await f.calls.waitForAttempt(f.grant.attemptId);
  });
  it("accepts only explicit exact-current results and keeps native work permissions", async () => {
    const f = fixture();
    f.coordinator.outcome(f.intent.id, f.grant.attemptId, "connected");
    expect(
      f.reviews.applyProactiveAnswer(f.intent, "maybe, thanks", "ambiguous")
        .status,
    ).toBe("clarification_required");
    expect(f.tasks.ledger.get(f.session.session.id, f.task.id).state).toBe(
      "review_ready",
    );
    const answer = f.reviews.applyProactiveAnswer(
      f.intent,
      "I accept this result",
      "accept",
    );
    expect(answer.status).toBe("accepted");
    expect(answer.message).toContain("separate action");
    expect(
      f.reviews.applyProactiveAnswer(
        f.intent,
        "I accept this result",
        "accept",
      ),
    ).toEqual(answer);
    expect(f.worker).not.toHaveBeenCalled();
  });
  it("routes explicit revisions once into the same worker and rejects stale answers", async () => {
    const f = fixture();
    f.coordinator.outcome(f.intent.id, f.grant.attemptId, "connected");
    expect(
      f.reviews.applyProactiveAnswer(
        f.intent,
        "Change the heading to Draft",
        "revise",
      ).status,
    ).toBe("continued");
    await f.engine.wait(f.task.id);
    expect(f.worker).toHaveBeenCalledTimes(1);
    expect(
      f.tasks.ledger.get(f.session.session.id, f.task.id).runs.at(-1)
        ?.instruction,
    ).toBe("Change the heading to Draft");
    expect(() =>
      f.reviews.applyProactiveAnswer(f.intent, "I accept this result", "stale"),
    ).toThrow(/no longer matches/);
    f.reviews.applyProactiveAnswer(
      f.intent,
      "Change the heading to Draft",
      "revise",
    );
    expect(f.worker).toHaveBeenCalledTimes(1);
  });
});

describe("generic proactive native Calls transport", () => {
  it("uses exact non-task bindings and never retries a lost submission", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("lost response"));
    const config = {
      callsOrigin: "https://calls.example.invalid",
      projectId: "fixture",
      projectKey: "synthetic-protected-key",
      recipient: "+15555550123",
      lineId,
    };
    const native = new NativeTaskAudioCalls(config, request);
    const binding: NativeProactiveCallBinding = {
      attemptId: "attempt",
      lineId,
      recipientHash: hash(config.recipient),
      agentIdentity: "outgoing",
      channel: "phone_walkthrough",
    };
    const credentials = {
      livekit_url: "wss://media.example.invalid",
      participant_token: "synthetic".repeat(10),
      remote_participant_identity: "outgoing",
    };
    await expect(
      native.createProactive(binding, credentials, "effect"),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body))).toMatchObject({
      media: { audio: true, video: true },
    });
    await expect(
      native.createProactive(
        { ...binding, recipientHash: digest },
        credentials,
        "wrong",
      ),
    ).rejects.toThrow(/destination/);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
