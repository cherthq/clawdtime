import { describe, it, expect, vi } from "vitest";
import { createTaskAudioStopApp } from "../src/control/task-audio-stop.js";
describe("local handset Stop", () => {
  it("requires exact origin and its cookie while allowing other local cookies", async () => {
    const stop = vi.fn(async () => {}),
      origin = "http://127.0.0.1:13324",
      host = "127.0.0.1:13324";
    const app = createTaskAudioStopApp({
      origin,
      stop,
      status: () => ({ state: "connected", ended: false }),
    });
    const page = await app.request(origin, { headers: { host } });
    const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
    const rejectedHeaders: Record<string, string>[] = [
      { host },
      { host, origin: "https://untrusted.example", cookie },
      { host, origin, cookie: cookie + "; " + cookie },
    ];
    for (const headers of rejectedHeaders)
      expect(
        (await app.request(origin + "/stop", { method: "POST", headers }))
          .status,
      ).toBe(403);
    expect(stop).not.toHaveBeenCalled();
    expect(
      (
        await app.request(origin + "/stop", {
          method: "POST",
          headers: { host, origin, cookie: "unrelated=1; " + cookie },
        })
      ).status,
    ).toBe(200);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
