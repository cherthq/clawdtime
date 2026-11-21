/**
 * One message for the desktop service that runs on this Mac.
 *
 * `clawdtime chat TEXT` has a brain of its own, in the process of the command.
 * That brain has no task service and no engine for computer work. The desktop
 * service has both, and the conversation of the panel. So when a desktop
 * service runs, the command hands the text to it: `POST /desktop/chat`, with
 * the panel credential from the service's own owner-only file. A phone call
 * uses that command, so a caller's request reaches the same brain as the chat
 * of the panel.
 *
 * Where the service is looked for: the folder in `CLAWDTIME_DESKTOP_STATE`,
 * or else the folder `desktop` in the state folder of ClawdTime
 * (`CLAWDTIME_CONFIG_HOME`, or `~/.local/share/clawdtime`).
 *
 * The rule for a message that may already be with the service: it is never
 * sent a second time and never answered by the command's own brain. Two
 * brains must not act on one sentence.
 *
 * The credential is read, sent to the loopback address of the service, and
 * nothing else. It is never printed and never part of an error.
 */
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { readDesktopPrivateJSON } from "../../src/control/task-desktop-config.js";
import { stateRoot } from "./hooks.js";
import type { System } from "./system.js";

/** How long the service has to answer the first read. After that the command answers by itself. */
export const desktopConnectMs = 2000;
/** How long the answer to the message may take. The language model of the service is in it. */
export const desktopAnswerMs = 110_000;

/** What the person hears when the message went out and no answer came back. */
export const desktopLostText =
  "The ClawdTime desktop service took the message and did not answer. It may still act on it. I did not send it again. Ask what it is doing before you say it again.";

const loopback = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/;
const serviceSchema = z
  .object({
    version: z.literal(1),
    instanceId: z.string().min(1).max(200),
    pid: z.number().int().positive(),
    origin: z.string().regex(loopback),
    configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .passthrough();
const panelSchema = z
  .object({
    version: z.literal(1),
    origin: z.string().regex(loopback),
    token: z.string().min(32).max(4096),
    configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .passthrough();
const ownerSchema = z.object({ pid: z.number().int().positive() }).strict();
const stateSchema = z
  .object({ instanceId: z.string().min(1).max(200) })
  .passthrough();
const replySchema = z
  .object({
    reply: z
      .object({ role: z.literal("assistant"), text: z.string().max(20_000) })
      .passthrough(),
  })
  .passthrough();

/**
 * The folder where a desktop service of this person keeps its state, or null
 * when none may be looked for. A command that a test runs never looks in the
 * person's own folder: there it needs the folder by name.
 */
export function desktopStateFolder(
  system: Pick<System, "env" | "home">,
): string | null {
  const named = system.env.CLAWDTIME_DESKTOP_STATE;
  if (named) return isAbsolute(named) ? named : null;
  if (system.env.VITEST) return null;
  return join(stateRoot(system), "desktop");
}

/** A desktop service that its own files describe and whose process is there. */
export interface DesktopService {
  origin: string;
  instanceId: string;
  /** The panel credential. Only `sayToDesktop` uses it. */
  token: string;
}

/** A process of this person with that number runs. Signal 0 sends nothing. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // No such process, or one of another user: not this person's service.
    return false;
  }
};

/**
 * Reads what the service wrote about itself. Null when no service is
 * described there, when a file is not an owner-only regular file, when the
 * files do not agree, or when the process that wrote them is gone.
 */
export function findDesktopService(
  folder: string,
  exists: (pid: number) => boolean = alive,
): DesktopService | null {
  try {
    const service = serviceSchema.parse(
      readDesktopPrivateJSON(join(folder, "desktop-service.json")),
    );
    const panel = panelSchema.parse(
      readDesktopPrivateJSON(join(folder, "desktop-panel.json")),
    );
    const owner = ownerSchema.parse(
      readDesktopPrivateJSON(join(folder, "owner.lock")),
    );
    if (
      service.origin !== panel.origin ||
      service.configurationFingerprint !== panel.configurationFingerprint ||
      service.pid !== owner.pid ||
      !exists(service.pid)
    )
      return null;
    return {
      origin: service.origin,
      instanceId: service.instanceId,
      token: panel.token,
    };
  } catch {
    // What failed is not said: the text of an error can hold what a file held.
    return null;
  }
}

export type DesktopAnswer =
  /** The service answered. */
  | { kind: "answered"; text: string }
  /** No service took the message: the command answers by itself. */
  | { kind: "absent" }
  /** The message went to the service and no answer came back. Nothing is sent again. */
  | { kind: "lost"; text: string };

/**
 * Hands one message to the desktop service that runs, and gives its answer.
 * `absent` when no service runs, when it does not answer its first read
 * within `connectMs`, or when it has no chat. It never throws.
 */
export async function sayToDesktop(
  system: Pick<System, "env" | "home">,
  text: string,
  options: {
    request?: typeof fetch;
    connectMs?: number;
    answerMs?: number;
    exists?: (pid: number) => boolean;
  } = {},
): Promise<DesktopAnswer> {
  const absent: DesktopAnswer = { kind: "absent" };
  const words = text.trim().slice(0, 2000);
  if (!words) return absent;
  const folder = desktopStateFolder(system);
  if (!folder) return absent;
  const service = findDesktopService(folder, options.exists);
  if (!service) return absent;
  const request = options.request ?? fetch;
  const headers = { authorization: `Bearer ${service.token}` };
  // The first read shows that the service is there, that it takes this
  // credential and that it is the instance that wrote the files. It changes
  // nothing, so with no answer in time the command can answer by itself.
  try {
    const response = await request(`${service.origin}/desktop/state`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(options.connectMs ?? desktopConnectMs),
    });
    if (!response.ok) return absent;
    const state = stateSchema.parse(await response.json());
    if (state.instanceId !== service.instanceId) return absent;
  } catch {
    return absent;
  }
  // From here the message may be with the service. Exactly one POST.
  const lost: DesktopAnswer = { kind: "lost", text: desktopLostText };
  try {
    const response = await request(`${service.origin}/desktop/chat`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ text: words }),
      redirect: "error",
      signal: AbortSignal.timeout(options.answerMs ?? desktopAnswerMs),
    });
    // A service with its agent board off has no chat: the route is not there,
    // so nothing took the message.
    if (response.status === 404) return absent;
    if (!response.ok) return lost;
    const answer = replySchema.parse(await response.json()).reply.text.trim();
    return answer ? { kind: "answered", text: answer } : lost;
  } catch {
    return lost;
  }
}
