import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Adapter, SetupTest } from "../../src/contracts.js";
import { ApiError, ClawdTimeClient } from "./client.js";
import {
  loadConnection,
  secureRead,
  secureWrite,
  type RunState,
} from "./state.js";
import { startHeartbeat } from "./heartbeat.js";
import { requireAttentionReadiness, summarizeReadiness } from "./readiness.js";

type Command = { id: string; command: string; args?: Record<string, unknown> };
interface BridgeState {
  schemaVersion: 1;
  runId: string;
  sessionId?: string;
  closedAt?: number;
  test?: SetupTest | null;
  effects: Record<
    string,
    {
      command: string;
      fingerprint: string;
      intentAt: number;
      rejected?: boolean;
      result?: unknown;
    }
  >;
}
const effects = new Set([
  "invite",
  "yield",
  "start",
  "ack",
  "resume",
  "complete",
  "verify",
  "cancel",
]);
const textArg = (args: Record<string, unknown>, key: string, max = 200) => {
  const value = args[key];
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new Error(
      `Provide ${key} as a nonempty string (maximum ${max} characters).`,
    );
  return value;
};
/** Foreground tool bridge, never a coding client, child agent, daemon or shell executor. */
export async function startSetupSession(options: {
  connection: string;
  project: string;
  adapter: Adapter;
  runId: string;
  input?: Readable;
  output?: Writable;
  request?: typeof fetch;
}) {
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(options.runId))
    throw new Error(
      "Use a stable current-chat --run-id (16–100 letters, digits, underscore or hyphen).",
    );
  const connection = loadConnection(
    options.connection,
    options.project,
    options.adapter,
  );
  const statePath = join(
    dirname(options.connection),
    "runs",
    `${options.runId}.json`,
  );
  const bridgePath = join(
    dirname(options.connection),
    "runs",
    `${options.runId}.setup.json`,
  );
  const lockPath = `${statePath}.lock`;
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(join(lockPath, "pid"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("Invalid existing run lock; preserve for recovery.");
    try {
      process.kill(pid, 0);
      throw new Error(
        "This run already has an active connector; never drive it concurrently.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    rmSync(lockPath, { recursive: true });
  }
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(join(lockPath, "pid"), String(process.pid), { mode: 0o600 });
  let stopHeartbeat = () => {};
  let closed = false;
  let bridge: BridgeState | undefined;
  let client: ClawdTimeClient | undefined;
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const emit = (value: unknown) => output.write(`${JSON.stringify(value)}\n`);
  const abort = () => {
    closed = true;
    stopHeartbeat();
  };
  input.once("end", abort);
  input.once("close", abort);
  const onSignal = () => {
    abort();
    input.destroy();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    let run: RunState = existsSync(statePath)
      ? secureRead<RunState>(statePath)
      : {
          schemaVersion: 1,
          runId: options.runId,
          projectRoot: connection.projectRoot,
          adapter: options.adapter,
        };
    if (
      run.runId !== options.runId ||
      run.adapter !== options.adapter ||
      run.projectRoot !== connection.projectRoot
    )
      throw new Error("Run identity mismatch.");
    bridge = existsSync(bridgePath)
      ? secureRead<BridgeState>(bridgePath)
      : { schemaVersion: 1, runId: options.runId, effects: {} };
    if (
      bridge.schemaVersion !== 1 ||
      bridge.runId !== options.runId ||
      bridge.closedAt
    )
      throw new Error(
        "Setup bridge is closed or mismatched. Preserve its receipts; do not reopen a stopped session.",
      );
    if (!run.token) {
      if (run.registrationIntentAt)
        throw new Error(
          "Registration outcome is unknown. Do not retry or replace this run; reconcile its saved intent.",
        );
      run.registrationIntentAt = Date.now();
      secureWrite(statePath, run);
      const result = await new ClawdTimeClient(
        connection.baseUrl,
        connection.token,
        options.request,
      ).register({
        adapter: connection.adapter,
        adapterVersion: connection.adapterVersion,
        projectRoot: connection.projectRoot,
        externalSessionId: options.runId,
        hostId: connection.hostId,
        capabilities: { cooperativePause: true, polling: true },
      });
      run = { ...run, session: result.session, token: result.token };
      secureWrite(statePath, run);
    }
    if (bridge.sessionId && bridge.sessionId !== run.session?.id)
      throw new Error("Setup session binding changed.");
    bridge.sessionId = run.session?.id;
    secureWrite(bridgePath, bridge);
    client = new ClawdTimeClient(
      connection.baseUrl,
      run.token!,
      options.request,
    );
    await client.heartbeat();
    if (closed) return;
    stopHeartbeat = startHeartbeat(() => client!.heartbeat());
    emit({
      event: "ready",
      localRunId: options.runId,
      sessionId: run.session?.id,
      projectRoot: connection.projectRoot,
      adapter: connection.adapter,
      currentChat: true,
      next: "Keep this foreground bridge alive. Use this chat's native question tool while waiting; do not finalize or stop while setup is pending.",
    });
    const lines = createInterface({
      input,
      crlfDelay: Infinity,
      terminal: false,
    });
    for await (const line of lines) {
      if (closed) break;
      let command: Command | undefined;
      try {
        if (line.length > 16_384) throw new Error("Command exceeds 16 KiB.");
        try {
          command = JSON.parse(line) as Command;
        } catch {
          throw new Error("Invalid JSONL command; private contents omitted.");
        }
        if (
          !command ||
          typeof command.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(command.id) ||
          typeof command.command !== "string"
        )
          throw new Error("Command requires a stable id and command name.");
        const args = command.args || {};
        if (typeof args !== "object" || Array.isArray(args))
          throw new Error("args must be an object.");
        // Validate before persisting any effect intent.
        const requestId = ["result", "ack", "resume", "complete"].includes(
          command.command,
        )
          ? textArg(args, "requestId")
          : undefined;
        const responseId =
          command.command === "ack" ? textArg(args, "responseId") : undefined;
        const completeText =
          command.command === "complete"
            ? textArg(args, "text", 8000)
            : undefined;
        const waitSeconds = args.waitSeconds ?? 0;
        if (
          command.command === "result" &&
          (!Number.isInteger(waitSeconds) ||
            Number(waitSeconds) < 0 ||
            Number(waitSeconds) > 20)
        )
          throw new Error("waitSeconds must be an integer between 0 and 20.");
        if (
          command.command === "yield" &&
          args.backgroundActorsStopped !== true
        )
          throw new Error(
            "Stop/join all conflicting actors and explicitly set backgroundActorsStopped=true.",
          );
        if (
          command.command === "resume" &&
          (!Number.isSafeInteger(args.controlEpoch) ||
            Number(args.controlEpoch) < 0)
        )
          throw new Error("Provide the current nonnegative controlEpoch.");
        if (requestId && bridge.test?.requestId !== requestId)
          throw new Error(
            "Request does not belong to this setup test; read status first.",
          );
        const fingerprint = createHash("sha256")
          .update(JSON.stringify([command.command, args]))
          .digest("hex");
        if (effects.has(command.command)) {
          const prior = bridge.effects[command.id];
          if (prior) {
            if (prior.fingerprint !== fingerprint)
              throw new Error(
                "Command id already belongs to different arguments.",
              );
            if (!prior.rejected) {
              if (!Object.hasOwn(prior, "result"))
                throw new Error(
                  "Command outcome is unknown. Read status/result and reconcile the saved intent; no effect was retried.",
                );
              emit({
                id: command.id,
                ok: true,
                replayed: true,
                result: prior.result,
              });
              continue;
            }
          }
          // Each setup operation has a single stable intent, even if caller changes its id.
          if (
            ["invite", "start", "complete", "verify", "cancel"].includes(
              command.command,
            ) &&
            Object.entries(bridge.effects).some(
              ([id, effect]) =>
                id !== command!.id && effect.command === command!.command,
            )
          )
            throw new Error(
              "Use the original command id; this operation already has a saved intent.",
            );
          // Local/read-only readiness failures have no effect intent and may be corrected safely.
          if (["invite", "start"].includes(command.command))
            requireAttentionReadiness(await client.doctor());
          bridge.effects[command.id] = {
            command: command.command,
            fingerprint,
            intentAt: Date.now(),
          };
          secureWrite(bridgePath, bridge);
        }
        let result: any;
        switch (command.command) {
          case "status": {
            const backend = await client.doctor();
            const status = await client.setupStatus();
            bridge.test = status.test;
            result = {
              ...status,
              readiness: summarizeReadiness(backend),
              session: backend.session,
              localRunId: options.runId,
            };
            break;
          }
          case "invite":
            result = await client.setupInvite();
            break;
          case "yield":
            result = await client.yield();
            break;
          case "start":
            result = await client.setupStart();
            break;
          case "result": {
            const deadline = Date.now() + Number(waitSeconds) * 1000;
            do {
              result = await client.result(requestId!);
              if (
                closed ||
                result.response ||
                ![
                  "requested",
                  "queued",
                  "ringing",
                  "connected",
                  "awaiting_input",
                ].includes(result.request.state) ||
                Date.now() >= deadline
              )
                break;
              await new Promise((resolve) =>
                setTimeout(
                  resolve,
                  Math.min(1000, Math.max(0, deadline - Date.now())),
                ),
              );
            } while (!closed);
            break;
          }
          case "ack":
            result = await client.ack(requestId!, responseId!);
            break;
          case "resume":
            result = await client.resume(requestId!, Number(args.controlEpoch));
            break;
          case "complete":
            result = await client.complete(requestId!, completeText!);
            break;
          case "verify":
            result = await client.setupVerify();
            break;
          case "cancel":
            result = await client.setupCancel();
            break;
          default:
            throw new Error(
              "Unknown command. Use status, invite, yield, start, result, ack, resume, complete, verify or cancel.",
            );
        }
        if (result && Object.hasOwn(result, "test")) bridge.test = result.test;
        if (result?.session) {
          run.session = result.session;
          secureWrite(statePath, run);
        }
        if (effects.has(command.command))
          bridge.effects[command.id]!.result = result;
        secureWrite(bridgePath, bridge);
        emit({ id: command.id, ok: true, result });
      } catch (error) {
        // Only a definitive backend rejection permits a later explicit retry of this same command.
        if (
          command &&
          error instanceof ApiError &&
          [400, 401, 403, 404, 409, 422].includes(error.status) &&
          bridge.effects[command.id]
        ) {
          bridge.effects[command.id]!.rejected = true;
          secureWrite(bridgePath, bridge);
        }
        emit({
          id:
            typeof command?.id === "string" &&
            /^[A-Za-z0-9_-]{1,100}$/.test(command.id)
              ? command.id
              : null,
          ok: false,
          error:
            error instanceof Error ? error.message : "Setup command failed.",
          retryPolicy:
            "Read status/result for the original test. Never substitute a new run or intent to retry an unknown effect. Only an explicit rejected command may be retried with the same id after fixing its prerequisite.",
        });
      }
    }
  } finally {
    abort();
    // No daemon survives stdin. Cancellation is attempted once; failure is left to backend expiry.
    if (bridge && !bridge.closedAt) {
      bridge.closedAt = Date.now();
      if (
        client &&
        bridge.test &&
        ["awaiting_approval", "approved", "call_requested"].includes(
          bridge.test.state,
        ) &&
        !Object.values(bridge.effects).some(
          (effect) => effect.command === "cancel",
        )
      ) {
        bridge.effects["bridge-eof-cancel"] = {
          command: "cancel",
          fingerprint: "eof-cancel",
          intentAt: Date.now(),
        };
        secureWrite(bridgePath, bridge);
        try {
          bridge.effects["bridge-eof-cancel"]!.result =
            await client.setupCancel();
        } catch {
          /* Conservative session expiry and owned cleanup remain authoritative. */
        }
      }
      secureWrite(bridgePath, bridge);
    }
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    input.removeListener("end", abort);
    input.removeListener("close", abort);
    rmSync(lockPath, { recursive: true, force: true });
  }
}
