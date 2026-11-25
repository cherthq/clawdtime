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
 * A service with no language model does not get the message of a command
 * that has one: it could only tell the state, and the command alone answers
 * better, as it did before.
 *
 * The rule for a message that may already be with the service: it is never
 * sent a second time and never answered by the command's own brain. Two
 * brains must not act on one sentence.
 *
 * `clawdtime chat new` and `clawdtime chat open TIME` go to the same service
 * in the same way, when it runs: it owns the chat of the panel and knows what
 * waits for the person. `clawdtime chat history` reads the chats that it put
 * aside. With no service the command works on the files itself.
 *
 * The credential is read, sent to the loopback address of the service, and
 * nothing else. It is never printed and never part of an error.
 */
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { readDesktopPrivateJSON } from "../../src/control/task-desktop-config.js";
import { stateRoot } from "./hooks.js";
import type { System } from "./system.js";
import { userMessageLimit, userMessageTooLong } from "./request-text.js";

/** How long the service has to answer the two reads that come first. After that the command answers by itself. */
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
const chatSchema = z.object({ model: z.boolean() }).passthrough();
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
  /** Rejected before transport; never fall back to another executor. */
  | { kind: "rejected"; text: string }
  /** The service answered. */
  | { kind: "answered"; text: string }
  /** No service took the message: the command answers by itself. */
  | { kind: "absent" }
  /** The message went to the service and no answer came back. Nothing is sent again. */
  | { kind: "lost"; text: string };

/**
 * Hands one message to the desktop service that runs, and gives its answer.
 * `absent` when no service runs, when it does not answer its two first reads
 * within `connectMs`, when it has no chat, and when it has no language model
 * while the command has one. It never throws.
 */
interface DesktopOptions {
  request?: typeof fetch;
  connectMs?: number;
  answerMs?: number;
  exists?: (pid: number) => boolean;
}
/**
 * The desktop service that runs, after its two first reads within one time
 * limit, or null. The reads show that the service is there, that it takes
 * this credential, that it is the instance that wrote the files, and that it
 * has a chat. They change nothing, so with no answer in time the command can
 * act by itself.
 */
async function reachDesktop(
  system: Pick<System, "env" | "home">,
  options: DesktopOptions,
) {
  const folder = desktopStateFolder(system);
  if (!folder) return null;
  const service = findDesktopService(folder, options.exists);
  if (!service) return null;
  const request = options.request ?? fetch;
  const headers = { authorization: `Bearer ${service.token}` };
  const until = Date.now() + (options.connectMs ?? desktopConnectMs);
  const read = (path: string) =>
    request(`${service.origin}${path}`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, until - Date.now())),
    });
  try {
    const state = await read("/desktop/state");
    if (!state.ok) return null;
    if (stateSchema.parse(await state.json()).instanceId !== service.instanceId)
      return null;
    // A service with its agent board off has no chat: the route is not there.
    const chat = await read("/desktop/chat");
    if (!chat.ok) return null;
    const { model } = chatSchema.parse(await chat.json());
    return { service, request, headers, model };
  } catch {
    return null;
  }
}

export async function sayToDesktop(
  system: Pick<System, "env" | "home">,
  text: string,
  options: DesktopOptions & {
    /** The command has a language model of its own. */
    ownModel?: boolean;
  } = {},
): Promise<DesktopAnswer> {
  if (text.length > userMessageLimit)
    return { kind: "rejected", text: userMessageTooLong };
  const absent: DesktopAnswer = { kind: "absent" };
  const words = text.trim();
  if (!words) return absent;
  const desk = await reachDesktop(system, options);
  if (!desk) return absent;
  if (!desk.model && options.ownModel) return absent;
  const { service, request, headers } = desk;
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
    if (!response.ok) return lost;
    const answer = replySchema.parse(await response.json()).reply.text.trim();
    return answer ? { kind: "answered", text: answer } : lost;
  } catch {
    return lost;
  }
}

/** What the person hears when the service took a change of the chat and did not answer. */
export const desktopChatLostText =
  "The ClawdTime desktop service took the request and did not answer. I did not send it again. Run clawdtime chat history to see which chats are kept.";
const switchSchema = z
  .object({ ok: z.boolean(), text: z.string().min(1).max(600) })
  .passthrough();
const historySchema = z
  .object({
    chats: z
      .array(
        z
          .object({
            id: z.string().regex(/^[0-9]{8}T[0-9]{6}Z(?:-[0-9]{1,3})?$/),
            messages: z.number().int().nonnegative(),
            first: z.string().max(200),
          })
          .strict(),
      )
      .max(10_000),
  })
  .passthrough();

/**
 * A new chat, or a chat that was put aside opened again, by the desktop
 * service that runs: it owns the chat of the panel. `absent` when no
 * service runs: the command changes the files itself. Exactly one POST,
 * never sent again. It never throws.
 */
export async function changeDesktopChat(
  system: Pick<System, "env" | "home">,
  change: "new" | { open: string },
  options: DesktopOptions = {},
): Promise<DesktopAnswer & { ok?: boolean }> {
  const desk = await reachDesktop(system, options);
  if (!desk) return { kind: "absent" };
  const { service, request, headers } = desk;
  const lost = { kind: "lost" as const, text: desktopChatLostText };
  try {
    const response = await request(
      `${service.origin}/desktop/chat/${change === "new" ? "new" : "open"}`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(change === "new" ? {} : { id: change.open }),
        redirect: "error",
        signal: AbortSignal.timeout(options.answerMs ?? desktopConnectMs * 5),
      },
    );
    if (!response.ok) return lost;
    const { ok, text } = switchSchema.parse(await response.json());
    return { kind: "answered", text, ok };
  } catch {
    return lost;
  }
}

/**
 * The chats that the desktop service that runs put aside, or null when no
 * service runs or it does not answer: the command reads the files itself.
 */
export async function desktopChatHistory(
  system: Pick<System, "env" | "home">,
  options: DesktopOptions = {},
) {
  const desk = await reachDesktop(system, options);
  if (!desk) return null;
  try {
    const response = await desk.request(
      `${desk.service.origin}/desktop/chat/history`,
      {
        headers: desk.headers,
        redirect: "error",
        signal: AbortSignal.timeout(options.connectMs ?? desktopConnectMs),
      },
    );
    if (!response.ok) return null;
    return historySchema.parse(await response.json()).chats;
  } catch {
    return null;
  }
}
