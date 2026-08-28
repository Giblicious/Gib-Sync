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
      CREATE TABLE IF NOT EXISTS vaults(id TEXT PRIMARY KEY, name TEXT NOT NULL, wrapped_key TEXT NOT NULL, head_id TEXT, created_at TEXT NOT NULL,
        storage_url TEXT, storage_username TEXT, storage_repo_id TEXT, storage_repo_name TEXT, storage_base_path TEXT, storage_token TEXT, storage_layout TEXT,
        mirror_base_path TEXT, mirror_head_id TEXT, mirror_generation_id TEXT);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id), name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id), parent_id TEXT, device_id TEXT NOT NULL, device_name TEXT NOT NULL, created_at TEXT NOT NULL, message TEXT NOT NULL, manifest_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshots_vault_created ON snapshots(vault_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS blobs(vault_id TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(vault_id, hash));
      CREATE TABLE IF NOT EXISTS pairings(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, secret_hash TEXT NOT NULL, created_by_device TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT);
      CREATE TABLE IF NOT EXISTS mirror_entries(vault_id TEXT NOT NULL REFERENCES vaults(id), path TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(vault_id,path));
      CREATE TABLE IF NOT EXISTS external_absences(vault_id TEXT NOT NULL REFERENCES vaults(id), path TEXT NOT NULL, hash TEXT NOT NULL, mirror_head_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, observations INTEGER NOT NULL, PRIMARY KEY(vault_id,path));
      CREATE TABLE IF NOT EXISTS quarantines(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id), proposal_hash TEXT NOT NULL, source TEXT NOT NULL,
        device_id TEXT NOT NULL, device_name TEXT NOT NULL, parent_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL,
        message TEXT NOT NULL, manifest_json TEXT NOT NULL, assessment_json TEXT NOT NULL, changes_json TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT);
      CREATE INDEX IF NOT EXISTS quarantines_vault_status ON quarantines(vault_id,status,created_at DESC);
      CREATE TABLE IF NOT EXISTS snapshot_bookmarks(vault_id TEXT NOT NULL REFERENCES vaults(id), snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
        label TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, PRIMARY KEY(vault_id,snapshot_id));
      CREATE TABLE IF NOT EXISTS health_events(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id), code TEXT NOT NULL, level TEXT NOT NULL,
        message TEXT NOT NULL, created_at TEXT NOT NULL, cleared_at TEXT);
      CREATE TABLE IF NOT EXISTS server_containment(singleton INTEGER PRIMARY KEY CHECK(singleton=1), allowed_vault_id TEXT NOT NULL REFERENCES vaults(id),
        reason TEXT NOT NULL, enabled_at TEXT NOT NULL, disabled_at TEXT);
      CREATE TABLE IF NOT EXISTS server_containment_events(id TEXT PRIMARY KEY, action TEXT NOT NULL, allowed_vault_id TEXT,
        reason TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    const columns = new Set(this.all<{name:string}>("PRAGMA table_info(vaults)").map((row) => row.name));
    for (const [name, type] of Object.entries({storage_url:"TEXT",storage_username:"TEXT",storage_repo_id:"TEXT",storage_repo_name:"TEXT",storage_base_path:"TEXT",storage_token:"TEXT",storage_layout:"TEXT",mirror_base_path:"TEXT",mirror_head_id:"TEXT",mirror_generation_id:"TEXT",retired_at:"TEXT",retired_reason:"TEXT"})) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE vaults ADD COLUMN ${name} ${type}`);
    }
    const pairingColumns=new Set(this.all<{name:string}>("PRAGMA table_info(pairings)").map((row)=>row.name));
    if(!pairingColumns.has("quick_code_hash"))this.db.exec("ALTER TABLE pairings ADD COLUMN quick_code_hash TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS pairing_quick_code ON pairings(quick_code_hash)");
    this.db.exec("CREATE INDEX IF NOT EXISTS vault_storage_location ON vaults(storage_url,storage_repo_id,storage_base_path)");
    const mirrorColumns=new Set(this.all<{name:string}>("PRAGMA table_info(mirror_entries)").map((row)=>row.name));
    if(!mirrorColumns.has("storage_id"))this.db.exec("ALTER TABLE mirror_entries ADD COLUMN storage_id TEXT");
    if(!mirrorColumns.has("storage_mtime"))this.db.exec("ALTER TABLE mirror_entries ADD COLUMN storage_mtime INTEGER");
    const quarantineColumns=new Set(this.all<{name:string}>("PRAGMA table_info(quarantines)").map((row)=>row.name));
    if(!quarantineColumns.has("resolution_kind"))this.db.exec("ALTER TABLE quarantines ADD COLUMN resolution_kind TEXT");
    if(!quarantineColumns.has("resolution_context_json"))this.db.exec("ALTER TABLE quarantines ADD COLUMN resolution_context_json TEXT");
    const currentVaultColumns=new Set(this.all<{name:string}>("PRAGMA table_info(vaults)").map((row)=>row.name));
    if(!currentVaultColumns.has("external_scan_at"))this.db.exec("ALTER TABLE vaults ADD COLUMN external_scan_at TEXT");
    if(!currentVaultColumns.has("external_import_at"))this.db.exec("ALTER TABLE vaults ADD COLUMN external_import_at TEXT");
    if(!currentVaultColumns.has("external_error"))this.db.exec("ALTER TABLE vaults ADD COLUMN external_error TEXT");
    if(!currentVaultColumns.has("safeguard_policy"))this.db.exec("ALTER TABLE vaults ADD COLUMN safeguard_policy TEXT");
    if(!currentVaultColumns.has("write_locked_at"))this.db.exec("ALTER TABLE vaults ADD COLUMN write_locked_at TEXT");
    if(!currentVaultColumns.has("write_locked_by"))this.db.exec("ALTER TABLE vaults ADD COLUMN write_locked_by TEXT");
    if(!currentVaultColumns.has("trusted_until"))this.db.exec("ALTER TABLE vaults ADD COLUMN trusted_until TEXT");
    if(!currentVaultColumns.has("trusted_device_id"))this.db.exec("ALTER TABLE vaults ADD COLUMN trusted_device_id TEXT");
    const deviceColumns=new Set(this.all<{name:string}>("PRAGMA table_info(devices)").map((row)=>row.name));
    if(!deviceColumns.has("initial_sync_complete")){this.db.exec("ALTER TABLE devices ADD COLUMN initial_sync_complete INTEGER NOT NULL DEFAULT 0");this.db.exec("UPDATE devices SET initial_sync_complete=1");}
    if(!deviceColumns.has("initial_sync_head_id"))this.db.exec("ALTER TABLE devices ADD COLUMN initial_sync_head_id TEXT");
    if(!deviceColumns.has("clock_skew_ms"))this.db.exec("ALTER TABLE devices ADD COLUMN clock_skew_ms INTEGER NOT NULL DEFAULT 0");
    if(!deviceColumns.has("client_version"))this.db.exec("ALTER TABLE devices ADD COLUMN client_version TEXT");
    if(!deviceColumns.has("client_protocol"))this.db.exec("ALTER TABLE devices ADD COLUMN client_protocol INTEGER");
  }
  one<T>(sql: string, ...params: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined; }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...params) as T[]; }
  run(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).run(...params); }
  getSnapshot(id: string): Snapshot | null {
    const row = this.one<{manifest_json: string}>("SELECT manifest_json FROM snapshots WHERE id=?", id);
    return row ? JSON.parse(row.manifest_json) as Snapshot : null;
  }
}
