import { z } from "zod";

/** Signs in with a code texted to the person's own number, after consent.
 * Only pairing signs in. A call is proved by the paired Mac itself, so
 * `shared prove` sends no text and keeps no sign-in. */
export async function sharedSignIn(options: {
  origin: string;
  ask(question: string): Promise<string>;
  post(path: string, input: unknown, bearer?: string): Promise<unknown>;
}): Promise<{ token: string } | null> {
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
  return { token: session.token };
}
