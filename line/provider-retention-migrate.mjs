/** Lead-only one-time installation into an exactly identified Node process. No stop/release action. */
import fs from "node:fs";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  inspectPinnedProvider,
  privateJSON,
  processIdentity,
  readRetentionConfig,
  readRetentionEvidence,
  RETENTION_PIN,
  sha256,
} from "./provider-retention.mjs";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export function describeRetentionTarget(configFile, pid) {
  const config = readRetentionConfig(configFile);
  const proof = inspectPinnedProvider(config.providerRoot);
  const identity = processIdentity(pid);
  const command = execFileSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "command="],
    { encoding: "utf8" },
  ).trim();
  // Inspect only whether debugger-affecting environment exists; never return or persist environment values.
  const environment = execFileSync(
    "/bin/ps",
    ["eww", "-p", String(pid), "-o", "command="],
    { encoding: "utf8", maxBuffer: 1048576 },
  );
  if (/(?:^|\s)NODE_OPTIONS=/.test(environment))
    throw Error("retention_migration_node_options_present");
  const executable = execFileSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "comm="],
    { encoding: "utf8" },
  ).trim();
  if (
    !command.split(/\s+/).some((arg, index, args) => {
      if (args[index + 1] !== "dev") return false;
      try {
        return (
          fs.realpathSync(arg) ===
          join(proof.providerRoot, "dist/src/cli/main.js")
        );
      } catch {
        return false;
      }
    }) ||
    /--inspect|--debug/.test(command)
  )
    throw Error("retention_migration_target_not_dev");
  if (sha256(fs.readFileSync(executable)) !== RETENTION_PIN.nodeSha256)
    throw Error("retention_migration_node_mismatch");
  return {
    ...identity,
    execPath: fs.realpathSync(executable),
    commandHash: sha256(command),
    providerRoot: proof.providerRoot,
    configHash: sha256(fs.readFileSync(configFile)),
  };
}
function listenerPids(port) {
  try {
    return [
      ...new Set(
        execFileSync(
          "/usr/sbin/lsof",
          ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "p"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        )
          .split("\n")
          .filter((line) => /^p[0-9]+$/.test(line))
          .map((line) => Number(line.slice(1))),
      ),
    ];
  } catch (error) {
    if (error.status === 1) return [];
    throw Error("retention_inspector_listener_unverified");
  }
}
async function assertUnusedPort(port) {
  if (listenerPids(port).length)
    throw Error("retention_inspector_port_occupied");
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () =>
      reject(Error("retention_inspector_port_occupied")),
    );
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      server.close(resolve),
    );
  });
}
class Inspector {
  constructor(ws) {
    this.ws = ws;
    this.sequence = 0;
    this.pending = new Map();
    ws.addEventListener("message", (e) => {
      const r = JSON.parse(String(e.data));
      const p = this.pending.get(r.id);
      if (p) {
        this.pending.delete(r.id);
        clearTimeout(p.timer);
        r.error
          ? p.reject(Error("retention_inspector_protocol_error"))
          : p.resolve(r.result);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("retention_inspector_timeout"));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw Error("retention_inspector_evaluation_failed");
    return r.result?.value;
  }
  close() {
    this.ws.close();
  }
}
export async function migrateRetention(configFile, expectedFile) {
  const expected = privateJSON(expectedFile);
  const before = describeRetentionTarget(configFile, expected.pid);
  if (JSON.stringify(before) !== JSON.stringify(expected))
    throw Error("retention_migration_identity_changed");
  // SIGUSR1's documented default debugger port only. Never connect to a pre-existing listener.
  const port = 9229;
  await assertUnusedPort(port);
  if (
    JSON.stringify(describeRetentionTarget(configFile, expected.pid)) !==
    JSON.stringify(expected)
  )
    throw Error("retention_migration_identity_changed");
  process.kill(expected.pid, "SIGUSR1");
  let target;
  for (let i = 0; i < 30; i++) {
    try {
      const listeners = listenerPids(port);
      if (listeners.length !== 1 || listeners[0] !== expected.pid) {
        await pause(100);
        continue;
      }
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(200),
      });
      const list = await response.json();
      if (Array.isArray(list) && list.length === 1) {
        target = list[0];
        break;
      }
    } catch {}
    await pause(100);
  }
  if (!target) throw Error("retention_inspector_not_ready");
  const url = new URL(target.webSocketDebuggerUrl);
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== String(port) ||
    !/^\/[a-f0-9-]+$/.test(url.pathname)
  )
    throw Error("retention_inspector_target_mismatch");
  const listeners = listenerPids(port);
  if (listeners.length !== 1 || listeners[0] !== expected.pid)
    throw Error("retention_inspector_listener_changed");
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(Error("retention_inspector_connect_timeout"));
    }, 3000);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(Error("retention_inspector_connect_failed"));
      },
      { once: true },
    );
  });
  const inspector = new Inspector(ws);
  let verified = false;
  let failure;
  try {
    const actual = await inspector.evaluate(
      "({pid:process.pid,execPath:process.execPath,version:process.version,argv:process.argv.slice(0,3),debugPort:process.debugPort})",
    );
    const config = readRetentionConfig(configFile);
    verified =
      actual.pid === expected.pid &&
      processIdentity(expected.pid).startedAt === expected.startedAt;
    if (
      actual.pid !== expected.pid ||
      actual.execPath !== expected.execPath ||
      actual.version !== RETENTION_PIN.nodeVersion ||
      actual.argv?.[2] !== "dev" ||
      fs.realpathSync(actual.argv[1]) !==
        join(config.providerRoot, "dist/src/cli/main.js") ||
      actual.debugPort !== port
    )
      throw Error("retention_inspector_process_mismatch");
    verified = true;
    if (
      JSON.stringify(describeRetentionTarget(configFile, expected.pid)) !==
      JSON.stringify(expected)
    )
      throw Error("retention_migration_identity_changed");
    const modulePath = fileURLToPath(
      new URL("./provider-retention.mjs", import.meta.url),
    );
    const result = await inspector.evaluate(
      `(()=>{const m=process.getBuiltinModule("module").createRequire(process.execPath)(${JSON.stringify(modulePath)});const e=m.installProviderRetention(${JSON.stringify(configFile)});return {pid:e.pid,capability:e.capability}})()`,
    );
    if (
      result.pid !== expected.pid ||
      result.capability !== "clawdtime-retention-v1"
    )
      throw Error("retention_guard_not_acknowledged");
    readRetentionEvidence(configFile, expected.pid);
  } catch (error) {
    failure = error;
  } finally {
    // Close only the inspector we opened and verified. Defer close so the acknowledgement can return.
    try {
      if (verified)
        await inspector.evaluate(
          "(()=>{const m=process.getBuiltinModule('inspector');setTimeout(()=>m.close(),100);return {closing:true}})()",
        );
    } finally {
      inspector.close();
    }
  }
  for (let i = 0; i < 30; i++) {
    try {
      await assertUnusedPort(port);
      if (failure) throw failure;
      return { installed: true, inspectorClosed: true, pid: expected.pid };
    } catch (error) {
      if (error === failure) throw error;
    }
    await pause(100);
  }
  throw Error("retention_inspector_close_unconfirmed");
}
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [command, config, arg] = process.argv.slice(2);
    if (command === "describe")
      console.log(JSON.stringify(describeRetentionTarget(config, Number(arg))));
    else if (command === "install")
      console.log(JSON.stringify(await migrateRetention(config, arg)));
    else
      throw Error(
        "usage: describe CONFIG PID | install CONFIG PRIVATE_EXPECTED_JSON",
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
