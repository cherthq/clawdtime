/** Local geometric presentation only; this broker cannot submit native input. */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { FileNativeSceneJournal } from "../connectors/shared/native-scene-journal.js";
import { nativeQualificationReasonSchema } from "../src/native-presentation-contracts.js";
import type { PresentationSceneController } from "../connectors/shared/presentation-scenes.js";
import {
  livePresentationIntentSchema,
  livePresentationSchema,
  livePresentationResultSchema,
  type LivePresentation,
  type LivePresentationIntent,
  type LivePresentationResult,
} from "../src/live-presentation-contracts.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const ownerSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  executor: z.string(),
  state: z.string(),
  epoch: z.number(),
  cursor: z.number(),
  acknowledgedCursor: z.number(),
  policyRevision: z.number(),
  pendingDelivery: z.boolean(),
  viewingStopped: z.boolean().optional(),
  hold: z.object({ active: z.boolean() }),
  leases: z.array(
    z.object({
      id: z.string(),
      sessionId: z.string().optional(),
      requestId: z.string().optional(),
      state: z.string(),
      mode: z.string(),
      executor: z.string().optional(),
      executorEpoch: z.number().optional(),
      policyRevision: z.number().optional(),
      displayId: z.union([z.string(), z.number()]),
      expiresAt: z.number(),
    }),
  ),
  actions: z.array(z.object({ state: z.string() })),
});
type RecordEntry = {
  intent: LivePresentationIntent;
  presentation: LivePresentation;
  fingerprint: string;
  phase: "prepared" | "dispatching" | "accepted" | "rejected" | "uncertain";
  createdAt: number;
  result?: LivePresentationResult;
  hostResult?: LivePresentationResult;
  diagnostic?: string;
};
export class PreviewLivePresentationBroker {
  readonly journalPath: string;
  private journal: FileNativeSceneJournal;
  private records = new Map<string, RecordEntry>();
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  private fatal = false;
  constructor(
    private options: {
      app: Hono;
      token: string;
      hostToken: string;
      mediaSessionId: string;
      requestId: string;
      sessionId: string;
      displayId: number;
      directory: string;
      scenes: () => PresentationSceneController | undefined;
      executionStatus: () => Promise<unknown>;
      cameraStatus: () => Promise<unknown>;
      mediaOrigin: () => string | undefined;
      processIdentity: (
        window: LivePresentationIntent["window"],
      ) => string | undefined;
      shuttingDown: () => boolean;
    },
  ) {
    if (options.hostToken.length < 32 || options.hostToken === options.token)
      throw new Error("Separate host credential required.");
    this.journalPath = join(options.directory, "live-receipts.json");
    this.journal = new FileNativeSceneJournal(this.journalPath);
    if (this.journal.read().length)
      throw new Error(
        "Preserve existing live receipts; a new review requires a new directory.",
      );
    const path = `/local-native/${options.mediaSessionId}/presentation-authority`;
    options.app.use(path, async (c, next) => {
      const got = Buffer.from(c.req.header("Authorization") ?? ""),
        expected = Buffer.from(`Bearer ${options.token}`);
      if (got.length !== expected.length || !timingSafeEqual(got, expected))
        return c.json({ error: "unauthorized" }, 401);
      if (c.req.header("Origin"))
        return c.json({ error: "server_bridge_only" }, 403);
      await next();
    });
    options.app.use(path, bodyLimit({ maxSize: 16384 }));
    options.app.post(path, async (c) => {
      try {
        const body = z
          .object({ presentation: livePresentationSchema })
          .strict()
          .parse(await c.req.json());
        return c.json(await this.authority(body.presentation));
      } catch {
        return c.json({ error: "presentation_authority_unavailable" }, 409);
      }
    });
  }
  private save() {
    try {
      this.journal.write([...this.records.values()]);
    } catch {
      this.fatal = true;
      throw new Error("Presentation journal unavailable; preserve receipts.");
    }
  }
  private matches(p: LivePresentation) {
    const s = this.options.scenes()?.status();
    return (
      s?.generation === p.generation &&
      s.plan.id === p.planId &&
      s.scene?.id === p.sceneId &&
      (s.phase === "presenting" ||
        (s.phase === "presented" &&
          this.records.get(p.commandId)?.phase === "accepted")) &&
      isDeepStrictEqual(s.scene.window, p.window) &&
      isDeepStrictEqual(s.scene.focus, p.focus) &&
      isDeepStrictEqual(s.scene.annotation, p.annotation)
    );
  }
  private valid() {
    if (this.closed || this.fatal || this.options.shuttingDown())
      throw new Error("Live presentation unavailable.");
  }
  private checkOwner(raw: unknown, p: LivePresentation) {
    const s = ownerSchema.parse(raw),
      e = p.expected,
      l = s.leases.find((l) => l.id === e.leaseId),
      now = Date.now();
    if (
      s.requestId !== e.requestId ||
      s.sessionId !== e.sessionId ||
      s.executor !== "none" ||
      s.state !== "idle" ||
      s.epoch !== e.epoch ||
      s.cursor !== e.cursor ||
      s.acknowledgedCursor !== e.cursor ||
      s.policyRevision !== e.policyRevision ||
      s.pendingDelivery ||
      s.viewingStopped ||
      s.hold.active ||
      s.leases.some((l) => l.state === "unknown") ||
      s.actions.some((a) =>
        ["pending", "submitted", "unknown"].includes(a.state),
      ) ||
      !l ||
      l.state !== "active" ||
      l.mode !== "view" ||
      l.sessionId !== e.sessionId ||
      l.requestId !== e.requestId ||
      l.executor !== "none" ||
      l.executorEpoch !== e.epoch ||
      l.policyRevision !== e.policyRevision ||
      String(l.displayId) !== String(e.displayId) ||
      l.expiresAt <= now
    )
      throw new Error("Released live presentation authority required.");
    return Math.min(l.expiresAt, now + 2000);
  }
  async authority(p: LivePresentation) {
    this.valid();
    const known = this.records.get(p.commandId);
    if (
      !known ||
      !isDeepStrictEqual(known.presentation, p) ||
      !this.matches(p) ||
      p.expected.requestId !== this.options.requestId ||
      p.expected.sessionId !== this.options.sessionId ||
      p.expected.displayId !== this.options.displayId
    )
      throw new Error("Presentation scene changed.");
    const before = await this.options.executionStatus();
    const expiry = this.checkOwner(before, p);
    const after = await this.options.executionStatus();
    this.valid();
    if (!this.matches(p)) throw new Error("Presentation scene changed.");
    return {
      ...p.expected,
      fingerprint: known.fingerprint,
      expiresAt: Math.min(expiry, this.checkOwner(after, p)),
    };
  }
  status() {
    return structuredClone({
      closed: this.closed,
      fatal: this.fatal,
      operations: [...this.records.values()],
    });
  }
  hasUnresolved() {
    return (
      this.pending.size > 0 ||
      this.fatal ||
      [...this.records.values()].some(
        (r) => r.phase === "dispatching" || r.phase === "uncertain",
      )
    );
  }
  present(raw: unknown): Promise<LivePresentationResult> {
    this.valid();
    const work = Promise.resolve().then(() => this.run(raw));
    this.pending.add(work);
    return work.then(
      (v) => {
        this.pending.delete(work);
        return v;
      },
      (e) => {
        this.pending.delete(work);
        throw e;
      },
    );
  }
  private async run(raw: unknown) {
    this.valid();
    const intent = livePresentationIntentSchema.parse(raw),
      old = this.records.get(intent.commandId);
    if (old) {
      if (!isDeepStrictEqual(old.intent, intent))
        throw new Error("Presentation ID already bound.");
      if (old.result) return structuredClone(old.result);
      throw new Error("Presentation outcome unresolved; do not replay.");
    }
    if (
      this.records.size >= 128 ||
      [...this.records.values()].some((r) =>
        ["prepared", "dispatching", "uncertain"].includes(r.phase),
      )
    )
      throw new Error("Prior presentation unresolved or limit reached.");
    const owner = ownerSchema.parse(await this.options.executionStatus()),
      camera: any = await this.options.cameraStatus(),
      identity = this.options.processIdentity(intent.window);
    if (!identity)
      throw new Error(
        "Verified native process identity required before presentation.",
      );
    const presentation = livePresentationSchema.parse({
      ...intent,
      version: 1,
      processIdentity: identity,
      expected: {
        requestId: this.options.requestId,
        sessionId: this.options.sessionId,
        leaseId: camera.leaseId,
        epoch: owner.epoch,
        cursor: owner.cursor,
        policyRevision: owner.policyRevision,
        displayId: this.options.displayId,
      },
    });
    const fingerprint = createHash("sha256")
        .update(canonical(presentation))
        .digest("hex"),
      record: RecordEntry = {
        intent,
        presentation,
        fingerprint,
        phase: "prepared",
        createdAt: Date.now(),
      };
    // Recheck admission after awaited reads, so two callers cannot reserve together.
    if (
      this.records.has(intent.commandId) ||
      [...this.records.values()].some((r) =>
        ["prepared", "dispatching", "uncertain"].includes(r.phase),
      )
    )
      throw new Error("Presentation busy.");
    this.records.set(intent.commandId, record);
    this.save();
    const fallback = (
      state: "rejected" | "uncertain",
      reason: string,
    ): LivePresentationResult => ({
      version: 1,
      commandId: intent.commandId,
      state,
      reason,
      fingerprint,
      receiptId: randomUUID(),
    });
    try {
      await this.authority(presentation);
    } catch {
      record.phase = "rejected";
      record.result = fallback("rejected", "authority_not_current");
      this.save();
      return record.result;
    }
    record.phase = "dispatching";
    this.save();
    try {
      const origin = this.options.mediaOrigin();
      if (!origin) throw new Error("Host unavailable.");
      const response = await fetch(
        `${origin}/sessions/${this.options.mediaSessionId}/native/present`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.hostToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ presentation, fingerprint }),
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const reasons = new Set<string>([
          ...nativeQualificationReasonSchema.options,
          "target_not_foreground",
          "presentation_stopped",
          "presentation_busy",
          "invalid_presentation",
          "presentation_fingerprint_mismatch",
          "presentation_authority_unavailable",
          "presentation_target_changed",
          "presentation_frame_unavailable",
          "presentation_bracket_changed",
          "presentation_camera_changed",
          "presentation_transaction_refused",
          "presentation_completion_unknown",
          "presentation_resolver_unavailable",
          "presentation_witness_expired",
        ]);
        if (
          body?.error === "live_presentation_unavailable" &&
          reasons.has(body.reason)
        )
          record.diagnostic = body.reason;
        throw new Error("Host result unavailable.");
      }
      const result = livePresentationResultSchema.parse(await response.json());
      if (
        result.commandId !== intent.commandId ||
        result.fingerprint !== fingerprint
      )
        throw new Error("Host result mismatch.");
      record.hostResult = result;
      if (result.state === "accepted") {
        const o = result.observation!,
          c = result.camera!,
          now = Date.now();
        if (
          !isDeepStrictEqual(o.window, intent.window) ||
          o.processIdentity !== identity ||
          !o.appActive ||
          !o.windowFocused ||
          !o.windowOnScreen ||
          now - o.observedAt > 2000 ||
          o.observedAt > now + 250 ||
          now - c.capturedAt > 2000 ||
          c.capturedAt > o.observedAt ||
          o.observedAt < record.createdAt
        )
          throw new Error("Host observation mismatch.");
        await this.authority(presentation);
      }
      record.phase = result.state;
      record.result = result;
    } catch {
      record.phase = "uncertain";
      record.result = fallback("uncertain", "presentation_completion_unknown");
    }
    this.save();
    return structuredClone(record.result!);
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    this.journal.close();
  }
}
