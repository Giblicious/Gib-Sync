import { normalizePath, type DataAdapter } from "obsidian";
import { detectMoves,planReconciliationCooperative,selectPluginPackage,MAX_SETTINGS_JSON_BYTES,type ManifestEntry,type Snapshot,type SyncTree,type SyncOperation,type OperationBatch,type OperationReceipt } from "@gib-sync/protocol";
import { ApiError, GibSyncApi } from "./api";
import { decryptBlob, encryptBlob, hashBytes } from "./crypto";
import { mergeText } from "./merge";
import { canonicalConfigPath, isDeviceLocalObsidianPath, isDeviceLocalPlugin, isGibSyncConflictPath, isObsidianSystemPath, isPluginDataPath, obsidianPluginPath, shouldSyncChangedPath, type ApplyOperation, type GibSyncSettings, type SyncPhase } from "./settings";
import { mergeCommunityPluginEnablement, mergeSystemJson } from "./system-merge";
import { BodyCache } from "./body-cache";
import { AdapterFileChangedError, hashAdapterFile,streamAdapterFile,copyVerifiedAdapterFile } from "./file-io";
import {uploadAdapterFile} from "./outbound-stream";
import {sha256} from "@noble/hashes/sha2.js";
import {bytesToHex} from "@noble/hashes/utils.js";
import {conflictCopyPath} from '@gib-sync/protocol';
import {VaultInventory} from "./vault-inventory";
import {IntentJournal,indexedIntentCreates,type IntentKind,type VaultIntent} from "./intent-journal";
import {OperationJournal,type PreparedBatch} from "./operation-journal";
import {buildOperationBatch} from "./operation-plan";
import {AtomicPackageInstaller} from "./atomic-package";
import {ConflictStore} from "./conflict-store";
import type {ConflictChoice,ConflictInboxItem,ConflictInboxPreview} from "./conflict-inbox";
import {observeLocalFolders,reconcileAndAlignFolders,type FolderFileCollision} from "./folder-reconciliation";
import {PackageRuntimeHoldError,type PackageRuntime} from "./plugin-runtime";
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

export interface SyncResult { uploaded: number; downloaded: number; deleted: number; prunedFolders:number; pendingRetiredFolders:number; conflicts: number; resolved:number; mirrored:number; snapshotId: string | null; processedPaths:string[]; fullScan:boolean; pendingPackages?:string[]; }
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
  private readonly inventory:VaultInventory;
  private readonly intents:IntentJournal;
  private readonly operations:OperationJournal;
  private readonly packages:AtomicPackageInstaller;
  private readonly conflictStore:ConflictStore;
  private backgroundInventory:Promise<{changedPaths:string[];pending:number;checked:number}>|null=null;
  private lastInventoryListingAt=0;
  private observedInventoryFolders:Set<string>|null=null;
  private configAliases:string[]=[];
  private canonicalNamespace=false;
  private readonly pendingRuntimeActivation=new Map<string,string|null>();
  private readonly pendingRuntimeFingerprints=new Map<string,string>();
  private firstRun=true;
  private readonly bootstrapRetainedPluginIds=new Set<string>();
  private readonly workBatch=typeof navigator!=="undefined"&&/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)?MOBILE_WORK_BATCH:DESKTOP_WORK_BATCH;
  constructor(
    private readonly adapter: DataAdapter,
    private readonly api: GibSyncApi,
    private readonly getSettings: () => GibSyncSettings,
    private readonly saveSettings: () => Promise<void>,
    private readonly status: (progress: SyncProgress) => void,
    private readonly wait: (milliseconds:number) => Promise<void> = (milliseconds) => new Promise((resolve)=>window.setTimeout(resolve,milliseconds)),
    private readonly observeExpectedMutation:(path:string,hash:string|null)=>void=()=>{},
    private readonly yieldControl:()=>Promise<void>=cooperativeYield,
    private readonly isMobileDevice=false,
    private readonly canApplyLocalMutation:(path:string)=>boolean=()=>true,
    private readonly shouldContinue:()=>boolean=()=>true,
    private readonly packageRuntime?:PackageRuntime
  ) {
    const scope=()=>JSON.stringify([this.getSettings().vaultId,this.getSettings().deviceId,this.getSettings().vaultIdentity,this.getSettings().configDir,this.getSettings().syncBookmarks,this.getSettings().syncObsidianConfig,this.getSettings().syncPlugins,this.getSettings().exclusions]);
    this.inventory=new VaultInventory(this.adapter,scope,this.yieldControl,size=>size<LOW_MEMORY_DOWNLOAD_BYTES||typeof this.api.supportsStreamUpload!=="function"||!this.api.supportsStreamUpload(),()=>this.checkpoint());
    const journalScope=()=>JSON.stringify([this.getSettings().vaultId,this.getSettings().deviceId]);this.intents=new IntentJournal(this.adapter,journalScope,this.yieldControl);this.operations=new OperationJournal(this.adapter,journalScope);
    this.packages=new AtomicPackageInstaller(this.adapter,journalScope,()=>this.checkpoint(),()=>this.cooperate(),path=>this.savedHash(path),(path,hash)=>this.expectLocalMutation(path,hash),root=>this.packageRuntime?.quiesce(root.split("/").at(-1)!)??Promise.resolve());
    this.conflictStore=new ConflictStore(this.adapter,journalScope);
  }
  get verificationPending():number{return this.inventory.pendingVerification;}
  private expectLocalMutation(path:string,hash:string|null):void{this.inventory.markDirty(path);this.observeExpectedMutation(path,hash);}
  setConfigAliases(aliases:readonly string[]):void{this.canonicalNamespace=true;this.configAliases=[...new Set(aliases)].filter(alias=>alias&&alias!==".obsidian").sort((a,b)=>b.length-a.length);}
  private get logicalConfigDir():string{return this.canonicalNamespace?".obsidian":this.getSettings().configDir;}
  private canonicalSnapshot(snapshot:Snapshot|null):Snapshot|null{
    if(!snapshot||!this.configAliases.length)return snapshot;const path=(value:string)=>{for(const alias of this.configAliases)if(value===alias||value.startsWith(`${alias}/`))return `.obsidian${value.slice(alias.length)}`;return value;};
    const entries=new Map<string,ManifestEntry>();for(const entry of [...snapshot.entries].sort((a,b)=>Number(a.path===path(a.path))-Number(b.path===path(b.path)))){const normalized=path(entry.path),mapped={...entry,path:this.include(normalized)?normalized:entry.path},prior=entries.get(mapped.path);if(!prior||entry.path===mapped.path)entries.set(mapped.path,mapped);}
    const folderEntries=new Map<string,NonNullable<Snapshot["folderEntries"]>[number]>();for(const entry of [...snapshot.folderEntries??[]].sort((a,b)=>Number(a.path===path(a.path))-Number(b.path===path(b.path)))){const mapped={...entry,path:path(entry.path)};if(!folderEntries.has(mapped.path)||entry.path===mapped.path)folderEntries.set(mapped.path,mapped);}
    return {...snapshot,entries:[...entries.values()],folders:snapshot.folders?[...new Set(snapshot.folders.map(path))]:undefined,folderEntries:[...folderEntries.values()],...(snapshot.folderRepair?{folderRepair:{...snapshot.folderRepair,retiredFolders:snapshot.folderRepair.retiredFolders.map(path).filter(value=>value!==".obsidian"&&!value.startsWith(".obsidian/"))}}:{})};
  }
  stop():void{this.cancel();this.inventory.stop();}
  async recordIntent(kind:IntentKind,path:string,entity:"file"|"folder"="file",from?:string):Promise<void>{this.inventory.markDirty(path);if(from)this.inventory.markMove(from,path);await this.intents.record(kind,path,entity,from);}
  verifyInventory():Promise<{changedPaths:string[];pending:number;checked:number}>{
    if(this.backgroundInventory)return this.backgroundInventory;
    const requestedGeneration=this.generation;
    this.backgroundInventory=this.operationTail.catch(()=>{}).then(async()=>{
      this.activeGeneration=requestedGeneration;this.checkpoint();await this.inventory.ready();const changed=new Set<string>();
      if(!this.lastInventoryListingAt||Date.now()-this.lastInventoryListingAt>=5*60*1000){
        const folders=new Set<string>(),paths=await this.listFiles("",folders),priorPaths=new Set(this.inventory.paths());
        for(const folder of this.acceptedFolders(paths))folders.delete(folder);
        for(const path of paths){await this.cooperate();const before=this.inventory.known(path),after=await this.inspectLocalFile(path);if(after&&before?.hash!==after.hash)changed.add(path);priorPaths.delete(path);}for(const path of priorPaths)changed.add(path);
        if(this.observedInventoryFolders&&(folders.size!==this.observedInventoryFolders.size||[...folders].some(path=>!this.observedInventoryFolders!.has(path))))this.getSettings().fullScanRequired=true;
        this.observedInventoryFolders=folders;await this.inventory.finishListing(paths);this.lastInventoryListingAt=Date.now();
      }
      const result=await this.inventory.verifyStep();for(const path of result.changedPaths)changed.add(path);return {...result,changedPaths:[...changed]};
    }).finally(()=>{this.backgroundInventory=null;});this.operationTail=this.backgroundInventory;return this.backgroundInventory;
  }

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
    if(this.backgroundInventory)this.generation++;
    const requestedGeneration=this.generation;
    this.running = this.operationTail.catch(()=>undefined).then(()=>{this.activeGeneration=requestedGeneration;this.checkpoint();return this.run(0);}).finally(async() => {try{await this.packageRuntime?.finish();await this.cleanPreparedResults();}finally{this.running = null;} });
    this.operationTail=this.running;return this.running;
  }

  restoreAcceptedSnapshot():Promise<{downloaded:number;deleted:number;prunedFolders:number}>{
    if(this.backgroundInventory)this.generation++;
    const requestedGeneration=this.generation;
    const restoring=this.operationTail.catch(()=>undefined).then(()=>{this.activeGeneration=requestedGeneration;this.checkpoint();return this.restore();}).finally(()=>this.packageRuntime?.finish());this.operationTail=restoring;return restoring;
  }
  private ownedOperation<T>(operation:()=>Promise<T>):Promise<T>{if(this.backgroundInventory)this.generation++;const requested=this.generation,task=this.operationTail.catch(()=>{}).then(()=>{this.activeGeneration=requested;this.checkpoint();return operation();}).finally(()=>this.packageRuntime?.finish());this.operationTail=task;return task;}
  private async activatePackages():Promise<void>{for(const [id,hash]of this.pendingRuntimeActivation){this.checkpoint();try{await this.packageRuntime?.activate(id,hash);delete this.getSettings().packageHolds[id];this.pendingRuntimeActivation.delete(id);this.pendingRuntimeFingerprints.delete(id);}catch(error){if(!(error instanceof PackageRuntimeHoldError))throw error;const previous=this.getSettings().packageHolds[id],attempts=(previous?.attempts??0)+1;this.getSettings().packageHolds[id]={...previous,fingerprint:this.pendingRuntimeFingerprints.get(id)??previous?.fingerprint,kind:"activation",reason:error.message,at:Date.now(),attempts,retryAt:Date.now()+Math.min(300000,10000*2**Math.min(attempts-1,5))};this.pendingRuntimeActivation.delete(id);this.pendingRuntimeFingerprints.delete(id);this.status({phase:"applying",message:error.message,level:"warning"});}}}
  private async packageFingerprint(entries:readonly FileState[]):Promise<string>{return hashBytes(encoder.encode(JSON.stringify(entries.map(entry=>[entry.path,entry.hash,entry.size]).sort(([a],[b])=>String(a).localeCompare(String(b))))));}
  private async queuePackageActivation(id:string,hash:string|null,entries:readonly FileState[]):Promise<void>{this.pendingRuntimeActivation.set(id,hash);this.pendingRuntimeFingerprints.set(id,await this.packageFingerprint(entries));}
  private async holdPackage(id:string,reason:string,kind:"incomplete"|"activation",desired:readonly FileState[],observed:readonly FileState[]):Promise<void>{
    const settings=this.getSettings(),previous=settings.packageHolds[id],fingerprint=await this.packageFingerprint(desired),same=previous?.fingerprint===fingerprint,attempts=same?(previous?.attempts??0)+1:1,priorEntries=previous?.priorEntries??{};
    for(const entry of observed){if(priorEntries[entry.path])continue;const sourcePath=`.gib-sync/package-hold-originals/${crypto.randomUUID()}.bin`;await this.ensureParent(sourcePath);await this.copyProtectedOriginal(entry,sourcePath);priorEntries[entry.path]={...this.manifestEntry(entry),sourcePath};}
    settings.packageHolds[id]={reason,kind,at:Date.now(),attempts,retryAt:Date.now()+(kind==="incomplete"?300000:Math.min(300000,10000*2**Math.min(attempts-1,5))),fingerprint,priorEntries};
  }
  async listConflictInbox():Promise<ConflictInboxItem[]>{
    const local=await this.conflictStore.list(),byId=new Map(local.map(item=>[item.id,item]));
    if(typeof this.api.conflictInbox==="function")try{for(const item of await this.api.conflictInbox()){const prior=byId.get(item.id);byId.set(item.id,{...item,versions:item.versions.map(side=>({...side,...prior?.versions.find(saved=>saved.id===side.id)?.sourcePath?{sourcePath:prior!.versions.find(saved=>saved.id===side.id)!.sourcePath}:{}}))});}}catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;}
    return [...byId.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  async previewConflict(id:string):Promise<ConflictInboxPreview>{const item=(await this.listConflictInbox()).find(item=>item.id===id);if(!item)throw new SyncSafetyError("This recorded conflict is no longer available");const texts:ConflictInboxPreview["texts"]=[];for(const side of item.versions){if(side.hash===null||side.deleted||side.size>128*1024||!this.text(item.path)){texts.push({id:side.id,text:null,truncated:side.size>128*1024});continue;}const clear=side.sourcePath&&await this.adapter.exists(side.sourcePath)?new Uint8Array(await this.adapter.readBinary(side.sourcePath)):await this.remoteBytes({path:side.path,hash:side.hash,size:side.size,mtime:0},this.bodyCache());if(await hashBytes(clear)!==side.hash)throw new SyncSafetyError("A preserved original did not verify; it was not used for preview or resolution");texts.push({id:side.id,text:decoder.decode(clear),truncated:false});}return {item,texts};}
  packageRecoveryOriginals(){return this.packages.originals();}
  resolveConflict(id:string,choice:ConflictChoice,combinedText?:string):Promise<void>{return this.ownedOperation(async()=>{
    await this.recoverPendingBatch();const item=(await this.listConflictInbox()).find(item=>item.id===id);if(!item||item.state!=="open"||!item.originSnapshotId)throw new SyncSafetyError("This conflict is not ready for a new decision");if(!this.api.supportsOperationsV2())throw new SyncSafetyError("The server must support safe operation decisions before this conflict can be resolved");
    const tree=await this.api.syncTree(),origin=this.canonicalSnapshot(await this.api.snapshot(item.originSnapshotId)),byPath=new Map(tree.files.map(entry=>[entry.path,entry])),originPaths=new Map(origin!.entries.map(entry=>[entry.path,entry])),paths=[...new Set(item.versions.map(side=>side.annotatedPath??side.path))];
    for(const path of paths){const current=byPath.get(path),atConflict=originPaths.get(path),expected=item.versions.find(side=>(side.annotatedPath??side.path)===path)?.annotatedHash;if(!current||current.hash!==expected||!current.revision||!atConflict?.revision||current.fileId!==atConflict.fileId||current.revision.id!==atConflict.revision.id)throw new SyncSafetyError("A newer edit exists in this conflict. Your files were not overwritten; review the newest version first");}
    const final=new Map<string,FileState>(tree.files.map(entry=>[entry.path,{...entry}])),before=paths.map(path=>({path,hash:byPath.get(path)?.hash??null})),cache=this.bodyCache();
    if(choice==="both"&&paths.length===1&&!item.versions.some(side=>side.deleted)){/* Deep settings retain one canonical active file, plus both private originals. */}
    else if(choice==="both"){for(const side of item.versions){if(side.hash===null||side.deleted)continue;const path=side.annotatedPath??side.path,current=byPath.get(path)!;final.set(path,{...current,hash:side.hash,size:side.size,mtime:Date.now(),...side.sourcePath?{sourcePath:side.sourcePath}:{}});}}
    else{for(const path of paths)final.delete(path);const current=byPath.get(item.path);if(choice==="combine"){if(item.versions.some(side=>side.deleted)||typeof combinedText!=="string"||encoder.encode(combinedText).length>1024*1024)throw new SyncSafetyError("A combined decision requires two text originals and a result under 1 MB");await this.prepareResult(item.path,encoder.encode(combinedText),final,cache);const entry=final.get(item.path)!;entry.fileId=current?.fileId;entry.revision=current?.revision;}else{const side=item.versions[choice==="this"?0:1];if(!side)throw new SyncSafetyError("The selected original is unavailable");if(side.hash!==null&&!side.deleted)final.set(item.path,{...current,path:item.path,hash:side.hash,size:side.size,mtime:Date.now(),...side.sourcePath?{sourcePath:side.sourcePath}:{}});}}
    const after=paths.map(path=>({path,hash:final.get(path)?.hash??null}));await this.commitDecision(tree,final,{id,kind:"resolve",choice,before,after},cache);
  });}
  undoConflict(id:string):Promise<void>{return this.ownedOperation(async()=>{
    await this.recoverPendingBatch();const item=(await this.listConflictInbox()).find(item=>item.id===id),resolution=item?.resolution;if(!item||item.state!=="resolved"||!resolution?.undoable||!resolution.before||!resolution.after||!resolution.afterIdentity||!item.originSnapshotId)throw new SyncSafetyError("This decision cannot be undone automatically after newer edits; preserved originals remain available");
    const tree=await this.api.syncTree();for(const guard of resolution.afterIdentity){const entity=guard.deleted?tree.tombstones.find(entry=>entry.targetId===guard.targetId):tree.files.find(entry=>entry.fileId===guard.targetId);if(!entity||entity.path!==guard.path||entity.revision?.id!==guard.revisionId)throw new SyncSafetyError("A newer causal revision prevents undo. No content was overwritten");}
    const origin=this.canonicalSnapshot(await this.api.snapshot(item.originSnapshotId))!,final=new Map<string,FileState>(tree.files.map(entry=>[entry.path,{...entry}])),intents:VaultIntent[]=[];
    for(const before of resolution.before){if(before.hash===null){final.delete(before.path);continue;}const original=origin.entries.find(entry=>entry.path===before.path&&entry.hash===before.hash);if(!original)throw new SyncSafetyError("The exact undo original is unavailable; current files were retained");const current=tree.files.find(entry=>entry.path===before.path);final.set(before.path,{...original,...current?{fileId:current.fileId,revision:current.revision}:{fileId:crypto.randomUUID()},mtime:Date.now()});if(!current)intents.push({id:crypto.randomUUID(),sequence:0,kind:"create",entity:"file",path:before.path,at:Date.now(),targetId:final.get(before.path)!.fileId});}
    await this.commitDecision(tree,final,{id,kind:"undo",resolutionId:resolution.id,before:resolution.after,after:resolution.before},this.bodyCache(),intents);
  });}
  restoreLocalRecovery(sourcePath:string):Promise<void>{return this.ownedOperation(async()=>{
    await this.recoverPendingBatch();let path:string|null=null;
    if(sourcePath.startsWith(".gib-sync/local-recovery/"))path=sourcePath.split("/").slice(3).join("/");else{const packageOriginal=(await this.packages.originals()).find(item=>sourcePath.startsWith(`${item.path}/`));if(packageOriginal)path=`${packageOriginal.packageRoot}${sourcePath.slice(packageOriginal.path.length)}`;}
    if(!path||!this.include(path))throw new SyncSafetyError("This protected copy belongs to an excluded or device-local path. The recovery original is unchanged");const stat=await this.adapter.stat(sourcePath);if(stat?.type!=="file")throw new SyncSafetyError("The recovery original is unavailable");const hash=await this.savedHash(sourcePath);if(!hash)throw new SyncSafetyError("The recovery original could not be verified");
    if(!this.api.supportsOperationsV2())throw new SyncSafetyError("Update the server to safely restore a protected original through the sync ledger");const tree=await this.api.syncTree(),current=tree.files.find(entry=>entry.path===path),final=new Map<string,FileState>(tree.files.map(entry=>[entry.path,{...entry}]));final.set(path,{...current,path,hash,size:stat.size,mtime:Date.now(),sourcePath});const intents:VaultIntent[]=current?[]:[{id:crypto.randomUUID(),sequence:0,kind:"create",entity:"file",path,at:Date.now(),targetId:crypto.randomUUID()}];await this.commitDecision(tree,final,undefined,this.bodyCache(),intents);
  });}
  private async recordDecision(record:PreparedBatch):Promise<void>{const action=record.conflictAction;if(!action||!record.receipt)return;if(action.kind==="resolve")await this.api.recordConflictResolution(action.id,record.batch.batchId,action.choice!,action.after,action.before);else await this.api.recordConflictUndo(action.id,record.batch.batchId,action.resolutionId!);const saved=(await this.listConflictInbox()).find(item=>item.id===action.id);if(saved)await this.conflictStore.save(saved);}
  private async commitDecision(tree:SyncTree,final:Map<string,FileState>,conflictAction:PreparedBatch["conflictAction"],bytes:Map<string,Uint8Array>,extraIntents:VaultIntent[]=[]):Promise<void>{
    const scanned=await this.scan(),physical=scanned.files,changed=new Set([...new Set([...final.keys(),...physical.keys()])].filter(path=>this.include(path)&&final.get(path)?.hash!==physical.get(path)?.hash));
    for(const path of changed){const accepted=tree.files.find(entry=>entry.path===path);if(await this.savedHash(path)!==(accepted?.hash??null)||!this.canApplyLocalMutation(path))throw new FileChangedDuringReadError(path);}
    const intents=await this.intents.snapshot(),entries=[...final.values()].map(entry=>this.manifestEntry(entry)),batch=await buildOperationBatch(tree,entries,tree.folders.map(entry=>entry.path),[...intents,...extraIntents],conflictAction?"Resolve preserved conflict":"Restore protected original",undefined,undefined,undefined,()=>this.cooperate(true)),record:PreparedBatch={batch,phase:"prepared",intentSequence:0,priorHashes:Object.fromEntries([...changed].map(path=>[path,physical.get(path)?.hash??null])),priorEntries:Object.fromEntries([...changed].flatMap(path=>{const entry=physical.get(path);return entry?[[path,this.manifestEntry(entry)]]:[]})),...(conflictAction?{conflictAction}:{})};
    await this.operations.save(record);this.checkpoint();const remoteHashes=new Set(tree.files.map(entry=>entry.hash));for(const entry of final.values())if(!remoteHashes.has(entry.hash)&&entry.sourcePath)await this.uploadLocalFile(entry,bytes);
    // Every chosen remote original is already immutable server content. Local
    // protected originals are uploaded above before the atomic operation batch.
    record.phase="submitted";await this.operations.save(record);this.checkpoint();record.receipt=await this.api.operationBatch(batch);this.assertOwnedReceipt(record.receipt,batch);if(record.receipt.batchId!==batch.batchId)throw new SyncSafetyError("A decision received the wrong operation receipt");record.phase="accepted";await this.operations.save(record);this.checkpoint();
    await this.stageAndApply(record.receipt.snapshot.id,final,this.snapshotFolders(record.receipt.snapshot),physical,new Set(),scanned,[],bytes,this.bodyCache(),record.receipt.snapshot.folderRepair,record.receipt.snapshot.createdAt);await this.recordDecision(record);await this.operations.clear();this.getSettings().fullScanRequired=true;await this.saveSettings();
  }

  private async restore():Promise<{downloaded:number;deleted:number;prunedFolders:number}>{
    const settings=this.getSettings();if(!settings.deviceToken||!settings.vaultKey)throw new Error("Gib Sync is not configured");
    const scanned=await this.scan(),local=scanned.files,head=(await this.api.state()).head;this.checkpoint();
    if(!head&&local.size)throw new SyncSafetyError("The server has no accepted snapshot to restore. Local files were left unchanged.");
    const canonicalHead=this.canonicalSnapshot(head),remote=this.map(canonicalHead);for(const path of scanned.unreadableConflictPaths){const accepted=remote.get(path);if(accepted)local.set(path,accepted);}
    if(!head)return {downloaded:0,deleted:0,prunedFolders:0};
    // Explicit repair replaces unknown interrupted copy output only after every
    // private original is archived. The unknown visible file is then backed up
    // as the fresh operation's original, never treated as an upload proposal.
    await this.archiveInterruptedApplyForRestore();
    const result=await this.stageAndApply(head.id,remote,this.snapshotFolders(canonicalHead),local,new Set(),scanned,[],this.bodyCache(),this.bodyCache(),canonicalHead?.folderRepair,head.createdAt);
    return {downloaded:result.downloaded,deleted:result.deleted,prunedFolders:result.prunedFolders};
  }

  private async archiveInterruptedApplyForRestore():Promise<void>{
    const settings=this.getSettings();if(!settings.pendingApplySnapshotId)return;
    const target=await this.optionalSnapshot(settings.pendingApplySnapshotId);if(!target)throw new SyncSafetyError("The interrupted copy's accepted snapshot is unavailable; its original, current and staged versions were retained.");
    const entries=new Map(target.entries.map(entry=>[entry.path,entry])),cache=this.bodyCache(),desktopOnly=new Set<string>();
    if(this.isMobileDevice)for(const entry of target.entries){const plugin=this.pluginPath(entry.path);if(plugin?.relative.toLowerCase()!=="manifest.json")continue;try{if(JSON.parse(decoder.decode(await this.remoteBytes(entry,cache))).isDesktopOnly===true)desktopOnly.add(plugin.id);}catch{}}
    for(const path of settings.pendingApplyPaths){if(!this.include(path))continue;await this.cooperate();const entry=entries.get(path),priorHash=settings.pendingApplyPriorHashes[path]??null,targetHash=entry?(path===this.enablementPath?(await this.deviceBytes(path,entry,cache,desktopOnly)).hash:entry.hash):null;await this.loadOperation(path,targetHash,priorHash);}
    await this.finishOperations(true);
  }

  private bodyCache():BodyCache{return new BodyCache(this.isMobileDevice?8*1024*1024:32*1024*1024);}
  private configPath(path:string):string{return canonicalConfigPath(path,this.logicalConfigDir);}
  private pluginPath(path:string){return obsidianPluginPath(path,this.logicalConfigDir);}
  private systemPath(path:string):boolean{return isObsidianSystemPath(path,this.logicalConfigDir);}
  private pluginDataPath(path:string):boolean{return isPluginDataPath(path,this.logicalConfigDir);}
  private heldPackagePath(path:string):boolean{const id=this.pluginPath(path)?.id;return Boolean(id&&this.getSettings().packageHolds[id]);}
  private pluginFile(id:string,name:string):string{return normalizePath(`${this.logicalConfigDir}/plugins/${id}/${name}`);}
  private get enablementPath():string{return normalizePath(`${this.logicalConfigDir}/community-plugins.json`);}

  private async entropy(bytes:Uint8Array):Promise<number>{
    if(bytes.length<1024)return 0;const counts=new Uint32Array(256);
    for(let start=0;start<bytes.length;start+=64*1024){for(const value of bytes.subarray(start,start+64*1024))counts[value]++;await this.cooperate();}
    let result=0;
    for(const count of counts)if(count){const probability=count/bytes.length;result-=probability*Math.log2(probability);}return result;
  }

  private include(path: string): boolean {
    let normalized=normalizePath(path);if(this.canonicalNamespace)for(const alias of this.configAliases)if(normalized===alias||normalized.startsWith(`${alias}/`)){normalized=`.obsidian${normalized.slice(alias.length)}`;break;}
    return shouldSyncChangedPath(normalized,this.getSettings());
  }

  private async disappeared(path:string):Promise<boolean>{
    try{if(!await this.adapter.exists(path))return true;}catch{}
    try{return !await this.adapter.stat(path);}catch{return false;}
  }

  private pluginSyncPath(path:string):boolean{
    const normalized=normalizePath(path);if(normalized===this.enablementPath)return true;
    const plugin=this.pluginPath(normalized);return Boolean(plugin&&this.sharedPlugin(plugin.id));
  }

  private sharedPlugin(id:string):boolean{return !isDeviceLocalPlugin(id)&&this.include(this.pluginFile(id,"manifest.json"))&&this.include(this.pluginFile(id,"main.js"));}
  private deviceLocalEnablementIds(...texts:string[]):Set<string>{const ids=new Set<string>();for(const text of texts)try{const value=JSON.parse(text) as unknown;if(Array.isArray(value))for(const id of value)if(typeof id==="string"&&!this.sharedPlugin(id))ids.add(id);}catch{/* The schema merge reports malformed input separately. */}return ids;}
  private async entryBytes(entry:FileState,physical:Map<string,FileState>,bytes:Map<string,Uint8Array>,remote:Map<string,Uint8Array>):Promise<Uint8Array>{
    const observed=physical.get(entry.path);
    return bytes.get(entry.hash)??(observed?.hash===entry.hash?this.localBytes(entry.path,observed,bytes):this.remoteBytes(entry,remote));
  }
  private async deviceEnablement(clear:Uint8Array,desktopOnly:Set<string>):Promise<Uint8Array>{
    let enabled:unknown;try{enabled=JSON.parse(decoder.decode(clear));}catch{return clear;}
    if(!Array.isArray(enabled)||enabled.some(id=>typeof id!=="string"))return clear;
    let local:string[]=[];const stat=await this.adapter.stat(this.enablementPath);
    if(stat?.type==="file"){
      if(stat.size>512*1024)throw new SyncSafetyError("Device plugin enablement exceeds its safe read budget; it was retained");
      const current=JSON.parse(decoder.decode(new Uint8Array(await this.adapter.readBinary(this.enablementPath)))) as unknown;
      if(!Array.isArray(current)||current.some(id=>typeof id!=="string"))throw new SyncSafetyError("Device plugin enablement is not a valid list; it was retained");
      local=current;
    }
    const projected=[...new Set([...enabled.filter(id=>this.sharedPlugin(id)&&(!this.isMobileDevice||!desktopOnly.has(id))),...local.filter(id=>!this.sharedPlugin(id)||this.bootstrapRetainedPluginIds.has(id))])];
    return projected.length===enabled.length&&projected.every((id,index)=>id===enabled[index])?clear:encoder.encode(`${JSON.stringify(projected,null,2)}\n`);
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
      let hash:string,stat;try{const observed=await this.inspectLocalFile(path,this.getSettings().pendingPaths.includes(path));if(!observed){current++;continue;}hash=observed.hash;stat={type:"file",size:observed.size,mtime:observed.mtime};}catch(error){
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
    await this.inventory.finishListing(paths);
    this.observedInventoryFolders=new Set(folders);this.lastInventoryListingAt=Date.now();
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
        const observed=await this.inspectLocalFile(path,true);if(!observed){output.delete(path);continue;}output.set(path,{path,hash:observed.hash,size:observed.size,mtime:observed.mtime});
      }catch(error){
        if(await this.disappeared(path)){output.delete(path);continue;}
        if(!isGibSyncConflictPath(path))throw error;output.delete(path);unreadableConflictPaths.add(path);
        this.status({phase:"scanning",message:`Isolated unreadable generated conflict copy · ${path} · accepted server version preserved`,level:"warning"});
      }
      if(this.progress(current,changedPaths.length))this.status({phase:"scanning",message:"Checking changed files",current,total:changedPaths.length});
    }
    // Shared enablement is intentionally projected differently on each device
    // (installer, excluded plugins and desktop-only toggles). Its server hash
    // is not physical inventory, even without an editor/config-change event.
    // Refresh this one small control file, not the entire vault.
    if(this.getSettings().syncPlugins&&this.include(this.enablementPath)&&!changedPaths.some(path=>normalizePath(path)===this.enablementPath)){
      const observed=await this.inspectLocalFile(this.enablementPath,true);
      if(observed)output.set(this.enablementPath,{...output.get(this.enablementPath),...observed});else output.delete(this.enablementPath);
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
    if(entry.sourcePath?.startsWith(".gib-sync/package-hold-originals/"))return this.localBytes(entry.path,entry,cache);
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
    return Boolean(top)&&!PROTECTED_FOLDER_ROOTS.has(lower)&&lower!==this.getSettings().configDir.split("/")[0].toLowerCase()&&!this.configAliases.some(alias=>alias.split("/")[0].toLowerCase()===lower)&&this.include(top);
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
    return conflictCopyPath(path,deviceName,mtime,occupied);
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
    await this.recordConflict(path,local,remote,localName,remoteName,preferred,copyPath,final,"Large concurrent versions");
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
    await this.recordConflict(path,local,remote,localName,remoteName,preferred,copyPath,final,"Concurrent versions preserved");
  }
  private async copyProtectedOriginal(entry:FileState,destination:string):Promise<void>{
    try{await copyVerifiedAdapterFile(this.adapter,entry.sourcePath??entry.path,destination,entry.hash,entry.size,()=>this.checkpoint(),()=>this.cooperate());}
    catch(error){if(error instanceof AdapterFileChangedError)throw new FileChangedDuringReadError(entry.path);throw error;}
  }
  private async recordConflict(path:string,local:FileState,remote:FileState,localName:string,remoteName:string,preferred:"local"|"remote",copyPath:string,final:Map<string,FileState>,reason:string):Promise<void>{
    const known=(await this.conflictStore.list()).find(item=>item.state==="open"&&!item.originSnapshotId&&item.path===path&&item.versions[0]?.hash===local.hash&&item.versions[1]?.hash===remote.hash),id=known?.id??crypto.randomUUID(),sourcePath=known?.versions[0]?.sourcePath??`.gib-sync/conflict-originals/${crypto.randomUUID()}.bin`;
    if(!await this.adapter.exists(sourcePath)){await this.ensureParent(sourcePath);await this.copyProtectedOriginal(local,sourcePath);}
    if(await this.savedHash(sourcePath)!==local.hash)throw new FileChangedDuringReadError(local.sourcePath??local.path);
    const localPath=preferred==="local"?path:copyPath,remotePath=preferred==="remote"?path:copyPath,settings=this.getSettings();
    await this.conflictStore.save({id,originSnapshotId:null,path,createdAt:known?.createdAt??new Date().toISOString(),reason,state:"open",versions:[{id:known?.versions[0]?.id??crypto.randomUUID(),label:localName.slice(0,100),path,hash:local.hash,size:local.size,deviceId:settings.deviceId,deviceName:localName,revisionId:local.revision?.id,sourcePath,annotatedPath:localPath,annotatedHash:final.get(localPath)!.hash},{id:known?.versions[1]?.id??crypto.randomUUID(),label:remoteName.slice(0,100),path,hash:remote.hash,size:remote.size,deviceId:remote.revision?.deviceId,deviceName:remoteName,revisionId:remote.revision?.id,annotatedPath:remotePath,annotatedHash:final.get(remotePath)!.hash}]});
  }
  private async recordDeletionConflict(path:string,survivor:FileState,localSurvived:boolean,remoteName:string,final:Map<string,FileState>):Promise<void>{
    const settings=this.getSettings(),annotatedHash=final.get(path)!.hash,sourcePath=localSurvived?`.gib-sync/conflict-originals/${crypto.randomUUID()}.bin`:undefined;
    if(sourcePath){await this.ensureParent(sourcePath);await this.copyProtectedOriginal(survivor,sourcePath);}
    const edited={id:crypto.randomUUID(),label:(localSurvived?settings.deviceName:remoteName).slice(0,100),path,hash:survivor.hash,size:survivor.size,deviceId:localSurvived?settings.deviceId:survivor.revision?.deviceId,deviceName:localSurvived?settings.deviceName:remoteName,revisionId:survivor.revision?.id,...sourcePath?{sourcePath}:{},annotatedPath:path,annotatedHash},deleted={id:crypto.randomUUID(),label:(localSurvived?remoteName:settings.deviceName).slice(0,100),path,hash:null,size:0,deleted:true,deviceId:localSurvived?undefined:settings.deviceId,deviceName:localSurvived?remoteName:settings.deviceName,annotatedPath:path,annotatedHash};
    await this.conflictStore.save({id:crypto.randomUUID(),originSnapshotId:null,path,createdAt:new Date().toISOString(),reason:"An edit and a deletion overlapped; the complete edit was preserved",state:"open",versions:localSurvived?[edited,deleted]:[deleted,edited]});
  }
  private async preserveNamespaceCollision(collision:FolderFileCollision<FileState>,final:Map<string,FileState>,bytes:Map<string,Uint8Array>,remoteCache:Map<string,Uint8Array>,occupied:Set<string>):Promise<void>{
    const path=collision.path,current=collision.versions.filter(version=>version.side!=="base"),canonical=current.find(version=>version.side==="remote"&&version.originalPath===path)??current.find(version=>version.side==="remote")??current[0],unique=new Map<string,typeof canonical>();
    for(const version of current){const key=`${version.entry.fileId??version.originalPath}:${version.entry.hash}`,previous=unique.get(key);if(!previous||version.side==="local")unique.set(key,version);}
    const canonicalKey=`${canonical.entry.fileId??canonical.originalPath}:${canonical.entry.hash}`,versions=[unique.get(canonicalKey)!,...[...unique].filter(([key])=>key!==canonicalKey).sort(([a],[b])=>a.localeCompare(b)).map(([,version])=>version)],known=(await this.conflictStore.list()).find(item=>!item.originSnapshotId&&item.reason==="Folders converged onto the same location; every distinct file generation was preserved"&&item.path===path&&item.versions.length===versions.length&&item.versions.every((side,index)=>side.hash===versions[index].entry.hash)),names=versions.map(version=>`${version.entry.revision?.deviceName??(version.side==="local"?this.getSettings().deviceName:"Remote device")} · ${version.originalPath}`),targets=versions.map((version,index)=>{if(index===0)return path;const target=this.conflictPath(path,version.entry.revision?.deviceName??(version.side==="local"?this.getSettings().deviceName:"Remote device"),version.entry.mtime,occupied);occupied.add(target);return target;}),prefix=path.toLowerCase().endsWith(".md")?`> [!warning] Gib Sync conflict\n> Separate folders converged onto this location. Every complete version was preserved from **${names.join("** and **")}**.\n> Preserved notes: ${targets.map(target=>this.wikiLink(target)).join(", ")}\n\n`:"",sides:ConflictInboxItem["versions"]=[];
    for(let index=0;index<versions.length;index++){await this.cooperate();const version=versions[index],entry=version.entry,target=targets[index],side=version.side==="local"?"local":"remote";
      if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES)await this.prepareStreamedVersion(target,entry,side,prefix,final);else{const clear=side==="local"?await this.localBytes(entry.path,entry,bytes):await this.remoteBytes(entry,remoteCache);await this.prepareResult(target,prefix?encoder.encode(prefix+decoder.decode(clear)):clear,final,bytes);}
      const accepted=final.get(target)!;if(index===0){accepted.fileId=canonical.entry.fileId;accepted.revision=canonical.entry.revision;}else{delete accepted.fileId;delete accepted.revision;}
      let sourcePath:string|undefined;if(side==="local"){sourcePath=known?.versions[index]?.sourcePath??`.gib-sync/conflict-originals/${crypto.randomUUID()}.bin`;if(!await this.adapter.exists(sourcePath)){await this.ensureParent(sourcePath);await this.copyProtectedOriginal({...entry,path:version.originalPath},sourcePath);}if(await this.savedHash(sourcePath)!==entry.hash)throw new FileChangedDuringReadError(version.originalPath);}
      sides.push({id:known?.versions[index]?.id??crypto.randomUUID(),label:names[index].slice(0,100),path:version.originalPath,hash:entry.hash,size:entry.size,deviceId:entry.revision?.deviceId??(side==="local"?this.getSettings().deviceId:undefined),deviceName:entry.revision?.deviceName,revisionId:entry.revision?.id,...sourcePath?{sourcePath}:{},annotatedPath:target,annotatedHash:accepted.hash});
    }
    await this.conflictStore.save({id:known?.id??crypto.randomUUID(),originSnapshotId:null,path,createdAt:known?.createdAt??new Date().toISOString(),reason:"Folders converged onto the same location; every distinct file generation was preserved",state:"open",versions:sides});
  }
  private async recordSystemConflict(path:string,local:FileState,remote:FileState,preferred:"local"|"remote",final:Map<string,FileState>,remoteName:string,reason:string):Promise<void>{
    await this.recordConflict(path,local,remote,this.getSettings().deviceName,remoteName,preferred,path,final,reason);
    const item=(await this.conflictStore.list()).find(item=>!item.originSnapshotId&&item.path===path&&item.versions[0]?.hash===local.hash&&item.versions[1]?.hash===remote.hash);if(item){item.actionRequired=false;await this.conflictStore.save(item);}
  }
  private async publishPendingConflicts(snapshot:Snapshot):Promise<void>{
    const accepted=new Map(snapshot.entries.map(entry=>[entry.path,entry.hash]));
    const pending=(await this.conflictStore.list()).filter(item=>item.state==="open"&&!(item as ConflictInboxItem&{published?:boolean}).published&&(item.originSnapshotId||item.versions.every(side=>side.annotatedPath&&accepted.get(side.annotatedPath)===side.annotatedHash)));
    if(!pending.length)return;
    for(const item of pending){item.originSnapshotId??=snapshot.id;await this.conflictStore.save(item);}
    if(typeof this.api.publishConflicts==="function")try{await this.api.publishConflicts(pending);for(const item of pending){(item as ConflictInboxItem&{published?:boolean}).published=true;await this.conflictStore.save(item);}}catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;}
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
    await this.intents.acknowledge(intent.intentSequence??0);
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
    await this.adapter.writeBinary(recordPath,exactArrayBuffer(encoder.encode(JSON.stringify({path:operation.namespacePath??path,snapshotId:this.getSettings().pendingApplySnapshotId,...operation}))));
    if(!allowCancelled)this.checkpoint();
  }
  private async loadOperation(path:string,targetHash:string|null,priorHash:string|null):Promise<ApplyOperation|undefined>{
    const settings=this.getSettings(),legacy=settings.pendingApplyOperations[path];
    const namespacePath=legacy?.namespacePath??path;
    const identity=await hashBytes(encoder.encode(`${settings.pendingApplySnapshotId??"restore"}\n${namespacePath}\n${targetHash??"delete"}\n${priorHash??"absent"}`));
    const expected={stagePath:`.gib-sync/apply/${identity}.stage`,backupPath:`.gib-sync/apply/${identity}.backup`};
    const recordPath=this.operationRecord(legacy?.targetHash===targetHash&&legacy.priorHash===priorHash?legacy:{...expected,targetHash,priorHash,phase:"planned"});
    const stat=await this.adapter.stat(recordPath);
    if(!stat)return legacy?.targetHash===targetHash&&legacy.priorHash===priorHash?legacy:undefined;
    if(stat.type!=="file"||stat.size>8192)throw new SyncSafetyError(`The recovery journal for ${path} is invalid; local bytes were left unchanged.`);
    let record:ApplyOperation&{path:string;snapshotId:string|null};
    try{record=JSON.parse(decoder.decode(new Uint8Array(await this.adapter.readBinary(recordPath)))) as typeof record;}catch{throw new SyncSafetyError(`The recovery journal for ${path} is incomplete; local bytes were left unchanged.`);}
    if(record.path!==namespacePath||record.snapshotId!==settings.pendingApplySnapshotId||record.targetHash!==targetHash||record.priorHash!==priorHash||record.stagePath!==expected.stagePath||record.backupPath!==expected.backupPath||!["planned","staged","backed-up","promoting","applied"].includes(record.phase))throw new SyncSafetyError(`The recovery journal for ${path} does not match its accepted operation; local bytes were left unchanged.`);
    const operation:ApplyOperation={targetHash,priorHash,...expected,phase:record.phase,...namespacePath!==path?{namespacePath}:{}};settings.pendingApplyOperations[path]=operation;return operation;
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
  private async inspectLocalFile(path:string,force=false){try{return await this.inventory.inspect(path,force);}catch(error){if(error instanceof AdapterFileChangedError)throw new FileChangedDuringReadError(path);throw error;}}

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
    const packagePaths=new Set<string>();
    if(this.packageRuntime&&this.getSettings().syncPlugins&&final.get(this.enablementPath)?.hash!==physicalLocal.get(this.enablementPath)?.hash){
      const readList=async(entry:FileState|undefined,local:boolean):Promise<string[]>=>{if(!entry||entry.size>512*1024)return [];const clear=local?await this.localBytes(entry.path,entry,bytes):bytes.get(entry.hash)??await this.remoteBytes(entry,remoteCache);const value=JSON.parse(decoder.decode(clear)) as unknown;return Array.isArray(value)?value.filter((id):id is string=>typeof id==="string"):[];};
      const before=await readList(physicalLocal.get(this.enablementPath),true),after=await readList(final.get(this.enablementPath),false),ids=new Set([...before,...after].filter(id=>before.includes(id)!==after.includes(id)));
      for(const id of ids){if(!this.sharedPlugin(id)||/[\\/]/.test(id))continue;const root=`${this.logicalConfigDir}/plugins/${id}`;if(!await this.adapter.exists(`${root}/manifest.json`)||!await this.adapter.exists(`${root}/main.js`))continue;try{await this.packageRuntime.quiesce(id);await this.queuePackageActivation(id,final.get(`${root}/data.json`)?.hash??await this.savedHash(`${root}/data.json`),[...final.values()].filter(entry=>this.pluginPath(entry.path)?.id===id));}catch(error){if(!(error instanceof PackageRuntimeHoldError))throw error;this.getSettings().packageHolds[id]={reason:error.message,at:Date.now()};}}
    }
    if(this.getSettings().syncPlugins){
      for(const root of await this.packages.recover(this.getSettings().pendingApplySnapshotId??undefined)){const id=root.split("/").at(-1)!;if(this.sharedPlugin(id))await this.queuePackageActivation(id,await this.savedHash(`${root}/data.json`),[...final.values()].filter(entry=>this.pluginPath(entry.path)?.id===id));}
      const changedIds=new Set([...Object.keys(this.getSettings().packageHolds),...[...new Set([...final.keys(),...physicalLocal.keys()])].filter(path=>this.include(path)&&final.get(path)?.hash!==physicalLocal.get(path)?.hash).map(path=>this.pluginPath(path)?.id).filter((id):id is string=>Boolean(id))].filter(id=>this.sharedPlugin(id)&&[...final.keys(),...physicalLocal.keys()].some(path=>this.pluginPath(path)?.id===id&&["manifest.json","main.js"].includes(this.pluginPath(path)!.relative))));
      for(const id of changedIds){
        const desired=[...final.values()].filter(entry=>this.include(entry.path)&&this.pluginPath(entry.path)?.id===id),observed=[...physicalLocal.values()].filter(entry=>this.pluginPath(entry.path)?.id===id),root=normalizePath(`${this.logicalConfigDir}/plugins/${id}`);
        const hold=this.getSettings().packageHolds[id];if(hold&&(hold.kind==="incomplete"||hold.fingerprint===await this.packageFingerprint(desired)&&(hold.retryAt??0)>Date.now())){for(const entry of [...desired,...observed])packagePaths.add(entry.path);continue;}
        if(desired.length&&(!desired.some(entry=>entry.path===`${root}/manifest.json`)||!desired.some(entry=>entry.path===`${root}/main.js`)))throw new SyncSafetyError(`Plugin ${id} has an incomplete accepted package. Its existing package and settings were retained.`);
        this.status({phase:"applying",message:`Installing verified complete plugin package · ${id}`});
        try{await this.packageRuntime?.quiesce(id);this.expectLocalMutation(root,desired.length?"folder":null);await this.packages.install(root,desired,observed,this.getSettings().pendingApplySnapshotId??"accepted",async(entry,destination)=>{
          const prepared=final.get(entry.path),source=prepared?.sourcePath??(physicalLocal.get(entry.path)?.hash===entry.hash?entry.path:null);
          if(source){this.checkpoint();await this.adapter.copy(source,destination);this.checkpoint();return;}
          if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES&&typeof this.adapter.appendBinary==="function"&&typeof this.api.streamContent==="function"){await this.adapter.writeBinary(destination,new ArrayBuffer(0));await this.api.streamContent(entry.hash,entry.size,async chunk=>{this.checkpoint();await this.adapter.appendBinary(destination,exactArrayBuffer(chunk));await this.cooperate();},()=>this.checkpoint());}
          else{const clear=bytes.get(entry.hash)??await this.remoteBytes(entry,remoteCache);await this.adapter.writeBinary(destination,exactArrayBuffer(clear));this.checkpoint();}
        });delete this.getSettings().packageHolds[id];if(desired.length)await this.queuePackageActivation(id,desired.find(entry=>entry.path===`${root}/data.json`)?.hash??await this.savedHash(`${root}/data.json`),desired);else await this.packageRuntime?.confirmRetirement?.(id);
        }catch(error){if(error instanceof PackageRuntimeHoldError){await this.holdPackage(id,error.message,"activation",desired,observed);for(const entry of [...desired,...observed])packagePaths.add(entry.path);this.status({phase:"applying",message:error.message,level:"warning"});continue;}if(error instanceof AdapterFileChangedError)throw new FileChangedDuringReadError(error.path);throw error;}
        for(const entry of desired){packagePaths.add(entry.path);if(physicalLocal.get(entry.path)?.hash!==entry.hash)downloaded++;this.inventory.markDirty(entry.path);}
        for(const entry of observed){packagePaths.add(entry.path);if(!final.has(entry.path))deleted++;}
      }
    }
    const operationTotal=[...final].filter(([path,entry])=>physicalLocal.get(path)?.hash!==entry.hash).length+[...physicalLocal.keys()].filter(path=>!final.has(path)&&this.include(path)).length;
    const applyOrder=[...final].sort(([left,leftEntry],[right,rightEntry])=>{
      const rank=(path:string,entry:FileState)=>path===this.enablementPath?4:entry.size>=LOW_MEMORY_DOWNLOAD_BYTES?3:this.pluginPath(path)?0:this.systemPath(path)?2:1;
      return rank(left,leftEntry)-rank(right,rightEntry)||left.localeCompare(right);
    });
    for(const [path,entry] of applyOrder){
      if(!this.include(path)||this.heldPackagePath(path))continue;
      if(packagePaths.has(path))continue;
      await this.cooperate();let deviceEntry=entry,deviceClear:Uint8Array|undefined;
      if(path===this.enablementPath){
        const serverClear=await this.entryBytes(entry,physicalLocal,bytes,remoteCache);
        deviceClear=await this.deviceEnablement(serverClear,desktopOnlyPlugins);deviceEntry={...entry,hash:await hashBytes(deviceClear),size:deviceClear.length};
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
      if(this.heldPackagePath(path))continue;
      if(packagePaths.has(path))continue;
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
    if(path===this.enablementPath){clear=await this.deviceEnablement(clear,desktopOnly);hash=await hashBytes(clear);}
    return {clear,hash};
  }
  private async resumePendingApplication():Promise<number>{
    const settings=this.getSettings(),pending=[...new Set(settings.pendingApplyPaths.map((path)=>normalizePath(path)).filter(Boolean))];if(!pending.length&&!settings.pendingApplySnapshotId)return 0;
    // v0.8.33 recorded lastSnapshotId before applying. Treat it as the staged
    // target when upgrading an interrupted journal that predates explicit ids.
    const targetId=settings.pendingApplySnapshotId??settings.lastSnapshotId;if(!targetId)throw new SyncSafetyError("An accepted device update is pending, but its target snapshot was not recorded.");
    const target=this.canonicalSnapshot(await this.optionalSnapshot(targetId));if(!target)throw new SyncSafetyError("An accepted device update is pending, but its exact server snapshot is unavailable. No local files were uploaded or deleted.");
    const priorId=settings.pendingApplyBaseSnapshotId??target.parentId,prior=this.canonicalSnapshot(priorId?await this.optionalSnapshot(priorId):null),targetMap=this.map(target),priorMap=this.map(prior),cache=this.bodyCache(),desktopOnly=new Set<string>();let completed=0,preserved=0;
    if(this.isMobileDevice)for(const [path,entry] of targetMap){const plugin=this.pluginPath(path);if(plugin?.relative.toLowerCase()!=="manifest.json")continue;try{if((JSON.parse(decoder.decode(await this.remoteBytes(entry,cache))) as {isDesktopOnly?:unknown}).isDesktopOnly===true)desktopOnly.add(plugin.id);}catch{}}
    const packageHandled=new Set<string>();
    if(settings.syncPlugins){
      try{for(const root of await this.packages.recover(target.id)){const id=root.split("/").at(-1)!;if(this.sharedPlugin(id))await this.queuePackageActivation(id,targetMap.get(`${root}/data.json`)?.hash??await this.savedHash(`${root}/data.json`),[...targetMap.values()].filter(entry=>this.pluginPath(entry.path)?.id===id));}}catch(error){if(error instanceof AdapterFileChangedError)throw new FileChangedDuringReadError(error.path);throw error;}
      const ids=new Set(pending.map(path=>this.pluginPath(path)?.id).filter((id):id is string=>Boolean(id)&&this.sharedPlugin(id!)));
      for(const id of ids){
        const packageEntries=[...targetMap.values()].filter(entry=>this.pluginPath(entry.path)?.id===id),oldEntries=[...priorMap.values()].filter(entry=>this.pluginPath(entry.path)?.id===id);
        if(![...packageEntries,...oldEntries].some(entry=>["manifest.json","main.js"].includes(this.pluginPath(entry.path)!.relative)))continue;
        const root=normalizePath(`${this.logicalConfigDir}/plugins/${id}`),physical=new Map<string,FileState>();for(const path of await this.listFiles(root)){const stat=await this.adapter.stat(path);if(stat?.type!=="file")continue;physical.set(path,{path,hash:await this.hashLocalFile(path),size:stat.size,mtime:stat.mtime});}
        let changedDuringApply=false;
        for(const path of pending.filter(path=>this.pluginPath(path)?.id===id)){
          const current=physical.get(path)?.hash??null,expected=targetMap.get(path)?.hash??null,priorHash=settings.pendingApplyPriorHashes[path]??priorMap.get(path)?.hash??null,operation=await this.loadOperation(path,expected,priorHash);
          if(operation?.phase==="promoting"&&current!==expected&&current!==priorHash)throw new SyncSafetyError(`An interrupted plugin copy left an unverified version of ${path}. Both originals are retained; repair the accepted snapshot before publishing any changes.`);
          if(current!==expected&&current!==priorHash)changedDuringApply=true;packageHandled.add(path);
        }
        if(changedDuringApply){
          for(const path of new Set([...packageEntries.map(entry=>entry.path),...oldEntries.map(entry=>entry.path),...physical.keys()])){settings.localReconcileBases[path]=settings.pendingApplyPriorEntries[path]??priorMap.get(path)??null;if(!settings.pendingPaths.includes(path))settings.pendingPaths.push(path);settings.pendingPathTimes[path]??=Date.now();this.inventory.markDirty(path);}preserved++;
          this.status({phase:"applying",message:`Preserved plugin ${id}'s settings changed during the download; its complete package will reconcile before activation`,level:"info"});continue;
        }
        await this.applyFinal(new Map(packageEntries.map(entry=>[entry.path,entry])),physical,desktopOnly,{files:physical,folders:new Set(),unreadableConflictPaths:new Set()},[],this.bodyCache(),cache);
      }
    }
    for(const path of pending){const old=priorMap.get(path);if(!targetMap.has(path)&&old)settings.retiredPaths[path]={hash:old.hash,snapshotId:target.id,retiredAt:Date.now()};}
    this.trimRetiredPaths();await this.saveSettings();
    this.status({phase:"applying",message:`Resuming ${pending.length} accepted file operation${pending.length===1?"":"s"} from its exact snapshot`});
    for(const path of [...pending].sort((left,right)=>Number(left===this.enablementPath)-Number(right===this.enablementPath)||left.localeCompare(right))){
      if(!this.include(path)){completed++;continue;}
      if(packageHandled.has(path)){completed++;continue;}
      await this.cooperate();const entry=targetMap.get(path),old=priorMap.get(path);
      this.inventory.markDirty(path);
      const priorHash=Object.prototype.hasOwnProperty.call(settings.pendingApplyPriorHashes,path)?settings.pendingApplyPriorHashes[path]:(old?.hash??null);
      const expected=entry?(path===this.enablementPath?await this.deviceBytes(path,entry,cache,desktopOnly):{hash:entry.hash,clear:undefined}):undefined;
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
    const retiredCleanup=await this.pruneRetiredEmptyFolders(),topology=await this.reconcileFolderTopology(this.snapshotFolders(target),target.folderRepair,target.createdAt);await this.activatePackages();await this.finishOperations();settings.lastSnapshotId=target.id;settings.initialized=true;settings.pendingApplyPaths=[];settings.pendingApplySnapshotId=null;settings.pendingApplyBaseSnapshotId=null;settings.pendingApplyPriorHashes={};settings.pendingApplyPriorEntries={};settings.pendingCommit=null;settings.pendingPaths=[...new Set(settings.pendingPaths)].sort();if(settings.syncPlugins)settings.pluginSyncBootstrapPending=false;await this.saveSettings();
    if(preserved)this.status({phase:"applying",message:`Preserved ${preserved} genuine local change${preserved===1?"":"s"} made during the interrupted download; they will reconcile normally`,level:"success"});
    return retiredCleanup.removed+topology.removed;
  }

  private async stageAndApply(snapshotId:string,final:Map<string,FileState>,topologyPaths:Iterable<string>,physicalLocal:Map<string,FileState>,desktopOnlyPlugins:Set<string>,scanned:LocalScan,orphanUnreadableConflicts:string[],bytes:Map<string,Uint8Array>,remoteCache:Map<string,Uint8Array>,folderRepair?:Snapshot["folderRepair"],repairSnapshotCreatedAt?:string):Promise<{downloaded:number;deleted:number;prunedFolders:number}>{
    const changed=[...final].filter(([path,entry])=>this.include(path)&&!this.heldPackagePath(path)&&physicalLocal.get(path)?.hash!==entry.hash).map(([path])=>path),removed=[...physicalLocal.keys()].filter((path)=>!final.has(path)&&!this.heldPackagePath(path));
    const settings=this.getSettings(),baseId=settings.lastSnapshotId;settings.pendingApplySnapshotId=snapshotId;settings.pendingApplyBaseSnapshotId=baseId;settings.pendingApplyPaths=[...new Set([...changed,...removed,...orphanUnreadableConflicts])].sort();
    settings.pendingApplyPriorHashes=Object.fromEntries(settings.pendingApplyPaths.map((path)=>[path,physicalLocal.get(path)?.hash??null]));
    settings.pendingApplyPriorEntries=Object.fromEntries(settings.pendingApplyPaths.flatMap(path=>{const entry=physicalLocal.get(path);return entry?[[path,this.manifestEntry(entry)]]:[]}));
    for(const path of removed){const previous=physicalLocal.get(path);if(previous)settings.retiredPaths[path]={hash:previous.hash,snapshotId,retiredAt:Date.now()};}
    // The controller acknowledges consumed path revisions after success. Never
    // erase edits observed while upload/commit was awaiting the network.
    this.trimRetiredPaths();await this.saveSettings();
    const result=await this.applyFinal(final,physicalLocal,desktopOnlyPlugins,scanned,orphanUnreadableConflicts,bytes,remoteCache),retiredCleanup=await this.pruneRetiredEmptyFolders(),topology=await this.reconcileFolderTopology(topologyPaths,folderRepair,repairSnapshotCreatedAt);
    await this.activatePackages();await this.finishOperations();settings.lastSnapshotId=snapshotId;if(!topology.remaining)settings.observedFolderSnapshotId=snapshotId;settings.initialized=true;settings.pendingApplyPaths=[];settings.pendingApplySnapshotId=null;settings.pendingApplyBaseSnapshotId=null;settings.pendingApplyPriorHashes={};settings.pendingApplyPriorEntries={};settings.localReconcileBases={};settings.pendingCommit=null;if(settings.syncPlugins)settings.pluginSyncBootstrapPending=false;await this.saveSettings();return {...result,prunedFolders:retiredCleanup.removed+topology.removed};
  }

  private async recoverPendingBatch():Promise<void>{
    let record=await this.operations.load();if(!record)return;
    const wasAccepted=record.phase==="accepted";
    // No request can have been sent in prepared phase. Orphan immutable uploads
    // are harmless; fresh local intent may supersede this unsubmitted proposal.
    if(record.phase==="prepared"){await this.operations.clear();return;}
    if(typeof this.api.supportsOperationsV2!=="function"||!this.api.supportsOperationsV2())throw new SyncSafetyError("This device has a saved operation awaiting its server receipt. The server must support operation recovery before syncing can resume.");
    if(record.phase==="submitted"){
      let receipt:OperationReceipt;try{receipt=await this.api.batchReceipt(record.batch.batchId);}catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;try{receipt=await this.api.operationBatch(record.batch);}catch(retryError){if(retryError instanceof ApiError&&retryError.status>=400&&retryError.status<500&&retryError.status!==408&&retryError.status!==423){await this.operations.clear();return;}throw retryError;}}
      this.assertOwnedReceipt(receipt,record.batch);if(receipt.batchId!==record.batch.batchId)throw new SyncSafetyError("The server returned a different durable operation receipt");record={...record,phase:"accepted",receipt};await this.operations.save(record);
    }
    const receipt=record.receipt;if(!receipt)throw new SyncSafetyError("An accepted operation journal is missing its receipt; local files were retained");
    const scope=this.getSettings();if(receipt.batchId!==record.batch.batchId||receipt.snapshot.vaultId!==scope.vaultId||receipt.snapshot.deviceId!==scope.deviceId)throw new SyncSafetyError("An operation receipt does not belong to this device and vault; no files were changed");
    if(wasAccepted){const authenticated=await this.api.batchReceipt(record.batch.batchId);if(authenticated.batchId!==receipt.batchId||authenticated.sequence!==receipt.sequence||authenticated.snapshot.vaultId!==scope.vaultId||authenticated.snapshot.deviceId!==scope.deviceId||JSON.stringify(authenticated.snapshot)!==JSON.stringify(receipt.snapshot))throw new SyncSafetyError("The saved accepted receipt does not match its authenticated immutable server proof; all local versions were retained");record.receipt=authenticated;}
    await this.publishPendingConflicts(receipt.snapshot);
    const settings=this.getSettings();
    if(settings.lastSnapshotId!==receipt.snapshot.id&&!settings.pendingApplySnapshotId){settings.pendingApplySnapshotId=receipt.snapshot.id;settings.pendingApplyBaseSnapshotId=settings.lastSnapshotId;settings.pendingApplyPaths=Object.keys(record.priorHashes);settings.pendingApplyPriorHashes={...record.priorHashes};settings.pendingApplyPriorEntries={...record.priorEntries};await this.saveSettings();}
    if(settings.pendingApplySnapshotId||settings.pendingApplyPaths.length)await this.resumePendingApplication();
    await this.recordDecision(record);await this.intents.acknowledge(record.intentSequence);await this.operations.clear();this.checkpoint();
  }
  private assertOwnedReceipt(receipt:OperationReceipt,batch:OperationBatch):void{const settings=this.getSettings();if(receipt.batchId!==batch.batchId||!receipt.snapshot||receipt.snapshot.vaultId!==settings.vaultId||receipt.snapshot.deviceId!==settings.deviceId)throw new SyncSafetyError("The operation receipt does not belong to this device and vault; no files were changed");}

  private async run(attempt: number): Promise<SyncResult> {
    const settings = this.getSettings(); if (!settings.deviceToken || !settings.vaultKey) throw new Error("Gib Sync is not configured");
    this.bootstrapRetainedPluginIds.clear();
    if(this.firstRun){
      const recovery=await this.packages.restoreDeviceLocalRetirements();
      for(const root of recovery.restored)this.status({phase:"applying",message:`Restored protected device-local plugin original · ${root.split("/").at(-1)}`,level:"success"});
      for(const root of recovery.held)this.status({phase:"applying",message:`Device-local plugin original retained for review · ${root.split("/").at(-1)}`,level:"warning"});
      for(const id of Object.keys(settings.packageHolds))if(isDeviceLocalPlugin(id)&&await this.adapter.exists(this.pluginFile(id,"manifest.json"))&&await this.adapter.exists(this.pluginFile(id,"main.js")))delete settings.packageHolds[id];
      if(recovery.restored.length)settings.fullScanRequired=true;
    }
    if(this.firstRun){this.firstRun=false;for(const hold of Object.values(settings.packageHolds))hold.retryAt=0;}
    if(!settings.syncPlugins)settings.packageHolds={};
    await this.intents.flush();
    await this.recoverPendingBatch();
    await this.recoverPendingCommit();
    const initialFolderCleanup=await this.pruneRetiredEmptyFolders();let prunedFolders=initialFolderCleanup.removed;if(initialFolderCleanup.attempted)await this.saveSettings();
    let requestedBaseId=settings.lastSnapshotId;
    let pendingPaths=[...new Set(settings.pendingPaths.map((path)=>normalizePath(path)).filter(Boolean))];
    const consumedMoves=settings.pendingMoves.map(move=>({...move}));
    const lastAudit=settings.lastFullScanAt?Date.parse(settings.lastFullScanAt):0,auditDue=!lastAudit||Date.now()-lastAudit>=6*60*60*1000;
    const heldRetryDue=Object.values(settings.packageHolds).some(hold=>(hold.retryAt??0)<=Date.now());
    this.status({phase:"reading-remote",message:"Checking for a newer server snapshot"});
    let remoteHeadId:string|null;
    try{remoteHeadId=(await this.api.headState()).headId;}catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;remoteHeadId=(await this.api.state()).head?.id??null;}
    if(remoteHeadId!==requestedBaseId)this.status({phase:"checking",message:"New server changes found",remoteChanged:true});
    if(settings.initialized&&!settings.pendingApplySnapshotId&&!settings.pendingApplyPaths.length&&!Object.keys(settings.localReconcileBases).length&&!settings.fullScanRequired&&!settings.pluginSyncBootstrapPending&&!auditDue&&!heldRetryDue&&!pendingPaths.length&&remoteHeadId===requestedBaseId){
      const inspectTopology=settings.observedFolderSnapshotId!==requestedBaseId||settings.retiredFolderCount>0||Boolean(settings.lastFolderCleanupError);
      let topology={removed:0,remaining:0};
      if(inspectTopology){const accepted=requestedBaseId?await this.api.snapshot(requestedBaseId):null;topology=await this.reconcileFolderTopology(this.snapshotFolders(accepted),accepted?.folderRepair,accepted?.createdAt);prunedFolders+=topology.removed;await this.saveSettings();}
      this.status({phase:topology.remaining?"applying":"up-to-date",message:topology.remaining?settings.retiredFolderNote:"Up to date · accepted file manifest and observed folders agree",level:topology.remaining?"warning":"success"});
      return {uploaded:0,downloaded:0,deleted:0,prunedFolders,pendingRetiredFolders:settings.retiredFolderCount,conflicts:0,resolved:0,mirrored:0,snapshotId:requestedBaseId,processedPaths:[],fullScan:false,pendingPackages:Object.keys(settings.packageHolds)};
    }
    const operationTree=typeof this.api.supportsOperationsV2==="function"&&this.api.supportsOperationsV2()?await this.api.syncTree():null;
    const rollout=operationTree&&typeof this.api.rolloutStatus==="function"?await this.api.rolloutStatus():null,usesOperations=Boolean(operationTree&&(!rollout||rollout.mode==="active"||rollout.mode==="canary"&&rollout.canaryDeviceId===settings.deviceId));
    const remoteSnapshot=this.canonicalSnapshot(operationTree?.snapshotId?await this.api.snapshot(operationTree.snapshotId):(await this.api.state()).head);
    if(settings.pendingApplySnapshotId||settings.pendingApplyPaths.length){prunedFolders+=await this.resumePendingApplication();requestedBaseId=settings.lastSnapshotId;pendingPaths=[...new Set(settings.pendingPaths.map((path)=>normalizePath(path)).filter(Boolean))];}
    const baseSnapshot = this.canonicalSnapshot(requestedBaseId ? await this.optionalSnapshot(requestedBaseId) : null);
    const ownDescendants=baseSnapshot&&pendingPaths.length?await this.ownDescendantCount(requestedBaseId,remoteSnapshot,settings.deviceId):0;
    const fullScan=heldRetryDue||Boolean(Object.keys(settings.packageHolds).length&&remoteHeadId!==requestedBaseId)||settings.fullScanRequired||Boolean(Object.keys(settings.localReconcileBases).length)||settings.pluginSyncBootstrapPending||!settings.initialized||!baseSnapshot||auditDue;
    this.status({phase:"scanning",message:fullScan?"Reconciling the full local vault":pendingPaths.length?`Checking ${pendingPaths.length} changed path${pendingPaths.length===1?"":"s"}`:"No local paths changed"});
    const scanBaseline=ownDescendants&&remoteSnapshot?remoteSnapshot:baseSnapshot;
    const scanned=fullScan?await this.scan():await this.scanIncremental(scanBaseline!,pendingPaths),local=scanned.files;
    // A held package has not consumed the acknowledged server package yet.
    // Incremental scans must not treat that logical checkpoint as physical
    // inventory. Inspect only its component subtree, not the entire vault.
    if(!fullScan)for(const id of Object.keys(settings.packageHolds))if(this.sharedPlugin(id)){
      for(const path of local.keys())if(this.pluginPath(path)?.id===id)local.delete(path);
      for(const path of await this.listFiles(`${this.logicalConfigDir}/plugins/${id}`)){const entry=await this.inspectLocalFile(path);if(entry)local.set(path,entry);}
    }
    // Carry server identities through physical scans without pretending a new
    // content hash has the baseline's authorship. The server assigns revisions.
    const intentPath=(path:string)=>{for(const alias of this.configAliases)if(path===alias||path.startsWith(`${alias}/`))return `.obsidian${path.slice(alias.length)}`;return path;},observedIntents=(await this.intents.snapshot()).map(event=>({...event,path:intentPath(event.path),...event.from?{from:intentPath(event.from)}:{}})),latestFileIntent=new Map([...indexedIntentCreates(observedIntents).values()].filter(event=>event.entity==="file").map(event=>[event.path,event]));
    for(const observed of local.values()){const created=latestFileIntent.get(observed.path);if(created?.kind==="create"&&created.targetId)observed.fileId=created.targetId;}
    const observedLineage=new Map((scanBaseline?.entries??[]).map(entry=>[entry.path,{...entry}]));
    for(const event of observedIntents){
      if(event.kind==="move"&&event.from){const moved=[...observedLineage].filter(([path])=>path===event.from||event.entity==="folder"&&path.startsWith(`${event.from}/`));for(const [from,entry]of moved){observedLineage.delete(from);const path=`${event.path}${from.slice(event.from.length)}`;observedLineage.set(path,{...entry,path});}}
      else if(event.kind==="delete"||event.kind==="create"){for(const path of observedLineage.keys())if(path===event.path||event.entity==="folder"&&path.startsWith(`${event.path}/`))observedLineage.delete(path);}
    }
    for(const [path,entry]of observedLineage){const observed=local.get(path);if(!observed)continue;const recreated=observed.fileId&&entry.fileId&&observed.fileId!==entry.fileId;local.set(path,recreated?{...observed}:{...entry,...observed});}
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
      if(settings.syncPlugins){const acceptedIds=new Set([...accepted.keys()].map(path=>this.pluginPath(path)?.id).filter(Boolean));for(const [path,entry]of local){const id=this.pluginPath(path)?.id;if(id&&!acceptedIds.has(id)){accepted.set(path,entry);this.bootstrapRetainedPluginIds.add(id);}}}
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
    if(effectiveBaseSnapshot&&Object.values(settings.packageHolds).some(hold=>hold.priorEntries)){const replay=new Map(effectiveBaseSnapshot.entries.map(entry=>[entry.path,{...entry}]));for(const [id,hold]of Object.entries(settings.packageHolds)){for(const path of replay.keys())if(this.pluginPath(path)?.id===id)replay.delete(path);for(const [path,entry]of Object.entries(hold.priorEntries??{}))replay.set(path,{...entry});}effectiveBaseSnapshot={...effectiveBaseSnapshot,entries:[...replay.values()]};}
    const base:Map<string,FileState>=operationTree?new Map((effectiveBaseSnapshot?.entries??[]).map(entry=>[entry.path,{...entry}])):this.map(effectiveBaseSnapshot),remote:Map<string,FileState>=operationTree?new Map((remoteSnapshot?.entries??[]).map(entry=>[entry.path,{...entry}])):this.map(remoteSnapshot);for(const path of scanned.unreadableConflictPaths){const accepted=base.get(path)??remote.get(path);if(accepted)local.set(path,accepted);}
    const physicalLocal=new Map(local),bootstrapPluginSync=settings.syncPlugins&&settings.pluginSyncBootstrapPending,acceptedPluginState=Boolean(bootstrapPluginSync&&remoteSnapshot&&[...remote.keys()].some((path)=>this.pluginSyncPath(path)));
    let folderPlan:ReturnType<typeof reconcileAndAlignFolders>|null=null;
    if(operationTree){
      // Current paths cannot hydrate an unrelated historical generation.
      // Unknown old empty folders never authorize retirement of a replacement.
      const basePaths=this.snapshotFolders(effectiveBaseSnapshot),baseFolders=(effectiveBaseSnapshot?.folderEntries?.length?effectiveBaseSnapshot.folderEntries:effectiveBaseSnapshot?.id===operationTree.snapshotId?operationTree.folders.filter(folder=>basePaths.has(folder.path)):[]).filter(folder=>this.managedTopLevelFolder(folder.path)),remoteFolders=operationTree.folders.filter(folder=>this.managedTopLevelFolder(folder.path)),localFolderPaths=new Set([...scanned.folders,...this.acceptedFolders(local.keys())]),localFolders=observeLocalFolders(baseFolders,remoteFolders,localFolderPaths,observedIntents,settings.deviceId,settings.deviceName);
      try{folderPlan=reconcileAndAlignFolders(baseFolders,localFolders,remoteFolders,base,local,remote);}catch(error){throw new SyncSafetyError(error instanceof Error?error.message:"Folder identities could not be reconciled safely");}
      if(folderPlan.conflicts.length)this.status({phase:"merging",message:`Resolved ${folderPlan.conflicts.length} overlapping folder changes by stable identity; edits follow the chosen location`,level:"info"});
    }
    const remoteAlignedAll=operationTree?new Map(remote):new Map((remoteSnapshot?.entries??[]).map(entry=>[entry.path,{...entry}]));for(const map of [base,remote])for(const path of map.keys())if(!this.include(path))map.delete(path);
    if(operationTree&&rollout?.mode==="shadow"&&typeof this.api.observeReconciliation==="function"){
      const shadowBase=baseSnapshot?await this.api.snapshot(baseSnapshot.id):null,shadowRemote=remoteSnapshot?await this.api.snapshot(remoteSnapshot.id):null,preserved=(shadowRemote?.entries??[]).filter(entry=>!this.include(entry.path));
      const baseIds=new Map((shadowBase?.entries??[]).map(entry=>[entry.path,entry.fileId]));try{await this.api.observeReconciliation({base:shadowBase?.entries??[],local:[...physicalLocal.values(),...preserved].map(entry=>this.manifestEntry(entry)),remote:shadowRemote?.entries??[],localCreationIntents:[...latestFileIntent.values()].filter(event=>event.kind==="create"&&event.targetId).map(event=>({operationId:event.id,targetId:event.targetId!,path:event.path,baseTargetId:baseIds.get(event.path)??null}))},shadowBase?.id??null);}catch(error){if(error instanceof ApiError&&error.status===409)return this.convergeAfterConflict(attempt,"The accepted tree advanced during reconciliation validation");if(!(error instanceof ApiError&&error.status===404))throw error;}
    }
    const bootstrapLocalOnlyIds=this.bootstrapRetainedPluginIds;
    if(acceptedPluginState){
      const remoteIds=new Set([...remote.keys()].map(path=>this.pluginPath(path)?.id).filter(Boolean));
      for(const path of local.keys()){const id=this.pluginPath(path)?.id;if(id&&!remoteIds.has(id))bootstrapLocalOnlyIds.add(id);}
      for(const path of new Set([...local.keys(),...remote.keys()].filter(candidate=>this.pluginSyncPath(candidate)))){
        const id=this.pluginPath(path)?.id;if(id&&bootstrapLocalOnlyIds.has(id))continue;
        const accepted=remote.get(path);if(accepted)local.set(path,accepted);else local.delete(path);
      }
      this.status({phase:"merging",message:"Plugin sync first activation · adopting shared server packages and settings; retaining locally installed packages absent from that inventory",level:"success"});
    }
    else if(bootstrapPluginSync)this.status({phase:"merging",message:"Plugin sync first activation · no accepted plugin inventory exists, so this device will establish it",level:"info"});
    const orphanUnreadableConflicts=[...scanned.unreadableConflictPaths].filter((path)=>!base.has(path)&&!remote.has(path));let suppressedRetired=0,retiredStateChanged=false;
    if(operationTree){const newest=new Map<string,typeof operationTree.tombstones[number]>();for(const tombstone of operationTree.tombstones){const old=newest.get(tombstone.path);if(!old||tombstone.deletedSequence>old.deletedSequence||tombstone.deletedSequence===old.deletedSequence&&(tombstone.deletedOrdinal??0)>(old.deletedOrdinal??0))newest.set(tombstone.path,tombstone);}for(const [path,tombstone]of newest){const current=local.get(path);if(!current||remote.has(path)||tombstone.entityKind!=="file"||!tombstone.content)continue;const created=latestFileIntent.get(path)?.kind==="create";if(current.hash===tombstone.content.hash&&!created){settings.retiredPaths[path]={hash:current.hash,snapshotId:remoteSnapshot?.id??"accepted",retiredAt:tombstone.revision.modifiedAt};local.delete(path);suppressedRetired++;retiredStateChanged=true;}}}
    for(const [path,retired] of Object.entries(settings.retiredPaths)){
      const current=local.get(path);
      if(remote.has(path)){delete settings.retiredPaths[path];retiredStateChanged=true;continue;}
      if(current?.hash===retired.hash){
        if(latestFileIntent.get(path)?.kind==="create"){delete settings.retiredPaths[path];retiredStateChanged=true;continue;}
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
    const namespaceCollisionPaths=new Set<string>();for(const collision of folderPlan?.fileCollisions??[]){await this.preserveNamespaceCollision(collision,final,bytes,remoteCache,occupied);namespaceCollisionPaths.add(collision.path);conflicts++;}
    if(recognizedMoves)this.status({phase:"merging",message:`Recognized ${recognizedMoves} file move${recognizedMoves===1?"":"s"} by content identity; edits will follow the destination`,level:"success"});
    const handledPluginPaths=new Set<string>(),desktopOnlyPlugins=new Set<string>();
    if(settings.syncPlugins){
      /* Component holds retain verified baselines until a complete retry succeeds. */
      const pluginIds=new Set([...paths].map((path)=>this.pluginPath(path)?.id).filter((id):id is string=>Boolean(id)));
      const packageFor=(source:Map<string,FileState>,id:string)=>new Map([...source].filter(([path])=>{const plugin=this.pluginPath(path);return plugin?.id===id&&!this.pluginDataPath(path);}));
      const versionFor=async(source:"local"|"remote",entries:Map<string,FileState>,id:string):Promise<string|null>=>{
        const entry=entries.get(this.pluginFile(id,"manifest.json"));if(!entry||entry.size>64*1024)return null;
        try{const clear=source==="local"?await this.entryBytes(entry,physicalLocal,bytes,remoteCache):await this.remoteBytes(entry,remoteCache),manifest=JSON.parse(decoder.decode(clear)) as {id?:unknown;version?:unknown;isDesktopOnly?:unknown}|null;return manifest&&manifest.id===id&&typeof manifest.version==="string"&&(manifest.isDesktopOnly===undefined||typeof manifest.isDesktopOnly==="boolean")?manifest.version:null;}catch(error){if(!(error instanceof SyntaxError))throw error;return null;}
      };
      for(const id of [...pluginIds].sort()){
        await this.cooperate();
        const baseline=packageFor(base,id),localPackage=packageFor(local,id),remotePackage=packageFor(remote,id);
        for(const path of new Set([...baseline.keys(),...localPackage.keys(),...remotePackage.keys()]))handledPluginPaths.add(path);
        const localChanged=!this.packageSame(localPackage,baseline),remoteChanged=!this.packageSame(remotePackage,baseline);
        const localVersion=await versionFor("local",localPackage,id),remoteVersion=await versionFor("remote",remotePackage,id);
        const baseVersion=await versionFor("remote",baseline,id),complete=(entries:Map<string,FileState>,version:string|null)=>Boolean(version)&&entries.has(this.pluginFile(id,"manifest.json"))&&entries.has(this.pluginFile(id,"main.js")),choice=selectPluginPackage({entries:[...baseline.values()],version:baseVersion,complete:complete(baseline,baseVersion)},{entries:[...localPackage.values()].map(entry=>({...entry,mtime:this.localChangeTime(entry.path,entry,effectiveBaseSnapshot),...baseline.get(entry.path)?.hash!==entry.hash?{revision:undefined}:{}})),version:localVersion,complete:complete(localPackage,localVersion)},{entries:[...remotePackage.values()],version:remoteVersion,complete:complete(remotePackage,remoteVersion)}),chosen=new Map(choice.entries.map(entry=>[entry.path,{...entry} as FileState])),side=choice.side,reason=choice.reason;
        if(choice.side==="held"&&[...baseline.keys(),...localPackage.keys(),...remotePackage.keys()].some(path=>["manifest.json","main.js"].includes(this.pluginPath(path)!.relative))){await this.holdPackage(id,reason,"incomplete",[...remote.values()].filter(entry=>this.pluginPath(entry.path)?.id===id),[...physicalLocal.values()].filter(entry=>this.pluginPath(entry.path)?.id===id));chosen.clear();for(const [path,entry]of remote)if(this.pluginPath(path)?.id===id)chosen.set(path,entry);for(const path of paths)if(this.pluginPath(path)?.id===id)handledPluginPaths.add(path);this.status({phase:"merging",message:`Plugin ${id} needs a complete valid package; its files and settings were held while other vault files continue syncing`,level:"warning"});}
        if(choice.side!=="held"&&settings.packageHolds[id]?.kind==="incomplete")delete settings.packageHolds[id];
        if(choice.resolved)resolved++;
        for(const [path,entry] of chosen)final.set(path,entry);
        if(localChanged||remoteChanged)this.status({phase:"merging",message:`Plugin package · ${id} · chose ${side}${(side==="local"?localVersion:remoteVersion)?` v${side==="local"?localVersion:remoteVersion}`:""} · ${reason}`,level:"info"});
      }
      for(const id of pluginIds){
        const path=this.pluginFile(id,"manifest.json"),entry=final.get(path);if(!entry)continue;
        try{
          const clear=await this.entryBytes(entry,physicalLocal,bytes,remoteCache);
          if((JSON.parse(decoder.decode(clear)) as {isDesktopOnly?:unknown}).isDesktopOnly===true)desktopOnlyPlugins.add(id);
        }catch{/* Malformed manifests remain governed by normal package repair. */}
      }
    }
    // The shared planner is the authority for generic reconciliation on both
    // the client and external-import path. Package/schema rules below enrich
    // concurrent decisions; they do not reinvent change detection.
    const reconciliation=await planReconciliationCooperative({base:[...base.values()],local:[...local.values()],remote:[...remote.values()]},()=>this.cooperate(true));
    for (const decision of reconciliation.decisions) {
      const path=decision.path;
      await this.cooperate();
      if(namespaceCollisionPaths.has(path))continue;
      if(handledPluginPaths.has(path))continue;
      const b = base.get(path), l = local.get(path), r = remote.get(path);
      if (decision.kind==="equal"||decision.kind==="unchanged") { if (r) final.set(path, {...l,...r}); continue; }
      if(settings.syncPlugins&&path===this.enablementPath&&l&&r){
        const baseText=b?decoder.decode(await this.remoteBytes(b,remoteCache)):"[]",localText=decoder.decode(await this.entryBytes(l,physicalLocal,bytes,remoteCache)),remoteText=decoder.decode(await this.remoteBytes(r,remoteCache)),preferred=this.preferredSide(path,l,effectiveBaseSnapshot,remoteSnapshot,r);
        const deviceLocalIds=this.deviceLocalEnablementIds(baseText,localText,remoteText);
        const merged=mergeCommunityPluginEnablement(baseText,localText,remoteText,preferred,desktopOnlyPlugins,this.isMobileDevice,deviceLocalIds),clear=encoder.encode(merged.text);await this.prepareResult(path,clear,final,bytes);resolved++;
        this.status({phase:"merging",message:`Plugin enablement · ${merged.reason}`,level:"success"});continue;
      }
      // A filename is never proof of ownership or an accepted deletion.
      if (decision.kind==="remote-only") { if(r)final.set(path,r);continue; }
      if (decision.kind==="local-only") { if(l)final.set(path,l);continue; }
      if (!l && !r) continue;
      if(decision.strategy!=="text"||this.systemPath(path)){
        if(b&&(!l||!r)){
          const kept=l??r;if(kept)final.set(path,kept);resolved++;this.status({phase:"merging",message:`Obsidian system file · ${path} · kept the modified version instead of an overlapping deletion`,level:"warning"});continue;
        }
        if(l&&r){
          const preferred=this.preferredSide(path,l,effectiveBaseSnapshot,remoteSnapshot,r);
          if(Math.max(b?.size??0,l.size,r.size)>MAX_SETTINGS_JSON_BYTES){final.set(path,preferred==="local"?l:r);resolved++;this.status({phase:"merging",message:`Large Obsidian settings file · ${path} · used the newer complete ${preferred} version without parsing it; prior copies remain recoverable`,level:"warning"});await this.recordSystemConflict(path,l,r,preferred,final,remoteSnapshot?.deviceName??"Remote device","Large settings overlap was resolved with one complete version");continue;}
          if(decision.strategy==="json-settings"||path.toLowerCase().endsWith(".json")){
            const baseText=b?decoder.decode(await this.remoteBytes(b,remoteCache)):path===this.enablementPath?"[]":"{}",localText=decoder.decode(await this.entryBytes(l,physicalLocal,bytes,remoteCache)),remoteText=decoder.decode(await this.remoteBytes(r,remoteCache));
            const merged=path===this.enablementPath?mergeCommunityPluginEnablement(baseText,localText,remoteText,preferred,desktopOnlyPlugins,this.isMobileDevice):mergeSystemJson(baseText,localText,remoteText,preferred,this.configPath(path)===".obsidian/bookmarks.json"?"bookmarks":undefined),clear=encoder.encode(merged.text);await this.prepareResult(path,clear,final,bytes);
            if(merged.overlaps)await this.recordSystemConflict(path,l,r,preferred,final,remoteSnapshot?.deviceName??"Remote device","Overlapping settings were merged; both originals are recoverable");
            this.status({phase:"merging",message:`Obsidian settings · ${path} · ${merged.reason}`,level:merged.overlaps?"warning":"success"});
          }else{const chosen=preferred==="local"?l:r;final.set(path,chosen);this.status({phase:"merging",message:`Obsidian system file · ${path} · used newer ${preferred} whole file`,level:"info"});await this.recordSystemConflict(path,l,r,preferred,final,remoteSnapshot?.deviceName??"Remote device","Whole settings overlap was resolved; both originals are recoverable");}
          resolved++;continue;
        }
      }
      if(b&&(!l||!r)){
        conflicts++;
        const survivor=l??r;if(survivor&&survivor.size>=LOW_MEMORY_DOWNLOAD_BYTES){const editor=l?settings.deviceName:r!.revision?.deviceName??remoteSnapshot?.deviceName??"Remote device",deleter=l?remoteSnapshot?.deviceName??"Remote device":settings.deviceName;await this.prepareStreamedVersion(path,survivor,l?"local":"remote",path.toLowerCase().endsWith(".md")?this.deletionWarning("",editor,deleter):"",final);}
        else if(l)await this.preserveDeletion(path,await this.localBytes(path,l,bytes),settings.deviceName,remoteSnapshot?.deviceName??"Remote device",final,bytes);
        else if(r)await this.preserveDeletion(path,await this.remoteBytes(r,remoteCache),r.revision?.deviceName??remoteSnapshot?.deviceName??"Remote device",settings.deviceName,final,bytes);
        if(survivor)await this.recordDeletionConflict(path,survivor,Boolean(l),r?.revision?.deviceName??remoteSnapshot?.deviceName??"Remote device",final);
        continue;
      }
      if(decision.strategy==="text"&&b&&l&&r&&r.fileId&&(!b.fileId||!l.fileId)){
        conflicts++;const preferred=this.preferredSide(path,l,effectiveBaseSnapshot,remoteSnapshot,r);if(Math.max(l.size,r.size)>=LOW_MEMORY_DOWNLOAD_BYTES)await this.preserveLargePair(path,l,r,settings.deviceName,r.revision?.deviceName??remoteSnapshot?.deviceName??"Remote device",preferred,final,occupied);else await this.preservePair(path,l,await this.localBytes(path,l,bytes),r,settings.deviceName,r.revision?.deviceName??remoteSnapshot?.deviceName??"Remote device",preferred,final,bytes,remoteCache,occupied);this.status({phase:"merging",message:`Preserved both · ${path} · this older baseline cannot prove both versions belong to the same file generation`,level:"info"});continue;
      }
      if(l&&r&&Math.max(b?.size??0,l.size,r.size)>=LOW_MEMORY_DOWNLOAD_BYTES){conflicts++;await this.preserveLargePair(path,l,r,settings.deviceName,r.revision?.deviceName??remoteSnapshot?.deviceName??"Remote device",this.preferredSide(path,l,effectiveBaseSnapshot,remoteSnapshot,r),final,occupied);this.status({phase:"merging",message:`Large concurrent versions · ${path} · both complete files preserved without loading them into memory`,level:"warning"});continue;}
      if (l && r && this.text(path)) {
        if(!b||decision.kind==="independent-create"){
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
          const clear=await this.entryBytes(entry,physicalLocal,bytes,remoteCache);
          const enabled=JSON.parse(decoder.decode(clear)) as unknown;
          if(Array.isArray(enabled)){
            const valid=enabled.filter((id):id is string=>typeof id==="string"&&(!this.sharedPlugin(id)||(final.has(this.pluginFile(id,"manifest.json"))&&final.has(this.pluginFile(id,"main.js")))));
            if(bootstrapLocalOnlyIds.size){const localEntry=physicalLocal.get(enablementPath);if(localEntry){const localEnabled=JSON.parse(decoder.decode(await this.localBytes(enablementPath,localEntry,bytes))) as unknown;if(Array.isArray(localEnabled))for(const id of localEnabled)if(typeof id==="string"&&bootstrapLocalOnlyIds.has(id)&&final.has(this.pluginFile(id,"manifest.json"))&&final.has(this.pluginFile(id,"main.js"))&&!valid.includes(id))valid.push(id);}}
            const missing=enabled.filter((id)=>typeof id==="string"&&!valid.includes(id));
            if(missing.length||valid.length!==enabled.length){const sanitized=encoder.encode(`${JSON.stringify(valid,null,2)}\n`);await this.prepareResult(enablementPath,sanitized,final,bytes);resolved++;
              if(missing.length)this.status({phase:"merging",message:`Plugin enablement repaired · skipped ${missing.length} incomplete package${missing.length===1?"":"s"}: ${missing.slice(0,5).join(", ")}${missing.length>5?"…":""}`,level:"warning"});}
          }
        }catch(error){if(!(error instanceof SyntaxError))throw error;this.status({phase:"merging",message:"Plugin enablement list is non-standard JSON · kept the newer complete file",level:"warning"});}
      }
    }

    // An ignored path is device-local: keep its accepted remote manifest entry
    // even though this device neither reads nor writes the file. This is
    // essential when phones intentionally omit desktop-only plugins.
    const preservedIgnored=[...remoteAlignedAll.values()].filter((entry)=>!this.include(entry.path)&&!isDeviceLocalObsidianPath(entry.path,this.logicalConfigDir));
    const entries = [...final.values(),...preservedIgnored].map(entry=>this.manifestEntry(entry)).sort((a,b)=>a.path.localeCompare(b.path));
    const remoteEntries = [...(remoteSnapshot?.entries??[])].map(({path,hash,size,mtime}) => ({path,hash,size,mtime})).sort((a,b)=>a.path.localeCompare(b.path));
    const baseFolders=this.manifestFolders(effectiveBaseSnapshot),remoteFolders=this.manifestFolders(remoteSnapshot),implicitFolders=this.acceptedFolders(entries.map(entry=>entry.path)),mergedFolders=folderPlan?new Set(folderPlan.folders.map(folder=>folder.path).filter(path=>!implicitFolders.has(path))):this.mergeFolders(baseFolders,scanned.folders,remoteFolders);
    if(remoteSnapshot?.folderRepair){
      for(const raw of remoteSnapshot.folderRepair.retiredFolders){const path=normalizePath(raw);if(!await this.hasProtectedFolderIntent(path,remoteSnapshot.folderRepair,remoteSnapshot.createdAt))mergedFolders.delete(path);}
    }
    for(const folder of remoteSnapshot?.folders??[])if(!this.include(folder)&&!isDeviceLocalObsidianPath(folder,settings.configDir))mergedFolders.add(normalizePath(folder));
    const folders=[...mergedFolders].sort(),acceptedRemoteFolders=this.manifestFolders(remoteSnapshot);
    for(const folder of remoteSnapshot?.folders??[])if(!this.include(folder)&&!isDeviceLocalObsidianPath(folder,settings.configDir))acceptedRemoteFolders.add(normalizePath(folder));
    const remoteFolderList=[...acceptedRemoteFolders].sort();
    const clientCanMirrorAll=!preservedIgnored.length;
    const remoteHashes=new Set(remoteEntries.map((entry)=>entry.hash)),remotePathHashes=new Map(remoteEntries.map((entry)=>[entry.path,entry.hash])),entryPaths=new Set(entries.map((entry)=>entry.path));
    const remoteIds=new Map((remoteSnapshot?.entries??[]).map(entry=>[entry.path,entry.fileId])),remoteFolderIds=new Map((operationTree?.folders??[]).map(entry=>[entry.path,entry.folderId])),identityIntent=entries.some(entry=>entry.fileId&&remoteIds.get(entry.path)&&entry.fileId!==remoteIds.get(entry.path))||observedIntents.some(event=>event.entity==="folder"&&event.kind==="create"&&remoteFolderIds.has(event.path)&&remoteFolderIds.get(event.path)!==event.targetId);
    const unchanged = !identityIntent&&entries.length === remoteEntries.length && entries.every((entry, i) => entry.path === remoteEntries[i].path && entry.hash === remoteEntries[i].hash)
      && folders.length===remoteFolderList.length&&folders.every((folder,index)=>folder===remoteFolderList[index]);
    if (unchanged) {
      const topologyFolders=new Set([...folders,...this.acceptedFolders(entries.map((entry)=>entry.path))]);let downloaded=0,deleted=0;if(remoteSnapshot){const applied=await this.stageAndApply(remoteSnapshot.id,final,topologyFolders,physicalLocal,desktopOnlyPlugins,scanned,orphanUnreadableConflicts,bytes,remoteCache,remoteSnapshot.folderRepair,remoteSnapshot.createdAt);downloaded=applied.downloaded;deleted=applied.deleted;prunedFolders+=applied.prunedFolders;}else{const topology=await this.reconcileFolderTopology(topologyFolders);prunedFolders+=topology.removed;settings.lastSnapshotId=null;settings.initialized=true;if(settings.syncPlugins)settings.pluginSyncBootstrapPending=false;await this.saveSettings();}let mirrored=0;
      try{mirrored=remoteSnapshot&&clientCanMirrorAll?await this.mirror(remoteSnapshot.id,entries,final,bytes,remoteCache):0;}
      catch(error){if(this.retryableMirrorError(error))return this.convergeAfterConflict(attempt,"Another device advanced the vault during mirror verification");throw error;}
      this.status({phase:"up-to-date",message:"Up to date · this device matches the accepted snapshot"});
      if(fullScan&&!settings.retiredFolderCount){settings.fullScanRequired=false;settings.lastFullScanAt=new Date().toISOString();await this.saveSettings();}
      this.acknowledgeMoves(consumedMoves,entries);await this.saveSettings();await this.intents.acknowledge(observedIntents.reduce((maximum,event)=>Math.max(maximum,event.sequence),0));
      return { uploaded: 0, downloaded, deleted, prunedFolders,pendingRetiredFolders:settings.retiredFolderCount, conflicts, resolved, mirrored, snapshotId: settings.lastSnapshotId,processedPaths:pendingPaths,fullScan,pendingPackages:Object.keys(settings.packageHolds) };
    }

    if(!settings.initialized&&remoteSnapshot){
      this.status({phase:"committing",message:onboardingReconcile?"Verifying the matched server baseline before publishing the union":"Verifying the first download before cleaning device-local workspace state"});
      try{this.checkpoint();await this.api.markDeviceReady(remoteSnapshot.id);this.checkpoint();}
      catch(error){if(error instanceof ApiError&&error.status===409)return this.convergeAfterConflict(attempt,"The server vault changed during onboarding verification");throw error;}
    }

    const applyPaths=new Set([...entries.filter(entry=>physicalLocal.get(entry.path)?.hash!==entry.hash).map(entry=>entry.path),...[...physicalLocal.keys()].filter(path=>!entryPaths.has(path))]);
    const priorEntries=Object.fromEntries([...applyPaths].flatMap(path=>{const entry=physicalLocal.get(path);return entry?[[path,this.manifestEntry(entry)]]:[]}));
    const proposalHashes=new Set(entries.map(entry=>entry.hash)),conflictOriginals:FileState[]=[];for(const item of await this.conflictStore.list())if(!item.originSnapshotId)for(const side of item.versions)if(side.hash!==null&&side.sourcePath)conflictOriginals.push({path:side.path,hash:side.hash,size:side.size,mtime:Date.now(),sourcePath:side.sourcePath});const replayUploads=[...new Map([...Object.values(priorEntries),...conflictOriginals].filter(entry=>!remoteHashes.has(entry.hash)&&!proposalHashes.has(entry.hash)).map(entry=>[entry.hash,entry])).values()];
    const uploadTotal=entries.filter(entry=>!remoteHashes.has(entry.hash)).length+replayUploads.length;
    let preparedBatch:PreparedBatch|null=null;
    if(operationTree){
      const batch=await buildOperationBatch(operationTree,entries,folders,observedIntents,conflicts?`Sync with ${conflicts} preserved conflicts`:"Sync",()=>crypto.randomUUID(),new Map(folderPlan?.folders.map(folder=>[folder.path,folder.folderId])??[]),new Set(operationTree.folders.filter(folder=>!this.managedTopLevelFolder(folder.path)||!this.include(folder.path)).map(folder=>folder.path)),()=>this.cooperate(true));
      for(const entry of entries){const existing=final.get(entry.path);if(existing)existing.fileId=entry.fileId;}
      const prepared:PreparedBatch={batch,phase:"prepared",intentSequence:observedIntents.reduce((maximum,event)=>Math.max(maximum,event.sequence),0),priorHashes:Object.fromEntries([...applyPaths].map(path=>[path,physicalLocal.get(path)?.hash??null])),priorEntries};if(usesOperations)preparedBatch=prepared;
      await this.operations.save(prepared);this.checkpoint();
    }
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
    if(!preparedBatch)settings.pendingCommit={parentId:remoteSnapshot?.id??null,fingerprint:await commitFingerprint(entries,folders),priorHashes:Object.fromEntries([...applyPaths].map(path=>[path,physicalLocal.get(path)?.hash??null])),priorEntries,intentSequence:observedIntents.reduce((maximum,event)=>Math.max(maximum,event.sequence),0)};
    await this.saveSettings();this.checkpoint();
    try{if(preparedBatch){preparedBatch.phase="submitted";await this.operations.save(preparedBatch);this.checkpoint();const receipt=await this.api.operationBatch(preparedBatch.batch);this.assertOwnedReceipt(receipt,preparedBatch.batch);if(receipt.batchId!==preparedBatch.batch.batchId)throw new SyncSafetyError("The accepted operation receipt has the wrong batch identity");preparedBatch={...preparedBatch,phase:"accepted",receipt};await this.operations.save(preparedBatch);snapshot=receipt.snapshot;}else snapshot=await this.api.commit({ parentId: remoteSnapshot?.id ?? null, message: conflicts ? `Sync with ${conflicts} preserved conflict${conflicts === 1 ? "" : "s"}` : "Sync", entries,folders,...folderPlan?{folderEntries:folderPlan.folders}:{},
      clientTime:new Date().toISOString(),signals:{highEntropyPaths,deviceLocalCleanupPaths,vaultIdentity:settings.vaultIdentity,staleBaseline:Boolean(baseSnapshot&&remoteSnapshot&&baseSnapshot.id!==remoteSnapshot.id)} });}
    catch(error){if(error instanceof ApiError&&error.status>=400&&error.status<500&&error.status!==408&&error.status!==423){if(preparedBatch)await this.operations.clear();settings.pendingCommit=null;await this.saveSettings();}if(error instanceof ApiError&&error.status===409)return this.convergeAfterConflict(attempt,"Another device committed at the same time");throw error;}
    this.checkpoint();
    await this.publishPendingConflicts(snapshot);this.checkpoint();
    const topologyFolders=new Set([...folders,...this.acceptedFolders(entries.map((entry)=>entry.path))]),applied=await this.stageAndApply(snapshot.id,final,topologyFolders,physicalLocal,desktopOnlyPlugins,scanned,orphanUnreadableConflicts,bytes,remoteCache,snapshot.folderRepair,snapshot.createdAt),downloaded=applied.downloaded,deleted=applied.deleted;prunedFolders+=applied.prunedFolders;let mirrored:number;
    try{mirrored=clientCanMirrorAll?await this.mirror(snapshot.id,entries,final,bytes,remoteCache):0;}
    catch(error){if(this.retryableMirrorError(error))return this.convergeAfterConflict(attempt,"The commit succeeded and another device advanced the vault during mirroring");throw error;}
    this.status({phase:"complete",message:conflicts ? `Synced · ${conflicts} conflict${conflicts === 1 ? "" : "s"} preserved` : "Sync complete · this device matches the accepted snapshot"});
    if(fullScan&&!settings.retiredFolderCount){settings.fullScanRequired=false;settings.lastFullScanAt=new Date().toISOString();await this.saveSettings();}
    this.acknowledgeMoves(consumedMoves,entries);await this.saveSettings();
    await this.intents.acknowledge(preparedBatch?.intentSequence??observedIntents.reduce((maximum,event)=>Math.max(maximum,event.sequence),0));if(operationTree)await this.operations.clear();
    return { uploaded, downloaded, deleted, prunedFolders,pendingRetiredFolders:settings.retiredFolderCount, conflicts, resolved, mirrored, snapshotId: settings.lastSnapshotId,processedPaths:pendingPaths,fullScan,pendingPackages:Object.keys(settings.packageHolds) };
  }
}
