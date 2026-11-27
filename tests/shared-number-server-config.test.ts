import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

// Made-up values only. The coordinator reads its configuration from an
// owner-only file and refuses to start when the file does not match the schema.
const lineId = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const projectId = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const entry = resolve("scripts/shared-number-server.ts");
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "clawdtime-shared-config-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? done(address.port)
          : fail(Error("no_port")),
      );
    });
  });

const configFile = (port: number, change: Record<string, unknown> = {}) => {
  const file = join(directory, "config.json");
  writeFileSync(
    file,
    JSON.stringify({
      enabled: false,
      database: join(directory, "data", "shared.sqlite"),
      lineId,
      proofKey: "a".repeat(64),
      identityKey: "b".repeat(64),
      lineToken: "t".repeat(32),
      host: "127.0.0.1",
      port,
      messaging: {
        origin: "https://messaging.example",
        projectId,
        key: "k".repeat(32),
      },
      ...change,
    }),
    { mode: 0o600 },
  );
  return file;
};

const environment = (file: string) => ({
  PATH: process.env.PATH,
  VITEST: "true",
  CLAWDTIME_SHARED_CONFIG: file,
});

const refuses = (file: string) => {
  const result = spawnSync(process.execPath, ["--import", "tsx", entry], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 20_000,
    env: environment(file),
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Shared coordinator refused startup");
};

const startsInStandby = (file: string) =>
  new Promise<string>((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      cwd: process.cwd(),
      env: environment(file),
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(Error(`no_standby: ${output}`));
    }, 20_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Shared coordinator standby")) child.kill("SIGTERM");
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", () => {
      clearTimeout(timer);
      done(output);
    });
  });

it("starts in standby with a UUID line and a UUID project", async () => {
  const output = await startsInStandby(configFile(await freePort()));
  expect(output).toContain("Shared coordinator standby");
  expect(output).not.toContain("refused startup");
}, 30_000);

it("refuses a line ID that is not a UUID", async () => {
  refuses(configFile(await freePort(), { lineId: "line-1" }));
}, 30_000);

it("refuses a project ID that is not a UUID", async () => {
  refuses(
    configFile(await freePort(), {
      messaging: {
        origin: "https://messaging.example",
        projectId: "project-1",
        key: "k".repeat(32),
      },
    }),
  );
}, 30_000);

// An enabled coordinator with a made-up provider. Nothing here sends a text:
// every number is a stranger, so no sign-in text leaves the process.
const enabled = (port: number, change: Record<string, unknown> = {}) =>
  configFile(port, {
    enabled: true,
    provider: {
      integrationId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      endpoint: "https://coordinator.example/provider/webhook",
      webhookSecret: "w".repeat(32),
      controlCredentialsFile: join(directory, "control.json"),
      media: {
        url: "wss://media.example",
        key: "media-key",
        secret: "m".repeat(16),
        agentName: "shared-test",
      },
    },
    ...change,
  });

const running = (file: string) =>
  new Promise<{ stop(): Promise<void> }>((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      cwd: process.cwd(),
      env: environment(file),
    });
    let output = "";
    const exited = new Promise<void>((resolve) => child.once("exit", resolve));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(Error(`not_available: ${output}`));
    }, 20_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("refused startup")) {
        clearTimeout(timer);
        fail(Error(`refused: ${output}`));
      }
      if (output.includes("Shared coordinator available")) {
        clearTimeout(timer);
        done({
          stop: async () => {
            child.kill("SIGTERM");
            await exited;
          },
        });
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
  });

const startFrom = async (port: number, recipient: string, forwarded = "") =>
  (
    await fetch(`http://127.0.0.1:${port}/auth/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
      },
      body: JSON.stringify({ recipient }),
    })
  ).status;
const strangers = Array.from(
  { length: 12 },
  (_, i) => `+1312555${String(1000 + i)}`,
);

it("counts sign-in starts by the client address that the real server sees", async () => {
  const port = await freePort();
  const server = await running(enabled(port));
  try {
    // A forwarded header is not trusted without the proxy flag.
    for (const number of strangers.slice(0, 10))
      expect(await startFrom(port, number, "203.0.113.9")).toBe(200);
    expect(await startFrom(port, strangers[10]!, "198.51.100.7")).toBe(429);
  } finally {
    await server.stop();
  }
  // Each start was counted by the socket address, not as one unknown client.
  const db = new DatabaseSync(join(directory, "data", "shared.sqlite"));
  const clients = db
    .prepare(
      "SELECT DISTINCT json_extract(body, '$.client') AS client FROM entities WHERE kind = 'shared_identity_challenge'",
    )
    .all()
    .map((row) => row.client);
  db.close();
  const digest = (client: string) =>
    createHmac("sha256", Buffer.from("b".repeat(64), "hex"))
      .update(JSON.stringify(["client", client]))
      .digest("hex");
  expect(clients).toEqual([digest("127.0.0.1")]);
}, 60_000);

it("counts each client behind a proxy by the last forwarded address", async () => {
  const port = await freePort();
  const server = await running(enabled(port, { behindProxy: true }));
  try {
    for (const number of strangers.slice(0, 10))
      expect(await startFrom(port, number, "203.0.113.9")).toBe(200);
    expect(await startFrom(port, strangers[10]!, "203.0.113.9")).toBe(429);
    // A client cannot pick its address: the proxy appends the real one last.
    expect(
      await startFrom(port, strangers[10]!, "198.51.100.7, 203.0.113.9"),
    ).toBe(429);
    // Another client keeps its own allowance.
    expect(await startFrom(port, strangers[10]!, "198.51.100.7")).toBe(200);
  } finally {
    await server.stop();
  }
}, 60_000);

it("starts with a list of invited numbers, and refuses one that is not a phone number", async () => {
  const output = await startsInStandby(
    configFile(await freePort(), { invited: ["+14155550100", "+12125550100"] }),
  );
  expect(output).toContain("Shared coordinator standby");
  refuses(configFile(await freePort(), { invited: ["555-0100"] }));
}, 60_000);
