import { normalizePath, type DataAdapter } from "obsidian";
import { detectMoves, type ManifestEntry, type Snapshot } from "@gib-sync/protocol";
import { ApiError, GibSyncApi } from "./api";
import { decryptBlob, encryptBlob, hashBytes } from "./crypto";
import { mergeText } from "./merge";
import { canonicalConfigPath, isDeviceLocalObsidianPath, isGibSyncConflictPath, isObsidianSystemPath, isPluginDataPath, obsidianPluginPath, shouldSyncChangedPath, type ApplyOperation, type GibSyncSettings, type SyncPhase } from "./settings";
import { mergeCommunityPluginEnablement, mergeSystemJson } from "./system-merge";
import { BodyCache } from "./body-cache";
import { AdapterFileChangedError, hashAdapterFile,streamAdapterFile } from "./file-io";
import {uploadAdapterFile} from "./outbound-stream";
import {sha256} from "@noble/hashes/sha2.js";
import {bytesToHex} from "@noble/hashes/utils.js";
import { SyncCancelledError } from "./sync-recovery";
export { SyncCancelledError } from "./sync-recovery";

type FileState = ManifestEntry & { sourcePath?:string };
type LocalScan = { files:Map<string,FileState>; folders:Set<string>; unreadableConflictPaths:Set<string> };
const TEXT_EXTENSIONS = new Set(["md","txt","canvas","json","jsonl","css","js","ts","yaml","yml","xml","csv","svg","html"]);
const decoder = new TextDecoder(); const encoder = new TextEncoder();
export const LOW_MEMORY_DOWNLOAD_BYTES=8*1024*1024;
const MOBILE_WORK_BATCH=2;
const DESKTOP_WORK_BATCH=8;
const RETIRED_PATH_MAX_AGE=90*24*60*60*1000;
const RETIRED_PATH_LIMIT=5000;
const PROTECTED_FOLDER_ROOTS=new Set([".obsidian",".obsidian/plugins",".obsidian/themes",".trash",".git",".gib-sync"]);
const DISPOSABLE_FOLDER_METADATA=new Set([".ds_store",".nomedia","desktop.ini","thumbs.db"]);

export function cooperativeYield():Promise<void>{
  const taskScheduler=(globalThis as typeof globalThis&{scheduler?:{yield?:()=>Promise<void>}}).scheduler;
  if(typeof taskScheduler?.yield==="function")return taskScheduler.yield();
  if(typeof MessageChannel!=="undefined")return new Promise((resolve)=>{const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};channel.port2.postMessage(undefined);});
  return Promise.resolve();
}

function exactArrayBuffer(bytes:Uint8Array):ArrayBuffer{
  if(bytes.buffer instanceof ArrayBuffer&&bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength)return bytes.buffer;
  return bytes.slice().buffer;
}

// Receipts compare content and canonical explicit folders, not timestamps or
// display names. Implicit parent folders are removed by the server on commit.
export async function commitFingerprint(entries:ManifestEntry[],folders:readonly string[]=[]):Promise<string>{
  const parents=new Set<string>();
  for(const entry of entries){const parts=entry.path.split("/");for(let i=1;i<parts.length;i++)parents.add(parts.slice(0,i).join("/"));}
  const files=entries.map(({path,hash,size})=>[path,hash,size]).sort((a,b)=>String(a[0])<String(b[0])?-1:String(a[0])>String(b[0])?1:0);
  const explicit=[...new Set(folders)].filter(path=>!parents.has(path)).sort();
  return hashBytes(encoder.encode(JSON.stringify({files,folders:explicit})));
}

export interface SyncResult { uploaded: number; downloaded: number; deleted: number; prunedFolders:number; pendingRetiredFolders:number; conflicts: number; resolved:number; mirrored:number; snapshotId: string | null; processedPaths:string[]; fullScan:boolean; }
export interface SyncProgress { phase:SyncPhase; message:string; current?:number; total?:number; level?:"info"|"success"|"warning"|"error"; remoteChanged?:boolean; }
export class SyncSafetyError extends Error { override readonly name="SyncSafetyError"; }
export class FileChangedDuringReadError extends Error {
  override readonly name="FileChangedDuringReadError";
  constructor(readonly path:string){super(`${path} changed or was deleted while Gib Sync was reading it. It was not uploaded; sync will quietly retry the current vault state.`);}
}

export class SyncEngine {
  private running: Promise<SyncResult> | null = null;
  private operationTail:Promise<unknown>=Promise.resolve();
  private generation=0;
  private activeGeneration=0;
  private readonly preparedPaths=new Set<string>();
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
    private readonly yieldControl:()=>Promise<void>=cooperativeYield,
    private readonly isMobileDevice=false,
    private readonly canApplyLocalMutation:(path:string)=>boolean=()=>true,
    private readonly shouldContinue:()=>boolean=()=>true
  ) {}

  cancel():void {this.generation++;}
  get isRunning():boolean{return this.running!==null;}
  private checkpoint():void {if(this.activeGeneration!==this.generation||!this.shouldContinue())throw new SyncCancelledError("Sync paused safely; accepted updates will resume from their saved checkpoint.");}

  private async cooperate(force=false):Promise<void>{
    this.checkpoint();
    const now=typeof performance!=="undefined"?performance.now():Date.now();
    this.workSinceYield++;
    if(!force&&this.workSinceYield<this.workBatch&&now-this.lastYieldAt<8)return;
    this.workSinceYield=0;this.lastYieldAt=now;await this.yieldControl();this.checkpoint();
  }
  private progress(current:number,total?:number):boolean{return current===1||current===total||current%10===0;}

  sync(): Promise<SyncResult> {
    if (this.running) return this.running;
    const requestedGeneration=this.generation;
    this.running = this.operationTail.catch(()=>undefined).then(()=>{this.activeGeneration=requestedGeneration;this.checkpoint();return this.run(0);}).finally(async() => {await this.cleanPreparedResults();this.running = null; });
    this.operationTail=this.running;return this.running;
  }

  restoreAcceptedSnapshot():Promise<{downloaded:number;deleted:number;prunedFolders:number}>{
    const requestedGeneration=this.generation;
    const restoring=this.operationTail.catch(()=>undefined).then(()=>{this.activeGeneration=requestedGeneration;this.checkpoint();return this.restore();});this.operationTail=restoring;return restoring;
  }

  private async restore():Promise<{downloaded:number;deleted:number;prunedFolders:number}>{
    const settings=this.getSettings();if(!settings.deviceToken||!settings.vaultKey)throw new Error("Gib Sync is not configured");
    const scanned=await this.scan(),local=scanned.files,head=(await this.api.state()).head;this.checkpoint();
    if(!head&&local.size)throw new SyncSafetyError("The server has no accepted snapshot to restore. Local files were left unchanged.");
    const remote=this.map(head);for(const path of scanned.unreadableConflictPaths){const accepted=remote.get(path);if(accepted)local.set(path,accepted);}
    if(!head)return {downloaded:0,deleted:0,prunedFolders:0};
    // Explicit repair replaces unknown interrupted copy output only after every
    // private original is archived. The unknown visible file is then backed up
    // as the fresh operation's original, never treated as an upload proposal.
    await this.archiveInterruptedApplyForRestore();
    const result=await this.stageAndApply(head.id,remote,this.snapshotFolders(head),local,new Set(),scanned,[],this.bodyCache(),this.bodyCache(),head.folderRepair,head.createdAt);
    return {downloaded:result.downloaded,deleted:result.deleted,prunedFolders:result.prunedFolders};
  }

  private async archiveInterruptedApplyForRestore():Promise<void>{
    const settings=this.getSettings();if(!settings.pendingApplySnapshotId)return;
    const target=await this.optionalSnapshot(settings.pendingApplySnapshotId);if(!target)throw new SyncSafetyError("The interrupted copy's accepted snapshot is unavailable; its original, current and staged versions were retained.");
    const entries=new Map(target.entries.map(entry=>[entry.path,entry])),cache=this.bodyCache(),desktopOnly=new Set<string>();
    if(this.isMobileDevice)for(const entry of target.entries){const plugin=this.pluginPath(entry.path);if(plugin?.relative.toLowerCase()!=="manifest.json")continue;try{if(JSON.parse(decoder.decode(await this.remoteBytes(entry,cache))).isDesktopOnly===true)desktopOnly.add(plugin.id);}catch{}}
    for(const path of settings.pendingApplyPaths){await this.cooperate();const entry=entries.get(path),priorHash=settings.pendingApplyPriorHashes[path]??null,targetHash=entry?(this.isMobileDevice&&path===this.enablementPath?(await this.deviceBytes(path,entry,cache,desktopOnly)).hash:entry.hash):null;await this.loadOperation(path,targetHash,priorHash);}
    await this.finishOperations(true);
  }

  private bodyCache():BodyCache{return new BodyCache(this.isMobileDevice?8*1024*1024:32*1024*1024);}
  private configPath(path:string):string{return canonicalConfigPath(path,this.getSettings().configDir);}
  private pluginPath(path:string){return obsidianPluginPath(path,this.getSettings().configDir);}
  private systemPath(path:string):boolean{return isObsidianSystemPath(path,this.getSettings().configDir);}
  private pluginDataPath(path:string):boolean{return isPluginDataPath(path,this.getSettings().configDir);}
  private pluginFile(id:string,name:string):string{return normalizePath(`${this.getSettings().configDir}/plugins/${id}/${name}`);}
  private get enablementPath():string{return normalizePath(`${this.getSettings().configDir}/community-plugins.json`);}

  private async entropy(bytes:Uint8Array):Promise<number>{
    if(bytes.length<1024)return 0;const counts=new Uint32Array(256);
    for(let start=0;start<bytes.length;start+=64*1024){for(const value of bytes.subarray(start,start+64*1024))counts[value]++;await this.cooperate();}
    let result=0;
    for(const count of counts)if(count){const probability=count/bytes.length;result-=probability*Math.log2(probability);}return result;
  }

  private include(path: string): boolean {
    return shouldSyncChangedPath(normalizePath(path),this.getSettings());
  }

  private async disappeared(path:string):Promise<boolean>{
    try{if(!await this.adapter.exists(path))return true;}catch{}
    try{return !await this.adapter.stat(path);}catch{return false;}
  }

  private pluginSyncPath(path:string):boolean{
    const normalized=normalizePath(path);if(normalized===this.enablementPath)return true;
    const plugin=this.pluginPath(normalized);return Boolean(plugin&&plugin.id.toLowerCase()!=="gib-sync");
  }

  private async listFiles(path = "",folders=new Set<string>()): Promise<string[]> {
    let listing;
    try{listing=await this.adapter.list(path);}
    catch(error){if(path&&await this.disappeared(path)){folders.delete(normalizePath(path));return [];}throw error;}
    const files = listing.files.filter((file) => this.include(file));
    for (const folder of listing.folders.filter((item) => this.include(item))) {
      await this.cooperate();const normalized=normalizePath(folder);if(this.managedTopLevelFolder(normalized))folders.add(normalized);for(const file of await this.listFiles(normalized,folders))files.push(file);
    }
    return files;
  }

  private async scan(): Promise<LocalScan> {
    const output = new Map<string, FileState>(),folders=new Set<string>(),unreadableConflictPaths=new Set<string>();
    const paths = await this.listFiles("",folders); let current = 0;
    for (const path of paths) {
      await this.cooperate();
      let hash:string,stat;try{hash=await this.hashLocalFile(path);stat=await this.adapter.stat(path);}catch(error){
        if(await this.disappeared(path)){current++;continue;}
        if(!isGibSyncConflictPath(path))throw error;unreadableConflictPaths.add(path);this.status({phase:"scanning",message:`Isolated unreadable generated conflict copy · ${path} · accepted server version preserved`,level:"warning"});current++;continue;
      }
      if(!stat||stat.type!=="file"){current++;continue;}
      // Retain metadata rather than every file body. Mobile WebViews have much
      // tighter memory limits, so changed content is read lazily when required.
      output.set(path, { path, hash, size: stat.size, mtime: stat.mtime ?? Date.now() });
      current++; if (current===1 || current===paths.length || current%25===0) this.status({phase:"scanning",message:"Scanning local vault",current,total:paths.length});
    }
    for(const folder of this.acceptedFolders(paths))folders.delete(folder);
    return {files:output,folders,unreadableConflictPaths};
  }

  private async scanIncremental(baseSnapshot:Snapshot,changedPaths:string[]):Promise<LocalScan>{
    const output=this.map(baseSnapshot),folders=this.manifestFolders(baseSnapshot),unreadableConflictPaths=new Set<string>();let current=0;
    for(const rawPath of changedPaths){
      await this.cooperate();
      const path=normalizePath(rawPath);current++;
      if(!this.include(path)){output.delete(path);continue;}
      let stat;try{stat=await this.adapter.stat(path);}catch(error){if(await this.disappeared(path)){output.delete(path);continue;}throw error;}
      if(!stat){output.delete(path);continue;}
      if(stat.type!=="file")throw new SyncSafetyError("A changed folder requires a full vault reconciliation before syncing.");
      try{
        const hash=await this.hashLocalFile(path);output.set(path,{path,hash,size:stat.size,mtime:stat.mtime??Date.now()});
      }catch(error){
        if(await this.disappeared(path)){output.delete(path);continue;}
        if(!isGibSyncConflictPath(path))throw error;output.delete(path);unreadableConflictPaths.add(path);
        this.status({phase:"scanning",message:`Isolated unreadable generated conflict copy · ${path} · accepted server version preserved`,level:"warning"});
      }
      if(this.progress(current,changedPaths.length))this.status({phase:"scanning",message:"Checking changed files",current,total:changedPaths.length});
    }
    return {files:output,folders,unreadableConflictPaths};
  }

  private map(snapshot: Snapshot | null): Map<string, FileState> {
    return new Map((snapshot?.entries ?? []).filter((entry) => this.include(entry.path)).map((entry) => [entry.path, { ...entry }]));
  }
  private async localBytes(path:string,entry:FileState,cache:Map<string,Uint8Array>):Promise<Uint8Array>{
    const cached=cache.get(entry.hash);if(cached)return cached;
    const sourcePath=entry.sourcePath??path;let clear:Uint8Array;
    try{clear=new Uint8Array(await this.adapter.readBinary(sourcePath));}
    catch(error){if(await this.disappeared(sourcePath))throw new FileChangedDuringReadError(sourcePath);throw error;}
    if(await hashBytes(clear)!==entry.hash)throw new FileChangedDuringReadError(sourcePath);
    cache.set(entry.hash,clear);return clear;
  }

  private async remoteBytes(entry: FileState, cache: Map<string, Uint8Array>): Promise<Uint8Array> {
    const existing = cache.get(entry.hash); if (existing) return existing;
    if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES){const bytes=await this.api.getContent(entry.hash,entry.size);this.checkpoint();if(bytes.byteLength!==entry.size||await hashBytes(bytes)!==entry.hash)throw new Error(`Large-file integrity check failed for ${entry.path}`);return bytes;}
    const bytes=await decryptBlob(await this.api.getBlob(entry.hash),this.getSettings().vaultKey,entry.hash);cache.set(entry.hash,bytes);return bytes;
  }
  private async uploadLocalFile(entry:FileState,cache:Map<string,Uint8Array>):Promise<void>{
    const sourcePath=entry.sourcePath??entry.path;
    if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES&&typeof this.api.supportsStreamUpload==="function"&&this.api.supportsStreamUpload()){
      const checkpoint=()=>{this.checkpoint();const observedPath=sourcePath.startsWith(".gib-sync/")?entry.path:sourcePath;if(!this.canApplyLocalMutation(observedPath)){this.getSettings().fullScanRequired=true;throw new FileChangedDuringReadError(observedPath);}};
      try{if(await uploadAdapterFile(this.adapter,sourcePath,entry.hash,entry.size,this.api,checkpoint,()=>this.cooperate(),stage=>this.status({phase:"uploading",message:stage==="waiting"?`Waiting for safe server processing · ${entry.path}`:stage==="checking"?`Verifying the stored large file · ${entry.path}`:stage==="verifying"?`Verifying complete large upload · ${entry.path}`:`Saving the verified large upload · ${entry.path}`})))return;}
      catch(error){if(error instanceof AdapterFileChangedError)throw new FileChangedDuringReadError(sourcePath);throw error;}
    }
    const clear=await this.localBytes(entry.path,entry,cache),encrypted=await encryptBlob(clear,this.getSettings().vaultKey,entry.hash);this.checkpoint();await this.api.putBlob(entry.hash,encrypted);this.checkpoint();
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = normalizePath(path).split("/").slice(0, -1); let current = "";
    for (const part of parts) { current = current ? `${current}/${part}` : part; if (!await this.adapter.exists(current)){this.checkpoint();this.expectLocalMutation(current,"folder");await this.adapter.mkdir(current);} }
  }

  private disposableMetadata(path:string):boolean{const name=normalizePath(path).split("/").at(-1)?.toLowerCase()??"";return DISPOSABLE_FOLDER_METADATA.has(name)||name.startsWith("._");}

  private async localRecoveryPath(batch:string,path:string):Promise<string>{
    // Private recovery names are unguessable and never reused across runs;
    // adapter.rename has no public no-clobber option on every platform.
    const base=normalizePath(`.gib-sync/local-recovery/${batch}-${crypto.randomUUID()}/${path}`);let candidate=base,index=2;
    while(await this.adapter.exists(candidate)){const dot=base.lastIndexOf("."),slash=base.lastIndexOf("/"),stem=dot>slash?base.slice(0,dot):base,extension=dot>slash?base.slice(dot):"";candidate=`${stem} - ${index++}${extension}`;}
    return candidate;
  }

  private async currentFolderFile(path:string):Promise<boolean>{
    if(!this.include(path))return false;const retired=this.getSettings().retiredPaths[path];if(!retired)return true;
    try{return await this.hashLocalFile(path)!==retired.hash;}catch(error){if(error instanceof SyncCancelledError)throw error;return true;}
  }

  private hasLocalFolderIntent(path:string,after=0):boolean{
    const normalized=normalizePath(path);
    return Object.entries(this.getSettings().folderCreateTimes).some(([createdAtPath,createdAt])=>{
      if(createdAt<=after)return false;const created=normalizePath(createdAtPath);
      return created===normalized||created.startsWith(`${normalized}/`)||normalized.startsWith(`${created}/`);
    });
  }

  private trimFolderCreateTimes(existing:Set<string>,desired:Set<string>):void{
    const times=this.getSettings().folderCreateTimes;
    for(const recorded of Object.keys(times)){
      const path=normalizePath(recorded);
      if(!existing.has(path)||desired.has(path))delete times[recorded];
    }
  }

  private async retireFolderFile(path:string,batch:string):Promise<"kept"|"metadata"|"recovered">{
    if(await this.currentFolderFile(path))return "kept";
    await this.cooperate();this.expectLocalMutation(path,null);
    if(this.disposableMetadata(path)){this.checkpoint();await this.adapter.remove(path);return "metadata";}
    const trashLocal=(this.adapter as DataAdapter&{trashLocal?:DataAdapter["trashLocal"]}).trashLocal;
    if(typeof trashLocal==="function")try{await trashLocal.call(this.adapter,path);return "recovered";}catch{if(!await this.adapter.exists(path))return "recovered";}
    const recovery=await this.localRecoveryPath(batch,path);await this.ensureParent(recovery);this.checkpoint();await this.adapter.rename(path,recovery);
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
    this.checkpoint();this.expectLocalMutation(path,null);await this.adapter.rmdir(path,false);return {folders:folders+1,metadata,recovered};
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
      try{const stat=await this.adapter.stat(path);if(stat?.type==="folder"&&!this.hasLocalFolderIntent(path,retiredAt))eligible.add(path);}catch(error){failures++;failureDetails.push(`${path}: ${error instanceof Error?error.message:String(error)}`);}
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
    return Boolean(top)&&!PROTECTED_FOLDER_ROOTS.has(lower)&&lower!==this.getSettings().configDir.split("/")[0].toLowerCase()&&this.include(top);
  }

  private async localManagedFolders():Promise<Set<string>>{
    const folders=new Set<string>();
    const visit=async(path:string):Promise<void>=>{let listing;try{listing=await this.adapter.list(path);}catch(error){if(await this.disappeared(path)){folders.delete(normalizePath(path));return;}throw error;}for(const folder of listing.folders){const normalized=normalizePath(folder);folders.add(normalized);await this.cooperate();await visit(normalized);}};
    const root=await this.adapter.list("");
    for(const folder of root.folders){const normalized=normalizePath(folder);if(!this.managedTopLevelFolder(normalized))continue;folders.add(normalized);await this.cooperate();await visit(normalized);}
    return folders;
  }

  private acceptedFolders(paths:Iterable<string>):Set<string>{
    const folders=new Set<string>();
    for(const path of paths){const parts=normalizePath(path).split("/").slice(0,-1);if(!parts.length||!this.managedTopLevelFolder(parts[0]))continue;let current="";for(const part of parts){current=current?`${current}/${part}`:part;folders.add(current);}}
    return folders;
  }

  private async hasProtectedFolderIntent(path:string,repair?:Snapshot["folderRepair"],fallbackIssuedAt?:string):Promise<boolean>{
    if(!repair)return this.hasLocalFolderIntent(path);
    const normalized=normalizePath(path),retired=repair.retiredFolders.some((raw)=>{const candidate=normalizePath(raw);return candidate===normalized||candidate.startsWith(`${normalized}/`)||normalized.startsWith(`${candidate}/`);});
    const observedAt=retired?Date.parse(repair.issuedAt??fallbackIssuedAt??repair.observedAt):0;if(!Number.isFinite(observedAt)||!this.hasLocalFolderIntent(path,observedAt))return !retired&&this.hasLocalFolderIntent(path);
    // Obsidian can emit a burst of create events while re-indexing folders
    // that already existed. Require filesystem evidence newer than the unsafe
    // observation before allowing such an event to override an exact server
    // retirement directive.
    for(const [createdPath,createdAt] of Object.entries(this.getSettings().folderCreateTimes)){
      const created=normalizePath(createdPath);if(createdAt<=observedAt||!(created===normalized||created.startsWith(`${normalized}/`)||normalized.startsWith(`${created}/`)))continue;
      try{const stat=await this.adapter.stat(created);if(stat?.type==="folder"&&Math.max(stat.ctime,stat.mtime)>observedAt)return true;}catch{}
    }
    return false;
  }

  private snapshotFolders(snapshot:Snapshot|null):Set<string>{
    const folders=this.acceptedFolders((snapshot?.entries??[]).map((entry)=>entry.path));
    for(const raw of this.manifestFolders(snapshot)){
      const parts=normalizePath(raw).split("/").filter(Boolean);if(!parts.length||!this.managedTopLevelFolder(parts[0]))continue;
      let current="";for(const part of parts){current=current?`${current}/${part}`:part;folders.add(current);}
    }
    return folders;
  }

  private manifestFolders(snapshot:Snapshot|null):Set<string>{return new Set((snapshot?.folders??[]).map((folder)=>normalizePath(folder)).filter((folder)=>this.managedTopLevelFolder(folder)));}

  private mergeFolders(base:Set<string>,local:Set<string>,remote:Set<string>):Set<string>{
    const merged=new Set<string>(),paths=new Set([...base,...local,...remote]);
    for(const path of paths){
      const b=base.has(path),l=local.has(path),r=remote.has(path),keep=l===r?l:l===b?r:l;
      if(keep)merged.add(path);
    }
    return merged;
  }

  private minimalFolderRoots(paths:Iterable<string>):string[]{
    return [...new Set(paths)].sort((left,right)=>left.split("/").length-right.split("/").length||left.localeCompare(right)).filter((path,index,all)=>!all.slice(0,index).some((parent)=>path.startsWith(`${parent}/`)));
  }

  private async folderHasSyncableFile(path:string):Promise<boolean>{
    let listing;try{listing=await this.adapter.list(path);}catch(error){if(await this.disappeared(path))return false;throw error;}for(const file of listing.files)if(this.include(normalizePath(file)))return true;
    for(const folder of listing.folders){await this.cooperate();if(await this.folderHasSyncableFile(normalizePath(folder)))return true;}
    return false;
  }

  private async reconcileFolderTopology(acceptedFolders:Iterable<string>,repair?:Snapshot["folderRepair"],repairSnapshotCreatedAt?:string):Promise<{removed:number;remaining:number}>{
    const settings=this.getSettings(),desired=new Set([...acceptedFolders].map((path)=>normalizePath(path)).filter((path)=>this.managedTopLevelFolder(path))),before=await this.localManagedFolders();
    let created=0,removed=0,recovered=0,metadata=0,failures=0;const failureDetails:string[]=[],batch=new Date().toISOString().replace(/[:.]/g,"-");
    for(const path of [...desired].sort((left,right)=>left.split("/").length-right.split("/").length||left.localeCompare(right))){
      if(before.has(path))continue;await this.cooperate();
      try{if(!await this.adapter.exists(path)){this.checkpoint();this.expectLocalMutation(path,"folder");await this.adapter.mkdir(path);}created++;before.add(path);}
      catch(error){if(!await this.adapter.exists(path)){failures++;failureDetails.push(`${path}: ${error instanceof Error?error.message:String(error)}`);}}
    }
    const unprotectedBefore:string[]=[];for(const path of before)if(!desired.has(path)&&!await this.hasProtectedFolderIntent(path,repair,repairSnapshotCreatedAt))unprotectedBefore.push(path);
    const extraRoots=this.minimalFolderRoots(unprotectedBefore);
    for(const root of extraRoots){
      await this.cooperate();
      try{
        // A syncable file created during this run is a new vault change, not
        // stale topology. Preserve it and force normal file reconciliation.
        if(await this.folderHasSyncableFile(root))continue;
        const cleaned=await this.pruneRetiredTree(root,batch);removed+=cleaned.folders;recovered+=cleaned.recovered;metadata+=cleaned.metadata;
      }catch(error){failures++;failureDetails.push(`${root}: ${error instanceof Error?error.message:String(error)}`);}
    }
    const after=extraRoots.length?await this.localManagedFolders():before,unprotectedAfter:string[]=[];for(const path of after)if(!desired.has(path)&&!await this.hasProtectedFolderIntent(path,repair,repairSnapshotCreatedAt))unprotectedAfter.push(path);
    const extra=this.minimalFolderRoots(unprotectedAfter),missing=this.minimalFolderRoots([...desired].filter((path)=>!after.has(path))),remaining=extra.length+missing.length;this.trimFolderCreateTimes(after,desired);
    settings.retiredFolderCount=remaining;
    settings.retiredFolderNote=remaining?`Folder topology differs from the accepted snapshot: ${[...extra.map((path)=>`extra ${path}`),...missing.map((path)=>`missing ${path}`)].slice(0,8).join(" · ")}${remaining>8?` · and ${remaining-8} more`:""}`.slice(0,2000):"";
    if(!failures)settings.lastFolderCleanupAt=Date.now();settings.lastFolderCleanupError=failures?failureDetails.slice(0,8).join(" · ").slice(0,2000):"";
    if(remaining)settings.fullScanRequired=true;
    else settings.observedFolderSnapshotId=settings.pendingApplySnapshotId??settings.lastSnapshotId;
    if(created)this.status({phase:"applying",message:`Folder topology reconciled · created ${created} accepted folder${created===1?"":"s"}`,level:"success"});
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
    await this.prepareResult(path,preserved,final,bytes);
  }
  private async prepareStreamedVersion(path:string,entry:FileState,side:"local"|"remote",prefix:string,final:Map<string,FileState>):Promise<void>{
    if(!prefix){final.set(path,{...entry,path,...(side==="local"?{sourcePath:entry.sourcePath??entry.path}:{})});return;}
    if(typeof this.adapter.appendBinary!=="function")throw new SyncSafetyError("This adapter cannot safely prepare a large conflict version. Both originals remain unchanged; update Obsidian before retrying.");
    const temporary=`.gib-sync/prepared/${crypto.randomUUID()}.tmp`,prefixBytes=encoder.encode(prefix),digest=sha256.create();digest.update(prefixBytes);
    const append=async(chunk:Uint8Array)=>{for(let offset=0;offset<chunk.length;offset+=64*1024){this.checkpoint();const part=chunk.subarray(offset,offset+64*1024);digest.update(part);await this.adapter.appendBinary(temporary,exactArrayBuffer(part));this.checkpoint();await this.cooperate();}};
    try{
      await this.ensureParent(temporary);this.checkpoint();await this.adapter.writeBinary(temporary,exactArrayBuffer(prefixBytes));
      if(side==="local")await streamAdapterFile(this.adapter,entry.sourcePath??entry.path,entry.hash,entry.size,append,()=>this.checkpoint(),()=>this.cooperate());
      else if(typeof this.api.streamContent==="function")await this.api.streamContent(entry.hash,entry.size,append,()=>this.checkpoint());
      else if(entry.size<LOW_MEMORY_DOWNLOAD_BYTES)await append(await this.remoteBytes(entry,this.bodyCache()));
      else throw new SyncSafetyError("This server cannot safely stream a large conflict version. Both originals were preserved; update the server before retrying.");
      const hash=bytesToHex(digest.digest()),sourcePath=`.gib-sync/prepared/${hash}.bin`;
      if(await this.savedHash(temporary)!==hash)throw new SyncSafetyError(`Prepared conflict integrity failed for ${path}; both originals were preserved.`);
      if(await this.adapter.exists(sourcePath)){if(await this.savedHash(sourcePath)!==hash)throw new SyncSafetyError("A prepared recovery file failed verification; it was not overwritten.");await this.adapter.remove(temporary);}else await this.adapter.rename(temporary,sourcePath);
      this.preparedPaths.add(sourcePath);final.set(path,{...entry,path,hash,size:entry.size+prefixBytes.length,mtime:Date.now(),sourcePath});
    }catch(error){try{await this.adapter.remove(temporary);}catch{}if(error instanceof AdapterFileChangedError)throw new FileChangedDuringReadError(error.path);throw error;}
    finally{digest.destroy();}
  }
  private async preserveLargePair(path:string,local:FileState,remote:FileState,localName:string,remoteName:string,preferred:"local"|"remote",final:Map<string,FileState>,occupied:Set<string>):Promise<void>{
    const localWins=preferred==="local",loser=localWins?remote:local,copyPath=this.conflictPath(path,localWins?remoteName:localName,loser.mtime,occupied);occupied.add(copyPath);const warning=path.toLowerCase().endsWith(".md"),names=[localName,remoteName];
    await this.prepareStreamedVersion(path,localWins?local:remote,localWins?"local":"remote",warning?this.warning("",names,copyPath):"",final);
    await this.prepareStreamedVersion(copyPath,loser,localWins?"remote":"local",warning?this.warning("",names,path):"",final);
    const copy=final.get(copyPath)!;delete copy.fileId;delete copy.revision;
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
    await this.prepareResult(path,originalClear,final,bytes);await this.prepareResult(copyPath,copyClear,final,bytes);
  }
  private async prepareResult(path:string,clear:Uint8Array,final:Map<string,FileState>,cache:Map<string,Uint8Array>):Promise<void>{
    const hash=await hashBytes(clear),sourcePath=`.gib-sync/prepared/${hash}.bin`;await this.ensureParent(sourcePath);this.checkpoint();await this.adapter.writeBinary(sourcePath,exactArrayBuffer(clear));
    this.preparedPaths.add(sourcePath);cache.set(hash,clear);const prior=final.get(path);final.set(path,{...prior,path,hash,size:clear.length,mtime:Date.now(),sourcePath});
  }
  private async cleanPreparedResults():Promise<void>{
    for(const path of this.preparedPaths)try{if(await this.savedHash(path)===path.slice(path.lastIndexOf("/")+1,-4))await this.adapter.remove(path);}catch{/* Preserve unverified scratch bytes rather than interfering with checkpoint recovery. */}
    this.preparedPaths.clear();
  }
  private manifestEntry(entry:FileState):ManifestEntry {const {path,hash,size,mtime,fileId,revision}=entry;return {path,hash,size,mtime,...(fileId?{fileId}:{}),...(revision?{revision}:{})};}
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
  private preferredSide(path:string,local:FileState|undefined,baseSnapshot:Snapshot|null,remoteSnapshot:Snapshot|null,remote?:FileState):"local"|"remote"{
    const remoteTime=remote?.revision?.modifiedAt??remoteSnapshot?.entries.find(entry=>entry.path===path)?.revision?.modifiedAt??(remoteSnapshot?Date.parse(remoteSnapshot.createdAt):0);
    const localTime=this.localChangeTime(path,local,baseSnapshot),verifiedRemoteTime=Number.isFinite(remoteTime)?remoteTime:0;
    // A real editor event observed while applying this remote snapshot wins a
    // millisecond-resolution tie; filesystem timestamp guesses do not.
    const observed=Object.entries(this.getSettings().pendingPathTimes).some(([candidate,time])=>time>0&&(candidate===normalizePath(path)||candidate.endsWith("/")&&normalizePath(path).startsWith(candidate)));
    return localTime>verifiedRemoteTime||localTime===verifiedRemoteTime&&observed?"local":"remote";
  }
  private canonicalizeMoves(base:Map<string,FileState>,local:Map<string,FileState>,remote:Map<string,FileState>,baseSnapshot:Snapshot|null,remoteSnapshot:Snapshot|null):number{
    const localMoves=new Map(detectMoves([...base.values()],[...local.values()],"identity").map((item)=>[item.previousPath,item.path]));
    // Filesystem rename events are evidence of intent, including a simultaneous
    // edit. Similar names or sizes are not evidence that two notes are one file.
    const intents=[...this.getSettings().pendingMoves].sort((left,right)=>left.at-right.at);
    for(const [source,entry] of base){
      let destination=source;
      for(const move of intents){const from=normalizePath(move.from),to=normalizePath(move.to);if(destination===from||destination.startsWith(`${from}/`))destination=destination===from?to:`${to}${destination.slice(from.length)}`;}
      const candidate=local.get(destination);
      if(destination===source||!candidate||local.has(source)||base.has(destination))continue;
      if(entry.fileId)local.set(destination,{...candidate,fileId:entry.fileId,revision:entry.revision});
      localMoves.set(source,destination);
    }
    const remoteMoves=new Map(detectMoves([...base.values()],[...remote.values()],"identity").map((item)=>[item.previousPath,item.path]));
    const sources=[...new Set([...localMoves.keys(),...remoteMoves.keys()])].sort(),claimed=new Set<string>();let recognized=0;
    for(const source of sources){
      const b=base.get(source),localDestination=localMoves.get(source),remoteDestination=remoteMoves.get(source);if(!b)continue;
      const localPath=localDestination??source,remotePath=remoteDestination??source,l=local.get(localPath),r=remote.get(remotePath);if(!l&&!r)continue;
      if(localDestination&&!remoteDestination&&remote.has(localDestination))continue;
      if(remoteDestination&&!localDestination&&local.has(remoteDestination))continue;
      if(localDestination&&remoteDestination&&localDestination!==remoteDestination&&(remote.has(localDestination)||local.has(remoteDestination)))continue;
      let destination=localDestination??remoteDestination!;
      if(localDestination&&remoteDestination&&localDestination!==remoteDestination)destination=this.preferredSide(localDestination,l,baseSnapshot,remoteSnapshot,r)==="local"?localDestination:remoteDestination;
      if(!destination||claimed.has(destination)||base.has(destination))continue;claimed.add(destination);
      base.delete(source);local.delete(source);remote.delete(source);if(localDestination)local.delete(localDestination);if(remoteDestination)remote.delete(remoteDestination);
      base.set(destination,{...b,path:destination});
      if(l)local.set(destination,{...b,...l,path:destination,sourcePath:l.sourcePath??localPath});
      if(r)remote.set(destination,{...r,path:destination});
      recognized++;
    }
    return recognized;
  }
  private acknowledgeMoves(consumed:GibSyncSettings["pendingMoves"],entries:ManifestEntry[]):void{
    const settings=this.getSettings();settings.pendingMoves=settings.pendingMoves.flatMap(move=>{
      if(consumed.some(item=>item.from===move.from&&item.to===move.to&&item.at===move.at))return [];
      // A rename may be coalesced in-place while its earlier destination is
      // accepted. Carry the remaining leg from that proven intermediate path,
      // rather than losing identity after another edit at the final path.
      const accepted=[...consumed].reverse().find(item=>item.from===move.from&&item.at<move.at&&entries.some(entry=>entry.path===item.to||entry.path.startsWith(`${item.to}/`)));
      return [{...move,...(accepted?{from:accepted.to}:{})}];
    });
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
      try{cursor=await this.api.snapshot(cursor.parentId);}catch(error){if(error instanceof ApiError&&error.status===404)return 0;throw error;}
    }
    return 0;
  }
  private retryableMirrorError(error:unknown):boolean{return error instanceof ApiError&&(error.status===409||error.status===422);}

  private async optionalSnapshot(id:string):Promise<Snapshot|null>{
    try{return await this.api.snapshot(id);}catch(error){if(error instanceof ApiError&&error.status===404)return null;throw error;}
  }

  private async recoverPendingCommit():Promise<void>{
    const settings=this.getSettings(),intent=settings.pendingCommit;if(!intent)return;
    this.status({phase:"checking",message:"Verifying an interrupted upload before comparing newer edits"});
    let cursor=(await this.api.state()).head,accepted:Snapshot|null=null,verifiedAbsent=false;
    for(let count=0;count<128;count++){
      await this.cooperate();
      if((cursor?.id??null)===intent.parentId){verifiedAbsent=true;break;}
      if(!cursor){verifiedAbsent=true;break;}
      if(cursor.parentId===intent.parentId){
        if(cursor.deviceId===settings.deviceId&&await commitFingerprint(cursor.entries,cursor.folders)===intent.fingerprint)accepted=cursor;
        else verifiedAbsent=true;
        break;
      }
      if(!cursor.parentId){verifiedAbsent=true;break;}
      cursor=await this.optionalSnapshot(cursor.parentId);
      if(!cursor)throw new SyncSafetyError("The interrupted upload's history could not be verified. Local edits are safe; no files were changed.");
    }
    if(!accepted){
      if(!verifiedAbsent)throw new SyncSafetyError("The interrupted upload's receipt needs older server history before sync can safely continue. Local edits are safe.");
      settings.pendingCommit=null;await this.saveSettings();return;
    }
    if(settings.pendingApplySnapshotId&&settings.pendingApplySnapshotId!==accepted.id)throw new SyncSafetyError("The saved upload and download journals disagree. Local files were left unchanged.");
    settings.pendingApplySnapshotId=accepted.id;
    settings.pendingApplyBaseSnapshotId=settings.lastSnapshotId;
    settings.pendingApplyPriorHashes={...intent.priorHashes,...settings.pendingApplyPriorHashes};
    settings.pendingApplyPriorEntries={...intent.priorEntries,...settings.pendingApplyPriorEntries};
    settings.pendingApplyPaths=[...new Set([...Object.keys(intent.priorHashes),...settings.pendingApplyPaths])].filter(path=>this.include(path)).sort();
    settings.fullScanRequired=true;
    await this.saveSettings();
    this.status({phase:"checking",message:"Verified this device's accepted upload; resuming its checkpoint without creating a self-conflict",level:"success"});
  }

  private async assertLocalUnchanged(path:string,prior:FileState|undefined):Promise<void>{
    this.checkpoint();
    if(!this.canApplyLocalMutation(path)){this.getSettings().fullScanRequired=true;throw new FileChangedDuringReadError(path);}
    const stat=await this.adapter.stat(path);
    let same=!stat&&!prior;
    if(stat?.type==="file"&&prior){
      try{same=await this.savedHash(path)===prior.hash;}catch(error){if(!await this.disappeared(path))throw error;}
    }
    this.checkpoint();if(!same||!this.canApplyLocalMutation(path)){this.getSettings().fullScanRequired=true;throw new FileChangedDuringReadError(path);}
  }

  private async operationFor(path:string,targetHash:string|null,priorHash:string|null):Promise<ApplyOperation>{
    const settings=this.getSettings(),existing=await this.loadOperation(path,targetHash,priorHash);
    if(existing&&existing.targetHash===targetHash&&existing.priorHash===priorHash)return existing;
    const identity=await hashBytes(encoder.encode(`${settings.pendingApplySnapshotId??"restore"}\n${path}\n${targetHash??"delete"}\n${priorHash??"absent"}`));
    const operation:ApplyOperation={targetHash,priorHash,stagePath:`.gib-sync/apply/${identity}.stage`,backupPath:`.gib-sync/apply/${identity}.backup`,phase:"planned"};
    settings.pendingApplyOperations[path]=operation;await this.persistOperation(path,operation);this.checkpoint();return operation;
  }

  private operationRecord(operation:ApplyOperation):string{return `${operation.stagePath.slice(0,-6)}.journal`;}
  private async persistOperation(path:string,operation:ApplyOperation,allowCancelled=false):Promise<void>{
    const recordPath=this.operationRecord(operation);if(!allowCancelled){await this.ensureParent(recordPath);this.checkpoint();}
    await this.adapter.writeBinary(recordPath,exactArrayBuffer(encoder.encode(JSON.stringify({path,snapshotId:this.getSettings().pendingApplySnapshotId,...operation}))));
    if(!allowCancelled)this.checkpoint();
  }
  private async loadOperation(path:string,targetHash:string|null,priorHash:string|null):Promise<ApplyOperation|undefined>{
    const settings=this.getSettings(),legacy=settings.pendingApplyOperations[path];
    const identity=await hashBytes(encoder.encode(`${settings.pendingApplySnapshotId??"restore"}\n${path}\n${targetHash??"delete"}\n${priorHash??"absent"}`));
    const expected={stagePath:`.gib-sync/apply/${identity}.stage`,backupPath:`.gib-sync/apply/${identity}.backup`};
    const recordPath=this.operationRecord(legacy?.targetHash===targetHash&&legacy.priorHash===priorHash?legacy:{...expected,targetHash,priorHash,phase:"planned"});
    const stat=await this.adapter.stat(recordPath);
    if(!stat)return legacy?.targetHash===targetHash&&legacy.priorHash===priorHash?legacy:undefined;
    if(stat.type!=="file"||stat.size>8192)throw new SyncSafetyError(`The recovery journal for ${path} is invalid; local bytes were left unchanged.`);
    let record:ApplyOperation&{path:string;snapshotId:string|null};
    try{record=JSON.parse(decoder.decode(new Uint8Array(await this.adapter.readBinary(recordPath)))) as typeof record;}catch{throw new SyncSafetyError(`The recovery journal for ${path} is incomplete; local bytes were left unchanged.`);}
    if(record.path!==path||record.snapshotId!==settings.pendingApplySnapshotId||record.targetHash!==targetHash||record.priorHash!==priorHash||record.stagePath!==expected.stagePath||record.backupPath!==expected.backupPath||!["planned","staged","backed-up","promoting","applied"].includes(record.phase))throw new SyncSafetyError(`The recovery journal for ${path} does not match its accepted operation; local bytes were left unchanged.`);
    const operation:ApplyOperation={targetHash,priorHash,...expected,phase:record.phase};settings.pendingApplyOperations[path]=operation;return operation;
  }

  private async savedHash(path:string,allowCancelled=false):Promise<string|null>{
    const stat=await this.adapter.stat(path);if(!stat)return null;if(stat.type!=="file")throw new FileChangedDuringReadError(path);
    return this.hashLocalFile(path,allowCancelled);
  }

  private async hashLocalFile(path:string,allowCancelled=false):Promise<string>{
    const streamedServer=typeof this.api.supportsStreamUpload==="function"&&this.api.supportsStreamUpload(),stat=streamedServer?await this.adapter.stat(path):null,allowBufferedFallback=!streamedServer||(stat?.size??0)<LOW_MEMORY_DOWNLOAD_BYTES;
    try{return await hashAdapterFile(this.adapter,path,allowCancelled?()=>{}:()=>this.checkpoint(),allowCancelled?this.yieldControl:()=>this.cooperate(),allowBufferedFallback);}
    catch(error){if(error instanceof AdapterFileChangedError)throw new FileChangedDuringReadError(path);throw error;}
  }

  private async rollbackMissingDestination(path:string,operation:ApplyOperation):Promise<void>{
    // Public DataAdapter.copy fails if the destination exists; unlike rename,
    // it cannot silently clobber a file created after an absence check.
    const backupHash=await this.savedHash(operation.backupPath,true);if(backupHash&&await this.savedHash(path,true)===null){operation.phase="promoting";await this.persistOperation(path,operation,true);this.expectLocalMutation(path,backupHash);try{await this.adapter.copy(operation.backupPath,path);}catch(error){if(await this.savedHash(path,true)===null)throw error;} }
  }

  private async replaceFile(path:string,clear:Uint8Array,targetHash:string,prior:FileState|undefined):Promise<void>{
    await this.assertLocalUnchanged(path,prior);
    const operation=await this.operationFor(path,targetHash,prior?.hash??null);
    try{
      await this.ensureParent(operation.stagePath);this.checkpoint();await this.adapter.writeBinary(operation.stagePath,exactArrayBuffer(clear));
      if(await this.savedHash(operation.stagePath)!==targetHash)throw new SyncSafetyError(`Staged download integrity check failed for ${path}; its original content was preserved.`);
      await this.applyVerifiedStage(path,operation,prior);
    }catch(error){await this.rollbackMissingDestination(path,operation);throw error;}
  }

  private async replaceStreamedFile(path:string,entry:FileState,prior:FileState|undefined):Promise<void>{
    await this.assertLocalUnchanged(path,prior);const operation=await this.operationFor(path,entry.hash,prior?.hash??null);
    try{
      await this.ensureParent(operation.stagePath);this.checkpoint();await this.adapter.writeBinary(operation.stagePath,new ArrayBuffer(0));
      await this.api.streamContent(entry.hash,entry.size,async(chunk)=>{this.checkpoint();await this.adapter.appendBinary(operation.stagePath,exactArrayBuffer(chunk));this.checkpoint();await this.cooperate();},()=>this.checkpoint());
      if(await this.savedHash(operation.stagePath)!==entry.hash)throw new SyncSafetyError(`Staged download integrity check failed for ${path}; its original content was preserved.`);
      await this.applyVerifiedStage(path,operation,prior);
    }catch(error){await this.rollbackMissingDestination(path,operation);throw error;}
  }

  private async applyVerifiedStage(path:string,operation:ApplyOperation,prior:FileState|undefined):Promise<void>{
      operation.phase="staged";await this.persistOperation(path,operation);await this.assertLocalUnchanged(path,prior);
      if(prior){
        if(await this.adapter.exists(operation.backupPath))await this.archiveOperationBackup(path,operation);
        this.checkpoint();this.expectLocalMutation(path,operation.targetHash);await this.adapter.rename(path,operation.backupPath);
        if(await this.savedHash(operation.backupPath)!==prior.hash)throw new FileChangedDuringReadError(path);
      }
      operation.phase="backed-up";await this.persistOperation(path,operation);await this.assertLocalUnchanged(path,undefined);
      operation.phase="promoting";await this.persistOperation(path,operation);
      this.expectLocalMutation(path,operation.targetHash);this.checkpoint();await this.adapter.copy(operation.stagePath,path);
      if(await this.savedHash(path)!==operation.targetHash)throw new SyncSafetyError(`Applied download integrity check failed for ${path}; its recovery copy was retained.`);
      operation.phase="applied";await this.persistOperation(path,operation);this.checkpoint();
  }

  private async deleteFile(path:string,prior:FileState):Promise<void>{
    await this.assertLocalUnchanged(path,prior);const operation=await this.operationFor(path,null,prior.hash);
    try{
      await this.ensureParent(operation.backupPath);await this.assertLocalUnchanged(path,prior);
      if(await this.adapter.exists(operation.backupPath))await this.archiveOperationBackup(path,operation);
      this.checkpoint();this.expectLocalMutation(path,null);await this.adapter.rename(path,operation.backupPath);
      if(await this.savedHash(operation.backupPath)!==prior.hash)throw new FileChangedDuringReadError(path);
      operation.phase="applied";await this.persistOperation(path,operation);this.checkpoint();
    }catch(error){await this.rollbackMissingDestination(path,operation);throw error;}
  }

  private async recoverOperationBoundary(path:string,targetHash:string|null,priorHash:string|null):Promise<void>{
    const operation=await this.loadOperation(path,targetHash,priorHash);if(!operation)return;
    const current=await this.savedHash(path),backup=await this.savedHash(operation.backupPath);
    if(backup!==null&&backup!==operation.priorHash)throw new SyncSafetyError(`Recovery bytes for ${path} changed unexpectedly; neither version was overwritten.`);
    if(operation.phase==="promoting"&&current!==null&&current!==operation.targetHash&&current!==operation.priorHash)throw new SyncSafetyError(`An interrupted copy left an unverified version of ${path}. Its original and incoming copies are safe; use Repair from the accepted server snapshot before syncing. This uncertain content was not uploaded.`);
    if(current===null&&backup!==null&&operation.targetHash!==null)await this.rollbackMissingDestination(path,operation);
    // A saved stage is disposable only when the exact target can be fetched
    // again. Keep original backups until the whole accepted snapshot is applied.
  }

  private async finishOperations(explicitRepair=false):Promise<void>{
    const settings=this.getSettings();
    for(const [path,operation] of Object.entries(settings.pendingApplyOperations)){
      await this.cooperate();if(await this.adapter.exists(operation.backupPath))await this.archiveOperationBackup(path,operation,explicitRepair);
      if(operation.targetHash&&await this.savedHash(operation.stagePath)===operation.targetHash){this.checkpoint();await this.adapter.remove(operation.stagePath);}
      const recordPath=this.operationRecord(operation);if(await this.adapter.exists(recordPath)){this.checkpoint();await this.adapter.remove(recordPath);}
    }
    settings.pendingApplyOperations={};
  }

  private async archiveOperationBackup(path:string,operation:ApplyOperation,explicitRepair=false):Promise<void>{
    const expected=explicitRepair?await this.savedHash(operation.backupPath):operation.priorHash,recovery=await this.localRecoveryPath(`accepted-${this.getSettings().pendingApplySnapshotId??"restore"}`,path);await this.ensureParent(recovery);
    if(await this.savedHash(operation.backupPath)!==expected)throw new SyncSafetyError(`The recovery copy for ${path} changed; it was not discarded or archived as a verified original.`);
    this.checkpoint();await this.adapter.rename(operation.backupPath,recovery);
  }

  private async mirror(snapshotId:string,entries:ManifestEntry[],final:Map<string,FileState>,bytes:Map<string,Uint8Array>,remoteCache:Map<string,Uint8Array>):Promise<number>{
    this.status({phase:"checking",message:"Verifying the Seafile copy"});const plan=await this.api.mirrorPlan(snapshotId,entries);this.checkpoint();if(plan.alreadyCurrent||plan.serverManaged)return 0;
    if(plan.uploadPaths.length||plan.deletePaths.length)this.status({phase:"mirroring",message:"Updating the Seafile copy",current:0,total:plan.uploadPaths.length||undefined});
    let mirrored=0;for(const path of plan.uploadPaths){await this.cooperate();const entry=final.get(path);if(!entry)throw new Error(`Mirror plan referenced missing path: ${path}`);const clear=bytes.get(entry.hash)??await this.remoteBytes(entry,remoteCache);if(entry.size<LOW_MEMORY_DOWNLOAD_BYTES)bytes.set(entry.hash,clear);
      this.checkpoint();await this.api.putMirrorFile(snapshotId,path,entry.hash,clear);this.checkpoint();if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES){bytes.delete(entry.hash);remoteCache.delete(entry.hash);}mirrored++;if(this.progress(mirrored,plan.uploadPaths.length))this.status({phase:"mirroring",message:`Writing readable recovery files (${mirrored}/${plan.uploadPaths.length})`,current:mirrored,total:plan.uploadPaths.length});}
    this.checkpoint();await this.api.mirrorComplete(snapshotId);this.checkpoint();this.status({phase:"checking",message:`Seafile copy verified · ${entries.length} files`});return mirrored;
  }

  private async applyFinal(final:Map<string,FileState>,physicalLocal:Map<string,FileState>,desktopOnlyPlugins:Set<string>,scanned:LocalScan,orphanUnreadableConflicts:string[],bytes:Map<string,Uint8Array>,remoteCache:Map<string,Uint8Array>):Promise<{downloaded:number;deleted:number}>{
    let downloaded=0,deleted=0;this.status({phase:"checking",message:"Checking which files this device needs"});
    const operationTotal=[...final].filter(([path,entry])=>physicalLocal.get(path)?.hash!==entry.hash).length+[...physicalLocal.keys()].filter(path=>!final.has(path)&&this.include(path)).length;
    const applyOrder=[...final].sort(([left,leftEntry],[right,rightEntry])=>{
      const rank=(path:string,entry:FileState)=>path===this.enablementPath?4:entry.size>=LOW_MEMORY_DOWNLOAD_BYTES?3:this.pluginPath(path)?0:this.systemPath(path)?2:1;
      return rank(left,leftEntry)-rank(right,rightEntry)||left.localeCompare(right);
    });
    for(const [path,entry] of applyOrder){
      await this.cooperate();let deviceEntry=entry,deviceClear:Uint8Array|undefined;
      if(this.isMobileDevice&&path===this.enablementPath&&desktopOnlyPlugins.size){
        const serverClear=bytes.get(entry.hash)??await this.remoteBytes(entry,remoteCache);
        try{const enabled=JSON.parse(decoder.decode(serverClear)) as unknown;if(Array.isArray(enabled)){deviceClear=encoder.encode(`${JSON.stringify(enabled.filter((id)=>typeof id==="string"&&!desktopOnlyPlugins.has(id)),null,2)}\n`);const hash=await hashBytes(deviceClear);deviceEntry={...entry,hash,size:deviceClear.length};}}catch{}
      }
      if(physicalLocal.get(path)?.hash===deviceEntry.hash)continue;
      this.status({phase:"applying",message:"Updating files on this device",current:downloaded+deleted,total:operationTotal});
      if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES)this.status({phase:"applying",message:`Downloading large file with mobile-safe memory use · ${path} · ${(entry.size/1024/1024).toFixed(1)} MB`,current:downloaded+deleted,total:operationTotal});
      if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES&&!deviceClear&&typeof this.adapter.appendBinary==="function"&&typeof this.api.streamContent==="function"){
        await this.ensureParent(path);await this.replaceStreamedFile(path,entry,physicalLocal.get(path));bytes.delete(entry.hash);remoteCache.delete(entry.hash);downloaded++;continue;
      }
      const clear=deviceClear??bytes.get(entry.hash)??await this.remoteBytes(entry,remoteCache);if(entry.size<LOW_MEMORY_DOWNLOAD_BYTES&&!deviceClear)bytes.set(entry.hash,clear);
      await this.ensureParent(path);await this.replaceFile(path,clear,deviceEntry.hash,physicalLocal.get(path));if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES){bytes.delete(entry.hash);remoteCache.delete(entry.hash);}downloaded++;
    }
    for(const path of physicalLocal.keys())if(!final.has(path)&&this.include(path)){
      await this.cooperate();if(scanned.unreadableConflictPaths.has(path)){this.status({phase:"applying",message:`Left inaccessible generated conflict entry isolated on this device · ${path}`,level:"warning"});continue;}
      this.status({phase:"applying",message:"Applying accepted file deletions",current:downloaded+deleted,total:operationTotal});await this.deleteFile(path,physicalLocal.get(path)!);deleted++;
    }
    for(const path of orphanUnreadableConflicts)this.status({phase:"applying",message:`Unreadable local file retained · ${path} · its filename does not authorize deletion`,level:"warning"});
    return {downloaded,deleted};
  }

  private trimRetiredPaths(){
    const settings=this.getSettings(),cutoff=Date.now()-RETIRED_PATH_MAX_AGE;
    // A device may be offline longer than ninety days. Retirements are causal
    // safety records, not a cache; time alone cannot make old bytes new again.
    settings.retiredPaths=Object.fromEntries(Object.entries(settings.retiredPaths).sort((left,right)=>right[1].retiredAt-left[1].retiredAt));
    settings.folderCreateTimes=Object.fromEntries(Object.entries(settings.folderCreateTimes).filter(([,createdAt])=>createdAt>=cutoff).sort((left,right)=>right[1]-left[1]).slice(0,RETIRED_PATH_LIMIT));
  }
  private async deviceBytes(path:string,entry:FileState,cache:Map<string,Uint8Array>,desktopOnly:Set<string>):Promise<{clear:Uint8Array;hash:string}>{
    let clear=await this.remoteBytes(entry,cache),hash=entry.hash;
    if(this.isMobileDevice&&path===this.enablementPath&&desktopOnly.size)try{
      const enabled=JSON.parse(decoder.decode(clear)) as unknown;
      if(Array.isArray(enabled)){clear=encoder.encode(`${JSON.stringify(enabled.filter((id)=>typeof id==="string"&&!desktopOnly.has(id)),null,2)}\n`);hash=await hashBytes(clear);}
    }catch{}
    return {clear,hash};
  }
  private async resumePendingApplication():Promise<number>{
    const settings=this.getSettings(),pending=[...new Set(settings.pendingApplyPaths.map((path)=>normalizePath(path)).filter(Boolean))];if(!pending.length&&!settings.pendingApplySnapshotId)return 0;
    // v0.8.33 recorded lastSnapshotId before applying. Treat it as the staged
    // target when upgrading an interrupted journal that predates explicit ids.
    const targetId=settings.pendingApplySnapshotId??settings.lastSnapshotId;if(!targetId)throw new SyncSafetyError("An accepted device update is pending, but its target snapshot was not recorded.");
    const target=await this.optionalSnapshot(targetId);if(!target)throw new SyncSafetyError("An accepted device update is pending, but its exact server snapshot is unavailable. No local files were uploaded or deleted.");
    const priorId=settings.pendingApplyBaseSnapshotId??target.parentId,prior=priorId?await this.optionalSnapshot(priorId):null,targetMap=this.map(target),priorMap=this.map(prior),cache=this.bodyCache(),desktopOnly=new Set<string>();let completed=0,preserved=0;
    if(this.isMobileDevice)for(const [path,entry] of targetMap){const plugin=this.pluginPath(path);if(plugin?.relative.toLowerCase()!=="manifest.json")continue;try{if((JSON.parse(decoder.decode(await this.remoteBytes(entry,cache))) as {isDesktopOnly?:unknown}).isDesktopOnly===true)desktopOnly.add(plugin.id);}catch{}}
    for(const path of pending){const old=priorMap.get(path);if(!targetMap.has(path)&&old)settings.retiredPaths[path]={hash:old.hash,snapshotId:target.id,retiredAt:Date.now()};}
    this.trimRetiredPaths();await this.saveSettings();
    this.status({phase:"applying",message:`Resuming ${pending.length} accepted file operation${pending.length===1?"":"s"} from its exact snapshot`});
    for(const path of pending){
      await this.cooperate();const entry=targetMap.get(path),old=priorMap.get(path);
      const priorHash=Object.prototype.hasOwnProperty.call(settings.pendingApplyPriorHashes,path)?settings.pendingApplyPriorHashes[path]:(old?.hash??null);
      const expected=entry?(this.isMobileDevice&&path===this.enablementPath?await this.deviceBytes(path,entry,cache,desktopOnly):{hash:entry.hash,clear:undefined}):undefined;
      await this.recoverOperationBoundary(path,expected?.hash??null,priorHash);let stat=await this.adapter.stat(path),currentHash:string|null=null;
      if(stat?.type==="file")try{currentHash=await this.savedHash(path);}catch(error){if(await this.disappeared(path))stat=null;else throw error;}
      if(entry){
        if(currentHash===expected!.hash){completed++;continue;}
        if(currentHash!==null&&currentHash!==priorHash){
          const replayBase=settings.pendingApplyPriorEntries[path]??(old?.hash===priorHash?old:undefined);
          // A legacy journal without a provable source must preserve both
          // versions; never reinterpret its new editor bytes as a replacement
          // of an incoming version the editor has not actually seen.
          settings.localReconcileBases[path]=replayBase??null;
          preserved++;settings.pendingPathTimes[path]=settings.pendingPathTimes[path]??Date.now();if(!settings.pendingPaths.includes(path))settings.pendingPaths.push(path);completed++;continue;
        }
        await this.ensureParent(path);const observed=currentHash&&stat?{path,hash:currentHash,size:stat.size,mtime:stat.mtime}:undefined;
        if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES&&typeof this.adapter.appendBinary==="function"&&typeof this.api.streamContent==="function")await this.replaceStreamedFile(path,entry,observed);
        else await this.replaceFile(path,expected!.clear??await this.remoteBytes(entry,cache),expected!.hash,observed);
      }else if(stat){
        if(priorHash!==null&&currentHash===priorHash)await this.deleteFile(path,{path,hash:currentHash,size:stat.size,mtime:stat.mtime});
        else{settings.localReconcileBases[path]=settings.pendingApplyPriorEntries[path]??old??null;preserved++;settings.pendingPathTimes[path]=settings.pendingPathTimes[path]??Date.now();if(!settings.pendingPaths.includes(path))settings.pendingPaths.push(path);}
      }
      completed++;if(this.progress(completed,pending.length))this.status({phase:"applying",message:"Resuming accepted device state",current:completed,total:pending.length});
    }
    const retiredCleanup=await this.pruneRetiredEmptyFolders(),topology=await this.reconcileFolderTopology(this.snapshotFolders(target),target.folderRepair,target.createdAt);await this.finishOperations();settings.lastSnapshotId=target.id;settings.initialized=true;settings.pendingApplyPaths=[];settings.pendingApplySnapshotId=null;settings.pendingApplyBaseSnapshotId=null;settings.pendingApplyPriorHashes={};settings.pendingApplyPriorEntries={};settings.pendingCommit=null;settings.pendingPaths=[...new Set(settings.pendingPaths)].sort();if(settings.syncPlugins)settings.pluginSyncBootstrapPending=false;await this.saveSettings();
    if(preserved)this.status({phase:"applying",message:`Preserved ${preserved} genuine local change${preserved===1?"":"s"} made during the interrupted download; they will reconcile normally`,level:"success"});
    return retiredCleanup.removed+topology.removed;
  }

  private async stageAndApply(snapshotId:string,final:Map<string,FileState>,topologyPaths:Iterable<string>,physicalLocal:Map<string,FileState>,desktopOnlyPlugins:Set<string>,scanned:LocalScan,orphanUnreadableConflicts:string[],bytes:Map<string,Uint8Array>,remoteCache:Map<string,Uint8Array>,folderRepair?:Snapshot["folderRepair"],repairSnapshotCreatedAt?:string):Promise<{downloaded:number;deleted:number;prunedFolders:number}>{
    const changed=[...final].filter(([path,entry])=>physicalLocal.get(path)?.hash!==entry.hash).map(([path])=>path),removed=[...physicalLocal.keys()].filter((path)=>!final.has(path));
    const settings=this.getSettings(),baseId=settings.lastSnapshotId;settings.pendingApplySnapshotId=snapshotId;settings.pendingApplyBaseSnapshotId=baseId;settings.pendingApplyPaths=[...new Set([...changed,...removed,...orphanUnreadableConflicts])].sort();
    settings.pendingApplyPriorHashes=Object.fromEntries(settings.pendingApplyPaths.map((path)=>[path,physicalLocal.get(path)?.hash??null]));
    settings.pendingApplyPriorEntries=Object.fromEntries(settings.pendingApplyPaths.flatMap(path=>{const entry=physicalLocal.get(path);return entry?[[path,this.manifestEntry(entry)]]:[]}));
    for(const path of removed){const previous=physicalLocal.get(path);if(previous)settings.retiredPaths[path]={hash:previous.hash,snapshotId,retiredAt:Date.now()};}
    // The controller acknowledges consumed path revisions after success. Never
    // erase edits observed while upload/commit was awaiting the network.
    this.trimRetiredPaths();await this.saveSettings();
    const result=await this.applyFinal(final,physicalLocal,desktopOnlyPlugins,scanned,orphanUnreadableConflicts,bytes,remoteCache),retiredCleanup=await this.pruneRetiredEmptyFolders(),topology=await this.reconcileFolderTopology(topologyPaths,folderRepair,repairSnapshotCreatedAt);
    await this.finishOperations();settings.lastSnapshotId=snapshotId;if(!topology.remaining)settings.observedFolderSnapshotId=snapshotId;settings.initialized=true;settings.pendingApplyPaths=[];settings.pendingApplySnapshotId=null;settings.pendingApplyBaseSnapshotId=null;settings.pendingApplyPriorHashes={};settings.pendingApplyPriorEntries={};settings.localReconcileBases={};settings.pendingCommit=null;if(settings.syncPlugins)settings.pluginSyncBootstrapPending=false;await this.saveSettings();return {...result,prunedFolders:retiredCleanup.removed+topology.removed};
  }

  private async run(attempt: number): Promise<SyncResult> {
    const settings = this.getSettings(); if (!settings.deviceToken || !settings.vaultKey) throw new Error("Gib Sync is not configured");
    await this.recoverPendingCommit();
    const initialFolderCleanup=await this.pruneRetiredEmptyFolders();let prunedFolders=initialFolderCleanup.removed;if(initialFolderCleanup.attempted)await this.saveSettings();
    let requestedBaseId=settings.lastSnapshotId;
    let pendingPaths=[...new Set(settings.pendingPaths.map((path)=>normalizePath(path)).filter(Boolean))];
    const consumedMoves=settings.pendingMoves.map(move=>({...move}));
    const lastAudit=settings.lastFullScanAt?Date.parse(settings.lastFullScanAt):0,auditDue=!lastAudit||Date.now()-lastAudit>=6*60*60*1000;
    this.status({phase:"reading-remote",message:"Checking for a newer server snapshot"});
    let remoteHeadId:string|null;
    try{remoteHeadId=(await this.api.headState()).headId;}catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;remoteHeadId=(await this.api.state()).head?.id??null;}
    if(remoteHeadId!==requestedBaseId)this.status({phase:"checking",message:"New server changes found",remoteChanged:true});
    if(settings.initialized&&!settings.pendingApplySnapshotId&&!settings.pendingApplyPaths.length&&!Object.keys(settings.localReconcileBases).length&&!settings.fullScanRequired&&!settings.pluginSyncBootstrapPending&&!auditDue&&!pendingPaths.length&&remoteHeadId===requestedBaseId){
      const inspectTopology=settings.observedFolderSnapshotId!==requestedBaseId||settings.retiredFolderCount>0||Boolean(settings.lastFolderCleanupError);
      let topology={removed:0,remaining:0};
      if(inspectTopology){const accepted=requestedBaseId?await this.api.snapshot(requestedBaseId):null;topology=await this.reconcileFolderTopology(this.snapshotFolders(accepted),accepted?.folderRepair,accepted?.createdAt);prunedFolders+=topology.removed;await this.saveSettings();}
      this.status({phase:topology.remaining?"applying":"up-to-date",message:topology.remaining?settings.retiredFolderNote:"Up to date · accepted file manifest and observed folders agree",level:topology.remaining?"warning":"success"});
      return {uploaded:0,downloaded:0,deleted:0,prunedFolders,pendingRetiredFolders:settings.retiredFolderCount,conflicts:0,resolved:0,mirrored:0,snapshotId:requestedBaseId,processedPaths:[],fullScan:false};
    }
    const remoteSnapshot=(await this.api.state()).head;
    if(settings.pendingApplySnapshotId||settings.pendingApplyPaths.length){prunedFolders+=await this.resumePendingApplication();requestedBaseId=settings.lastSnapshotId;pendingPaths=[...new Set(settings.pendingPaths.map((path)=>normalizePath(path)).filter(Boolean))];}
    const baseSnapshot = requestedBaseId ? await this.optionalSnapshot(requestedBaseId) : null;
    const ownDescendants=baseSnapshot&&pendingPaths.length?await this.ownDescendantCount(requestedBaseId,remoteSnapshot,settings.deviceId):0;
    const fullScan=settings.fullScanRequired||Boolean(Object.keys(settings.localReconcileBases).length)||settings.pluginSyncBootstrapPending||!settings.initialized||!baseSnapshot||auditDue;
    this.status({phase:"scanning",message:fullScan?"Reconciling the full local vault":pendingPaths.length?`Checking ${pendingPaths.length} changed path${pendingPaths.length===1?"":"s"}`:"No local paths changed"});
    const scanBaseline=ownDescendants&&remoteSnapshot?remoteSnapshot:baseSnapshot;
    const scanned=fullScan?await this.scan():await this.scanIncremental(scanBaseline!,pendingPaths),local=scanned.files;
    // Carry server identities through physical scans without pretending a new
    // content hash has the baseline's authorship. The server assigns revisions.
    for(const entry of scanBaseline?.entries??[]){const observed=local.get(entry.path);if(observed)local.set(entry.path,{...entry,...observed});}
    let effectiveBaseSnapshot=baseSnapshot;
    if(ownDescendants&&remoteSnapshot){
      const remoteMap=this.map(remoteSnapshot),allPaths=new Set([...local.keys(),...remoteMap.keys()]),pending=new Set(pendingPaths);
      const differences=[...allPaths].filter((path)=>local.get(path)?.hash!==remoteMap.get(path)?.hash||local.has(path)!==remoteMap.has(path));
      if(!fullScan||differences.every((path)=>pending.has(path))){
        effectiveBaseSnapshot=remoteSnapshot;
        this.status({phase:"merging",message:`Recovered a stale local checkpoint across ${ownDescendants} prior sync${ownDescendants===1?"":"s"} from this device; applying only newly observed local changes`,level:"success"});
      }else{
        // Recover each observed path independently. An unrelated unjournaled
        // bookmark/config difference must not turn a note into a self-conflict.
        const recovered=new Map(this.map(baseSnapshot));let count=0;
        for(const path of allPaths)if([...pending].some(prefix=>path===prefix||path.startsWith(`${prefix.replace(/\/$/,"")}/`))){const entry=remoteMap.get(path);if(entry)recovered.set(path,entry);else recovered.delete(path);count++;}
        effectiveBaseSnapshot={...baseSnapshot!,entries:[...recovered.values()]};
        this.status({phase:"merging",message:`Recovered ${count} observed paths across this device's prior uploads; unrecorded differences retain normal lossless reconciliation`,level:"info"});
      }
    }
    let onboardingReconcile=false;
    if(settings.initialized&&requestedBaseId&&!baseSnapshot&&local.size){
      throw new SyncSafetyError("Stale-device protection paused sync because this device's last verified server snapshot is unavailable. No files were uploaded or deleted. Reconnect this device to establish a safe baseline.");
    }
    if(!settings.initialized&&remoteSnapshot&&settings.onboardingMode==="server-first"){
      const accepted=this.map(remoteSnapshot),desktopOnly=new Set<string>(),cache=this.bodyCache();
      if(this.isMobileDevice&&settings.syncPlugins)for(const [path,entry] of accepted){const plugin=this.pluginPath(path);if(plugin?.relative.toLowerCase()!=="manifest.json")continue;try{if((JSON.parse(decoder.decode(await this.remoteBytes(entry,cache))) as {isDesktopOnly?:unknown}).isDesktopOnly===true)desktopOnly.add(plugin.id);}catch{}}
      this.status({phase:"applying",message:"Downloading the accepted server vault; existing local differences are retained in local recovery"});
      const applied=await this.stageAndApply(remoteSnapshot.id,accepted,this.snapshotFolders(remoteSnapshot),local,desktopOnly,scanned,[],this.bodyCache(),cache,remoteSnapshot.folderRepair,remoteSnapshot.createdAt);
      this.checkpoint();await this.api.markDeviceReady(remoteSnapshot.id);this.checkpoint();settings.fullScanRequired=false;settings.lastFullScanAt=new Date().toISOString();await this.saveSettings();
      return {uploaded:0,downloaded:applied.downloaded,deleted:applied.deleted,prunedFolders:prunedFolders+applied.prunedFolders,pendingRetiredFolders:settings.retiredFolderCount,conflicts:0,resolved:0,mirrored:0,snapshotId:remoteSnapshot.id,processedPaths:pendingPaths,fullScan:true};
    }
    if(remoteSnapshot&&!baseSnapshot&&local.size){
      const remoteHashes=new Map(remoteSnapshot.entries.filter((entry)=>this.include(entry.path)).map((entry)=>[entry.path,entry.hash]));
      const unexpected=[...local.values()].filter((entry)=>remoteHashes.get(entry.path)!==entry.hash);
      if(unexpected.length){
        const exactMatches=[...local.values()].filter((entry)=>remoteHashes.get(entry.path)===entry.hash).length;
        const comparedSize=Math.max(local.size,remoteHashes.size),overlap=comparedSize?exactMatches/comparedSize:0;
      const localUserFiles=[...local.values()].filter((entry)=>!this.systemPath(entry.path)),exactUserMatches=localUserFiles.filter((entry)=>remoteHashes.get(entry.path)===entry.hash).length;
        const localAgreement=localUserFiles.length?exactUserMatches/localUserFiles.length:1,interruptedDownload=localUserFiles.length===0||(exactUserMatches>0&&localAgreement>=0.8);
        onboardingReconcile=true;
        this.status({phase:"merging",message:overlap>=0.9?`Matching vault recognized · ${exactMatches}/${comparedSize} files agree; preserving every difference`:interruptedDownload?`Interrupted onboarding recognized · ${exactUserMatches}/${localUserFiles.length} local user files already match; preserving local-only files`:`Connecting populated vaults · ${exactMatches}/${comparedSize} files agree; both independent versions will be preserved without inferring deletions`,level:"success"});
      }
    }
    if(Object.keys(settings.localReconcileBases).length&&effectiveBaseSnapshot){
      const replay=this.map(effectiveBaseSnapshot);for(const [path,entry] of Object.entries(settings.localReconcileBases))if(this.include(path)){if(entry)replay.set(path,entry);else replay.delete(path);}
      effectiveBaseSnapshot={...effectiveBaseSnapshot,entries:[...replay.values()]};
      this.status({phase:"merging",message:`Replaying ${Object.keys(settings.localReconcileBases).length} edits made during a download against their actual prior content`,level:"info"});
    }
    const base = this.map(effectiveBaseSnapshot), remote = this.map(remoteSnapshot);for(const path of scanned.unreadableConflictPaths){const accepted=base.get(path)??remote.get(path);if(accepted)local.set(path,accepted);}
    const physicalLocal=new Map(local),bootstrapPluginSync=settings.syncPlugins&&settings.pluginSyncBootstrapPending,acceptedPluginState=Boolean(bootstrapPluginSync&&remoteSnapshot&&[...remote.keys()].some((path)=>this.pluginSyncPath(path)));
    if(acceptedPluginState){for(const path of new Set([...local.keys(),...remote.keys()].filter((candidate)=>this.pluginSyncPath(candidate)))){const accepted=remote.get(path);if(accepted)local.set(path,accepted);else local.delete(path);}this.status({phase:"merging",message:"Plugin sync first activation · adopting the accepted server plugin inventory and settings before publishing device changes",level:"success"});}
    else if(bootstrapPluginSync)this.status({phase:"merging",message:"Plugin sync first activation · no accepted plugin inventory exists, so this device will establish it",level:"info"});
    const orphanUnreadableConflicts=[...scanned.unreadableConflictPaths].filter((path)=>!base.has(path)&&!remote.has(path));let suppressedRetired=0,retiredStateChanged=false;
    for(const [path,retired] of Object.entries(settings.retiredPaths)){
      const current=local.get(path);
      if(remote.has(path)){delete settings.retiredPaths[path];retiredStateChanged=true;continue;}
      if(current?.hash===retired.hash){
        const observed=settings.fileCreationTimes[path]??0;
        let recreated=false;
        if(observed>retired.retiredAt){const stat=await this.adapter.stat(current.sourcePath??path);recreated=Boolean(stat?.type==="file"&&Math.max(stat.ctime,stat.mtime)>retired.retiredAt);}
        if(recreated){delete settings.retiredPaths[path];retiredStateChanged=true;continue;}
        local.delete(path);suppressedRetired++;continue;
      }
      if(current){delete settings.retiredPaths[path];retiredStateChanged=true;}
    }
    this.trimRetiredPaths();if(retiredStateChanged)await this.saveSettings();
    if(suppressedRetired)this.status({phase:"merging",message:`Removed ${suppressedRetired} stale retired path${suppressedRetired===1?"":"s"} that reappeared after an earlier accepted move or deletion`,level:"success"});
    const recognizedMoves=this.canonicalizeMoves(base,local,remote,effectiveBaseSnapshot,remoteSnapshot),final = new Map<string, FileState>();
    const bytes = this.bodyCache(); const remoteCache = this.bodyCache();
    const paths = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);const occupied=new Set(paths);
    let conflicts = 0,resolved=0; this.status({phase:"merging",message:`Comparing ${paths.size} paths · ${local.size} local · ${remote.size} remote · ${base.size} baseline`});
    if(recognizedMoves)this.status({phase:"merging",message:`Recognized ${recognizedMoves} file move${recognizedMoves===1?"":"s"} by content identity; edits will follow the destination`,level:"success"});
    const handledPluginPaths=new Set<string>(),desktopOnlyPlugins=new Set<string>();
    if(settings.syncPlugins){
      const pluginIds=new Set([...paths].map((path)=>this.pluginPath(path)?.id).filter((id):id is string=>Boolean(id)));
      const packageFor=(source:Map<string,FileState>,id:string)=>new Map([...source].filter(([path])=>{const plugin=this.pluginPath(path);return plugin?.id===id&&!this.pluginDataPath(path);}));
      const localPackageIsNewer=(entries:Map<string,FileState>)=>Math.max(0,...[...entries].map(([path,entry])=>this.localChangeTime(path,entry,effectiveBaseSnapshot)))>(remoteSnapshot?Date.parse(remoteSnapshot.createdAt):0);
      const versionFor=async(source:"local"|"remote",entries:Map<string,FileState>,id:string):Promise<string|null>=>{
        const entry=entries.get(this.pluginFile(id,"manifest.json"));if(!entry)return null;
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
          const localComplete=localPackage.has(this.pluginFile(id,"manifest.json"))&&localPackage.has(this.pluginFile(id,"main.js")),remoteComplete=remotePackage.has(this.pluginFile(id,"manifest.json"))&&remotePackage.has(this.pluginFile(id,"main.js"));
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
        const path=this.pluginFile(id,"manifest.json"),entry=final.get(path);if(!entry)continue;
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
      if (this.same(l, r)) { if (r) final.set(path, {...l,...r}); continue; }
      if(settings.syncPlugins&&path===this.enablementPath&&b&&l&&r){
        const baseText=decoder.decode(await this.remoteBytes(b,remoteCache)),localText=decoder.decode(await this.localBytes(path,l,bytes)),remoteText=decoder.decode(await this.remoteBytes(r,remoteCache)),preferred=this.preferredSide(path,l,effectiveBaseSnapshot,remoteSnapshot,r);
        const merged=mergeCommunityPluginEnablement(baseText,localText,remoteText,preferred,desktopOnlyPlugins,this.isMobileDevice),clear=encoder.encode(merged.text);await this.prepareResult(path,clear,final,bytes);resolved++;
        this.status({phase:"merging",message:`Plugin enablement · ${merged.reason}`,level:"success"});continue;
      }
      // A filename is never proof of ownership or an accepted deletion.
      if (!settings.initialized && !b && !l && r) { final.set(path, r); continue; }
      if (this.same(l, b)) { if (r) final.set(path, r); continue; }
      if (this.same(r, b)) { if (l) final.set(path, l); continue; }
      if (!b && l && !r) { final.set(path, l); continue; }
      if (!b && !l && r) { final.set(path, r); continue; }
      if (!l && !r) continue;
      if(this.systemPath(path)){
        if(b&&(!l||!r)){
          const kept=l??r;if(kept)final.set(path,kept);resolved++;this.status({phase:"merging",message:`Obsidian system file · ${path} · kept the modified version instead of an overlapping deletion`,level:"warning"});continue;
        }
        if(l&&r){
          const preferred=this.preferredSide(path,l,effectiveBaseSnapshot,remoteSnapshot,r);
          if(Math.max(b?.size??0,l.size,r.size)>=LOW_MEMORY_DOWNLOAD_BYTES){final.set(path,preferred==="local"?l:r);resolved++;this.status({phase:"merging",message:`Large Obsidian settings file · ${path} · used the newer complete ${preferred} version without parsing it; prior copies remain recoverable`,level:"warning"});continue;}
          if(path.toLowerCase().endsWith(".json")){
            const baseText=b?decoder.decode(await this.remoteBytes(b,remoteCache)):"{}",localText=decoder.decode(await this.localBytes(path,l,bytes)),remoteText=decoder.decode(await this.remoteBytes(r,remoteCache));
            const merged=path===this.enablementPath?mergeCommunityPluginEnablement(baseText,localText,remoteText,preferred,desktopOnlyPlugins,this.isMobileDevice):mergeSystemJson(baseText,localText,remoteText,preferred,path===normalizePath(`${settings.configDir}/bookmarks.json`)?"bookmarks":undefined),clear=encoder.encode(merged.text);await this.prepareResult(path,clear,final,bytes);
            this.status({phase:"merging",message:`Obsidian settings · ${path} · ${merged.reason}`,level:merged.overlaps?"warning":"success"});
          }else{const chosen=preferred==="local"?l:r;final.set(path,chosen);this.status({phase:"merging",message:`Obsidian system file · ${path} · used newer ${preferred} whole file`,level:"info"});}
          resolved++;continue;
        }
      }
      if(b&&(!l||!r)){
        conflicts++;
        const survivor=l??r;if(survivor&&survivor.size>=LOW_MEMORY_DOWNLOAD_BYTES){const editor=l?settings.deviceName:r!.revision?.deviceName??remoteSnapshot?.deviceName??"Remote device",deleter=l?remoteSnapshot?.deviceName??"Remote device":settings.deviceName;await this.prepareStreamedVersion(path,survivor,l?"local":"remote",path.toLowerCase().endsWith(".md")?this.deletionWarning("",editor,deleter):"",final);}
        else if(l)await this.preserveDeletion(path,await this.localBytes(path,l,bytes),settings.deviceName,remoteSnapshot?.deviceName??"Remote device",final,bytes);
        else if(r)await this.preserveDeletion(path,await this.remoteBytes(r,remoteCache),r.revision?.deviceName??remoteSnapshot?.deviceName??"Remote device",settings.deviceName,final,bytes);
        continue;
      }
      if(l&&r&&Math.max(b?.size??0,l.size,r.size)>=LOW_MEMORY_DOWNLOAD_BYTES){conflicts++;await this.preserveLargePair(path,l,r,settings.deviceName,r.revision?.deviceName??remoteSnapshot?.deviceName??"Remote device",this.preferredSide(path,l,effectiveBaseSnapshot,remoteSnapshot,r),final,occupied);this.status({phase:"merging",message:`Large concurrent versions · ${path} · both complete files preserved without loading them into memory`,level:"warning"});continue;}
      if (l && r && this.text(path)) {
        if(!b){
          const preferred=this.preferredSide(path,l,effectiveBaseSnapshot,remoteSnapshot,r);conflicts++;await this.preservePair(path,l,await this.localBytes(path,l,bytes),r,settings.deviceName,r.revision?.deviceName??remoteSnapshot?.deviceName??"Remote device",preferred,final,bytes,remoteCache,occupied);continue;
        }
        const baseText = b ? decoder.decode(await this.remoteBytes(b, remoteCache)) : "";
        const localText = decoder.decode(await this.localBytes(path,l,bytes)); const remoteText = decoder.decode(await this.remoteBytes(r, remoteCache));
        const preferred=this.preferredSide(path,l,effectiveBaseSnapshot,remoteSnapshot,r);
        this.status({phase:"merging",message:`Three-way merge · ${path} · base ${b?.size??0} B · local ${l.size} B · remote ${r.size} B`});
        await this.cooperate(true);
        const merged = mergeText(baseText, localText, remoteText, preferred);
        await this.cooperate(true);
        if(merged.kind==="large-conflict"||merged.kind==="merge-fallback"){
          const reason=merged.kind==="merge-fallback"?merged.reason??"merge engine fallback":`${merged.overlapWords} overlapping words across ${merged.overlapLines} lines`;
          console.warn("Gib Sync preserved both versions after merge fallback",{path,reason,baseBytes:b?.size??0,localBytes:l.size,remoteBytes:r.size});
          this.status({phase:"merging",message:`Preserving both · ${path} · ${reason}`,level:"warning"});
          conflicts++;await this.preservePair(path,l,await this.localBytes(path,l,bytes),r,settings.deviceName,r.revision?.deviceName??remoteSnapshot?.deviceName??"Remote device",preferred,final,bytes,remoteCache,occupied);continue;
        }
        this.status({phase:"merging",message:merged.kind==="small-overlap"?`Resolved small overlap · ${path} · preferred ${preferred} version`:`Merged non-overlapping edits · ${path}`,level:"success"});
        const mergedBytes = encoder.encode(merged.text);await this.prepareResult(path,mergedBytes,final,bytes);
        continue;
      }
      // A binary conflict never destroys either side; the newest stays at the intended path.
      conflicts++;
      if(l&&r)await this.preservePair(path,l,await this.localBytes(path,l,bytes),r,settings.deviceName,r.revision?.deviceName??remoteSnapshot?.deviceName??"Remote device",this.preferredSide(path,l,effectiveBaseSnapshot,remoteSnapshot,r),final,bytes,remoteCache,occupied);
    }

    if(settings.syncPlugins){
      const enablementPath=this.enablementPath,entry=final.get(enablementPath);
      if(entry){
        try{
          const localEntry=local.get(enablementPath),clear=bytes.get(entry.hash)??(localEntry?.hash===entry.hash?await this.localBytes(enablementPath,localEntry,bytes):await this.remoteBytes(entry,remoteCache));
          const enabled=JSON.parse(decoder.decode(clear)) as unknown;
          if(Array.isArray(enabled)){
            const valid=enabled.filter((id):id is string=>typeof id==="string"&&(id==="gib-sync"||(final.has(this.pluginFile(id,"manifest.json"))&&final.has(this.pluginFile(id,"main.js")))));
            const missing=enabled.filter((id)=>typeof id==="string"&&!valid.includes(id));
            if(missing.length){const sanitized=encoder.encode(`${JSON.stringify(valid,null,2)}\n`);await this.prepareResult(enablementPath,sanitized,final,bytes);resolved++;
              this.status({phase:"merging",message:`Plugin enablement repaired · skipped ${missing.length} incomplete package${missing.length===1?"":"s"}: ${missing.slice(0,5).join(", ")}${missing.length>5?"…":""}`,level:"warning"});}
          }
        }catch{this.status({phase:"merging",message:"Plugin enablement list is non-standard JSON · kept the newer complete file",level:"warning"});}
      }
    }

    // An ignored path is device-local: keep its accepted remote manifest entry
    // even though this device neither reads nor writes the file. This is
    // essential when phones intentionally omit desktop-only plugins.
    const preservedIgnored=(remoteSnapshot?.entries??[]).filter((entry)=>!this.include(entry.path)&&!isDeviceLocalObsidianPath(entry.path,settings.configDir));
    const entries = [...final.values(),...preservedIgnored].map(entry=>this.manifestEntry(entry)).sort((a,b)=>a.path.localeCompare(b.path));
    const remoteEntries = [...(remoteSnapshot?.entries??[])].map(({path,hash,size,mtime}) => ({path,hash,size,mtime})).sort((a,b)=>a.path.localeCompare(b.path));
    const baseFolders=this.manifestFolders(effectiveBaseSnapshot),remoteFolders=this.manifestFolders(remoteSnapshot),mergedFolders=this.mergeFolders(baseFolders,scanned.folders,remoteFolders);
    if(remoteSnapshot?.folderRepair){
      for(const raw of remoteSnapshot.folderRepair.retiredFolders){const path=normalizePath(raw);if(!await this.hasProtectedFolderIntent(path,remoteSnapshot.folderRepair,remoteSnapshot.createdAt))mergedFolders.delete(path);}
    }
    for(const folder of remoteSnapshot?.folders??[])if(!this.include(folder)&&!isDeviceLocalObsidianPath(folder,settings.configDir))mergedFolders.add(normalizePath(folder));
    const folders=[...mergedFolders].sort(),acceptedRemoteFolders=this.manifestFolders(remoteSnapshot);
    for(const folder of remoteSnapshot?.folders??[])if(!this.include(folder)&&!isDeviceLocalObsidianPath(folder,settings.configDir))acceptedRemoteFolders.add(normalizePath(folder));
    const remoteFolderList=[...acceptedRemoteFolders].sort();
    const clientCanMirrorAll=!preservedIgnored.length;
    const remoteHashes=new Set(remoteEntries.map((entry)=>entry.hash)),remotePathHashes=new Map(remoteEntries.map((entry)=>[entry.path,entry.hash])),entryPaths=new Set(entries.map((entry)=>entry.path));
    const unchanged = entries.length === remoteEntries.length && entries.every((entry, i) => entry.path === remoteEntries[i].path && entry.hash === remoteEntries[i].hash)
      && folders.length===remoteFolderList.length&&folders.every((folder,index)=>folder===remoteFolderList[index]);
    if (unchanged) {
      const topologyFolders=new Set([...folders,...this.acceptedFolders(entries.map((entry)=>entry.path))]);let downloaded=0,deleted=0;if(remoteSnapshot){const applied=await this.stageAndApply(remoteSnapshot.id,final,topologyFolders,physicalLocal,desktopOnlyPlugins,scanned,orphanUnreadableConflicts,bytes,remoteCache,remoteSnapshot.folderRepair,remoteSnapshot.createdAt);downloaded=applied.downloaded;deleted=applied.deleted;prunedFolders+=applied.prunedFolders;}else{const topology=await this.reconcileFolderTopology(topologyFolders);prunedFolders+=topology.removed;settings.lastSnapshotId=null;settings.initialized=true;if(settings.syncPlugins)settings.pluginSyncBootstrapPending=false;await this.saveSettings();}let mirrored=0;
      try{mirrored=remoteSnapshot&&clientCanMirrorAll?await this.mirror(remoteSnapshot.id,entries,final,bytes,remoteCache):0;}
      catch(error){if(this.retryableMirrorError(error))return this.convergeAfterConflict(attempt,"Another device advanced the vault during mirror verification");throw error;}
      this.status({phase:"up-to-date",message:"Up to date · this device matches the accepted snapshot"});
      if(fullScan&&!settings.retiredFolderCount){settings.fullScanRequired=false;settings.lastFullScanAt=new Date().toISOString();await this.saveSettings();}
      this.acknowledgeMoves(consumedMoves,entries);await this.saveSettings();
      return { uploaded: 0, downloaded, deleted, prunedFolders,pendingRetiredFolders:settings.retiredFolderCount, conflicts, resolved, mirrored, snapshotId: settings.lastSnapshotId,processedPaths:pendingPaths,fullScan };
    }

    if(!settings.initialized&&remoteSnapshot){
      this.status({phase:"committing",message:onboardingReconcile?"Verifying the matched server baseline before publishing the union":"Verifying the first download before cleaning device-local workspace state"});
      try{this.checkpoint();await this.api.markDeviceReady(remoteSnapshot.id);this.checkpoint();}
      catch(error){if(error instanceof ApiError&&error.status===409)return this.convergeAfterConflict(attempt,"The server vault changed during onboarding verification");throw error;}
    }

    const applyPaths=new Set([...entries.filter(entry=>physicalLocal.get(entry.path)?.hash!==entry.hash).map(entry=>entry.path),...[...physicalLocal.keys()].filter(path=>!entryPaths.has(path))]);
    const priorEntries=Object.fromEntries([...applyPaths].flatMap(path=>{const entry=physicalLocal.get(path);return entry?[[path,this.manifestEntry(entry)]]:[]}));
    const proposalHashes=new Set(entries.map(entry=>entry.hash)),replayUploads=[...new Map(Object.values(priorEntries).filter(entry=>!remoteHashes.has(entry.hash)&&!proposalHashes.has(entry.hash)).map(entry=>[entry.hash,entry])).values()];
    const uploadTotal=entries.filter(entry=>!remoteHashes.has(entry.hash)).length+replayUploads.length;
    this.status({phase:uploadTotal?"uploading":"checking",message:uploadTotal?"Uploading changed files":"Verifying the planned snapshot",current:uploadTotal?0:undefined,total:uploadTotal||undefined}); let uploaded = 0;
    for (const entry of entries) {
      await this.cooperate();
      if(remoteHashes.has(entry.hash))continue;
      const localEntry=local.get(entry.path),prepared=final.get(entry.path),source=prepared?.sourcePath?prepared:localEntry?.hash===entry.hash?localEntry:undefined;if(!source)throw new Error(`Unable to prepare changed file ${entry.path}`);
      await this.uploadLocalFile(source,bytes);uploaded++;
      if(this.progress(uploaded,uploadTotal))this.status({phase:"uploading",message:`Uploaded ${uploaded} encrypted file${uploaded===1?"":"s"}`,current:uploaded,total:uploadTotal});
    }
    // A merged result may differ from the editor's pre-download file. Keep that
    // encrypted replay base so edits made mid-download can merge, not overwrite
    // the already accepted remote additions after application resumes.
    for(const entry of replayUploads){await this.cooperate();await this.uploadLocalFile(entry,bytes);uploaded++;}
    this.status({phase:"committing",message:"Committing an atomic snapshot"});
    let snapshot:Snapshot;
    const highEntropyPaths:string[]=[];
    for(const entry of entries){
      if(!this.text(entry.path)||remotePathHashes.get(entry.path)===entry.hash)continue;
      const clear=bytes.get(entry.hash);if(clear&&await this.entropy(clear)>7.2)highEntropyPaths.push(entry.path);
    }
    const deviceLocalCleanupPaths=remoteEntries.filter((entry)=>isDeviceLocalObsidianPath(entry.path,settings.configDir)&&!entryPaths.has(entry.path)).slice(0,5000).map((entry)=>entry.path);
    // Write-ahead receipt survives a lost HTTP response, app suspension, or a
    // later settings-save failure. Save must finish before the server request.
    settings.pendingCommit={parentId:remoteSnapshot?.id??null,fingerprint:await commitFingerprint(entries,folders),priorHashes:Object.fromEntries([...applyPaths].map(path=>[path,physicalLocal.get(path)?.hash??null])),priorEntries};
    await this.saveSettings();this.checkpoint();
    try{snapshot=await this.api.commit({ parentId: remoteSnapshot?.id ?? null, message: conflicts ? `Sync with ${conflicts} preserved conflict${conflicts === 1 ? "" : "s"}` : "Sync", entries,folders,
      clientTime:new Date().toISOString(),signals:{highEntropyPaths,deviceLocalCleanupPaths,vaultIdentity:settings.vaultIdentity,staleBaseline:Boolean(baseSnapshot&&remoteSnapshot&&baseSnapshot.id!==remoteSnapshot.id)} });}
    catch(error){if(error instanceof ApiError&&error.status>=400&&error.status<500&&error.status!==408){settings.pendingCommit=null;await this.saveSettings();}if(error instanceof ApiError&&error.status===409)return this.convergeAfterConflict(attempt,"Another device committed at the same time");throw error;}
    this.checkpoint();
    const topologyFolders=new Set([...folders,...this.acceptedFolders(entries.map((entry)=>entry.path))]),applied=await this.stageAndApply(snapshot.id,final,topologyFolders,physicalLocal,desktopOnlyPlugins,scanned,orphanUnreadableConflicts,bytes,remoteCache,snapshot.folderRepair,snapshot.createdAt),downloaded=applied.downloaded,deleted=applied.deleted;prunedFolders+=applied.prunedFolders;let mirrored:number;
    try{mirrored=clientCanMirrorAll?await this.mirror(snapshot.id,entries,final,bytes,remoteCache):0;}
    catch(error){if(this.retryableMirrorError(error))return this.convergeAfterConflict(attempt,"The commit succeeded and another device advanced the vault during mirroring");throw error;}
    this.status({phase:"complete",message:conflicts ? `Synced · ${conflicts} conflict${conflicts === 1 ? "" : "s"} preserved` : "Sync complete · this device matches the accepted snapshot"});
    if(fullScan&&!settings.retiredFolderCount){settings.fullScanRequired=false;settings.lastFullScanAt=new Date().toISOString();await this.saveSettings();}
    this.acknowledgeMoves(consumedMoves,entries);await this.saveSettings();
    return { uploaded, downloaded, deleted, prunedFolders,pendingRetiredFolders:settings.retiredFolderCount, conflicts, resolved, mirrored, snapshotId: settings.lastSnapshotId,processedPaths:pendingPaths,fullScan };
  }
}
