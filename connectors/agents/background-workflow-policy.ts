import { z } from "zod";

const identity = z.string().min(1).max(256);
const text = z
  .string()
  .min(1)
  .max(512)
  // Newlines, tabs, terminal escapes and Unicode line separators are not text
  // entry capabilities: a native app may interpret them as Submit/navigation.
  .refine((value) => !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(value));

/** Trusted control-service identity; never construct from model/surface labels. */
export const backgroundWorkflowBindingSchema = z
  .object({
    callId: identity,
    taskId: identity,
    toolCallId: identity,
    driverInstanceId: identity,
    driverGeneration: identity,
    driverVersion: identity,
    bundleId: identity,
    pid: z.number().int().positive(),
    processStartIdentity: identity,
    windowId: identity,
    observationId: identity,
    observationFingerprint: identity,
  })
  .strict();
export type BackgroundWorkflowBinding = z.infer<
  typeof backgroundWorkflowBindingSchema
>;

const elementToken = identity;
const coordinate = z.number().finite().min(0).max(32768);
export const backgroundEditorGeometrySchema = z
  .object({
    editorId: identity,
    screenshotWidth: z.number().int().positive().max(32768),
    screenshotHeight: z.number().int().positive().max(32768),
    bounds: z
      .object({
        x: coordinate,
        y: coordinate,
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
      })
      .strict(),
  })
  .strict()
  .superRefine((geometry, context) => {
    if (
      geometry.bounds.x + geometry.bounds.width > geometry.screenshotWidth ||
      geometry.bounds.y + geometry.bounds.height > geometry.screenshotHeight
    )
      context.addIssue({
        code: "custom",
        message: "Editor is outside the original screenshot.",
      });
  });
// No Enter, Return, Tab, Space, modifiers, shortcuts, launch, shell or script.
// Even these editing keys require an exact observed editor capability below.
const editKey = z.enum([
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "Backspace",
  "Delete",
]);
export const backgroundWorkflowActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("pixel-type"),
      editorId: identity,
      x: coordinate,
      y: coordinate,
      text,
    })
    .strict(),
  z.object({ type: z.literal("click"), elementToken }).strict(),
  z.object({ type: z.literal("type"), elementToken, text }).strict(),
  z.object({ type: z.literal("key"), elementToken, key: editKey }).strict(),
  z
    .object({
      type: z.literal("scroll"),
      elementToken,
      deltaY: z
        .number()
        .int()
        .min(-500)
        .max(500)
        .refine((value) => value !== 0),
    })
    .strict(),
]);
export type BackgroundWorkflowAction = z.infer<
  typeof backgroundWorkflowActionSchema
>;

const capabilitySchema = z.discriminatedUnion("purpose", [
  z
    .object({
      purpose: z.literal("pixel-draft"),
      geometry: backgroundEditorGeometrySchema,
      allowedText: text,
    })
    .strict(),
  z
    .object({
      purpose: z.literal("navigate"),
      elementToken,
      // Installed, independently qualified control mappings only. A Send button
      // with an innocent label does not become one of these capabilities.
      operation: z.enum([
        "select-test-conversation",
        "new-chat",
        "focus-search",
      ]),
    })
    .strict(),
  z
    .object({
      purpose: z.literal("search"),
      elementToken,
      allowedText: text,
    })
    .strict(),
  z
    .object({
      purpose: z.literal("draft"),
      elementToken,
      allowedText: text,
      keys: z.array(editKey).max(6),
    })
    .strict(),
  z
    .object({
      purpose: z.literal("read-scroll"),
      elementToken,
      maxDeltaY: z.number().int().min(1).max(500),
    })
    .strict(),
]);

/**
 * Created by a qualified app adapter from operator scope and fresh native state.
 * This is NOT an LLM output schema. App labels/roles alone cannot mint a grant.
 * Keep it transient; persist only the existing encrypted action receipt.
 */
export const backgroundWorkflowGrantSchema = z
  .object({
    workflow: z.enum([
      "messages-read",
      "codex-draft",
      "email-read",
      "email-draft",
    ]),
    qualificationId: identity,
    // Trusted opaque identity for the selected account/conversation/project.
    // The adapter must independently re-observe this destination before dispatch.
    destinationId: identity,
    binding: backgroundWorkflowBindingSchema,
    observedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    capabilities: z.array(capabilitySchema).max(64),
  })
  .strict()
  .superRefine((grant, context) => {
    if (
      grant.expiresAt <= grant.observedAt ||
      grant.expiresAt - grant.observedAt > 5000
    )
      context.addIssue({
        code: "custom",
        message: "Observation grant exceeds its freshness bound.",
      });
    if (
      new Set(
        grant.capabilities.map((item) =>
          item.purpose === "pixel-draft"
            ? `pixel:${item.geometry.editorId}`
            : `element:${item.elementToken}`,
        ),
      ).size !== grant.capabilities.length
    )
      context.addIssue({
        code: "custom",
        message: "Element capability is ambiguous.",
      });
    for (const capability of grant.capabilities) {
      if (
        (grant.workflow === "messages-read" ||
          grant.workflow === "email-read") &&
        (capability.purpose === "draft" || capability.purpose === "pixel-draft")
      )
        context.addIssue({
          code: "custom",
          message: "Read-only workflows cannot write a draft.",
        });
      if (
        capability.purpose === "navigate" &&
        ((capability.operation === "new-chat" &&
          grant.workflow !== "codex-draft") ||
          (capability.operation === "select-test-conversation" &&
            grant.workflow !== "messages-read"))
      )
        context.addIssue({
          code: "custom",
          message: "Navigation does not match the workflow.",
        });
    }
  });
export type BackgroundWorkflowGrant = z.infer<
  typeof backgroundWorkflowGrantSchema
>;

export const backgroundWorkflowRequestSchema = z
  .object({
    binding: backgroundWorkflowBindingSchema,
    destinationId: identity,
    delivery: z.literal("background"),
    action: backgroundWorkflowActionSchema,
  })
  .strict();
export type BackgroundWorkflowRequest = z.infer<
  typeof backgroundWorkflowRequestSchema
>;
export type BackgroundWorkflowDecision =
  | { allowed: true; request: BackgroundWorkflowRequest }
  | {
      allowed: false;
      code:
        | "invalid_capability"
        | "stopped"
        | "stale_observation"
        | "target_changed"
        | "action_not_granted";
    };

/**
 * Final-dispatch defense in depth. The controller must still enforce admission,
 * a live lease, shared execution ownership, durable dedupe and the driver's own
 * protections. Allowed means permission to attempt one action, never UI success.
 * Throws no model/surface text into logs. Does not invoke, retry or fall back.
 */
export function admitBackgroundWorkflowAction(input: {
  grant: unknown;
  request: unknown;
  currentBinding: unknown;
  currentDestinationId: string;
  qualifications: readonly {
    id: string;
    workflow: BackgroundWorkflowGrant["workflow"];
    bundleId: string;
    driverVersion: string;
    pixelDraft?: true;
  }[];
  /** Independently resolved current editor geometry, never model-supplied. */
  currentEditorGeometry?: unknown;
  now: number;
  signal: AbortSignal;
}): BackgroundWorkflowDecision {
  if (input.signal.aborted) return { allowed: false, code: "stopped" };
  const grant = backgroundWorkflowGrantSchema.safeParse(input.grant);
  const request = backgroundWorkflowRequestSchema.safeParse(input.request);
  const current = backgroundWorkflowBindingSchema.safeParse(
    input.currentBinding,
  );
  if (
    !grant.success ||
    !request.success ||
    !current.success ||
    !input.qualifications.some(
      (qualification) =>
        qualification.id === grant.data.qualificationId &&
        qualification.workflow === grant.data.workflow &&
        qualification.bundleId === grant.data.binding.bundleId &&
        qualification.driverVersion === grant.data.binding.driverVersion,
    )
  )
    return { allowed: false, code: "invalid_capability" };
  if (
    !Number.isSafeInteger(input.now) ||
    input.now < grant.data.observedAt ||
    input.now >= grant.data.expiresAt
  )
    return { allowed: false, code: "stale_observation" };
  const bindingKeys = Object.keys(
    grant.data.binding,
  ) as (keyof BackgroundWorkflowBinding)[];
  if (
    bindingKeys.some(
      (key) =>
        grant.data.binding[key] !== current.data[key] ||
        grant.data.binding[key] !== request.data.binding[key],
    ) ||
    grant.data.destinationId !== input.currentDestinationId ||
    grant.data.destinationId !== request.data.destinationId
  )
    return { allowed: false, code: "target_changed" };
  const action = request.data.action;
  if (action.type === "pixel-type") {
    const geometry = backgroundEditorGeometrySchema.safeParse(
      input.currentEditorGeometry,
    );
    const capability = grant.data.capabilities.find(
      (item) =>
        item.purpose === "pixel-draft" &&
        item.geometry.editorId === action.editorId,
    );
    const qualified = input.qualifications.some(
      (item) =>
        item.id === grant.data.qualificationId &&
        item.workflow === grant.data.workflow &&
        item.bundleId === grant.data.binding.bundleId &&
        item.driverVersion === grant.data.binding.driverVersion &&
        item.pixelDraft === true,
    );
    if (
      !qualified ||
      !geometry.success ||
      capability?.purpose !== "pixel-draft" ||
      JSON.stringify(geometry.data) !== JSON.stringify(capability.geometry) ||
      action.x !== geometry.data.bounds.x + geometry.data.bounds.width / 2 ||
      action.y !== geometry.data.bounds.y + geometry.data.bounds.height / 2 ||
      action.text !== capability.allowedText
    )
      return { allowed: false, code: "action_not_granted" };
    return { allowed: true, request: request.data };
  }
  const capability = grant.data.capabilities.find(
    (item) =>
      item.purpose !== "pixel-draft" &&
      item.elementToken === action.elementToken,
  );
  if (!capability) return { allowed: false, code: "action_not_granted" };
  const allowed =
    (action.type === "click" &&
      ["navigate", "search", "draft"].includes(capability.purpose)) ||
    (action.type === "type" &&
      (capability.purpose === "draft" || capability.purpose === "search") &&
      action.text === capability.allowedText) ||
    (action.type === "key" &&
      capability.purpose === "draft" &&
      capability.keys.includes(action.key)) ||
    (action.type === "scroll" &&
      capability.purpose === "read-scroll" &&
      Math.abs(action.deltaY) <= capability.maxDeltaY);
  return allowed
    ? { allowed: true, request: request.data }
    : { allowed: false, code: "action_not_granted" };
}
