import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectDesktopReadiness } from "../connectors/agents/desktop-readiness.js";
import { computerCli } from "../cli/computer.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function fixture(
  values: {
    instanceId?: string;
    model?: boolean;
    sessionActive?: boolean;
    canSubmit?: boolean;
    execution?: { configured: boolean; mode?: "native"; state: string };
    computer?: { enabled: boolean; state: string } | null;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-readiness-"));
  roots.push(root);
  const folder = join(root, "desktop");
  mkdirSync(folder, { mode: 0o700 });
  const origin = "http://127.0.0.1:12345",
    token = "private-test-credential".repeat(3);
  const base = { version: 1, origin, configurationFingerprint: "a".repeat(64) };
  const write = (name: string, data: unknown) =>
    writeFileSync(join(folder, name), JSON.stringify(data), { mode: 0o600 });
  write("desktop-service.json", {
    ...base,
    instanceId: "expected",
    pid: process.pid,
  });
  write("desktop-panel.json", { ...base, token });
  write("owner.lock", { pid: process.pid });
  const request = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({ authorization: `Bearer ${token}` });
    const route = new URL(String(url)).pathname;
    if (route === "/desktop/state")
      return Response.json({
        instanceId: values.instanceId ?? "expected",
        sessionActive: values.sessionActive ?? false,
        canSubmit: values.canSubmit ?? false,
      });
    if (route === "/desktop/chat")
      return Response.json({
        model: values.model ?? true,
        execution: values.execution,
      });
    if (route === "/desktop/computer" && values.computer !== null)
      return Response.json(
        values.computer ?? { enabled: false, state: "idle" },
      );
    return new Response("unavailable", { status: 404 });
  });
  const system = {
    env: { CLAWDTIME_CONFIG_HOME: root, CLAWDTIME_DESKTOP_STATE: folder },
    home: "/nowhere",
  };
  return { root, folder, token, system, request };
}

it("does not probe a missing configured destination or claim computer readiness", async () => {
  const f = fixture();
  rmSync(f.folder, { recursive: true });
  const result = await inspectDesktopReadiness(f.system, {
    request: f.request,
  });
  expect(result).toMatchObject({
    service: "absent",
    computer: "unknown",
    physicalVerification: "required",
  });
  expect(f.request).not.toHaveBeenCalled();
});

it("separates an inactive coding session from an enabled computer worker", async () => {
  const f = fixture({ computer: { enabled: true, state: "idle" } });
  expect(
    await inspectDesktopReadiness(f.system, { request: f.request }),
  ).toEqual({
    service: "connected",
    chat: "connected",
    taskSession: "inactive",
    taskAdmission: "blocked",
    computer: "configured",
    computerMode: "worker",
    physicalVerification: "required",
  });
  expect(f.request).toHaveBeenCalledTimes(3);
});

it("does not confuse a live model and active task session with a computer executor", async () => {
  const f = fixture({ sessionActive: true, canSubmit: true });
  expect(
    await inspectDesktopReadiness(f.system, { request: f.request }),
  ).toMatchObject({
    taskSession: "active",
    taskAdmission: "available",
    computer: "not_configured",
  });
});

it("reports a configured native adapter separately from the disabled panel worker", async () => {
  const f = fixture({
    execution: { configured: true, mode: "native", state: "idle" },
  });
  expect(
    await inspectDesktopReadiness(f.system, { request: f.request }),
  ).toMatchObject({ computer: "configured", computerMode: "native" });
});

it("preserves uncertain execution and reports a missing service model", async () => {
  const f = fixture({
    model: false,
    execution: { configured: true, state: "uncertain" },
  });
  expect(
    await inspectDesktopReadiness(f.system, { request: f.request }),
  ).toMatchObject({ chat: "no_model", computer: "uncertain" });
});

it("does not inspect capabilities after an identity mismatch or failed connection", async () => {
  const f = fixture({ instanceId: "different" });
  expect(
    await inspectDesktopReadiness(f.system, { request: f.request }),
  ).toMatchObject({ service: "identity_mismatch", computer: "unknown" });
  expect(f.request).toHaveBeenCalledTimes(1);
  f.request.mockRejectedValueOnce(Error("sensitive raw failure"));
  const failed = await inspectDesktopReadiness(f.system, {
    request: f.request,
  });
  expect(failed.service).toBe("unavailable");
  expect(JSON.stringify(failed)).not.toContain("sensitive");
});

it("doctor JSON contains software evidence without private credentials or a physical pass", async () => {
  const f = fixture({ computer: { enabled: true, state: "idle" } });
  const lines: string[] = [];
  await computerCli(["doctor", "--json"], {
    ...f.system,
    request: f.request,
    print: (line) => lines.push(line),
  });
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain(f.token);
  const result = JSON.parse(lines[0]!);
  expect(result.desktop.computer).toBe("configured");
  expect(result.desktop.physicalVerification).toBe("required");
  expect(
    result.checks.find((c: { name: string }) => c.name === "executor").detail,
  ).toContain("still need verification");
});
