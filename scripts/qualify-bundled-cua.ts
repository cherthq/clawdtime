import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

// Explicit paid-model qualification on a disposable loopback fixture only.
// No personal profile, actual inbox, phone, OS input, transcript or screenshots.
async function main() {
  const apiKey = process.env.CLAWDTIME_OPENAI_API_KEY;
  const model = process.argv[2];
  if (!apiKey || !model)
    throw Error(
      "Set the protected CLAWDTIME_OPENAI_API_KEY and supply an explicit model name.",
    );
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)), "..");
  const directory = mkdtempSync(join(tmpdir(), "clawdtime-owned-cua-"));
  const state = join(directory, "state");
  mkdirSync(state, { mode: 0o700 });
  const project = join(directory, "project");
  mkdirSync(project, { mode: 0o700 });
  let savedNote: string | undefined;
  const fixture = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/saved") {
      savedNote = url.searchParams.get("note") ?? "";
      res.end("observed");
      return;
    }
    if (req.url !== "/") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><html><head><title>ClawdTime disposable fixture</title><style>body{font:24px system-ui;background:#f1f5f9;margin:80px;color:#162134}main{background:white;padding:50px;width:800px;border-radius:24px}input,button{font:24px system-ui;padding:18px;margin:20px 0;display:block}input{width:600px}button{background:#147af5;color:white;border:0;border-radius:10px}p{padding:20px;background:#e4edf9}</style></head><body><main><h1>ClawdTime local fixture</h1><label for="note">Note</label><input id="note" data-testid="note" aria-label="Note"><button data-testid="save" onclick="document.getElementById('result').textContent='Saved note: '+document.getElementById('note').value;fetch('/saved?note='+encodeURIComponent(document.getElementById('note').value))">Save note</button><p id="result" role="status">No note saved</p></main></body></html>`,
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixturePort = (fixture.address() as { port: number }).port;
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`,
    fixtureOrigin = `http://127.0.0.1:${fixturePort}`;
  writeFileSync(
    join(state, "bundled-cua.json"),
    JSON.stringify({
      version: 1,
      mode: "browser",
      model,
      maxSteps: 12,
      timeoutMs: 240000,
      browser: {
        startUrl: fixtureOrigin,
        allowedOrigins: [fixtureOrigin],
        headless: true,
        fixtureGrants: [
          { testId: "note", type: "click" },
          { testId: "note", type: "type", text: "ready for review" },
          { testId: "save", type: "click" },
        ],
      },
    }),
    { mode: 0o600 },
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [
        "HOME",
        "PATH",
        "PLAYWRIGHT_BROWSERS_PATH",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "LANG",
        "TZ",
      ].includes(key),
    ),
  );
  env.CLAWDTIME_OPENAI_API_KEY = apiKey;
  env.CLAWDTIME_CONFIG_HOME = join(directory, "supervisor");
  let child: ChildProcess | undefined;
  try {
    child = spawn(
      process.execPath,
      [
        join(root, "dist/scripts/task-server.js"),
        "--state",
        state,
        "--project",
        project,
        "--port",
        String(port),
        "--desktop",
        "true",
      ],
      { env, stdio: ["ignore", "ignore", "ignore"] },
    );
    const until = Date.now() + 15000;
    while (!existsSync(join(state, "desktop-panel.json"))) {
      if (Date.now() > until || child.exitCode !== null)
        throw Error("Isolated task service did not start.");
      await new Promise((r) => setTimeout(r, 100));
    }
    const panel = JSON.parse(
      readFileSync(join(state, "desktop-panel.json"), "utf8"),
    );
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${panel.token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
      if (!response.ok)
        throw Error(`Local qualification API refused (${response.status}).`);
      return response.json() as Promise<any>;
    };
    await request("/desktop/chat", {
      text: "Use the browser to click the Note field, type exactly ready for review, click Save note, and verify that Saved note: ready for review is visible. This is the disposable local fixture only.",
    });
    const deadline = Date.now() + 245000;
    let lastState = "";
    for (;;) {
      const chat = await request("/desktop/chat");
      const execution = chat.execution;
      if (execution?.state !== lastState) {
        lastState = execution?.state;
        console.log(JSON.stringify({ stage: lastState }));
      }
      if (execution?.pendingAction) {
        writeFileSync(
          join(directory, "qualification.json"),
          JSON.stringify({
            state: "pending_approval",
            pendingAction: execution.pendingAction,
            fixture: "isolated-loopback-note",
            independentlyObservedSave: savedNote === "ready for review",
            screensRetained: false,
          }),
          { mode: 0o600 },
        );
        console.log(JSON.stringify({ evidenceDirectory: directory }));
        await request("/desktop/execution/stop", {});
        throw Error(
          "The model proposed an action outside the exact fixture grants; stopped without approval.",
        );
      }
      if (
        ["completed", "blocked", "canceled", "uncertain"].includes(
          execution?.state,
        )
      ) {
        const evidence = {
          version: 1,
          model,
          state: execution.state,
          chatIndependent: true,
          codexEnvironmentPresent: Object.keys(env).some((k) =>
            k.startsWith("CODEX_"),
          ),
          fixture: "isolated-loopback-note",
          screensRetained: false,
          independentlyObservedSave: savedNote === "ready for review",
        };
        writeFileSync(
          join(directory, "qualification.json"),
          JSON.stringify(evidence, null, 2),
          { mode: 0o600 },
        );
        console.log(
          JSON.stringify({ ...evidence, evidenceDirectory: directory }),
        );
        if (execution.state !== "completed" || savedNote !== "ready for review")
          throw Error(
            "The independent computer task did not reach verified completion.",
          );
        break;
      }
      if (Date.now() > deadline) {
        await request("/desktop/execution/stop", {});
        throw Error("Qualification deadline reached.");
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    if (child && child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exit, new Promise((r) => setTimeout(r, 10000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Qualification failed.",
  );
  process.exitCode = 1;
});
