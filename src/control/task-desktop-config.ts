import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import { token } from "../storage/security.js";
import type { TaskService } from "./task-service.js";

export function desktopConfigurationFingerprint(value: {
  projectRoot: string;
  worker: "simulation" | "codex";
  checksFingerprint: string | null;
  port: number;
  sessionFingerprint?: string;
  callsFingerprint?: string;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectRoot: value.projectRoot,
        worker: value.worker,
        checksFingerprint: value.checksFingerprint,
        port: value.port,
        ...(value.sessionFingerprint
          ? { sessionFingerprint: value.sessionFingerprint }
          : {}),
        ...(value.callsFingerprint
          ? { callsFingerprint: value.callsFingerprint }
          : {}),
      }),
    )
    .digest("hex");
}
export function readDesktopPrivateBytes(path: string): Buffer {
  const parent = lstatSync(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    parent.mode & 0o077
  )
    throw Error("Owner-only desktop configuration required.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.uid !== process.getuid?.() ||
      s.mode & 0o077 ||
      s.size > 65536 ||
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid?.() ||
      parent.mode & 0o077
    )
      throw Error("Owner-only desktop configuration required.");
    const bytes = readFileSync(fd);
    if (bytes.length > 65536 || bytes.length !== s.size)
      throw Error("Desktop configuration changed during read.");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function readDesktopPrivateJSON(path: string) {
  return JSON.parse(readDesktopPrivateBytes(path).toString("utf8"));
}
export function writeDesktopPrivateJSON(path: string, value: unknown) {
  if (existsSync(path)) readDesktopPrivateJSON(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}
export function prepareTaskDesktop(
  service: TaskService,
  input: {
    directory: string;
    projectRoot: string;
    worker: "simulation" | "codex";
    port: number;
    checksPath?: string;
    checksBytes?: Buffer;
    sessionPath?: string;
    sessionBytes?: Buffer;
    callsPath?: string;
    callsBytes?: Buffer;
  },
) {
  const { directory, projectRoot, worker, port } = input;
  for (const path of [
    input.checksPath,
    input.sessionPath,
    input.callsPath,
  ].filter((p): p is string => !!p)) {
    const part = relative(projectRoot, realpathSync(path));
    if (
      part === "" ||
      (part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part))
    )
      throw Error(
        "Desktop checks and session files must be outside the worker project.",
      );
  }
  const sessionBytes = input.sessionPath
    ? (input.sessionBytes ?? readDesktopPrivateBytes(input.sessionPath))
    : undefined;
  let attachedToken: string | undefined;
  if (sessionBytes) {
    const saved = JSON.parse(sessionBytes.toString("utf8"));
    if (
      typeof saved.token !== "string" ||
      saved.token.length < 32 ||
      saved.token.length > 4096
    )
      throw Error("An existing task session capability is required.");
    const session = service.authenticate(saved.token);
    if (
      session.projectRoot !== projectRoot ||
      session.permissions.execute !== true
    )
      throw Error("Existing task session belongs to another project.");
    attachedToken = saved.token;
  }
  const configurationFingerprint = desktopConfigurationFingerprint({
    projectRoot,
    worker,
    port,
    ...(input.callsPath
      ? {
          callsFingerprint: createHash("sha256")
            .update(
              input.callsBytes ?? readDesktopPrivateBytes(input.callsPath),
            )
            .digest("hex"),
        }
      : {}),
    ...(sessionBytes
      ? {
          sessionFingerprint: createHash("sha256")
            .update(sessionBytes)
            .digest("hex"),
        }
      : {}),
    checksFingerprint: input.checksPath
      ? createHash("sha256")
          .update(
            input.checksBytes ?? readDesktopPrivateBytes(input.checksPath),
          )
          .digest("hex")
      : null,
  });
  const bindingPath = join(directory, "desktop-binding.json");
  const binding = existsSync(bindingPath)
    ? readDesktopPrivateJSON(bindingPath)
    : {
        version: 1,
        desktopId: `desktop_${randomUUID()}`,
        configurationFingerprint,
        uiToken: token(),
        registrationId: `desktop_${randomUUID()}`,
      };
  if (
    binding.version !== 1 ||
    binding.configurationFingerprint !== configurationFingerprint ||
    typeof binding.uiToken !== "string" ||
    binding.uiToken.length < 32 ||
    typeof binding.desktopId !== "string" ||
    typeof binding.registrationId !== "string"
  )
    throw Error(
      "Desktop configuration differs from this workspace. Preserve the existing binding.",
    );
  // Save the registration identity before any service mutation; restart recovers
  // the same registration receipt, never a second session or silent renewal.
  if (!existsSync(bindingPath)) writeDesktopPrivateJSON(bindingPath, binding);
  const sessionToken =
    attachedToken ??
    service.register({
      eventId: binding.registrationId,
      pairingId: "local-demo-pairing",
      hostId: "local-desktop",
      projectRoot,
      voice: false,
    }).token;
  const origin = `http://127.0.0.1:${port}`,
    instanceId = `instance_${randomUUID()}`;
  const receiptDirectory = join(directory, "desktop-receipts");
  mkdirSync(receiptDirectory, { recursive: true, mode: 0o700 });
  const rs = lstatSync(receiptDirectory);
  if (rs.isSymbolicLink() || rs.mode & 0o077 || rs.uid !== process.getuid?.())
    throw Error("Private panel receipt directory required.");
  const panelConfigPath = join(directory, "desktop-panel.json");
  writeDesktopPrivateJSON(panelConfigPath, {
    version: 1,
    desktopId: binding.desktopId,
    origin,
    token: binding.uiToken,
    projectRoot,
    receiptDirectory,
    configurationFingerprint,
  });
  return {
    config: {
      desktopId: binding.desktopId,
      instanceId,
      configurationFingerprint,
      token: binding.uiToken,
      sessionToken,
      worker,
    },
    descriptor: {
      version: 1,
      instanceId,
      pid: process.pid,
      origin,
      projectRoot,
      worker,
      panelConfigPath,
      configurationFingerprint,
    },
  };
}

/** Opt-in UI attachment inside the existing handset owner; never registers a session. */
export function prepareHandsetDesktop(
  service: TaskService,
  input: {
    directory: string;
    sessionToken: string;
    taskId: string;
    attemptId: string;
    worker: "simulation" | "codex";
  },
) {
  const session = service.authenticate(input.sessionToken);
  service.ledger.get(session.id, input.taskId);
  const directory = realpathSync(input.directory);
  const relativePath = relative(session.projectRoot, directory);
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077 ||
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(".." + sep) &&
      !isAbsolute(relativePath))
  )
    throw Error(
      "Handset panel state must be private and outside the worker project.",
    );
  const desktopId = `desktop_${randomUUID()}`;
  const configurationFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: session.id,
        taskId: input.taskId,
        attemptId: input.attemptId,
        projectRoot: session.projectRoot,
        worker: input.worker,
      }),
    )
    .digest("hex");
  const receiptDirectory = join(directory, "desktop-receipts");
  mkdirSync(receiptDirectory, { mode: 0o700 });
  const uiToken = token();
  const panelConfigPath = join(directory, "desktop-panel.json");
  writeDesktopPrivateJSON(panelConfigPath, {
    version: 1,
    desktopId,
    origin: "http://127.0.0.1:13323",
    token: uiToken,
    projectRoot: session.projectRoot,
    receiptDirectory,
    configurationFingerprint,
    boundTaskId: input.taskId,
  });
  return {
    panelConfigPath,
    config: {
      desktopId,
      instanceId: `instance_${randomUUID()}`,
      configurationFingerprint,
      token: uiToken,
      sessionToken: input.sessionToken,
      worker: input.worker,
      boundTaskId: input.taskId,
    },
  };
}
