import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { hash } from "../storage/security.js";
import type { ClawdTime } from "../attention/service.js";
const stores = new WeakMap<ClawdTime, ConversationTimeline>();
export function timelineFor(service: ClawdTime) {
  let t = stores.get(service);
  if (!t) {
    t = new ConversationTimeline(
      service.transport.mode === "simulation" ? "synthetic" : "unclassified",
    );
    stores.set(service, t);
  }
  return t;
}
export type TimelineEvent =
  | "callback_accepted"
  | "agent_acknowledged"
  | "execution_reported"
  | "approval_reported"
  | "reply_accepted"
  | "outcome_reported"
  | "end_requested"
  | "cleanup_confirmed";
/** Bounded metadata only. UTC is observation, elapsedMs is process-local. */
export class ConversationTimeline {
  processId = randomUUID().replaceAll("-", "");
  private born: number;
  private sequence = 0;
  private lastClock: number;
  private requests = new Map<
    string,
    {
      at: number;
      events: Array<{
        sequence: number;
        event: TimelineEvent;
        correlationId: string;
        elapsedMs: number;
        at: string;
      }>;
    }
  >();
  constructor(
    readonly measurementKind: "synthetic" | "unclassified",
    readonly clock = () => performance.now(),
  ) {
    this.born = this.lastClock = clock();
  }
  private prune() {
    const now = this.clock();
    if (now < this.lastClock || now - this.born >= 86400000) {
      this.processId = randomUUID().replaceAll("-", "");
      this.born = now;
      this.sequence = 0;
      this.requests.clear();
    }
    this.lastClock = now;
    for (const [id, v] of this.requests)
      if (now - v.at >= 600000) this.requests.delete(id);
  }
  record(requestId: string, event: TimelineEvent, correlation: string) {
    this.prune();
    let r = this.requests.get(requestId);
    if (!r) {
      if (this.requests.size >= 100) return;
      r = { at: this.clock(), events: [] };
      this.requests.set(requestId, r);
    }
    const correlationId = /^[a-f0-9]{24}$/.test(correlation)
      ? correlation
      : hash(`${requestId}:${correlation}`).slice(0, 24);
    if (
      r.events.some(
        (e) => e.event === event && e.correlationId === correlationId,
      )
    )
      return;
    r.events.push({
      sequence: ++this.sequence,
      event,
      correlationId,
      elapsedMs: Math.max(
        0,
        Math.min(86400000, Math.round(this.clock() - this.born)),
      ),
      at: new Date().toISOString(),
    });
    if (r.events.length > 64) r.events.shift();
  }
  snapshot(requestId: string) {
    this.prune();
    return {
      version: 1,
      processId: this.processId,
      measurementKind: this.measurementKind,
      events: (this.requests.get(requestId)?.events ?? []).map((e) => ({
        ...e,
      })),
    };
  }
}
