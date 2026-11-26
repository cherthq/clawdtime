import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fsyncSync,
  openSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type {
  AgentSession,
  ExecutionResult,
  ExecutionRunner,
  RunnerEvent,
  RunnerRequest,
} from "../../src/contracts.js";
import { documentOperationSchema } from "../../src/document-contracts.js";
import { createDocumentHost } from "./document-host.js";
import { CodexAppServerRunner } from "../codex/runner.js";
import { validateOrigin } from "./client.js";
import { startHeartbeat } from "./heartbeat.js";
import {
  canonicalProject,
  loadConnection,
  secureRead,
  secureWrite,
  type RunState,
} from "./state.js";

type Receipt = {
  dispatchId: string;
  state: "started" | "result" | "reported";
  result?: ExecutionResult;
};
interface Ledger {
  version: 1;
  sessionId: string;
  externalSessionId: string;
  receipts: Receipt[];
}
const unknown = (dispatchId: string): ExecutionResult => ({
  outcome: "unknown",
  summary: "Local worker stopped with an unresolved execution. Do not replay.",
  unresolvedEffectIds: [dispatchId],
});
const smallId = z.string().min(1).max(200);
const dispatchSchema = z
  .object({
    projectRoot: z.string().min(1).max(4096),
    externalSessionId: smallId,
    job: z
      .object({
        id: smallId,
        dispatchId: smallId,
        sessionId: smallId,
        pairingId: smallId,
        runnerId: smallId,
        revision: z.number().int().positive(),
        kind: z.enum(["file", "document"]),
      })
      .passthrough(),
    intent: z.union([
      z
        .object({
          instruction: z.string().min(1).max(8000),
          kind: z.literal("file"),
          preference: z.enum(["auto", "native"]),
          target: z.string().min(1).max(512).optional(),
          verification: z
            .object({
              kind: z.literal("file_contains"),
              path: z.string().min(1).max(4096),
              expected: z.string().min(1).max(8000),
            })
            .strict()
            .optional(),
        })
        .strict(),
      z
        .object({
          instruction: z.string().min(1).max(8000),
          kind: z.literal("document"),
          preference: z.enum(["auto", "native"]),
          document: documentOperationSchema,
        })
        .strict(),
    ]),
  })
  .strict();

/** One explicit local worker for one already-registered managed session. No desktop-chat wakeup. */
export class ExecutorWorker {
  private ledger: Ledger;
  private active?: AbortController;
  private fatal = false;
  private readonly origin: string;
  constructor(
    private options: {
      origin: string;
      token: string;
      session: AgentSession;
      ledgerPath: string;
      runner: ExecutionRunner;
      request?: typeof fetch;
      pollMs?: number;
      retryMs?: number;
    },
  ) {
    this.origin = validateOrigin(options.origin);
    if (
      !["remote-codex-app-server", "remote-documents"].includes(
        options.session.conversation?.runnerId ?? "",
      ) ||
      options.session.conversation?.executionSession !== "api_managed" ||
      options.session.protocolVersion !== 2 ||
      options.session.adapter !== "codex"
    )
      throw new Error(
        "Select a fresh supported managed execution session first.",
      );
    if (
      !options.runner.capabilities().available ||
      canonicalProject(options.session.projectRoot) !==
        options.session.projectRoot
    )
      throw new Error(
        "Local executor or exact selected project is unavailable.",
      );
    this.ledger = existsSync(options.ledgerPath)
      ? secureRead<Ledger>(options.ledgerPath)
      : {
          version: 1,
          sessionId: options.session.id,
          externalSessionId: options.session.externalSessionId,
          receipts: [],
        };
    if (
      this.ledger.version !== 1 ||
      this.ledger.sessionId !== options.session.id ||
      this.ledger.externalSessionId !== options.session.externalSessionId ||
      !Array.isArray(this.ledger.receipts) ||
      this.ledger.receipts.length > 1000
    )
      throw new Error(
        "Local worker receipt identity mismatch; preserve the ledger.",
      );
    for (const receipt of this.ledger.receipts)
      if (receipt.state === "started") {
        receipt.state = "result";
        receipt.result = unknown(receipt.dispatchId);
      }
    this.save();
  }
  private save() {
    secureWrite(this.options.ledgerPath, this.ledger);
    // Atomic rename alone is not durable after power loss. Flush the receipt and
    // its directory entry before starting an effect or acknowledging its result.
    const file = openSync(
      this.options.ledgerPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    const directory = openSync(
      dirname(this.options.ledgerPath),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  private async api(path: string, body?: unknown): Promise<any> {
    const response = await (this.options.request ?? fetch)(this.origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(4000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if ([400, 401, 403, 404, 409, 422].includes(response.status))
        this.fatal = true;
      throw new Error("Worker transport refused; preserve original receipts.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Worker response missing.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 128_000) {
        await reader.cancel();
        throw new Error("Worker response exceeds bound.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  private async ready() {
    await this.api("/api/sessions/heartbeat", {});
    const r = await this.api("/api/executor/ready", {
      version: this.options.runner.capabilities().version,
      projectRoot: this.options.session.projectRoot,
      externalSessionId: this.options.session.externalSessionId,
    });
    if (r.ready !== true)
      throw new Error("Remote broker did not accept worker readiness.");
  }
  private async report(receipt: Receipt, signal: AbortSignal) {
    do {
      try {
        const r = await this.api("/api/executor/result", {
          dispatchId: receipt.dispatchId,
          result: receipt.result,
        });
        if (r.accepted !== true)
          throw new Error("Result acknowledgement missing.");
        receipt.state = "reported";
        this.save();
        return true;
      } catch {
        if (this.fatal || signal.aborted) return false;
        await this.pause(signal, this.options.retryMs ?? 1000);
      }
    } while (!signal.aborted);
    return false;
  }
  private pause(signal: AbortSignal, ms: number) {
    return new Promise<void>((done) => {
      if (signal.aborted) return done();
      const stop = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        done();
      };
      const timer = setTimeout(stop, ms);
      signal.addEventListener("abort", stop, { once: true });
    });
  }
  async run(signal: AbortSignal) {
    const stop = () => this.active?.abort();
    signal.addEventListener("abort", stop);
    let stopHeartbeat = () => {};
    try {
      await this.ready();
      stopHeartbeat = startHeartbeat(async () => {
        try {
          await this.ready();
        } catch {
          this.active?.abort();
        }
      });
      for (const receipt of this.ledger.receipts)
        if (receipt.state === "result" && !(await this.report(receipt, signal)))
          return;
      let eventId = randomUUID();
      while (!signal.aborted && !this.fatal) {
        let envelope: { dispatch?: RunnerRequest };
        try {
          envelope = await this.api("/api/executor/next", { eventId });
        } catch {
          if (this.fatal) return;
          await this.pause(signal, this.options.retryMs ?? 1000);
          continue;
        }
        if (!envelope.dispatch) {
          eventId = randomUUID();
          await this.pause(signal, this.options.pollMs ?? 500);
          continue;
        }
        const parsed = dispatchSchema.safeParse(envelope.dispatch);
        if (!parsed.success)
          throw new Error("Invalid worker dispatch; no execution started.");
        const dispatch = parsed.data as unknown as RunnerRequest;
        if (
          dispatch.job.sessionId !== this.options.session.id ||
          dispatch.job.pairingId !== this.options.session.pairingId ||
          dispatch.job.runnerId !==
            this.options.session.conversation?.runnerId ||
          dispatch.job.kind !== dispatch.intent.kind ||
          (dispatch.intent.kind === "document") !==
            (dispatch.job.runnerId === "remote-documents") ||
          dispatch.projectRoot !== this.options.session.projectRoot ||
          dispatch.externalSessionId !== this.options.session.externalSessionId
        )
          throw new Error(
            "Worker dispatch identity mismatch; no execution started.",
          );
        let receipt = this.ledger.receipts.find(
          (r) => r.dispatchId === dispatch.job.dispatchId,
        );
        if (!receipt) {
          if (this.ledger.receipts.length >= 1000)
            throw new Error(
              "Worker receipt capacity reached; preserve records and reconcile.",
            );
          receipt = { dispatchId: dispatch.job.dispatchId!, state: "started" };
          this.ledger.receipts.push(receipt);
          this.save();
          this.active = new AbortController();
          if (signal.aborted) this.active.abort();
          const active = this.active;
          let commandBusy = false,
            events = Promise.resolve();
          const checkCommand = async () => {
            if (commandBusy || active.signal.aborted) return;
            commandBusy = true;
            try {
              const command = await this.api(
                `/api/executor/command?dispatchId=${encodeURIComponent(receipt!.dispatchId)}`,
              );
              if (command.cancelRequested !== false) active.abort();
            } catch {
              active.abort();
            } finally {
              commandBusy = false;
            }
          };
          await checkCommand();
          const commands = setInterval(
            () => void checkCommand(),
            Math.min(500, this.options.pollMs ?? 500),
          );
          try {
            const emit = (event: RunnerEvent) => {
              events = events.then(async () => {
                try {
                  const response = await this.api("/api/executor/events", {
                    dispatchId: receipt!.dispatchId,
                    event,
                  });
                  if (response.accepted !== true) active.abort();
                } catch {
                  active.abort();
                }
              });
            };
            receipt.result = await this.options.runner
              .run(dispatch, emit, active.signal)
              .catch(() => unknown(receipt!.dispatchId));
            await events;
          } finally {
            clearInterval(commands);
            this.active = undefined;
          }
          receipt.state = "result";
          this.save();
        }
        // A repeated assignment only reconciles its exact saved result, never executes again.
        if (!receipt.result || !(await this.report(receipt, signal))) return;
        eventId = randomUUID();
      }
    } finally {
      stopHeartbeat();
      signal.removeEventListener("abort", stop);
      this.active?.abort();
    }
  }
}

/** Foreground CLI. Protected state paths contain credentials; no credential appears in arguments. */
export async function startExecutorWorker(options: {
  runFile: string;
  connectionFile?: string;
  signal?: AbortSignal;
}) {
  const runPath = resolve(options.runFile),
    run = secureRead<RunState>(runPath);
  if (
    !run.session ||
    !run.token ||
    run.session.state === "stopped" ||
    run.projectRoot !== run.session.projectRoot ||
    run.runId !== run.session.externalSessionId
  )
    throw new Error(
      "Use an active protected registered run with its exact managed session identity.",
    );
  const connection = loadConnection(
    options.connectionFile ??
      resolve(dirname(runPath), "..", "connection.json"),
    run.projectRoot,
    run.adapter,
  );
  const lockPath = `${runPath}.executor.lock`;
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(join(lockPath, "pid"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("Invalid worker lock; preserve for recovery.");
    try {
      process.kill(pid, 0);
      throw new Error("This session already has an executor worker.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    rmSync(lockPath, { recursive: true });
  }
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(join(lockPath, "pid"), String(process.pid), { mode: 0o600 });
  let documentHost: Awaited<ReturnType<typeof createDocumentHost>> | undefined;
  const abort = new AbortController(),
    stop = () => {
      void documentHost?.stop();
      abort.abort();
    };
  options.signal?.addEventListener("abort", stop, { once: true });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let runner: ExecutionRunner | undefined;
  try {
    if (run.session.conversation?.runnerId === "remote-documents") {
      documentHost = await createDocumentHost(
        run.session,
        connection.baseUrl,
        run.token,
      );
      runner = documentHost.runner;
    } else
      runner = new CodexAppServerRunner({
        enabled: true,
        version: "unqualified",
        projectRoots: [run.projectRoot],
      });
    if (options.signal?.aborted) stop();
    if (abort.signal.aborted) return;
    const worker = new ExecutorWorker({
      origin: connection.baseUrl,
      token: run.token,
      session: run.session,
      ledgerPath: `${runPath}.executor.json`,
      runner,
    });
    console.log(
      JSON.stringify({
        worker: run.session.conversation?.runnerId,
        sessionId: run.session.id,
        host: runner.capabilities().host,
        version: runner.capabilities().version,
        nativeControl: "none",
        status: "connecting",
      }),
    );
    await worker.run(
      options.signal
        ? AbortSignal.any([abort.signal, options.signal])
        : abort.signal,
    );
  } finally {
    if (runner instanceof CodexAppServerRunner) runner.close();
    if (documentHost)
      console.log(
        JSON.stringify({
          documentAuthorityStopped: await documentHost.stop(),
          nativeControl: "none",
        }),
      );
    options.signal?.removeEventListener("abort", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (
      existsSync(join(lockPath, "pid")) &&
      readFileSync(join(lockPath, "pid"), "utf8") === String(process.pid)
    )
      rmSync(lockPath, { recursive: true });
  }
}
