import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import type { Snapshot } from "@gib-sync/protocol";
import { FileChangedDuringReadError, LOW_MEMORY_DOWNLOAD_BYTES, SyncEngine } from "./engine";
import { ApiError } from "./api";
import type { GibSyncApi } from "./api";
import { decryptBlob, encryptBlob, hashBytes, toBase64Url } from "./crypto";
import { DEFAULT_SETTINGS, type GibSyncSettings } from "./settings";

beforeAll(() => Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true }));

class MemoryAdapter {
  files = new Map<string, Uint8Array>(); dirs = new Set<string>();listCalls=0;readCalls:string[]=[];writeCalls:string[]=[];
  async list(path: string) {
    this.listCalls++;
    const prefix = path ? `${path}/` : ""; const files: string[] = [], folders = new Set<string>();
    for (const name of this.files.keys()) if (name.startsWith(prefix)) { const rest = name.slice(prefix.length); const slash = rest.indexOf("/"); if (slash < 0) files.push(name); else folders.add(`${prefix}${rest.slice(0,slash)}`); }
    return { files, folders:[...folders] };
  }
  async readBinary(path: string) { this.readCalls.push(path);return this.files.get(path)!.slice().buffer; }
  async writeBinary(path: string, data: ArrayBuffer) { this.writeCalls.push(path);this.files.set(path, new Uint8Array(data)); }
  async stat(path: string) { const bytes = this.files.get(path); return bytes ? {type:"file" as const,ctime:1,mtime:1,size:bytes.length} : null; }
  async exists(path: string) { return this.files.has(path) || this.dirs.has(path); }
  async mkdir(path: string) { this.dirs.add(path); }
  async remove(path: string) { this.files.delete(path); }
}

class MemoryApi {
  head: Snapshot | null = null; blobs = new Map<string,Uint8Array>(); contents=new Map<string,Uint8Array>();contentCalls:string[]=[];mirror = new Map<string,Uint8Array>(); snapshots = new Map<string,Snapshot>(); commits = 0;readyHeads:string[]=[];lastCommitBody:any=null;
  async state() { return {head:this.head}; }
  async headState() { return {headId:this.head?.id??null}; }
  async snapshot(id: string) { const snapshot=this.snapshots.get(id)??(this.head?.id===id?this.head:null);if(!snapshot)throw new Error("missing");return snapshot; }
  async getBlob(hash: string) { return this.blobs.get(hash)!; }
  async getContent(hash:string){this.contentCalls.push(hash);return this.contents.get(hash)!;}
  async putBlob(hash: string, bytes: Uint8Array) { this.blobs.set(hash,bytes); }
  async markDeviceReady(headId:string|null){this.readyHeads.push(headId??"");return {ok:true};}
  async commit(body: {parentId:string|null;message:string;entries:Snapshot["entries"]}) {
    this.commits++;this.lastCommitBody=body; this.head = {id:`00000000-0000-4000-8000-${String(this.commits).padStart(12,"0")}`,vaultId:"vault",parentId:body.parentId,deviceId:"device",deviceName:"Test",createdAt:new Date().toISOString(),message:body.message,entries:body.entries};this.snapshots.set(this.head.id,this.head);return this.head;
  }
  async mirrorPlan(_snapshotId:string,entries:Snapshot["entries"]){return {uploadPaths:entries.filter((entry)=>!this.mirror.has(entry.path)).map((entry)=>entry.path),deletePaths:[],alreadyCurrent:false};}
  async putMirrorFile(_snapshotId:string,path:string,_hash:string,bytes:Uint8Array){this.mirror.set(path,bytes.slice());}
  async mirrorComplete(snapshotId:string){return {mirroredFiles:this.mirror.size,deletedFiles:0,snapshotId};}
}

function settings(): GibSyncSettings {
  const key = new Uint8Array(32); key.fill(7);
  return {...DEFAULT_SETTINGS,serverUrl:"https://sync.test",vaultId:"vault",vaultName:"Test",vaultKey:toBase64Url(key),deviceId:"device",deviceName:"Desktop",deviceToken:"token"};
}

describe("SyncEngine", () => {
  it("cooperatively yields and throttles UI progress during large sync work",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),progress:string[]=[];let yields=0;
    for(let index=0;index<40;index++)adapter.files.set(`Journal/${index}.md`,new TextEncoder().encode(`entry ${index}\n`));
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},(item)=>progress.push(`${item.phase}:${item.current??0}`),async()=>{},()=>{},async()=>{yields++;});
    const result=await engine.sync();
    expect(result.uploaded).toBe(40);expect(yields).toBeGreaterThan(5);
    expect(progress.filter((item)=>item.startsWith("mirroring:")).length).toBeLessThan(10);
  });
  it("uses only the lightweight head check when neither side changed",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("stable\n"),hash=await hashBytes(clear);
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000010",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"stable.md",hash,size:clear.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();adapter.files.set("stable.md",clear);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:0,downloaded:0,fullScan:false});expect(adapter.listCalls).toBe(0);expect(adapter.readCalls).toEqual([]);
  });
  it("hashes only journaled paths and preserves the rest of the baseline",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),oldChanged=new TextEncoder().encode("old\n"),changed=new TextEncoder().encode("new\n"),stable=new TextEncoder().encode("stable\n");
    const oldHash=await hashBytes(oldChanged),stableHash=await hashBytes(stable),base:Snapshot={id:"00000000-0000-4000-8000-000000000011",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:[{path:"changed.md",hash:oldHash,size:oldChanged.length,mtime:1},{path:"stable.md",hash:stableHash,size:stable.length,mtime:1}]};
    api.head=base;api.snapshots.set(base.id,base);api.blobs.set(oldHash,await encryptBlob(oldChanged,config.vaultKey,oldHash));api.blobs.set(stableHash,await encryptBlob(stable,config.vaultKey,stableHash));config.initialized=true;config.lastSnapshotId=base.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.pendingPaths=["changed.md"];
    adapter.files.set("changed.md",changed);adapter.files.set("stable.md",stable);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:1,fullScan:false,processedPaths:["changed.md"]});expect(adapter.listCalls).toBe(0);expect(adapter.readCalls.every((path)=>path==="changed.md")).toBe(true);expect(api.head?.entries.map((entry)=>entry.path).sort()).toEqual(["changed.md","stable.md"]);
  });
  it("pushes a new desktop vault as an encrypted snapshot", async () => {
    const adapter = new MemoryAdapter(); const api = new MemoryApi(); const config = settings(); const clear = new TextEncoder().encode("hello\n"); adapter.files.set("note.md",clear);
    const engine = new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}); const result = await engine.sync();
    expect(result.uploaded).toBe(1); expect(api.head?.entries[0].path).toBe("note.md"); const hash = await hashBytes(clear);
    expect(await decryptBlob(api.blobs.get(hash)!,config.vaultKey,hash)).toEqual(clear);expect(api.mirror.get("note.md")).toEqual(clear);expect(result.mirrored).toBe(1);expect(config.initialized).toBe(true);
  });
  it("pulls an existing remote snapshot onto a newly paired mobile vault", async () => {
    const adapter = new MemoryAdapter(); const api = new MemoryApi(); const config = settings(); config.deviceName="Mobile"; const clear = new TextEncoder().encode("from desktop\n"); const hash = await hashBytes(clear);
    api.blobs.set(hash,await encryptBlob(clear,config.vaultKey,hash)); api.head={id:"00000000-0000-4000-8000-000000000123",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Initial",entries:[{path:"folder/note.md",hash,size:clear.length,mtime:1}]};
    const engine = new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}); const result=await engine.sync();
    expect(result.downloaded).toBe(1);expect(result.mirrored).toBe(1);expect(api.commits).toBe(0);expect(adapter.files.get("folder/note.md")).toEqual(clear);expect(api.mirror.get("folder/note.md")).toEqual(clear);expect(config.lastSnapshotId).toBe(api.head.id);
  });
  it("syncs bookmarks by default without pulling unrelated Obsidian configuration",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),bookmarks=new TextEncoder().encode('{"items":[{"type":"file","path":"Notes/Important.md"}]}'),appConfig=new TextEncoder().encode('{"theme":"moonstone"}'),bookmarkHash=await hashBytes(bookmarks),appHash=await hashBytes(appConfig);
    api.blobs.set(bookmarkHash,await encryptBlob(bookmarks,config.vaultKey,bookmarkHash));api.blobs.set(appHash,await encryptBlob(appConfig,config.vaultKey,appHash));api.head={id:"00000000-0000-4000-8000-000000000129",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Bookmarks",entries:[{path:".obsidian/bookmarks.json",hash:bookmarkHash,size:bookmarks.length,mtime:1},{path:".obsidian/app.json",hash:appHash,size:appConfig.length,mtime:1}]};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.downloaded).toBe(1);expect(adapter.files.get(".obsidian/bookmarks.json")).toEqual(bookmarks);expect(adapter.files.has(".obsidian/app.json")).toBe(false);expect(api.commits).toBe(0);
  });
  it("uses the verified low-memory content path for a large mobile onboarding file",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new Uint8Array(LOW_MEMORY_DOWNLOAD_BYTES),hash=await hashBytes(clear);
    api.contents.set(hash,clear);api.head={id:"00000000-0000-4000-8000-000000000124",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Initial",entries:[{path:"audio/large.mp3",hash,size:clear.length,mtime:1}]};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.downloaded).toBe(1);expect(api.contentCalls).toEqual([hash,hash]);expect(adapter.files.get("audio/large.mp3")?.byteLength).toBe(clear.byteLength);expect(api.mirror.get("audio/large.mp3")?.byteLength).toBe(clear.byteLength);expect(api.commits).toBe(0);
  });
  it("applies small vault files before large attachments during onboarding",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),small=new TextEncoder().encode("note\n"),large=new Uint8Array(LOW_MEMORY_DOWNLOAD_BYTES),smallHash=await hashBytes(small),largeHash=await hashBytes(large);
    api.blobs.set(smallHash,await encryptBlob(small,config.vaultKey,smallHash));api.contents.set(largeHash,large);api.head={id:"00000000-0000-4000-8000-000000000125",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Initial",entries:[{path:"A-large.mp3",hash:largeHash,size:large.length,mtime:1},{path:"Z-note.md",hash:smallHash,size:small.length,mtime:1}]};
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(adapter.writeCalls).toEqual(["Z-note.md","A-large.mp3"]);
  });
  it("blocks a newly paired device from uploading a different pre-existing vault",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),local=new TextEncoder().encode("wrong vault\n"),remote=new TextEncoder().encode("shared vault\n"),hash=await hashBytes(remote);
    adapter.files.set("note.md",local);api.blobs.set(hash,await encryptBlob(remote,config.vaultKey,hash));
    api.head={id:"00000000-0000-4000-8000-000000000201",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Shared",entries:[{path:"note.md",hash,size:remote.length,mtime:1}]};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});
    await expect(engine.sync()).rejects.toThrow("Onboarding protection paused");expect(api.commits).toBe(0);expect(adapter.files.get("note.md")).toEqual(local);
  });
  it("resumes a partial first download instead of comparing its subset to the whole server vault",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),remoteEntries:Snapshot["entries"]=[];
    for(let index=0;index<20;index++){const clear=new TextEncoder().encode(`server ${index}\n`),hash=await hashBytes(clear),path=`Note ${index}.md`;remoteEntries.push({path,hash,size:clear.length,mtime:index});api.blobs.set(hash,await encryptBlob(clear,config.vaultKey,hash));if(index<4)adapter.files.set(path,clear);}
    adapter.files.set("Local scratch.md",new TextEncoder().encode("preserve me\n"));api.head={id:"00000000-0000-4000-8000-000000000202",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Existing vault",entries:remoteEntries};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.downloaded).toBe(16);expect(api.readyHeads).toEqual([api.head?.parentId??"00000000-0000-4000-8000-000000000202"]);expect(api.commits).toBe(1);expect(adapter.files.get("Local scratch.md")).toEqual(new TextEncoder().encode("preserve me\n"));expect([...adapter.files.keys()].filter((path)=>path.includes("conflict"))).toEqual([]);
  });
  it("losslessly unifies a highly overlapping newly paired vault",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.deviceName="New phone";
    const remoteEntries:Snapshot["entries"]=[];
    for(let index=0;index<10;index++){
      const path=`Note ${index}.md`,remoteBytes=new TextEncoder().encode(index===9?"remote edit\n":`same ${index}\n`),remoteHash=await hashBytes(remoteBytes);
      remoteEntries.push({path,hash:remoteHash,size:remoteBytes.length,mtime:100+index});api.blobs.set(remoteHash,await encryptBlob(remoteBytes,config.vaultKey,remoteHash));
      adapter.files.set(path,index===9?new TextEncoder().encode("local edit\n"):remoteBytes);
    }
    api.head={id:"00000000-0000-4000-8000-000000000210",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Existing vault",entries:remoteEntries};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.conflicts).toBe(1);expect(api.readyHeads).toEqual(["00000000-0000-4000-8000-000000000210"]);expect(api.commits).toBe(1);expect(api.head?.entries).toHaveLength(11);
    expect(api.head?.entries.some((entry)=>entry.path.includes("conflict - New phone"))).toBe(true);
    expect([...adapter.files.values()].map((bytes)=>new TextDecoder().decode(bytes)).join("\n")).toContain("local edit");
    expect([...adapter.files.values()].map((bytes)=>new TextDecoder().decode(bytes)).join("\n")).toContain("remote edit");
  });
  it("blocks a returning device with local files when its verified baseline is unavailable",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),local=new TextEncoder().encode("local\n"),remote=new TextEncoder().encode("remote\n"),hash=await hashBytes(remote);
    config.initialized=true;config.lastSnapshotId="00000000-0000-4000-8000-000000000299";adapter.files.set("note.md",local);api.blobs.set(hash,await encryptBlob(remote,config.vaultKey,hash));
    api.head={id:"00000000-0000-4000-8000-000000000300",vaultId:"vault",parentId:null,deviceId:"other",deviceName:"Other",createdAt:new Date().toISOString(),message:"Current",entries:[{path:"note.md",hash,size:remote.length,mtime:1}]};
    await expect(new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync()).rejects.toThrow("last verified server snapshot is unavailable");
    expect(api.commits).toBe(0);expect(adapter.files.get("note.md")).toEqual(local);
  });
  it("pulls safely when a returning device is empty even if its old baseline is unavailable",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),remote=new TextEncoder().encode("safe\n"),hash=await hashBytes(remote);
    config.initialized=true;config.lastSnapshotId="00000000-0000-4000-8000-000000000298";api.blobs.set(hash,await encryptBlob(remote,config.vaultKey,hash));
    api.head={id:"00000000-0000-4000-8000-000000000301",vaultId:"vault",parentId:null,deviceId:"other",deviceName:"Other",createdAt:new Date().toISOString(),message:"Current",entries:[{path:"note.md",hash,size:remote.length,mtime:1}]};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.downloaded).toBe(1);expect(api.commits).toBe(0);expect(adapter.files.get("note.md")).toEqual(remote);
  });
  it("marks deletions made from an older verified baseline as stale",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),keep=new TextEncoder().encode("keep\n"),deleted=new TextEncoder().encode("delete\n"),added=new TextEncoder().encode("remote\n");
    const keepHash=await hashBytes(keep),deletedHash=await hashBytes(deleted),addedHash=await hashBytes(added);const base:Snapshot={id:"00000000-0000-4000-8000-000000000302",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:[{path:"keep.md",hash:keepHash,size:keep.length,mtime:1},{path:"deleted.md",hash:deletedHash,size:deleted.length,mtime:1}]};
    api.head={...base,id:"00000000-0000-4000-8000-000000000303",parentId:base.id,entries:[...base.entries,{path:"remote.md",hash:addedHash,size:added.length,mtime:2}]};api.snapshots.set(base.id,base);api.blobs.set(keepHash,await encryptBlob(keep,config.vaultKey,keepHash));api.blobs.set(addedHash,await encryptBlob(added,config.vaultKey,addedHash));config.initialized=true;config.lastSnapshotId=base.id;adapter.files.set("keep.md",keep);
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(api.lastCommitBody.signals.staleBaseline).toBe(true);expect(api.head?.entries.some((entry)=>entry.path==="deleted.md")).toBe(false);
  });
  it("restores the last accepted snapshot exactly after rejecting quarantined local changes",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),accepted=new TextEncoder().encode("accepted\n"),hash=await hashBytes(accepted);
    config.initialized=true;adapter.files.set("note.md",new TextEncoder().encode("suspicious rewrite\n"));adapter.files.set("extra.md",new TextEncoder().encode("delete me\n"));
    api.blobs.set(hash,await encryptBlob(accepted,config.vaultKey,hash));api.head={id:"00000000-0000-4000-8000-000000000202",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Accepted",entries:[{path:"note.md",hash,size:accepted.length,mtime:1}]};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});
    await expect(engine.restoreAcceptedSnapshot()).resolves.toEqual({downloaded:1,deleted:1});expect(adapter.files.get("note.md")).toEqual(accepted);expect(adapter.files.has("extra.md")).toBe(false);expect(config.lastSnapshotId).toBe(api.head.id);
  });
  it("lets mobile ignore desktop plugins without deleting their remote copies",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.syncPlugins=false;
    const baseNote=new TextEncoder().encode("base\n"),editedNote=new TextEncoder().encode("mobile edit\n"),pluginBytes=new TextEncoder().encode("desktop plugin\n");
    const baseHash=await hashBytes(baseNote),pluginHash=await hashBytes(pluginBytes);
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000203",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Desktop with plugins",entries:[
      {path:"note.md",hash:baseHash,size:baseNote.length,mtime:1},{path:".obsidian/plugins/desktop-tool/main.js",hash:pluginHash,size:pluginBytes.length,mtime:1}
    ]};
    config.lastSnapshotId=base.id;api.head=base;api.snapshots.set(base.id,base);api.blobs.set(baseHash,await encryptBlob(baseNote,config.vaultKey,baseHash));api.blobs.set(pluginHash,await encryptBlob(pluginBytes,config.vaultKey,pluginHash));adapter.files.set("note.md",editedNote);
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(api.head?.entries.map((entry)=>entry.path).sort()).toEqual([".obsidian/plugins/desktop-tool/main.js","note.md"]);expect(adapter.files.has(".obsidian/plugins/desktop-tool/main.js")).toBe(false);
  });
  it("downloads mobile-compatible plugin files after plugin sync is enabled",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.syncPlugins=true;config.lastSnapshotId=null;
    const pluginBytes=new TextEncoder().encode("mobile plugin\n"),workspaceBytes=new TextEncoder().encode("{}"),generatedBytes=new TextEncoder().encode("generated index"),pluginHash=await hashBytes(pluginBytes),workspaceHash=await hashBytes(workspaceBytes),generatedHash=await hashBytes(generatedBytes);
    api.blobs.set(pluginHash,await encryptBlob(pluginBytes,config.vaultKey,pluginHash));api.blobs.set(workspaceHash,await encryptBlob(workspaceBytes,config.vaultKey,workspaceHash));api.blobs.set(generatedHash,await encryptBlob(generatedBytes,config.vaultKey,generatedHash));
    api.head={id:"00000000-0000-4000-8000-000000000204",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Plugins",entries:[
      {path:".obsidian/plugins/calendar/main.js",hash:pluginHash,size:pluginBytes.length,mtime:1},{path:".obsidian/workspace.json",hash:workspaceHash,size:workspaceBytes.length,mtime:1},{path:".obsidian/plugins/gib-search/embeddings/model/index.meta.json",hash:generatedHash,size:generatedBytes.length,mtime:1}
    ]};
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(adapter.files.get(".obsidian/plugins/calendar/main.js")).toEqual(pluginBytes);expect(adapter.files.has(".obsidian/workspace.json")).toBe(false);expect(adapter.files.has(".obsidian/plugins/gib-search/embeddings/model/index.meta.json")).toBe(false);
    expect(api.readyHeads).toEqual(["00000000-0000-4000-8000-000000000204"]);expect(api.head?.entries.map((entry)=>entry.path)).toEqual([".obsidian/plugins/calendar/main.js"]);
  });
  it("carries concurrent edits to the destination of a folder move",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;
    const encode=(value:string)=>new TextEncoder().encode(value),baseValues=[encode("a\nb\nc\n"),encode("two\n"),encode("three\n")],localValues=[encode("A\nb\nc\n"),baseValues[1],baseValues[2]],remoteValues=[encode("a\nb\nC\n"),baseValues[1],baseValues[2]];
    const baseEntries:Snapshot["entries"]=[],remoteEntries:Snapshot["entries"]=[];
    for(let index=0;index<3;index++){const baseHash=await hashBytes(baseValues[index]),remoteHash=await hashBytes(remoteValues[index]);baseEntries.push({path:`Old/note-${index}.md`,hash:baseHash,size:baseValues[index].length,mtime:1});remoteEntries.push({path:`Old/note-${index}.md`,hash:remoteHash,size:remoteValues[index].length,mtime:index===0?3:1});api.blobs.set(baseHash,await encryptBlob(baseValues[index],config.vaultKey,baseHash));api.blobs.set(remoteHash,await encryptBlob(remoteValues[index],config.vaultKey,remoteHash));adapter.files.set(`New/note-${index}.md`,localValues[index]);}
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000710",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:baseEntries};
    api.snapshots.set(base.id,base);api.head={...base,id:"00000000-0000-4000-8000-000000000711",parentId:base.id,deviceId:"mobile",deviceName:"Mobile",entries:remoteEntries};config.lastSnapshotId=base.id;
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.conflicts).toBe(0);expect(api.head?.entries.every((entry)=>entry.path.startsWith("New/"))).toBe(true);expect([...adapter.files.keys()].some((path)=>path.startsWith("Old/"))).toBe(false);
    expect(new TextDecoder().decode(adapter.files.get("New/note-0.md"))).toBe("A\nb\nC\n");
  });
  it("keeps a fully edited batch at its new folder without creating duplicates",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;const baseEntries:Snapshot["entries"]=[];
    for(let index=0;index<10;index++){const baseBytes=new TextEncoder().encode(`journal ${index}\n`),localBytes=new TextEncoder().encode(`journal ${index}\nmetadata: moved\n`),hash=await hashBytes(baseBytes);baseEntries.push({path:`Journal/day-${index}.md`,hash,size:baseBytes.length,mtime:1});api.blobs.set(hash,await encryptBlob(baseBytes,config.vaultKey,hash));adapter.files.set(`Archive/Journal/day-${index}.md`,localBytes);}
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000730",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:baseEntries};api.snapshots.set(base.id,base);api.head=base;config.lastSnapshotId=base.id;
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync(),paths=api.head!.entries.map((entry)=>entry.path);
    expect(result.conflicts).toBe(0);expect(paths).toHaveLength(10);expect(paths.every((path)=>path.startsWith("Archive/Journal/"))).toBe(true);expect([...adapter.files.keys()].some((path)=>path.startsWith("Journal/"))).toBe(false);
  });
  it("converges simultaneous moves to one destination instead of duplicating files",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;const entries:Snapshot["entries"]=[];
    for(let index=0;index<3;index++){const clear=new TextEncoder().encode(`note ${index}\n`),hash=await hashBytes(clear);entries.push({path:`Old/note-${index}.md`,hash,size:clear.length,mtime:1});api.blobs.set(hash,await encryptBlob(clear,config.vaultKey,hash));adapter.files.set(`Local destination/note-${index}.md`,clear);}
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000720",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries};api.snapshots.set(base.id,base);config.lastSnapshotId=base.id;
    api.head={...base,id:"00000000-0000-4000-8000-000000000721",parentId:base.id,deviceId:"mobile",deviceName:"Mobile",entries:entries.map((entry)=>({...entry,path:entry.path.replace("Old/","Remote destination/")}))};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync(),paths=api.head!.entries.map((entry)=>entry.path);
    expect(result.conflicts).toBe(0);expect(paths).toHaveLength(3);expect(paths.every((path)=>path.startsWith("Remote destination/"))).toBe(true);expect([...adapter.files.keys()].every((path)=>path.startsWith("Remote destination/"))).toBe(true);
  });
  it("semantically combines Obsidian settings without creating deep conflict files",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.syncObsidianConfig=true;
    const baseBytes=new TextEncoder().encode('{"theme":"old","editor":{"line":true}}'),localBytes=new TextEncoder().encode('{"theme":"dark","editor":{"line":true}}'),remoteBytes=new TextEncoder().encode('{"theme":"old","editor":{"line":false}}');
    const baseHash=await hashBytes(baseBytes),remoteHash=await hashBytes(remoteBytes),base:Snapshot={id:"00000000-0000-4000-8000-000000000205",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base settings",entries:[{path:".obsidian/app.json",hash:baseHash,size:baseBytes.length,mtime:1}]};
    config.lastSnapshotId=base.id;api.snapshots.set(base.id,base);api.blobs.set(baseHash,await encryptBlob(baseBytes,config.vaultKey,baseHash));api.blobs.set(remoteHash,await encryptBlob(remoteBytes,config.vaultKey,remoteHash));api.head={...base,id:"00000000-0000-4000-8000-000000000206",parentId:base.id,deviceId:"mobile",deviceName:"Mobile",entries:[{path:".obsidian/app.json",hash:remoteHash,size:remoteBytes.length,mtime:3}]};adapter.files.set(".obsidian/app.json",localBytes);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.conflicts).toBe(0);expect(result.resolved).toBe(1);expect(api.head?.entries).toHaveLength(1);expect([...adapter.files.keys()].filter((path)=>path.includes("conflict"))).toHaveLength(0);expect(JSON.parse(new TextDecoder().decode(adapter.files.get(".obsidian/app.json")))).toEqual({theme:"dark",editor:{line:false}});
  });
  it("selects one complete plugin package and repairs incomplete enablement atomically",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.syncPlugins=true;
    const encode=(value:string)=>new TextEncoder().encode(value),baseManifest=encode('{"id":"demo","version":"1.0.0"}'),newManifest=encode('{"id":"demo","version":"2.0.0"}'),baseMain=encode("base code"),localMain=encode("complete local code"),enabled=encode('["demo","missing-plugin","gib-sync"]');
    const baseManifestHash=await hashBytes(baseManifest),newManifestHash=await hashBytes(newManifest),baseMainHash=await hashBytes(baseMain),localMainHash=await hashBytes(localMain),enabledHash=await hashBytes(enabled);
    const entries:Snapshot["entries"]=[{path:".obsidian/plugins/demo/manifest.json",hash:baseManifestHash,size:baseManifest.length,mtime:1},{path:".obsidian/plugins/demo/main.js",hash:baseMainHash,size:baseMain.length,mtime:1},{path:".obsidian/community-plugins.json",hash:enabledHash,size:enabled.length,mtime:1}],base:Snapshot={id:"00000000-0000-4000-8000-000000000207",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Plugin v1",entries};
    config.lastSnapshotId=base.id;api.snapshots.set(base.id,base);for(const [hash,value] of [[baseManifestHash,baseManifest],[newManifestHash,newManifest],[baseMainHash,baseMain],[enabledHash,enabled]] as const)api.blobs.set(hash,await encryptBlob(value,config.vaultKey,hash));
    api.head={...base,id:"00000000-0000-4000-8000-000000000208",parentId:base.id,deviceId:"mobile",deviceName:"Mobile",entries:[{path:".obsidian/plugins/demo/manifest.json",hash:newManifestHash,size:newManifest.length,mtime:4},{path:".obsidian/community-plugins.json",hash:enabledHash,size:enabled.length,mtime:1}]};
    adapter.files.set(".obsidian/plugins/demo/manifest.json",newManifest);adapter.files.set(".obsidian/plugins/demo/main.js",localMain);adapter.files.set(".obsidian/community-plugins.json",enabled);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.conflicts).toBe(0);expect(result.resolved).toBeGreaterThanOrEqual(2);expect(adapter.files.get(".obsidian/plugins/demo/main.js")).toEqual(localMain);expect(api.head?.entries.map((entry)=>entry.path).sort()).toEqual([".obsidian/community-plugins.json",".obsidian/plugins/demo/main.js",".obsidian/plugins/demo/manifest.json"]);expect(JSON.parse(new TextDecoder().decode(adapter.files.get(".obsidian/community-plugins.json")))).toEqual(["demo","gib-sync"]);expect(api.blobs.has(localMainHash)).toBe(true);
  });
  it("keeps desktop-only enablement server-side while mobile syncs compatible plugin toggles",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.syncPlugins=true;
    const files=new Map<string,Uint8Array>([
      [".obsidian/plugins/desktop-tool/manifest.json",new TextEncoder().encode('{"id":"desktop-tool","version":"1.0.0","isDesktopOnly":true}')],
      [".obsidian/plugins/desktop-tool/main.js",new TextEncoder().encode("desktop")],
      [".obsidian/plugins/mobile-tool/manifest.json",new TextEncoder().encode('{"id":"mobile-tool","version":"1.0.0","isDesktopOnly":false}')],
      [".obsidian/plugins/mobile-tool/main.js",new TextEncoder().encode("mobile")],
      [".obsidian/community-plugins.json",new TextEncoder().encode('["desktop-tool","mobile-tool","gib-sync"]')]
    ]),entries:Snapshot["entries"]=[];
    for(const [path,clear] of files){const hash=await hashBytes(clear);entries.push({path,hash,size:clear.length,mtime:1});api.blobs.set(hash,await encryptBlob(clear,config.vaultKey,hash));adapter.files.set(path,clear);}
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000212",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Enabled on desktop",entries};
    config.lastSnapshotId=base.id;api.head=base;api.snapshots.set(base.id,base);adapter.files.set(".obsidian/community-plugins.json",new TextEncoder().encode('["gib-sync"]'));
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{},undefined,undefined,undefined,true).sync();
    const enabledEntry=api.head!.entries.find((entry)=>entry.path===".obsidian/community-plugins.json")!,serverEnabled=JSON.parse(new TextDecoder().decode(await decryptBlob(api.blobs.get(enabledEntry.hash)!,config.vaultKey,enabledEntry.hash)));
    expect(result.conflicts).toBe(0);expect(new Set(serverEnabled)).toEqual(new Set(["gib-sync","desktop-tool"]));expect(JSON.parse(new TextDecoder().decode(adapter.files.get(".obsidian/community-plugins.json")))).toEqual(["gib-sync"]);
  });
  it("repairs a locally incomplete plugin from the unchanged complete server package",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.syncPlugins=true;
    const manifest=new TextEncoder().encode('{"id":"demo","version":"1.0.0"}'),main=new TextEncoder().encode("working code"),manifestHash=await hashBytes(manifest),mainHash=await hashBytes(main);
    const entries:Snapshot["entries"]=[{path:".obsidian/plugins/demo/manifest.json",hash:manifestHash,size:manifest.length,mtime:1},{path:".obsidian/plugins/demo/main.js",hash:mainHash,size:main.length,mtime:1}],base:Snapshot={id:"00000000-0000-4000-8000-000000000209",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Complete plugin",entries};
    config.lastSnapshotId=base.id;api.head=base;api.snapshots.set(base.id,base);api.blobs.set(manifestHash,await encryptBlob(manifest,config.vaultKey,manifestHash));api.blobs.set(mainHash,await encryptBlob(main,config.vaultKey,mainHash));adapter.files.set(".obsidian/plugins/demo/manifest.json",manifest);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.resolved).toBe(1);expect(adapter.files.get(".obsidian/plugins/demo/main.js")).toEqual(main);expect(api.head?.entries).toEqual(entries);
  });
  it("restores missing ancillary files when complete same-version plugin packages are reconciled",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.syncPlugins=true;
    const values={manifest:new TextEncoder().encode('{"id":"demo","version":"1.0.0"}'),main:new TextEncoder().encode("code"),styles:new TextEncoder().encode("body{}"),model:new Uint8Array(LOW_MEMORY_DOWNLOAD_BYTES)};const entries:Snapshot["entries"]=[];
    for(const [name,value] of Object.entries(values)){const hash=await hashBytes(value),path=`.obsidian/plugins/demo/${name==="manifest"?"manifest.json":name==="main"?"main.js":name==="styles"?"styles.css":"models/model.onnx"}`;entries.push({path,hash,size:value.length,mtime:1});adapter.files.set(path,value);if(value.length>=LOW_MEMORY_DOWNLOAD_BYTES)api.contents.set(hash,value);else api.blobs.set(hash,await encryptBlob(value,config.vaultKey,hash));}
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000210",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Complete package",entries};config.lastSnapshotId=base.id;api.snapshots.set(base.id,base);api.head={...base,id:"00000000-0000-4000-8000-000000000211",parentId:base.id,deviceId:"mobile",deviceName:"Mobile",entries:entries.filter((entry)=>entry.path.endsWith("manifest.json")||entry.path.endsWith("main.js"))};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({conflicts:0,resolved:1,uploaded:2});expect(api.head.entries.map((entry)=>entry.path).sort()).toEqual(entries.map((entry)=>entry.path).sort());expect([...adapter.files.keys()].some((path)=>path.includes("conflict"))).toBe(false);
  });
  it("never uploads a stale body when a file changes during a low-memory scan",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),before=new TextEncoder().encode("before\n"),after=new TextEncoder().encode("after\n");adapter.files.set("note.md",before);
    const originalRead=adapter.readBinary.bind(adapter);let reads=0;adapter.readBinary=async(path:string)=>{reads++;if(reads===2)adapter.files.set(path,after);return originalRead(path);};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});
    await expect(engine.sync()).rejects.toBeInstanceOf(FileChangedDuringReadError);expect(api.commits).toBe(0);
  });
  it("isolates an unreadable generated conflict copy without blocking the vault",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;
    const path="Notes/Entry (conflict - Seafile - 2026-07-26 16-46-02 UTC - 2).md",accepted=new TextEncoder().encode("accepted conflict copy\n"),edited=new TextEncoder().encode("ordinary edit\n"),acceptedHash=await hashBytes(accepted);
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000701",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:[{path,hash:acceptedHash,size:accepted.length,mtime:1}]};
    config.lastSnapshotId=base.id;api.head=base;api.snapshots.set(base.id,base);api.blobs.set(acceptedHash,await encryptBlob(accepted,config.vaultKey,acceptedHash));adapter.files.set(path,new Uint8Array([1]));adapter.files.set("ordinary.md",edited);
    const read=adapter.readBinary.bind(adapter);adapter.readBinary=async(candidate:string)=>{if(candidate===path)throw Object.assign(new Error("access denied"),{code:"EPERM"});return read(candidate);};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.uploaded).toBe(1);expect(api.head?.entries.find((entry)=>entry.path===path)?.hash).toBe(acceptedHash);expect(api.head?.entries.some((entry)=>entry.path==="ordinary.md")).toBe(true);
  });
  it("deletes a local-only generated conflict copy instead of uploading it again",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;
    const path="Notes/Orphan (conflict - Seafile - 2026-07-26 16-46-02 UTC - 2).md",clear=new TextEncoder().encode("obsolete copy\n");adapter.files.set(path,clear);
    api.head={id:"00000000-0000-4000-8000-000000000702",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Clean",entries:[]};config.lastSnapshotId=api.head.id;
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:0,deleted:1,conflicts:0});expect(adapter.files.has(path)).toBe(false);expect(api.commits).toBe(0);
  });
  it("keeps retrying a locked orphaned conflict copy without restoring it remotely",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;
    const path="Notes/Locked (conflict - Seafile - 2026-07-26 16-46-02 UTC - 2).md";adapter.files.set(path,new Uint8Array([1]));
    api.head={id:"00000000-0000-4000-8000-000000000703",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Clean",entries:[]};config.lastSnapshotId=api.head.id;
    adapter.readBinary=async()=>{throw Object.assign(new Error("access denied"),{code:"EPERM"});};adapter.remove=async()=>{throw Object.assign(new Error("locked"),{code:"EPERM"});};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:0,deleted:0,conflicts:0});expect(api.commits).toBe(0);expect(api.head.entries).toEqual([]);
  });
  it("still stops for an unreadable ordinary note",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();adapter.files.set("ordinary.md",new Uint8Array([1]));adapter.readBinary=async()=>{throw Object.assign(new Error("access denied"),{code:"EPERM"});};
    await expect(new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync()).rejects.toThrow("access denied");
  });
  it("retries mirror supersession without reporting a committed sync as failed",async()=>{
    const adapter=new MemoryAdapter();const api=new MemoryApi();const config=settings();const clear=new TextEncoder().encode("current\n");const hash=await hashBytes(clear);adapter.files.set("note.md",clear);
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000321",vaultId:"vault",parentId:null,deviceId:"other",deviceName:"Mobile",createdAt:new Date().toISOString(),message:"Current",entries:[{path:"note.md",hash,size:clear.length,mtime:1}]};
    api.head=head;api.snapshots.set(head.id,head);api.blobs.set(hash,await encryptBlob(clear,config.vaultKey,hash));config.initialized=true;config.lastSnapshotId=head.id;
    let plans=0;api.mirrorPlan=async(_snapshotId:string,entries:Snapshot["entries"])=>{plans++;if(plans<=3)throw new ApiError("Mirror snapshot is no longer the vault head",409,{});return {uploadPaths:entries.map((entry)=>entry.path),deletePaths:[],alreadyCurrent:false};};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{},async()=>{});await expect(engine.sync()).resolves.toMatchObject({snapshotId:head.id});expect(plans).toBe(4);
  });
  it("rebases a journaled edit onto this device's own newer snapshot without self-bifurcation",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.fullScanRequired=true;config.lastFullScanAt=new Date().toISOString();config.pendingPaths=["note.md"];
    const baseBytes=new TextEncoder().encode("base\n"),firstBytes=new TextEncoder().encode("first saved edit\n"),latestBytes=new TextEncoder().encode("latest local edit\n");
    const baseHash=await hashBytes(baseBytes),firstHash=await hashBytes(firstBytes),base:Snapshot={id:"00000000-0000-4000-8000-000000000330",vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:[{path:"note.md",hash:baseHash,size:baseBytes.length,mtime:1}]};
    const ownHead:Snapshot={...base,id:"00000000-0000-4000-8000-000000000331",parentId:base.id,message:"Sync",entries:[{path:"note.md",hash:firstHash,size:firstBytes.length,mtime:2}]};
    config.lastSnapshotId=base.id;api.snapshots.set(base.id,base);api.snapshots.set(ownHead.id,ownHead);api.head=ownHead;api.blobs.set(firstHash,await encryptBlob(firstBytes,config.vaultKey,firstHash));adapter.files.set("note.md",latestBytes);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.conflicts).toBe(0);expect(api.head?.parentId).toBe(ownHead.id);expect(api.head?.entries).toHaveLength(1);expect(api.head?.entries[0].path).toBe("note.md");expect([...adapter.files.keys()].some((path)=>path.includes("conflict"))).toBe(false);
  });
  it("recovers across several consecutive own snapshots when the saved checkpoint lags",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.pendingPaths=["note.md"];
    const versions=await Promise.all(["base\n","one\n","two\n"].map(async(text)=>{const bytes=new TextEncoder().encode(text);return {bytes,hash:await hashBytes(bytes)}}));
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000340",vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:[{path:"note.md",hash:versions[0].hash,size:versions[0].bytes.length,mtime:1}]};
    const first:Snapshot={...base,id:"00000000-0000-4000-8000-000000000341",parentId:base.id,entries:[{path:"note.md",hash:versions[1].hash,size:versions[1].bytes.length,mtime:2}]},second:Snapshot={...base,id:"00000000-0000-4000-8000-000000000342",parentId:first.id,entries:[{path:"note.md",hash:versions[2].hash,size:versions[2].bytes.length,mtime:3}]};
    for(const snapshot of [base,first,second])api.snapshots.set(snapshot.id,snapshot);api.head=second;api.blobs.set(versions[2].hash,await encryptBlob(versions[2].bytes,config.vaultKey,versions[2].hash));config.lastSnapshotId=base.id;adapter.files.set("note.md",new TextEncoder().encode("three\n"));
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(result.conflicts).toBe(0);expect(api.head?.parentId).toBe(second.id);expect(api.head?.entries).toHaveLength(1);
  });
  it("applies a journaled deletion after this device's own newer snapshot",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.pendingPaths=["delete.md"];
    const baseBytes=new TextEncoder().encode("base\n"),newBytes=new TextEncoder().encode("new\n"),baseHash=await hashBytes(baseBytes),newHash=await hashBytes(newBytes);
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000350",vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:[{path:"delete.md",hash:baseHash,size:baseBytes.length,mtime:1}]},ownHead:Snapshot={...base,id:"00000000-0000-4000-8000-000000000351",parentId:base.id,entries:[{path:"delete.md",hash:newHash,size:newBytes.length,mtime:2}]};
    api.snapshots.set(base.id,base);api.snapshots.set(ownHead.id,ownHead);api.head=ownHead;config.lastSnapshotId=base.id;
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(result.conflicts).toBe(0);expect(api.head?.entries).toEqual([]);expect(api.head?.parentId).toBe(ownHead.id);
  });
  it("applies a journaled move and edit after this device's own newer snapshot",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.pendingPaths=["Old/note.md","New/note.md"];
    const baseBytes=new TextEncoder().encode("base\n"),remoteBytes=new TextEncoder().encode("first edit\n"),localBytes=new TextEncoder().encode("moved and edited again\n"),baseHash=await hashBytes(baseBytes),remoteHash=await hashBytes(remoteBytes);
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000355",vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:[{path:"Old/note.md",hash:baseHash,size:baseBytes.length,mtime:1}]},ownHead:Snapshot={...base,id:"00000000-0000-4000-8000-000000000356",parentId:base.id,entries:[{path:"Old/note.md",hash:remoteHash,size:remoteBytes.length,mtime:2}]};
    api.snapshots.set(base.id,base);api.snapshots.set(ownHead.id,ownHead);api.head=ownHead;config.lastSnapshotId=base.id;adapter.files.set("New/note.md",localBytes);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(result.conflicts).toBe(0);expect(api.head?.entries.map((entry)=>entry.path)).toEqual(["New/note.md"]);expect(adapter.files.has("Old/note.md")).toBe(false);
  });
  it("keeps normal conflict protection when another device interrupts the ancestry",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.pendingPaths=["note.md"];
    const text=(prefix:string)=>new TextEncoder().encode(Array.from({length:30},(_,index)=>`${prefix}${index}`).join(" ")+"\n"),baseBytes=text("base"),ownBytes=text("own"),remoteBytes=text("remote"),localBytes=text("local");
    const baseHash=await hashBytes(baseBytes),ownHash=await hashBytes(ownBytes),remoteHash=await hashBytes(remoteBytes),base:Snapshot={id:"00000000-0000-4000-8000-000000000360",vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:[{path:"note.md",hash:baseHash,size:baseBytes.length,mtime:1}]};
    const own:Snapshot={...base,id:"00000000-0000-4000-8000-000000000361",parentId:base.id,entries:[{path:"note.md",hash:ownHash,size:ownBytes.length,mtime:2}]},other:Snapshot={...base,id:"00000000-0000-4000-8000-000000000362",parentId:own.id,deviceId:"mobile",deviceName:"Mobile",entries:[{path:"note.md",hash:remoteHash,size:remoteBytes.length,mtime:3}]};
    for(const snapshot of [base,own,other])api.snapshots.set(snapshot.id,snapshot);for(const [hash,bytes] of [[baseHash,baseBytes],[remoteHash,remoteBytes]] as const)api.blobs.set(hash,await encryptBlob(bytes,config.vaultKey,hash));api.head=other;config.lastSnapshotId=base.id;adapter.files.set("note.md",localBytes);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(result.conflicts).toBe(1);expect(api.head?.entries).toHaveLength(2);expect(api.head?.entries.some((entry)=>entry.path.includes("conflict"))).toBe(true);
  });
  it("does not self-rebase a full scan containing unjournaled differences",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.fullScanRequired=true;config.pendingPaths=["observed.md"];
    const text=(prefix:string)=>new TextEncoder().encode(Array.from({length:24},(_,index)=>`${prefix}${index}`).join(" ")+"\n"),baseBytes=text("base"),remoteBytes=text("remote"),localBytes=text("local");
    const baseHash=await hashBytes(baseBytes),remoteHash=await hashBytes(remoteBytes),base:Snapshot={id:"00000000-0000-4000-8000-000000000370",vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:["observed.md","unjournaled.md"].map((path)=>({path,hash:baseHash,size:baseBytes.length,mtime:1}))};
    const ownHead:Snapshot={...base,id:"00000000-0000-4000-8000-000000000371",parentId:base.id,entries:["observed.md","unjournaled.md"].map((path)=>({path,hash:remoteHash,size:remoteBytes.length,mtime:2}))};
    api.snapshots.set(base.id,base);api.snapshots.set(ownHead.id,ownHead);api.head=ownHead;api.blobs.set(baseHash,await encryptBlob(baseBytes,config.vaultKey,baseHash));api.blobs.set(remoteHash,await encryptBlob(remoteBytes,config.vaultKey,remoteHash));config.lastSnapshotId=base.id;adapter.files.set("observed.md",localBytes);adapter.files.set("unjournaled.md",localBytes);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(result.conflicts).toBe(2);expect(api.head?.entries.filter((entry)=>entry.path.includes("conflict"))).toHaveLength(2);
  });
  it("converges simultaneous disjoint edits from two devices",async()=>{
    const adapter=new MemoryAdapter();const api=new MemoryApi();const config=settings();config.initialized=true;
    const baseBytes=new TextEncoder().encode("a\nb\nc\n");const baseHash=await hashBytes(baseBytes);const base:Snapshot={id:"00000000-0000-4000-8000-000000000401",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:[{path:"note.md",hash:baseHash,size:baseBytes.length,mtime:1}]};
    api.head=base;api.snapshots.set(base.id,base);api.blobs.set(baseHash,await encryptBlob(baseBytes,config.vaultKey,baseHash));config.lastSnapshotId=base.id;adapter.files.set("note.md",new TextEncoder().encode("A\nb\nc\n"));
    const regularCommit=api.commit.bind(api);let raced=false;api.commit=async(body)=>{if(!raced){raced=true;const remoteBytes=new TextEncoder().encode("a\nb\nC\n");const remoteHash=await hashBytes(remoteBytes);api.blobs.set(remoteHash,await encryptBlob(remoteBytes,config.vaultKey,remoteHash));const remote:Snapshot={...base,id:"00000000-0000-4000-8000-000000000402",parentId:base.id,deviceId:"mobile",deviceName:"Mobile",entries:[{path:"note.md",hash:remoteHash,size:remoteBytes.length,mtime:2}]};api.head=remote;api.snapshots.set(remote.id,remote);throw new ApiError("Head moved",409,{head:remote});}return regularCommit(body);};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{},async()=>{});const result=await engine.sync();const finalEntry=api.head!.entries[0];
    expect(new TextDecoder().decode(await decryptBlob(api.blobs.get(finalEntry.hash)!,config.vaultKey,finalEntry.hash))).toBe("A\nb\nC\n");expect(result.conflicts).toBe(0);expect(api.head?.parentId).toBe("00000000-0000-4000-8000-000000000402");
  });
  it("does not multiply conflicts when the server head moves repeatedly before acceptance",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;const local=new TextEncoder().encode("local draft\n"),remote=new TextEncoder().encode("remote draft\n"),remoteHash=await hashBytes(remote);
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000410",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date(Date.now()-60_000).toISOString(),message:"Empty",entries:[]};config.lastSnapshotId=base.id;api.head=base;api.snapshots.set(base.id,base);adapter.files.set("Draft.md",local);
    const regularCommit=api.commit.bind(api);let races=0;api.commit=async(body)=>{if(races<2){expect(adapter.writeCalls).toHaveLength(0);const id=races++===0?"00000000-0000-4000-8000-000000000411":"00000000-0000-4000-8000-000000000412",parentId=api.head!.id;api.blobs.set(remoteHash,await encryptBlob(remote,config.vaultKey,remoteHash));api.head={...base,id,parentId,deviceId:"mobile",deviceName:"Mobile",createdAt:new Date().toISOString(),entries:[{path:"Draft.md",hash:remoteHash,size:remote.length,mtime:2}]};api.snapshots.set(id,api.head);throw new ApiError("Head moved",409,{head:api.head});}return regularCommit(body);};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{},async()=>{}).sync(),paths=api.head!.entries.map((entry)=>entry.path);
    expect(result.conflicts).toBe(1);expect(paths.filter((path)=>path.includes("conflict -"))).toHaveLength(1);expect([...adapter.files.keys()].filter((path)=>path.includes("conflict -"))).toHaveLength(1);
  });
  it("resumes an interrupted accepted application without re-uploading stale local bytes",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),old=new TextEncoder().encode("old\n"),accepted=new TextEncoder().encode("accepted\n"),hash=await hashBytes(accepted);
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000420",vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Accepted",entries:[{path:"note.md",hash,size:accepted.length,mtime:2}]};api.head=head;api.snapshots.set(head.id,head);api.blobs.set(hash,await encryptBlob(accepted,config.vaultKey,hash));adapter.files.set("note.md",old);config.initialized=true;config.lastSnapshotId=head.id;config.pendingApplyPaths=["note.md"];config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(result.uploaded).toBe(0);expect(api.commits).toBe(0);expect(adapter.files.get("note.md")).toEqual(accepted);expect(config.pendingApplyPaths).toEqual([]);
  });
  it("uses journaled observation time instead of misleading cross-device mtimes",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;const baseBytes=new TextEncoder().encode("a quick note\n"),localBytes=new TextEncoder().encode("a local note\n"),remoteBytes=new TextEncoder().encode("a remote note\n"),baseHash=await hashBytes(baseBytes),remoteHash=await hashBytes(remoteBytes);
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000430",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date(Date.now()-120_000).toISOString(),message:"Base",entries:[{path:"note.md",hash:baseHash,size:baseBytes.length,mtime:Date.now()-120_000}]},remote:Snapshot={...base,id:"00000000-0000-4000-8000-000000000431",parentId:base.id,deviceId:"mobile",deviceName:"Mobile",createdAt:new Date(Date.now()-60_000).toISOString(),entries:[{path:"note.md",hash:remoteHash,size:remoteBytes.length,mtime:Date.now()+86_400_000}]};
    config.lastSnapshotId=base.id;config.pendingPaths=["note.md"];config.pendingPathTimes={"note.md":Date.now()};api.snapshots.set(base.id,base);api.head=remote;api.blobs.set(baseHash,await encryptBlob(baseBytes,config.vaultKey,baseHash));api.blobs.set(remoteHash,await encryptBlob(remoteBytes,config.vaultKey,remoteHash));adapter.files.set("note.md",localBytes);
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();const entry=api.head!.entries.find((item)=>item.path==="note.md")!;expect(new TextDecoder().decode(await decryptBlob(api.blobs.get(entry.hash)!,config.vaultKey,entry.hash))).toBe("a local note\n");
  });
  it("bifurcates independently created same-path notes with linked warnings",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.deviceName="Desktop";config.initialized=true;
    const local=new TextEncoder().encode("# Desktop draft\n"),remote=new TextEncoder().encode("# Mobile draft\n"),remoteHash=await hashBytes(remote);
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000500",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Known empty base",entries:[]};
    config.lastSnapshotId=base.id;api.snapshots.set(base.id,base);
    adapter.files.set("Project.md",local);api.blobs.set(remoteHash,await encryptBlob(remote,config.vaultKey,remoteHash));
    api.head={id:"00000000-0000-4000-8000-000000000501",vaultId:"vault",parentId:base.id,deviceId:"mobile",deviceName:"Mobile",createdAt:new Date().toISOString(),message:"Offline create",entries:[{path:"Project.md",hash:remoteHash,size:remote.length,mtime:2}]};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});
    const result=await engine.sync(),paths=api.head!.entries.map((entry)=>entry.path);
    expect(result.conflicts).toBe(1);expect(paths).toHaveLength(2);expect(paths).toContain("Project.md");
    const copyPath=paths.find((path)=>path!=="Project.md")!;expect(copyPath).toContain("conflict - Desktop");
    const original=new TextDecoder().decode(adapter.files.get("Project.md")),copy=new TextDecoder().decode(adapter.files.get(copyPath));
    expect(original).toContain("[!warning] Gib Sync conflict");expect(original).toContain(`[[${copyPath.slice(0,-3)}`);
    expect(copy).toContain("# Desktop draft");expect(copy).toContain("[[Project|Project.md]]");
  });
  it("keeps an edited note with a warning when another device deleted it",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;
    const baseBytes=new TextEncoder().encode("base\n"),baseHash=await hashBytes(baseBytes),editedBytes=new TextEncoder().encode("mobile edit\n"),editedHash=await hashBytes(editedBytes);
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000601",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:[{path:"Delete.md",hash:baseHash,size:baseBytes.length,mtime:1}]};
    const remote:Snapshot={...base,id:"00000000-0000-4000-8000-000000000602",parentId:base.id,deviceId:"mobile",deviceName:"Mobile",entries:[{path:"Delete.md",hash:editedHash,size:editedBytes.length,mtime:2}]};
    api.snapshots.set(base.id,base);api.head=remote;api.blobs.set(editedHash,await encryptBlob(editedBytes,config.vaultKey,editedHash));config.lastSnapshotId=base.id;
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.conflicts).toBe(1);expect(new TextDecoder().decode(adapter.files.get("Delete.md"))).toContain("[!warning] Gib Sync deletion conflict");
  });
});
