import type { AgentSession } from "../../src/contracts.js";

export interface ProtocolOptions {
  protocolVersion?: 1 | 2;
  /** Explicit adapter/operator evidence, not discovery or permission grants. */
  nativeControl?: "none" | "browser" | "desktop";
  sharedSurface?: boolean;
  nativeCancellation?: boolean;
  messageUpdates?: boolean;
  conversation?: AgentSession["conversation"];
  documentAccess?: AgentSession["documentAccess"];
  screenCamera?: AgentSession["screenCamera"];
  voiceFrontend?: AgentSession["voiceFrontend"];
}
export function sessionInteraction(
  options: ProtocolOptions,
): AgentSession["interaction"] {
  return options.protocolVersion === 1
    ? undefined
    : {
        version: 1,
        commandChannel: "imessage_first",
        messageUpdates: options.conversation
          ? false
          : (options.messageUpdates ?? true),
      };
}
export function sessionCapabilities(
  options: ProtocolOptions,
): AgentSession["capabilities"] {
  if (options.screenCamera && options.protocolVersion === 1)
    throw new Error("Screen camera requires protocol v2.");
  if (
    options.voiceFrontend &&
    (options.protocolVersion === 1 ||
      options.conversation ||
      options.documentAccess)
  )
    throw new Error(
      "Realtime voice requires a fresh v2 same-chat session without a managed runner.",
    );
  if (
    options.voiceFrontend &&
    (options.voiceFrontend.version !== 1 ||
      options.voiceFrontend.provider !== "elevenlabs")
  )
    throw new Error("Unsupported realtime voice frontend.");
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
    ...(options.screenCamera ? { screenCameraVersion: 1 as const } : {}),
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
    "screen-camera",
  ])
    if (flags[key] !== undefined && !["true", "false"].includes(flags[key]!))
      throw new Error(`--${key} must be true or false.`);
  const cameraEnabled = flags["screen-camera"] === "true";
  const cameraDisplay = flags["camera-display"];
  const cameraWindow = flags["camera-window"];
  const cameraOwner = flags["camera-owner-pid"];
  const positiveId = (value: string | undefined) =>
    value !== undefined &&
    /^[1-9][0-9]{0,9}$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) <= 4_294_967_295;
  if (
    !cameraEnabled &&
    [cameraDisplay, cameraWindow, cameraOwner].some((v) => v !== undefined)
  )
    throw new Error(
      "Camera surface flags require --screen-camera true on a fresh session.",
    );
  if (cameraEnabled && (protocolVersion !== 2 || !positiveId(cameraDisplay)))
    throw new Error(
      "Screen camera requires v2 and an explicit --camera-display positive ID.",
    );
  if (
    cameraEnabled &&
    ((cameraWindow !== undefined) !== (cameraOwner !== undefined) ||
      (cameraWindow !== undefined &&
        (!positiveId(cameraWindow) ||
          !positiveId(cameraOwner) ||
          Number(cameraOwner) > 0x7fffffff)))
  )
    throw new Error(
      "Window camera requires both --camera-window ID and --camera-owner-pid PID.",
    );
  if (cameraEnabled && flags["runner"] === "remote-documents")
    throw new Error("Document-only execution cannot claim a screen camera.");
  const runnerId = flags["runner"];
  const voiceFrontend = flags["voice-frontend"];
  if (voiceFrontend !== undefined && voiceFrontend !== "elevenlabs")
    throw new Error(
      "--voice-frontend must be elevenlabs; omit it to preserve the existing voice path.",
    );
  if (
    voiceFrontend &&
    (protocolVersion !== 2 || runnerId || flags["execution-session"])
  )
    throw new Error(
      "Realtime voice requires a fresh v2 same-chat session without a managed runner.",
    );
  const documentUntil = flags["document-access-until"];
  if ((runnerId === "remote-documents") !== (documentUntil !== undefined))
    throw new Error(
      "remote-documents requires --document-access-until ISO_TIMESTAMP; other runners cannot request document access.",
    );
  const documentExpiry =
    documentUntil === undefined ? undefined : Date.parse(documentUntil);
  if (
    documentExpiry !== undefined &&
    (!Number.isFinite(documentExpiry) ||
      documentExpiry <= Date.now() ||
      documentExpiry > Date.now() + 3_600_000)
  )
    throw new Error(
      "Document access must have an explicit future expiry within one hour.",
    );
  if ((runnerId !== undefined) !== (flags["execution-session"] !== undefined))
    throw new Error(
      "Use --runner ID with --execution-session api_managed for an explicitly separate execution session.",
    );
  if (
    runnerId &&
    (flags["execution-session"] !== "api_managed" ||
      protocolVersion !== 2 ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(runnerId))
  )
    throw new Error(
      "Managed execution requires v2, a bounded runner ID and --execution-session api_managed.",
    );
  if (
    runnerId &&
    (nativeControl !== "none" ||
      flags["shared-surface"] === "true" ||
      flags["native-cancellation"] === "true")
  )
    throw new Error(
      "Managed runner capability comes from its host; do not attest this chat's native tools.",
    );
  const result: ProtocolOptions = {
    protocolVersion,
    ...(voiceFrontend
      ? {
          voiceFrontend: {
            version: 1 as const,
            provider: "elevenlabs" as const,
          },
        }
      : {}),
    ...(cameraEnabled
      ? {
          screenCamera: {
            version: 1 as const,
            surface: cameraWindow
              ? {
                  kind: "window" as const,
                  id: cameraWindow,
                  displayId: Number(cameraDisplay),
                  ownerPid: Number(cameraOwner),
                }
              : {
                  kind: "display" as const,
                  id: cameraDisplay!,
                  displayId: Number(cameraDisplay),
                },
          },
        }
      : {}),
    ...(documentExpiry !== undefined
      ? {
          documentAccess: {
            version: 1 as const,
            readOnly: true as const,
            expiresAt: documentExpiry,
          },
        }
      : {}),
    ...(runnerId
      ? {
          conversation: {
            version: 1 as const,
            runnerId,
            executionSession: "api_managed" as const,
          },
        }
      : {}),
    nativeControl: nativeControl as "none" | "browser" | "desktop",
    sharedSurface: flags["shared-surface"] === "true",
    nativeCancellation: flags["native-cancellation"] === "true",
    messageUpdates: flags["message-updates"] !== "false",
  };
  sessionCapabilities(result);
  return result;
}
