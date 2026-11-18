import { realpathSync } from "node:fs";
import { z } from "zod";
import type {
  IndependentTaskSession,
  Pairing,
  TaskCommand,
} from "../contracts.js";
import { Store } from "../storage/store.js";
import { Vault, hash, id, token, DomainError } from "../storage/security.js";
import { TaskLedger } from "../attention/task-ledger.js";

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
  session(sessionId: string) {
    const record = this.store.get<{ id: string; sealed: string }>(
      "task-session",
      sessionId,
    );
    if (!record) throw new DomainError(403, "Task session unavailable.");
    const session = this.vault.open<IndependentTaskSession>(record.sealed);
    const pairing = this.pairing(session.pairingId);
    if (
      session.revokedAt !== undefined ||
      session.expiresAt <= this.now() ||
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
  authenticate(raw: string) {
    if (raw.length < 32)
      throw new DomainError(401, "Task credential required.");
    const credential = this.store.get<{ sessionId: string }>(
      "task-credential",
      hash(raw),
    );
    if (!credential) throw new DomainError(401, "Invalid task credential.");
    return this.session(credential.sessionId);
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
