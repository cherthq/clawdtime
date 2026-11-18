import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { taskCli, taskOrigin } from "../cli/tasks.js";

const token = "synthetic-task-token-12345678901234567890";
describe("independent task CLI", () => {
  it("limits credentials to the chosen loopback service", () => {
    expect(taskOrigin("http://127.0.0.1:3320")).toBe("http://127.0.0.1:3320");
    for (const url of [
      "https://remote.invalid",
      "http://user:pass@localhost",
      "http://localhost/api",
      "http://localhost?token=x",
    ])
      expect(() => taskOrigin(url)).toThrow();
  });
  it("saves registration credentials privately without printing them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawdtime-task-cli-"));
    const file = join(directory, "session.json");
    const operatorFile = join(directory, "operator.json");
    const print = vi.fn();
    const request = vi.fn(async () =>
      Response.json({ session: { id: "session-one" }, token }),
    ) as unknown as typeof fetch;
    try {
      await writeFile(operatorFile, JSON.stringify({ token }), { mode: 0o600 });
      await taskCli(
        [
          "register",
          "--pairing-id",
          "pair",
          "--host-id",
          "host",
          "--project",
          directory,
          "--event-id",
          "registration-one",
          "--save",
          file,
          "--operator-file",
          operatorFile,
        ],
        { request, print, env: {} },
      );
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(file, "utf8")).token).toBe(token);
      expect(print.mock.calls.flat().join("")).not.toContain(token);
      const input = (request as any).mock.calls[0][1];
      expect(JSON.parse(input.body)).toMatchObject({
        voice: false,
        eventId: "registration-one",
      });
      await taskCli(
        [
          "create",
          "--goal",
          "Implement fixture",
          "--event-id",
          "task-one",
          "--session-file",
          file,
        ],
        {
          request: async (_url, init) => {
            expect(init?.headers).toMatchObject({
              authorization: `Bearer ${token}`,
            });
            expect(JSON.parse(String(init?.body))).toEqual({
              goal: "Implement fixture",
              eventId: "task-one",
            });
            return Response.json({ id: "task-one" });
          },
          print,
          env: {},
        },
      );
      await expect(
        taskCli(["status", "--id", "task-one", "--session-file", file], {
          env: { CLAWDTIME_TASK_URL: "http://localhost:4444" },
        }),
      ).rejects.toThrow("another task service");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("never automatically retries a lost write response or prints peer error content", async () => {
    const request = vi.fn(async () => {
      throw new Error("private peer error");
    }) as unknown as typeof fetch;
    await expect(
      taskCli(["create", "--goal", "Fixture", "--event-id", "stable"], {
        request,
        env: { CLAWDTIME_TASK_TOKEN: token },
      }),
    ).rejects.toThrow("no retry was attempted");
    expect(request).toHaveBeenCalledTimes(1);
    await expect(
      taskCli(["status", "--id", "task-one"], {
        request: async () => new Response("private error", { status: 403 }),
        env: { CLAWDTIME_TASK_TOKEN: token },
      }),
    ).rejects.toThrow("HTTP 403");
  });
  it("requires explicit command payload and rejects duplicate flags", async () => {
    const request = vi.fn() as unknown as typeof fetch;
    await expect(
      taskCli(["command", "--id", "task-one", "--json", "[]"], {
        request,
        env: { CLAWDTIME_TASK_TOKEN: token },
      }),
    ).rejects.toThrow("command object");
    await expect(
      taskCli(["status", "--id", "a", "--id", "b"], {
        request,
        env: { CLAWDTIME_TASK_TOKEN: token },
      }),
    ).rejects.toThrow("once");
    expect(request).not.toHaveBeenCalled();
  });
});
