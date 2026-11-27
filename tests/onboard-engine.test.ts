import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { noTerminalLine, onboardCli, TerminalWizard } from "../cli/onboard.js";
import type { DesktopReadiness } from "../connectors/agents/desktop-readiness.js";
import { keyRows } from "../connectors/computer/keys.js";
import { readComputerSwitch } from "../connectors/computer/journal.js";
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
  } = {},
) {
  const calls = {
    desktopStarts: 0,
    permissionChecks: 0,
    connectionStarts: 0,
    connectionStops: 0,
    validated: 0,
  };
  let desktop = options.desktop ?? "absent";
  let connection: "running" | "stopped" = "stopped";
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
    mac: async () => ({ darwinMajor: 25, appleSilicon: true }),
    helpers: () => ({ panel: true, capture: true }),
    desktop: {
      status: async () =>
        desktop === "connected"
          ? {
              ...desktopAbsent,
              service: "connected",
              chat: "connected",
              computer: "configured",
              taskSession: "inactive",
            }
          : desktopAbsent,
      instanceId: async () => (desktop === "connected" ? "desktop_1" : null),
      start: async (log) => {
        calls.desktopStarts++;
        log("Desktop panel requested.");
        desktop = "connected";
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
      calls.validated++;
      return "valid";
    },
    request: options.request ?? fetch,
  };
  return { ports, calls };
}

type Responder = (
  event: StepEvent,
) => OnboardCommand | OnboardCommand[] | undefined;

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
  const send = (command: OnboardCommand) =>
    setImmediate(() => stdin.write(`${JSON.stringify(command)}\n`));
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
          for (const command of [answer ?? []].flat()) send(command);
          if (!answer) send({ type: "cancel" });
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
      protocol: 1,
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
          // Permissions cannot be skipped: the skip is refused, the recheck works.
          return [
            { type: "action", id: "permissions", action: "skip" },
            { type: "action", id: "permissions", action: "recheck" },
          ];
        }
        return yes(event);
      },
    );
    const asking = steps(events).filter(
      (event) => event.id === "permissions" && event.state === "needs_input",
    );
    expect(asking).toHaveLength(2);
    expect(asking[0]!.recovery).toEqual({
      label: "Open System Settings",
      action: "open_settings",
      url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    });
    expect(asking[0]!.detail).toContain(
      "Accessibility for ClawdTimeTaskPanel (/Applications/Made Up/ClawdTimeTaskPanel)",
    );
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
    const home = folder();
    const result = await new OnboardEngine(
      wizard,
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
