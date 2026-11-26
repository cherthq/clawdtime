import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import {
  WebsiteMetrics,
  WEBSITE_PUBLIC_PATHS,
  websiteBrowserEventSchema,
  readOperationalWebsiteMetrics,
} from "../src/storage/website-metrics.js";

const event = {
  event: "landing_view",
  path: "/",
  channel: "direct",
  availability: "preview",
} as const;
const stores: Store[] = [];
const folders: string[] = [];
function store(path?: string) {
  const value = new Store(path);
  stores.push(value);
  return value;
}
afterEach(() => {
  for (const value of stores.splice(0)) {
    try {
      value.close();
    } catch {
      // The failure-isolation and durability tests deliberately close stores.
    }
  }
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

describe("bounded website event aggregates", () => {
  it("is disabled by default and leaves storage untouched", () => {
    const db = store();
    const metrics = new WebsiteMetrics(db);
    expect(metrics.recordBrowser(event)).toEqual({
      accepted: false,
      reason: "disabled",
    });
    expect(metrics.report()).toMatchObject({
      available: false,
      reason: "disabled",
      rows: [],
    });
    expect(
      db.query(
        "SELECT name FROM sqlite_master WHERE name='website_metrics_daily'",
      ),
    ).toEqual([]);
  });

  it("rejects sensitive payloads, operational paths and forged milestones", () => {
    const db = store();
    const metrics = new WebsiteMetrics(db, { enabled: true });
    const invalid = [
      { ...event, token: "synthetic-private-token" },
      { ...event, referrer: "https://example.test/private?token=synthetic" },
      { ...event, phone: "synthetic-phone" },
      { ...event, path: "/setup" },
      { ...event, path: "/pair" },
      { ...event, path: "/?token=synthetic" },
      { ...event, path: "/#token=synthetic" },
      { ...event, path: "https://www.clawdtime.com/" },
      { ...event, channel: "arbitrary-referrer.example" },
      { ...event, event: "pairing_completed" },
      { ...event, event: "first_pilot_loop_verified" },
      { ...event, placement: "header" },
      { ...event, event: "pilot_cta_clicked" },
      null,
      "private text",
    ];
    for (const input of invalid)
      expect(metrics.recordBrowser(input)).toEqual({
        accepted: false,
        reason: "invalid",
      });
    expect(metrics.report().rows).toEqual([]);
    expect(db.all("pairing")).toEqual([]);
    expect(db.query("SELECT * FROM website_metrics_daily")).toEqual([]);
  });

  it("keeps bounded dimensions distinct without retaining events or identities", () => {
    const db = store();
    const metrics = new WebsiteMetrics(db, {
      enabled: true,
      clock: () => Date.parse("2026-11-13T23:59:30Z"),
    });
    metrics.recordBrowser(event);
    metrics.recordBrowser(event);
    const cta = {
      ...event,
      event: "pilot_cta_clicked",
      path: "/integrations/codex",
      channel: "ai",
      availability: "invited",
      placement: "content",
      action: "setup",
    } as const;
    expect(metrics.recordBrowser(cta)).toEqual({ accepted: true });
    expect(metrics.report(1)).toEqual({
      available: true,
      timezone: "UTC",
      retentionDays: 90,
      rows: [
        { ...event, day: "2026-11-13", count: 2 },
        { ...cta, day: "2026-11-13", count: 1 },
      ],
    });
    const raw = db.query("SELECT * FROM website_metrics_daily");
    expect(raw).toHaveLength(2);
    expect(Object.keys(raw[0]!).sort()).toEqual(["count", "day", "dimensions"]);
    expect(db.query("SELECT * FROM events")).toEqual([]);
    expect(db.query("SELECT * FROM operational_state")).toEqual([]);
  });

  it("persists counts across new connections using an atomic increment", () => {
    const folder = mkdtempSync(join(tmpdir(), "clawdtime-website-metrics-"));
    folders.push(folder);
    const path = join(folder, "synthetic.sqlite");
    const first = store(path);
    const second = store(path);
    const a = new WebsiteMetrics(first, { enabled: true });
    const b = new WebsiteMetrics(second, { enabled: true });
    for (let i = 0; i < 10; i++) {
      expect(a.recordBrowser(event).accepted).toBe(true);
      expect(b.recordBrowser(event).accepted).toBe(true);
    }
    first.close();
    second.close();
    const reopened = new WebsiteMetrics(store(path), { enabled: true });
    expect(reopened.report().rows[0]?.count).toBe(20);
  });

  it("uses UTC day boundaries and a finite 90-day retention window", () => {
    const db = store();
    let now = Date.parse("2026-08-15T23:59:59Z");
    const metrics = new WebsiteMetrics(db, { enabled: true, clock: () => now });
    metrics.recordBrowser(event);
    now = Date.parse("2026-08-16T00:00:00Z");
    metrics.recordBrowser(event);
    expect(metrics.report(2).rows.map((row) => row.day)).toEqual([
      "2026-08-15",
      "2026-08-16",
    ]);
    now = Date.parse("2026-11-13T04:00:00Z");
    // Aug 16 is the first day of the inclusive 90-day window.
    expect(metrics.report(90).rows.map((row) => row.day)).toEqual([
      "2026-08-16",
    ]);
    expect(db.query("SELECT day FROM website_metrics_daily")).toEqual([
      { day: "2026-08-16" },
    ]);
    expect(metrics.report(28).rows).toEqual([]);
    metrics.recordBrowser(event);
    expect(metrics.report(1).rows.map((row) => row.day)).toEqual([
      "2026-11-13",
    ]);
  });

  it("bounds the write rate without retaining clients and resumes next minute", () => {
    const db = store();
    let now = Date.parse("2026-11-13T16:00:00Z");
    const metrics = new WebsiteMetrics(db, {
      enabled: true,
      clock: () => now,
      maxEventsPerMinute: 2,
    });
    expect(metrics.recordBrowser(event).accepted).toBe(true);
    expect(
      metrics.recordBrowser({ ...event, channel: "search" }).accepted,
    ).toBe(true);
    expect(metrics.recordBrowser(event)).toEqual({
      accepted: false,
      reason: "rate_limited",
    });
    now += 60_000;
    expect(metrics.recordBrowser(event).accepted).toBe(true);
    expect(metrics.report().rows.reduce((sum, row) => sum + row.count, 0)).toBe(
      3,
    );
  });

  it("does not leak validation errors or affect callers when storage fails", () => {
    const db = store();
    const metrics = new WebsiteMetrics(db, { enabled: true });
    expect(metrics.recordBrowser(event).accepted).toBe(true);
    db.close();
    expect(metrics.recordBrowser(event)).toEqual({
      accepted: false,
      reason: "unavailable",
    });
    expect(metrics.report()).toEqual({
      available: false,
      reason: "unavailable",
      timezone: "UTC",
      retentionDays: 90,
      rows: [],
    });
  });

  it("sanitizes report windows and rejects unbounded event dimensions", () => {
    const metrics = new WebsiteMetrics(store(), { enabled: true });
    for (const days of [0, -1, 91, Infinity, NaN, 1.5])
      expect(metrics.report(days)).toMatchObject({
        available: false,
        reason: "invalid",
        rows: [],
      });
    for (const path of WEBSITE_PUBLIC_PATHS)
      expect(
        websiteBrowserEventSchema.safeParse({ ...event, path }).success,
      ).toBe(true);
    expect(
      websiteBrowserEventSchema.safeParse({
        ...event,
        event: "pilot_cta_clicked",
        placement: "not-a-placement",
        action: "setup",
      }).success,
    ).toBe(false);
  });
});

describe("read-only operational website baseline", () => {
  const now = Date.parse("2026-11-13T20:00:00.000Z");
  const yesterday = Date.parse("2026-11-12T23:59:59.999Z");
  const midnight = Date.parse("2026-11-13T00:00:00.000Z");

  it("projects daily counts only and leaves all source records untouched", () => {
    const db = store();
    db.put("pairing", {
      id: "private-pairing-a",
      createdAt: yesterday,
      recipient: "synthetic-private-recipient",
      conversationId: "synthetic-private-conversation",
    });
    db.put("pairing", {
      id: "private-pairing-b",
      createdAt: midnight,
      revokedAt: now,
    });
    db.put("session", {
      id: "private-legacy-session",
      pairingId: "private-pairing-a",
      projectRoot: "/synthetic-private-project",
    });
    db.put("setup_test", {
      id: "private-test-a",
      pairingId: "private-pairing-a",
      sessionId: "private-legacy-session",
      createdAt: yesterday,
      state: "verified",
      verifiedAt: midnight,
    });
    db.put("setup_test", {
      id: "private-test-b",
      createdAt: midnight,
      state: "expired",
      previousTestId: "private-test-a",
    });
    const before = db.query("SELECT * FROM entities ORDER BY kind, id");
    const all = vi.spyOn(db, "all");
    const get = vi.spyOn(db, "get");
    const result = readOperationalWebsiteMetrics(db, 2, () => now);
    expect(result).toMatchObject({
      available: true,
      timezone: "UTC",
      datasetMixedMode: true,
      attribution: "none",
      fromDay: "2026-11-12",
      throughDay: "2026-11-13",
      rows: [
        { day: "2026-11-12", metric: "pairing_records_created", count: 1 },
        { day: "2026-11-12", metric: "setup_test_attempts_created", count: 1 },
        { day: "2026-11-13", metric: "legacy_setup_tests_verified", count: 1 },
        { day: "2026-11-13", metric: "pairing_records_created", count: 1 },
        { day: "2026-11-13", metric: "setup_test_attempts_created", count: 1 },
      ],
    });
    expect(result.coverage.first_attention_call_connected).toMatch(
      /^unavailable:/,
    );
    expect(result.coverage.first_pilot_loop_verified).toMatch(/^unavailable:/);
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(all).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(db.query("SELECT * FROM entities ORDER BY kind, id")).toEqual(
      before,
    );
    expect(db.query("SELECT * FROM operational_state")).toEqual([]);
    expect(
      db.query(
        "SELECT name FROM sqlite_master WHERE name='website_metrics_daily'",
      ),
    ).toEqual([]);
  });

  it("excludes invalid timestamps, out-of-window entries and mismatched duplicate bodies", () => {
    const db = store();
    const values = [
      undefined,
      null,
      "2026-11-13",
      String(midnight),
      -1,
      NaN,
      Infinity,
      Date.parse("2026-11-11T23:59:59.999Z"),
      now + 1,
    ];
    values.forEach((createdAt, i) =>
      db.put("pairing", { id: `invalid-${i}`, createdAt }),
    );
    db.put("pairing", { id: "valid", createdAt: midnight });
    db.db
      .prepare("INSERT INTO entities(kind,id,body) VALUES(?,?,?)")
      .run(
        "pairing",
        "duplicate-body-wrong-id",
        JSON.stringify({ id: "valid", createdAt: midnight }),
      );
    db.put("setup_test", {
      id: "invalid-state",
      createdAt: midnight,
      state: "not-a-test-state",
    });
    expect(readOperationalWebsiteMetrics(db, 2, () => now).rows).toEqual([
      { day: "2026-11-13", metric: "pairing_records_created", count: 1 },
    ]);
  });

  it("counts only persisted legacy verification, never queued or v2 results", () => {
    const db = store();
    const sessions = [
      { id: "implicit-v1" },
      { id: "explicit-v1", protocolVersion: 1 },
      { id: "v2", protocolVersion: 2 },
      { id: "invalid-protocol", protocolVersion: "1" },
      { id: "null-protocol", protocolVersion: null },
    ];
    sessions.forEach((session) => {
      db.put("session", { ...session, pairingId: "synthetic-pairing" });
      db.put("setup_test", {
        id: `test-${session.id}`,
        sessionId: session.id,
        pairingId: "synthetic-pairing",
        createdAt: yesterday,
        state: "verified",
        verifiedAt: midnight,
      });
    });
    const base = {
      sessionId: "implicit-v1",
      pairingId: "synthetic-pairing",
      createdAt: yesterday,
      state: "verified",
      verifiedAt: midnight,
    };
    for (const value of [
      { id: "queued", state: "call_requested" },
      { id: "missing-session", sessionId: "no-session" },
      { id: "wrong-pairing", pairingId: "another-pairing" },
      { id: "missing-verification", verifiedAt: undefined },
      { id: "bad-order", createdAt: now },
      { id: "future-verification", verifiedAt: now + 1 },
      { id: "string-verification", verifiedAt: String(midnight) },
    ])
      db.put("setup_test", { ...base, ...value });
    const rows = readOperationalWebsiteMetrics(db, 2, () => now).rows;
    expect(
      rows.filter((row) => row.metric === "legacy_setup_tests_verified"),
    ).toEqual([
      { day: "2026-11-13", metric: "legacy_setup_tests_verified", count: 2 },
    ]);
    expect(rows.every((row) => !row.metric.startsWith("first_"))).toBe(true);
  });

  it("returns a sanitized unavailable report on invalid inputs or store errors", () => {
    const db = store();
    for (const days of [0, 91, Infinity, NaN, -2, 0.5])
      expect(readOperationalWebsiteMetrics(db, days, () => now)).toMatchObject({
        available: false,
        reason: "invalid",
        rows: [],
      });
    for (const timestamp of [NaN, Infinity, -1])
      expect(
        readOperationalWebsiteMetrics(db, 28, () => timestamp),
      ).toMatchObject({
        available: false,
        reason: "invalid",
        rows: [],
      });
    db.close();
    expect(readOperationalWebsiteMetrics(db, 28, () => now)).toMatchObject({
      available: false,
      reason: "unavailable",
      rows: [],
    });
  });
});
