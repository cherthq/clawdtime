import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAppServerConnection,
  executorEnvironment,
} from "../connectors/codex/app-server.js";

afterEach(() => vi.unstubAllEnvs());

it("does not pass frontend or control-plane credentials to the actual executor child", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawdtime-executor-env-"));
  const binary = join(root, "fixture-executor");
  const hidden = [
    "CLAWDTIME_AI_GATEWAY_KEY",
    "CLAWDTIME_OPERATOR_TOKEN",
    "OPENAI_API_KEY",
    "OPENAI_ADMIN_KEY",
    "AI_GATEWAY_API_KEY",
    "MEDIA_API_KEY",
    "BACKEND_TOKEN",
    "LIVEKIT_API_SECRET",
    "DEEPGRAM_API_KEY",
    "DEVICE_GATEWAY_KEY",
    "GATEWAY_SECRET",
    "RAILWAY_TOKEN",
    "VERCEL_TOKEN",
    "DATABASE_URL",
    "ELEVENLABS_API_KEY",
    "ARBITRARY_PRIVATE_SECRET",
    "CODEX_API_KEY",
  ];
  for (const key of hidden) vi.stubEnv(key, "synthetic-private-test-value");
  vi.stubEnv("CODEX_HOME", root);
  // Report booleans only: no parent or child environment values enter logs/results.
  await writeFile(
    binary,
    `#!${process.execPath}\nconst rl = require('node:readline').createInterface({input:process.stdin});\nrl.on('line', line => { const message=JSON.parse(line); process.stdout.write(JSON.stringify({id:message.id,result:{isolated:${JSON.stringify(hidden)}.every(key=>process.env[key]===undefined),codexHomePreserved:process.env.CODEX_HOME===${JSON.stringify(root)},pathPresent:!!process.env.PATH,homePresent:!!process.env.HOME}})+'\\n'); });\n`,
    { mode: 0o700 },
  );
  const connection = new CodexAppServerConnection(root, binary, 3000);
  try {
    expect(await connection.request("fixture/environment", {})).toEqual({
      isolated: true,
      codexHomePreserved: true,
      pathPresent: true,
      homePresent: true,
    });
    expect(
      process.env.CLAWDTIME_OPERATOR_TOKEN === "synthetic-private-test-value",
    ).toBe(true);
  } finally {
    connection.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("copies rather than mutates supplied host environment and filters namespaces case-insensitively", () => {
  const env = {
    Path: "/synthetic",
    openai_api_key: "synthetic",
    CODEX_HOME: "/codex",
    CODEX_API_KEY: "synthetic-host",
  };
  const child = executorEnvironment(env);
  expect("openai_api_key" in child).toBe(false);
  expect("openai_api_key" in env).toBe(true);
  expect(child.CODEX_HOME === env.CODEX_HOME).toBe(true);
  expect(child.CODEX_API_KEY).toBeUndefined();
});
