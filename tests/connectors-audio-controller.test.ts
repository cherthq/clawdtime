import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only a disposable loopback HTTP fixture is exercised; these tests never dial.
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture(status = 200) {
  const calls: { method?: string; path?: string; body: string }[] = [];
  const credential = "synthetic-audio-operator-credential-000000";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    calls.push({ method: request.method, path: request.url, body });
    expect(request.headers.authorization).toBe(`Bearer ${credential}`);
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        status === 200
          ? {
              version: 1,
              enabled: true,
              ready: true,
              executionDisabled: true,
              maxDurationSeconds: 300,
              privateFixtureValue: credential,
            }
          : { error: credential },
      ),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture address missing");
  const root = mkdtempSync(join(tmpdir(), "clawdtime-audio-controller-"));
  roots.push(root);
  const config = join(root, "operator.json");
  writeFileSync(
    config,
    JSON.stringify({
      backendOrigin: `http://127.0.0.1:${address.port}`,
      operatorToken: credential,
      pairingId: "synthetic-pairing",
    }),
    { mode: 0o600 },
  );
  return { calls, config, root, credential };
}

function run(config: string, args: string[] = []) {
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/audio-qualification.ts",
          "--config",
          config,
          ...args,
        ],
        {
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve({ code, output });
      });
      child.stdin.end();
    },
  );
}

it("defaults to one read-only readiness request without a ledger or credential output", async () => {
  const f = await fixture();
  const result = await run(f.config);
  expect(result.code).toBe(0);
  expect(f.calls).toEqual([
    {
      method: "GET",
      path: "/internal/audio-qualifications/readiness",
      body: "",
    },
  ]);
  expect(JSON.parse(result.output)).toMatchObject({
    executionDisabled: true,
    ready: true,
    physicalAcceptance: false,
  });
  expect(result.output).not.toContain(f.credential);
  expect(readdirSync(f.root)).toEqual(["operator.json"]);
});

it("refuses unattended start even with current readiness and the explicit flag", async () => {
  const f = await fixture();
  const result = await run(f.config, ["--start", "--ready-for-one-call"]);
  expect(result.code).toBe(1);
  expect(f.calls.map((item) => item.method)).toEqual(["GET"]);
  expect(readdirSync(f.root)).toEqual(["operator.json"]);
});

it("sends only the exact operator Stop and makes no cleanup-confirmed claim", async () => {
  const f = await fixture();
  const result = await run(f.config, ["--stop", "attention_synthetic"]);
  expect(result.code).toBe(0);
  expect(f.calls).toEqual([
    {
      method: "POST",
      path: "/internal/audio-qualifications/attention_synthetic/stop",
      body: "{}",
    },
  ]);
  expect(result.output).toContain(
    "Inspect status until provider cleanup is confirmed",
  );
  expect(result.output).not.toContain("Call ended; cleanup confirmed");
});

it("does not retry failed Stop or expose the response body", async () => {
  const f = await fixture(503);
  const result = await run(f.config, ["--stop", "attention_synthetic"]);
  expect(result.code).toBe(1);
  expect(f.calls).toHaveLength(1);
  expect(result.output).not.toContain(f.credential);
  expect(result.output).toContain("No retry was issued");
});

it("rejects a symlink configuration before any HTTP request", async () => {
  const f = await fixture();
  const link = join(f.root, "linked.json");
  symlinkSync(f.config, link);
  const result = await run(link, ["--check"]);
  expect(result.code).toBe(1);
  expect(f.calls).toEqual([]);
});
