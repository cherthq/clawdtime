export type CheckStatus = "pass" | "fail" | "unknown" | "not_applicable";
export interface ReadinessCheck {
  id: string;
  status: CheckStatus;
  message: string;
  nextAction?: string;
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
    checks,
    nextActions: [
      ...new Set(
        checks
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
