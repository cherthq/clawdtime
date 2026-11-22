import { z } from "zod";
import {
  desktopAnswerMs,
  desktopConnectMs,
  desktopStateFolder,
  findDesktopService,
} from "./desktop-chat.js";
import type { System } from "./system.js";

import {
  phoneChatPayloadSchema,
  phoneResponseSchema,
  type PhoneTurnContext,
} from "../../src/phone-desktop-contracts.js";
export { phoneChatPayloadSchema } from "../../src/phone-desktop-contracts.js";
export type { PhoneTurnContext };
const identity = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
export type PhoneDesktopResult = z.infer<typeof phoneResponseSchema>;
export type PhoneDesktopCommand =
  | { action: "open" | "renew" | "close" | "stop"; callId: string }
  | {
      action: "chat";
      callId: string;
      requestId: string;
      payload: z.infer<typeof phoneChatPayloadSchema>;
    };

/** One exact call operation. No fallback, no retries, and no secrets in its result. */
export async function callPhoneDesktop(
  system: Pick<System, "env" | "home">,
  command: PhoneDesktopCommand,
  options: {
    request?: typeof fetch;
    exists?: (pid: number) => boolean;
    connectMs?: number;
    answerMs?: number;
  } = {},
): Promise<PhoneDesktopResult> {
  try {
    identity.parse(command.callId);
    if (command.action === "chat") {
      identity.parse(command.requestId);
      phoneChatPayloadSchema.parse(command.payload);
    }
  } catch {
    return { ok: false, code: "invalid_request" };
  }
  const folder = desktopStateFolder(system);
  const service = folder ? findDesktopService(folder, options.exists) : null;
  if (!service) return { ok: false, code: "desktop_unavailable" };
  const request = options.request ?? fetch;
  const headers = { authorization: `Bearer ${service.token}` };
  try {
    const state = await request(`${service.origin}/desktop/state`, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(options.connectMs ?? desktopConnectMs),
    });
    if (
      !state.ok ||
      z.object({ instanceId: z.string() }).parse(await state.json())
        .instanceId !== service.instanceId
    )
      return { ok: false, code: "desktop_unavailable" };
  } catch {
    return { ok: false, code: "desktop_unavailable" };
  }
  const body = {
    instanceId: service.instanceId,
    callId: command.callId,
    ...(command.action === "chat"
      ? { requestId: command.requestId, ...command.payload }
      : {}),
  };
  try {
    const response = await request(
      `${service.origin}/desktop/phone/${command.action}`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(options.answerMs ?? desktopAnswerMs),
      },
    );
    const parsed = phoneResponseSchema.parse(await response.json());
    if (parsed.code && !/^[a-z_]{1,100}$/.test(parsed.code))
      return { ok: false, code: "outcome_unknown" };
    if (!response.ok && parsed.ok)
      return { ok: false, code: "outcome_unknown" };
    if (command.action === "chat" && parsed.ok && !parsed.reply)
      return { ok: false, code: "outcome_unknown" };
    return parsed;
  } catch {
    return { ok: false, code: "outcome_unknown" };
  }
}
