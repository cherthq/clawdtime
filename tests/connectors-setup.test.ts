import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { prepareSetup, readSetupLink } from "../cli/setup.js";
import {
  canonicalProject,
  secureRead,
  secureWrite,
} from "../connectors/shared/state.js";
import { startSetupSession } from "../connectors/shared/setup-session.js";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SetupService } from "../src/pairing/setup.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { installConfiguration, refreshOwnedSkill } from "../cli/install.js";
import { inspectInstallation } from "../cli/doctor.js";

const roots: string[] = [];
const root = () => {
  const value = canonicalProject(
    mkdtempSync(join(tmpdir(), "clawdtime-setup-")),
  );
  roots.push(value);
  return value;
};
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function claimFixture() {
  const project = root(),
    connectionFile = join(root(), "connection.json"),
    linkFile = join(root(), "link.txt");
  const origin = "https://setup.example.test";
  writeFileSync(
    linkFile,
    `${origin}/setup#token=synthetic-one-use&device=mac&display=1`,
    { mode: 0o600 },
  );
  const claim = {
    baseUrl: origin,
    pairing: {
      id: "paired",
      deviceId: "mac",
      displayId: "1",
      allowView: true,
      allowControl: true,
    },
    token: "synthetic-pairing-token",
  };
  const options = {
    project,
    adapter: "codex" as const,
    connectionFile,
    adapterVersion: "test",
    setupLinkFile: linkFile,
    origin,
    allowView: true,
    allowControl: true,
  };
  return { options, claim, linkFile };
}
it("validates private same-origin fragments and stores the claim before later setup work; reuses without claiming twice", async () => {
  const f = claimFixture();
  const request = vi.fn(
    async () => new Response(JSON.stringify(f.claim), { status: 200 }),
  ) as unknown as typeof fetch;
  const first = await prepareSetup({ ...f.options, request });
  expect(first.connection.token).toBe(f.claim.token);
  expect(statSync(first.claimFile).mode & 0o777).toBe(0o600);
  expect(
    secureRead<any>(join(dirname(f.options.connectionFile), "setup-claim.json"))
      .claim.token,
  ).toBe(f.claim.token);
  expect((await prepareSetup({ ...f.options, request })).reused).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
  expect(
    (
      await prepareSetup({
        ...f.options,
        setupLinkFile: undefined,
        existing: true,
        request,
      })
    ).reused,
  ).toBe(true);
  await expect(
    prepareSetup({
      ...f.options,
      setupLinkFile: undefined,
      existing: true,
      allowControl: false,
      request,
    }),
  ).rejects.toThrow("permissions differ");
  for (const link of [
    "https://elsewhere.example/setup#token=hidden&device=mac&display=1",
    `${f.options.origin}/setup?token=hidden#device=mac&display=1`,
    `${f.options.origin}/setup#token=hidden&token=second&device=mac&display=1`,
    "http://127.0.0.1/setup#token=hidden&device=mac&display=1",
  ]) {
    writeFileSync(f.linkFile, link);
    expect(() => readSetupLink(f.linkFile, f.options.origin)).toThrow();
  }
});
it("never retries an uncertain one-use claim or prints its private body", async () => {
  const f = claimFixture();
  const request = vi.fn(async () => {
    throw new Error("synthetic-secret-body");
  }) as unknown as typeof fetch;
  await expect(prepareSetup({ ...f.options, request })).rejects.toThrow(
    "saved intent",
  );
  await expect(prepareSetup({ ...f.options, request })).rejects.toThrow(
    "outcome is unknown",
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(
    readFileSync(
      join(dirname(f.options.connectionFile), "setup-claim.json"),
      "utf8",
    ),
  ).not.toContain("synthetic-one-use");
});

function backendFixture() {
  const project = root(),
    connection = join(root(), "connection.json");
  const store = new Store(),
    transport = new SimulationTransport(),
    service = new ClawdTime(store, transport),
    setup = new SetupService(service);
  const binding = {
    memberId: "member",
    recipient: "synthetic-recipient",
    conversationId: "synthetic-conversation",
    lineId: "line",
    deviceId: "mac",
    displayId: "1",
  };
  const invite = service.createPairingInvite(binding);
  const grant = service.claimPairing({
    token: invite.token,
    deviceId: "mac",
    displayId: "1",
    allowView: true,
    allowControl: true,
  });
  secureWrite(connection, {
    schemaVersion: 1,
    baseUrl: "https://fixture.example.test",
    ...grant,
    adapter: "codex",
    adapterVersion: "test",
    projectRoot: project,
    hostId: "fixture",
  });
  const app = new Hono();
  const token = (c: any) => c.req.header("authorization").slice(7);
  const calls: string[] = [];
  let blocked = false;
  app.use("*", async (c, next) => {
    calls.push(`${c.req.method} ${c.req.path}`);
    await next();
  });
  app.onError((_e, c) => c.json({ error: "synthetic rejection" }, 409));
  app.post("/api/sessions", async (c) =>
    c.json(service.registerSession(token(c), await c.req.json())),
  );
  app.post("/api/sessions/heartbeat", (c) =>
    c.json({ session: service.heartbeat(token(c)) }),
  );
  app.get("/api/doctor", (c) =>
    c.json(
      blocked
        ? { ...service.doctor(token(c)), mode: "live", readiness: undefined }
        : service.doctor(token(c)),
    ),
  );
  app.post("/api/sessions/yield", (c) =>
    c.json({ session: service.yieldSession(token(c)) }),
  );
  app.get("/api/setup/test", (c) => c.json(setup.get(token(c))));
  app.post("/api/setup/test", async (c) => {
    const result = setup.invite(token(c));
    await service.drain();
    return c.json(result);
  });
  app.post("/api/setup/test/start", async (c) => {
    const result = setup.start(token(c));
    await service.drain();
    return c.json(result);
  });
  app.post("/api/setup/test/cancel", (c) => c.json(setup.cancel(token(c))));
  app.post("/api/setup/test/verify", (c) => c.json(setup.verify(token(c))));
  app.get("/api/attention/:id/result", (c) =>
    c.json({
      ...service.result(token(c), c.req.param("id")),
      session: service.authenticateSession(token(c)),
    }),
  );
  app.post("/api/attention/:id/ack", async (c) =>
    c.json({
      response: service.ack(
        token(c),
        c.req.param("id"),
        (await c.req.json()).responseId,
      ),
    }),
  );
  app.post("/api/attention/:id/resume", async (c) =>
    c.json(
      service.resume(
        token(c),
        c.req.param("id"),
        (await c.req.json()).controlEpoch,
      ),
    ),
  );
  app.post("/api/attention/:id/complete", async (c) => {
    const result = {
      request: service.complete(
        token(c),
        c.req.param("id"),
        (await c.req.json()).text,
      ),
    };
    await service.drain();
    return c.json(result);
  });
  const request: typeof fetch = async (url, init) =>
    app.request(String(url), init);
  return {
    project,
    connection,
    store,
    transport,
    service,
    setup,
    binding,
    calls,
    request,
    block: (value: boolean) => {
      blocked = value;
    },
  };
}
function bridge(
  f: ReturnType<typeof backendFixture>,
  request = f.request,
  runId = randomUUID(),
) {
  const input = new PassThrough(),
    output = new PassThrough();
  let buffered = "";
  const messages: any[] = [];
  output.on("data", (chunk) => {
    buffered += String(chunk);
    while (buffered.includes("\n")) {
      const end = buffered.indexOf("\n");
      messages.push(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
    }
  });
  const done = startSetupSession({
    connection: f.connection,
    project: f.project,
    adapter: "codex",
    runId,
    input,
    output,
    request,
  });
  const wait = async (predicate: (value: any) => boolean) => {
    await vi.waitFor(() => expect(messages.some(predicate)).toBe(true), {
      timeout: 3000,
      interval: 5,
    });
    return messages.find(predicate);
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
      { timeout: 3000, interval: 5 },
    );
    return messages.filter((value) => value.id === id).at(-1);
  };
  return { input, done, messages, wait, send, runId };
}
it("keeps setup, approved call, result acknowledgement and continuation in the same foreground bridge", async () => {
  const f = backendFixture(),
    b = bridge(f);
  try {
    const ready = await b.wait((value) => value.event === "ready");
    expect(ready.currentChat).toBe(true);
    f.block(true);
    expect((await b.send("invite", "invite")).ok).toBe(false);
    expect(
      f.calls.filter((path) => path === "POST /api/setup/test"),
    ).toHaveLength(0);
    f.block(false);
    const invitation = await b.send("invite", "invite");
    expect(invitation.result.test.sessionId).toBe(ready.sessionId);
    expect((await b.send("invite", "invite")).replayed).toBe(true);
    expect(f.transport.messages).toHaveLength(1);
    expect((await b.send("start", "start")).ok).toBe(false);
    expect(f.transport.calls).toHaveLength(0);
    expect(
      f.setup.receive({
        id: "human-yes",
        sender: f.binding.recipient,
        conversationId: f.binding.conversationId,
        lineId: f.binding.lineId,
        text: "YES",
      }),
    ).toBe(true);
    expect((await b.send("yield-invalid", "yield")).ok).toBe(false);
    expect(
      (await b.send("yield", "yield", { backgroundActorsStopped: true })).ok,
    ).toBe(true);
    const started = await b.send("start", "start");
    expect(started.ok).toBe(true);
    const requestId = started.result.request.id;
    expect(f.transport.calls).toHaveLength(1);
    expect(
      (await b.send("pending", "result", { requestId, waitSeconds: 0 })).result
        .response,
    ).toBeUndefined();
    expect(
      (await b.send("wrong", "result", { requestId: "different" })).ok,
    ).toBe(false);
    const response = f.service.receiveResponse({
      eventId: "synthetic-human-feedback",
      requestId,
      memberId: f.binding.memberId,
      conversationId: f.binding.conversationId,
      lineId: f.binding.lineId,
      channel: "text",
      text: "Synthetic screen observed",
    });
    const result = await b.send("result", "result", {
      requestId,
      waitSeconds: 0,
    });
    expect(result.result.session.id).toBe(ready.sessionId);
    expect(
      (await b.send("ack", "ack", { requestId, responseId: response.id })).ok,
    ).toBe(true);
    expect(
      (
        await b.send("resume", "resume", {
          requestId,
          controlEpoch: result.result.session.controlEpoch,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await b.send("complete", "complete", {
          requestId,
          text: "Synthetic continuation complete",
        })
      ).ok,
    ).toBe(true);
    expect((await b.send("verify", "verify")).ok).toBe(false); // Simulations never establish physical acceptance.
    expect((await b.send("verify", "verify")).ok).toBe(false);
    expect(
      f.calls.filter((path) => path === "POST /api/setup/test/verify"),
    ).toHaveLength(2);
    expect(f.transport.messages).toHaveLength(2);
    expect(f.store.all("session")).toHaveLength(1);
    expect(
      f.calls.filter((path) => path === "POST /api/sessions"),
    ).toHaveLength(1);
    await b.send("cancel", "cancel");
    b.input.end();
    await b.done;
    expect(
      f.calls.filter((path) => path === "POST /api/setup/test/cancel"),
    ).toHaveLength(1);
    expect(
      secureRead<any>(
        join(dirname(f.connection), "runs", `${b.runId}.setup.json`),
      ).closedAt,
    ).toBeGreaterThan(0);
  } finally {
    b.input.end();
    await b.done;
    f.store.close();
  }
});

it("upgrades only unchanged owned skills and reports interrupted or edited installations", () => {
  const f = backendFixture();
  try {
    const connection = secureRead<any>(f.connection);
    const executable = join(f.project, "main.js");
    writeFileSync(executable, "// fixture");
    const installed = installConfiguration(
      connection,
      f.connection,
      executable,
      "old reviewed skill",
    );
    const updated = refreshOwnedSkill(
      installed,
      f.connection,
      "new reviewed skill",
    );
    expect(readFileSync(updated.installed!.skillPath, "utf8")).toBe(
      "new reviewed skill",
    );
    writeFileSync(updated.installed!.skillPath, "user edited skill");
    refreshOwnedSkill(updated, f.connection, "next reviewed skill");
    expect(readFileSync(updated.installed!.skillPath, "utf8")).toBe(
      "user edited skill",
    );
    expect(
      inspectInstallation(updated, "test").find(
        (c) => c.id === "skill_installation",
      )?.status,
    ).toBe("fail");
    rmSync(updated.installed!.configPath);
    expect(
      inspectInstallation(updated, "test").find(
        (c) => c.id === "mcp_configuration",
      )?.status,
    ).toBe("fail");
  } finally {
    f.store.close();
  }
});
it("stops heartbeat and cancels once on stdin EOF, with no surviving background bridge", async () => {
  const f = backendFixture(),
    b = bridge(f);
  try {
    await b.wait((value) => value.event === "ready");
    await b.send("invite", "invite");
    b.input.end();
    await b.done;
    expect(
      f.calls.filter((path) => path === "POST /api/setup/test/cancel"),
    ).toHaveLength(1);
    expect(f.store.all<any>("setup_test")[0].state).toBe("canceled");
    const count = f.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 5100));
    expect(f.calls.length).toBe(count);
  } finally {
    b.input.end();
    await b.done;
    f.store.close();
  }
}, 10_000);
it("does not retry unknown registration or unknown invitation under a changed command id", async () => {
  const f = backendFixture();
  let registrations = 0;
  const failRegister: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/api/sessions")) {
      registrations++;
      await f.request(url, init);
      throw new Error("uncertain registration");
    }
    return f.request(url, init);
  };
  const runId = randomUUID();
  const b = bridge(f, failRegister, runId);
  await expect(b.done).rejects.toThrow("uncertain registration");
  const b2 = bridge(f, failRegister, runId);
  await expect(b2.done).rejects.toThrow();
  expect(registrations).toBe(1);
  const failInvite: typeof fetch = async (url, init) => {
    const response = await f.request(url, init);
    if (String(url).endsWith("/api/setup/test") && init?.method === "POST")
      throw new Error("uncertain invitation");
    return response;
  };
  const b3 = bridge(f, failInvite);
  try {
    await b3.wait((value) => value.event === "ready");
    expect((await b3.send("invite", "invite")).ok).toBe(false);
    expect((await b3.send("invite", "invite")).error).toContain(
      "outcome is unknown",
    );
    expect(
      (await b3.send("different-id", "invite", { ignored: "changed" })).ok,
    ).toBe(false);
    expect(
      f.calls.filter((path) => path === "POST /api/setup/test"),
    ).toHaveLength(1);
    expect((await b3.send("status", "status")).result.test.state).toBe(
      "awaiting_approval",
    );
  } finally {
    b3.input.end();
    await b3.done;
    f.store.close();
  }
});
