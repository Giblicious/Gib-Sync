import {randomUUID} from "node:crypto";
import type {ManifestEntry,OperationBatch,Snapshot,SyncOperation} from "@gib-sync/protocol";
import {folderPaths,portablePath,stableUuid,type SyncEntity} from "./operation-state.js";

/** Full legacy manifests become actual causal operations, never a parallel state writer. */
export function bridgeSnapshotBatch(previous:SyncEntity[],snapshot:Pick<Snapshot,"id"|"parentId"|"entries"|"folders"|"folderEntries"|"message">):OperationBatch{
  const active=previous.filter(e=>!e.deleted),files=active.filter(e=>e.kind==="file"),folders=active.filter(e=>e.kind==="folder"),desiredPaths=new Set(snapshot.entries.map(e=>e.path)),desiredByPath=new Map(snapshot.entries.map(entry=>[entry.path,entry])),desiredFolderPaths=folderPaths(snapshot.entries,snapshot.folders),declaredFolders=new Map(snapshot.folderEntries?.map(e=>[e.path,e.folderId]));
  const previousById=new Map(previous.map(e=>[e.id,e])),filesById=new Map(files.map(e=>[e.id,e])),filesByPath=new Map(files.map(e=>[e.path,e])),foldersById=new Map(folders.map(e=>[e.id,e])),foldersByPath=new Map(folders.map(e=>[e.path,e])),hashSourcesByHash=new Map<string,SyncEntity[]>(),hashDestinationCounts=new Map<string,number>(),deletedByPath=new Map<string,SyncEntity>();
  for(const entity of files)if(!desiredPaths.has(entity.path)){const group=hashSourcesByHash.get(entity.hash!)??[];group.push(entity);hashSourcesByHash.set(entity.hash!,group);}
  for(const entry of snapshot.entries)if(!filesByPath.has(entry.path))hashDestinationCounts.set(entry.hash,(hashDestinationCounts.get(entry.hash)??0)+1);
  for(const entity of previous)if(entity.deleted){const key=`${entity.kind}:${portablePath(entity.path)}`,prior=deletedByPath.get(key);if(!prior||entity.sequence>prior.sequence||entity.sequence===prior.sequence&&(entity.ordinal??0)>(prior.ordinal??0))deletedByPath.set(key,entity);}
  const used=new Set<string>(),desiredFiles=snapshot.entries.map(file=>{
    const declared=file.fileId?filesById.get(file.fileId):undefined;
    const hashSources=!file.fileId?hashSourcesByHash.get(file.hash)??[]:[];
    const retainedSource=declared?desiredByPath.get(declared.path):undefined,sourceIsDifferentGeneration=Boolean(retainedSource?.fileId&&retainedSource.fileId!==declared?.id);
    const prior=(declared&&(declared.path===file.path||!retainedSource||sourceIsDifferentGeneration)?declared:undefined)??(!file.fileId?filesByPath.get(file.path):undefined)??(hashSources.length===1&&hashDestinationCounts.get(file.hash)===1?hashSources[0]:undefined);
    const id=prior?.id??(file.fileId&&!previousById.has(file.fileId)?file.fileId:randomUUID());
    if(used.has(id))throw new Error("A file identity cannot occupy two paths");used.add(id);return {...file,fileId:id};
  });
  const movedFolderIds=new Set([...declaredFolders].flatMap(([path,id])=>foldersById.get(id)&&foldersById.get(id)!.path!==path?[id]:[]));
  const desiredFolders=desiredFolderPaths.map(path=>{
    const claimed=declaredFolders.get(path),declared=claimed?foldersById.get(claimed):undefined,candidate=foldersByPath.get(path),byPath=!claimed&&candidate&&!movedFolderIds.has(candidate.id)?candidate:undefined,prior=declared??byPath;
    const id=prior?.id??(claimed&&!previousById.has(claimed)?claimed:randomUUID());if(used.has(id))throw new Error("A folder identity cannot occupy two paths");used.add(id);return {id,path};
  });
  const working=new Map(active.map(e=>[e.id,{...e}])),operations:SyncOperation[]=[],retired=new Map<string,{entity:SyncEntity;operationId:string}>(),base=(entity:SyncEntity)=>({operationId:randomUUID(),targetId:entity.id,baseRevisionId:entity.revision.id});
  const latestDeleted=(path:string,_kind:"file"|"folder")=>{const keys=[`file:${portablePath(path)}`,`folder:${portablePath(path)}`],recent=keys.map(key=>retired.get(key)).filter((value):value is {entity:SyncEntity;operationId:string}=>Boolean(value));if(recent.length)return recent.at(-1);const entity=keys.map(key=>deletedByPath.get(key)).filter((value):value is SyncEntity=>Boolean(value)).sort((a,b)=>b.sequence-a.sequence||(b.ordinal??0)-(a.ordinal??0))[0];return entity?{entity,operationId:undefined}:undefined;};
  for(const entity of files.filter(e=>!used.has(e.id))){const operation={...base(entity),kind:"delete" as const};operations.push(operation);retired.set(`file:${portablePath(entity.path)}`,{entity,operationId:operation.operationId});working.delete(entity.id);}
  // A known new folder generation at an occupied path needs an explicit empty
  // retirement, not a silent reassignment of the earlier folder's identity.
  const replacedPaths=new Set([...desiredFolderPaths,...desiredPaths]);
  for(const entity of folders.filter(e=>!used.has(e.id)&&replacedPaths.has(e.path)).sort((a,b)=>b.path.length-a.path.length)){
    if([...working.values()].some(e=>e.path.startsWith(`${entity.path}/`)))throw new Error("Folder recreation must account for the earlier descendants");
    const operation={...base(entity),kind:"rmdir" as const};operations.push(operation);retired.set(`folder:${portablePath(entity.path)}`,{entity,operationId:operation.operationId});working.delete(entity.id);
  }
  const folderMoves=desiredFolders.filter(folder=>foldersById.has(folder.id)&&foldersById.get(folder.id)!.path!==folder.path).sort((a,b)=>foldersById.get(a.id)!.path.length-foldersById.get(b.id)!.path.length);
  const newFolders=desiredFolders.filter(folder=>!foldersById.has(folder.id)),created=new Set<string>(),workingPaths=new Set([...working.values()].map(e=>portablePath(e.path)));
  const mkdir=(folder:{id:string;path:string})=>{const tombstone=latestDeleted(folder.path,"folder");operations.push(tombstone?{...base(tombstone.entity),kind:"mkdir",newTargetId:folder.id,path:folder.path,...tombstone.operationId?{deletedByOperationId:tombstone.operationId}:{}}:{operationId:randomUUID(),targetId:folder.id,baseRevisionId:null,kind:"mkdir",path:folder.path});created.add(folder.id);working.set(folder.id,{id:folder.id,kind:"folder",path:folder.path,hash:null,size:0,mtime:0,revision:{id:"$new",parentId:null,deviceId:"bridge",deviceName:"Bridge",modifiedAt:0},deleted:false,sequence:0});};
  for(const folder of newFolders.sort((a,b)=>a.path.length-b.path.length||a.path.localeCompare(b.path)))if(!workingPaths.has(portablePath(folder.path))&&!folderMoves.some(move=>folder.path.startsWith(`${foldersById.get(move.id)!.path}/`)))mkdir(folder);
  for(const folder of folderMoves){
    const current=working.get(folder.id)!;if(current.path===folder.path)continue;
    const descendants=[...working.values()].filter(e=>e.path.startsWith(`${current.path}/`));
    operations.push({...base(foldersById.get(folder.id)!),kind:"move-folder",newPath:folder.path,descendants:descendants.map(e=>({targetId:e.id,baseRevisionId:previousById.get(e.id)?.revision.id??e.revision.id}))});
    const oldPath=current.path;for(const child of [current,...descendants])working.set(child.id,{...child,path:child.id===current.id?folder.path:`${folder.path}${child.path.slice(oldPath.length)}`});
  }
  for(const folder of newFolders.filter(folder=>!created.has(folder.id)).sort((a,b)=>a.path.length-b.path.length||a.path.localeCompare(b.path)))mkdir(folder);
  // An accepted generation may move out while a distinct new generation keeps
  // its earlier path. Vacate these proven, unoccupied move destinations before
  // replacement creates, independent of manifest ordering or file extension.
  const workingByPath=new Map([...working.values()].map(entity=>[portablePath(entity.path),entity.id]));
  for(const file of desiredFiles){const current=working.get(file.fileId),original=filesById.get(file.fileId);if(current&&original&&current.path!==file.path&&!workingByPath.has(portablePath(file.path))){operations.push({...base(original),kind:'move',newPath:file.path});workingByPath.delete(portablePath(current.path));workingByPath.set(portablePath(file.path),current.id);working.set(current.id,{...current,path:file.path});}}
  for(const file of desiredFiles){
    const current=working.get(file.fileId),original=filesById.get(file.fileId),content={hash:file.hash,size:file.size,mtime:file.mtime};
    if(!current){const tombstone=latestDeleted(file.path,"file");operations.push(tombstone?{...base(tombstone.entity),kind:"recreate",newTargetId:file.fileId,path:file.path,content,...tombstone.operationId?{deletedByOperationId:tombstone.operationId}:{}}:{operationId:randomUUID(),targetId:file.fileId,baseRevisionId:null,kind:"create",path:file.path,content});}
    else{
      if(current.path!==file.path)operations.push({...base(original!),kind:"move",newPath:file.path});
      if(current.hash!==file.hash||current.size!==file.size)operations.push({...base(original!),kind:"edit",content});
    }
  }
  for(const entity of [...working.values()].filter(e=>e.kind==="folder"&&!used.has(e.id)).sort((a,b)=>b.path.length-a.path.length))operations.push({...base(foldersById.get(entity.id)!),kind:"rmdir"});
  return {batchId:stableUuid(`legacy:${snapshot.id}`),baseSnapshotId:snapshot.parentId,message:snapshot.message,operations};
}
