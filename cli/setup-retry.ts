import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { Adapter, AgentSession, SetupTest } from "../src/contracts.js";
import { ApiError, ClawdTimeClient } from "../connectors/shared/client.js";
import {
  loadConnection,
  secureRead,
  secureWrite,
  type RunState,
} from "../connectors/shared/state.js";
import { requireAttentionReadiness } from "../connectors/shared/readiness.js";
import {
  requireRetryPredecessor,
  requireSameLiveSession,
  validateRetryResult,
} from "../connectors/shared/setup-retry.js";

interface RetryIntent {
  schemaVersion: 1;
  fingerprint: string;
  ownerPid: number;
  runId: string;
  sessionId: string;
  previousTestId: string;
  intentAt: number;
  rejected?: boolean;
  result?: { test: SetupTest };
}
/** Verify the old foreground bridge, without signaling it or exposing its command line. */
export function verifyBridgeOwner(lockPath: string, runId: string): number {
  const stat = lstatSync(lockPath);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error(
      "The original bridge's private run lock is missing or unsafe.",
    );
  const pid = secureRead<number>(join(lockPath, "pid"));
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
    throw new Error(
      "The original bridge must still own its distinct foreground process.",
    );
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error(
      "The original bridge owner is no longer alive; no replacement session was created.",
    );
  }
  const inspected = spawnSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "uid=", "-o", "command="],
    { encoding: "utf8", timeout: 3000, maxBuffer: 32 * 1024 },
  );
  const match = inspected.stdout?.trim().match(/^(\d+)\s+(.+)$/s);
  const command = match?.[2];
  if (
    inspected.status !== 0 ||
    !match ||
    (process.getuid && Number(match[1]) !== process.getuid()) ||
    !command ||
    !/(?:^|\s)setup-session(?:\s|$)/.test(command) ||
    command.match(/(?:^|\s)--run-id\s+(\S+)/)?.[1] !== runId
  )
    throw new Error(
      "The live PID does not prove ownership by this exact foreground setup bridge.",
    );
  return pid;
}

/** One scoped POST using the already-running bridge token. Never registers, heartbeats, launches or stops an agent. */
export async function retryExistingSetup(options: {
  connection: string;
  project: string;
  adapter: Adapter;
  runId: string;
  previousTestId: string;
  authorizeNewInvitation: boolean;
  request?: typeof fetch;
}) {
  if (!options.authorizeNewInvitation)
    throw new Error(
      "Explicit --authorize-new-invitation true is required after user authorization and the lead's immutable retirement audit. Retirement does not prove delivery or no delivery.",
    );
  if (
    !/^[A-Za-z0-9_-]{16,100}$/.test(options.runId) ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(options.previousTestId)
  )
    throw new Error("Provide the existing run ID and exact previous test ID.");
  const connection = loadConnection(
    options.connection,
    options.project,
    options.adapter,
  );
  const runPath = join(
    dirname(options.connection),
    "runs",
    `${options.runId}.json`,
  );
  const bridgePath = join(
    dirname(options.connection),
    "runs",
    `${options.runId}.setup.json`,
  );
  const ownerPid = verifyBridgeOwner(`${runPath}.lock`, options.runId);
  const run = secureRead<RunState>(runPath);
  const bridge = secureRead<{
    schemaVersion: number;
    runId: string;
    sessionId: string;
    closedAt?: number;
    test?: SetupTest;
  }>(bridgePath);
  if (
    run.schemaVersion !== 1 ||
    run.runId !== options.runId ||
    run.projectRoot !== connection.projectRoot ||
    run.adapter !== options.adapter ||
    !run.token ||
    !run.session ||
    run.session.externalSessionId !== options.runId ||
    run.session.pairingId !== connection.pairing.id ||
    run.session.hostId !== connection.hostId ||
    run.session.projectRoot !== connection.projectRoot ||
    run.session.adapter !== options.adapter ||
    bridge.schemaVersion !== 1 ||
    bridge.runId !== options.runId ||
    bridge.sessionId !== run.session.id ||
    bridge.closedAt !== undefined
  )
    throw new Error(
      "Protected run/checkpoint does not prove this exact live bridge session. Nothing was registered or changed.",
    );
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        connection.baseUrl,
        connection.projectRoot,
        connection.adapter,
        connection.hostId,
        connection.pairing.id,
        run.runId,
        run.session.id,
        options.previousTestId,
      ]),
    )
    .digest("hex");
  const file = join(dirname(runPath), "retry-intents", `${fingerprint}.json`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const effectLock = `${file}.lock`;
  try {
    mkdirSync(effectLock, { mode: 0o700 });
  } catch {
    throw new Error(
      "A recovery intent is already owned or its writer stopped. Preserve it and inspect status; no second request was sent.",
    );
  }
  try {
    const client = new ClawdTimeClient(
      connection.baseUrl,
      run.token,
      options.request,
    );
    const backend = await client.doctor();
    requireSameLiveSession(
      backend.session as AgentSession | undefined,
      run.session,
      options.runId,
    );
    const current = await client.setupStatus();
    let intent = existsSync(file) ? secureRead<RetryIntent>(file) : undefined;
    if (
      intent &&
      (intent.schemaVersion !== 1 ||
        intent.fingerprint !== fingerprint ||
        intent.ownerPid !== ownerPid ||
        intent.runId !== options.runId ||
        intent.sessionId !== run.session.id ||
        intent.previousTestId !== options.previousTestId)
    )
      throw new Error(
        "Recovery intent identity changed; preserve it for explicit reconciliation.",
      );
    if (intent && !intent.rejected) {
      if (intent.result)
        return {
          ...intent.result,
          replayed: true,
          invitationDelivery: "unverified",
          next: "Use status in the original foreground bridge; no invitation was resent.",
        };
      // A read can establish the new backend test while the earlier POST's reply was lost.
      if (current.test?.previousTestId === options.previousTestId) {
        const result = validateRetryResult(
          current,
          options.previousTestId,
          run.session.id,
          connection.pairing.id,
        );
        secureWrite(file, { ...intent, result });
        return {
          ...result,
          reconciled: true,
          invitationDelivery: "unverified",
          next: "Use status in the original foreground bridge. Retirement/reconciliation does not establish message delivery.",
        };
      }
      throw new Error(
        "Recovery outcome is unknown and no matching successor is established. Preserve its original intent; no retry or new session was attempted.",
      );
    }
    requireRetryPredecessor(
      current.test,
      options.previousTestId,
      run.session.id,
      connection.pairing.id,
    );
    if (bridge.test?.id !== options.previousTestId)
      throw new Error(
        "The old bridge has not observed this predecessor. Send status to that same bridge first.",
      );
    requireAttentionReadiness(backend);
    if (verifyBridgeOwner(`${runPath}.lock`, options.runId) !== ownerPid)
      throw new Error(
        "Foreground bridge owner changed; no recovery request sent.",
      );
    intent = {
      schemaVersion: 1,
      fingerprint,
      ownerPid,
      runId: options.runId,
      sessionId: run.session.id,
      previousTestId: options.previousTestId,
      intentAt: Date.now(),
    };
    secureWrite(file, intent);
    let response: unknown;
    try {
      response = await client.setupRetry(options.previousTestId);
    } catch (error) {
      if (
        error instanceof ApiError &&
        [400, 401, 403, 404, 409, 422].includes(error.status)
      )
        secureWrite(file, { ...intent, rejected: true });
      throw error;
    }
    const result = validateRetryResult(
      response,
      options.previousTestId,
      run.session.id,
      connection.pairing.id,
    );
    secureWrite(file, { ...intent, result });
    return {
      ...result,
      invitationDelivery: "unverified",
      next: "Keep the existing coding chat and foreground bridge alive. Send status to that bridge to learn the new test; wait using the native question tool for the exact YES code sent by the backend. Nothing was registered or restarted.",
    };
  } finally {
    rmSync(effectLock, { recursive: true });
  }
}
