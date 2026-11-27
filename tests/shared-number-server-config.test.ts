import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

it("starts with a list of invited numbers, and refuses one that is not a phone number", async () => {
  const output = await startsInStandby(
    configFile(await freePort(), { invited: ["+14155550100", "+12125550100"] }),
  );
  expect(output).toContain("Shared coordinator standby");
  refuses(configFile(await freePort(), { invited: ["555-0100"] }));
}, 60_000);
