import {z} from "zod";
import type {OperationReceipt,Snapshot} from "@gib-sync/protocol";
import type {Store} from "./db.js";
import {canonicalManifest} from "./manifest.js";
import {applyOperations,batchHash,bridgeSnapshotBatch,readEntities,treeFromEntities,writeEntity,OperationConflict} from "./operation-state.js";
import {captureBeforeState} from './snapshot-evidence.js';

/** Runs inside Store's upgrade transaction. A rolled-back legacy runtime can
 * accept immutable descendants without knowing the new ledger tables. Replay
 * only that proven missing ancestry; never reset state or rewrite old JSON. */
export function catchUpSyncState(store:Store):void{
  for(const vault of store.all<{id:string;head_id:string|null;snapshot_id:string|null;sequence:number}>("SELECT v.id,v.head_id,s.snapshot_id,s.sequence FROM vaults v JOIN sync_vault_state s ON s.vault_id=v.id WHERE v.head_id IS NOT s.snapshot_id")){
    const missing:Snapshot[]=[],seen=new Set<string>();let cursor=vault.head_id;
    while(cursor!==vault.snapshot_id){if(!cursor||seen.has(cursor))throw new OperationConflict("Accepted legacy history diverges from the durable operation baseline");seen.add(cursor);const snapshot=store.getSnapshot(cursor);if(!snapshot||snapshot.vaultId!==vault.id)throw new OperationConflict("Accepted legacy ancestry is incomplete or belongs to another vault");missing.push(snapshot);cursor=snapshot.parentId;}
    let sequence=vault.sequence,previous=readEntities(store,vault.id);
    for(const original of missing.reverse()){
      const validated=canonicalManifest(original.entries,original.folders);for(const entry of validated.entries){z.string().regex(/^[a-f0-9]{64}$/).parse(entry.hash);z.number().int().nonnegative().parse(entry.size);z.number().finite().nonnegative().parse(entry.mtime);if(entry.fileId)z.string().uuid().parse(entry.fileId);}
      const batch=bridgeSnapshotBatch(previous,original);if(store.one('SELECT 1 FROM sync_batches WHERE vault_id=? AND batch_id=?',vault.id,batch.batchId))throw new OperationConflict('A missing legacy descendant already has an inconsistent operation receipt');
      const planned=applyOperations(previous,batch,{deviceId:original.deviceId,deviceName:original.deviceName,at:original.createdAt},++sequence,true),tree=treeFromEntities(original.id,sequence,planned.entities),shape=(entries:Snapshot['entries'])=>JSON.stringify([...entries].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(({path,hash,size})=>({path,hash,size})));
      if(shape(tree.files)!==shape(original.entries))throw new OperationConflict('Legacy replay does not reproduce its accepted immutable file manifest');
      const parent=original.parentId?store.getSnapshot(original.parentId):null,before=captureBeforeState(parent,previous,original.parentId),receipt:OperationReceipt={batchId:batch.batchId,snapshot:{...original,entries:tree.files,folderEntries:tree.folders},sequence,replayed:false};
      store.run('UPDATE sync_entities SET deleted=1 WHERE vault_id=?',vault.id);for(const entity of planned.entities)writeEntity(store,vault.id,entity);store.run('UPDATE sync_vault_state SET snapshot_id=?,sequence=? WHERE vault_id=?',original.id,sequence,vault.id);
      store.run('INSERT INTO sync_batches(vault_id,batch_id,device_id,payload_hash,parent_id,result_snapshot_id,sequence,receipt_json,source,created_at,batch_json,before_state_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',vault.id,batch.batchId,original.deviceId,batchHash(batch),original.parentId,original.id,sequence,JSON.stringify(receipt),'legacy-catchup',original.createdAt,JSON.stringify(batch),JSON.stringify(before));
      planned.results.forEach(({operation,revision},ordinal)=>store.run('INSERT INTO sync_operations(vault_id,operation_id,batch_id,ordinal,kind,target_id,base_revision_id,payload_json,result_revision_json,sequence) VALUES(?,?,?,?,?,?,?,?,?,?)',vault.id,operation.operationId,batch.batchId,ordinal,operation.kind,operation.targetId,operation.baseRevisionId,JSON.stringify(operation),JSON.stringify(revision),sequence));previous=planned.entities;
    }
    store.run("UPDATE sync_rollouts SET mode=CASE WHEN mode='hold' THEN 'hold' ELSE 'shadow' END,canary_device_id=NULL,last_error=CASE WHEN mode='hold' THEN last_error ELSE NULL END,updated_at=? WHERE vault_id=?",new Date().toISOString(),vault.id);
  }
}
