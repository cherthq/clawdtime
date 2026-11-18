/** Bundle and execute in the existing backend container. GETs/read-only SQLite only.
 * No runtime rows or credentials leave that container. */
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline";
import { NativeTaskAudioReadiness } from "../src/transport/task-audio-readiness.js";
import {
  taskAudioPlanSchema,
  type TaskAudioAuthorization,
} from "../src/transport/task-audio.js";
import type { EffectReceipt, Pairing } from "../src/contracts.js";
import { hash } from "../src/storage/security.js";
import { taskAudioFingerprint } from "../src/transport/task-audio.js";
import type { Store } from "../src/storage/store.js";

async function inspect(input: any) {
  const plan = taskAudioPlanSchema.parse(input.plan);
  const authorization = input.authorization as TaskAudioAuthorization;
  if (
    process.env.CLAWDTIME_MODE !== "standby" ||
    process.env.CLAWDTIME_LIVE_TRAFFIC !== "false" ||
    !input.deploymentId ||
    process.env.RAILWAY_DEPLOYMENT_ID !== input.deploymentId
  )
    throw new Error("Verified exclusive standby deployment is required.");
  const config = JSON.parse(process.env.CLAWDTIME_LIVE_CONFIG_JSON!);
  const health = await fetch(
    "http://127.0.0.1:" +
      (process.env.CLAWDTIME_PORT ?? "3310") +
      "/internal/readiness",
    {
      headers: {
        authorization: "Bearer " + process.env.CLAWDTIME_OPERATOR_TOKEN,
      },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    },
  );
  const h = (await health.json()) as Record<string, unknown>;
  if (
    !health.ok ||
    h.mode !== "live" ||
    h.pending !== 0 ||
    h.unknown !== 0 ||
    h.activeCalls !== 0
  )
    throw new Error("Hosted owner is not idle in standby.");
  const db = new DatabaseSync(process.env.CLAWDTIME_DATABASE!, {
    readOnly: true,
  });
  const view: Pick<Store, "get" | "all" | "state" | "effects"> = {
    get<T>(kind: string, id: string): T | undefined {
      const row = db
        .prepare("SELECT body FROM entities WHERE kind=? AND id=?")
        .get(kind, id);
      return row ? (JSON.parse(String(row.body)) as T) : undefined;
    },
    all<T>(kind: string): T[] {
      return db
        .prepare("SELECT body FROM entities WHERE kind=?")
        .all(kind)
        .map((r) => JSON.parse(String(r.body)) as T);
    },
    state<T>(key: string): T | undefined {
      const row = db
        .prepare("SELECT body FROM operational_state WHERE key=?")
        .get(key);
      return row ? (JSON.parse(String(row.body)) as T) : undefined;
    },
    effects(state?: EffectReceipt["state"]): EffectReceipt[] {
      return db
        .prepare("SELECT body FROM effects")
        .all()
        .map((r) => JSON.parse(String(r.body)) as EffectReceipt)
        .filter((r) => !state || r.state === state);
    },
  };
  try {
    if (view.state("runtime:mode") !== "standby")
      throw new Error("Current runtime has not entered standby.");
    const pairing = view.get<Pairing>("pairing", plan.pairingId);
    if (
      !pairing ||
      pairing.revokedAt !== undefined ||
      pairing.memberId !== plan.memberId ||
      pairing.deviceId !== plan.deviceId ||
      pairing.lineId !== plan.lineId ||
      hash(pairing.recipient) !== plan.recipientHash ||
      config.binding.lineId !== plan.lineId ||
      !config.testerAllowlist.includes(pairing.recipient) ||
      config.handoff.owner !== "clawdtime" ||
      config.handoff.sourceOwnerPaused !== true
    )
      throw new Error("Current destination or ownership authority differs.");
    if (input.authorityOnly === true) {
      return {
        authorized: true,
        checkedAt: Date.now(),
        planFingerprint: taskAudioFingerprint(plan),
      };
    }
    // Original handoff identity remains intact; actual current standby supplies
    // fresh pause evidence. No historical cursor or record is rewritten.
    const handoff = {
      ...config.handoff,
      checkedAt: Date.now(),
      sourcePauseEvidence: `standby:${input.deploymentId}`,
      rollbackRecord: input.restoreRecord,
    };
    const inspector = new NativeTaskAudioReadiness(view, {
      ...config,
      handoff: () => handoff,
    });
    const evidence = await inspector.check(plan, authorization);
    return evidence;
  } finally {
    db.close();
  }
}
if (process.argv[1] === "rpc") {
  let queue = Promise.resolve();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  console.log(JSON.stringify({ ready: true, version: 1 }));
  input.on("line", (line) => {
    if (line.length > 1_048_576) {
      input.close();
      process.exitCode = 1;
      return;
    }
    queue = queue.then(async () => {
      let id: string | undefined;
      try {
        const message = JSON.parse(line);
        if (
          Object.keys(message).sort().join(",") !== "id,payload" ||
          typeof message.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,120}$/.test(message.id)
        )
          throw Error();
        id = message.id;
        const value = await inspect(message.payload);
        console.log(JSON.stringify({ id, ok: true, value }));
      } catch {
        if (id)
          console.log(
            JSON.stringify({ id, ok: false, error: "inspection_failed" }),
          );
        else {
          input.close();
          process.exitCode = 1;
        }
      }
    });
  });
} else {
  inspect(JSON.parse(process.argv[1]!))
    .then((value) => console.log(JSON.stringify(value)))
    .catch(() => {
      console.error(
        "Read-only native readiness refused; configuration and records withheld.",
      );
      process.exitCode = 1;
    });
}
