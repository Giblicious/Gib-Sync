import type {FolderEntry,OperationReceipt,Snapshot} from '@gib-sync/protocol';
import type {Store} from './db.js';
import type {SyncEntity} from './operation-state.js';

export interface BeforeStateEvidence {version:1;snapshotId:string|null;extraEntities:SyncEntity[];}
const revisionEqual=(a:SyncEntity['revision'],b:SyncEntity['revision'])=>a.id===b.id&&a.parentId===b.parentId&&a.deviceId===b.deviceId&&a.deviceName===b.deviceName&&a.modifiedAt===b.modifiedAt;
const entityEqual=(a:SyncEntity,b:SyncEntity)=>a.id===b.id&&a.kind===b.kind&&a.path===b.path&&a.hash===b.hash&&a.size===b.size&&a.mtime===b.mtime&&a.deleted===b.deleted&&revisionEqual(a.revision,b.revision);
function snapshotEntities(snapshot:Snapshot|null,sequence:number):SyncEntity[]{return [
  ...(snapshot?.entries??[]).filter(file=>file.fileId&&file.revision).map(file=>({id:file.fileId!,kind:'file' as const,path:file.path,hash:file.hash,size:file.size,mtime:file.mtime,revision:file.revision!,deleted:false,sequence})),
  ...(snapshot?.folderEntries??[]).map(folder=>({id:folder.folderId,kind:'folder' as const,path:folder.path,hash:null,size:0,mtime:0,revision:folder.revision,deleted:false,sequence}))
];}
/** Compact immutable overlay, including differences caused by a legacy rollback.
 * Presence of an ID in historical JSON alone does not prove its live revision. */
export function captureBeforeState(parent:Snapshot|null,previous:SyncEntity[],snapshotId:string|null):BeforeStateEvidence{
  const rawEntities=snapshotEntities(parent,0),represented=new Map(rawEntities.map(entity=>[entity.id,entity])),counts=new Map<string,number>();for(const entity of rawEntities)counts.set(entity.id,(counts.get(entity.id)??0)+1);
  return {version:1,snapshotId,extraEntities:previous.filter(entity=>{const raw=represented.get(entity.id);return entity.deleted||!raw||counts.get(entity.id)!==1||!entityEqual(raw,entity);})};
}
export function reconstructBeforeState(parent:Snapshot|null,saved:BeforeStateEvidence,sequence:number):SyncEntity[]{
  if(saved.version!==1||saved.snapshotId!==(parent?.id??null)||!Array.isArray(saved.extraEntities)||new Set(saved.extraEntities.map(entity=>entity.id)).size!==saved.extraEntities.length)throw new Error('Immutable before-state evidence differs from its accepted parent');
  const replaced=new Set(saved.extraEntities.map(entity=>entity.id));
  return [...snapshotEntities(parent,sequence).filter(entity=>!replaced.has(entity.id)),...saved.extraEntities];
}
function folderPaths(snapshot:Snapshot):Set<string>{const paths=new Set<string>();for(const path of [...snapshot.folders??[],...snapshot.entries.map(file=>file.path.split('/').slice(0,-1).join('/'))]){const parts=path.split('/').filter(Boolean);for(let index=1;index<=parts.length;index++)paths.add(parts.slice(0,index).join('/'));}return paths;}
function overlay(snapshot:Snapshot,entities:SyncEntity[]):Snapshot|null{
  const live=entities.filter(entity=>!entity.deleted),files=live.filter(entity=>entity.kind==='file'),folders=live.filter(entity=>entity.kind==='folder'),paths=folderPaths(snapshot),byPath=new Map(files.map(entity=>[entity.path,entity]));
  if(files.length!==snapshot.entries.length||byPath.size!==files.length||new Set(live.map(entity=>entity.id)).size!==live.length||folders.length!==paths.size||new Set(folders.map(entity=>entity.path)).size!==folders.length||folders.some(folder=>!paths.has(folder.path))||snapshot.entries.some(file=>{const proof=byPath.get(file.path);return !proof||proof.hash!==file.hash||proof.size!==file.size;}))return null;
  return {...snapshot,entries:snapshot.entries.map(file=>{const proof=byPath.get(file.path)!;return {...file,fileId:proof.id,revision:proof.revision};}),folderEntries:folders.map(folder=>({folderId:folder.id,path:folder.path,revision:folder.revision})).sort((a,b)=>a.path.localeCompare(b.path))};
}
/** Read-only identity view from the exact generation's receipt or immutable
 * before-state. Never borrow identities from a different current generation. */
export function projectSnapshot(store:Store,snapshot:Snapshot):Snapshot{
  const receipt=store.one<{receipt_json:string}>('SELECT receipt_json FROM sync_batches WHERE vault_id=? AND result_snapshot_id=? ORDER BY sequence LIMIT 1',snapshot.vaultId,snapshot.id);
  if(receipt){const recorded=(JSON.parse(receipt.receipt_json) as OperationReceipt).snapshot;if(recorded.id===snapshot.id&&recorded.vaultId===snapshot.vaultId){const view=overlay(snapshot,snapshotEntities(recorded,0));if(view)return view;}}
  const state=store.one<{snapshot_id:string|null}>('SELECT snapshot_id FROM sync_vault_state WHERE vault_id=?',snapshot.vaultId);
  if(state?.snapshot_id===snapshot.id){const entities=store.all<{entity_id:string;entity_kind:'file'|'folder';path:string;hash:string|null;size:number;mtime:number;revision_json:string;deleted:number;sequence:number;mutation_ordinal:number}>('SELECT * FROM sync_entities WHERE vault_id=?',snapshot.vaultId).map(row=>({id:row.entity_id,kind:row.entity_kind,path:row.path,hash:row.hash,size:row.size,mtime:row.mtime,revision:JSON.parse(row.revision_json),deleted:Boolean(row.deleted),sequence:row.sequence,ordinal:row.mutation_ordinal}));const view=overlay(snapshot,entities);if(view)return view;}
  const rows=store.all<{sequence:number;before_state_json:string}>('SELECT sequence,before_state_json FROM sync_batches WHERE vault_id=? AND parent_id=? AND before_state_json IS NOT NULL ORDER BY sequence',snapshot.vaultId,snapshot.id);
  for(const row of rows){const view=overlay(snapshot,reconstructBeforeState(snapshot,JSON.parse(row.before_state_json),row.sequence-1));if(view)return view;}
  return snapshot;
}
export function getSnapshotView(store:Store,id:string):Snapshot|null{const snapshot=store.getSnapshot(id);return snapshot?projectSnapshot(store,snapshot):null;}
export function provenFolders(store:Store,snapshot:Snapshot):FolderEntry[]|null{const projected=projectSnapshot(store,snapshot),paths=folderPaths(snapshot),folders=projected.folderEntries;return folders&&folders.length===paths.size&&new Set(folders.map(folder=>folder.folderId)).size===folders.length&&new Set(folders.map(folder=>folder.path)).size===folders.length&&folders.every(folder=>paths.has(folder.path)&&folder.revision)?folders:null;}
