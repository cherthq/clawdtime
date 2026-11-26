import { describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutorWorker } from "../connectors/shared/executor-worker.js";
import { secureRead, secureWrite } from "../connectors/shared/state.js";
import type {
  AgentSession,
  ExecutionResult,
  ExecutionRunner,
  RunnerRequest,
} from "../src/contracts.js";

const durabilityFault = vi.hoisted(() => ({ fail: false }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    fsyncSync: (fd: number) => {
      if (durabilityFault.fail)
        throw new Error("simulated receipt flush failure");
      original.fsyncSync(fd);
    },
  };
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "clawdtime-worker-")),
  );
  const session: AgentSession = {
    id: "session",
    pairingId: "pairing",
    adapter: "codex",
    adapterVersion: "fixture",
    projectRoot: root,
    externalSessionId: "selected-session",
    hostId: "host",
    createdAt: 1,
    protocolVersion: 2,
    conversation: {
      version: 1,
      runnerId: "remote-codex-app-server",
      executionSession: "api_managed",
    },
    capabilities: { cooperativePause: true, polling: true },
    state: "active",
    controlEpoch: 0,
  };
  const dispatch: RunnerRequest = {
    projectRoot: root,
    externalSessionId: session.externalSessionId,
    job: {
      id: "job",
      dispatchId: "job:1",
      version: 1,
      sessionId: session.id,
      pairingId: session.pairingId,
      memberId: "member",
      runnerId: "remote-codex-app-server",
      revision: 1,
      instructionSequence: 1,
      kind: "file",
      preference: "auto",
      state: "running",
      source: { channel: "text", eventId: "event" },
      createdAt: 1,
      updatedAt: 1,
    },
    intent: {
      kind: "file",
      preference: "auto",
      instruction: "private instruction must not persist",
      verification: { kind: "file_contains", path: "out", expected: "done" },
    },
  };
  const outcome: ExecutionResult = {
    outcome: "succeeded",
    summary: "Independent fixture verified.",
    verification: {
      method: "file_read",
      verified: true,
      evidenceId: "evidence",
    },
    unresolvedEffectIds: [],
  };
  let runs = 0;
  const runner: ExecutionRunner = {
    capabilities: () => ({
      id: "codex-app-server",
      host: "codex_app_server",
      available: true,
      version: "fixture",
      nativeControl: "none",
      customControl: false,
      cancellation: "cooperative",
    }),
    async run(_request, emit) {
      runs++;
      emit({ type: "accepted" });
      return outcome;
    },
  };
  const abort = new AbortController(),
    ledgerPath = join(root, "worker.json"),
    calls: Array<{ path: string; body: any }> = [];
  let handler = async (path: string, _body: any): Promise<any> =>
    path === "/api/executor/ready"
      ? { ready: true }
      : path === "/api/executor/next"
        ? { dispatch }
        : path.startsWith("/api/executor/command")
          ? { cancelRequested: false }
          : path === "/api/executor/result"
            ? (abort.abort(), { accepted: true })
            : { accepted: true };
  const request = (async (url, init) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search,
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    return new Response(JSON.stringify(await handler(path, body)));
  }) as typeof fetch;
  const worker = () =>
    new ExecutorWorker({
      origin: "http://127.0.0.1:3330",
      token: "fixture-token",
      session,
      ledgerPath,
      runner,
      request,
      pollMs: 5,
      retryMs: 1,
    });
  return {
    root,
    session,
    dispatch,
    outcome,
    runner,
    abort,
    ledgerPath,
    calls,
    worker,
    runs: () => runs,
    handler: (fn: typeof handler) => {
      handler = fn;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("explicit local executor pull worker", () => {
  it("accepts only document dispatches in an explicitly selected document worker", async () => {
    const f = await fixture();
    f.session.conversation!.runnerId = "remote-documents";
    f.session.documentAccess = {
      version: 1,
      readOnly: true,
      expiresAt: Date.now() + 60_000,
    };
    f.dispatch.job.runnerId = "remote-documents";
    f.dispatch.job.kind = "document";
    f.dispatch.intent = {
      kind: "document",
      preference: "auto",
      instruction: "Read-only discovery",
      document: { operation: "discover", grantId: "grant" },
    };
    f.outcome.verification = {
      method: "document_digest",
      verified: true,
      evidenceId: "fixture",
    };
    f.outcome.document = { operation: "discover", candidates: [] };
    try {
      await f.worker().run(f.abort.signal);
      expect(f.runs()).toBe(1);
      expect(
        f.calls.find((item) => item.path === "/api/executor/result")?.body
          .result.document,
      ).toEqual({ operation: "discover", candidates: [] });
    } finally {
      await f.cleanup();
    }
  });
  it("refuses file-agent work delivered to a document session", async () => {
    const f = await fixture();
    f.session.conversation!.runnerId = "remote-documents";
    f.dispatch.job.runnerId = "remote-documents";
    try {
      await expect(f.worker().run(f.abort.signal)).rejects.toThrow(
        "identity mismatch",
      );
      expect(f.runs()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it("executes once and persists metadata without prompt content", async () => {
    const f = await fixture();
    try {
      await f.worker().run(f.abort.signal);
      expect(f.runs()).toBe(1);
      const saved = secureRead<any>(f.ledgerPath);
      expect(saved.receipts[0].state).toBe("reported");
      expect(JSON.stringify(saved)).not.toContain("private instruction");
      expect(
        f.calls.find((c) => c.path === "/api/executor/ready")?.body,
      ).toEqual({
        version: "fixture",
        projectRoot: f.root,
        externalSessionId: "selected-session",
      });
    } finally {
      await f.cleanup();
    }
  });
  it("does not execute when the intent receipt cannot be durably flushed", async () => {
    const f = await fixture();
    try {
      const worker = f.worker();
      durabilityFault.fail = true;
      await expect(worker.run(f.abort.signal)).rejects.toThrow(
        "simulated receipt flush failure",
      );
      expect(f.runs()).toBe(0);
    } finally {
      durabilityFault.fail = false;
      await f.cleanup();
    }
  });

  it("reconciles duplicate assignment by posting the original result without reexecution", async () => {
    const f = await fixture();
    let reports = 0;
    f.handler(async (path) =>
      path === "/api/executor/ready"
        ? { ready: true }
        : path === "/api/executor/next"
          ? { dispatch: f.dispatch }
          : path.startsWith("/api/executor/command")
            ? { cancelRequested: false }
            : path === "/api/executor/result"
              ? (++reports === 2 && f.abort.abort(), { accepted: true })
              : { accepted: true },
    );
    try {
      await f.worker().run(f.abort.signal);
      expect(reports).toBe(2);
      expect(f.runs()).toBe(1);
      const results = f.calls.filter((c) => c.path === "/api/executor/result");
      expect(results[0]?.body).toEqual(results[1]?.body);
    } finally {
      await f.cleanup();
    }
  });
  it("retries an ambiguous result post under exactly the same identity", async () => {
    const f = await fixture();
    let reports = 0;
    f.handler(async (path) => {
      if (path === "/api/executor/result") {
        if (++reports === 1) throw new Error("ack lost");
        f.abort.abort();
        return { accepted: true };
      }
      return path === "/api/executor/ready"
        ? { ready: true }
        : path === "/api/executor/next"
          ? { dispatch: f.dispatch }
          : path.startsWith("/api/executor/command")
            ? { cancelRequested: false }
            : { accepted: true };
    });
    try {
      await f.worker().run(f.abort.signal);
      expect(f.runs()).toBe(1);
      const results = f.calls.filter((c) => c.path === "/api/executor/result");
      expect(results).toHaveLength(2);
      expect(results[0]?.body).toEqual(results[1]?.body);
    } finally {
      await f.cleanup();
    }
  });
  it("reports an interrupted local receipt unknown after restart without invoking agent", async () => {
    const f = await fixture();
    secureWrite(f.ledgerPath, {
      version: 1,
      sessionId: f.session.id,
      externalSessionId: f.session.externalSessionId,
      receipts: [{ dispatchId: "job:1", state: "started" }],
    });
    try {
      await f.worker().run(f.abort.signal);
      expect(f.runs()).toBe(0);
      expect(
        f.calls.find((c) => c.path === "/api/executor/result")?.body.result,
      ).toMatchObject({ outcome: "unknown", unresolvedEffectIds: ["job:1"] });
    } finally {
      await f.cleanup();
    }
  });
  it("rejects a mismatched project before any executor call", async () => {
    const f = await fixture();
    f.dispatch.projectRoot = "/other-project";
    try {
      await expect(f.worker().run(f.abort.signal)).rejects.toThrow(
        "identity mismatch",
      );
      expect(f.runs()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it("polls cooperative cancellation while a slow runner continues", async () => {
    const f = await fixture();
    let checks = 0;
    f.handler(async (path) =>
      path === "/api/executor/ready"
        ? { ready: true }
        : path === "/api/executor/next"
          ? { dispatch: f.dispatch }
          : path.startsWith("/api/executor/command")
            ? { cancelRequested: ++checks > 1 }
            : path === "/api/executor/result"
              ? (f.abort.abort(), { accepted: true })
              : { accepted: true },
    );
    f.runner.run = async (_request, emit, signal) => {
      emit({ type: "accepted" });
      await new Promise<void>((r) =>
        signal.addEventListener("abort", () => r(), { once: true }),
      );
      return {
        outcome: "canceled",
        summary: "Confirmed stop.",
        unresolvedEffectIds: [],
      };
    };
    try {
      await f.worker().run(f.abort.signal);
      expect(checks).toBeGreaterThan(1);
      expect(
        f.calls.find((c) => c.path === "/api/executor/result")?.body.result
          .outcome,
      ).toBe("canceled");
    } finally {
      await f.cleanup();
    }
  });
});
