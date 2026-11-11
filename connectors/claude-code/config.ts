export interface StdioEntry {
  command: string;
  args: string[];
}
export function installClaude(text: string | undefined, entry: StdioEntry) {
  const config = text ? JSON.parse(text) : {};
  if (!config || Array.isArray(config) || typeof config !== "object")
    throw new Error("Invalid Claude project configuration.");
  config.mcpServers ||= {};
  if (typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))
    throw new Error("Invalid Claude MCP configuration.");
  if (config.mcpServers.clawdtime)
    throw new Error(
      "Existing clawdtime server is preserved. Disconnect it before installing again.",
    );
  config.mcpServers.clawdtime = { type: "stdio", ...entry };
  return {
    text: `${JSON.stringify(config, null, 2)}\n`,
    installedEntry: config.mcpServers.clawdtime,
  };
}
export function uninstallClaude(text: string, expected: unknown) {
  const config = JSON.parse(text);
  if (JSON.stringify(config.mcpServers?.clawdtime) !== JSON.stringify(expected))
    throw new Error(
      "ClawdTime configuration changed; preserved for manual review.",
    );
  delete config.mcpServers.clawdtime;
  return `${JSON.stringify(config, null, 2)}\n`;
}
