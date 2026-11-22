/** ClawdTime's opt-in, pinned beta.19 cleanup adapter. Never changes provider release logic. */
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const RETENTION_PIN = Object.freeze({
  version: "0.1.0-beta.19",
  nodeVersion: "v24.22.1",
  nodeSha256:
    "6f32069480ec14d52b6d7b1f3c7124cfbbc46203abf5ddf5c65b127435f3f329",
  files: Object.freeze({
    "dist/src/dev/command.js":
      "267374082a1ec32de40d9870b8976c7271eab177041bc9b8c158ff0e59822dfe",
    "dist/src/dev/claim.js":
      "b37c81792f203322340f974dc3d003aa93861ee970c52cb6ba43e951629ad422",
    "dist/src/cli/main.js":
      "c3c432d7d9f381628e9cfbfb29154f740910182c626f429d46121f8b428c38ac",
    "dist/src/byor/journal.js":
      "8b96ffd60700bebcde5ba5fa13f208c33f2cd7b350df3458380c029be6cd441f",
  }),
});
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
const self = fileURLToPath(import.meta.url);
export function privateJSON(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid() ||
      s.nlink !== 1 ||
      s.mode & 0o077 ||
      s.size > 16_777_216
    )
      throw Error("retention_private_file_required");
    try {
      return JSON.parse(fs.readFileSync(fd, "utf8"));
    } catch {
      throw Error("retention_json_invalid");
    }
  } finally {
    fs.closeSync(fd);
  }
}
export function inspectPinnedProvider(providerRoot) {
  const root = fs.realpathSync(providerRoot);
  if (
    JSON.parse(fs.readFileSync(join(root, "package.json"), "utf8")).version !==
    RETENTION_PIN.version
  )
    throw Error("retention_provider_version_mismatch");
  for (const [name, hash] of Object.entries(RETENTION_PIN.files)) {
    if (sha256(fs.readFileSync(join(root, name))) !== hash)
      throw Error("retention_provider_source_mismatch");
  }
  return {
    version: RETENTION_PIN.version,
    providerRoot: root,
    commandHash: RETENTION_PIN.files["dist/src/dev/command.js"],
  };
}
export function processIdentity(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid < 2)
    throw Error("retention_pid_invalid");
  const start = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
  }).trim();
  if (!start) throw Error("retention_process_missing");
  return { pid, startedAt: start };
}
/** Darwin ps comm can be bare argv0; use mapped text files, never PATH resolution. */
export function mappedNodeExecutable(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2)
    throw Error("retention_pid_invalid");
  let output;
  try {
    output = execFileSync(
      "/usr/sbin/lsof",
      ["-a", "-p", String(pid), "-d", "txt", "-F", "n"],
      {
        encoding: "utf8",
        maxBuffer: 262144,
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    throw Error("retention_mapped_executable_unavailable");
  }
  const candidates = [
    ...new Set(
      output
        .split("\n")
        .filter((line) => line.startsWith("n/"))
        .map((line) => line.slice(1)),
    ),
  ];
  if (candidates.length > 64)
    throw Error("retention_mapped_executable_ambiguous");
  const matches = [];
  for (const candidate of candidates) {
    if (candidate.length > 4096 || basename(candidate) !== "node") continue;
    const path = fs.realpathSync(candidate),
      stat = fs.statSync(path);
    if (!stat.isFile() || stat.size > 268435456) continue;
    if (sha256(fs.readFileSync(path)) === RETENTION_PIN.nodeSha256)
      matches.push(path);
  }
  const exact = [...new Set(matches)];
  if (exact.length !== 1) throw Error("retention_mapped_executable_mismatch");
  return exact[0];
}
export function readRetentionConfig(path) {
  const c = privateJSON(path);
  if (
    c.version !== 1 ||
    ![c.providerRoot, c.chertHome, c.receiptDirectory].every(
      (v) => typeof v === "string" && isAbsolute(v),
    ) ||
    ![c.projectId, c.lineId].every(
      (v) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(v),
    )
  )
    throw Error("retention_config_invalid");
  for (const p of [c.chertHome, c.receiptDirectory]) {
    const stat = fs.lstatSync(p);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      stat.mode & 0o077 ||
      fs.realpathSync(p) !== resolve(p)
    )
      throw Error("retention_private_directory_required");
  }
  return c;
}
/** Internal primitive is exported for synthetic fixture tests; production entry always validates pins. */
export function installScopedRetentionGuard({
  chertHome,
  projectId,
  lineId,
  commandFile,
  receiptDirectory,
}) {
  const original = fs.rmSync;
  const root = join(chertHome, "dev");
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const wrapped = function (path, options) {
    const target =
      typeof path === "string"
        ? resolve(path)
        : path instanceof URL
          ? fileURLToPath(path)
          : null;
    if (target && dirname(target) === root) {
      const name = target.slice(root.length + 1);
      const binding = name.endsWith(".credentials.json")
        ? name.slice(0, -17)
        : name;
      if (uuid.test(binding)) {
        // Only the pinned provider cleanup site can be intercepted. Other operations retain native semantics.
        const stack = new Error().stack ?? "";
        if (
          stack.includes(`${commandFile}:`) ||
          stack.includes(`${new URL("file://" + commandFile).href}:`)
        ) {
          const stateDir = join(root, binding);
          if (
            fs.realpathSync(root) !== root ||
            (fs.existsSync(stateDir) && fs.realpathSync(stateDir) !== stateDir)
          )
            throw Error("retention_state_path_changed");
          const journalPath = join(stateDir, "journal.json");
          if (!fs.existsSync(journalPath)) {
            if (!receiptDirectory)
              throw Error("retention_binding_authorization_required");
            const authorization = privateJSON(
              join(receiptDirectory, `${process.pid}.binding.json`),
            );
            if (
              authorization.pid !== process.pid ||
              authorization.startedAt !== processIdentity().startedAt ||
              authorization.scope?.project_id !== projectId ||
              authorization.scope?.line_id !== lineId ||
              authorization.scope?.binding_id !== binding ||
              authorization.scope?.session_mode !== "byor"
            )
              throw Error("retention_binding_authorization_mismatch");
            return;
          }
          const journal = privateJSON(journalPath);
          if (
            journal.schema_version !== 2 ||
            journal.mode !== "byor" ||
            journal.scope?.session_mode !== "byor" ||
            journal.scope?.project_id !== projectId ||
            journal.scope?.line_id !== lineId ||
            journal.scope?.binding_id !== binding
          )
            throw Error("retention_scope_mismatch");
          if (
            target !== stateDir &&
            target !== join(root, `${binding}.credentials.json`)
          )
            throw Error("retention_target_mismatch");
          return; // No journal, receipt, credential, or provider-state mutation.
        }
      }
    }
    return original.call(fs, path, options);
  };
  fs.rmSync = wrapped;
  syncBuiltinESMExports();
  return () => {
    if (fs.rmSync === wrapped) {
      fs.rmSync = original;
      syncBuiltinESMExports();
    }
  };
}
const slot = Symbol.for("clawdtime.provider-retention.v1");
export function installProviderRetention(configFile) {
  const config = readRetentionConfig(configFile);
  const proof = inspectPinnedProvider(config.providerRoot);
  if (
    process.version !== RETENTION_PIN.nodeVersion ||
    sha256(fs.readFileSync(process.execPath)) !== RETENTION_PIN.nodeSha256
  )
    throw Error("retention_node_mismatch");
  if (
    fs.realpathSync(process.argv[1]) !==
      join(proof.providerRoot, "dist/src/cli/main.js") ||
    process.argv[2] !== "dev"
  )
    throw Error("retention_process_not_dev");
  const configHash = sha256(fs.readFileSync(configFile));
  if (globalThis[slot]) {
    if (globalThis[slot].configHash !== configHash)
      throw Error("retention_already_installed_different_config");
    return globalThis[slot];
  }
  const undo = installScopedRetentionGuard({
    ...config,
    commandFile: join(proof.providerRoot, "dist/src/dev/command.js"),
  });
  const evidence = {
    version: 1,
    capability: "clawdtime-retention-v1",
    ...processIdentity(),
    execPath: fs.realpathSync(process.execPath),
    nodeHash: RETENTION_PIN.nodeSha256,
    nodeVersion: process.version,
    configHash,
    guardHash: sha256(fs.readFileSync(self)),
    providerRoot: proof.providerRoot,
    commandHash: proof.commandHash,
    processCommandHash: sha256(
      execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "command="], {
        encoding: "utf8",
      }).trim(),
    ),
    installedAt: Date.now(),
  };
  try {
    const path = join(config.receiptDirectory, `${process.pid}.json`);
    const fd = fs.openSync(path, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(evidence) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    undo();
    throw error;
  }
  globalThis[slot] = Object.freeze(evidence);
  return evidence;
}
export function readRetentionEvidence(configFile, pid) {
  const config = readRetentionConfig(configFile);
  const proof = inspectPinnedProvider(config.providerRoot);
  const e = privateJSON(join(config.receiptDirectory, `${pid}.json`));
  if (
    e.version !== 1 ||
    e.capability !== "clawdtime-retention-v1" ||
    e.pid !== pid ||
    e.startedAt !== processIdentity(pid).startedAt ||
    e.configHash !== sha256(fs.readFileSync(configFile)) ||
    e.guardHash !== sha256(fs.readFileSync(self)) ||
    e.providerRoot !== proof.providerRoot ||
    e.commandHash !== proof.commandHash ||
    e.nodeVersion !== RETENTION_PIN.nodeVersion ||
    e.nodeHash !== RETENTION_PIN.nodeSha256 ||
    e.execPath !== mappedNodeExecutable(pid) ||
    e.processCommandHash !==
      sha256(
        execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
          encoding: "utf8",
        }).trim(),
      ) ||
    sha256(fs.readFileSync(e.execPath)) !== RETENTION_PIN.nodeSha256
  )
    throw Error("retention_evidence_mismatch");
  return e;
}

/** Called only after the owner has verified the current provider binding and process. No runtime data copied. */
export function authorizeRetentionBinding(configFile, pid, scope) {
  const config = readRetentionConfig(configFile);
  const evidence = readRetentionEvidence(configFile, pid);
  if (
    scope?.project_id !== config.projectId ||
    scope?.line_id !== config.lineId ||
    scope?.session_mode !== "byor" ||
    !/^[a-f0-9-]{36}$/i.test(scope?.binding_id ?? "")
  )
    throw Error("retention_binding_authorization_mismatch");
  const value = {
    version: 1,
    pid,
    startedAt: evidence.startedAt,
    scope: {
      project_id: scope.project_id,
      line_id: scope.line_id,
      binding_id: scope.binding_id,
      session_mode: "byor",
    },
  };
  const path = join(config.receiptDirectory, `${pid}.binding.json`);
  if (fs.existsSync(path)) {
    if (JSON.stringify(privateJSON(path)) !== JSON.stringify(value))
      throw Error("retention_binding_authorization_changed");
    return;
  }
  const fd = fs.openSync(path, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
/** Before a new claim, validate original journals with the pinned provider's own schema/completion predicate. */
export function assertRetainedJournalsClean(configFile) {
  const config = readRetentionConfig(configFile);
  inspectPinnedProvider(config.providerRoot);
  const { byorJournalSchema, complete } = createRequire(import.meta.url)(
    join(config.providerRoot, "dist/src/byor/journal.js"),
  );
  const root = join(config.chertHome, "dev");
  if (!fs.existsSync(root)) return;
  if (fs.realpathSync(root) !== root)
    throw Error("retention_state_path_changed");
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error("retention_state_path_changed");
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "journal.json");
    if (!fs.existsSync(path)) continue;
    let journal;
    try {
      journal = byorJournalSchema.parse(privateJSON(path));
    } catch {
      throw Error("retention_original_journal_invalid");
    }
    if (
      journal.scope.project_id !== config.projectId ||
      journal.scope.line_id !== config.lineId
    )
      continue;
    if (
      journal.scope.binding_id !== entry.name ||
      !Object.values(journal.entries).every(complete)
    )
      throw Error("retention_original_work_unfinished");
  }
}
