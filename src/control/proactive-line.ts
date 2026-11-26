import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { Hono } from "hono";
import { equal, hash, token, DomainError } from "../storage/security.js";
import type {
  CallAttemptGrant,
  ProactiveCallIntent,
} from "../attention/proactive-contracts.js";
import type { ProactivePolicyAuthority } from "../attention/proactive-policy.js";
import type { ProactiveReviewPacket } from "./proactive-preparation.js";

const bindingSchema = z
  .object({
    attemptId: z.string().min(1).max(200),
    roomName: z.string().min(1).max(200),
    agentIdentity: z.string().min(1).max(200),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    packetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ProactiveLineBinding = z.infer<typeof bindingSchema>;
const commandSchema = z
  .object({
    action: z.enum([
      "prepared",
      "status",
      "answer",
      "computer",
      "stop_computer",
      "stop_sharing",
      "close",
    ]),
    binding: bindingSchema,
    turnId: z.string().min(1).max(200).optional(),
    text: z.string().min(1).max(8000).optional(),
    callerIdentity: z.string().min(1).max(200).optional(),
    media: z
      .object({ audioReady: z.boolean(), videoReady: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();
interface Call {
  token: string;
  binding: ProactiveLineBinding;
  intent: ProactiveCallIntent;
  grant: CallAttemptGrant;
  packet: ProactiveReviewPacket;
  providerCallerIdentity: string | null;
  prepared: boolean;
  closed: boolean;
  sharingStopped: boolean;
  cleanupConfirmed: boolean;
  answerTail?: Promise<string>;
  unknownAnswer?: boolean;
  resultInvalidated?: boolean;
  answers: Map<string, { fingerprint: string; response: Promise<string> }>;
}
/** One ephemeral room capability per durable reserved attempt. Restart never
 * restores these tokens; the durable coordinator retains the unknown outcome. */
export class ProactiveLineSessions {
  private calls = new Map<string, Call>();
  constructor(
    private readonly authority: ProactivePolicyAuthority,
    private readonly ports: {
      sourceCurrent(intent: ProactiveCallIntent): boolean;
      answer(
        intent: ProactiveCallIntent,
        words: string,
        turnId: string,
      ): Promise<string>;
      stopSharing(intent: ProactiveCallIntent): Promise<{ confirmed: boolean }>;
      computer?: {
        submit(
          intent: ProactiveCallIntent,
          words: string,
          turnId: string,
        ): Promise<string>;
        renew(intent: ProactiveCallIntent): void;
        stop(intent: ProactiveCallIntent): string;
        close(intent: ProactiveCallIntent): void;
      };
      frame?(intent: ProactiveCallIntent): Promise<{
        bytes: Uint8Array;
        width: number;
        height: number;
        capturedAt: number;
        sourceFingerprint: string;
        claimsCurrent?: boolean;
      } | null>;
    },
    private readonly now = Date.now,
  ) {}
  open(
    intent: ProactiveCallIntent,
    grant: CallAttemptGrant,
    packet: ProactiveReviewPacket,
    room: { roomName: string; agentIdentity: string },
  ) {
    if (
      !this.authority.validateGrant(grant) ||
      intent.attemptId !== grant.attemptId ||
      grant.intentId !== intent.id ||
      grant.packetFingerprint !== packet.fingerprint ||
      packet.intentId !== intent.id ||
      packet.channel !== grant.channel ||
      packet.expiresAt <= this.now() ||
      packet.policyId !== grant.policyId ||
      packet.policyRevision !== grant.policyRevision ||
      !isDeepStrictEqual(packet.source, intent.source) ||
      !isDeepStrictEqual(grant.source, intent.source) ||
      !this.ports.sourceCurrent(intent)
    )
      throw new DomainError(
        403,
        "Exact current reserved call authority is required.",
      );
    if (this.calls.size || this.calls.has(grant.attemptId))
      throw new DomainError(409, "A phone runtime already owns this service.");
    const binding = bindingSchema.parse({
      attemptId: grant.attemptId,
      ...room,
      sourceFingerprint: packet.sourceFingerprint,
      packetFingerprint: packet.fingerprint,
    });
    const secret = token();
    this.calls.set(grant.attemptId, {
      token: secret,
      binding,
      intent,
      grant,
      packet: structuredClone(packet),
      providerCallerIdentity: null,
      prepared: false,
      closed: false,
      sharingStopped: false,
      cleanupConfirmed: false,
      answers: new Map(),
    });
    return {
      version: 1 as const,
      token: secret,
      ...binding,
      expiresAt: grant.expiresAt,
    };
  }
  bindCaller(attemptId: string, providerCallerIdentity: string) {
    const call = this.calls.get(attemptId);
    if (
      !call ||
      call.closed ||
      !this.authority.validateGrant(call.grant) ||
      !providerCallerIdentity ||
      (call.providerCallerIdentity &&
        call.providerCallerIdentity !== providerCallerIdentity)
    )
      throw new DomainError(409, "Provider caller binding differs.");
    call.providerCallerIdentity = providerCallerIdentity;
  }
  private authorized(
    attemptId: string,
    credential: string,
    binding: ProactiveLineBinding,
    cleanup = false,
  ) {
    const call = this.calls.get(attemptId);
    if (
      !call ||
      !equal(credential, call.token) ||
      !isDeepStrictEqual(bindingSchema.parse(binding), call.binding)
    )
      throw new DomainError(403, "Exact phone runtime capability required.");
    if (
      !cleanup &&
      (call.closed ||
        !this.authority.validateGrant(call.grant) ||
        this.now() >= call.grant.expiresAt)
    ) {
      this.ports.computer?.close(call.intent);
      throw new DomainError(403, "Phone runtime authority ended.");
    }
    return call;
  }
  /** This grant is separate from result freshness and never upgrades old calls. */
  permitsComputer(attemptId: string) {
    const call = this.calls.get(attemptId);
    return (
      !!call &&
      !!this.ports.computer &&
      call.grant.inputAllowed &&
      call.grant.channel === "phone_walkthrough" &&
      call.grant.viewScope.includes("selected-display") &&
      call.prepared &&
      !!call.providerCallerIdentity &&
      !call.closed &&
      !call.sharingStopped &&
      !call.unknownAnswer &&
      this.now() < call.grant.expiresAt &&
      this.authority.validateGrant(call.grant)
    );
  }
  private response(call: Call, message?: string) {
    const current =
      !call.resultInvalidated && this.ports.sourceCurrent(call.intent);
    return {
      authorized: !call.closed && this.authority.validateGrant(call.grant),
      ...call.binding,
      channel: call.grant.channel,
      providerCallerIdentity: call.providerCallerIdentity,
      narration: current
        ? call.packet.narration
        : "The work changed after this walkthrough was prepared. The previous result is no longer current.",
      ...(current && call.packet.question
        ? { question: call.packet.question }
        : {}),
      ...(message ? { message } : {}),
      expiresAt: call.grant.expiresAt,
      sharingAllowed:
        this.authority.validateGrant(call.grant) &&
        call.grant.channel === "phone_walkthrough" &&
        !call.sharingStopped &&
        !call.closed,
      ended: call.closed,
      computerAllowed: this.permitsComputer(call.grant.attemptId),
    };
  }
  async command(attemptId: string, credential: string, raw: unknown) {
    const command = commandSchema.parse(raw);
    const call = this.authorized(
      attemptId,
      credential,
      command.binding,
      ["close", "stop_sharing", "stop_computer"].includes(command.action),
    );
    if (command.action === "prepared") {
      if (!command.media?.audioReady || !command.media.videoReady)
        throw new DomainError(
          409,
          "Stable warm audio and video publications required.",
        );
      call.prepared = true;
    } else if (command.action === "status") {
      if (this.permitsComputer(attemptId))
        this.ports.computer?.renew(call.intent);
      else this.ports.computer?.close(call.intent);
    } else if (command.action === "answer" || command.action === "computer") {
      if (
        !call.prepared ||
        !command.turnId ||
        !command.text ||
        !call.providerCallerIdentity ||
        command.callerIdentity !== call.providerCallerIdentity
      )
        throw new DomainError(
          403,
          "Exact provider caller and speech turn required.",
        );
      const fingerprint = hash(
        JSON.stringify([command.action, command.text, command.callerIdentity]),
      );
      const prior = call.answers.get(command.turnId);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new DomainError(
            409,
            "Phone turn conflicts with its original receipt.",
          );
        return this.response(call, await prior.response);
      }
      if (call.answers.size >= 256)
        throw new DomainError(409, "Phone turn limit reached.");
      const response = Promise.resolve(call.answerTail).then(() => {
        if (call.unknownAnswer)
          throw new DomainError(
            409,
            "An earlier phone answer has an unknown outcome.",
          );
        // Revalidate immediately before the exact source effect, after every wait.
        this.authorized(attemptId, credential, command.binding);
        if (command.action === "computer") {
          if (!this.permitsComputer(attemptId))
            return "Computer control is not enabled for this walkthrough. No action was sent.";
          if (command.text!.length > 2000)
            return "Please give a shorter computer request. No action was sent.";
          return this.ports.computer!.submit(
            call.intent,
            command.text!,
            command.turnId!,
          );
        }
        if (call.resultInvalidated || !this.ports.sourceCurrent(call.intent))
          return "That request is no longer pending. No answer was applied.";
        return this.ports.answer(call.intent, command.text!, command.turnId!);
      });
      call.answerTail = response.catch((error) => {
        call.unknownAnswer = true;
        this.ports.computer?.close(call.intent);
        throw error;
      });
      void call.answerTail.catch(() => {});
      call.answers.set(command.turnId, { fingerprint, response });
      return this.response(call, await response);
    } else if (command.action === "stop_computer") {
      return this.response(
        call,
        this.ports.computer?.stop(call.intent) ??
          "No computer work is owned by this call.",
      );
    } else if (
      command.action === "stop_sharing" ||
      command.action === "close"
    ) {
      call.sharingStopped = true;
      if (command.action === "close") call.closed = true;
      this.ports.computer?.close(call.intent);
      const cleanup = await this.ports.stopSharing(call.intent);
      call.cleanupConfirmed = cleanup.confirmed;
    }
    return this.response(call);
  }
  async frame(
    attemptId: string,
    credential: string,
    binding: ProactiveLineBinding,
  ) {
    const call = this.authorized(attemptId, credential, binding);
    if (
      !call.prepared ||
      !call.providerCallerIdentity ||
      call.grant.channel !== "phone_walkthrough" ||
      call.sharingStopped ||
      !this.ports.frame
    )
      throw new DomainError(403, "Screen viewing is not authorized.");
    const frame = await this.ports.frame(call.intent);
    this.authorized(attemptId, credential, binding);
    if (
      !frame ||
      call.sharingStopped ||
      frame.sourceFingerprint !== call.packet.sourceFingerprint ||
      ((!this.ports.sourceCurrent(call.intent) || call.resultInvalidated) &&
        frame.claimsCurrent !== false) ||
      !Number.isFinite(frame.capturedAt) ||
      frame.capturedAt > this.now() ||
      this.now() - frame.capturedAt >= 1000 ||
      !Number.isInteger(frame.width) ||
      !Number.isInteger(frame.height) ||
      frame.width < 1 ||
      frame.height < 1 ||
      frame.width > 2400 ||
      frame.height > 2400 ||
      frame.width * frame.height > 4_000_000 ||
      frame.bytes.length !== frame.width * frame.height * 4
    )
      throw new DomainError(409, "Fresh exact prepared frame unavailable.");
    if (frame.claimsCurrent === false) call.resultInvalidated = true;
    return {
      ...frame,
      attemptId,
      packetFingerprint: call.packet.fingerprint,
      viewId: call.packet.walkthroughOrder[0] ?? "prepared-review",
      frameId: randomUUID(),
      expiresAt: Math.min(frame.capturedAt + 1000, call.grant.expiresAt),
    };
  }
  status(attemptId: string) {
    const call = this.calls.get(attemptId);
    return call
      ? {
          prepared: call.prepared,
          closed: call.closed,
          cleanupConfirmed: call.cleanupConfirmed,
        }
      : null;
  }
  /** Trusted transport reconciliation, never exposed as a phone HTTP command. */
  confirmClosed(
    attemptId: string,
    evidence: {
      captureCleanupConfirmed: boolean;
      mediaClosed: boolean;
      providerEnded: boolean;
    },
  ) {
    if (
      !evidence.captureCleanupConfirmed ||
      !evidence.mediaClosed ||
      !evidence.providerEnded
    )
      throw new DomainError(
        409,
        "Provider, media, and capture cleanup must all be confirmed.",
      );
    const call = this.calls.get(attemptId);
    if (!call) return;
    call.closed = true;
    call.sharingStopped = true;
    this.ports.computer?.close(call.intent);
    call.cleanupConfirmed = true;
    this.calls.delete(attemptId);
  }
  release(attemptId: string, providerEnded: boolean) {
    const call = this.calls.get(attemptId);
    if (!call || !providerEnded || !call.cleanupConfirmed)
      throw new DomainError(
        409,
        "Provider termination and capture cleanup must both be confirmed.",
      );
    this.ports.computer?.close(call.intent);
    this.calls.delete(attemptId);
  }
}

export function mountProactiveLine(app: Hono, sessions: ProactiveLineSessions) {
  const credential = (value?: string) =>
    value?.startsWith("Bearer ") ? value.slice(7) : "";
  app.post("/proactive/line/:attemptId", async (c) =>
    c.json(
      await sessions.command(
        c.req.param("attemptId"),
        credential(c.req.header("authorization")),
        await c.req.json(),
      ),
    ),
  );
  app.get("/proactive/line/:attemptId/frame", async (c) => {
    const frame = await sessions.frame(
      c.req.param("attemptId"),
      credential(c.req.header("authorization")),
      {
        attemptId: c.req.header("X-ClawdTime-Attempt") ?? "",
        roomName: c.req.header("X-ClawdTime-Room") ?? "",
        agentIdentity: c.req.header("X-ClawdTime-Agent") ?? "",
        sourceFingerprint: c.req.header("X-ClawdTime-Source") ?? "",
        packetFingerprint: c.req.header("X-ClawdTime-Packet") ?? "",
      },
    );
    const { bytes, ...metadata } = frame;
    c.header("Content-Type", "application/octet-stream");
    c.header("Cache-Control", "no-store");
    c.header("X-ClawdTime-Frame", JSON.stringify(metadata));
    return c.body(new Uint8Array(frame.bytes).buffer);
  });
}
