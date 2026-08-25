import type { ManifestEntry,Snapshot } from "@gib-sync/protocol";
import type { Config } from "./config.js";
import { openJson,sealJson,sha256 } from "./security.js";
import type { SeafileStorage,VaultStorageRow } from "./seafile.js";

const GENERATION_PATH="readable-generation.gib";

export interface ReadableGeneration{
  version:2;
  vaultId:string;
  snapshotId:string;
  entryCount:number;
  folderCount:number;
  manifestHash:string;
  completedAt:string;
}

function foldersFor(snapshot:Snapshot):string[]{
  const folders=new Set<string>(),add=(parts:string[])=>{let current="";for(const part of parts){current=current?`${current}/${part}`:part;folders.add(current);}};for(const folder of snapshot.folders??[])add(folder.split("/").filter(Boolean));for(const entry of snapshot.entries)add(entry.path.split("/").slice(0,-1));
  return [...folders].sort();
}

export function manifestHash(entries:ManifestEntry[],folders:string[]=[]):string{
  const stable=[...entries].sort((left,right)=>left.path.localeCompare(right.path)).map(({path,hash,size})=>({path,hash,size}));
  return sha256(Buffer.from(JSON.stringify({entries:stable,folders:[...new Set(folders)].sort()})));
}

export function generationFor(snapshot:Snapshot):ReadableGeneration{
  const folders=foldersFor(snapshot);return {version:2,vaultId:snapshot.vaultId,snapshotId:snapshot.id,entryCount:snapshot.entries.length,folderCount:folders.length,manifestHash:manifestHash(snapshot.entries,folders),completedAt:new Date().toISOString()};
}

export function validGeneration(generation:ReadableGeneration|null,snapshot:Snapshot|null):generation is ReadableGeneration{
  if(!generation||!snapshot||generation.version!==2)return false;const folders=foldersFor(snapshot);
  return generation.vaultId===snapshot.vaultId&&generation.snapshotId===snapshot.id&&generation.entryCount===snapshot.entries.length&&generation.folderCount===folders.length&&generation.manifestHash===manifestHash(snapshot.entries,folders);
}

export async function readGeneration(config:Config,storage:SeafileStorage,row:VaultStorageRow):Promise<ReadableGeneration|null>{
  try{
    const bytes=await storage.get(row,GENERATION_PATH);
    return openJson<ReadableGeneration>(new TextDecoder().decode(bytes),config.GIBSYNC_SERVER_SECRET,`readable-generation:${row.id}`);
  }catch{return null;}
}

export async function writeGeneration(config:Config,storage:SeafileStorage,row:VaultStorageRow,snapshot:Snapshot):Promise<ReadableGeneration>{
  const generation=generationFor(snapshot),sealed=sealJson(generation,config.GIBSYNC_SERVER_SECRET,`readable-generation:${row.id}`);
  await storage.put(row,GENERATION_PATH,Buffer.from(sealed),"application/octet-stream");
  const verified=await readGeneration(config,storage,row);
  if(!validGeneration(verified,snapshot))throw new Error("Readable mirror completion marker could not be verified");
  return verified;
}
