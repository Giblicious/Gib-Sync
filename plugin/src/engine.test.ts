import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import type { Snapshot } from "@gib-sync/protocol";
import { SyncEngine } from "./engine";
import type { GibSyncApi } from "./api";
import { decryptBlob, encryptBlob, hashBytes, toBase64Url } from "./crypto";
import { DEFAULT_SETTINGS, type GibSyncSettings } from "./settings";

beforeAll(() => Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true }));

class MemoryAdapter {
  files = new Map<string, Uint8Array>(); dirs = new Set<string>();
  async list(path: string) {
    const prefix = path ? `${path}/` : ""; const files: string[] = [], folders = new Set<string>();
    for (const name of this.files.keys()) if (name.startsWith(prefix)) { const rest = name.slice(prefix.length); const slash = rest.indexOf("/"); if (slash < 0) files.push(name); else folders.add(`${prefix}${rest.slice(0,slash)}`); }
    return { files, folders:[...folders] };
  }
  async readBinary(path: string) { return this.files.get(path)!.slice().buffer; }
  async writeBinary(path: string, data: ArrayBuffer) { this.files.set(path, new Uint8Array(data)); }
  async stat(path: string) { const bytes = this.files.get(path); return bytes ? {type:"file" as const,ctime:1,mtime:1,size:bytes.length} : null; }
  async exists(path: string) { return this.files.has(path) || this.dirs.has(path); }
  async mkdir(path: string) { this.dirs.add(path); }
  async remove(path: string) { this.files.delete(path); }
}

class MemoryApi {
  head: Snapshot | null = null; blobs = new Map<string,Uint8Array>(); commits = 0;
  async state() { return {head:this.head}; }
  async snapshot(id: string) { if (this.head?.id !== id) throw new Error("missing"); return this.head; }
  async getBlob(hash: string) { return this.blobs.get(hash)!; }
  async putBlob(hash: string, bytes: Uint8Array) { this.blobs.set(hash,bytes); }
  async commit(body: {parentId:string|null;message:string;entries:Snapshot["entries"]}) {
    this.commits++; this.head = {id:`00000000-0000-4000-8000-${String(this.commits).padStart(12,"0")}`,vaultId:"vault",parentId:body.parentId,deviceId:"device",deviceName:"Test",createdAt:new Date().toISOString(),message:body.message,entries:body.entries}; return this.head;
  }
}

function settings(): GibSyncSettings {
  const key = new Uint8Array(32); key.fill(7);
  return {...DEFAULT_SETTINGS,serverUrl:"https://sync.test",vaultId:"vault",vaultName:"Test",vaultKey:toBase64Url(key),deviceId:"device",deviceName:"Desktop",deviceToken:"token"};
}

describe("SyncEngine", () => {
  it("pushes a new desktop vault as an encrypted snapshot", async () => {
    const adapter = new MemoryAdapter(); const api = new MemoryApi(); const config = settings(); const clear = new TextEncoder().encode("hello\n"); adapter.files.set("note.md",clear);
    const engine = new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}); const result = await engine.sync();
    expect(result.uploaded).toBe(1); expect(api.head?.entries[0].path).toBe("note.md"); const hash = await hashBytes(clear);
    expect(await decryptBlob(api.blobs.get(hash)!,config.vaultKey,hash)).toEqual(clear); expect(config.initialized).toBe(true);
  });
  it("pulls an existing remote snapshot onto a newly paired mobile vault", async () => {
    const adapter = new MemoryAdapter(); const api = new MemoryApi(); const config = settings(); config.deviceName="Mobile"; const clear = new TextEncoder().encode("from desktop\n"); const hash = await hashBytes(clear);
    api.blobs.set(hash,await encryptBlob(clear,config.vaultKey,hash)); api.head={id:"00000000-0000-4000-8000-000000000123",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Initial",entries:[{path:"folder/note.md",hash,size:clear.length,mtime:1}]};
    const engine = new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}); const result=await engine.sync();
    expect(result.downloaded).toBe(1); expect(api.commits).toBe(0); expect(adapter.files.get("folder/note.md")).toEqual(clear); expect(config.lastSnapshotId).toBe(api.head.id);
  });
});
