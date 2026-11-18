import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IndependentTaskSession, Pairing } from "../src/contracts.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { createTaskApp } from "../src/control/task-app.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function fixture(simulation = false) {
  const directory = mkdtempSync(join(tmpdir(), "clawdtime-task-authority-"));
  const projectRoot = realpathSync(directory);
  const otherRoot = join(projectRoot, "other");
  mkdirSync(otherRoot);
  const store = new Store();
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const vault = new Vault("ab".repeat(32));
  let now = 100_000;
  const pair: Pairing = {
    id: "pair",
    memberId: "member",
    deviceId: "mac",
    recipient: "fixture",
    conversationId: "fixture",
    lineId: "fixture",
    displayId: "none",
    allowView: false,
    allowControl: false,
    createdAt: now,
  };
  store.put("pairing", pair);
  const ledger = new TaskLedger(store, vault, () => now);
  const service = new TaskService(store, vault, ledger, {
    projectRoots: [projectRoot],
    simulation,
    clock: () => now,
  });
  const operator = "synthetic-operator-" + "x".repeat(32);
  const app = createTaskApp(service, operator);
  const request = (
    path: string,
    body?: unknown,
    token = operator,
    extraHeaders: Record<string, string> = {},
  ) =>
    app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const registration = {
    eventId: "register-one",
    pairingId: pair.id,
    hostId: "host",
    projectRoot,
    voice: true,
  };
  const register = (eventId = "register-one") =>
    service.register({ ...registration, eventId });
  return {
    store,
    vault,
    ledger,
    service,
    app,
    request,
    registration,
    register,
    pair,
    operator,
    projectRoot,
    otherRoot,
    advance: (amount: number) => {
      now += amount;
    },
  };
}

describe("independent task authority for future voice sessions", () => {
  it("requires operator admission and does not turn task credentials into operator credentials", async () => {
    const f = fixture();
    expect((await f.request("/sessions", f.registration, "wrong")).status).toBe(
      401,
    );
    const first = f.register();
    expect(
      (
        await f.request(
          "/sessions",
          { ...f.registration, eventId: "register-two" },
          first.token,
        )
      ).status,
    ).toBe(401);
    expect(first.session.permissions).toEqual({
      execute: true,
      voice: true,
      presentation: false,
      control: false,
    });
    expect(f.store.effects()).toHaveLength(0);
  });

  it("rejects unknown pairings, unselected projects and capability injection", async () => {
    const f = fixture();
    for (const body of [
      { ...f.registration, pairingId: "other" },
      { ...f.registration, projectRoot: f.otherRoot },
    ])
      expect((await f.request("/sessions", body)).status).toBe(403);
    expect(
      (
        await f.request("/sessions", {
          ...f.registration,
          permissions: { control: true },
        })
      ).status,
    ).toBe(400);
    expect(f.store.all("task-session")).toHaveLength(0);
  });

  it("isolates task reads and mutation across separate sessions on the same pairing", async () => {
    const f = fixture();
    const one = f.register(),
      two = f.register("register-two");
    const created = f.service.create(one.token, {
      eventId: "create",
      goal: "Synthetic task",
    }).task;
    expect(
      (await f.request(`/tasks/${created.id}`, undefined, "wrong")).status,
    ).toBe(401);
    expect(
      (await f.request(`/tasks/${created.id}`, undefined, two.token)).status,
    ).toBe(404);
    expect(
      (
        await f.request(
          `/tasks/${created.id}/commands`,
          { action: "cancel", eventId: "cancel", expectedRevision: 0 },
          two.token,
        )
      ).status,
    ).toBe(404);
    expect(f.ledger.get(one.session.id, created.id).state).toBe("queued");
  });

  it("checks pairing revocation again before reads, writes and registration replay", async () => {
    const f = fixture();
    const session = f.register();
    const task = f.service.create(session.token, {
      eventId: "create",
      goal: "Synthetic task",
    }).task;
    f.store.put("pairing", { ...f.pair, revokedAt: 100_001 });
    expect(
      (await f.request(`/tasks/${task.id}`, undefined, session.token)).status,
    ).toBe(403);
    expect(
      (
        await f.request(
          `/tasks/${task.id}/commands`,
          { action: "cancel", eventId: "cancel", expectedRevision: 0 },
          session.token,
        )
      ).status,
    ).toBe(403);
    expect((await f.request("/sessions", f.registration)).status).toBe(403);
    expect(f.ledger.get(session.session.id, task.id).state).toBe("queued");
  });

  it("checks immutable paired identity, independent-session revocation and expiry", async () => {
    const f = fixture();
    const first = f.register();
    f.store.put("pairing", { ...f.pair, memberId: "different-member" });
    expect(() => f.service.authenticate(first.token)).toThrow(
      "expired or revoked",
    );
    f.store.put("pairing", f.pair);
    const record = f.store.get<{ id: string; sealed: string }>(
      "task-session",
      first.session.id,
    )!;
    f.store.put("task-session", {
      ...record,
      sealed: f.vault.seal({
        ...first.session,
        revokedAt: 100_001,
      } satisfies IndependentTaskSession),
    });
    expect(() => f.service.authenticate(first.token)).toThrow(
      "expired or revoked",
    );
    const second = f.register("register-two");
    f.advance(24 * 60 * 60 * 1000);
    expect(() => f.service.authenticate(second.token)).toThrow(
      "expired or revoked",
    );
  });

  it("refuses browser origins and non-JSON mutations without consuming receipts", async () => {
    const f = fixture();
    expect(
      (
        await f.request("/sessions", f.registration, f.operator, {
          origin: "http://untrusted.invalid",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request("/sessions", f.registration, f.operator, {
          "content-type": "text/plain",
        })
      ).status,
    ).toBe(415);
    expect(f.store.all("task-session")).toHaveLength(0);
  });

  it("refuses forged worker, verification and call events outside explicit simulation", async () => {
    const f = fixture();
    const session = f.register();
    const task = f.service.create(session.token, {
      eventId: "create",
      goal: "Synthetic task",
    }).task;
    for (const action of [
      "claim_run",
      "run_result",
      "verify_result",
      "prepare_call",
      "call_state",
    ]) {
      const response = await f.request(
        `/tasks/${task.id}/commands`,
        { action, eventId: `forged-${action}`, expectedRevision: 0 },
        session.token,
      );
      expect(response.status).toBe(403);
    }
    expect(f.ledger.get(session.session.id, task.id)).toMatchObject({
      state: "queued",
      revision: 0,
    });
    expect(f.store.effects()).toHaveLength(0);
  });

  it("never admits a live call even with simulation credentials", async () => {
    const f = fixture(true);
    const session = f.register();
    const task = f.service.create(session.token, {
      eventId: "create",
      goal: "Synthetic task",
    }).task;
    expect(
      (
        await f.request(
          `/tasks/${task.id}/commands`,
          {
            action: "prepare_call",
            callId: "call",
            opening: "Synthetic decision",
            simulated: false,
            eventId: "live-call",
            expectedRevision: 0,
          },
          session.token,
        )
      ).status,
    ).toBe(403);
    expect(f.store.effects()).toHaveLength(0);
    expect(await (await f.request("/health")).json()).toMatchObject({
      mode: "simulation",
      liveDispatch: false,
      presentation: false,
      control: false,
    });
  });
});
