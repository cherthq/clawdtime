#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DecisionDesk,
  describeRequest,
  holdPolicy,
  hookOutput,
} from "../connectors/agents/decisions.js";
import {
  hookAncestors,
  receiveHook,
  stateRoot,
} from "../connectors/agents/hooks.js";
import { requestPattern } from "../connectors/agents/trove.js";
import { agentKinds, type AgentKind } from "../connectors/agents/types.js";

/**
 * The command an agent's hook runs.
 *
 *   agent-hook.js AGENT          records one state change and prints nothing.
 *   agent-hook.js AGENT decide   also lets the person answer the request from
 *                                ClawdTime, and prints that answer for the agent.
 *
 * It always exits 0, and with nothing to say it prints nothing: the agent then
 * does exactly what it does with no hook. The board must never block an agent.
 */
const at = Date.now();
const agent = process.argv[2] as AgentKind;
const decide = process.argv[3] === "decide";

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout : "";
}
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
/**
 * Hands the answer to the agent, and is done only when all of it is written.
 * The program ends right after this, and an end during the write would cut a
 * long answer: the agent would then read a broken one.
 */
const say = (text: string | null) =>
  new Promise<void>((done) => {
    if (!text) return done();
    process.stdout.write(text, () => done());
  });
// An agent that closed its end takes no answer. That is not a fault of the hook.
process.stdout.on("error", () => process.exit(0));

/**
 * Reads the status that Claude Code keeps for its own process. The process is
 * one of this hook's ancestors: the first one that has a status record.
 */
function terminalStatus(parents: string, pids: number[]) {
  const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const chain = [...pids];
  for (let current = pids.at(-1), steps = 0; current && steps < 6; steps++) {
    const next = hookAncestors(parents, current, 1)[0];
    if (!next) break;
    chain.push(next);
    current = next;
  }
  const file = chain
    .map((pid) => join(home, "sessions", `${pid}.json`))
    .find((path) => existsSync(path));
  if (!file) return null;
  return () => {
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as {
        status?: unknown;
      };
      return typeof value.status === "string" ? value.status : null;
    } catch {
      return null;
    }
  };
}

async function handle(raw: string) {
  if (!agentKinds.includes(agent)) return;
  const input = JSON.parse(raw) as Record<string, unknown>;
  const listing = run("/bin/ps", ["-axo", "pid=,ppid=,command="]);
  const parents = listing.replace(/^(\s*\d+\s+\d+).*$/gm, "$1");
  const pids = hookAncestors(parents, process.pid);
  const root = stateRoot({ env: process.env, home: homedir() });
  receiveHook({ root, agent, input, at, pids });
  if (!decide) return;

  const described = describeRequest(input);
  const sessionId = input.session_id;
  if (!described || typeof sessionId !== "string" || !sessionId) return;
  const cwd = typeof input.cwd === "string" ? input.cwd : null;
  const desk = new DecisionDesk(root);
  const facts = {
    agent,
    cwd,
    pattern:
      described.pattern ?? requestPattern(described.tool, described.summary),
    path: described.path ?? null,
  };

  // A rule the person made answers at once. Nothing else is ever answered for them.
  if (described.kind === "permission" && desk.trove.matchRule(facts)) {
    const request = desk.open({
      agent,
      sessionId,
      cwd,
      pids,
      described,
      holdSeconds: 1,
    });
    desk.close(request, {
      version: 1,
      id: request.id,
      decision: "allow",
      text: null,
      via: "playbook",
      remember: false,
      at: Date.now(),
    });
    await say(hookOutput(input, request, { decision: "allow", text: null }));
    return;
  }

  const policy = holdPolicy({ attended: desk.attended(), away: desk.away() });
  if (!policy.hold) return;

  const request = desk.open({
    agent,
    sessionId,
    cwd,
    pids,
    described,
    holdSeconds: policy.seconds,
  });
  const release = () => {
    desk.close(request, null);
    process.exit(0);
  };
  process.on("SIGTERM", release);
  process.on("SIGINT", release);
  process.on("SIGHUP", release);
  // Claude Code shows its own prompt while this hook waits. Its status says
  // "waiting" for as long as that prompt is open. Once it leaves "waiting",
  // the person answered in the terminal, and this request is over.
  const status = agent === "claude-code" ? terminalStatus(parents, pids) : null;
  let prompted = false;
  let answer = desk.take(request.id);
  while (!answer && Date.now() < request.holdUntil) {
    await sleep(150);
    answer = desk.take(request.id);
    const now = status?.();
    if (now === "waiting") prompted = true;
    else if (prompted && now) break;
  }
  desk.close(request, answer);
  if (!answer) return;
  // The session works again: the board must not keep showing that it waits.
  receiveHook({
    root,
    agent,
    input: { session_id: sessionId, cwd, hook_event_name: "PostToolUse" },
    at: Date.now(),
    pids,
  });
  await say(hookOutput(input, request, answer));
}

const chunks: Buffer[] = [];
let size = 0;
process.stdin.on("data", (chunk: Buffer) => {
  size += chunk.length;
  if (size <= 1024 * 1024) chunks.push(chunk);
});
process.stdin.on("error", () => process.exit(0));
process.stdin.on("end", () => {
  const done = () => process.exit(0);
  if (size > 1024 * 1024) return done();
  // A payload that cannot be read changes nothing.
  handle(Buffer.concat(chunks).toString("utf8")).then(done, done);
});
