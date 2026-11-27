import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { onboardCli } from "../cli/onboard.js";
import type { DesktopReadiness } from "../connectors/agents/desktop-readiness.js";
import type { OnboardPorts } from "../src/onboard/engine.js";
import {
  readSharedPairing,
  sharedPairingPaths,
} from "../src/onboard/pairing.js";
import { fakeCoordinator, member } from "./onboard-fixture.js";

// Made-up values only. Nothing here texts, calls, captures or opens a pane.
const key = `sk-made-up-${"k".repeat(40)}`;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function folder() {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-terminal-"));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

const absent: DesktopReadiness = {
  service: "absent",
  chat: "unknown",
  taskSession: "unknown",
  taskAdmission: "unknown",
  computer: "unknown",
  computerMode: "unknown",
  physicalVerification: "required",
};

/** A Mac whose desktop a start makes ready, with every permission on. */
function fakePorts(): OnboardPorts {
  let desktop = "absent";
  return {
    mac: async () => ({ darwinMajor: 25, appleSilicon: true }),
    helpers: () => ({ panel: true, capture: true }),
    desktop: {
      status: async () =>
        desktop === "connected"
          ? {
              ...absent,
              service: "connected",
              chat: "connected",
              computer: "configured",
              taskSession: "inactive",
              taskAdmission: "available",
            }
          : absent,
      instanceId: async () => (desktop === "connected" ? "desktop_1" : null),
      start: async () => {
        desktop = "connected";
      },
    },
    permissions: async () => ({
      panel: { path: "/x/P", accessibility: true, screenRecording: true },
      capture: { path: "/x/C", screenRecording: true },
    }),
    displays: {
      capture: () => "/x/C",
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
      status: async () => "stopped",
      holder: async () => null,
      start: async () => {},
      stop: async () => {},
    },
    validateKey: async () => "valid",
    request: fetch,
  };
}

/**
 * A terminal as Node sees one: a stream with isTTY and setRawMode. The test
 * types into it when the screen shows a prompt, as a person does.
 */
function fakeTerminal(
  script: (screen: string, type: (text: string) => void) => void,
) {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => input,
  });
  let screen = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      screen += chunk.toString();
      script(screen, (text) => input.write(text));
      done();
    },
  });
  return { input, output, screen: () => screen };
}

describe("the terminal wizard and consent", () => {
  it("drops a yes typed ahead: a double yes at the display question cannot answer the next consent question, and Enter alone means no", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const home = folder();
    const said = new Set<string>();
    // Each prompt is answered once, the moment it shows.
    const answer = (
      screen: string,
      type: (text: string) => void,
      prompt: string,
      reply: () => void,
    ) => {
      if (said.has(prompt) || !screen.endsWith(prompt)) return;
      said.add(prompt);
      setImmediate(reply);
      void type;
    };
    const terminal = fakeTerminal((screen, type) => {
      answer(
        screen,
        type,
        "Turn on computer use? Type yes or no, or skip: ",
        () => type("yes\r"),
      );
      answer(
        screen,
        type,
        "Your own phone number, with country code (or skip): ",
        () => type(`${member}\r`),
      );
      answer(
        screen,
        type,
        "Send a sign-in code to this number now? Type yes or no, or skip: ",
        () => type("yes\r"),
      );
      answer(screen, type, "Sign-in code (or skip): ", () =>
        type(`${coordinator.codeFor(member)}\r`),
      );
      answer(screen, type, "Type a number, or skip: ", () => type("1\r"));
      answer(
        screen,
        type,
        "Allow this display to be shown during your verified calls? Type yes or no, or skip: ",
        () => {
          // The person sees nothing happen for a moment and types it again.
          type("yes\r");
          setTimeout(() => type("yes\r"), 50);
        },
      );
      // Enter alone at a consent question is a no.
      answer(
        screen,
        type,
        "Allow your verified phone to ask for computer actions on this Mac? Type yes or no, or skip: ",
        () => type("\r"),
      );
      answer(
        screen,
        type,
        "Allow ClawdTime to open a task result report on this Mac during your verified callbacks? Type yes or no, or skip: ",
        () => type("\r"),
      );
      answer(
        screen,
        type,
        "Pair this Mac with your verified account? Type yes or no, or skip: ",
        () => type("yes\r"),
      );
      answer(
        screen,
        type,
        "Connect this Mac to the shared number now? Type yes or no, or skip: ",
        () => type("no\r"),
      );
    });
    const code = await onboardCli(["--coordinator", coordinator.origin], {
      env: { OPENAI_API_KEY: key },
      home,
      root: folder(),
      stdin: terminal.input,
      stdout: terminal.output,
      ports: fakePorts(),
      allowLoopback: true,
      pollMs: 0,
    });
    expect(code).toBe(0);
    const saved = readSharedPairing(sharedPairingPaths(home).file);
    if (saved.kind !== "paired")
      throw Error(`not paired:\n${terminal.screen()}`);
    expect(saved.connection).toMatchObject({
      allowView: true,
      allowControl: false,
      walkthroughReports: false,
    });
  }, 20_000);

  it("in a real terminal, a yes typed twice 50 ms apart at the display question answers only that question", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const here = folder();
    const home = join(here, "home");
    const codeFile = join(here, "code.txt");
    const child = join(here, "wizard.mts");
    // The real wizard on a real pseudo terminal, with fake Mac ports.
    writeFileSync(
      child,
      `import { writeFileSync, readFileSync } from "node:fs";
const { onboardCli } = await import(${JSON.stringify(resolve("cli/onboard.ts"))});
const { sharedPairingPaths } = await import(${JSON.stringify(resolve("src/onboard/pairing.ts"))});
const absent = ${JSON.stringify(absent)};
let desktop = "absent";
const ports = {
  mac: async () => ({ darwinMajor: 25, appleSilicon: true }),
  helpers: () => ({ panel: true, capture: true }),
  desktop: {
    status: async () => desktop === "connected" ? { ...absent, service: "connected", chat: "connected", computer: "configured", taskSession: "inactive", taskAdmission: "available" } : absent,
    instanceId: async () => desktop === "connected" ? "desktop_1" : null,
    start: async () => { desktop = "connected"; },
  },
  permissions: async () => ({ panel: { path: "/x/P", accessibility: true, screenRecording: true }, capture: { path: "/x/C", screenRecording: true } }),
  displays: {
    capture: () => "/x/C",
    list: async () => [{ displayId: "1", width: 2560, height: 1440, isMain: true }],
    resolve: async (id) => { await new Promise((d) => setTimeout(d, 150)); return { displayId: Number(id), displayUUID: "11111111-2222-3333-4444-555555555555", x: 0, y: 0, width: 2560, height: 1440 }; },
  },
  connection: { status: async () => "stopped", holder: async () => null, start: async () => {}, stop: async () => {} },
  validateKey: async () => "valid",
  request: fetch,
};
const code = await onboardCli(["--coordinator", ${JSON.stringify(coordinator.origin)}], { env: { OPENAI_API_KEY: ${JSON.stringify(key)} }, home: ${JSON.stringify(home)}, root: ${JSON.stringify(here)}, ports, allowLoopback: true, pollMs: 0 });
const saved = JSON.parse(readFileSync(sharedPairingPaths(${JSON.stringify(home)}).file, "utf8"));
console.log("\\nEXIT " + code + " SAVED view=" + saved.allowView + " control=" + saved.allowControl + " reports=" + saved.walkthroughReports);
process.exit(0);
`,
    );
    const driver = join(here, "drive.py");
    // The person: types each answer when its prompt shows, and at the
    // display question types yes and Return twice, 50 ms apart.
    writeFileSync(
      driver,
      `import os, pty, re, sys, time, select
tsx, script, code_file = sys.argv[1], sys.argv[2], sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.execv(tsx, [tsx, script])
buf = b""
def until(pat, t=20):
    global buf
    end = time.time() + t
    while time.time() < end:
        m = re.search(pat, buf)
        if m:
            out = buf[:m.end()]; buf = buf[m.end():]; return out
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: buf += os.read(fd, 4096)
            except OSError: break
    sys.stdout.write("TIMEOUT %r %r\\n" % (pat, buf[-400:])); sys.exit(2)
def say(s): os.write(fd, s.encode())
until(rb"Turn on computer use\\? Type yes or no, or skip: "); say("yes\\r")
until(rb"\\(or skip\\): "); say("${member}\\r")
until(rb"Send a sign-in code to this number now\\? Type yes or no, or skip: "); say("yes\\r")
until(rb"Sign-in code \\(or skip\\): ")
for _ in range(200):
    if os.path.exists(code_file) and open(code_file).read().strip(): break
    time.sleep(0.05)
code = open(code_file).read().strip(); say(code + "\\r")
until(rb"Type a number, or skip: "); say("1\\r")
until(rb"Allow this display to be shown during your verified calls\\? Type yes or no, or skip: ")
say("yes\\r"); time.sleep(0.05); say("yes\\r")
out = until(rb"\\? Type yes or no, or skip: ")
sys.stdout.write("NEXT " + out.decode(errors="replace").replace("\\r", "").strip().splitlines()[-1] + "\\n")
say("no\\r")
until(rb"Allow ClawdTime to open a task result report[^\\n]*: "); say("no\\r")
until(rb"Pair this Mac with your verified account\\?[^\\n]*: "); say("yes\\r")
until(rb"Connect this Mac to the shared number now\\?[^\\n]*: "); say("no\\r")
sys.stdout.write(until(rb"SAVED[^\\n]*\\n").decode(errors="replace").replace("\\r", "").strip().splitlines()[-1] + "\\n")
`,
    );
    const watch = setInterval(() => {
      const code = coordinator.codeFor(member);
      if (code) {
        writeFileSync(codeFile, code);
        clearInterval(watch);
      }
    }, 20);
    cleanup.push(() => clearInterval(watch));
    const output = await new Promise<string>((done) => {
      const run = spawn(
        "/usr/bin/python3",
        ["-I", driver, resolve("node_modules/.bin/tsx"), child, codeFile],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let text = "";
      run.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
      run.stderr.on("data", (chunk: Buffer) => (text += chunk.toString()));
      run.once("exit", () => done(text));
    });
    // The question after the view question is the one about computer actions,
    // and the second yes did not answer it.
    expect(output).toContain(
      "NEXT Allow your verified phone to ask for computer actions on this Mac? Type yes or no, or skip:",
    );
    expect(output).toContain(
      "EXIT 0 SAVED view=true control=false reports=false",
    );
  }, 40_000);
});
