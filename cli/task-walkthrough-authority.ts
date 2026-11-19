import { z } from "zod";
import type { TaskService } from "../src/control/task-service.js";
import type { TaskVoiceLedger } from "../src/attention/task-voice-ledger.js";
import { buildTaskBrief } from "../src/attention/task-ledger.js";
import { unresolvedTaskAudioCalls } from "../src/attention/task-audio-call.js";
import { DomainError } from "../src/storage/security.js";
import {
  taskPresentationManifestSchema,
  taskPresentationGrantSchema,
  taskPresentationFingerprint,
} from "../src/task-presentation-contracts.js";
import {
  taskWalkthroughPlanSchema,
  taskWalkthroughAuthorizationSchema,
  taskWalkthroughExportGrantSchema,
  taskWalkthroughFingerprint,
  type TaskWalkthroughPlan,
  type TaskWalkthroughAuthorization,
} from "../src/task-walkthrough-contracts.js";

const preparedSchema = z
  .object({
    manifest: taskPresentationManifestSchema,
    grant: taskPresentationGrantSchema,
    exportGrant: taskWalkthroughExportGrantSchema,
  })
  .strict();
export type PreparedWalkthroughAuthority = z.infer<typeof preparedSchema>;

/** Delegated export is separate from local capture and from audio-smoke authority. */
export class TaskWalkthroughAuthority {
  private readonly prepared: PreparedWalkthroughAuthority;
  constructor(
    private readonly tasks: TaskService,
    private readonly voices: TaskVoiceLedger,
    prepared: PreparedWalkthroughAuthority,
    private readonly clock: () => number = Date.now,
    private readonly connected: (plan: TaskWalkthroughPlan) => boolean = () =>
      false,
  ) {
    this.prepared = preparedSchema.parse(structuredClone(prepared));
  }

  private current(
    input: TaskWalkthroughPlan,
    raw: TaskWalkthroughAuthorization,
  ) {
    const plan = taskWalkthroughPlanSchema.parse(input);
    const authorization = taskWalkthroughAuthorizationSchema.parse(raw);
    const { manifest: m, grant: g, exportGrant: e } = this.prepared;
    const now = this.clock(),
      fingerprint = taskWalkthroughFingerprint(plan);
    const b = plan.presentationBinding;
    if (
      fingerprint !== e.planFingerprint ||
      authorization.planFingerprint !== fingerprint ||
      plan.exportGrantId !== e.id ||
      authorization.id !== e.authorizationId ||
      authorization.authorizedAt !== e.authorizedAt ||
      e.authorizedAt > now ||
      authorization.expiresAt !== e.dispatchExpiresAt ||
      plan.dispatchExpiresAt !== e.dispatchExpiresAt ||
      authorization.callExpiresAt !== e.expiresAt ||
      plan.expiresAt !== e.expiresAt ||
      e.expiresAt <= now ||
      plan.taskSessionId !== m.sessionId ||
      plan.taskId !== m.taskId ||
      plan.runId !== m.runId ||
      plan.revision !== m.taskRevision ||
      plan.callKind !== m.kind ||
      b.presentationId !== m.id ||
      b.manifestFingerprint !== taskPresentationFingerprint(m) ||
      b.verificationId !== m.verificationId ||
      b.presentationGrantId !== g.id ||
      g.manifestFingerprint !== b.manifestFingerprint ||
      g.sessionId !== m.sessionId ||
      g.taskId !== m.taskId ||
      g.runId !== m.runId ||
      g.taskRevision !== m.taskRevision ||
      b.hostId !== g.hostId ||
      b.captureDeviceId !== plan.deviceId
    )
      throw new DomainError(
        403,
        "Exact explicit walkthrough export authority is required.",
      );

    const unresolved = unresolvedTaskAudioCalls(
      this.tasks.store,
      this.tasks.vault,
    );
    if (
      unresolved.some(
        (call) =>
          call.id !== plan.id || ["unknown", "stopping"].includes(call.state),
      )
    )
      throw new DomainError(
        409,
        "Another or unresolved handset call requires reconciliation.",
      );
    const session = this.tasks.session(m.sessionId);
    const task = this.tasks.ledger.get(session.id, m.taskId);
    const run = task.runs.at(-1);
    const original = task.runs.find((item) => item.id === m.runId);
    if (
      session.pairingId !== e.sourcePairingId ||
      session.projectRoot !== e.projectRoot ||
      task.projectRoot !== e.projectRoot ||
      session.hostId !== b.hostId ||
      !session.permissions.voice ||
      session.permissions.presentation !== false ||
      session.permissions.control !== false ||
      !run ||
      !original ||
      !["completed", "failed", "blocked"].includes(original.state) ||
      task.revision < m.taskRevision ||
      ["unknown", "canceled"].includes(task.state) ||
      task.verification?.state === "unknown" ||
      task.runs.some((r) => r.state === "unknown" || r.cancelRequested) ||
      task.calls.some((c) => !["ended", "unanswered"].includes(c.state))
    )
      throw new DomainError(
        403,
        "Original task ownership or known outcome is unavailable.",
      );
    const voice = this.voices.get(session.id, plan.voiceSessionId);
    if (
      voice.sessionId !== session.id ||
      voice.taskId !== task.id ||
      voice.mode !== "handset_walkthrough" ||
      voice.instructionsAllowed !== true ||
      voice.callAttemptId !== plan.id ||
      voice.exportGrantId !== e.id ||
      voice.presentationId !== m.id ||
      voice.manifestFingerprint !== b.manifestFingerprint ||
      voice.openedRunId !== m.runId ||
      voice.openedRevision !== m.taskRevision ||
      voice.opening !== m.opening ||
      voice.endedAt !== undefined ||
      voice.expiresAt <= now ||
      voice.permissions.screen !== true ||
      voice.permissions.presentation !== true ||
      voice.permissions.control !== false
    )
      throw new DomainError(
        403,
        "Exact active walkthrough voice authority is required.",
      );
    return { plan, task, run, now };
  }

  assertInitial(
    plan: TaskWalkthroughPlan,
    authorization: TaskWalkthroughAuthorization,
  ): void {
    const { task, run, now } = this.current(plan, authorization);
    const { manifest: m, grant: g, exportGrant: e } = this.prepared;
    if (
      e.dispatchExpiresAt <= now ||
      g.authorizedAt > now ||
      g.expiresAt <= now ||
      task.revision !== m.taskRevision ||
      run.id !== m.runId ||
      !["completed", "failed", "blocked"].includes(run.state) ||
      ![
        "needs_decision",
        "walkthrough_ready",
        "review_ready",
        "in_call",
        "review_call",
      ].includes(task.state) ||
      task.verification?.id !== m.verificationId ||
      task.verification.runId !== run.id ||
      task.verification.state === "unknown" ||
      !task.brief ||
      task.brief.runId !== run.id ||
      task.brief.verificationId !== m.verificationId ||
      this.voices.heldForTask(task.id).length
    )
      throw new DomainError(
        403,
        "Initial walkthrough requires its current verified prepared run.",
      );
    const brief = buildTaskBrief(task);
    if (
      brief.kind !== m.kind ||
      brief.opening !== m.opening ||
      (m.kind === "review" && task.verification.state !== "passed")
    )
      throw new DomainError(
        403,
        "Prepared opening differs from current verification.",
      );
  }

  /** A newer run invalidates prepared-result proof, not this connected conversation.
   * Continued capture separately requires an explicit call-scoped presentation grant.
   * connected is a trusted internal receipt check, never provider/model input.
   */
  assertOngoing(
    plan: TaskWalkthroughPlan,
    authorization: TaskWalkthroughAuthorization,
  ): void {
    const current = this.current(plan, authorization);
    if (!this.connected(current.plan))
      throw new DomainError(
        403,
        "An exact connected, unstopped walkthrough receipt is required.",
      );
  }
}
