import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Hono } from "hono";
import jpeg from "jpeg-js";
import { Store } from "../src/storage/store.js";
import { Vault, hash } from "../src/storage/security.js";
import { ProactivePolicyAuthority } from "../src/attention/proactive-policy.js";
import { ProactiveCallCoordinator } from "../src/attention/proactive-coordinator.js";
import { ProactiveService } from "../src/control/proactive-service.js";
import {
  ProactiveLineSessions,
  mountProactiveLine,
} from "../src/control/proactive-line.js";
import { ProactiveReviewViews } from "../src/control/proactive-views.js";
import type {
  ProactiveReviewPacket,
  ProactiveSourceEvidence,
} from "../src/control/proactive-preparation.js";

const stores: Store[] = [],
  dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fingerprint = "ab".repeat(32),
  sourceFingerprint = "cd".repeat(32);
function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  const vault = new Vault("ef".repeat(32));
  let now = Date.now();
  const clock = () => now;
  const authority = new ProactivePolicyAuthority(store, vault, clock);
  const coordinator = new ProactiveCallCoordinator(
    store,
    vault,
    authority,
    clock,
  );
  const policy = authority.register({
    version: 2,
    id: "policy",
    scope: { personId: "person", deviceId: "device", projectRoot: "/fixture" },
    triggers: ["decision", "review", "completion"],
    channels: ["phone_alert", "phone_walkthrough"],
    expiresAt: now + 100000,
    maxAttempts: 5,
    minIntervalMs: 0,
    attemptLifetimeMs: 60000,
    viewScope: ["prepared-review"],
    alertFallback: false,
    consent: {
      actorId: "person",
      recordedAt: now,
      source: "operator",
      statement: "Call about this fixture.",
    },
  });
  const intent = coordinator.enqueue({
    source: {
      kind: "decision",
      sessionId: "session",
      runId: "run",
      decisionId: "decision",
    },
    scope: { ...policy.scope, sessionId: "session" },
    policyId: policy.id,
    trigger: "decision",
    channel: "phone_walkthrough",
    expiresAt: now + 90000,
    brief: "Which fixture?",
  }).record;
  const packet: ProactiveReviewPacket = {
    version: 1,
    id: "packet",
    intentId: intent.id,
    source: intent.source,
    sourceFingerprint,
    policyId: policy.id,
    policyRevision: 1,
    channel: "phone_walkthrough",
    goal: "Review fixture",
    status: "decision",
    summary: "Choose a color",
    question: "Blue or green?",
    choices: ["Blue", "Green"],
    checks: [],
    artifacts: [],
    narration: "Choose a fixture color.",
    views: [],
    walkthroughOrder: ["prepared-review"],
    createdAt: now,
    expiresAt: now + 30000,
    fingerprint,
  };
  const reserve = () => {
    coordinator.prepare(intent.id);
    coordinator.ready(intent.id, fingerprint);
    return coordinator.reserve(intent.id, {
      sourceCurrent: true,
      lineAvailable: true,
      packetFingerprint: fingerprint,
    });
  };
  return {
    authority,
    coordinator,
    policy,
    intent,
    packet,
    reserve,
    clock,
    time: (value: number) => (now = value),
  };
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

describe("proactive scheduler boundaries", () => {
  it("accepts a preparation service that already made the intent ready and reserves before dispatch", async () => {
    const f = fixture();
    let calls = 0;
    const service = new ProactiveService(f.coordinator, {
      sourceCurrent: () => true,
      preparation: {
        prepare: async (i) => {
          f.coordinator.ready(i.id, fingerprint);
          return { fingerprint };
        },
        current: async () => true,
      },
      delivery: {
        readiness: async () => ({ ready: true }),
        deliver: async (i, g) => {
          calls++;
          expect(f.coordinator.get(i.id)).toMatchObject({
            state: "dispatching",
            attemptId: g.attemptId,
          });
          return { state: "ended", cleanupConfirmed: true };
        },
      },
    });
    await service.pump();
    await service.pump();
    expect(calls).toBe(1);
    expect(f.coordinator.get(f.intent.id).state).toBe("ended");
  });
  it("releases prepared capture when an incoming call wins admission", async () => {
    const f = fixture();
    let ready = 0,
      cleaned = 0,
      calls = 0;
    const service = new ProactiveService(f.coordinator, {
      sourceCurrent: () => true,
      preparation: {
        prepare: async () => ({ fingerprint }),
        current: () => true,
        release: async () => {
          cleaned++;
          return { confirmed: true };
        },
      },
      delivery: {
        readiness: async () => ({ ready: ++ready === 1 }),
        deliver: async () => {
          calls++;
          return { state: "ended", cleanupConfirmed: true };
        },
      },
    });
    await service.pump();
    expect(calls).toBe(0);
    expect(cleaned).toBe(1);
    expect(f.coordinator.get(f.intent.id)).toMatchObject({
      state: "queued",
      reason: "waiting_for_line",
    });
  });
  it("Stop during preparation cancels dialing and keeps failed capture cleanup unknown", async () => {
    const f = fixture(),
      wait = deferred<{ fingerprint: string }>();
    let started = false,
      calls = 0;
    const service = new ProactiveService(f.coordinator, {
      sourceCurrent: () => true,
      preparation: {
        prepare: () => {
          started = true;
          return wait.promise;
        },
        current: () => true,
        release: async () => ({ confirmed: false }),
      },
      delivery: {
        readiness: async () => ({ ready: true }),
        deliver: async () => {
          calls++;
          return { state: "ended", cleanupConfirmed: true };
        },
      },
    });
    const pump = service.pump();
    while (!started) await Promise.resolve();
    await service.stop(f.intent.id);
    wait.resolve({ fingerprint });
    await pump;
    expect(calls).toBe(0);
    expect(f.coordinator.get(f.intent.id)).toMatchObject({
      state: "unknown",
      reason: "capture_cleanup_unknown",
    });
  });
  it("revocation during asynchronous preparation never reaches a dial", async () => {
    const f = fixture();
    let cleaned = 0;
    const service = new ProactiveService(f.coordinator, {
      sourceCurrent: () => true,
      preparation: {
        prepare: async () => {
          f.authority.revoke("policy");
          return { fingerprint };
        },
        current: () => true,
        release: async () => {
          cleaned++;
          return { confirmed: true };
        },
      },
      delivery: {
        readiness: async () => ({ ready: true }),
        deliver: async () => {
          throw Error("must never dial");
        },
      },
    });
    await service.pump();
    expect(f.coordinator.get(f.intent.id).state).toBe("canceled");
    expect(cleaned).toBe(1);
  });
  it("lost delivery response remains unknown and never redials", async () => {
    const f = fixture();
    let calls = 0;
    const service = new ProactiveService(f.coordinator, {
      sourceCurrent: () => true,
      preparation: {
        prepare: async () => ({ fingerprint }),
        current: () => true,
      },
      delivery: {
        readiness: async () => ({ ready: true }),
        deliver: async () => {
          calls++;
          throw Error("lost");
        },
      },
    });
    await service.pump();
    await service.pump();
    expect(calls).toBe(1);
    expect(f.coordinator.get(f.intent.id).state).toBe("unknown");
  });
});

function lineFixture() {
  const f = fixture();
  const reserved = f.reserve();
  let current = true,
    answers = 0,
    stopped = 0;
  const line = new ProactiveLineSessions(
    f.authority,
    {
      sourceCurrent: () => current,
      answer: async () => {
        answers++;
        return "Applied to the exact pending request.";
      },
      stopSharing: async () => {
        stopped++;
        return { confirmed: true };
      },
      frame: async () => ({
        bytes: new Uint8Array(16),
        width: 2,
        height: 2,
        capturedAt: f.clock(),
        sourceFingerprint,
        claimsCurrent: current,
      }),
    },
    f.clock,
  );
  const capability = line.open(reserved.record, reserved.grant!, f.packet, {
    roomName: "fixture-room",
    agentIdentity: "fixture-agent",
  });
  const { token, version: _v, expiresAt: _e, ...binding } = capability;
  const command = (action: string, extra: object = {}) =>
    line.command(binding.attemptId, token, { action, binding, ...extra });
  const prepare = async () => {
    line.bindCaller(binding.attemptId, "paired-human");
    await command("prepared", {
      media: { audioReady: true, videoReady: true },
    });
  };
  return {
    ...f,
    line,
    capability,
    binding,
    token,
    command,
    prepare,
    current: (v: boolean) => (current = v),
    counts: () => ({ answers, stopped }),
  };
}
describe("prepared handset runtime", () => {
  it("rejects wrong caller and deduplicates an exact speech turn", async () => {
    const f = lineFixture();
    await f.prepare();
    await expect(
      f.command("answer", {
        turnId: "turn",
        text: "Blue",
        callerIdentity: "other",
      }),
    ).rejects.toThrow("caller");
    await Promise.all([
      f.command("answer", {
        turnId: "turn",
        text: "Blue",
        callerIdentity: "paired-human",
      }),
      f.command("answer", {
        turnId: "turn",
        text: "Blue",
        callerIdentity: "paired-human",
      }),
    ]);
    expect(f.counts().answers).toBe(1);
    await expect(
      f.command("answer", {
        turnId: "turn",
        text: "Green",
        callerIdentity: "paired-human",
      }),
    ).rejects.toThrow("conflicts");
  });
  it("returns bounded exact frame metadata understood by the phone client", async () => {
    const f = lineFixture();
    await f.prepare();
    const app = new Hono();
    mountProactiveLine(app, f.line);
    const b = f.binding;
    const response = await app.request(`/proactive/line/${b.attemptId}/frame`, {
      headers: {
        authorization: `Bearer ${f.token}`,
        "X-ClawdTime-Attempt": b.attemptId,
        "X-ClawdTime-Room": b.roomName,
        "X-ClawdTime-Agent": b.agentIdentity,
        "X-ClawdTime-Source": b.sourceFingerprint,
        "X-ClawdTime-Packet": b.packetFingerprint,
      },
    });
    expect(response.status).toBe(200);
    const metadata = JSON.parse(response.headers.get("x-clawdtime-frame")!);
    expect(metadata).toMatchObject({
      attemptId: b.attemptId,
      sourceFingerprint,
      packetFingerprint: fingerprint,
      viewId: "prepared-review",
      width: 2,
      height: 2,
    });
    expect(metadata.expiresAt - metadata.capturedAt).toBeLessThanOrEqual(1000);
    expect((await response.arrayBuffer()).byteLength).toBe(16);
  });
  it("invalidates result claims while retaining a safe app-owned view; Stop sharing is sticky", async () => {
    const f = lineFixture();
    await f.prepare();
    f.current(false);
    expect(await f.command("status")).toMatchObject({
      sharingAllowed: true,
      narration: expect.stringContaining("no longer current"),
    });
    expect(
      await f.line.frame(f.binding.attemptId, f.token, f.binding),
    ).toMatchObject({ claimsCurrent: false });
    f.current(true);
    await f.command("stop_sharing");
    await f.command("prepared", {
      media: { audioReady: true, videoReady: true },
    });
    await expect(
      f.line.frame(f.binding.attemptId, f.token, f.binding),
    ).rejects.toThrow("not authorized");
    expect(f.counts().stopped).toBe(1);
  });
  it("allows cleanup after revocation but requires provider termination before releasing the owner", async () => {
    const f = lineFixture();
    await f.prepare();
    f.authority.revoke("policy");
    await expect(f.command("status")).rejects.toThrow("authority ended");
    await f.command("close");
    expect(() => f.line.release(f.binding.attemptId, false)).toThrow(
      "termination",
    );
    f.line.release(f.binding.attemptId, true);
    expect(f.line.status(f.binding.attemptId)).toBeNull();
  });
});

function viewFixture() {
  const f = fixture(),
    directory = mkdtempSync(join(tmpdir(), "clawdtime-proactive-views-"));
  dirs.push(directory);
  const renderer = join(directory, "renderer"),
    capture = join(directory, "capture");
  const encoded = jpeg
    .encode({ width: 2, height: 2, data: Buffer.alloc(16, 255) }, 85)
    .data.toString("base64");
  writeFileSync(
    renderer,
    `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const config=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));fs.writeFileSync(path.join(path.dirname(process.argv[3]),'renderer-pid'),String(process.pid));process.stdout.write(JSON.stringify({ready:true,appId:'com.example.Prepared',title:config.title})+'\\n');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);process.stdout.write(JSON.stringify({id:request.id,invalidated:true})+'\\n');});setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  writeFileSync(
    capture,
    `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),readline=require('node:readline');const config=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));const hash=v=>crypto.createHash('sha256').update(v).digest('hex');if(process.argv[2]==='--resolve-target'){console.log(JSON.stringify({target:{appId:config.appId,windowId:'101',ownerPid:Number(fs.readFileSync(path.join(path.dirname(process.argv[3]),'renderer-pid'),'utf8')),processIdentity:'${"ab".repeat(32)}',displayId:1,titleHash:hash(config.title)}}));}else{const bytes=Buffer.from('${encoded}','base64');readline.createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);process.stdout.write(JSON.stringify({id:req.id,ok:true,target:req.target,bytes:bytes.length,width:2,height:2,capturedAt:Date.now(),contentRevision:hash(bytes)})+'\\n');process.stdout.write(bytes);});}`,
    { mode: 0o700 },
  );
  const evidence: ProactiveSourceEvidence = {
    current: true,
    sourceFingerprint,
    goal: "Synthetic review",
    status: "decision",
    summary: "Choose fixture",
    checks: [],
    artifacts: [],
    views: [
      { id: "prepared-review", scope: "prepared-review", title: "Fixture" },
    ],
  };
  return { ...f, directory, renderer, capture, evidence };
}
describe("exact-window view ownership", () => {
  it("validates the native JPEG hash, holds ownership through capture, and confirms every child before release", async () => {
    const f = viewFixture();
    const views = new ProactiveReviewViews(
      {
        rendererBinary: f.renderer,
        captureBinary: f.capture,
        directory: f.directory,
      },
      { assertIdle() {}, authorize() {}, evidence: async () => f.evidence },
    );
    try {
      const prepared = await views.prepare({
        intent: f.intent,
        policy: f.policy,
        sourceFingerprint,
      });
      expect(prepared[0]?.windowId).toBe("101");
      expect(views.occupied).toBe(true);
      const frame = await views.frame(f.intent);
      expect(frame?.bytes.length).toBe(16);
      f.evidence.current = false;
      expect(await views.frame(f.intent)).toMatchObject({
        claimsCurrent: false,
      });
      f.evidence.current = true;
      expect(await views.frame(f.intent)).toMatchObject({
        claimsCurrent: false,
      });
      expect(existsSync(join(f.directory, "ownership.json"))).toBe(true);
      expect((await views.release(f.intent.id)).confirmed).toBe(true);
      expect(views.occupied).toBe(false);
      expect(existsSync(join(f.directory, "ownership.json"))).toBe(false);
    } finally {
      await views.release(f.intent.id);
    }
  });
  it("reserves ownership before asynchronous source inspection and prevents spawn after Stop", async () => {
    const f = viewFixture(),
      wait = deferred<ProactiveSourceEvidence>();
    const views = new ProactiveReviewViews(
      {
        rendererBinary: f.renderer,
        captureBinary: f.capture,
        directory: f.directory,
      },
      { assertIdle() {}, authorize() {}, evidence: () => wait.promise },
    );
    const first = views.prepare({
      intent: f.intent,
      policy: f.policy,
      sourceFingerprint,
    });
    await expect(
      views.prepare({ intent: f.intent, policy: f.policy, sourceFingerprint }),
    ).rejects.toThrow("busy");
    expect((await views.release(f.intent.id)).confirmed).toBe(true);
    wait.resolve(f.evidence);
    await expect(first).rejects.toThrow("stopped");
    expect(readdirSync(f.directory).sort()).toEqual(["capture", "renderer"]);
  });
  it("retains interrupted child ownership across restart without deleting the receipt", async () => {
    const f = viewFixture();
    writeFileSync(
      join(f.directory, "ownership.json"),
      JSON.stringify({
        version: 1,
        intentId: f.intent.id,
        state: "preparing_or_active",
      }),
      { mode: 0o600 },
    );
    const views = new ProactiveReviewViews(
      {
        rendererBinary: f.renderer,
        captureBinary: f.capture,
        directory: f.directory,
      },
      { assertIdle() {}, authorize() {}, evidence: async () => f.evidence },
    );
    expect(views.occupied).toBe(true);
    await expect(
      views.prepare({ intent: f.intent, policy: f.policy, sourceFingerprint }),
    ).rejects.toThrow("busy");
    expect((await views.release(f.intent.id)).confirmed).toBe(false);
    expect(existsSync(join(f.directory, "ownership.json"))).toBe(true);
  });
});
