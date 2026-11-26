import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopCli } from "../cli/task-desktop.js";
import { desktopConfigurationFingerprint } from "../src/control/task-desktop-config.js";

const directories: string[] = [];
afterEach(() => {
  while (directories.length)
    rmSync(directories.pop()!, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-desktop-test-")),
  );
  directories.push(root);
  const project = join(root, "project"),
    state = join(root, "private"),
    binary = join(root, "panel");
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(binary, "synthetic executable, never run", { mode: 0o700 });
  const origin = "http://127.0.0.1:13326",
    panelPath = join(state, "desktop-panel.json");
  const receiptDirectory = join(state, "receipts");
  mkdirSync(receiptDirectory, { mode: 0o700 });
  const fingerprint = desktopConfigurationFingerprint({
    projectRoot: project,
    worker: "simulation",
    checksFingerprint: null,
    port: 13326,
  });
  const descriptor = {
    version: 1,
    instanceId: "instance_fixture",
    pid: 42001,
    origin,
    projectRoot: project,
    worker: "simulation",
    panelConfigPath: panelPath,
    configurationFingerprint: fingerprint,
  };
  const panel = {
    version: 1,
    desktopId: "desktop_fixture",
    origin,
    token: "synthetic_desktop_token_".repeat(3),
    projectRoot: project,
    receiptDirectory,
    configurationFingerprint: fingerprint,
  };
  const stateResponse = {
    version: 1,
    desktopId: panel.desktopId,
    instanceId: descriptor.instanceId,
    configurationFingerprint: fingerprint,
    projectRoot: project,
    worker: "simulation",
    mode: "simulation",
  };
  const write = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  const publish = () => {
    write(join(state, "owner.lock"), { pid: descriptor.pid });
    write(join(state, "desktop-service.json"), descriptor);
    write(panelPath, panel);
  };
  const children: Array<
    EventEmitter & {
      pid: number;
      unref: ReturnType<typeof vi.fn>;
      kill: ReturnType<typeof vi.fn>;
    }
  > = [];
  let shouldPublish = true;
  let failPanel = false;
  const spawnMock = vi.fn(
    (command: string, _args: string[], _options: unknown) => {
      const child = Object.assign(new EventEmitter(), {
        pid: command === process.execPath ? descriptor.pid : 42002,
        unref: vi.fn(),
        kill: vi.fn(),
      });
      children.push(child);
      if (command === process.execPath && shouldPublish) publish();
      queueMicrotask(() =>
        child.emit(
          command === binary && failPanel ? "error" : "spawn",
          Error("synthetic spawn failed"),
        ),
      );
      return child;
    },
  );
  const request = vi.fn(
    async () => new Response(JSON.stringify(stateResponse), { status: 200 }),
  );
  const print = vi.fn();
  const args = [
    "--state",
    state,
    "--project",
    project,
    "--panel-binary",
    binary,
  ];
  const run = (extra: string[] = []) =>
    desktopCli([...args, ...extra], {
      root,
      spawn: spawnMock as unknown as typeof spawn,
      request,
      print,
      startupMs: 25,
      pollMs: 1,
    });
  return {
    root,
    project,
    state,
    binary,
    origin,
    panel,
    panelPath,
    descriptor,
    stateResponse,
    publish,
    write,
    args,
    run,
    request,
    print,
    spawnMock,
    children,
    noPublish: () => {
      shouldPublish = false;
    },
    failPanel: () => {
      failPanel = true;
    },
  };
}

function callsFixture() {
  const f = fixture();
  const sessionFile = join(f.state, "session.json"),
    checksFile = join(f.state, "checks.json"),
    callsFile = join(f.state, "calls.json");
  f.write(sessionFile, { token: "synthetic_session_".repeat(4) });
  f.write(checksFile, [
    { name: "synthetic check", command: ["/usr/bin/true"] },
  ]);
  const uuid = "00000000-0000-4000-8000-000000000001";
  const config = {
    version: 1,
    providerFile: join(f.state, "provider.json"),
    livekitFile: join(f.state, "livekit.json"),
    inspectorBundle: join(f.state, "inspector.mjs"),
    python: "/synthetic/python",
    helperBinary: "/synthetic/helper",
    attemptRoot: join(f.state, "attempts"),
    native: {
      callsOrigin: "https://calls.example.invalid",
      projectId: "synthetic_project",
      projectKey: "synthetic_private_project_key",
      recipient: "synthetic_recipient",
      lineId: uuid,
    },
    destination: {
      pairingId: "synthetic_pairing",
      memberId: "synthetic_member",
      deviceId: "synthetic_device",
      lineId: uuid,
      recipientHash: "a".repeat(64),
    },
    railway: {
      binary: "/synthetic/railway",
      projectId: uuid,
      environmentId: uuid,
      backendServiceId: uuid,
    },
  };
  f.write(callsFile, config);
  const digest = (path: string) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const expected = desktopConfigurationFingerprint({
    projectRoot: f.project,
    worker: "codex",
    checksFingerprint: digest(checksFile),
    port: 13326,
    sessionFingerprint: digest(sessionFile),
    callsFingerprint: digest(callsFile),
  });
  f.descriptor.worker = f.stateResponse.worker = "codex";
  f.stateResponse.mode = "standby";
  f.descriptor.configurationFingerprint =
    f.panel.configurationFingerprint =
    f.stateResponse.configurationFingerprint =
      expected;
  const baseArgs = [
    "--worker",
    "codex",
    "--checks",
    checksFile,
    "--session-file",
    sessionFile,
  ];
  return {
    ...f,
    config,
    callsFile,
    baseArgs,
    runCalls: (path = callsFile) =>
      f.run([...baseArgs, "--calls-config", path]),
  };
}

describe("dormant desktop calls configuration", () => {
  it("preserves the original no-calls fingerprint", () => {
    const value = {
      projectRoot: "/synthetic/project",
      worker: "simulation" as const,
      checksFingerprint: null,
      port: 13326,
    };
    expect(desktopConfigurationFingerprint(value)).toBe(
      createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    );
  });
  it("passes only the protected path and reopens one unchanged owner using GET only", async () => {
    const f = callsFixture();
    await f.runCalls();
    expect(f.spawnMock.mock.calls[0]![1].slice(-2)).toEqual([
      "--calls-config",
      f.callsFile,
    ]);
    expect(f.spawnMock.mock.calls.map(([command]) => command)).toEqual([
      process.execPath,
      f.binary,
    ]);
    await f.runCalls();
    expect(f.spawnMock.mock.calls.map(([command]) => command)).toEqual([
      process.execPath,
      f.binary,
      f.binary,
    ]);
    for (const call of f.request.mock.calls as unknown as Array<
      [string, RequestInit]
    >) {
      expect(call[0]).toBe(`${f.origin}/desktop/state`);
      expect(call[1].method ?? "GET").toBe("GET");
    }
    for (const privateValue of [
      f.config.native.projectKey,
      f.config.native.recipient,
    ]) {
      expect(JSON.stringify(f.spawnMock.mock.calls)).not.toContain(
        privateValue,
      );
      expect(JSON.stringify(f.print.mock.calls)).not.toContain(privateValue);
    }
    expect(JSON.parse(readFileSync(f.panelPath, "utf8")).desktopId).toBe(
      f.panel.desktopId,
    );
  });
  it("refuses changed configuration without starting another owner or requesting a call", async () => {
    const f = callsFixture();
    await f.runCalls();
    f.write(f.callsFile, {
      ...f.config,
      helperBinary: "/synthetic/other-helper",
    });
    await expect(f.runCalls()).rejects.toThrow("cannot be authenticated");
    expect(f.spawnMock).toHaveBeenCalledTimes(2);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["simulation", "missing-session"])(
    "requires explicit runtime prerequisites: %s",
    async (kind) => {
      const f = callsFixture();
      const args = kind === "simulation" ? [] : f.baseArgs.slice(0, 4);
      await expect(
        f.run([...args, "--calls-config", f.callsFile]),
      ).rejects.toThrow("requires Codex");
      expect(f.spawnMock).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it.each([
    "mode",
    "parent-mode",
    "symlink",
    "project",
    "oversized",
    "invalid",
    "extra-field",
  ])(
    "refuses unsafe calls configuration %s before any child or request",
    async (kind) => {
      const f = callsFixture();
      let path = f.callsFile;
      if (kind === "mode") chmodSync(path, 0o644);
      if (kind === "parent-mode") chmodSync(f.state, 0o755);
      if (kind === "symlink") {
        path = join(f.state, "calls-link.json");
        symlinkSync(f.callsFile, path);
      }
      if (kind === "project") {
        path = join(f.project, "calls.json");
        f.write(path, f.config);
      }
      if (kind === "oversized")
        writeFileSync(path, " ".repeat(65537), { mode: 0o600 });
      if (kind === "invalid") f.write(path, { version: 2 });
      if (kind === "extra-field")
        f.write(path, { ...f.config, userAuthorizedOneCall: true });
      await expect(f.runCalls(path)).rejects.toThrow();
      expect(f.spawnMock).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    },
  );
});

describe("independent desktop service launcher", () => {
  it("binds an explicit existing session by private file bytes without printing its token", async () => {
    const f = fixture();
    const file = join(f.state, "session.json"),
      token = "synthetic_session_".repeat(4);
    f.write(file, { version: 1, token, sessionId: "existing_session" });
    const expected = desktopConfigurationFingerprint({
      projectRoot: f.project,
      worker: "simulation",
      checksFingerprint: null,
      port: 13326,
      sessionFingerprint: createHash("sha256")
        .update(readFileSync(file))
        .digest("hex"),
    });
    f.descriptor.configurationFingerprint =
      f.panel.configurationFingerprint =
      f.stateResponse.configurationFingerprint =
        expected;
    await f.run(["--session-file", file]);
    expect(f.spawnMock.mock.calls[0]![1].slice(-2)).toEqual([
      "--session-file",
      file,
    ]);
    expect(JSON.stringify(f.spawnMock.mock.calls)).not.toContain(token);
    expect(JSON.stringify(f.print.mock.calls)).not.toContain(token);
    await f.run(["--session-file", file]);
    expect(
      f.spawnMock.mock.calls.filter(
        ([command]) => command === process.execPath,
      ),
    ).toHaveLength(1);
    f.write(file, {
      version: 1,
      token: token + "changed",
      sessionId: "existing_session",
    });
    await expect(f.run(["--session-file", file])).rejects.toThrow(
      "cannot be authenticated",
    );
    expect(
      f.spawnMock.mock.calls.filter(
        ([command]) => command === process.execPath,
      ),
    ).toHaveLength(1);
  });
  it.each(["mode", "invalid", "project"])(
    "refuses unsafe session file %s before starting a service",
    async (kind) => {
      const f = fixture(),
        file = join(kind === "project" ? f.project : f.state, "session.json");
      f.write(
        file,
        kind === "invalid"
          ? { token: "short" }
          : { token: "synthetic_session_".repeat(4) },
      );
      if (kind === "mode") chmodSync(file, 0o644);
      await expect(f.run(["--session-file", file])).rejects.toThrow();
      expect(f.spawnMock).not.toHaveBeenCalled();
    },
  );
  it("launches production JavaScript without a TS loader and preserves source mode", async () => {
    const f = fixture();
    mkdirSync(join(f.root, "scripts"));
    const entry = join(f.root, "scripts/task-server.js");
    writeFileSync(entry, "// compiled service fixture");
    await f.run();
    expect(f.spawnMock.mock.calls[0]![1].slice(0, 3)).toEqual([
      entry,
      "--state",
      f.state,
    ]);
    expect(f.spawnMock.mock.calls[0]![1]).not.toContain("tsx");
    const source = fixture();
    mkdirSync(join(source.root, "scripts"));
    writeFileSync(
      join(source.root, "scripts/task-server.js"),
      "// adjacent artifact",
    );
    writeFileSync(
      join(source.root, "scripts/task-server.ts"),
      "// source entry",
    );
    await source.run();
    expect(source.spawnMock.mock.calls[0]![1].slice(0, 3)).toEqual([
      "--import",
      "tsx",
      join(source.root, "scripts/task-server.ts"),
    ]);
  });
  it("starts simulation separately, then reopens against exactly the same service", async () => {
    const f = fixture();
    await f.run();
    expect(f.spawnMock).toHaveBeenCalledTimes(2);
    const service = f.spawnMock.mock.calls[0]!;
    expect(service[0]).toBe(process.execPath);
    expect(service[1]).toEqual([
      "--import",
      "tsx",
      join(f.root, "scripts/task-server.ts"),
      "--state",
      f.state,
      "--project",
      f.project,
      "--port",
      "13326",
      "--desktop",
      "true",
    ]);
    expect(service[2]).toMatchObject({ detached: true, stdio: "ignore" });
    expect(f.spawnMock.mock.calls[1]![1]).toEqual(["--config", f.panelPath]);
    const [url, options] = f.request.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(f.origin + "/desktop/state");
    expect(options).toMatchObject({
      headers: { authorization: `Bearer ${f.panel.token}` },
      redirect: "error",
    });
    expect(f.print.mock.calls.flat().join(" ")).not.toContain(f.panel.token);
    expect(existsSync(join(f.state, "desktop-launch.lock"))).toBe(false);
    await f.run();
    expect(f.spawnMock).toHaveBeenCalledTimes(3);
    expect(f.spawnMock.mock.calls[2]![0]).toBe(f.binary);
    for (const child of f.children) expect(child.kill).not.toHaveBeenCalled();
  });
  it("panel exit never closes the service or removes its ownership", async () => {
    const f = fixture();
    await f.run();
    f.children[1]!.emit("exit", 0);
    expect(existsSync(join(f.state, "owner.lock"))).toBe(true);
    expect(f.children[0]!.kill).not.toHaveBeenCalled();
  });
  it("a panel launch failure retains a confirmed persistent service", async () => {
    const f = fixture();
    f.failPanel();
    await expect(f.run()).rejects.toThrow("task service remains available");
    expect(existsSync(join(f.state, "owner.lock"))).toBe(true);
    expect(existsSync(join(f.state, "desktop-launch.lock"))).toBe(false);
    expect(f.children[0]!.kill).not.toHaveBeenCalled();
  });
  it.each(["project", "fingerprint", "instance", "pid", "origin", "mode"])(
    "refuses an existing mismatched %s without spawning a replacement",
    async (kind) => {
      const f = fixture();
      f.publish();
      if (kind === "project") f.stateResponse.projectRoot += "_other";
      if (kind === "fingerprint")
        f.stateResponse.configurationFingerprint = "0".repeat(64);
      if (kind === "instance") f.stateResponse.instanceId = "other_instance";
      if (kind === "pid") f.write(join(f.state, "owner.lock"), { pid: 42003 });
      if (kind === "origin") {
        f.descriptor.origin = "http://127.0.0.1:13327";
        f.publish();
      }
      if (kind === "mode") f.stateResponse.mode = "standby";
      await expect(f.run()).rejects.toThrow("cannot be authenticated");
      expect(f.spawnMock).not.toHaveBeenCalled();
      expect(existsSync(join(f.state, "owner.lock"))).toBe(true);
    },
  );
  it("never replaces an unreachable owner or retries a write", async () => {
    const f = fixture();
    f.publish();
    f.request.mockRejectedValue(Error("synthetic disconnected"));
    await expect(f.run()).rejects.toThrow("No replacement or renewal");
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.spawnMock).not.toHaveBeenCalled();
  });
  it("preserves a stale launcher lock instead of stealing it", async () => {
    const f = fixture();
    f.write(join(f.state, "desktop-launch.lock"), { pid: 999999 });
    const before = readFileSync(join(f.state, "desktop-launch.lock"));
    await expect(f.run()).rejects.toThrow("Do not steal");
    expect(readFileSync(join(f.state, "desktop-launch.lock"))).toEqual(before);
    expect(f.spawnMock).not.toHaveBeenCalled();
  });
  it("leaves an uncertain startup untouched and releases only its own launch lock", async () => {
    const f = fixture();
    f.noPublish();
    f.write(join(f.state, "desktop-service.json"), f.descriptor);
    await expect(f.run()).rejects.toThrow("startup is unconfirmed");
    expect(f.spawnMock).toHaveBeenCalledTimes(1);
    expect(f.children[0]!.kill).not.toHaveBeenCalled();
    expect(existsSync(join(f.state, "desktop-service.json"))).toBe(true);
    expect(existsSync(join(f.state, "desktop-launch.lock"))).toBe(false);
  });
  it("serializes overlapping launches before any duplicate service spawn", async () => {
    const f = fixture();
    let release!: () => void;
    f.request.mockImplementationOnce(async () => {
      await new Promise<void>((done) => {
        release = done;
      });
      return new Response(JSON.stringify(f.stateResponse));
    });
    const first = f.run();
    await expect(f.run()).rejects.toThrow("unresolved launch lock");
    release();
    await first;
    expect(
      f.spawnMock.mock.calls.filter(
        ([command]) => command === process.execPath,
      ),
    ).toHaveLength(1);
  });
  it("refuses changed checks/mode without mutating the existing service", async () => {
    const f = fixture();
    f.publish();
    const checks = join(f.state, "checks.json");
    f.write(checks, [{ name: "Synthetic", command: ["synthetic"] }]);
    await expect(
      f.run(["--worker", "codex", "--checks", checks]),
    ).rejects.toThrow("cannot be authenticated");
    expect(f.spawnMock).not.toHaveBeenCalled();
  });
  it.each([
    "permissions",
    "symlink",
    "inside_project",
    "invalid_checks",
    "missing_checks",
  ])("refuses unsafe configuration: %s", async (kind) => {
    const f = fixture();
    if (kind === "permissions") {
      chmodSync(f.state, 0o755);
      await expect(f.run()).rejects.toThrow("owner-only");
    }
    if (kind === "symlink") {
      f.publish();
      rmSync(f.panelPath);
      symlinkSync(join(f.state, "desktop-service.json"), f.panelPath);
      await expect(f.run()).rejects.toThrow("cannot be authenticated");
    }
    if (kind === "inside_project") {
      await expect(
        desktopCli(
          [
            "--state",
            join(f.project, "private"),
            "--project",
            f.project,
            "--panel-binary",
            f.binary,
          ],
          { spawn: f.spawnMock as unknown as typeof spawn },
        ),
      ).rejects.toThrow("outside");
    }
    if (kind === "invalid_checks") {
      const path = join(f.state, "checks.json");
      f.write(path, []);
      await expect(
        f.run(["--worker", "codex", "--checks", path]),
      ).rejects.toThrow("plan is invalid");
    }
    if (kind === "missing_checks")
      await expect(f.run(["--worker", "codex"])).rejects.toThrow(
        "verification plan",
      );
    expect(f.spawnMock).not.toHaveBeenCalled();
  });
  it("passes explicit Space settings only to the panel on launch and reattach", async () => {
    const f = fixture();
    const settings = {
      CLAWDTIME_SPACE_LEFT_SHORTCUT: "ctrl+shift+left",
      CLAWDTIME_SPACE_RIGHT_SHORTCUT: "ctrl+shift+right",
      CLAWDTIME_DESKTOP_SWITCHING: "off",
    };
    for (const [key, value] of Object.entries(settings)) vi.stubEnv(key, value);
    try {
      await f.run();
      await f.run();
      const calls = f.spawnMock.mock.calls;
      expect(calls.map(([command]) => command)).toEqual([
        process.execPath,
        f.binary,
        f.binary,
      ]);
      for (const key of Object.keys(settings))
        expect(calls[0]![2]).not.toHaveProperty(`env.${key}`);
      for (const call of calls.slice(1))
        expect(call[2]).toMatchObject({ env: settings });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("passes the cursor pace only to the panel, and none when it is not set", async () => {
    const f = fixture();
    vi.stubEnv("CLAWDTIME_CURSOR_PACE", "calm");
    try {
      await f.run();
      await f.run();
      const calls = f.spawnMock.mock.calls;
      expect(calls[0]![2]).not.toHaveProperty("env.CLAWDTIME_CURSOR_PACE");
      for (const call of calls.slice(1))
        expect(call[2]).toMatchObject({
          env: { CLAWDTIME_CURSOR_PACE: "calm" },
        });
    } finally {
      vi.unstubAllEnvs();
    }
    const g = fixture();
    vi.stubEnv("CLAWDTIME_CURSOR_PACE", undefined);
    try {
      await g.run();
      for (const call of g.spawnMock.mock.calls)
        expect(call[2]).not.toHaveProperty("env.CLAWDTIME_CURSOR_PACE");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("does not manufacture Space shortcut mappings when none were supplied", async () => {
    const f = fixture();
    const keys = [
      "CLAWDTIME_SPACE_LEFT_SHORTCUT",
      "CLAWDTIME_SPACE_RIGHT_SHORTCUT",
      "CLAWDTIME_DESKTOP_SWITCHING",
    ];
    for (const key of keys) vi.stubEnv(key, undefined);
    try {
      await f.run();
      for (const call of f.spawnMock.mock.calls)
        for (const key of keys)
          expect(call[2]).not.toHaveProperty(`env.${key}`);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("does not pass arbitrary inherited credentials to either child", async () => {
    const f = fixture();
    vi.stubEnv("DESKTOP_SYNTHETIC_SECRET", "fixture-only");
    try {
      await f.run();
      for (const call of f.spawnMock.mock.calls)
        expect(call[2]).not.toHaveProperty("env.DESKTOP_SYNTHETIC_SECRET");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
