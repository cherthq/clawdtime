import { z } from "zod";
import { DomainError } from "../storage/security.js";
import { jsonRequest } from "./native-messages.js";
import {
  taskPresentationFingerprint,
  taskPresentationManifestSchema,
  taskPresentationGrantSchema,
  taskSceneFrameSchema,
  taskPresentationCleanupSchema,
  type TaskPresentationHost,
  type TaskPresentationManifest,
} from "../task-presentation-contracts.js";
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const sequence = z.number().int().nonnegative().safe();
const showSchema = z
  .object({
    presentationId: identity,
    operationId: identity,
    manifestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sceneId: identity,
    generation: sequence,
  })
  .strict();

/** One fixed loopback renderer. No redirect, retry, native input or call capability. */
export class HTTPTaskPresentationHost implements TaskPresentationHost {
  private readonly manifests = new Map<string, TaskPresentationManifest>();
  constructor(
    private readonly config: { origin: string; token: string },
    private readonly request: typeof fetch = fetch,
  ) {
    const url = new URL(config.origin);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.origin !== config.origin ||
      url.username ||
      url.password ||
      !url.port ||
      Number(url.port) < 1024 ||
      config.token.length < 32 ||
      config.token.length > 200
    )
      throw new DomainError(
        400,
        "Exact protected loopback presentation host is required.",
      );
  }
  private api(path: string, body: unknown, timeoutMs: number) {
    return jsonRequest(
      this.config.origin + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.config.token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      this.request,
      timeoutMs,
    );
  }
  async prepare(input: Parameters<TaskPresentationHost["prepare"]>[0]) {
    const parsed = z
      .object({
        presentationId: identity,
        manifest: taskPresentationManifestSchema,
        grant: taskPresentationGrantSchema,
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(input);
    if (
      parsed.presentationId !== parsed.manifest.id ||
      taskPresentationFingerprint(parsed.manifest) !== parsed.fingerprint ||
      parsed.grant.manifestFingerprint !== parsed.fingerprint
    )
      throw new DomainError(409, "Presentation binding differs.");
    const prior = this.manifests.get(parsed.presentationId);
    if (prior && taskPresentationFingerprint(prior) !== parsed.fingerprint)
      throw new DomainError(
        409,
        "Prepared presentation identity cannot be rebound.",
      );
    const result = z
      .object({ ready: z.literal(true) })
      .strict()
      .parse(await this.api("/prepare", parsed, 10000));
    this.manifests.set(parsed.presentationId, parsed.manifest);
    return result;
  }
  private bound(presentationId: string) {
    identity.parse(presentationId);
    const manifest = this.manifests.get(presentationId);
    if (!manifest)
      throw new DomainError(
        409,
        "Prepare the exact presentation host before use.",
      );
    return manifest;
  }
  private frame(presentationId: string, raw: unknown) {
    const manifest = this.bound(presentationId),
      frame = taskSceneFrameSchema.parse(raw),
      scene = manifest.scenes.find((s) => s.id === frame.sceneId);
    if (
      frame.presentationId !== presentationId ||
      frame.manifestFingerprint !== taskPresentationFingerprint(manifest) ||
      !scene ||
      JSON.stringify(frame.target) !== JSON.stringify(scene.target)
    )
      throw new DomainError(409, "Presentation frame binding differs.");
    return frame;
  }
  async show(input: Parameters<TaskPresentationHost["show"]>[0]) {
    const parsed = showSchema.parse(input),
      manifest = this.bound(parsed.presentationId);
    if (
      parsed.manifestFingerprint !== taskPresentationFingerprint(manifest) ||
      !manifest.scenes.some((s) => s.id === parsed.sceneId)
    )
      throw new DomainError(409, "Unknown exact presentation scene.");
    const frame = this.frame(
      parsed.presentationId,
      await this.api("/show", parsed, 10000),
    );
    if (
      frame.operationId !== parsed.operationId ||
      frame.sceneId !== parsed.sceneId ||
      frame.generation !== parsed.generation
    )
      throw new DomainError(409, "Presentation effect response differs.");
    return frame;
  }
  async observe(presentationId: string) {
    this.bound(presentationId);
    return this.frame(
      presentationId,
      await this.api(
        `/observe?presentationId=${encodeURIComponent(presentationId)}`,
        undefined,
        5000,
      ),
    );
  }
  async narrate(input: Parameters<TaskPresentationHost["narrate"]>[0]) {
    const parsed = z
      .object({
        presentationId: identity,
        operationId: identity,
        sceneId: identity,
        generation: sequence,
        frame: taskSceneFrameSchema,
        text: z.string().min(1).max(1600),
      })
      .strict()
      .parse(input);
    const manifest = this.bound(parsed.presentationId),
      scene = manifest.scenes.find((s) => s.id === parsed.sceneId),
      frame = this.frame(parsed.presentationId, parsed.frame);
    if (
      !scene ||
      parsed.text !== scene.narration ||
      frame.sceneId !== scene.id ||
      frame.generation !== parsed.generation
    )
      throw new DomainError(
        409,
        "Narration must match the exact prepared visible scene.",
      );
    return z
      .object({
        completed: z.literal(true),
        evidence: z.literal("playback_completed_not_audibility"),
      })
      .strict()
      .parse(await this.api("/narrate", parsed, 120000));
  }
  async stop(presentationId: string) {
    // Cleanup is available even when preparation response was lost.
    identity.parse(presentationId);
    return taskPresentationCleanupSchema.parse(
      await this.api("/stop", { presentationId }, 15000),
    );
  }
}
