/**
 * The owner of this Mac, as `clawdtime connect` keeps it in the state folder
 * of ClawdTime (`CLAWDTIME_CONFIG_HOME`, or `~/.local/share/clawdtime`):
 *
 * - `owner.json`: the owner's own phone number, with the country code, and the
 *   owner's answer to "May ClawdTime call and text this number when it needs
 *   you?". The answer belongs to that number: a new number has no answer.
 * - `chert-key.json`: the project API key of Chert and the project it is for.
 *
 * Both are owner-only files (see private-file.ts). The text channel and the
 * reach read the key when the environment does not have it: a variable of the
 * environment wins. The owner's number of owner.json wins over the one of the
 * environment, for both (see ownerContact). Nothing here prints a key, and a
 * number is shown only by its last two digits.
 */
import { join } from "node:path";
import { z } from "zod";
import { readPrivateJSON, writePrivateJSON } from "./private-file.js";

export const ownerFile = (root: string) => join(root, "owner.json");
export const chertKeyFile = (root: string) => join(root, "chert-key.json");

const e164 = /^\+[1-9][0-9]{7,14}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A number in international form, as +15550100123. Null when it is not one. */
export function normalizePhone(raw: string): string | null {
  let value = raw.trim().replace(/[\s().-]/g, "");
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  return e164.test(value) ? value : null;
}
/** The only part of a number that ClawdTime shows. */
export const phoneEnding = (phone: string) =>
  `ends in ${phone.replace(/\D/g, "").slice(-2)}`;

const ownerSchema = z
  .object({
    version: z.literal(1),
    phone: z.string().regex(e164),
    consent: z
      .object({
        answer: z.enum(["yes", "no"]),
        at: z.number().int().nonnegative(),
        /** The calling policy that this yes made, once it is made. */
        policyId: z.string().min(1).max(300).optional(),
      })
      .strict()
      .optional(),
    /**
     * Calling policies that a no took out of proactive.json while no desktop
     * service ran to take them back. The next run with the service does.
     */
    revoke: z.array(z.string().min(1).max(300)).max(64).optional(),
  })
  .strict();
export type OwnerRecord = z.infer<typeof ownerSchema>;

const keySchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().regex(uuid),
    apiKey: z.string().min(16).max(4096),
  })
  .strict();
export type ChertKeyRecord = z.infer<typeof keySchema>;

const notValid = (file: string) =>
  `${file} is not valid, so it is not used and not changed. Look at it, and move it away to start again.`;

/** The stored owner, or null, and the problem of the file when it cannot be used. */
export function readOwner(root: string): {
  owner: OwnerRecord | null;
  problem: string | null;
} {
  const file = ownerFile(root);
  const read = readPrivateJSON(file);
  if (read.problem || read.value === null)
    return { owner: null, problem: read.problem };
  const parsed = ownerSchema.safeParse(read.value);
  return parsed.success
    ? { owner: parsed.data, problem: null }
    : { owner: null, problem: notValid(file) };
}
export function writeOwner(root: string, owner: OwnerRecord) {
  writePrivateJSON(ownerFile(root), ownerSchema.parse(owner));
}

/** The stored project API key with its project, or null. It is never shown. */
export function readChertKey(root: string): {
  key: ChertKeyRecord | null;
  problem: string | null;
} {
  const file = chertKeyFile(root);
  const read = readPrivateJSON(file);
  if (read.problem || read.value === null)
    return { key: null, problem: read.problem };
  const parsed = keySchema.safeParse(read.value);
  return parsed.success
    ? { key: parsed.data, problem: null }
    : { key: null, problem: notValid(file) };
}
export function writeChertKey(root: string, key: ChertKeyRecord) {
  writePrivateJSON(chertKeyFile(root), keySchema.parse(key));
}

/** The project API key that `clawdtime connect` stored for the text channel. A file that cannot be used gives nothing. */
export function storedTextValues(root: string): { key?: ChertKeyRecord } {
  const { key } = readChertKey(root);
  return key ? { key } : {};
}

/**
 * The owner's number for a text or a call: one source for the text channel
 * and the reach. With the state folder, owner.json decides when it is there:
 * its number, with the owner's answer. Without owner.json, the number of the
 * environment is used, with no answer. An owner.json that is there but cannot
 * be used gives no number and its problem: nothing falls back to the number
 * of the environment then, so no text goes out without the stored answer.
 */
export function ownerContact(
  env: Record<string, string | undefined>,
  root?: string,
):
  | { phone: string; stored: boolean; consent?: "yes" | "no" }
  | { problem: string } {
  if (root) {
    const { owner, problem } = readOwner(root);
    if (problem) return { problem };
    if (owner)
      return {
        phone: owner.phone,
        stored: true,
        ...(owner.consent ? { consent: owner.consent.answer } : {}),
      };
  }
  return {
    phone: (env.CLAWDTIME_OWNER_PHONE ?? "").replace(/[\s().-]/g, ""),
    stored: false,
  };
}
