import { z } from "zod";
import type { TaskVoiceSession } from "../contracts.js";
import { TaskVoiceLedger } from "../attention/task-voice-ledger.js";
import { DomainError, hash, token } from "../storage/security.js";
import type { TaskService } from "./task-service.js";
import type { TaskEngine } from "./task-engine.js";
const identity = z.string().min(1).max(200);
interface Utterance {
  voiceSessionId: string;
  providerConversationId: string;
  utteranceId: string;
  runId: string;
  expectedRevision: number;
  text: string;
}

/** Only this boundary converts finalized remote speech into task instructions. */
export class TaskVoiceService {
  constructor(
    readonly tasks: TaskService,
    readonly ledger: TaskVoiceLedger,
    private engine?: TaskEngine,
  ) {
    tasks.beforeDecision = (taskId) => {
      if (ledger.heldForTask(taskId).length)
        throw new DomainError(
          409,
          "A finalized spoken instruction is waiting for this run's outcome.",
        );
    };
    engine?.onSettled((taskId) => {
      for (const receipt of ledger.heldForTask(taskId)) {
        const voice = this.voiceById(receipt.voiceSessionId);
        tasks.session(voice.sessionId); // Ending voice does not revoke an already admitted task instruction.
        const result = ledger.releaseHeld(voice.id, receipt.id);
        if (!result.replayed && result.receipt.state === "applied")
          engine.start(voice.sessionId, taskId);
      }
    });
  }
  open(raw: string, taskId: string, input: unknown) {
    const session = this.tasks.authenticate(raw);
    if (!session.permissions.voice)
      throw new DomainError(
        403,
        "Voice was not explicitly authorized for this task session.",
      );
    const value = z
      .object({
        eventId: identity,
        runId: identity,
        expectedRevision: z.number().int().nonnegative(),
      })
      .strict()
      .parse(input);
    return this.tasks.store.transaction(() => {
      const { voice } = this.ledger.open(session, { ...value, taskId });
      const key = `task-voice-token:${voice.id}`;
      const prior = this.tasks.store.state<{ sealed: string }>(key);
      if (prior)
        return { voice, token: this.tasks.vault.open<string>(prior.sealed) };
      const rawToken = token();
      this.tasks.store.put("task-voice-credential", {
        id: hash(rawToken),
        voiceId: voice.id,
        sessionId: session.id,
      });
      this.tasks.store.saveState(key, {
        sealed: this.tasks.vault.seal(rawToken),
      });
      return { voice, token: rawToken };
    });
  }
  private voiceById(voiceId: string): TaskVoiceSession {
    const credential = this.tasks.store
      .all<{ voiceId: string; sessionId: string }>("task-voice-credential")
      .find((c) => c.voiceId === voiceId);
    if (!credential) throw new DomainError(403, "Voice session unavailable.");
    return this.ledger.get(credential.sessionId, voiceId);
  }
  private authenticate(
    raw: string,
    taskId: string,
    voiceId: string,
    active = true,
  ) {
    if (raw.length < 32)
      throw new DomainError(401, "Voice credential required.");
    const credential = this.tasks.store.get<{
      voiceId: string;
      sessionId: string;
    }>("task-voice-credential", hash(raw));
    if (!credential || credential.voiceId !== voiceId)
      throw new DomainError(403, "Voice credential does not match.");
    const session = this.tasks.session(credential.sessionId);
    if (!session.permissions.voice)
      throw new DomainError(403, "Voice permission unavailable.");
    const voice = this.ledger.get(session.id, voiceId);
    if (
      voice.taskId !== taskId ||
      (active && (voice.endedAt !== undefined || voice.expiresAt <= Date.now()))
    )
      throw new DomainError(403, "Voice session stopped or expired.");
    return voice;
  }
  context(raw: string, taskId: string, voiceId: string) {
    const voice = this.authenticate(raw, taskId, voiceId, false);
    const task = this.tasks.ledger.get(voice.sessionId, taskId);
    const run = task.runs.at(-1)!;
    return {
      voiceSessionId: voice.id,
      mode: voice.mode,
      ...(voice.callAttemptId ? { callAttemptId: voice.callAttemptId } : {}),
      taskId,
      runId: run.id,
      revision: task.revision,
      sequence: task.revision,
      goal: task.goal,
      state: task.state,
      summary: run.summary ?? "",
      decision: task.decision?.question,
      verification: task.verification
        ? { state: task.verification.state, runId: task.verification.runId }
        : undefined,
      opening: voice.opening,
      openingRunId: voice.openedRunId,
      openingRevision: voice.openedRevision,
      active: voice.endedAt === undefined && voice.expiresAt > Date.now(),
      permissions: {
        ...voice.permissions,
        instructions:
          voice.mode === "local_audio" && voice.instructionsAllowed !== false,
      },
    };
  }
  bind(raw: string, taskId: string, voiceId: string, input: unknown) {
    this.authenticate(raw, taskId, voiceId);
    const value = z
      .object({ providerConversationId: identity })
      .strict()
      .parse(input);
    return this.ledger.bindProvider(voiceId, value.providerConversationId);
  }
  utterance(raw: string, taskId: string, voiceId: string, input: unknown) {
    const voice = this.authenticate(raw, taskId, voiceId);
    const value = z
      .object({
        providerConversationId: identity,
        utteranceId: identity,
        runId: identity,
        expectedRevision: z.number().int().nonnegative(),
        text: z.string().trim().min(1).max(8000),
      })
      .strict()
      .parse(input);
    if (
      !voice.providerConversationId ||
      voice.providerConversationId !== value.providerConversationId
    )
      throw new DomainError(403, "Provider conversation mismatch.");
    const key = `voice-utterance:${hash(`${voiceId}\0${value.utteranceId}`)}`;
    const utterance: Utterance = { ...value, voiceSessionId: voiceId };
    return this.tasks.store.transaction(() => {
      const prior = this.tasks.store.state<{ sealed: string }>(key);
      if (prior) {
        const original = this.tasks.vault.open<Utterance>(prior.sealed);
        if (JSON.stringify(original) !== JSON.stringify(utterance))
          throw new DomainError(409, "Finalized utterance conflicts.");
        return { utteranceId: value.utteranceId, replayed: true };
      }
      const task = this.tasks.ledger.get(voice.sessionId, taskId);
      if (
        task.runs.at(-1)!.id !== value.runId ||
        value.expectedRevision > task.revision ||
        value.expectedRevision < voice.openedRevision
      )
        throw new DomainError(409, "Utterance task context is stale.");
      const countKey = `voice-utterance-count:${voiceId}`;
      const count = this.tasks.store.state<number>(countKey) ?? 0;
      if (count >= 256)
        throw new DomainError(409, "Voice utterance limit reached.");
      this.tasks.store.saveState(key, {
        sealed: this.tasks.vault.seal(utterance),
      });
      this.tasks.store.saveState(countKey, count + 1);
      return { utteranceId: value.utteranceId, replayed: false };
    });
  }
  instruction(raw: string, taskId: string, voiceId: string, input: unknown) {
    const voice = this.authenticate(raw, taskId, voiceId);
    if (voice.mode !== "local_audio" || voice.instructionsAllowed === false)
      throw new DomainError(
        403,
        "This voice session permits status and end only.",
      );
    const value = z
      .object({ eventId: identity, utteranceId: identity })
      .strict()
      .parse(input);
    const saved = this.tasks.store.state<{ sealed: string }>(
      `voice-utterance:${hash(`${voiceId}\0${value.utteranceId}`)}`,
    );
    if (!saved)
      throw new DomainError(
        409,
        "No finalized human utterance for this instruction.",
      );
    const utterance = this.tasks.vault.open<Utterance>(saved.sealed);
    const current = this.tasks.ledger.get(voice.sessionId, taskId);
    const result = this.ledger.finalize(voiceId, {
      eventId: value.eventId,
      providerConversationId: utterance.providerConversationId,
      utteranceId: utterance.utteranceId,
      taskId,
      runId: utterance.runId,
      expectedRevision: utterance.expectedRevision,
      currentRevision: current.revision,
      instruction: utterance.text,
    });
    if (!result.replayed && result.receipt.state === "applied")
      this.engine?.start(voice.sessionId, taskId);
    return {
      state: result.receipt.state,
      replayed: result.replayed,
      runId: result.receipt.appliedRunId,
      taskId,
    };
  }
  end(raw: string, taskId: string, voiceId: string, input: unknown) {
    this.authenticate(raw, taskId, voiceId, false);
    const value = z.object({ eventId: identity }).strict().parse(input);
    this.ledger.end(voiceId, value.eventId);
    return { ended: true, taskCanceled: false };
  }
}
