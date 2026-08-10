import type { ManifestEntry,Snapshot } from "@gib-sync/protocol";
import type { Config } from "./config.js";
import { openJson,sealJson,sha256 } from "./security.js";
import type { SeafileStorage,VaultStorageRow } from "./seafile.js";

const GENERATION_PATH="readable-generation.gib";

export interface ReadableGeneration{
  version:1;
  vaultId:string;
  snapshotId:string;
  entryCount:number;
  manifestHash:string;
  completedAt:string;
}

export function manifestHash(entries:ManifestEntry[]):string{
  const stable=[...entries].sort((left,right)=>left.path.localeCompare(right.path)).map(({path,hash,size})=>({path,hash,size}));
  return sha256(Buffer.from(JSON.stringify(stable)));
}

export function generationFor(snapshot:Snapshot):ReadableGeneration{
  return {version:1,vaultId:snapshot.vaultId,snapshotId:snapshot.id,entryCount:snapshot.entries.length,manifestHash:manifestHash(snapshot.entries),completedAt:new Date().toISOString()};
}

export function validGeneration(generation:ReadableGeneration|null,snapshot:Snapshot|null):generation is ReadableGeneration{
  return Boolean(generation&&snapshot&&generation.version===1&&generation.vaultId===snapshot.vaultId&&generation.snapshotId===snapshot.id&&generation.entryCount===snapshot.entries.length&&generation.manifestHash===manifestHash(snapshot.entries));
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
