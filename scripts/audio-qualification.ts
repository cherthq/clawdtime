/** Foreground operator only. Default --check has no external effects. No auto-redial. */
import {
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  writeFileSync,
  renameSync,
  constants,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const configSchema = z
  .object({
    backendOrigin: z.string().url(),
    operatorToken: z.string().min(32),
    pairingId: z.string().min(1).max(160),
  })
  .strict();
async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--config");
  const configPath = index >= 0 ? args[index + 1] : undefined;
  if (!configPath)
    throw new Error(
      "Use --config PATH [--check | --start --ready-for-one-call | --stop REQUEST_ID].",
    );
  const file = resolve(configPath);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = fstatSync(fd);
  if (
    !info.isFile() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Error("Operator configuration must be an owner-only file.");
  let config: z.infer<typeof configSchema>;
  try {
    config = configSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
  const origin = new URL(config.backendOrigin);
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(origin.hostname)
      ))
  )
    throw new Error(
      "Exact HTTPS backend origin required (HTTP loopback allowed for simulation).",
    );
  const request = async (
    path: string,
    body?: unknown,
    token = config.operatorToken,
    signal?: AbortSignal,
  ): Promise<any> => {
    const response = await fetch(origin.origin + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
        : AbortSignal.timeout(8000),
    });
    if (!response.ok)
      throw new Error(
        "Operator request failed with HTTP " +
          response.status +
          "; no automatic retry.",
      );
    return response.json();
  };
  const stopIndex = args.indexOf("--stop");
  if (stopIndex >= 0) {
    const id = z
      .string()
      .regex(/^attention_[A-Za-z0-9_-]+$/)
      .parse(args[stopIndex + 1]);
    await request(
      `/internal/audio-qualifications/${encodeURIComponent(id)}/stop`,
      {},
    );
    console.log(
      "Stop recorded for the exact session. Inspect status until provider cleanup is confirmed; do not redial.",
    );
    return;
  }
  const readiness = await request("/internal/audio-qualifications/readiness");
  console.log(
    JSON.stringify({
      version: readiness.version,
      enabled: readiness.enabled,
      ready: readiness.ready,
      executionDisabled: readiness.executionDisabled,
      maxDurationSeconds: readiness.maxDurationSeconds,
      physicalAcceptance: false,
    }),
  );
  if (!args.includes("--start")) return;
  if (
    !args.includes("--ready-for-one-call") ||
    !process.stdin.isTTY ||
    readiness.ready !== true
  )
    throw new Error(
      "Starting requires a foreground terminal, current --ready-for-one-call, and ready services.",
    );
  const idempotencyKey = "audio-test-" + randomUUID();
  const ledger = join(dirname(file), `${idempotencyKey}.json`);
  const intent: Record<string, unknown> = {
    idempotencyKey,
    at: new Date().toISOString(),
    backendOrigin: origin.origin,
    pairingId: config.pairingId,
    state: "prepared",
    durationSeconds: 180,
  };
  const save = (initial = false) => {
    const target = initial ? ledger : ledger + ".tmp-" + randomUUID();
    const handle = openSync(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(handle, JSON.stringify(intent, null, 2) + "\n");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    if (!initial) renameSync(target, ledger);
    const parent = openSync(dirname(ledger), constants.O_RDONLY);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  };
  save(true);
  console.log(
    "One audio-only call authorized. Press Enter or Ctrl-C to Stop. No execution or screen sharing. Maximum 3 minutes.",
  );
  let requestId: string | undefined, token: string | undefined;
  let stopPromise: Promise<unknown> | undefined;
  const polling = new AbortController();
  const sendStop = () => {
    if (requestId && !stopPromise) {
      stopPromise = request(
        `/internal/audio-qualifications/${encodeURIComponent(requestId)}/stop`,
        {},
      );
      void stopPromise.catch(() => {}); // Retain rejection for cleanup without an unhandled promise.
    }
    return stopPromise;
  };
  let stopRequested = false;
  const stop = () => {
    stopRequested = true;
    polling.abort();
    void sendStop(); // Immediate independent Stop; never waits behind a status/heartbeat request.
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.resume();
  process.stdin.on("data", stop);
  try {
    // Persist intent before this one call-producing request; never retry it.
    intent.state = "submitted";
    save();
    const created = await request("/internal/audio-qualifications", {
      pairingId: config.pairingId,
      idempotencyKey,
      durationSeconds: 180,
      readyForOneCall: true,
    });
    requestId = z
      .string()
      .regex(/^attention_[A-Za-z0-9_-]+$/)
      .parse(created.request?.id);
    if (stopRequested) void sendStop();
    token = z.string().min(32).parse(created.token);
    intent.requestId = requestId;
    intent.state = "accepted";
    save();
    const expiry = z
      .number()
      .finite()
      .parse(created.request?.audioQualification?.expiresAt);
    let heartbeatAt = 0,
      lastState = "";
    while (!stopRequested && Date.now() < expiry) {
      if (Date.now() - heartbeatAt > 5000) {
        await request("/api/sessions/heartbeat", {}, token, polling.signal);
        heartbeatAt = Date.now();
      }
      const current = await request(
        `/internal/audio-qualifications/${encodeURIComponent(requestId)}`,
        undefined,
        config.operatorToken,
        polling.signal,
      );
      const state = String(current.request?.state ?? "unknown");
      if (state !== lastState) {
        console.log("Audio test: " + state);
        lastState = state;
      }
      if (
        ["ended", "unknown"].includes(current.call?.state) ||
        current.session?.state === "stopped"
      )
        break;
      await delay(1000);
    }
  } catch {
    intent.state = stopRequested ? "stop_requested" : "requires_reconciliation";
    save();
    if (!stopRequested) {
      console.error(
        "Test interrupted or outcome uncertain. Intent retained at " +
          ledger +
          ". Never repeat a call with a new key.",
      );
      process.exitCode = 1;
    }
  } finally {
    if (requestId) {
      try {
        await sendStop();
        intent.state = "stop_recorded";
        save();
        let closed = false;
        for (let n = 0; n < 15; n++) {
          const status = await request(
            `/internal/audio-qualifications/${encodeURIComponent(requestId)}`,
          );
          if (status.cleanupConfirmed === true) {
            closed = true;
            break;
          }
          await delay(1000);
        }
        intent.state = closed ? "closed" : "cleanup_unconfirmed";
        save();
        console.log(
          closed
            ? "Call ended; cleanup confirmed."
            : "Stop recorded; cleanup is unconfirmed. Do not redial.",
        );
        if (!closed) process.exitCode = 1;
      } catch {
        intent.state = "cleanup_unconfirmed";
        save();
        process.exitCode = 1;
        console.error(
          "Cleanup unconfirmed. Heartbeat and fixed expiry fail closed; reconcile the exact request before another call.",
        );
      }
    }
    token = undefined;
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.stdin.removeListener("data", stop);
    process.stdin.pause();
  }
}
main().catch(() => {
  // Never print response bodies, configuration, credential-bearing URLs or exceptions.
  console.error(
    "Audio qualification did not start. Check owner-only config, --ready-for-one-call, foreground terminal and service readiness. No retry was issued.",
  );
  process.exitCode = 1;
});
