import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { taskCli } from "../cli/tasks.js";

const token = "synthetic-task-token-12345678901234567890";
const voiceToken = "synthetic-voice-token-12345678901234567890";
describe("task voice CLI", () => {
  it("starts an exact task/run/revision session and privately saves its separate capability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawdtime-voice-cli-"));
    const voiceFile = join(directory, "voice.json");
    const print = vi.fn();
    try {
      await taskCli(
        [
          "voice-start",
          "--id",
          "task-one",
          "--run-id",
          "run-one",
          "--revision",
          "3",
          "--event-id",
          "opening-one",
          "--save",
          voiceFile,
        ],
        {
          env: { CLAWDTIME_TASK_TOKEN: token },
          print,
          request: async (url, init) => {
            expect(String(url)).toBe(
              "http://127.0.0.1:3320/tasks/task-one/voice-sessions",
            );
            expect(JSON.parse(String(init?.body))).toEqual({
              eventId: "opening-one",
              runId: "run-one",
              expectedRevision: 3,
            });
            return Response.json({
              voice: { id: "voice-one", taskId: "task-one" },
              token: voiceToken,
            });
          },
        },
      );
      expect((await stat(voiceFile)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(voiceFile, "utf8"))).toEqual({
        version: 1,
        taskOrigin: "http://127.0.0.1:3320",
        taskId: "task-one",
        voiceSessionId: "voice-one",
        voiceToken,
      });
      expect(print.mock.calls.flat().join(" ")).not.toContain(voiceToken);
      expect(print.mock.calls.flat().join(" ")).not.toContain(token);
      const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({
          authorization: `Bearer ${voiceToken}`,
        });
        return Response.json({ state: "ended" });
      }) as unknown as typeof fetch;
      await taskCli(["voice-status", "--voice-file", voiceFile], {
        env: {},
        print,
        request,
      });
      await taskCli(
        ["voice-stop", "--voice-file", voiceFile, "--event-id", "stop-one"],
        { env: {}, print, request },
      );
      expect((request as any).mock.calls.map((call: any) => call[0])).toEqual([
        "http://127.0.0.1:3320/tasks/task-one/voice/voice-one/context",
        "http://127.0.0.1:3320/tasks/task-one/voice/voice-one/end",
      ]);
      expect(JSON.parse((request as any).mock.calls[1][1].body)).toEqual({
        eventId: "stop-one",
      });
      expect(
        (request as any).mock.calls.every(
          (call: any) => !call[0].includes("cancel"),
        ),
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("requires voice opt-in and refuses invalid registration flags before sending", async () => {
    const request = vi.fn() as unknown as typeof fetch;
    await expect(
      taskCli(
        [
          "register",
          "--voice",
          "yes",
          "--pairing-id",
          "pair",
          "--host-id",
          "host",
          "--project",
          "/tmp",
          "--event-id",
          "register",
        ],
        { request, env: { CLAWDTIME_TASK_TOKEN: token } },
      ),
    ).rejects.toThrow("true or false");
    expect(request).not.toHaveBeenCalled();
  });
  it("never sends a voice token to a different origin or accepts a task token file as voice authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawdtime-voice-cli-"));
    const file = join(directory, "voice.json");
    const request = vi.fn() as unknown as typeof fetch;
    try {
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          taskOrigin: "http://127.0.0.1:3320",
          taskId: "t",
          voiceSessionId: "v",
          voiceToken,
        }),
        { mode: 0o600 },
      );
      await expect(
        taskCli(["voice-status", "--voice-file", file], {
          request,
          env: { CLAWDTIME_TASK_URL: "http://localhost:9999" },
        }),
      ).rejects.toThrow("another task service");
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          origin: "http://127.0.0.1:3320",
          sessionId: "s",
          token,
        }),
      );
      await expect(
        taskCli(["voice-status", "--voice-file", file], { request, env: {} }),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
