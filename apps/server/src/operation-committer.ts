import {randomUUID} from "node:crypto";
import type {FolderEntry,FolderRepairDirective,ManifestEntry,OperationBatch,OperationReceipt,Snapshot,SyncTree} from "@gib-sync/protocol";
import type {Store} from "./db.js";
import {canonicalManifest} from "./manifest.js";
import type {SeafileStorage,VaultStorageRow} from "./seafile.js";
import {applyOperations,batchHash,bootstrapSyncState,bridgeSnapshotBatch,getOperationReceipt,getSyncTree,OperationConflict,readEntities,treeFromEntities,writeEntity,type PlannedOperations} from "./operation-state.js";
import {assertReservedState,configAliases} from "./reserved-paths.js";
import {captureBeforeState,getSnapshotView} from './snapshot-evidence.js';

export interface SnapshotCommit {
  vaultId:string;parentId:string|null;deviceId:string;deviceName:string;message:string;entries:ManifestEntry[];folders?:string[];folderEntries?:FolderEntry[];folderRepair?:FolderRepairDirective;createdAt?:string;
  operationBatch?:OperationBatch;afterInsert?:(snapshot:Snapshot)=>void;
  signal?:AbortSignal;
  maintenancePermit?:symbol;
}
export interface BatchPreview {tree:SyncTree;parentId:string|null;createdAt:string;sequence:number;planned:PlannedOperations;}

/** Sole authority: operations, live tree, accepted snapshot and receipt commit together. */
export class OperationSnapshotCommitter {
  constructor(private readonly store:Store,private readonly storage:SeafileStorage,private readonly storageRow:(vaultId:string)=>VaultStorageRow,private readonly assertWritable?:(vaultId:string,permit?:symbol)=>void){}
  getBatch(vaultId:string,batchId:string,deviceId?:string):OperationReceipt|null{return getOperationReceipt(this.store,vaultId,batchId,deviceId);}
  private ensure(vaultId:string):void{if(!this.store.one("SELECT 1 FROM sync_vault_state WHERE vault_id=?",vaultId)){this.store.db.exec("BEGIN IMMEDIATE");try{bootstrapSyncState(this.store);this.store.db.exec("COMMIT");}catch(error){this.store.db.exec("ROLLBACK");throw error;}}}
  previewBatch(vaultId:string,batch:OperationBatch,deviceId:string,deviceName:string,createdAt=new Date().toISOString()):BatchPreview{
    this.ensure(vaultId);const tree=getSyncTree(this.store,vaultId),current=this.store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",vaultId)?.head_id??null;
    if(tree.snapshotId!==current)throw new OperationConflict("Materialized authority does not match the accepted head");
    if(batch.baseSnapshotId!==null){let cursor=current,found=false;const visited=new Set<string>();while(cursor&&!visited.has(cursor)){if(cursor===batch.baseSnapshotId){found=true;break;}visited.add(cursor);const snapshot=this.store.getSnapshot(cursor);if(!snapshot||snapshot.vaultId!==vaultId)break;cursor=snapshot.parentId;}if(!found)throw new OperationConflict("Batch baseline is not accepted vault ancestry");}
    else if(current!==null)throw new OperationConflict("A first-sync batch cannot replace an existing vault");
    for(const operation of batch.operations)if(this.store.one("SELECT 1 FROM sync_operations WHERE vault_id=? AND operation_id=?",vaultId,operation.operationId))throw new OperationConflict("Operation ID already belongs to an accepted batch");
    const previous=readEntities(this.store,vaultId),sequence=tree.sequence+1,planned=applyOperations(previous,batch,{deviceId,deviceName,at:createdAt},sequence);assertReservedState(previous,planned.entities,configAliases(this.store,vaultId));
    return {tree:treeFromEntities(current,sequence,planned.entities),parentId:current,createdAt,sequence,planned};
  }
  async accept(input:SnapshotCommit):Promise<Snapshot|null>{
    input.signal?.throwIfAborted();
    this.ensure(input.vaultId);
    const supplied=input.operationBatch,payloadHash=supplied?batchHash(supplied):null;
    const replay=()=>{if(!supplied)return null;const existing=this.store.one<{device_id:string;payload_hash:string;result_snapshot_id:string}>("SELECT device_id,payload_hash,result_snapshot_id FROM sync_batches WHERE vault_id=? AND batch_id=?",input.vaultId,supplied.batchId);if(!existing)return null;if(existing.device_id!==input.deviceId||existing.payload_hash!==payloadHash)throw new OperationConflict("Batch ID was reused with different ownership or content");return getSnapshotView(this.store,existing.result_snapshot_id);};
    const existing=replay();if(existing)return existing;
    this.assertWritable?.(input.vaultId,input.maintenancePermit);
    const current=this.store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",input.vaultId)?.head_id??null;if(current!==input.parentId)return null;
    const acceptedSizes=new Map((current?this.store.getSnapshot(current)?.entries??[]:[]).map(entry=>[entry.hash,entry.size]));
    for(const entry of input.entries){const proof=this.store.one<{clear_size:number}>("SELECT clear_size FROM blob_integrity WHERE vault_id=? AND hash=?",input.vaultId,entry.hash),known=proof?.clear_size??acceptedSizes.get(entry.hash);if(known!==undefined&&known!==entry.size)throw new OperationConflict("Proposed content size differs from its verified clear content");}
    const createdAt=input.createdAt??new Date().toISOString(),snapshotId=randomUUID(),previous=readEntities(this.store,input.vaultId),state=getSyncTree(this.store,input.vaultId);
    if(state.snapshotId!==current)throw new OperationConflict("Materialized authority does not match the accepted head");
    const batch=supplied??bridgeSnapshotBatch(previous,{id:snapshotId,parentId:input.parentId,message:input.message,entries:canonicalManifest(input.entries,input.folders).entries,folders:input.folders,folderEntries:input.folderEntries});
    const sequence=state.sequence+1,planned=supplied?this.previewBatch(input.vaultId,batch,input.deviceId,input.deviceName,createdAt).planned:applyOperations(previous,batch,{deviceId:input.deviceId,deviceName:input.deviceName,at:createdAt},sequence,true),tree=treeFromEntities(snapshotId,sequence,planned.entities),manifest=canonicalManifest(tree.files,input.folders);
    assertReservedState(previous,planned.entities,configAliases(this.store,input.vaultId));
    const requested=canonicalManifest(input.entries,input.folders),fingerprint=(files:ManifestEntry[])=>JSON.stringify(files.map(({path,hash,size})=>({path,hash,size})));
    if(fingerprint(manifest.entries)!==fingerprint(requested.entries))throw new OperationConflict("Operation materialization differs from the proposed snapshot");
    const snapshot:Snapshot={id:snapshotId,vaultId:input.vaultId,parentId:input.parentId,deviceId:input.deviceId,deviceName:input.deviceName,createdAt,message:input.message,entries:manifest.entries,folderEntries:tree.folders};if(manifest.folders!==undefined)snapshot.folders=manifest.folders;
    if(input.folderRepair)snapshot.folderRepair={...input.folderRepair,retiredFolders:canonicalManifest([],input.folderRepair.retiredFolders).folders??[],originSnapshotIds:[...new Set(input.folderRepair.originSnapshotIds)].sort()};
    await this.storage.put(this.storageRow(input.vaultId),`snapshots/${snapshot.id}.json`,Buffer.from(JSON.stringify(snapshot)),"application/json",input.signal);
    input.signal?.throwIfAborted();
    const acceptedWhileWriting=replay();if(acceptedWhileWriting)return acceptedWhileWriting;
    // A repair may begin while the immutable sidecar PUT is in flight. An
    // unaccepted sidecar is harmless; the authoritative head must not advance.
    this.assertWritable?.(input.vaultId,input.maintenancePermit);
    this.store.db.exec("BEGIN IMMEDIATE");
    try{
      const concurrentReplay=replay();if(concurrentReplay){this.store.db.exec("ROLLBACK");return concurrentReplay;}
      input.signal?.throwIfAborted();
      const updated=this.store.run("UPDATE vaults SET head_id=? WHERE id=? AND head_id IS ?",snapshot.id,input.vaultId,input.parentId);if(!updated.changes){this.store.db.exec("ROLLBACK");return null;}
      if(this.store.one<{sequence:number}>("SELECT sequence FROM sync_vault_state WHERE vault_id=?",input.vaultId)?.sequence!==state.sequence)throw new OperationConflict("Operation authority advanced during acceptance");
      this.store.run("INSERT INTO snapshots(id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?,?)",snapshot.id,input.vaultId,input.parentId,input.deviceId,input.deviceName,snapshot.createdAt,input.message,JSON.stringify(snapshot));
      this.store.run("UPDATE sync_entities SET deleted=1 WHERE vault_id=?",input.vaultId);for(const entity of planned.entities)writeEntity(this.store,input.vaultId,entity);
      this.store.run("UPDATE sync_vault_state SET snapshot_id=?,sequence=? WHERE vault_id=?",snapshot.id,sequence,input.vaultId);
      const receipt:OperationReceipt={batchId:batch.batchId,snapshot,sequence,replayed:false};
      const parent=current?this.store.getSnapshot(current):null,beforeEvidence=captureBeforeState(parent,previous,current);
      this.store.run("INSERT INTO sync_batches(vault_id,batch_id,device_id,payload_hash,parent_id,result_snapshot_id,sequence,receipt_json,source,created_at,batch_json,before_state_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",input.vaultId,batch.batchId,input.deviceId,payloadHash??batchHash(batch),input.parentId,snapshot.id,sequence,JSON.stringify(receipt),supplied?"operations":"legacy-snapshot",createdAt,JSON.stringify(batch),JSON.stringify(beforeEvidence));
      planned.results.forEach(({operation,revision},ordinal)=>this.store.run("INSERT INTO sync_operations(vault_id,operation_id,batch_id,ordinal,kind,target_id,base_revision_id,payload_json,result_revision_json,sequence) VALUES(?,?,?,?,?,?,?,?,?,?)",input.vaultId,operation.operationId,batch.batchId,ordinal,operation.kind,operation.targetId,operation.baseRevisionId,JSON.stringify(operation),JSON.stringify(revision),sequence));
      this.store.run("DELETE FROM sync_pending_batches WHERE vault_id=? AND batch_id=?",input.vaultId,batch.batchId);
      input.afterInsert?.(snapshot);this.store.db.exec("COMMIT");return snapshot;
    }catch(error){try{this.store.db.exec("ROLLBACK");}catch{}throw error;}
  }
}
