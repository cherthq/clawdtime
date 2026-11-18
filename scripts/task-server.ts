import { serve } from "@hono/node-server";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
  lstatSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../src/storage/store.js";
import { Vault, token } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { createTaskApp } from "../src/control/task-app.js";

const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i],
    value = process.argv[i + 1];
  if (
    !key?.startsWith("--") ||
    !value ||
    !["--state", "--project", "--port"].includes(key)
  )
    throw new Error(
      "Use --state PRIVATE_DIR --project SELECTED_PROJECT [--port 3320].",
    );
  flags.set(key, value);
}
if (!flags.has("--state") || !flags.has("--project"))
  throw new Error(
    "An explicit private state directory and selected project are required.",
  );
const directory = resolve(flags.get("--state")!);
const projectRoot = realpathSync(flags.get("--project")!);
const port = Number(flags.get("--port") ?? 3320);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid port.");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const inside = relative(projectRoot, realpathSync(directory));
if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside)))
  throw new Error("Private task state must be outside the worker project.");
const stat = lstatSync(directory);
if (
  !stat.isDirectory() ||
  stat.isSymbolicLink() ||
  stat.mode & 0o077 ||
  stat.uid !== process.getuid?.()
)
  throw new Error("State must be an owner-only directory.");
// Never steal a stale lock: operator must establish prior process quiescence first.
const lockPath = join(directory, "owner.lock");
const lock = openSync(lockPath, "wx", 0o600);
writeFileSync(lock, JSON.stringify({ pid: process.pid }));
let store: Store | undefined;
let closed = false;
function cleanup() {
  if (closed) return;
  closed = true;
  store?.close();
  closeSync(lock);
  unlinkSync(lockPath);
}
process.on("exit", cleanup);
const configPath = join(directory, "local-config.json");
if (!existsSync(configPath))
  writeFileSync(
    configPath,
    JSON.stringify({
      key: randomBytes(32).toString("hex"),
      operatorToken: token(),
      projectRoot,
    }),
    { mode: 0o600, flag: "wx" },
  );
const configStat = lstatSync(configPath);
if (
  !configStat.isFile() ||
  configStat.isSymbolicLink() ||
  configStat.mode & 0o077 ||
  configStat.uid !== process.getuid?.()
)
  throw new Error("Unsafe local configuration.");
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  key: string;
  operatorToken: string;
  projectRoot: string;
};
if (config.projectRoot !== projectRoot)
  throw new Error("State is bound to a different selected project.");
const operatorPath = join(directory, "operator.json");
if (!existsSync(operatorPath))
  writeFileSync(operatorPath, JSON.stringify({ token: config.operatorToken }), {
    mode: 0o600,
    flag: "wx",
  });
store = new Store(join(directory, "tasks.sqlite"));
if (!store.get("pairing", "local-demo-pairing"))
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
const vault = new Vault(config.key);
const ledger = new TaskLedger(store, vault);
const service = new TaskService(store, vault, ledger, {
  projectRoots: [projectRoot],
  simulation: true,
});
const app = createTaskApp(service, config.operatorToken);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () =>
  console.log(
    `Task simulation listening on 127.0.0.1:${port}. Local fixture pairing only; no phone, capture or control. Operator credential file: ${operatorPath}`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    server.close(() => {
      cleanup();
      process.exit(0);
    }),
  );
