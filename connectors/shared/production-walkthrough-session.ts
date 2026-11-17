import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { presentationScenePlanSchema } from "../../src/presentation-scene-contracts.js";
import { ClawdTimeClient } from "./client.js";
import { FileNativeSceneJournal } from "./native-scene-journal.js";
import { loadConnection, secureRead, type RunState } from "./state.js";
import { ProductionWalkthroughController } from "./production-native.js";
import { startProductionNativeTrigger } from "./production-native-trigger.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const commandSchema = z.discriminatedUnion("command", [
  z.object({ id, command: z.literal("status") }).strict(),
  z
    .object({
      id,
      command: z.literal("prepare"),
      sceneId: id,
      operationId: id,
      action: z.enum(["activate_app", "raise_window"]).default("activate_app"),
    })
    .strict(),
  z.object({ id, command: z.literal("complete") }).strict(),
  z
    .object({
      id,
      command: z.literal("replan"),
      plan: presentationScenePlanSchema,
      expectedGeneration: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ id, command: z.literal("stop") }).strict(),
]);

/** Attach to this original chat; never register, call, rearm or start capture. */
export async function startProductionWalkthroughSession(options: {
  runFile: string;
  connectionFile?: string;
  planFile: string;
  requestId: string;
  backgroundActorsStopped: true;
  input?: Readable;
  output?: Writable;
}) {
  const runPath = resolve(options.runFile),
    run = secureRead<RunState>(runPath);
  const session = run.session;
  if (
    run.schemaVersion !== 1 ||
    !run.token ||
    !session ||
    session.state !== "active" ||
    session.id.length === 0 ||
    session.externalSessionId !== run.runId ||
    session.projectRoot !== run.projectRoot ||
    session.adapter !== run.adapter ||
    session.protocolVersion !== 2 ||
    session.capabilities.nativeActivationVersion !== 1 ||
    session.capabilities.livePresentationVersion !== 1 ||
    !session.capabilities.sharedSurface ||
    session.capabilities.nativeControl !== "desktop" ||
    session.screenCamera?.surface.kind !== "display" ||
    session.conversation ||
    session.documentAccess ||
    options.backgroundActorsStopped !== true
  )
    throw new Error(
      "Use an existing exact active same-chat native-activation run with stopped conflicting actors; do not replace an old session.",
    );
  const connection = loadConnection(
    options.connectionFile ??
      join(dirname(dirname(runPath)), "connection.json"),
    run.projectRoot,
    run.adapter,
  );
  if (
    session.pairingId !== connection.pairing.id ||
    session.hostId !== connection.hostId
  )
    throw new Error("Walkthrough connection identity mismatch.");
  const plan = presentationScenePlanSchema.parse(secureRead(options.planFile));
  const journal = new FileNativeSceneJournal(`${runPath}.walkthrough.json`);
  const input = options.input ?? process.stdin,
    output = options.output ?? process.stdout;
  const emit = (value: unknown) => output.write(`${JSON.stringify(value)}\n`);
  let controller: ProductionWalkthroughController | undefined;
  let trigger:
    Awaited<ReturnType<typeof startProductionNativeTrigger>> | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  const stop = () => {
    controller?.stop();
    lines?.close();
  };
  try {
    if (journal.read().length)
      throw new Error(
        "A prior walkthrough journal exists. Preserve its receipts and reconcile the original operations; do not restart its plan or replace the journal.",
      );
    const client = new ClawdTimeClient(connection.baseUrl, run.token);
    const owner = (await client.conversationExecution(options.requestId)) as {
      sessionId?: string;
    };
    if (owner.sessionId !== session.id)
      throw new Error("Request belongs to another session.");
    controller = new ProductionWalkthroughController({
      client,
      requestId: options.requestId,
      sessionId: session.id,
      plan,
      backgroundActorsStopped: () => options.backgroundActorsStopped === true,
    });
    await controller.native.status();
    trigger = await startProductionNativeTrigger(controller);
    // The fragment is a transient loopback capability for the original chat's CUA; do not log it.
    emit({
      event: "ready",
      requestId: options.requestId,
      sessionId: session.id,
      triggerUrl: trigger.url,
      instruction:
        "Use the original chat's permitted CUA for the fixed prepared operation. Keep this capability URL private. Companion Stop independently ends capture/input.",
    });
    lines = createInterface({ input, crlfDelay: Infinity });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const records: Array<{
      id: string;
      fingerprint: string;
      operationId?: string;
      state: "reserved" | "returned";
    }> = [];
    for await (const line of lines) {
      if (Buffer.byteLength(line) > 65536) {
        emit({ error: "Command exceeds its bound." });
        continue;
      }
      let command: z.infer<typeof commandSchema> | undefined;
      try {
        command = commandSchema.parse(JSON.parse(line));
        const hash = createHash("sha256")
          .update(JSON.stringify(command))
          .digest("hex");
        if (command.command !== "status") {
          const prior = records.find((r) => r.id === command!.id);
          if (prior)
            throw new Error(
              prior.fingerprint === hash
                ? "Command already reserved; inspect its original status/receipt without replay."
                : "Command ID already bound.",
            );
          if (records.length >= 256)
            throw new Error("Walkthrough command bound reached.");
          records.push({
            id: command.id,
            fingerprint: hash,
            state: "reserved",
            ...(command.command === "prepare"
              ? { operationId: command.operationId }
              : {}),
          });
          journal.write(records);
        }
        const result =
          command.command === "prepare"
            ? await controller.prepare(
                command.sceneId,
                command.operationId,
                command.action,
              )
            : command.command === "replan"
              ? await controller.replan(
                  command.plan,
                  command.expectedGeneration,
                )
              : command.command === "complete"
                ? controller.scenes.complete()
                : command.command === "stop"
                  ? (controller.stop(), { stopped: true })
                  : controller.status();
        if (command.command !== "status") {
          records.at(-1)!.state = "returned";
          journal.write(records);
        }
        emit({ id: command.id, ok: true, result });
        if (command.command === "stop") break;
      } catch {
        emit({
          id: command?.id ?? null,
          ok: false,
          error:
            "Walkthrough command refused or outcome unknown. Inspect current status and original production receipt; do not replay input.",
        });
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    controller?.stop();
    lines?.close();
    await trigger?.close();
    journal.close();
  }
}
