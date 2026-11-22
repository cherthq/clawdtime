// Explicit operator-only local qualification. Never replay a previous receipt.
import { mkdirSync, lstatSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { backgroundConfigSchema } from "../src/control/background-config.js";
import { QualifiedBackgroundWorker } from "../src/control/background-worker.js";
import { BackgroundRuntime } from "../src/control/background-runtime.js";
import { LineRuntime } from "../src/control/line-runtime.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { readDesktopPrivateBytes } from "../src/control/task-desktop-config.js";
const [configPath, statePath, workflow] = process.argv.slice(2);
if (
  process.argv.length !== 5 ||
  !configPath?.startsWith("/") ||
  !statePath?.startsWith("/") ||
  !["messages", "codex"].includes(workflow!)
)
  throw Error("Use private-config absolute-new-private-state messages|codex");
const config = backgroundConfigSchema.parse(
  JSON.parse(readDesktopPrivateBytes(configPath).toString("utf8")),
);
const directory = resolve(statePath);
if (existsSync(directory))
  throw Error(
    "Choose a new qualification state directory; existing outcomes cannot be reset or replayed",
  );
const parent = lstatSync(resolve(directory, ".."));
if (
  !parent.isDirectory() ||
  parent.isSymbolicLink() ||
  parent.mode & 0o077 ||
  parent.uid !== process.getuid?.()
)
  throw Error("Private qualification parent required");
mkdirSync(directory, { mode: 0o700 });
const key = randomBytes(32).toString("hex");
writeFileSync(
  join(directory, "qualification-key.json"),
  JSON.stringify({ key }),
  { mode: 0o600, flag: "wx" },
);
const store = new Store(join(directory, "receipts.sqlite"));
const vault = new Vault(key);
let qualifiedWorker: QualifiedBackgroundWorker | undefined;
const runtime = new BackgroundRuntime(
  store,
  vault,
  () => {
    const worker = new QualifiedBackgroundWorker(
      config,
      join(directory, "driver-owner.json"),
      process.env.CLAWDTIME_OPENAI_API_KEY ?? "",
    );
    qualifiedWorker = worker;
    const run = worker.run.bind(worker);
    worker.run = async (...args) => {
      try {
        return await run(...args);
      } catch (error) {
        const sites =
          error instanceof Error
            ? error.stack
                ?.split("\n")
                .slice(1, 4)
                .map((line) => line.replace(/.*\//, ""))
            : [];
        console.log(JSON.stringify({ qualificationFailureSites: sites }));
        throw error;
      }
    };
    return worker;
  },
  config.timeoutMs,
);
const token = randomBytes(32).toString("hex");
const line = new LineRuntime(store, vault, token, runtime);
const callId = `qualification_${randomUUID()}`;
const requestId = `local_${randomUUID()}`;
const goal =
  workflow === "messages"
    ? `Read the visible conversation with ${config.messages.destination} in Messages and give a brief summary.`
    : `Prepare a new unsent Codex draft in ${config.codex.destination} with this exact text: "ClawdTime integration qualification. Do not submit or run."`;
let timer: NodeJS.Timeout | undefined;
try {
  await line.command(token, { action: "open", callId });
  await line.command(token, {
    action: "execute",
    callId,
    requestId,
    text: goal,
  });
  let last = "",
    frames = 0;
  timer = setInterval(() => {
    void line
      .command(token, { action: "status", callId })
      .then((state) => {
        if (state.state !== last) {
          console.log(JSON.stringify({ state: state.state }));
          last = state.state;
        }
      })
      .catch(() => {});
  }, 3000);
  const video = setInterval(() => {
    void line
      .preview(token, callId)
      .then((frame) => {
        if (frame?.valid()) frames++;
      })
      .catch(() => {});
  }, 400);
  try {
    await runtime.waitForIdle();
  } finally {
    clearInterval(video);
  }
  const result = await line.command(token, { action: "status", callId });
  console.log(
    JSON.stringify({
      state: result.state,
      validVideoFrames: frames,
      captureStatus: qualifiedWorker?.captureStatus(),
      verificationStatus: qualifiedWorker?.verificationStatus(),
      message:
        result.state === "completed"
          ? "Independent workflow verification passed; private summary retained encrypted."
          : result.message,
    }),
  );
  if (result.state !== "completed") process.exitCode = 1;
} finally {
  if (timer) clearInterval(timer);
  await line.command(token, { action: "close", callId }).catch(() => {});
  await runtime.close();
  store.close();
}
