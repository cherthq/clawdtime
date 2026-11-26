import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../cli/main.js";
import { connectionPath, secureWrite } from "../connectors/shared/state.js";

// disconnect and uninstall remove ClawdTime's own files. A --connection path
// that the person gave may sit in a folder of their own: that folder and its
// other files stay.
let home: string;
let project: string;
let server: Server;
let origin: string;
let previousConfigHome: string | undefined;

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-disconnect-")));
  project = join(home, "project");
  mkdirSync(project);
  previousConfigHome = process.env.CLAWDTIME_CONFIG_HOME;
  process.env.CLAWDTIME_CONFIG_HOME = join(home, "state");
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (previousConfigHome === undefined)
    delete process.env.CLAWDTIME_CONFIG_HOME;
  else process.env.CLAWDTIME_CONFIG_HOME = previousConfigHome;
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
});

const connection = (revoked = false) => ({
  schemaVersion: 1,
  baseUrl: origin,
  pairing: {
    id: "pairing-fixture",
    ...(revoked ? { revokedAt: 1 } : {}),
  },
  token: "t".repeat(43),
  adapter: "codex",
  adapterVersion: "0.0.0",
  projectRoot: project,
  hostId: "host-fixture",
});

describe("disconnect and uninstall", () => {
  for (const command of ["disconnect", "uninstall"] as const)
    it(`${command} with --connection removes that file only, never its folder`, async () => {
      const folder = join(home, "my-files");
      mkdirSync(folder, { mode: 0o700 });
      const mine = join(folder, "notes.txt");
      writeFileSync(mine, "my own notes");
      const file = join(folder, "connection.json");
      secureWrite(file, connection(command === "uninstall"));
      await main([
        command,
        "--agent",
        "codex",
        "--project",
        project,
        "--connection",
        file,
      ]);
      expect(existsSync(file)).toBe(false);
      expect(existsSync(folder)).toBe(true);
      expect(existsSync(mine)).toBe(true);
    });

  for (const command of ["disconnect", "uninstall"] as const)
    it(`${command} without --connection removes ClawdTime's own folder of the connection`, async () => {
      const state = process.env.CLAWDTIME_CONFIG_HOME!;
      const file = connectionPath(project, "codex");
      secureWrite(file, connection(command === "uninstall"));
      const owner = join(state, "owner.json");
      writeFileSync(owner, "{}", { mode: 0o600 });
      await main([command, "--agent", "codex", "--project", project]);
      expect(existsSync(dirname(file))).toBe(false);
      expect(existsSync(join(state, "connections"))).toBe(true);
      expect(existsSync(owner)).toBe(true);
    });

  it("a --connection path that is the default one still removes its own folder", async () => {
    const file = connectionPath(project, "codex");
    secureWrite(file, connection());
    await main([
      "disconnect",
      "--agent",
      "codex",
      "--project",
      project,
      "--connection",
      file,
    ]);
    expect(existsSync(dirname(file))).toBe(false);
  });
});
