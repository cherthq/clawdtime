/** Synthetic port policy tests only; not native/custom performance or physical acceptance. */
import { describe, expect, it } from "vitest";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import {
  BoundedDesktopRunner,
  RoutedExecutionRunner,
  type DesktopPlanner,
} from "../src/control/desktop-runner.js";
import {
  MediaTextDevicePort,
  type DesktopObservation,
  type TextDesktopPort,
  type TextLease,
} from "../src/control/text-device.js";
import type {
  ConversationJob,
  ExecutionRunner,
  InputAction,
  RunnerRequest,
  TextControlGrant,
} from "../src/contracts.js";

function fixture(adapter: "native" | "custom" = "custom") {
  const store = new Store();
  let now = 100_000;
  const service = new ClawdTime(store, new SimulationTransport(), {
    clock: () => now,
  });
  const invitation = service.createPairingInvite({
    memberId: "member",
    recipient: "synthetic",
    conversationId: "messages",
    lineId: "line",
    deviceId: "device",
    displayId: "1",
  });
  const paired = service.claimPairing({
    token: invitation.token,
    deviceId: "device",
    displayId: "1",
    allowView: true,
    allowControl: true,
  });
  const agent = service.registerSession(paired.token, {
    adapter: "codex",
    adapterVersion: "synthetic",
    projectRoot: "/fixture",
    externalSessionId: "managed-fixture",
    hostId: "host",
    protocolVersion: 2,
    conversation: {
      version: 1,
      runnerId: `bounded-${adapter}`,
      executionSession: "api_managed",
    },
    capabilities: { cooperativePause: true, polling: true },
  });
  const grant: TextControlGrant = {
    id: "grant",
    kind: "text_session",
    sessionId: agent.session.id,
    pairingId: paired.pairing.id,
    memberId: "member",
    deviceId: "device",
    displayId: "1",
    projectRoot: "/fixture",
    surface: "display:1",
    actions: ["type"],
    expiresAt: 120_000,
    policyRevision: 1,
    localEnableGeneration: 7,
    state: "active",
  };
  const job: ConversationJob = {
    id: "job",
    version: 1,
    sessionId: agent.session.id,
    pairingId: paired.pairing.id,
    memberId: "member",
    source: { channel: "text", eventId: "event" },
    runnerId: `bounded-${adapter}`,
    revision: 1,
    instructionSequence: 1,
    kind: "desktop",
    preference: adapter,
    state: "running",
    createdAt: now,
    updatedAt: now,
    dispatchId: "job:1",
  };
  store.put("text_control_grant", grant);
  store.put("conversation_job", job);
  const request: RunnerRequest = {
    job,
    intent: {
      instruction: "Type blue into the fixture's selected color field",
      kind: "desktop",
      preference: adapter,
      target: "fixture color field",
      grantId: grant.id,
    },
    projectRoot: "/fixture",
    externalSessionId: "managed-fixture",
  };
  let observations = 0,
    acquires = 0,
    releases = 0,
    inputs = 0,
    verifies = 0;
  const leases: TextLease[] = [];
  const port: TextDesktopPort = {
    async proposeGrant() {
      return { state: "pending" };
    },
    async grantStatus() {
      return { state: "active", grant: { ...grant } };
    },
    async acquire(lease) {
      acquires++;
      leases.push(lease);
    },
    async observe() {
      observations++;
      now++;
      return {
        frame: {
          id: `frame_${observations}`,
          capturedAt: now,
          width: 640,
          height: 480,
        },
        dataUrl:
          observations <= 2
            ? "data:image/jpeg;base64,YmVmb3Jl"
            : "data:image/jpeg;base64,YWZ0ZXI=",
      };
    },
    async input(_lease, _frame, _action, _actionId) {
      inputs++;
      return { submitted: true };
    },
    async release() {
      releases++;
    },
  };
  const planner: DesktopPlanner = {
    async propose() {
      return { kind: "type", text: "blue" };
    },
    async verify() {
      verifies++;
      return true;
    },
  };
  const runner = new BoundedDesktopRunner(service, port, planner, {
    enabled: true,
    adapter,
    version: "synthetic-port",
  });
  return {
    store,
    service,
    grant,
    job,
    request,
    port,
    planner,
    runner,
    leases,
    advance: (ms: number) => {
      now += ms;
    },
    counts: () => ({ observations, acquires, releases, inputs, verifies }),
    run: (signal = new AbortController().signal) =>
      runner.run(request, () => {}, signal),
  };
}

for (const adapter of ["native", "custom"] as const)
  describe(`bounded ${adapter} adapter with supplied synthetic port`, () => {
    it("performs one bounded action with fresh observation and semantic verification", async () => {
      const f = fixture(adapter);
      try {
        const value = await f.run();
        expect(value.outcome).toBe("succeeded");
        expect(value.verification?.method).toBe("ui_observation");
        expect(f.counts()).toEqual({
          observations: 3,
          acquires: 1,
          releases: 1,
          inputs: 1,
          verifies: 1,
        });
        expect(f.leases[0]).toMatchObject({
          protocolVersion: 3,
          authority: {
            kind: "text_session",
            grantId: "grant",
            projectId: "/fixture",
          },
          executor: adapter === "native" ? "native" : "clawdtime",
        });
        expect(f.leases[0]).not.toHaveProperty("callId");
        expect(f.store.all("desktop_ownership")[0]?.state).toBe("released");
      } finally {
        f.store.close();
      }
    });
    it("retains the original action identity and never repeats a completed dispatch", async () => {
      const f = fixture(adapter);
      try {
        expect((await f.run()).outcome).toBe("succeeded");
        const original = f.store.all("desktop_action")[0]?.id;
        expect((await f.run()).outcome).toBe("unknown");
        expect(f.counts().inputs).toBe(1);
        expect(f.store.all("desktop_action").map((x) => x.id)).toEqual([
          original,
        ]);
      } finally {
        f.store.close();
      }
    });
    it("does not equate a submitted input or changed image with success", async () => {
      const f = fixture(adapter);
      f.planner.verify = async () => false;
      try {
        expect((await f.run()).outcome).toBe("failed");
        expect(f.counts().inputs).toBe(1);
        expect(f.store.all("desktop_ownership")[0]?.state).toBe("released");
      } finally {
        f.store.close();
      }
    });
    it.each(["stop", "revision", "hold", "revocation"] as const)(
      "checks %s again after planning before input",
      async (change) => {
        const f = fixture(adapter),
          abort = new AbortController();
        f.planner.propose = async () => {
          if (change === "stop") abort.abort();
          if (change === "revision")
            f.store.put("conversation_job", { ...f.job, revision: 2 });
          if (change === "hold")
            f.store.saveState(`job-hold:${f.job.sessionId}`, { active: true });
          if (change === "revocation")
            f.store.put("text_control_grant", { ...f.grant, state: "revoked" });
          return { kind: "type", text: "blue" };
        };
        try {
          expect((await f.run(abort.signal)).outcome).toBe(
            change === "stop" ? "canceled" : "failed",
          );
          expect(f.counts().inputs).toBe(0);
          expect(f.counts().releases).toBe(1);
        } finally {
          f.store.close();
        }
      },
    );
    it("refuses a stale fresh observation", async () => {
      const f = fixture(adapter);
      f.port.observe = async () => ({
        frame: { id: "stale", capturedAt: 1, width: 640, height: 480 },
        dataUrl: "data:image/jpeg;base64,c3RhbGU=",
      });
      try {
        expect((await f.run()).outcome).toBe("failed");
        expect(f.counts().inputs).toBe(0);
      } finally {
        f.store.close();
      }
    });
    it("holds ownership unknown after ambiguous input, preventing another adapter", async () => {
      const f = fixture(adapter);
      let attempts = 0;
      f.port.input = async () => {
        attempts++;
        throw new Error("connection lost after input");
      };
      try {
        const value = await f.run();
        expect(value.outcome).toBe("unknown");
        expect(value.unresolvedEffectIds).toHaveLength(1);
        expect(attempts).toBe(1);
        expect(f.store.all("desktop_ownership")[0]?.state).toBe("unknown");
        const other = new BoundedDesktopRunner(f.service, f.port, f.planner, {
          enabled: true,
          adapter: adapter === "native" ? "custom" : "native",
          version: "synthetic-port",
        });
        expect(
          (await other.run(f.request, () => {}, new AbortController().signal))
            .outcome,
        ).toBe("unknown");
        const switched = {
          ...f.request,
          job: { ...f.job, dispatchId: "new-dispatch-must-not-evade-unknown" },
        };
        expect(
          (await other.run(switched, () => {}, new AbortController().signal))
            .outcome,
        ).toBe("failed");
        expect(attempts).toBe(1);
      } finally {
        f.store.close();
      }
    });
    it("keeps ambiguous lease acquisition unknown even after a delete acknowledgment", async () => {
      const f = fixture(adapter);
      f.port.acquire = async () => {
        throw new Error("lease acceptance lost");
      };
      try {
        expect((await f.run()).outcome).toBe("unknown");
        expect(f.store.all("desktop_ownership")[0]?.state).toBe("unknown");
        expect(f.counts().inputs).toBe(0);
      } finally {
        f.store.close();
      }
    });
    it("rechecks actual local Stop after planning, not only the backend snapshot", async () => {
      const f = fixture(adapter);
      let reads = 0;
      f.port.grantStatus = async () =>
        ++reads === 1
          ? { state: "active", grant: { ...f.grant } }
          : { state: "revoked" };
      try {
        expect((await f.run()).outcome).toBe("failed");
        expect(reads).toBe(2);
        expect(f.counts().inputs).toBe(0);
      } finally {
        f.store.close();
      }
    });
    it("requires a fresh post-input observation before releasing uncertain input", async () => {
      const f = fixture(adapter);
      const observe = f.port.observe;
      let reads = 0;
      f.port.observe = async (lease) => {
        const view = await observe(lease);
        if (++reads === 3) view.frame.capturedAt = 1;
        return view;
      };
      try {
        expect((await f.run()).outcome).toBe("unknown");
        expect(f.counts().inputs).toBe(1);
        expect(f.counts().verifies).toBe(0);
      } finally {
        f.store.close();
      }
    });
    it("refuses a conflicting active call lease", async () => {
      const f = fixture(adapter);
      f.store.put("lease", {
        id: "active-call",
        deviceId: "device",
        displayId: "1",
        state: "active",
      });
      try {
        expect((await f.run()).outcome).toBe("failed");
        expect(f.counts().acquires).toBe(0);
      } finally {
        f.store.close();
      }
    });
    it("preserves unknown when release is unconfirmed", async () => {
      const f = fixture(adapter);
      f.port.release = async () => {
        throw new Error("release lost");
      };
      try {
        expect((await f.run()).outcome).toBe("unknown");
        expect(f.store.all("desktop_ownership")[0]?.state).toBe("unknown");
      } finally {
        f.store.close();
      }
    });
    it("does not execute an unavailable or ambiguous single action", async () => {
      const f = fixture(adapter);
      f.planner.propose = async () => undefined;
      try {
        expect((await f.run()).outcome).toBe("failed");
        expect(f.counts().inputs).toBe(0);
      } finally {
        f.store.close();
      }
    });
  });

describe("adapter selection", () => {
  it("does not retry an unknown custom result through another runner or choose auto", async () => {
    let files = 0,
      desktops = 0;
    const file: ExecutionRunner = {
      capabilities: () => ({
        id: "files",
        host: "codex_app_server",
        available: true,
        version: "synthetic",
        nativeControl: "none",
        customControl: false,
        cancellation: "cooperative",
      }),
      async run() {
        files++;
        return { outcome: "succeeded", summary: "", unresolvedEffectIds: [] };
      },
    };
    const desktop: ExecutionRunner = {
      capabilities: () => ({
        ...file.capabilities(),
        id: "desktop",
        host: "bounded_desktop",
        customControl: true,
      }),
      async run() {
        desktops++;
        return {
          outcome: "unknown",
          summary: "",
          unresolvedEffectIds: ["original-action"],
        };
      },
    };
    const f = fixture();
    const router = new RoutedExecutionRunner(file, desktop);
    try {
      expect(
        (await router.run(f.request, () => {}, new AbortController().signal))
          .outcome,
      ).toBe("unknown");
      expect(files).toBe(0);
      expect(desktops).toBe(1);
      f.request.intent.preference = "auto";
      expect(
        (await router.run(f.request, () => {}, new AbortController().signal))
          .outcome,
      ).toBe("failed");
      expect(desktops).toBe(1);
    } finally {
      f.store.close();
    }
  });
});

// These examples match gateway.validate_lease/validate_action and the helper receipt wire.
describe("text desktop media wire", () => {
  it("maps scoped lease and flat action fields and validates actual receipt identities", async () => {
    const requests: Array<{ path: string; body: any }> = [];
    const port = new MediaTextDevicePort(
      "http://127.0.0.1:3330",
      "x".repeat(32),
      (async (url, init) => {
        const path = new URL(String(url)).pathname,
          body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ path, body });
        return new Response(
          JSON.stringify(
            path === "/text-leases"
              ? { id: "lease", state: "active" }
              : { id: "action", leaseId: "lease", state: "submitted" },
          ),
        );
      }) as typeof fetch,
    );
    const lease: TextLease = {
      leaseId: "lease",
      deviceId: "device",
      memberId: "member",
      displayId: 1,
      protocolVersion: 3,
      sessionId: "session",
      executor: "clawdtime",
      executorEpoch: 4,
      policyRevision: 2,
      mode: "control",
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
      authority: {
        kind: "text_session",
        grantId: "grant",
        projectId: "/fixture",
      },
    };
    await port.acquire(lease);
    await port.input(
      lease,
      { id: "frame", capturedAt: Date.now(), width: 640, height: 480 },
      { kind: "type", text: "blue" },
      "action",
    );
    expect(requests[0]?.body).toMatchObject({
      id: "lease",
      protocolVersion: 3,
    });
    expect(requests[0]?.body).not.toHaveProperty("leaseId");
    expect(requests[0]?.body).not.toHaveProperty("callId");
    expect(requests[1]?.body).toEqual({
      id: "action",
      frameId: "frame",
      type: "type",
      text: "blue",
      sessionId: "session",
      executorEpoch: 4,
      policyRevision: 2,
    });
  });
});
