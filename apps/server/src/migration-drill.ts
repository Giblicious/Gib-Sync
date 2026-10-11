import {backup,DatabaseSync} from "node:sqlite";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {Store} from "./db.js";

type OriginalTable={name:string;columns:string[]};
function tables(db:DatabaseSync):OriginalTable[]{
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[])
    .map(({name})=>({name,columns:(db.prepare(`PRAGMA table_info("${name.replaceAll('"','""')}")`).all() as {name:string}[]).map(column=>column.name)}));
}
function fingerprint(db:DatabaseSync,originalTables:OriginalTable[]):string{
  const state={
    vaults:db.prepare("SELECT id,name,wrapped_key,head_id,created_at FROM vaults ORDER BY id").all(),
    devices:db.prepare("SELECT id,vault_id,name,token_hash,created_at,last_seen_at,revoked_at FROM devices ORDER BY id").all(),
    snapshots:db.prepare("SELECT id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json FROM snapshots ORDER BY id").all(),
    blobs:db.prepare("SELECT vault_id,hash,size,created_at FROM blobs ORDER BY vault_id,hash").all()
  };
  const allOriginalData=originalTables.map(table=>{
    const quote=(name:string)=>`"${name.replaceAll('"','""')}"`;
    // Only columns already present before migration are compared. Added
    // acknowledgment/default columns must not change routing or preferences.
    const rows=db.prepare(`SELECT ${table.columns.map(quote).join(",")} FROM ${quote(table.name)}`).all();
    return {name:table.name,rows:rows.map(row=>JSON.stringify(row)).sort()};
  });
  return createHash("sha256").update(JSON.stringify({state,allOriginalData})).digest("hex");
}

/** Rehearse only on an isolated consistent copy; never starts network workers. */
export async function rehearseMigration(sourcePath:string):Promise<{preserved:boolean;integrity:boolean;snapshots:number}>{
  const dir=await mkdtemp(join(tmpdir(),"gib-migration-drill-"));
  try{
    const source=new DatabaseSync(sourcePath,{readOnly:true});
    try{
      // Retain one read-only WAL view instead of restarting under unrelated
      // live scanner/heartbeat writes. No write lock or worker is started.
      source.exec("BEGIN");source.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
      await backup(source,join(dir,"gib-sync.db"),{rate:100});
    }finally{source.close();}
    const original=new DatabaseSync(join(dir,"gib-sync.db"),{readOnly:true});let before:string,originalTables:OriginalTable[];
    try{originalTables=tables(original);before=fingerprint(original,originalTables);}finally{original.close();}
    const migrated=new Store(dir);
    try{
      const preserved=before===fingerprint(migrated.db,originalTables),integrity=migrated.db.prepare("PRAGMA integrity_check").get()?.integrity_check==="ok";
      if(!preserved||!integrity)throw new Error("Automatic migration failed preservation verification");
      return {preserved,integrity,snapshots:Number(migrated.one<{count:number}>("SELECT COUNT(*) count FROM snapshots")?.count??0)};
    }finally{migrated.db.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
}
