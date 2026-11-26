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
import { homedir } from "node:os";
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
import { BoardFeed } from "../connectors/agents/feed.js";
import { stateRoot } from "../connectors/agents/hooks.js";
import {
  buildOwnerReach,
  chooseExecution,
} from "../connectors/computer/service.js";
import {
  isTextTurn,
  voiceOnlyCall,
  withOwnerWords,
} from "../connectors/computer/reach.js";
import { mountReachCalls } from "../connectors/computer/calls-api.js";
import { ChatLog } from "../connectors/agents/brain.js";
import { Memory } from "../connectors/agents/memory.js";
import { browserFromEnvironment } from "../connectors/computer/browser.js";
import { PhoneDesktop } from "../src/control/phone-desktop.js";
import { deskTasks } from "../connectors/agents/tasks.js";
import { queueDesktopRequest } from "../connectors/agents/desktop-executor.js";
import { BundledCuaRuntime } from "../src/control/bundled-cua-runtime.js";
import { BackgroundRuntime } from "../src/control/background-runtime.js";
import { QualifiedBackgroundWorker } from "../src/control/background-worker.js";
import { backgroundConfigSchema } from "../src/control/background-config.js";
import {
  LineRuntime,
  assertSeparateLineToken,
  lineRuntimeConfigSchema,
} from "../src/control/line-runtime.js";
import { BundledCuaNative } from "../src/control/bundled-cua-native.js";
import { bundledCuaConfigSchema } from "../src/control/cua-contracts.js";
import { BundledCuaBrowser } from "../connectors/agents/bundled-cua-browser.js";
import { openAiBundledCuaPlanner } from "../connectors/agents/bundled-cua-planner.js";
import {
  DesktopExecutor,
  desktopExecutorConfigSchema,
} from "../src/control/desktop-executor.js";
import { TaskDesktopCalls } from "../src/control/task-desktop-calls.js";
import { TaskReviewService } from "../src/control/task-review-service.js";
import { createProactiveSetup } from "../src/control/proactive-setup.js";
import { desktopCallsConfigSchema } from "../src/control/task-desktop-calls-config.js";
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
      "--calls-config",
      "--agents",
    ].includes(key)
  )
    throw new Error(
      "Use --state PRIVATE_DIR --project SELECTED_PROJECT [--port 3320].",
    );
  flags.set(key, value);
}
if (
  flags.has("--agents") &&
  (!flags.has("--desktop") ||
    !["true", "false"].includes(flags.get("--agents")!))
)
  throw Error("Use --agents true|false with --desktop true.");
if (flags.has("--desktop") && flags.get("--desktop") !== "true")
  throw Error(
    "Use --desktop true to enable the separate native panel capability.",
  );
if (flags.has("--session-file") && !flags.has("--desktop"))
  throw Error("An attached session requires --desktop true.");
if (
  flags.has("--calls-config") &&
  (!flags.has("--desktop") ||
    !flags.has("--session-file") ||
    flags.get("--worker") !== "codex")
)
  throw Error(
    "Desktop calls require an explicit Codex desktop and existing paired session.",
  );
if (flags.has("--calls-config") && flags.has("--presentation-config"))
  throw Error(
    "Use either local presentation or the scoped desktop call runtime.",
  );
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
let calls: TaskDesktopCalls | undefined;
const voices = new TaskVoiceLedger(store, vault, ledger);
const voice = new TaskVoiceService(
  service,
  voices,
  engine,
  () => calls?.presentationPort,
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
const callsPath = flags.has("--calls-config")
  ? resolve(flags.get("--calls-config")!)
  : undefined;
const callsBytes = callsPath ? readDesktopPrivateBytes(callsPath) : undefined;
const callsConfig = callsBytes
  ? desktopCallsConfigSchema.parse(JSON.parse(callsBytes.toString("utf8")))
  : undefined;
if (
  callsConfig &&
  Object.values(
    callsConfig.ports ?? { task: 13323, media: 3322, stop: 13324 },
  ).includes(port)
)
  throw Error("Desktop and call runtime ports must be distinct.");
const desktopSetup = flags.has("--desktop")
  ? prepareTaskDesktop(service, {
      directory,
      projectRoot,
      worker: realWorker ? "codex" : "simulation",
      port,
      ...(callsPath ? { callsPath, callsBytes } : {}),
      ...(flags.has("--session-file")
        ? { sessionPath: resolve(flags.get("--session-file")!) }
        : {}),
      ...(realWorker
        ? { checksPath: resolve(flags.get("--checks")!), checksBytes }
        : {}),
    })
  : undefined;
if (callsConfig && desktopSetup && engine) {
  calls = new TaskDesktopCalls(service, engine, voices, voice, {
    config: callsConfig,
    configPath: callsPath!,
    stateDirectory: directory,
    projectRoot,
    sessionPath: resolve(flags.get("--session-file")!),
    sessionToken: desktopSetup.config.sessionToken,
    checksPath: resolve(flags.get("--checks")!),
    operatorToken: config.operatorToken,
  });
}
const desktop = desktopSetup
  ? new TaskDesktopService(
      service,
      engine,
      desktopSetup.config,
      calls,
      () =>
        !calls?.ledger
          .unresolved()
          .some((r) => ["starting", "unknown"].includes(r.state)),
    )
  : undefined;
if (calls && desktop) calls.selectedTaskId = () => desktop.selectedTaskId();
const reviews = desktopSetup
  ? new TaskReviewService(
      service,
      desktopSetup.config.sessionToken,
      engine,
      !!calls,
    )
  : undefined;
if (desktop) desktop.reviews = reviews;
if (calls) calls.reviews = reviews?.ledger;
if (calls && reviews) reviews.configureDelivery(calls);
// The panel's board of coding-agent sessions. It scans in its own process, so
// it cannot delay task, voice or presentation work in this one.
// The agent that the person talks to reaches the task through the desktop
// service of this process, with that service's own receipts.
let agentBoard: BoardFeed | undefined;
const executorPath = join(directory, "desktop-executor.json");
const executorConfig =
  desktop && existsSync(executorPath)
    ? desktopExecutorConfigSchema.parse(
        JSON.parse(readDesktopPrivateBytes(executorPath).toString("utf8")),
      )
    : undefined;
if (
  executorConfig &&
  (executorConfig.origin !== `http://127.0.0.1:${port}` ||
    calls ||
    presentation ||
    flags.get("--agents") === "false")
)
  throw Error(
    "Desktop execution requires its exact local origin, agent board and a service without phone/presentation actors.",
  );
if (
  executorConfig &&
  [
    config.operatorToken,
    desktopSetup?.config.token,
    desktopSetup?.config.sessionToken,
  ].includes(executorConfig.token)
)
  throw Error("Desktop execution needs a separate credential.");
const bundledPath = join(directory, "bundled-cua.json");
const bundledConfig =
  desktop && existsSync(bundledPath)
    ? bundledCuaConfigSchema.parse(
        JSON.parse(readDesktopPrivateBytes(bundledPath).toString("utf8")),
      )
    : undefined;
if (
  bundledConfig &&
  (executorConfig || presentation || flags.get("--agents") === "false")
)
  throw Error(
    "Select exactly one desktop executor; standalone presentation actors cannot share its ownership.",
  );
const backgroundPath = join(directory, "background-cua.json");
const backgroundConfig =
  desktop && existsSync(backgroundPath)
    ? backgroundConfigSchema.parse(
        JSON.parse(readDesktopPrivateBytes(backgroundPath).toString("utf8")),
      )
    : undefined;
if (
  backgroundConfig &&
  (executorConfig || calls || presentation || flags.get("--agents") === "false")
)
  throw Error(
    "Background execution requires exclusive local runtime selection.",
  );
// A service that a test started never has the background runtime, as it never
// has the computer worker: no input for the driver can come out of a test.
if (backgroundConfig && process.env.VITEST)
  throw Error(
    "Background execution does not run in a service that a test started.",
  );
const background = backgroundConfig
  ? new BackgroundRuntime(
      store,
      vault,
      () =>
        new QualifiedBackgroundWorker(
          backgroundConfig,
          join(directory, "background-driver-owner.json"),
          process.env.CLAWDTIME_OPENAI_API_KEY ??
            process.env.OPENAI_API_KEY ??
            "",
        ),
      backgroundConfig.timeoutMs,
      (text) => agentBoard?.appendExecutionResult(text),
    )
  : undefined;
const bundled =
  bundledConfig && !backgroundConfig
    ? new BundledCuaRuntime(
        store,
        vault,
        bundledConfig,
        openAiBundledCuaPlanner({
          apiKey:
            process.env.CLAWDTIME_OPENAI_API_KEY ??
            process.env.OPENAI_API_KEY ??
            "",
          model: bundledConfig.model,
          reasoningEffort: bundledConfig.reasoningEffort,
        }),
        () =>
          bundledConfig.mode === "browser"
            ? new BundledCuaBrowser(bundledConfig.browser!)
            : new BundledCuaNative(
                bundledConfig.native!,
                fetch,
                Date.now,
                !!calls,
              ),
        (text) => agentBoard?.appendExecutionResult(text),
      )
    : undefined;
if (calls && bundled) {
  calls.executionOwnership = {
    acquireReviewOwnership: (id) => bundled.acquireReviewOwnership(id),
    releaseReviewOwnership: (id) => bundled.releaseReviewOwnership(id),
    ...(bundledConfig!.mode === "native"
      ? {
          confirmReviewOwnership: () =>
            new BundledCuaNative(bundledConfig!.native!).assertReviewIdle(),
        }
      : {}),
  };
  bundled.setOwnershipGuard(() => calls!.ledger.unresolved().length === 0);
}
const executor =
  background ??
  bundled ??
  (executorConfig
    ? new DesktopExecutor(
        store,
        vault,
        executorConfig,
        (id) =>
          queueDesktopRequest(
            executorConfig.binary,
            executorConfig.threadId,
            id,
            executorConfig.clientPath,
            executorPath,
          ),
        (text) => agentBoard?.appendExecutionResult(text),
      )
    : undefined);
// The file of the phone runtime is a private desktop file as the three before
// it: it is read only in a desktop service, and only as a regular file of
// this user for its owner alone, never through a link.
const lineRuntimePath = join(directory, "line-runtime.json");
const lineRuntimeConfig =
  desktop && existsSync(lineRuntimePath)
    ? lineRuntimeConfigSchema.parse(
        JSON.parse(readDesktopPrivateBytes(lineRuntimePath).toString("utf8")),
      )
    : undefined;
// A phone process never holds the operator, panel or session credential.
if (lineRuntimeConfig)
  assertSeparateLineToken(lineRuntimeConfig.token, [
    config.operatorToken,
    desktopSetup?.config.token,
    desktopSetup?.config.sessionToken,
  ]);
if (
  lineRuntimeConfig &&
  !background &&
  (!bundled || bundledConfig?.mode !== "native")
)
  throw Error("Phone computer control requires the app-owned native runtime.");
const lineRuntime =
  lineRuntimeConfig && (background ?? bundled)
    ? new LineRuntime(
        store,
        vault,
        lineRuntimeConfig.token,
        (background ?? bundled)!,
      )
    : undefined;
const lineRuntimeWatch = lineRuntime
  ? setInterval(() => lineRuntime.expire(), 1000)
  : undefined;
// One engine does the computer work of this service. A file in the state
// folder keeps priority: the connection to an existing chat, then the
// background runtime, then the bundled runtime. With none of them, the
// app-owned computer worker runs, when the person turned it on with
// `clawdtime computer on` and a key for the language model is in this
// environment or in the key store of the state folder (`clawdtime keys`). A
// service that a test started never has that worker, so no command for the
// hands can come out of a test.
const connectedBrowser = desktop
  ? browserFromEnvironment(process.env)
  : undefined;
const chosen = desktop
  ? chooseExecution({
      root: stateRoot({ env: process.env, home: homedir() }),
      env: process.env,
      chat: executorConfig ? executor : undefined,
      background,
      bundled,
      actors: !!(calls || presentation),
      board: flags.get("--agents") !== "false",
      notify: (text) => agentBoard?.appendExecutionResult(text),
      // The browser driver reads and operates the page of the browser in
      // front through the browser's own scripting, in place of pixels. It is
      // a switch, off unless CLAWDTIME_COMPUTER_BROWSER=on: it runs a script
      // in the person's own signed-in pages, so the person turns it on.
      // CLAWDTIME_COMPUTER_BROWSER=own drives ClawdTime's own browser, with
      // its own profile, instead. It starts at the first browser step.
      // Without it the worker refuses the browser actions and uses the screen.
      ...(connectedBrowser ? { browser: connectedBrowser } : {}),
      // The memory store of the service, in its state folder. The worker
      // reads notes from it before a request and keeps what the owner taught
      // after it, only while the person has memory on (clawdtime memory on).
      memory: new Memory(stateRoot({ env: process.env, home: homedir() })),
    })
  : undefined;
// Phone ownership applies to the panel worker only. Other runtime types retain
// their own admission and must not acquire a second phone authority path.
const phoneDesktop = chosen?.computer.worker
  ? new PhoneDesktop(chosen.computer.worker)
  : undefined;
const execution = phoneDesktop?.execution ?? chosen?.execution;
const proactive =
  desktopSetup && reviews
    ? createProactiveSetup({
        tasks: service,
        reviews,
        sessionToken: desktopSetup.config.sessionToken,
        directory,
        root: stateRoot({ env: process.env, home: homedir() }),
        projectRoot,
        origin: `http://127.0.0.1:${port}`,
        board: () => agentBoard,
        execution: () => execution?.snapshot(),
        phoneDesktop,
      })
    : undefined;
if (calls && proactive)
  calls.proactive = {
    coordinator: proactive.coordinator,
    packet: (id) => proactive.preparation.packetSnapshot(id),
  };
if (proactive)
  chosen?.computer.worker?.setOwnershipGuard(
    (authority) =>
      (phoneDesktop?.ownsExecution(authority) === true &&
        !!authority &&
        proactive.permitsComputer(authority.callId)) ||
      (!proactive.viewOccupied() &&
        !proactive.coordinator.list().some(
          (i) =>
            ["dispatching", "connected", "unknown"].includes(i.state) &&
            // A call of the reach only talks: it shares no screen, so the
            // worker keeps the screen and can take the answer said on it.
            !voiceOnlyCall(i),
        )),
  );
// The reach and the routines of the computer worker. The reach calls the
// owner on the line when a question waits too long in the chat, and texts
// when the call does not get through. Routines hand a request of the owner
// to the worker at its time. Both read and act only through the worker's own
// status, answer, stop and submit.
const lineInCall = () =>
  !!(
    proactive &&
    (proactive.viewOccupied() ||
      proactive.coordinator
        .list()
        .some((i) => ["dispatching", "connected", "unknown"].includes(i.state)))
  ) ||
  (phoneDesktop?.hasOpenCall() ?? false);
const owner = chosen?.computer.worker
  ? buildOwnerReach({
      worker: chosen.computer.worker,
      root: stateRoot({ env: process.env, home: homedir() }),
      env: process.env,
      projectRoot,
      proactive: proactive
        ? {
            coordinator: proactive.coordinator,
            configured: proactive.deliveryConfigured,
            pump: () => {
              void proactive.service.pump().catch(() => {
                /* The queue runs again on its own turn. */
              });
            },
            stop: (id) => {
              void proactive.service.stop(id).catch(() => {
                /* The call ends at its own deadline. */
              });
            },
          }
        : undefined,
      liveCall: lineInCall,
      notify: (text) => agentBoard?.appendExecutionResult(text),
      // With no retained provider, the reach calls through the Calls API of
      // Chert, and the line agent posts the owner's words to this address.
      origin: `http://127.0.0.1:${port}`,
    })
  : undefined;
if (proactive && owner?.reach)
  proactive.attachComputer(owner.reach.proactiveSource());
agentBoard =
  desktop && desktopSetup && flags.get("--agents") !== "false"
    ? new BoardFeed({
        ...(proactive ? { proactive: proactive.sources } : {}),
        // Work that no own tool does goes to a new coding session in the
        // selected project, and an application can open. CLAWDTIME_DESKTOP_WINDOWS=off
        // turns both off. A service that a test started never opens a window
        // on the person's screen, whatever else is set.
        ...(process.env.CLAWDTIME_DESKTOP_WINDOWS !== "off" &&
        !process.env.VITEST
          ? {
              project: projectRoot,
              jobsForTasks: process.env.CLAWDTIME_SIMULATION_JOBS === "on",
            }
          : {}),
        tasks: deskTasks(desktop, desktopSetup.config.token),
        ...(execution ? { execution } : {}),
        // The routines of the computer worker, for the tools of the chat agent.
        ...(owner ? { routines: owner.routines } : {}),
        // The structured intent reader of the task service: a model reads what
        // each message is for the task, before the other rules of the chat. It
        // is a switch, off unless CLAWDTIME_SEMANTIC_TASKS=on, so that a
        // service that does not ask for it talks exactly as before.
        ...(process.env.CLAWDTIME_SEMANTIC_TASKS === "on"
          ? { semanticTasks: true }
          : {}),
      })
    : undefined;
// The owner's words reach the routines, and a text reply reaches the
// question of the reach, before the language model of the chat reads them.
if (agentBoard && owner) {
  const board = agentBoard;
  const root = stateRoot({ env: process.env, home: homedir() });
  const log = new ChatLog(root);
  board.say = withOwnerWords(board.say.bind(board), {
    reach: owner.reach ?? undefined,
    routine: (words) => owner.routines.fromWords(words),
    fromText: (words) => isTextTurn(root, words),
    answered: (text, reply, via = "chat") => {
      const at = Date.now();
      log.append({ role: "user", text, at, via });
      const message = { role: "assistant" as const, text: reply, at, via };
      log.append(message);
      return message;
    },
  });
}
agentBoard?.start();
process.on("exit", () => agentBoard?.close());
const app = createTaskApp(
  service,
  config.operatorToken,
  engine,
  voice,
  presentation,
  undefined,
  desktop,
  calls,
  agentBoard,
  executor,
  chosen?.computer.port,
  lineRuntime,
  phoneDesktop && desktopSetup
    ? { scope: phoneDesktop, instanceId: desktopSetup.descriptor.instanceId }
    : undefined,
  proactive,
);
// The line agent of a reach call over the Calls API: its capability for that
// one call, then the owner's words, the stop and the end of the call.
if (owner?.calls) mountReachCalls(app, owner.calls);
const proactiveWatch = proactive
  ? setInterval(() => {
      void proactive.service.pump().catch(() => {
        /* Durable state remains authoritative after scheduling errors. */
      });
    }, 1000)
  : undefined;
const ownerWatch = owner
  ? setInterval(() => {
      void owner.reach?.tick().catch(() => {
        /* The record of the reach stays; the next turn reads again. */
      });
      void owner.routines.tick().catch(() => {
        /* A routine waits for the next turn. */
      });
    }, 1000)
  : undefined;
ownerWatch?.unref();
const presentationWatch = presentation
  ? setInterval(() => {
      void presentation!.reconcile().catch(() => {});
    }, 100)
  : undefined;
const reviewWatch = reviews
  ? setInterval(() => {
      try {
        reviews.refresh();
        calls?.reconcileReview();
        void reviews.pump();
      } catch {
        /* Expired authority never starts effects. */
      }
    }, 1000)
  : undefined;
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
  if (desktopSetup)
    writeDesktopPrivateJSON(
      join(directory, "desktop-service.json"),
      desktopSetup.descriptor,
    );
  console.log(
    `Task ${realWorker ? "Codex worker" : "simulation"} listening on 127.0.0.1:${port}. ${background ? "Qualified background runtime configured; admitted call and local Enable required." : calls ? "Review callbacks retain exact result intent. Fresh prepared call authorization and exclusive capture handoff are required." : bundled ? "App-owned computer runtime configured. Phone setup missing; callbacks cannot be delivered." : presentation ? "Explicit local presentation configured; capture requires local Start. No phone or control." : "Local fixture pairing only; no phone, capture or control."} Operator credential file: ${operatorPath}`,
  );
});
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    phoneDesktop?.shutdown();
    if (presentationWatch) clearInterval(presentationWatch);
    if (reviewWatch) clearInterval(reviewWatch);
    if (proactiveWatch) clearInterval(proactiveWatch);
    if (ownerWatch) clearInterval(ownerWatch);
    proactive?.service.close();
    reviews?.close();
    if (lineRuntimeWatch) clearInterval(lineRuntimeWatch);
    lineRuntime?.close();
    agentBoard?.close();
    void (async () => {
      if (proactive) {
        await Promise.allSettled(
          proactive.coordinator
            .list()
            .filter((intent) =>
              [
                "queued",
                "preparing",
                "ready",
                "dispatching",
                "connected",
              ].includes(intent.state),
            )
            .map((intent) => proactive.service.stop(intent.id)),
        );
      }
      // ClawdTime's own browser closes its control port with the service.
      await connectedBrowser?.close?.().catch(() => {});
      await background?.close();
      await bundled?.close();
      await calls?.close();
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
