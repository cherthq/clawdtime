import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCli } from "../cli/start.js";
import { providerById } from "../connectors/computer/providers.js";
import { firstRequest, providerOfKey } from "../src/onboard/engine.js";
import {
  assignments,
  shellFiles,
  shellKeys,
} from "../src/onboard/known-keys.js";
import { macPorts } from "../src/onboard/system.js";

// Made-up keys only. Nothing here runs a shell, starts a desktop or opens a window.
const openaiKey = `sk-made-up-${"o".repeat(40)}`;
const anthropicKey = `sk-ant-made-up-${"a".repeat(40)}`;
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
function folder() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-first-")));
  folders.push(path);
  return path;
}

describe("keys in the shell settings", () => {
  const names = ["CLAWDTIME_OPENAI_API_KEY", "OPENAI_API_KEY"];

  it("reads a plain assignment, with or without export and quotes, and the last one wins", () => {
    const text = [
      "# export OPENAI_API_KEY=commented-out",
      `export OPENAI_API_KEY=first`,
      `  export OPENAI_API_KEY="${openaiKey}"  # my key`,
      `CLAWDTIME_OPENAI_API_KEY='single-quoted'`,
      `export PATH="$HOME/bin:$PATH"`,
    ].join("\n");
    expect([...assignments(text, names)]).toEqual([
      ["OPENAI_API_KEY", openaiKey],
      ["CLAWDTIME_OPENAI_API_KEY", "single-quoted"],
    ]);
  });

  it("leaves alone a value that needs a shell: a variable, a command or an escape", () => {
    for (const line of [
      "export OPENAI_API_KEY=$(security find-generic-password -w)",
      'export OPENAI_API_KEY="$SECRET"',
      "export OPENAI_API_KEY=`cat ~/.key`",
      "export OPENAI_API_KEY=a\\ b",
      "export OPENAI_API_KEY=part; echo done",
      "OPENAI_API_KEY=one two",
    ])
      expect(assignments(line, names).size, line).toBe(0);
  });

  it("reads the files of the person's shell, in the order the shell reads them", () => {
    expect(shellFiles("/Users/made-up", { SHELL: "/bin/zsh" })).toEqual([
      "/Users/made-up/.zshenv",
      "/Users/made-up/.zprofile",
      "/Users/made-up/.zshrc",
    ]);
    expect(
      shellFiles("/Users/made-up", { SHELL: "/bin/zsh", ZDOTDIR: "/z" }),
    ).toEqual(["/z/.zshenv", "/z/.zprofile", "/z/.zshrc"]);
    expect(shellFiles("/Users/made-up", { SHELL: "/bin/bash" })).toEqual([
      "/Users/made-up/.bash_profile",
      "/Users/made-up/.bashrc",
      "/Users/made-up/.profile",
    ]);
    // macOS starts with zsh: no SHELL means zsh.
    expect(shellFiles("/Users/made-up", {})[2]).toBe("/Users/made-up/.zshrc");
  });

  it("finds one key for each offered provider, a later file over an earlier one, and an empty value clears it", () => {
    const home = folder();
    writeFileSync(
      join(home, ".zprofile"),
      `export OPENAI_API_KEY=old-one\nexport ANTHROPIC_API_KEY=${anthropicKey}\n`,
    );
    writeFileSync(
      join(home, ".zshrc"),
      `export OPENAI_API_KEY=${openaiKey}\nexport ANTHROPIC_API_KEY=\n`,
    );
    const found = shellKeys(home, { SHELL: "/bin/zsh" });
    expect(found.map((one) => [one.provider.id, one.key, one.source])).toEqual([
      ["openai", openaiKey, join(home, ".zshrc")],
    ]);
  });

  it("reads only regular files of this user that are not too large", () => {
    const home = folder();
    mkdirSync(join(home, ".zshrc"));
    writeFileSync(
      join(home, ".zprofile"),
      `export OPENAI_API_KEY=${openaiKey}\n${"#".repeat(300 * 1024)}\n`,
    );
    expect(shellKeys(home, { SHELL: "/bin/zsh" })).toEqual([]);
    writeFileSync(
      join(home, ".zshenv"),
      `export OPENAI_API_KEY=${openaiKey}\n`,
    );
    chmodSync(join(home, ".zshenv"), 0o600);
    expect(shellKeys(home, { SHELL: "/bin/zsh" })).toHaveLength(1);
  });

  it("the real ports read the shell settings of the home they are given", async () => {
    const home = folder();
    writeFileSync(join(home, ".zshrc"), `export OPENAI_API_KEY=${openaiKey}\n`);
    const ports = macPorts({
      env: { SHELL: "/bin/zsh" },
      home,
      root: home,
      command: { executable: process.execPath, args: [] },
      startDesktop: async () => {},
    });
    const found = await ports.knownKeys!();
    expect(found.map((one) => one.provider.id)).toEqual(["openai"]);
  });
});

describe("the provider of a key", () => {
  it("tells OpenAI and Anthropic keys apart by their start, and nothing else", () => {
    expect(providerOfKey(anthropicKey)).toBe(providerById("anthropic"));
    expect(providerOfKey(openaiKey)).toBe(providerById("openai"));
    expect(providerOfKey("gsk_made_up")).toBeNull();
  });
});

describe("the conversation opens at the end of setup", () => {
  it("the panel offers the same first request as setup, word for word", () => {
    const swift = readFileSync(
      join("mac", "Sources", "TaskPanelCore", "FirstRequest.swift"),
      "utf8",
    );
    for (const on of [true, false])
      expect(swift).toContain(JSON.stringify(firstRequest(on)));
  });

  it("clawdtime start --chat asks the panel to open the chat, and never with --tucked true", async () => {
    const base = folder();
    const home = join(base, "home");
    const root = join(base, "checkout");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(join(root, "mac", ".build", "debug"), { recursive: true });
    writeFileSync(
      join(root, "mac", ".build", "debug", "ClawdTimeTaskPanel"),
      "synthetic executable, never run",
      { mode: 0o700 },
    );
    const calls: string[][] = [];
    const lines: string[] = [];
    const run = (args: string[]) =>
      startCli(args, {
        env: {},
        home,
        root,
        cwd: base,
        print: (line) => lines.push(line),
        desktop: async (desktopArgs) => {
          calls.push(desktopArgs);
        },
      });
    await run(["--chat"]);
    expect(calls[0]).toContain("--chat");
    expect(calls[0]![calls[0]!.indexOf("--chat") + 1]).toBe("true");
    expect(calls[0]).not.toContain("--tucked");
    expect(lines.at(-1)).toBe(
      "The chat is open. Write or talk to ClawdTime. clawdtime computer doctor says what is ready.",
    );
    await expect(run(["--chat", "--tucked", "true"])).rejects.toThrow(
      "Use --chat or --tucked true, not both.",
    );
    await expect(run(["--chat", "yes"])).rejects.toThrow(
      "Use: clawdtime start",
    );
    await expect(run(["--chat", "--chat"])).rejects.toThrow(
      "Use: clawdtime start",
    );
  });

  it("setup starts the desktop with the panel tucked, so the chat opens only at the end", async () => {
    const home = folder();
    const seen: ({ tucked?: boolean } | undefined)[] = [];
    const ports = macPorts({
      env: { CLAWDTIME_CONFIG_HOME: join(home, "config") },
      home,
      root: home,
      command: { executable: process.execPath, args: [] },
      startDesktop: async (_log, options) => {
        seen.push(options);
      },
      openChat: async () => {},
    });
    await ports.desktop.start(() => {});
    expect(seen).toEqual([{ tucked: true }]);
    expect(typeof ports.desktop.openChat).toBe("function");
  });
});
