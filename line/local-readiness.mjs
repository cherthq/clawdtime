import { z } from "zod";
import {
  constants,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
} from "node:fs";
import { createHash } from "node:crypto";

const id = z.string().min(1).max(200);
const uuid = z.string().uuid();
const anchor = z
  .object({ sequence: z.number().int().nonnegative(), eventId: id })
  .strict();
const receiptWitness = z
  .object({
    kind: z.literal("byor_v2"),
    scopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    beforeDigest: z.string().regex(/^[a-f0-9]{64}$/),
    afterDigest: z.string().regex(/^[a-f0-9]{64}$/),
    beforeReceiptCount: z.number().int().nonnegative(),
    afterReceiptCount: z.number().int().nonnegative(),
    appendOnly: z.literal(true),
    retained: z.literal(0),
    originalPresent: z.literal(true),
  })
  .strict();

/** Audited beta.19 and beta.22 delete clean journals on every dev exit.
 * Unknown releases are not assumed compatible. Call before any host stop. */
export function assertIncomingReleaseSupported(host) {
  if (host?.program !== "chert-dev" || typeof host.version !== "string")
    throw Error("incoming_release_capability_unverified");
  throw Error("incoming_release_deletes_original_journal");
}
export const localOwnershipEvidenceSchema = z
  .object({
    version: z.literal(1),
    attemptId: id,
    lineId: uuid,
    incomingBindingId: uuid,
    phase: z.literal("outbound_reserved"),
    release: z
      .object({
        state: z.literal("released"),
        retained: z.literal(0),
        offset: z.number().int().nonnegative(),
      })
      .strict(),
    cursorBefore: anchor.optional(),
    cursorAfter: anchor.optional(),
    byorReceipts: receiptWitness.optional(),
    unresolvedEffects: z.literal(0),
    activeCalls: z.literal(0),
    activeCaptures: z.literal(0),
    localStop: z.literal(false),
    checkedAt: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (e) =>
      e.byorReceipts
        ? !e.cursorBefore && !e.cursorAfter
        : !!e.cursorBefore && !!e.cursorAfter,
    "Use original message cursor or BYOR receipt evidence, never fabricated equivalents.",
  );

/** Read the original journal in place. No copies, lock recovery, writes, or customer data in the result. */
export function createByorReceiptWitness(path, expectedScope) {
  const digest = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const scopeKeys = [
    "project_id",
    "line_id",
    "binding_id",
    "binding_epoch",
    "instance_id",
  ];
  if (!scopeKeys.every((k) => expectedScope[k] !== undefined))
    throw Error("byor_scope_required");
  const read = () => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077 ||
        stat.size > 16_777_216
      )
        throw Error("byor_journal_unavailable");
      const bytes = readFileSync(fd);
      if (bytes.length !== stat.size) throw Error("byor_journal_changed");
      const value = JSON.parse(bytes.toString("utf8"));
      if (
        value.schema_version !== 2 ||
        value.mode !== "byor" ||
        value.scope?.session_mode !== "byor" ||
        !scopeKeys.every((k) => value.scope[k] === expectedScope[k]) ||
        !value.entries ||
        !value.receipts ||
        typeof value.entries !== "object" ||
        Array.isArray(value.entries) ||
        typeof value.receipts !== "object" ||
        Array.isArray(value.receipts) ||
        !Object.entries(value.receipts).every(
          ([k, v]) =>
            k.length <= 256 && typeof v === "string" && v.length <= 256,
        )
      )
        throw Error("byor_journal_identity_invalid");
      for (const entry of Object.values(value.entries)) {
        if (
          !scopeKeys.every((k) => entry.owner?.[k] === expectedScope[k]) ||
          entry.call?.call_id !== entry.owner?.call_id ||
          entry.call?.request_id !== entry.owner?.request_id ||
          entry.call?.project_id !== expectedScope.project_id ||
          entry.call?.line_id !== expectedScope.line_id ||
          !Array.isArray(entry.events) ||
          typeof entry.authoritative_terminal !== "boolean" ||
          typeof entry.settled !== "boolean"
        )
          throw Error("byor_journal_entry_invalid");
      }
      return value;
    } finally {
      closeSync(fd);
    }
  };
  const initial = read(),
    initialReceipts = Object.entries(initial.receipts).sort();
  return {
    inspect() {
      const current = read(),
        receipts = Object.entries(current.receipts).sort();
      if (
        !initialReceipts.every(([k, v]) => current.receipts[k] === v) ||
        !Object.entries(initial.entries).every(
          ([key, entry]) =>
            current.entries[key] &&
            JSON.stringify(current.entries[key].owner) ===
              JSON.stringify(entry.owner) &&
            current.entries[key].digest === entry.digest,
        )
      )
        throw Error("byor_receipts_not_preserved");
      const retained = Object.values(current.entries).filter(
        (e) =>
          !(
            e.authoritative_terminal &&
            e.settled &&
            e.cleanup === "clean" &&
            e.events.every((x) => x.acknowledged === true)
          ),
      ).length;
      if (retained) throw Error("byor_retained_work");
      return {
        kind: "byor_v2",
        scopeFingerprint: digest(scopeKeys.map((k) => [k, expectedScope[k]])),
        beforeDigest: digest(initialReceipts),
        afterDigest: digest(receipts),
        beforeReceiptCount: initialReceipts.length,
        afterReceiptCount: receipts.length,
        appendOnly: true,
        retained: 0,
        originalPresent: true,
      };
    },
  };
}

const health = z.object({
  line_id: uuid,
  identity_confirmed: z.literal(true),
  status: z.literal("accepting"),
  last_heartbeat_at: z.string(),
  capabilities: z
    .object({ outbound_audio_protocol: z.literal(1) })
    .passthrough(),
  readiness: z.record(z.string(), z.unknown()),
});
const prerequisites = [
  "accessibility",
  "facetime_signed_in",
  "audio_devices",
  "facetime_selections",
  "playback_renderer",
  "configuration",
  "control_plane_poll",
];
const freshTime = (value, now, maxAge) => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at <= now && now - at < maxAge;
};

/** Metadata evidence only. This does not claim decoded media or handset visibility. */
export function transportReadiness(line, worker, now) {
  const parsed = health.safeParse(line.session_health);
  if (!parsed.success) return { audioReady: false, videoReady: false };
  const h = parsed.data,
    r = h.readiness,
    a = r.automatic;
  const checks = Array.isArray(a?.checks) ? a.checks : [];
  const start = Date.parse(a?.runtime_started_at),
    begin = Date.parse(a?.started_at),
    end = Date.parse(a?.completed_at);
  const valid =
    checks.length <= 100 &&
    new Set(checks.map((c) => c.id)).size === checks.length &&
    [start, begin, end].every(Number.isFinite) &&
    start <= begin &&
    begin <= end &&
    end <= now;
  const passed = (name) =>
    checks.some(
      (c) =>
        c.id === name &&
        c.outcome === "passed" &&
        freshTime(c.completed_at, now, 90_000) &&
        Date.parse(c.completed_at) >= start &&
        Date.parse(c.completed_at) <= end,
    );
  const capture = checks.find((c) => c.id === "system_audio_capture");
  const audioReady =
    valid &&
    h.line_id === line.id &&
    freshTime(h.last_heartbeat_at, now, 90_000) &&
    ["control_ready", "facetime_signed_in", "accessibility_ready"].every(
      (k) => r[k] === true,
    ) &&
    prerequisites.every(passed) &&
    (r.audio_ready === true
      ? passed("system_audio_capture")
      : r.audio_ready === false &&
        capture?.outcome === "at_call_start" &&
        capture.completed_at === null);
  const videoEvidence = (readiness, heartbeat) => {
    const auto = readiness?.automatic;
    if (
      !auto ||
      !freshTime(heartbeat, now, 30_000) ||
      readiness.automatic_transport_missing ||
      auto.version !== 1 ||
      auto.worker_id !== worker.id ||
      !uuid.safeParse(auto.runtime_id).success ||
      !["build", "device_binding", "config_binding"].every(
        (k) => /^[a-f0-9]{64}$/.test(auto[k]) && readiness[k] === auto[k],
      ) ||
      auto.runtime_id !== readiness.runtime_id ||
      !["audio", "audio_optional_video", "audio_video"].includes(auto.profile)
    )
      return false;
    const runtime = Date.parse(auto.runtime_started_at),
      begun = Date.parse(auto.started_at),
      ended = Date.parse(auto.completed_at);
    const rows = auto.checks;
    if (
      ![runtime, begun, ended].every(Number.isFinite) ||
      runtime > begun ||
      begun > ended ||
      ended > now ||
      !Array.isArray(rows) ||
      rows.length > 100 ||
      new Set(rows.map((c) => c.id)).size !== rows.length ||
      (readiness.operating_intent &&
        (readiness.operating_intent.runtime_id !== auto.runtime_id ||
          readiness.operating_intent.runtime_started_at !==
            auto.runtime_started_at))
    )
      return false;
    return [...prerequisites, "video_resources", "screen_capture"].every(
      (name) =>
        rows.some(
          (c) =>
            c.id === name &&
            c.outcome === "passed" &&
            freshTime(c.completed_at, now, 90_000) &&
            Date.parse(c.completed_at) >= runtime &&
            Date.parse(c.completed_at) <= ended,
        ),
    );
  };
  const videoReady =
    audioReady &&
    line.supports_audio === true &&
    line.supports_video === true &&
    worker?.enabled === true &&
    worker.status === "accepting" &&
    worker.current_call_id === null &&
    worker.automatic_readiness_enabled === true &&
    h.capabilities.video === true &&
    h.capabilities.outbound_video_protocol === 1 &&
    worker.capabilities?.video === true &&
    worker.capabilities?.outbound_audio_protocol === 1 &&
    worker.capabilities?.outbound_video_protocol === 1 &&
    videoEvidence(worker.readiness, worker.last_heartbeat_at) &&
    videoEvidence(h.readiness, h.last_heartbeat_at);
  return { audioReady: Boolean(audioReady), videoReady: Boolean(videoReady) };
}

/** Concrete GET-only provider inspector. Supplied local evidence is read twice around network I/O. */
export class LocalLineReadiness {
  constructor(
    config,
    { readLocalEvidence, request = fetch, clock = Date.now },
  ) {
    if (config.incomingHost)
      assertIncomingReleaseSupported(config.incomingHost);
    const origin = new URL(config.callsOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== config.callsOrigin ||
      origin.username ||
      origin.password ||
      !uuid.safeParse(config.projectId).success ||
      !uuid.safeParse(config.lineId).success ||
      typeof config.projectKey !== "string" ||
      config.projectKey.length < 16 ||
      typeof readLocalEvidence !== "function"
    )
      throw Error("local_readiness_configuration_invalid");
    this.config = config;
    this.readLocalEvidence = readLocalEvidence;
    this.request = request;
    this.clock = clock;
  }

  async get(path) {
    const response = await this.request(this.config.callsOrigin + path, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: {
        authorization: `Bearer ${path === "/api/v1/connectors" ? (this.config.connectorToken ?? this.config.projectKey) : this.config.projectKey}`,
        "X-Chert-Project-Id": this.config.projectId,
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error("provider_inspection_unavailable");
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error("provider_inspection_invalid");
    const chunks = [];
    let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 1_048_576) throw Error("provider_inspection_bound");
        chunks.push(Buffer.from(chunk.value));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")).data;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async inventory(kind) {
    const rows = [];
    for (let offset = 0; offset < 2000;) {
      const page = await this.get(`/api/v1/${kind}?limit=100&offset=${offset}`);
      if (
        !Array.isArray(page?.items) ||
        page.items.length > 100 ||
        !Number.isSafeInteger(page.total) ||
        page.total < 0 ||
        page.offset !== offset ||
        page.limit !== 100 ||
        (!page.items.length && offset < page.total)
      )
        throw Error("provider_inventory_invalid");
      rows.push(...page.items);
      offset += page.items.length;
      if (offset >= page.total) return rows;
    }
    throw Error("provider_inventory_bound");
  }

  evidence(attemptId) {
    const e = localOwnershipEvidenceSchema.parse(this.readLocalEvidence());
    if (
      e.attemptId !== attemptId ||
      e.lineId !== this.config.lineId ||
      e.checkedAt > this.clock() ||
      this.clock() - e.checkedAt > 10_000 ||
      (e.cursorBefore &&
        e.cursorAfter &&
        (e.cursorAfter.sequence < e.cursorBefore.sequence ||
          (e.cursorAfter.sequence === e.cursorBefore.sequence &&
            e.cursorAfter.eventId !== e.cursorBefore.eventId))) ||
      (e.byorReceipts &&
        e.byorReceipts.afterReceiptCount < e.byorReceipts.beforeReceiptCount)
    )
      throw Error("local_ownership_unverified");
    return e;
  }

  async inspect(attemptId) {
    const before = this.evidence(attemptId),
      started = this.clock();
    const [lines, workers, bindings] = await Promise.all([
      this.inventory("lines"),
      this.inventory("workers"),
      this.get("/api/v1/connectors"),
    ]);
    const matching = lines.filter((l) => l.id === this.config.lineId);
    if (
      matching.length !== 1 ||
      !Array.isArray(bindings) ||
      bindings.length > 2000
    )
      throw Error("provider_identity_unverified");
    const line = matching[0],
      owners = bindings.filter((b) => b.scope?.line_id === line.id);
    const previous = owners.filter(
      (b) =>
        b.scope?.binding_id === before.incomingBindingId &&
        b.scope.project_id === this.config.projectId,
    );
    if (
      previous.length !== 1 ||
      previous[0].state !== "revoked" ||
      previous[0].connected !== false ||
      owners.some(
        (b) => b.state === "active" || b.state === "draining" || b.connected,
      )
    )
      throw Error("incoming_owner_not_released");
    if (
      line.current_call_id !== null ||
      line.worker_occupied !== false ||
      line.status !== "available"
    )
      throw Error("line_busy_or_unavailable");
    const matches = workers.filter((w) => w.id === line.worker_id);
    if (matches.length !== 1) throw Error("provider_worker_unverified");
    const transport = transportReadiness(line, matches[0], this.clock());
    if (!transport.audioReady) throw Error("native_audio_not_ready");
    const after = this.evidence(attemptId);
    if (
      JSON.stringify(before) !== JSON.stringify(after) ||
      this.clock() - started > 10_000
    )
      throw Error("ownership_changed_during_inspection");
    return {
      source: "operator_verified_native",
      checkedAt: started,
      attemptId,
      lineId: line.id,
      incomingBindingId: before.incomingBindingId,
      idle: true,
      exclusiveOwner: true,
      identityVerified: true,
      cursorPreserved: true,
      cleanupClear: true,
      ...transport,
    };
  }
}
