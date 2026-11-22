import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  readSync,
  writeFileSync,
  renameSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  createByorReceiptWitness,
  transportReadiness,
} from "./local-readiness.mjs";
import { hostLogBoundary, hostStopReceipt } from "./host-receipts.mjs";
import {
  readRetentionEvidence,
  authorizeRetentionBinding,
} from "./provider-retention.mjs";
const execute = promisify(execFile),
  digest = (value) => createHash("sha256").update(value).digest("hex");
const uuid = z.string().uuid();
const scopeSchema = z
  .object({
    project_id: uuid,
    line_id: uuid,
    binding_id: uuid,
    binding_epoch: z.number().int().nonnegative(),
    instance_id: z.string().min(1),
    session_mode: z.literal("byor"),
  })
  .passthrough();
const id = (value) => {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value))
    throw Error("owner_attempt_identity_invalid");
  return value;
};
function privateDirectory(path) {
  const s = lstatSync(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    s.mode & 0o077
  )
    throw Error("owner_private_directory_required");
}
function readPrivate(path, max = 16_777_216) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid?.() ||
      s.mode & 0o077 ||
      s.size > max
    )
      throw Error("owner_private_file_required");
    const b = readFileSync(fd);
    if (b.length !== s.size) throw Error("owner_file_changed");
    return b;
  } finally {
    closeSync(fd);
  }
}
function atomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
function journal(path, config, { allowActive = false } = {}) {
  const canonical = resolve(path),
    part = relative(resolve(config.providerStateDirectory), canonical);
  if (
    part.startsWith(".." + sep) ||
    part === ".." ||
    isAbsolute(part) ||
    part.split(sep).length !== 2 ||
    !canonical.endsWith(`${sep}journal.json`)
  )
    throw Error("owner_journal_outside_provider_root");
  privateDirectory(dirname(canonical));
  const bytes = readPrivate(canonical),
    value = JSON.parse(bytes.toString("utf8")),
    scope = scopeSchema.parse(value.scope);
  if (
    scope.project_id !== config.projectId ||
    scope.line_id !== config.lineId ||
    dirname(canonical) !==
      join(resolve(config.providerStateDirectory), scope.binding_id)
  )
    throw Error("owner_journal_scope_mismatch");
  const witness = createByorReceiptWitness(canonical, scope);
  if (!allowActive) witness.inspect();
  const stat = lstatSync(canonical);
  return {
    path: canonical,
    scope,
    witness,
    hash: digest(bytes),
    device: stat.dev,
    inode: stat.ino,
    unchanged() {
      const now = lstatSync(canonical);
      if (now.dev !== stat.dev || now.ino !== stat.ino)
        throw Error("owner_journal_identity_changed");
    },
  };
}
function recordsAfter(path, boundary) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (
      s.dev !== boundary.device ||
      s.ino !== boundary.inode ||
      s.size < boundary.offset ||
      s.size - boundary.offset > 1_048_576
    )
      throw Error("owner_log_changed");
    const b = Buffer.alloc(s.size - boundary.offset);
    readSync(fd, b, 0, b.length, boundary.offset);
    return b
      .toString("utf8")
      .split("\n")
      .slice(0, -1)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } finally {
    closeSync(fd);
  }
}

/** Exact host ancestry proof; no name-only process matching or PID reuse assumptions. */
export async function hasProcessAncestor(pid, ancestor, readParent) {
  if (
    !Number.isSafeInteger(pid) ||
    !Number.isSafeInteger(ancestor) ||
    pid <= 1 ||
    ancestor <= 1
  )
    return false;
  const seen = new Set();
  for (let depth = 0; depth < 64; depth++) {
    if (pid === ancestor) return true;
    if (seen.has(pid) || pid <= 1) return false;
    seen.add(pid);
    const parent = await readParent(pid);
    if (!Number.isSafeInteger(parent) || parent <= 0) return false;
    pid = parent;
  }
  return false;
}

/** Supported drain/revoke and fresh claim, with a source-pinned retention guard.
 * Original journals stay in their original directories. Only bounded hashes and
 * binding identities are retained in this additional owner receipt. */
export class RetainedProactiveLineOwner {
  constructor(
    config,
    {
      request = fetch,
      clock = Date.now,
      host,
      retention,
      authorizeBinding,
      sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    } = {},
  ) {
    for (const key of ["projectId", "lineId"]) uuid.parse(config[key]);
    const origin = new URL(config.callsOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== config.callsOrigin ||
      config.projectKey.length < 16 ||
      config.connectorToken.length < 16
    )
      throw Error("owner_provider_configuration_invalid");
    for (const key of [
      "hostScript",
      "hostStateDirectory",
      "retentionConfigFile",
      "providerStateDirectory",
      "initialJournal",
      "stateFile",
    ])
      if (!isAbsolute(config[key]))
        throw Error("owner_absolute_paths_required");
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(config.hostSession) ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(config.agentName)
    )
      throw Error("owner_host_identity_invalid");
    privateDirectory(dirname(config.stateFile));
    privateDirectory(config.hostStateDirectory);
    privateDirectory(config.providerStateDirectory);
    this.config = config;
    this.request = request;
    this.clock = clock;
    this.sleep = sleep;
    this.log = join(config.hostStateDirectory, "dev.jsonl");
    this.hold = join(config.hostStateDirectory, "outbound-hold");
    this.lock = `${config.stateFile}.lock`;
    this.heldLock = false;
    this.retention =
      retention ??
      (async (pid) => readRetentionEvidence(config.retentionConfigFile, pid));
    this.authorizeBinding =
      authorizeBinding ??
      (retention
        ? async () => {}
        : async (pid, scope) =>
            authorizeRetentionBinding(config.retentionConfigFile, pid, scope));
    this.host = host ?? {
      inspect: async () => {
        try {
          await execute("tmux", ["has-session", "-t", config.hostSession], {
            timeout: 3000,
            maxBuffer: 4096,
          });
        } catch {
          return { running: false };
        }
        const { stdout: paneOutput } = await execute(
          "tmux",
          [
            "display-message",
            "-p",
            "-t",
            `${config.hostSession}:dev`,
            "#{pane_pid}",
          ],
          { timeout: 3000, maxBuffer: 4096 },
        );
        const panePid = Number(paneOutput.trim());
        if (!Number.isSafeInteger(panePid) || panePid <= 1)
          throw Error("owner_host_pane_unverified");
        const rc = JSON.parse(
          readPrivate(config.retentionConfigFile, 65536).toString("utf8"),
        );
        privateDirectory(rc.receiptDirectory);
        const matches = [];
        for (const name of readdirSync(rc.receiptDirectory)
          .filter((n) => /^\d+\.json$/.test(n))
          .slice(0, 1000)) {
          const pid = Number(name.slice(0, -5));
          try {
            const proof = await this.retention(pid);
            if (
              !(await hasProcessAncestor(pid, panePid, async (current) => {
                const { stdout: parent } = await execute(
                  "ps",
                  ["-p", String(current), "-o", "ppid="],
                  { timeout: 3000, maxBuffer: 4096 },
                );
                return Number(parent.trim());
              }))
            )
              continue;
            const { stdout } = await execute(
              "ps",
              ["-p", String(pid), "-o", "command="],
              { timeout: 3000, maxBuffer: 16384 },
            );
            if (
              !stdout.includes(" dev ") ||
              !new RegExp(
                `(?:^|\\s)--agent\\s+${config.agentName}(?:\\s|$)`,
              ).test(stdout)
            )
              continue;
            const argv = stdout.trim().split(/\s+/),
              devIndex = argv.indexOf("dev");
            if (
              devIndex < 2 ||
              realpathSync(argv[devIndex - 1]) !==
                realpathSync(join(rc.providerRoot, "dist/src/cli/main.js")) ||
              (argv[0] !== "node" &&
                realpathSync(argv[0]) !== realpathSync(proof.execPath))
            )
              continue;
            matches.push(pid);
          } catch {}
        }
        if (matches.length !== 1)
          throw Error("owner_guarded_process_ambiguous");
        return { running: true, pid: matches[0] };
      },
      stop: async () => {
        await execute(config.hostScript, ["stop"], {
          cwd: dirname(config.hostScript),
          env: {
            ...process.env,
            CLAWDTIME_LINE_STATE: config.hostStateDirectory,
            CLAWDTIME_LINE_SESSION: config.hostSession,
            CLAWDTIME_LINE_RETENTION_CONFIG: config.retentionConfigFile,
            CLAWDTIME_LINE_ENV_FILE: config.lineEnvironmentFile,
          },
          timeout: 30000,
          maxBuffer: 32768,
        });
      },
      start: async () => {
        await execute(config.hostScript, ["start"], {
          cwd: dirname(config.hostScript),
          env: {
            ...process.env,
            CLAWDTIME_LINE_STATE: config.hostStateDirectory,
            CLAWDTIME_LINE_SESSION: config.hostSession,
            CLAWDTIME_LINE_RETENTION_CONFIG: config.retentionConfigFile,
            CLAWDTIME_LINE_ENV_FILE: config.lineEnvironmentFile,
          },
          timeout: 30000,
          maxBuffer: 32768,
        });
      },
    };
    this.state = existsSync(config.stateFile)
      ? JSON.parse(readPrivate(config.stateFile, 1_048_576).toString("utf8"))
      : {
          version: 1,
          projectId: config.projectId,
          lineId: config.lineId,
          phase: "incoming",
          currentJournal: config.initialJournal,
          history: [],
        };
    if (
      this.state.version !== 1 ||
      this.state.projectId !== config.projectId ||
      this.state.lineId !== config.lineId ||
      !Array.isArray(this.state.history)
    )
      throw Error("owner_receipt_identity_invalid");
    if (["releasing", "restoring"].includes(this.state.phase))
      this.state = {
        ...this.state,
        phase: "unknown",
        recoveryReason: "restart_during_handoff",
      };
    this.last = { ready: false, reason: "awaiting_probe", checkedAt: 0 };
  }
  save(phase, reason, extra = {}) {
    if (this.state.history.length >= 1000)
      throw Error("owner_receipt_history_limit");
    this.state = {
      ...this.state,
      ...extra,
      phase,
      updatedAt: this.clock(),
      history: [...this.state.history, { phase, reason, at: this.clock() }],
    };
    atomic(this.config.stateFile, this.state);
  }
  lockMutation() {
    const fd = openSync(this.lock, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: this.clock() }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.heldLock = true;
  }
  unlock() {
    if (this.heldLock) {
      unlinkSync(this.lock);
      this.heldLock = false;
    }
  }
  async get(path) {
    this.config.assertConfiguration?.();
    const credential =
      path === "/api/v1/connectors"
        ? (this.config.getConnectorToken?.() ?? this.config.connectorToken)
        : this.config.projectKey;
    if (typeof credential !== "string" || credential.length < 16)
      throw Error("owner_provider_credential_unavailable");
    const response = await this.request(this.config.callsOrigin + path, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        authorization: `Bearer ${credential}`,
        "X-Chert-Project-Id": this.config.projectId,
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error("owner_provider_inspection_unavailable");
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error("owner_provider_body_missing");
    let length = 0;
    const chunks = [];
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 1_048_576) throw Error("owner_provider_body_bound");
        chunks.push(Buffer.from(next.value));
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
        page.offset !== offset ||
        page.limit !== 100 ||
        !Number.isSafeInteger(page.total) ||
        page.total < 0 ||
        (!page.items.length && offset < page.total)
      )
        throw Error("owner_provider_inventory_invalid");
      rows.push(...page.items);
      offset += page.items.length;
      if (offset >= page.total) return rows;
    }
    throw Error("owner_provider_inventory_bound");
  }
  async provider(bindingId, mode, expectedScope) {
    const started = this.clock();
    const [lines, workers, bindings] = await Promise.all([
      this.inventory("lines"),
      this.inventory("workers"),
      this.get("/api/v1/connectors"),
    ]);
    const matches = lines.filter((l) => l.id === this.config.lineId);
    if (
      matches.length !== 1 ||
      !Array.isArray(bindings) ||
      bindings.length > 2000
    )
      throw Error("owner_provider_identity_unverified");
    const line = matches[0],
      assigned = workers.filter((w) => w.id === line.worker_id),
      owners = bindings.filter((b) => b.scope?.line_id === line.id),
      expected = owners.filter(
        (b) =>
          b.scope?.binding_id === bindingId &&
          b.scope.project_id === this.config.projectId,
      );
    if (expected.length !== 1 || assigned.length !== 1)
      throw Error("owner_binding_or_worker_unverified");
    if (
      !expectedScope ||
      ![
        "project_id",
        "line_id",
        "binding_id",
        "binding_epoch",
        "instance_id",
        "session_mode",
      ].every((key) => expected[0].scope?.[key] === expectedScope[key])
    )
      throw Error("owner_provider_scope_mismatch");
    if (mode === "incoming" || mode === "restored") {
      if (
        expected[0].state !== "active" ||
        expected[0].connected !== true ||
        owners.some(
          (b) =>
            b !== expected[0] && (b.connected === true || b.state === "active"),
        )
      )
        throw Error("owner_incoming_binding_unverified");
    } else if (
      expected[0].state !== "revoked" ||
      expected[0].connected !== false ||
      owners.some((b) => b.connected === true || b.state === "active")
    )
      throw Error("owner_release_unverified");
    if (mode !== "restored") {
      if (
        line.current_call_id !== null ||
        line.worker_occupied !== false ||
        line.status !== "available"
      )
        throw Error("owner_line_busy");
      const readiness = transportReadiness(line, assigned[0], this.clock());
      if (!readiness.audioReady || !readiness.videoReady)
        throw Error("owner_native_media_not_ready");
    } else if (
      line.session_health?.line_id !== line.id ||
      line.session_health?.identity_confirmed !== true ||
      assigned[0].enabled !== true ||
      !Number.isFinite(Date.parse(line.session_health?.last_heartbeat_at)) ||
      Date.parse(line.session_health.last_heartbeat_at) > this.clock() ||
      this.clock() - Date.parse(line.session_health.last_heartbeat_at) > 90000
    )
      throw Error("owner_restored_worker_unverified");
    if (this.clock() - started > 10000)
      throw Error("owner_provider_evidence_stale");
    return { bindingId, checkedAt: this.clock(), workerId: line.worker_id };
  }
  checkHistory() {
    for (const old of this.state.retained ?? []) {
      const current = journal(old.path, this.config);
      if (
        current.scope.binding_id !== old.bindingId ||
        current.device !== old.device ||
        current.inode !== old.inode ||
        digest(readPrivate(old.path)) !== old.hash
      )
        throw Error("owner_retained_journal_changed");
    }
  }
  incomingReceipt(bindingId) {
    const rows = readPrivate(this.log)
      .toString("utf8")
      .split("\n")
      .slice(0, -1)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const lastReady = rows.findLastIndex((row) => row.code === "dev_ready");
    const ready = rows[lastReady];
    if (
      !ready ||
      ready.agent !== this.config.agentName ||
      ready.binding_id !== bindingId ||
      ready.state_dir !==
        join(resolve(this.config.providerStateDirectory), bindingId) ||
      rows
        .slice(lastReady + 1)
        .some((row) =>
          ["dev_stopped", "release_failed", "cleanup_pending"].includes(
            row.code,
          ),
        )
    )
      throw Error("owner_incoming_receipt_mismatch");
  }
  async guardedHost(bindingId) {
    this.incomingReceipt(bindingId);
    const host = await this.host.inspect();
    if (!host.running || !Number.isSafeInteger(host.pid) || host.pid <= 0)
      throw Error("owner_incoming_host_unavailable");
    const proof = await this.retention(host.pid);
    if (
      proof?.capability !== "clawdtime-retention-v1" ||
      proof.pid !== host.pid
    )
      throw Error("owner_retention_unverified");
    return host;
  }
  async readiness() {
    try {
      if (
        this.state.phase !== "incoming" ||
        existsSync(this.hold) ||
        existsSync(this.lock)
      )
        throw Error("owner_handoff_unresolved");
      this.checkHistory();
      const current = journal(this.state.currentJournal, this.config),
        host = await this.guardedHost(current.scope.binding_id);
      await this.provider(current.scope.binding_id, "incoming", current.scope);
      current.witness.inspect();
      current.unchanged();
      const after = await this.guardedHost(current.scope.binding_id);
      if (after.pid !== host.pid) throw Error("owner_host_changed");
      this.last = { ready: true, checkedAt: this.clock() };
    } catch (error) {
      this.last = {
        ready: false,
        reason: /^owner_[a-z_]+$/.test(error?.message)
          ? error.message
          : "owner_readiness_unavailable",
        checkedAt: this.clock(),
      };
    }
    return this.last;
  }
  diagnostics() {
    return {
      ...this.last,
      phase: this.state.phase,
      attemptId: this.state.attemptId,
      retainedJournals: this.state.retained?.length ?? 0,
    };
  }
  async acquire(attemptId) {
    id(attemptId);
    if (!(await this.readiness()).ready) throw Error("owner_not_ready");
    this.lockMutation();
    try {
      const current = journal(this.state.currentJournal, this.config),
        host = await this.guardedHost(current.scope.binding_id);
      // Recheck after locking and immediately before reserving the release effect.
      await this.provider(current.scope.binding_id, "incoming", current.scope);
      current.witness.inspect();
      current.unchanged();
      await this.authorizeBinding(host.pid, current.scope);
      const boundary = hostLogBoundary(this.log);
      const holdFd = openSync(this.hold, "wx", 0o600);
      try {
        writeFileSync(
          holdFd,
          JSON.stringify({ version: 1, attemptId, lineId: this.config.lineId }),
        );
        fsyncSync(holdFd);
      } finally {
        closeSync(holdFd);
      }
      this.save("releasing", "release_reserved", {
        attemptId,
        incomingBindingId: current.scope.binding_id,
        incomingScope: current.scope,
        releaseBoundary: boundary,
        releasePid: host.pid,
      });
      this.config.assertConfiguration?.();
      await this.host.stop();
      const receipt = hostStopReceipt(this.log, boundary);
      if (receipt.state !== "released" || receipt.retained !== 0)
        throw Error("owner_release_receipt_missing");
      if ((await this.host.inspect()).running)
        throw Error("owner_incoming_process_remains");
      const witness = current.witness.inspect();
      current.unchanged();
      await this.provider(current.scope.binding_id, "released", current.scope);
      current.witness.inspect();
      current.unchanged();
      const retained = [
        ...(this.state.retained ?? []).filter(
          (r) => r.bindingId !== current.scope.binding_id,
        ),
        {
          path: current.path,
          bindingId: current.scope.binding_id,
          device: current.device,
          inode: current.inode,
          hash: digest(readPrivate(current.path)),
          scopeFingerprint: witness.scopeFingerprint,
          receiptCount: witness.afterReceiptCount,
        },
      ];
      this.save("outbound", "release_and_journal_confirmed", {
        release: receipt,
        retained,
      });
      this.unlock();
      return { exclusive: true };
    } catch (error) {
      this.save("unknown", "release_outcome_unknown");
      throw error;
    }
  }
  async verify(attemptId) {
    if (this.state.phase !== "outbound" || this.state.attemptId !== attemptId)
      return false;
    try {
      this.checkHistory();
      const hold = JSON.parse(readPrivate(this.hold, 4096).toString("utf8"));
      if (
        hold.attemptId !== attemptId ||
        hold.lineId !== this.config.lineId ||
        (await this.host.inspect()).running
      )
        throw Error("owner_local_ownership_changed");
      await this.provider(
        this.state.incomingBindingId,
        "released",
        this.state.incomingScope,
      );
      this.checkHistory();
      return true;
    } catch {
      return false;
    }
  }
  async restore(attemptId) {
    id(attemptId);
    if (this.state.phase !== "outbound" || this.state.attemptId !== attemptId)
      throw Error("owner_restore_requires_original_attempt");
    this.lockMutation();
    try {
      // Provider busy includes an inbound arrival during the released-binding gap.
      // Never reacquire over it or interpret disconnected historical draining rows as current owners.
      if (!(await this.verify(attemptId)))
        throw Error("owner_restore_not_idle");
      const boundary = hostLogBoundary(this.log);
      this.save("restoring", "incoming_claim_reserved", {
        restoreBoundary: boundary,
      });
      const hold = JSON.parse(readPrivate(this.hold, 4096).toString("utf8"));
      if (hold.attemptId !== attemptId)
        throw Error("owner_hold_identity_changed");
      this.config.assertConfiguration?.();
      unlinkSync(this.hold);
      await this.host.start();
      let next, lastFailure;
      const deadline = this.clock() + 60000;
      while (this.clock() < deadline) {
        const rows = recordsAfter(this.log, boundary),
          ready = rows.filter(
            (r) => r.code === "dev_ready" && r.agent === this.config.agentName,
          );
        if (
          ready.length > 1 ||
          rows.some((r) =>
            ["release_failed", "cleanup_pending", "dev_stopped"].includes(
              r.code,
            ),
          )
        )
          throw Error("owner_reacquisition_receipt_conflict");
        try {
          if (
            ready.length !== 1 ||
            !rows.some((r) => r.code === "dev_connected")
          )
            throw Error("owner_reacquisition_receipt_missing");
          const row = ready[0];
          if (
            !uuid.safeParse(row.binding_id).success ||
            row.binding_id === this.state.incomingBindingId ||
            row.state_dir !==
              join(resolve(this.config.providerStateDirectory), row.binding_id)
          )
            throw Error("owner_new_binding_invalid");
          const candidate = journal(
            join(row.state_dir, "journal.json"),
            this.config,
            { allowActive: true },
          );
          if (candidate.scope.binding_id !== row.binding_id)
            throw Error("owner_new_journal_identity_invalid");
          await this.guardedHost(row.binding_id);
          await this.provider(row.binding_id, "restored", candidate.scope);
          // The fresh incoming binding may already own a new call. Its journal
          // identity is validated above; only released originals must remain clean.
          this.checkHistory();
          next = candidate;
          break;
        } catch (error) {
          lastFailure = error;
          await this.sleep(250);
        }
      }
      if (!next) throw lastFailure ?? Error("owner_reacquisition_unconfirmed");
      this.save("incoming", "incoming_claim_confirmed", {
        currentJournal: next.path,
        attemptId: undefined,
        incomingBindingId: undefined,
        incomingScope: undefined,
      });
      this.unlock();
      return { confirmed: true };
    } catch (error) {
      this.save("unknown", "incoming_restore_unknown");
      throw error;
    }
  }
}
