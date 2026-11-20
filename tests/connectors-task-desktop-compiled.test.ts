import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { desktopCli } from "../cli/task-desktop.js";
import { desktopConfigurationFingerprint } from "../src/control/task-desktop-config.js";

it("starts a JS-only production layout using plain Node without tsx or source files", async () => {
  const temporary = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-compiled-launch-")),
  );
  const runtime = join(temporary, "artifact", "dist"),
    state = join(temporary, "private"),
    project = join(temporary, "project"),
    panel = join(temporary, "fake-panel");
  for (const path of [join(runtime, "scripts"), state, project])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  mkdirSync(join(state, "receipts"), { mode: 0o700 });
  writeFileSync(panel, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const fingerprint = desktopConfigurationFingerprint({
    projectRoot: project,
    worker: "simulation",
    checksFingerprint: null,
    port,
  });
  const setup = {
    state,
    project,
    port,
    fingerprint,
    token: "synthetic-local-test-token-".repeat(3),
  };
  const entry = join(runtime, "scripts", "task-server.js");
  // Only Node built-ins: this fixture directory has no source tree or node_modules.
  writeFileSync(
    entry,
    `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
const config = ${JSON.stringify(setup)};
const origin = 'http://127.0.0.1:' + config.port;
const panelConfigPath = join(config.state, 'desktop-panel.json');
const instanceId = 'compiled-instance', desktopId = 'compiled-desktop';
const json = (path, value) => writeFileSync(path, JSON.stringify(value), {mode:0o600});
const response = {version:1, desktopId, instanceId, configurationFingerprint:config.fingerprint, projectRoot:config.project, worker:'simulation', mode:'simulation'};
const server = createServer((req,res) => { res.setHeader('content-type','application/json'); if(req.url !== '/desktop/state' || req.headers.authorization !== 'Bearer '+config.token){res.statusCode=403;res.end('{}');return;}res.end(JSON.stringify(response)); });
server.listen(config.port,'127.0.0.1',() => {
json(join(config.state,'owner.lock'),{pid:process.pid});
json(panelConfigPath,{version:1,desktopId,origin,token:config.token,projectRoot:config.project,receiptDirectory:join(config.state,'receipts'),configurationFingerprint:config.fingerprint});
json(join(config.state,'desktop-service.json'),{version:1,instanceId,pid:process.pid,origin,projectRoot:config.project,worker:'simulation',panelConfigPath,configurationFingerprint:config.fingerprint});
});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`,
  );
  const children: ChildProcess[] = [];
  const launches: string[][] = [];
  try {
    await desktopCli(
      [
        "--state",
        state,
        "--project",
        project,
        "--port",
        String(port),
        "--panel-binary",
        panel,
        "--agents",
        "false",
      ],
      {
        root: runtime,
        print: () => {},
        startupMs: 5000,
        pollMs: 20,
        spawn: ((binary: string, args: string[], options: object) => {
          const child = spawn(binary, args, options);
          children.push(child);
          launches.push([binary, ...args]);
          return child;
        }) as typeof spawn,
      },
    );
    expect(launches[0]!.slice(0, 2)).toEqual([process.execPath, entry]);
    expect(launches[0]).not.toContain("--import");
    expect(launches[0]).not.toContain("tsx");
    expect(existsSync(join(runtime, "node_modules"))).toBe(false);
    expect(existsSync(join(runtime, "scripts/task-server.ts"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(state, "owner.lock"), "utf8")).pid,
    ).toBe(children[0]!.pid);
    expect(launches).toHaveLength(2);
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(timer);
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}, 10000);
