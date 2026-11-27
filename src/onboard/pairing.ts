/**
 * The pairing operations of a shared participant Mac, with no terminal in
 * them: `clawdtime shared pair` and `clawdtime onboard` both use them. Nothing
 * here prints, logs or returns a phone number, a code, a session token or a
 * device credential in a message. Every error is a fixed code.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  privateFolder,
  readPrivateJSON,
  writePrivateJSON,
} from "../../connectors/shared/private-file.js";
import { routingId } from "../shared-number-contracts.js";
import { sharedDisplayTargetSchema } from "../control/proactive-display-views.js";
import { oneJSON } from "../control/proactive-views.js";

/** The private connection file of a paired Mac. It keeps the person's own
 * view and control answers, and this Mac enforces them whatever the
 * coordinator sends. A file without the answers allows neither. */
export const sharedConnectionSchema = z
  .object({
    origin: z.string(),
    credential: z.string().min(32),
    deviceId: routingId,
    displayId: routingId,
    allowView: z.boolean().default(false),
    allowControl: z.boolean().default(false),
    walkthroughReports: z.boolean().default(false),
    capture: z
      .object({
        binary: z.string().refine(isAbsolute),
        target: sharedDisplayTargetSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type SharedConnection = z.infer<typeof sharedConnectionSchema>;
export type SharedDisplayTarget = z.infer<typeof sharedDisplayTargetSchema>;

/** The folder and the connection file of the shared pairing. */
export function sharedPairingPaths(home = homedir()) {
  const directory = join(home, ".config", "clawdtime", "shared");
  return { directory, file: join(directory, "connection.json") };
}

/**
 * The lock of the one `clawdtime shared run` of this Mac. The connection
 * holds it for its whole life; the kernel ends it with the process.
 */
export function sharedConnectionLock(home = homedir()) {
  return join(sharedPairingPaths(home).directory, "connection.lock");
}

/** The saved pairing: none, one, or a file that cannot be used. */
export function readSharedPairing(
  file: string,
):
  | { kind: "none" }
  | { kind: "paired"; connection: SharedConnection }
  | { kind: "unusable" } {
  const loaded = readPrivateJSON(file);
  if (loaded.problem) return { kind: "unusable" };
  if (!loaded.value) return { kind: "none" };
  const parsed = sharedConnectionSchema.safeParse(loaded.value);
  return parsed.success
    ? { kind: "paired", connection: parsed.data }
    : { kind: "unusable" };
}

/** Writes the pairing for its owner only, in a folder for its owner only. */
export function saveSharedPairing(
  directory: string,
  file: string,
  connection: SharedConnection,
) {
  privateFolder(directory);
  writePrivateJSON(file, sharedConnectionSchema.parse(connection));
}

/** The acceptance that pairing sends: the person's real answers. Viewing is
 * allowed only when they agreed to share the display. Computer actions need
 * viewing, as on the coordinator. */
export function sharedAcceptance(answers: {
  displayId: string;
  shareScreen: boolean;
  control: boolean;
}) {
  return {
    localAccepted: true as const,
    displayId: routingId.parse(answers.displayId),
    allowView: answers.shareScreen,
    allowControl: answers.shareScreen && answers.control,
  };
}

/** A refusal of the coordinator: its fixed code, and the HTTP status, or
 * null when no answer came. A request with no answer may have had an effect. */
export class CoordinatorError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null,
  ) {
    super(code);
    this.name = "CoordinatorError";
  }
}

export type CoordinatorPost = (
  path: string,
  input: unknown,
  bearer?: string,
) => Promise<unknown>;

/** POSTs JSON to the coordinator: no redirect, a bounded wait, and only the
 * coordinator's fixed error code in the error. */
export function coordinatorPost(
  origin: string,
  request: typeof fetch = fetch,
  timeoutMs = 20_000,
): CoordinatorPost {
  return async (path, input, bearer) => {
    let response: Response;
    try {
      response = await request(`${origin}${path}`, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CoordinatorError("coordinator_unreachable", null);
    }
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok)
      throw new CoordinatorError(
        z.object({ code: z.string().max(100) }).safeParse(body).data?.code ??
          "coordinator_refused",
        response.status,
      );
    return body;
  };
}

/** Asks the coordinator to text a sign-in code to the person's own number.
 * Call it only after the person said yes. Strangers get the same answer and
 * no text. */
export async function startSharedSignIn(
  post: CoordinatorPost,
  recipient: string,
) {
  return z
    .object({ challengeId: z.string().max(200), expiresAt: z.number() })
    .partial({ expiresAt: true })
    .parse(await post("/auth/start", { recipient }));
}

/** Trades the texted code for a sign-in session of about an hour. */
export async function verifySharedSignIn(
  post: CoordinatorPost,
  challengeId: string,
  code: string,
) {
  const session = z
    .object({ token: z.string(), expiresAt: z.number().optional() })
    .parse(await post("/auth/verify", { challengeId, code }));
  return { token: session.token, expiresAt: session.expiresAt };
}

/** Asks for a pairing invitation. With replace, accepting it revokes the
 * account's other paired Mac. */
export async function requestSharedInvitation(
  post: CoordinatorPost,
  token: string,
  replace: boolean,
) {
  return z
    .object({ invitation: z.string() })
    .parse(
      await post("/account/invite", replace ? { replace: true } : {}, token),
    );
}

/** Accepts the invitation with the person's answers: the device credential. */
export async function acceptSharedInvitation(
  post: CoordinatorPost,
  invitation: { invitation: string },
  acceptance: ReturnType<typeof sharedAcceptance>,
) {
  return z
    .object({
      credential: z.string().min(32),
      pairing: z.object({ deviceId: routingId }),
    })
    .parse(await post("/pair/accept", { ...invitation, acceptance }));
}

/** A display of this Mac, from the capture helper's metadata only: no
 * screen image, no permission prompt. */
export interface SharedDisplay {
  displayId: string;
  width: number;
  height: number;
  isMain: boolean;
}

/** The displays of this Mac, from `ClawdTimeTaskCapture --list-displays`. */
export async function listSharedDisplays(
  binary: string,
): Promise<SharedDisplay[]> {
  const output = await new Promise<string>((done, fail) =>
    execFile(
      binary,
      ["--list-displays"],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout) =>
        error ? fail(Error("displays_unavailable")) : done(stdout),
    ),
  );
  const rows = z
    .array(
      z
        .object({
          displayId: z.number().int().positive(),
          width: z.number(),
          height: z.number(),
          isMain: z.boolean().optional(),
        })
        .passthrough(),
    )
    .max(32)
    .parse(JSON.parse(output));
  return rows.map((row) => ({
    displayId: String(row.displayId),
    width: row.width,
    height: row.height,
    isMain: row.isMain === true,
  }));
}

/** The exact capture target of one display. It must still be that display. */
export async function resolveSharedDisplay(
  binary: string,
  displayId: string,
): Promise<SharedDisplayTarget> {
  const target = sharedDisplayTargetSchema.parse(
    await oneJSON(binary, ["--resolve-display", displayId], true).result,
  );
  if (String(target.displayId) !== displayId)
    throw Error("display_selection_changed");
  return target;
}
