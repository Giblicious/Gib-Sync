import { normalizePath, type DataAdapter } from "obsidian";
import { detectMoves, type ManifestEntry, type Snapshot } from "@gib-sync/protocol";
import { ApiError, GibSyncApi } from "./api";
import { decryptBlob, encryptBlob, hashBytes } from "./crypto";
import { mergeText } from "./merge";
import { isDeviceLocalObsidianPath, isGibSyncConflictPath, isObsidianSystemPath, isPluginDataPath, obsidianPluginPath, shouldSyncChangedPath, type GibSyncSettings, type SyncPhase } from "./settings";
import { mergeSystemJson } from "./system-merge";

type FileState = ManifestEntry & { bytes?: Uint8Array; sourcePath?:string };
type LocalScan = { files:Map<string,FileState>; unreadableConflictPaths:Set<string> };
const TEXT_EXTENSIONS = new Set(["md","txt","canvas","json","jsonl","css","js","ts","yaml","yml","xml","csv","svg","html"]);
const decoder = new TextDecoder(); const encoder = new TextEncoder();
export const LOW_MEMORY_DOWNLOAD_BYTES=8*1024*1024;

function exactArrayBuffer(bytes:Uint8Array):ArrayBuffer{
  if(bytes.buffer instanceof ArrayBuffer&&bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength)return bytes.buffer;
  return bytes.slice().buffer;
}

export interface SyncResult { uploaded: number; downloaded: number; deleted: number; conflicts: number; resolved:number; mirrored:number; snapshotId: string | null; processedPaths:string[]; fullScan:boolean; }
export interface SyncProgress { phase:SyncPhase; message:string; current?:number; total?:number; level?:"info"|"success"|"warning"|"error"; }
export class SyncSafetyError extends Error { override readonly name="SyncSafetyError"; }
export class FileChangedDuringReadError extends Error {
  override readonly name="FileChangedDuringReadError";
  constructor(readonly path:string){super(`${path} changed while Gib Sync was reading it. It was not uploaded; sync will retry with the newer saved version.`);}
}

export class SyncEngine {
  private running: Promise<SyncResult> | null = null;
  constructor(
    private readonly adapter: DataAdapter,
    private readonly api: GibSyncApi,
    private readonly getSettings: () => GibSyncSettings,
    private readonly saveSettings: () => Promise<void>,
    private readonly status: (progress: SyncProgress) => void,
    private readonly wait: (milliseconds:number) => Promise<void> = (milliseconds) => new Promise((resolve)=>window.setTimeout(resolve,milliseconds)),
    private readonly expectLocalMutation:(path:string,hash:string|null)=>void=()=>{}
  ) {}

  sync(): Promise<SyncResult> {
    if (this.running) return this.running;
    this.running = this.run(0).finally(() => { this.running = null; }); return this.running;
  }

  async restoreAcceptedSnapshot():Promise<{downloaded:number;deleted:number}>{
    const settings=this.getSettings();if(!settings.deviceToken||!settings.vaultKey)throw new Error("Gib Sync is not configured");
    const scanned=await this.scan(),local=scanned.files,head=(await this.api.state()).head,remote=this.map(head),cache=new Map<string,Uint8Array>();for(const path of scanned.unreadableConflictPaths){const accepted=remote.get(path);if(accepted)local.set(path,accepted);}let downloaded=0,deleted=0;
    for(const [path,entry] of remote){if(local.get(path)?.hash===entry.hash)continue;const clear=await this.remoteBytes(entry,cache);await this.ensureParent(path);this.expectLocalMutation(path,entry.hash);await this.adapter.writeBinary(path,exactArrayBuffer(clear));downloaded++;}
    for(const path of local.keys())if(!remote.has(path)&&this.include(path)){this.expectLocalMutation(path,null);await this.adapter.remove(path);deleted++;}
    settings.lastSnapshotId=head?.id??null;settings.initialized=true;await this.saveSettings();return {downloaded,deleted};
  }

  private entropy(bytes:Uint8Array):number{
    if(bytes.length<1024)return 0;const counts=new Uint32Array(256);for(const value of bytes)counts[value]++;let result=0;
    for(const count of counts)if(count){const probability=count/bytes.length;result-=probability*Math.log2(probability);}return result;
  }

  private include(path: string): boolean {
    return shouldSyncChangedPath(normalizePath(path),this.getSettings());
  }

  private async listFiles(path = ""): Promise<string[]> {
    const listing = await this.adapter.list(path); const files = listing.files.filter((file) => this.include(file));
    for (const folder of listing.folders.filter((item) => this.include(item))) files.push(...await this.listFiles(folder));
    return files;
  }

  private async scan(): Promise<LocalScan> {
    const output = new Map<string, FileState>(),unreadableConflictPaths=new Set<string>();
    const paths = await this.listFiles(); let current = 0;
    for (const path of paths) {
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
      this.status({phase:"scanning",message:"Checking changed files",current,total:changedPaths.length});
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
  private async preservePair(path:string,local:FileState,localBytes:Uint8Array,remote:FileState,localName:string,remoteName:string,final:Map<string,FileState>,bytes:Map<string,Uint8Array>,remoteCache:Map<string,Uint8Array>,occupied:Set<string>):Promise<void>{
    const remoteBytes=await this.remoteBytes(remote,remoteCache);
    const localIsNewer=local.mtime>=remote.mtime;
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
  private canonicalizeMoves(base:Map<string,FileState>,local:Map<string,FileState>,remote:Map<string,FileState>):number{
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
      if(localDestination&&remoteDestination&&localDestination!==remoteDestination)destination=(l?.mtime??0)>(r?.mtime??0)?localDestination:remoteDestination;
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
  private packageMtime(entries:Map<string,FileState>):number{return Math.max(0,...[...entries.values()].map((entry)=>entry.mtime));}
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
  private retryableMirrorError(error:unknown):boolean{return error instanceof ApiError&&(error.status===409||error.status===422);}

  private async mirror(snapshotId:string,entries:ManifestEntry[],final:Map<string,FileState>,bytes:Map<string,Uint8Array>,remoteCache:Map<string,Uint8Array>):Promise<number>{
    this.status({phase:"mirroring",message:"Planning the readable Seafile recovery copy"});const plan=await this.api.mirrorPlan(snapshotId,entries);if(plan.alreadyCurrent)return 0;
    let mirrored=0;for(const path of plan.uploadPaths){const entry=final.get(path);if(!entry)throw new Error(`Mirror plan referenced missing path: ${path}`);const clear=bytes.get(entry.hash)??await this.remoteBytes(entry,remoteCache);if(entry.size<LOW_MEMORY_DOWNLOAD_BYTES)bytes.set(entry.hash,clear);
      await this.api.putMirrorFile(snapshotId,path,entry.hash,clear);if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES){bytes.delete(entry.hash);remoteCache.delete(entry.hash);}mirrored++;this.status({phase:"mirroring",message:`Writing readable recovery files (${mirrored}/${plan.uploadPaths.length})`,current:mirrored,total:plan.uploadPaths.length});}
    await this.api.mirrorComplete(snapshotId);this.status({phase:"mirroring",message:`Readable recovery copy is current · ${entries.length} files`});return mirrored;
  }

  private async run(attempt: number): Promise<SyncResult> {
    const settings = this.getSettings(); if (!settings.deviceToken || !settings.vaultKey) throw new Error("Gib Sync is not configured");
    const requestedBaseId=settings.lastSnapshotId;
    const pendingPaths=[...new Set(settings.pendingPaths.map((path)=>normalizePath(path)).filter(Boolean))];
    const lastAudit=settings.lastFullScanAt?Date.parse(settings.lastFullScanAt):0,auditDue=!lastAudit||Date.now()-lastAudit>=6*60*60*1000;
    this.status({phase:"reading-remote",message:"Checking for a newer server snapshot"});
    let remoteHeadId:string|null;
    try{remoteHeadId=(await this.api.headState()).headId;}catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;remoteHeadId=(await this.api.state()).head?.id??null;}
    if(settings.initialized&&!settings.fullScanRequired&&!auditDue&&!pendingPaths.length&&remoteHeadId===requestedBaseId){
      this.status({phase:"up-to-date",message:"Up to date · no local or server changes"});
      return {uploaded:0,downloaded:0,deleted:0,conflicts:0,resolved:0,mirrored:0,snapshotId:requestedBaseId,processedPaths:[],fullScan:false};
    }
    const remoteSnapshot=(await this.api.state()).head;
    const baseSnapshot = requestedBaseId ? await this.api.snapshot(requestedBaseId).catch(() => null) : null;
    const fullScan=settings.fullScanRequired||!settings.initialized||!baseSnapshot||auditDue;
    this.status({phase:"scanning",message:fullScan?"Reconciling the full local vault":pendingPaths.length?`Checking ${pendingPaths.length} changed path${pendingPaths.length===1?"":"s"}`:"No local paths changed"});
    const scanned=fullScan?await this.scan():await this.scanIncremental(baseSnapshot!,pendingPaths),local=scanned.files;
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
    const base = this.map(baseSnapshot), remote = this.map(remoteSnapshot);for(const path of scanned.unreadableConflictPaths){const accepted=base.get(path)??remote.get(path);if(accepted)local.set(path,accepted);} const orphanUnreadableConflicts=[...scanned.unreadableConflictPaths].filter((path)=>!base.has(path)&&!remote.has(path)),physicalLocal=new Map(local),recognizedMoves=this.canonicalizeMoves(base,local,remote),final = new Map<string, FileState>();
    const bytes = new Map<string, Uint8Array>(); const remoteCache = new Map<string, Uint8Array>();
    const paths = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);const occupied=new Set(paths);
    let conflicts = 0,resolved=0; this.status({phase:"merging",message:`Comparing ${paths.size} paths · ${local.size} local · ${remote.size} remote · ${base.size} baseline`});
    if(recognizedMoves)this.status({phase:"merging",message:`Recognized ${recognizedMoves} file move${recognizedMoves===1?"":"s"} by content identity; edits will follow the destination`,level:"success"});
    const handledPluginPaths=new Set<string>();
    if(settings.syncPlugins){
      const pluginIds=new Set([...paths].map((path)=>obsidianPluginPath(path)?.id).filter((id):id is string=>Boolean(id)));
      const packageFor=(source:Map<string,FileState>,id:string)=>new Map([...source].filter(([path])=>{const plugin=obsidianPluginPath(path);return plugin?.id===id&&!isPluginDataPath(path);}));
      const versionFor=async(source:"local"|"remote",entries:Map<string,FileState>,id:string):Promise<string|null>=>{
        const entry=entries.get(`.obsidian/plugins/${id}/manifest.json`);if(!entry)return null;
        try{const clear=source==="local"?await this.localBytes(entry.path,entry,bytes):await this.remoteBytes(entry,remoteCache);return (JSON.parse(decoder.decode(clear)) as {version?:unknown}).version as string??null;}catch{return null;}
      };
      for(const id of [...pluginIds].sort()){
        const baseline=packageFor(base,id),localPackage=packageFor(local,id),remotePackage=packageFor(remote,id);
        for(const path of new Set([...baseline.keys(),...localPackage.keys(),...remotePackage.keys()]))handledPluginPaths.add(path);
        const localChanged=!this.packageSame(localPackage,baseline),remoteChanged=!this.packageSame(remotePackage,baseline);
        let chosen=remotePackage,side:"local"|"remote"="remote",reason="both devices already agree";
        const localVersion=await versionFor("local",localPackage,id),remoteVersion=await versionFor("remote",remotePackage,id);
        if(this.packageSame(localPackage,remotePackage)){chosen=remotePackage;}
        else if(!localPackage.size||!remotePackage.size){
          if(localChanged&&!remoteChanged){chosen=localPackage;side="local";reason=localPackage.size?"this device installed the package":"this device removed the package";}
          else if(!localChanged&&remoteChanged){reason=remotePackage.size?"the server installed the package":"the server removed the package";}
          else{const useLocal=this.packageMtime(localPackage)>this.packageMtime(remotePackage);side=useLocal?"local":"remote";chosen=useLocal?localPackage:remotePackage;reason=`concurrent install/removal used the later ${side} package`;resolved++;}
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
          else if(this.packageMtime(localPackage)>this.packageMtime(remotePackage)){side="local";chosen=localPackage;reason="same plugin version; local package was modified later";resolved++;}
          else{reason="same plugin version; server package was modified later";resolved++;}
        }
        for(const [path,entry] of chosen)final.set(path,entry);
        if(localChanged||remoteChanged)this.status({phase:"merging",message:`Plugin package · ${id} · chose ${side}${(side==="local"?localVersion:remoteVersion)?` v${side==="local"?localVersion:remoteVersion}`:""} · ${reason}`,level:"info"});
      }
    }
    for (const path of [...paths].sort()) {
      if(handledPluginPaths.has(path))continue;
      const b = base.get(path), l = local.get(path), r = remote.get(path);
      if (this.same(l, r)) { if (l) final.set(path, l); continue; }
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
          const preferred=l.mtime>=r.mtime?"local":"remote";
          if(path.toLowerCase().endsWith(".json")){
            const baseText=b?decoder.decode(await this.remoteBytes(b,remoteCache)):"{}",localText=decoder.decode(await this.localBytes(path,l,bytes)),remoteText=decoder.decode(await this.remoteBytes(r,remoteCache));
            const merged=mergeSystemJson(baseText,localText,remoteText,preferred),clear=encoder.encode(merged.text),hash=await hashBytes(clear);bytes.set(hash,clear);final.set(path,{path,hash,size:clear.length,mtime:Date.now(),bytes:clear});
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
          conflicts++;await this.preservePair(path,l,await this.localBytes(path,l,bytes),r,settings.deviceName,remoteSnapshot?.deviceName??"Remote device",final,bytes,remoteCache,occupied);continue;
        }
        const baseText = b ? decoder.decode(await this.remoteBytes(b, remoteCache)) : "";
        const localText = decoder.decode(await this.localBytes(path,l,bytes)); const remoteText = decoder.decode(await this.remoteBytes(r, remoteCache));
        const preferred=l.mtime>=r.mtime?"local":"remote";
        this.status({phase:"merging",message:`Three-way merge · ${path} · base ${b?.size??0} B · local ${l.size} B · remote ${r.size} B`});
        const merged = mergeText(baseText, localText, remoteText, preferred);
        if(merged.kind==="large-conflict"||merged.kind==="merge-fallback"){
          const reason=merged.kind==="merge-fallback"?merged.reason??"merge engine fallback":`${merged.overlapWords} overlapping words across ${merged.overlapLines} lines`;
          console.warn("Gib Sync preserved both versions after merge fallback",{path,reason,baseBytes:b?.size??0,localBytes:l.size,remoteBytes:r.size});
          this.status({phase:"merging",message:`Preserving both · ${path} · ${reason}`,level:"warning"});
          conflicts++;await this.preservePair(path,l,await this.localBytes(path,l,bytes),r,settings.deviceName,remoteSnapshot?.deviceName??"Remote device",final,bytes,remoteCache,occupied);continue;
        }
        this.status({phase:"merging",message:merged.kind==="small-overlap"?`Resolved small overlap · ${path} · preferred ${preferred} version`:`Merged non-overlapping edits · ${path}`,level:"success"});
        const mergedBytes = encoder.encode(merged.text); const hash = await hashBytes(mergedBytes); bytes.set(hash, mergedBytes);
        final.set(path, { path, hash, size: mergedBytes.length, mtime: Date.now(), bytes: mergedBytes });
        continue;
      }
      // A binary conflict never destroys either side; the newest stays at the intended path.
      conflicts++;
      if(l&&r)await this.preservePair(path,l,await this.localBytes(path,l,bytes),r,settings.deviceName,remoteSnapshot?.deviceName??"Remote device",final,bytes,remoteCache,occupied);
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

    let downloaded = 0, deleted = 0;
    this.status({phase:"applying",message:"Applying merged changes to this device"});
    const applyOrder=[...final].sort(([left,leftEntry],[right,rightEntry])=>{
      const rank=(path:string,entry:FileState)=>path===".obsidian/community-plugins.json"?4:entry.size>=LOW_MEMORY_DOWNLOAD_BYTES?3:obsidianPluginPath(path)?0:isObsidianSystemPath(path)?2:1;
      return rank(left,leftEntry)-rank(right,rightEntry)||left.localeCompare(right);
    });
    for (const [path, entry] of applyOrder) {
      if (physicalLocal.get(path)?.hash === entry.hash) continue;
      if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES)this.status({phase:"applying",message:`Downloading large file with mobile-safe memory use · ${path} · ${(entry.size/1024/1024).toFixed(1)} MB`,current:downloaded,total:applyOrder.length});
      const clear = bytes.get(entry.hash) ?? await this.remoteBytes(entry, remoteCache);if(entry.size<LOW_MEMORY_DOWNLOAD_BYTES)bytes.set(entry.hash,clear);
      await this.ensureParent(path);this.expectLocalMutation(path,entry.hash);await this.adapter.writeBinary(path,exactArrayBuffer(clear));if(entry.size>=LOW_MEMORY_DOWNLOAD_BYTES){bytes.delete(entry.hash);remoteCache.delete(entry.hash);} downloaded++;
    }
    for (const path of physicalLocal.keys()) if (!final.has(path) && this.include(path)) {
      if(scanned.unreadableConflictPaths.has(path)){
        this.status({phase:"applying",message:`Left inaccessible generated conflict entry isolated on this device · ${path}`,level:"warning"});
        continue;
      }
      this.expectLocalMutation(path,null);await this.adapter.remove(path); deleted++;
    }
    for(const path of orphanUnreadableConflicts){
      try{this.expectLocalMutation(path,null);await this.adapter.remove(path);deleted++;this.status({phase:"applying",message:`Removed orphaned generated conflict copy after its handle released · ${path}`,level:"success"});}
      catch{this.status({phase:"applying",message:`Generated conflict copy is still locked locally and absent from the accepted vault · ${path} · it will be retried without upload`,level:"warning"});}
    }

    // An ignored path is device-local: keep its accepted remote manifest entry
    // even though this device neither reads nor writes the file. This is
    // essential when phones intentionally omit desktop-only plugins.
    const preservedIgnored=(remoteSnapshot?.entries??[]).filter((entry)=>!this.include(entry.path)&&!isDeviceLocalObsidianPath(entry.path));
    const entries = [...final.values(),...preservedIgnored].map(({path,hash,size,mtime}) => ({path,hash,size,mtime})).sort((a,b)=>a.path.localeCompare(b.path));
    const remoteEntries = [...(remoteSnapshot?.entries??[])].map(({path,hash,size,mtime}) => ({path,hash,size,mtime})).sort((a,b)=>a.path.localeCompare(b.path));
    const clientCanMirrorAll=!preservedIgnored.length;
    const unchanged = entries.length === remoteEntries.length && entries.every((entry, i) => entry.path === remoteEntries[i].path && entry.hash === remoteEntries[i].hash);
    if (unchanged) {
      settings.lastSnapshotId = remoteSnapshot?.id ?? null; settings.initialized = true; await this.saveSettings();let mirrored=0;
      try{mirrored=remoteSnapshot&&clientCanMirrorAll?await this.mirror(remoteSnapshot.id,entries,final,bytes,remoteCache):0;}
      catch(error){if(this.retryableMirrorError(error))return this.convergeAfterConflict(attempt,"Another device advanced the vault during mirror verification");throw error;}
      this.status({phase:"up-to-date",message:"Up to date · readable recovery copy verified"});
      if(fullScan){settings.fullScanRequired=false;settings.lastFullScanAt=new Date().toISOString();await this.saveSettings();}
      return { uploaded: 0, downloaded, deleted, conflicts, resolved, mirrored, snapshotId: settings.lastSnapshotId,processedPaths:pendingPaths,fullScan };
    }

    if(!settings.initialized&&remoteSnapshot){
      this.status({phase:"committing",message:onboardingReconcile?"Verifying the matched server baseline before publishing the union":"Verifying the first download before cleaning device-local workspace state"});
      try{await this.api.markDeviceReady(remoteSnapshot.id);}
      catch(error){if(error instanceof ApiError&&error.status===409)return this.convergeAfterConflict(attempt,"The server vault changed during onboarding verification");throw error;}
    }

    this.status({phase:"uploading",message:"Preparing encrypted uploads"}); let uploaded = 0;
    for (const entry of entries) {
      if(remoteEntries.some((remoteEntry)=>remoteEntry.hash===entry.hash))continue;
      const localEntry=local.get(entry.path);const clear=bytes.get(entry.hash)??(localEntry?.hash===entry.hash?await this.localBytes(entry.path,localEntry,bytes):undefined);if(!clear)throw new Error(`Unable to prepare changed file ${entry.path}`);
      await this.api.putBlob(entry.hash, await encryptBlob(clear, settings.vaultKey, entry.hash)); uploaded++;
      this.status({phase:"uploading",message:`Uploaded ${uploaded} encrypted file${uploaded===1?"":"s"}`,current:uploaded});
    }
    this.status({phase:"committing",message:"Committing an atomic snapshot"});
    let snapshot:Snapshot;
    const highEntropyPaths=entries.filter((entry)=>this.text(entry.path)&&!remoteEntries.some((remoteEntry)=>remoteEntry.path===entry.path&&remoteEntry.hash===entry.hash))
      .filter((entry)=>{const clear=bytes.get(entry.hash);return clear?this.entropy(clear)>7.2:false;}).map((entry)=>entry.path);
    const deviceLocalCleanupPaths=remoteEntries.filter((entry)=>isDeviceLocalObsidianPath(entry.path)&&!entries.some((next)=>next.path===entry.path)).slice(0,5000).map((entry)=>entry.path);
    try{snapshot=await this.api.commit({ parentId: remoteSnapshot?.id ?? null, message: conflicts ? `Sync with ${conflicts} preserved conflict${conflicts === 1 ? "" : "s"}` : "Sync", entries,
      clientTime:new Date().toISOString(),signals:{highEntropyPaths,deviceLocalCleanupPaths,vaultIdentity:settings.vaultIdentity,staleBaseline:Boolean(baseSnapshot&&remoteSnapshot&&baseSnapshot.id!==remoteSnapshot.id)} });}
    catch(error){if(error instanceof ApiError&&error.status===409)return this.convergeAfterConflict(attempt,"Another device committed at the same time");throw error;}
    settings.lastSnapshotId = snapshot.id; settings.initialized = true; await this.saveSettings();let mirrored:number;
    try{mirrored=clientCanMirrorAll?await this.mirror(snapshot.id,entries,final,bytes,remoteCache):0;}
    catch(error){if(this.retryableMirrorError(error))return this.convergeAfterConflict(attempt,"The commit succeeded and another device advanced the vault during mirroring");throw error;}
    this.status({phase:"complete",message:conflicts ? `Synced · ${conflicts} conflict${conflicts === 1 ? "" : "s"} preserved` : "Sync complete · readable recovery copy current"});
    if(fullScan){settings.fullScanRequired=false;settings.lastFullScanAt=new Date().toISOString();await this.saveSettings();}
    return { uploaded, downloaded, deleted, conflicts, resolved, mirrored, snapshotId: settings.lastSnapshotId,processedPaths:pendingPaths,fullScan };
  }
}
