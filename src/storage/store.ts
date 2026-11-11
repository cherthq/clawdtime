// Transaction/receipt patterns extracted from Apple Teams src/store.ts at be47b11.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { EffectReceipt } from "../contracts.js";

export class Store {
  readonly db: DatabaseSync;
  private depth = 0;
  constructor(path = ":memory:") {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS operational_state(key TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));
      CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
      PRAGMA user_version=1;`);
    this.transaction(() => {
      for (const effect of this.effects("running"))
        this.putEffect({ ...effect, state: "unknown" });
    });
  }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }
  get<T = Record<string, unknown>>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT body FROM entities WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? (JSON.parse(String(row.body)) as T) : undefined;
  }
  put<T extends { id: string }>(kind: string, value: T): T {
    this.db
      .prepare(
        "INSERT INTO entities(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, value.id, JSON.stringify(value));
    return value;
  }
  all<T = Record<string, unknown>>(kind: string): T[] {
    return this.db
      .prepare("SELECT body FROM entities WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((r) => JSON.parse(String(r.body)) as T);
  }
  state<T>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT body FROM operational_state WHERE key=?")
      .get(key);
    return row ? (JSON.parse(String(row.body)) as T) : undefined;
  }
  saveState(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO operational_state(key,body) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body",
      )
      .run(key, JSON.stringify(value));
  }
  effect(id: string): EffectReceipt | undefined {
    const row = this.db.prepare("SELECT body FROM effects WHERE id=?").get(id);
    return row ? (JSON.parse(String(row.body)) as EffectReceipt) : undefined;
  }
  putEffect(effect: EffectReceipt) {
    this.db
      .prepare(
        "INSERT INTO effects(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(effect.id, JSON.stringify(effect));
    return effect;
  }
  effects(state?: EffectReceipt["state"]): EffectReceipt[] {
    return this.db
      .prepare("SELECT body FROM effects ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(String(r.body)) as EffectReceipt)
      .filter((e) => !state || e.state === state);
  }
  event<T>(id: string): { fingerprint: string; result: T } | undefined {
    const r = this.db
      .prepare("SELECT fingerprint,result FROM events WHERE id=?")
      .get(id);
    return r
      ? {
          fingerprint: String(r.fingerprint),
          result: JSON.parse(String(r.result)) as T,
        }
      : undefined;
  }
  recordEvent(id: string, fingerprint: string, result: unknown) {
    this.db
      .prepare("INSERT INTO events(id,fingerprint,result) VALUES(?,?,?)")
      .run(id, fingerprint, JSON.stringify(result));
  }
  query(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).all(...args);
  }
  close() {
    this.db.close();
  }
}
