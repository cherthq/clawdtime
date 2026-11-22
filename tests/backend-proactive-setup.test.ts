import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { TaskReviewService } from "../src/control/task-review-service.js";
import { createProactiveSetup } from "../src/control/proactive-setup.js";
import { createTaskApp } from "../src/control/task-app.js";
import type { TaskCommand } from "../src/contracts.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
function fixture(simulation = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "proactive-setup-")));
  const directory = join(base, "state"),
    projectRoot = join(base, "project");
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(projectRoot, { mode: 0o700 });
  const store = new Store(join(directory, "tasks.sqlite"));
  const vault = new Vault("a1".repeat(32));
  store.put("pairing", {
    id: "fixture",
    memberId: "person",
    deviceId: "device",
    recipient: "fixture",
    lineId: "fixture",
    conversationId: "fixture",
    displayId: "none",
    allowView: false,
    allowControl: false,
    createdAt: Date.now(),
  });
  const tasks = new TaskService(store, vault, new TaskLedger(store, vault), {
    projectRoots: [projectRoot],
    simulation,
  });
  const registered = tasks.register({
    eventId: "registration",
    pairingId: "fixture",
    hostId: "host",
    projectRoot,
    voice: false,
  });
  const reviews = new TaskReviewService(tasks, registered.token);
  cleanup.push(() => {
    reviews.close();
    store.close();
    rmSync(base, { recursive: true, force: true });
  });
  const policy = {
    version: 2 as const,
    id: "explicit-project-policy",
    scope: { personId: "person", deviceId: "device", projectRoot },
    triggers: ["completion" as const, "decision" as const],
    channels: ["phone_alert" as const],
    expiresAt: Date.now() + 60_000,
    maxAttempts: 2,
    minIntervalMs: 0,
    attemptLifetimeMs: 30_000,
    viewScope: [],
    alertFallback: false,
    consent: {
      actorId: "person",
      recordedAt: Date.now(),
      source: "operator" as const,
      statement: "Call about this synthetic project.",
    },
  };
  const options = {
    tasks,
    reviews,
    sessionToken: registered.token,
    directory,
    root: base,
    projectRoot,
    board: () => undefined,
    execution: () => undefined,
  };
  return {
    ...options,
    store,
    policy,
    setup: () => createProactiveSetup(options),
  };
}

it("exposes explicit missing setup without registering consent or pretending a phone can ring", () => {
  const f = fixture(),
    setup = f.setup();
  expect(setup.authority.list()).toEqual([]);
  expect(setup.service.doctor()).toMatchObject({
    deliveryConfigured: false,
    physicalAcceptance: false,
    policyCount: 0,
  });
  expect(setup.status().provider).toMatchObject({
    ready: false,
    reason: "outbound_setup_missing",
  });
});

function checkedTask(
  f: ReturnType<typeof fixture>,
  outcome: "completed" | "failed" = "completed",
  decision?: string,
) {
  const session = f.tasks.authenticate(f.sessionToken);
  let sequence = 0;
  let task = f.tasks.ledger.create(session, {
    eventId: "create-checked",
    goal: "Build a synthetic draft.",
  }).task;
  const change = (command: Record<string, unknown>) => {
    task = f.tasks.ledger.transition(session.id, task.id, {
      eventId: `change-${sequence++}`,
      expectedRevision: task.revision,
      ...command,
    } as TaskCommand).task;
  };
  change({ action: "claim_run", runId: task.runs.at(-1)!.id });
  change({
    action: "run_result",
    runId: task.runs.at(-1)!.id,
    dispatchId: task.runs.at(-1)!.dispatchId,
    outcome,
    summary: "Synthetic result.",
    ...(decision ? { decision } : {}),
  });
  change({
    action: "verify_result",
    verification: {
      id: "check-fixture",
      runId: task.runs.at(-1)!.id,
      state: "passed",
      completedAt: Date.now(),
      checks: [
        {
          name: "fixture",
          command: ["fixture"],
          state: "passed",
          exitCode: 0,
          summary: "Synthetic check receipt.",
        },
      ],
    },
  });
  return task;
}

it("keeps simulated checked results local even under an explicit real calling policy", () => {
  const f = fixture();
  writeFileSync(
    join(f.directory, "proactive.json"),
    JSON.stringify({
      version: 2,
      policies: [{ ...f.policy, triggers: ["review"] }],
    }),
    { mode: 0o600 },
  );
  const setup = f.setup();
  checkedTask(f);
  f.reviews.refresh();
  expect(setup.coordinator.list()).toEqual([]);
});

it("rejects worker-project policy files before registering their consent", () => {
  const f = fixture();
  writeFileSync(
    join(f.projectRoot, "proactive.json"),
    JSON.stringify({ version: 2, policies: [f.policy] }),
    { mode: 0o600 },
  );
  expect(() =>
    createProactiveSetup({ ...f, directory: f.projectRoot }),
  ).toThrow("outside the worker project");
  expect(f.store.all("proactive-call-policy-v2")).toEqual([]);
});

it.each(["review", "decision", "failure"] as const)(
  "selects only the matching %s trigger and paired identity for real task receipts",
  (trigger) => {
    const f = fixture(false);
    const selected = { ...f.policy, triggers: [trigger] };
    const other = {
      ...selected,
      id: "unrelated-person",
      scope: {
        ...selected.scope,
        personId: "other-person",
        deviceId: "other-device",
      },
      consent: { ...selected.consent, actorId: "other-person" },
    };
    writeFileSync(
      join(f.directory, "proactive.json"),
      JSON.stringify({ version: 2, policies: [other, selected] }),
      { mode: 0o600 },
    );
    const setup = f.setup();
    const task = checkedTask(
      f,
      trigger === "failure" ? "failed" : "completed",
      trigger === "decision" ? "Choose the draft variant." : undefined,
    );
    f.reviews.refresh();
    expect(setup.coordinator.list()).toHaveLength(1);
    expect(setup.coordinator.list()[0]).toMatchObject({
      policyId: selected.id,
      trigger,
      source: { kind: "task", taskId: task.id, runId: task.runs.at(-1)!.id },
    });
  },
);

it("rejects enrollment outside the native bounded hook lifetime and malformed session identity", () => {
  const f = fixture(),
    setup = f.setup();
  setup.authority.register(f.policy);
  const enrollment = {
    policyId: f.policy.id,
    projectRoot: f.projectRoot,
    sessionKey: "a".repeat(32),
    expiresAt: f.policy.expiresAt,
  };
  expect(() => setup.enroll({ ...enrollment, responseSeconds: 600 })).toThrow();
  expect(() =>
    setup.enroll({ ...enrollment, sessionKey: "wrong-session" }),
  ).toThrow();
  expect(() =>
    setup.enroll({ ...enrollment, responseSeconds: 540 }),
  ).not.toThrow();
});

it("preserves revoked policy across restart instead of renewing configuration consent", () => {
  const f = fixture();
  writeFileSync(
    join(f.directory, "proactive.json"),
    JSON.stringify({
      version: 2,
      policies: [f.policy],
      outbound: { provider: "chert-dev", receiptRetention: "unsupported" },
    }),
    { mode: 0o600 },
  );
  const first = f.setup();
  first.authority.revoke(f.policy.id);
  first.service.close();
  const restarted = f.setup();
  expect(restarted.authority.get(f.policy.id)?.revokedAt).toBeTypeOf("number");
  expect(restarted.service.doctor().policyCount).toBe(0);
  expect(restarted.status().provider.reason).toBe(
    "provider_journal_retention_unsupported",
  );
});

it("requires protected operator authorization, refuses browser origins and never lets a phone token grant policy", async () => {
  const f = fixture(),
    setup = f.setup(),
    operator = "o".repeat(40);
  const app = createTaskApp(
    f.tasks,
    operator,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    setup,
  );
  const request = (token: string, origin?: string) =>
    app.request("/operator/proactive/policies", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(f.policy),
    });
  expect((await request("phone-token")).status).toBe(401);
  expect((await request(operator, "https://example.com")).status).toBe(403);
  expect(setup.authority.list()).toHaveLength(0);
  expect((await request(operator)).status).toBe(201);
  const doctor = await app.request("/operator/proactive/doctor", {
    headers: { authorization: `Bearer ${operator}` },
  });
  expect(doctor.status).toBe(200);
  expect(await doctor.json()).toMatchObject({
    policyCount: 1,
    physicalAcceptance: false,
    installation: { provider: { configured: false } },
  });
});

it("keeps the baseline store schema readable with additive encrypted policy records", () => {
  const f = fixture(),
    setup = f.setup();
  setup.authority.register(f.policy);
  const stored = f.store.all<{ id: string; ciphertext: string }>(
    "proactive-call-policy-v2",
  );
  expect(stored).toHaveLength(1);
  expect(JSON.stringify(stored)).not.toContain(f.policy.consent.statement);
  expect(f.tasks.authenticate(f.sessionToken).projectRoot).toBe(f.projectRoot);
});
