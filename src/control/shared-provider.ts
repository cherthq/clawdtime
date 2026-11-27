import { createHmac } from "node:crypto";
import { z } from "zod";
import { Store } from "../storage/store.js";
import { DomainError, equal, hash } from "../storage/security.js";
import { SharedCallbacks } from "./shared-callbacks.js";
import type { SharedNumber } from "./shared-number.js";
import type { SharedCallbackOwnership } from "../shared-number-contracts.js";
import type { TaskAudioCredentials } from "../transport/task-audio.js";
export interface SharedMedia {
  prepare(input: {
    roomId: string;
    expiresAt: number;
    deadlineAt: number;
    video: boolean;
    signal?: AbortSignal;
  }): Promise<TaskAudioCredentials>;
  cleanup(roomId: string): Promise<boolean>;
  activate(roomId: string): Promise<void>;
}
interface Incoming {
  id: string;
  eventId: string;
  fingerprint: string;
  roomId: string;
  phase: "preparing" | "prepared" | "unknown" | "ended";
  activated?: boolean;
  /** Reconciliation reads of an unknown call that did not end it. */
  retries?: number;
  retryAt?: number;
  /** When the call ended here, for its retention window. */
  endedAt?: number;
}
const incomingKind = "shared_provider_incoming";
// Unknown calls are read again after 1, 2, 4, 8 and 16 s, then every 30 s.
const retryCeilingMs = 30_000;
/** Ended calls, their webhook receipts and their event receipts are kept this
 * long after the call ended, then pruned. Unknown and open calls always stay. */
export const SHARED_RETENTION_MS = 24 * 60 * 60_000;
const pruneEveryMs = 60_000;
/** The room removal of a call the router released, retried until it holds. */
interface Release {
  id: string;
  roomId: string;
  removed: boolean;
  retryAt?: number;
}
const releaseRetryMs = 5000;
const eventSchema = z
  .object({
    event_id: z.uuid(),
    type: z.enum([
      "call.incoming",
      "call.started",
      "call.ended",
      "call.failed",
    ]),
    created_at: z.iso.datetime(),
    data: z
      .object({
        call_id: z.uuid(),
        line_id: z.uuid(),
        media: z
          .object({ audio: z.literal(true), video: z.boolean() })
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** Signed webhooks and Calls API share one durable line scheduler. A webhook
 * route has no standing connector to release or silently fall back to. */
export class SharedProvider {
  readonly callbacks: SharedCallbacks;
  private busy = false;
  private prunedAt = -Infinity;
  private preparing = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  async drain() {
    await Promise.allSettled([...this.pending]);
  }
  private now: () => number;
  constructor(
    private options: {
      store: Store;
      router: SharedNumber;
      lineId: string;
      webhookSecret: string;
      media: SharedMedia;
      now?: () => number;
      event(input: unknown): Promise<unknown>;
      api: {
        ready(idle?: boolean): Promise<boolean>;
        observe(id: string): Promise<{
          answered: boolean;
          terminal: boolean;
          cleanupComplete: boolean;
        }>;
        dial(
          callback: SharedCallbackOwnership,
          media: TaskAudioCredentials,
          recipient: string,
        ): Promise<{ providerCallId: string }>;
      };
    },
  ) {
    this.now = options.now ?? Date.now;
    options.store.db.exec(
      `CREATE INDEX IF NOT EXISTS ${incomingKind}_phase
       ON entities(kind, json_extract(body, '$.phase'))
       WHERE kind = '${incomingKind}'`,
    );
    for (const item of this.incoming("'preparing'"))
      options.store.put(incomingKind, { ...item, phase: "unknown" });
    this.callbacks = new SharedCallbacks(
      options.router,
      options.store,
      {
        ready: () => options.api.ready(),
        acquire: async () => {
          if (!(await options.api.ready()))
            throw Error("shared_webhook_route_unavailable");
        },
        verify: () => options.api.ready(),
        prepare: (callback) =>
          options.media.prepare({
            roomId: callback.roomId!,
            expiresAt: this.now() + 3600000,
            deadlineAt: this.now() + 20000,
            video: true,
          }),
        dial: (callback, media, recipient) =>
          options.api.dial(callback, media as TaskAudioCredentials, recipient),
        inspect: async (callback, id, activate = true) => {
          const observed = await options.api.observe(id);
          if (activate && observed.answered && !observed.terminal) {
            options.router.activateCallback(callback.id);
            await options.media.activate(callback.roomId!);
          }
          return observed;
        },
        closeMedia: (callback) => options.media.cleanup(callback.roomId!),
        restore: () => options.api.ready(),
      },
      this.now,
    );
  }
  async webhook(raw: string, signature: string) {
    const expected = `sha256=${createHmac("sha256", this.options.webhookSecret).update(raw).digest("hex")}`;
    if (!equal(expected, signature))
      throw new DomainError(403, "shared_webhook_signature");
    const event = eventSchema.parse(JSON.parse(raw));
    if (event.data.line_id !== this.options.lineId)
      throw new DomainError(403, "shared_webhook_line");
    // The observed caller handle, exactly as the provider sent it, only selects
    // whose paired Mac may be shown the call code. The router keeps a keyed
    // digest of it. It is never persisted here or used to authorize a device.
    const from = (event.data as { from?: unknown }).from;
    const caller =
      typeof from === "string" && from.length > 0 && from.length <= 320
        ? from
        : undefined;
    if (event.type !== "call.incoming") return { ok: true }; // poll authoritative provider cleanup below
    const fingerprint = hash(
      JSON.stringify([
        event.event_id,
        event.type,
        event.created_at,
        event.data.call_id,
        event.data.line_id,
        event.data.media,
      ]),
    );
    const prior = this.options.store.get<Incoming>(
      "shared_provider_incoming",
      event.data.call_id,
    );
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new DomainError(409, "shared_webhook_conflict");
      return { action: "decline" }; // bearer credentials never persisted or replayed
    }
    const age = this.now() - Date.parse(event.created_at);
    if (age < -1000 || age > 4500 || !event.data.media)
      return { action: "decline" };
    const record: Incoming = {
      id: event.data.call_id,
      eventId: event.event_id,
      fingerprint,
      roomId: `shared_${hash(event.data.call_id)}`,
      phase: "preparing",
    };
    this.options.store.put("shared_provider_incoming", record);
    const incoming = (await this.options.event({
      ...this.binding(record, "incoming"),
      ...(caller ? { caller } : {}),
    })) as { state: string };
    if (incoming.state !== "unknown_identity") {
      this.options.store.put("shared_provider_incoming", {
        ...record,
        phase: "ended",
        endedAt: this.now(),
      });
      return { action: "decline" };
    }
    const deadlineAt = Date.parse(event.created_at) + 4500;
    this.preparing.add(record.id);
    const preparation = (async () => {
      try {
        const credentials = await this.options.media.prepare({
          roomId: record.roomId,
          expiresAt: this.now() + 3600000,
          deadlineAt,
          video: event.data.media!.video,
        });
        this.options.store.put("shared_provider_incoming", {
          ...record,
          phase: "prepared",
        });
        return this.now() < deadlineAt
          ? { action: "accept", ...credentials }
          : { action: "decline" };
      } catch {
        this.options.store.put("shared_provider_incoming", {
          ...record,
          phase: "unknown",
        });
        return { action: "decline" };
      } finally {
        this.preparing.delete(record.id);
      }
    })();
    this.pending.add(preparation);
    void preparation.finally(() => this.pending.delete(preparation));
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        preparation,
        new Promise<{ action: string }>((resolve) => {
          timer = setTimeout(
            () => resolve({ action: "decline" }),
            Math.max(1, deadlineAt - this.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
  private binding(item: Incoming, kind: "incoming" | "cleanup_complete") {
    return {
      kind,
      eventId: `webhook:${kind}:${item.eventId}`,
      lineId: this.options.lineId,
      providerCallId: item.id,
      roomId: item.roomId,
      participantId: "shared-bridge",
      expiresAt: this.now() + 30000,
    };
  }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.releaseUnverified();
      for (const item of this.incoming("'unknown', 'prepared'")) {
        if (this.preparing.has(item.id)) continue;
        if (item.phase === "unknown") {
          await this.reconcile(item);
          continue;
        }
        if (item.phase !== "prepared") continue;
        try {
          const state = await this.options.api.observe(item.id);
          if (state.terminal && state.cleanupComplete) {
            if (!(await this.options.media.cleanup(item.roomId))) continue;
            await this.options.event(this.binding(item, "cleanup_complete"));
            this.options.store.put("shared_provider_incoming", {
              ...item,
              phase: "ended",
              endedAt: this.now(),
            });
          } else if (state.answered && !state.terminal && !item.activated) {
            await this.options.media.activate(item.roomId);
            this.options.store.put("shared_provider_incoming", {
              ...item,
              activated: true,
            });
          }
        } catch {
          /* read failure retains call ownership; no accept or dial is retried */
        }
      }
      await this.callbacks.pump();
      this.prune();
    } finally {
      this.busy = false;
    }
  }
  /** Incoming calls in the given phases, read through the phase index. */
  private incoming(phases: string) {
    return this.options.store.db
      .prepare(
        `SELECT body FROM entities WHERE kind = '${incomingKind}'
         AND json_extract(body, '$.phase') IN (${phases}) ORDER BY rowid`,
      )
      .all()
      .map((row) => JSON.parse(String(row.body)) as Incoming);
  }
  /** At most once a minute, remove what ended before the retention window:
   * the webhook receipts here, then the router's calls and receipts. */
  private prune() {
    const now = this.now();
    if (now - this.prunedAt < pruneEveryMs) return;
    this.prunedAt = now;
    const before = now - SHARED_RETENTION_MS;
    const { store, router } = this.options;
    store.transaction(() => {
      // A record from an earlier release has no end time: its window starts now.
      store.db
        .prepare(
          `UPDATE entities SET body = json_set(body, '$.endedAt', ?)
           WHERE kind = '${incomingKind}'
           AND json_extract(body, '$.phase') = 'ended'
           AND json_extract(body, '$.endedAt') IS NULL`,
        )
        .run(now);
      store.db
        .prepare(
          `DELETE FROM entities WHERE kind = '${incomingKind}'
           AND json_extract(body, '$.phase') = 'ended'
           AND json_extract(body, '$.endedAt') <= ?`,
        )
        .run(before);
    });
    for (let batch = 0; batch < 10; batch++) {
      const pruned = router.prune(before);
      store.db
        .prepare(
          `DELETE FROM entities WHERE kind = 'shared_provider_release'
           AND id IN (SELECT value FROM json_each(?))`,
        )
        .run(JSON.stringify(pruned));
      if (pruned.length < 1000) break;
    }
  }
  /** End a call the router released: its caller did not verify in time, ran
   * out of attempts, or reached an offline Mac. Removing the room ends the
   * provider call. The slot still frees only after the provider's terminal
   * cleanup and an observed room absence, as for every other call. */
  private async releaseUnverified() {
    for (const call of this.options.router.releaseUnverified()) {
      const prior = this.options.store.get<Release>(
        "shared_provider_release",
        call.callId,
      );
      if (prior?.removed || (prior?.retryAt ?? 0) > this.now()) continue;
      let removed = false;
      try {
        removed = await this.options.media.cleanup(call.roomId);
      } catch {
        /* retried below; the slot stays held */
      }
      this.options.store.put<Release>("shared_provider_release", {
        id: call.callId,
        roomId: call.roomId,
        removed,
        ...(removed ? {} : { retryAt: this.now() + releaseRetryMs }),
      });
    }
  }
  /** A failed preparation or a restart leaves no evidence of a room or of the
   * provider call. Only the provider's terminal cleanup and an observed room
   * absence free the slot; a live, unread or uncleaned call keeps it. Nothing
   * is accepted, activated or redialed for an unknown call. */
  private async reconcile(item: Incoming) {
    if ((item.retryAt ?? 0) > this.now()) return;
    try {
      const state = await this.options.api.observe(item.id);
      if (state.terminal && state.cleanupComplete) {
        if (await this.options.media.cleanup(item.roomId)) {
          await this.options.event(this.binding(item, "cleanup_complete"));
          this.options.store.put("shared_provider_incoming", {
            ...item,
            phase: "ended",
            endedAt: this.now(),
          });
          return;
        }
      }
    } catch {
      /* an unread provider or room state keeps the slot */
    }
    const retries = (item.retries ?? 0) + 1;
    this.options.store.put("shared_provider_incoming", {
      ...item,
      retries,
      retryAt:
        this.now() +
        Math.min(retryCeilingMs, 1000 * 2 ** Math.min(retries - 1, 15)),
    });
  }
}
