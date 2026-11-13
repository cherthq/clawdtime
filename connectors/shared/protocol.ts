import type { AgentSession } from "../../src/contracts.js";

export interface ProtocolOptions {
  protocolVersion?: 1 | 2;
  /** Explicit adapter/operator evidence, not discovery or permission grants. */
  nativeControl?: "none" | "browser" | "desktop";
  sharedSurface?: boolean;
  nativeCancellation?: boolean;
  messageUpdates?: boolean;
}
export function sessionInteraction(
  options: ProtocolOptions,
): AgentSession["interaction"] {
  return options.protocolVersion === 1
    ? undefined
    : {
        version: 1,
        commandChannel: "imessage_first",
        messageUpdates: options.messageUpdates ?? true,
      };
}
export function sessionCapabilities(
  options: ProtocolOptions,
): AgentSession["capabilities"] {
  const nativeControl = options.nativeControl ?? "none";
  if (options.sharedSurface && nativeControl === "none")
    throw new Error(
      "A verified shared surface requires a suitable native input tool.",
    );
  return {
    cooperativePause: true,
    polling: true,
    nativeControl,
    sharedSurface: options.sharedSurface ?? false,
    nativeCancellation: options.nativeCancellation ?? false,
    ...(options.protocolVersion === 1
      ? {}
      : { voiceInteractionVersion: 1 as const }),
  };
}
export function protocolOptions(
  flags: Record<string, string>,
): ProtocolOptions {
  const protocolVersion = Number(flags["protocol-version"] ?? 2);
  if (protocolVersion !== 1 && protocolVersion !== 2)
    throw new Error("--protocol-version must be 1 or 2.");
  const nativeControl = flags["native-control"] ?? "none";
  if (!["none", "browser", "desktop"].includes(nativeControl))
    throw new Error("--native-control must be none, browser or desktop.");
  for (const key of [
    "shared-surface",
    "native-cancellation",
    "message-updates",
  ])
    if (flags[key] !== undefined && !["true", "false"].includes(flags[key]!))
      throw new Error(`--${key} must be true or false.`);
  const result: ProtocolOptions = {
    protocolVersion,
    nativeControl: nativeControl as "none" | "browser" | "desktop",
    sharedSurface: flags["shared-surface"] === "true",
    nativeCancellation: flags["native-cancellation"] === "true",
    messageUpdates: flags["message-updates"] !== "false",
  };
  sessionCapabilities(result);
  return result;
}
