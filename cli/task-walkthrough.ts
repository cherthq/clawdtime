/** Thin task-service client. No capture, native input, provider or legacy chat adapter. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  taskPresentationManifestSchema,
  taskPresentationGrantSchema,
  taskSceneFrameSchema,
  taskPresentationCleanupSchema,
  taskPresentationFingerprint,
  type TaskPresentationManifest,
} from "../src/task-presentation-contracts.js";
import { secureRead, secureWrite } from "../connectors/shared/state.js";
import { taskOrigin } from "./tasks.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const sequence = z.number().int().nonnegative().safe();
const effectSchema = z
  .object({
    id,
    action: z.enum(["show_scene", "narrate", "stop"]),
    sceneId: id.optional(),
    generation: sequence,
    state: z.enum(["running", "done", "rejected", "unknown"]),
    startedAt: z.number().finite(),
    completedAt: z.number().finite().optional(),
    frame: taskSceneFrameSchema.optional(),
  })
  .strict();
const recordSchema = z
  .object({
    id,
    manifest: taskPresentationManifestSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    grant: taskPresentationGrantSchema,
    generation: sequence,
    state: z.enum([
      "prepared",
      "presenting",
      "visible",
      "narrating",
      "stopped",
      "unknown",
    ]),
    stoppedAt: z.number().finite().optional(),
    cleanup: taskPresentationCleanupSchema.optional(),
    activeSceneId: id.optional(),
    frame: taskSceneFrameSchema.optional(),
    effects: z.array(effectSchema).max(256),
    createdAt: z.number().finite(),
  })
  .strict();
const stopSchema = z
  .object({
    id,
    state: z.enum([
      "prepared",
      "presenting",
      "visible",
      "narrating",
      "stopped",
      "unknown",
    ]),
    generation: sequence,
    stoppedAt: z.number().finite().optional(),
    cleanup: taskPresentationCleanupSchema.optional(),
  })
  .strict();
const savedSchema = z
  .object({
    version: z.literal(1),
    origin: z.string(),
    sessionId: id,
    projectRoot: z.string(),
    manifest: taskPresentationManifestSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    prepareEventId: id,
    sceneEvents: z
      .array(z.object({ sceneId: id, show: id, narrate: id }).strict())
      .min(1)
      .max(12),
    stopEventId: id,
    startClaimed: z.boolean(),
    stopClaimed: z.boolean(),
  })
  .strict();
type Saved = z.infer<typeof savedSchema>;
const sessionSchema = z
  .object({
    version: z.literal(1),
    origin: z.string(),
    sessionId: id,
    token: z.string().min(32),
  })
  .strict();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const walkthroughFingerprint = taskPresentationFingerprint;

function privateRead(file: string): unknown {
  if (lstatSync(file).size > 1_048_576)
    throw Error("Protected walkthrough input exceeds its bound.");
  return secureRead(file);
}
function save(file: string, value: Saved) {
  secureWrite(file, value);
  for (const path of [file, dirname(file)]) {
    const descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
function locked<T>(file: string, work: () => T): T {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Error("Walkthrough state requires an owner-only directory.");
  const lock = `${file}.lock`;
  const descriptor = openSync(
    lock,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_WRONLY,
    0o600,
  );
  try {
    return work();
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}

/** Hash only explicitly named regular artifacts beneath the selected project. */
export function validateWalkthroughArtifacts(
  manifest: TaskPresentationManifest,
  project: string,
) {
  const root = realpathSync(project);
  if (!lstatSync(root).isDirectory())
    throw Error("Selected project must be a directory.");
  for (const scene of manifest.scenes) {
    if (!scene.artifact) continue;
    const name = scene.artifact.relativePath;
    if (
      isAbsolute(name) ||
      name.split(/[\\/]/).some((part) => part === ".." || part === "")
    )
      throw Error("Scene artifact must be an explicit project-relative path.");
    const file = resolve(root, name),
      actual = realpathSync(file),
      within = relative(root, actual);
    if (
      !within ||
      within === ".." ||
      within.startsWith(`..${sep}`) ||
      isAbsolute(within) ||
      actual !== file
    )
      throw Error(
        "Scene artifact must not escape the project or follow symbolic links.",
      );
    const descriptor = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 4_194_304)
        throw Error("Scene artifact must be a bounded regular file.");
      if (
        createHash("sha256").update(readFileSync(descriptor)).digest("hex") !==
        scene.artifact.sha256
      )
        throw Error(
          "Scene artifact changed; prepare a new manifest and grant.",
        );
    } finally {
      closeSync(descriptor);
    }
  }
  return root;
}

export async function taskWalkthroughCli(
  args: string[],
  dependencies: {
    request?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    print?: (value: string) => void;
  } = {},
) {
  const command = args[0]!;
  const allowed =
    command === "walkthrough-prepare"
      ? [
          "id",
          "plan-file",
          "grant-file",
          "project",
          "session-file",
          "event-id",
          "save",
        ]
      : ["walkthrough-file", "session-file"];
  if (
    ![
      "walkthrough-prepare",
      "walkthrough-start",
      "walkthrough-status",
      "walkthrough-stop",
    ].includes(command)
  )
    throw Error("Unknown walkthrough command; use task help.");
  const options: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, ""),
      value = args[i + 1];
    if (
      !args[i]?.startsWith("--") ||
      !key ||
      !allowed.includes(key) ||
      options[key] !== undefined ||
      !value ||
      value.startsWith("--")
    )
      throw Error("Use each supported --option value once.");
    options[key] = value;
  }
  const required = (key: string) => {
    if (!options[key]) throw Error(`Missing --${key}.`);
    return options[key]!;
  };
  const session = sessionSchema.parse(privateRead(required("session-file")));
  const origin = taskOrigin(
    (dependencies.env ?? process.env).CLAWDTIME_TASK_URL ?? session.origin,
  );
  if (origin !== session.origin)
    throw Error("Session file belongs to another task service.");
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > 32768)
      throw Error("Walkthrough request exceeds its bound.");
    let response: Response;
    try {
      response = await (dependencies.request ?? fetch)(origin + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(
          path.endsWith("/narrate") ? 125_000 : 30_000,
        ),
        body: encoded,
      });
    } catch {
      throw Error(
        "Walkthrough outcome unconfirmed; inspect the original status. No retry was attempted.",
      );
    }
    if (!response.ok)
      throw Error(
        `Walkthrough request refused (HTTP ${response.status}); inspect original status before any further effect.`,
      );
    const reader = response.body?.getReader();
    if (!reader)
      throw Error("Walkthrough response missing; inspect original status.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_048_576) {
        await reader.cancel();
        throw Error("Walkthrough response exceeds its bound.");
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Error("Walkthrough response invalid; inspect original status.");
    }
  };
  const file = resolve(
    required(command === "walkthrough-prepare" ? "save" : "walkthrough-file"),
  );
  let saved: Saved;
  if (command === "walkthrough-prepare") {
    const manifest = taskPresentationManifestSchema.parse(
      privateRead(required("plan-file")),
    );
    const grant = taskPresentationGrantSchema.parse(
      privateRead(required("grant-file")),
    );
    const fingerprint = walkthroughFingerprint(manifest);
    if (
      manifest.taskId !== required("id") ||
      manifest.sessionId !== session.sessionId ||
      grant.manifestFingerprint !== fingerprint ||
      grant.sessionId !== session.sessionId ||
      grant.taskId !== manifest.taskId ||
      grant.runId !== manifest.runId ||
      grant.taskRevision !== manifest.taskRevision
    )
      throw Error(
        "Manifest, grant and task session identity must match exactly.",
      );
    const projectRoot = validateWalkthroughArtifacts(
      manifest,
      required("project"),
    );
    const task = (await request(
      `/tasks/${encodeURIComponent(manifest.taskId)}`,
    )) as Record<string, unknown>;
    if (
      task.id !== manifest.taskId ||
      task.sessionId !== session.sessionId ||
      task.projectRoot !== projectRoot ||
      task.revision !== manifest.taskRevision
    )
      throw Error("Manifest must match the current task and selected project.");
    saved = savedSchema.parse({
      version: 1,
      origin,
      sessionId: session.sessionId,
      projectRoot,
      manifest,
      fingerprint,
      prepareEventId: id.parse(required("event-id")),
      sceneEvents: manifest.scenes.map((scene) => ({
        sceneId: scene.id,
        show: randomUUID(),
        narrate: randomUUID(),
      })),
      stopEventId: randomUUID(),
      startClaimed: false,
      stopClaimed: false,
    });
    locked(file, () => {
      if (existsSync(file))
        throw Error(
          "Walkthrough state already exists; inspect its original status instead of preparing again.",
        );
      save(file, saved);
    });
    const result = recordSchema.parse(
      await request(
        `/tasks/${encodeURIComponent(manifest.taskId)}/presentations`,
        { eventId: saved.prepareEventId, manifest, grant },
      ),
    );
    assertRecord(result, saved);
    if (result.state !== "prepared" || result.effects.length)
      throw Error("Walkthrough was not prepared without effects.");
    (dependencies.print ?? console.log)(
      JSON.stringify({
        walkthroughFile: file,
        presentationId: result.id,
        state: result.state,
      }),
    );
    return;
  }
  saved = savedSchema.parse(privateRead(file));
  if (
    saved.origin !== origin ||
    saved.sessionId !== session.sessionId ||
    saved.manifest.sessionId !== session.sessionId ||
    saved.fingerprint !== walkthroughFingerprint(saved.manifest) ||
    saved.sceneEvents.length !== saved.manifest.scenes.length ||
    saved.sceneEvents.some(
      (event, i) => event.sceneId !== saved.manifest.scenes[i]?.id,
    )
  )
    throw Error("Walkthrough state belongs to another session or manifest.");
  const base = `/tasks/${encodeURIComponent(saved.manifest.taskId)}/presentations/${encodeURIComponent(saved.manifest.id)}`;
  const get = async () => {
    const value = recordSchema.parse(await request(base));
    assertRecord(value, saved);
    return value;
  };
  const claim = (field: "startClaimed" | "stopClaimed") =>
    locked(file, () => {
      const current = savedSchema.parse(privateRead(file));
      if (
        canonical({ ...current, startClaimed: false, stopClaimed: false }) !==
        canonical({ ...saved, startClaimed: false, stopClaimed: false })
      )
        throw Error("Walkthrough state changed; inspect original status.");
      if (current[field] || (field === "startClaimed" && current.stopClaimed))
        throw Error(
          "Walkthrough operation already claimed; inspect status without replaying it.",
        );
      current[field] = true;
      save(file, current);
    });
  if (command === "walkthrough-stop") {
    // Cleanup remains available after task authority expires. Do not require
    // a full-status read (which would reveal protected prose after expiry).
    claim("stopClaimed");
    const stopped = stopSchema.parse(
      await request(`${base}/stop`, { eventId: saved.stopEventId }),
    );
    if (
      stopped.id !== saved.manifest.id ||
      stopped.state !== "stopped" ||
      !stopped.cleanup
    )
      throw Error("Walkthrough cleanup unconfirmed; inspect original status.");
    (dependencies.print ?? console.log)(JSON.stringify(stopped, null, 2));
    return;
  }
  let result = await get();
  if (command === "walkthrough-start") {
    if (
      result.state !== "prepared" ||
      result.effects.length ||
      result.generation !== 0
    )
      throw Error(
        "Only a fresh prepared walkthrough with no prior effects can start.",
      );
    validateWalkthroughArtifacts(saved.manifest, saved.projectRoot);
    claim("startClaimed");
    for (const event of saved.sceneEvents) {
      if (savedSchema.parse(privateRead(file)).stopClaimed)
        throw Error("Walkthrough was stopped; no further scenes may run.");
      const generation: number = result.generation + 1;
      const shown = recordSchema.parse(
        await request(`${base}/scenes`, {
          eventId: event.show,
          expectedGeneration: result.generation,
          sceneId: event.sceneId,
        }),
      );
      assertRecord(shown, saved);
      assertVisible(shown, saved, event.sceneId, generation, event.show);
      result = await get();
      assertVisible(result, saved, event.sceneId, generation, event.show);
      if (savedSchema.parse(privateRead(file)).stopClaimed)
        throw Error("Walkthrough was stopped; narration may not begin.");
      result = recordSchema.parse(
        await request(`${base}/narrate`, {
          eventId: event.narrate,
          expectedGeneration: generation,
          sceneId: event.sceneId,
        }),
      );
      assertRecord(result, saved);
      if (
        result.generation !== generation ||
        result.state !== "visible" ||
        !result.effects.some(
          (effect) =>
            effect.id === event.narrate &&
            effect.action === "narrate" &&
            effect.sceneId === event.sceneId &&
            effect.generation === generation &&
            effect.state === "done",
        )
      )
        throw Error(
          "Narration completion unconfirmed; inspect original status.",
        );
    }
  }
  (dependencies.print ?? console.log)(JSON.stringify(result, null, 2));
}

function assertRecord(record: z.infer<typeof recordSchema>, saved: Saved) {
  if (
    record.id !== saved.manifest.id ||
    record.fingerprint !== saved.fingerprint ||
    walkthroughFingerprint(record.manifest) !== saved.fingerprint ||
    record.grant.manifestFingerprint !== saved.fingerprint
  )
    throw Error(
      "Walkthrough response identity mismatch; preserve original receipts.",
    );
}
function assertVisible(
  record: z.infer<typeof recordSchema>,
  saved: Saved,
  sceneId: string,
  generation: number,
  operationId: string,
) {
  const frame = record.frame,
    scene = saved.manifest.scenes.find((item) => item.id === sceneId)!;
  if (
    record.state !== "visible" ||
    record.activeSceneId !== sceneId ||
    record.generation !== generation ||
    !frame ||
    frame.presentationId !== record.id ||
    frame.manifestFingerprint !== saved.fingerprint ||
    frame.sceneId !== sceneId ||
    frame.generation !== generation ||
    frame.operationId !== operationId ||
    canonical(frame.target) !== canonical(scene.target) ||
    !record.effects.some(
      (effect) =>
        effect.id === operationId &&
        effect.state === "done" &&
        effect.action === "show_scene" &&
        effect.generation === generation,
    )
  )
    throw Error("Scene render proof unconfirmed; narration was not requested.");
}
