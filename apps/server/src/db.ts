import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Snapshot } from "@gib-sync/protocol";

export class Store {
  readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, "gib-sync.db"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vaults(id TEXT PRIMARY KEY, name TEXT NOT NULL, wrapped_key TEXT NOT NULL, head_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id), name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id), parent_id TEXT, device_id TEXT NOT NULL, device_name TEXT NOT NULL, created_at TEXT NOT NULL, message TEXT NOT NULL, manifest_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshots_vault_created ON snapshots(vault_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS blobs(vault_id TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(vault_id, hash));
      CREATE TABLE IF NOT EXISTS pairings(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, secret_hash TEXT NOT NULL, created_by_device TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT);
    `);
  }
  one<T>(sql: string, ...params: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined; }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...params) as T[]; }
  run(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).run(...params); }
  getSnapshot(id: string): Snapshot | null {
    const row = this.one<{manifest_json: string}>("SELECT manifest_json FROM snapshots WHERE id=?", id);
    return row ? JSON.parse(row.manifest_json) as Snapshot : null;
  }
}
