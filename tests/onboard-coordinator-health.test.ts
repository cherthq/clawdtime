import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

// Made-up values only. The coordinator starts in standby: no provider, no text.
const entry = resolve("scripts/shared-number-server.ts");
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "clawdtime-onboard-health-"));
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

it("answers /health with the protocol number that setup checks", async () => {
  const port = await freePort();
  const file = join(directory, "config.json");
  writeFileSync(
    file,
    JSON.stringify({
      enabled: false,
      database: join(directory, "data", "shared.sqlite"),
      lineId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
      proofKey: "a".repeat(64),
      identityKey: "b".repeat(64),
      lineToken: "t".repeat(32),
      host: "127.0.0.1",
      port,
      messaging: {
        origin: "https://messaging.example",
        projectId: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
        key: "k".repeat(32),
      },
    }),
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      VITEST: "true",
      CLAWDTIME_SHARED_CONFIG: file,
    },
  });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  try {
    await new Promise<void>((done, fail) => {
      let output = "";
      const timer = setTimeout(
        () => fail(Error(`no_standby: ${output}`)),
        20_000,
      );
      const read = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("Shared coordinator standby")) {
          clearTimeout(timer);
          done();
        }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
    });
    const health = await (
      await fetch(`http://127.0.0.1:${port}/health`)
    ).json();
    expect(health).toMatchObject({
      service: "shared-number",
      mode: "standby",
      protocol: 1,
      physicalAcceptance: false,
    });
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
}, 30_000);
