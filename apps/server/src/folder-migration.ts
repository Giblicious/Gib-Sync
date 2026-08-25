import { randomUUID } from "node:crypto";
import type { Snapshot } from "@gib-sync/protocol";
import type { Store } from "./db.js";

function sameFiles(left:Snapshot,right:Snapshot):boolean{
  if(left.entries.length!==right.entries.length)return false;
  const stable=(snapshot:Snapshot)=>snapshot.entries.map(({path,hash,size,mtime})=>({path,hash,size,mtime})).sort((a,b)=>a.path.localeCompare(b.path));
  return JSON.stringify(stable(left))===JSON.stringify(stable(right));
}

export function repairUnsafeLegacyFolderHeads(store:Store):number{
  let repaired=0;
  for(const vault of store.all<{id:string;head_id:string}>("SELECT id,head_id FROM vaults WHERE head_id IS NOT NULL")){
    const head=store.getSnapshot(vault.head_id);if(!head?.parentId||head.deviceId!==`seafile:${vault.id}`||head.deviceName!=="Seafile"||!Array.isArray(head.folders)||!head.folders.length)continue;
    if(!/^Seafile external change \(0 changed, 0 deleted, \d+ folders(?:, 0 conflicts)?\)$/.test(head.message))continue;
    const parent=store.getSnapshot(head.parentId);if(!parent||Array.isArray(parent.folders)||!sameFiles(head,parent))continue;
    const now=new Date().toISOString();
    store.db.exec("BEGIN IMMEDIATE");
    try{
      const updated=store.run("UPDATE vaults SET head_id=? WHERE id=? AND head_id=?",parent.id,vault.id,head.id);
      if(updated.changes){
        store.run("INSERT INTO health_events(id,vault_id,code,level,message,created_at) VALUES(?,?,?,?,?,?)",randomUUID(),vault.id,"legacy_folder_migration_reverted","warning","An unsafe legacy folder-only migration was retired. The next trusted device sync will establish the folder baseline.",now);
        repaired++;
      }
      store.db.exec("COMMIT");
    }catch(error){try{store.db.exec("ROLLBACK");}catch{}throw error;}
  }
  return repaired;
}
