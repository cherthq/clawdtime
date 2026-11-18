import { realpathSync } from "node:fs";
import { z } from "zod";
import type {
  IndependentTaskSession,
  Pairing,
  TaskCommand,
  CodingTask,
  TaskVoiceSession,
} from "../contracts.js";
import { Store } from "../storage/store.js";
import { Vault, hash, id, token, DomainError } from "../storage/security.js";
import { TaskLedger } from "../attention/task-ledger.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
import { unresolvedTaskPresentations } from "../attention/task-presentation-ledger.js";
import { unresolvedTaskAudioCalls } from "../attention/task-audio-call.js";

const text = z.string().trim().min(1).max(200);
const registration = z
  .object({
    eventId: text,
    pairingId: text,
    hostId: text,
    projectRoot: z.string().min(1).max(4096),
    voice: z.boolean().default(false),
  })
  .strict();

/** App-owned authority. No legacy AgentSession, polling chat, screen or control grant. */
export class TaskService {
  beforeDecision?: (taskId: string) => void;
  constructor(
    readonly store: Store,
    readonly vault: Vault,
    readonly ledger: TaskLedger,
    readonly options: {
      projectRoots: string[];
      simulation: boolean;
      clock?: () => number;
    },
  ) {}
  private now() {
    return this.options.clock?.() ?? Date.now();
  }
  register(input: unknown) {
    const value = registration.parse(input);
    const projectRoot = realpathSync(value.projectRoot);
    if (
      !this.options.projectRoots
        .map((p) => realpathSync(p))
        .includes(projectRoot)
    )
      throw new DomainError(403, "Project is not explicitly allowed.");
    const pairing = this.pairing(value.pairingId);
    return this.store.transaction(() => {
      const receiptId = `task-session:${hash(value.eventId)}`;
      const fingerprint = hash(JSON.stringify({ ...value, projectRoot }));
      const prior = this.store.state<{ fingerprint: string; sealed: string }>(
        receiptId,
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new DomainError(409, "Registration receipt conflicts.");
        const result = this.vault.open<{
          session: IndependentTaskSession;
          token: string;
        }>(prior.sealed);
        this.authenticate(result.token);
        return result;
      }
      const session: IndependentTaskSession = {
        id: id("task_session"),
        version: 1,
        pairingId: pairing.id,
        memberId: pairing.memberId,
        deviceId: pairing.deviceId,
        hostId: value.hostId,
        projectRoot,
        createdAt: this.now(),
        expiresAt: this.now() + 24 * 60 * 60 * 1000,
        permissions: {
          execute: true,
          voice: value.voice,
          presentation: false,
          control: false,
        },
      };
      const raw = token();
      this.store.put("task-session", {
        id: session.id,
        sealed: this.vault.seal(session),
      });
      this.store.put("task-credential", {
        id: hash(raw),
        sessionId: session.id,
      });
      const result = { session, token: raw };
      this.store.saveState(receiptId, {
        fingerprint,
        sealed: this.vault.seal(result),
      });
      return result;
    });
  }
  private pairing(pairingId: string) {
    const pairing = this.store.get<Pairing>("pairing", pairingId);
    if (!pairing || pairing.revokedAt !== undefined)
      throw new DomainError(403, "Pairing unavailable.");
    return pairing;
  }
  private checkedSession(sessionId: string, allowExpired = false) {
    const record = this.store.get<{ id: string; sealed: string }>(
      "task-session",
      sessionId,
    );
    if (!record) throw new DomainError(403, "Task session unavailable.");
    const session = this.vault.open<IndependentTaskSession>(record.sealed);
    const pairing = this.pairing(session.pairingId);
    if (
      session.revokedAt !== undefined ||
      (!allowExpired && session.expiresAt <= this.now()) ||
      pairing.memberId !== session.memberId ||
      pairing.deviceId !== session.deviceId
    )
      throw new DomainError(403, "Task session expired or revoked.");
    if (
      !this.options.projectRoots
        .map((p) => realpathSync(p))
        .includes(realpathSync(session.projectRoot))
    )
      throw new DomainError(403, "Project authorization unavailable.");
    return session;
  }
  session(sessionId: string) {
    return this.checkedSession(sessionId);
  }
  private credential(raw: string) {
    if (raw.length < 32)
      throw new DomainError(401, "Task credential required.");
    const credential = this.store.get<{ sessionId: string }>(
      "task-credential",
      hash(raw),
    );
    if (!credential) throw new DomainError(401, "Invalid task credential.");
    return credential.sessionId;
  }
  authenticate(raw: string) {
    return this.session(this.credential(raw));
  }
  private sessionState(sessionId: string) {
    const tasks = new ProtectedTaskStore<CodingTask>(
      this.store,
      this.vault,
      "coding-task-v1",
    )
      .all()
      .filter((task) => task.sessionId === sessionId);
    const voices = new ProtectedTaskStore<TaskVoiceSession>(
      this.store,
      this.vault,
      "coding-task-voice-v1",
    )
      .all()
      .filter(
        (voice) => voice.sessionId === sessionId && voice.endedAt === undefined,
      );
    const held = new ProtectedTaskStore<{
      id: string;
      receipt: { taskId: string; state: string };
    }>(this.store, this.vault, "coding-task-voice-instruction-v1")
      .all()
      .some(
        (record) =>
          record.receipt.state === "held" &&
          tasks.some((task) => task.id === record.receipt.taskId),
      );
    const blockedReasons: string[] = [];
    if (voices.length) blockedReasons.push("voice_cleanup_required");
    if (
      tasks.some(
        (task) =>
          ["queued", "running", "verifying", "unknown"].includes(task.state) ||
          task.runs.some((run) =>
            ["queued", "running", "unknown"].includes(run.state),
          ),
      )
    )
      blockedReasons.push("run_outcome_unresolved");
    if (
      tasks.some((task) =>
        task.calls.some(
          (call) => !["ended", "unanswered"].includes(call.state),
        ),
      )
    )
      blockedReasons.push("call_cleanup_required");
    if (held) blockedReasons.push("held_instruction_unresolved");
    if (unresolvedTaskAudioCalls(this.store, this.vault).length)
      blockedReasons.push("handset_cleanup_required");
    if (
      unresolvedTaskPresentations(this.store, this.vault).some(
        (r) => r.sessionId === sessionId,
      )
    )
      blockedReasons.push("presentation_cleanup_required");
    return { tasks, voices, blockedReasons };
  }
  /** Expiry-only exception for read-only diagnostics, never task prose or execution. */
  readiness(raw: string, taskId: string) {
    const session = this.checkedSession(this.credential(raw), true);
    const state = this.sessionState(session.id);
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new DomainError(404, "Task unavailable for this session.");
    const sessionActive = session.expiresAt > this.now();
    return {
      taskId,
      sessionId: session.id,
      sessionExpiresAt: session.expiresAt,
      sessionActive,
      taskState: task.state,
      runId: task.runs.at(-1)?.id,
      revision: task.revision,
      verificationState: task.verification?.state ?? null,
      unendedVoices: state.voices.map((voice) => ({
        id: voice.id,
        mode: voice.mode,
        expiresAt: voice.expiresAt,
        ended: false,
      })),
      blockedReasons: [
        ...state.blockedReasons,
        ...(!sessionActive ? ["session_expired"] : []),
      ],
      handsetDispatch: false,
      permissions: { presentation: false, control: false, screen: false },
    };
  }
  /** Operator-authorized same-identity renewal; never renews voices or replays work. */
  reauthorize(sessionId: string, input: unknown) {
    const value = registration.parse(input);
    const projectRoot = realpathSync(value.projectRoot);
    return this.store.transaction(() => {
      const current = this.checkedSession(sessionId, true);
      if (
        current.pairingId !== value.pairingId ||
        current.hostId !== value.hostId ||
        current.projectRoot !== projectRoot ||
        current.permissions.voice !== value.voice
      )
        throw new DomainError(
          403,
          "Reauthorization must preserve the exact identity and permissions.",
        );
      const key = `task-reauthorize:${hash(value.eventId)}`;
      const fingerprint = hash(
        JSON.stringify({ sessionId, ...value, projectRoot }),
      );
      const prior = this.store.state<{ fingerprint: string; sealed: string }>(
        key,
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new DomainError(409, "Reauthorization receipt conflicts.");
        return {
          session: this.vault.open<IndependentTaskSession>(prior.sealed),
          replayed: true,
        };
      }
      if (this.sessionState(sessionId).blockedReasons.length)
        throw new DomainError(
          409,
          "Resolve run, call, voice and instruction outcomes before reauthorization.",
        );
      const session = {
        ...current,
        expiresAt: Math.max(
          current.expiresAt,
          this.now() + 24 * 60 * 60 * 1000,
        ),
      };
      this.store.put("task-session", {
        id: sessionId,
        sealed: this.vault.seal(session),
      });
      this.store.saveState(key, {
        fingerprint,
        sealed: this.vault.seal(session),
      });
      return { session, replayed: false };
    });
  }
  create(raw: string, input: unknown) {
    const session = this.authenticate(raw);
    const value = z
      .object({ eventId: text, goal: z.string().trim().min(1).max(8000) })
      .strict()
      .parse(input);
    return this.ledger.create(session, value);
  }
  command(raw: string, taskId: string, command: TaskCommand) {
    const session = this.authenticate(raw);
    if (command.action === "decide") this.beforeDecision?.(taskId);
    if (
      !this.options.simulation &&
      !["decide", "accept", "cancel"].includes(command.action)
    )
      throw new DomainError(
        403,
        "Worker and verification events are service-owned.",
      );
    if (command.action === "prepare_call" && !command.simulated)
      throw new DomainError(403, "Live task calls are disabled.");
    return this.ledger.transition(session.id, taskId, command);
  }
}
