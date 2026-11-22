import { homedir } from "node:os";
import {
  callPhoneDesktop,
  phoneChatPayloadSchema,
  type PhoneDesktopCommand,
} from "../connectors/agents/phone-desktop.js";

/** Internal phone transport. JSON results distinguish a rejected dispatch from an unknown one. */
export async function phoneCli(
  args: string[],
  options: {
    env?: Record<string, string | undefined>;
    home?: string;
    request?: typeof fetch;
    print?: (text: string) => void;
  } = {},
) {
  const print = options.print ?? console.log;
  const [action, callId, requestId, raw] = args;
  let command: PhoneDesktopCommand;
  try {
    if (action === "chat" && args.length === 4 && callId && requestId && raw)
      command = {
        action,
        callId,
        requestId,
        payload: phoneChatPayloadSchema.parse(JSON.parse(raw)),
      };
    else if (
      (action === "open" ||
        action === "renew" ||
        action === "close" ||
        action === "stop") &&
      args.length === 2 &&
      callId
    )
      command = { action, callId };
    else throw Error("invalid command");
  } catch {
    return print(JSON.stringify({ ok: false, code: "invalid_request" }));
  }
  print(
    JSON.stringify(
      await callPhoneDesktop(
        { env: options.env ?? process.env, home: options.home ?? homedir() },
        command,
        options.request ? { request: options.request } : {},
      ),
    ),
  );
}
