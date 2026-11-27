import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

// The real `clawdtime onboard` in its own process, with fake Mac ports. Its
// desktop start takes a while and leaves a stand-in service (a sleep) that
// only the desktop stop ends. Nothing here starts a real desktop.
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function setup(mode: "app" | "terminal") {
  const here = mkdtempSync(join(tmpdir(), "clawdtime-stop-"));
  cleanup.push(() => rmSync(here, { recursive: true, force: true }));
  const script = join(here, "onboard.mts");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
const { onboardCli } = await import(${JSON.stringify(resolve("cli/onboard.ts"))});
const absent = { service: "absent", chat: "unknown", taskSession: "unknown", taskAdmission: "unknown", computer: "unknown", computerMode: "unknown", physicalVerification: "required" };
let desktop = "absent", service;
const ports = {
  mac: async () => ({ darwinMajor: 25, appleSilicon: true }),
  helpers: () => ({ panel: true, capture: true }),
  desktop: {
    status: async () => desktop === "connected" ? { ...absent, service: "connected", chat: "connected", computer: "configured", taskSession: "inactive", taskAdmission: "available" } : absent,
    instanceId: async () => null,
    start: async () => {
      service = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
      service.unref();
      process.stderr.write("SERVICE " + service.pid + "\\n");
      await new Promise((done) => setTimeout(done, 1500));
      desktop = "connected";
    },
    stop: async () => { process.stderr.write("STOP\\n"); process.kill(service.pid, "SIGTERM"); desktop = "absent"; },
  },
  permissions: async () => ({ panel: { accessibility: true, screenRecording: true }, capture: { screenRecording: true } }),
  displays: { capture: () => undefined, list: async () => [], resolve: async () => { throw Error("none"); } },
  connection: { status: async () => "stopped", holder: async () => null, start: async () => {}, stop: async () => {} },
  validateKey: async () => "valid",
  request: fetch,
};
const terminal = { input: new PassThrough(), output: process.stderr, close: () => {} };
const code = await onboardCli(${JSON.stringify(mode === "app" ? ["--json", "--app", "--local"] : ["--local"])}, {
  env: { OPENAI_API_KEY: "sk-made-up-${"k".repeat(40)}" }, home: ${JSON.stringify(join(here, "home"))}, root: ${JSON.stringify(here)},
  ports, pollMs: 0, desktopWaitMs: 0, openTerminal: () => terminal,
});
process.stderr.write("EXIT " + code + "\\n");
`,
  );
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const seen: { text: string; then: () => void }[] = [];
  const check = () => {
    for (const wait of [...seen])
      if (stdout.includes(wait.text) || stderr.includes(wait.text)) {
        seen.splice(seen.indexOf(wait), 1);
        wait.then();
      }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    check();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    check();
  });
  const exited = new Promise<number | null>((done) =>
    child.once("exit", (code) => done(code)),
  );
  cleanup.push(() => child.kill("SIGKILL"));
  return {
    child,
    exited,
    output: () => ({ stdout, stderr }),
    when: (text: string) =>
      new Promise<void>((then) => {
        seen.push({ text, then });
        check();
      }),
    service: () => Number(/SERVICE (\d+)/.exec(stderr)?.[1] ?? 0),
  };
}

it("in the app, a Stop and then SIGTERM during the desktop start end the desktop that setup was starting", async () => {
  const run = setup("app");
  await run.when('"id":"desktop","state":"in_progress"');
  await run.when("SERVICE ");
  const service = run.service();
  cleanup.push(() => alive(service) && process.kill(service, "SIGKILL"));
  // The app's Stop: a cancel and the end of the input, then SIGTERM while
  // the start still runs.
  await new Promise((done) => setTimeout(done, 300));
  run.child.stdin.end('{"type":"cancel"}\n');
  await new Promise((done) => setTimeout(done, 300));
  run.child.kill("SIGTERM");
  const code = await run.exited;
  expect(run.output().stderr).toContain("STOP");
  expect(alive(service)).toBe(false);
  expect(code).toBe(0);
  expect(run.output().stderr).toContain("EXIT 1");
  expect(run.output().stdout).toContain('"type":"done"');
}, 30_000);

it("in Terminal, Ctrl+C outside a question during the desktop start ends the desktop that setup was starting", async () => {
  const run = setup("terminal");
  await run.when("Desktop: Starting the desktop.");
  await run.when("SERVICE ");
  const service = run.service();
  cleanup.push(() => alive(service) && process.kill(service, "SIGKILL"));
  await new Promise((done) => setTimeout(done, 300));
  run.child.kill("SIGINT");
  const code = await run.exited;
  expect(run.output().stderr).toContain("STOP");
  expect(alive(service)).toBe(false);
  expect(code).toBe(0);
  expect(run.output().stderr).toContain("EXIT 1");
}, 30_000);

it("in the app, Skip for now during the desktop start ends the desktop of that start, and setup goes on", async () => {
  const run = setup("app");
  // The person skips every question, and the desktop while it starts.
  let partial = "";
  run.child.stdout.on("data", (chunk: Buffer) => {
    partial += chunk.toString();
    let end: number;
    while ((end = partial.indexOf("\n")) >= 0) {
      const line = partial.slice(0, end);
      partial = partial.slice(end + 1);
      const event = JSON.parse(line) as {
        type: string;
        id?: string;
        state?: string;
        question?: string;
      };
      if (
        event.type === "step" &&
        event.question &&
        (event.state === "needs_input" ||
          event.state === "failed" ||
          (event.state === "in_progress" && event.id === "desktop"))
      )
        run.child.stdin.write(
          `${JSON.stringify({ type: "action", id: event.id, question: event.question, action: "skip" })}\n`,
        );
      if (event.type === "done") run.child.stdin.end();
    }
  });
  await run.when("SERVICE ");
  const service = run.service();
  cleanup.push(() => alive(service) && process.kill(service, "SIGKILL"));
  const code = await run.exited;
  expect(code).toBe(0);
  expect(run.output().stderr).toContain("STOP");
  expect(alive(service)).toBe(false);
  expect(run.output().stderr).toContain("EXIT 2");
  expect(run.output().stdout).toContain(
    '{"id":"desktop","state":"skipped","detail":"The desktop does not run, so the chat and computer use do not work yet. To start it later, run clawdtime start, or clawdtime onboard."}',
  );
}, 30_000);
