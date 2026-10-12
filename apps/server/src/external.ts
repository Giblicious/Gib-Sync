import { detectMoves,planReconciliation,mergeJsonValues,reconciliationStrategy,reconcileFolders,selectPluginPackage,MAX_SETTINGS_JSON_BYTES,type ManifestEntry,type Snapshot,type PluginPackageEvidence,type FolderEntry } from "@gib-sync/protocol";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { mergeText } from "./merge.js";
import { mergeSystemJson } from "./system-merge.js";
import { sha256 } from "./security.js";
import {VerifiedBlobStore} from "./blob-store.js";
import {SERVER_INLINE_BYTES} from "./security-stream.js";
import { SeafileStorage,type ReadableStorageEntry,type VaultStorageRow } from "./seafile.js";
import { SafeguardService } from "./safeguards.js";
import { canonicalManifest } from "./manifest.js";
import { SnapshotCommitter } from "./snapshot-commit.js";
import {ReconciliationRollout} from "./reconciliation-rollout.js";
import {randomUUID} from "node:crypto";
import {ConflictInbox,type ConflictRecord} from "./conflict-inbox.js";
import {stableUuid,getSyncTree,provenSnapshotFolders} from "./operation-state.js";
import {normalizeAliasEntries,normalizeAliasFolders,normalizeAliasPath,aliasCollisionRecords} from "./config-roots.js";
import {isReservedSyncPath} from "./reserved-paths.js";
import {getSnapshotView} from './snapshot-evidence.js';
import {alignExternalNamespace,type NamespaceCollision} from './external-namespace.js';
import {externalCreationProofs} from './external-provenance.js';

type MirrorEntry={path:string;hash:string;size:number;updated_at:string;storage_id:string|null;storage_mtime:number|null};
export interface ExternalImportResult{snapshotId:string|null;changedFiles:number;deletedFiles:number;conflicts:number;changedFolders?:number;quarantineId?:string;locked?:boolean;deferredDeletions?:number;mirrorGenerationMismatch?:boolean;contained?:boolean;}

const textExtensions=new Set(["md","txt","canvas","json","jsonl","css","js","ts","yaml","yml","xml","csv","svg","html"]);
const decoder=new TextDecoder(),encoder=new TextEncoder();
const DELETION_CONFIRMATION_MS=15_000;

function folderSet(snapshot:Snapshot|null):Set<string>{
  const folders=new Set<string>(),add=(parts:string[])=>{let current="";for(const part of parts){current=current?`${current}/${part}`:part;folders.add(current);}};for(const folder of snapshot?.folders??[])add(folder.split("/").filter(Boolean));for(const entry of snapshot?.entries??[])add(entry.path.split("/").slice(0,-1));return folders;
}

export class ExternalImporter{
  private readonly jobs=new Map<string,Promise<ExternalImportResult>>();
  private tail:Promise<void>=Promise.resolve();
  private readonly committer:SnapshotCommitter;
  private readonly blobs:VerifiedBlobStore;
  private conflictRecords:ConflictRecord[]=[];
  private configAliases:string[]=[];
  constructor(private readonly config:Config,private readonly store:Store,private readonly storage:SeafileStorage,private readonly safeguards?:SafeguardService,private readonly canOperate:(vaultId:string)=>boolean=()=>true){this.committer=new SnapshotCommitter(store,storage,(vaultId)=>this.storageRow(vaultId));this.blobs=new VerifiedBlobStore(config,store,storage);}
  async settle():Promise<void>{await Promise.allSettled([...this.jobs.values()]);}
  async settleVault(vaultId:string):Promise<void>{const job=this.jobs.get(vaultId);if(job)await Promise.allSettled([job]);}

  scan(vaultId:string,fresh=false):Promise<ExternalImportResult>{
    const active=this.jobs.get(vaultId);if(active)return fresh?active.then(()=>this.scan(vaultId)):active;
    const job=this.tail.then(()=>this.run(vaultId)).catch((error)=>{
      this.store.run("UPDATE vaults SET external_scan_at=?,external_error=? WHERE id=?",new Date().toISOString(),error instanceof Error?error.message:String(error),vaultId);
      throw error;
    }).finally(()=>this.jobs.delete(vaultId));
    this.jobs.set(vaultId,job);this.tail=job.then(()=>{},()=>{});return job;
  }

  private storageRow(vaultId:string):VaultStorageRow{
    const row=this.store.one<VaultStorageRow>("SELECT id,storage_url,storage_username,storage_repo_id,storage_repo_name,storage_base_path,storage_token,storage_layout,mirror_base_path,mirror_head_id FROM vaults WHERE id=?",vaultId);
    if(!row?.storage_url||!row.storage_token)throw new Error("Vault storage is not configured");
    return row;
  }

  private async clear(row:VaultStorageRow,entry:ManifestEntry):Promise<Uint8Array>{return this.blobs.readSmall(row,entry.hash);}
  private mergeable(...entries:Array<{size:number}|undefined>):boolean{return entries.every(entry=>!entry||entry.size<=SERVER_INLINE_BYTES);}

  private conflictPath(path:string,deviceName:string,mtime:number,occupied:Set<string>):string{
    const index=path.lastIndexOf("."),slash=path.lastIndexOf("/");
    const device=deviceName.replace(/[\\/:*?"<>|\[\]#]/g,"-").replace(/\s+/g," ").trim().slice(0,40)||"Unknown device";
    const date=new Date(Number.isFinite(mtime)&&mtime>0?mtime:Date.now());
    const stamp=(Number.isNaN(date.getTime())?new Date():date).toISOString().replace("T"," ").replace(/\.\d{3}Z$/," UTC").replace(/:/g,"-");
    const stem=index>slash?path.slice(0,index):path,extension=index>slash?path.slice(index):"";
    let candidate=`${stem} (conflict - ${device} - ${stamp})${extension}`,sequence=2;
    while(occupied.has(candidate))candidate=`${stem} (conflict - ${device} - ${stamp} - ${sequence++})${extension}`;
    return candidate;
  }

  private wikiLink(path:string):string{
    const target=path.toLowerCase().endsWith(".md")?path.slice(0,-3):path;
    return `[[${target.replace(/\|/g," ")}|${path.slice(path.lastIndexOf("/")+1)}]]`;
  }

  private warning(text:string,devices:string[],otherPath:string):string{
    return `> [!warning] Gib Sync conflict\n> Gib Sync preserved overlapping versions from **${devices.join("** and **")}**. No content was discarded.\n> Review the other version: ${this.wikiLink(otherPath)}\n\n${text}`;
  }

  private async preserveDeletion(row:VaultStorageRow,path:string,entry:ManifestEntry,editor:string,deleter:string,final:Map<string,ManifestEntry>):Promise<void>{
    const preserved=path.toLowerCase().endsWith(".md")?await this.blobs.prepend(row,entry.hash,`> [!warning] Gib Sync deletion conflict\n> **${deleter}** deleted this note while **${editor}** modified it. Gib Sync kept the modified content here; delete this note if the deletion was intended.\n\n`):entry;
    final.set(path,{...entry,path,hash:preserved.hash,size:preserved.size,mtime:Date.now()});
    this.conflictRecords.push({id:randomUUID(),originSnapshotId:null,path,createdAt:new Date().toISOString(),reason:`${deleter} deleted a concurrently edited file`,state:"open",versions:[{id:randomUUID(),label:"Preserved edit",path,hash:entry.hash,size:entry.size,deviceName:editor,annotatedPath:path,annotatedHash:preserved.hash},{id:randomUUID(),label:"Deletion",path,hash:null,size:0,deleted:true,deviceName:deleter}]});
  }

  private async preservePair(row:VaultStorageRow,path:string,current:ManifestEntry,external:ManifestEntry,currentName:string,preferred:"current"|"external",final:Map<string,ManifestEntry>,occupied:Set<string>):Promise<void>{
    const currentIsNewer=preferred==="current",loser=currentIsNewer?external:current;
    const winner=currentIsNewer?current:external;
    const loserName=currentIsNewer?"Seafile":currentName,copyPath=this.conflictPath(path,loserName,loser.mtime,occupied);occupied.add(copyPath);
    let original=winner,copy=loser;
    if(path.toLowerCase().endsWith(".md")){
      const names=[currentName,"Seafile"];
      original={...winner,...await this.blobs.prepend(row,winner.hash,this.warning("",names,copyPath))};
      copy={...loser,...await this.blobs.prepend(row,loser.hash,this.warning("",names,path))};
    }
    const originalHash=original.hash,copyHash=copy.hash;
    // Unknown generations must not inherit an occupied accepted path's identity
    // via the legacy bridge. These fresh proposal IDs are never move evidence;
    // the same preserved proposal retries with exactly the same identities.
    const parent=this.store.one<{head_id:string|null}>('SELECT head_id FROM vaults WHERE id=?',row.id)?.head_id,winnerId=winner.fileId??stableUuid(`${row.id}:${parent}:conflict:${path}:winner:${winner.hash}:${winner.mtime}`),loserId=loser.fileId&&loser.fileId!==winnerId?loser.fileId:stableUuid(`${row.id}:${parent}:conflict:${path}:copy:${loser.hash}:${loser.mtime}`);
    final.set(path,{...winner,fileId:winnerId,path,hash:originalHash,size:original.size,mtime:Date.now()});
    final.set(copyPath,{...loser,fileId:loserId,path:copyPath,hash:copyHash,size:copy.size,mtime:Date.now()});
    this.conflictRecords.push({id:randomUUID(),originSnapshotId:null,path,createdAt:new Date().toISOString(),reason:"Independent overlapping versions were preserved",state:"open",versions:[
      {id:randomUUID(),label:"Accepted version",path,hash:current.hash,size:current.size,deviceName:currentName,annotatedPath:currentIsNewer?path:copyPath,annotatedHash:currentIsNewer?originalHash:copyHash},
      {id:randomUUID(),label:"Seafile edit",path,hash:external.hash,size:external.size,deviceName:"Seafile",annotatedPath:currentIsNewer?copyPath:path,annotatedHash:currentIsNewer?copyHash:originalHash}
    ]});
  }

  private text(path:string):boolean{return textExtensions.has(path.split(".").pop()?.toLowerCase()??"");}
  private async preserveNamespaceCollision(row:VaultStorageRow,collision:NamespaceCollision,final:Map<string,ManifestEntry>,occupied:Set<string>):Promise<void>{
    const path=collision.path,current=collision.versions.filter(version=>version.side!=='base'),canonical=current.find(version=>version.side==='accepted'&&version.sourcePath===path)??current.find(version=>version.side==='accepted')??current[0]!,unique=new Map<string,typeof canonical>();
    for(const version of current){const key=`${version.entry.fileId??version.sourcePath}:${version.entry.hash}`,prior=unique.get(key);if(!prior||version.side==='accepted')unique.set(key,version);}
    const key=`${canonical.entry.fileId??canonical.sourcePath}:${canonical.entry.hash}`,versions=[unique.get(key)!,...[...unique].filter(([candidate])=>candidate!==key).sort(([a],[b])=>a.localeCompare(b)).map(([,version])=>version)],deep=reconciliationStrategy(normalizeAliasPath(path,this.configAliases))!=='text',targets=versions.map((version,index)=>{if(index===0||deep)return path;const target=this.conflictPath(path,version.entry.revision?.deviceName??(version.side==='external'?'Seafile':'Earlier device'),version.entry.mtime,occupied);occupied.add(target);return target;}),names=versions.map(version=>`${version.entry.revision?.deviceName??(version.side==='external'?'Seafile':'Earlier device')} · ${version.sourcePath}`),prefix=!deep&&path.toLowerCase().endsWith('.md')?`> [!warning] Gib Sync conflict\n> Separate folders converged onto this location. Every complete version was preserved from **${names.join('** and **')}**.\n> Preserved notes: ${targets.map(target=>this.wikiLink(target)).join(', ')}\n\n`:'',usedIds=new Set<string>(),sides:ConflictRecord['versions']=[],parent=this.store.one<{head_id:string|null}>('SELECT head_id FROM vaults WHERE id=?',row.id)?.head_id;
    for(let index=0;index<versions.length;index++){const version=versions[index]!,entry=version.entry,target=targets[index]!,preserved=prefix?await this.blobs.prepend(row,entry.hash,prefix):entry;
      if(index===0||!deep){const id=entry.fileId&&!usedIds.has(entry.fileId)?entry.fileId:stableUuid(`${row.id}:${parent}:namespace-conflict:${path}:${version.sourcePath}:${entry.fileId??'unknown'}:${entry.hash}:${entry.mtime}`);usedIds.add(id);final.set(target,{...entry,fileId:id,path:target,hash:preserved.hash,size:preserved.size,mtime:Date.now()});}
      sides.push({id:randomUUID(),label:names[index]!.slice(0,100),path:version.sourcePath,hash:entry.hash,size:entry.size,deviceName:entry.revision?.deviceName??(version.side==='external'?'Seafile':'Earlier device'),revisionId:entry.revision?.id,annotatedPath:target,annotatedHash:final.get(target)!.hash});
    }
    this.conflictRecords.push({id:randomUUID(),originSnapshotId:null,path,createdAt:new Date().toISOString(),reason:'Folders converged onto the same location; every distinct file generation was preserved',state:'open',actionRequired:!deep,versions:sides});
  }
  private systemJson(path:string):boolean{return path.replace(/\\/g,"/").toLowerCase().startsWith(".obsidian/")&&path.toLowerCase().endsWith(".json");}
  private retainDeepChoice(path:string,current:ManifestEntry,external:ManifestEntry,selected:ManifestEntry,reason:string):void{
    this.conflictRecords.push({id:randomUUID(),originSnapshotId:null,path,createdAt:new Date().toISOString(),reason,state:"open",actionRequired:false,versions:[{id:randomUUID(),label:"Accepted settings",path,hash:current.hash,size:current.size,deviceName:current.revision?.deviceName??"Earlier device",annotatedPath:path,annotatedHash:selected.hash},{id:randomUUID(),label:"Seafile settings",path,hash:external.hash,size:external.size,deviceName:"Seafile",annotatedPath:path,annotatedHash:selected.hash}]});
  }
  private async applyDeepPolicy(row:VaultStorageRow,path:string,current:ManifestEntry,external:ManifestEntry,base:{hash:string;size:number}|undefined,preferred:"current"|"external",final:Map<string,ManifestEntry>,newBytes:Map<string,Uint8Array>):Promise<boolean>{
    const strategy=reconciliationStrategy(normalizeAliasPath(path,this.configAliases));if(strategy==="text")return false;
    let selected={...(preferred==="external"?external:current),path},ambiguous=current.hash!==external.hash;
    if(strategy==="json-settings"&&[current,external,base].every(entry=>!entry||entry.size<=MAX_SETTINGS_JSON_BYTES)){
      const baselineBytes=base?await this.clear(row,{path,hash:base.hash,size:base.size,mtime:0}):null,localBytes=await this.clear(row,current),remoteBytes=await this.clear(row,external);
      try{const original=baselineBytes?JSON.parse(decoder.decode(baselineBytes)):undefined,local=JSON.parse(decoder.decode(localBytes)),remote=JSON.parse(decoder.decode(remoteBytes)),merged=mergeJsonValues(original,local,remote,preferred==="current",path.endsWith("/bookmarks.json")?"bookmarks":undefined),bytes=encoder.encode(`${JSON.stringify(merged.value,null,2)}\n`);if(bytes.length>MAX_SETTINGS_JSON_BYTES)throw new Error("Merged settings exceed bounded JSON budget");const hash=sha256(bytes);newBytes.set(hash,bytes);selected={...current,path,hash,size:bytes.length,mtime:Date.now()};ambiguous=merged.overlaps>0;}
      catch{/* Invalid or oversized deep settings use a recoverable whole-file choice. */}
    }
    final.set(path,selected);if(ambiguous)this.retainDeepChoice(path,current,external,selected,"Concurrent settings/package versions were resolved without creating deep conflict files; both immutable originals remain available");return true;
  }

  private async run(vaultId:string):Promise<ExternalImportResult>{
    this.conflictRecords=[];
    this.configAliases=this.store.all<{config_root:string}>("SELECT config_root FROM vault_config_aliases WHERE vault_id=?",vaultId).map(row=>row.config_root);
    if(!this.canOperate(vaultId))return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,contained:true};
    const row=this.storageRow(vaultId),vault=this.store.one<{head_id:string|null;mirror_head_id:string|null;mirror_generation_id:string|null;wrapped_key:string}>("SELECT head_id,mirror_head_id,mirror_generation_id,wrapped_key FROM vaults WHERE id=?",vaultId)!;
    // This signed marker is Gib Sync's committed last-sync database. Safe
    // creations and edits can still be imported while a newer generation is
    // being written, but absence is deletion evidence only for a path that
    // existed in a successfully completed generation.
    const generationSnapshot=vault.mirror_generation_id?getSnapshotView(this.store,vault.mirror_generation_id):null,generationCurrent=Boolean(generationSnapshot&&vault.mirror_generation_id===vault.mirror_head_id),mirrorCurrent=Boolean(generationCurrent&&vault.head_id===vault.mirror_head_id),head=vault.head_id?getSnapshotView(this.store,vault.head_id):null,folderImportAllowed=Boolean(mirrorCurrent&&Array.isArray(head?.folders));
    const completedEntries=new Map((generationSnapshot?.entries??[]).map((entry)=>[entry.path,entry]));
    this.store.run("UPDATE vaults SET trusted_until=NULL,trusted_device_id=NULL WHERE id=? AND trusted_device_id=?",vaultId,`seafile:${vaultId}`);
    const readableTree=await this.storage.listReadableTree(row),remote=readableTree.files.filter(entry=>!isReservedSyncPath(entry.path,this.configAliases)),remoteFolders=new Set(readableTree.folders.filter(path=>!isReservedSyncPath(path,this.configAliases))),headFolders=folderSet(head);
    const repoBaseline=this.store.one<{mirror_repo_commit:string|null}>("SELECT mirror_repo_commit FROM vaults WHERE id=?",vaultId)?.mirror_repo_commit,events=repoBaseline&&typeof this.storage.readableEvents==="function"?await this.storage.readableEvents(row,repoBaseline):[],creations=externalCreationProofs(events,[...completedEntries.keys(),...headFolders]),recreated=new Set([...creations].filter(([,proof])=>proof.recreated).map(([path])=>path));
    const localFolders=getSyncTree(this.store,vaultId).folders,baseFolders:FolderEntry[]=provenSnapshotFolders(this.store,vaultId,generationSnapshot)??[];
    const provenFolders=baseFolders.map(folder=>{let path=folder.path,lastMove:number|null=null;for(const event of events)if(event.operation==="renamed"&&event.previousPath&&(path===event.previousPath||path.startsWith(`${event.previousPath}/`))){path=`${event.path}${path.slice(event.previousPath.length)}`;lastMove=event.mtime;}const creation=creations.get(path),fresh=creation?.recreated;return {...folder,path,...fresh?{folderId:stableUuid(`${vaultId}:seafile-folder-create:${creation.commitId}:${creation.originPath}`)}:{},revision:lastMove!==null?{...folder.revision,modifiedAt:lastMove}:folder.revision};}),remoteFolderEntries:FolderEntry[]=provenFolders.filter(folder=>remoteFolders.has(folder.path)||!folderImportAllowed),knownRemoteFolders=new Set(remoteFolderEntries.map(folder=>folder.path));
    if(folderImportAllowed)for(const path of remoteFolders)if(!knownRemoteFolders.has(path)){const proof=creations.get(path),id=stableUuid(`${vaultId}:seafile-folder-create:${proof?.commitId??repoBaseline}:${proof?.originPath??path}`);remoteFolderEntries.push({path,folderId:id,revision:{id:stableUuid(`${id}:revision`),parentId:null,deviceId:`seafile:${vaultId}`,deviceName:"Seafile",modifiedAt:proof?.mtime??Date.now()}});}
    const folderPlan=reconcileFolders({base:baseFolders,local:localFolders,remote:remoteFolderEntries,acceptedSide:'local'});
    if(remote.length>200_000)throw new Error("Readable Seafile vault exceeds 200,000 files");
    const remoteByPath=new Map(remote.map((entry)=>[entry.path,entry]));
    const mirrored=new Map(this.store.all<MirrorEntry>("SELECT path,hash,size,updated_at,storage_id,storage_mtime FROM mirror_entries WHERE vault_id=?",vaultId).map((entry)=>[entry.path,entry]));
    const candidates=remote.filter((entry)=>{const previous=mirrored.get(entry.path);return recreated.has(entry.path)||!previous||previous.storage_id!==entry.id||previous.storage_mtime!==entry.mtime||previous.size!==entry.size;});
    const archived=this.store.all<{path:string;revision_id:string;hash:string;size:number;mtime:number}>("SELECT path,revision_id,hash,size,mtime FROM external_revisions WHERE vault_id=? AND imported_at IS NULL ORDER BY causal_order DESC,mtime DESC,revision_id",vaultId).filter(entry=>!isReservedSyncPath(entry.path,this.configAliases)),archiveByPath=new Map<string,(typeof archived)[number]>();
    for(const revision of archived)if(!archiveByPath.has(revision.path))archiveByPath.set(revision.path,revision);
    const missingAll=[...mirrored.values()].filter((entry)=>!remoteByPath.has(entry.path));
    const scannedAt=new Date().toISOString();
    const observations=new Map<string,string>();
    const archivedFolders=this.store.all<{path:string;revision_id:string}>("SELECT path,revision_id FROM external_folder_revisions WHERE vault_id=? AND imported_at IS NULL",vaultId);
    const consumeFolders=()=>{for(const entry of archivedFolders)this.store.run("UPDATE external_folder_revisions SET imported_at=? WHERE vault_id=? AND path=? AND revision_id=? AND imported_at IS NULL",scannedAt,vaultId,entry.path,entry.revision_id);};
    const consumeArchive=(path:string)=>{for(const revision of archived)if(revision.path===path)this.store.run("UPDATE external_revisions SET imported_at=? WHERE vault_id=? AND path=? AND revision_id=? AND imported_at IS NULL",scannedAt,vaultId,path,revision.revision_id);const observation=observations.get(path);if(observation)this.store.run("UPDATE external_revisions SET imported_at=? WHERE vault_id=? AND path=? AND revision_id=? AND imported_at IS NULL",scannedAt,vaultId,path,observation);};
    for(const absence of this.store.all<{path:string}>("SELECT path FROM external_absences WHERE vault_id=?",vaultId))if(remoteByPath.has(absence.path))this.store.run("DELETE FROM external_absences WHERE vault_id=? AND path=?",vaultId,absence.path);
    const observedFolderChange=folderImportAllowed&&([...remoteFolders].some((folder)=>!headFolders.has(folder)||recreated.has(folder))||[...headFolders].some((folder)=>!remoteFolders.has(folder)));
    if(!candidates.length&&!missingAll.length&&!observedFolderChange&&!archiveByPath.size&&!archivedFolders.length){
      this.store.run("UPDATE vaults SET external_scan_at=?,external_error=NULL WHERE id=?",scannedAt,vaultId);
      return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,mirrorGenerationMismatch:!generationCurrent||vault.head_id!==vault.mirror_head_id};
    }

    const mergeBase=(path:string):MirrorEntry|undefined=>{
      if(mirrorCurrent)return mirrored.get(path);
      const completed=completedEntries.get(path);
      return completed?{path:completed.path,hash:completed.hash,size:completed.size,updated_at:generationSnapshot?.createdAt??"",storage_id:null,storage_mtime:completed.mtime/1000}:undefined;
    };
    const headByPath=new Map(head?.entries.map(entry=>[entry.path,entry])),headById=new Map(head?.entries.filter(entry=>entry.fileId).map(entry=>[entry.fileId!,entry]));
    const externalPreferred=(entry:ManifestEntry):"current"|"external"=>{const accepted=(entry.fileId?headById.get(entry.fileId):undefined)??headByPath.get(entry.path);return entry.mtime>=(accepted?.revision?.modifiedAt??accepted?.mtime??0)?"external":"current";};
    const final=new Map((head?.entries??[]).map((entry)=>[entry.path,{...entry}])),occupied=new Set(final.keys());
    const persistBytes=async(hash:string,bytes:Uint8Array)=>{if(this.store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?",vaultId,hash))return;if(!this.canOperate(vaultId))throw new Error("Vault was paused before external content preservation");const file=await this.blobs.staging.fromChunks((async function*(){yield bytes;})(),this.config.MAX_BLOB_BYTES);try{if(file.hash!==hash)throw new Error("Generated content hash changed before preservation");await this.blobs.persist(row,file);}finally{await file.dispose();}};
    // Candidate bodies are durably preserved one at a time. A large external
    // batch keeps only its manifest metadata in memory, never all file bodies.
    const downloaded=new Map<string,{metadata:ReadableStorageEntry;hash:string;archiveRevision?:string;consumeArchived?:boolean}>();
    for(const metadata of candidates){
      if(metadata.size>this.config.MAX_BLOB_BYTES)throw new Error(`External file exceeds the Gib Sync size limit: ${metadata.path}`);
      const file=await this.blobs.readable(row,metadata.path);try{const hash=file.hash;if(!this.canOperate(vaultId))throw new Error("Vault was paused before external content preservation");await this.blobs.persist(row,file);const observation=`visible:${metadata.id}:${metadata.mtime}:${hash}:${vault.head_id??"none"}`;this.store.run("INSERT OR IGNORE INTO external_revisions(vault_id,path,revision_id,hash,size,observed_at,source,mtime,causal_order) VALUES(?,?,?,?,?,?,?,?,?)",vaultId,metadata.path,observation,hash,file.size,scannedAt,"external-observation",metadata.mtime*1000,`${scannedAt}:000000`);observations.set(metadata.path,observation);downloaded.set(metadata.path,{metadata:{...metadata,size:file.size},hash});}finally{await file.dispose();}
    }
    for(const revision of archiveByPath.values()){
      const live=downloaded.get(revision.path),accepted=head?.entries.find((entry)=>entry.path===revision.path);
      if(live&&live.hash!==accepted?.hash&&live.metadata.mtime*1000>=revision.mtime){live.consumeArchived=true;continue;}
      downloaded.set(revision.path,{metadata:{path:revision.path,id:revision.revision_id,mtime:revision.mtime/1000,size:revision.size},hash:revision.hash,archiveRevision:revision.revision_id});
    }

    const nextReadable=new Map<string,ManifestEntry>([...mirrored.values()].map((entry)=>[entry.path,{path:entry.path,hash:entry.hash,size:entry.size,mtime:(entry.storage_mtime??0)*1000}]));
    for(const missing of missingAll)nextReadable.delete(missing.path);
    for(const [path,item] of downloaded)nextReadable.set(path,{path,hash:item.hash,size:item.metadata.size,mtime:item.metadata.mtime*1000});
    const deletedPaths=new Set(missingAll.map((entry)=>entry.path)),externalMoves=detectMoves([...mirrored.values()].map((entry)=>({path:entry.path,hash:entry.hash,size:entry.size,mtime:(entry.storage_mtime??0)*1000})),[...nextReadable.values()],"identity")
      .filter((move)=>deletedPaths.has(move.previousPath)&&downloaded.has(move.path)&&completedEntries.get(move.previousPath)?.hash===mirrored.get(move.previousPath)?.hash);
    const externalSources=new Map<string,string>();
    const externalFile=(path:string,item:(typeof downloaded extends Map<string,infer T>?T:never),source=externalSources.get(item.metadata.path)??item.metadata.path):ManifestEntry=>{const original=completedEntries.get(source),creation=creations.get(item.metadata.path),fresh=creation&&(creation.recreated||!original);return {path,hash:item.hash,size:item.metadata.size,mtime:item.metadata.mtime*1000,...fresh?{fileId:stableUuid(`${vaultId}:seafile-file-create:${creation.commitId}:${creation.originPath}`)}:original?.fileId?{fileId:original.fileId,revision:original.revision}:{}};};
    if(repoBaseline&&missingAll.length&&downloaded.size){
      const renames=await this.storage.readableRenames(row,repoBaseline),destinations=new Map<string,string>();
      for(const source of mirrored.keys()){let destination=source;for(const rename of renames){if(destination===rename.previousPath)destination=rename.path;else if(destination.startsWith(`${rename.previousPath}/`))destination=`${rename.path}${destination.slice(rename.previousPath.length)}`;}if(destination!==source)destinations.set(source,destination);}
      const claimedSources=new Set(externalMoves.map((move)=>move.previousPath)),claimedTargets=new Set(externalMoves.map((move)=>move.path));
      for(const [previousPath,path] of destinations){if(claimedSources.has(previousPath)||claimedTargets.has(path)||!deletedPaths.has(previousPath)||!downloaded.has(path)||completedEntries.get(previousPath)?.hash!==mirrored.get(previousPath)?.hash)continue;externalMoves.push({previousPath,path});claimedSources.add(previousPath);claimedTargets.add(path);}
    }
    const movedSources=new Set(externalMoves.map((move)=>move.previousPath)),deleted:MirrorEntry[]=[];let deferredDeletions=0;
    for(const missing of missingAll){
      if(movedSources.has(missing.path)){deleted.push(missing);this.store.run("DELETE FROM external_absences WHERE vault_id=? AND path=?",vaultId,missing.path);continue;}
      const completed=completedEntries.get(missing.path);
      // A path written only into the mutable/incomplete mirror database was
      // never proven visible in Seafile. Its absence is an interrupted upload,
      // not an external deletion, so reconciliation must be allowed to resume.
      if(!completed||completed.hash!==missing.hash){this.store.run("DELETE FROM external_absences WHERE vault_id=? AND path=?",vaultId,missing.path);continue;}
      const previous=this.store.one<{hash:string;mirror_head_id:string;first_seen_at:string;observations:number}>("SELECT hash,mirror_head_id,first_seen_at,observations FROM external_absences WHERE vault_id=? AND path=?",vaultId,missing.path),same=previous?.hash===missing.hash&&previous.mirror_head_id===(vault.mirror_head_id??"");
      const firstSeen=same?previous.first_seen_at:scannedAt,observations=same?(previous.observations+1):1;
      this.store.run("INSERT INTO external_absences(vault_id,path,hash,mirror_head_id,first_seen_at,last_seen_at,observations) VALUES(?,?,?,?,?,?,?) ON CONFLICT(vault_id,path) DO UPDATE SET hash=excluded.hash,mirror_head_id=excluded.mirror_head_id,first_seen_at=excluded.first_seen_at,last_seen_at=excluded.last_seen_at,observations=excluded.observations",vaultId,missing.path,missing.hash,vault.mirror_head_id??"",firstSeen,scannedAt,observations);
      const confirmed=observations>=2&&Date.parse(firstSeen)<=Date.now()-DELETION_CONFIRMATION_MS;
      if(confirmed)deleted.push(missing);else deferredDeletions++;
    }
    for(const move of externalMoves)externalSources.set(move.path,move.previousPath);
    const rawBase=new Map<string,ManifestEntry>();for(const path of new Set([...mirrored.keys(),...downloaded.keys(),...final.keys()])){const baseline=mergeBase(path);if(baseline)rawBase.set(path,{...completedEntries.get(path),path,hash:baseline.hash,size:baseline.size,mtime:0});}
    const rawIncoming=new Map(rawBase);for(const missing of deleted)rawIncoming.delete(missing.path);for(const [path,item] of downloaded)rawIncoming.set(path,externalFile(path,item));
    const namespace=alignExternalNamespace({baseFolders,acceptedFolders:localFolders,externalFolders:remoteFolderEntries,base:[...rawBase.values()],accepted:[...final.values()],external:[...rawIncoming.values()]});final.clear();for(const [path,entry] of namespace.accepted)final.set(path,entry);for(const path of final.keys())occupied.add(path);const finalById=new Map([...final.values()].filter(entry=>entry.fileId).map(entry=>[entry.fileId!,entry]));
    const handledDownloads=new Set<string>(),handledDeletes=new Set<string>(),newBytes=new Map<string,Uint8Array>();let changedFiles=0,deletedFiles=0,conflicts=0;
    const flushGenerated=async()=>{for(const [hash,bytes] of newBytes){await persistBytes(hash,bytes);newBytes.delete(hash);}};
    for(const collision of namespace.collisions){await this.preserveNamespaceCollision(row,collision,final,occupied);for(const version of collision.versions){handledDownloads.add(version.sourcePath);handledDeletes.add(version.sourcePath);}for(const move of externalMoves)if(namespace.externalPath(move.path)===collision.path){handledDownloads.add(move.path);handledDeletes.add(move.previousPath);}conflicts++;changedFiles++;}
    for(let move of externalMoves){
      await flushGenerated();
      if(handledDownloads.has(move.path))continue;
      const item=downloaded.get(move.path)!,target=namespace.externalPath(move.path),sourceId=completedEntries.get(move.previousPath)?.fileId,current=(sourceId?finalById.get(sourceId):undefined)??final.get(namespace.basePath(move.previousPath));if(final.has(target)&&final.get(target)?.fileId!==current?.fileId)continue;
      const externalEntry=externalFile(target,item,move.previousPath),alignedMove={...move,path:target};
      const base=mergeBase(move.previousPath);if(current)final.delete(current.path);
      const originalMove=move;move=alignedMove;
      const decision=planReconciliation({base:base?[{...completedEntries.get(move.previousPath),path:move.path,hash:base.hash,size:base.size,mtime:0}]:[],local:current?[{...current,path:move.path}]:[],remote:[externalEntry]}).decisions[0];
      if(decision.kind==="remote-only"||decision.kind==="equal"||decision.kind==="unchanged")final.set(move.path,externalEntry);
      else if(decision.kind==="local-only"){if(current)final.set(move.path,{...current,path:move.path});}
      else if(decision.kind==="edit-delete"){conflicts++;await this.preserveDeletion(row,move.path,externalEntry,"Seafile",head?.deviceName??"Obsidian",final);}
      else if(current&&await this.applyDeepPolicy(row,move.path,{...current,path:move.path},externalEntry,base,externalPreferred(externalEntry),final,newBytes)){}
      else if(current&&decision.kind==='independent-create'){conflicts++;await this.preservePair(row,move.path,{...current,path:move.path},externalEntry,current.revision?.deviceName??'Earlier version',externalPreferred(externalEntry),final,occupied);}
      else if(this.text(move.path)&&current&&base&&this.mergeable(current,externalEntry,base)){
        const itemBytes=await this.clear(row,externalEntry);
        const currentBytes=await this.clear(row,current),baseEntry:ManifestEntry={path:move.previousPath,hash:base.hash,size:base.size,mtime:0},preferred=externalPreferred(externalEntry);
        const baseText=decoder.decode(await this.clear(row,baseEntry)),currentText=decoder.decode(currentBytes),externalText=decoder.decode(itemBytes),merged=this.systemJson(move.path)?{text:mergeSystemJson(baseText,currentText,externalText,preferred,move.path.endsWith("/bookmarks.json")?"bookmarks":undefined),kind:"merged" as const}:mergeText(baseText,currentText,externalText,preferred);
        if(merged.kind==="large-conflict"||merged.kind==="merge-fallback"){conflicts++;await this.preservePair(row,move.path,{...current,path:move.path},externalEntry,current.revision?.deviceName??"Earlier version",preferred,final,occupied);}
        else{const mergedBytes=encoder.encode(merged.text),hash=sha256(mergedBytes);newBytes.set(hash,mergedBytes);final.set(move.path,{...current,path:move.path,hash,size:mergedBytes.length,mtime:Date.now()});}
      }else if(current){
        conflicts++;await this.preservePair(row,move.path,{...current,path:move.path},externalEntry,current.revision?.deviceName??"Earlier version",externalPreferred(externalEntry),final,occupied);
      }
      handledDownloads.add(originalMove.path);handledDeletes.add(move.previousPath);changedFiles++;
    }
    const planBase=namespace.base,planRemote=namespace.external;
    const planningInput={base:[...planBase.values()],local:[...final.values()],remote:[...planRemote.values()]},sharedPlan=planReconciliation(planningInput),decisions=new Map(sharedPlan.decisions.map(decision=>[decision.path,decision]));
    new ReconciliationRollout(this.store,20,3,this.config.GIBSYNC_RELEASE_DIGEST).observe(vaultId,planningInput,"seafile",{validatedIdentities:true,provenRemoteCreations:[...creations.keys()].flatMap(path=>{const entry=planRemote.get(namespace.externalPath(path));return entry?.fileId?[{path:entry.path,targetId:entry.fileId}]:[]})});
    // Packages are selected once as complete units by the same policy used on
    // devices. Settings data.json is deliberately outside this asset set.
    const packageRoot=(path:string)=>{const match=normalizeAliasPath(path,this.configAliases).match(/^(\.obsidian\/plugins\/[^/]+)\/(.+)$/);return match&&match[2]!=="data.json"?match[1]:null;},packageHandled=new Set<string>(),heldPackages=new Set<string>();
    const groupPackages=(entries:Iterable<ManifestEntry>)=>{const groups=new Map<string,ManifestEntry[]>();for(const entry of entries){const root=packageRoot(entry.path);if(root){let files=groups.get(root);if(!files){files=[];groups.set(root,files);}files.push(entry);}}return groups;},basePackages=groupPackages(planBase.values()),localPackages=groupPackages(final.values()),remotePackages=groupPackages(planRemote.values()),changedPackages=new Set<string>();for(const path of [...downloaded.keys(),...deleted.map(entry=>entry.path)]){const root=packageRoot(path);if(root)changedPackages.add(root);}
    const evidence=async(entries:ManifestEntry[],root:string):Promise<PluginPackageEvidence>=>{const manifest=entries.find(entry=>entry.path.endsWith("/manifest.json")),main=entries.find(entry=>entry.path.endsWith("/main.js"));let version:string|null=null,valid=false;if(manifest&&manifest.size<=MAX_SETTINGS_JSON_BYTES){const bytes=await this.clear(row,manifest);try{const parsed=JSON.parse(decoder.decode(bytes));valid=typeof parsed.id==="string"&&parsed.id===root.slice(root.lastIndexOf('/')+1)&&typeof parsed.version==="string"&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(parsed.version)&&(parsed.isDesktopOnly===undefined||typeof parsed.isDesktopOnly==="boolean");if(valid)version=parsed.version;}catch{/* Invalid package is never preferred to a complete package. */}}return {entries,version,complete:Boolean(manifest&&main&&valid)};};
    for(const root of changedPackages){const baseFiles=basePackages.get(root)??[],localFiles=localPackages.get(root)??[],remoteFiles=remotePackages.get(root)??[],choice=selectPluginPackage(await evidence(baseFiles,root),await evidence(localFiles,root),await evidence(remoteFiles,root)),chosen=new Map(choice.entries.map(entry=>[entry.path,entry]));if(choice.side==="held"){heldPackages.add(root);this.safeguards?.event(vaultId,"plugin_package_held","info",choice.reason);}for(const path of new Set([...baseFiles,...localFiles,...remoteFiles].map(entry=>entry.path))){packageHandled.add(path);const current=final.get(path),external=planRemote.get(path),selected=chosen.get(path);if(selected){if(current?.hash!==selected.hash||current.fileId!==selected.fileId){final.set(path,selected);changedFiles++;}if(choice.resolved&&current&&external&&current.hash!==external.hash)this.retainDeepChoice(path,current,external,selected,`Plugin package resolved as a unit: ${choice.reason}; both immutable originals remain available`);}else if(current){final.delete(path);deletedFiles++;}}}
    for(const [sourcePath,item] of downloaded){
      await flushGenerated();
      const path=namespace.externalPath(sourcePath);if(handledDownloads.has(sourcePath)||packageHandled.has(path))continue;
      const base=planBase.get(path),current=final.get(path);
      const decision=decisions.get(path)!;if(decision.kind==="unchanged"||decision.kind==="equal"||decision.kind==="local-only")continue;
      changedFiles++;
      const externalEntry=externalFile(path,item);
      if(!current){
        if(decision.kind==="edit-delete"){conflicts++;await this.preserveDeletion(row,path,externalEntry,"Seafile",head?.deviceName??"Obsidian",final);}
        else final.set(path,externalEntry);
        occupied.add(path);continue;
      }
      if(decision.kind!=="remote-only"&&await this.applyDeepPolicy(row,path,current,externalEntry,base,externalPreferred(externalEntry),final,newBytes))continue;
      if(decision.kind==="independent-create"){
        conflicts++;await this.preservePair(row,path,current,externalEntry,current.revision?.deviceName??"Earlier version",externalPreferred(externalEntry),final,occupied);continue;
      }
      if(decision.kind==="remote-only"){final.set(path,externalEntry);continue;}
      if(this.text(path)&&this.mergeable(current,externalEntry,base)){
        const itemBytes=await this.clear(row,externalEntry);
        const baseEntry:ManifestEntry={path,hash:base!.hash,size:base!.size,mtime:0};
        const currentBytes=await this.clear(row,current);
        const preferred=externalPreferred(externalEntry),baseText=decoder.decode(await this.clear(row,baseEntry)),currentText=decoder.decode(currentBytes),externalText=decoder.decode(itemBytes),merged=this.systemJson(path)?{text:mergeSystemJson(baseText,currentText,externalText,preferred,path.endsWith("/bookmarks.json")?"bookmarks":undefined),kind:"merged" as const}:mergeText(baseText,currentText,externalText,preferred);
        if(merged.kind==="large-conflict"||merged.kind==="merge-fallback"){
          conflicts++;await this.preservePair(row,path,current,externalEntry,current.revision?.deviceName??"Earlier version",preferred,final,occupied);continue;
        }
        const bytes=encoder.encode(merged.text),hash=sha256(bytes);newBytes.set(hash,bytes);
        final.set(path,{...current,path,hash,size:bytes.length,mtime:Date.now()});continue;
      }
      conflicts++;
      await this.preservePair(row,path,current,externalEntry,current.revision?.deviceName??"Earlier version",externalPreferred(externalEntry),final,occupied);
    }
    for(const originalMissing of deleted){
      await flushGenerated();
      if(handledDeletes.has(originalMissing.path))continue;const missing={...originalMissing,path:namespace.basePath(originalMissing.path)};if(packageHandled.has(missing.path))continue;
      const current=final.get(missing.path);if(!current)continue;
      const decision=decisions.get(missing.path);if(decision?.kind==="remote-only"){final.delete(missing.path);deletedFiles++;}
      else if(decision?.kind!=="edit-delete")continue;
      else{
        conflicts++;changedFiles++;
        await this.preserveDeletion(row,missing.path,current,current.revision?.deviceName??"Earlier version","Seafile",final);
      }
    }
    await flushGenerated();

    const finalFolders=new Set(folderPlan.folders.map(folder=>folder.path));for(const folder of folderSet({entries:[...final.values()]} as Snapshot))finalFolders.add(folder);for(const folder of archivedFolders)finalFolders.add(folder.path);
    const changedFolders=folderImportAllowed||archivedFolders.length?[...new Set([...headFolders,...finalFolders])].filter((folder)=>headFolders.has(folder)!==finalFolders.has(folder)||headFolders.has(folder)&&finalFolders.has(folder)&&recreated.has(folder)).length:0;
    const fileFolders=folderSet({entries:[...final.values()]} as Snapshot),explicitFolders=Array.isArray(head?.folders)?[...finalFolders].filter((folder)=>!fileFolders.has(folder)).sort():undefined;
    if(!changedFiles&&!deletedFiles&&!changedFolders){
      consumeFolders();
      for(const item of downloaded.values()){if(heldPackages.has(packageRoot(item.metadata.path)??""))continue;consumeArchive(item.metadata.path);if(!item.archiveRevision)this.store.run("UPDATE mirror_entries SET storage_id=?,storage_mtime=?,size=? WHERE vault_id=? AND path=?",item.metadata.id,item.metadata.mtime,item.metadata.size,vaultId,item.metadata.path);}
      this.store.run("UPDATE vaults SET external_scan_at=?,external_error=NULL WHERE id=?",scannedAt,vaultId);
      return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts,deferredDeletions,mirrorGenerationMismatch:!generationCurrent||vault.head_id!==vault.mirror_head_id};
    }

    const rawEntries=[...final.values()];this.conflictRecords.push(...aliasCollisionRecords(rawEntries,this.configAliases,"Seafile"));const canonical=canonicalManifest(normalizeAliasEntries(rawEntries,this.configAliases),explicitFolders?normalizeAliasFolders(explicitFolders,this.configAliases):undefined),entries=canonical.entries;
    const mappedFolders=folderPlan.folders;
    if(!this.canOperate(vaultId))return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,contained:true};
    const decision=this.safeguards?.propose({vaultId,deviceId:`seafile:${vaultId}`,deviceName:"Seafile",parentId:head?.id??null,message:`Seafile external change (${changedFiles} changed, ${deletedFiles} deleted, ${changedFolders} folders)`,entries,folders:canonical.folders??[],folderEntries:mappedFolders,source:"seafile"});
    if(decision&&!decision.allowed){
      this.store.run("UPDATE vaults SET external_scan_at=?,external_error=NULL WHERE id=?",scannedAt,vaultId);
      if(decision.quarantine&&decision.created)this.safeguards?.event(vaultId,"external_quarantine","warning",`Seafile changes were quarantined: ${decision.assessment.reasons.join("; ")}`);
      if(decision.quarantine&&this.conflictRecords.length)this.store.run("INSERT INTO conflict_proposals(quarantine_id,vault_id,records_json) VALUES(?,?,?) ON CONFLICT(quarantine_id) DO NOTHING",decision.quarantine.id,vaultId,JSON.stringify(this.conflictRecords));
      if(decision.quarantine)this.store.run("INSERT INTO sync_pending_folders VALUES(?,?,?) ON CONFLICT(quarantine_id) DO NOTHING",decision.quarantine.id,vaultId,JSON.stringify(mappedFolders));
      return {snapshotId:null,changedFiles,deletedFiles,conflicts,changedFolders,quarantineId:decision.quarantine?.id,locked:decision.locked,deferredDeletions};
    }
    if(!this.canOperate(vaultId))return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,contained:true};
    const snapshot=await this.committer.accept({vaultId,parentId:head?.id??null,deviceId:`seafile:${vaultId}`,deviceName:"Seafile",createdAt:scannedAt,
      message:`Seafile external change (${changedFiles} changed, ${deletedFiles} deleted, ${changedFolders} folders${conflicts?`, ${conflicts} conflicts`:""})`,entries,folders:canonical.folders,folderEntries:mappedFolders,
      afterInsert:accepted=>{
      if(this.conflictRecords.length)new ConflictInbox(this.store).publishInTransaction({id:"seafile",vault_id:vaultId,name:"Seafile"},this.conflictRecords.map(record=>({...record,originSnapshotId:accepted.id})));
      consumeFolders();
      this.store.run("UPDATE vaults SET external_scan_at=?,external_import_at=?,external_error=NULL WHERE id=?",scannedAt,scannedAt,vaultId);
      for(const item of downloaded.values()){if(heldPackages.has(packageRoot(item.metadata.path)??""))continue;consumeArchive(item.metadata.path);if(!item.archiveRevision)this.store.run("INSERT INTO mirror_entries(vault_id,path,hash,size,updated_at,storage_id,storage_mtime) VALUES(?,?,?,?,?,?,?) ON CONFLICT(vault_id,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,updated_at=excluded.updated_at,storage_id=excluded.storage_id,storage_mtime=excluded.storage_mtime",vaultId,item.metadata.path,item.hash,item.metadata.size,scannedAt,item.metadata.id,item.metadata.mtime);}
      for(const missing of deleted)if(!final.has(missing.path)){this.store.run("DELETE FROM mirror_entries WHERE vault_id=? AND path=?",vaultId,missing.path);this.store.run("DELETE FROM external_absences WHERE vault_id=? AND path=?",vaultId,missing.path);}
    }});
    if(!snapshot)return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0};
    return {snapshotId:snapshot.id,changedFiles,deletedFiles,conflicts,changedFolders,deferredDeletions};
  }
}
