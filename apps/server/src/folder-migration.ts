import { randomUUID } from "node:crypto";
import type { Snapshot } from "@gib-sync/protocol";
import type { Store } from "./db.js";

const stableFiles=(snapshot:Snapshot)=>snapshot.entries.map(({path,hash,size})=>({path,hash,size})).sort((a,b)=>a.path.localeCompare(b.path));
const sameFiles=(left:Snapshot,right:Snapshot):boolean=>JSON.stringify(stableFiles(left))===JSON.stringify(stableFiles(right));
const folders=(snapshot:Snapshot):Set<string>=>new Set(snapshot.folders??[]);
const externalDevice=(snapshot:Snapshot):boolean=>snapshot.deviceId===`seafile:${snapshot.vaultId}`&&snapshot.deviceName==="Seafile";
const trustedDevice=(snapshot:Snapshot):boolean=>!externalDevice(snapshot)&&!snapshot.deviceId.startsWith("server:");

/**
 * Protocol 7 briefly allowed a legacy readable mirror to seed its empty-folder
 * baseline. That source had no deletion history, so stale empty directories
 * could become authoritative. The signature deliberately requires an exact
 * file manifest and a legacy parent with no folder manifest.
 */
export function unsafeLegacyFolderSeed(snapshot:Snapshot,parent:Snapshot|null):boolean{
  return Boolean(parent&&snapshot.parentId===parent.id&&externalDevice(snapshot)&&Array.isArray(snapshot.folders)&&snapshot.folders.length&&!Array.isArray(parent.folders)&&sameFiles(snapshot,parent));
}

export interface LegacyFolderRepairPlan{
  vaultId:string;
  headId:string;
  originIds:string[];
  contaminatedFolders:string[];
  desiredFolders:string[];
  currentFolders:string[];
  observedAt:string;
}

function currentChain(store:Store,vaultId:string,headId:string):Snapshot[]{
  const reverse:Snapshot[]=[],seen=new Set<string>();let id:string|null=headId;
  while(id){
    if(seen.has(id))throw new Error(`Snapshot ancestry cycle detected for vault ${vaultId}`);seen.add(id);
    const snapshot=store.getSnapshot(id);if(!snapshot||snapshot.vaultId!==vaultId)throw new Error(`Snapshot ancestry is incomplete for vault ${vaultId}`);
    reverse.push(snapshot);id=snapshot.parentId;
  }
  return reverse.reverse();
}

/**
 * Replays folder provenance along the accepted head ancestry. Folders first
 * introduced by the unsafe legacy Seafile seed remain contaminated until a
 * real device explicitly removes and later recreates them. This preserves all
 * post-migration device intent while removing inherited stale shells.
 */
export function planLegacyFolderDescendantRepair(store:Store,vaultId:string,headId:string):LegacyFolderRepairPlan|null{
  const chain=currentChain(store,vaultId,headId),tainted=new Set<string>(),trustedRecreations=new Set<string>(),origins:string[]=[];let previous:Snapshot|null=null;
  for(const snapshot of chain){
    if(unsafeLegacyFolderSeed(snapshot,previous)){
      origins.push(snapshot.id);for(const folder of snapshot.folders??[])tainted.add(folder);previous=snapshot;continue;
    }
    if(tainted.size&&previous&&Array.isArray(previous.folders)&&Array.isArray(snapshot.folders)){
      const before=folders(previous),after=folders(snapshot);
      // Only a real device can establish new folder intent. An external scan
      // may merely be observing a stale directory that the mirror has not yet
      // removed, so its additions never cleanse inherited contamination.
      if(trustedDevice(snapshot))for(const path of after)if(!before.has(path)&&tainted.has(path))trustedRecreations.add(path);
    }
    previous=snapshot;
  }
  const head=chain.at(-1);if(!head||!origins.length||!Array.isArray(head.folders))return null;
  const contaminated=[...tainted].filter((path)=>head.folders!.includes(path)&&!trustedRecreations.has(path)).sort();if(!contaminated.length)return null;
  const contaminatedSet=new Set(contaminated);
  const originSet=new Set(origins),observedAt=chain.filter((snapshot)=>originSet.has(snapshot.id)).map((snapshot)=>snapshot.createdAt).sort().at(-1)!;
  return {vaultId,headId,originIds:origins,contaminatedFolders:contaminated,currentFolders:[...head.folders].sort(),desiredFolders:head.folders.filter((path)=>!contaminatedSet.has(path)).sort(),observedAt};
}

/**
 * A direct unsafe seed may already have been rewound while its readable mirror
 * still contains the observed empty folders. Establish an explicit baseline
 * and carry the exact retired paths to updated clients.
 */
export function planRetiredLegacyFolderRepair(store:Store,vaultId:string,headId:string):LegacyFolderRepairPlan|null{
  const chain=currentChain(store,vaultId,headId),head=chain.at(-1);if(!head||Array.isArray(head.folders))return null;
  const accepted=new Set(chain.map((snapshot)=>snapshot.id)),origins:Snapshot[]=[];
  for(const row of store.all<{id:string}>("SELECT id FROM snapshots WHERE vault_id=?",vaultId)){
    const snapshot=store.getSnapshot(row.id);if(!snapshot||accepted.has(snapshot.id)||!snapshot.parentId||!accepted.has(snapshot.parentId))continue;
    const parent=store.getSnapshot(snapshot.parentId);if(unsafeLegacyFolderSeed(snapshot,parent))origins.push(snapshot);
  }
  if(!origins.length)return null;
  const contaminated=[...new Set(origins.flatMap((snapshot)=>snapshot.folders??[]))].sort();if(!contaminated.length)return null;
  return {vaultId,headId,originIds:origins.map((snapshot)=>snapshot.id).sort(),contaminatedFolders:contaminated,currentFolders:[],desiredFolders:[],observedAt:origins.map((snapshot)=>snapshot.createdAt).sort().at(-1)!};
}

export function repairUnsafeLegacyFolderHeads(store:Store):number{
  let repaired=0;
  for(const vault of store.all<{id:string;head_id:string}>("SELECT id,head_id FROM vaults WHERE head_id IS NOT NULL")){
    const head=store.getSnapshot(vault.head_id),parent=head?.parentId?store.getSnapshot(head.parentId):null;if(!head||!unsafeLegacyFolderSeed(head,parent))continue;
    const now=new Date().toISOString();store.db.exec("BEGIN IMMEDIATE");
    try{
      const updated=store.run("UPDATE vaults SET head_id=? WHERE id=? AND head_id=?",parent!.id,vault.id,head.id);
      if(updated.changes){
        store.run("INSERT INTO health_events(id,vault_id,code,level,message,created_at) VALUES(?,?,?,?,?,?)",randomUUID(),vault.id,"legacy_folder_migration_reverted","warning","An unsafe legacy folder-only migration was retired. The next trusted device sync will establish the folder baseline.",now);repaired++;
      }
      store.db.exec("COMMIT");
    }catch(error){try{store.db.exec("ROLLBACK");}catch{}throw error;}
  }
  return repaired;
}
