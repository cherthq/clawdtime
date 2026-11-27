import { z } from "zod";
import {
  readPrivateJSON,
  writePrivateJSON,
} from "../connectors/shared/private-file.js";

const saved = z
  .object({ origin: z.string(), token: z.string(), expiresAt: z.number() })
  .strict();
// The session must outlive the pending-call read and the call proof.
const margin = 2 * 60_000;

/** Signs in with a code texted to the person's own number, after consent.
 * With `keep`, a session that the coordinator still accepts is reused, so
 * `shared prove` does not send a new text for each call. It is kept only in an
 * owner-only file, for one origin, until shortly before it expires. */
export async function sharedSignIn(options: {
  origin: string;
  ask(question: string): Promise<string>;
  post(path: string, input: unknown, bearer?: string): Promise<unknown>;
  keep?: { file: string; check(token: string): Promise<unknown> };
  now?: () => number;
}): Promise<{ token: string } | null> {
  const now = options.now ?? Date.now;
  const keep = options.keep;
  if (keep) {
    const loaded = readPrivateJSON(keep.file);
    const session = loaded.problem ? null : saved.safeParse(loaded.value).data;
    if (
      session &&
      session.origin === options.origin &&
      session.expiresAt - now() > margin
    ) {
      try {
        await keep.check(session.token);
        return { token: session.token };
      } catch {
        // Refused or unreachable: forget it, then ask before a new text.
        try {
          writePrivateJSON(keep.file, null);
        } catch {
          /* An unsafe file is never overwritten. */
        }
      }
    }
  }
  const recipient = (
    await options.ask("Your own phone number, with country code: ")
  ).trim();
  if (
    (
      await options.ask(
        `Send a sign-in code to that number through ${options.origin}? Type yes: `,
      )
    ).trim() !== "yes"
  )
    return null;
  const challenge = z
    .object({ challengeId: z.string() })
    .parse(await options.post("/auth/start", { recipient }));
  const code = (
    await options.ask("Enter the sign-in code from your phone: ")
  ).trim();
  const session = z
    .object({ token: z.string(), expiresAt: z.number().optional() })
    .parse(await options.post("/auth/verify", { ...challenge, code }));
  if (keep && session.expiresAt !== undefined)
    try {
      writePrivateJSON(keep.file, {
        origin: options.origin,
        token: session.token,
        expiresAt: session.expiresAt,
      });
    } catch {
      /* An unsafe file is never overwritten; the next prove signs in again. */
    }
  return { token: session.token };
}
