import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Connection } from "../connectors/shared/state.js";
import type { ReadinessCheck } from "../connectors/shared/readiness.js";

export function inspectInstallation(
  connection: Connection,
  detectedVersion?: string,
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const installed = connection.installed;
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
  let configMatches = false,
    skillMatches = false,
    launcherPresent = false;
  try {
    if (
      installed?.configPath === configPath &&
      existsSync(configPath) &&
      lstatSync(configPath).isFile() &&
      !lstatSync(configPath).isSymbolicLink()
    ) {
      const text = readFileSync(configPath, "utf8");
      configMatches =
        connection.adapter === "codex"
          ? typeof installed.configEntry === "string" &&
            text.split(installed.configEntry).length === 2
          : JSON.stringify(JSON.parse(text).mcpServers?.clawdtime) ===
            JSON.stringify(installed.configEntry);
    }
    if (installed) {
      const entry =
        typeof installed.configEntry === "string"
          ? {
              command: JSON.parse(
                installed.configEntry.match(/^command = (.+)$/m)?.[1] ?? "null",
              ),
              args: JSON.parse(
                installed.configEntry.match(/^args = (.+)$/m)?.[1] ?? "null",
              ),
            }
          : (installed.configEntry as { command?: unknown; args?: unknown });
      launcherPresent =
        typeof entry?.command === "string" &&
        existsSync(entry.command) &&
        Array.isArray(entry.args) &&
        typeof entry.args[0] === "string" &&
        existsSync(entry.args[0]);
    }
    if (
      installed?.skillPath === skillPath &&
      existsSync(skillPath) &&
      lstatSync(skillPath).isFile() &&
      !lstatSync(skillPath).isSymbolicLink()
    )
      skillMatches =
        createHash("sha256").update(readFileSync(skillPath)).digest("hex") ===
        installed.skillHash;
  } catch {
    /* Report a specific local failure; never rewrite the user's files. */
  }
  checks.push({
    id: "mcp_configuration",
    status: configMatches ? "pass" : "fail",
    message: configMatches
      ? "The project's owned ClawdTime MCP entry matches the installed command."
      : "The ClawdTime MCP entry is missing, changed or invalid.",
    ...(!configMatches
      ? {
          nextAction:
            "Review the project MCP configuration. Preserve edits; reconnect after intentional cleanup instead of overwriting it.",
        }
      : {}),
  });
  checks.push({
    id: "mcp_launcher",
    status: launcherPresent ? "pass" : "fail",
    message: launcherPresent
      ? "The configured Node executable and compiled connector entry point exist."
      : "The configured Node executable or compiled connector entry point is missing.",
    ...(!launcherPresent
      ? {
          nextAction:
            "Rebuild ClawdTime at its installed absolute path or intentionally reconnect to the new build location.",
        }
      : {}),
  });
  checks.push({
    id: "skill_installation",
    status: skillMatches ? "pass" : "fail",
    message: skillMatches
      ? "The scoped ClawdTime skill matches this installation."
      : "The scoped ClawdTime skill is missing or changed.",
    ...(!skillMatches
      ? {
          nextAction:
            "Review the scoped ClawdTime skill and restore the reviewed workflow before live use.",
        }
      : {}),
  });
  const sameVersion = detectedVersion === connection.adapterVersion;
  checks.push({
    id: "agent_client_version",
    status: !detectedVersion ? "fail" : sameVersion ? "pass" : "unknown",
    message: !detectedVersion
      ? "The configured agent CLI could not report its installed version."
      : sameVersion
        ? `Agent client detected: ${detectedVersion}.`
        : `Agent version changed from ${connection.adapterVersion} to ${detectedVersion}.`,
    ...(!sameVersion
      ? {
          nextAction: !detectedVersion
            ? "Install/sign in to the intended agent CLI and rerun doctor."
            : "Re-run connector compatibility checks for this client version before live testing.",
        }
      : {}),
  });
  return checks;
}
