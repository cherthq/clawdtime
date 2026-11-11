import type { StdioEntry } from "../claude-code/config.js";
const start = "# BEGIN CLAWDTIME MANAGED MCP";
const end = "# END CLAWDTIME MANAGED MCP";
export function installCodex(text: string | undefined, entry: StdioEntry) {
  const existing = text || "";
  // Fail closed for all quoted/inline TOML variants instead of rewriting a user's TOML.
  if (/clawdtime/i.test(existing))
    throw new Error(
      "Existing clawdtime configuration is preserved. Disconnect it before installing again.",
    );
  const block = [
    start,
    "[mcp_servers.clawdtime]",
    `command = ${JSON.stringify(entry.command)}`,
    `args = ${JSON.stringify(entry.args)}`,
    "tool_timeout_sec = 40",
    "startup_timeout_sec = 15",
    'env_vars = ["CLAWDTIME_RUN_ID"]',
    end,
  ].join("\n");
  return {
    text: `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}\n${block}\n`,
    installedEntry: block,
  };
}
export function uninstallCodex(text: string, expected: unknown) {
  if (typeof expected !== "string" || !text.includes(expected))
    throw new Error(
      "ClawdTime configuration changed; preserved for manual review.",
    );
  return text.replace(expected, "");
}
