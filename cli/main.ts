#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  lstatSync,
  chmodSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { Adapter, Pairing } from "../src/contracts.js";
import {
  ClawdTimeClient,
  validateOrigin,
} from "../connectors/shared/client.js";
import {
  connectionPath,
  loadConnection,
  secureRead,
  secureWrite,
  type Connection,
} from "../connectors/shared/state.js";
import { startMcp } from "../connectors/shared/mcp.js";
import { installConfiguration, uninstallConfiguration } from "./install.js";

function options(args: string[]) {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!key?.startsWith("--") || !args[i + 1] || args[i + 1]!.startsWith("--"))
      throw new Error("Use --option value.");
    values[key.slice(2)] = args[++i]!;
  }
  return values;
}
export async function main(args = process.argv.slice(2)) {
  const command = args[0] || "help";
  if (command === "help" || command === "--help") {
    console.log(
      "ClawdTime internal build (no npm publication implied)\nconnect --agent codex|claude-code [--project PATH] [--pairing-file PATH]\ndoctor --agent AGENT [--project PATH]\nrun --agent AGENT [--project PATH] [--run-id ID] -- [native client arguments]\ndisconnect --agent AGENT [--project PATH]\nuninstall --agent AGENT [--project PATH] (requires prior disconnect)\nKeep pairing files private; never pass a credential in command arguments.",
    );
    return;
  }
  const separator = args.indexOf("--");
  const flags = options(args.slice(1, separator < 0 ? undefined : separator));
  const adapter = flags.agent as Adapter;
  if (!["codex", "claude-code"].includes(adapter))
    throw new Error("--agent must be codex or claude-code.");
  const project = realpathSync(flags.project || process.cwd());
  const connectionFile = flags.connection || connectionPath(project, adapter);
  if (command === "mcp") {
    await startMcp({ connection: connectionFile, project, adapter });
    return;
  }
  const binary = adapter === "codex" ? "codex" : "claude";
  if (command === "connect") {
    if (existsSync(connectionFile))
      throw new Error(
        "Existing connection preserved; use doctor or disconnect first.",
      );
    const version = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (version.status !== 0)
      throw new Error(`Install and sign in to ${binary} first.`);
    let pairingFile = flags["pairing-file"];
    if (!pairingFile) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        pairingFile = await rl.question(
          "Path to the private pairing JSON downloaded from ClawdTime: ",
        );
      } finally {
        rl.close();
      }
    }
    const grantStat = lstatSync(resolve(pairingFile));
    if (
      !grantStat.isFile() ||
      grantStat.isSymbolicLink() ||
      (process.getuid && grantStat.uid !== process.getuid())
    )
      throw new Error("Pairing export must be your own regular file.");
    chmodSync(resolve(pairingFile), 0o600);
    const grant = secureRead<{
      baseUrl: string;
      pairing: Pairing;
      token: string;
    }>(resolve(pairingFile));
    if (!grant.token || !grant.pairing?.id || grant.pairing.revokedAt)
      throw new Error("Invalid or revoked pairing export.");
    const baseUrl = validateOrigin(grant.baseUrl);
    const readiness = await new ClawdTimeClient(baseUrl, grant.token).doctor();
    const connection: Connection = {
      schemaVersion: 1,
      baseUrl,
      pairing: grant.pairing,
      token: grant.token,
      adapter,
      adapterVersion: version.stdout.trim(),
      projectRoot: project,
      hostId: hostname(),
    };
    const here = dirname(fileURLToPath(import.meta.url));
    // Source invocation still configures the compiled entry point, so it is independent of tsx.
    const executable = here.endsWith("/dist/cli")
      ? resolve(here, "main.js")
      : resolve(here, "../dist/cli/main.js");
    if (!existsSync(executable))
      throw new Error("Run npm run build before connecting.");
    const skill = readFileSync(
      here.endsWith("/dist/cli")
        ? resolve(here, "../../skills/clawdtime/SKILL.md")
        : resolve(here, "../skills/clawdtime/SKILL.md"),
      "utf8",
    );
    installConfiguration(connection, connectionFile, executable, skill);
    console.log(
      JSON.stringify(
        {
          connected: true,
          adapter,
          project,
          version: connection.adapterVersion,
          readiness,
          reload:
            "Restart/reload this project in the client and approve the project MCP server under existing policy. For durable reconnects use the run command.",
        },
        null,
        2,
      ),
    );
    return;
  }
  const connection = loadConnection(connectionFile, project, adapter);
  const client = new ClawdTimeClient(connection.baseUrl, connection.token);
  if (command === "doctor") {
    console.log(
      JSON.stringify(
        {
          adapter,
          version: connection.adapterVersion,
          project,
          backend: await client.doctor(),
          configurationPresent:
            !!connection.installed &&
            existsSync(connection.installed.configPath),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "disconnect") {
    await client.disconnect();
    secureWrite(connectionFile, {
      ...connection,
      pairing: { ...connection.pairing, revokedAt: Date.now() },
    });
    uninstallConfiguration(connection);
    rmSync(dirname(connectionFile), { recursive: true });
    console.log(
      "Pairing revoked; ClawdTime configuration and local credentials removed. Other client settings preserved.",
    );
    return;
  }
  if (command === "uninstall") {
    if (!connection.pairing.revokedAt)
      throw new Error(
        "Run disconnect while the backend is available to revoke remote access before uninstalling.",
      );
    uninstallConfiguration(connection);
    rmSync(dirname(connectionFile), { recursive: true });
    return;
  }
  if (command === "run") {
    const runId = flags["run-id"] || randomUUID();
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(runId))
      throw new Error("Invalid run identifier.");
    console.error(
      `ClawdTime run ${runId}. Recover only with this project/adapter and the native client's exact resume arguments.`,
    );
    const child = spawn(
      binary,
      separator < 0 ? [] : args.slice(separator + 1),
      {
        cwd: project,
        stdio: "inherit",
        env: { ...process.env, CLAWDTIME_RUN_ID: runId },
      },
    );
    child.on("error", () => {
      console.error("Could not start agent client.");
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  throw new Error("Unknown command. Run help.");
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "ClawdTime failed.");
    process.exitCode = 1;
  });
