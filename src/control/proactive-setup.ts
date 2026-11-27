import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import { z } from "zod";
import { ProactiveCallCoordinator } from "../attention/proactive-coordinator.js";
import {
  ProactivePolicyAuthority,
  proactivePolicySchema,
} from "../attention/proactive-policy.js";
import type { ProactiveCallIntent } from "../attention/proactive-contracts.js";
import { ProactiveSourceAdapter } from "../../connectors/agents/proactive.js";
import { interpret, callCanApprove } from "../../connectors/agents/call.js";
import type { BoardFeed } from "../../connectors/agents/feed.js";
import { readDesktopPrivateJSON } from "./task-desktop-config.js";
import {
  ProactivePreparationService,
  type ProactiveSourceEvidence,
} from "./proactive-preparation.js";
import { ProactiveReviewViews } from "./proactive-views.js";
import { walkthroughArtifactSchema } from "./proactive-artifact.js";
import {
  ProactiveDisplayViews,
  sharedDisplayTargetSchema,
  displayViewScope,
} from "./proactive-display-views.js";
import {
  ProactiveService,
  type ProactiveDeliveryPort,
} from "./proactive-service.js";
import { ProactiveLineSessions } from "./proactive-line.js";
import { createProductionDelivery } from "./proactive-production.js";
import { hash, DomainError } from "../storage/security.js";
import type { TaskService } from "./task-service.js";
import {
  managedReviewTrigger,
  type TaskReviewService,
} from "./task-review-service.js";
import type {
  DesktopExecutionAuthority,
  DesktopExecutionSnapshot,
} from "./desktop-executor.js";
import type { PhoneDesktop } from "./phone-desktop.js";
import {
  validateVerificationPlan,
  type VerificationPlan,
} from "./task-verification.js";

const privatePath = z.string().startsWith("/").max(4096);
export const proactiveConfigSchema = z
  .object({
    version: z.literal(2),
    policies: z.array(proactivePolicySchema).max(64).default([]),
    jobChecksPath: privatePath.optional(),
    jobChecksByRunPath: privatePath.optional(),
    preparedViews: z
      .object({
        rendererBinary: privatePath,
        captureBinary: privatePath,
        directory: privatePath,
      })
      .strict()
      .optional(),
    sharedDisplay: z
      .object({
        captureBinary: privatePath,
        directory: privatePath,
        target: sharedDisplayTargetSchema,
        artifacts: z.array(walkthroughArtifactSchema).max(64).optional(),
      })
      .strict()
      .optional(),
    outbound: z
      .discriminatedUnion("provider", [
        // Historical refusal is retained; config cannot silently upgrade authority.
        z
          .object({
            provider: z.literal("chert-dev"),
            receiptRetention: z.literal("unsupported"),
          })
          .strict(),
        z
          .object({
            provider: z.literal("chert-dev-retained-v1"),
            configurationFile: privatePath,
          })
          .strict(),
      ])
      .optional(),
  })
  .strict()
  .refine(
    (value) => !(value.preparedViews && value.sharedDisplay),
    "Choose a review window or a display, not both.",
  );

/** A question of the computer worker on this Mac, as the line asks about it. */
export interface ProactiveComputerSource {
  evidence(intent: ProactiveCallIntent): ProactiveSourceEvidence;
  /** The owner's spoken words for that exact question. The answer is spoken back. */
  answer(intent: ProactiveCallIntent, words: string): Promise<string>;
  /** The owner asked on the call to stop the computer work. Stop only reduces control. */
  stop(intent: ProactiveCallIntent): void;
}

/**
 * The computer port of a walkthrough call with computer control. It runs the
 * caller's exact words on the native worker under the call's own phone lease,
 * so only this call's requests can use the shared screen.
 */
export function walkthroughComputer(deps: {
  phone: Pick<
    PhoneDesktop,
    "open" | "renew" | "run" | "stop" | "close" | "execution"
  >;
  /** The call still has computer control and owns the selected display. */
  owns(intent: ProactiveCallIntent): boolean;
  /** How long a request waits for an observed result or a question. */
  waitMs?: number;
  pollMs?: number;
}) {
  const { phone } = deps;
  const waitMs = deps.waitMs ?? 45000,
    pollMs = deps.pollMs ?? 200;
  const computerCalls = new Set<string>();
  // A spoken yes answers only the newest question that this call told the
  // caller, as a plain yes in the chat answers only the newest question the
  // owner saw. Per call: the question that its last reply said.
  const told = new Map<string, string>();
  const asks = (state: DesktopExecutionSnapshot) =>
    state.state === "waiting_for_person" && state.canStop;
  const question = (state: DesktopExecutionSnapshot) =>
    JSON.stringify([
      state.requestId ?? null,
      state.waiting ?? null,
      state.pendingAction?.id ?? null,
      state.message,
    ]);
  /** The reply the caller hears: it tells a waiting question when it says it. */
  const reply = (callId: string, message: string) => {
    const now = phone.execution.snapshot();
    if (!asks(now)) told.delete(callId);
    else if (now.message === message) told.set(callId, question(now));
    return message;
  };
  return {
    async submit(intent: ProactiveCallIntent, words: string, turnId: string) {
      const callId = intent.attemptId!;
      if (!deps.owns(intent))
        return "This call no longer owns the shared display. No action was sent.";
      phone.open(callId);
      computerCalls.add(callId);
      phone.renew(callId);
      // Provider speech identity, not model arguments, supplies these words.
      const requestId = `turn_${hash(turnId)}`;
      try {
        return await phone.run(callId, requestId, words, async () => {
          const before = phone.execution.snapshot();
          if (asks(before) && phone.execution.answer) {
            // A question that came after the caller's last words is told
            // now. These words answer nothing.
            if (told.get(callId) !== question(before)) {
              told.set(callId, question(before));
              return `This question came after your last words, so they did not answer it: ${before.message}`;
            }
            return reply(callId, (await phone.execution.answer(words)).message);
          }
          const result = await phone.execution.submit(requestId, words);
          if (result.message) return reply(callId, result.message);
          // Await observed completion or a question while independent
          // status heartbeats maintain the call lease. Never resubmit.
          const deadline = Date.now() + waitMs;
          while (Date.now() < deadline) {
            const state = phone.execution.snapshot();
            if (state.state !== "running" && state.state !== "queued")
              return reply(callId, state.message);
            await new Promise((resolve) => setTimeout(resolve, pollMs));
          }
          return reply(
            callId,
            phone.execution.snapshot().message ||
              "The computer request is still running; completion is not confirmed.",
          );
        });
      } catch (error) {
        if (
          error instanceof DomainError &&
          error.message === "phone_request_cancelled"
        )
          return "This call's computer request was stopped.";
        throw error;
      }
    },
    renew(intent: ProactiveCallIntent) {
      if (computerCalls.has(intent.attemptId!)) phone.renew(intent.attemptId!);
    },
    stop(intent: ProactiveCallIntent) {
      if (!computerCalls.has(intent.attemptId!))
        return "No computer work is owned by this call.";
      try {
        return phone.stop(intent.attemptId!).reply.text;
      } catch {
        // The call's lease ended, and its end already stopped the call's work.
        return "No computer work owned by this call is running. Coding jobs may continue.";
      }
    },
    close(intent: ProactiveCallIntent) {
      told.delete(intent.attemptId!);
      if (computerCalls.has(intent.attemptId!)) phone.close(intent.attemptId!);
    },
  };
}

/**
 * Who may use the screen of the native worker. A walkthrough call with
 * computer control uses it only through its own reserved phone requests.
 * Every other request waits while a call shares or may share the screen.
 * A call of the reach only talks, so it blocks nothing.
 */
export function walkthroughScreenGuard(deps: {
  phone?: Pick<PhoneDesktop, "ownsExecution">;
  permitsComputer(attemptId: string): boolean;
  viewOccupied(): boolean;
  intents(): ProactiveCallIntent[];
  voiceOnly(intent: ProactiveCallIntent): boolean;
}) {
  return (authority?: DesktopExecutionAuthority) =>
    (deps.phone?.ownsExecution(authority) === true &&
      !!authority &&
      deps.permitsComputer(authority.callId)) ||
    (!deps.viewOccupied() &&
      !deps
        .intents()
        .some(
          (i) =>
            ["dispatching", "connected", "unknown"].includes(i.state) &&
            !deps.voiceOnly(i),
        ));
}

export function createProactiveSetup(options: {
  tasks: TaskService;
  reviews: TaskReviewService;
  sessionToken: string;
  directory: string;
  root: string;
  projectRoot: string;
  origin?: string;
  board(): BoardFeed | undefined;
  execution(): DesktopExecutionSnapshot | undefined;
  phoneDesktop?: PhoneDesktop;
  /** Integration port for a provider with proved in-place receipt retention. */
  delivery?: ProactiveDeliveryPort;
}) {
  const { tasks } = options;
  const authority = new ProactivePolicyAuthority(tasks.store, tasks.vault);
  const coordinator = new ProactiveCallCoordinator(
    tasks.store,
    tasks.vault,
    authority,
  );
  const configPath = join(options.directory, "proactive.json");
  const config = existsSync(configPath)
    ? proactiveConfigSchema.parse(readDesktopPrivateJSON(configPath))
    : proactiveConfigSchema.parse({ version: 2 });
  const outside = (path: string) => {
    const part = relative(
      realpathSync(options.projectRoot),
      realpathSync(path),
    );
    if (
      !part ||
      (part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part))
    )
      throw Error(
        "Proactive configuration must remain outside the worker project.",
      );
  };
  if (existsSync(configPath)) outside(configPath);
  for (const policy of config.policies) {
    if (policy.scope.projectRoot !== options.projectRoot)
      throw Error("Calling policy belongs to another selected project.");
    // Restart never renews/revives a revoked policy from an old configuration file.
    if (!authority.get(policy.id)) authority.register(policy);
  }
  const plan = config.jobChecksPath
    ? (() => {
        outside(config.jobChecksPath);
        const value = readDesktopPrivateJSON(
          config.jobChecksPath,
        ) as VerificationPlan;
        validateVerificationPlan(value);
        return value;
      })()
    : undefined;
  const plansByRun = config.jobChecksByRunPath
    ? (() => {
        if (!plan) throw Error("Run checks require a default job check plan.");
        outside(config.jobChecksByRunPath);
        const value = z
          .record(z.string().uuid(), z.unknown())
          .parse(readDesktopPrivateJSON(config.jobChecksByRunPath)) as Record<
          string,
          VerificationPlan
        >;
        if (Object.keys(value).length > 64)
          throw Error("At most 64 run-specific check plans are allowed.");
        for (const checks of Object.values(value))
          validateVerificationPlan(checks);
        return value;
      })()
    : undefined;
  let views: ProactiveReviewViews | ProactiveDisplayViews | undefined;
  let production: ReturnType<typeof createProductionDelivery> | undefined;
  const assertIdle = () => {
    const execution = options.execution();
    if (
      execution &&
      [
        "queued",
        "running",
        "waiting_for_person",
        "stopping",
        "uncertain",
      ].includes(execution.state)
    )
      throw Error("Existing execution ownership is not idle.");
    if (coordinator.list().some((i) => i.state === "unknown"))
      throw Error("Retained phone uncertainty requires reconciliation.");
  };
  const viewRequests = (intent: ProactiveCallIntent) =>
    intent.channel === "phone_walkthrough" && config.sharedDisplay
      ? [
          {
            id: displayViewScope,
            scope: displayViewScope,
            title: "Mac display",
          },
        ]
      : intent.channel === "phone_walkthrough" && config.preparedViews
        ? [
            {
              id: "prepared-review",
              scope: "prepared-review",
              title: "Prepared review",
            },
          ]
        : [];
  const sources = new ProactiveSourceAdapter({
    root: options.root,
    coordinator,
    authority,
    views: viewRequests,
    ...(plan
      ? {
          jobVerification: {
            projectRoot: options.projectRoot,
            plan,
            ...(plansByRun ? { plansByRun } : {}),
            authorize: () => {
              assertIdle();
              if (views?.occupied)
                throw Error("Prepared capture owns execution.");
            },
          },
        }
      : {}),
  });
  options.reviews.configureProactive({
    coordinator,
    deliveryConfigured: () => !!options.delivery || !!production,
    policyFor(task) {
      // Simulation receipts are useful locally, but never authorize real calls.
      if (tasks.options.simulation) return;
      const session = tasks.authenticate(options.sessionToken);
      const trigger = managedReviewTrigger(task);
      const choices = authority
        .list()
        .filter(
          (p) =>
            !p.revokedAt &&
            p.expiresAt > Date.now() &&
            p.scope.personId === session.memberId &&
            p.scope.deviceId === session.deviceId &&
            p.scope.projectRoot === task.projectRoot &&
            (!p.scope.sessionId || p.scope.sessionId === task.sessionId) &&
            (!p.scope.taskId || p.scope.taskId === task.id) &&
            p.triggers.includes(trigger),
        );
      const exact = choices.filter((p) => p.scope.taskId === task.id);
      const selected = exact.length ? exact : choices;
      if (selected.length !== 1) return;
      const policy = selected[0]!;
      return {
        policyId: policy.id,
        channel: policy.channels.includes("phone_walkthrough")
          ? "phone_walkthrough"
          : "phone_alert",
        expiresAt: policy.expiresAt,
      };
    },
    viewEvidence: () => ({
      artifacts: [],
      views: config.sharedDisplay
        ? [
            {
              id: displayViewScope,
              scope: displayViewScope,
              title: "Mac display",
            },
          ]
        : config.preparedViews
          ? [
              {
                id: "prepared-review",
                scope: "prepared-review",
                title: "Prepared review",
              },
            ]
          : [],
    }),
  });
  // The computer worker attaches its questions after the setup is built.
  let computer: ProactiveComputerSource | undefined;
  const computerEvidence = (
    intent: ProactiveCallIntent,
  ): ProactiveSourceEvidence =>
    computer?.evidence(intent) ?? {
      current: false,
      sourceFingerprint: hash(JSON.stringify(intent.source)),
      goal: "A computer task on this Mac",
      status: "decision",
      summary: "The computer worker is not attached.",
      question: "The computer worker is not attached.",
      checks: [],
      artifacts: [],
      views: [],
    };
  const evidence = (intent: ProactiveCallIntent) =>
    intent.source.kind === "task"
      ? options.reviews.proactiveEvidence(intent)
      : intent.source.kind === "computer"
        ? computerEvidence(intent)
        : sources.inspectSource(intent);
  const current = (intent: ProactiveCallIntent) => {
    try {
      return evidence(intent).current;
    } catch {
      return false;
    }
  };
  if (config.preparedViews || config.sharedDisplay) {
    const viewConfig = (config.sharedDisplay ?? config.preparedViews)!;
    const binaries = [
      viewConfig.captureBinary,
      ...(config.preparedViews ? [config.preparedViews.rendererBinary] : []),
    ];
    for (const path of [...binaries, viewConfig.directory]) outside(path);
    for (const binary of binaries) {
      const stat = lstatSync(binary);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o022 ||
        !(stat.mode & 0o100)
      )
        throw Error("Protected prepared-view executable required.");
    }
    const state = lstatSync(viewConfig.directory);
    if (
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      state.uid !== process.getuid?.() ||
      state.mode & 0o077
    )
      throw Error("Private prepared-view directory required.");
    const viewPorts = {
      assertIdle,
      authorize(intent: ProactiveCallIntent) {
        const actual = coordinator.get(intent.id);
        const grant = actual.grantId
          ? authority.grant(actual.grantId)
          : undefined;
        if (
          !["preparing", "ready", "dispatching", "connected"].includes(
            actual.state,
          ) ||
          (grant
            ? !authority.validateGrant(grant)
            : !authority.inspect(actual).allowed || !current(actual))
        )
          throw Error("Prepared view authority is no longer current.");
      },
      evidence: async (intent: ProactiveCallIntent) => evidence(intent),
    };
    views = config.sharedDisplay
      ? new ProactiveDisplayViews(config.sharedDisplay, viewPorts)
      : new ProactiveReviewViews(config.preparedViews!, viewPorts);
  }
  const preparation = new ProactivePreparationService(
    tasks.store,
    tasks.vault,
    coordinator,
    {
      inspectSource: evidence,
      resolveViews: async (input) => {
        if (!views) throw Error("Prepared views are not configured.");
        return views.prepare(input);
      },
      releaseViews: async (id) => views?.release(id) ?? { confirmed: true },
    },
    Date.now,
    // Initial packet admission permits the bounded provider inventory checks.
    // Transport captures again after handoff/media startup and requires <=1s
    // actual frame age immediately before dialing and on every exported frame.
    5000,
  );
  const phone = options.phoneDesktop;
  const line = new ProactiveLineSessions(authority, {
    ...(phone && config.sharedDisplay
      ? {
          computer: walkthroughComputer({
            phone,
            owns: (intent) =>
              line.permitsComputer(intent.attemptId!) &&
              views instanceof ProactiveDisplayViews &&
              views.owns(intent.id),
          }),
        }
      : {}),
    sourceCurrent: current,
    async answer(intent, words, turnId) {
      if (/^(?:please\s+)?stop calling(?:\s+me)?[.!]?$/i.test(words.trim())) {
        authority.revoke(intent.policyId);
        for (const pending of coordinator.list())
          if (pending.policyId === intent.policyId)
            coordinator.cancel(pending.id, "stop_calling");
        return "Calling permission is revoked for this scope. Work remains under its existing permissions.";
      }
      if (intent.source.kind === "computer")
        return computer
          ? computer.answer(intent, words)
          : "That question no longer waits, so nothing was passed on.";
      if (intent.source.kind === "task")
        return options.reviews.applyProactiveAnswer(
          intent,
          words,
          `phone:${hash(`${intent.attemptId}:${turnId}`)}`,
        ).message;
      if (intent.source.kind === "decision") {
        const request = options
          .board()
          ?.pendingDecisions()
          .find((p) => p.id === intent.source.decisionId);
        if (!request || !current(intent))
          return "That request is no longer pending. No answer was applied.";
        const answer = interpret(words, request);
        if (!answer)
          return "Please give an unambiguous answer to the current question.";
        if (answer.decision === "allow" && !callCanApprove(request))
          return "This approval must be completed in the native terminal.";
        return options.board()?.applyProactiveAnswer(intent, answer)
          ? "The answer reached the exact waiting request. Continuation has not yet been observed."
          : "The request changed before the answer could be applied.";
      }
      return "This call reports the exact job result. It does not wake an idle coding chat or authorize more work. Start a revision through that job's supported session.";
    },
    stopSharing: async (intent) => {
      // A call about a computer question shares no screen. Its stop tool is
      // the owner's Stop for the computer work, while the call is open; the
      // end of the call itself stops nothing.
      if (
        intent.source.kind === "computer" &&
        intent.attemptId &&
        line.status(intent.attemptId)?.closed === false
      )
        computer?.stop(intent);
      return views?.release(intent.id) ?? { confirmed: true };
    },
    frame: async (intent) => views?.frame(intent) ?? null,
  });
  production =
    config.outbound?.provider === "chert-dev-retained-v1"
      ? (() => {
          outside(config.outbound.configurationFile);
          if (!options.origin)
            throw Error("Actual desktop service origin is required.");
          return createProductionDelivery(config.outbound.configurationFile, {
            projectRoot: options.projectRoot,
            origin: options.origin,
            coordinator,
            sessions: line,
            packet: (id) => preparation.packetSnapshot(id),
            current,
            sourceFingerprint: (intent) => evidence(intent).sourceFingerprint,
            freshFrame: async (intent) => views?.frame(intent) ?? null,
            cleanupViews: async (id) =>
              views?.release(id) ?? { confirmed: true },
          });
        })()
      : undefined;
  const delivery =
    options.delivery ??
    production ??
    (config.outbound
      ? {
          readiness: async () => ({
            ready: false,
            reason: "provider_journal_retention_unsupported",
          }),
          deliver: async () => ({
            state: "refused" as const,
            cleanupConfirmed: true,
            reason: "provider_journal_retention_unsupported",
          }),
        }
      : undefined);
  const service = new ProactiveService(coordinator, {
    sourceCurrent: current,
    delivery,
    preparation: {
      prepare: async (intent) => preparation.prepare(intent.id),
      current: async (intent, fingerprint) =>
        (await preparation.resolve(intent.id))?.fingerprint === fingerprint,
      release: async (id) => views?.release(id) ?? { confirmed: true },
    },
  });
  return {
    authority,
    coordinator,
    sources,
    preparation,
    service,
    line,
    /** Lets the line ask about questions of the computer worker, and pass its answers. */
    attachComputer(source: ProactiveComputerSource) {
      computer = source;
    },
    /** An outbound line that can place a call is configured. */
    deliveryConfigured: () => !!options.delivery || !!production,
    probe: () => production?.probe(),
    viewOccupied: () => views?.occupied ?? false,
    permitsComputer: (attemptId: string) => {
      const intent = coordinator.list().find((i) => i.attemptId === attemptId);
      return (
        !!intent &&
        intent.state === "connected" &&
        line.permitsComputer(attemptId) &&
        views instanceof ProactiveDisplayViews &&
        views.owns(intent.id)
      );
    },
    status: () => ({
      sources: sources.status(),
      provider: production
        ? production.diagnostics()
        : config.outbound
          ? {
              configured: true,
              ready: false,
              reason: "provider_journal_retention_unsupported",
            }
          : {
              configured: false,
              ready: false,
              reason: "outbound_setup_missing",
            },
    }),
    enroll(input: unknown) {
      sources.enroll(
        z
          .object({
            policyId: z.string().min(1).max(300),
            projectRoot: z.literal(options.projectRoot),
            sessionKey: z
              .string()
              .regex(/^[a-f0-9]{32}$/)
              .optional(),
            jobRunId: z.string().min(1).optional(),
            expiresAt: z.number().int().positive(),
            responseSeconds: z.number().int().min(20).max(540).optional(),
          })
          .strict()
          .parse(input),
      );
    },
  };
}
