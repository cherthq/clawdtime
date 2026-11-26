import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export const connectorOperations = [
  "poll",
  "ack",
  "progress",
  "reply",
  "cancel",
  "end",
  "execution_status",
  "execution",
  "observe",
  "act",
] as const;
export type ConnectorOperation = (typeof connectorOperations)[number];
type TimingEvent = {
  sequence: number;
  event: `connector_${ConnectorOperation}_${"started" | "completed" | "failed"}`;
  correlationId: string;
  elapsedMs: number;
  generation: 0;
};

/** Local HTTP boundaries only. Never retains request/response content or errors. */
export class ConnectorTiming {
  private processId = randomUUID().replaceAll("-", "");
  private born: number;
  private lastClock: number;
  private sequence = 0;
  private requests = new Map<string, { at: number; events: TimingEvent[] }>();

  constructor(private readonly clock = () => performance.now()) {
    this.born = this.lastClock = clock();
  }

  private now() {
    const now = this.clock();
    if (!Number.isFinite(now)) return null;
    if (now < this.lastClock || now - this.born >= 86_400_000) {
      this.processId = randomUUID().replaceAll("-", "");
      this.born = now;
      this.sequence = 0;
      this.requests.clear();
    }
    this.lastClock = now;
    for (const [key, value] of this.requests)
      if (now - value.at >= 600_000) this.requests.delete(key);
    return now;
  }

  private key(requestId: string) {
    return createHash("sha256")
      .update(`${this.processId}:${requestId}`)
      .digest("hex");
  }

  begin(requestId: string, operation: ConnectorOperation) {
    const now = this.now();
    if (now === null) return () => {};
    const key = this.key(requestId);
    let request = this.requests.get(key);
    if (!request) {
      if (this.requests.size >= 100) return () => {};
      request = { at: now, events: [] };
      this.requests.set(key, request);
    }
    const processId = this.processId;
    const correlationId = randomUUID().replaceAll("-", "").slice(0, 24);
    const append = (state: "started" | "completed" | "failed", at: number) => {
      request!.events.push({
        sequence: ++this.sequence,
        event: `connector_${operation}_${state}`,
        correlationId,
        elapsedMs: Math.round(at - this.born),
        generation: 0,
      });
      if (request!.events.length > 64) request!.events.shift();
    };
    append("started", now);
    let finished = false;
    return (outcome: "completed" | "failed") => {
      if (finished) return;
      finished = true;
      const end = this.now();
      // An old request must never attach to a new clock scope or revive expiry.
      if (
        end === null ||
        processId !== this.processId ||
        this.requests.get(key) !== request
      )
        return;
      append(outcome, end);
    };
  }

  snapshot(requestId: string) {
    this.now();
    return {
      version: 1,
      processId: this.processId,
      measurementKind: "unclassified" as const,
      boundary: "connector_http_round_trip" as const,
      nativeToolInternals: "unavailable" as const,
      events: (this.requests.get(this.key(requestId))?.events ?? []).map(
        (event) => ({ ...event }),
      ),
    };
  }
}
