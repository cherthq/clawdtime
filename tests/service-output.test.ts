import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DesktopRefusal,
  failureLine,
  installServiceOutput,
  redactOutput,
  serviceOutputLimit,
} from "../src/service-output.js";

// Made-up values only.
const secret = `sk-made-up-${"9z".repeat(20)}`;

describe("the masked output of the desktop service", () => {
  it("masks keys, tokens, phone numbers and email addresses, and keeps paths and ports", () => {
    const text = redactOutput(
      [
        `key ${secret}`,
        `{"token":"made-up-${"x1".repeat(20)}","projectKey":"made_up_project_key"}`,
        "Call +1 415 555 0100 or (415) 555-0100 or 415-555-0100.",
        "Write to someone@shop.example.",
        `authorization: Bearer ${"a".repeat(10)}`,
        "Task simulation listening on 127.0.0.1:13326. Operator credential file: /Users/made-up/.local/share/clawdtime/desktop/operator.json",
      ].join("\n"),
    );
    expect(text).not.toContain(secret);
    expect(text).not.toContain("x1x1x1");
    expect(text).not.toContain("made_up_project_key");
    expect(text).not.toContain("555");
    expect(text).not.toContain("someone@");
    expect(text).not.toContain("aaaaaaaaaa");
    expect(text).toContain(
      "Task simulation listening on 127.0.0.1:13326. Operator credential file: /Users/made-up/.local/share/clawdtime/desktop/operator.json",
    );
  });

  it("marks a refusal with its kind and any other error with its message, on one line", () => {
    expect(
      failureLine(new DesktopRefusal("session_open_work", "Open work.\nKept.")),
    ).toBe("desktop-start-refused session_open_work: Open work. Kept.");
    expect(failureLine(Error(`listen EADDRINUSE ${secret}`))).toBe(
      "desktop-service-error: listen EADDRINUSE [redacted]",
    );
  });

  it("masks and bounds every write, and ends the process with the marked line", () => {
    const written: string[] = [];
    const stream = {
      write: ((chunk: string) => {
        written.push(chunk);
        return true;
      }) as NodeJS.WriteStream["write"],
    };
    const events = new EventEmitter();
    const exits: number[] = [];
    expect(installServiceOutput({}, [stream], () => {}, events)).toBe(false);
    expect(
      installServiceOutput(
        { CLAWDTIME_SERVICE_OUTPUT: "log" },
        [stream],
        (code) => exits.push(code),
        events,
      ),
    ).toBe(true);
    stream.write(`the key is ${secret}\n`);
    expect(written).toEqual(["the key is [redacted]\n"]);
    events.emit(
      "uncaughtException",
      new DesktopRefusal("session_revoked", "Revoked."),
    );
    expect(written.at(-1)).toBe(
      "desktop-start-refused session_revoked: Revoked.\n",
    );
    expect(exits).toEqual([1]);
    // A long write is cut, and the whole run stops at its limit.
    stream.write("x".repeat(200 * 1024));
    expect(written.at(-1)).toContain("[the rest of this write is cut]");
    for (let i = 0; i < serviceOutputLimit / (60 * 1024) + 1; i++)
      stream.write("y".repeat(60 * 1024));
    expect(written.at(-1)).toBe(
      "The service output stops here: its log reached its limit.\n",
    );
    stream.write("more\n");
    expect(written.at(-1)).not.toBe("more\n");
  });

  it("a real process that throws as it starts writes the marked line and exits 1", () => {
    const folder = mkdtempSync(join(tmpdir(), "clawdtime-output-"));
    try {
      const script = join(folder, "service.mts");
      writeFileSync(
        script,
        `import ${JSON.stringify(resolve("src/service-output.ts"))};
console.log("starting with ${secret}");
throw new Error("Desktop configuration differs from this workspace. Preserve the existing binding.");
`,
      );
      const result = spawnSync(process.execPath, ["--import", "tsx", script], {
        env: { ...process.env, CLAWDTIME_SERVICE_OUTPUT: "log" },
        encoding: "utf8",
        timeout: 20000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("starting with [redacted]\n");
      expect(result.stderr).toContain(
        "desktop-service-error: Desktop configuration differs from this workspace. Preserve the existing binding.\n",
      );
      expect(result.stdout + result.stderr).not.toContain(secret);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
