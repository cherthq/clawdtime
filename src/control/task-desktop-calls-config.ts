import { z } from "zod";
import {
  taskPresentationManifestSchema,
  taskPresentationGrantSchema,
} from "../task-presentation-contracts.js";

const path = z.string().min(1).max(4096).startsWith("/");
const text = z.string().min(1).max(4096);
const id = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
const port = z.number().int().min(1024).max(65535);
export const handsetPortsSchema = z
  .object({ task: port, media: port, stop: port })
  .strict()
  .refine(
    (v) => new Set(Object.values(v)).size === 3,
    "Call runtime ports must be distinct.",
  );
export const desktopCallsConfigSchema = z
  .object({
    version: z.literal(1),
    providerFile: path,
    livekitFile: path,
    inspectorBundle: path,
    python: path,
    helperBinary: path,
    attemptRoot: path,
    ports: handsetPortsSchema.optional(),
    native: z
      .object({
        callsOrigin: text,
        projectId: text,
        projectKey: text,
        recipient: text,
        lineId: z.string().uuid(),
      })
      .strict(),
    destination: z
      .object({
        pairingId: text,
        memberId: text,
        deviceId: text,
        lineId: z.string().uuid(),
        recipientHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    railway: z
      .object({
        binary: path,
        projectId: z.string().uuid(),
        environmentId: z.string().uuid(),
        backendServiceId: z.string().uuid(),
        deploymentId: z.string().uuid(),
        restoreRecord: text,
      })
      .strict(),
  })
  .strict();
export type DesktopCallsConfig = z.infer<typeof desktopCallsConfigSchema>;

/** Only the protected operator may submit this. The UI capability grants no calls. */
export const desktopCallRequestSchema = z
  .object({
    eventId: id,
    taskId: id,
    runId: id,
    expectedRevision: z.number().int().nonnegative().safe(),
    authorizationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    authorizedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().nonnegative().safe(),
    callDurationMs: z.number().int().min(30_000).max(900_000),
    userAuthorizedOneCall: z.literal(true),
    userAuthorizedPreparedWindowExport: z.literal(true),
    userAuthorizedTaskInstructions: z.literal(true),
    prepared: z
      .object({
        manifest: taskPresentationManifestSchema,
        grant: taskPresentationGrantSchema,
      })
      .strict(),
  })
  .strict();
export type DesktopCallRequest = z.infer<typeof desktopCallRequestSchema>;
