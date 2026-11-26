import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { hash } from "../storage/security.js";

export type ControlTimingEvent =
  | "ownership_started"
  | "ownership_completed"
  | "ownership_failed"
  | "frame_started"
  | "frame_completed"
  | "frame_failed"
  | "input_started"
  | "input_submitted"
  | "input_observed"
  | "input_failed";

/** Process-local boundaries only; no user content, images or tool arguments. */
export class ControlTiming {
  private processId = randomUUID().replaceAll("-", "");
  private born: number;
  private last: number;
  private sequence = 0;
  private requests = new Map<
    string,
    {
      at: number;
      events: Array<{
        sequence: number;
        event: ControlTimingEvent;
        correlationId: string;
        elapsedMs: number;
      }>;
    }
  >();
  constructor(
    readonly measurementKind: "synthetic" | "unclassified" = "unclassified",
    private readonly clock = () => performance.now(),
  ) {
    this.born = this.last = clock();
  }
  private prune() {
    const now = this.clock();
    if (now < this.last || now - this.born >= 86_400_000) {
      this.processId = randomUUID().replaceAll("-", "");
      this.requests.clear();
      this.sequence = 0;
      this.born = now;
    }
    this.last = now;
    for (const [key, value] of this.requests)
      if (now - value.at >= 600_000) this.requests.delete(key);
  }
  attempt(requestId: string) {
    return hash(`${requestId}:${randomUUID()}`).slice(0, 24);
  }
  record(requestId: string, event: ControlTimingEvent, correlationId: string) {
    this.prune();
    if (!/^[a-f0-9]{24}$/.test(correlationId)) return;
    let value = this.requests.get(requestId);
    if (!value) {
      if (this.requests.size >= 100) return;
      value = { at: this.clock(), events: [] };
      this.requests.set(requestId, value);
    }
    value.at = this.clock();
    value.events.push({
      sequence: ++this.sequence,
      event,
      correlationId,
      elapsedMs: Math.max(0, Math.round(this.clock() - this.born)),
    });
    if (value.events.length > 64) value.events.shift();
  }
  snapshot(requestId: string) {
    this.prune();
    return {
      version: 1,
      processId: this.processId,
      measurementKind: this.measurementKind,
      boundary: "backend_control",
      nativeToolInternals: "unavailable",
      events: (this.requests.get(requestId)?.events ?? []).map((e) => ({
        ...e,
      })),
    };
  }
}
