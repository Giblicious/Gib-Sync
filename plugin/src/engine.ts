import { normalizePath, type DataAdapter } from "obsidian";
import { detectMoves, type ManifestEntry, type Snapshot } from "@gib-sync/protocol";
import { ApiError, GibSyncApi } from "./api";
import { decryptBlob, encryptBlob, hashBytes } from "./crypto";
import { mergeText } from "./merge";
import { isDeviceLocalObsidianPath, isGibSyncConflictPath, isObsidianSystemPath, isPluginDataPath, obsidianPluginPath, shouldSyncChangedPath, type GibSyncSettings, type SyncPhase } from "./settings";
import { mergeCommunityPluginEnablement, mergeSystemJson } from "./system-merge";

type FileState = ManifestEntry & { bytes?: Uint8Array; sourcePath?:string };
type LocalScan = { files:Map<string,FileState>; unreadableConflictPaths:Set<string> };
const TEXT_EXTENSIONS = new Set(["md","txt","canvas","json","jsonl","css","js","ts","yaml","yml","xml","csv","svg","html"]);
const decoder = new TextDecoder(); const encoder = new TextEncoder();
export const LOW_MEMORY_DOWNLOAD_BYTES=8*1024*1024;
const MOBILE_WORK_BATCH=2;
const DESKTOP_WORK_BATCH=8;
const RETIRED_PATH_MAX_AGE=90*24*60*60*1000;
const RETIRED_PATH_LIMIT=5000;
const PROTECTED_FOLDER_ROOTS=new Set([".obsidian",".obsidian/plugins",".obsidian/themes",".trash",".git",".gib-sync"]);
const DISPOSABLE_FOLDER_METADATA=new Set([".ds_store",".nomedia","desktop.ini","thumbs.db"]);

function exactArrayBuffer(bytes:Uint8Array):ArrayBuffer{
  if(bytes.buffer instanceof ArrayBuffer&&bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength)return bytes.buffer;
  return bytes.slice().buffer;
}

export interface SyncResult { uploaded: number; downloaded: number; deleted: number; prunedFolders:number; pendingRetiredFolders:number; conflicts: number; resolved:number; mirrored:number; snapshotId: string | null; processedPaths:string[]; fullScan:boolean; }
export interface SyncProgress { phase:SyncPhase; message:string; current?:number; total?:number; level?:"info"|"success"|"warning"|"error"; }
export class SyncSafetyError extends Error { override readonly name="SyncSafetyError"; }
export class FileChangedDuringReadError extends Error {
  override readonly name="FileChangedDuringReadError";
  constructor(readonly path:string){super(`${path} changed while Gib Sync was reading it. It was not uploaded; sync will retry with the newer saved version.`);}
}

export class SyncEngine {
  private running: Promise<SyncResult> | null = null;
  private workSinceYield=0;
  private lastYieldAt=0;
  private readonly workBatch=typeof navigator!=="undefined"&&/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)?MOBILE_WORK_BATCH:DESKTOP_WORK_BATCH;
  constructor(
    private readonly adapter: DataAdapter,
    private readonly api: GibSyncApi,
    private readonly getSettings: () => GibSyncSettings,
    private readonly saveSettings: () => Promise<void>,
    private readonly status: (progress: SyncProgress) => void,
    private readonly wait: (milliseconds:number) => Promise<void> = (milliseconds) => new Promise((resolve)=>window.setTimeout(resolve,milliseconds)),
    private readonly expectLocalMutation:(path:string,hash:string|null)=>void=()=>{},
    private readonly yieldControl:()=>Promise<void>=()=>new Promise((resolve)=>globalThis.setTimeout(resolve,0)),
    private readonly isMobileDevice=false
  ) {}

  private async cooperate(force=false):Promise<void>{
    const now=typeof performance!=="undefined"?performance.now():Date.now();
    this.workSinceYield++;
    if(!force&&this.workSinceYield<this.workBatch&&now-this.lastYieldAt<8)return;
    this.workSinceYield=0;this.lastYieldAt=now;await this.yieldControl();
  }
  private progress(current:number,total?:number):boolean{return current===1||current===total||current%10===0;}

  sync(): Promise<SyncResult> {
    if (this.running) return this.running;
    this.running = this.run(0).finally(() => { this.running = null; }); return this.running;
  }

  async restoreAcceptedSnapshot():Promise<{downloaded:number;deleted:number;prunedFolders:number}>{
    const settings=this.getSettings();if(!settings.deviceToken||!settings.vaultKey)throw new Error("Gib Sync is not configured");
    const scanned=await this.scan(),local=scanned.files,head=(await this.api.state()).head,remote=this.map(head),cache=new Map<string,Uint8Array>();for(const path of scanned.unreadableConflictPaths){const accepted=remote.get(path);if(accepted)local.set(path,accepted);}let downloaded=0,deleted=0;
    for(const [path,entry] of remote){await this.cooperate();if(local.get(path)?.hash===entry.hash)continue;const clear=await this.remoteBytes(entry,cache);await this.ensureParent(path);this.expectLocalMutation(path,entry.hash);await this.adapter.writeBinary(path,exactArrayBuffer(clear));downloaded++;}
    for(const [path,entry] of local)if(!remote.has(path)&&this.include(path)){await this.cooperate();if(head)settings.retiredPaths[path]={hash:entry.hash,snapshotId:head.id,retiredAt:Date.now()};this.expectLocalMutation(path,null);await this.adapter.remove(path);deleted++;}
    const retiredCleanup=await this.pruneRetiredEmptyFolders(),topology=await this.reconcileFolderTopology((head?.entries??[]).map((entry)=>entry.path));settings.lastSnapshotId=head?.id??null;settings.initialized=true;settings.pendingApplyPaths=[];settings.pendingApplySnapshotId=null;settings.pendingApplyBaseSnapshotId=null;settings.pendingApplyPriorHashes={};if(settings.syncPlugins)settings.pluginSyncBootstrapPending=false;this.trimRetiredPaths();await this.saveSettings();return {downloaded,deleted,prunedFolders:retiredCleanup.removed+topology.removed};
  }

  private async entropy(bytes:Uint8Array):Promise<number>{
    if(bytes.length<1024)return 0;const counts=new Uint32Array(256);
    for(let start=0;start<bytes.length;start+=64*1024){for(const value of bytes.subarray(start,start+64*1024))counts[value]++;await this.cooperate();}
    let result=0;
    for(const count of counts)if(count){const probability=count/bytes.length;result-=probability*Math.log2(probability);}return result;
  }

  private include(path: string): boolean {
    return shouldSyncChangedPath(normalizePath(path),this.getSettings());
  }

  private pluginSyncPath(path:string):boolean{
    const normalized=normalizePath(path);if(normalized===".obsidian/community-plugins.json")return true;
    const plugin=obsidianPluginPath(normalized);return Boolean(plugin&&plugin.id.toLowerCase()!=="gib-sync");
  }

  private async listFiles(path = ""): Promise<string[]> {
    const listing = await this.adapter.list(path); const files = listing.files.filter((file) => this.include(file));
    for (const folder of listing.folders.filter((item) => this.include(item))) {await this.cooperate();files.push(...await this.listFiles(folder));}
    return files;
  }

  private async scan(): Promise<LocalScan> {
    const output = new Map<string, FileState>(),unreadableConflictPaths=new Set<string>();
    const paths = await this.listFiles(); let current = 0;
    for (const path of paths) {
      await this.cooperate();
      let bytes:Uint8Array,stat;try{bytes=new Uint8Array(await this.adapter.readBinary(path));stat=await this.adapter.stat(path);}catch(error){if(!isGibSyncConflictPath(path))throw error;unreadableConflictPaths.add(path);this.status({phase:"scanning",message:`Isolated unreadable generated conflict copy · ${path} · accepted server version preserved`,level:"warning"});current++;continue;}
      // Retain metadata rather than every file body. Mobile WebViews have much
      // tighter memory limits, so changed content is read lazily when required.
      output.set(path, { path, hash: await hashBytes(bytes), size: bytes.length, mtime: stat?.mtime ?? Date.now() });
      current++; if (current===1 || current===paths.length || current%25===0) this.status({phase:"scanning",message:"Scanning local vault",current,total:paths.length});
    }
    return {files:output,unreadableConflictPaths};
  }

  private async scanIncremental(baseSnapshot:Snapshot,changedPaths:string[]):Promise<LocalScan>{
    const output=this.map(baseSnapshot),unreadableConflictPaths=new Set<string>();let current=0;
    for(const rawPath of changedPaths){
      await this.cooperate();
      const path=normalizePath(rawPath);current++;
      if(!this.include(path)){output.delete(path);continue;}
      const stat=await this.adapter.stat(path);
      if(!stat){output.delete(path);continue;}
      if(stat.type!=="file")throw new SyncSafetyError("A changed folder requires a full vault reconciliation before syncing.");
      try{
        const bytes=new Uint8Array(await this.adapter.readBinary(path));output.set(path,{path,hash:await hashBytes(bytes),size:bytes.length,mtime:stat.mtime??Date.now()});
      }catch(error){
        if(!isGibSyncConflictPath(path))throw error;output.delete(path);unreadableConflictPaths.add(path);
        this.status({phase:"scanning",message:`Isolated unreadable generated conflict copy · ${path} · accepted server version preserved`,level:"warning"});
      }
      if(this.progress(current,changedPaths.length))this.status({phase:"scanning",message:"Checking changed files",current,total:changedPaths.length});
    }
    return {files:output,unreadableConflictPaths};
  }

  private map(snapshot: Snapshot | null): Map<string, FileState> {
    return new Map((snapshot?.entries ?? []).filter((entry) => this.include(entry.path)).map((entry) => [entry.path, { ...entry }]));
  }
  private async localBytes(path:string,entry:FileState,cache:Map<string,Uint8Array>):Promise<Uint8Array>{
    const cached=cache.get(entry.hash);if(cached)return cached;
    const sourcePath=entry.sourcePath??path,clear=new Uint8Array(await this.adapter.readBinary(sourcePath));
    if(await hashBytes(clear)!==entry.hash)throw new FileChangedDuringReadError(sourcePath);
    cache.set(entry.hash,clear);return clear;
  }

  private async remoteBytes(entry: FileState, cache: Map<string, Uint8Array>): Promise<Uint8Array> {
    const existing = cache.get(entry.hash); if (existing) return existing;
    if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES){const bytes=await this.api.getContent(entry.hash,entry.size);if(bytes.byteLength!==entry.size)throw new Error(`Large-file length check failed for ${entry.path}`);return bytes;}
    const bytes=await decryptBlob(await this.api.getBlob(entry.hash),this.getSettings().vaultKey,entry.hash);cache.set(entry.hash,bytes);return bytes;
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = normalizePath(path).split("/").slice(0, -1); let current = "";
    for (const part of parts) { current = current ? `${current}/${part}` : part; if (!await this.adapter.exists(current)) await this.adapter.mkdir(current); }
  }

  private disposableMetadata(path:string):boolean{const name=normalizePath(path).split("/").at(-1)?.toLowerCase()??"";return DISPOSABLE_FOLDER_METADATA.has(name)||name.startsWith("._");}

  private async localRecoveryPath(batch:string,path:string):Promise<string>{
    const base=normalizePath(`.gib-sync/local-recovery/${batch}/${path}`);let candidate=base,index=2;
    while(await this.adapter.exists(candidate)){const dot=base.lastIndexOf("."),slash=base.lastIndexOf("/"),stem=dot>slash?base.slice(0,dot):base,extension=dot>slash?base.slice(dot):"";candidate=`${stem} - ${index++}${extension}`;}
    return candidate;
  }

  private async currentFolderFile(path:string):Promise<boolean>{
    if(!this.include(path))return false;const retired=this.getSettings().retiredPaths[path];if(!retired)return true;
    try{return await hashBytes(new Uint8Array(await this.adapter.readBinary(path)))!==retired.hash;}catch{return true;}
  }

  private async retireFolderFile(path:string,batch:string):Promise<"kept"|"metadata"|"recovered">{
    if(await this.currentFolderFile(path))return "kept";
    await this.cooperate();this.expectLocalMutation(path,null);
    if(this.disposableMetadata(path)){await this.adapter.remove(path);return "metadata";}
    const trashLocal=(this.adapter as DataAdapter&{trashLocal?:DataAdapter["trashLocal"]}).trashLocal;
    if(typeof trashLocal==="function")try{await trashLocal.call(this.adapter,path);return "recovered";}catch{if(!await this.adapter.exists(path))return "recovered";}
    const recovery=await this.localRecoveryPath(batch,path);await this.ensureParent(recovery);await this.adapter.rename(path,recovery);
    return "recovered";
  }

  private async pruneRetiredTree(path:string,batch:string):Promise<{folders:number;metadata:number;recovered:number}>{
    const stat=await this.adapter.stat(path);if(stat?.type!=="folder")return {folders:0,metadata:0,recovered:0};
    let folders=0,metadata=0,recovered=0;const listing=await this.adapter.list(path);
    for(const folder of listing.folders){
      const normalized=normalizePath(folder),lower=normalized.toLowerCase();if(PROTECTED_FOLDER_ROOTS.has(lower))continue;
      await this.cooperate();const child=await this.pruneRetiredTree(normalized,batch);folders+=child.folders;metadata+=child.metadata;recovered+=child.recovered;
    }
    for(const file of listing.files){const result=await this.retireFolderFile(normalizePath(file),batch);if(result==="metadata")metadata++;else if(result==="recovered")recovered++;}
    const first=await this.adapter.list(path);if(first.files.length||first.folders.length)return {folders,metadata,recovered};
    await this.cooperate(true);const second=await this.adapter.list(path);if(second.files.length||second.folders.length)return {folders,metadata,recovered};
    if((await this.adapter.stat(path))?.type!=="folder")return {folders,metadata,recovered};
    this.expectLocalMutation(path,null);await this.adapter.rmdir(path,true);return {folders:folders+1,metadata,recovered};
  }

  private async inspectRetiredFolder(path:string):Promise<{canonical:boolean;blockers:string[]}>{
    const listing=await this.adapter.list(path);
    let canonical=false;const blockers:string[]=[];
    for(const file of listing.files){
      const normalized=normalizePath(file);
      if(await this.currentFolderFile(normalized))canonical=true;
      else if(blockers.length<4)blockers.push(normalized);
    }
    for(const folder of listing.folders){
      await this.cooperate();const child=await this.inspectRetiredFolder(folder);canonical ||= child.canonical;
      for(const blocker of child.blockers)if(blockers.length<4)blockers.push(blocker);
    }
    return {canonical,blockers};
  }

  private async pruneRetiredEmptyFolders():Promise<{removed:number;remaining:number;attempted:boolean}>{
    const settings=this.getSettings(),retired=Object.entries(settings.retiredPaths),newest=Math.max(0,...retired.map(([,state])=>state.retiredAt));
    if(!newest){settings.retiredFolderCount=0;settings.retiredFolderNote="";return {removed:0,remaining:0,attempted:false};}
    // Older clients could leave a retired branch in place when it contained an
    // ignored file. Retry those records after upgrades until accepted folder
    // topology has actually been applied on this device.
    if(newest<=settings.lastFolderCleanupAt&&!settings.retiredFolderCount)return {removed:0,remaining:0,attempted:false};
    const candidates=new Map<string,number>();
    for(const [path,state] of retired){
      const parts=normalizePath(path).split("/").slice(0,-1);let current="";
      for(const part of parts){
        current=current?`${current}/${part}`:part;const lower=current.toLowerCase();
        if(PROTECTED_FOLDER_ROOTS.has(lower)||!this.include(current))continue;
        candidates.set(current,Math.max(candidates.get(current)??0,state.retiredAt));
      }
    }
    const eligible=new Set<string>();let failures=0,removed=0;const failureDetails:string[]=[];
    for(const [path,retiredAt] of candidates){
      try{const stat=await this.adapter.stat(path);if(stat?.type==="folder")eligible.add(path);}catch(error){failures++;failureDetails.push(`${path}: ${error instanceof Error?error.message:String(error)}`);}
    }
    const ordered=[...eligible].sort((left,right)=>right.split("/").length-left.split("/").length||right.localeCompare(left));let metadataRemoved=0,recovered=0;const batch=new Date().toISOString().replace(/[:.]/g,"-");
    for(const path of ordered){
      await this.cooperate();
      try{
        if((await this.inspectRetiredFolder(path)).canonical)continue;
        const cleaned=await this.pruneRetiredTree(path,batch);removed+=cleaned.folders;metadataRemoved+=cleaned.metadata;recovered+=cleaned.recovered;
      }catch(error){failures++;failureDetails.push(`${path}: ${error instanceof Error?error.message:String(error)}`);}
    }
    const remainingPaths:string[]=[],remainingDetails:string[]=[];
    for(const path of eligible)try{
      if((await this.adapter.stat(path))?.type!=="folder")continue;
      // A parent may still legitimately contain accepted files after only one
      // of its child branches moved. It is healthy, not a stale folder shell.
      // Retry only branches made entirely of retired or device-local content.
      const inspection=await this.inspectRetiredFolder(path);
      if(!inspection.canonical){remainingPaths.push(path);remainingDetails.push(`${path} ← ${inspection.blockers.length?inspection.blockers.join(", "):"contents changed during cleanup"}`);}
    }catch(error){if(!failureDetails.some((item)=>item.startsWith(`${path}:`))){failures++;failureDetails.push(`${path}: ${error instanceof Error?error.message:String(error)}`);}}
    const remaining=remainingPaths.length;
    settings.retiredFolderCount=remaining;
    settings.retiredFolderNote=remaining?`${remaining} retired folder${remaining===1?" is":"s are"} blocked: ${remainingDetails.slice(0,4).join(" · ")}${remainingDetails.length>4?` · and ${remainingDetails.length-4} more`:""}`.slice(0,2000):"";
    if(!failures){settings.lastFolderCleanupAt=newest;settings.lastFolderCleanupError="";}
    else settings.lastFolderCleanupError=failureDetails.slice(0,8).join(" · ").slice(0,2000);
    if(removed)this.status({phase:"applying",message:`Removed ${removed} empty retired folder${removed===1?"":"s"} left by accepted moves or deletions`,level:"success"});
    if(metadataRemoved)this.status({phase:"applying",message:`Removed ${metadataRemoved} harmless platform metadata file${metadataRemoved===1?"":"s"} from retired folders`,level:"success"});
    if(recovered)this.status({phase:"applying",message:`Applied accepted folder deletions · moved ${recovered} device-only file${recovered===1?"":"s"} to local recovery`,level:"success"});
    if(failures)this.status({phase:"applying",message:`Empty-folder cleanup deferred for ${failures} path${failures===1?"":"s"}; ${failureDetails.slice(0,3).join(" · ")}; file reconciliation can continue and cleanup will retry`,level:"warning"});
    else if(remaining)this.status({phase:"applying",message:`Folder topology differs locally · ${settings.retiredFolderNote} · cleanup will retry safely`,level:"warning"});
    return {removed,remaining,attempted:true};
  }

  private managedTopLevelFolder(path:string):boolean{
    const top=normalizePath(path).split("/")[0],lower=top.toLowerCase();
    return Boolean(top)&&!PROTECTED_FOLDER_ROOTS.has(lower)&&this.include(top);
  }

  private async localManagedFolders():Promise<Set<string>>{
    const folders=new Set<string>();
    const visit=async(path:string):Promise<void>=>{const listing=await this.adapter.list(path);for(const folder of listing.folders){const normalized=normalizePath(folder);folders.add(normalized);await this.cooperate();await visit(normalized);}};
    const root=await this.adapter.list("");
    for(const folder of root.folders){const normalized=normalizePath(folder);if(!this.managedTopLevelFolder(normalized))continue;folders.add(normalized);await this.cooperate();await visit(normalized);}
    return folders;
  }

  private acceptedFolders(paths:Iterable<string>):Set<string>{
    const folders=new Set<string>();
    for(const path of paths){const parts=normalizePath(path).split("/").slice(0,-1);if(!parts.length||!this.managedTopLevelFolder(parts[0]))continue;let current="";for(const part of parts){current=current?`${current}/${part}`:part;folders.add(current);}}
    return folders;
  }

  private minimalFolderRoots(paths:Iterable<string>):string[]{
    return [...new Set(paths)].sort((left,right)=>left.split("/").length-right.split("/").length||left.localeCompare(right)).filter((path,index,all)=>!all.slice(0,index).some((parent)=>path.startsWith(`${parent}/`)));
  }

  private async folderHasSyncableFile(path:string):Promise<boolean>{
    const listing=await this.adapter.list(path);for(const file of listing.files)if(this.include(normalizePath(file)))return true;
    for(const folder of listing.folders){await this.cooperate();if(await this.folderHasSyncableFile(normalizePath(folder)))return true;}
    return false;
  }

  private async reconcileFolderTopology(acceptedPaths:Iterable<string>):Promise<{removed:number;remaining:number}>{
    const settings=this.getSettings(),desired=this.acceptedFolders(acceptedPaths),before=await this.localManagedFolders(),extraRoots=this.minimalFolderRoots([...before].filter((path)=>!desired.has(path)));
    let removed=0,recovered=0,metadata=0,failures=0;const failureDetails:string[]=[],batch=new Date().toISOString().replace(/[:.]/g,"-");
    for(const root of extraRoots){
      await this.cooperate();
      try{
        // A syncable file created during this run is a new vault change, not
        // stale topology. Preserve it and force normal file reconciliation.
        if(await this.folderHasSyncableFile(root))continue;
        const cleaned=await this.pruneRetiredTree(root,batch);removed+=cleaned.folders;recovered+=cleaned.recovered;metadata+=cleaned.metadata;
      }catch(error){failures++;failureDetails.push(`${root}: ${error instanceof Error?error.message:String(error)}`);}
    }
    const after=extraRoots.length?await this.localManagedFolders():before,extra=this.minimalFolderRoots([...after].filter((path)=>!desired.has(path))),missing=this.minimalFolderRoots([...desired].filter((path)=>!after.has(path))),remaining=extra.length+missing.length;
    settings.retiredFolderCount=remaining;
    settings.retiredFolderNote=remaining?`Folder topology differs from the accepted snapshot: ${[...extra.map((path)=>`extra ${path}`),...missing.map((path)=>`missing ${path}`)].slice(0,8).join(" · ")}${remaining>8?` · and ${remaining-8} more`:""}`.slice(0,2000):"";
    if(!failures)settings.lastFolderCleanupAt=Date.now();settings.lastFolderCleanupError=failures?failureDetails.slice(0,8).join(" · ").slice(0,2000):"";
    if(remaining)settings.fullScanRequired=true;
    if(removed)this.status({phase:"applying",message:`Folder topology reconciled · removed ${removed} obsolete folder${removed===1?"":"s"}`,level:"success"});
    if(recovered)this.status({phase:"applying",message:`Folder topology reconciled · moved ${recovered} ignored file${recovered===1?"":"s"} to local recovery`,level:"success"});
    if(metadata)this.status({phase:"applying",message:`Folder topology reconciled · removed ${metadata} harmless platform metadata file${metadata===1?"":"s"}`,level:"success"});
    if(remaining)this.status({phase:"applying",message:settings.retiredFolderNote,level:"warning"});
    return {removed,remaining};
  }

  private text(path: string): boolean { return TEXT_EXTENSIONS.has(path.split(".").pop()?.toLowerCase() ?? ""); }
  private conflictPath(path: string, deviceName: string, mtime: number, occupied: Set<string>): string {
    const index = path.lastIndexOf("."), slash = path.lastIndexOf("/");
    const device = deviceName.replace(/[\\/:*?"<>|\[\]#]/g, "-").replace(/\s+/g, " ").trim().slice(0, 40) || "Unknown device";
    const date = new Date(Number.isFinite(mtime) && mtime > 0 ? mtime : Date.now());
    const stamp = (Number.isNaN(date.getTime()) ? new Date() : date).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC").replace(/:/g, "-");
    const stem = index > slash ? path.slice(0, index) : path, extension = index > slash ? path.slice(index) : "";
    let candidate = `${stem} (conflict - ${device} - ${stamp})${extension}`, sequence = 2;
    while (occupied.has(candidate)) candidate = `${stem} (conflict - ${device} - ${stamp} - ${sequence++})${extension}`;
    return candidate;
  }
  private wikiLink(path:string):string {
    const target=path.toLowerCase().endsWith(".md")?path.slice(0,-3):path;
    return `[[${target.replace(/\|/g," ")}|${path.slice(path.lastIndexOf("/")+1)}]]`;
  }
  private warning(text:string, devices:string[], otherPath:string):string {
    return `> [!warning] Gib Sync conflict\n> Gib Sync preserved overlapping versions from **${devices.join("** and **")}**. No content was discarded.\n> Review the other version: ${this.wikiLink(otherPath)}\n\n${text}`;
  }
  private deletionWarning(text:string,editor:string,deleter:string):string {
    return `> [!warning] Gib Sync deletion conflict\n> **${deleter}** deleted this note while **${editor}** modified it. Gib Sync kept the modified content here; delete this note if the deletion was intended.\n\n${text}`;
  }
  private async preserveDeletion(path:string,clear:Uint8Array,editor:string,deleter:string,final:Map<string,FileState>,bytes:Map<string,Uint8Array>):Promise<void>{
    const preserved=path.toLowerCase().endsWith(".md")?encoder.encode(this.deletionWarning(decoder.decode(clear),editor,deleter)):clear;
    const hash=await hashBytes(preserved);bytes.set(hash,preserved);final.set(path,{path,hash,size:preserved.length,mtime:Date.now(),bytes:preserved});
  }
  private async preservePair(path:string,local:FileState,localBytes:Uint8Array,remote:FileState,localName:string,remoteName:string,preferred:"local"|"remote",final:Map<string,FileState>,bytes:Map<string,Uint8Array>,remoteCache:Map<string,Uint8Array>,occupied:Set<string>):Promise<void>{
    const remoteBytes=await this.remoteBytes(remote,remoteCache);
    const localIsNewer=preferred==="local";
    const loser=localIsNewer?remote:local;
    const winnerBytes=localIsNewer?localBytes:remoteBytes,loserBytes=localIsNewer?remoteBytes:localBytes;
    const loserName=localIsNewer?remoteName:localName;
    const copyPath=this.conflictPath(path,loserName,loser.mtime,occupied);occupied.add(copyPath);
    let originalClear=winnerBytes,copyClear=loserBytes;
    if(path.toLowerCase().endsWith(".md")){
      const names=[localName,remoteName];
      originalClear=encoder.encode(this.warning(decoder.decode(winnerBytes),names,copyPath));
      copyClear=encoder.encode(this.warning(decoder.decode(loserBytes),names,path));
    }
    const originalHash=await hashBytes(originalClear),copyHash=await hashBytes(copyClear);bytes.set(originalHash,originalClear);bytes.set(copyHash,copyClear);
    final.set(path,{path,hash:originalHash,size:originalClear.length,mtime:Date.now(),bytes:originalClear});
    final.set(copyPath,{path:copyPath,hash:copyHash,size:copyClear.length,mtime:Date.now(),bytes:copyClear});
  }
  private same(a?: FileState, b?: FileState) { return a?.hash === b?.hash && (!!a === !!b); }
  private localChangeTime(path:string,entry:FileState|undefined,baseSnapshot:Snapshot|null):number{
    const normalized=normalizePath(path),times=this.getSettings().pendingPathTimes;
    let journaled=times[normalized]??0,longest=0;
    for(const [prefix,time] of Object.entries(times))if(prefix.endsWith("/")&&normalized.startsWith(prefix)&&prefix.length>longest){longest=prefix.length;journaled=time;}
    if(journaled)return journaled;
    const mtime=entry?.mtime??0,baseline=baseSnapshot?Date.parse(baseSnapshot.createdAt):0,now=Date.now();
    const plausible=Number.isFinite(mtime)&&mtime>0&&mtime<now+5*60_000?mtime:now;
    return Math.max(plausible,Number.isFinite(baseline)?baseline:0);
  }
  private preferredSide(path:string,local:FileState|undefined,baseSnapshot:Snapshot|null,remoteSnapshot:Snapshot|null):"local"|"remote"{
    const remoteTime=remoteSnapshot?Date.parse(remoteSnapshot.createdAt):0;
    return this.localChangeTime(path,local,baseSnapshot)>(Number.isFinite(remoteTime)?remoteTime:0)?"local":"remote";
  }
  private canonicalizeMoves(base:Map<string,FileState>,local:Map<string,FileState>,remote:Map<string,FileState>,baseSnapshot:Snapshot|null,remoteSnapshot:Snapshot|null):number{
    const localMoves=new Map(detectMoves([...base.values()],[...local.values()]).map((item)=>[item.previousPath,item.path]));
    const remoteMoves=new Map(detectMoves([...base.values()],[...remote.values()]).map((item)=>[item.previousPath,item.path]));
    const sources=[...new Set([...localMoves.keys(),...remoteMoves.keys()])].sort(),claimed=new Set<string>();let recognized=0;
    for(const source of sources){
      const b=base.get(source),localDestination=localMoves.get(source),remoteDestination=remoteMoves.get(source);if(!b)continue;
      const localPath=localDestination??source,remotePath=remoteDestination??source,l=local.get(localPath),r=remote.get(remotePath);if(!l&&!r)continue;
      if(localDestination&&!remoteDestination&&remote.has(localDestination))continue;
      if(remoteDestination&&!localDestination&&local.has(remoteDestination))continue;
      if(localDestination&&remoteDestination&&localDestination!==remoteDestination&&(remote.has(localDestination)||local.has(remoteDestination)))continue;
      let destination=localDestination??remoteDestination!;
      if(localDestination&&remoteDestination&&localDestination!==remoteDestination)destination=this.preferredSide(localDestination,l,baseSnapshot,remoteSnapshot)==="local"?localDestination:remoteDestination;
      if(!destination||claimed.has(destination)||base.has(destination))continue;claimed.add(destination);
      base.delete(source);local.delete(source);remote.delete(source);if(localDestination)local.delete(localDestination);if(remoteDestination)remote.delete(remoteDestination);
      base.set(destination,{...b,path:destination});
      if(l)local.set(destination,{...l,path:destination,sourcePath:l.sourcePath??localPath});
      if(r)remote.set(destination,{...r,path:destination});
      recognized++;
    }
    return recognized;
  }
  private packageSame(left:Map<string,FileState>,right:Map<string,FileState>):boolean{return left.size===right.size&&[...left].every(([path,entry])=>right.get(path)?.hash===entry.hash);}
  private compareVersions(left:string|null,right:string|null):number{
    if(left===right)return 0;if(!left)return -1;if(!right)return 1;
    const parse=(value:string)=>{const [core,pre]=value.split("-",2);return {parts:core.split(".").map((part)=>Number.parseInt(part,10)||0),pre:pre??""};},a=parse(left),b=parse(right);
    for(let index=0;index<Math.max(a.parts.length,b.parts.length);index++){const difference=(a.parts[index]??0)-(b.parts[index]??0);if(difference)return difference;}
    if(!a.pre&&b.pre)return 1;if(a.pre&&!b.pre)return -1;return a.pre.localeCompare(b.pre);
  }
  private async convergeAfterConflict(attempt:number,reason:string):Promise<SyncResult>{
    if(attempt>=7)throw new Error("The vault kept changing during eight convergence attempts. Gib Sync preserved every committed version; retry once editing settles.");
    const delay=Math.min(2000,100*(2**attempt))+Math.floor(Math.random()*250);
    this.status({phase:"merging",message:`${reason}; converging again in ${(delay/1000).toFixed(1)}s`});
    await this.wait(delay);return this.run(attempt+1);
  }
  private async ownDescendantCount(requestedBaseId:string|null,remote:Snapshot|null,deviceId:string):Promise<number>{
    if(!requestedBaseId||!remote||remote.id===requestedBaseId||remote.deviceId!==deviceId)return 0;
    let cursor=remote,count=0;
    // A stale local checkpoint can lag by several successful saves. Only
    // recover across an unbroken chain authored by this registered device;
    // another device or Seafile in the chain keeps normal three-way merging.
    while(count<64){
      if(cursor.deviceId!==deviceId)return 0;
      count++;
      if(cursor.parentId===requestedBaseId)return count;
      if(!cursor.parentId)return 0;
      try{cursor=await this.api.snapshot(cursor.parentId);}catch{return 0;}
    }
    return 0;
  }
  private retryableMirrorError(error:unknown):boolean{return error instanceof ApiError&&(error.status===409||error.status===422);}

  private async mirror(snapshotId:string,entries:ManifestEntry[],final:Map<string,FileState>,bytes:Map<string,Uint8Array>,remoteCache:Map<string,Uint8Array>):Promise<number>{
    this.status({phase:"mirroring",message:"Planning the readable Seafile recovery copy"});const plan=await this.api.mirrorPlan(snapshotId,entries);if(plan.alreadyCurrent)return 0;
    let mirrored=0;for(const path of plan.uploadPaths){await this.cooperate();const entry=final.get(path);if(!entry)throw new Error(`Mirror plan referenced missing path: ${path}`);const clear=bytes.get(entry.hash)??await this.remoteBytes(entry,remoteCache);if(entry.size<LOW_MEMORY_DOWNLOAD_BYTES)bytes.set(entry.hash,clear);
      await this.api.putMirrorFile(snapshotId,path,entry.hash,clear);if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES){bytes.delete(entry.hash);remoteCache.delete(entry.hash);}mirrored++;if(this.progress(mirrored,plan.uploadPaths.length))this.status({phase:"mirroring",message:`Writing readable recovery files (${mirrored}/${plan.uploadPaths.length})`,current:mirrored,total:plan.uploadPaths.length});}
    await this.api.mirrorComplete(snapshotId);this.status({phase:"mirroring",message:`Readable recovery copy is current · ${entries.length} files`});return mirrored;
  }

  private async applyFinal(final:Map<string,FileState>,physicalLocal:Map<string,FileState>,desktopOnlyPlugins:Set<string>,scanned:LocalScan,orphanUnreadableConflicts:string[],bytes:Map<string,Uint8Array>,remoteCache:Map<string,Uint8Array>):Promise<{downloaded:number;deleted:number}>{
    let downloaded=0,deleted=0;this.status({phase:"applying",message:"Applying the accepted snapshot to this device"});
    const applyOrder=[...final].sort(([left,leftEntry],[right,rightEntry])=>{
      const rank=(path:string,entry:FileState)=>path===".obsidian/community-plugins.json"?4:entry.size>=LOW_MEMORY_DOWNLOAD_BYTES?3:obsidianPluginPath(path)?0:isObsidianSystemPath(path)?2:1;
      return rank(left,leftEntry)-rank(right,rightEntry)||left.localeCompare(right);
    });
    for(const [path,entry] of applyOrder){
      await this.cooperate();let deviceEntry=entry,deviceClear:Uint8Array|undefined;
      if(this.isMobileDevice&&path===".obsidian/community-plugins.json"&&desktopOnlyPlugins.size){
        const serverClear=bytes.get(entry.hash)??await this.remoteBytes(entry,remoteCache);
        try{const enabled=JSON.parse(decoder.decode(serverClear)) as unknown;if(Array.isArray(enabled)){deviceClear=encoder.encode(`${JSON.stringify(enabled.filter((id)=>typeof id==="string"&&!desktopOnlyPlugins.has(id)),null,2)}\n`);const hash=await hashBytes(deviceClear);deviceEntry={...entry,hash,size:deviceClear.length};}}catch{}
      }
      if(physicalLocal.get(path)?.hash===deviceEntry.hash)continue;
      if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES)this.status({phase:"applying",message:`Downloading large file with mobile-safe memory use · ${path} · ${(entry.size/1024/1024).toFixed(1)} MB`,current:downloaded,total:applyOrder.length});
      const clear=deviceClear??bytes.get(entry.hash)??await this.remoteBytes(entry,remoteCache);if(entry.size<LOW_MEMORY_DOWNLOAD_BYTES&&!deviceClear)bytes.set(entry.hash,clear);
      await this.ensureParent(path);this.expectLocalMutation(path,deviceEntry.hash);await this.adapter.writeBinary(path,exactArrayBuffer(clear));if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES){bytes.delete(entry.hash);remoteCache.delete(entry.hash);}downloaded++;
    }
    for(const path of physicalLocal.keys())if(!final.has(path)&&this.include(path)){
      await this.cooperate();if(scanned.unreadableConflictPaths.has(path)){this.status({phase:"applying",message:`Left inaccessible generated conflict entry isolated on this device · ${path}`,level:"warning"});continue;}
      this.expectLocalMutation(path,null);await this.adapter.remove(path);deleted++;
    }
    for(const path of orphanUnreadableConflicts){await this.cooperate();try{this.expectLocalMutation(path,null);await this.adapter.remove(path);deleted++;this.status({phase:"applying",message:`Removed orphaned generated conflict copy after its handle released · ${path}`,level:"success"});}catch{this.status({phase:"applying",message:`Generated conflict copy is still locked locally and absent from the accepted vault · ${path} · it will be retried without upload`,level:"warning"});}}
    return {downloaded,deleted};
  }

  private trimRetiredPaths(){
    const settings=this.getSettings(),cutoff=Date.now()-RETIRED_PATH_MAX_AGE;
    const kept=Object.entries(settings.retiredPaths).filter(([,value])=>value.retiredAt>=cutoff).sort((left,right)=>right[1].retiredAt-left[1].retiredAt).slice(0,RETIRED_PATH_LIMIT);
    settings.retiredPaths=Object.fromEntries(kept);
    settings.folderCreateTimes=Object.fromEntries(Object.entries(settings.folderCreateTimes).filter(([,createdAt])=>createdAt>=cutoff).sort((left,right)=>right[1]-left[1]).slice(0,RETIRED_PATH_LIMIT));
  }
  private async deviceBytes(path:string,entry:FileState,cache:Map<string,Uint8Array>,desktopOnly:Set<string>):Promise<{clear:Uint8Array;hash:string}>{
    let clear=await this.remoteBytes(entry,cache),hash=entry.hash;
    if(this.isMobileDevice&&path===".obsidian/community-plugins.json"&&desktopOnly.size)try{
      const enabled=JSON.parse(decoder.decode(clear)) as unknown;
      if(Array.isArray(enabled)){clear=encoder.encode(`${JSON.stringify(enabled.filter((id)=>typeof id==="string"&&!desktopOnly.has(id)),null,2)}\n`);hash=await hashBytes(clear);}
    }catch{}
    return {clear,hash};
  }
  private async resumePendingApplication():Promise<number>{
    const settings=this.getSettings(),pending=[...new Set(settings.pendingApplyPaths.map((path)=>normalizePath(path)).filter(Boolean))];if(!pending.length)return 0;
    // v0.8.33 recorded lastSnapshotId before applying. Treat it as the staged
    // target when upgrading an interrupted journal that predates explicit ids.
    const targetId=settings.pendingApplySnapshotId??settings.lastSnapshotId;if(!targetId)throw new SyncSafetyError("An accepted device update is pending, but its target snapshot was not recorded.");
    const target=await this.api.snapshot(targetId).catch(()=>null);if(!target)throw new SyncSafetyError("An accepted device update is pending, but its exact server snapshot is unavailable. No local files were uploaded or deleted.");
    const priorId=settings.pendingApplyBaseSnapshotId??target.parentId,prior=priorId?await this.api.snapshot(priorId).catch(()=>null):null,targetMap=this.map(target),priorMap=this.map(prior),cache=new Map<string,Uint8Array>(),desktopOnly=new Set<string>();let completed=0,preserved=0;
    if(this.isMobileDevice)for(const [path,entry] of targetMap){const plugin=obsidianPluginPath(path);if(plugin?.relative.toLowerCase()!=="manifest.json")continue;try{if((JSON.parse(decoder.decode(await this.remoteBytes(entry,cache))) as {isDesktopOnly?:unknown}).isDesktopOnly===true)desktopOnly.add(plugin.id);}catch{}}
    for(const path of pending){const old=priorMap.get(path);if(!targetMap.has(path)&&old)settings.retiredPaths[path]={hash:old.hash,snapshotId:target.id,retiredAt:Date.now()};}
    this.trimRetiredPaths();await this.saveSettings();
    this.status({phase:"applying",message:`Resuming ${pending.length} accepted file operation${pending.length===1?"":"s"} from its exact snapshot`});
    for(const path of pending){
      await this.cooperate();const entry=targetMap.get(path),old=priorMap.get(path),stat=await this.adapter.stat(path);let currentHash:string|null=null;
      if(stat?.type==="file")currentHash=await hashBytes(new Uint8Array(await this.adapter.readBinary(path)));
      const priorHash=Object.prototype.hasOwnProperty.call(settings.pendingApplyPriorHashes,path)?settings.pendingApplyPriorHashes[path]:(old?.hash??null);
      if(entry){
        const expected=await this.deviceBytes(path,entry,cache,desktopOnly);if(currentHash===expected.hash){completed++;continue;}
        if(currentHash!==null&&currentHash!==priorHash){preserved++;settings.pendingPathTimes[path]=settings.pendingPathTimes[path]??Date.now();if(!settings.pendingPaths.includes(path))settings.pendingPaths.push(path);completed++;continue;}
        await this.ensureParent(path);this.expectLocalMutation(path,expected.hash);await this.adapter.writeBinary(path,exactArrayBuffer(expected.clear));
      }else if(stat){
        if(old&&currentHash===old.hash){this.expectLocalMutation(path,null);await this.adapter.remove(path);}
        else{preserved++;settings.pendingPathTimes[path]=settings.pendingPathTimes[path]??Date.now();if(!settings.pendingPaths.includes(path))settings.pendingPaths.push(path);}
      }
      completed++;if(this.progress(completed,pending.length))this.status({phase:"applying",message:"Resuming accepted device state",current:completed,total:pending.length});
    }
    const retiredCleanup=await this.pruneRetiredEmptyFolders(),topology=await this.reconcileFolderTopology(target.entries.map((entry)=>entry.path));settings.lastSnapshotId=target.id;settings.initialized=true;settings.pendingApplyPaths=[];settings.pendingApplySnapshotId=null;settings.pendingApplyBaseSnapshotId=null;settings.pendingApplyPriorHashes={};settings.pendingPaths=[...new Set(settings.pendingPaths)].sort();if(settings.syncPlugins)settings.pluginSyncBootstrapPending=false;await this.saveSettings();
    if(preserved)this.status({phase:"applying",message:`Preserved ${preserved} genuine local change${preserved===1?"":"s"} made during the interrupted download; they will reconcile normally`,level:"success"});
    return retiredCleanup.removed+topology.removed;
  }

  private async stageAndApply(snapshotId:string,final:Map<string,FileState>,topologyPaths:Iterable<string>,physicalLocal:Map<string,FileState>,desktopOnlyPlugins:Set<string>,scanned:LocalScan,orphanUnreadableConflicts:string[],bytes:Map<string,Uint8Array>,remoteCache:Map<string,Uint8Array>):Promise<{downloaded:number;deleted:number;prunedFolders:number}>{
    const changed=[...final].filter(([path,entry])=>physicalLocal.get(path)?.hash!==entry.hash).map(([path])=>path),removed=[...physicalLocal.keys()].filter((path)=>!final.has(path));
    const settings=this.getSettings(),baseId=settings.lastSnapshotId;settings.pendingApplySnapshotId=snapshotId;settings.pendingApplyBaseSnapshotId=baseId;settings.pendingApplyPaths=[...new Set([...changed,...removed,...orphanUnreadableConflicts])].sort();
    settings.pendingApplyPriorHashes=Object.fromEntries(settings.pendingApplyPaths.map((path)=>[path,physicalLocal.get(path)?.hash??null]));
    for(const path of removed){const previous=physicalLocal.get(path);if(previous)settings.retiredPaths[path]={hash:previous.hash,snapshotId,retiredAt:Date.now()};}
    settings.pendingPaths=[];settings.pendingPathTimes={};this.trimRetiredPaths();await this.saveSettings();
    const result=await this.applyFinal(final,physicalLocal,desktopOnlyPlugins,scanned,orphanUnreadableConflicts,bytes,remoteCache),retiredCleanup=await this.pruneRetiredEmptyFolders(),topology=await this.reconcileFolderTopology(topologyPaths);
    settings.lastSnapshotId=snapshotId;settings.initialized=true;settings.pendingApplyPaths=[];settings.pendingApplySnapshotId=null;settings.pendingApplyBaseSnapshotId=null;settings.pendingApplyPriorHashes={};if(settings.syncPlugins)settings.pluginSyncBootstrapPending=false;await this.saveSettings();return {...result,prunedFolders:retiredCleanup.removed+topology.removed};
  }

  private async run(attempt: number): Promise<SyncResult> {
    const settings = this.getSettings(); if (!settings.deviceToken || !settings.vaultKey) throw new Error("Gib Sync is not configured");
    const initialFolderCleanup=await this.pruneRetiredEmptyFolders();let prunedFolders=initialFolderCleanup.removed;if(initialFolderCleanup.attempted)await this.saveSettings();
    let requestedBaseId=settings.lastSnapshotId;
    const pendingPaths=[...new Set(settings.pendingPaths.map((path)=>normalizePath(path)).filter(Boolean))];
    const lastAudit=settings.lastFullScanAt?Date.parse(settings.lastFullScanAt):0,auditDue=!lastAudit||Date.now()-lastAudit>=6*60*60*1000;
    this.status({phase:"reading-remote",message:"Checking for a newer server snapshot"});
    let remoteHeadId:string|null;
    try{remoteHeadId=(await this.api.headState()).headId;}catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;remoteHeadId=(await this.api.state()).head?.id??null;}
    if(settings.initialized&&!settings.pendingApplyPaths.length&&!settings.fullScanRequired&&!settings.pluginSyncBootstrapPending&&!auditDue&&!pendingPaths.length&&remoteHeadId===requestedBaseId){
      const accepted=requestedBaseId?await this.api.snapshot(requestedBaseId):null,topology=await this.reconcileFolderTopology((accepted?.entries??[]).map((entry)=>entry.path));prunedFolders+=topology.removed;await this.saveSettings();
      this.status({phase:topology.remaining?"applying":"up-to-date",message:topology.remaining?settings.retiredFolderNote:"Up to date · accepted file manifest and observed folders agree",level:topology.remaining?"warning":"success"});
      return {uploaded:0,downloaded:0,deleted:0,prunedFolders,pendingRetiredFolders:settings.retiredFolderCount,conflicts:0,resolved:0,mirrored:0,snapshotId:requestedBaseId,processedPaths:[],fullScan:false};
    }
    const remoteSnapshot=(await this.api.state()).head;
    if(settings.pendingApplyPaths.length){prunedFolders+=await this.resumePendingApplication();requestedBaseId=settings.lastSnapshotId;}
    const baseSnapshot = requestedBaseId ? await this.api.snapshot(requestedBaseId).catch(() => null) : null;
    const ownDescendants=baseSnapshot&&pendingPaths.length?await this.ownDescendantCount(requestedBaseId,remoteSnapshot,settings.deviceId):0;
    const fullScan=settings.fullScanRequired||settings.pluginSyncBootstrapPending||!settings.initialized||!baseSnapshot||auditDue;
    this.status({phase:"scanning",message:fullScan?"Reconciling the full local vault":pendingPaths.length?`Checking ${pendingPaths.length} changed path${pendingPaths.length===1?"":"s"}`:"No local paths changed"});
    const scanBaseline=ownDescendants&&remoteSnapshot?remoteSnapshot:baseSnapshot;
    const scanned=fullScan?await this.scan():await this.scanIncremental(scanBaseline!,pendingPaths),local=scanned.files;
    let effectiveBaseSnapshot=baseSnapshot;
    if(ownDescendants&&remoteSnapshot){
      const remoteMap=this.map(remoteSnapshot),allPaths=new Set([...local.keys(),...remoteMap.keys()]),pending=new Set(pendingPaths);
      const differences=[...allPaths].filter((path)=>local.get(path)?.hash!==remoteMap.get(path)?.hash||local.has(path)!==remoteMap.has(path));
      if(!fullScan||differences.every((path)=>pending.has(path))){
        effectiveBaseSnapshot=remoteSnapshot;
        this.status({phase:"merging",message:`Recovered a stale local checkpoint across ${ownDescendants} prior sync${ownDescendants===1?"":"s"} from this device; applying only newly observed local changes`,level:"success"});
      }else{
        this.status({phase:"merging",message:"A stale local checkpoint followed this device's own sync, but unjournaled vault differences require normal lossless reconciliation",level:"warning"});
      }
    }
    let onboardingReconcile=false;
    if(settings.initialized&&requestedBaseId&&!baseSnapshot&&local.size){
      throw new SyncSafetyError("Stale-device protection paused sync because this device's last verified server snapshot is unavailable. No files were uploaded or deleted. Reconnect this device to establish a safe baseline.");
    }
    if(remoteSnapshot&&!baseSnapshot&&local.size){
      const remoteHashes=new Map(remoteSnapshot.entries.filter((entry)=>this.include(entry.path)).map((entry)=>[entry.path,entry.hash]));
      const unexpected=[...local.values()].filter((entry)=>remoteHashes.get(entry.path)!==entry.hash);
      if(unexpected.length){
        const exactMatches=[...local.values()].filter((entry)=>remoteHashes.get(entry.path)===entry.hash).length;
        const comparedSize=Math.max(local.size,remoteHashes.size),overlap=comparedSize?exactMatches/comparedSize:0;
        const localUserFiles=[...local.values()].filter((entry)=>!isObsidianSystemPath(entry.path)),exactUserMatches=localUserFiles.filter((entry)=>remoteHashes.get(entry.path)===entry.hash).length;
        const localAgreement=localUserFiles.length?exactUserMatches/localUserFiles.length:1,interruptedDownload=localUserFiles.length===0||(exactUserMatches>0&&localAgreement>=0.8);
        if(overlap<0.9&&!interruptedDownload)throw new SyncSafetyError(`Onboarding protection paused sync because this appears to be a different populated vault (${exactMatches} of ${comparedSize} files match the server; ${exactUserMatches} of ${localUserFiles.length} local user files match). No files were uploaded or deleted. Verify that you opened the intended local and server vaults.`);
        onboardingReconcile=true;
        this.status({phase:"merging",message:overlap>=0.9?`Matching vault recognized · ${exactMatches}/${comparedSize} files agree; preserving every difference`:`Interrupted onboarding recognized · ${exactUserMatches}/${localUserFiles.length} local user files already match; resuming the server-first download while preserving local-only files`,level:"success"});
      }
    }
    const base = this.map(effectiveBaseSnapshot), remote = this.map(remoteSnapshot);for(const path of scanned.unreadableConflictPaths){const accepted=base.get(path)??remote.get(path);if(accepted)local.set(path,accepted);}
    const physicalLocal=new Map(local),bootstrapPluginSync=settings.syncPlugins&&settings.pluginSyncBootstrapPending,acceptedPluginState=Boolean(bootstrapPluginSync&&remoteSnapshot&&[...remote.keys()].some((path)=>this.pluginSyncPath(path)));
    if(acceptedPluginState){for(const path of new Set([...local.keys(),...remote.keys()].filter((candidate)=>this.pluginSyncPath(candidate)))){const accepted=remote.get(path);if(accepted)local.set(path,accepted);else local.delete(path);}this.status({phase:"merging",message:"Plugin sync first activation · adopting the accepted server plugin inventory and settings before publishing device changes",level:"success"});}
    else if(bootstrapPluginSync)this.status({phase:"merging",message:"Plugin sync first activation · no accepted plugin inventory exists, so this device will establish it",level:"info"});
    const orphanUnreadableConflicts=[...scanned.unreadableConflictPaths].filter((path)=>!base.has(path)&&!remote.has(path));let suppressedRetired=0,retiredStateChanged=false;
    for(const [path,retired] of Object.entries(settings.retiredPaths)){
      const current=local.get(path);
      if(remote.has(path)){delete settings.retiredPaths[path];retiredStateChanged=true;continue;}
      if(current?.hash===retired.hash){local.delete(path);suppressedRetired++;continue;}
      if(current){delete settings.retiredPaths[path];retiredStateChanged=true;}
    }
    this.trimRetiredPaths();if(retiredStateChanged)await this.saveSettings();
    if(suppressedRetired)this.status({phase:"merging",message:`Removed ${suppressedRetired} stale retired path${suppressedRetired===1?"":"s"} that reappeared after an earlier accepted move or deletion`,level:"success"});
    const recognizedMoves=this.canonicalizeMoves(base,local,remote,effectiveBaseSnapshot,remoteSnapshot),final = new Map<string, FileState>();
    const bytes = new Map<string, Uint8Array>(); const remoteCache = new Map<string, Uint8Array>();
    const paths = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);const occupied=new Set(paths);
    let conflicts = 0,resolved=0; this.status({phase:"merging",message:`Comparing ${paths.size} paths · ${local.size} local · ${remote.size} remote · ${base.size} baseline`});
    if(recognizedMoves)this.status({phase:"merging",message:`Recognized ${recognizedMoves} file move${recognizedMoves===1?"":"s"} by content identity; edits will follow the destination`,level:"success"});
    const handledPluginPaths=new Set<string>(),desktopOnlyPlugins=new Set<string>();
    if(settings.syncPlugins){
      const pluginIds=new Set([...paths].map((path)=>obsidianPluginPath(path)?.id).filter((id):id is string=>Boolean(id)));
      const packageFor=(source:Map<string,FileState>,id:string)=>new Map([...source].filter(([path])=>{const plugin=obsidianPluginPath(path);return plugin?.id===id&&!isPluginDataPath(path);}));
      const localPackageIsNewer=(entries:Map<string,FileState>)=>Math.max(0,...[...entries].map(([path,entry])=>this.localChangeTime(path,entry,effectiveBaseSnapshot)))>(remoteSnapshot?Date.parse(remoteSnapshot.createdAt):0);
      const versionFor=async(source:"local"|"remote",entries:Map<string,FileState>,id:string):Promise<string|null>=>{
        const entry=entries.get(`.obsidian/plugins/${id}/manifest.json`);if(!entry)return null;
        try{const clear=source==="local"&&!acceptedPluginState?await this.localBytes(entry.path,entry,bytes):await this.remoteBytes(entry,remoteCache);return (JSON.parse(decoder.decode(clear)) as {version?:unknown}).version as string??null;}catch{return null;}
      };
      for(const id of [...pluginIds].sort()){
        await this.cooperate();
        const baseline=packageFor(base,id),localPackage=packageFor(local,id),remotePackage=packageFor(remote,id);
        for(const path of new Set([...baseline.keys(),...localPackage.keys(),...remotePackage.keys()]))handledPluginPaths.add(path);
        const localChanged=!this.packageSame(localPackage,baseline),remoteChanged=!this.packageSame(remotePackage,baseline);
        let chosen=remotePackage,side:"local"|"remote"="remote",reason="both devices already agree";
        const localVersion=await versionFor("local",localPackage,id),remoteVersion=await versionFor("remote",remotePackage,id);
        if(this.packageSame(localPackage,remotePackage)){chosen=remotePackage;}
        else if(!localPackage.size||!remotePackage.size){
          if(localChanged&&!remoteChanged){chosen=localPackage;side="local";reason=localPackage.size?"this device installed the package":"this device removed the package";}
          else if(!localChanged&&remoteChanged){reason=remotePackage.size?"the server installed the package":"the server removed the package";}
          else{const useLocal=localPackageIsNewer(localPackage);side=useLocal?"local":"remote";chosen=useLocal?localPackage:remotePackage;reason=`concurrent install/removal used the later ${side} change`;resolved++;}
        }else{
          const localComplete=localPackage.has(`.obsidian/plugins/${id}/manifest.json`)&&localPackage.has(`.obsidian/plugins/${id}/main.js`),remoteComplete=remotePackage.has(`.obsidian/plugins/${id}/manifest.json`)&&remotePackage.has(`.obsidian/plugins/${id}/main.js`);
          const versionOrder=this.compareVersions(localVersion,remoteVersion);
          if(localComplete!==remoteComplete){side=localComplete?"local":"remote";chosen=side==="local"?localPackage:remotePackage;reason=`repaired an incomplete ${side==="local"?"server":"local"} package from the complete copy`;resolved++;}
          else if(versionOrder>0){side="local";chosen=localPackage;reason=`newer plugin version ${localVersion} supersedes ${remoteVersion??"unknown"}`;resolved++;}
          else if(versionOrder<0){reason=`newer plugin version ${remoteVersion} supersedes ${localVersion??"unknown"}`;resolved++;}
          else if([...localPackage.keys()].some((path)=>!remotePackage.has(path))||[...remotePackage.keys()].some((path)=>!localPackage.has(path))){
            chosen=new Map(remotePackage);for(const [path,entry] of localPackage)if(!chosen.has(path))chosen.set(path,entry);
            reason="same plugin version; restored ancillary files missing from either complete package";resolved++;
          }
          else if(localChanged&&!remoteChanged){chosen=localPackage;side="local";reason="only this device changed the package";}
          else if(!localChanged&&remoteChanged){reason="only the server package changed";}
          else if(localPackageIsNewer(localPackage)){side="local";chosen=localPackage;reason="same plugin version; local package change was observed later";resolved++;}
          else{reason="same plugin version; server package was modified later";resolved++;}
        }
        for(const [path,entry] of chosen)final.set(path,entry);
        if(localChanged||remoteChanged)this.status({phase:"merging",message:`Plugin package · ${id} · chose ${side}${(side==="local"?localVersion:remoteVersion)?` v${side==="local"?localVersion:remoteVersion}`:""} · ${reason}`,level:"info"});
      }
      for(const id of pluginIds){
        const path=`.obsidian/plugins/${id}/manifest.json`,entry=final.get(path);if(!entry)continue;
        try{
          const localEntry=local.get(path),clear=bytes.get(entry.hash)??(localEntry?.hash===entry.hash?await this.localBytes(path,localEntry,bytes):await this.remoteBytes(entry,remoteCache));
          if((JSON.parse(decoder.decode(clear)) as {isDesktopOnly?:unknown}).isDesktopOnly===true)desktopOnlyPlugins.add(id);
        }catch{/* Malformed manifests remain governed by normal package repair. */}
      }
    }
    for (const path of [...paths].sort()) {
      await this.cooperate();
      if(handledPluginPaths.has(path))continue;
      const b = base.get(path), l = local.get(path), r = remote.get(path);
      if (this.same(l, r)) { if (l) final.set(path, l); continue; }
      if(settings.syncPlugins&&path===".obsidian/community-plugins.json"&&b&&l&&r){
        const baseText=decoder.decode(await this.remoteBytes(b,remoteCache)),localText=decoder.decode(await this.localBytes(path,l,bytes)),remoteText=decoder.decode(await this.remoteBytes(r,remoteCache)),preferred=this.preferredSide(path,l,effectiveBaseSnapshot,remoteSnapshot);
        const merged=mergeCommunityPluginEnablement(baseText,localText,remoteText,preferred,desktopOnlyPlugins,this.isMobileDevice),clear=encoder.encode(merged.text),hash=await hashBytes(clear);bytes.set(hash,clear);final.set(path,{path,hash,size:clear.length,mtime:Date.now(),bytes:clear});resolved++;
        this.status({phase:"merging",message:`Plugin enablement · ${merged.reason}`,level:"success"});continue;
      }
      if (!b && l && !r && isGibSyncConflictPath(path)) { resolved++;this.status({phase:"merging",message:`Removing orphaned generated conflict copy · ${path}`,level:"success"});continue; }
      if (!settings.initialized && !b && !l && r) { final.set(path, r); continue; }
      if (this.same(l, b)) { if (r) final.set(path, r); continue; }
      if (this.same(r, b)) { if (l) final.set(path, l); continue; }
      if (!b && l && !r) { final.set(path, l); continue; }
      if (!b && !l && r) { final.set(path, r); continue; }
      if (!l && !r) continue;
      if(isObsidianSystemPath(path)){
        if(b&&(!l||!r)){
          const kept=l??r;if(kept)final.set(path,kept);resolved++;this.status({phase:"merging",message:`Obsidian system file · ${path} · kept the modified version instead of an overlapping deletion`,level:"warning"});continue;
        }
        if(l&&r){
          const preferred=this.preferredSide(path,l,effectiveBaseSnapshot,remoteSnapshot);
          if(path.toLowerCase().endsWith(".json")){
            const baseText=b?decoder.decode(await this.remoteBytes(b,remoteCache)):"{}",localText=decoder.decode(await this.localBytes(path,l,bytes)),remoteText=decoder.decode(await this.remoteBytes(r,remoteCache));
            const merged=path===".obsidian/community-plugins.json"?mergeCommunityPluginEnablement(baseText,localText,remoteText,preferred,desktopOnlyPlugins,this.isMobileDevice):mergeSystemJson(baseText,localText,remoteText,preferred),clear=encoder.encode(merged.text),hash=await hashBytes(clear);bytes.set(hash,clear);final.set(path,{path,hash,size:clear.length,mtime:Date.now(),bytes:clear});
            this.status({phase:"merging",message:`Obsidian settings · ${path} · ${merged.reason}`,level:merged.overlaps?"warning":"success"});
          }else{const chosen=preferred==="local"?l:r;final.set(path,chosen);this.status({phase:"merging",message:`Obsidian system file · ${path} · used newer ${preferred} whole file`,level:"info"});}
          resolved++;continue;
        }
      }
      if(b&&(!l||!r)){
        conflicts++;
        if(l)await this.preserveDeletion(path,await this.localBytes(path,l,bytes),settings.deviceName,remoteSnapshot?.deviceName??"Remote device",final,bytes);
        else if(r)await this.preserveDeletion(path,await this.remoteBytes(r,remoteCache),remoteSnapshot?.deviceName??"Remote device",settings.deviceName,final,bytes);
        continue;
      }
      if (l && r && this.text(path)) {
        if(!b){
          const preferred=this.preferredSide(path,l,effectiveBaseSnapshot,remoteSnapshot);conflicts++;await this.preservePair(path,l,await this.localBytes(path,l,bytes),r,settings.deviceName,remoteSnapshot?.deviceName??"Remote device",preferred,final,bytes,remoteCache,occupied);continue;
        }
        const baseText = b ? decoder.decode(await this.remoteBytes(b, remoteCache)) : "";
        const localText = decoder.decode(await this.localBytes(path,l,bytes)); const remoteText = decoder.decode(await this.remoteBytes(r, remoteCache));
        const preferred=this.preferredSide(path,l,effectiveBaseSnapshot,remoteSnapshot);
        this.status({phase:"merging",message:`Three-way merge · ${path} · base ${b?.size??0} B · local ${l.size} B · remote ${r.size} B`});
        await this.cooperate(true);
        const merged = mergeText(baseText, localText, remoteText, preferred);
        await this.cooperate(true);
        if(merged.kind==="large-conflict"||merged.kind==="merge-fallback"){
          const reason=merged.kind==="merge-fallback"?merged.reason??"merge engine fallback":`${merged.overlapWords} overlapping words across ${merged.overlapLines} lines`;
          console.warn("Gib Sync preserved both versions after merge fallback",{path,reason,baseBytes:b?.size??0,localBytes:l.size,remoteBytes:r.size});
          this.status({phase:"merging",message:`Preserving both · ${path} · ${reason}`,level:"warning"});
          conflicts++;await this.preservePair(path,l,await this.localBytes(path,l,bytes),r,settings.deviceName,remoteSnapshot?.deviceName??"Remote device",preferred,final,bytes,remoteCache,occupied);continue;
        }
        this.status({phase:"merging",message:merged.kind==="small-overlap"?`Resolved small overlap · ${path} · preferred ${preferred} version`:`Merged non-overlapping edits · ${path}`,level:"success"});
        const mergedBytes = encoder.encode(merged.text); const hash = await hashBytes(mergedBytes); bytes.set(hash, mergedBytes);
        final.set(path, { path, hash, size: mergedBytes.length, mtime: Date.now(), bytes: mergedBytes });
        continue;
      }
      // A binary conflict never destroys either side; the newest stays at the intended path.
      conflicts++;
      if(l&&r)await this.preservePair(path,l,await this.localBytes(path,l,bytes),r,settings.deviceName,remoteSnapshot?.deviceName??"Remote device",this.preferredSide(path,l,effectiveBaseSnapshot,remoteSnapshot),final,bytes,remoteCache,occupied);
    }

    if(settings.syncPlugins){
      const enablementPath=".obsidian/community-plugins.json",entry=final.get(enablementPath);
      if(entry){
        try{
          const localEntry=local.get(enablementPath),clear=bytes.get(entry.hash)??(localEntry?.hash===entry.hash?await this.localBytes(enablementPath,localEntry,bytes):await this.remoteBytes(entry,remoteCache));
          const enabled=JSON.parse(decoder.decode(clear)) as unknown;
          if(Array.isArray(enabled)){
            const valid=enabled.filter((id):id is string=>typeof id==="string"&&(id==="gib-sync"||(final.has(`.obsidian/plugins/${id}/manifest.json`)&&final.has(`.obsidian/plugins/${id}/main.js`))));
            const missing=enabled.filter((id)=>typeof id==="string"&&!valid.includes(id));
            if(missing.length){const sanitized=encoder.encode(`${JSON.stringify(valid,null,2)}\n`),hash=await hashBytes(sanitized);bytes.set(hash,sanitized);final.set(enablementPath,{path:enablementPath,hash,size:sanitized.length,mtime:Date.now(),bytes:sanitized});resolved++;
              this.status({phase:"merging",message:`Plugin enablement repaired · skipped ${missing.length} incomplete package${missing.length===1?"":"s"}: ${missing.slice(0,5).join(", ")}${missing.length>5?"…":""}`,level:"warning"});}
          }
        }catch{this.status({phase:"merging",message:"Plugin enablement list is non-standard JSON · kept the newer complete file",level:"warning"});}
      }
    }

    // An ignored path is device-local: keep its accepted remote manifest entry
    // even though this device neither reads nor writes the file. This is
    // essential when phones intentionally omit desktop-only plugins.
    const preservedIgnored=(remoteSnapshot?.entries??[]).filter((entry)=>!this.include(entry.path)&&!isDeviceLocalObsidianPath(entry.path));
    const entries = [...final.values(),...preservedIgnored].map(({path,hash,size,mtime}) => ({path,hash,size,mtime})).sort((a,b)=>a.path.localeCompare(b.path));
    const remoteEntries = [...(remoteSnapshot?.entries??[])].map(({path,hash,size,mtime}) => ({path,hash,size,mtime})).sort((a,b)=>a.path.localeCompare(b.path));
    const clientCanMirrorAll=!preservedIgnored.length;
    const remoteHashes=new Set(remoteEntries.map((entry)=>entry.hash)),remotePathHashes=new Map(remoteEntries.map((entry)=>[entry.path,entry.hash])),entryPaths=new Set(entries.map((entry)=>entry.path));
    const unchanged = entries.length === remoteEntries.length && entries.every((entry, i) => entry.path === remoteEntries[i].path && entry.hash === remoteEntries[i].hash);
    if (unchanged) {
      let downloaded=0,deleted=0;if(remoteSnapshot){const applied=await this.stageAndApply(remoteSnapshot.id,final,entries.map((entry)=>entry.path),physicalLocal,desktopOnlyPlugins,scanned,orphanUnreadableConflicts,bytes,remoteCache);downloaded=applied.downloaded;deleted=applied.deleted;prunedFolders+=applied.prunedFolders;}else{const topology=await this.reconcileFolderTopology([]);prunedFolders+=topology.removed;settings.lastSnapshotId=null;settings.initialized=true;if(settings.syncPlugins)settings.pluginSyncBootstrapPending=false;await this.saveSettings();}let mirrored=0;
      try{mirrored=remoteSnapshot&&clientCanMirrorAll?await this.mirror(remoteSnapshot.id,entries,final,bytes,remoteCache):0;}
      catch(error){if(this.retryableMirrorError(error))return this.convergeAfterConflict(attempt,"Another device advanced the vault during mirror verification");throw error;}
      this.status({phase:"up-to-date",message:"Up to date · readable recovery copy verified"});
      if(fullScan&&!settings.retiredFolderCount){settings.fullScanRequired=false;settings.lastFullScanAt=new Date().toISOString();await this.saveSettings();}
      return { uploaded: 0, downloaded, deleted, prunedFolders,pendingRetiredFolders:settings.retiredFolderCount, conflicts, resolved, mirrored, snapshotId: settings.lastSnapshotId,processedPaths:pendingPaths,fullScan };
    }

    if(!settings.initialized&&remoteSnapshot){
      this.status({phase:"committing",message:onboardingReconcile?"Verifying the matched server baseline before publishing the union":"Verifying the first download before cleaning device-local workspace state"});
      try{await this.api.markDeviceReady(remoteSnapshot.id);}
      catch(error){if(error instanceof ApiError&&error.status===409)return this.convergeAfterConflict(attempt,"The server vault changed during onboarding verification");throw error;}
    }

    this.status({phase:"uploading",message:"Preparing encrypted uploads"}); let uploaded = 0;
    for (const entry of entries) {
      await this.cooperate();
      if(remoteHashes.has(entry.hash))continue;
      const localEntry=local.get(entry.path);const clear=bytes.get(entry.hash)??(localEntry?.hash===entry.hash?await this.localBytes(entry.path,localEntry,bytes):undefined);if(!clear)throw new Error(`Unable to prepare changed file ${entry.path}`);
      await this.api.putBlob(entry.hash, await encryptBlob(clear, settings.vaultKey, entry.hash)); uploaded++;
      if(this.progress(uploaded))this.status({phase:"uploading",message:`Uploaded ${uploaded} encrypted file${uploaded===1?"":"s"}`,current:uploaded});
    }
    this.status({phase:"committing",message:"Committing an atomic snapshot"});
    let snapshot:Snapshot;
    const highEntropyPaths:string[]=[];
    for(const entry of entries){
      if(!this.text(entry.path)||remotePathHashes.get(entry.path)===entry.hash)continue;
      const clear=bytes.get(entry.hash);if(clear&&await this.entropy(clear)>7.2)highEntropyPaths.push(entry.path);
    }
    const deviceLocalCleanupPaths=remoteEntries.filter((entry)=>isDeviceLocalObsidianPath(entry.path)&&!entryPaths.has(entry.path)).slice(0,5000).map((entry)=>entry.path);
    try{snapshot=await this.api.commit({ parentId: remoteSnapshot?.id ?? null, message: conflicts ? `Sync with ${conflicts} preserved conflict${conflicts === 1 ? "" : "s"}` : "Sync", entries,
      clientTime:new Date().toISOString(),signals:{highEntropyPaths,deviceLocalCleanupPaths,vaultIdentity:settings.vaultIdentity,staleBaseline:Boolean(baseSnapshot&&remoteSnapshot&&baseSnapshot.id!==remoteSnapshot.id)} });}
    catch(error){if(error instanceof ApiError&&error.status===409)return this.convergeAfterConflict(attempt,"Another device committed at the same time");throw error;}
    const applied=await this.stageAndApply(snapshot.id,final,entries.map((entry)=>entry.path),physicalLocal,desktopOnlyPlugins,scanned,orphanUnreadableConflicts,bytes,remoteCache),downloaded=applied.downloaded,deleted=applied.deleted;prunedFolders+=applied.prunedFolders;let mirrored:number;
    try{mirrored=clientCanMirrorAll?await this.mirror(snapshot.id,entries,final,bytes,remoteCache):0;}
    catch(error){if(this.retryableMirrorError(error))return this.convergeAfterConflict(attempt,"The commit succeeded and another device advanced the vault during mirroring");throw error;}
    this.status({phase:"complete",message:conflicts ? `Synced · ${conflicts} conflict${conflicts === 1 ? "" : "s"} preserved` : "Sync complete · readable recovery copy current"});
    if(fullScan&&!settings.retiredFolderCount){settings.fullScanRequired=false;settings.lastFullScanAt=new Date().toISOString();await this.saveSettings();}
    return { uploaded, downloaded, deleted, prunedFolders,pendingRetiredFolders:settings.retiredFolderCount, conflicts, resolved, mirrored, snapshotId: settings.lastSnapshotId,processedPaths:pendingPaths,fullScan };
  }
}
