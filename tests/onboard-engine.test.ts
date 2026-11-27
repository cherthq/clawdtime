import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  desktopStarter,
  noTerminalLine,
  onboardCli,
  TerminalWizard,
} from "../cli/onboard.js";
import type { startCli } from "../cli/start.js";
import type { DesktopReadiness } from "../connectors/agents/desktop-readiness.js";
import { keyRows } from "../connectors/computer/keys.js";
import {
  readComputerSwitch,
  setComputerSwitch,
} from "../connectors/computer/journal.js";
import {
  OnboardEngine,
  type OnboardPorts,
  type PermissionFacts,
} from "../src/onboard/engine.js";
import {
  acceptSharedInvitation,
  coordinatorPost,
  readSharedPairing,
  requestSharedInvitation,
  sharedAcceptance,
  sharedPairingPaths,
  startSharedSignIn,
  verifySharedSignIn,
} from "../src/onboard/pairing.js";
import {
  jsonLinesIO,
  stepIds,
  type OnboardCommand,
  type OnboardEvent,
  type StepEvent,
} from "../src/onboard/protocol.js";
import { fakeCoordinator, member } from "./onboard-fixture.js";

// Made-up values only. Nothing here texts, calls, captures or opens a pane.
const key = `sk-made-up-${"k".repeat(40)}`;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function folder() {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-onboard-"));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

const desktopAbsent: DesktopReadiness = {
  service: "absent",
  chat: "unknown",
  taskSession: "unknown",
  taskAdmission: "unknown",
  computer: "unknown",
  computerMode: "unknown",
  physicalVerification: "required",
};

/** A fake Mac: a desktop that a start makes ready, a permission checker and
 * a connection that only records. */
function fakeMac(
  options: {
    permissions?: PermissionFacts[];
    desktop?: "absent" | "connected";
    request?: typeof fetch;
    /** A `shared run` that setup did not start, and the desktop it serves. */
    other?: { instanceId: string };
    /** What the desktop reports of computer use, before and after a restart. */
    computer?: {
      before: DesktopReadiness["computer"];
      after: DesktopReadiness["computer"];
    };
    taskAdmission?: DesktopReadiness["taskAdmission"];
    /** Called as each port is called, before it acts. */
    onCall?: (port: string) => void;
    /** The Darwin major version: 25 unless set. */
    darwinMajor?: number;
  } = {},
) {
  const call = (port: string) => options.onCall?.(port);
  const calls = {
    desktopStarts: 0,
    desktopRestarts: 0,
    desktopStops: 0,
    permissionChecks: 0,
    connectionStarts: 0,
    connectionStops: 0,
    validated: 0,
  };
  let desktop = options.desktop ?? "absent";
  let connection: "running" | "stopped" = "stopped";
  let restarted = false;
  const granted: PermissionFacts = {
    panel: {
      path: "/Applications/Made Up/ClawdTimeTaskPanel",
      accessibility: true,
      screenRecording: true,
    },
    capture: {
      path: "/Applications/Made Up/ClawdTimeTaskCapture",
      screenRecording: true,
    },
  };
  const permissions = [...(options.permissions ?? [])];
  const ports: OnboardPorts = {
    mac: async () => ({
      darwinMajor: options.darwinMajor ?? 25,
      appleSilicon: true,
    }),
    helpers: () => ({ panel: true, capture: true }),
    desktop: {
      status: async () => {
        call("desktop.status");
        return desktop === "connected"
          ? {
              ...desktopAbsent,
              service: "connected",
              chat: "connected",
              computer: options.computer
                ? restarted
                  ? options.computer.after
                  : options.computer.before
                : "configured",
              // A live desktop has an authorized session, as the real one says.
              taskSession: "active",
              taskAdmission: options.taskAdmission ?? "available",
            }
          : desktopAbsent;
      },
      instanceId: async () =>
        desktop === "connected"
          ? restarted
            ? "desktop_2"
            : "desktop_1"
          : null,
      start: async (log) => {
        call("desktop.start");
        calls.desktopStarts++;
        log("Desktop panel requested.");
        desktop = "connected";
      },
      restart: async () => {
        call("desktop.restart");
        calls.desktopRestarts++;
        restarted = true;
      },
      stop: async () => {
        calls.desktopStops++;
        desktop = "absent";
      },
    },
    permissions: async () => {
      calls.permissionChecks++;
      return permissions.shift() ?? granted;
    },
    displays: {
      capture: () => "/Applications/Made Up/ClawdTimeTaskCapture",
      list: async () => [
        { displayId: "1", width: 2560, height: 1440, isMain: true },
      ],
      resolve: async (displayId) => ({
        displayId: Number(displayId),
        displayUUID: "11111111-2222-3333-4444-555555555555",
        x: 0,
        y: 0,
        width: 2560,
        height: 1440,
      }),
    },
    connection: {
      status: async () => connection,
      holder: async () =>
        connection === "running"
          ? { instanceId: restarted ? "desktop_2" : "desktop_1", managed: true }
          : options.other
            ? { instanceId: options.other.instanceId, managed: false }
            : null,
      start: async () => {
        calls.connectionStarts++;
        connection = "running";
      },
      stop: async () => {
        calls.connectionStops++;
        connection = "stopped";
      },
    },
    validateKey: async () => {
      call("validateKey");
      calls.validated++;
      return "valid";
    },
    request: options.request ?? fetch,
  };
  return { ports, calls };
}

/** A command as a test writes it. runJson names the question of the event,
 * as the app and the terminal do, unless the command has its own `question`. */
type Reply =
  | { type: "cancel" }
  | (Omit<Extract<OnboardCommand, { type: "input" }>, "question"> & {
      question?: string | undefined;
    })
  | (Omit<Extract<OnboardCommand, { type: "action" }>, "question"> & {
      question?: string | undefined;
    });
type Responder = (event: StepEvent) => Reply | Reply[] | undefined;

/** The answers of a person who says yes to everything. */
const agree =
  (codeFor: () => string | undefined = () => undefined): Responder =>
  (event) => {
    const id = event.id;
    if (event.state === "failed")
      return { type: "action", id, action: "retry" };
    const input = event.input!;
    if (event.recovery?.action === "open_settings")
      return { type: "action", id, action: "recheck" };
    if (input.kind === "secret") return { type: "input", id, value: key };
    if (input.kind === "phone") return { type: "input", id, value: member };
    if (input.kind === "code")
      return { type: "input", id, value: codeFor() ?? "00000000" };
    if (input.kind === "choice")
      return { type: "input", id, value: input.options![0]!.id };
    if (input.kind === "confirm")
      return {
        type: "input",
        id,
        value: !input.prompt.startsWith("Allow your verified phone to ask"),
      };
    return { type: "input", id, value: "" };
  };

/** Runs `clawdtime onboard --json` with a scripted interface on its pipes. */
async function runJson(
  args: string[],
  home: string,
  ports: OnboardPorts,
  respond: Responder,
  extra: { now?: () => number; root?: string } = {},
) {
  const stdin = new PassThrough();
  const lines: string[] = [];
  const errors: string[] = [];
  let partial = "";
  // Each answer names the question it answers, as the app and the terminal
  // do. A command with its own `question` key keeps it.
  const send = (command: Reply, event: StepEvent) =>
    setImmediate(() =>
      stdin.write(
        `${JSON.stringify(
          command.type !== "cancel" && !("question" in command)
            ? { ...command, question: event.question }
            : command,
        )}\n`,
      ),
    );
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      partial += chunk.toString();
      let end: number;
      while ((end = partial.indexOf("\n")) >= 0) {
        const line = partial.slice(0, end);
        partial = partial.slice(end + 1);
        lines.push(line);
        const event = JSON.parse(line) as OnboardEvent;
        if (
          event.type === "step" &&
          (event.state === "needs_input" || event.state === "failed")
        ) {
          const answer = respond(event);
          for (const command of [answer ?? []].flat()) send(command, event);
          if (!answer) send({ type: "cancel" }, event);
        }
      }
      done();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, done) {
      errors.push(chunk.toString());
      done();
    },
  });
  const code = await onboardCli(["--json", ...args], {
    env: {},
    home,
    root: extra.root ?? folder(),
    stdin,
    stdout,
    stderr,
    ports,
    allowLoopback: true,
    pollMs: 0,
    ...(extra.now ? { now: extra.now } : {}),
  });
  const events = lines.map((line) => JSON.parse(line) as OnboardEvent);
  return { code, lines, events, errors };
}

const steps = (events: OnboardEvent[]) =>
  events.filter((event): event is StepEvent => event.type === "step");
const done = (events: OnboardEvent[]) =>
  events.find(
    (event): event is Extract<OnboardEvent, { type: "done" }> =>
      event.type === "done",
  )!;
const stateOf = (events: OnboardEvent[], id: string) =>
  done(events).report.find((row) => row.id === id)!.state;
const asked = (events: OnboardEvent[], id: string) =>
  steps(events).filter(
    (event) => event.id === id && event.state === "needs_input",
  ).length;

describe("clawdtime onboard --json", () => {
  it("runs local mode from hello to done with no coordinator", async () => {
    const home = folder();
    const requests: string[] = [];
    const mac = fakeMac({
      request: (async (url: string) => {
        requests.push(url);
        throw Error("no network in local mode");
      }) as unknown as typeof fetch,
    });
    const { code, events, lines } = await runJson(
      ["--local"],
      home,
      mac.ports,
      agree(),
    );
    expect(code).toBe(0);
    expect(events[0]).toEqual({
      type: "hello",
      protocol: 2,
      version: "unknown",
    });
    // Every line is one protocol object.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    // The first state of every step is pending, in the fixed order.
    expect(
      steps(events)
        .slice(0, stepIds.length)
        .map((event) => [event.id, event.state]),
    ).toEqual(stepIds.map((id) => [id, "pending"]));
    const report = done(events);
    expect(report.ready).toBe(true);
    expect(report.report.map((row) => [row.id, row.state])).toEqual([
      ["preflight", "ready"],
      ["model", "ready"],
      ["desktop", "ready"],
      ["computer", "ready"],
      ["permissions", "ready"],
      ["phone", "skipped"],
      ["pairing", "skipped"],
      ["connection", "skipped"],
      ["ready", "ready"],
    ]);
    expect(requests).toEqual([]);
    expect(mac.calls.desktopStarts).toBe(1);
    const root = join(home, ".local", "share", "clawdtime");
    expect(
      keyRows({}, root).rows.find((row) => row.provider.id === "openai")!.from,
    ).toEqual({ kind: "store" });
    expect(readComputerSwitch(root).enabled).toBe(true);
    // The key went in, and it never came back out.
    expect(lines.join("\n")).not.toContain(key);
  });

  it("pairs in shared mode from hello to done and never echoes a secret", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const home = folder();
    const mac = fakeMac();
    const { code, events, lines, errors } = await runJson(
      ["--coordinator", coordinator.origin],
      home,
      mac.ports,
      agree(() => coordinator.codeFor(member)),
    );
    expect(code).toBe(0);
    expect(done(events).ready).toBe(true);
    expect(done(events).report.map((row) => row.state)).toEqual(
      Array(stepIds.length).fill("ready"),
    );
    // One text, and only after the yes that came right before it.
    expect(coordinator.texts).toHaveLength(1);
    const consent = steps(events).findIndex(
      (event) =>
        event.input?.prompt === "Send a sign-in code to this number now?",
    );
    expect(consent).toBeGreaterThan(-1);
    const saved = readSharedPairing(sharedPairingPaths(home).file);
    expect(saved.kind).toBe("paired");
    if (saved.kind !== "paired") return;
    expect(saved.connection).toMatchObject({
      origin: coordinator.origin,
      displayId: "1",
      allowView: true,
      allowControl: false,
      walkthroughReports: true,
      capture: { binary: "/Applications/Made Up/ClawdTimeTaskCapture" },
    });
    expect(mac.calls.connectionStarts).toBe(1);
    // Scan every event and every log line.
    const everything = [...lines, ...errors].join("\n");
    for (const secret of [
      key,
      member,
      member.slice(2),
      coordinator.codeFor(member)!,
      saved.connection.credential,
    ])
      expect(everything).not.toContain(secret);
  });

  it("resumes on a rerun: a ready step is checked again, not repeated", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const home = folder();
    const mac = fakeMac();
    await runJson(
      ["--coordinator", coordinator.origin],
      home,
      mac.ports,
      agree(() => coordinator.codeFor(member)),
    );
    const again = await runJson(
      ["--coordinator", coordinator.origin],
      home,
      mac.ports,
      () => {
        throw Error("no question expected on a rerun");
      },
    );
    expect(again.code).toBe(0);
    expect(done(again.events).ready).toBe(true);
    for (const id of stepIds) expect(asked(again.events, id)).toBe(0);
    expect(mac.calls.desktopStarts).toBe(1);
    expect(mac.calls.connectionStarts).toBe(1);
    expect(coordinator.texts).toHaveLength(1);
  });

  it("asks for a new code after the code expired, only after a new yes", async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const coordinator = await fakeCoordinator({ now });
    cleanup.push(coordinator.close);
    let expiredOnce = false;
    const yes = agree(() => coordinator.codeFor(member));
    const { events } = await runJson(
      ["--coordinator", coordinator.origin],
      folder(),
      fakeMac().ports,
      (event) => {
        if (event.input?.kind === "code" && !expiredOnce) {
          expiredOnce = true;
          clock += 6 * 60_000;
        }
        return yes(event);
      },
      { now },
    );
    const expired = steps(events).find(
      (event) => event.id === "phone" && event.state === "failed",
    )!;
    expect(expired.detail).toBe("The code expired. Ask for a new one.");
    expect(expired.recovery).toEqual({
      label: "Send a new code",
      action: "retry",
    });
    // The retry asks for a new yes before the second text.
    const consents = steps(events).filter(
      (event) =>
        event.input?.prompt === "Send a sign-in code to this number now?",
    );
    expect(consents).toHaveLength(2);
    expect(coordinator.texts).toHaveLength(2);
    expect(stateOf(events, "phone")).toBe("ready");
  });

  it("opens the right pane for a denied permission and checks again", async () => {
    const denied: PermissionFacts = {
      panel: {
        path: "/Applications/Made Up/ClawdTimeTaskPanel",
        accessibility: false,
        screenRecording: true,
      },
      capture: { screenRecording: false },
    };
    const mac = fakeMac({ permissions: [denied, denied] });
    let first = true;
    const yes = agree();
    const { events } = await runJson(
      ["--local"],
      folder(),
      mac.ports,
      (event) => {
        if (event.id === "permissions" && first) {
          first = false;
          // Permissions cannot be skipped: the skip is refused and the
          // question comes again with a new id. Then the recheck works.
          return { type: "action", id: "permissions", action: "skip" };
        }
        return yes(event);
      },
    );
    const asking = steps(events).filter(
      (event) => event.id === "permissions" && event.state === "needs_input",
    );
    // Asked, asked again after the refused skip, asked after a denied recheck.
    expect(asking).toHaveLength(3);
    expect(asking[1]!.detail).toBe(asking[0]!.detail);
    expect(asking[1]!.question).not.toBe(asking[0]!.question);
    expect(asking[0]!.recovery).toEqual({
      label: "Open System Settings",
      action: "open_settings",
      url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    });
    expect(asking[0]!.detail).toContain(
      "In Accessibility, turn on ClawdTimeTaskPanel.",
    );
    expect(asking[0]!.details).toEqual([
      "ClawdTimeTaskPanel: /Applications/Made Up/ClawdTimeTaskPanel",
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "log" &&
          event.message === "This step cannot be skipped.",
      ),
    ).toBe(true);
    expect(mac.calls.permissionChecks).toBe(3);
    expect(stateOf(events, "permissions")).toBe("ready");
  });

  it("names each permission and each binary as System Settings shows them, and keeps the paths for the details", async () => {
    const denied: PermissionFacts = {
      panel: {
        path: "/Applications/Made Up/ClawdTimeTaskPanel",
        accessibility: false,
        screenRecording: false,
      },
      capture: { screenRecording: true },
    };
    for (const [darwinMajor, screen] of [
      [25, "Screen & System Audio Recording"],
      [23, "Screen Recording"],
    ] as const) {
      const mac = fakeMac({ permissions: [denied], darwinMajor });
      const { events } = await runJson(
        ["--local"],
        folder(),
        mac.ports,
        agree(),
      );
      const asking = steps(events).find(
        (event) => event.id === "permissions" && event.state === "needs_input",
      )!;
      expect(asking.detail).toBe(
        `In System Settings, open Privacy & Security. In Accessibility, turn on ClawdTimeTaskPanel. In ${screen}, turn on ClawdTimeTaskPanel. Then check again.`,
      );
      expect(asking.detail).not.toContain("/");
      expect(asking.details).toEqual([
        "ClawdTimeTaskPanel: /Applications/Made Up/ClawdTimeTaskPanel",
      ]);
    }
  });

  it("names the capture helper in the Screen Recording list in shared mode", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const denied: PermissionFacts = {
      panel: {
        path: "/Applications/Made Up/ClawdTimeTaskPanel",
        accessibility: false,
        screenRecording: true,
      },
      capture: {
        path: "/Applications/Made Up/ClawdTimeTaskCapture",
        screenRecording: false,
      },
    };
    const { events } = await runJson(
      ["--coordinator", coordinator.origin],
      folder(),
      fakeMac({ permissions: [denied] }).ports,
      agree(() => coordinator.codeFor(member)),
    );
    const asking = steps(events).find(
      (event) => event.id === "permissions" && event.state === "needs_input",
    )!;
    expect(asking.detail).toBe(
      "In System Settings, open Privacy & Security. In Accessibility, turn on ClawdTimeTaskPanel. In Screen & System Audio Recording, turn on ClawdTimeTaskCapture. Then check again.",
    );
    expect(asking.details).toEqual([
      "ClawdTimeTaskPanel: /Applications/Made Up/ClawdTimeTaskPanel",
      "ClawdTimeTaskCapture: /Applications/Made Up/ClawdTimeTaskCapture",
    ]);
    expect(asking.recovery?.url).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );
  });

  it("falls back to local mode when the coordinator does not answer", async () => {
    const { code, events } = await runJson(
      ["--coordinator", "http://127.0.0.1:1"],
      folder(),
      fakeMac().ports,
      agree(),
    );
    expect(code).toBe(0);
    const preflight = done(events).report.find(
      (row) => row.id === "preflight",
    )!;
    expect(preflight.detail).toContain("did not answer");
    expect(preflight.detail).toContain("local mode");
    expect(stateOf(events, "phone")).toBe("skipped");
    expect(asked(events, "phone")).toBe(0);
  });

  it("falls back to local mode for a coordinator with an older protocol", async () => {
    const coordinator = await fakeCoordinator({
      health: { service: "shared-number", mode: "enabled" },
    });
    cleanup.push(coordinator.close);
    const { events } = await runJson(
      ["--coordinator", coordinator.origin],
      folder(),
      fakeMac().ports,
      agree(),
    );
    expect(
      events.some(
        (event) =>
          event.type === "log" &&
          event.message.includes("is older than this ClawdTime"),
      ),
    ).toBe(true);
    expect(stateOf(events, "pairing")).toBe("skipped");
    expect(coordinator.paths).toEqual(["/health"]);
    expect(coordinator.texts).toHaveLength(0);
  });

  it("reads the coordinator from release.json, never guessed", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const root = folder();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(root, "release.json"),
      JSON.stringify({ version: "0.4.0", coordinator: coordinator.origin }),
    );
    const { events } = await runJson(
      [],
      folder(),
      fakeMac().ports,
      () => undefined,
      {
        root,
      },
    );
    const preflight = steps(events).find(
      (event) => event.id === "preflight" && event.state === "ready",
    )!;
    expect(preflight.detail).toContain(
      `Shared mode with ${coordinator.origin}.`,
    );
  });

  it("replaces another Mac only on an explicit choice that shows the consequence", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    // Another Mac paired this number first.
    const post = coordinatorPost(coordinator.origin);
    const challenge = await startSharedSignIn(post, member);
    const session = await verifySharedSignIn(
      post,
      challenge.challengeId,
      coordinator.codeFor(member)!,
    );
    await acceptSharedInvitation(
      post,
      await requestSharedInvitation(post, session.token, false),
      sharedAcceptance({ displayId: "1", shareScreen: false, control: false }),
    );
    const yes = agree(() => coordinator.codeFor(member));
    const keep = await runJson(
      ["--coordinator", coordinator.origin],
      folder(),
      fakeMac().ports,
      (event) =>
        event.input?.prompt === "Your number already has a paired Mac."
          ? { type: "input", id: "pairing", value: "keep" }
          : yes(event),
    );
    const choice = steps(keep.events).find(
      (event) =>
        event.input?.prompt === "Your number already has a paired Mac.",
    )!;
    expect(choice.input!.options!.find((o) => o.id === "replace")!.detail).toBe(
      "The other Mac loses access at once. Its open call ends, and its tasks get no callback.",
    );
    expect(stateOf(keep.events, "pairing")).toBe("skipped");
    expect(stateOf(keep.events, "connection")).toBe("skipped");

    const home = folder();
    const replace = await runJson(
      ["--coordinator", coordinator.origin],
      home,
      fakeMac().ports,
      (event) =>
        event.input?.prompt === "Your number already has a paired Mac."
          ? { type: "input", id: "pairing", value: "replace" }
          : yes(event),
    );
    expect(stateOf(replace.events, "pairing")).toBe("ready");
    expect(readSharedPairing(sharedPairingPaths(home).file).kind).toBe(
      "paired",
    );
  });

  it("in the app, the app owns the connection: setup asks, starts none, and ends one that Terminal setup started", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const home = folder();
    const mac = fakeMac();
    const yes = agree(() => coordinator.codeFor(member));
    // Terminal setup leaves its background connection running.
    await runJson(["--coordinator", coordinator.origin], home, mac.ports, yes);
    expect(mac.calls.connectionStarts).toBe(1);
    const app = await runJson(
      ["--coordinator", coordinator.origin, "--app"],
      home,
      mac.ports,
      yes,
    );
    expect(app.code).toBe(0);
    expect(stateOf(app.events, "connection")).toBe("ready");
    expect(asked(app.events, "connection")).toBe(1);
    // No second connection: the one of Terminal setup ends, the app starts its own.
    expect(mac.calls.connectionStarts).toBe(1);
    expect(mac.calls.connectionStops).toBe(1);
    expect(
      done(app.events).report.find((row) => row.id === "connection")!.detail,
    ).toBe("ClawdTime connects this Mac to the shared number when setup ends.");
  });

  it("in the app, a no to the connection ends the one that Terminal setup started, so the report is true", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const home = folder();
    const mac = fakeMac();
    const yes = agree(() => coordinator.codeFor(member));
    await runJson(["--coordinator", coordinator.origin], home, mac.ports, yes);
    expect(mac.calls.connectionStarts).toBe(1);
    const app = await runJson(
      ["--coordinator", coordinator.origin, "--app"],
      home,
      mac.ports,
      (event) =>
        event.id === "connection" && event.state === "needs_input"
          ? { type: "input", id: "connection", value: false }
          : yes(event),
    );
    expect(stateOf(app.events, "connection")).toBe("skipped");
    expect(
      done(app.events).report.find((row) => row.id === "connection")!.detail,
    ).toBe(
      "This Mac is not connected. The connection that ran in the background ended. To connect it later, run clawdtime onboard.",
    );
    expect(mac.calls.connectionStops).toBe(1);
    expect(await mac.ports.connection.status("desktop_1")).toBe("stopped");
  });

  it("a connection that does not stop after a no is reported as running, never as not connected", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const home = folder();
    const mac = fakeMac();
    const yes = agree(() => coordinator.codeFor(member));
    await runJson(["--coordinator", coordinator.origin], home, mac.ports, yes);
    mac.ports.connection.stop = async () => {
      throw Error("connection_did_not_stop");
    };
    const app = await runJson(
      ["--coordinator", coordinator.origin, "--app"],
      home,
      mac.ports,
      (event) =>
        event.id === "connection"
          ? event.state === "needs_input"
            ? { type: "input", id: "connection", value: false }
            : { type: "action", id: "connection", action: "skip" }
          : yes(event),
    );
    const failed = steps(app.events).find(
      (event) => event.id === "connection" && event.state === "failed",
    )!;
    expect(failed.detail).toBe(
      "The connection that runs in the background did not stop. Try again.",
    );
    expect(
      done(app.events).report.find((row) => row.id === "connection")!.detail,
    ).toBe(
      "A connection to the shared number still runs in the background. Run setup again to end it.",
    );
  });

  it("never starts a second connection: one that runs for this desktop is used", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const mac = fakeMac({ other: { instanceId: "desktop_1" } });
    const { events } = await runJson(
      ["--coordinator", coordinator.origin],
      folder(),
      mac.ports,
      agree(() => coordinator.codeFor(member)),
    );
    expect(stateOf(events, "connection")).toBe("ready");
    expect(asked(events, "connection")).toBe(0);
    expect(mac.calls.connectionStarts).toBe(0);
    expect(mac.calls.connectionStops).toBe(0);
  });

  it("starts no connection while one of an earlier desktop runs, in Terminal and in the app", async () => {
    for (const args of [[], ["--app"]]) {
      const coordinator = await fakeCoordinator();
      cleanup.push(coordinator.close);
      const mac = fakeMac({ other: { instanceId: "desktop_0" } });
      const yes = agree(() => coordinator.codeFor(member));
      const { events } = await runJson(
        ["--coordinator", coordinator.origin, ...args],
        folder(),
        mac.ports,
        (event) =>
          event.id === "connection" && event.state === "failed"
            ? { type: "action", id: "connection", action: "skip" }
            : yes(event),
      );
      const failed = steps(events).find(
        (event) => event.id === "connection" && event.state === "failed",
      )!;
      expect(failed.detail).toBe(
        "Another connection to the shared number runs on this Mac, for an earlier desktop. End that clawdtime shared run, then try again.",
      );
      expect(stateOf(events, "connection")).toBe("skipped");
      expect(mac.calls.connectionStarts).toBe(0);
      expect(mac.calls.connectionStops).toBe(0);
    }
  });

  it("in the app, a Stop during setup ends the desktop that setup started; in Terminal it stays", async () => {
    for (const [args, stops] of [
      [["--local", "--app"], 1],
      [["--local"], 0],
    ] as const) {
      const mac = fakeMac();
      const { code } = await runJson([...args], folder(), mac.ports, (event) =>
        event.id === "computer" ? undefined : agree()(event),
      );
      expect(code).toBe(1);
      expect(mac.calls.desktopStarts).toBe(1);
      expect(mac.calls.desktopStops).toBe(stops);
    }
  });

  it("starts an idle desktop again after the yes to computer use, in Terminal and in the app", async () => {
    for (const args of [["--local"], ["--local", "--app"]]) {
      const mac = fakeMac({
        computer: { before: "not_configured", after: "configured" },
      });
      const { events } = await runJson(args, folder(), mac.ports, agree());
      expect(mac.calls.desktopRestarts).toBe(1);
      expect(
        done(events).report.find((row) => row.id === "computer")!.detail,
      ).toBe("Computer use is on.");
    }
  });

  it("starts the desktop again on a rerun when computer use is on but the desktop has none", async () => {
    const home = folder();
    const first = fakeMac();
    await runJson(["--local"], home, first.ports, agree());
    const mac = fakeMac({
      desktop: "connected",
      computer: { before: "not_configured", after: "configured" },
    });
    const { events } = await runJson(["--local"], home, mac.ports, () => {
      throw Error("no question expected on a rerun");
    });
    expect(mac.calls.desktopRestarts).toBe(1);
    expect(stateOf(events, "computer")).toBe("ready");
  });

  it("never starts a busy desktop again: a task runs, or a connection serves it", async () => {
    const busy = [
      fakeMac({
        computer: { before: "not_configured", after: "configured" },
        taskAdmission: "blocked",
      }),
      fakeMac({
        computer: { before: "not_configured", after: "configured" },
        other: { instanceId: "desktop_1" },
      }),
    ];
    for (const mac of busy) {
      const { events } = await runJson(
        ["--local"],
        folder(),
        mac.ports,
        agree(),
      );
      expect(mac.calls.desktopRestarts).toBe(0);
      expect(
        done(events).report.find((row) => row.id === "computer")!.detail,
      ).toBe(
        "Computer use is on. The desktop is busy, so it uses computer use from its next start.",
      );
    }
  });

  it("stops with a cancel and reports where it stopped", async () => {
    const { code, events } = await runJson(
      ["--local"],
      folder(),
      fakeMac().ports,
      (event) => (event.id === "model" ? { type: "cancel" } : agree()(event)),
    );
    expect(code).toBe(1);
    expect(done(events).ready).toBe(false);
    expect(stateOf(events, "model")).toBe("needs_input");
    expect(stateOf(events, "desktop")).toBe("pending");
  });

  it("a double yes on showing the display cannot answer the question about computer actions", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const home = folder();
    const yes = agree(() => coordinator.codeFor(member));
    const { events } = await runJson(
      ["--coordinator", coordinator.origin],
      home,
      fakeMac().ports,
      (event) =>
        // One double click: the same answer goes out twice.
        event.input?.prompt.startsWith("Allow this display")
          ? [yes(event)!, yes(event)!].flat()
          : yes(event),
    );
    const saved = readSharedPairing(sharedPairingPaths(home).file);
    expect(saved.kind).toBe("paired");
    if (saved.kind !== "paired") return;
    // The person said no to computer actions and yes to reports.
    expect(saved.connection).toMatchObject({
      allowView: true,
      allowControl: false,
      walkthroughReports: true,
    });
    expect(
      events.some(
        (event) =>
          event.type === "log" &&
          event.message ===
            "That answer is not for the question that is open now. It was ignored.",
      ),
    ).toBe(true);
  });

  it("a repeated no on computer actions cannot land on the reports question", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const home = folder();
    const yes = agree(() => coordinator.codeFor(member));
    await runJson(
      ["--coordinator", coordinator.origin],
      home,
      fakeMac().ports,
      (event) =>
        event.input?.prompt.startsWith("Allow your verified phone to ask")
          ? [yes(event)!, yes(event)!].flat()
          : yes(event),
    );
    const saved = readSharedPairing(sharedPairingPaths(home).file);
    if (saved.kind !== "paired") throw Error("not paired");
    expect(saved.connection.allowControl).toBe(false);
    expect(saved.connection.walkthroughReports).toBe(true);
  });

  it("refuses an answer with no question, an unknown question or a used one, with no effect", async () => {
    const home = folder();
    const { events } = await runJson(
      ["--local"],
      home,
      fakeMac().ports,
      (event) =>
        event.id === "computer" && event.state === "needs_input"
          ? [
              {
                type: "input",
                id: "computer",
                question: undefined,
                value: true,
              },
              {
                type: "input",
                id: "computer",
                question: "made-up",
                value: true,
              },
              { type: "input", id: "computer", value: false },
              { type: "input", id: "computer", value: true },
            ]
          : agree()(event),
    );
    expect(stateOf(events, "computer")).toBe("skipped");
    expect(
      readComputerSwitch(join(home, ".local", "share", "clawdtime")).enabled,
    ).toBe(false);
    expect(stateOf(events, "permissions")).toBe("skipped");
    expect(done(events).ready).toBe(true);
  });

  it("gives every question its own id, and every answer names it", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const { events } = await runJson(
      ["--coordinator", coordinator.origin],
      folder(),
      fakeMac().ports,
      agree(() => coordinator.codeFor(member)),
    );
    const questions = steps(events)
      .filter((event) => event.state === "needs_input")
      .map((event) => event.question);
    expect(questions.length).toBeGreaterThan(8);
    for (const question of questions)
      expect(question).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(new Set(questions).size).toBe(questions.length);
  });

  it("ignores a line that is not a command without quoting it", async () => {
    const { events, lines } = await runJson(
      ["--local"],
      folder(),
      fakeMac().ports,
      (event) =>
        event.input?.kind === "secret"
          ? [
              // A key pasted as raw text, not as a command.
              { type: "input", id: "model", value: key, extra: 1 } as never,
              { type: "input", id: "model", value: key },
            ]
          : agree()(event),
    );
    expect(
      events.some(
        (event) =>
          event.type === "log" &&
          event.message ===
            "A command line was not understood. It was ignored.",
      ),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain(key);
    expect(done(events).ready).toBe(true);
  });
});

describe("clawdtime onboard in a terminal", () => {
  it("prints the one line and exits 3 with no terminal at all", async () => {
    const out: string[] = [];
    const stdin = new PassThrough();
    const code = await onboardCli([], {
      env: {},
      home: folder(),
      root: folder(),
      stdin,
      stdout: new Writable({
        write(chunk, _encoding, done) {
          out.push(chunk.toString());
          done();
        },
      }),
      openTerminal: () => null,
      ports: fakeMac().ports,
    });
    expect(code).toBe(3);
    expect(out.join("")).toBe(`${noTerminalLine}\n`);
    expect(noTerminalLine).toBe(
      "Run clawdtime onboard in Terminal to finish setup.",
    );
  });

  it("asks in plain sentences and never shows the key", async () => {
    const input = new PassThrough();
    const shown: string[] = [];
    const answers: [string, string][] = [
      ["Type a number", "1"],
      ["API key (it is not shown)", key],
      ["Turn on computer use?", "no"],
    ];
    const output = new Writable({
      write(chunk, _encoding, done) {
        const text = chunk.toString();
        shown.push(text);
        const next = answers[0];
        if (next && text.includes(next[0])) {
          answers.shift();
          setImmediate(() => input.write(`${next[1]}\n`));
        }
        done();
      },
    });
    const wizard = new TerminalWizard({ input, output, close: () => {} });
    // Every answer of the wizard names the question that it answers.
    const asked: string[] = [];
    const named: (string | undefined)[] = [];
    const io = {
      emit: (event: OnboardEvent) => {
        const question = (event as { question?: string }).question;
        if (question) asked.push(question);
        wizard.emit(event);
      },
      next: async () => {
        const command = await wizard.next();
        if (command.type !== "cancel")
          named.push((command as { question?: string }).question);
        return command;
      },
      cancelled: () => false,
    };
    const home = folder();
    const result = await new OnboardEngine(
      io,
      {
        version: "0.4.0",
        local: true,
        env: {},
        home,
        root: folder(),
        pollMs: 0,
      },
      fakeMac().ports,
    ).run();
    expect(result.ready).toBe(true);
    expect(named).toHaveLength(3);
    expect(named).toEqual(asked);
    const text = shown.join("");
    expect(text).toContain(
      "Model key: done. A key for OpenAI is in the protected key store.",
    );
    expect(text).toContain("Computer use: skipped.");
    expect(text).toContain("Setup is done.");
    // The answer went to the key store only: the wizard printed none of it.
    expect(text).not.toContain(key);
    expect(
      readFileSync(
        join(home, ".local", "share", "clawdtime", "computer", "keys.json"),
        "utf8",
      ),
    ).toContain(key);
  });
});

describe("a stop before the next effect", () => {
  /**
   * The engine on JSON lines in local mode. The person answers yes to each
   * question, and stops setup (a cancel and the end of the input, or the end
   * alone) at one moment: at hello, or as one port is called.
   */
  async function stopAt(
    moment: string,
    how: "cancel" | "end",
    setup: { env?: Record<string, string>; computerOn?: boolean } = {},
  ) {
    const home = folder();
    const root = join(home, ".local", "share", "clawdtime");
    if (setup.computerOn) setComputerSwitch(root, true, Date.now());
    const stdin = new PassThrough();
    let ended = false;
    const stop = () => {
      if (ended) return;
      ended = true;
      if (how === "cancel") stdin.write('{"type":"cancel"}\n');
      stdin.end();
    };
    const mac = fakeMac({
      computer: { before: "not_configured", after: "configured" },
      onCall: (port) => {
        if (port === moment) stop();
      },
    });
    const events: OnboardEvent[] = [];
    const yes = agree();
    const io = jsonLinesIO(stdin, (line) => {
      const event = JSON.parse(line) as OnboardEvent;
      events.push(event);
      if (event.type === "hello" && moment === "hello") stop();
      if (
        event.type === "step" &&
        (event.state === "needs_input" || event.state === "failed")
      )
        setImmediate(() => {
          if (ended) return;
          for (const reply of [yes(event) ?? []].flat())
            stdin.write(
              `${JSON.stringify({ ...reply, question: event.question })}\n`,
            );
        });
    });
    const result = await new OnboardEngine(
      io,
      {
        version: "0",
        local: true,
        env: setup.env ?? {},
        home,
        root: folder(),
        pollMs: 0,
        desktopWaitMs: 0,
      },
      mac.ports,
    ).run();
    io.close();
    const stored = keyRows({}, root).rows.some(
      (row) => row.from?.kind === "store",
    );
    return { result, events, calls: mac.calls, stored, root };
  }
  const withKey = { OPENAI_API_KEY: key };

  it("starts no desktop after a cancel and the end of the input right after hello", async () => {
    for (const how of ["cancel", "end"] as const) {
      const { result, calls } = await stopAt("hello", how, { env: withKey });
      expect(result).toEqual({ ready: false, cancelled: true });
      expect(calls.desktopStarts).toBe(0);
    }
  });

  it("stores no key when setup stops while the provider checks it", async () => {
    const { result, calls, stored } = await stopAt("validateKey", "cancel");
    expect(result.cancelled).toBe(true);
    expect(calls.validated).toBe(1);
    expect(stored).toBe(false);
    expect(calls.desktopStarts).toBe(0);
  });

  it("starts no desktop when setup stops while it checks the desktop", async () => {
    const { calls } = await stopAt("desktop.status", "end", { env: withKey });
    expect(calls.desktopStarts).toBe(0);
  });

  it("starts no desktop again when setup stops while the desktop starts", async () => {
    const { calls, root } = await stopAt("desktop.start", "cancel", {
      env: withKey,
      computerOn: true,
    });
    expect(calls.desktopStarts).toBe(1);
    expect(calls.desktopRestarts).toBe(0);
    expect(readComputerSwitch(root).enabled).toBe(true);
  });
});

describe("how setup starts the desktop", () => {
  it("opens no panel for the app, a panel in Terminal, and a tucked one on a restart", async () => {
    const seen: { args: string[]; panel?: boolean }[] = [];
    const start = (async (
      args: string[],
      dependencies: { panel?: boolean },
    ) => {
      seen.push({
        args,
        ...(dependencies.panel !== undefined
          ? { panel: dependencies.panel }
          : {}),
      });
    }) as unknown as typeof startCli;
    const base = { env: {}, home: "/Users/made-up", root: "/made-up/app" };
    await desktopStarter(true, base, start)(() => {});
    await desktopStarter(false, base, start)(() => {});
    await desktopStarter(false, base, start)(() => {}, { tucked: true });
    expect(seen).toEqual([
      { args: [], panel: false },
      { args: [] },
      { args: ["--tucked", "true"] },
    ]);
  });

  it("takes --app only with --json", async () => {
    await expect(
      onboardCli(["--app"], { ports: fakeMac().ports }),
    ).rejects.toThrow("--app goes with --json");
  });
});
