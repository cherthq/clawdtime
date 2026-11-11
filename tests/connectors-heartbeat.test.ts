import { afterEach, expect, it, vi } from "vitest";
import { startHeartbeat } from "../connectors/shared/heartbeat.js";
afterEach(() => vi.useRealTimers());
it("keeps yielded sessions alive every five seconds and stops after client closure", async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => ({}));
  const stop = startHeartbeat(send);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_001);
  expect(send).toHaveBeenCalledTimes(3);
  stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(send).toHaveBeenCalledTimes(3);
});
it("does not overlap slow heartbeats or revive/re-register after failure", async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const send = vi.fn(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  const stop = startHeartbeat(send);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(send).toHaveBeenCalledTimes(1);
  reject(new Error("Session stopped"));
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(send).toHaveBeenCalledTimes(2);
  stop();
  reject(new Error("Session stopped"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(send).toHaveBeenCalledTimes(2);
});
