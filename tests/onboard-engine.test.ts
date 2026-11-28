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
  firstRequest,
  OnboardEngine,
  type KnownKey,
  type OnboardPorts,
  type PermissionFacts,
} from "../src/onboard/engine.js";
import { providerById } from "../connectors/computer/providers.js";
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
  routeSteps,
  skippableSteps,
  stepIds,
  type OnboardCommand,
  type OnboardEvent,
  type StepEvent,
} from "../src/onboard/protocol.js";
import { DesktopStartError } from "../src/desktop-start.js";
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
    /** The ports remember the desktop that an app setup started, as the real ones do. */
    remembers?: boolean;
    /** The panel is missing from this install. */
    panelMissing?: boolean;
    /** The desktop start fails, or takes this long. */
    startFails?: boolean;
    startMs?: number;
    /** The errors of the next desktop starts, one for each start. */
    startErrors?: Error[];
    /** The ports can use or stop the desktop of another install. */
    otherInstall?: { stopFails?: Error };
    /** Keys in the shell startup files of the person. */
    knownKeys?: KnownKey[];
    /** What the provider says of each key: valid unless set. */
    verdict?: (key: string) => "valid" | "refused" | "unchecked";
    /** The ports can open the chat, as Terminal setup's do. */
    chat?: boolean;
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
    otherUses: 0,
    otherStops: 0,
    chatOpens: 0,
    keysChecked: [] as string[],
  };
  let desktop = options.desktop ?? "absent";
  /** The desktop that an app setup started runs, and no owner holds it. */
  let setupStarted = false;
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
    helpers: () => ({ panel: !options.panelMissing, capture: true }),
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
        if (options.startMs)
          await new Promise((done) => setTimeout(done, options.startMs));
        if (options.startFails) throw Error("The desktop did not start.");
        const refused = options.startErrors?.shift();
        if (refused) throw refused;
        log("Desktop panel requested.");
        desktop = "connected";
        if (options.remembers) setupStarted = true;
      },
      restart: async () => {
        call("desktop.restart");
        calls.desktopRestarts++;
        restarted = true;
      },
      stop: async () => {
        calls.desktopStops++;
        desktop = "absent";
        setupStarted = false;
      },
      ...(options.remembers
        ? {
            setupStarted: async () => setupStarted && desktop === "connected",
          }
        : {}),
      ...(options.chat
        ? {
            openChat: async () => {
              calls.chatOpens++;
            },
          }
        : {}),
      ...(options.otherInstall
        ? {
            useOther: async () => {
              calls.otherUses++;
              desktop = "connected";
            },
            stopOther: async () => {
              calls.otherStops++;
              if (options.otherInstall?.stopFails)
                throw options.otherInstall.stopFails;
            },
          }
        : {}),
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
    validateKey: async (_provider, checked) => {
      call("validateKey");
      calls.validated++;
      calls.keysChecked.push(checked);
      return options.verdict?.(checked) ?? "valid";
    },
    ...(options.knownKeys ? { knownKeys: async () => options.knownKeys! } : {}),
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
  extra: {
    now?: () => number;
    root?: string;
    cancelAtHello?: boolean;
    env?: Record<string, string | undefined>;
    /** Answers a step that is in progress and may be skipped. */
    progress?: (event: StepEvent) => Reply | undefined;
    /** How often the permissions step checks again by itself: never unless set. */
    permissionPollMs?: number;
  } = {},
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
        if (event.type === "hello" && extra.cancelAtHello)
          setImmediate(() => stdin.end('{"type":"cancel"}\n'));
        if (
          event.type === "step" &&
          event.state === "in_progress" &&
          event.question &&
          extra.progress
        ) {
          const answer = extra.progress(event);
          if (answer) send(answer, event);
        }
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
    env: extra.env ?? {},
    home,
    root: extra.root ?? folder(),
    stdin,
    stdout,
    stderr,
    ports,
    allowLoopback: true,
    pollMs: 0,
    permissionPollMs: extra.permissionPollMs ?? 0,
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
  it("runs the first run from hello to done: no coordinator, no phone, no text", async () => {
    const home = folder();
    const requests: string[] = [];
    const mac = fakeMac({
      request: (async (url: string) => {
        requests.push(url);
        throw Error("no network in the first run");
      }) as unknown as typeof fetch,
    });
    const { code, events, lines } = await runJson([], home, mac.ports, agree());
    expect(code).toBe(0);
    expect(events[0]).toEqual({
      type: "hello",
      protocol: 2,
      version: "unknown",
    });
    // Every line is one protocol object.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    // The first state of every step of the run is pending, in the fixed
    // order. The phone steps are not part of the first run.
    expect(
      steps(events)
        .slice(0, routeSteps.first.length)
        .map((event) => [event.id, event.state]),
    ).toEqual(routeSteps.first.map((id) => [id, "pending"]));
    expect(steps(events).some((event) => event.id === "phone")).toBe(false);
    const report = done(events);
    expect(report.ready).toBe(true);
    expect(report.report.map((row) => [row.id, row.state])).toEqual([
      ["preflight", "ready"],
      ["model", "ready"],
      ["desktop", "ready"],
      ["computer", "ready"],
      ["permissions", "ready"],
      ["ready", "ready"],
    ]);
    // Only the provider's key check went out: no coordinator, no text.
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

  it("gets calls on the phone in a later run, pairs from hello to done and never echoes a secret", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const home = folder();
    const mac = fakeMac();
    const first = await runJson(
      ["--coordinator", coordinator.origin],
      home,
      mac.ports,
      agree(),
    );
    // The first run never reads the coordinator, even when one is named.
    expect(first.code).toBe(0);
    expect(coordinator.paths).toEqual([]);
    const { code, events, lines, errors } = await runJson(
      ["--phone", "--coordinator", coordinator.origin],
      home,
      mac.ports,
      agree(() => coordinator.codeFor(member)),
    );
    expect(code).toBe(0);
    expect(done(events).ready).toBe(true);
    expect(done(events).report.map((row) => [row.id, row.state])).toEqual(
      routeSteps.phone.map((id) => [id, "ready"]),
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
    // Scan every event and every log line of both runs.
    const everything = [
      ...first.lines,
      ...first.errors,
      ...lines,
      ...errors,
    ].join("\n");
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
    await runJson([], home, mac.ports, agree());
    await runJson(
      ["--phone", "--coordinator", coordinator.origin],
      home,
      mac.ports,
      agree(() => coordinator.codeFor(member)),
    );
    const none = () => {
      throw Error("no question expected on a rerun");
    };
    // A paired Mac takes every step on a rerun, so that it stays connected.
    const again = await runJson(
      ["--coordinator", coordinator.origin],
      home,
      mac.ports,
      none,
    );
    expect(again.code).toBe(0);
    expect(done(again.events).ready).toBe(true);
    expect(done(again.events).report.map((row) => row.id)).toEqual([
      ...stepIds,
    ]);
    for (const id of stepIds) expect(asked(again.events, id)).toBe(0);
    const phone = await runJson(
      ["--phone", "--coordinator", coordinator.origin],
      home,
      mac.ports,
      none,
    );
    expect(phone.code).toBe(0);
    for (const id of stepIds) expect(asked(phone.events, id)).toBe(0);
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
      ["--phone", "--coordinator", coordinator.origin],
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
          // A check again before the person acted: the question comes again
          // with a new id. Then the recheck works.
          return { type: "action", id: "permissions", action: "recheck" };
        }
        return yes(event);
      },
    );
    const asking = steps(events).filter(
      (event) => event.id === "permissions" && event.state === "needs_input",
    );
    // Asked, then asked again after the recheck that found it still denied:
    // the person said it is on, so the words name an older build's permission.
    expect(asking).toHaveLength(2);
    expect(asking[1]!.detail).toMatch(
      /^Accessibility is still off for the app you run ClawdTime in, such as Terminal\. If the list shows ClawdTime on, macOS still holds the permission of an older ClawdTime\./,
    );
    expect(asking[1]!.question).not.toBe(asking[0]!.question);
    expect(asking[0]!.recovery).toEqual({
      label: "Open System Settings",
      action: "open_settings",
      url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    });
    expect(asking[0]!.detail).toContain(
      "In Accessibility, turn on the app you run ClawdTime in, such as Terminal.",
    );
    expect(asking[0]!.details).toEqual([
      "Checked for ClawdTimeTaskPanel: /Applications/Made Up/ClawdTimeTaskPanel",
    ]);
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
        `In System Settings, open Privacy & Security. In Accessibility, turn on the app you run ClawdTime in, such as Terminal. In ${screen}, turn on the app you run ClawdTime in, such as Terminal. Then check again.`,
      );
      expect(asking.detail).not.toContain("/");
      expect(asking.details).toEqual([
        "Checked for ClawdTimeTaskPanel: /Applications/Made Up/ClawdTimeTaskPanel",
      ]);
    }
  });

  it("names the app that macOS lists: ClawdTime in the Mac app, the terminal app in Terminal", async () => {
    const denied: PermissionFacts = {
      panel: {
        path: "/Applications/Made Up/ClawdTimeTaskPanel",
        accessibility: false,
        screenRecording: false,
      },
      capture: { screenRecording: true },
    };
    for (const [args, env, name] of [
      [["--local", "--app"], {}, "ClawdTime"],
      [["--local"], { TERM_PROGRAM: "Apple_Terminal" }, "Terminal"],
      [
        ["--local"],
        { TERM_PROGRAM: "made-up-term" },
        "the app you run ClawdTime in, such as Terminal",
      ],
    ] as const) {
      const mac = fakeMac({ permissions: [denied], darwinMajor: 25 });
      const { events } = await runJson(
        [...args],
        folder(),
        mac.ports,
        agree(),
        {
          env: { ...env },
        },
      );
      const asking = steps(events).find(
        (event) => event.id === "permissions" && event.state === "needs_input",
      )!;
      expect(asking.detail).toBe(
        `In System Settings, open Privacy & Security. In Accessibility, turn on ${name}. In Screen & System Audio Recording, turn on ${name}. Then check again.`,
      );
      expect(asking.detail).not.toContain("ClawdTimeTaskPanel");
      expect(asking.details).toEqual([
        "Checked for ClawdTimeTaskPanel: /Applications/Made Up/ClawdTimeTaskPanel",
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
    // The phone run checks the panel too while computer use is on.
    const home = folder();
    setComputerSwitch(
      join(home, ".local", "share", "clawdtime"),
      true,
      Date.now(),
    );
    const { events } = await runJson(
      ["--phone", "--coordinator", coordinator.origin],
      home,
      fakeMac({ permissions: [denied] }).ports,
      agree(() => coordinator.codeFor(member)),
    );
    const asking = steps(events).find(
      (event) => event.id === "permissions" && event.state === "needs_input",
    )!;
    expect(asking.detail).toBe(
      "In System Settings, open Privacy & Security. In Accessibility, turn on the app you run ClawdTime in, such as Terminal. In Screen & System Audio Recording, turn on the app you run ClawdTime in, such as Terminal. Then check again.",
    );
    expect(asking.details).toEqual([
      "Checked for ClawdTimeTaskPanel: /Applications/Made Up/ClawdTimeTaskPanel",
      "Checked for ClawdTimeTaskCapture: /Applications/Made Up/ClawdTimeTaskCapture",
    ]);
    expect(asking.recovery?.url).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );
  });

  describe("a permission that macOS still holds for an older build", () => {
    const both: PermissionFacts = {
      panel: {
        path: "/Applications/Made Up/ClawdTimeTaskPanel",
        accessibility: false,
        screenRecording: false,
      },
      capture: { screenRecording: true },
    };
    const granted: PermissionFacts = {
      panel: { accessibility: true, screenRecording: true },
      capture: { screenRecording: true },
    };
    /** The person says the switches are on twice; macOS refuses both times, then grants. */
    const recheckTwice: Responder = (event) =>
      event.id === "permissions"
        ? { type: "action", id: "permissions", action: "recheck" }
        : agree()(event);

    it("in the app, says so after a check again still fails, and names what is missing", async () => {
      const mac = fakeMac({ permissions: [both, both, granted] });
      const { events } = await runJson(
        ["--local", "--app"],
        folder(),
        mac.ports,
        recheckTwice,
      );
      const asking = steps(events).filter(
        (event) => event.id === "permissions" && event.state === "needs_input",
      );
      expect(asking).toHaveLength(2);
      // The first question: the usual words, and what macOS does not grant.
      expect(asking[0]!.detail).toBe(
        "In System Settings, open Privacy & Security. In Accessibility, turn on ClawdTime. In Screen & System Audio Recording, turn on ClawdTime. Then check again.",
      );
      expect(asking[0]!.permissions).toEqual({
        missing: ["accessibility", "screen_recording"],
        stale: false,
      });
      // The person said they are on, and macOS still refuses: an older build holds them.
      expect(asking[1]!.detail).toBe(
        "Accessibility and Screen & System Audio Recording are still off for ClawdTime. If the list shows ClawdTime on, macOS still holds the permission of an older ClawdTime. Remove ClawdTime from the list with the minus button, then turn it on again. Or click Reset ClawdTime permissions.",
      );
      // The app runs its own fixed reset: the event carries no command.
      expect(asking[1]!.permissions).toEqual({
        missing: ["accessibility", "screen_recording"],
        stale: true,
      });
      expect(asking[1]!.recovery?.action).toBe("open_settings");
      expect(stateOf(events, "permissions")).toBe("ready");
    });

    it("in Terminal, prints the two reset commands for the person to run, and runs nothing", async () => {
      const mac = fakeMac({ permissions: [both, both, granted] });
      const { events } = await runJson(
        ["--local"],
        folder(),
        mac.ports,
        recheckTwice,
        { env: { TERM_PROGRAM: "Apple_Terminal" } },
      );
      const asking = steps(events).filter(
        (event) => event.id === "permissions" && event.state === "needs_input",
      );
      expect(asking[1]!.detail).toBe(
        "Accessibility and Screen & System Audio Recording are still off for Terminal. If the list shows ClawdTime on, macOS still holds the permission of an older ClawdTime. Remove ClawdTime from the list with the minus button, then turn it on again. Or run these commands in Terminal, then check again.",
      );
      expect(asking[1]!.permissions).toEqual({
        missing: ["accessibility", "screen_recording"],
        stale: true,
        reset: [
          "tccutil reset Accessibility com.clawdtime.app",
          "tccutil reset ScreenCapture com.clawdtime.app",
        ],
      });
      // Only ClawdTime's own bundle id, never every app.
      for (const command of asking[1]!.permissions!.reset!)
        expect(command).toMatch(
          /^tccutil reset (Accessibility|ScreenCapture) com\.clawdtime\.app$/,
        );
      expect(stateOf(events, "permissions")).toBe("ready");
    });

    it("resets only what is still off", async () => {
      const accessibility: PermissionFacts = {
        panel: { accessibility: false, screenRecording: true },
        capture: { screenRecording: true },
      };
      const mac = fakeMac({
        permissions: [accessibility, accessibility, granted],
      });
      const { events } = await runJson(
        ["--local"],
        folder(),
        mac.ports,
        recheckTwice,
        { env: { TERM_PROGRAM: "Apple_Terminal" } },
      );
      const stale = steps(events).filter(
        (event) => event.id === "permissions" && event.state === "needs_input",
      )[1]!;
      expect(stale.detail).toMatch(
        /^Accessibility is still off for Terminal\. /,
      );
      expect(stale.permissions).toEqual({
        missing: ["accessibility"],
        stale: true,
        reset: ["tccutil reset Accessibility com.clawdtime.app"],
      });
    });

    it("is not said while the app checks again by itself: only after the person says they are on", async () => {
      const mac = fakeMac({ permissions: [both, both, both, granted] });
      const { events } = await runJson(
        ["--local", "--app"],
        folder(),
        mac.ports,
        (event) =>
          event.id === "permissions" && event.state === "needs_input"
            ? []
            : agree()(event),
        { permissionPollMs: 5 },
      );
      const asking = steps(events).filter(
        (event) => event.id === "permissions" && event.state === "needs_input",
      );
      expect(asking).toHaveLength(1);
      expect(asking[0]!.permissions?.stale).toBe(false);
      expect(stateOf(events, "permissions")).toBe("ready");
    });
  });

  it("falls back to local mode when the coordinator does not answer", async () => {
    const { code, events } = await runJson(
      ["--phone", "--coordinator", "http://127.0.0.1:1"],
      folder(),
      fakeMac().ports,
      agree(),
    );
    // The phone run is not done: calls from the phone cannot reach this Mac.
    expect(code).toBe(2);
    expect(stateOf(events, "ready")).toBe("skipped");
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
      ["--phone", "--coordinator", coordinator.origin],
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
    // The first run reads no coordinator: the phone run does.
    await runJson([], folder(), fakeMac().ports, agree(), { root });
    expect(coordinator.paths).toEqual([]);
    const { events } = await runJson(
      ["--phone"],
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
      ["--phone", "--coordinator", coordinator.origin],
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
      ["--phone", "--coordinator", coordinator.origin],
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
    await runJson(
      ["--phone", "--coordinator", coordinator.origin],
      home,
      mac.ports,
      yes,
    );
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
    await runJson(
      ["--phone", "--coordinator", coordinator.origin],
      home,
      mac.ports,
      yes,
    );
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
      "This Mac is not connected. The connection that ran in the background ended. To connect it later, run clawdtime onboard --phone.",
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
    await runJson(
      ["--phone", "--coordinator", coordinator.origin],
      home,
      mac.ports,
      yes,
    );
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
      ["--phone", "--coordinator", coordinator.origin],
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
        ["--phone", "--coordinator", coordinator.origin, ...args],
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

  it("in the app, done says when the desktop that setup started still runs with no owner", async () => {
    const mac = fakeMac({ remembers: true });
    const home = folder();
    const app = await runJson(["--local", "--app"], home, mac.ports, agree());
    expect(app.code).toBe(0);
    expect(done(app.events).setupDesktop).toBe(true);
    // In Terminal the desktop is the person's own: done says nothing of it.
    const terminal = await runJson(["--local"], home, fakeMac().ports, agree());
    expect(done(terminal.events).setupDesktop).toBeUndefined();
  });

  it("in the app, a Stop during a second setup run ends the desktop that the first run started", async () => {
    for (const stopAt of ["hello", "computer"] as const) {
      const mac = fakeMac({ remembers: true });
      const home = folder();
      const no = (event: StepEvent) =>
        event.id === "computer"
          ? ({ type: "input", id: "computer", value: false } as const)
          : agree()(event);
      await runJson(["--local", "--app"], home, mac.ports, no);
      expect(mac.calls.desktopStarts).toBe(1);
      expect(mac.calls.desktopStops).toBe(0);
      // The second run finds the desktop running: it did not start it.
      const second = await runJson(
        ["--local", "--app"],
        home,
        mac.ports,
        (event) => (event.id === "computer" ? undefined : agree()(event)),
        stopAt === "hello" ? { cancelAtHello: true } : {},
      );
      expect(second.code).toBe(1);
      expect(mac.calls.desktopStarts).toBe(1);
      expect(mac.calls.desktopStops).toBe(1);
      expect(done(second.events).setupDesktop).toBe(false);
    }
  });

  it("in Terminal, a Stop never ends a desktop that an earlier run started", async () => {
    const mac = fakeMac({ remembers: true });
    const home = folder();
    await runJson(["--local"], home, mac.ports, (event) =>
      event.id === "computer"
        ? { type: "input", id: "computer", value: false }
        : agree()(event),
    );
    const second = await runJson(["--local"], home, mac.ports, (event) =>
      event.id === "computer" ? undefined : agree()(event),
    );
    expect(second.code).toBe(1);
    expect(mac.calls.desktopStops).toBe(0);
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
        "Computer use is on. ClawdTime is busy, so it uses computer use from its next start.",
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
      ["--phone", "--coordinator", coordinator.origin],
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
      ["--phone", "--coordinator", coordinator.origin],
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
      ["--phone", "--coordinator", coordinator.origin],
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

describe("skip, so that nobody is stuck at setup", () => {
  const skip = (id: StepEvent["id"]): Reply => ({
    type: "action",
    id,
    action: "skip",
  });
  /** Says yes to everything, and skips the first question of one step. */
  const skipAt =
    (id: string, codeFor: () => string | undefined = () => undefined) =>
    (event: StepEvent) =>
      event.id === id ? skip(event.id) : agree(codeFor)(event);
  const row = (events: OnboardEvent[], id: string) =>
    done(events).report.find((one) => one.id === id)!;
  const later = {
    preflight:
      "The ClawdTime panel is missing, so ClawdTime cannot start. Install ClawdTime again, then run clawdtime onboard.",
    model:
      "No model key is stored, so ClawdTime cannot plan or chat yet. To add one later, run clawdtime onboard, or clawdtime keys set PROVIDER.",
    desktop:
      "ClawdTime does not run, so the chat and computer use do not work yet. To start it later, run clawdtime start, or clawdtime onboard.",
    computer: "Computer use stays off. Turn it on later: clawdtime computer on",
    permissions:
      "Screen Recording and Accessibility are not on yet, so ClawdTime cannot see or use this Mac. Turn them on in System Settings, then run clawdtime onboard.",
    phone:
      "This Mac is not paired, so calls from your phone cannot reach it. To pair it later, run clawdtime onboard --phone.",
    pairing:
      "This Mac is not paired, so calls from your phone cannot reach it. To pair it later, run clawdtime onboard --phone.",
    connection:
      "This Mac is not connected, so calls from your phone cannot reach it. To connect it later, run clawdtime onboard --phone.",
  };

  it("every step but ready takes a skip", () => {
    for (const id of stepIds)
      expect(skippableSteps.has(id)).toBe(id !== "ready");
  });

  it("a skip at each step goes on to the next step, and the skipped step says what does not work and how to finish it", async () => {
    const denied: PermissionFacts = {
      panel: { path: "/x/P", accessibility: false, screenRecording: false },
      capture: { path: "/x/C", screenRecording: true },
    };
    const cases = [
      { id: "preflight", mac: { panelMissing: true }, ready: false },
      { id: "model", mac: {}, ready: false },
      { id: "desktop", mac: { startFails: true }, ready: false },
      { id: "computer", mac: {}, ready: true },
      { id: "permissions", mac: { permissions: [denied] }, ready: true },
      // The phone run is done only when calls can reach this Mac.
      { id: "phone", mac: {}, ready: false, shared: true },
      { id: "pairing", mac: {}, ready: false, shared: true },
      { id: "connection", mac: {}, ready: false, shared: true },
    ] as const;
    for (const one of cases) {
      const coordinator = await fakeCoordinator();
      cleanup.push(coordinator.close);
      const mac = fakeMac({ ...one.mac } as Parameters<typeof fakeMac>[0]);
      const home = folder();
      const root = join(home, ".local", "share", "clawdtime");
      if (one.id === "permissions") setComputerSwitch(root, true, Date.now());
      const { events, code } = await runJson(
        "shared" in one
          ? ["--phone", "--coordinator", coordinator.origin]
          : ["--local"],
        home,
        mac.ports,
        skipAt(one.id, () => coordinator.codeFor(member)),
      );
      expect(row(events, one.id), one.id).toEqual({
        id: one.id,
        state: "skipped",
        detail: later[one.id],
      });
      // Setup went on: the steps after it ran, and no failure screen.
      expect(done(events).ready, one.id).toBe(one.ready);
      expect(row(events, "ready").state, one.id).toBe(
        one.ready ? "ready" : "skipped",
      );
      expect(code, one.id).toBe(one.ready ? 0 : 2);
      const route = "shared" in one ? routeSteps.phone : routeSteps.first;
      const next = route[route.indexOf(one.id) + 1]!;
      expect(row(events, next).state, one.id).not.toBe("pending");
      if (one.id === "model")
        expect(
          keyRows({}, root).rows.some((key) => key.from?.kind === "store"),
        ).toBe(false);
      void one;
    }
  });

  it("the report lists each skipped step with its line", async () => {
    const { events } = await runJson(
      ["--local"],
      folder(),
      fakeMac().ports,
      skipAt("computer"),
    );
    expect(row(events, "computer").state).toBe("skipped");
    expect(row(events, "ready").detail).toBe(
      "ClawdTime is ready on this Mac. Click the mascot to open the chat. To get calls on your phone later, run clawdtime onboard --phone. Skipped for now: Computer use. Run clawdtime onboard to finish it.",
    );
    const model = await runJson(
      ["--local"],
      folder(),
      fakeMac().ports,
      skipAt("model"),
    );
    expect(row(model.events, "ready")).toEqual({
      id: "ready",
      state: "skipped",
      detail:
        "ClawdTime cannot work on this Mac yet. Skipped for now: Model key. Run clawdtime onboard to finish it.",
    });
  });

  it("a skip on a consent question grants nothing", async () => {
    // Computer use stays off.
    const home = folder();
    await runJson(["--local"], home, fakeMac().ports, skipAt("computer"));
    expect(
      readComputerSwitch(join(home, ".local", "share", "clawdtime")).enabled,
    ).toBe(false);
    // No sign-in text goes out.
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    await runJson(
      ["--coordinator", coordinator.origin],
      folder(),
      fakeMac().ports,
      (event) =>
        event.input?.prompt === "Send a sign-in code to this number now?"
          ? skip("phone")
          : agree(() => coordinator.codeFor(member))(event),
    );
    expect(coordinator.texts).toHaveLength(0);
    // A skip at the view question pairs nothing.
    const paired = folder();
    await runJson(
      ["--coordinator", coordinator.origin],
      paired,
      fakeMac().ports,
      (event) =>
        event.input?.prompt.startsWith("Allow this display")
          ? skip("pairing")
          : agree(() => coordinator.codeFor(member))(event),
    );
    expect(readSharedPairing(sharedPairingPaths(paired).file).kind).toBe(
      "none",
    );
    // A skip at the connection question connects nothing.
    const mac = fakeMac();
    await runJson(
      ["--coordinator", coordinator.origin],
      folder(),
      mac.ports,
      skipAt("connection", () => coordinator.codeFor(member)),
    );
    expect(mac.calls.connectionStarts).toBe(0);
  });

  it("a skip while the desktop starts ends that start, and leaves no desktop", async () => {
    for (const args of [["--local"], ["--local", "--app"]]) {
      const mac = fakeMac({ startMs: 150 });
      const { events, code } = await runJson(
        args,
        folder(),
        mac.ports,
        agree(),
        {
          progress: (event) =>
            event.id === "desktop" ? skip("desktop") : undefined,
        },
      );
      expect(row(events, "desktop")).toEqual({
        id: "desktop",
        state: "skipped",
        detail: later.desktop,
      });
      expect(mac.calls.desktopStarts).toBe(1);
      expect(mac.calls.desktopStops).toBe(1);
      expect((await mac.ports.desktop.status()).service).toBe("absent");
      expect(code).toBe(2);
    }
  });

  it("a rerun asks a skipped step again", async () => {
    const home = folder();
    const mac = fakeMac();
    const first = await runJson(
      ["--local"],
      home,
      mac.ports,
      skipAt("computer"),
    );
    expect(row(first.events, "computer").state).toBe("skipped");
    const second = await runJson(["--local"], home, mac.ports, agree());
    expect(asked(second.events, "computer")).toBe(1);
    expect(row(second.events, "computer").state).toBe("ready");
  });
});

describe("the first run: install to talking with the fewest decisions", () => {
  const openai = providerById("openai")!;
  const anthropic = providerById("anthropic")!;
  const shellKey = `sk-made-up-shell-${"s".repeat(32)}`;
  const otherKey = `sk-ant-made-up-${"a".repeat(32)}`;
  const store = (home: string) => join(home, ".local", "share", "clawdtime");
  const storedFrom = (home: string, id: string) =>
    keyRows({}, store(home)).rows.find((row) => row.provider.id === id)!.from;

  it("uses a key from the shell settings with no question, after its provider checks it", async () => {
    const home = folder();
    const mac = fakeMac({
      knownKeys: [{ provider: openai, key: shellKey, source: "/x/.zshrc" }],
    });
    const { code, events, lines, errors } = await runJson(
      ["--app"],
      home,
      mac.ports,
      agree(),
    );
    expect(code).toBe(0);
    expect(asked(events, "model")).toBe(0);
    expect(mac.calls.keysChecked).toEqual([shellKey]);
    expect(storedFrom(home, "openai")).toEqual({ kind: "store" });
    expect(done(events).report.find((row) => row.id === "model")!.detail).toBe(
      "ClawdTime found your OpenAI key in your shell settings. It checked the key. It keeps the key in the protected key store.",
    );
    // The key and its file never show in an event or a log.
    const everything = [...lines, ...errors].join("\n");
    expect(everything).not.toContain(shellKey);
    expect(everything).not.toContain("/x/.zshrc");
  });

  it("never uses a key from the shell settings that its provider refuses: it asks instead", async () => {
    const home = folder();
    const mac = fakeMac({
      knownKeys: [{ provider: openai, key: shellKey, source: "/x/.zshrc" }],
      verdict: (checked) => (checked === shellKey ? "refused" : "valid"),
    });
    const { events } = await runJson(["--app"], home, mac.ports, agree());
    expect(asked(events, "model")).toBe(2);
    expect(
      events.some(
        (event) =>
          event.type === "log" &&
          event.message ===
            "OpenAI refused the key in your shell settings, so ClawdTime does not use it.",
      ),
    ).toBe(true);
    // The pasted key is the one in the store.
    expect(mac.calls.keysChecked).toEqual([shellKey, key]);
    expect(stateOf(events, "model")).toBe("ready");
  });

  it("asks for the provider with a default and offers the page that makes a key", async () => {
    const { events } = await runJson(
      ["--app"],
      folder(),
      fakeMac().ports,
      agree(),
    );
    const choice = steps(events).find(
      (event) => event.id === "model" && event.input?.kind === "choice",
    )!;
    expect(choice.input!.default).toBe("openai");
    expect(choice.input!.consent).toBeUndefined();
    expect(choice.detail).not.toContain("clawdtime keys");
    const secret = steps(events).find(
      (event) => event.id === "model" && event.input?.kind === "secret",
    )!;
    expect(secret.recovery).toEqual({
      label: "Get a key from OpenAI",
      action: "open_url",
      url: "https://platform.openai.com/api-keys",
    });
  });

  it("uses the provider that a pasted key belongs to, so a wrong choice is no error", async () => {
    const home = folder();
    const mac = fakeMac();
    const { events } = await runJson(["--app"], home, mac.ports, (event) =>
      event.id === "model" && event.input?.kind === "secret"
        ? { type: "input", id: "model", value: otherKey }
        : agree()(event),
    );
    expect(stateOf(events, "model")).toBe("ready");
    expect(storedFrom(home, "anthropic")).toEqual({ kind: "store" });
    expect(storedFrom(home, "openai")).toBeNull();
    expect(
      events.some(
        (event) =>
          event.type === "log" &&
          event.message ===
            `This key is for ${anthropic.name}, so ClawdTime uses ${anthropic.name}.`,
      ),
    ).toBe(true);
    // The person chose OpenAI, the default: the key went to Anthropic's check.
    expect(mac.calls.keysChecked).toEqual([otherKey]);
  });

  it("no consent question has a default, in the first run and in the phone run", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const home = folder();
    const mac = fakeMac();
    const first = await runJson([], home, mac.ports, agree());
    const phone = await runJson(
      ["--phone", "--coordinator", coordinator.origin],
      home,
      mac.ports,
      agree(() => coordinator.codeFor(member)),
    );
    const consents = steps([...first.events, ...phone.events]).filter(
      (event) => event.input?.consent,
    );
    expect(consents.length).toBeGreaterThan(6);
    for (const event of consents) expect(event.input!.default).toBeUndefined();
  });

  it("in the app, goes on by itself when the permissions are on, with no click", async () => {
    const denied: PermissionFacts = {
      panel: { path: "/x/P", accessibility: false, screenRecording: false },
      capture: { path: "/x/C", screenRecording: true },
    };
    // Denied at the first check and at the first watch, then on.
    const mac = fakeMac({ permissions: [denied, denied] });
    const { code, events } = await runJson(
      ["--app"],
      folder(),
      mac.ports,
      (event) => {
        // The person turns the switches on and clicks nothing.
        if (event.id === "permissions" && event.state === "needs_input")
          return [];
        return agree()(event);
      },
      { permissionPollMs: 5 },
    );
    expect(code).toBe(0);
    expect(asked(events, "permissions")).toBe(1);
    const asking = steps(events).find(
      (event) => event.id === "permissions" && event.state === "needs_input",
    )!;
    expect(asking.detail).toBe(
      "In System Settings, open Privacy & Security. In Accessibility, turn on ClawdTime. In Screen & System Audio Recording, turn on ClawdTime. Setup continues when they are on.",
    );
    expect(stateOf(events, "permissions")).toBe("ready");
    // The first check, one watch that found them off, one that found them on,
    // and the check of the step that then goes on.
    expect(mac.calls.permissionChecks).toBe(4);
  });

  it("in Terminal, a first run that is ready opens the chat with one suggested request; the app opens its own", async () => {
    const terminal = fakeMac({ chat: true });
    const opened = await runJson([], folder(), terminal.ports, agree());
    expect(terminal.calls.chatOpens).toBe(1);
    expect(
      done(opened.events).report.find((row) => row.id === "ready")!.detail,
    ).toBe(
      `ClawdTime is ready, and the chat is open. Write or talk to ClawdTime. Try: ${firstRequest(true)} To get calls on your phone later, run clawdtime onboard --phone.`,
    );
    const app = fakeMac({ chat: true });
    const inApp = await runJson(["--app"], folder(), app.ports, agree());
    expect(app.calls.chatOpens).toBe(0);
    expect(
      done(inApp.events).report.find((row) => row.id === "ready")!.detail,
    ).toBe(
      "ClawdTime is ready on this Mac. To get calls on your phone later, choose Get calls on your phone.",
    );
    // Not ready, or stopped: no chat opens.
    const skipped = fakeMac({ chat: true });
    await runJson([], folder(), skipped.ports, (event) =>
      event.id === "model"
        ? { type: "action", id: "model", action: "skip" }
        : agree()(event),
    );
    const stopped = fakeMac({ chat: true });
    await runJson([], folder(), stopped.ports, (event) =>
      event.id === "computer" ? undefined : agree()(event),
    );
    expect(skipped.calls.chatOpens + stopped.calls.chatOpens).toBe(0);
  });

  it("suggests a chat request when computer use is off", async () => {
    const mac = fakeMac({ chat: true });
    const { events } = await runJson([], folder(), mac.ports, (event) =>
      event.id === "computer" && event.state === "needs_input"
        ? { type: "input", id: "computer", value: false }
        : agree()(event),
    );
    expect(
      done(events).report.find((row) => row.id === "ready")!.detail,
    ).toContain(`Try: ${firstRequest(false)}`);
    expect(firstRequest(false)).toBe("What can you do on this Mac?");
  });

  it("takes every step on a paired Mac, and only the first run with --local", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const home = folder();
    const mac = fakeMac();
    await runJson([], home, mac.ports, agree());
    await runJson(
      ["--phone", "--coordinator", coordinator.origin],
      home,
      mac.ports,
      agree(() => coordinator.codeFor(member)),
    );
    const paired = await runJson(
      ["--coordinator", coordinator.origin],
      home,
      mac.ports,
      agree(),
    );
    expect(done(paired.events).report.map((row) => row.id)).toEqual([
      ...stepIds,
    ]);
    const local = await runJson(["--local"], home, mac.ports, agree());
    expect(done(local.events).report.map((row) => row.id)).toEqual([
      ...routeSteps.first,
    ]);
    await expect(
      onboardCli(["--json", "--local", "--phone"], { ports: mac.ports }),
    ).rejects.toThrow("Use --local or --phone, not both");
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
        // The questions that wait for an answer; a step in progress may carry
        // one for a skip in the app, which the terminal does not offer.
        const question = (event as { question?: string }).question;
        const state = (event as { state?: string }).state;
        if (question && state !== "in_progress") asked.push(question);
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

describe("a desktop that does not start says why", () => {
  const other = {
    port: 13326,
    pid: 52001,
    state: "/Users/made-up/.local/share/clawdtime/other-desktop",
    verified: true,
  };
  const otherError = (verified = true) =>
    new DesktopStartError(
      "other_install",
      "ClawdTime is already running from another install, on the port that this desktop uses.",
      [`It runs as process 52001, with the desktop folder ${other.state}.`],
      { ...other, verified, state: verified ? other.state : null },
    );
  /** Answers the desktop step with this choice, and yes elsewhere. */
  const choose =
    (choice: string): Responder =>
    (event) =>
      event.id === "desktop" && event.input?.kind === "choice"
        ? { type: "input", id: "desktop", value: choice }
        : agree()(event);
  const reportRow = (events: OnboardEvent[], id: string) =>
    done(events).report.find((one) => one.id === id)!;
  const desktopEvents = (events: OnboardEvent[]) =>
    steps(events).filter((event) => event.id === "desktop");

  it("offers to use, stop or try again when another install runs, and stops it on the person's choice", async () => {
    const mac = fakeMac({ startErrors: [otherError()], otherInstall: {} });
    const { events } = await runJson(
      ["--local"],
      folder(),
      mac.ports,
      choose("stop"),
    );
    const question = desktopEvents(events).find(
      (event) => event.state === "needs_input",
    )!;
    expect(question.input?.prompt).toBe(
      "ClawdTime is already running from another install.",
    );
    expect(question.input?.options?.map((option) => option.label)).toEqual([
      "Use the running ClawdTime",
      "Stop it and try again",
      "Try again",
    ]);
    expect(question.details?.join(" ")).toContain(other.state);
    // The detail names no path: the path is in the details.
    expect(question.detail).not.toContain("/");
    expect(mac.calls.otherStops).toBe(1);
    expect(mac.calls.desktopStarts).toBe(2);
    expect(reportRow(events, "desktop")).toMatchObject({ state: "ready" });
  });

  it("uses the running ClawdTime of another install when the person chooses it", async () => {
    const mac = fakeMac({ startErrors: [otherError()], otherInstall: {} });
    const { events } = await runJson(
      ["--local"],
      folder(),
      mac.ports,
      choose("use"),
    );
    expect(mac.calls.otherUses).toBe(1);
    expect(mac.calls.otherStops).toBe(0);
    expect(mac.calls.desktopStarts).toBe(1);
    expect(reportRow(events, "desktop")).toEqual({
      id: "desktop",
      state: "ready",
      detail: "ClawdTime runs already. Its work is kept.",
    });
  });

  it("says plainly when a stop of the other install did not happen, and tries again on retry", async () => {
    const mac = fakeMac({
      startErrors: [otherError(), otherError()],
      otherInstall: {
        stopFails: Error(
          "That ClawdTime is held by its app or by a Terminal that runs it in the foreground, so setup did not stop it. Quit it there, then try again.",
        ),
      },
    });
    let asked = 0;
    const { events } = await runJson(
      ["--local"],
      folder(),
      mac.ports,
      (event) => {
        if (event.id === "desktop" && event.input?.kind === "choice")
          return {
            type: "input",
            id: "desktop",
            value: asked++ === 0 ? "stop" : "use",
          };
        return agree()(event);
      },
    );
    const failure = desktopEvents(events).find(
      (event) => event.state === "failed",
    )!;
    expect(failure.detail).toBe(
      "That ClawdTime is held by its app or by a Terminal that runs it in the foreground, so setup did not stop it. Quit it there, then try again.",
    );
    expect(failure.recovery).toEqual({ label: "Try again", action: "retry" });
    expect(reportRow(events, "desktop").state).toBe("ready");
  });

  it("offers only Try again when the other install cannot be confirmed", async () => {
    const mac = fakeMac({ startErrors: [otherError(false)], otherInstall: {} });
    const { events } = await runJson(["--local"], folder(), mac.ports, agree());
    const failure = desktopEvents(events).find(
      (event) => event.state === "failed",
    )!;
    expect(failure.detail).toContain(
      "ClawdTime is already running from another install, and setup cannot confirm which one.",
    );
    expect(failure.input).toBeUndefined();
    expect(mac.calls.otherStops).toBe(0);
    expect(reportRow(events, "desktop").state).toBe("ready");
  });

  it.each([
    [
      "a port that another program holds",
      new DesktopStartError(
        "port_in_use",
        "Port 13326 is in use by another program (Stonepad), so the desktop cannot start there. Quit that program, then try again.",
        ["That program runs as process 52004."],
      ),
    ],
    [
      "an expired session with open work",
      new DesktopStartError(
        "session_open_work",
        "The task session of this desktop expired while a task, call or voice is still open, so it was not renewed and nothing was changed.",
        [
          'To keep that task\'s record and start a new desktop, move this desktop\'s folder aside: mv "/Users/made-up/desk" "/Users/made-up/desk-kept"',
          "The service log is /Users/made-up/desk/desktop-start.log.",
        ],
      ),
    ],
    [
      "a crash with a message",
      new DesktopStartError(
        "stopped",
        "The desktop service stopped as it started: Cannot read the saved project",
        ["The service log is /Users/made-up/desk/desktop-start.log."],
      ),
    ],
  ])(
    "shows the plain reason of %s and offers Try again",
    async (_name, error) => {
      const mac = fakeMac({ startErrors: [error] });
      const { events } = await runJson(
        ["--local"],
        folder(),
        mac.ports,
        agree(),
      );
      const failure = desktopEvents(events).find(
        (event) => event.state === "failed",
      )!;
      expect(failure.detail).toBe(error.reason);
      expect(failure.details).toEqual(error.details);
      expect(failure.recovery).toEqual({ label: "Try again", action: "retry" });
      expect(JSON.stringify(events)).not.toContain(
        "Desktop service startup failed",
      );
      // Try again starts the desktop again.
      expect(mac.calls.desktopStarts).toBe(2);
      expect(reportRow(events, "desktop").state).toBe("ready");
    },
  );

  it("asks the same choice in Terminal, with the reason and the details", async () => {
    const input = new PassThrough();
    const shown: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        const text = chunk.toString();
        shown.push(text);
        if (text.includes("Use the running ClawdTime"))
          setImmediate(() => input.write("1\n"));
        else if (text.includes("Type a number"))
          setImmediate(() => input.write("1\n"));
        else if (text.includes("API key (it is not shown)"))
          setImmediate(() => input.write(`${key}\n`));
        else if (text.includes("Turn on computer use?"))
          setImmediate(() => input.write("no\n"));
        done();
      },
    });
    const wizard = new TerminalWizard({ input, output, close: () => {} });
    const mac = fakeMac({ startErrors: [otherError()], otherInstall: {} });
    const result = await new OnboardEngine(
      wizard,
      {
        version: "0.4.0",
        local: true,
        env: {},
        home: folder(),
        root: folder(),
        pollMs: 0,
      },
      mac.ports,
    ).run();
    const text = shown.join("");
    expect(text).toContain(
      "ClawdTime is already running from another install.",
    );
    expect(text).toContain("Stop it and try again");
    expect(text).toContain(other.state);
    expect(mac.calls.otherUses).toBe(1);
    expect(result.ready).toBe(true);
  });
});
