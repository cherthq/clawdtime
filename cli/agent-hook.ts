#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import {
  hookAncestors,
  receiveHook,
  stateRoot,
} from "../connectors/agents/hooks.js";
import { agentKinds, type AgentKind } from "../connectors/agents/types.js";

/**
 * The command an agent's hook runs. It records one state change and prints
 * nothing. It always exits 0: the board must never block or fail an agent.
 */
const at = Date.now();
const agent = process.argv[2] as AgentKind;
const chunks: Buffer[] = [];
let size = 0;
process.stdin.on("data", (chunk: Buffer) => {
  size += chunk.length;
  if (size <= 1024 * 1024) chunks.push(chunk);
});
process.stdin.on("error", () => process.exit(0));
process.stdin.on("end", () => {
  try {
    if (!agentKinds.includes(agent) || size > 1024 * 1024) return;
    const listing = spawnSync("/bin/ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    receiveHook({
      root: stateRoot({ env: process.env, home: homedir() }),
      agent,
      input: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      at,
      pids: hookAncestors(listing.stdout ?? "", process.pid),
    });
  } catch {
    // A payload that cannot be read changes nothing.
  } finally {
    process.exit(0);
  }
});
