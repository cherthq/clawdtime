import { z } from "zod";
import { hash, type Vault } from "../storage/security.js";
import type { Store } from "../storage/store.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
import type { BackgroundTaskRecord } from "./background-runtime.js";

const id = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const retirementSchema = z.object({
  fingerprint: digest, driverGeneration: id, driverPid: z.number().int().positive(),
  driverProcessStart: digest, driverQuiescent: z.literal(true), observationId: id,
  observedAt: z.string().datetime(),
  evidence: z.object({
    kind: z.literal("codex_new_chat_navigation"), sessionId: id, taskId: id,
    actionReceiptId: id, actionFingerprint: digest, originalOutcome: z.literal("unknown"),
    noReplay: z.literal(true), noTextOrSubmissionDispatched: z.literal(true),
  }).strict(),
}).strict();
const receiptSchema = z.object({
  state: z.literal("retired_unknown_navigation"),
  reservation: z.object({ id, fingerprint: digest, driverGeneration: id,
    driverPid: z.number().int().positive(), driverProcessStart: digest }),
  lease: z.object({ taskId: id, sessionId: id }),
  retirement: retirementSchema,
  resolution: z.null().optional(),
});
type Recovery = { id: string; recordDigest: string; helperReceipt: unknown };

/** Operator-only journal. Neither the model nor worker receives this object.
 * The caller must obtain the exact retirement from the authenticated helper;
 * it does not issue input, clear helper fences, or rewrite original outcomes. */
export class BackgroundRecovery {
  private records: ProtectedTaskStore<Recovery>;
  constructor(store: Store, vault: Vault) {
    this.records = new ProtectedTaskStore(store, vault, "background-navigation-retirement-v1");
  }
  private validate(record: BackgroundTaskRecord, receipt: unknown) {
    const r = receiptSchema.parse(receipt), proof = r.retirement;
    const action = record.actions.find(a => a.id === proof.evidence.actionReceiptId);
    if (record.state !== "uncertain" || record.sessionId !== proof.evidence.sessionId ||
        record.id !== proof.evidence.taskId || r.lease.taskId !== record.id ||
        r.lease.sessionId !== record.sessionId || !action || action.state !== "unknown" ||
        action.operation !== "codex_new_chat_navigation" ||
        action.fingerprint !== proof.evidence.actionFingerprint ||
        record.actions.length !== 2 || record.actions[1]?.id !== action.id ||
        record.actions[0]?.operation !== "qualified_launch" || record.actions[0]?.state !== "verified" ||
        record.actions.some(a => a.applicationBundleId !== "com.openai.codex") ||
        record.actions.filter(a => a.operation === "codex_new_chat_navigation").length !== 1 ||
        record.actions.some(a => a.id !== action.id &&
          !(a.operation === "qualified_launch" && a.state === "verified")) ||
        ["fingerprint", "driverGeneration", "driverPid", "driverProcessStart"].some(
          key => Reflect.get(r.reservation, key) !== Reflect.get(proof, key)))
      throw Error("Navigation retirement does not match the original bounded action record");
    return r;
  }
  record(record: BackgroundTaskRecord, helperReceipt: unknown) {
    const receipt = this.validate(record, helperReceipt);
    const next = { id: record.id, recordDigest: hash(JSON.stringify(record)), helperReceipt: receipt };
    const old = this.records.get(record.id);
    if (old && JSON.stringify(old) !== JSON.stringify(next))
      throw Error("Navigation retirement identity conflicts");
    if (!old) this.records.put(next);
  }
  retired(record: BackgroundTaskRecord) {
    const saved = this.records.get(record.id);
    if (!saved || saved.recordDigest !== hash(JSON.stringify(record))) return false;
    try { this.validate(record, saved.helperReceipt); return true; } catch { return false; }
  }
}
