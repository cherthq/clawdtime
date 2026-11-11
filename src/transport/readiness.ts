import { z } from "zod";
import { DomainError } from "../storage/security.js";
import type { NativeTransportConfig } from "./native.js";
export class PreflightBlocked extends DomainError {
  constructor(message: string) {
    super(503, message);
  }
}
export type CheckStatus = "pass" | "fail" | "unknown" | "not_applicable";
export interface ReadinessCheck {
  id: string;
  status: CheckStatus;
  message: string;
  nextAction?: string;
}
export interface TransportReadiness {
  checkedAt: number;
  mode: "live";
  liveReady: boolean;
  checks: ReadinessCheck[];
  bindingFingerprint: string;
}
export interface DeviceReadiness {
  checkedAt: number;
  deviceId: string;
  memberId: string;
  displayId: string;
  bindingFingerprint: string;
  checks: ReadinessCheck[];
}
export const READINESS_MAX_AGE_MS = 30_000;
export function freshEvidence(checkedAt: number, now: number) {
  return (
    Number.isFinite(checkedAt) &&
    checkedAt <= now + 1000 &&
    now - checkedAt <= READINESS_MAX_AGE_MS
  );
}
const text = z.string().trim().min(1);
const httpsOrigin = z.string().refine((value) => {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      u.origin === value &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
});
/** Fixed messages only. Never include parsed values, secrets or phone numbers. */
export function configurationChecks(
  config: NativeTransportConfig,
  now = Date.now(),
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  checks.push({
    id: "live_gate",
    status: config.enabled === true ? "pass" : "fail",
    message:
      config.enabled === true
        ? "The explicit transport traffic gate is configured."
        : "The transport remains in standby.",
    ...(config.enabled !== true
      ? {
          nextAction:
            "Keep standby until identity, source pause, cursor and rollback evidence are complete.",
        }
      : {}),
  });
  const binding = z
    .object({
      origin: httpsOrigin,
      token: z.string().min(16),
      signingSecret: z.string().min(16),
      lineId: z.string().uuid(),
      providerLineId: text,
      phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
      instanceId: text,
    })
    .safeParse(config.binding);
  checks.push({
    id: "native_configuration",
    status: binding.success ? "pass" : "fail",
    message: binding.success
      ? "Exact native identity and protected connection fields are configured."
      : "Native line configuration is incomplete or invalid.",
    ...(!binding.success
      ? {
          nextAction:
            "Provide the verified logical UUID, native provider/instance identity, E.164 line and protected credentials.",
        }
      : {}),
  });
  const credentials = z
    .object({
      callsOrigin: httpsOrigin,
      projectId: text,
      projectKey: z.string().min(16),
      mediaOrigin: httpsOrigin,
      mediaKey: z.string().min(32),
      encryptionKey: z.string().regex(/^[a-f0-9]{64}$/i),
      testerAllowlist: z.array(z.string().regex(/^\+[1-9]\d{7,14}$/)).min(1),
    })
    .safeParse(config);
  const independent =
    credentials.success &&
    config.mediaKey !== config.projectKey &&
    config.mediaKey !== config.binding.token &&
    config.mediaKey !== config.binding.signingSecret;
  checks.push({
    id: "service_configuration",
    status: independent ? "pass" : "fail",
    message: independent
      ? "Independent media/authentication fields and tester allowlist are configured."
      : "Live service credentials, origins or tester allowlist need correction.",
    ...(!independent
      ? {
          nextAction:
            "Use independent backend/media resources and fresh media credentials; configure the intended tester only.",
        }
      : {}),
  });
  const h = config.handoff;
  const exclusive =
    !!h &&
    h.owner === "clawdtime" &&
    h.sourceOwnerPaused === true &&
    h.lineId === config.binding.lineId &&
    h.providerLineId === config.binding.providerLineId &&
    h.instanceId === config.binding.instanceId &&
    h.phone === config.binding.phone &&
    !!h.identityEvidence?.trim() &&
    !!h.sourcePauseEvidence?.trim() &&
    !!h.rollbackRecord?.trim() &&
    Number.isFinite(h.checkedAt) &&
    h.checkedAt > 0 &&
    h.checkedAt <= now + 1000;
  checks.push({
    id: "line_handoff",
    status: exclusive ? "pass" : "fail",
    message: exclusive
      ? "Exact line identity, source pause and rollback evidence are recorded; this is an operator attestation."
      : "Exclusive ownership and exact requested-line evidence are incomplete.",
    ...(!exclusive
      ? {
          nextAction:
            "Complete the controlled handoff and record matching phone, identityEvidence, sourcePauseEvidence and rollbackRecord privately.",
        }
      : {}),
  });
  const baseline =
    !!h &&
    Number.isSafeInteger(h.baseline?.sequence) &&
    h.baseline.sequence > 0 &&
    typeof h.baseline.eventId === "string" &&
    h.baseline.eventId.length > 0;
  checks.push({
    id: "handoff_boundary",
    status: baseline ? "pass" : "fail",
    message: baseline
      ? "A retained non-replaying event boundary is configured."
      : "A verified retained event boundary is missing.",
  });
  return checks;
}
