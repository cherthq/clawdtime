import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SetupService } from "../src/pairing/setup.js";
import {
  legacySetupInvitation,
  retireSetupInvitation,
} from "../src/pairing/retired-setup.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { hash } from "../src/storage/security.js";
import type { AgentSession, SetupTest, Transport } from "../src/contracts.js";
import {
  canonicalProject,
  secureRead,
  secureWrite,
  type Connection,
} from "../connectors/shared/state.js";
import { startSetupSession } from "../connectors/shared/setup-session.js";
import { retryExistingSetup } from "../cli/setup-retry.js";

async function fixture() {
  const project = canonicalProject(
    mkdtempSync(join(tmpdir(), "clawdtime-retry-fixture-")),
  );
  const connection = join(project, "private", "connection.json");
  const store = new Store(),
    synthetic = new SimulationTransport();
  // Mode exercises live guards, while every transport operation is an in-memory fake.
  const transport: Transport = {
    mode: "live",
    call: (...args) => synthetic.call(...args),
    endCall: (...args) => synthetic.endCall(...args),
    message: (...args) => synthetic.message(...args),
  };
  // The original pairing/session predates the retained expired invitation.
  let now: number | undefined = Date.now() - 700_000;
  const service = new ClawdTime(store, transport, {
      clock: () => now ?? Date.now(),
    }),
    setup = new SetupService(service);
  const binding = {
    memberId: "synthetic-member",
    recipient: "+15550000002",
    conversationId: "iMessage;-;+15550000002",
    lineId: "fixture-line",
    deviceId: "fixture-mac",
    displayId: "1",
  };
  const invited = service.createPairingInvite(binding);
  const grant = service.claimPairing({
    token: invited.token,
    deviceId: binding.deviceId,
    displayId: binding.displayId,
    allowView: true,
    allowControl: true,
  });
  const nativeBinding = {
    lineId: binding.lineId,
    providerLineId: "synthetic-provider",
    phone: "+15550000001",
    instanceId: "synthetic-instance",
    fingerprint: "synthetic-binding",
  };
  store.saveState("native-binding-fingerprint", nativeBinding.fingerprint);
  const freshness = () => {
    store.saveState("native-preflight", {
      checkedAt: Date.now(),
      mode: "live",
      liveReady: true,
      bindingFingerprint: nativeBinding.fingerprint,
      checks: [
        {
          id: "synthetic_transport",
          status: "pass",
          message: "Synthetic unit-test evidence only",
        },
      ],
    });
    store.saveState(`device-readiness:${grant.pairing.id}`, {
      checkedAt: Date.now(),
      deviceId: binding.deviceId,
      memberId: binding.memberId,
      displayId: "1",
      bindingFingerprint: nativeBinding.fingerprint,
      checks: [
        {
          id: "synthetic_device",
          status: "pass",
          message: "Synthetic unit-test evidence only",
        },
      ],
    });
  };
  freshness();
  const app = new Hono(),
    calls: string[] = [];
  const token = (c: any) => c.req.header("authorization").slice(7);
  app.use("*", async (c, next) => {
    calls.push(`${c.req.method} ${c.req.path}`);
    await next();
  });
  app.onError((_error, c) =>
    c.json({ error: "Synthetic backend rejection" }, 409),
  );
  app.post("/api/sessions", async (c) => {
    const registered = service.registerSession(token(c), await c.req.json());
    now = undefined;
    registered.session = store.put("session", {
      ...registered.session,
      lastSeenAt: Date.now(),
    });
    return c.json(registered);
  });
  app.post("/api/sessions/heartbeat", (c) => {
    now = undefined;
    return c.json({ session: service.heartbeat(token(c)) });
  });
  app.get("/api/doctor", (c) => {
    freshness();
    return c.json(service.doctor(token(c)));
  });
  app.get("/api/setup/test", (c) => c.json(setup.get(token(c))));
  app.post("/api/setup/test", (c) => c.json(setup.invite(token(c))));
  app.post("/api/setup/test/retry", async (c) =>
    c.json(setup.retry(token(c), (await c.req.json()).previousTestId)),
  );
  app.post("/api/sessions/yield", (c) =>
    c.json({ session: service.yieldSession(token(c)) }),
  );
  app.post("/api/setup/test/authorize", async (c) => {
    const body = await c.req.json();
    return c.json(
      setup.authorize(token(c), body.testId, body.userAuthorizedCall),
    );
  });
  app.post("/api/setup/test/start", async (c) => {
    const value = setup.start(token(c));
    await service.drain();
    return c.json(value);
  });
  app.post("/api/setup/test/cancel", (c) => c.json(setup.cancel(token(c))));
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((done) => server.on("listening", done));
  const address = server.address() as { port: number };
  secureWrite(connection, {
    schemaVersion: 1,
    baseUrl: `http://127.0.0.1:${address.port}`,
    ...grant,
    adapter: "codex",
    adapterVersion: "synthetic",
    projectRoot: project,
    hostId: binding.deviceId,
  } satisfies Connection);
  const seedLegacy = (sessionId: string) => {
    const createdAt = Date.now() - 601_000;
    const test: SetupTest = {
      id: "setup_legacy_fixture",
      sessionId,
      pairingId: grant.pairing.id,
      createdAt,
      expiresAt: createdAt + 600_000,
      state: "expired",
      invitationEffectId: "setup_legacy_fixture:invite",
    };
    store.put("setup_test", test);
    store.putEffect({
      id: test.invitationEffectId,
      kind: "message",
      state: "unknown",
      createdAt,
      payload: {
        pairingId: grant.pairing.id,
        setupTestId: test.id,
        text: legacySetupInvitation,
      },
    });
    store.saveState(`messages:${binding.lineId}`, {
      sequence: 7,
      eventId: "synthetic-cursor",
    });
    return test;
  };
  const retire = (test: SetupTest) =>
    retireSetupInvitation(store, nativeBinding, {
      testId: test.id,
      effectId: test.invitationEffectId,
      pairingId: test.pairingId,
      evidenceReference: `sha256:${"a".repeat(64)}`,
      acknowledgeUnknown: true,
      receipt: {
        origin: `text_${hash(test.invitationEffectId).slice(0, 32)}`,
        fingerprint: hash(
          JSON.stringify([
            "chert-text-once-v1",
            nativeBinding.phone,
            binding.recipient,
            legacySetupInvitation,
          ]).replaceAll("/", "\\/"),
        ),
        preparedGuid: "11111111-2222-4333-8444-555555555555",
        state: "attempted",
        found: true,
      },
    });
  const approve = (test: SetupTest, text = `YES ${test.approvalCode}`) =>
    setup.receive({
      id: randomUUID(),
      sender: binding.recipient,
      conversationId: binding.conversationId,
      lineId: binding.lineId,
      text,
    });
  return {
    project,
    connection,
    store,
    service,
    setup,
    synthetic,
    calls,
    seedLegacy,
    retire,
    approve,
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
      rmSync(project, { recursive: true, force: true });
    },
  };
}

function channel(input: NodeJS.WritableStream, output: NodeJS.ReadableStream) {
  const messages: any[] = [];
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += String(chunk);
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      messages.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const ready = async () => {
    await vi.waitFor(
      () =>
        expect(messages.some((value) => value.event === "ready")).toBe(true),
      { timeout: 5000, interval: 10 },
    );
    return messages.find((value) => value.event === "ready");
  };
  const send = async (
    id: string,
    command: string,
    args?: Record<string, unknown>,
  ) => {
    const count = messages.filter((value) => value.id === id).length;
    input.write(`${JSON.stringify({ id, command, args })}\n`);
    await vi.waitFor(
      () =>
        expect(
          messages.filter((value) => value.id === id).length,
        ).toBeGreaterThan(count),
      { timeout: 5000, interval: 10 },
    );
    return messages.filter((value) => value.id === id).at(-1);
  };
  return { ready, send };
}

it("adds explicit guarded bridge retry in the same session and preserves unknown predecessor", async () => {
  const f = await fixture(),
    input = new PassThrough(),
    output = new PassThrough(),
    runId = randomUUID();
  const ch = channel(input, output);
  const done = startSetupSession({
    connection: f.connection,
    project: f.project,
    adapter: "codex",
    runId,
    input,
    output,
  });
  try {
    const ready = await ch.ready(),
      previous = f.seedLegacy(ready.sessionId);
    await ch.send("status", "status");
    expect(
      (await ch.send("retry-no-auth", "retry", { previousTestId: previous.id }))
        .ok,
    ).toBe(false);
    const args = {
      previousTestId: previous.id,
      authorizeNewInvitation: true,
      operatorRetirementConfirmed: true,
    };
    expect((await ch.send("retry", "retry", args)).ok).toBe(false); // immutable retirement proof missing
    expect(
      f.calls.filter((value) => value === "POST /api/setup/test/retry"),
    ).toHaveLength(0); // readiness refuses unknown first
    f.retire(previous);
    const retried = await ch.send("retry", "retry", args);
    expect(retried.ok).toBe(true);
    expect(retried.result.test.sessionId).toBe(ready.sessionId);
    expect(retried.result.test.previousTestId).toBe(previous.id);
    expect((await ch.send("retry", "retry", args)).replayed).toBe(true);
    expect(
      f.calls.filter((value) => value === "POST /api/setup/test/retry"),
    ).toHaveLength(1);
    expect(f.store.effect(previous.invitationEffectId)?.state).toBe("unknown");
    expect(f.synthetic.calls).toHaveLength(0);
    await f.service.drain();
    expect(f.approve(retried.result.test, "YES")).toBe(false);
    expect(f.approve(retried.result.test, "YES FFFFFFFF")).toBe(false);
    expect(f.approve(retried.result.test)).toBe(false);
    expect(
      (
        await ch.send("authorize", "authorize", {
          testId: retried.result.test.id,
          userAuthorizedCall: true,
        })
      ).result.test.state,
    ).toBe("approved");
    expect(f.store.all("session")).toHaveLength(1);
  } finally {
    input.end();
    await done;
    await f.close();
  }
});

it("refuses a mismatched retry response without rebinding or resending the unknown operation", async () => {
  const f = await fixture(),
    input = new PassThrough(),
    output = new PassThrough(),
    runId = randomUUID();
  const ch = channel(input, output);
  const request: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith("/api/setup/test/retry") && response.ok) {
      const value = (await response.json()) as { test: SetupTest };
      return new Response(
        JSON.stringify({
          test: { ...value.test, sessionId: "foreign-session" },
        }),
        { status: 200 },
      );
    }
    return response;
  };
  const done = startSetupSession({
    connection: f.connection,
    project: f.project,
    adapter: "codex",
    runId,
    input,
    output,
    request,
  });
  try {
    const ready = await ch.ready(),
      previous = f.seedLegacy(ready.sessionId);
    await ch.send("status", "status");
    f.retire(previous);
    const args = {
      previousTestId: previous.id,
      authorizeNewInvitation: true,
      operatorRetirementConfirmed: true,
    };
    expect((await ch.send("retry", "retry", args)).ok).toBe(false);
    const checkpoint = secureRead<any>(
      join(dirname(f.connection), "runs", `${runId}.setup.json`),
    );
    expect(checkpoint.test.id).toBe(previous.id);
    expect(checkpoint.effects.retry.result).toBeUndefined();
    expect((await ch.send("retry", "retry", args)).error).toContain(
      "outcome is unknown",
    );
    expect((await ch.send("replacement-id", "retry", args)).ok).toBe(false);
    expect(
      f.calls.filter((value) => value === "POST /api/setup/test/retry"),
    ).toHaveLength(1);
    const reconciled = await ch.send("status-after", "status");
    expect(reconciled.result.test.previousTestId).toBe(previous.id);
    expect(reconciled.result.test.sessionId).toBe(ready.sessionId);
    expect(f.synthetic.calls).toHaveLength(0);
  } finally {
    input.end();
    await done;
    await f.close();
  }
});

it("one-shot recovery leaves the frozen f57798c bridge alive and its old status/start learns the new binding", async () => {
  const f = await fixture(),
    runId = randomUUID();
  // Freeze the implementation actually available before retry existed. Only imports point
  // at unchanged local dependency APIs; this is not the new bridge under another label.
  let frozen = execFileSync(
    "git",
    ["show", "f57798c:connectors/shared/setup-session.ts"],
    { cwd: resolve("."), encoding: "utf8" },
  );
  expect(frozen).not.toContain('case "retry"');
  frozen = frozen.replace(
    /from "\.\/(.+?)\.js"/g,
    (_whole, name) =>
      `from ${JSON.stringify(pathToFileURL(resolve(`connectors/shared/${name}.ts`)).href)}`,
  );
  const snapshot = join(f.project, "old-bridge.ts"),
    runner = join(f.project, "runner.ts");
  writeFileSync(snapshot, frozen);
  writeFileSync(
    runner,
    `import { startSetupSession } from "./old-bridge.ts";\nvoid startSetupSession({connection:${JSON.stringify(f.connection)},project:${JSON.stringify(f.project)},adapter:"codex",runId:${JSON.stringify(runId)}}).catch(()=>{process.exitCode=1});\n`,
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      resolve("node_modules/tsx/dist/loader.mjs"),
      runner,
      "setup-session",
      "--run-id",
      runId,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = new Promise<void>((done) => child.once("exit", () => done()));
  const ch = channel(child.stdin, child.stdout);
  const options = {
    connection: f.connection,
    project: f.project,
    adapter: "codex" as const,
    runId,
    previousTestId: "setup_legacy_fixture",
    authorizeNewInvitation: true,
  };
  try {
    const ready = await ch.ready(),
      previous = f.seedLegacy(ready.sessionId);
    await ch.send("old-status", "status");
    const checkpointPath = join(
      dirname(f.connection),
      "runs",
      `${runId}.setup.json`,
    );
    const runPath = join(dirname(f.connection), "runs", `${runId}.json`);
    const checkpoint = readFileSync(checkpointPath, "utf8"),
      run = readFileSync(runPath, "utf8");
    f.retire(previous);
    await expect(
      retryExistingSetup({ ...options, authorizeNewInvitation: false }),
    ).rejects.toThrow("authorization");
    // Model a lost response after the one accepted retry: rerunning performs status
    // reconciliation only, never a second POST or another agent registration.
    const request: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith("/retry") && response.ok)
        throw new Error("synthetic lost response");
      return response;
    };
    await expect(retryExistingSetup({ ...options, request })).rejects.toThrow(
      "lost response",
    );
    const recovered = await retryExistingSetup(options);
    expect("reconciled" in recovered && recovered.reconciled).toBe(true);
    expect(recovered.test.sessionId).toBe(ready.sessionId);
    expect(recovered.invitationDelivery).toBe("unverified");
    expect(
      f.calls.filter((value) => value === "POST /api/setup/test/retry"),
    ).toHaveLength(1);
    expect(
      f.calls.filter((value) => value === "POST /api/sessions"),
    ).toHaveLength(1);
    expect(
      f.calls.filter((value) => value === "POST /api/sessions/heartbeat"),
    ).toHaveLength(1);
    expect(readFileSync(checkpointPath, "utf8")).toBe(checkpoint);
    expect(readFileSync(runPath, "utf8")).toBe(run);
    expect(child.exitCode).toBeNull();
    const learned = await ch.send("new-status", "status");
    expect(learned.result.test.id).toBe(recovered.test.id);
    expect(secureRead<any>(checkpointPath).test.id).toBe(recovered.test.id);
    expect((await ch.send("start", "start")).ok).toBe(false); // no scoped native-session authorization
    await f.service.drain();
    expect(f.approve(recovered.test, "YES")).toBe(false);
    expect(f.approve(recovered.test)).toBe(false);
    // Frozen old code cannot gain a new command through hot reload. This explicit
    // synthetic backend authorization only tests its existing status/start interoperability.
    const existingRun = secureRead<any>(runPath);
    expect(
      f.setup.authorize(existingRun.token, recovered.test.id, true).test.state,
    ).toBe("approved");
    await ch.send("yield", "yield", { backgroundActorsStopped: true });
    const started = await ch.send("start", "start");
    expect(started.ok).toBe(true);
    expect(started.result.test.id).toBe(recovered.test.id);
    expect(started.result.request.sessionId).toBe(ready.sessionId);
    expect(f.synthetic.calls).toHaveLength(1);
    expect(f.store.effect(previous.invitationEffectId)?.state).toBe("unknown");
    expect(f.store.state(`messages:fixture-line`)).toEqual({
      sequence: 7,
      eventId: "synthetic-cursor",
    });
    expect(f.store.all<AgentSession>("session")).toHaveLength(1);
    await ch.send("cancel", "cancel");
    child.stdin.end();
    await closed;
    await expect(retryExistingSetup(options)).rejects.toThrow();
  } finally {
    child.stdin.end();
    await closed;
    await f.close();
  }
}, 15_000);
