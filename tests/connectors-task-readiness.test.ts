import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { taskCli } from "../cli/tasks.js";

const sessionToken = "synthetic-session-token-12345678901234567890";
const operatorToken = "synthetic-operator-token-12345678901234567890";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "clawdtime-readiness-"));
  const sessionFile = join(directory, "session.json");
  const operatorFile = join(directory, "operator.json");
  await writeFile(
    sessionFile,
    JSON.stringify({
      version: 1,
      origin: "http://127.0.0.1:3320",
      sessionId: "session-one",
      token: sessionToken,
    }),
    { mode: 0o600 },
  );
  await writeFile(operatorFile, JSON.stringify({ token: operatorToken }), {
    mode: 0o600,
  });
  return {
    directory,
    sessionFile,
    operatorFile,
    args: [
      "reauthorize",
      "--session-file",
      sessionFile,
      "--operator-file",
      operatorFile,
      "--pairing-id",
      "pair",
      "--host-id",
      "host",
      "--project",
      directory,
      "--voice",
      "true",
      "--event-id",
      "renew-once",
    ],
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

describe("task readiness and explicit reauthorization CLI", () => {
  it("reads expired-session readiness without renewing or dispatching", async () => {
    const f = await fixture();
    const print = vi.fn();
    const result = {
      taskId: "task-one",
      sessionId: "session-one",
      sessionExpiresAt: 1,
      sessionActive: false,
      taskState: "review_ready",
      runId: "run-three",
      revision: 9,
      verificationState: "passed",
      unendedVoices: [],
      blockedReasons: ["session_expired"],
      handsetDispatch: false,
      permissions: { screen: false, presentation: false, control: false },
    };
    const request = vi.fn(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:3320/tasks/task-one/readiness");
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
      });
      expect(init?.body).toBeUndefined();
      return Response.json(result);
    }) as unknown as typeof fetch;
    try {
      await taskCli(
        ["readiness", "--id", "task-one", "--session-file", f.sessionFile],
        { request, print, env: {} },
      );
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.parse(print.mock.calls[0]![0])).toEqual(result);
    } finally {
      await f.cleanup();
    }
  });

  it("uses only the explicit operator credential and preserves the existing session file", async () => {
    const f = await fixture();
    const print = vi.fn();
    const before = await readFile(f.sessionFile, "utf8");
    const request = vi.fn(async (url, init) => {
      expect(url).toBe(
        "http://127.0.0.1:3320/sessions/session-one/reauthorize",
      );
      expect(init).toMatchObject({
        method: "POST",
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        eventId: "renew-once",
        pairingId: "pair",
        hostId: "host",
        projectRoot: f.directory,
        voice: true,
      });
      return Response.json({
        session: { id: "session-one", expiresAt: 100000 },
      });
    }) as unknown as typeof fetch;
    try {
      await taskCli(f.args, {
        request,
        print,
        env: { CLAWDTIME_TASK_TOKEN: sessionToken },
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(await readFile(f.sessionFile, "utf8")).toBe(before);
      expect(print.mock.calls.flat().join("")).not.toContain(sessionToken);
      expect(print.mock.calls.flat().join("")).not.toContain(operatorToken);
    } finally {
      await f.cleanup();
    }
  });

  it("requires both protected files and explicit voice scope before sending", async () => {
    const f = await fixture();
    const request = vi.fn() as unknown as typeof fetch;
    try {
      for (const flag of ["--session-file", "--operator-file", "--voice"]) {
        const args = [...f.args];
        args.splice(args.indexOf(flag), 2);
        await expect(
          taskCli(args, {
            request,
            env: { CLAWDTIME_TASK_TOKEN: operatorToken },
          }),
        ).rejects.toThrow(`Missing ${flag}`);
      }
      await expect(
        taskCli(f.args, {
          request,
          env: { CLAWDTIME_TASK_URL: "http://localhost:9999" },
        }),
      ).rejects.toThrow("another task service");
      expect(request).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it("never retries uncertain renewal and refuses credential-bearing output", async () => {
    const f = await fixture();
    const print = vi.fn();
    const request = vi.fn(async () => {
      throw Error("private failure");
    }) as unknown as typeof fetch;
    try {
      await expect(
        taskCli(f.args, { request, print, env: {} }),
      ).rejects.toThrow("no retry was attempted");
      expect(request).toHaveBeenCalledTimes(1);
      await expect(
        taskCli(f.args, {
          request: async () => Response.json({ token: operatorToken }),
          print,
          env: {},
        }),
      ).rejects.toThrow("Unexpected credential");
      expect(print).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
});
