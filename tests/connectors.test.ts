import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  chmodSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installClaude,
  uninstallClaude,
} from "../connectors/claude-code/config.js";
import { installCodex, uninstallCodex } from "../connectors/codex/config.js";
import {
  ClawdTimeClient,
  validateOrigin,
} from "../connectors/shared/client.js";
import {
  canonicalProject,
  secureWrite,
  secureRead,
  loadConnection,
  type Connection,
} from "../connectors/shared/state.js";
import {
  installConfiguration,
  uninstallConfiguration,
} from "../cli/install.js";
const roots: string[] = [];
const temporary = () => {
  const p = mkdtempSync(join(tmpdir(), "clawdtime-connectors-"));
  roots.push(p);
  return p;
};
afterEach(() =>
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
const entry = {
  command: "/usr/bin/node",
  args: ["/private/build/cli.js", "mcp"],
};
describe("configuration ownership", () => {
  it("preserves Claude servers and settings, removing only our unchanged entry", () => {
    const initial = {
      mcpServers: { existing: { command: "other" } },
      custom: { untouched: true },
    };
    const changed = installClaude(JSON.stringify(initial), entry);
    const edited = JSON.parse(changed.text);
    edited.mcpServers.later = { command: "later" };
    const restored = JSON.parse(
      uninstallClaude(JSON.stringify(edited), changed.installedEntry),
    );
    expect(restored).toEqual({
      ...initial,
      mcpServers: { ...initial.mcpServers, later: { command: "later" } },
    });
  });
  it("preserves exact existing Codex TOML bytes and refuses changed managed block", () => {
    const initial =
      '# my settings\nmodel = "existing"\n[mcp_servers.other]\ncommand = "other"\n';
    const changed = installCodex(initial, entry);
    expect(changed.text.startsWith(initial)).toBe(true);
    expect(
      uninstallCodex(changed.text, changed.installedEntry).startsWith(initial),
    ).toBe(true);
    expect(() =>
      uninstallCodex(
        changed.text.replace("tool_timeout_sec = 40", "tool_timeout_sec = 80"),
        changed.installedEntry,
      ),
    ).toThrow("changed");
  });
  it("does not overwrite existing ClawdTime names, including quoted TOML", () => {
    expect(() =>
      installClaude('{"mcpServers":{"clawdtime":{"command":"custom"}}}', entry),
    ).toThrow("preserved");
    expect(() =>
      installCodex('[mcp_servers."clawdtime"]\ncommand="custom"', entry),
    ).toThrow("preserved");
  });
  it("never edits sandbox or native approval policy", () => {
    const c = installCodex(
      'approval_policy = "never"\nsandbox_mode = "read-only"\n',
      entry,
    ).text;
    expect(c).toContain(
      'approval_policy = "never"\nsandbox_mode = "read-only"',
    );
    expect(c).not.toContain("danger-full-access");
  });
  it("preserves user-edited skill/config on uninstall", () => {
    const project = canonicalProject(temporary()),
      file = join(temporary(), "connection.json");
    const connection = {
      schemaVersion: 1,
      baseUrl: "http://127.0.0.1:3320",
      token: "private-credential",
      pairing: { id: "fixture" },
      adapter: "codex",
      adapterVersion: "test",
      projectRoot: project,
      hostId: "fixture",
    } as Connection;
    const installed = installConfiguration(
      connection,
      file,
      "/build/cli.js",
      "original skill",
    );
    writeFileSync(installed.installed!.skillPath, "user changed skill");
    expect(() => uninstallConfiguration(installed)).toThrow("preserved");
    expect(readFileSync(installed.installed!.configPath, "utf8")).toContain(
      "mcp_servers.clawdtime",
    );
  });
});
describe("credential and project boundaries", () => {
  it("requires owner-only files and exact canonical project/adapter", () => {
    const root = temporary(),
      project = canonicalProject(temporary()),
      file = join(root, "connection.json");
    secureWrite(file, {
      schemaVersion: 1,
      projectRoot: project,
      adapter: "codex",
      baseUrl: "http://127.0.0.1:3320",
      token: "private-credential",
    });
    expect(loadConnection(file, project, "codex").adapter).toBe("codex");
    expect(() =>
      loadConnection(file, canonicalProject(temporary()), "codex"),
    ).toThrow("different");
    expect(() => loadConnection(file, project, "claude-code")).toThrow(
      "different",
    );
    chmodSync(file, 0o644);
    expect(() => secureRead(file)).toThrow("owner-only");
  });
  it("rejects insecure endpoints and embedded credentials", () => {
    for (const value of [
      "http://example.com",
      "https://user:secret@example.com",
      "https://example.com/path",
      "https://example.com/#token",
    ])
      expect(() => validateOrigin(value)).toThrow();
    expect(validateOrigin("http://127.0.0.1:3320/")).toBe(
      "http://127.0.0.1:3320",
    );
  });
  it("does not blindly retry a lost effect or leak provider error bodies", async () => {
    let count = 0;
    const client = new ClawdTimeClient(
      "http://127.0.0.1:3320",
      "private-credential",
      async () => {
        count++;
        return new Response("private-credential sensitive error", {
          status: 503,
        });
      },
    );
    await expect(
      client.requestAttention({
        taskId: "task",
        idempotencyKey: "stable",
        reason: "review",
        question: "Review?",
      }),
    ).rejects.toThrow("503");
    expect(count).toBe(1);
    await expect(client.doctor()).rejects.not.toThrow("private-credential");
  });
});
