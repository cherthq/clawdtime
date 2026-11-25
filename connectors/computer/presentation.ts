/** Transient presentation metadata. Never an instruction or an input coordinate transform. */
import { z } from "zod";

const positive = z.number().finite().positive();
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const rectangle = z
  .object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    w: positive,
    h: positive,
  })
  .strict();

export const presentationEventSchema = z
  .object({
    version: z.literal(1),
    producerId: identity,
    sequence: integer,
    commandSeq: integer,
    at: positive,
    expiresAt: positive,
    kind: z.enum(["target", "typing", "context", "transition", "reset"]),
    reducedMotion: z.boolean(),
    surface: z
      .object({
        displayId: identity,
        width: positive.max(32768),
        height: positive.max(32768),
        scale: positive.max(8),
        appId: identity,
        windowId: identity,
        window: rectangle,
      })
      .strict()
      .optional(),
    target: rectangle.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    const invalid = () =>
      context.addIssue({
        code: "custom",
        message: "Invalid presentation geometry or lifetime.",
      });
    if (event.expiresAt <= event.at || event.expiresAt - event.at > 2000)
      invalid();
    const spatial = event.kind !== "reset" && event.kind !== "transition";
    if (spatial !== !!event.surface) invalid();
    const targeted = event.kind === "target" || event.kind === "typing";
    if (targeted !== !!event.target) invalid();
    if (event.surface) {
      const { width, height, window } = event.surface;
      for (const rect of [window, event.target]) {
        if (
          rect &&
          (rect.x + rect.w > width + 0.01 || rect.y + rect.h > height + 0.01)
        )
          invalid();
      }
    }
  });
export type PresentationEvent = z.infer<typeof presentationEventSchema>;

/** One latest event in memory; sequence fences survive clear so delayed POSTs cannot revive it. */
export class PresentationEvents {
  private event: PresentationEvent | null = null;
  private producer: string | null = null;
  private sequence = 0;
  private command = 0;
  private retiredState = false;
  constructor(private readonly now: () => number = Date.now) {}

  accept(raw: unknown, commandSeq: number, active: boolean): boolean {
    const event = presentationEventSchema.parse(raw);
    const now = this.now();
    if (
      !active ||
      commandSeq <= 0 ||
      event.commandSeq !== commandSeq ||
      event.at > now + 100 ||
      event.expiresAt <= now ||
      now - event.at > 2000 ||
      event.commandSeq < this.command
    )
      return false;
    if (event.producerId === this.producer) {
      if (event.sequence <= this.sequence) return false;
    } else if (this.producer && event.commandSeq <= this.command) return false;
    this.producer = event.producerId;
    this.sequence = event.sequence;
    this.command = event.commandSeq;
    if (event.kind === "reset") {
      this.event = null;
      this.retiredState = true;
    } else {
      this.event = event;
      this.retiredState = false;
    }
    return true;
  }

  latest(allow = true): PresentationEvent | null {
    if (!allow) {
      this.retire();
      return null;
    }
    if (this.event && this.event.expiresAt <= this.now()) this.clear();
    return this.event;
  }

  retire(): void {
    this.event = null;
    this.retiredState = true;
  }

  retired(): boolean {
    return this.retiredState;
  }

  clear(): void {
    this.event = null;
  }
}
