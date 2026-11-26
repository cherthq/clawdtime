import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { secureWrite } from "../../connectors/shared/state.js";
import { DomainError } from "../storage/security.js";
import type { ProactiveCallIntent } from "../attention/proactive-contracts.js";
import type { ProactivePolicy } from "../attention/proactive-policy.js";
import type {
  ProactivePreparedView,
  ProactiveSourceEvidence,
} from "./proactive-preparation.js";
import { CaptureChild, joinChild, oneJSON } from "./proactive-views.js";
import {
  openWalkthroughArtifact,
  type WalkthroughArtifact,
} from "./proactive-artifact.js";

export const sharedDisplayTargetSchema = z
  .object({
    displayId: z.number().int().min(1).max(0xffffffff),
    // CoreGraphics display UUIDs need not carry an RFC version nibble.
    displayUUID: z
      .string()
      .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i),
    x: z.number().finite().min(-65536).max(65536),
    y: z.number().finite().min(-65536).max(65536),
    width: z.number().finite().min(1).max(65536),
    height: z.number().finite().min(1).max(65536),
  })
  .strict();
export type SharedDisplayTarget = z.infer<typeof sharedDisplayTargetSchema>;
export const displayViewScope = "selected-display";
type OwnedDisplay = {
  intent: ProactiveCallIntent;
  fingerprint: string;
  directory: string;
  expiresAt: number;
  stopped: boolean;
  resolver?: ChildProcessWithoutNullStreams;
  capture?: CaptureChild<SharedDisplayTarget>;
  closing?: Promise<{ confirmed: boolean; receiptId?: string }>;
  recovering?: Promise<void>;
};

/** A protected operator-selected display, never a model-selected capture target. */
export class ProactiveDisplayViews {
  private owned?: OwnedDisplay;
  private preparing?: { intentId: string; canceled: boolean };
  private recoveryUnknown: boolean;
  private get ownerFile() {
    return join(this.config.directory, "ownership.json");
  }
  constructor(
    private readonly config: {
      captureBinary: string;
      directory: string;
      target: SharedDisplayTarget;
      artifacts?: WalkthroughArtifact[];
    },
    private readonly ports: {
      assertIdle(): void;
      authorize(intent: ProactiveCallIntent): void;
      evidence(intent: ProactiveCallIntent): Promise<ProactiveSourceEvidence>;
    },
  ) {
    sharedDisplayTargetSchema.parse(config.target);
    this.recoveryUnknown = existsSync(this.ownerFile);
  }
  get occupied() {
    return !!this.owned || !!this.preparing || this.recoveryUnknown;
  }
  owns(intentId: string) {
    return (
      this.owned?.intent.id === intentId &&
      !this.owned.stopped &&
      !!this.owned.capture &&
      this.owned.expiresAt > Date.now()
    );
  }
  private persist() {
    const owned = this.owned!;
    secureWrite(this.ownerFile, {
      version: 1,
      intentId: owned.intent.id,
      state: "preparing_or_active",
      directory: owned.directory,
      display: this.config.target,
      resolverPid: owned.resolver?.pid ?? null,
      capturePid: owned.capture?.process.pid ?? null,
      captureBinary: this.config.captureBinary,
    });
  }
  async prepare(input: {
    intent: ProactiveCallIntent;
    policy: ProactivePolicy;
    sourceFingerprint: string;
  }): Promise<ProactivePreparedView[]> {
    if (this.occupied) throw new DomainError(409, "display_owner_busy");
    const preparing = { intentId: input.intent.id, canceled: false };
    this.preparing = preparing;
    const authorize = () => {
      if (
        preparing.canceled ||
        this.preparing !== preparing ||
        this.owned?.stopped
      )
        throw new DomainError(409, "display_stopped");
      this.ports.authorize(input.intent);
    };
    try {
      this.ports.assertIdle();
      authorize();
      if (!input.policy.viewScope.includes(displayViewScope))
        throw new DomainError(403, "display_scope_missing");
      const evidence = await this.ports.evidence(input.intent);
      authorize();
      if (
        !evidence.current ||
        evidence.sourceFingerprint !== input.sourceFingerprint
      )
        throw new DomainError(409, "source_changed_before_display");
      mkdirSync(this.config.directory, { recursive: true, mode: 0o700 });
      writeFileSync(
        this.ownerFile,
        JSON.stringify({
          version: 1,
          intentId: input.intent.id,
          state: "preparing_or_active",
        }),
        { mode: 0o600, flag: "wx" },
      );
      this.recoveryUnknown = true;
      const directory = join(this.config.directory, randomUUID());
      mkdirSync(directory, { mode: 0o700 });
      const owned: OwnedDisplay = {
        intent: input.intent,
        fingerprint: input.sourceFingerprint,
        directory,
        expiresAt: Math.min(
          input.policy.expiresAt,
          input.intent.expiresAt,
          Date.now() + 900000,
        ),
        stopped: false,
      };
      this.owned = owned;
      this.persist();
      const resolver = oneJSON(
        this.config.captureBinary,
        ["--resolve-display", String(this.config.target.displayId)],
        true,
      );
      owned.resolver = resolver.child;
      this.persist();
      const actual = sharedDisplayTargetSchema.parse(await resolver.result);
      authorize();
      if (!isDeepStrictEqual(actual, this.config.target))
        throw new DomainError(409, "selected_display_changed");
      await openWalkthroughArtifact(
        this.config.artifacts ?? [],
        input.intent,
        this.config.directory,
        () => {
          this.ports.assertIdle();
          authorize();
        },
      );
      const file = join(directory, "capture.json");
      writeFileSync(
        file,
        JSON.stringify({
          presentationId: `display_${input.intent.id}`,
          expiresAt: owned.expiresAt,
          target: actual,
        }),
        { mode: 0o600, flag: "wx" },
      );
      this.ports.assertIdle();
      authorize();
      owned.capture = new CaptureChild<SharedDisplayTarget>(
        this.config.captureBinary,
        file,
        "--display-config",
      );
      this.persist();
      const frame = await this.frame(input.intent);
      authorize();
      if (!frame || !frame.claimsCurrent)
        throw new DomainError(409, "display_frame_unavailable");
      return [
        {
          id: displayViewScope,
          scope: displayViewScope,
          title: "Mac display",
          displayId: String(actual.displayId),
          sourceFingerprint: owned.fingerprint,
          frameObservedAt: frame.capturedAt,
        },
      ];
    } finally {
      if (this.preparing === preparing) this.preparing = undefined;
    }
  }
  async frame(intent: ProactiveCallIntent) {
    const owned = this.owned;
    if (
      !owned ||
      owned.intent.id !== intent.id ||
      owned.stopped ||
      !owned.capture ||
      owned.expiresAt <= Date.now()
    )
      return null;
    this.ports.authorize(intent);
    if (owned.recovering) return null;
    let frame;
    try {
      frame = await owned.capture.capture(this.config.target);
    } catch {
      if (owned.capture.unavailable && !owned.recovering && !owned.stopped) {
        const previous = owned.capture;
        owned.recovering = (async () => {
          // A dead or desynchronized capture owner is replaced only after its
          // process has joined. Reuse the exact original display grant.
          if (!(await previous.close()))
            throw Error("display_capture_cleanup_unknown");
          if (owned.stopped || this.owned !== owned) return;
          this.ports.authorize(intent);
          owned.capture = new CaptureChild<SharedDisplayTarget>(
            this.config.captureBinary,
            join(owned.directory, "capture.json"),
            "--display-config",
          );
          this.persist();
        })();
        try {
          await owned.recovering;
        } finally {
          owned.recovering = undefined;
        }
      }
      return null;
    }
    this.ports.authorize(intent);
    const evidence = await this.ports.evidence(intent);
    this.ports.authorize(intent);
    if (
      owned.stopped ||
      this.owned !== owned ||
      owned.expiresAt <= Date.now() ||
      frame.capturedAt > Date.now() ||
      Date.now() - frame.capturedAt >= 1000
    )
      return null;
    // The desktop remains live during continuation; it does not attest an old result.
    return {
      ...frame,
      sourceFingerprint: owned.fingerprint,
      claimsCurrent:
        evidence.current && evidence.sourceFingerprint === owned.fingerprint,
    };
  }
  async release(intentId: string) {
    if (this.preparing?.intentId === intentId) this.preparing.canceled = true;
    const owned = this.owned;
    if (!owned)
      return this.recoveryUnknown
        ? { confirmed: false }
        : { confirmed: true, receiptId: `no-display:${intentId}` };
    if (owned.intent.id !== intentId) return { confirmed: false };
    owned.stopped = true;
    return (owned.closing ??= (async () => {
      await owned.recovering?.catch(() => {});
      const capture = owned.capture ? await owned.capture.close() : true;
      const resolver = owned.resolver ? await joinChild(owned.resolver) : true;
      if (!capture || !resolver) return { confirmed: false };
      rmSync(owned.directory, { recursive: true, force: true });
      rmSync(this.ownerFile, { force: true });
      this.owned = undefined;
      this.recoveryUnknown = false;
      return { confirmed: true, receiptId: `display-closed:${intentId}` };
    })());
  }
}
