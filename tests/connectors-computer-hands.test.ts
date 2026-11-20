import { describe, expect, it } from "vitest";
import {
  HandsTimeout,
  PanelHands,
} from "../connectors/computer/panel-hands.js";
import { observation } from "./connectors-computer-fixture.js";

const click = {
  kind: "click",
  x: 10,
  y: 20,
  button: "left",
  count: 1,
} as const;

describe("the hands that the panel serves", () => {
  it("holds one command, serves it again until its result arrives, and then resolves", async () => {
    const hands = new PanelHands({ first: 1 });
    expect(hands.next(0)).toBeNull();
    const running = hands.run(click, "Click Save");
    const served = hands.next(0);
    expect(served).toEqual({ seq: 1, command: click, label: "Click Save" });
    // The panel asks again before it posts: the same command, the same number.
    expect(hands.next(0)).toEqual(served);
    // The panel has run number 1: it is not served again.
    expect(hands.next(1)).toBeNull();
    expect(hands.result({ seq: 1, ok: true })).toBe(true);
    expect(await running).toEqual({ seq: 1, ok: true });
    expect(hands.next(0)).toBeNull();
    // A second result for the same number finds nothing that waits.
    expect(hands.result({ seq: 1, ok: true })).toBe(false);
  });

  it("gives each command the next number", async () => {
    const hands = new PanelHands({ first: 41 });
    const first = hands.run({ kind: "wait", ms: 0 }, "Wait");
    expect(hands.next(0)?.seq).toBe(41);
    hands.result({ seq: 41, ok: true });
    await first;
    const second = hands.run(
      { kind: "observe", image: true, elements: true },
      "Look at the screen",
    );
    expect(hands.next(41)?.seq).toBe(42);
    const seen = observation();
    hands.result({ seq: 42, ok: true, observation: seen });
    expect((await second).observation).toEqual(seen);
  });

  it("starts above every number of an earlier run of the service", () => {
    const before = Date.now();
    const hands = new PanelHands();
    void hands.run(click, "Click").catch(() => {});
    expect(hands.next(0)!.seq).toBeGreaterThanOrEqual(before);
    hands.withdraw();
  });

  it("ignores a result for another number and refuses a result of another shape", async () => {
    const hands = new PanelHands({ first: 5 });
    const running = hands.run(click, "Click");
    expect(hands.result({ seq: 4, ok: true })).toBe(false);
    expect(hands.result({ seq: 6, ok: true })).toBe(false);
    for (const raw of [
      null,
      {},
      { seq: 5 },
      { seq: 5, ok: "yes" },
      { seq: 5, ok: false, error: "exploded" },
      { seq: 5, ok: true, extra: 1 },
      { seq: 0, ok: true },
    ])
      expect(() => hands.result(raw)).toThrow();
    // The command still waits for its real result.
    expect(hands.next(0)?.seq).toBe(5);
    hands.result({ seq: 5, ok: false, error: "not_found" });
    expect(await running).toEqual({ seq: 5, ok: false, error: "not_found" });
  });

  it("rejects when no result comes in time, and says whether the panel had fetched the command", async () => {
    const hands = new PanelHands({ first: 1, timeoutMs: 20 });
    // Never fetched: the command certainly did not run.
    const unfetched = await hands.run(click, "Click").catch((error) => error);
    expect(unfetched).toBeInstanceOf(HandsTimeout);
    expect((unfetched as HandsTimeout).delivered).toBe(false);
    expect(hands.next(0)).toBeNull();
    // Fetched, and then silence: it may have run.
    const running = hands.run(click, "Click").catch((error) => error);
    expect(hands.next(0)?.seq).toBe(2);
    const fetched = await running;
    expect(fetched).toBeInstanceOf(HandsTimeout);
    expect((fetched as HandsTimeout).delivered).toBe(true);
    // The late result finds nothing, and the command is not served again.
    expect(hands.result({ seq: 2, ok: true })).toBe(false);
    expect(hands.next(0)).toBeNull();
  });

  it("gives a wait command its own time on top of the limit", async () => {
    const hands = new PanelHands({ first: 1, timeoutMs: 20 });
    const started = Date.now();
    const result = await hands
      .run({ kind: "wait", ms: 60 }, "Wait")
      .catch((error) => error);
    expect(result).toBeInstanceOf(HandsTimeout);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it("gives a long text more time: keys go out one after the other", async () => {
    const hands = new PanelHands({ first: 1, timeoutMs: 20 });
    const started = Date.now();
    // 4 characters at 25 ms each, on top of the limit of 20 ms.
    const result = await hands
      .run({ kind: "type", text: "abcd" }, "Type")
      .catch((error) => error);
    expect(result).toBeInstanceOf(HandsTimeout);
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });

  it("takes back a command that the panel has not fetched, and only that", async () => {
    const hands = new PanelHands({ first: 1 });
    const unfetched = hands.run(click, "Click");
    expect(hands.withdraw()).toBe(true);
    expect(await unfetched).toEqual({
      seq: 1,
      ok: false,
      error: "stopped_by_person",
    });
    expect(hands.next(0)).toBeNull();
    const fetched = hands.run(click, "Click");
    expect(hands.next(0)?.seq).toBe(2);
    // The panel may be in the middle of it: its result is still awaited.
    expect(hands.withdraw()).toBe(false);
    hands.result({ seq: 2, ok: true });
    expect(await fetched).toEqual({ seq: 2, ok: true });
    expect(hands.withdraw()).toBe(false);
  });

  it("does not take a second command while one waits, or a command of another shape", async () => {
    const hands = new PanelHands({ first: 1 });
    const first = hands.run(click, "Click");
    expect(await hands.run(click, "Click again")).toMatchObject({
      ok: false,
      error: "failed",
    });
    expect(
      await hands.run({ kind: "type", text: "x".repeat(4001) }, "Type"),
    ).toMatchObject({ ok: false, error: "refused" });
    // Only the first one is ever served.
    expect(hands.next(0)).toMatchObject({ seq: 1, label: "Click" });
    hands.result({ seq: 1, ok: true });
    await first;
    expect(hands.next(0)).toBeNull();
  });

  it("cuts a long label to what the banner shows", async () => {
    const hands = new PanelHands({ first: 1 });
    void hands.run(click, "x".repeat(500)).catch(() => {});
    expect(hands.next(0)!.label).toHaveLength(120);
    hands.withdraw();
  });
});
