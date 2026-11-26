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

describe("API-managed Codex executor sessions", () => {
  class CountedHost extends Host {
    closed = 0;
    override close() {
      this.closed++;
    }
  }
  function many(
    factory: () => CountedHost,
    sessionOpen?: (id: string) => boolean,
  ) {
    return new CodexAppServerRunner({
      enabled: true,
      version: "fixture",
      timeoutMs: 500,
      interruptTimeoutMs: 10,
      connectionFactory: factory,
      ...(sessionOpen ? { sessionOpen } : {}),
    });
  }
  function job(index: number) {
    const value = request("/fixture", `dispatch-${index}`);
    value.job = { ...value.job, id: `job-${index}`, sessionId: `s-${index}` };
    return value;
  }
  it("ends the app-server of a finished session, so finished sessions never fill the capacity", async () => {
    const hosts: CountedHost[] = [];
    const open = new Set<string>();
    const r = many(
      () => {
        const host = new CountedHost();
        host.onStart = () => host.complete("interrupted");
        hosts.push(host);
        return host;
      },
      (id) => open.has(id),
    );
    const summaries: string[] = [];
    for (let i = 0; i < 25; i++) {
      open.add(`s-${i}`);
      summaries.push(
        (await r.run(job(i), () => {}, new AbortController().signal)).summary,
      );
      open.delete(`s-${i}`);
    }
    expect(summaries.filter((s) => /capacity/.test(s))).toEqual([]);
    expect(hosts).toHaveLength(25);
    // Each finished session's app-server ended when the next run came.
    expect(hosts.slice(0, 24).every((host) => host.closed === 1)).toBe(true);
    expect(hosts[24]!.closed).toBe(0);
  });
  it("keeps the app-server of an open session for its next turn", async () => {
    const hosts: CountedHost[] = [];
    const r = many(
      () => {
        const host = new CountedHost();
        host.onStart = () => host.complete("interrupted");
        hosts.push(host);
        return host;
      },
      () => true,
    );
    await r.run(job(1), () => {}, new AbortController().signal);
    const again = job(1);
    again.job = { ...again.job, dispatchId: "dispatch-again" };
    await r.run(again, () => {}, new AbortController().signal);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.closed).toBe(0);
    expect(hosts[0]!.requests.filter((x) => x === "turn/start")).toHaveLength(
      2,
    );
  });
  it("frees the place of a poisoned session but still refuses its next turn", async () => {
    const hosts: CountedHost[] = [];
    const r = many(() => {
      const host = new CountedHost();
      // The acceptance has no turn ID, so the outcome is unknown.
      host.request = async (method: string) => {
        host.requests.push(method);
        if (method === "thread/start") return { thread: { id: "thread" } };
        return {};
      };
      hosts.push(host);
      return host;
    });
    for (let i = 0; i < 20; i++)
      expect(
        (await r.run(job(i), () => {}, new AbortController().signal)).outcome,
      ).toBe("unknown");
    const next = await r.run(job(20), () => {}, new AbortController().signal);
    expect(next.summary).not.toMatch(/capacity/);
    const again = job(0);
    again.job = { ...again.job, dispatchId: "dispatch-0-again" };
    expect(
      (await r.run(again, () => {}, new AbortController().signal)).summary,
    ).toMatch(/reconciliation/);
    expect(hosts).toHaveLength(21);
  });
});
