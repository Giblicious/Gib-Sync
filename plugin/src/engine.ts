import { normalizePath, type DataAdapter } from "obsidian";
import type { ManifestEntry, Snapshot } from "@gib-sync/protocol";
import { ApiError, GibSyncApi } from "./api";
import { decryptBlob, encryptBlob, hashBytes } from "./crypto";
import { mergeText } from "./merge";
import { shouldSyncChangedPath, type GibSyncSettings, type SyncPhase } from "./settings";

type FileState = ManifestEntry & { bytes?: Uint8Array };
const TEXT_EXTENSIONS = new Set(["md","txt","canvas","json","jsonl","css","js","ts","yaml","yml","xml","csv","svg","html"]);
const decoder = new TextDecoder(); const encoder = new TextEncoder();

export interface SyncResult { uploaded: number; downloaded: number; deleted: number; conflicts: number; mirrored:number; snapshotId: string | null; }
export interface SyncProgress { phase:SyncPhase; message:string; current?:number; total?:number; }

export class SyncEngine {
  private running: Promise<SyncResult> | null = null;
  constructor(
    private readonly adapter: DataAdapter,
    private readonly api: GibSyncApi,
    private readonly getSettings: () => GibSyncSettings,
    private readonly saveSettings: () => Promise<void>,
    private readonly status: (progress: SyncProgress) => void,
    private readonly wait: (milliseconds:number) => Promise<void> = (milliseconds) => new Promise((resolve)=>window.setTimeout(resolve,milliseconds))
  ) {}

  sync(): Promise<SyncResult> {
    if (this.running) return this.running;
    this.running = this.run(0).finally(() => { this.running = null; }); return this.running;
  }

  async restoreAcceptedSnapshot():Promise<{downloaded:number;deleted:number}>{
    const settings=this.getSettings();if(!settings.deviceToken||!settings.vaultKey)throw new Error("Gib Sync is not configured");
    const local=await this.scan(),head=(await this.api.state()).head,remote=this.map(head),cache=new Map<string,Uint8Array>();let downloaded=0,deleted=0;
    for(const [path,entry] of remote){if(local.get(path)?.hash===entry.hash)continue;const clear=await this.remoteBytes(entry,cache);await this.ensureParent(path);await this.adapter.writeBinary(path,clear.slice().buffer);downloaded++;}
    for(const path of local.keys())if(!remote.has(path)&&this.include(path)){await this.adapter.remove(path);deleted++;}
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

  private async scan(): Promise<Map<string, FileState>> {
    const output = new Map<string, FileState>();
    const paths = await this.listFiles(); let current = 0;
    for (const path of paths) {
      const bytes = new Uint8Array(await this.adapter.readBinary(path)); const stat = await this.adapter.stat(path);
      // Retain metadata rather than every file body. Mobile WebViews have much
      // tighter memory limits, so changed content is read lazily when required.
      output.set(path, { path, hash: await hashBytes(bytes), size: bytes.length, mtime: stat?.mtime ?? Date.now() });
      current++; if (current===1 || current===paths.length || current%25===0) this.status({phase:"scanning",message:`Scanning local vault (${current}/${paths.length})`,current,total:paths.length});
    }
    return output;
  }

  private map(snapshot: Snapshot | null): Map<string, FileState> {
    return new Map((snapshot?.entries ?? []).filter((entry) => this.include(entry.path)).map((entry) => [entry.path, { ...entry }]));
  }
  private async localBytes(path:string,entry:FileState,cache:Map<string,Uint8Array>):Promise<Uint8Array>{
    const cached=cache.get(entry.hash);if(cached)return cached;
    const clear=new Uint8Array(await this.adapter.readBinary(path));
    if(await hashBytes(clear)!==entry.hash)throw new Error(`${path} changed while Gib Sync was reading it. It was not uploaded; sync will retry with the newer saved version.`);
    cache.set(entry.hash,clear);return clear;
  }

  private async remoteBytes(entry: FileState, cache: Map<string, Uint8Array>): Promise<Uint8Array> {
    const existing = cache.get(entry.hash); if (existing) return existing;
    const encrypted = await this.api.getBlob(entry.hash); const bytes = await decryptBlob(encrypted, this.getSettings().vaultKey, entry.hash);
    cache.set(entry.hash, bytes); return bytes;
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
  private async convergeAfterConflict(attempt:number,reason:string):Promise<SyncResult>{
    if(attempt>=7)throw new Error("The vault kept changing during eight convergence attempts. Gib Sync preserved every committed version; retry once editing settles.");
    const delay=Math.min(2000,100*(2**attempt))+Math.floor(Math.random()*250);
    this.status({phase:"merging",message:`${reason}; converging again in ${(delay/1000).toFixed(1)}s`});
    await this.wait(delay);return this.run(attempt+1);
  }
  private retryableMirrorError(error:unknown):boolean{return error instanceof ApiError&&(error.status===409||error.status===422);}

  private async mirror(snapshotId:string,entries:ManifestEntry[],final:Map<string,FileState>,bytes:Map<string,Uint8Array>,remoteCache:Map<string,Uint8Array>):Promise<number>{
    this.status({phase:"mirroring",message:"Planning the readable Seafile recovery copy"});const plan=await this.api.mirrorPlan(snapshotId,entries);if(plan.alreadyCurrent)return 0;
    let mirrored=0;for(const path of plan.uploadPaths){const entry=final.get(path);if(!entry)throw new Error(`Mirror plan referenced missing path: ${path}`);const clear=bytes.get(entry.hash)??await this.remoteBytes(entry,remoteCache);bytes.set(entry.hash,clear);
      await this.api.putMirrorFile(snapshotId,path,entry.hash,clear);mirrored++;this.status({phase:"mirroring",message:`Writing readable recovery files (${mirrored}/${plan.uploadPaths.length})`,current:mirrored,total:plan.uploadPaths.length});}
    await this.api.mirrorComplete(snapshotId);this.status({phase:"mirroring",message:`Readable recovery copy is current · ${entries.length} files`});return mirrored;
  }

  private async run(attempt: number): Promise<SyncResult> {
    const settings = this.getSettings(); if (!settings.deviceToken || !settings.vaultKey) throw new Error("Gib Sync is not configured");
    this.status({phase:"scanning",message:"Listing local vault files"}); const local = await this.scan();
    this.status({phase:"reading-remote",message:"Reading the remote snapshot"}); const remoteSnapshot = (await this.api.state()).head;
    const requestedBaseId=settings.lastSnapshotId;
    const baseSnapshot = requestedBaseId ? await this.api.snapshot(requestedBaseId).catch(() => null) : null;
    if(settings.initialized&&requestedBaseId&&!baseSnapshot&&local.size){
      throw new Error("Stale-device protection paused sync because this device's last verified server snapshot is unavailable. No files were uploaded or deleted. Reconnect this device to establish a safe baseline.");
    }
    if(remoteSnapshot&&!baseSnapshot&&local.size){
      const remoteHashes=new Map(remoteSnapshot.entries.map((entry)=>[entry.path,entry.hash]));
      const unexpected=[...local.values()].filter((entry)=>remoteHashes.get(entry.path)!==entry.hash);
      if(unexpected.length)throw new Error(`Onboarding protection paused sync because this server vault already has history and the local vault contains ${unexpected.length} unverified file${unexpected.length===1?"":"s"}. No files were uploaded or deleted. Verify that you opened the intended local and server vaults.`);
    }
    const base = this.map(baseSnapshot), remote = this.map(remoteSnapshot); const final = new Map<string, FileState>();
    const bytes = new Map<string, Uint8Array>(); const remoteCache = new Map<string, Uint8Array>();
    const paths = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);const occupied=new Set(paths);
    let conflicts = 0; this.status({phase:"merging",message:`Comparing ${paths.size} paths`});
    for (const path of [...paths].sort()) {
      const b = base.get(path), l = local.get(path), r = remote.get(path);
      if (this.same(l, r)) { if (l) final.set(path, l); continue; }
      if (!settings.initialized && !b && !l && r) { final.set(path, r); continue; }
      if (this.same(l, b)) { if (r) final.set(path, r); continue; }
      if (this.same(r, b)) { if (l) final.set(path, l); continue; }
      if (!b && l && !r) { final.set(path, l); continue; }
      if (!b && !l && r) { final.set(path, r); continue; }
      if (!l && !r) continue;
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
        const merged = mergeText(baseText, localText, remoteText, preferred);
        if(merged.kind==="large-conflict"){
          conflicts++;await this.preservePair(path,l,await this.localBytes(path,l,bytes),r,settings.deviceName,remoteSnapshot?.deviceName??"Remote device",final,bytes,remoteCache,occupied);continue;
        }
        const mergedBytes = encoder.encode(merged.text); const hash = await hashBytes(mergedBytes); bytes.set(hash, mergedBytes);
        final.set(path, { path, hash, size: mergedBytes.length, mtime: Date.now(), bytes: mergedBytes });
        continue;
      }
      // A binary conflict never destroys either side; the newest stays at the intended path.
      conflicts++;
      if(l&&r)await this.preservePair(path,l,await this.localBytes(path,l,bytes),r,settings.deviceName,remoteSnapshot?.deviceName??"Remote device",final,bytes,remoteCache,occupied);
    }

    let downloaded = 0, deleted = 0;
    this.status({phase:"applying",message:"Applying merged changes to this device"});
    for (const [path, entry] of final) {
      if (local.get(path)?.hash === entry.hash) continue;
      const clear = bytes.get(entry.hash) ?? await this.remoteBytes(entry, remoteCache); bytes.set(entry.hash, clear);
      await this.ensureParent(path); await this.adapter.writeBinary(path, clear.slice().buffer); downloaded++;
    }
    for (const path of local.keys()) if (!final.has(path) && this.include(path)) { await this.adapter.remove(path); deleted++; }

    // An ignored path is device-local: keep its accepted remote manifest entry
    // even though this device neither reads nor writes the file. This is
    // essential when phones intentionally omit desktop-only plugins.
    const preservedIgnored=(remoteSnapshot?.entries??[]).filter((entry)=>!this.include(entry.path));
    const entries = [...final.values(),...preservedIgnored].map(({path,hash,size,mtime}) => ({path,hash,size,mtime})).sort((a,b)=>a.path.localeCompare(b.path));
    const remoteEntries = [...(remoteSnapshot?.entries??[])].map(({path,hash,size,mtime}) => ({path,hash,size,mtime})).sort((a,b)=>a.path.localeCompare(b.path));
    const clientCanMirrorAll=!preservedIgnored.length;
    const unchanged = entries.length === remoteEntries.length && entries.every((entry, i) => entry.path === remoteEntries[i].path && entry.hash === remoteEntries[i].hash);
    if (unchanged) {
      settings.lastSnapshotId = remoteSnapshot?.id ?? null; settings.initialized = true; await this.saveSettings();let mirrored=0;
      try{mirrored=remoteSnapshot&&clientCanMirrorAll?await this.mirror(remoteSnapshot.id,entries,final,bytes,remoteCache):0;}
      catch(error){if(this.retryableMirrorError(error))return this.convergeAfterConflict(attempt,"Another device advanced the vault during mirror verification");throw error;}
      this.status({phase:"up-to-date",message:"Up to date · readable recovery copy verified"});
      return { uploaded: 0, downloaded, deleted, conflicts, mirrored, snapshotId: settings.lastSnapshotId };
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
    try{snapshot=await this.api.commit({ parentId: remoteSnapshot?.id ?? null, message: conflicts ? `Sync with ${conflicts} preserved conflict${conflicts === 1 ? "" : "s"}` : "Sync", entries,
      clientTime:new Date().toISOString(),signals:{highEntropyPaths,vaultIdentity:settings.vaultIdentity,staleBaseline:Boolean(baseSnapshot&&remoteSnapshot&&baseSnapshot.id!==remoteSnapshot.id)} });}
    catch(error){if(error instanceof ApiError&&error.status===409)return this.convergeAfterConflict(attempt,"Another device committed at the same time");throw error;}
    settings.lastSnapshotId = snapshot.id; settings.initialized = true; await this.saveSettings();let mirrored:number;
    try{mirrored=clientCanMirrorAll?await this.mirror(snapshot.id,entries,final,bytes,remoteCache):0;}
    catch(error){if(this.retryableMirrorError(error))return this.convergeAfterConflict(attempt,"The commit succeeded and another device advanced the vault during mirroring");throw error;}
    this.status({phase:"complete",message:conflicts ? `Synced · ${conflicts} conflict${conflicts === 1 ? "" : "s"} preserved` : "Sync complete · readable recovery copy current"});
    return { uploaded, downloaded, deleted, conflicts, mirrored, snapshotId: settings.lastSnapshotId };
  }
}
