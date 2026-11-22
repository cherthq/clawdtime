import type { Hono } from "hono";
import { z } from "zod";
import { DomainError } from "../storage/security.js";
import {
  phoneCallSchema,
  phoneChatSchema,
  type PhoneTurnContext,
} from "../phone-desktop-contracts.js";
import type { PhoneDesktop } from "./phone-desktop.js";

/** Local panel authentication is checked before parsing a phone command. */
export function mountPhoneDesktop(
  app: Hono,
  options: {
    scope: PhoneDesktop;
    instanceId: string;
    authorize(token: string): void;
    say(
      text: string,
      via: "voice",
      context?: PhoneTurnContext,
    ): Promise<unknown>;
  },
) {
  for (const operation of ["open", "renew", "chat", "stop", "close"] as const) {
    app.post(`/desktop/phone/${operation}`, async (c) => {
      const auth = c.req.header("authorization") ?? "";
      options.authorize(auth.startsWith("Bearer ") ? auth.slice(7) : "");
      const raw: unknown = await c.req.json();
      const input =
        operation === "chat"
          ? phoneChatSchema.parse(raw)
          : phoneCallSchema.parse(raw);
      // A new service cannot inherit a call or request from its predecessor.
      if (input.instanceId !== options.instanceId)
        return c.json({ ok: false, code: "service_changed" }, 409);
      try {
        if (operation === "chat") {
          const chat = phoneChatSchema.parse(raw);
          const reply = await options.scope.run(
            chat.callId,
            chat.requestId,
            chat.text,
            () =>
              options.say(chat.text, "voice", {
                ...(chat.presentation
                  ? { phonePresentation: chat.presentation }
                  : {}),
                isLive: options.scope.currentContext()?.isLive,
              }),
            chat.presentation ?? null,
          );
          const value = z
            .object({ text: z.string().max(20000) })
            .passthrough()
            .parse(reply);
          return c.json({ ok: true, reply: { text: value.text } });
        }
        return c.json(options.scope[operation](input.callId));
      } catch (error) {
        // Never serialize supervisor/model/native errors or repeat a command.
        const code =
          error instanceof DomainError && /^phone_[a-z_]+$/.test(error.message)
            ? error.message
            : "outcome_unknown";
        return c.json({ ok: false, code }, 409);
      }
    });
  }
}
