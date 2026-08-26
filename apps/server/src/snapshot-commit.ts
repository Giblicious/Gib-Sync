import { randomUUID } from "node:crypto";
import type { FolderRepairDirective,ManifestEntry,Snapshot } from "@gib-sync/protocol";
import type { Store } from "./db.js";
import { canonicalManifest } from "./manifest.js";
import type { SeafileStorage,VaultStorageRow } from "./seafile.js";

export interface SnapshotCommit{
  vaultId:string;parentId:string|null;deviceId:string;deviceName:string;message:string;entries:ManifestEntry[];folders?:string[];folderRepair?:FolderRepairDirective;createdAt?:string;
  afterInsert?:(snapshot:Snapshot)=>void;
}

/** The only path that advances an accepted vault head. */
export class SnapshotCommitter{
  constructor(private readonly store:Store,private readonly storage:SeafileStorage,private readonly storageRow:(vaultId:string)=>VaultStorageRow){}
  async accept(input:SnapshotCommit):Promise<Snapshot|null>{
    const current=this.store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",input.vaultId)?.head_id;if(current!==input.parentId)return null;
    const manifest=canonicalManifest(input.entries,input.folders),snapshot:Snapshot={id:randomUUID(),vaultId:input.vaultId,parentId:input.parentId,deviceId:input.deviceId,deviceName:input.deviceName,createdAt:input.createdAt??new Date().toISOString(),message:input.message,entries:manifest.entries};
    if(manifest.folders!==undefined)snapshot.folders=manifest.folders;
    if(input.folderRepair){
      const retiredFolders=canonicalManifest([],input.folderRepair.retiredFolders).folders??[];
      snapshot.folderRepair={retiredFolders,observedAt:input.folderRepair.observedAt,originSnapshotIds:[...new Set(input.folderRepair.originSnapshotIds)].sort()};
    }
    await this.storage.put(this.storageRow(input.vaultId),`snapshots/${snapshot.id}.json`,Buffer.from(JSON.stringify(snapshot)),"application/json");
    this.store.db.exec("BEGIN IMMEDIATE");
    try{
      const updated=this.store.run("UPDATE vaults SET head_id=? WHERE id=? AND head_id IS ?",snapshot.id,input.vaultId,input.parentId);
      if(!updated.changes){this.store.db.exec("ROLLBACK");return null;}
      this.store.run("INSERT INTO snapshots(id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?,?)",snapshot.id,input.vaultId,input.parentId,input.deviceId,input.deviceName,snapshot.createdAt,input.message,JSON.stringify(snapshot));
      input.afterInsert?.(snapshot);this.store.db.exec("COMMIT");return snapshot;
    }catch(error){try{this.store.db.exec("ROLLBACK");}catch{}throw error;}
  }
}
