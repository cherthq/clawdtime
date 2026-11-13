export type CheckStatus = "pass" | "fail" | "unknown" | "not_applicable";
export interface ReadinessCheck {
  id: string;
  status: CheckStatus;
  message: string;
  nextAction?: string;
  reason?: ReadinessReason;
  checkedAt?: number;
}
export interface ReadinessSummary {
  mode: string;
  status: "live_ready" | "simulation_only" | "blocked";
  liveReady: boolean;
  connectionReady: boolean;
  checkedAt?: number;
  physicalAcceptance: false;
  checks: ReadinessCheck[];
  nextActions: string[];
}

export const readinessReasons = {
  agent_stale: {
    message: "The originating agent is stale or disconnected.",
    nextAction:
      "Reconnect the exact originating chat and recheck its heartbeat; preserve pending turn IDs.",
  },
  sharing_disabled: {
    message: "Sharing is stopped locally.",
    nextAction:
      "Use Enable on the intended Mac only when you intend to share; rechecking does not enable it.",
  },
  screen_permission: {
    message: "Screen Recording permission is unavailable.",
    nextAction:
      "Review Screen Recording for the intended companion in macOS Settings, then recheck.",
  },
  control_permission: {
    message: "Control permission is unavailable.",
    nextAction:
      "Review Accessibility and the local control policy before attempting shared-screen input.",
  },
  binding_mismatch: {
    message: "The selected Mac or display does not match this session.",
    nextAction:
      "Select the intended paired Mac/display in setup and verify this exact chat binding.",
  },
  gateway_unavailable: {
    message: "The selected gateway is unreachable.",
    nextAction:
      "Check the intended Mac's gateway connection. Unreachability alone does not establish that the Mac is asleep.",
  },
  native_approval: {
    message: "Native approval is pending in the coding client.",
    nextAction:
      "Review the pending permission in the original coding client; voice and readiness cannot approve it.",
  },
  unresolved_effect: {
    message: "A previous effect remains unresolved.",
    nextAction:
      "Inspect the original receipt and observed result; do not repeat the action or replace its ID.",
  },
} as const;
export type ReadinessReason = keyof typeof readinessReasons;
const reasonsByCheck: Record<string, ReadinessReason> = {
  session_heartbeat: "agent_stale",
  agent_connection: "agent_stale",
  locally_enabled: "sharing_disabled",
  local_arm: "sharing_disabled",
  display: "binding_mismatch",
  paired_device: "binding_mismatch",
  media_gateway: "gateway_unavailable",
  sharing_enabled: "sharing_disabled",
  armed: "sharing_disabled",
  screen_permission: "screen_permission",
  control_permission: "control_permission",
  device_binding: "binding_mismatch",
  display_binding: "binding_mismatch",
  gateway_connection: "gateway_unavailable",
  gateway: "gateway_unavailable",
  pending_approval: "native_approval",
  unknown_effects: "unresolved_effect",
  unresolved_actions: "unresolved_effect",
};
/** Fixed categories derived from explicit check IDs, never guessed from prose. */
export function explainReadiness(
  check: ReadinessCheck,
  checkedAt?: number,
): ReadinessCheck {
  const reason =
    check.reason && Object.hasOwn(readinessReasons, check.reason)
      ? check.reason
      : reasonsByCheck[check.id];
  if (!reason || check.status === "pass" || check.status === "not_applicable")
    return { ...check, ...(checkedAt === undefined ? {} : { checkedAt }) };
  return {
    ...check,
    reason,
    nextAction: check.nextAction ?? readinessReasons[reason].nextAction,
    ...(checkedAt === undefined ? {} : { checkedAt }),
  };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A paired account or an old ready:true flag is never live readiness evidence. */
export function summarizeReadiness(
  raw: Record<string, unknown>,
  localChecks: ReadinessCheck[] = [],
  now = Date.now(),
): ReadinessSummary {
  const report = record(raw.readiness);
  const mode =
    typeof report?.mode === "string"
      ? report.mode
      : typeof raw.mode === "string"
        ? raw.mode
        : "unknown";
  const checks: ReadinessCheck[] = [...localChecks];
  const reported = Array.isArray(report?.checks) ? report.checks : [];
  for (const item of reported) {
    const check = record(item);
    if (
      typeof check?.id !== "string" ||
      typeof check.message !== "string" ||
      !["pass", "fail", "unknown", "not_applicable"].includes(
        String(check.status),
      )
    ) {
      checks.push({
        id: "backend_report_format",
        status: "unknown",
        message: "Backend returned an incomplete readiness check.",
        nextAction:
          "Update the backend and rerun doctor; do not infer readiness from pairing.",
      });
      continue;
    }
    checks.push({
      id: check.id,
      status: check.status as CheckStatus,
      message: check.message,
      ...(typeof check.reason === "string" &&
      Object.hasOwn(readinessReasons, check.reason)
        ? { reason: check.reason as ReadinessReason }
        : {}),
      ...(typeof check.nextAction === "string"
        ? { nextAction: check.nextAction }
        : {}),
    });
  }
  const checkedAt =
    typeof report?.checkedAt === "number" && Number.isFinite(report.checkedAt)
      ? report.checkedAt
      : undefined;
  const fresh =
    checkedAt !== undefined &&
    now - checkedAt <= 30_000 &&
    checkedAt <= now + 5_000;
  if (!report || !reported.length)
    checks.push({
      id: "backend_readiness_evidence",
      status: "unknown",
      message:
        "No detailed live readiness evidence is available; pairing alone does not qualify calling or screen sharing.",
      nextAction:
        "Run the backend's read-only transport/media/helper preflight, then rerun doctor.",
    });
  else if (!fresh)
    checks.push({
      id: "backend_readiness_freshness",
      status: "unknown",
      message: "Readiness evidence is missing, stale or future-dated.",
      nextAction:
        "Wait for a fresh integration preflight and rerun doctor before any live request.",
    });
  if (mode !== "live")
    checks.push({
      id: "live_mode",
      status: "not_applicable",
      message:
        mode === "simulation"
          ? "This backend is simulation only; calls and Messages receipts are synthetic."
          : "Live dispatch is not enabled.",
      nextAction:
        "The lead must finish the documented line handoff and explicitly enable independent live services for a supervised test.",
    });
  const blocked = checks.some(
    (c) => c.status === "fail" || c.status === "unknown",
  );
  const connectionReady =
    localChecks.every(
      (c) => c.status === "pass" || c.status === "not_applicable",
    ) && !!record(raw.pairing);
  const liveReady =
    mode === "live" &&
    report?.liveReady === true &&
    fresh &&
    reported.length > 0 &&
    !blocked;
  if (
    mode === "live" &&
    !liveReady &&
    !checks.some((c) => c.status === "fail" || c.status === "unknown")
  )
    checks.push({
      id: "live_gate",
      status: "fail",
      message: "Backend has not qualified this live configuration.",
      nextAction:
        "Inspect backend readiness and resolve its live gate before requesting attention.",
    });
  return {
    mode,
    status: liveReady
      ? "live_ready"
      : mode === "simulation" && connectionReady
        ? "simulation_only"
        : "blocked",
    liveReady,
    connectionReady,
    ...(checkedAt === undefined ? {} : { checkedAt }),
    physicalAcceptance: false,
    checks: checks.map((check) => explainReadiness(check, checkedAt)),
    nextActions: [
      ...new Set(
        checks
          .map((check) => explainReadiness(check, checkedAt))
          .filter((c) => c.status !== "pass" && c.nextAction)
          .map((c) => c.nextAction!),
      ),
    ],
  };
}
export function requireAttentionReadiness(
  raw: Record<string, unknown>,
  now = Date.now(),
) {
  const summary = summarizeReadiness(raw, [], now);
  if (summary.mode !== "simulation" && !summary.liveReady)
    throw new Error(
      "Live attention is blocked by readiness. Call connection_status/doctor and resolve its listed line, media, gateway and helper checks; no call was requested.",
    );
  return summary;
}
