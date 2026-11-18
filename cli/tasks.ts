import { join } from "node:path";
import { z } from "zod";
import {
  secureRead,
  secureWrite,
  stateDirectory,
} from "../connectors/shared/state.js";

const sessionFileSchema = z
  .object({
    version: z.literal(1),
    origin: z.string(),
    sessionId: z.string(),
    token: z.string().min(32),
  })
  .strict();
const voiceFileSchema = z
  .object({
    version: z.literal(1),
    taskOrigin: z.string(),
    taskId: z.string().min(1),
    voiceSessionId: z.string().min(1),
    voiceToken: z.string().min(32),
  })
  .strict();

/** Independent tasks never inherit the original-chat connection or its permissions. */
export function taskOrigin(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "The task service must be an explicit loopback HTTP origin.",
    );
  return url.origin;
}

function flags(args: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (
      !key?.startsWith("--") ||
      !value ||
      value.startsWith("--") ||
      result[key.slice(2)] !== undefined
    )
      throw new Error("Use each --option value once.");
    result[key.slice(2)] = value;
  }
  return result;
}

export async function taskCli(
  args: string[],
  dependencies: {
    request?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    print?: (value: string) => void;
  } = {},
) {
  const print = dependencies.print ?? console.log;
  const command = args[0] ?? "help";
  if (command === "help" || command === "--help") {
    print(
      "Independent local tasks (simulation by default)\n" +
        "task register --pairing-id ID --host-id ID --project PATH --event-id ID [--voice true|false] [--operator-file PRIVATE_PATH] [--save PRIVATE_PATH]\n" +
        "task create --goal TEXT --event-id ID [--session-file PRIVATE_PATH]\n" +
        "task status --id ID [--session-file PRIVATE_PATH]\n" +
        "task readiness --id ID [--session-file PRIVATE_PATH]\n" +
        "task reauthorize --session-file PRIVATE_PATH --operator-file PRIVATE_PATH --pairing-id ID --host-id ID --project PATH --voice true|false --event-id ID\n" +
        "task run --id ID [--session-file PRIVATE_PATH]\n" +
        "task command --id ID --json JSON [--session-file PRIVATE_PATH]\n" +
        "task voice-start --id TASK_ID --run-id RUN_ID --revision NUMBER --event-id ID [--session-file PRIVATE_PATH] [--save PRIVATE_PATH]\n" +
        "task voice-status --voice-file PRIVATE_PATH\n" +
        "task voice-stop --voice-file PRIVATE_PATH --event-id ID\n" +
        "Use CLAWDTIME_TASK_URL (default http://127.0.0.1:3320). Registration uses an operator credential; reauthorization requires both protected files. Other commands use task or voice credentials. Readiness never renews authority. Never put credentials in arguments. Preserve event IDs when reconciling a lost response; this CLI never retries writes.",
    );
    return;
  }
  const options = flags(args.slice(1));
  const allowed: Record<string, string[]> = {
    register: [
      "pairing-id",
      "host-id",
      "project",
      "event-id",
      "save",
      "operator-file",
      "voice",
    ],
    create: ["goal", "event-id", "session-file"],
    status: ["id", "session-file"],
    readiness: ["id", "session-file"],
    reauthorize: [
      "session-file",
      "operator-file",
      "pairing-id",
      "host-id",
      "project",
      "voice",
      "event-id",
    ],
    run: ["id", "session-file"],
    command: ["id", "json", "session-file"],
    "voice-start": [
      "id",
      "run-id",
      "revision",
      "event-id",
      "session-file",
      "save",
    ],
    "voice-status": ["voice-file"],
    "voice-stop": ["voice-file", "event-id"],
  };
  if (
    !allowed[command] ||
    Object.keys(options).some((key) => !allowed[command]!.includes(key))
  )
    throw new Error("Unknown task command or option; use task help.");
  const required = (name: string) => {
    const value = options[name];
    if (!value) throw new Error(`Missing --${name}.`);
    return value;
  };
  const env = dependencies.env ?? process.env;
  if (command === "reauthorize") {
    required("session-file");
    required("operator-file");
  }
  const saved = options["session-file"]
    ? sessionFileSchema.parse(secureRead(options["session-file"]))
    : undefined;
  const voice =
    command === "voice-status" || command === "voice-stop"
      ? voiceFileSchema.parse(secureRead(required("voice-file")))
      : undefined;
  const origin = taskOrigin(
    env.CLAWDTIME_TASK_URL ??
      saved?.origin ??
      voice?.taskOrigin ??
      "http://127.0.0.1:3320",
  );
  if (saved && saved.origin !== origin)
    throw new Error("Session file belongs to another task service.");
  if (voice && voice.taskOrigin !== origin)
    throw new Error("Voice file belongs to another task service.");
  const operator = options["operator-file"]
    ? z
        .object({ token: z.string().min(32) })
        .strict()
        .parse(secureRead(options["operator-file"]))
    : undefined;
  const token =
    command === "reauthorize"
      ? operator?.token
      : (voice?.voiceToken ??
        saved?.token ??
        operator?.token ??
        env.CLAWDTIME_TASK_TOKEN);
  if (!token || token.length < 32)
    throw new Error(
      "A protected task session file or CLAWDTIME_TASK_TOKEN is required.",
    );
  let path: string, body: unknown;
  switch (command) {
    case "reauthorize":
      if (!["true", "false"].includes(required("voice")))
        throw new Error("--voice must be true or false.");
      path = `/sessions/${encodeURIComponent(saved!.sessionId)}/reauthorize`;
      body = {
        eventId: required("event-id"),
        pairingId: required("pairing-id"),
        hostId: required("host-id"),
        projectRoot: required("project"),
        voice: options.voice === "true",
      };
      break;
    case "register":
      if (
        options.voice !== undefined &&
        !["true", "false"].includes(options.voice)
      )
        throw new Error("--voice must be true or false.");
      path = "/sessions";
      body = {
        pairingId: required("pairing-id"),
        hostId: required("host-id"),
        projectRoot: required("project"),
        voice: options.voice === "true",
        eventId: required("event-id"),
      };
      break;
    case "create":
      path = "/tasks";
      body = { eventId: required("event-id"), goal: required("goal") };
      break;
    case "status":
      path = `/tasks/${encodeURIComponent(required("id"))}`;
      break;
    case "readiness":
      path = `/tasks/${encodeURIComponent(required("id"))}/readiness`;
      break;
    case "run":
      path = `/tasks/${encodeURIComponent(required("id"))}/run`;
      body = {};
      break;
    case "voice-start": {
      const revision = Number(required("revision"));
      if (!Number.isSafeInteger(revision) || revision < 0)
        throw new Error("--revision must be a nonnegative integer.");
      path = `/tasks/${encodeURIComponent(required("id"))}/voice-sessions`;
      body = {
        eventId: required("event-id"),
        runId: required("run-id"),
        expectedRevision: revision,
      };
      break;
    }
    case "voice-status":
    case "voice-stop":
      path = `/tasks/${encodeURIComponent(voice!.taskId)}/voice/${encodeURIComponent(voice!.voiceSessionId)}/${command === "voice-status" ? "context" : "end"}`;
      if (command === "voice-stop") body = { eventId: required("event-id") };
      break;
    default:
      path = `/tasks/${encodeURIComponent(required("id"))}/commands`;
      try {
        body = JSON.parse(required("json"));
      } catch {
        throw new Error("--json must be a valid task command object.");
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("--json must be a task command object.");
  }
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  if (requestBody && Buffer.byteLength(requestBody) > 32_768)
    throw new Error("Task request exceeds the 32 KiB limit.");
  let response: Response;
  try {
    response = await (dependencies.request ?? fetch)(origin + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
      body: requestBody,
    });
  } catch {
    throw new Error(
      "Task service response unavailable. Preserve the event ID and inspect task state; no retry was attempted.",
    );
  }
  if (!response.ok)
    throw new Error(
      `Task service rejected the request (HTTP ${response.status}); inspect current state before another action.`,
    );
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Task service returned no response body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 1_048_576) {
      await reader.cancel();
      throw new Error("Task service response exceeds the bound.");
    }
    chunks.push(value);
  }
  let value: any;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error(
      "Task service returned an invalid response; preserve the original event ID.",
    );
  }
  if (command === "register") {
    const session = sessionFileSchema.parse({
      version: 1,
      origin,
      sessionId: value.session?.id,
      token: value.token,
    });
    const file =
      options.save ??
      join(
        stateDirectory(),
        "tasks",
        `${session.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`,
      );
    secureWrite(file, session);
    print(JSON.stringify({ session: value.session, sessionFile: file }));
  } else if (command === "voice-start") {
    if (value.voice?.taskId !== required("id"))
      throw new Error("Voice response belongs to another task.");
    const credentials = voiceFileSchema.parse({
      version: 1,
      taskOrigin: origin,
      taskId: required("id"),
      voiceSessionId: value.voice?.id,
      voiceToken: value.token,
    });
    const file =
      options.save ??
      join(
        stateDirectory(),
        "task-voice",
        `${credentials.voiceSessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`,
      );
    secureWrite(file, credentials);
    print(JSON.stringify({ voice: value.voice, voiceFile: file }));
  } else {
    // Task endpoints never return credentials; reject unexpected credential responses.
    if (
      value &&
      typeof value === "object" &&
      ("token" in value || "voiceToken" in value)
    )
      throw new Error("Unexpected credential in task response.");
    print(JSON.stringify(value, null, 2));
  }
}
