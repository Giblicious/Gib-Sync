import {createHash,randomUUID} from "node:crypto";
import type {FileRevision,FolderEntry,ManifestEntry,OperationBatch,OperationReceipt,Snapshot,SyncOperation,SyncTree} from "@gib-sync/protocol";
import type {Store} from "./db.js";
import {canonicalManifest} from "./manifest.js";
import {provenFolders} from './snapshot-evidence.js';

export interface SyncEntity {id:string;kind:"file"|"folder";path:string;hash:string|null;size:number;mtime:number;revision:FileRevision;deleted:boolean;sequence:number;ordinal?:number;}
export class OperationConflict extends Error {readonly statusCode=409;constructor(message:string){super(message);this.name="OperationConflict";}}
export const portablePath=(path:string)=>path.normalize("NFC").toLowerCase();
export function stableUuid(value:string):string{const hex=createHash("sha256").update(value).digest("hex");return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}
export function folderPaths(files:ManifestEntry[],folders:string[]=[]):string[]{const paths=new Set<string>();for(const raw of [...folders,...files.map(file=>file.path.split("/").slice(0,-1).join("/"))]){const parts=raw.split("/").filter(Boolean);for(let i=1;i<=parts.length;i++)paths.add(parts.slice(0,i).join("/"));}return [...paths].sort();}
export function readEntities(store:Store,vaultId:string):SyncEntity[]{return store.all<{entity_id:string;entity_kind:"file"|"folder";path:string;hash:string|null;size:number;mtime:number;revision_json:string;deleted:number;sequence:number;mutation_ordinal:number}>("SELECT * FROM sync_entities WHERE vault_id=? ORDER BY entity_id",vaultId).map(row=>({id:row.entity_id,kind:row.entity_kind,path:row.path,hash:row.hash,size:row.size,mtime:row.mtime,revision:JSON.parse(row.revision_json),deleted:Boolean(row.deleted),sequence:row.sequence,ordinal:row.mutation_ordinal}));}
export function treeFromEntities(snapshotId:string|null,sequence:number,entities:SyncEntity[]):SyncTree{return {snapshotId,sequence,files:entities.filter(e=>!e.deleted&&e.kind==="file").map(e=>({fileId:e.id,path:e.path,hash:e.hash!,size:e.size,mtime:e.mtime,revision:e.revision})).sort((a,b)=>a.path.localeCompare(b.path)),folders:entities.filter(e=>!e.deleted&&e.kind==="folder").map(e=>({folderId:e.id,path:e.path,revision:e.revision})).sort((a,b)=>a.path.localeCompare(b.path)),tombstones:entities.filter(e=>e.deleted).map(e=>({targetId:e.id,entityKind:e.kind,path:e.path,revision:e.revision,deletedSequence:e.sequence,deletedOrdinal:e.ordinal??0,...e.kind==="file"&&e.hash?{content:{hash:e.hash,size:e.size,mtime:e.mtime}}:{}}))};}
export function getSyncTree(store:Store,vaultId:string):SyncTree{const state=store.one<{snapshot_id:string|null;sequence:number}>("SELECT snapshot_id,sequence FROM sync_vault_state WHERE vault_id=?",vaultId);return treeFromEntities(state?.snapshot_id??null,state?.sequence??0,readEntities(store,vaultId));}
/** Historical identities are projected only from exact accepted evidence. */
export function provenSnapshotFolders(store:Store,vaultId:string,snapshot:Snapshot|null):FolderEntry[]|null{
  return !snapshot?[]:snapshot.vaultId!==vaultId?null:provenFolders(store,snapshot);
}
export function getOperationReceipt(store:Store,vaultId:string,batchId:string,deviceId?:string):OperationReceipt|null{const row=store.one<{receipt_json:string;device_id:string}>("SELECT receipt_json,device_id FROM sync_batches WHERE vault_id=? AND batch_id=?",vaultId,batchId);if(!row||deviceId&&row.device_id!==deviceId)return null;return {...JSON.parse(row.receipt_json),replayed:true};}
export function canonicalBatch(batch:OperationBatch):string{
  const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value as Record<string,unknown>).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
  return JSON.stringify(canonical(batch));
}
export const batchHash=(batch:OperationBatch)=>createHash("sha256").update(canonicalBatch(batch)).digest("hex");

/** Run only inside the schema/bootstrap transaction; historical JSON is never changed. */
export function bootstrapSyncState(store:Store):void{
  for(const vault of store.all<{id:string;head_id:string|null}>("SELECT id,head_id FROM vaults")){
    if(store.one("SELECT 1 FROM sync_vault_state WHERE vault_id=?",vault.id))continue;
    const snapshot=vault.head_id?store.getSnapshot(vault.head_id):null,now=new Date().toISOString();
    store.run("INSERT INTO sync_vault_state(vault_id,snapshot_id,sequence,initialized_at) VALUES(?,?,0,?)",vault.id,vault.head_id,now);
    store.run("INSERT OR IGNORE INTO sync_rollouts(vault_id,mode,updated_at) VALUES(?,'shadow',?)",vault.id,now);
    const revision=(path:string,kind:string):FileRevision=>({id:stableUuid(`${vault.id}:${vault.head_id}:${kind}:${path}:revision`),parentId:null,deviceId:"legacy:unknown",deviceName:"Earlier version",modifiedAt:Date.parse(snapshot?.createdAt??now)});
    for(const file of snapshot?.entries??[]){const entity:SyncEntity={id:file.fileId??stableUuid(`${vault.id}:${vault.head_id}:file:${file.path}`),kind:"file",path:file.path,hash:file.hash,size:file.size,mtime:file.mtime,revision:file.revision??revision(file.path,"file"),deleted:false,sequence:0};writeEntity(store,vault.id,entity);}
    for(const path of folderPaths(snapshot?.entries??[],snapshot?.folders)){const previous=snapshot?.folderEntries?.find(e=>e.path===path),entity:SyncEntity={id:previous?.folderId??stableUuid(`${vault.id}:${vault.head_id}:folder:${path}`),kind:"folder",path,hash:null,size:0,mtime:0,revision:previous?.revision??revision(path,"folder"),deleted:false,sequence:0};writeEntity(store,vault.id,entity);}
  }
}
export function writeEntity(store:Store,vaultId:string,entity:SyncEntity):void{store.run("INSERT INTO sync_entities(vault_id,entity_id,entity_kind,path,path_key,hash,size,mtime,revision_json,deleted,sequence,mutation_ordinal) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(vault_id,entity_id) DO UPDATE SET entity_kind=excluded.entity_kind,path=excluded.path,path_key=excluded.path_key,hash=excluded.hash,size=excluded.size,mtime=excluded.mtime,revision_json=excluded.revision_json,deleted=excluded.deleted,sequence=excluded.sequence,mutation_ordinal=excluded.mutation_ordinal",vaultId,entity.id,entity.kind,entity.path,portablePath(entity.path),entity.hash,entity.size,entity.mtime,JSON.stringify(entity.revision),entity.deleted?1:0,entity.sequence,entity.ordinal??0);}
export interface PlannedOperations {entities:SyncEntity[];results:Array<{operation:SyncOperation;revision:FileRevision}>;}

/** The authoritative materializer used by explicit operations and the snapshot bridge. */
export function applyOperations(previous:SyncEntity[],batch:OperationBatch,author:{deviceId:string;deviceName:string;at:string},sequence:number,internalChain=false):PlannedOperations{
  const entities=new Map(previous.map(entity=>[entity.id,{...entity,revision:{...entity.revision}}])),results:PlannedOperations["results"]=[],ids=new Set<string>();
  const original=new Map(previous.map(entity=>[entity.id,entity]));
  const paths=new Map<string,string>(),descendantIds=new Map<string,Set<string>>(),latestTombstones=new Map<string,SyncEntity>(),resultById=new Map<string,PlannedOperations["results"][number]>();
  const ancestors=(path:string)=>{const parts=path.split('/'),values:string[]=[];for(let index=1;index<parts.length;index++)values.push(parts.slice(0,index).join('/'));return values;};
  const index=(entity:SyncEntity,add:boolean)=>{if(entity.deleted)return;const key=portablePath(entity.path);if(add)paths.set(key,entity.id);else if(paths.get(key)===entity.id)paths.delete(key);for(const parent of ancestors(entity.path)){let children=descendantIds.get(parent);if(add){if(!children){children=new Set();descendantIds.set(parent,children);}children.add(entity.id);}else {children?.delete(entity.id);if(!children?.size)descendantIds.delete(parent);}}};
  const rememberDeletion=(entity:SyncEntity)=>{const key=portablePath(entity.path),prior=latestTombstones.get(key);if(!prior||entity.sequence>prior.sequence||entity.sequence===prior.sequence&&(entity.ordinal??0)>(prior.ordinal??0))latestTombstones.set(key,entity);};
  for(const entity of entities.values()){index(entity,true);if(entity.deleted)rememberDeletion(entity);}
  const setEntity=(entity:SyncEntity)=>{const old=entities.get(entity.id);if(!old||old.deleted!==entity.deleted||old.path!==entity.path){if(old)index(old,false);index(entity,true);}entities.set(entity.id,entity);};
  const live=()=>[...entities.values()].filter(entity=>!entity.deleted);
  const occupied=(path:string,except?:string)=>{const id=paths.get(portablePath(path));return id&&id!==except?entities.get(id):undefined;};
  let executingId="",executingTarget="",executingModifiedAt=Date.parse(author.at);
  const nextRevision=(entity?:SyncEntity,preserveContent=false):FileRevision=>({id:stableUuid(`${batch.batchId}:${executingId}:${entity?.id??executingTarget}:revision`),parentId:entity?.revision.id??null,deviceId:preserveContent&&entity?entity.revision.deviceId:author.deviceId,deviceName:preserveContent&&entity?entity.revision.deviceName:author.deviceName,modifiedAt:preserveContent&&entity?entity.revision.modifiedAt:executingModifiedAt});
  for(const raw of batch.operations){
    const operation=raw.baseRevisionId==="$previous"&&internalChain?{...raw,baseRevisionId:entities.get(raw.targetId)?.revision.id??null}:raw;executingId=operation.operationId;executingTarget="newTargetId" in operation&&operation.newTargetId?operation.newTargetId:operation.targetId;
    executingModifiedAt="content" in operation?Math.min(operation.content.mtime,Date.parse(author.at)+5*60_000):Date.parse(author.at);
    if(ids.has(operation.operationId))throw new OperationConflict("Duplicate operation ID in batch");ids.add(operation.operationId);
    let entity=entities.get(operation.targetId);
    const matchesBase=()=>entity?.revision.id===operation.baseRevisionId||original.get(operation.targetId)?.revision.id===operation.baseRevisionId;
    const deletionProof=()=>{
      const proof="deletedByOperationId" in operation?operation.deletedByOperationId:undefined;
      if(!proof)return original.get(operation.targetId)?.deleted===true;
      const deleted=resultById.get(proof);
      return Boolean(deleted&&deleted.operation.targetId===operation.targetId&&(deleted.operation.kind==="delete"||deleted.operation.kind==="rmdir")&&deleted.operation.baseRevisionId===operation.baseRevisionId&&deleted.revision.id===entity?.revision.id);
    };
    const latestDeletion=()=>latestTombstones.get(portablePath(entity!.path))?.id===entity!.id;
    const expectLive=(kind:"file"|"folder")=>{if(!entity||entity.deleted||entity.kind!==kind||!matchesBase())throw new OperationConflict("Entity revision changed before this operation");return entity;};
    if(operation.kind==="mkdir"&&operation.newTargetId){
      if(!entity?.deleted||!matchesBase()||!deletionProof()||!latestDeletion()||entities.has(operation.newTargetId)||occupied(operation.path)||entity.path!==operation.path)throw new OperationConflict("Folder recreation does not reference its deletion");
      entity={id:operation.newTargetId,kind:"folder",path:operation.path,hash:null,size:0,mtime:0,revision:nextRevision(entity),deleted:false,sequence};setEntity(entity);
    }else if(operation.kind==="create"||operation.kind==="mkdir"){
      if(entity||operation.baseRevisionId!==null||occupied(operation.path))throw new OperationConflict("Creation identity or path already exists");
      // A tombstone at this exact path requires an explicit recreation. A new
      // location occupied only historically by a move does not create a tombstone.
      if(latestTombstones.has(portablePath(operation.path)))throw new OperationConflict("Deleted paths require an explicit causal recreation");
      const content=operation.kind==="create"?operation.content:undefined;
      entity={id:operation.targetId,kind:operation.kind==="create"?"file":"folder",path:operation.path,hash:content?.hash??null,size:content?.size??0,mtime:content?.mtime??0,revision:nextRevision(),deleted:false,sequence};setEntity(entity);
    }else if(operation.kind==="recreate"){
      if(!entity?.deleted||!matchesBase()||!deletionProof()||!latestDeletion()||entities.has(operation.newTargetId)||occupied(operation.path)||portablePath(entity.path)!==portablePath(operation.path))throw new OperationConflict("Recreation does not reference the current deletion");
      entity={id:operation.newTargetId,kind:"file",path:operation.path,hash:operation.content.hash,size:operation.content.size,mtime:operation.content.mtime,revision:nextRevision(entity),deleted:false,sequence};setEntity(entity);
    }else if(operation.kind==="edit"){
      entity=expectLive("file");entity={...entity,...operation.content,revision:nextRevision(entity),sequence};setEntity(entity);
    }else if(operation.kind==="move"||operation.kind==="move-folder"){
      entity=expectLive(operation.kind==="move"?"file":"folder");if(operation.newPath===entity.path)throw new OperationConflict("A move must change location");if(occupied(operation.newPath,entity.id))throw new OperationConflict("Move destination already exists");
      const oldPath=entity.path;
      if(operation.kind==="move-folder"){
        if(operation.newPath.startsWith(`${oldPath}/`))throw new OperationConflict("A folder cannot move inside itself");
        const descendants=[...(descendantIds.get(oldPath)??[])].map(id=>entities.get(id)!),expected=new Map(operation.descendants.map(item=>[item.targetId,item.baseRevisionId]));
        if(expected.size!==operation.descendants.length||expected.size!==descendants.length||descendants.some(item=>expected.get(item.id)!==item.revision.id&&expected.get(item.id)!==original.get(item.id)?.revision.id))throw new OperationConflict("Folder contents changed before the move");
        const moving=new Set([entity.id,...descendants.map(item=>item.id)]);
        for(const child of descendants){const path=`${operation.newPath}${child.path.slice(oldPath.length)}`,collision=occupied(path);if(collision&&!moving.has(collision.id))throw new OperationConflict("Folder move collides with another entity");setEntity({...child,path,revision:nextRevision(child,child.kind==="file"),sequence});}
      }
      entity={...entity,path:operation.newPath,revision:nextRevision(entity,entity.kind==="file"),sequence};setEntity(entity);
    }else{
      entity=expectLive(operation.kind==="delete"?"file":"folder");if(entity.kind==="folder"&&descendantIds.get(entity.path)?.size)throw new OperationConflict("Folder deletion must explicitly account for every child");
      entity={...entity,deleted:true,revision:nextRevision(entity),sequence};setEntity(entity);
    }
    const result={operation,revision:entity.revision};results.push(result);resultById.set(operation.operationId,result);
    entity.ordinal=results.length;
    if(entity.deleted)rememberDeletion(entity);
  }
  const active=live(),files=active.filter(e=>e.kind==="file").map(e=>({path:e.path,hash:e.hash!,size:e.size,mtime:e.mtime})),folders=active.filter(e=>e.kind==="folder").map(e=>e.path);canonicalManifest(files,folders);
  // Parents are real identified entities, not filesystem side effects.
  const declared=new Set(folders);for(const path of folderPaths(files,folders))if(!declared.has(path))throw new OperationConflict("Every parent folder must be created explicitly");
  return {entities:[...entities.values()],results};
}

export {bridgeSnapshotBatch} from "./snapshot-bridge.js";
