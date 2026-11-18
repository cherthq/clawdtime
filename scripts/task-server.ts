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
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../src/storage/store.js";
import { Vault, token } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { createTaskApp } from "../src/control/task-app.js";
import { TaskEngine } from "../src/control/task-engine.js";
import type { VerificationPlan } from "../src/control/task-verification.js";
import { CodexTaskWorker } from "../connectors/codex/task-worker.js";
import { TaskVoiceLedger } from "../src/attention/task-voice-ledger.js";
import { TaskVoiceService } from "../src/control/task-voice-service.js";
import { z } from "zod";
import { TaskPresentationService } from "../src/control/task-presentation-service.js";
import { TaskPresentationLedger } from "../src/attention/task-presentation-ledger.js";
import { HTTPTaskPresentationHost } from "../src/transport/task-presentation.js";
import {
  taskPresentationManifestSchema,
  taskPresentationGrantSchema,
} from "../src/task-presentation-contracts.js";
import { TaskDesktopService } from "../src/control/task-desktop-service.js";
import {
  prepareTaskDesktop,
  writeDesktopPrivateJSON,
  readDesktopPrivateBytes,
} from "../src/control/task-desktop-config.js";

const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i],
    value = process.argv[i + 1];
  if (
    !key?.startsWith("--") ||
    !value ||
    ![
      "--state",
      "--project",
      "--port",
      "--worker",
      "--checks",
      "--presentation-config",
      "--desktop",
      "--session-file",
    ].includes(key)
  )
    throw new Error(
      "Use --state PRIVATE_DIR --project SELECTED_PROJECT [--port 3320].",
    );
  flags.set(key, value);
}
if (flags.has("--desktop") && flags.get("--desktop") !== "true")
  throw Error(
    "Use --desktop true to enable the separate native panel capability.",
  );
if (flags.has("--session-file") && !flags.has("--desktop"))
  throw Error("An attached session requires --desktop true.");
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
if (
  inside === "" ||
  (inside !== ".." && !inside.startsWith(".." + sep) && !isAbsolute(inside))
)
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
const realWorker = flags.get("--worker") === "codex";
if (flags.has("--worker") && !realWorker)
  throw new Error("Only the explicit codex worker is supported.");
if (realWorker !== flags.has("--checks"))
  throw new Error(
    "Real Codex requires an explicit verification plan file; simulation has no real checks.",
  );
const service = new TaskService(store, vault, ledger, {
  projectRoots: [projectRoot],
  simulation: !realWorker,
});
const checksBytes = realWorker
  ? flags.has("--desktop")
    ? readDesktopPrivateBytes(resolve(flags.get("--checks")!))
    : readFileSync(flags.get("--checks")!)
  : undefined;
const engine = realWorker
  ? new TaskEngine(
      service,
      new CodexTaskWorker({ enabled: true, projectRoots: [projectRoot] }),
      JSON.parse(checksBytes!.toString("utf8")) as VerificationPlan,
    )
  : undefined;
const voice = new TaskVoiceService(
  service,
  new TaskVoiceLedger(store, vault, ledger),
  engine,
);
let presentation: TaskPresentationService | undefined;
if (flags.has("--presentation-config")) {
  const path = resolve(flags.get("--presentation-config")!);
  const ps = lstatSync(path),
    parent = lstatSync(resolve(path, ".."));
  const inside = relative(projectRoot, realpathSync(path));
  if (
    !ps.isFile() ||
    ps.isSymbolicLink() ||
    ps.mode & 0o077 ||
    ps.uid !== process.getuid?.() ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.mode & 0o077 ||
    (inside !== ".." &&
      !inside.startsWith(".." + sep) &&
      !isAbsolute(inside)) ||
    ps.size > 65536
  )
    throw Error(
      "Presentation configuration must be owner-only and outside the worker project.",
    );
  const prepared = z
    .object({
      manifest: taskPresentationManifestSchema,
      grant: taskPresentationGrantSchema,
      host: z
        .object({ origin: z.string(), token: z.string().min(32).max(200) })
        .strict(),
    })
    .strict()
    .parse(JSON.parse(readFileSync(path, "utf8")));
  presentation = new TaskPresentationService(
    service,
    new TaskPresentationLedger(store, vault, ledger),
    new HTTPTaskPresentationHost(prepared.host),
    prepared,
  );
}
const desktopSetup = flags.has("--desktop")
  ? prepareTaskDesktop(service, {
      directory,
      projectRoot,
      worker: realWorker ? "codex" : "simulation",
      port,
      ...(flags.has("--session-file")
        ? { sessionPath: resolve(flags.get("--session-file")!) }
        : {}),
      ...(realWorker
        ? { checksPath: resolve(flags.get("--checks")!), checksBytes }
        : {}),
    })
  : undefined;
const desktop = desktopSetup
  ? new TaskDesktopService(service, engine, desktopSetup.config)
  : undefined;
const app = createTaskApp(
  service,
  config.operatorToken,
  engine,
  voice,
  presentation,
  undefined,
  desktop,
);
const presentationWatch = presentation
  ? setInterval(() => {
      void presentation!.reconcile().catch(() => {});
    }, 100)
  : undefined;
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
  if (desktopSetup)
    writeDesktopPrivateJSON(
      join(directory, "desktop-service.json"),
      desktopSetup.descriptor,
    );
  console.log(
    `Task ${realWorker ? "Codex worker" : "simulation"} listening on 127.0.0.1:${port}. ${presentation ? "Explicit local presentation configured; capture requires local Start. No phone or control." : "Local fixture pairing only; no phone, capture or control."} Operator credential file: ${operatorPath}`,
  );
});
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (presentationWatch) clearInterval(presentationWatch);
    void (async () => {
      await presentation?.close();
      await engine?.close();
      server.close(() => {
        cleanup();
        process.exit(0);
      });
    })().catch(() => {
      process.exitCode = 1;
    });
  });
