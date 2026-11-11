import { describe, it, expect } from "vitest";
import jpeg from "jpeg-js";
import { describeFrameChange } from "../src/control/frame-diagnostics.js";
import { VisionPlanner } from "../src/control/planner.js";
import type { ControlLease } from "../src/contracts.js";

const fixture = (changed = false, comments?: string[]) => {
  const data = Buffer.alloc(64 * 48 * 4, 255);
  if (changed)
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const p = (y * 64 + x) * 4;
        data[p] = 0;
        data[p + 1] = 0;
        data[p + 2] = 0;
      }
  return `data:image/jpeg;base64,${jpeg.encode({ width: 64, height: 48, data, comments }, 85).data.toString("base64")}`;
};

describe("transient frame-change diagnosis", () => {
  it("distinguishes exact encoding-only changes without retaining comments or pixels", () => {
    const result = describeFrameChange(
      fixture(false, ["private metadata A"]),
      fixture(false, ["private metadata B"]),
    );
    expect(result).toEqual({
      kind: "encoding_only",
      width: 64,
      height: 48,
      changedPixels: 0,
      changedTiles: [],
    });
    expect(JSON.stringify(result)).not.toMatch(/private|base64|dataUrl/);
  });
  it("reports a coarse changed tile and bounded count without accepting changed pixels", () => {
    const result = describeFrameChange(fixture(), fixture(true));
    expect(result.kind).toBe("pixels_changed");
    expect(result.changedPixels).toBeGreaterThan(0);
    expect(result.changedTiles).toEqual([0]);
    expect(describeFrameChange("untrusted", fixture()).kind).toBe(
      "unavailable",
    );
  });
});

describe("bounded screen settling", () => {
  it("refuses near-expired leases before waiting or generating", async () => {
    let waits = 0,
      generations = 0;
    const planner = new VisionPlanner(
      {
        frameImage: async () => ({
          dataUrl: fixture(),
          frame: { id: "one", capturedAt: 1000, width: 64, height: 48 },
        }),
      },
      {} as never,
      (async () => {
        generations++;
      }) as never,
      async () => {
        waits++;
      },
      () => 1000,
    );
    await expect(
      planner.plan("Click fixture", { expiresAt: 5000 } as ControlLease),
    ).rejects.toMatchObject({ code: "context_expired" });
    expect({ waits, generations }).toEqual({ waits: 0, generations: 0 });
  });
  it("accounts for time spent waiting on capture before model inference", async () => {
    let now = 1000,
      captures = 0,
      generations = 0;
    const planner = new VisionPlanner(
      {
        frameImage: async () => {
          captures++;
          if (captures === 2) now += 15000;
          return {
            dataUrl: fixture(),
            frame: {
              id: `f${captures}`,
              capturedAt: now,
              width: 64,
              height: 48,
            },
          };
        },
      },
      {} as never,
      (async () => {
        generations++;
      }) as never,
      async (ms) => {
        now += ms;
      },
      () => now,
    );
    await expect(
      planner.plan("Click fixture", { expiresAt: 20000 } as ControlLease),
    ).rejects.toMatchObject({ code: "context_expired" });
    expect(generations).toBe(0);
  });
  it("never returns an action when a model ignores cancellation beyond lease expiry", async () => {
    let now = 1000,
      captures = 0;
    const planner = new VisionPlanner(
      {
        frameImage: async () => ({
          dataUrl: fixture(),
          frame: {
            id: `f${++captures}`,
            capturedAt: now,
            width: 64,
            height: 48,
          },
        }),
      },
      {} as never,
      (async () => {
        now = 21000;
        return {
          output: {
            action: { kind: "click", x: 0.5, y: 0.5 },
            clarification: "",
          },
        };
      }) as never,
      async (ms) => {
        now += ms;
      },
      () => now,
    );
    await expect(
      planner.plan("Click fixture", { expiresAt: 20000 } as ControlLease),
    ).rejects.toMatchObject({ code: "context_expired" });
    expect(captures).toBe(2);
  });
  const model = {} as never,
    lease = { expiresAt: Date.now() + 20_000 } as ControlLease;
  const setup = (images: string[], ids?: string[]) => {
    let frames = 0,
      generations = 0;
    const delays: number[] = [];
    const device = {
      frameImage: async () => {
        const index = frames++;
        return {
          dataUrl: images[index] ?? images.at(-1)!,
          frame: {
            id: ids?.[index] ?? `f${index}`,
            capturedAt: Date.now(),
            width: 64,
            height: 48,
          },
        };
      },
    };
    const generate = (async () => {
      generations++;
      return {
        output: {
          action: { kind: "click", x: 0.5, y: 0.5 },
          clarification: "",
        },
      };
    }) as never;
    return {
      planner: new VisionPlanner(device, model, generate, async (ms) => {
        delays.push(ms);
      }),
      counts: () => ({ frames, generations, delays }),
    };
  };
  it("waits out a one-time transition, then plans once and binds the final fresh frame", async () => {
    const a = fixture(),
      b = fixture(true),
      t = setup([a, b, b, b]);
    expect((await t.planner.plan("Click fixture", lease)).frame.id).toBe("f3");
    expect(t.counts()).toEqual({
      frames: 4,
      generations: 1,
      delays: [2100, 2100],
    });
  });
  it("refuses continuing change before calling the model", async () => {
    const a = fixture(),
      b = fixture(true),
      t = setup([a, b, a]);
    await expect(t.planner.plan("Click fixture", lease)).rejects.toMatchObject({
      code: "screen_changed",
      diagnostics: {
        phase: "settling",
        comparison: { kind: "pixels_changed" },
      },
    });
    expect(t.counts().generations).toBe(0);
  });
  it("does not count a cached frame twice", async () => {
    const a = fixture(),
      t = setup([a, a, a], ["cached", "cached", "cached"]);
    await expect(t.planner.plan("Click fixture", lease)).rejects.toMatchObject({
      code: "screen_changed",
      diagnostics: { phase: "settling" },
    });
    expect(t.counts().generations).toBe(0);
  });
  it("still rejects a change after planning, even with two settled frames", async () => {
    const a = fixture(),
      b = fixture(true),
      t = setup([a, a, b]);
    await expect(t.planner.plan("Click fixture", lease)).rejects.toMatchObject({
      code: "screen_changed",
      diagnostics: {
        phase: "planning",
        comparison: { kind: "pixels_changed" },
      },
    });
    expect(t.counts().generations).toBe(1);
  });
});
