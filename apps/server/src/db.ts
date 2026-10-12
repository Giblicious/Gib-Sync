import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Snapshot } from "@gib-sync/protocol";
import {bootstrapSyncState} from "./operation-state.js";
import {catchUpSyncState} from "./sync-state-catchup.js";

export class Store {
  readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, "gib-sync.db"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec("BEGIN IMMEDIATE");try{
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vaults(id TEXT PRIMARY KEY, name TEXT NOT NULL, wrapped_key TEXT NOT NULL, head_id TEXT, created_at TEXT NOT NULL,
        storage_url TEXT, storage_username TEXT, storage_repo_id TEXT, storage_repo_name TEXT, storage_base_path TEXT, storage_token TEXT, storage_layout TEXT,
        mirror_base_path TEXT, mirror_head_id TEXT, mirror_generation_id TEXT);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id), name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id), parent_id TEXT, device_id TEXT NOT NULL, device_name TEXT NOT NULL, created_at TEXT NOT NULL, message TEXT NOT NULL, manifest_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshots_vault_created ON snapshots(vault_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS blobs(vault_id TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(vault_id, hash));
      CREATE TABLE IF NOT EXISTS blob_integrity(vault_id TEXT NOT NULL,hash TEXT NOT NULL,clear_size INTEGER NOT NULL,cipher_size INTEGER NOT NULL,verified_at TEXT NOT NULL,PRIMARY KEY(vault_id,hash));
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
      CREATE TABLE IF NOT EXISTS mirror_jobs(vault_id TEXT PRIMARY KEY REFERENCES vaults(id),due_at INTEGER NOT NULL,revision INTEGER NOT NULL,
        lease_owner TEXT,lease_until INTEGER,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT);
      CREATE TABLE IF NOT EXISTS request_budgets(scope TEXT NOT NULL,subject TEXT NOT NULL,window_start INTEGER NOT NULL,attempts INTEGER NOT NULL,
        PRIMARY KEY(scope,subject));
      CREATE TABLE IF NOT EXISTS external_revisions(vault_id TEXT NOT NULL REFERENCES vaults(id),path TEXT NOT NULL,revision_id TEXT NOT NULL,
        hash TEXT NOT NULL,size INTEGER NOT NULL,observed_at TEXT NOT NULL,source TEXT NOT NULL,mtime INTEGER NOT NULL DEFAULT 0,causal_order TEXT NOT NULL DEFAULT '',imported_at TEXT,PRIMARY KEY(vault_id,path,revision_id));
      CREATE TABLE IF NOT EXISTS mirror_mutations(id TEXT PRIMARY KEY,vault_id TEXT NOT NULL REFERENCES vaults(id),path TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,expected_hash TEXT,target_hash TEXT,history_baseline TEXT,state TEXT NOT NULL,created_at TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'file');
      CREATE TABLE IF NOT EXISTS external_folder_revisions(vault_id TEXT NOT NULL REFERENCES vaults(id),path TEXT NOT NULL,revision_id TEXT NOT NULL,
        causal_order TEXT NOT NULL,imported_at TEXT,PRIMARY KEY(vault_id,path,revision_id));
      CREATE TABLE IF NOT EXISTS content_uploads(id TEXT PRIMARY KEY,vault_id TEXT NOT NULL REFERENCES vaults(id),device_id TEXT NOT NULL REFERENCES devices(id),
        hash TEXT NOT NULL,size INTEGER NOT NULL,offset INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'receiving',created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,lease_owner TEXT,lease_until INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS content_upload_identity ON content_uploads(vault_id,device_id,hash,size);
      CREATE TABLE IF NOT EXISTS content_upload_chunks(session_id TEXT NOT NULL REFERENCES content_uploads(id),chunk_index INTEGER NOT NULL,
        offset INTEGER NOT NULL,size INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(session_id,chunk_index));
      CREATE TABLE IF NOT EXISTS sync_vault_state(vault_id TEXT PRIMARY KEY REFERENCES vaults(id),snapshot_id TEXT,sequence INTEGER NOT NULL DEFAULT 0,initialized_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_entities(vault_id TEXT NOT NULL REFERENCES vaults(id),entity_id TEXT NOT NULL,entity_kind TEXT NOT NULL,path TEXT NOT NULL,path_key TEXT NOT NULL,
        hash TEXT,size INTEGER NOT NULL,mtime REAL NOT NULL,revision_json TEXT NOT NULL,deleted INTEGER NOT NULL,sequence INTEGER NOT NULL,mutation_ordinal INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(vault_id,entity_id));
      CREATE UNIQUE INDEX IF NOT EXISTS sync_live_path ON sync_entities(vault_id,path_key) WHERE deleted=0;
      CREATE TABLE IF NOT EXISTS sync_batches(vault_id TEXT NOT NULL REFERENCES vaults(id),batch_id TEXT NOT NULL,device_id TEXT NOT NULL,payload_hash TEXT NOT NULL,
        parent_id TEXT,result_snapshot_id TEXT NOT NULL,sequence INTEGER NOT NULL,receipt_json TEXT NOT NULL,source TEXT NOT NULL,created_at TEXT NOT NULL,batch_json TEXT,before_state_json TEXT,PRIMARY KEY(vault_id,batch_id));
      CREATE TABLE IF NOT EXISTS sync_operations(vault_id TEXT NOT NULL,operation_id TEXT NOT NULL,batch_id TEXT NOT NULL,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,target_id TEXT NOT NULL,
        base_revision_id TEXT,payload_json TEXT NOT NULL,result_revision_json TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(vault_id,operation_id),UNIQUE(vault_id,batch_id,ordinal));
      CREATE INDEX IF NOT EXISTS sync_batch_result ON sync_batches(vault_id,result_snapshot_id);
      CREATE INDEX IF NOT EXISTS sync_batch_parent ON sync_batches(vault_id,parent_id,sequence);
      CREATE TABLE IF NOT EXISTS sync_rollouts(vault_id TEXT PRIMARY KEY REFERENCES vaults(id),mode TEXT NOT NULL DEFAULT 'shadow',canary_device_id TEXT,
        comparisons INTEGER NOT NULL DEFAULT 0,mismatches INTEGER NOT NULL DEFAULT 0,canary_batches INTEGER NOT NULL DEFAULT 0,canary_start_sequence INTEGER NOT NULL DEFAULT 0,last_error TEXT,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_shadow_observations(vault_id TEXT NOT NULL,fingerprint TEXT NOT NULL,source TEXT NOT NULL,matched INTEGER NOT NULL,created_at TEXT NOT NULL,legacy_difference INTEGER NOT NULL DEFAULT 0,reason TEXT,evidence_json TEXT,candidate_hash TEXT,reviewed_at TEXT,PRIMARY KEY(vault_id,fingerprint));
      CREATE TABLE IF NOT EXISTS sync_rollout_reviews(id INTEGER PRIMARY KEY,vault_id TEXT NOT NULL REFERENCES vaults(id),kind TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_release_validation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),release_id TEXT NOT NULL,image_digest TEXT NOT NULL,evidence_json TEXT NOT NULL,reviewed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_pending_batches(vault_id TEXT NOT NULL,batch_id TEXT NOT NULL,device_id TEXT NOT NULL,batch_json TEXT NOT NULL,quarantine_id TEXT NOT NULL,PRIMARY KEY(vault_id,batch_id));
      CREATE TABLE IF NOT EXISTS sync_pending_folders(quarantine_id TEXT PRIMARY KEY,vault_id TEXT NOT NULL,folder_entries_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trusted_pairing_claims(id TEXT PRIMARY KEY,pairing_id TEXT NOT NULL REFERENCES pairings(id),vault_id TEXT NOT NULL REFERENCES vaults(id),origin_device_id TEXT NOT NULL REFERENCES devices(id),
        device_name TEXT NOT NULL,confirmation_code TEXT NOT NULL,ticket_hash TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,state TEXT NOT NULL,result_payload TEXT,device_id TEXT);
      CREATE TABLE IF NOT EXISTS conflict_inbox(id TEXT PRIMARY KEY,vault_id TEXT NOT NULL REFERENCES vaults(id),origin_snapshot_id TEXT,record_json TEXT NOT NULL,created_at TEXT NOT NULL,state TEXT NOT NULL,resolution_json TEXT);
      CREATE TABLE IF NOT EXISTS conflict_inbox_events(id TEXT PRIMARY KEY,conflict_id TEXT NOT NULL REFERENCES conflict_inbox(id),vault_id TEXT NOT NULL,kind TEXT NOT NULL,batch_id TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(conflict_id,batch_id));
      CREATE TABLE IF NOT EXISTS conflict_proposals(quarantine_id TEXT PRIMARY KEY,vault_id TEXT NOT NULL REFERENCES vaults(id),records_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS device_config_roots(device_id TEXT PRIMARY KEY REFERENCES devices(id),vault_id TEXT NOT NULL REFERENCES vaults(id),config_root TEXT NOT NULL,declared_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vault_config_aliases(vault_id TEXT NOT NULL REFERENCES vaults(id),config_root TEXT NOT NULL,declared_at TEXT NOT NULL,PRIMARY KEY(vault_id,config_root));
    `);
    const columns = new Set(this.all<{name:string}>("PRAGMA table_info(vaults)").map((row) => row.name));
    const shadowColumns=new Set(this.all<{name:string}>("PRAGMA table_info(sync_shadow_observations)").map(row=>row.name));for(const [name,type] of Object.entries({legacy_difference:"INTEGER NOT NULL DEFAULT 0",reason:"TEXT",evidence_json:"TEXT",candidate_hash:"TEXT",reviewed_at:"TEXT"}))if(!shadowColumns.has(name))this.db.exec(`ALTER TABLE sync_shadow_observations ADD COLUMN ${name} ${type}`);
    if(!this.all<{name:string}>("PRAGMA table_info(sync_batches)").some(row=>row.name==='batch_json'))this.db.exec('ALTER TABLE sync_batches ADD COLUMN batch_json TEXT');
    if(!this.all<{name:string}>("PRAGMA table_info(sync_batches)").some(row=>row.name==='before_state_json'))this.db.exec('ALTER TABLE sync_batches ADD COLUMN before_state_json TEXT');
    for (const [name, type] of Object.entries({storage_url:"TEXT",storage_username:"TEXT",storage_repo_id:"TEXT",storage_repo_name:"TEXT",storage_base_path:"TEXT",storage_token:"TEXT",storage_layout:"TEXT",mirror_base_path:"TEXT",mirror_head_id:"TEXT",mirror_generation_id:"TEXT",retired_at:"TEXT",retired_reason:"TEXT"})) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE vaults ADD COLUMN ${name} ${type}`);
    }
    const pairingColumns=new Set(this.all<{name:string}>("PRAGMA table_info(pairings)").map((row)=>row.name));
    if(!pairingColumns.has("quick_code_hash"))this.db.exec("ALTER TABLE pairings ADD COLUMN quick_code_hash TEXT");
    if(!pairingColumns.has("requires_confirmation"))this.db.exec("ALTER TABLE pairings ADD COLUMN requires_confirmation INTEGER NOT NULL DEFAULT 0");
    if(!pairingColumns.has("qr_expires_at"))this.db.exec("ALTER TABLE pairings ADD COLUMN qr_expires_at TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS pairing_quick_code ON pairings(quick_code_hash)");
    this.db.exec("CREATE INDEX IF NOT EXISTS pairing_secret ON pairings(secret_hash)");
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
    if(!currentVaultColumns.has("mirror_repo_commit"))this.db.exec("ALTER TABLE vaults ADD COLUMN mirror_repo_commit TEXT");
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
    if(!deviceColumns.has("acknowledged_at"))this.db.exec("ALTER TABLE devices ADD COLUMN acknowledged_at TEXT");
    const revisionColumns=new Set(this.all<{name:string}>("PRAGMA table_info(external_revisions)").map((row)=>row.name));
    for(const [name,type] of Object.entries({mtime:"INTEGER NOT NULL DEFAULT 0",causal_order:"TEXT NOT NULL DEFAULT ''"}))if(!revisionColumns.has(name))this.db.exec(`ALTER TABLE external_revisions ADD COLUMN ${name} ${type}`);
    const mutationColumns=new Set(this.all<{name:string}>("PRAGMA table_info(mirror_mutations)").map((row)=>row.name));
    if(!mutationColumns.has("kind"))this.db.exec("ALTER TABLE mirror_mutations ADD COLUMN kind TEXT NOT NULL DEFAULT 'file'");
    if(!this.all<{name:string}>("PRAGMA table_info(sync_entities)").some(column=>column.name==="mutation_ordinal"))this.db.exec("ALTER TABLE sync_entities ADD COLUMN mutation_ordinal INTEGER NOT NULL DEFAULT 0");
    if(!this.all<{name:string}>("PRAGMA table_info(sync_rollouts)").some(column=>column.name==="canary_start_sequence"))this.db.exec("ALTER TABLE sync_rollouts ADD COLUMN canary_start_sequence INTEGER NOT NULL DEFAULT 0");
    bootstrapSyncState(this);catchUpSyncState(this);
    this.db.exec("COMMIT");}catch(error){try{this.db.exec("ROLLBACK");}catch{}this.db.close();throw error;}
  }
  one<T>(sql: string, ...params: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined; }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...params) as T[]; }
  run(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).run(...params); }
  getSnapshot(id: string): Snapshot | null {
    const row = this.one<{manifest_json: string}>("SELECT manifest_json FROM snapshots WHERE id=?", id);
    return row ? JSON.parse(row.manifest_json) as Snapshot : null;
  }
}
