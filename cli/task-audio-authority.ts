import { z } from "zod";
import type { TaskService } from "../src/control/task-service.js";
import type { TaskVoiceLedger } from "../src/attention/task-voice-ledger.js";
import { unresolvedTaskAudioCalls } from "../src/attention/task-audio-call.js";
import { DomainError } from "../src/storage/security.js";
import {
  taskAudioFingerprint,
  type TaskAudioAuthorization,
  type TaskAudioPlan,
} from "../src/transport/task-audio.js";

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
export const taskAudioAuthorityGrantSchema = z
  .object({
    taskSessionId: identity,
    taskId: identity,
    runId: identity,
    revision: z.number().int().nonnegative(),
    sourcePairingId: identity,
    projectRoot: z.string().min(1).max(4096),
    pairingId: identity,
    memberId: identity,
    deviceId: identity,
    lineId: z.string().uuid(),
    recipientHash: z.string().regex(/^[a-f0-9]{64}$/),
    planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    authId: identity,
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    audio: z.literal(true),
    video: z.literal(false),
    screen: z.literal(false),
    presentation: z.literal(false),
    control: z.literal(false),
    maxCalls: z.literal(1),
  })
  .strict();
export type TaskAudioAuthorityGrant = z.infer<
  typeof taskAudioAuthorityGrantSchema
>;

/** Read-only bridge: source ownership stays intact; fresh destination checks belong to readiness. */
export class TaskAudioAuthority {
  private readonly grant: Readonly<TaskAudioAuthorityGrant>;
  constructor(
    private readonly tasks: TaskService,
    private readonly voices: TaskVoiceLedger,
    grant: TaskAudioAuthorityGrant,
    private readonly clock: () => number = Date.now,
  ) {
    this.grant = Object.freeze(taskAudioAuthorityGrantSchema.parse(grant));
  }

  assert(plan: TaskAudioPlan, authorization: TaskAudioAuthorization): void {
    const grant = this.grant,
      now = this.clock();
    if (
      taskAudioFingerprint(plan) !== grant.planFingerprint ||
      authorization.id !== grant.authId ||
      authorization.planFingerprint !== grant.planFingerprint ||
      authorization.oneCallAuthorized !== true ||
      !Number.isFinite(authorization.authorizedAt) ||
      !Number.isFinite(authorization.expiresAt) ||
      authorization.authorizedAt > now ||
      authorization.expiresAt !== grant.expiresAt ||
      grant.expiresAt <= now ||
      authorization.expiresAt > authorization.authorizedAt + 300_000 ||
      plan.expiresAt <= now ||
      plan.expiresAt > grant.expiresAt ||
      plan.taskSessionId !== grant.taskSessionId ||
      plan.taskId !== grant.taskId ||
      plan.runId !== grant.runId ||
      plan.revision !== grant.revision ||
      plan.pairingId !== grant.pairingId ||
      plan.memberId !== grant.memberId ||
      plan.deviceId !== grant.deviceId ||
      plan.lineId !== grant.lineId ||
      plan.recipientHash !== grant.recipientHash
    )
      throw new DomainError(
        403,
        "Exact fresh delegated task audio authority is required.",
      );

    if (
      unresolvedTaskAudioCalls(this.tasks.store, this.tasks.vault).some(
        (call) => call.id !== plan.id,
      )
    )
      throw new DomainError(
        409,
        "Another handset call requires reconciliation.",
      );

    const session = this.tasks.session(grant.taskSessionId);
    const task = this.tasks.ledger.get(session.id, grant.taskId);
    const run = task.runs.at(-1);
    if (
      session.pairingId !== grant.sourcePairingId ||
      session.projectRoot !== grant.projectRoot ||
      task.projectRoot !== grant.projectRoot ||
      !session.permissions.voice ||
      session.permissions.presentation !== false ||
      session.permissions.control !== false ||
      task.revision !== grant.revision ||
      task.state !== "review_ready" ||
      run?.id !== grant.runId ||
      run.state !== "completed" ||
      run.cancelRequested ||
      run.decision ||
      task.verification?.runId !== grant.runId ||
      task.verification.state !== "passed" ||
      task.brief?.runId !== grant.runId ||
      task.brief.verificationId !== task.verification.id ||
      task.calls.some(
        (call) => !["ended", "unanswered"].includes(call.state),
      ) ||
      this.voices.heldForTask(task.id).length > 0
    )
      throw new DomainError(
        403,
        "Original verified task ownership is no longer current.",
      );

    const voice = this.voices.get(session.id, plan.voiceSessionId);
    if (
      voice.sessionId !== session.id ||
      voice.taskId !== task.id ||
      voice.mode !== "handset_audio_smoke" ||
      voice.instructionsAllowed !== false ||
      voice.callAttemptId !== plan.id ||
      voice.openedRunId !== grant.runId ||
      voice.openedRevision !== grant.revision ||
      voice.endedAt !== undefined ||
      voice.expiresAt <= now ||
      voice.permissions.screen !== false ||
      voice.permissions.presentation !== false ||
      voice.permissions.control !== false
    )
      throw new DomainError(
        403,
        "Exact active status-only handset voice authority is required.",
      );
  }
}
