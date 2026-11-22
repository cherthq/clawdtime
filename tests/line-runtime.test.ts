import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { TaskLedger } from "../src/attention/task-ledger.js";
import {
  LineRuntime,
  assertSeparateLineToken,
  sharedLineTokenText,
} from "../src/control/line-runtime.js";
import { createTaskApp } from "../src/control/task-app.js";
import { desktopConfigurationFingerprint } from "../src/control/task-desktop-config.js";
import { TaskService } from "../src/control/task-service.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import type { DesktopExecutionSnapshot } from "../src/control/desktop-executor.js";

const token = "l".repeat(40);
function fixture() {
  const store = new Store(),
    vault = new Vault("4".repeat(64));
  let now = 1000;
  let current: DesktopExecutionSnapshot = {
    configured: true,
    state: "idle",
    canStop: false,
    message: "Idle",
  };
  const runtime = {
    snapshot: (id?: string) =>
      !id || id === current.requestId
        ? current
        : { ...current, requestId: undefined },
    submit: vi.fn(async (id: string, _text: string) => {
      current = {
        configured: true,
        requestId: id,
        state: "running",
        canStop: true,
        message: "Running",
      };
      return { message: current.message };
    }),
    stop: vi.fn(
      () =>
        (current = {
          ...current,
          state: "canceled",
          canStop: false,
          message: "Stopped",
        }),
    ),
  };
  let bridge = new LineRuntime(store, vault, token, runtime, () => now);
  const command = (action: string, extra = {}, auth = token) =>
    bridge.command(auth, { action, callId: "fixture_call", ...extra });
  return {
    store,
    runtime,
    command,
    set: (v: DesktopExecutionSnapshot) => {
      current = v;
    },
    advance: () => {
      now += 30_001;
      bridge.expire();
    },
    restart: () => {
      bridge = new LineRuntime(store, vault, token, runtime, () => now);
    },
    app: () =>
      createTaskApp(
        {} as TaskService,
        "o".repeat(40),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        // The slot before the phone runtime is main's computer port.
        undefined,
        bridge,
      ),
  };
}
describe("phone computer runtime", () => {
  it("requires its own credential, an admitted call, and strict input", async () => {
    const f = fixture();
    await expect(f.command("open", {}, "wrong")).rejects.toThrow(
      "authorization",
    );
    await expect(
      f.command("execute", { requestId: "r1", text: "fixture" }),
    ).rejects.toThrow("admitted");
    await expect(f.command("open", { unknown: true })).rejects.toThrow();
    expect(f.runtime.submit).not.toHaveBeenCalled();
    f.store.close();
  });
  it("reserves exact requests and never replays duplicates or changed text", async () => {
    const f = fixture();
    await f.command("open");
    const request = { requestId: "r1", text: "fixture" };
    const first = await f.command("execute", request);
    expect(await f.command("execute", request)).toEqual(first);
    await expect(
      f.command("execute", { ...request, text: "changed" }),
    ).rejects.toThrow("conflicts");
    expect(f.runtime.submit).toHaveBeenCalledTimes(1);
    const db = f.store.all("line-runtime-request-v1");
    expect(JSON.stringify(db)).not.toContain("fixture");
    f.store.close();
  });
  it("stops only owned work at hangup, rejects commands and reopening", async () => {
    const f = fixture();
    await f.command("open");
    await f.command("execute", { requestId: "r1", text: "fixture" });
    expect((await f.command("close")).state).toBe("canceled");
    await f.command("close");
    expect(f.runtime.stop).toHaveBeenCalledTimes(1);
    await expect(f.command("open")).rejects.toThrow("ended");
    await expect(f.command("status")).rejects.toThrow("ended");
    f.store.close();
  });
  it("expires a lost call, does not restore authority after restart", async () => {
    const f = fixture();
    await f.command("open");
    await f.command("execute", { requestId: "r1", text: "fixture" });
    f.advance();
    expect(f.runtime.stop).toHaveBeenCalledTimes(1);
    f.restart();
    await expect(f.command("open")).rejects.toThrow("ended");
    expect(f.runtime.submit).toHaveBeenCalledTimes(1);
    f.store.close();
  });
  it("does not stop unrelated panel work or expose its result", async () => {
    const f = fixture();
    await f.command("open");
    f.set({
      configured: true,
      requestId: "panel_task",
      state: "running",
      canStop: true,
      message: "Private panel result",
    });
    expect(
      (await f.command("execute", { requestId: "r1", text: "fixture" })).state,
    ).toBe("blocked");
    expect((await f.command("status")).message).not.toContain("Private");
    await f.command("stop");
    await f.command("close");
    expect(f.runtime.submit).not.toHaveBeenCalled();
    expect(f.runtime.stop).not.toHaveBeenCalled();
    f.store.close();
  });
  it("retains an uncertain dispatch and never retries it", async () => {
    const f = fixture();
    await f.command("open");
    f.runtime.submit.mockRejectedValueOnce(new Error("lost response"));
    const request = { requestId: "r1", text: "fixture" };
    expect((await f.command("execute", request)).state).toBe("uncertain");
    expect((await f.command("execute", request)).state).toBe("uncertain");
    expect(f.runtime.submit).toHaveBeenCalledTimes(1);
    expect(
      (await f.command("execute", { requestId: "r2", text: "new fixture" }))
        .state,
    ).toBe("blocked");
    expect(f.runtime.submit).toHaveBeenCalledTimes(1);
    f.store.close();
  });
  it("returns uncertain over HTTP when a reserved dispatch throws", async () => {
    const f = fixture();
    await f.command("open");
    f.runtime.submit.mockRejectedValueOnce(new Error("unknown dispatch"));
    const response = await f.app().request("/line/command", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "execute",
        callId: "fixture_call",
        requestId: "r1",
        text: "fixture",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "uncertain",
      clientRequestId: "r1",
    });
    f.store.close();
  });
  it("allows only one call and protects HTTP route from browser origins", async () => {
    const f = fixture();
    await f.command("open");
    await expect(f.command("open", { callId: "other_call" })).rejects.toThrow(
      "Another call",
    );
    const app = f.app();
    const request = (auth: string, origin?: string) =>
      app.request("/line/command", {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth}`,
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ action: "status", callId: "fixture_call" }),
      });
    expect((await request("o".repeat(40))).status).toBe(401);
    expect((await request(token, "http://localhost")).status).toBe(403);
    expect((await request(token)).status).toBe(200);
    f.store.close();
  });
  it("checks the token of a command first: with none or a wrong one, the refusal is the same for every body, and no body is read", async () => {
    const f = fixture();
    await f.command("open");
    const app = f.app();
    /** A body that counts how often it is read. Nothing is read ahead. */
    const counted = (text: string) => {
      const state = { reads: 0 };
      const bytes = new TextEncoder().encode(text);
      let sent = false;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            state.reads++;
            if (sent) return controller.close();
            sent = true;
            controller.enqueue(bytes);
          },
        },
        { highWaterMark: 0 },
      );
      return { state, stream };
    };
    const good = JSON.stringify({ action: "status", callId: "fixture_call" });
    const bodies: {
      name: string;
      body: string;
      headers?: Record<string, string>;
    }[] = [
      { name: "a good command", body: good },
      { name: "text that is not JSON", body: "{ not json" },
      {
        name: "a command of another shape",
        body: JSON.stringify({ action: "unknown", more: true }),
      },
      {
        name: "a body that is not declared as JSON",
        body: good,
        headers: { "content-type": "text/plain" },
      },
      {
        name: "a body over the size limit",
        body: "x".repeat(40_000),
        headers: { "content-length": "40000" },
      },
      { name: "no body at all", body: "" },
    ];
    const credentials: { name: string; header?: string }[] = [
      { name: "no token" },
      { name: "a wrong token", header: `Bearer ${"o".repeat(40)}` },
      { name: "the token with one more character", header: `Bearer ${token}l` },
      { name: "the token under another scheme", header: `Basic ${token}` },
      { name: "an empty token", header: "Bearer " },
    ];
    for (const credential of credentials)
      for (const item of bodies) {
        const headers = {
          "content-type": "application/json",
          ...(item.headers ?? {}),
          ...(credential.header ? { authorization: credential.header } : {}),
        };
        const plain = await app.request("/line/command", {
          method: "POST",
          headers,
          ...(item.body ? { body: item.body } : {}),
        });
        const where = `${credential.name}, ${item.name}`;
        expect(plain.status, where).toBe(401);
        expect(await plain.json(), where).toEqual({
          error: "Line runtime authorization required.",
        });
        // The same body as a stream: it is never read.
        const { state, stream } = counted(item.body);
        const streamed = await app.request(
          new Request("http://localhost/line/command", {
            method: "POST",
            headers,
            body: stream,
            duplex: "half",
          } as RequestInit),
        );
        expect(streamed.status, where).toBe(401);
        expect(await streamed.json(), where).toEqual({
          error: "Line runtime authorization required.",
        });
        expect(state.reads, where).toBe(0);
      }
    // No refused request reached the runtime.
    expect(f.runtime.submit).not.toHaveBeenCalled();
    // With the token, the same stream is read and the command is answered.
    const { state, stream } = counted(good);
    const admitted = await app.request(
      new Request("http://localhost/line/command", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(admitted.status).toBe(200);
    expect(state.reads).toBeGreaterThan(0);
    // With the token, a body that is not JSON is still refused as before.
    const broken = await app.request("/line/command", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: "{ not json",
    });
    expect(broken.status).toBe(400);
    f.store.close();
  });
});

describe("the token of the phone runtime", () => {
  const line = "l".repeat(40);
  it("is refused when it is the same as another credential of the service", () => {
    for (const others of [
      [line],
      ["o".repeat(40), line],
      ["o".repeat(40), "p".repeat(40), line],
      [undefined, line, undefined],
    ])
      expect(() => assertSeparateLineToken(line, others)).toThrow(
        sharedLineTokenText,
      );
  });
  it("is accepted when it differs from each of them, also by one character or by its length", () => {
    for (const others of [
      [],
      [undefined, undefined],
      ["o".repeat(40), "p".repeat(40), "s".repeat(40)],
      [`${line}l`, line.slice(1), `${line.slice(0, 39)}L`],
    ])
      expect(() => assertSeparateLineToken(line, others)).not.toThrow();
  });
});

/**
 * The start of the real service script, with files that a test wrote in a new
 * private state folder. Every start here ends in a refusal before the service
 * listens, before the agent board starts and before any runtime takes a
 * request: nothing here reaches a screen, a helper or a driver.
 */
describe("the service and the files of the phone runtime", () => {
  const made: string[] = [];
  afterEach(() =>
    made
      .splice(0)
      .forEach((path) => rmSync(path, { recursive: true, force: true })),
  );
  const port = 39217;
  const key = "5".repeat(64);
  const operator = "operator-credential-".repeat(3);
  const panel = "panel-credential-".repeat(3);
  const lineToken = "line-credential-".repeat(3);
  /** A state folder and a project, with the operator credential that the test chose. */
  function folders(operatorToken = operator) {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "clawdtime-line-service-")),
    );
    made.push(root);
    const project = join(root, "project"),
      state = join(root, "state");
    mkdirSync(project, { mode: 0o700 });
    mkdirSync(state, { mode: 0o700 });
    const secret = (name: string, value: unknown) =>
      writeFileSync(join(state, name), JSON.stringify(value), { mode: 0o600 });
    secret("local-config.json", { key, operatorToken, projectRoot: project });
    const registrationId = "desktop_fixture_registration";
    /** The panel credential that the service will use, fixed before it starts. */
    const bindPanel = () =>
      secret("desktop-binding.json", {
        version: 1,
        desktopId: "desktop_fixture",
        configurationFingerprint: desktopConfigurationFingerprint({
          projectRoot: project,
          worker: "simulation",
          checksFingerprint: null,
          port,
        }),
        uiToken: panel,
        registrationId,
      });
    /**
     * The session credential that the service will use. The registration is
     * made here with the service's own classes and its receipt is kept in the
     * state folder, so the service finds the same one when it starts.
     */
    const registerSession = () => {
      bindPanel();
      const store = new Store(join(state, "tasks.sqlite"));
      try {
        store.put("pairing", {
          id: "local-demo-pairing",
          memberId: "local-demo-member",
          deviceId: "local-demo-device",
          recipient: "fixture",
          conversationId: "fixture",
          lineId: "fixture",
          displayId: "none",
          allowView: false,
          allowControl: false,
          createdAt: Date.now(),
        });
        const vault = new Vault(key);
        const service = new TaskService(
          store,
          vault,
          new TaskLedger(store, vault),
          { projectRoots: [project], simulation: true },
        );
        return service.register({
          eventId: registrationId,
          pairingId: "local-demo-pairing",
          hostId: "local-desktop",
          projectRoot: project,
          voice: false,
        }).token;
      } finally {
        store.close();
      }
    };
    const start = (
      extra: string[] = [],
      env: Record<string, string | undefined> = process.env,
    ) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("scripts/task-server.ts"),
          "--state",
          state,
          "--project",
          project,
          "--port",
          String(port),
          ...extra,
        ],
        { encoding: "utf8", timeout: 30_000, env },
      );
    return { state, project, secret, bindPanel, registerSession, start };
  }
  const desktop = ["--desktop", "true", "--agents", "false"];
  const needsRuntime =
    "Phone computer control requires the app-owned native runtime.";

  it(
    "does not start when the token of the phone runtime is the operator, panel or session token",
    { timeout: 120_000 },
    () => {
      // The operator token.
      const first = folders();
      first.secret("line-runtime.json", { version: 1, token: operator });
      const sameAsOperator = first.start(desktop);
      expect(sameAsOperator.status).toBe(1);
      expect(sameAsOperator.stderr).toContain(sharedLineTokenText);
      // The panel token.
      const second = folders();
      second.bindPanel();
      second.secret("line-runtime.json", { version: 1, token: panel });
      const sameAsPanel = second.start(desktop);
      expect(sameAsPanel.status).toBe(1);
      expect(sameAsPanel.stderr).toContain(sharedLineTokenText);
      // The session token.
      const third = folders();
      const session = third.registerSession();
      expect(session.length).toBeGreaterThanOrEqual(32);
      third.secret("line-runtime.json", { version: 1, token: session });
      const sameAsSession = third.start(desktop);
      expect(sameAsSession.status).toBe(1);
      expect(sameAsSession.stderr).toContain(sharedLineTokenText);
      // No refusal prints a credential.
      for (const result of [sameAsOperator, sameAsPanel, sameAsSession])
        for (const credential of [operator, panel, session]) {
          expect(result.stderr).not.toContain(credential);
          expect(result.stdout).not.toContain(credential);
        }
      // A token of its own passes this check. The start then ends at the
      // next one: this fixture has no runtime for the phone.
      const fourth = folders();
      fourth.registerSession();
      fourth.secret("line-runtime.json", { version: 1, token: lineToken });
      const separate = fourth.start(desktop);
      expect(separate.status).toBe(1);
      expect(separate.stderr).toContain(needsRuntime);
      expect(separate.stderr).not.toContain(sharedLineTokenText);
    },
  );
});
