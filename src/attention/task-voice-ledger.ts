import type {
  CodingTask,
  IndependentTaskSession,
  TaskVoiceInstruction,
  TaskVoiceSession,
} from "../contracts.js";
import { DomainError, hash, id, Vault } from "../storage/security.js";
import { Store } from "../storage/store.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
import { TaskLedger } from "./task-ledger.js";

interface VoiceEvent {
  id: string;
  fingerprint: string;
  voiceId: string;
  receiptId?: string;
}
interface InstructionRecord {
  id: string;
  fingerprint: string;
  receipt: TaskVoiceInstruction;
}
export interface FinalizedTaskInstruction {
  eventId: string;
  providerConversationId: string;
  utteranceId: string;
  taskId: string;
  runId: string;
  expectedRevision: number;
  /** Internal trusted-source reconciliation; never a provider/model input field. */
  currentRevision?: number;
  instruction: string;
}
export interface VoiceInstructionMutation {
  receipt: TaskVoiceInstruction;
  task: CodingTask;
  replayed: boolean;
}

const ready = new Set([
  "needs_decision",
  "review_ready",
  "walkthrough_ready",
  "in_call",
  "review_call",
]);
function text(value: unknown, label: string, limit = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new DomainError(400, `Invalid ${label}.`);
  return value;
}

/** Finalized instruction receipts only. The authenticated runtime owns audio provenance. */
export class TaskVoiceLedger {
  private readonly voices: ProtectedTaskStore<TaskVoiceSession>;
  private readonly instructions: ProtectedTaskStore<InstructionRecord>;
  private readonly events: ProtectedTaskStore<VoiceEvent>;

  constructor(
    private readonly store: Store,
    vault: Vault,
    private readonly tasks: TaskLedger,
    private readonly clock: () => number = Date.now,
  ) {
    this.voices = new ProtectedTaskStore(store, vault, "coding-task-voice-v1");
    this.instructions = new ProtectedTaskStore(
      store,
      vault,
      "coding-task-voice-instruction-v1",
    );
    this.events = new ProtectedTaskStore(
      store,
      vault,
      "coding-task-voice-event-v1",
    );
    // Construction never releases a held instruction or dispatches any external effect.
  }

  open(
    session: IndependentTaskSession,
    input: {
      eventId: string;
      taskId: string;
      runId: string;
      expectedRevision: number;
    },
  ): { voice: TaskVoiceSession; replayed: boolean } {
    text(input.eventId, "voice admission event");
    if (
      !session.permissions.voice ||
      session.revokedAt !== undefined ||
      session.expiresAt <= this.clock()
    )
      throw new DomainError(403, "Task voice authority unavailable.");
    return this.store.transaction(() => {
      const eventId = hash(`open\0${session.id}\0${input.eventId}`);
      const fingerprint = hash(
        JSON.stringify([
          session.id,
          input.taskId,
          input.runId,
          input.expectedRevision,
        ]),
      );
      const prior = this.events.get(eventId);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new DomainError(409, "Voice admission event conflicts.");
        return { voice: this.get(session.id, prior.voiceId), replayed: true };
      }
      const task = this.tasks.get(session.id, input.taskId);
      const run = task.runs.at(-1)!;
      if (
        task.revision !== input.expectedRevision ||
        run.id !== input.runId ||
        !ready.has(task.state) ||
        !task.brief ||
        task.brief.runId !== run.id ||
        task.brief.verificationId !== task.verification?.id ||
        task.verification.runId !== run.id ||
        task.verification.state === "unknown" ||
        task.calls.some((call) => call.state === "unknown")
      )
        throw new DomainError(
          409,
          "Voice requires the current verified prepared task brief.",
        );
      if (this.voices.all().some((voice) => voice.endedAt === undefined))
        throw new DomainError(409, "Another voice session has not ended.");
      const voice: TaskVoiceSession = {
        id: id("task_voice"),
        taskId: task.id,
        sessionId: session.id,
        openedRunId: run.id,
        openedRevision: task.revision,
        opening: task.brief.opening,
        createdAt: this.clock(),
        expiresAt: Math.min(session.expiresAt, this.clock() + 30 * 60_000),
        mode: "local_audio",
        permissions: { presentation: false, control: false, screen: false },
      };
      this.voices.put(voice);
      this.events.put({ id: eventId, fingerprint, voiceId: voice.id });
      return { voice, replayed: false };
    });
  }

  get(sessionId: string, voiceId: string): TaskVoiceSession {
    const voice = this.voice(voiceId);
    if (voice.sessionId !== sessionId)
      throw new DomainError(404, "Voice session is unavailable.");
    return voice;
  }

  bindProvider(
    voiceId: string,
    providerConversationId: string,
  ): TaskVoiceSession {
    text(providerConversationId, "provider conversation", 200);
    return this.store.transaction(() => {
      const voice = this.voice(voiceId);
      this.active(voice);
      if (voice.providerConversationId === providerConversationId) return voice;
      const task = this.tasks.get(voice.sessionId, voice.taskId);
      if (
        task.runs.at(-1)!.id !== voice.openedRunId ||
        task.revision !== voice.openedRevision ||
        !ready.has(task.state) ||
        !task.brief ||
        task.brief.runId !== voice.openedRunId ||
        task.calls.some((call) => call.state === "unknown")
      )
        throw new DomainError(
          409,
          "Prepared voice opening is no longer current.",
        );
      if (
        voice.providerConversationId ||
        this.voices
          .all()
          .some(
            (other) => other.providerConversationId === providerConversationId,
          )
      )
        throw new DomainError(
          409,
          "Provider conversation binding cannot be replaced or reused.",
        );
      voice.providerConversationId = providerConversationId;
      return this.voices.put(voice);
    });
  }

  finalize(
    voiceId: string,
    input: FinalizedTaskInstruction,
  ): VoiceInstructionMutation {
    text(input.eventId, "instruction event");
    text(input.providerConversationId, "provider conversation", 200);
    text(input.utteranceId, "finalized utterance", 200);
    text(input.instruction, "scoped spoken instruction", 8000);
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      (input.currentRevision !== undefined &&
        (!Number.isSafeInteger(input.currentRevision) ||
          input.currentRevision < input.expectedRevision))
    )
      throw new DomainError(400, "Invalid spoken instruction revision.");
    return this.store.transaction(() => {
      const voice = this.voice(voiceId);
      if (
        voice.providerConversationId !== input.providerConversationId ||
        voice.taskId !== input.taskId
      )
        throw new DomainError(
          403,
          "Instruction does not match this task voice session.",
        );
      const fingerprint = hash(
        JSON.stringify([
          voiceId,
          input.providerConversationId,
          input.utteranceId,
          input.taskId,
          input.runId,
          input.expectedRevision,
          input.instruction,
        ]),
      );
      const receiptId = hash(
        `utterance\0${voiceId}\0${input.providerConversationId}\0${input.utteranceId}`,
      );
      const eventId = hash(`instruction\0${voiceId}\0${input.eventId}`);
      const event = this.events.get(eventId);
      if (
        event &&
        (event.fingerprint !== fingerprint || event.receiptId !== receiptId)
      )
        throw new DomainError(409, "Instruction event conflicts.");
      const prior = this.instructions.get(receiptId);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new DomainError(
            409,
            "Finalized utterance conflicts with its original instruction.",
          );
        if (!event)
          this.events.put({ id: eventId, fingerprint, voiceId, receiptId });
        return {
          receipt: prior.receipt,
          task: this.tasks.get(voice.sessionId, voice.taskId),
          replayed: true,
        };
      }
      this.active(voice);
      const task = this.tasks.get(voice.sessionId, voice.taskId);
      const run = task.runs.at(-1)!;
      if (
        run.id !== input.runId ||
        task.revision !== (input.currentRevision ?? input.expectedRevision) ||
        input.expectedRevision > task.revision
      )
        throw new DomainError(409, "Spoken instruction context is stale.");
      if (this.heldForTask(task.id).length)
        throw new DomainError(
          409,
          "One finalized instruction is already waiting for this task.",
        );
      if (
        this.instructions
          .all()
          .filter((record) => record.receipt.voiceSessionId === voiceId)
          .length >= 128
      )
        throw new DomainError(409, "Voice instruction receipt limit reached.");
      const receipt: TaskVoiceInstruction = {
        id: receiptId,
        voiceSessionId: voiceId,
        taskId: task.id,
        runId: run.id,
        expectedRevision: input.expectedRevision,
        providerConversationId: input.providerConversationId,
        utteranceId: input.utteranceId,
        instruction: input.instruction,
        state: "held",
        createdAt: this.clock(),
      };
      let current = task;
      if (ready.has(task.state)) current = this.apply(voice, receipt, task);
      else if (
        !["running", "verifying"].includes(task.state) ||
        run.cancelRequested
      )
        throw new DomainError(
          409,
          "Task outcome cannot admit a spoken revision.",
        );
      this.instructions.put({ id: receiptId, fingerprint, receipt });
      this.events.put({ id: eventId, fingerprint, voiceId, receiptId });
      return { receipt, task: current, replayed: false };
    });
  }

  releaseHeld(voiceId: string, receiptId: string): VoiceInstructionMutation {
    return this.store.transaction(() => {
      const voice = this.voice(voiceId);
      const record = this.instructions.get(receiptId);
      if (!record || record.receipt.voiceSessionId !== voiceId)
        throw new DomainError(404, "Held instruction is unavailable.");
      const receipt = record.receipt;
      const task = this.tasks.get(voice.sessionId, voice.taskId);
      if (receipt.state === "applied") return { receipt, task, replayed: true };
      const current = this.apply(voice, receipt, task);
      this.instructions.put(record);
      return { receipt, task: current, replayed: false };
    });
  }

  heldForTask(taskId: string): TaskVoiceInstruction[] {
    return this.instructions
      .all()
      .map((record) => record.receipt)
      .filter(
        (receipt) => receipt.taskId === taskId && receipt.state === "held",
      );
  }

  end(voiceId: string, eventId: string): TaskVoiceSession {
    text(eventId, "voice end event");
    return this.store.transaction(() => {
      const voice = this.voice(voiceId);
      if (voice.endedAt !== undefined) return voice;
      voice.endedAt = this.clock();
      this.voices.put(voice);
      this.events.put({
        id: hash(`end\0${voiceId}\0${eventId}`),
        fingerprint: hash(voiceId),
        voiceId,
      });
      return voice;
    });
  }

  private apply(
    voice: TaskVoiceSession,
    receipt: TaskVoiceInstruction,
    task: CodingTask,
  ): CodingTask {
    const run = task.runs.at(-1)!;
    if (
      run.id !== receipt.runId ||
      !ready.has(task.state) ||
      run.cancelRequested ||
      !["completed", "failed", "blocked"].includes(run.state) ||
      task.verification?.runId !== run.id ||
      task.verification.state === "unknown" ||
      task.calls.some((call) => call.state === "unknown")
    )
      throw new DomainError(
        409,
        "Held instruction requires its original terminal run and completed verification.",
      );
    const mutation = this.tasks.transition(voice.sessionId, task.id, {
      action: "decide",
      eventId: `voice-instruction:${receipt.id}`,
      expectedRevision: task.revision,
      runId: run.id,
      instruction: receipt.instruction,
    });
    if (mutation.replayed)
      throw new DomainError(
        409,
        "Voice/task receipt reconciliation is required.",
      );
    receipt.state = "applied";
    receipt.appliedRunId = mutation.task.runs.at(-1)!.id;
    return mutation.task;
  }

  private voice(voiceId: string): TaskVoiceSession {
    const voice = this.voices.get(voiceId);
    if (!voice) throw new DomainError(404, "Voice session is unavailable.");
    return voice;
  }

  private active(voice: TaskVoiceSession) {
    if (voice.endedAt !== undefined || voice.expiresAt <= this.clock())
      throw new DomainError(403, "Voice session has ended or expired.");
  }
}
