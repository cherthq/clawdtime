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
import { sharedSignIn } from "./shared-sign-in.js";
import {
  acceptSharedInvitation,
  coordinatorPost,
  CoordinatorError,
  requestSharedInvitation,
  resolveSharedDisplay,
  saveSharedPairing,
  sharedAcceptance,
  sharedConnectionLock,
  sharedConnectionSchema,
  sharedPairingPaths,
} from "../src/onboard/pairing.js";
import { takeProcessLock } from "../src/process-lock.js";
import type {
  SharedOperation,
  SharedResult,
} from "../src/shared-relay-contracts.js";

export { sharedAcceptance, sharedConnectionSchema };
const configuration = sharedConnectionSchema;

/** The Mac's own answers decide what it runs, whatever the coordinator
 * sends. Computer actions need both answers. Every other operation that
 * opens, renews, shows or reports needs view. Stop, close and hide only end or
 * reduce access, so they are never refused. */
export function localRefusal(
  answers: { allowView: boolean; allowControl: boolean },
  operation: SharedOperation,
): SharedResult | null {
  const allowed =
    operation.action === "stop" ||
    operation.action === "close" ||
    operation.action === "hide" ||
    (answers.allowView &&
      (operation.action !== "chat" || answers.allowControl));
  return allowed ? null : { ok: false, code: "declined_on_this_mac" };
}

/** The paired Mac asks for the call code with its own device credential. The
 * coordinator gives it only while this Mac's `shared run` connection is live,
 * so a sign-in session alone never yields a code. */
export async function sharedCallProof(
  config: { origin: string; credential: string },
  callId?: string,
  request: typeof fetch = fetch,
) {
  const response = await request(
    `${sharedOrigin(config.origin)}/device/call-proof`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.credential}`,
      },
      body: JSON.stringify(callId ? { callId: routingId.parse(callId) } : {}),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const body = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok)
    throw Error(
      z.object({ code: z.string().max(100) }).safeParse(body).data?.code ??
        "shared_call_proof_refused",
    );
  return z
    .object({
      callId: routingId,
      code: z.string().regex(/^\d{8}$/),
      expiresAt: z.number(),
    })
    .parse(body);
}

/** The Mac replaces its own device credential. The old one stops working at
 * once. If the answer is lost, pair again with --replace. */
export async function sharedRotate(
  config: { origin: string; credential: string },
  request: typeof fetch = fetch,
) {
  const response = await request(
    `${sharedOrigin(config.origin)}/device/rotate`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.credential}`,
      },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) throw Error("shared_rotation_refused");
  return z
    .object({ credential: z.string().min(32).max(512) })
    .parse(await response.json()).credential;
}

export async function sharedCli(args: string[]) {
  const { directory, file } = sharedPairingPaths(homedir());
  const system = { env: process.env, home: homedir() };
  if (!["pair", "run", "prove", "rotate", "doctor"].includes(args[0] ?? "")) {
    console.log(
      "clawdtime shared pair HTTPS_ORIGIN [--replace]   (--replace pairs this Mac in place of a lost one)\nclawdtime shared run\nclawdtime shared rotate   (replace this Mac's device credential)\nclawdtime shared prove [CALL_ID]   (on the paired Mac, while shared run is open)\nclawdtime shared doctor\nShared calls remain unavailable until the provider, media, and callback integrations are qualified.",
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
      `Shared pairing: ${config ? `configured, view ${config.allowView ? "allowed" : "declined"}, control ${config.allowControl ? "allowed" : "declined"}` : "missing"}. Desktop: ${service ? "available" : "missing"}. Live shared-call acceptance: not qualified.`,
    );
    return;
  }
  if (args[0] === "run") {
    if (!config || !service) throw Error("shared_pairing_and_desktop_required");
    const instanceId = service.instanceId;
    // One connection per Mac, whoever starts it: the app, setup in Terminal
    // or a person. The kernel ends the lock with this process.
    const lock = takeProcessLock(sharedConnectionLock(homedir()), {
      version: 1,
      pid: process.pid,
      instanceId,
      startedAt: Date.now(),
    });
    if (!lock)
      throw Error(
        "Another clawdtime shared run connects this Mac already. Only one connection runs at a time.",
      );
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
        const refusal = localRefusal(config, command.operation);
        if (refusal) return refusal;
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
      `Shared Mac connection starting. View ${config.allowView ? "allowed" : "declined"}, computer actions ${config.allowControl ? "allowed" : "declined"} on this Mac. Press Ctrl+C to disconnect and close this connection's desktop calls.`,
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
      lock.release();
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    return;
  }
  if (args[0] === "prove") {
    if (!config) throw Error("shared_pairing_required");
    if (!process.stdin.isTTY) throw Error("shared_setup_requires_terminal");
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      if (
        (
          await terminal.question(
            "Are you on the ClawdTime call from your verified phone now? Type yes: ",
          )
        ).trim() !== "yes"
      )
        return;
      let proof: Awaited<ReturnType<typeof sharedCallProof>>;
      try {
        proof = await sharedCallProof(config, args[1]);
      } catch {
        console.error(
          "No code was given. Keep clawdtime shared run open on this Mac, call the shared number from your verified phone, then run this again.",
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        `Say this code on the ClawdTime call: ${proof.code}. It works once, only for this Mac, and expires within two minutes.`,
      );
    } finally {
      terminal.close();
    }
    return;
  }
  if (args[0] === "rotate") {
    if (!config) throw Error("shared_pairing_required");
    let credential: string;
    try {
      credential = await sharedRotate(config);
    } catch {
      console.error(
        "The credential was not replaced, or its answer was lost. If this Mac can no longer connect, run clawdtime shared pair HTTPS_ORIGIN --replace.",
      );
      process.exitCode = 1;
      return;
    }
    writePrivateJSON(file, { ...config, credential });
    console.log(
      "This Mac has a new device credential. The old one no longer works. Start clawdtime shared run again.",
    );
    return;
  }
  const replace = args.includes("--replace");
  const pairArgs = args.slice(1).filter((arg) => arg !== "--replace");
  if (config && !replace)
    throw Error(
      "shared_pairing_already_exists: to pair this Mac again, add --replace",
    );
  const origin = sharedOrigin(pairArgs[0] ?? "");
  if (!process.stdin.isTTY) throw Error("shared_setup_requires_terminal");
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const send = coordinatorPost(origin);
  const post = async (path: string, input: unknown, bearer?: string) => {
    try {
      return await send(path, input, bearer);
    } catch (error) {
      if (
        error instanceof CoordinatorError &&
        error.status === 409 &&
        path === "/account/invite" &&
        !replace
      )
        throw Error(
          "shared_pairing_exists: this number already has a paired Mac. To pair this Mac in its place, add --replace",
        );
      throw Error("shared_setup_refused");
    }
  };
  try {
    // Only pairing signs in. A call is proved by the paired Mac itself.
    const session = await sharedSignIn({
      origin,
      ask: (question) => terminal.question(question),
      post,
    });
    if (!session) return;
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
      const target = await resolveSharedDisplay(binary, displayId);
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
    if (!capture)
      console.log(
        "This display is not shared, so calls cannot view or use this Mac. Computer actions stay off.",
      );
    const acceptance = sharedAcceptance({
      displayId,
      shareScreen: !!capture,
      control:
        !!capture &&
        (
          await terminal.question(
            "Allow this paired account to request computer actions on this Mac? Type yes: ",
          )
        ).trim() === "yes",
    });
    if (
      (
        await terminal.question(
          "Pair this Mac with your verified account? Type yes: ",
        )
      ).trim() !== "yes"
    )
      return;
    // A replacement revokes the old pairing of this number when it is accepted.
    const invitation = await requestSharedInvitation(
      post,
      session.token,
      replace,
    );
    const accepted = await acceptSharedInvitation(post, invitation, acceptance);
    saveSharedPairing(directory, file, {
      origin,
      credential: accepted.credential,
      deviceId: accepted.pairing.deviceId,
      displayId,
      allowView: acceptance.allowView,
      allowControl: acceptance.allowControl,
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
