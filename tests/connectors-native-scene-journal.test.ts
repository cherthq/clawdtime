import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileNativeSceneJournal } from "../connectors/shared/native-scene-journal.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function location() {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-native-journal-"));
  roots.push(root);
  return join(root, "operations.json");
}
describe("durable local native operation journal", () => {
  it("preserves uncertain receipts across orderly reopen without another dispatch", () => {
    const path = location();
    const journal = new FileNativeSceneJournal(path);
    expect(journal.read()).toEqual([]);
    journal.write([{ operationId: "synthetic-op", state: "uncertain" }]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    journal.close();
    const reopened = new FileNativeSceneJournal(path);
    expect(reopened.read()).toEqual([
      { operationId: "synthetic-op", state: "uncertain" },
    ]);
    reopened.close();
  });
  it("refuses concurrent or stale lock ownership without deleting the lock", () => {
    const path = location();
    const journal = new FileNativeSceneJournal(path);
    expect(() => new FileNativeSceneJournal(path)).toThrow();
    journal.close();
    writeFileSync(`${path}.lock`, "999999", { mode: 0o600 });
    expect(() => new FileNativeSceneJournal(path)).toThrow();
    expect(readFileSync(`${path}.lock`, "utf8")).toBe("999999");
  });
  it("refuses broad directory permissions and oversized writes", () => {
    const path = location();
    chmodSync(join(path, ".."), 0o755);
    expect(() => new FileNativeSceneJournal(path)).toThrow("owner-only");
    chmodSync(join(path, ".."), 0o700);
    const journal = new FileNativeSceneJournal(path);
    expect(() =>
      journal.write(Array.from({ length: 257 }, () => ({}))),
    ).toThrow();
    expect(() => journal.write(["x".repeat(1024 * 1024)])).toThrow(
      "byte bound",
    );
    journal.close();
  });
  it("preserves malformed original data and never uses a closed journal", () => {
    const path = location();
    writeFileSync(path, "malformed", { mode: 0o600 });
    const journal = new FileNativeSceneJournal(path);
    expect(() => journal.read()).toThrow();
    expect(readFileSync(path, "utf8")).toBe("malformed");
    journal.close();
    expect(() => journal.write([])).toThrow("closed");
  });
});
