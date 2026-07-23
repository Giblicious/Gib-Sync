import { normalizePath, type DataAdapter } from "obsidian";
import type { ManifestEntry, Snapshot } from "@gib-sync/protocol";
import { ApiError, GibSyncApi } from "./api";
import { decryptBlob, encryptBlob, hashBytes } from "./crypto";
import { mergeText } from "./merge";
import type { GibSyncSettings, SyncPhase } from "./settings";

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
    private readonly status: (progress: SyncProgress) => void
  ) {}

  sync(): Promise<SyncResult> {
    if (this.running) return this.running;
    this.running = this.run(0).finally(() => { this.running = null; }); return this.running;
  }

  private include(path: string): boolean {
    const settings = this.getSettings(); const normalized = normalizePath(path);
    if(normalized===".gib-sync"||normalized.startsWith(".gib-sync/"))return false;
    if (!settings.syncObsidianConfig && (normalized === ".obsidian" || normalized.startsWith(".obsidian/"))) return false;
    return !settings.exclusions.some((prefix) => normalized === prefix.replace(/\/$/, "") || normalized.startsWith(prefix));
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
      output.set(path, { path, hash: await hashBytes(bytes), size: bytes.length, mtime: stat?.mtime ?? Date.now(), bytes });
      current++; if (current===1 || current===paths.length || current%25===0) this.status({phase:"scanning",message:`Scanning local vault (${current}/${paths.length})`,current,total:paths.length});
    }
    return output;
  }

  private map(snapshot: Snapshot | null): Map<string, FileState> {
    return new Map((snapshot?.entries ?? []).filter((entry) => this.include(entry.path)).map((entry) => [entry.path, { ...entry }]));
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
  private conflictPath(path: string): string {
    const index = path.lastIndexOf("."); const stamp = new Date().toISOString().replace(/[:.]/g, "-"); const suffix = ` (conflict ${this.getSettings().deviceName} ${stamp})`;
    return index > path.lastIndexOf("/") ? `${path.slice(0,index)}${suffix}${path.slice(index)}` : `${path}${suffix}`;
  }
  private same(a?: FileState, b?: FileState) { return a?.hash === b?.hash && (!!a === !!b); }

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
    const baseSnapshot = settings.lastSnapshotId ? await this.api.snapshot(settings.lastSnapshotId).catch(() => null) : null;
    const base = this.map(baseSnapshot), remote = this.map(remoteSnapshot); const final = new Map<string, FileState>();
    const bytes = new Map<string, Uint8Array>(); const remoteCache = new Map<string, Uint8Array>();
    for (const entry of local.values()) if (entry.bytes) bytes.set(entry.hash, entry.bytes);
    const paths = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
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
      if (l && r && this.text(path)) {
        const baseText = b ? decoder.decode(await this.remoteBytes(b, remoteCache)) : "";
        const localText = decoder.decode(l.bytes!); const remoteText = decoder.decode(await this.remoteBytes(r, remoteCache));
        const merged = mergeText(baseText, localText, remoteText, settings.deviceName, r.path);
        const mergedBytes = encoder.encode(merged.text); const hash = await hashBytes(mergedBytes); bytes.set(hash, mergedBytes);
        final.set(path, { path, hash, size: mergedBytes.length, mtime: Date.now(), bytes: mergedBytes });
        if (merged.conflicted) conflicts++;
        continue;
      }
      // A binary conflict never destroys either side: remote keeps the original path and local gets a conflict copy.
      conflicts++;
      if (r) final.set(path, r);
      if (l) { const copyPath = this.conflictPath(path); final.set(copyPath, { ...l, path: copyPath, mtime: Date.now() }); }
    }

    let downloaded = 0, deleted = 0;
    this.status({phase:"applying",message:"Applying merged changes to this device"});
    for (const [path, entry] of final) {
      if (local.get(path)?.hash === entry.hash) continue;
      const clear = bytes.get(entry.hash) ?? await this.remoteBytes(entry, remoteCache); bytes.set(entry.hash, clear);
      await this.ensureParent(path); await this.adapter.writeBinary(path, clear.slice().buffer); downloaded++;
    }
    for (const path of local.keys()) if (!final.has(path) && this.include(path)) { await this.adapter.remove(path); deleted++; }

    const entries = [...final.values()].map(({path,hash,size,mtime}) => ({path,hash,size,mtime})).sort((a,b)=>a.path.localeCompare(b.path));
    const remoteEntries = [...remote.values()].map(({path,hash,size,mtime}) => ({path,hash,size,mtime})).sort((a,b)=>a.path.localeCompare(b.path));
    const unchanged = entries.length === remoteEntries.length && entries.every((entry, i) => entry.path === remoteEntries[i].path && entry.hash === remoteEntries[i].hash);
    if (unchanged) {
      settings.lastSnapshotId = remoteSnapshot?.id ?? null; settings.initialized = true; await this.saveSettings();const mirrored=remoteSnapshot?await this.mirror(remoteSnapshot.id,entries,final,bytes,remoteCache):0;this.status({phase:"up-to-date",message:"Up to date · readable recovery copy verified"});
      return { uploaded: 0, downloaded, deleted, conflicts, mirrored, snapshotId: settings.lastSnapshotId };
    }

    this.status({phase:"uploading",message:"Preparing encrypted uploads"}); let uploaded = 0;
    for (const entry of entries) {
      const clear = bytes.get(entry.hash); if (!clear || remoteEntries.some((remoteEntry) => remoteEntry.hash === entry.hash)) continue;
      await this.api.putBlob(entry.hash, await encryptBlob(clear, settings.vaultKey, entry.hash)); uploaded++;
      this.status({phase:"uploading",message:`Uploaded ${uploaded} encrypted file${uploaded===1?"":"s"}`,current:uploaded});
    }
    this.status({phase:"committing",message:"Committing an atomic snapshot"});
    try {
      const snapshot = await this.api.commit({ parentId: remoteSnapshot?.id ?? null, message: conflicts ? `Sync with ${conflicts} preserved conflict${conflicts === 1 ? "" : "s"}` : "Sync", entries });
      settings.lastSnapshotId = snapshot.id; settings.initialized = true; await this.saveSettings();const mirrored=await this.mirror(snapshot.id,entries,final,bytes,remoteCache);this.status({phase:"complete",message:conflicts ? `Synced · ${conflicts} conflict${conflicts === 1 ? "" : "s"} preserved` : "Sync complete · readable recovery copy current"});
      return { uploaded, downloaded, deleted, conflicts, mirrored, snapshotId: snapshot.id };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && attempt < 2) { this.status({phase:"merging",message:"Remote changed during sync; merging again"}); return this.run(attempt + 1); }
      throw error;
    }
  }
}
