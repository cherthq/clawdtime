import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import {
  installClaude,
  uninstallClaude,
} from "../connectors/claude-code/config.js";
import { installCodex, uninstallCodex } from "../connectors/codex/config.js";
import { secureWrite, type Connection } from "../connectors/shared/state.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function regular(file: string) {
  if (
    existsSync(file) &&
    (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
  )
    throw new Error("Refusing non-regular configuration file.");
}
export function installConfiguration(
  connection: Connection,
  connectionFile: string,
  executable: string,
  skill: string,
) {
  const configPath = join(
    connection.projectRoot,
    connection.adapter === "codex" ? ".codex/config.toml" : ".mcp.json",
  );
  const skillPath = join(
    connection.projectRoot,
    connection.adapter === "codex"
      ? ".agents/skills/clawdtime/SKILL.md"
      : ".claude/skills/clawdtime/SKILL.md",
  );
  regular(configPath);
  regular(skillPath);
  if (existsSync(skillPath))
    throw new Error(
      "Existing ClawdTime skill is preserved; disconnect before reinstalling.",
    );
  const entry = {
    command: process.execPath,
    args: [
      executable,
      "mcp",
      "--connection",
      connectionFile,
      "--project",
      connection.projectRoot,
      "--agent",
      connection.adapter,
    ],
  };
  const change = (
    connection.adapter === "codex" ? installCodex : installClaude
  )(
    existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined,
    entry,
  );
  const result: Connection = {
    ...connection,
    installed: {
      configPath,
      configEntry: change.installedEntry,
      skillPath,
      skillHash: hash(skill),
    },
  };
  // Persist recovery information before either project edit. No native approval settings change.
  secureWrite(connectionFile, result);
  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(configPath, change.text, { mode: 0o600 });
  writeFileSync(skillPath, skill, { mode: 0o600, flag: "wx" });
  return result;
}
export function uninstallConfiguration(connection: Connection) {
  if (!connection.installed) return;
  const { configPath, configEntry, skillPath, skillHash } =
    connection.installed;
  regular(configPath);
  regular(skillPath);
  let changed: string | undefined;
  if (existsSync(configPath))
    changed = (
      connection.adapter === "codex" ? uninstallCodex : uninstallClaude
    )(readFileSync(configPath, "utf8"), configEntry);
  if (
    existsSync(skillPath) &&
    hash(readFileSync(skillPath, "utf8")) !== skillHash
  )
    throw new Error("ClawdTime skill changed; preserved for manual review.");
  if (changed !== undefined) writeFileSync(configPath, changed);
  if (existsSync(skillPath)) unlinkSync(skillPath);
}

/** Upgrade only an unchanged skill we previously installed. User edits stay untouched. */
export function refreshOwnedSkill(
  connection: Connection,
  connectionFile: string,
  skill: string,
) {
  if (!connection.installed) return connection;
  const { skillPath, skillHash } = connection.installed;
  regular(skillPath);
  if (
    !existsSync(skillPath) ||
    hash(readFileSync(skillPath, "utf8")) !== skillHash
  )
    return connection;
  if (hash(skill) === skillHash) return connection;
  writeFileSync(skillPath, skill, { mode: 0o600 });
  const updated = {
    ...connection,
    installed: { ...connection.installed, skillHash: hash(skill) },
  };
  secureWrite(connectionFile, updated);
  return updated;
}
