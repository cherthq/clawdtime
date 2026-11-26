import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sharedWalkthrough } from "../connectors/shared/shared-walkthrough.js";
import { Jobs } from "../connectors/agents/jobs.js";
import { stateRoot } from "../connectors/agents/hooks.js";
import { sharedJobCompletions } from "../connectors/shared/shared-job-completions.js";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import {
  privateFolder,
  readPrivateJSON,
  writePrivateJSON,
} from "../connectors/shared/private-file.js";
import { SharedMac, sharedOrigin } from "../connectors/shared/shared-mac.js";
import {
  desktopStateFolder,
  findDesktopService,
} from "../connectors/agents/desktop-chat.js";
import { callPhoneDesktop } from "../connectors/agents/phone-desktop.js";
import { Store } from "../src/storage/store.js";
import { routingId } from "../src/shared-number-contracts.js";
import { SharedDisplay } from "../connectors/shared/shared-display.js";
import { sharedDisplayTargetSchema } from "../src/control/proactive-display-views.js";
import { oneJSON } from "../src/control/proactive-views.js";

const configuration = z
  .object({
    origin: z.string(),
    credential: z.string().min(32),
    deviceId: routingId,
    displayId: routingId,
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
export async function sharedCli(args: string[]) {
  const directory = join(homedir(), ".config", "clawdtime", "shared");
  const file = join(directory, "connection.json");
  const system = { env: process.env, home: homedir() };
  if (!["pair", "run", "prove", "doctor"].includes(args[0] ?? "")) {
    console.log(
      "clawdtime shared pair HTTPS_ORIGIN\nclawdtime shared run\nclawdtime shared prove [CALL_ID]\nclawdtime shared doctor\nShared calls remain unavailable until the provider, media, and callback integrations are qualified.",
    );
    return;
  }
  const loaded = readPrivateJSON(file);
  if (loaded.problem) throw Error("shared_configuration_refused");
  const config = loaded.value ? configuration.parse(loaded.value) : null;
  const state = desktopStateFolder(system);
  const service = state ? findDesktopService(state) : null;
  if (args[0] === "doctor") {
    console.log(
      `Shared pairing: ${config ? "configured" : "missing"}. Desktop: ${service ? "available" : "missing"}. Live shared-call acceptance: not qualified.`,
    );
    return;
  }
  if (args[0] === "run") {
    if (!config || !service) throw Error("shared_pairing_and_desktop_required");
    const instanceId = service.instanceId;
    const store = new Store(join(directory, "receipts.sqlite"));
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const display = config.capture
      ? new SharedDisplay({
          ...config.capture,
          directory: join(directory, "capture"),
          inspect: (callId) =>
            callPhoneDesktop(
              system,
              { action: "inspect", callId },
              { expectedInstanceId: instanceId },
            ),
        })
      : null;
    const jobs = new Jobs(stateRoot(system), { project: homedir() });
    const client = new SharedMac({
      completions: () => {
        const facts = jobs.recent(1001);
        return facts.length > 1000
          ? []
          : sharedJobCompletions(facts, instanceId);
      },
      ...config,
      store,
      instanceId,
      execute: async (command, signal) => {
        if (command.operation.action === "walkthrough")
          return sharedWalkthrough({
            command,
            instanceId,
            jobs: jobs.recent(1001),
            directory: join(directory, "reports"),
            allowOpen: config.walkthroughReports,
            signal,
            inspect: (callId) =>
              callPhoneDesktop(
                system,
                { action: "inspect", callId },
                { expectedInstanceId: instanceId, signal },
              ),
            open: async (path) => {
              await promisify(execFile)("/usr/bin/open", [path], {
                timeout: 5000,
              });
            },
          });
        if (command.operation.action === "frame")
          return display
            ? display.frame(command.callId)
            : { ok: false, code: "screen_not_configured" };
        if (command.operation.action === "hide") {
          await display?.hide();
          return { ok: true };
        }
        if (
          command.operation.action === "close" ||
          command.operation.action === "stop"
        )
          await display?.hide();
        return callPhoneDesktop(
          system,
          command.operation.action === "chat"
            ? {
                action: "chat",
                callId: command.callId,
                requestId: command.operation.requestId,
                sharedTask: {
                  taskId: command.id,
                  callId: command.callId,
                  desktopInstanceId: command.instanceId,
                },
                payload: {
                  text: command.operation.text,
                  presentation: command.operation.presentation,
                },
              }
            : { action: command.operation.action, callId: command.callId },
          { expectedInstanceId: instanceId, signal },
        );
      },
      closeCall: async (callId) => {
        await display?.close();
        await callPhoneDesktop(
          system,
          { action: "close", callId },
          { expectedInstanceId: instanceId },
        );
      },
    });
    console.log(
      "Shared Mac connection starting. Press Ctrl+C to disconnect and close this connection's desktop calls.",
    );
    try {
      await client.run(controller.signal);
    } catch {
      if (!controller.signal.aborted)
        console.error(
          "Shared connection ended. No uncertain input was retried. Check the desktop before reconnecting.",
        );
    } finally {
      await display?.close();
      store.close();
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    return;
  }
  if (args[0] === "pair" && config)
    throw Error("shared_pairing_already_exists");
  const origin = sharedOrigin(
    args[0] === "pair" ? (args[1] ?? "") : (config?.origin ?? ""),
  );
  if (!process.stdin.isTTY) throw Error("shared_setup_requires_terminal");
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const post = async (path: string, input: unknown, bearer?: string) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw Error("shared_setup_refused");
    return response.json();
  };
  try {
    const recipient = (
      await terminal.question("Your own phone number, with country code: ")
    ).trim();
    if (
      (
        await terminal.question(
          `Send a sign-in code to that number through ${origin}? Type yes: `,
        )
      ).trim() !== "yes"
    )
      return;
    const challenge = z
      .object({ challengeId: z.string() })
      .parse(await post("/auth/start", { recipient }));
    const code = (
      await terminal.question("Enter the sign-in code from your phone: ")
    ).trim();
    const session = z
      .object({ token: z.string() })
      .parse(await post("/auth/verify", { ...challenge, code }));
    if (args[0] === "prove") {
      if (
        (
          await terminal.question(
            "Are you currently on the ClawdTime call you want to authorize? Type yes: ",
          )
        ).trim() !== "yes"
      )
        return;
      const callId = args[1]
        ? routingId.parse(args[1])
        : z
            .object({ callId: routingId })
            .parse(await post("/account/pending-call", {}, session.token))
            .callId;
      const proof = z
        .object({ code: z.string(), expiresAt: z.number() })
        .parse(await post("/account/proof", { callId }, session.token));
      console.log(
        `Say this code only on the ClawdTime call you started: ${proof.code}. It expires within two minutes.`,
      );
      return;
    }
    if (!service) throw Error("shared_desktop_required");
    const displayId = routingId.parse(
      (await terminal.question("Display ID to pair: ")).trim(),
    );
    const binary = (
      await terminal.question(
        "Absolute path to ClawdTimeTaskCapture for sharing this display, or Enter to disable sharing: ",
      )
    ).trim();
    let capture: z.infer<typeof configuration>["capture"];
    if (binary) {
      if (!isAbsolute(binary))
        throw Error("capture_binary_absolute_path_required");
      const target = sharedDisplayTargetSchema.parse(
        await oneJSON(binary, ["--resolve-display", displayId], true).result,
      );
      if (String(target.displayId) !== displayId)
        throw Error("display_selection_changed");
      if (
        (
          await terminal.question(
            "Allow this exact display to be shown during your verified calls? Type yes: ",
          )
        ).trim() === "yes"
      )
        capture = { binary, target };
    }
    const walkthroughReports =
      (
        await terminal.question(
          "Allow ClawdTime to open an inert task result report during your verified callbacks? Type yes: ",
        )
      ).trim() === "yes";
    const allowControl =
      (
        await terminal.question(
          "Allow this paired account to request computer actions on this Mac? Type yes: ",
        )
      ).trim() === "yes";
    if (
      (
        await terminal.question(
          "Pair this Mac with your verified account? Type yes: ",
        )
      ).trim() !== "yes"
    )
      return;
    const invitation = z
      .object({ invitation: z.string() })
      .parse(await post("/account/invite", {}, session.token));
    const accepted = z
      .object({
        credential: z.string(),
        pairing: z.object({ deviceId: routingId }),
      })
      .parse(
        await post("/pair/accept", {
          ...invitation,
          acceptance: {
            localAccepted: true,
            displayId,
            allowView: true,
            allowControl,
          },
        }),
      );
    privateFolder(directory);
    writePrivateJSON(file, {
      origin,
      credential: accepted.credential,
      deviceId: accepted.pairing.deviceId,
      displayId,
      walkthroughReports,
      ...(capture ? { capture } : {}),
    });
    console.log(
      "Mac paired. Run clawdtime shared run to connect it. No phone line was claimed and no screen sharing was started.",
    );
  } finally {
    terminal.close();
  }
}
