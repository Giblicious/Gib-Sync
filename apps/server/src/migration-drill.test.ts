import {DatabaseSync} from "node:sqlite";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,it,expect} from "vitest";
import {rehearseMigration} from "./migration-drill.js";
describe("automatic legacy migration",()=>{
  it("preserves data, device tokens, accepted heads and immutable history",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"gib-legacy-migration-test-")),path=join(dir,"gib-sync.db"),db=new DatabaseSync(path);
    try{
      db.exec(`CREATE TABLE vaults(id TEXT PRIMARY KEY,name TEXT,wrapped_key TEXT,head_id TEXT,created_at TEXT);
        CREATE TABLE devices(id TEXT PRIMARY KEY,vault_id TEXT,name TEXT,token_hash TEXT,created_at TEXT,last_seen_at TEXT,revoked_at TEXT);
        CREATE TABLE snapshots(id TEXT PRIMARY KEY,vault_id TEXT,parent_id TEXT,device_id TEXT,device_name TEXT,created_at TEXT,message TEXT,manifest_json TEXT);
        CREATE TABLE blobs(vault_id TEXT,hash TEXT,size INTEGER,created_at TEXT,PRIMARY KEY(vault_id,hash));
        INSERT INTO vaults VALUES('v','Vault','wrapped-key','s','now');
        INSERT INTO devices VALUES('d','v','Device','token-hash','now','now',NULL);
        INSERT INTO snapshots VALUES('s','v',NULL,'d','Device','now','test','{"entries":[]}');`);
      expect(await rehearseMigration(path)).toEqual({preserved:true,integrity:true,snapshots:1});
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='mirror_jobs'").get()).toBeUndefined();
    }finally{db.close();await rm(dir,{recursive:true,force:true});}
  });
});
