import { z } from "zod";
import {
  desktopConnectMs,
  desktopStateFolder,
  findDesktopService,
} from "./desktop-chat.js";
import type { System } from "./system.js";

/** Software evidence only. This probe never captures, submits work or sends input. */
export interface DesktopReadiness {
  service: "absent" | "unavailable" | "identity_mismatch" | "connected";
  chat: "unknown" | "unavailable" | "no_model" | "connected";
  taskSession: "unknown" | "inactive" | "active";
  taskAdmission: "unknown" | "blocked" | "available";
  computer: "unknown" | "not_configured" | "configured" | "uncertain";
  computerMode:
    "unknown" | "worker" | "native" | "browser" | "background" | "adapter";
  /** An enabled worker cannot establish that the panel or macOS grants work. */
  physicalVerification: "required";
}

const stateSchema = z.object({
  instanceId: z.string(),
  sessionActive: z.boolean().optional(),
  canSubmit: z.boolean().optional(),
});
const chatSchema = z.object({
  model: z.boolean(),
  execution: z
    .object({
      configured: z.boolean(),
      mode: z.enum(["native", "browser", "background"]).optional(),
      state: z.string(),
    })
    .optional(),
});
const computerSchema = z.object({ enabled: z.boolean(), state: z.string() });

/** Inspect the same exact desktop destination as `clawdtime chat`, with bounded GETs only. */
export async function inspectDesktopReadiness(
  system: Pick<System, "env" | "home">,
  options: {
    request?: typeof fetch;
    exists?: (pid: number) => boolean;
    connectMs?: number;
  } = {},
): Promise<DesktopReadiness> {
  const result: DesktopReadiness = {
    service: "absent",
    chat: "unknown",
    taskSession: "unknown",
    taskAdmission: "unknown",
    computer: "unknown",
    computerMode: "unknown",
    physicalVerification: "required",
  };
  const folder = desktopStateFolder(system);
  const service = folder ? findDesktopService(folder, options.exists) : null;
  if (!service) return result;
  const request = options.request ?? fetch;
  const deadline = Date.now() + (options.connectMs ?? desktopConnectMs);
  const read = async (route: string) => {
    const response = await request(service.origin + route, {
      method: "GET",
      headers: { authorization: `Bearer ${service.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (!response.ok) throw Error("Desktop readiness unavailable");
    return response.json();
  };
  try {
    const state = stateSchema.parse(await read("/desktop/state"));
    if (state.instanceId !== service.instanceId) {
      result.service = "identity_mismatch";
      return result;
    }
    result.service = "connected";
    if (state.sessionActive !== undefined)
      result.taskSession = state.sessionActive ? "active" : "inactive";
    if (state.canSubmit !== undefined)
      result.taskAdmission = state.canSubmit ? "available" : "blocked";
  } catch {
    result.service = "unavailable";
    return result;
  }
  const [chat, computer] = await Promise.allSettled([
    read("/desktop/chat").then((value) => chatSchema.parse(value)),
    read("/desktop/computer").then((value) => computerSchema.parse(value)),
  ]);
  if (chat.status === "fulfilled") {
    result.chat = chat.value.model ? "connected" : "no_model";
    if (chat.value.execution?.configured) {
      result.computer =
        chat.value.execution.state === "uncertain" ? "uncertain" : "configured";
      result.computerMode = chat.value.execution.mode ?? "adapter";
    } else result.computer = "not_configured";
  } else result.chat = "unavailable";
  if (computer.status === "fulfilled" && computer.value.enabled) {
    result.computer =
      computer.value.state === "uncertain" ? "uncertain" : "configured";
    result.computerMode = "worker";
  }
  return result;
}
