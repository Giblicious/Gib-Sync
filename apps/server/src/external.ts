import { detectMoves, type ManifestEntry,type Snapshot } from "@gib-sync/protocol";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { mergeText } from "./merge.js";
import { mergeSystemJson } from "./system-merge.js";
import { decryptVaultBlob,encryptVaultBlob,openJson,sha256 } from "./security.js";
import { SeafileStorage,type ReadableStorageEntry,type VaultStorageRow } from "./seafile.js";
import { SafeguardService } from "./safeguards.js";
import { canonicalManifest } from "./manifest.js";
import { SnapshotCommitter } from "./snapshot-commit.js";

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
  constructor(private readonly config:Config,private readonly store:Store,private readonly storage:SeafileStorage,private readonly safeguards?:SafeguardService,private readonly canOperate:(vaultId:string)=>boolean=()=>true){this.committer=new SnapshotCommitter(store,storage,(vaultId)=>this.storageRow(vaultId));}
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

  private async clear(row:VaultStorageRow,key:string,entry:ManifestEntry):Promise<Uint8Array>{
    return decryptVaultBlob(await this.storage.get(row,`blobs/${entry.hash.slice(0,2)}/${entry.hash}.gbs`),key,entry.hash);
  }

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

  private preserveDeletion(path:string,clear:Uint8Array,editor:string,deleter:string,final:Map<string,ManifestEntry>,newBytes:Map<string,Uint8Array>):void{
    const preserved=path.toLowerCase().endsWith(".md")
      ?encoder.encode(`> [!warning] Gib Sync deletion conflict\n> **${deleter}** deleted this note while **${editor}** modified it. Gib Sync kept the modified content here; delete this note if the deletion was intended.\n\n${decoder.decode(clear)}`)
      :clear;
    const hash=sha256(preserved);newBytes.set(hash,preserved);final.set(path,{path,hash,size:preserved.length,mtime:Date.now()});
  }

  private preservePair(path:string,current:ManifestEntry,currentBytes:Uint8Array,external:ManifestEntry,externalBytes:Uint8Array,currentName:string,preferred:"current"|"external",final:Map<string,ManifestEntry>,newBytes:Map<string,Uint8Array>,occupied:Set<string>):void{
    const currentIsNewer=preferred==="current",loser=currentIsNewer?external:current;
    const winnerBytes=currentIsNewer?currentBytes:externalBytes,loserBytes=currentIsNewer?externalBytes:currentBytes;
    const loserName=currentIsNewer?"Seafile":currentName,copyPath=this.conflictPath(path,loserName,loser.mtime,occupied);occupied.add(copyPath);
    let originalClear=winnerBytes,copyClear=loserBytes;
    if(path.toLowerCase().endsWith(".md")){
      const names=[currentName,"Seafile"];
      originalClear=encoder.encode(this.warning(decoder.decode(winnerBytes),names,copyPath));
      copyClear=encoder.encode(this.warning(decoder.decode(loserBytes),names,path));
    }
    const originalHash=sha256(originalClear),copyHash=sha256(copyClear);newBytes.set(originalHash,originalClear);newBytes.set(copyHash,copyClear);
    final.set(path,{path,hash:originalHash,size:originalClear.length,mtime:Date.now()});
    final.set(copyPath,{path:copyPath,hash:copyHash,size:copyClear.length,mtime:Date.now()});
  }

  private text(path:string):boolean{return textExtensions.has(path.split(".").pop()?.toLowerCase()??"");}
  private systemJson(path:string):boolean{return path.replace(/\\/g,"/").toLowerCase().startsWith(".obsidian/")&&path.toLowerCase().endsWith(".json");}

  private async run(vaultId:string):Promise<ExternalImportResult>{
    if(!this.canOperate(vaultId))return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,contained:true};
    const row=this.storageRow(vaultId),vault=this.store.one<{head_id:string|null;mirror_head_id:string|null;mirror_generation_id:string|null;wrapped_key:string}>("SELECT head_id,mirror_head_id,mirror_generation_id,wrapped_key FROM vaults WHERE id=?",vaultId)!;
    // This signed marker is Gib Sync's committed last-sync database. Safe
    // creations and edits can still be imported while a newer generation is
    // being written, but absence is deletion evidence only for a path that
    // existed in a successfully completed generation.
    const generationSnapshot=vault.mirror_generation_id?this.store.getSnapshot(vault.mirror_generation_id):null,generationCurrent=Boolean(generationSnapshot&&vault.mirror_generation_id===vault.mirror_head_id),mirrorCurrent=Boolean(generationCurrent&&vault.head_id===vault.mirror_head_id),head=vault.head_id?this.store.getSnapshot(vault.head_id):null,folderImportAllowed=Boolean(mirrorCurrent&&Array.isArray(head?.folders));
    const completedEntries=new Map((generationSnapshot?.entries??[]).map((entry)=>[entry.path,entry]));
    this.store.run("UPDATE vaults SET trusted_until=NULL,trusted_device_id=NULL WHERE id=? AND trusted_device_id=?",vaultId,`seafile:${vaultId}`);
    const readableTree=await this.storage.listReadableTree(row),remote=readableTree.files,remoteFolders=new Set(readableTree.folders),headFolders=folderSet(head);
    if(remote.length>200_000)throw new Error("Readable Seafile vault exceeds 200,000 files");
    const remoteByPath=new Map(remote.map((entry)=>[entry.path,entry]));
    const mirrored=new Map(this.store.all<MirrorEntry>("SELECT path,hash,size,updated_at,storage_id,storage_mtime FROM mirror_entries WHERE vault_id=?",vaultId).map((entry)=>[entry.path,entry]));
    const candidates=remote.filter((entry)=>{const previous=mirrored.get(entry.path);return !previous||previous.storage_id!==entry.id||previous.storage_mtime!==entry.mtime||previous.size!==entry.size;});
    const archived=this.store.all<{path:string;revision_id:string;hash:string;size:number;mtime:number}>("SELECT path,revision_id,hash,size,mtime FROM external_revisions WHERE vault_id=? AND imported_at IS NULL ORDER BY causal_order DESC,mtime DESC,revision_id",vaultId),archiveByPath=new Map<string,(typeof archived)[number]>();
    for(const revision of archived)if(!archiveByPath.has(revision.path))archiveByPath.set(revision.path,revision);
    const missingAll=[...mirrored.values()].filter((entry)=>!remoteByPath.has(entry.path));
    const scannedAt=new Date().toISOString();
    const observations=new Map<string,string>();
    const archivedFolders=this.store.all<{path:string;revision_id:string}>("SELECT path,revision_id FROM external_folder_revisions WHERE vault_id=? AND imported_at IS NULL",vaultId);
    const consumeFolders=()=>{for(const entry of archivedFolders)this.store.run("UPDATE external_folder_revisions SET imported_at=? WHERE vault_id=? AND path=? AND revision_id=? AND imported_at IS NULL",scannedAt,vaultId,entry.path,entry.revision_id);};
    const consumeArchive=(path:string)=>{for(const revision of archived)if(revision.path===path)this.store.run("UPDATE external_revisions SET imported_at=? WHERE vault_id=? AND path=? AND revision_id=? AND imported_at IS NULL",scannedAt,vaultId,path,revision.revision_id);const observation=observations.get(path);if(observation)this.store.run("UPDATE external_revisions SET imported_at=? WHERE vault_id=? AND path=? AND revision_id=? AND imported_at IS NULL",scannedAt,vaultId,path,observation);};
    for(const absence of this.store.all<{path:string}>("SELECT path FROM external_absences WHERE vault_id=?",vaultId))if(remoteByPath.has(absence.path))this.store.run("DELETE FROM external_absences WHERE vault_id=? AND path=?",vaultId,absence.path);
    const observedFolderChange=folderImportAllowed&&([...remoteFolders].some((folder)=>!headFolders.has(folder))||[...headFolders].some((folder)=>!remoteFolders.has(folder)));
    if(!candidates.length&&!missingAll.length&&!observedFolderChange&&!archiveByPath.size&&!archivedFolders.length){
      this.store.run("UPDATE vaults SET external_scan_at=?,external_error=NULL WHERE id=?",scannedAt,vaultId);
      return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,mirrorGenerationMismatch:!generationCurrent||vault.head_id!==vault.mirror_head_id};
    }

    const mergeBase=(path:string):MirrorEntry|undefined=>{
      if(mirrorCurrent)return mirrored.get(path);
      const completed=completedEntries.get(path);
      return completed?{path:completed.path,hash:completed.hash,size:completed.size,updated_at:generationSnapshot?.createdAt??"",storage_id:null,storage_mtime:completed.mtime/1000}:undefined;
    };
    const externalPreferred=(entry:ManifestEntry):"current"|"external"=>entry.mtime>=(head?.entries.find((item)=>item.path===entry.path)?.revision?.modifiedAt??head?.entries.find((item)=>item.path===entry.path)?.mtime??0)?"external":"current";
    const final=new Map((head?.entries??[]).map((entry)=>[entry.path,{...entry}])),occupied=new Set(final.keys());
    const key=openJson<string>(vault.wrapped_key,this.config.GIBSYNC_SERVER_SECRET,vaultId);
    const persistBytes=async(hash:string,bytes:Uint8Array)=>{if(this.store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?",vaultId,hash))return;if(!this.canOperate(vaultId))throw new Error("Vault was paused before external content preservation");await this.storage.put(row,`blobs/${hash.slice(0,2)}/${hash}.gbs`,encryptVaultBlob(bytes,key,hash));this.store.run("INSERT OR IGNORE INTO blobs(vault_id,hash,size,created_at) VALUES(?,?,?,?)",vaultId,hash,bytes.length,scannedAt);};
    // Candidate bodies are durably preserved one at a time. A large external
    // batch keeps only its manifest metadata in memory, never all file bodies.
    const downloaded=new Map<string,{metadata:ReadableStorageEntry;hash:string;archiveRevision?:string;consumeArchived?:boolean}>();
    for(const metadata of candidates){
      if(metadata.size>this.config.MAX_BLOB_BYTES)throw new Error(`External file exceeds the Gib Sync size limit: ${metadata.path}`);
      const bytes=await this.storage.getReadable(row,metadata.path),hash=sha256(bytes);
      await persistBytes(hash,bytes);const observation=`visible:${metadata.id}:${metadata.mtime}:${hash}:${vault.head_id??"none"}`;this.store.run("INSERT OR IGNORE INTO external_revisions(vault_id,path,revision_id,hash,size,observed_at,source,mtime,causal_order) VALUES(?,?,?,?,?,?,?,?,?)",vaultId,metadata.path,observation,hash,bytes.length,scannedAt,"external-observation",metadata.mtime*1000,`${scannedAt}:000000`);observations.set(metadata.path,observation);downloaded.set(metadata.path,{metadata:{...metadata,size:bytes.length},hash});
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
    const repoBaseline=this.store.one<{mirror_repo_commit:string|null}>("SELECT mirror_repo_commit FROM vaults WHERE id=?",vaultId)?.mirror_repo_commit;
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
    const handledDownloads=new Set<string>(),handledDeletes=new Set<string>(),newBytes=new Map<string,Uint8Array>();let changedFiles=0,deletedFiles=0,conflicts=0;
    const flushGenerated=async()=>{for(const [hash,bytes] of newBytes){await persistBytes(hash,bytes);newBytes.delete(hash);}};
    for(const move of externalMoves){
      await flushGenerated();
      const item=downloaded.get(move.path)!;if(final.has(move.path))continue;
      const current=final.get(move.previousPath),externalEntry:ManifestEntry={path:move.path,hash:item.hash,size:item.metadata.size,mtime:item.metadata.mtime*1000};
      const base=mergeBase(move.previousPath);final.delete(move.previousPath);
      if(!current||!base||current.hash===base.hash)final.set(move.path,externalEntry);
      else if(externalEntry.hash===base.hash)final.set(move.path,{...current,path:move.path,mtime:Date.now()});
      else if(this.text(move.path)){
        const itemBytes=await this.clear(row,key,externalEntry);
        const currentBytes=await this.clear(row,key,current),baseEntry:ManifestEntry={path:move.previousPath,hash:base.hash,size:base.size,mtime:0},preferred=externalPreferred(externalEntry);
        const baseText=decoder.decode(await this.clear(row,key,baseEntry)),currentText=decoder.decode(currentBytes),externalText=decoder.decode(itemBytes),merged=this.systemJson(move.path)?{text:mergeSystemJson(baseText,currentText,externalText,preferred,move.path.endsWith("/bookmarks.json")?"bookmarks":undefined),kind:"merged" as const}:mergeText(baseText,currentText,externalText,preferred);
        if(merged.kind==="large-conflict"||merged.kind==="merge-fallback"){conflicts++;this.preservePair(move.path,{...current,path:move.path},currentBytes,externalEntry,itemBytes,current.revision?.deviceName??"Earlier version",preferred,final,newBytes,occupied);}
        else{const mergedBytes=encoder.encode(merged.text),hash=sha256(mergedBytes);newBytes.set(hash,mergedBytes);final.set(move.path,{path:move.path,hash,size:mergedBytes.length,mtime:Date.now()});}
      }else{
        conflicts++;const currentBytes=await this.clear(row,key,current),itemBytes=await this.clear(row,key,externalEntry);this.preservePair(move.path,{...current,path:move.path},currentBytes,externalEntry,itemBytes,current.revision?.deviceName??"Earlier version",externalPreferred(externalEntry),final,newBytes,occupied);
      }
      handledDownloads.add(move.path);handledDeletes.add(move.previousPath);changedFiles++;
    }
    for(const [path,item] of downloaded){
      await flushGenerated();
      if(handledDownloads.has(path))continue;
      const base=mergeBase(path),current=final.get(path);
      if(item.hash===base?.hash||item.hash===current?.hash)continue;
      changedFiles++;
      const externalEntry:ManifestEntry={path,hash:item.hash,size:item.metadata.size,mtime:item.metadata.mtime*1000};
      if(!current){
        if(base){conflicts++;this.preserveDeletion(path,await this.clear(row,key,externalEntry),"Seafile",head?.deviceName??"Obsidian",final,newBytes);}
        else final.set(path,externalEntry);
        occupied.add(path);continue;
      }
      if(!base){
        conflicts++;const currentBytes=await this.clear(row,key,current),itemBytes=await this.clear(row,key,externalEntry);
        this.preservePair(path,current,currentBytes,externalEntry,itemBytes,current.revision?.deviceName??"Earlier version",externalPreferred(externalEntry),final,newBytes,occupied);continue;
      }
      if(current.hash===base.hash){final.set(path,externalEntry);continue;}
      if(this.text(path)){
        const itemBytes=await this.clear(row,key,externalEntry);
        const baseEntry:ManifestEntry={path,hash:base.hash,size:base.size,mtime:0};
        const currentBytes=await this.clear(row,key,current);
        const preferred=externalPreferred(externalEntry),baseText=decoder.decode(await this.clear(row,key,baseEntry)),currentText=decoder.decode(currentBytes),externalText=decoder.decode(itemBytes),merged=this.systemJson(path)?{text:mergeSystemJson(baseText,currentText,externalText,preferred,path.endsWith("/bookmarks.json")?"bookmarks":undefined),kind:"merged" as const}:mergeText(baseText,currentText,externalText,preferred);
        if(merged.kind==="large-conflict"||merged.kind==="merge-fallback"){
          conflicts++;this.preservePair(path,current,currentBytes,externalEntry,itemBytes,current.revision?.deviceName??"Earlier version",preferred,final,newBytes,occupied);continue;
        }
        const bytes=encoder.encode(merged.text),hash=sha256(bytes);newBytes.set(hash,bytes);
        final.set(path,{path,hash,size:bytes.length,mtime:Date.now()});continue;
      }
      conflicts++;
      const currentBytes=await this.clear(row,key,current),itemBytes=await this.clear(row,key,externalEntry);
      this.preservePair(path,current,currentBytes,externalEntry,itemBytes,current.revision?.deviceName??"Earlier version",externalPreferred(externalEntry),final,newBytes,occupied);
    }
    for(const missing of deleted){
      await flushGenerated();
      if(handledDeletes.has(missing.path))continue;
      const current=final.get(missing.path);if(!current)continue;
      if(current.hash===missing.hash){final.delete(missing.path);deletedFiles++;}
      else{
        conflicts++;changedFiles++;
        this.preserveDeletion(missing.path,await this.clear(row,key,current),current.revision?.deviceName??"Earlier version","Seafile",final,newBytes);
      }
    }
    await flushGenerated();

    const finalFolders=folderImportAllowed?new Set(remoteFolders):new Set(headFolders);for(const folder of folderSet({entries:[...final.values()]} as Snapshot))finalFolders.add(folder);for(const folder of archivedFolders)finalFolders.add(folder.path);
    const changedFolders=folderImportAllowed||archivedFolders.length?[...new Set([...headFolders,...finalFolders])].filter((folder)=>headFolders.has(folder)!==finalFolders.has(folder)).length:0;
    const fileFolders=folderSet({entries:[...final.values()]} as Snapshot),explicitFolders=Array.isArray(head?.folders)?[...finalFolders].filter((folder)=>!fileFolders.has(folder)).sort():undefined;
    if(!changedFiles&&!deletedFiles&&!changedFolders){
      consumeFolders();
      for(const item of downloaded.values()){consumeArchive(item.metadata.path);if(!item.archiveRevision)this.store.run("UPDATE mirror_entries SET storage_id=?,storage_mtime=?,size=? WHERE vault_id=? AND path=?",item.metadata.id,item.metadata.mtime,item.metadata.size,vaultId,item.metadata.path);}
      this.store.run("UPDATE vaults SET external_scan_at=?,external_error=NULL WHERE id=?",scannedAt,vaultId);
      return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts,deferredDeletions,mirrorGenerationMismatch:!generationCurrent||vault.head_id!==vault.mirror_head_id};
    }

    const canonical=canonicalManifest([...final.values()],explicitFolders),entries=canonical.entries;
    if(!this.canOperate(vaultId))return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,contained:true};
    const decision=this.safeguards?.propose({vaultId,deviceId:`seafile:${vaultId}`,deviceName:"Seafile",parentId:head?.id??null,message:`Seafile external change (${changedFiles} changed, ${deletedFiles} deleted, ${changedFolders} folders)`,entries,folders:canonical.folders??[],source:"seafile"});
    if(decision&&!decision.allowed){
      this.store.run("UPDATE vaults SET external_scan_at=?,external_error=NULL WHERE id=?",scannedAt,vaultId);
      if(decision.quarantine&&decision.created)this.safeguards?.event(vaultId,"external_quarantine","warning",`Seafile changes were quarantined: ${decision.assessment.reasons.join("; ")}`);
      return {snapshotId:null,changedFiles,deletedFiles,conflicts,changedFolders,quarantineId:decision.quarantine?.id,locked:decision.locked,deferredDeletions};
    }
    if(!this.canOperate(vaultId))return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,contained:true};
    const snapshot=await this.committer.accept({vaultId,parentId:head?.id??null,deviceId:`seafile:${vaultId}`,deviceName:"Seafile",createdAt:scannedAt,
      message:`Seafile external change (${changedFiles} changed, ${deletedFiles} deleted, ${changedFolders} folders${conflicts?`, ${conflicts} conflicts`:""})`,entries,folders:canonical.folders,
      afterInsert:()=>{
      consumeFolders();
      this.store.run("UPDATE vaults SET external_scan_at=?,external_import_at=?,external_error=NULL WHERE id=?",scannedAt,scannedAt,vaultId);
      for(const item of downloaded.values()){consumeArchive(item.metadata.path);if(!item.archiveRevision)this.store.run("INSERT INTO mirror_entries(vault_id,path,hash,size,updated_at,storage_id,storage_mtime) VALUES(?,?,?,?,?,?,?) ON CONFLICT(vault_id,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,updated_at=excluded.updated_at,storage_id=excluded.storage_id,storage_mtime=excluded.storage_mtime",vaultId,item.metadata.path,item.hash,item.metadata.size,scannedAt,item.metadata.id,item.metadata.mtime);}
      for(const missing of deleted)if(!final.has(missing.path)){this.store.run("DELETE FROM mirror_entries WHERE vault_id=? AND path=?",vaultId,missing.path);this.store.run("DELETE FROM external_absences WHERE vault_id=? AND path=?",vaultId,missing.path);}
    }});
    if(!snapshot)return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0};
    return {snapshotId:snapshot.id,changedFiles,deletedFiles,conflicts,changedFolders,deferredDeletions};
  }
}
