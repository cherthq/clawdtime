import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAppServerRunner,
  verifyFileResult,
} from "../connectors/codex/runner.js";
import type {
  AppServerConnection,
  AppServerMessage,
} from "../connectors/codex/app-server.js";
import type { RunnerEvent, RunnerRequest } from "../src/contracts.js";

class Host implements AppServerConnection {
  listeners = new Set<(m: AppServerMessage) => void>();
  requests: string[] = [];
  responses: unknown[] = [];
  onStart?: () => void;
  onInterrupt?: () => void;
  notify(m: AppServerMessage) {
    for (const fn of this.listeners) fn(m);
  }
  async request(method: string) {
    this.requests.push(method);
    if (method === "thread/start") return { thread: { id: "thread" } };
    if (method === "turn/start") {
      queueMicrotask(() => this.onStart?.());
      return { turn: { id: "turn", status: "inProgress" } };
    }
    if (method === "turn/interrupt") this.onInterrupt?.();
    return {};
  }
  respond(id: number | string, value: unknown) {
    this.responses.push({ id, value });
  }
  subscribe(fn: (m: AppServerMessage) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  close() {}
  complete(status = "completed") {
    this.notify({
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn", status } },
    });
  }
}
function request(root: string, dispatchId = "dispatch"): RunnerRequest {
  return {
    projectRoot: root,
    externalSessionId: "selected-managed-session",
    job: {
      version: 1,
      id: "job",
      sessionId: "session",
      pairingId: "pair",
      memberId: "member",
      source: { channel: "text", eventId: "event" },
      runnerId: "codex-app-server",
      revision: 1,
      instructionSequence: 1,
      kind: "file",
      preference: "auto",
      state: "running",
      createdAt: 1,
      updatedAt: 1,
      dispatchId,
    },
    intent: {
      kind: "file",
      preference: "auto",
      instruction: "Write the requested fixture",
      verification: {
        kind: "file_contains",
        path: "result.txt",
        expected: "verified value",
      },
    },
  };
}
function runner(host: Host, timeoutMs = 500) {
  return new CodexAppServerRunner({
    enabled: true,
    version: "fixture",
    timeoutMs,
    interruptTimeoutMs: 10,
    connectionFactory: () => host,
  });
}

describe("API-managed Codex executor", () => {
  it("accepts actual host events and independently verifies files, not model completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawdtime-runner-"));
    try {
      const host = new Host();
      const r = runner(host);
      const events: RunnerEvent[] = [];
      host.onStart = () => {
        void writeFile(join(root, "result.txt"), "verified value").then(() =>
          host.complete(),
        );
      };
      const value = await r.run(
        request(root),
        (e) => events.push(e),
        new AbortController().signal,
      );
      expect(value.outcome).toBe("succeeded");
      expect(value.verification?.verified).toBe(true);
      expect(events).toContainEqual({ type: "accepted" });
      expect(host.requests.filter((x) => x === "turn/start")).toHaveLength(1);
      expect(
        (await r.run(request(root), () => {}, new AbortController().signal))
          .outcome,
      ).toBe("unknown");
      const bad = request(root, "second");
      bad.intent.verification!.expected = "not present";
      host.onStart = () => host.complete();
      expect(
        (await r.run(bad, () => {}, new AbortController().signal)).outcome,
      ).toBe("failed");
      expect(host.requests.filter((x) => x === "thread/start")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("does not advertise an absent binary or an unconfigured local workspace", () => {
    expect(
      new CodexAppServerRunner({
        enabled: true,
        version: "unqualified",
        binary: "/nonexistent/clawdtime-codex",
        projectRoots: ["/tmp"],
      }).capabilities().available,
    ).toBe(false);
    expect(
      new CodexAppServerRunner({
        enabled: false,
        version: "unqualified",
      }).capabilities().available,
    ).toBe(false);
  });
  it("refuses desktop requests and does not silently fall back", async () => {
    const host = new Host(),
      input = request("/tmp");
    input.intent.kind = "desktop";
    expect(
      (await runner(host).run(input, () => {}, new AbortController().signal))
        .outcome,
    ).toBe("failed");
    expect(host.requests).toEqual([]);
  });
  it("rejects verifier escape through symlink and oversize content", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawdtime-runner-"));
    try {
      await mkdir(join(root, "project"));
      await writeFile(join(root, "outside"), "verified value");
      await symlink(join(root, "outside"), join(root, "project", "result.txt"));
      await expect(
        verifyFileResult(request(join(root, "project"))),
      ).rejects.toThrow("verification_outside_project");
      await writeFile(join(root, "result.txt"), "x".repeat(1_048_577));
      await expect(verifyFileResult(request(root))).rejects.toThrow(
        "verification_file_bounds",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("marks acceptance loss unknown without another turn submission", async () => {
    const host = new Host();
    host.onStart = () => host.notify({ method: "clawdtime/disconnected" });
    const r = runner(host);
    expect(
      (await r.run(request("/tmp"), () => {}, new AbortController().signal))
        .outcome,
    ).toBe("unknown");
    expect(
      (
        await r.run(
          request("/tmp", "next"),
          () => {},
          new AbortController().signal,
        )
      ).outcome,
    ).toBe("failed");
    expect(host.requests.filter((x) => x === "turn/start")).toHaveLength(1);
  });
  it("does not equate interrupt RPC acceptance with canceled execution", async () => {
    const host = new Host(),
      abort = new AbortController();
    host.onStart = () => abort.abort();
    const value = await runner(host).run(
      request("/tmp"),
      () => {},
      abort.signal,
    );
    expect(value.outcome).toBe("unknown");
    expect(value.unresolvedEffectIds).toEqual(["dispatch"]);
  });
  it("reports canceled only after host terminal interruption", async () => {
    const host = new Host(),
      abort = new AbortController();
    host.onStart = () => abort.abort();
    host.onInterrupt = () => host.complete("interrupted");
    expect(
      (await runner(host).run(request("/tmp"), () => {}, abort.signal)).outcome,
    ).toBe("canceled");
  });
  it("keeps interrupted native commands unknown until their input receipts finish", async () => {
    const host = new Host(),
      abort = new AbortController();
    host.onStart = () => {
      host.notify({
        method: "item/started",
        params: {
          threadId: "thread",
          turnId: "turn",
          item: { id: "command", type: "commandExecution" },
        },
      });
      abort.abort();
    };
    host.onInterrupt = () => host.complete("interrupted");
    expect(
      (await runner(host).run(request("/tmp"), () => {}, abort.signal)).outcome,
    ).toBe("unknown");
  });
  it("preserves native approvals and emits waiting state without approving", async () => {
    const host = new Host(),
      events: RunnerEvent[] = [];
    host.onStart = () =>
      setTimeout(
        () =>
          host.notify({
            id: 9,
            method: "item/commandExecution/requestApproval",
            params: { threadId: "thread", turnId: "turn" },
          }),
        0,
      );
    host.onInterrupt = () => host.complete("interrupted");
    await runner(host).run(
      request("/tmp"),
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(events).toContainEqual({ type: "waiting_approval" });
    expect(host.responses).toEqual([{ id: 9, value: { decision: "decline" } }]);
  });
  it("does not let another project reuse a managed execution session", async () => {
    const host = new Host();
    host.onStart = () => host.complete("interrupted");
    const r = runner(host);
    await r.run(request("/tmp"), () => {}, new AbortController().signal);
    expect(
      (
        await r.run(
          request("/another", "different"),
          () => {},
          new AbortController().signal,
        )
      ).summary,
    ).toContain("identity mismatch");
    expect(host.requests.filter((x) => x === "turn/start")).toHaveLength(1);
  });
});
