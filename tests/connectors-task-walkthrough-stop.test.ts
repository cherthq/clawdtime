import { describe, expect, it, vi } from "vitest";
import { createTaskAudioStopApp } from "../src/control/task-audio-stop.js";

const origin = "http://127.0.0.1:13324",
  host = "127.0.0.1:13324";
describe("walkthrough local Stop boundaries", () => {
  it("requires exact same-origin cookie for sharing Stop without ending call or task", async () => {
    const stop = vi.fn(async () => {}),
      stopSharing = vi.fn(async () => {});
    const app = createTaskAudioStopApp({
      origin,
      stop,
      stopSharing,
      status: () => ({ state: "connected", ended: false }),
    });
    const page = await app.request(origin, { headers: { host } });
    const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
    expect(page.headers.get("set-cookie")).toContain(
      "HttpOnly; SameSite=Strict",
    );
    expect(await page.text()).toContain('id="sharing"');
    const invalid: Record<string, string>[] = [
      { host },
      { host, origin },
      { host, cookie },
      { host, origin: "https://untrusted.invalid", cookie },
      { host: "untrusted.invalid", origin, cookie },
      { host, origin, cookie: cookie + "; " + cookie },
      { host, origin, cookie: "clawdtime_stop=wrong" },
    ];
    for (const headers of invalid)
      expect(
        (
          await app.request(origin + "/stop-sharing", {
            method: "POST",
            headers,
          })
        ).status,
      ).toBe(403);
    expect(stopSharing).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    const response = await app.request(origin + "/stop-sharing", {
      method: "POST",
      headers: { host, origin, cookie: "other=1; " + cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sharingStopped: true,
      voiceEnded: false,
      taskCanceled: false,
    });
    expect(stopSharing).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(
      (
        await app.request(origin + "/status", { headers: { host } })
      ).headers.get("cache-control"),
    ).toBe("no-store");
    expect(
      (
        await app.request(origin + "/stop", {
          method: "POST",
          headers: { host, origin, cookie },
        })
      ).status,
    ).toBe(200);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopSharing).toHaveBeenCalledTimes(1);
  });
  it("does not expose sharing authority in the legacy audio-only control", async () => {
    const stop = vi.fn(async () => {}),
      app = createTaskAudioStopApp({
        origin,
        stop,
        status: () => ({ state: "connected", ended: false }),
      });
    const page = await app.request(origin, { headers: { host } }),
      cookie = page.headers.get("set-cookie")!.split(";")[0]!;
    expect(await page.text()).not.toContain('id="sharing"');
    expect(
      (
        await app.request(origin + "/stop-sharing", {
          method: "POST",
          headers: { host, origin, cookie },
        })
      ).status,
    ).toBe(403);
    expect(stop).not.toHaveBeenCalled();
  });
});
