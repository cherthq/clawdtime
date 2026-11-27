import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { DomainError, id, type Vault } from "../storage/security.js";
import type { Store } from "../storage/store.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
import {
  callChannelSchema,
  callTriggerSchema,
  type CallAttemptGrant,
  type CallSource,
  type CallTrigger,
  type EnqueueCall,
} from "./proactive-contracts.js";

/**
 * Computer control is for a call about a result: a job or a session that
 * finished. Such a call asks the caller nothing of its own, so a spoken yes
 * can only answer a question that the computer task asked in this call. A
 * call about a decision, a task review or a computer question keeps its one
 * question and takes no computer input, under any policy.
 */
export const computerControlSubject = (
  source: Pick<CallSource, "kind">,
  trigger: CallTrigger,
) =>
  (source.kind === "job" || source.kind === "session") &&
  trigger !== "decision";

const identity = z.string().min(1).max(300);
export const proactivePolicySchema = z
  .object({
    version: z.literal(2),
    id: identity,
    scope: z
      .object({
        personId: identity,
        deviceId: identity,
        projectRoot: z.string().min(1).max(2000),
        sessionId: identity.optional(),
        taskId: identity.optional(),
      })
      .strict(),
    triggers: z.array(callTriggerSchema).min(1).max(5),
    channels: z.array(callChannelSchema).min(1).max(2),
    expiresAt: z.number().finite().positive(),
    maxAttempts: z.number().int().min(1).max(10000),
    minIntervalMs: z.number().int().min(0).max(86400000),
    attemptLifetimeMs: z.number().int().min(1000).max(3600000),
    allowedHours: z
      .object({
        timeZone: z.string().min(1).max(100),
        startHour: z.number().int().min(0).max(23),
        endHour: z.number().int().min(0).max(24),
      })
      .strict()
      .optional(),
    viewScope: z.array(z.string().min(1).max(2000)).max(32),
    allowComputerControl: z.boolean().optional(),
    alertFallback: z.boolean(),
    consent: z
      .object({
        actorId: identity,
        recordedAt: z.number().finite().nonnegative(),
        source: z.enum(["operator", "human_request"]),
        statement: z.string().trim().min(1).max(2000),
      })
      .strict(),
  })
  .strict();
export type ProactivePolicyInput = z.infer<typeof proactivePolicySchema>;
export interface ProactivePolicy extends ProactivePolicyInput {
  revision: number;
  createdAt: number;
  revokedAt?: number;
  attempts: number;
  lastAttemptAt?: number;
}
export interface PolicyInspection {
  allowed: boolean;
  reason?: string;
  policy?: ProactivePolicy;
}

/** Only the protected operator/human-request boundary may register consent. Worker output
 * is never a policy. Existing version-1 one-call envelopes are deliberately not accepted. */
export class ProactivePolicyAuthority {
  private policies: ProtectedTaskStore<ProactivePolicy>;
  private grants: ProtectedTaskStore<CallAttemptGrant>;
  constructor(
    private readonly store: Store,
    vault: Vault,
    private readonly clock: () => number = Date.now,
  ) {
    this.policies = new ProtectedTaskStore(
      store,
      vault,
      "proactive-call-policy-v2",
    );
    this.grants = new ProtectedTaskStore(
      store,
      vault,
      "proactive-call-attempt-grant-v2",
    );
  }
  register(input: ProactivePolicyInput): ProactivePolicy {
    const value = proactivePolicySchema.parse(input),
      now = this.clock();
    if (
      value.expiresAt <= now ||
      value.consent.recordedAt > now ||
      value.consent.actorId !== value.scope.personId
    )
      throw new DomainError(
        400,
        "Calling policy requires current explicit consent by its person.",
      );
    if (value.channels.includes("phone_walkthrough") && !value.viewScope.length)
      throw new DomainError(
        400,
        "Walkthrough policy requires an explicit view scope.",
      );
    if (
      value.allowComputerControl &&
      (!value.channels.includes("phone_walkthrough") ||
        !value.viewScope.includes("selected-display"))
    )
      throw new DomainError(
        400,
        "Computer control requires a selected-display walkthrough.",
      );
    if (value.allowedHours) {
      new Intl.DateTimeFormat("en-US", {
        timeZone: value.allowedHours.timeZone,
      }).format(now);
      if (value.allowedHours.startHour === value.allowedHours.endHour)
        throw new DomainError(
          400,
          "Allowed hours must have a nonempty interval.",
        );
    }
    return this.store.transaction(() => {
      const prior = this.policies.get(value.id);
      if (prior) {
        const {
          revision: _r,
          createdAt: _c,
          attempts: _a,
          lastAttemptAt: _l,
          revokedAt: _v,
          ...registered
        } = prior;
        if (
          JSON.stringify(registered) !== JSON.stringify(value) ||
          prior.revokedAt !== undefined
        )
          throw new DomainError(
            409,
            "Policy identity already exists; new consent requires a new policy ID.",
          );
        return prior;
      }
      return this.policies.put({
        ...value,
        revision: 1,
        createdAt: now,
        attempts: 0,
      });
    });
  }
  get(policyId: string) {
    return this.policies.get(policyId);
  }
  list() {
    return this.policies.all();
  }
  revoke(policyId: string) {
    return this.store.transaction(() => {
      const policy = this.get(policyId);
      if (!policy) throw new DomainError(404, "Calling policy is unavailable.");
      if (policy.revokedAt !== undefined) return policy;
      return this.policies.put({
        ...policy,
        revokedAt: this.clock(),
        revision: policy.revision + 1,
      });
    });
  }
  inspect(
    input: Pick<
      EnqueueCall,
      "policyId" | "scope" | "source" | "trigger" | "channel"
    >,
    options: { ignoreBudget?: boolean } = {},
  ): PolicyInspection {
    const policy = this.get(input.policyId),
      now = this.clock();
    const denied = (reason: string): PolicyInspection => ({
      allowed: false,
      reason,
      ...(policy ? { policy } : {}),
    });
    if (!policy) return denied("policy_missing");
    if (policy.revokedAt !== undefined) return denied("policy_revoked");
    if (policy.expiresAt <= now) return denied("policy_expired");
    const scope = input.scope;
    if (
      Object.entries(policy.scope).some(
        ([key, value]) => scope[key as keyof typeof scope] !== value,
      ) ||
      input.source.sessionId !== scope.sessionId ||
      (input.source.kind === "task" && input.source.taskId !== scope.taskId)
    )
      return denied("policy_scope_mismatch");
    if (!policy.triggers.includes(input.trigger))
      return denied("trigger_not_authorized");
    if (!policy.channels.includes(input.channel))
      return denied("channel_not_authorized");
    if (input.channel === "phone_walkthrough" && !policy.viewScope.length)
      return denied("view_scope_missing");
    if (policy.allowedHours) {
      const hour = Number(
        new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          hourCycle: "h23",
          timeZone: policy.allowedHours.timeZone,
        }).format(now),
      );
      const { startHour: start, endHour: end } = policy.allowedHours;
      if (
        !(start < end
          ? hour >= start && hour < end
          : hour >= start || hour < end)
      )
        return denied("quiet_hours");
    }
    if (!options.ignoreBudget && policy.attempts >= policy.maxAttempts)
      return denied("call_budget_exhausted");
    if (
      !options.ignoreBudget &&
      policy.lastAttemptAt !== undefined &&
      now - policy.lastAttemptAt < policy.minIntervalMs
    )
      return denied("call_rate_limited");
    return { allowed: true, policy };
  }
  /** Called inside the coordinator's atomic reservation; this consumes an attempt, not a reusable call approval. */
  issueAttempt(
    input: EnqueueCall & {
      intentId: string;
      attemptId: string;
      packetFingerprint: string;
    },
  ): CallAttemptGrant {
    return this.store.transaction(() => {
      if (
        this.grants
          .all()
          .some(
            (grant) =>
              grant.attemptId === input.attemptId ||
              grant.intentId === input.intentId,
          )
      )
        throw new DomainError(
          409,
          "A grant already exists for this intent or attempt; do not redial.",
        );
      if (!/^[a-f0-9]{64}$/.test(input.packetFingerprint))
        throw new DomainError(400, "Invalid prepared packet fingerprint.");
      const inspection = this.inspect(input);
      if (!inspection.allowed || !inspection.policy)
        throw new DomainError(
          403,
          inspection.reason ?? "Calling policy denied.",
        );
      const policy = inspection.policy,
        now = this.clock();
      const grant: CallAttemptGrant = {
        version: 2,
        id: id("callgrant"),
        policyId: policy.id,
        policyRevision: policy.revision,
        packetFingerprint: input.packetFingerprint,
        intentId: input.intentId,
        attemptId: input.attemptId,
        source: input.source,
        scope: input.scope,
        channel: input.channel,
        issuedAt: now,
        expiresAt: Math.min(
          input.expiresAt,
          policy.expiresAt,
          now + policy.attemptLifetimeMs,
        ),
        viewScope:
          input.channel === "phone_walkthrough" ? [...policy.viewScope] : [],
        inputAllowed:
          policy.allowComputerControl === true &&
          input.channel === "phone_walkthrough" &&
          policy.viewScope.includes("selected-display") &&
          computerControlSubject(input.source, input.trigger),
      };
      if (grant.expiresAt <= now)
        throw new DomainError(403, "Call intent expired.");
      this.policies.put({
        ...policy,
        attempts: policy.attempts + 1,
        lastAttemptAt: now,
      });
      return this.grants.put(grant);
    });
  }
  validateGrant(grant: CallAttemptGrant) {
    const stored = this.grants.get(grant.id),
      policy = this.get(grant.policyId);
    return (
      !!stored &&
      isDeepStrictEqual(stored, grant) &&
      !!policy &&
      policy.revokedAt === undefined &&
      policy.revision === grant.policyRevision &&
      policy.expiresAt > this.clock() &&
      grant.expiresAt > this.clock()
    );
  }
  grant(id: string) {
    return this.grants.get(id);
  }
}
