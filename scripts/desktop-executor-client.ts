import {
  constants,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  lstatSync,
} from "node:fs";
import { dirname } from "node:path";
import { desktopExecutorConfigSchema } from "../src/control/desktop-executor.js";

/** Private original-chat client. Never accepts credentials or task prose on argv. */
async function main() {
  const [flag, path, action, id, state, extra] = process.argv.slice(2);
  if (
    flag !== "--config" ||
    !path ||
    !["inbox", "claim", "check", "finish", "reconcile"].includes(
      action ?? "",
    ) ||
    (action !== "inbox" && !id) ||
    extra
  )
    throw Error(
      "Use --config PRIVATE_FILE inbox, claim|check REQUEST_ID, or finish|reconcile REQUEST_ID STATE with JSON {summary,observed} on stdin.",
    );
  const directory = lstatSync(dirname(path));
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.mode & 0o077 ||
    directory.uid !== process.getuid?.()
  )
    throw Error("Private configuration directory required.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 8192
    )
      throw Error("Private configuration file required.");
    bytes = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  const config = desktopExecutorConfigSchema.parse(
    JSON.parse(bytes.toString("utf8")),
  );
  if (process.env.CODEX_THREAD_ID !== config.threadId)
    throw Error("This client must run in the connected original Codex chat.");
  let result: { summary: string; observed: boolean } | undefined;
  if (action === "finish" || action === "reconcile") {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 8192)
        throw Error("Private result input too large.");
    }
    const parsed = JSON.parse(input);
    result = { summary: parsed.summary, observed: parsed.observed };
  }
  const response = await fetch(`${config.origin}/executor/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action,
      ...(action === "inbox" ? {} : { id }),
      threadId: config.threadId,
      ...(result ? { state, ...result } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok)
    throw Error(
      `Executor refused the request (${response.status}); preserve the request ID.`,
    );
  console.log(JSON.stringify(await response.json()));
}
void main().catch((error) => {
  // No provider/configuration errors or credentials reach stdout.
  console.error(
    error instanceof Error &&
      /^(Use |Private |This client|Executor refused)/.test(error.message)
      ? error.message
      : "Executor response unavailable. Do not repeat work; check the original request.",
  );
  process.exitCode = 1;
});
