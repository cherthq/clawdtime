import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectCli, plain } from "../cli/connect.js";
import { main } from "../cli/main.js";
import { computerCli } from "../cli/computer.js";
import {
  readChertKey,
  readOwner,
  writeOwner,
} from "../connectors/shared/owner.js";
import { ownerTextPort, reachSession } from "../connectors/computer/reach.js";
import { proactiveConfigSchema } from "../src/control/proactive-setup.js";

const project = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const lineId = "fedcbafe-dcba-4fed-8cba-fedcbafedcba";
const phone = "+15550100123";
const key = "ftk_fixture_project_key_abcdefghij";
const connectorToken = "fake-connector-credential-abcdefghij";
const email = "owner@example.test";
const pinned = {
  pin: { version: "0.1.0-beta.19", nodeVersion: "v24.22.1" },
  provider: () => true,
  node: () => true,
};
const unpinned = { ...pinned, provider: () => false };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** The fake chert: a node program on a temporary PATH, inside a fake provider package. */
const fakeChert = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const home = process.env.CHERT_HOME, args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CHERT_LOG, JSON.stringify(args) + "\\n");
const file = path.join(home, "fake.json");
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const save = () => { fs.mkdirSync(home, { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 }); };
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
switch (args[0]) {
  case "--version": console.log("0.1.0-beta.99"); break;
  case "whoami":
    if (!state.signedIn) { out({ command: "whoami", code: "whoami", signed_in: false, message: "Not signed in." }); process.exitCode = 3; break; }
    out({ schema_version: 1, command: "whoami", code: "whoami", signed_in: true, email: "${email}", expires_at: Date.now() + 30 * 86400000, project_id: "${project}", project_name: "Fixture Project", confirmed: true, role: "owner", message: "Signed in as ${email}" });
    break;
  case "login":
    state.signedIn = true; save();
    fs.writeFileSync(path.join(home, "credentials.json"), JSON.stringify({ access_token: "${connectorToken}", expires_at: Date.now() + 30 * 86400000 }), { mode: 0o600 });
    break;
  case "onboard": state.line = true; save(); break;
  case "doctor": {
    const mine = args[args.indexOf("--project") + 1] === "${project}";
    out({ command: "doctor", code: "doctor", ok: !!state.line && mine, checks: [
      { name: "session", status: "pass", detail: "${email}" },
      mine ? { name: "project", status: "pass", detail: "Fixture Project: your role is owner." } : { name: "project", status: "fail", detail: "That project is not one of yours.", fix: "Yours: Fixture Project" },
      !mine ? { name: "line", status: "skip", detail: "Needs one project." } : state.line ? { name: "line", status: "pass", detail: "+1 555 010 0199 is available." } : { name: "line", status: "fail", detail: "The project has no FaceTime line.", fix: "Run chert onboard to get a line." },
    ], message: "${email}" });
    process.exitCode = state.line && mine ? 0 : 3;
    break;
  }
  case "livekit": {
    const env = args[args.indexOf("--env-file") + 1];
    const text = fs.readFileSync(env, "utf8").split("\\n").filter((l) => !/^LIVEKIT_/.test(l)).join("\\n");
    fs.writeFileSync(env, text + "\\nLIVEKIT_URL=wss://fixture.livekit.example\\nLIVEKIT_API_KEY=fixture-livekit-key\\nLIVEKIT_API_SECRET=fixture-livekit-secret\\n");
    fs.chmodSync(env, 0o644);
    break;
  }
  default: process.exitCode = 2;
}
`;

function fixture(
  options: {
    signedIn?: boolean;
    line?: boolean;
    chert?: boolean;
    service?: boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-connect-")));
  roots.push(root);
  const folder = (path: string, mode = 0o700) => {
    mkdirSync(path, { recursive: true, mode });
    chmodSync(path, mode);
    return path;
  };
  const home = folder(join(root, "home"));
  const state = join(root, "state");
  const chertHome = folder(join(root, "chert-home"));
  const desktop = folder(join(root, "desktop"));
  const projectRoot = folder(join(root, "project"), 0o755);
  const lineState = folder(join(root, "line-state"));
  // The line agent: the files the call path checks, and the example settings.
  const line = folder(join(root, "line"), 0o755);
  copyFileSync(
    join(process.cwd(), "line", ".env.example"),
    join(line, ".env.example"),
  );
  for (const name of [
    "package.json",
    "package-lock.json",
    "agent.mjs",
    "proactive-agent.mjs",
    "proactive-owner.mjs",
    "proactive-outbound.mjs",
  ])
    writeFileSync(join(line, name), `// fixture ${name}\n`, { mode: 0o644 });
  writeFileSync(join(line, "host.sh"), "#!/bin/sh\n", { mode: 0o755 });
  folder(join(line, "node_modules"), 0o755);
  // The node that runs the call worker: a program of this user.
  const node = join(folder(join(root, "tools"), 0o755), "node");
  writeFileSync(node, "#!/bin/sh\n", { mode: 0o755 });
  // The fake chert, in a fake provider package, linked onto the PATH.
  const bin = folder(join(root, "bin"), 0o755);
  const provider = folder(
    join(root, "provider", "node_modules", "@trychert", "facetime"),
    0o755,
  );
  writeFileSync(
    join(provider, "package.json"),
    JSON.stringify({ name: "@trychert/facetime", version: "0.1.0-beta.99" }),
  );
  const program = join(
    folder(join(provider, "dist", "src", "cli"), 0o755),
    "main.js",
  );
  writeFileSync(program, fakeChert, { mode: 0o755 });
  if (options.chert !== false) symlinkSync(program, join(bin, "chert"));
  writeFileSync(join(bin, "clawdtime"), "#!/bin/sh\n", { mode: 0o755 });
  const log = join(root, "chert-calls.log");
  writeFileSync(log, "");
  const fake = (value: Record<string, unknown>) =>
    writeFileSync(join(chertHome, "fake.json"), JSON.stringify(value), {
      mode: 0o600,
    });
  if (options.signedIn) {
    fake({ signedIn: true, line: options.line ?? false });
    writeFileSync(
      join(chertHome, "credentials.json"),
      JSON.stringify({
        access_token: connectorToken,
        expires_at: Date.now() + 30 * 86_400_000,
      }),
      { mode: 0o600 },
    );
  }
  // What the desktop service wrote about itself when it ran once.
  writeFileSync(
    join(desktop, "desktop-service.json"),
    JSON.stringify({
      version: 1,
      instanceId: "instance_fixture",
      pid: 999999,
      origin: "http://127.0.0.1:13326",
      projectRoot,
      worker: "simulation",
      panelConfigPath: join(desktop, "desktop-panel.json"),
      configurationFingerprint: "a".repeat(64),
    }),
    { mode: 0o600 },
  );
  // A running desktop service: its own files, with this process as its owner.
  const startService = () => {
    const files: Record<string, unknown> = {
      "desktop-service.json": {
        version: 1,
        instanceId: "instance_fixture",
        pid: process.pid,
        origin: "http://127.0.0.1:13326",
        projectRoot,
        configurationFingerprint: "b".repeat(64),
      },
      "desktop-panel.json": {
        version: 1,
        origin: "http://127.0.0.1:13326",
        token: "p".repeat(40),
        configurationFingerprint: "b".repeat(64),
      },
      "owner.lock": { pid: process.pid },
      "operator.json": { token: "o".repeat(40) },
    };
    for (const [name, value] of Object.entries(files))
      writeFileSync(join(desktop, name), JSON.stringify(value), {
        mode: 0o600,
      });
  };
  const stopService = () => rmSync(join(desktop, "owner.lock"));
  if (options.service) startService();
  // What the operator routes of the service were sent, and the policies taken back there.
  const operator: { url: string; id?: string; auth: string }[] = [];
  const revoked = new Set<string>();
  // Answers of the operator routes to give once, in place of the normal one.
  const faults: { match: string; status: number | "lost" }[] = [];
  const env: Record<string, string> = {
    PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: home,
    CHERT_HOME: chertHome,
    CLAWDTIME_CONFIG_HOME: state,
    CLAWDTIME_DESKTOP_STATE: desktop,
    CLAWDTIME_LINE_STATE: lineState,
    FAKE_CHERT_LOG: log,
  };
  const requests: { url: string; method: string; auth: string }[] = [];
  let keyAccepted = true;
  const request = (async (url: string | URL, init: RequestInit = {}) => {
    const href = String(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    requests.push({
      url: href,
      method: init.method ?? "GET",
      auth: headers.authorization ?? "",
    });
    if (href.includes("/api/v1/shared-messages"))
      return new Response(JSON.stringify({ data: { items: [] } }), {
        status: keyAccepted ? 200 : 401,
      });
    if (href.startsWith("http://127.0.0.1:13326/operator/proactive/")) {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      operator.push({
        url: href,
        id: body.id,
        auth: headers.authorization ?? "",
      });
      const fault = faults.findIndex((f) => href.includes(f.match));
      if (fault >= 0) {
        const { status } = faults.splice(fault, 1)[0]!;
        if (status === "lost") throw new TypeError("fetch failed");
        return new Response("{}", { status });
      }
      if (href.endsWith("/policies"))
        return new Response("{}", { status: revoked.has(body.id) ? 409 : 201 });
      const taken = /policies\/(.+)\/revoke$/.exec(href)?.[1];
      if (taken) revoked.add(decodeURIComponent(taken));
      return new Response("{}", { status: 200 });
    }
    if (href.includes("/api/v1/lines"))
      return new Response(
        JSON.stringify({
          data: { items: [{ id: lineId }], offset: 0, limit: 100, total: 1 },
        }),
        { status: 200 },
      );
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const printed: string[] = [];
  const asked: { question: string; hidden: boolean }[] = [];
  let answers: (string | null)[] = [];
  const run = (
    args: string[] = [],
    extra: {
      answers?: (string | null)[];
      retention?: typeof pinned | null;
    } = {},
  ) => {
    answers = [...(extra.answers ?? [])];
    return connectCli(args, {
      env,
      home,
      print: (text) => printed.push(text),
      ask: async (question, hidden) => {
        asked.push({ question, hidden });
        return answers.length ? answers.shift()! : null;
      },
      interactive: true,
      request,
      lineDirectory: line,
      nodeBinary: node,
      retention: extra.retention === undefined ? unpinned : extra.retention,
    });
  };
  const calls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((text) => (JSON.parse(text) as string[])[0]);
  const completeEnv = () =>
    writeFileSync(
      join(line, ".env.local"),
      [
        "LIVEKIT_URL=wss://fixture.livekit.example",
        "LIVEKIT_API_KEY=fixture-livekit-key",
        "LIVEKIT_API_SECRET=fixture-livekit-secret",
        "OPENAI_API_KEY=fixture-openai-key",
        "AGENT_NAME=clawdtime",
        `CLAWDTIME_LINE_CHERT_PROJECT=${project}`,
        "CLAWDTIME_LINE_FRAMING=fit",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  return {
    root,
    home,
    state,
    chertHome,
    desktop,
    projectRoot,
    lineState,
    line,
    env,
    requests,
    printed,
    asked,
    run,
    calls,
    completeEnv,
    rejectKey: () => {
      keyAccepted = false;
    },
    operator,
    revoked,
    faults,
    startService,
    stopService,
  };
}
/** The copy of the policy that connect sent to the service. */
const policyOf = (f: { desktop: string }) =>
  JSON.parse(
    readFileSync(join(f.desktop, "outbound", "policy.json"), "utf8"),
  ) as {
    id: string;
    scope: Record<string, string>;
    channels: string[];
    consent: { source: string };
  };

/** Every file under the folders, with its mode and its bytes. */
function snapshot(...folders: string[]) {
  const found: Record<string, string> = {};
  const walk = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      found[path] = `dir ${stat.mode & 0o777}`;
      for (const name of readdirSync(path)) walk(join(path, name));
    } else
      found[path] =
        `${stat.mode & 0o777} ${stat.isSymbolicLink() ? "link" : readFileSync(path, "utf8")}`;
  };
  for (const folder of folders) if (existsSync(folder)) walk(folder);
  return found;
}
const mode = (path: string) => statSync(path).mode & 0o777;

// Each run starts the fake chert a few times: a loaded Mac needs more than the default 5 s.
describe("clawdtime connect", { timeout: 30_000 }, () => {
  it("walks a fresh machine through every step, with the prompts answered", async () => {
    const f = fixture({ service: true });
    const first = await f.run([], {
      answers: ["", "fill", "y", "+1 (555) 010-0123", "yes", key],
    });
    expect(f.calls()).toEqual([
      "--version",
      "whoami",
      "login",
      "whoami",
      "doctor",
      "onboard",
      "doctor",
      "livekit",
    ]);
    // The OpenAI key is the person's own to put in: a needed part is missing.
    expect(first).toBe(1);
    const text = f.printed.join("\n");
    expect(text).toContain("2. Sign-in: signed in now");
    expect(text).toContain("4. Line: ready now");
    expect(text).toMatch(/5\. Line agent: .*missing: OPENAI_API_KEY/);
    expect(text).toContain("6. Your number: stored, ends in 23");
    expect(text).toMatch(
      /7\. Calls and texts to you: allowed now\. The desktop service has the calling policy until/,
    );
    expect(text).toContain("8. Project API key: stored in");
    // The retained provider cannot run with this chert build: the Calls API
    // takes its place, and waits for the OpenAI key of the line agent too.
    expect(text).toMatch(
      /9\. Outbound calls: the retained provider cannot run here \(it needs @trychert\/facetime 0\.1\.0-beta\.19, and this Mac has 0\.1\.0-beta\.99\), and the Chert Calls API, which works with any chert version, still needs OPENAI_API_KEY/,
    );
    expect(text).toMatch(/10\. Calls to you: /);
    expect(text).toMatch(/10\. Texts to you: /);
    expect(text).toContain("Not ready: step 5.");
    // The key came from a hidden prompt; nothing else was hidden.
    expect(f.asked.map((a) => a.hidden)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(f.asked[0]!.question).toContain(
      "Get a line now with chert onboard?",
    );

    // The line agent's settings: for the owner only, the keys of chert livekit kept.
    const envFile = join(f.line, ".env.local");
    expect(mode(envFile)).toBe(0o600);
    const settings = readFileSync(envFile, "utf8");
    expect(settings).toContain("AGENT_NAME=clawdtime");
    expect(settings).toContain(`CLAWDTIME_LINE_CHERT_PROJECT=${project}`);
    expect(settings).toContain("CLAWDTIME_LINE_FRAMING=fill");
    expect(settings).toContain("LIVEKIT_API_KEY=fixture-livekit-key");

    // The owner, the answer and the key: owner-only files in an owner-only folder.
    expect(mode(f.state)).toBe(0o700);
    expect(mode(join(f.state, "owner.json"))).toBe(0o600);
    expect(mode(join(f.state, "chert-key.json"))).toBe(0o600);
    const owner = readOwner(f.state).owner!;
    expect(owner.phone).toBe(phone);
    expect(owner.consent?.answer).toBe("yes");
    expect(readChertKey(f.state).key).toEqual({
      version: 1,
      projectId: project,
      apiKey: key,
    });
    // The calling policy: version 2, the owner's own yes, the computer worker
    // only. It went once to the running service through clawdtime proactive.
    expect(mode(join(f.desktop, "outbound"))).toBe(0o700);
    expect(mode(join(f.desktop, "outbound", "policy.json"))).toBe(0o600);
    const policy = policyOf(f);
    expect(policy.id).toBe(owner.consent?.policyId);
    expect(f.operator).toEqual([
      {
        url: "http://127.0.0.1:13326/operator/proactive/policies",
        id: policy.id,
        auth: `Bearer ${"o".repeat(40)}`,
      },
    ]);
    // proactive.json is not written: the service keeps the policy in its store.
    expect(existsSync(join(f.desktop, "proactive.json"))).toBe(false);
    expect(policy.scope).toEqual({
      personId: "clawdtime-owner",
      deviceId: "this-mac",
      projectRoot: f.projectRoot,
      sessionId: reachSession,
    });
    expect(policy.channels).toEqual(["phone_alert"]);
    expect(policy.consent.source).toBe("human_request");
    // To Chert only reads went.
    expect(
      f.requests
        .filter((r) => r.url.startsWith("https://"))
        .every((r) => r.method === "GET"),
    ).toBe(true);

    // The person puts in the OpenAI key; the next run asks nothing and goes on.
    const envText = readFileSync(envFile, "utf8").replace(
      /^OPENAI_API_KEY=.*$/m,
      "OPENAI_API_KEY=fixture-openai-key",
    );
    writeFileSync(envFile, envText);
    f.printed.length = 0;
    f.asked.length = 0;
    expect(await f.run()).toBe(3);
    expect(f.asked).toEqual([]);
    expect(f.printed.join("\n")).toContain("5. Line agent: ready");
    expect(f.printed.join("\n")).toContain(
      "9. Outbound calls: set up for the Chert Calls API now, because the retained provider cannot run here",
    );
    expect(f.printed.join("\n")).toContain("as FaceTime Audio");
    // calls.json: the line and the folder of its agent, for the owner only. No key, no number.
    const calls = readFileSync(join(f.state, "calls.json"), "utf8");
    expect(mode(join(f.state, "calls.json"))).toBe(0o600);
    expect(JSON.parse(calls)).toEqual({
      version: 1,
      provider: "chert-calls-api",
      projectId: project,
      lineId,
      video: false,
      lineDirectory: f.line,
    });
    expect(calls).not.toContain(key);
    expect(calls).not.toContain(phone);
    expect(f.printed.at(-1)).toMatch(
      /Your line is ready\. Still to do.*step 10/,
    );
    // Once set up, the next run keeps it and changes nothing.
    f.printed.length = 0;
    expect(await f.run()).toBe(3);
    expect(f.printed.join("\n")).toContain(
      "9. Outbound calls: the Chert Calls API is set up: calls go to your number, ends in 23, as FaceTime Audio",
    );
    expect(f.printed.join("\n")).not.toContain(
      "Start the ClawdTime desktop service again",
    );
  });

  it("skips every step that is done, and changes nothing", async () => {
    const f = fixture({ signedIn: true, line: true, service: true });
    f.completeEnv();
    // The line runs once: its records and its claim exist.
    const binding = "11112222-3333-4444-8555-666677778888";
    const claim = join(f.chertHome, "dev", binding);
    mkdirSync(claim, { recursive: true, mode: 0o700 });
    chmodSync(join(f.chertHome, "dev"), 0o700);
    writeFileSync(join(claim, "journal.json"), "{}", { mode: 0o600 });
    writeFileSync(
      join(f.lineState, "dev.jsonl"),
      `${JSON.stringify({ code: "dev_ready", binding_id: binding, state_dir: claim })}\n`,
      { mode: 0o600 },
    );
    const retention = pinned;
    expect(
      await f
        .run(
          [
            "--phone",
            "+1 555 010 0123",
            "--consent",
            "yes",
            "--api-key-env",
            "FIXTURE_KEY",
          ],
          {
            retention,
          },
        )
        .catch((error) => error),
    ).toBe(3);
    // No key in that environment yet: the variable is named, never a value.
    expect(f.printed.join("\n")).toContain("FIXTURE_KEY is empty");
    f.env.FIXTURE_KEY = key;
    f.printed.length = 0;
    expect(await f.run(["--api-key-env", "FIXTURE_KEY"], { retention })).toBe(
      3,
    );
    // The guarded line has not run yet: the one command that finishes it is named.
    const retentionFile = join(f.desktop, "outbound", "retention.json");
    expect(f.printed.join("\n")).toContain(
      `CLAWDTIME_LINE_RETENTION_CONFIG=${retentionFile} ./host.sh start`,
    );
    expect(JSON.parse(readFileSync(retentionFile, "utf8"))).toMatchObject({
      version: 1,
      projectId: project,
      lineId,
      chertHome: f.chertHome,
    });
    // The guarded line starts and leaves its proof.
    writeFileSync(
      join(f.desktop, "outbound", "retention-receipts", "4242.json"),
      "{}",
      { mode: 0o600 },
    );
    f.printed.length = 0;
    expect(await f.run([], { retention })).toBe(3);
    expect(f.printed.join("\n")).toContain(
      "9. Outbound calls: configured now, and proactive.json names it",
    );
    expect(f.printed.join("\n")).toContain(
      "Start the ClawdTime desktop service again",
    );
    const config = proactiveConfigSchema.parse(
      JSON.parse(readFileSync(join(f.desktop, "proactive.json"), "utf8")),
    );
    expect(config.outbound).toEqual({
      provider: "chert-dev-retained-v1",
      configurationFile: join(f.desktop, "outbound", "configuration.json"),
    });
    for (const name of ["configuration.json", "native.json", "retention.json"])
      expect(mode(join(f.desktop, "outbound", name))).toBe(0o600);
    for (const name of ["", "attempts", "retention-receipts"])
      expect(mode(join(f.desktop, "outbound", name))).toBe(0o700);

    // The desktop service reports both sides ready after its start.
    mkdirSync(join(f.state, "computer"), { mode: 0o700 });
    writeFileSync(
      join(f.state, "computer", "reach.json"),
      JSON.stringify({
        version: 1,
        items: [],
        readiness: {
          at: Date.now(),
          calls: { ready: true, reason: "ready" },
          texts: { ready: true, reason: "ready" },
        },
      }),
      { mode: 0o600 },
    );
    const before = snapshot(
      f.state,
      f.desktop,
      f.line,
      f.chertHome,
      f.lineState,
    );
    const callsBefore = f.calls().length;
    f.printed.length = 0;
    f.asked.length = 0;
    expect(await f.run([], { retention })).toBe(0);
    expect(f.asked).toEqual([]);
    expect(f.calls().slice(callsBefore)).toEqual([
      "--version",
      "whoami",
      "doctor",
    ]);
    expect(
      snapshot(f.state, f.desktop, f.line, f.chertHome, f.lineState),
    ).toEqual(before);
    const text = f.printed.join("\n");
    for (const line of [
      "5. Line agent: ready",
      "6. Your number: kept, ends in 23",
      "7. Calls and texts to you: allowed. The desktop service has the calling policy until",
      "8. Project API key: stored in",
      "9. Outbound calls: configured, and proactive.json names it",
      "10. Calls to you: ready",
      "10. Texts to you: ready",
      "All ready",
    ])
      expect(text).toContain(line);
    expect(text).not.toContain("Start the ClawdTime desktop service again");
    // The same policy again is the check: the service has it, and none was added.
    expect(new Set(f.operator.map((o) => o.id)).size).toBe(1);

    // --check on the finished machine: all ready, nothing written, nothing sent but reads.
    const sentBefore = f.operator.length;
    const requestsBefore = f.requests.length;
    f.printed.length = 0;
    expect(await f.run(["--check"], { retention })).toBe(0);
    expect(f.operator).toHaveLength(sentBefore);
    expect(
      f.requests.slice(requestsBefore).every((r) => r.method === "GET"),
    ).toBe(true);
    expect(
      snapshot(f.state, f.desktop, f.line, f.chertHome, f.lineState),
    ).toEqual(before);

    // The call path would refuse its configuration now (the sign-in file is
    // open to others): proactive.json names no outbound line any more, so the
    // desktop service still starts.
    chmodSync(join(f.chertHome, "credentials.json"), 0o644);
    f.printed.length = 0;
    expect(await f.run([], { retention })).toBe(3);
    expect(f.printed.join("\n")).toContain(
      "proactive.json names no outbound line until then",
    );
    expect(
      proactiveConfigSchema.parse(
        JSON.parse(readFileSync(join(f.desktop, "proactive.json"), "utf8")),
      ).outbound,
    ).toBeUndefined();
    expect(f.printed.join("\n")).toContain(
      "Start the ClawdTime desktop service again",
    );
  });

  it("--check reports and writes nothing", async () => {
    const f = fixture({ signedIn: true, line: true });
    const before = snapshot(f.root);
    const callsBefore = f.calls().length;
    const code = await f.run(["--check", "--phone", phone, "--consent", "yes"]);
    expect(code).toBe(1);
    expect(f.asked).toEqual([]);
    // The log of the fake chert itself is the only file that grew.
    const after = snapshot(f.root);
    delete before[join(f.root, "chert-calls.log")];
    delete after[join(f.root, "chert-calls.log")];
    expect(after).toEqual(before);
    expect(f.calls().slice(callsBefore)).toEqual([
      "--version",
      "whoami",
      "doctor",
    ]);
    expect(f.requests).toEqual([]);
    const text = f.printed.join("\n");
    expect(text).toContain("Checking only");
    expect(text).toContain("5. Line agent: ");
    expect(text).toContain("clawdtime connect makes it from .env.example");
    expect(text).toContain("6. Your number: not stored yet, ends in 23");

    // Not signed in: check names chert login and starts nothing.
    const g = fixture();
    const fresh = snapshot(g.root);
    expect(await g.run(["--check"])).toBe(1);
    expect(g.calls()).toEqual(["--version", "whoami"]);
    expect(g.printed.join("\n")).toContain(
      "2. Sign-in: not signed in. Run: chert login",
    );
    const later = snapshot(g.root);
    delete fresh[join(g.root, "chert-calls.log")];
    delete later[join(g.root, "chert-calls.log")];
    expect(later).toEqual(fresh);
  });

  it("checks the project that line/.env.local names, and never onboards another one", async () => {
    const f = fixture({ signedIn: true, line: false });
    const other = "99998888-7777-4666-8555-444433332222";
    writeFileSync(
      join(f.line, ".env.local"),
      `CLAWDTIME_LINE_CHERT_PROJECT=${other}\n`,
      { mode: 0o600 },
    );
    expect(await f.run()).toBe(1);
    expect(f.calls()).not.toContain("onboard");
    const text = f.printed.join("\n");
    expect(text).toContain(
      `3. Project: ${other}, as line/.env.local names it. The sign-in of this Mac names ${project}`,
    );
    expect(text).toContain(
      "4. Line: That project is not one of yours. Run chert login and choose that project",
    );
  });

  it("says the one install command when chert is missing, and stops", async () => {
    const f = fixture({ chert: false });
    expect(await f.run()).toBe(1);
    expect(f.printed[0]).toBe(
      "1. Chert command: missing. Install it: npm install -g @trychert/facetime@beta. Then run clawdtime connect again",
    );
    expect(f.printed).toHaveLength(2);
  });

  it("prints no key, no full number, no address and no sign-in token", async () => {
    const f = fixture();
    await f.run([], { answers: ["", "", "y", phone, "yes", key] });
    f.completeEnv();
    await f.run(["--consent", "no"]);
    await computerCli(["doctor"], {
      env: f.env,
      home: f.home,
      print: (text) => f.printed.push(text),
    });
    const seen = [...f.printed, ...f.asked.map((a) => a.question)].join("\n");
    for (const secret of [
      key,
      connectorToken,
      email,
      "fixture-livekit-secret",
      "fixture-openai-key",
      phone,
      "5550100123",
      "0100123",
      "100123",
      "0123",
    ])
      expect(seen).not.toContain(secret);
    expect(seen).toContain("ends in 23");
    // The number of the line in the words of chert is not shown either.
    expect(plain("+1 555 010 0199 is available.")).toBe(
      "a number is available.",
    );
    expect(plain(`Signed in as ${email}.`)).toBe("Signed in as your account");
  });

  it("refuses a file that others can read, a linked file and a second name, and changes none", async () => {
    const f = fixture({ signedIn: true, line: true });
    mkdirSync(f.state, { mode: 0o700 });
    // owner.json that others can read.
    writeFileSync(
      join(f.state, "owner.json"),
      JSON.stringify({ version: 1, phone }),
      { mode: 0o644 },
    );
    // chert-key.json that is a link to another file.
    const elsewhere = join(f.root, "elsewhere.json");
    writeFileSync(elsewhere, "not a key", { mode: 0o600 });
    symlinkSync(elsewhere, join(f.state, "chert-key.json"));
    // .env.local that others can read.
    writeFileSync(join(f.line, ".env.local"), "OPENAI_API_KEY=x\n", {
      mode: 0o644,
    });
    const before = snapshot(f.root);
    delete before[join(f.root, "chert-calls.log")];
    await f.run(
      ["--phone", phone, "--consent", "yes", "--api-key-env", "NOT_SET"],
      {
        answers: [],
      },
    );
    const text = f.printed.join("\n");
    expect(text).toMatch(
      /5\. Line agent: .*\.env\.local is open to other users.*chmod 600/,
    );
    expect(text).toMatch(
      /6\. Your number: .*owner\.json is not a regular file of this user for its owner only/,
    );
    expect(text).toMatch(
      /8\. Project API key: .*chert-key\.json is not a regular file of this user for its owner only/,
    );
    const after = snapshot(f.root);
    delete after[join(f.root, "chert-calls.log")];
    expect(after).toEqual(before);
    expect(readFileSync(elsewhere, "utf8")).toBe("not a key");

    // A second name (a hard link) of the owner file is refused as well.
    const g = fixture({ signedIn: true, line: true });
    mkdirSync(g.state, { mode: 0o700 });
    writeFileSync(
      join(g.root, "other.json"),
      JSON.stringify({ version: 1, phone }),
      {
        mode: 0o600,
      },
    );
    linkSync(join(g.root, "other.json"), join(g.state, "owner.json"));
    expect(readOwner(g.state).problem).toMatch(
      /not a regular file of this user/,
    );
    expect(() =>
      writeOwner(g.state, { version: 1, phone: "+15550100999" }),
    ).toThrow(/not a regular file of this user/);
    expect(
      JSON.parse(readFileSync(join(g.root, "other.json"), "utf8")).phone,
    ).toBe(phone);
    // A state folder that others can read is not used.
    const h = fixture();
    mkdirSync(h.state, { mode: 0o755 });
    chmodSync(h.state, 0o755);
    expect(() => writeOwner(h.state, { version: 1, phone })).toThrow(
      /chmod 700/,
    );
  });

  it("with no yes, writes no calling policy, and says how to allow it later", async () => {
    const f = fixture({ signedIn: true, line: true });
    f.completeEnv();
    f.env.FIXTURE_KEY = key;
    const code = await f.run(
      ["--phone", phone, "--api-key-env", "FIXTURE_KEY"],
      { answers: ["no thanks"] },
    );
    expect(code).toBe(3);
    const text = f.printed.join("\n");
    expect(text).toContain(
      "7. Calls and texts to you: off: ClawdTime does not call or text you when it needs you. To allow it later: clawdtime connect --consent yes",
    );
    expect(text).toContain(
      "9. Outbound calls: off: calls to you are not allowed (step 7)",
    );
    expect(existsSync(join(f.desktop, "proactive.json"))).toBe(false);
    expect(existsSync(join(f.desktop, "outbound", "policy.json"))).toBe(false);
    expect(f.operator).toEqual([]);
    expect(readOwner(f.state).owner?.consent?.answer).toBe("no");
    // The reach does not text a number that was stored with a no.
    expect(ownerTextPort({}, f.state).readiness()).toEqual({
      ready: false,
      reason: "no_consent",
    });
    // A later run does not ask again.
    f.asked.length = 0;
    await f.run();
    expect(f.asked).toEqual([]);

    // A yes, then a no while the service runs: the policy is taken back there.
    f.startService();
    await f.run(["--consent", "yes"]);
    const first = readOwner(f.state).owner!.consent!.policyId!;
    expect(policyOf(f).id).toBe(first);
    await f.run(["--consent", "no"]);
    expect(f.operator.at(-1)!.url).toBe(
      `http://127.0.0.1:13326/operator/proactive/policies/${first}/revoke`,
    );
    expect(readOwner(f.state).owner!.revoke).toBeUndefined();
    // A yes, then a no while no service runs: the next run with it takes it back.
    await f.run(["--consent", "yes"]);
    const second = readOwner(f.state).owner!.consent!.policyId!;
    expect(second).not.toBe(first);
    f.stopService();
    f.printed.length = 0;
    await f.run(["--consent", "no"]);
    expect(readOwner(f.state).owner!.revoke).toEqual([second]);
    expect(f.printed.join("\n")).toContain(
      "so the desktop service cannot call you once it starts again. It did not confirm that it took the calling policy back",
    );
    f.startService();
    await f.run();
    expect(f.operator.at(-1)!.url).toBe(
      `http://127.0.0.1:13326/operator/proactive/policies/${second}/revoke`,
    );
    expect(readOwner(f.state).owner!.revoke).toBeUndefined();
  });

  it("sends the policy once to a running desktop service through clawdtime proactive", async () => {
    const f = fixture({ signedIn: true, line: true, service: true });
    f.completeEnv();
    expect(await f.run(["--phone", phone, "--consent", "yes"])).toBe(3);
    const first = policyOf(f).id;
    expect(f.operator.map((o) => [o.url, o.id])).toEqual([
      ["http://127.0.0.1:13326/operator/proactive/policies", first],
    ]);
    // The same policy again changes nothing, and nothing new is made.
    await f.run();
    expect(f.operator.map((o) => o.id)).toEqual([first, first]);
    expect(policyOf(f).id).toBe(first);
    // The owner said "stop calling" on a call: connect says so, and makes no new policy by itself.
    f.revoked.add(first);
    f.printed.length = 0;
    await f.run();
    expect(f.printed.join("\n")).toContain("the calling policy was taken back");
    expect(policyOf(f).id).toBe(first);
    // A new yes makes a new policy in its place.
    await f.run(["--consent", "yes"]);
    const second = policyOf(f).id;
    expect(second).not.toBe(first);
    expect(f.operator.at(-1)!.id).toBe(second);
    expect(readOwner(f.state).owner!.consent!.policyId).toBe(second);
    // A new number: the policy of the old one is taken back, and a new yes is asked for.
    f.printed.length = 0;
    await f.run(["--phone", "+15550100999"]);
    expect(
      f.operator.some((o) => o.url.endsWith(`/policies/${second}/revoke`)),
    ).toBe(true);
    const text = f.printed.join("\n");
    expect(text).toContain("6. Your number: changed, ends in 99");
    expect(text).toContain("7. Calls and texts to you: not answered");
    expect(readOwner(f.state).owner!.consent).toBeUndefined();
    expect(readOwner(f.state).owner!.revoke).toBeUndefined();
  });

  it("sends a policy whose answer was lost again as the same one, and never makes two", async () => {
    const f = fixture({ signedIn: true, line: true, service: true });
    f.completeEnv();
    f.faults.push({ match: "/policies", status: "lost" });
    f.printed.length = 0;
    await f.run(["--phone", phone, "--consent", "yes"]);
    expect(f.printed.join("\n")).toContain(
      "the desktop service did not confirm the calling policy. Run clawdtime connect again: it sends the same one",
    );
    const id = readOwner(f.state).owner!.consent!.policyId!;
    expect(policyOf(f).id).toBe(id);
    f.printed.length = 0;
    await f.run();
    expect(f.printed.join("\n")).toContain(
      "7. Calls and texts to you: allowed. The desktop service has the calling policy until",
    );
    expect(f.operator.map((o) => o.id)).toEqual([id, id]);

    // The policy nears its end: a new yes takes the old one back before a new one is made.
    const copy = join(f.desktop, "outbound", "policy.json");
    const near = { ...policyOf(f), expiresAt: Date.now() + 3_600_000 };
    writeFileSync(copy, JSON.stringify(near), { mode: 0o600 });
    f.faults.push({ match: `/policies/${id}/revoke`, status: 500 });
    f.printed.length = 0;
    await f.run([], { answers: ["yes"] });
    expect(f.printed.join("\n")).toContain(
      "did not confirm that it took the earlier calling policy back, so no new one is made",
    );
    expect(readOwner(f.state).owner!.revoke).toEqual([id]);
    expect(f.operator.filter((o) => o.url.endsWith("/policies"))).toHaveLength(
      2,
    );
    // The next run takes it back first, then makes the new one.
    await f.run([], { answers: ["yes"] });
    const urls = f.operator.map((o) => o.url);
    const revokedAt = urls.lastIndexOf(
      `http://127.0.0.1:13326/operator/proactive/policies/${id}/revoke`,
    );
    expect(revokedAt).toBeGreaterThan(0);
    expect(urls.slice(revokedAt + 1)).toEqual([
      "http://127.0.0.1:13326/operator/proactive/policies",
    ]);
    const fresh = readOwner(f.state).owner!;
    expect(fresh.consent!.policyId).not.toBe(id);
    expect(fresh.revoke).toBeUndefined();
  });

  it("does not count a revocation as done when the operator routes are not there", async () => {
    const f = fixture({ signedIn: true, line: true, service: true });
    f.completeEnv();
    await f.run(["--phone", phone, "--consent", "yes"]);
    const id = readOwner(f.state).owner!.consent!.policyId!;
    f.faults.push(
      { match: `/policies/${id}/revoke`, status: 404 },
      { match: "/intents", status: 404 },
    );
    await f.run(["--consent", "no"]);
    expect(readOwner(f.state).owner!.revoke).toEqual([id]);
  });

  it("refuses a key that the project refuses, and stores none", async () => {
    const f = fixture({ signedIn: true, line: true });
    f.completeEnv();
    f.rejectKey();
    f.env.FIXTURE_KEY = key;
    await f.run([
      "--phone",
      phone,
      "--consent",
      "no",
      "--api-key-env",
      "FIXTURE_KEY",
    ]);
    expect(f.printed.join("\n")).toContain(
      "8. Project API key: the key was refused for this project",
    );
    expect(existsSync(join(f.state, "chert-key.json"))).toBe(false);
  });

  it("keeps the pairing of a coding agent on connect --agent, and answers connect --help", async () => {
    await expect(main(["connect", "--agent", "neither"])).rejects.toThrow(
      "--agent must be codex or claude-code.",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main(["connect", "--help"]);
      expect(String(log.mock.calls[0]?.[0])).toContain(
        "clawdtime connect: connect ClawdTime to Chert",
      );
    } finally {
      log.mockRestore();
    }
    const printed: string[] = [];
    expect(
      await connectCli(["--consent", "maybe"], {
        print: (t) => printed.push(t),
      }),
    ).toBe(2);
    expect(printed).toEqual(["Use --consent yes, or --consent no."]);
    expect(
      await connectCli(["--phone", "abc"], { print: (t) => printed.push(t) }),
    ).toBe(2);
    expect(printed.at(-1)).toContain("--phone needs your full number");
    expect(
      await connectCli(["--api-key-env", "ftk_a key"], {
        print: (t) => printed.push(t),
      }),
    ).toBe(2);
  });
});
