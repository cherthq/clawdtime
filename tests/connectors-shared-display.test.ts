import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedDisplay } from "../connectors/shared/shared-display.js";
import type { CaptureChild } from "../src/control/proactive-views.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.useRealTimers();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "shared-display-"));
  let expiresAt = Date.now() + 30000;
  const inspect = vi.fn(async () => ({ ok: true, expiresAt }));
  const child = {
    process: { pid: 123 } as CaptureChild["process"],
    capture: vi.fn(async () => ({
      bytes: new Uint8Array(16),
      width: 2,
      height: 2,
      capturedAt: Date.now(),
    })),
    close: vi.fn(async () => true),
  };
  const capture = vi.fn(() => child);
  const display = new SharedDisplay({
    directory,
    binary: "/fake/capture",
    target: {
      displayId: 1,
      displayUUID: "00000000-0000-0000-0000-000000000001",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    },
    inspect,
    capture,
  });
  cleanup.push(async () => {
    await display.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    display,
    child,
    capture,
    inspect,
    directory,
    expire: () => {
      expiresAt = Date.now() - 1;
    },
  };
}
it("captures only while the local call lease is live and independently closes on expiry", async () => {
  vi.useFakeTimers();
  const f = fixture();
  expect((await f.display.frame("call")).frame?.width).toBe(2);
  f.expire();
  await vi.advanceTimersByTimeAsync(500);
  expect(f.child.close).toHaveBeenCalledOnce();
  expect(existsSync(join(f.directory, "owner.json"))).toBe(false);
  expect((await f.display.frame("call")).ok).toBe(false);
  expect(f.capture).toHaveBeenCalledOnce();
});
it("hide fences a frame already being captured and never returns its pixels", async () => {
  const f = fixture();
  let finish!: (v: Awaited<ReturnType<typeof f.child.capture>>) => void;
  f.child.capture.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.display.frame("call");
  await vi.waitFor(() => expect(f.child.capture).toHaveBeenCalledOnce());
  await f.display.hide();
  finish({
    bytes: new Uint8Array(16),
    width: 2,
    height: 2,
    capturedAt: Date.now(),
  });
  expect((await pending).frame).toBeUndefined();
});
it("retains an uncertain capture owner and refuses another process", async () => {
  const f = fixture();
  await f.display.frame("call");
  f.child.close.mockResolvedValue(false);
  await Promise.all([f.display.hide(), f.display.hide()]);
  expect(f.child.close).toHaveBeenCalledOnce();
  expect(existsSync(join(f.directory, "owner.json"))).toBe(true);
  expect((await f.display.frame("another")).ok).toBe(false);
  expect(f.capture).toHaveBeenCalledOnce();
});
it("discards stale or post-expiry frames and closes the child", async () => {
  const f = fixture();
  f.child.capture.mockImplementation(async () => {
    f.expire();
    return {
      bytes: new Uint8Array(16),
      width: 2,
      height: 2,
      capturedAt: Date.now(),
    };
  });
  expect((await f.display.frame("call")).ok).toBe(false);
  expect(f.child.close).toHaveBeenCalledOnce();
});

it("expires capture even if the local lease inspection stops answering", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.display.frame("call");
  f.inspect.mockImplementation(() => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(31000);
  expect(f.child.close).toHaveBeenCalledOnce();
  expect(existsSync(join(f.directory, "owner.json"))).toBe(false);
});
