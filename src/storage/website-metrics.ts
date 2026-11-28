import { z } from "zod";
import type { Store } from "./store.js";

/** Only public marketing paths belong here. Never accept arbitrary URLs. */
export const WEBSITE_PUBLIC_PATHS = [
  "/",
  "/pricing",
  "/privacy",
  "/integrations/codex",
  "/integrations/claude-code",
  "/guides/getting-started",
] as const;

const dimensions = {
  path: z.enum(WEBSITE_PUBLIC_PATHS),
  channel: z.enum(["direct", "search", "ai", "social", "referral"]),
  availability: z.enum(["preview", "invited"]),
};

/** Reject extra keys instead of silently accepting and possibly retaining PII. */
export const websiteBrowserEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("landing_view"), ...dimensions }).strict(),
  z
    .object({
      event: z.literal("pilot_cta_clicked"),
      ...dimensions,
      placement: z.enum([
        "header",
        "hero",
        "availability",
        "footer",
        "content",
      ]),
      action: z.enum([
        "availability",
        "setup",
        "guide",
        "download",
        "install_command",
        "copy_prompt",
      ]),
    })
    .strict(),
]);

export type WebsiteBrowserEvent = z.infer<typeof websiteBrowserEventSchema>;
export type WebsiteMetricRow = WebsiteBrowserEvent & {
  day: string;
  count: number;
};
type UnavailableReason = "disabled" | "invalid" | "unavailable";
export type WebsiteMetricResult =
  | { accepted: true }
  | { accepted: false; reason: UnavailableReason | "rate_limited" };
export interface WebsiteMetricReport {
  available: boolean;
  reason?: UnavailableReason;
  timezone: "UTC";
  retentionDays: 90;
  rows: WebsiteMetricRow[];
}

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 90;

/**
 * Optional daily event counts, not unique visitors or an attributed funnel.
 * No cookies, client IDs, IPs, request URLs, referrers or raw payloads are kept.
 * The caller authenticates reports and checks origin, content type and body size.
 * Browser submissions are untrusted signals and never certify product outcomes.
 */
export class WebsiteMetrics {
  private initialized = false;
  private bucket = -1;
  private acceptedInBucket = 0;
  private readonly clock: () => number;
  private readonly enabled: boolean;
  private readonly maxEventsPerMinute: number;

  constructor(
    private readonly store: Store,
    options: {
      enabled?: boolean;
      clock?: () => number;
      maxEventsPerMinute?: number;
    } = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.enabled = options.enabled === true;
    const limit = options.maxEventsPerMinute ?? 120;
    // A fixed upper bound avoids accidentally removing the abuse ceiling.
    this.maxEventsPerMinute =
      Number.isInteger(limit) && limit >= 1 && limit <= 1000 ? limit : 120;
  }

  recordBrowser(input: unknown): WebsiteMetricResult {
    if (!this.enabled) return { accepted: false, reason: "disabled" };
    try {
      const parsed = websiteBrowserEventSchema.safeParse(input);
      if (!parsed.success) return { accepted: false, reason: "invalid" };
      const now = this.clock();
      const day = this.day(now);
      const bucket = Math.floor(now / 60_000);
      if (bucket !== this.bucket) {
        this.bucket = bucket;
        this.acceptedInBucket = 0;
      }
      if (this.acceptedInBucket >= this.maxEventsPerMinute)
        return { accepted: false, reason: "rate_limited" };
      this.initialize();
      this.store.transaction(() => {
        this.prune(now);
        this.store.db
          .prepare(
            `INSERT INTO website_metrics_daily(day, dimensions, count)
             VALUES (?, ?, 1)
             ON CONFLICT(day, dimensions) DO UPDATE SET count = count + 1`,
          )
          .run(day, JSON.stringify(parsed.data));
      });
      this.acceptedInBucket++;
      return { accepted: true };
    } catch {
      // Telemetry must not leak payloads/errors or interrupt operational work.
      return { accepted: false, reason: "unavailable" };
    }
  }

  report(days = 28): WebsiteMetricReport {
    const base = {
      timezone: "UTC" as const,
      retentionDays: RETENTION_DAYS as 90,
      rows: [] as WebsiteMetricRow[],
    };
    if (!this.enabled) return { ...base, available: false, reason: "disabled" };
    if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS)
      return { ...base, available: false, reason: "invalid" };
    try {
      const now = this.clock();
      const through = this.day(now);
      const from = this.day(now - (days - 1) * DAY_MS);
      this.initialize();
      const rows = this.store.transaction(() => {
        this.prune(now);
        return this.store.db
          .prepare(
            `SELECT day, dimensions, count FROM website_metrics_daily
             WHERE day >= ? AND day <= ? ORDER BY day, dimensions`,
          )
          .all(from, through)
          .map((row) => ({
            ...websiteBrowserEventSchema.parse(
              JSON.parse(String(row.dimensions)),
            ),
            day: String(row.day),
            count: Number(row.count),
          }));
      });
      return { ...base, available: true, rows };
    } catch {
      return { ...base, available: false, reason: "unavailable" };
    }
  }

  private day(timestamp: number) {
    if (!Number.isFinite(timestamp)) throw new Error("Invalid metric clock.");
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  private initialize() {
    if (this.initialized) return;
    // Lazy creation means disabled analytics creates no table or other state.
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS website_metrics_daily (
      day TEXT NOT NULL,
      dimensions TEXT NOT NULL CHECK(json_valid(dimensions)),
      count INTEGER NOT NULL CHECK(count >= 1),
      PRIMARY KEY(day, dimensions)
    )`);
    this.initialized = true;
  }

  private prune(now: number) {
    this.store.db
      .prepare("DELETE FROM website_metrics_daily WHERE day < ?")
      .run(this.day(now - (RETENTION_DAYS - 1) * DAY_MS));
  }
}

export type OperationalWebsiteMetric =
  | "pairing_records_created"
  | "setup_test_attempts_created"
  | "legacy_setup_tests_verified";
export interface OperationalWebsiteMetricReport {
  available: boolean;
  reason?: "invalid" | "unavailable";
  timezone: "UTC";
  datasetMixedMode: true;
  attribution: "none";
  fromDay?: string;
  throughDay?: string;
  coverage: {
    pairing_records_created: string;
    setup_test_attempts_created: string;
    legacy_setup_tests_verified: string;
    first_attention_call_connected: string;
    first_pilot_loop_verified: string;
  };
  rows: { day: string; metric: OperationalWebsiteMetric; count: number }[];
}

/**
 * Read-only operational baseline, deliberately separate from browser counters.
 * SQL projects only aggregate dates/counts: private JSON and identity fields do
 * not enter the returned rows or JavaScript memory. No source records, cursors,
 * receipts or deduplication markers are written. The caller authenticates access.
 */
export function readOperationalWebsiteMetrics(
  store: Store,
  days = 28,
  clock: () => number = Date.now,
): OperationalWebsiteMetricReport {
  const base: OperationalWebsiteMetricReport = {
    available: false,
    timezone: "UTC",
    datasetMixedMode: true,
    attribution: "none",
    coverage: {
      pairing_records_created:
        "Pairing records created after a successful claim; not unique people. Stored records have no simulation/live marker.",
      setup_test_attempts_created:
        "Setup-test invitations created after pairing and session readiness, including retries; not onboarding starts. Stored records have no simulation/live marker.",
      legacy_setup_tests_verified:
        "Persisted verified tests belonging to legacy v1 sessions only. The legacy verifier requires a live loop; this is not current v2 physical acceptance.",
      first_attention_call_connected:
        "unavailable: qualified connection observations overwrite connectedAt, so the stored timestamp cannot establish the first connection.",
      first_pilot_loop_verified:
        "unavailable: current v2 physical acceptance has no authoritative durable metric. Legacy verification must not substitute for it.",
    },
    rows: [],
  };
  if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS)
    return { ...base, reason: "invalid" };
  try {
    const now = clock();
    if (!Number.isFinite(now) || now < 0) return { ...base, reason: "invalid" };
    const today = new Date(now).toISOString().slice(0, 10);
    const fromDay = new Date(now - (days - 1) * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const from = Date.parse(`${fromDay}T00:00:00.000Z`);
    const rows = store.query(
      `WITH observations AS (
        SELECT strftime('%Y-%m-%d', json_extract(body, '$.createdAt') / 1000.0, 'unixepoch') AS day,
               'pairing_records_created' AS metric
        FROM entities
        WHERE kind = 'pairing'
          AND json_type(body, '$.id') = 'text'
          AND json_extract(body, '$.id') = id
          AND json_type(body, '$.createdAt') IN ('integer', 'real')
          AND json_extract(body, '$.createdAt') >= ?
          AND json_extract(body, '$.createdAt') >= 0
          AND json_extract(body, '$.createdAt') <= ?
        UNION ALL
        SELECT strftime('%Y-%m-%d', json_extract(body, '$.createdAt') / 1000.0, 'unixepoch'),
               'setup_test_attempts_created'
        FROM entities
        WHERE kind = 'setup_test'
          AND json_type(body, '$.id') = 'text'
          AND json_extract(body, '$.id') = id
          AND json_extract(body, '$.state') IN ('awaiting_approval', 'approved', 'call_requested', 'verified', 'canceled', 'expired')
          AND json_type(body, '$.createdAt') IN ('integer', 'real')
          AND json_extract(body, '$.createdAt') >= ?
          AND json_extract(body, '$.createdAt') >= 0
          AND json_extract(body, '$.createdAt') <= ?
        UNION ALL
        SELECT strftime('%Y-%m-%d', json_extract(t.body, '$.verifiedAt') / 1000.0, 'unixepoch'),
               'legacy_setup_tests_verified'
        FROM entities t
        INNER JOIN entities s ON s.kind = 'session'
          AND s.id = json_extract(t.body, '$.sessionId')
          AND s.id = json_extract(s.body, '$.id')
          AND json_extract(t.body, '$.pairingId') = json_extract(s.body, '$.pairingId')
        WHERE t.kind = 'setup_test'
          AND json_type(t.body, '$.id') = 'text'
          AND json_extract(t.body, '$.id') = t.id
          AND json_extract(t.body, '$.state') = 'verified'
          AND (json_type(s.body, '$.protocolVersion') IS NULL
            OR (json_type(s.body, '$.protocolVersion') = 'integer'
              AND json_extract(s.body, '$.protocolVersion') = 1))
          AND json_type(t.body, '$.createdAt') IN ('integer', 'real')
          AND json_type(t.body, '$.verifiedAt') IN ('integer', 'real')
          AND json_extract(t.body, '$.createdAt') >= 0
          AND json_extract(t.body, '$.verifiedAt') >= json_extract(t.body, '$.createdAt')
          AND json_extract(t.body, '$.verifiedAt') >= ?
          AND json_extract(t.body, '$.verifiedAt') <= ?
      )
      SELECT day, metric, count(*) AS count FROM observations
      WHERE day IS NOT NULL
      GROUP BY day, metric ORDER BY day, metric`,
      from,
      now,
      from,
      now,
      from,
      now,
    );
    return {
      ...base,
      available: true,
      fromDay,
      throughDay: today,
      rows: rows.map((row) => ({
        day: String(row.day),
        metric: String(row.metric) as OperationalWebsiteMetric,
        count: Number(row.count),
      })),
    };
  } catch {
    return { ...base, reason: "unavailable" };
  }
}
