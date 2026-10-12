import {reconcileFolders,type FolderEntry,type FileRevision,type ManifestEntry} from "@gib-sync/protocol";
import {indexedIntentCreates,type VaultIntent} from "./intent-journal";

export function observeLocalFolders(base:readonly FolderEntry[],remote:readonly FolderEntry[],paths:ReadonlySet<string>,intents:readonly VaultIntent[],deviceId:string,deviceName:string):FolderEntry[]{
  const observed:FolderEntry[]=[],claimed=new Set<string>(),latestCreation=new Map([...indexedIntentCreates(intents).values()].filter(event=>event.entity==="folder").map(event=>[event.path,event]));
  const remotePaths=new Map(remote.map(folder=>[folder.path,folder])),revision=(event?:VaultIntent,prior?:FileRevision):FileRevision=>({id:event?.id??prior?.id??crypto.randomUUID(),parentId:prior?.id??null,deviceId,deviceName,modifiedAt:event?.at??Date.now()});
  for(const entry of base){let path=entry.path,last:VaultIntent|undefined;for(const event of intents){if(event.entity!=="folder"||event.kind!=="move"||!event.from)continue;if(path===event.from||path.startsWith(`${event.from}/`)){path=`${event.path}${path.slice(event.from.length)}`;last=event;}}
    if(!paths.has(path))continue;const creation=latestCreation.get(path);if(creation?.kind==="create"&&creation.targetId!==entry.folderId)continue;observed.push({...entry,path,...last?{revision:revision(last,entry.revision)}:{}});claimed.add(path);
  }
  for(const path of paths){if(claimed.has(path))continue;const creation=latestCreation.get(path);if(creation?.kind==="create"&&creation.targetId)observed.push({folderId:creation.targetId,path,revision:revision(creation)});else{const accepted=remotePaths.get(path);observed.push(accepted?{...accepted}:{folderId:crypto.randomUUID(),path,revision:revision()});}}
  return observed;
}

/** Align namespace and content decisions before generic file reconciliation. */
export interface FolderFileCollision<T extends ManifestEntry&{sourcePath?:string}=ManifestEntry&{sourcePath?:string}>{path:string;versions:Array<{side:"base"|"local"|"remote";entry:T;originalPath:string}>;}
export function reconcileAndAlignFolders<T extends ManifestEntry&{sourcePath?:string}>(baseFolders:FolderEntry[],localFolders:FolderEntry[],remoteFolders:FolderEntry[],base:Map<string,T>,local:Map<string,T>,remote:Map<string,T>):ReturnType<typeof reconcileFolders>&{fileCollisions:FolderFileCollision<T>[]}{
  const plan=reconcileFolders({base:baseFolders,local:localFolders,remote:remoteFolders}),selected=new Map(plan.folders.map(folder=>[folder.folderId,folder])),byPath=new Map(plan.folders.map(folder=>[folder.path.normalize("NFC").toLowerCase(),folder])),groups=new Map<string,FolderFileCollision<T>["versions"]>();
  const baseById=new Map(baseFolders.map(folder=>[folder.folderId,folder])),localById=new Map(localFolders.map(folder=>[folder.folderId,folder])),remoteById=new Map(remoteFolders.map(folder=>[folder.folderId,folder]));
  // A deduplicated folder shell still redirects every losing subtree into the
  // common location. Its distinct files are real conflicts, not dropped bytes.
  for(const id of new Set([...baseById.keys(),...localById.keys(),...remoteById.keys()]))if(!selected.has(id)){const list=(entry:FolderEntry|undefined)=>entry?[entry]:[],tentative=reconcileFolders({base:list(baseById.get(id)),local:list(localById.get(id)),remote:list(remoteById.get(id))}).folders[0],canonical=tentative&&byPath.get(tentative.path.normalize("NFC").toLowerCase());if(canonical)selected.set(id,canonical);}
  const align=(folders:FolderEntry[],files:Map<string,T>,side:"base"|"local"|"remote")=>{
    // Longest original prefixes prevent a parent's move from hiding a distinct
    // nested folder rename. The selected folder ID, not its name, is authority.
    const aliases=folders.flatMap(folder=>{const chosen=selected.get(folder.folderId);return chosen&&chosen.path!==folder.path?[{from:folder.path,to:chosen.path}]:[];}).sort((a,b)=>b.from.length-a.from.length),next=new Map<string,T>();
    for(const [original,entry]of files){const alias=aliases.find(item=>original.startsWith(`${item.from}/`)),path=alias?`${alias.to}${original.slice(alias.from.length)}`:original,mapped={...entry,path,...side==="local"&&path!==original?{sourcePath:entry.sourcePath??original}:{}};const versions=groups.get(path)??[];versions.push({side,entry:mapped,originalPath:original});groups.set(path,versions);next.set(path,mapped);}
    files.clear();for(const [path,entry]of next)files.set(path,entry);
  };
  align(baseFolders,base,"base");align(localFolders,local,"local");align(remoteFolders,remote,"remote");const fileCollisions:FolderFileCollision<T>[]=[];
  for(const [path,versions]of groups){const current=versions.filter(version=>version.side!=="base"),identities=new Set(current.map(version=>version.entry.fileId??`${version.originalPath}:${version.entry.hash}`));const namespaceCollision=(["base","local","remote"]as const).some(side=>new Set(versions.filter(version=>version.side===side).map(version=>version.entry.fileId??version.originalPath)).size>1);if(identities.size<2||!namespaceCollision)continue;fileCollisions.push({path,versions});const canonical=current.find(version=>version.side==="remote"&&version.originalPath===path)??current.find(version=>version.side==="remote")??current[0],id=canonical.entry.fileId;for(const [side,map]of [["base",base],["local",local],["remote",remote]]as const){const sameGeneration=versions.find(version=>version.side===side&&version.entry.fileId===id);if(sameGeneration)map.set(path,sameGeneration.entry);else map.delete(path);}}
  return {...plan,fileCollisions};
}
