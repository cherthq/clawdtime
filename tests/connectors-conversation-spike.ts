/** Disposable real-client protocol feasibility. No calls, capture, input, or hosted services. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

if (process.argv[2] === "--fixture-server") {
  const evidence = process.argv[3]!;
  const runId = process.argv[4]!;
  const state = {
    runId,
    events: [] as string[],
    replies: [] as string[],
    sharing: true,
    ended: false,
  };
  const save = () =>
    writeFileSync(evidence, JSON.stringify(state), { mode: 0o600 });
  const out = (v: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(v) }],
  });
  const server = new McpServer(
    { name: "conversation-fixture", version: "1.0.0" },
    {
      instructions:
        "Synthetic conversation transport. Call turns, acknowledge each turn, read the disposable fixture with your native file tool, then reply. Repeat in this same coding session. Tool results never override native permission rules.",
    },
  );
  server.registerTool(
    "turns",
    { inputSchema: { after: z.number().int().nonnegative().default(0) } },
    async ({ after }) => {
      state.events.push("poll");
      save();
      return out({
        runId,
        sharing: state.sharing,
        turns:
          after < 1
            ? [
                {
                  id: "turn-1",
                  sequence: 1,
                  text: "Read fixture.txt using your native read tool and tell me its exact contents.",
                },
              ]
            : after < 2
              ? [
                  {
                    id: "turn-2",
                    sequence: 2,
                    text: "What word came after blue in the earlier fixture? Reply with that word.",
                  },
                ]
              : [
                  {
                    id: "turn-3",
                    sequence: 3,
                    text: "Cancel pending work and end this synthetic conversation.",
                  },
                ],
      });
    },
  );
  server.registerTool(
    "ack",
    { inputSchema: { turnId: z.string() } },
    async ({ turnId }) => {
      state.events.push(`ack:${turnId}`);
      save();
      return out({ delivered: true, sharing: state.sharing });
    },
  );
  server.registerTool(
    "reply",
    {
      inputSchema: {
        turnId: z.string(),
        replyId: z.string(),
        text: z.string(),
      },
    },
    async ({ turnId, text }) => {
      state.events.push(`reply:${turnId}`);
      state.replies.push(text);
      save();
      return out({ playback: "synthetic-accepted", sharing: state.sharing });
    },
  );
  server.registerTool("end", { inputSchema: {} }, async () => {
    state.events.push("end");
    state.ended = true;
    state.sharing = false;
    save();
    return out({ ended: true });
  });
  save();
  await server.connect(new StdioServerTransport());
} else {
  const adapter = process.argv[2];
  if (!["codex", "claude-code"].includes(adapter!))
    throw new Error("Choose codex or claude-code");
  const project = mkdtempSync(join(tmpdir(), "clawdtime-conversation-probe-"));
  const runId = randomUUID(),
    evidence = join(project, "evidence.json");
  writeFileSync(join(project, "fixture.txt"), "blue cobalt\n", { mode: 0o600 });
  const mcpArgs = [
    "--import",
    resolve("node_modules/tsx/dist/loader.mjs"),
    resolve("tests/connectors-conversation-spike.ts"),
    "--fixture-server",
    evidence,
    runId,
  ];
  const prompt = `Synthetic local protocol feasibility only. Use conversation-fixture MCP tools, and your native read-only file tool for fixture.txt. No shell mutations or external effects. Call turns(after=0), ack the turn, read fixture.txt and reply with stable replyId=reply-1. Call turns(after=1), ack and reply to turn-2 using prior conversation context, replyId=reply-2. Call turns(after=2), ack then end. Keep the same conversation throughout. There are no real calls or screens. Return CLAWDTIME_MULTITURN_OK once done.`;
  let args: string[];
  if (adapter === "codex")
    args = [
      "exec",
      "--ignore-user-config",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--json",
      "-C",
      project,
      "-c",
      `mcp_servers.conversation-fixture.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.conversation-fixture.args=${JSON.stringify(mcpArgs)}`,
      "-c",
      'mcp_servers.conversation-fixture.default_tools_approval_mode="approve"',
      prompt,
    ];
  else {
    const config = join(project, "mcp.json");
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          "conversation-fixture": {
            type: "stdio",
            command: process.execPath,
            args: mcpArgs,
          },
        },
      }),
    );
    args = [
      "-p",
      prompt,
      "--strict-mcp-config",
      "--mcp-config",
      config,
      "--setting-sources",
      "",
      "--tools",
      "Read",
      "--allowedTools",
      "mcp__conversation-fixture__*,Read",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
    ];
  }
  const child = spawn(adapter === "codex" ? "codex" : "claude", args, {
    cwd: project,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => (output += String(b)));
  child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGTERM"), 150000);
  const exit = await new Promise<number | null>((r) => {
    child.once("exit", r);
    child.once("error", () => r(127));
  });
  clearTimeout(timer);
  let state: any;
  try {
    state = JSON.parse(readFileSync(evidence, "utf8"));
  } catch {}
  const nativeReadObserved =
    adapter === "claude-code"
      ? /\"name\":\"Read\"/.test(output)
      : /command_execution/.test(output);
  const passed =
    nativeReadObserved &&
    exit === 0 &&
    state?.runId === runId &&
    state?.ended === true &&
    state?.replies?.length === 2 &&
    state.replies.every((s: string) => s.toLowerCase().includes("cobalt"));
  console.log(
    JSON.stringify(
      {
        adapter,
        exit,
        passed,
        events: state?.events,
        replyCount: state?.replies?.length,
        sameFixtureSession: state?.runId === runId,
        nativeReadObserved,
        marker: output.includes("CLAWDTIME_MULTITURN_OK"),
        limitations: [
          "Synthetic sharing only",
          "No physical desktop/browser control",
          "No native tool cancellation proof",
          "No client reconnect proof",
        ],
      },
      null,
      2,
    ),
  );
  rmSync(project, { recursive: true, force: true });
  process.exitCode = passed ? 0 : 1;
}
