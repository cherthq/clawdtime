import { z } from "zod";
import { secureRead } from "../connectors/shared/state.js";
import { proactivePolicySchema } from "../src/attention/proactive-policy.js";
import { taskOrigin } from "./tasks.js";

/** Protected local operator path. Credentials and policy statements never appear in CLI output. */
export async function proactiveCli(
  args: string[],
  deps: { request?: typeof fetch; print?: (text: string) => void } = {},
) {
  const print = deps.print ?? console.log,
    command = args[0] ?? "help";
  if (command === "help" || command === "--help") {
    print(
      "proactive doctor|intents --origin LOOPBACK_ORIGIN --operator-file PRIVATE_FILE\nproactive policy --origin LOOPBACK_ORIGIN --operator-file PRIVATE_FILE --file PRIVATE_POLICY_JSON\nproactive enroll --origin LOOPBACK_ORIGIN --operator-file PRIVATE_FILE --file PRIVATE_ENROLLMENT_JSON\nproactive revoke|stop --origin LOOPBACK_ORIGIN --operator-file PRIVATE_FILE --id EXACT_ID\nPolicies require explicit version-2 calling/viewing consent. Writes are submitted once; retain IDs when reconciling lost responses.",
    );
    return;
  }
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key?.startsWith("--") ||
      !value ||
      value.startsWith("--") ||
      flags[key.slice(2)] !== undefined
    )
      throw Error("Use each --option value once.");
    flags[key.slice(2)] = value;
  }
  const allowed: Record<string, string[]> = {
    doctor: [],
    intents: [],
    policy: ["file"],
    enroll: ["file"],
    revoke: ["id"],
    stop: ["id"],
  };
  if (
    !allowed[command] ||
    Object.keys(flags).some(
      (key) => !["origin", "operator-file", ...allowed[command]!].includes(key),
    )
  )
    throw Error("Unknown proactive command or option; use proactive help.");
  const need = (key: string) => {
    if (!flags[key]) throw Error(`Missing --${key}.`);
    return flags[key]!;
  };
  const origin = taskOrigin(need("origin"));
  const credential = z
    .object({ token: z.string().min(32) })
    .strict()
    .parse(secureRead(need("operator-file")));
  let path = `/operator/proactive/${command}`,
    body: unknown;
  if (command === "policy") {
    path = "/operator/proactive/policies";
    body = proactivePolicySchema.parse(secureRead(need("file")));
  }
  if (command === "enroll")
    body = z
      .object({
        policyId: z.string().min(1),
        projectRoot: z.string().min(1),
        sessionKey: z.string().optional(),
        jobRunId: z.string().optional(),
        expiresAt: z.number().positive(),
        responseSeconds: z.number().int().min(1).max(540).optional(),
      })
      .strict()
      .parse(secureRead(need("file")));
  if (command === "revoke")
    path = `/operator/proactive/policies/${encodeURIComponent(need("id"))}/revoke`;
  if (command === "stop")
    path = `/operator/proactive/intents/${encodeURIComponent(need("id"))}/stop`;
  const read = command === "doctor" || command === "intents";
  const response = await (deps.request ?? fetch)(`${origin}${path}`, {
    method: read ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${credential.token}`,
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok)
    throw Error(
      `Proactive ${command} refused (HTTP ${response.status}); no retry was sent.`,
    );
  print(JSON.stringify(await response.json(), null, 2));
}
