import { describe, expect, it } from "vitest";
import { PreviewCommandQueue } from "../scripts/preview-command-queue.js";

describe("local presentation command interruption", () => {
  it("invalidates queued effects immediately while preserving an ownership release", async () => {
    const queue = new PreviewCommandQueue();
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const events: string[] = [];
    const active = queue.run(async () => {
      events.push("submitted");
      await waiting;
    }, true);
    await Promise.resolve();
    const queued = queue.run(async () => {
      events.push("must not execute");
    }, true);
    const rejected = expect(queued).rejects.toThrow(
      "canceled by presentation interruption",
    );
    const release = queue.run(
      async () => {
        events.push("release");
      },
      true,
      true,
    );
    const interruption = queue.interrupt(async () => {
      events.push("interrupt");
    });
    expect(events).toEqual(["submitted", "interrupt"]);
    finish();
    await Promise.all([
      active,
      rejected,
      release,
      interruption,
      queue.settled(),
    ]);
    expect(events).toEqual(["submitted", "interrupt", "release"]);
    await queue.run(async () => {
      events.push("fresh intent");
    }, true);
    expect(events.at(-1)).toBe("fresh intent");
  });
});
