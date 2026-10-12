import {backup,DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {OperationBatch,OperationReceipt,Snapshot} from '@gib-sync/protocol';
import {Store} from './db.js';
import {applyOperations,batchHash,folderPaths,getSyncTree,portablePath,stableUuid,treeFromEntities,type SyncEntity} from './operation-state.js';
import {reconstructBeforeState} from './snapshot-evidence.js';

type Row=Record<string,unknown>;
type OriginalTable={name:string;columns:string[];rows:Row[]};
const quote=(name:string)=>`"${name.replaceAll('"','""')}"`;
const sorted=(rows:Row[])=>rows.map(row=>JSON.stringify(row)).sort();
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function tables(db:DatabaseSync):OriginalTable[]{return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(({name})=>({name,columns:(db.prepare(`PRAGMA table_info(${quote(name)})`).all() as {name:string}[]).map(column=>column.name),rows:db.prepare(`SELECT * FROM ${quote(name)}`).all() as Row[]}));}
const project=(row:Row,columns:string[]):Row=>Object.fromEntries(columns.map(column=>[column,row[column]]));
const entities=(rows:Row[],vaultId:string):SyncEntity[]=>rows.filter(row=>row.vault_id===vaultId).map(row=>({id:String(row.entity_id),kind:row.entity_kind as 'file'|'folder',path:String(row.path),hash:row.hash as string|null,size:Number(row.size),mtime:Number(row.mtime),revision:JSON.parse(String(row.revision_json)),deleted:Boolean(row.deleted),sequence:Number(row.sequence),ordinal:Number(row.mutation_ordinal??0)}));
const entityRows=(vaultId:string,values:SyncEntity[]):Row[]=>values.map(entity=>({vault_id:vaultId,entity_id:entity.id,entity_kind:entity.kind,path:entity.path,path_key:portablePath(entity.path),hash:entity.hash,size:entity.size,mtime:entity.mtime,revision_json:JSON.stringify(entity.revision),deleted:entity.deleted?1:0,sequence:entity.sequence,mutation_ordinal:entity.ordinal??0}));
const semanticEntities=(values:SyncEntity[])=>values.map(entity=>({...entity,sequence:entity.deleted?entity.sequence:0,ordinal:entity.deleted?entity.ordinal??0:0})).sort((a,b)=>a.id.localeCompare(b.id));
const fileShape=(files:Snapshot['entries'])=>files.map(({path,hash,size})=>({path,hash,size})).sort((a,b)=>a.path.localeCompare(b.path));

/** Exact preservation except narrowly proved, append-only rollback catch-up.
 * Every pre-existing ledger row remains byte-identical in its original columns. */
export function verifyMigrationPreservation(original:DatabaseSync,migrated:Store):void{
  const before=tables(original),byName=new Map(before.map(table=>[table.name,table])),snapshots=new Map((byName.get('snapshots')?.rows??[]).map(row=>[String(row.id),JSON.parse(String(row.manifest_json)) as Snapshot])),originalBatches=byName.get('sync_batches')?.rows??[],originalOperations=byName.get('sync_operations')?.rows??[],originalBatchKeys=new Set(originalBatches.map(row=>`${row.vault_id}:${row.batch_id}`)),originalOperationKeys=new Set(originalOperations.map(row=>`${row.vault_id}:${row.operation_id}`));
  const appendedBatches=migrated.all<Row>('SELECT * FROM sync_batches').filter(row=>!originalBatchKeys.has(`${row.vault_id}:${row.batch_id}`)),appendedOperations=migrated.all<Row>('SELECT * FROM sync_operations').filter(row=>!originalOperationKeys.has(`${row.vault_id}:${row.operation_id}`)),provedBatches=new Set<string>(),provedOperations=new Set<string>(),caught=new Set<string>(),bootstrapped=new Set<string>(),expectedEntities=new Map<string,Row[]>(),expectedStates=new Map<string,Row>();
  // A legacy runtime may also register a new vault while a previous v2 schema
  // remains. Its first authority is proved directly by its exact accepted head.
  if(byName.has('sync_vault_state'))for(const vault of byName.get('vaults')?.rows??[]){const vaultId=String(vault.id);if(byName.get('sync_vault_state')!.rows.some(state=>state.vault_id===vaultId))continue;if((byName.get('sync_entities')?.rows??[]).some(entity=>entity.vault_id===vaultId))throw new Error('Uninitialized authority contains unexplained existing entities');const state=migrated.one<Row>('SELECT * FROM sync_vault_state WHERE vault_id=?',vaultId),snapshot=vault.head_id?snapshots.get(String(vault.head_id))??null:null;if(!state||state.snapshot_id!==vault.head_id||Number(state.sequence)!==0||typeof state.initialized_at!=='string'||!Number.isFinite(Date.parse(state.initialized_at)))throw new Error('New legacy vault bootstrap differs from its accepted head');const revision=(path:string,kind:string)=>({id:stableUuid(`${vaultId}:${vault.head_id}:${kind}:${path}:revision`),parentId:null,deviceId:'legacy:unknown',deviceName:'Earlier version',modifiedAt:Date.parse(snapshot?.createdAt??String(state.initialized_at))}),values:SyncEntity[]=[...(snapshot?.entries??[]).map(file=>({id:file.fileId??stableUuid(`${vaultId}:${vault.head_id}:file:${file.path}`),kind:'file' as const,path:file.path,hash:file.hash,size:file.size,mtime:file.mtime,revision:file.revision??revision(file.path,'file'),deleted:false,sequence:0})),...folderPaths(snapshot?.entries??[],snapshot?.folders).map(path=>{const prior=snapshot?.folderEntries?.find(folder=>folder.path===path);return {id:prior?.folderId??stableUuid(`${vaultId}:${vault.head_id}:folder:${path}`),kind:'folder' as const,path,hash:null,size:0,mtime:0,revision:prior?.revision??revision(path,'folder'),deleted:false,sequence:0};})];bootstrapped.add(vaultId);expectedEntities.set(vaultId,entityRows(vaultId,values));expectedStates.set(vaultId,state);}
  for(const state of byName.get('sync_vault_state')?.rows??[]){
    const vaultId=String(state.vault_id),vault=(byName.get('vaults')?.rows??[]).find(row=>row.id===vaultId);if(!vault||vault.head_id===state.snapshot_id)continue;
    const chain:Snapshot[]=[],seen=new Set<string>();let cursor=vault.head_id as string|null;
    while(cursor!==state.snapshot_id){if(!cursor||seen.has(cursor))throw new Error('Migration cannot prove the missing accepted snapshot ancestry');seen.add(cursor);const snapshot=snapshots.get(cursor);if(!snapshot||snapshot.vaultId!==vaultId)throw new Error('Migration ancestry is missing or foreign');chain.push(snapshot);cursor=snapshot.parentId;}
    let previous=entities(byName.get('sync_entities')?.rows??[],vaultId),sequence=Number(state.sequence);
    for(const snapshot of chain.reverse()){
      const rows=appendedBatches.filter(row=>row.vault_id===vaultId&&row.result_snapshot_id===snapshot.id);if(rows.length!==1)throw new Error('Missing ancestry must append exactly one derived accepted receipt');const row=rows[0]!,batch=JSON.parse(String(row.batch_json)) as OperationBatch,receipt=JSON.parse(String(row.receipt_json)) as OperationReceipt;
      if(row.source!=='legacy-catchup'||row.parent_id!==snapshot.parentId||row.device_id!==snapshot.deviceId||row.created_at!==snapshot.createdAt||Number(row.sequence)!==++sequence||batch.batchId!==row.batch_id||batch.baseSnapshotId!==snapshot.parentId||batch.message!==snapshot.message||batchHash(batch)!==row.payload_hash||receipt.batchId!==batch.batchId||receipt.sequence!==sequence||receipt.snapshot.id!==snapshot.id||receipt.snapshot.vaultId!==vaultId||receipt.snapshot.parentId!==snapshot.parentId||receipt.snapshot.deviceId!==snapshot.deviceId||receipt.snapshot.deviceName!==snapshot.deviceName||receipt.snapshot.createdAt!==snapshot.createdAt||receipt.snapshot.message!==snapshot.message)throw new Error('Derived catch-up receipt ownership, ancestry or payload changed');
      const parent=snapshot.parentId?snapshots.get(snapshot.parentId)??null:null,reconstructed=reconstructBeforeState(parent,JSON.parse(String(row.before_state_json)),sequence-1);if(!equal(semanticEntities(reconstructed),semanticEntities(previous)))throw new Error('Catch-up before-state does not prove the original durable authority');
      const planned=applyOperations(previous,batch,{deviceId:snapshot.deviceId,deviceName:snapshot.deviceName,at:snapshot.createdAt},sequence,true),tree=treeFromEntities(snapshot.id,sequence,planned.entities);
      if(!equal(fileShape(tree.files),fileShape(snapshot.entries))||!equal(tree.files,receipt.snapshot.entries)||!equal(tree.folders,receipt.snapshot.folderEntries))throw new Error('Derived replay differs from accepted historical content or its identity receipt');
      const operations=appendedOperations.filter(operation=>operation.vault_id===vaultId&&operation.batch_id===batch.batchId).sort((a,b)=>Number(a.ordinal)-Number(b.ordinal));if(operations.length!==planned.results.length)throw new Error('Catch-up ledger must append every and only its materialized operation');
      planned.results.forEach((result,index)=>{const operation=operations[index]!;if(operation.operation_id!==result.operation.operationId||Number(operation.ordinal)!==index||operation.kind!==result.operation.kind||operation.target_id!==result.operation.targetId||operation.base_revision_id!==result.operation.baseRevisionId||operation.payload_json!==JSON.stringify(result.operation)||operation.result_revision_json!==JSON.stringify(result.revision)||Number(operation.sequence)!==sequence)throw new Error('Derived operation proof differs from deterministic replay');provedOperations.add(`${vaultId}:${operation.operation_id}`);});
      provedBatches.add(`${vaultId}:${row.batch_id}`);previous=planned.entities;
    }
    caught.add(vaultId);expectedEntities.set(vaultId,entityRows(vaultId,previous));expectedStates.set(vaultId,{...state,snapshot_id:vault.head_id,sequence});
  }
  if(appendedBatches.some(row=>!provedBatches.has(`${row.vault_id}:${row.batch_id}`))||appendedOperations.some(row=>!provedOperations.has(`${row.vault_id}:${row.operation_id}`)))throw new Error('Migration appended unproved ledger records');
  for(const table of before){
    const after=migrated.all<Row>(`SELECT ${table.columns.map(quote).join(',')} FROM ${quote(table.name)}`);let expected=table.rows;
    if(table.name==='sync_batches'||table.name==='sync_operations'){
      const key=(row:Row)=>`${row.vault_id}:${row[table.name==='sync_batches'?'batch_id':'operation_id']}`,originalKeys=new Set(table.rows.map(key));if(!equal(sorted(after.filter(row=>originalKeys.has(key(row)))),sorted(table.rows)))throw new Error('Migration altered or removed an immutable existing ledger record');continue;
    }
    if(table.name==='sync_entities')expected=[...table.rows.filter(row=>!caught.has(String(row.vault_id))),...[...expectedEntities.values()].flat().map(row=>project(row,table.columns))];
    if(table.name==='sync_vault_state')expected=[...table.rows.map(row=>expectedStates.get(String(row.vault_id))??row),...[...bootstrapped].map(id=>expectedStates.get(id)!)].map(row=>project(row,table.columns));
    if(table.name==='sync_rollouts'){
      for(const row of after)if(caught.has(String(row.vault_id))){const old=table.rows.find(item=>item.vault_id===row.vault_id);if(!old||row.mode!==(old.mode==='hold'?'hold':'shadow')||row.canary_device_id!==null||row.last_error!==(old.mode==='hold'?old.last_error:null)||typeof row.updated_at!=='string'||!Number.isFinite(Date.parse(row.updated_at)))throw new Error('Catch-up rollout reset is not the supported safety transition');}
      expected=table.rows.map(row=>caught.has(String(row.vault_id))?{...row,mode:row.mode==='hold'?'hold':'shadow',canary_device_id:null,last_error:row.mode==='hold'?row.last_error:null,updated_at:after.find(item=>item.vault_id===row.vault_id)?.updated_at}:row);
      for(const id of bootstrapped){if(table.rows.some(row=>row.vault_id===id))throw new Error('An uninitialized legacy vault already has unexplained rollout evidence');expected.push(project({vault_id:id,mode:'shadow',canary_device_id:null,comparisons:0,mismatches:0,canary_batches:0,canary_start_sequence:0,last_error:null,updated_at:expectedStates.get(id)!.initialized_at},table.columns));}
    }
    if(!equal(sorted(after),sorted(expected)))throw new Error(`Migration failed exact preservation of ${table.name}`);
  }
}

/** Rehearse on an isolated consistent copy; never starts network workers. */
export async function rehearseMigration(sourcePath:string):Promise<{preserved:boolean;integrity:boolean;snapshots:number}>{
  const dir=await mkdtemp(join(tmpdir(),'gib-migration-drill-'));
  try{
    const source=new DatabaseSync(sourcePath,{readOnly:true});try{source.exec('BEGIN');source.prepare('SELECT name FROM sqlite_master LIMIT 1').get();await backup(source,join(dir,'gib-sync.db'),{rate:100});await backup(source,join(dir,'before.db'),{rate:100});}finally{source.close();}
    // The proof copy is separate: retaining a read transaction on a legacy
    // non-WAL destination would prevent Store from upgrading its journal mode.
    const original=new DatabaseSync(join(dir,'before.db'),{readOnly:true});
    let migrated:Store|undefined;try{
      migrated=new Store(dir);verifyMigrationPreservation(original,migrated);
      for(const vault of migrated.all<{id:string;head_id:string|null}>('SELECT id,head_id FROM vaults')){const tree=getSyncTree(migrated,vault.id),head=vault.head_id?migrated.getSnapshot(vault.head_id):null;if(tree.snapshotId!==vault.head_id||!equal(fileShape(tree.files),fileShape(head?.entries??[]))||new Set(tree.files.map(entry=>entry.fileId)).size!==tree.files.length||new Set(tree.folders.map(entry=>entry.folderId)).size!==tree.folders.length)throw new Error('Automatic authority bootstrap changed accepted content or identity uniqueness');}
      const integrity=migrated.db.prepare('PRAGMA integrity_check').get()?.integrity_check==='ok';if(!integrity)throw new Error('Automatic migration failed integrity verification');return {preserved:true,integrity,snapshots:Number(migrated.one<{count:number}>('SELECT COUNT(*) count FROM snapshots')?.count??0)};
    }finally{migrated?.db.close();original.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
}
