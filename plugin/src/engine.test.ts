import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import type { Snapshot } from "@gib-sync/protocol";
import { commitFingerprint, cooperativeYield, FileChangedDuringReadError, LOW_MEMORY_DOWNLOAD_BYTES, SyncCancelledError, SyncEngine } from "./engine";
import { ApiError,ApiTransportError } from "./api";
import { recoverSync } from "./sync-recovery";
import type { GibSyncApi } from "./api";
import { decryptBlob, encryptBlob, hashBytes, toBase64Url } from "./crypto";
import { DEFAULT_SETTINGS, type GibSyncSettings } from "./settings";

beforeAll(() => Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true }));

class MemoryAdapter {
  files = new Map<string, Uint8Array>(); trashed = new Map<string,Uint8Array>();dirs = new Set<string>();dirMtimes=new Map<string,number>();listCalls=0;readCalls:string[]=[];writeCalls:string[]=[];rmdirCalls:{path:string;recursive:boolean}[]=[];
  async list(path: string) {
    if(!path.startsWith(".gib-sync"))this.listCalls++;
    const prefix = path ? `${path}/` : ""; const files: string[] = [], folders = new Set<string>();
    for (const name of this.files.keys()) if (name.startsWith(prefix)) { const rest = name.slice(prefix.length); const slash = rest.indexOf("/"); if (slash < 0) files.push(name); else folders.add(`${prefix}${rest.slice(0,slash)}`); }
    for(const name of this.dirs)if(name.startsWith(prefix)&&name!==path){const rest=name.slice(prefix.length),slash=rest.indexOf("/");folders.add(slash<0?name:`${prefix}${rest.slice(0,slash)}`);}
    return { files, folders:[...folders] };
  }
  async readBinary(path: string) { if(!/^\.gib-sync\/(?:inventory-v2|conflicts-v2|operation-journal-v2|intents-v2|packages-v2)\/.*\.json$/.test(path))this.readCalls.push(path);const bytes=this.files.get(path);if(!bytes)throw Object.assign(new Error(`ENOENT: file not found, open '${path}'`),{code:"ENOENT"});return bytes.slice().buffer; }
  async writeBinary(path: string, data: ArrayBuffer) { if(!path.startsWith(".gib-sync/"))this.writeCalls.push(path);this.files.set(path, new Uint8Array(data)); }
  async stat(path: string) { const bytes = this.files.get(path); if(bytes)return {type:"file" as const,ctime:1,mtime:1,size:bytes.length};return this.dirs.has(path)||[...this.files.keys()].some(item=>item.startsWith(`${path}/`))||[...this.dirs].some(item=>item.startsWith(`${path}/`))?{type:"folder" as const,ctime:1,mtime:this.dirMtimes.get(path)??1,size:0}:null; }
  async exists(path: string) { return this.files.has(path) || this.dirs.has(path)||[...this.files.keys()].some(item=>item.startsWith(`${path}/`))||[...this.dirs].some(item=>item.startsWith(`${path}/`)); }
  async mkdir(path: string) { this.dirs.add(path);this.dirMtimes.set(path,Date.now()); }
  async remove(path: string) { this.files.delete(path); }
  async trashLocal(path:string){const bytes=this.files.get(path);if(bytes)this.trashed.set(path,bytes);this.files.delete(path);}
  getResourcePath(path:string){return `app://gib-sync-test/${encodeURIComponent(path)}`;}
  async rename(path:string,destination:string){if(this.dirs.has(path)||[...this.files.keys()].some(item=>item.startsWith(`${path}/`))){if(await this.exists(destination)||[...this.files.keys()].some(item=>item.startsWith(`${destination}/`)))throw new Error("directory destination already exists");for(const [item,bytes] of [...this.files])if(item.startsWith(`${path}/`)){this.files.set(`${destination}${item.slice(path.length)}`,bytes);this.files.delete(item);}for(const item of [...this.dirs])if(item===path||item.startsWith(`${path}/`)){this.dirs.add(`${destination}${item.slice(path.length)}`);this.dirs.delete(item);}return;}const bytes=this.files.get(path);if(!bytes)throw new Error("missing source");if(!destination.startsWith(".gib-sync/"))this.writeCalls.push(destination);this.files.set(destination,bytes);this.files.delete(path);}
  async copy(path:string,destination:string){const bytes=this.files.get(path);if(!bytes)throw new Error("missing source");if(this.files.has(destination)||this.dirs.has(destination))throw Object.assign(new Error("destination already exists"),{code:"EEXIST"});if(!destination.startsWith(".gib-sync/"))this.writeCalls.push(destination);this.files.set(destination,bytes.slice());}
  async rmdir(path:string,recursive:boolean){this.rmdirCalls.push({path,recursive});const prefix=`${path}/`;if(!recursive&&([...this.files.keys()].some(name=>name.startsWith(prefix))||[...this.dirs].some(name=>name.startsWith(prefix))))throw new Error("folder is not empty");if(recursive){for(const name of this.files.keys())if(name.startsWith(prefix))this.files.delete(name);for(const name of this.dirs)if(name.startsWith(prefix))this.dirs.delete(name);}this.dirs.delete(path);this.dirMtimes.delete(path);}
}

class MemoryApi {
  head: Snapshot | null = null; blobs = new Map<string,Uint8Array>(); contents=new Map<string,Uint8Array>();contentCalls:string[]=[];mirror = new Map<string,Uint8Array>(); snapshots = new Map<string,Snapshot>(); commits = 0;readyHeads:string[]=[];lastCommitBody:any=null;
  async state() { return {head:this.head}; }
  async headState() { return {headId:this.head?.id??null}; }
  async snapshot(id: string) { const snapshot=this.snapshots.get(id)??(this.head?.id===id?this.head:null);if(!snapshot)throw new ApiError("missing",404,null);return snapshot; }
  async getBlob(hash: string) { return this.blobs.get(hash)!; }
  async getContent(hash:string){this.contentCalls.push(hash);return this.contents.get(hash)!;}
  async putBlob(hash: string, bytes: Uint8Array) { this.blobs.set(hash,bytes); }
  async markDeviceReady(headId:string|null){this.readyHeads.push(headId??"");return {ok:true};}
  async commit(body: {parentId:string|null;message:string;entries:Snapshot["entries"];folders?:string[]}) {
    this.commits++;this.lastCommitBody=body; this.head = {id:`00000000-0000-4000-8000-${String(this.commits).padStart(12,"0")}`,vaultId:"vault",parentId:body.parentId,deviceId:"device",deviceName:"Test",createdAt:new Date().toISOString(),message:body.message,entries:body.entries,folders:body.folders};this.snapshots.set(this.head.id,this.head);return this.head;
  }
  async mirrorPlan(_snapshotId:string,entries:Snapshot["entries"]){return {uploadPaths:entries.filter((entry)=>!this.mirror.has(entry.path)).map((entry)=>entry.path),deletePaths:[],alreadyCurrent:false};}
  async putMirrorFile(_snapshotId:string,path:string,_hash:string,bytes:Uint8Array){this.mirror.set(path,bytes.slice());}
  async mirrorComplete(snapshotId:string){return {mirroredFiles:this.mirror.size,deletedFiles:0,snapshotId};}
}

function settings(): GibSyncSettings {
  const key = new Uint8Array(32); key.fill(7);
  return {...structuredClone(DEFAULT_SETTINGS),serverUrl:"https://sync.test",vaultId:"vault",vaultName:"Test",vaultKey:toBase64Url(key),deviceId:"device",deviceName:"Desktop",deviceToken:"token"};
}

async function incomingFixture(){
  const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),before=new TextEncoder().encode("original\n"),after=new TextEncoder().encode("incoming\n"),oldHash=await hashBytes(before),hash=await hashBytes(after);
  const base:Snapshot={id:"00000000-0000-4000-8000-000000009001",vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:[{path:"note.md",hash:oldHash,size:before.length,mtime:1}]};
  const target:Snapshot={...base,id:"00000000-0000-4000-8000-000000009002",parentId:base.id,deviceId:"other",deviceName:"Phone",entries:[{path:"note.md",hash,size:after.length,mtime:2}]};
  api.head=target;api.snapshots.set(base.id,base);api.snapshots.set(target.id,target);api.blobs.set(oldHash,await encryptBlob(before,config.vaultKey,oldHash));api.blobs.set(hash,await encryptBlob(after,config.vaultKey,hash));
  adapter.files.set("note.md",before);config.initialized=true;config.lastSnapshotId=base.id;return {adapter,api,config,before,after,oldHash,hash,base,target};
}

async function outgoingStreamFixture(){
  const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new Uint8Array(LOW_MEMORY_DOWNLOAD_BYTES+123);clear.fill(6);const hash=await hashBytes(clear);adapter.files.set("large.bin",clear);let offset=0,completed=false,supported=true,completions=0,largest=0;const chunks=new Map<number,Uint8Array>(),indexes:number[]=[];
  const native=adapter as MemoryAdapter&{getResourcePath:(path:string)=>string};native.getResourcePath=path=>`https://resource.test/${encodeURIComponent(path)}`;
  const streaming=api as MemoryApi&{supportsStreamUpload:()=>boolean;disableStreamUpload:()=>void;beginContentUpload:()=>Promise<any>;putContentUploadChunk:(id:string,index:number,bytes:Uint8Array,hash:string,signal:AbortSignal)=>Promise<any>;completeContentUpload:()=>Promise<any>};
  streaming.supportsStreamUpload=()=>supported;streaming.disableStreamUpload=()=>{supported=false;};streaming.beginContentUpload=async()=>({id:"session",hash,size:clear.length,offset,chunkBytes:262144,complete:completed});streaming.putContentUploadChunk=async(id,index,bytes,chunkHash)=>{expect(await hashBytes(bytes)).toBe(chunkHash);expect(index*262144).toBe(offset);largest=Math.max(largest,bytes.length);indexes.push(index);chunks.set(index,bytes.slice());offset+=bytes.length;return {id,offset};};streaming.completeContentUpload=async()=>{const received=new Uint8Array(clear.length);for(const [index,bytes] of chunks)received.set(bytes,index*262144);expect(await hashBytes(received)).toBe(hash);api.blobs.set(hash,await encryptBlob(received,config.vaultKey,hash));completed=true;completions++;return {id:"session",hash,size:clear.length,offset,chunkBytes:262144,complete:true};};api.mirrorPlan=async()=>({uploadPaths:[],deletePaths:[],alreadyCurrent:true});
  vi.stubGlobal("fetch",async(resource:string)=>{const path=decodeURIComponent(resource.slice(resource.lastIndexOf("/")+1)),bytes=adapter.files.get(path)!;let current=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){if(current>=bytes.length){controller.close();return;}controller.enqueue(bytes.subarray(current,current+64*1024));current+=64*1024;}}));});
  return {adapter,native,api,streaming,config,clear,hash,indexes,get largest(){return largest;},get completions(){return completions;}};
}

describe("resumable native outbound upload",()=>{
  it("uploads a large mobile file in 256 KiB chunks with no full binary read or client encryption",async()=>{const f=await outgoingStreamFixture(),put=vi.spyOn(f.api,"putBlob");try{const result=await new SyncEngine(f.native as unknown as DataAdapter,f.streaming as unknown as GibSyncApi,()=>f.config,async()=>{},()=>{},undefined,undefined,async()=>{},true).sync();expect(result.uploaded).toBe(1);expect(f.largest).toBe(262144);expect(f.indexes).toHaveLength(33);expect(f.completions).toBe(1);expect(f.adapter.readCalls).toEqual([]);expect(put).not.toHaveBeenCalled();expect(f.api.commits).toBe(1);}finally{vi.unstubAllGlobals();}});
  it("resumes an acknowledged prefix after a lost chunk reply without retransmitting it",async()=>{const f=await outgoingStreamFixture(),put=f.streaming.putContentUploadChunk;let fail=true;f.streaming.putContentUploadChunk=async(...args)=>{const receipt=await put(...args);if(fail&&args[1]===1){fail=false;throw new ApiTransportError(new Error("reply lost"));}return receipt;};const engine=()=>new SyncEngine(f.native as unknown as DataAdapter,f.streaming as unknown as GibSyncApi,()=>f.config,async()=>{},()=>{},undefined,undefined,async()=>{},true);try{await expect(engine().sync()).rejects.toBeInstanceOf(ApiTransportError);expect(f.api.commits).toBe(0);await engine().sync();expect(f.indexes).toEqual(Array.from({length:33},(_,index)=>index));expect(f.completions).toBe(1);expect(f.adapter.readCalls).toEqual([]);}finally{vi.unstubAllGlobals();}});
  it("does not complete or commit a source changed while it was streamed",async()=>{const f=await outgoingStreamFixture(),put=f.streaming.putContentUploadChunk;f.streaming.putContentUploadChunk=async(...args)=>{const receipt=await put(...args);if(args[1]===0)f.clear[f.clear.length-1]=9;return receipt;};try{await expect(new SyncEngine(f.native as unknown as DataAdapter,f.streaming as unknown as GibSyncApi,()=>f.config,async()=>{},()=>{},undefined,undefined,async()=>{},true).sync()).rejects.toBeInstanceOf(FileChangedDuringReadError);expect(f.completions).toBe(0);expect(f.api.commits).toBe(0);expect(f.adapter.readCalls).toEqual([]);}finally{vi.unstubAllGlobals();}});
  it("pauses after a chunk without completing or publishing the file",async()=>{const f=await outgoingStreamFixture(),put=f.streaming.putContentUploadChunk;let proceed=true;f.streaming.putContentUploadChunk=async(...args)=>{const receipt=await put(...args);proceed=false;return receipt;};try{await expect(new SyncEngine(f.native as unknown as DataAdapter,f.streaming as unknown as GibSyncApi,()=>f.config,async()=>{},()=>{},undefined,undefined,async()=>{},true,undefined,()=>proceed).sync()).rejects.toBeInstanceOf(SyncCancelledError);expect(f.completions).toBe(0);expect(f.api.commits).toBe(0);expect(f.indexes).toEqual([0]);}finally{vi.unstubAllGlobals();}});
  it("does not fall back to whole-file encryption for a real upload service error",async()=>{const f=await outgoingStreamFixture(),put=vi.spyOn(f.api,"putBlob");f.streaming.beginContentUpload=async()=>{throw new ApiError("Server busy",503,null);};try{await expect(new SyncEngine(f.native as unknown as DataAdapter,f.streaming as unknown as GibSyncApi,()=>f.config,async()=>{},()=>{},undefined,undefined,async()=>{},true).sync()).rejects.toMatchObject({status:503});expect(put).not.toHaveBeenCalled();expect(f.adapter.readCalls).toEqual([]);expect(f.streaming.supportsStreamUpload()).toBe(true);}finally{vi.unstubAllGlobals();}});
  it("still verifies the entire source when the server reports an already complete session",async()=>{const f=await outgoingStreamFixture();f.streaming.beginContentUpload=async()=>({id:"session",hash:f.hash,size:f.clear.length,offset:f.clear.length,chunkBytes:262144,complete:true});const before=f.native.getResourcePath;let reads=0;f.native.getResourcePath=path=>{if(++reads===2)f.clear[f.clear.length-1]=9;return before(path);};try{await expect(new SyncEngine(f.native as unknown as DataAdapter,f.streaming as unknown as GibSyncApi,()=>f.config,async()=>{},()=>{},undefined,undefined,async()=>{},true).sync()).rejects.toBeInstanceOf(FileChangedDuringReadError);expect(f.api.commits).toBe(0);expect(f.completions).toBe(0);expect(f.adapter.readCalls).toEqual([]);}finally{vi.unstubAllGlobals();}});
  it("uses the legacy encrypted upload only when an advertised route is unsupported",async()=>{const f=await outgoingStreamFixture();f.streaming.beginContentUpload=async()=>{throw new ApiError("Not found",404,null);};const put=vi.spyOn(f.api,"putBlob");try{await new SyncEngine(f.native as unknown as DataAdapter,f.streaming as unknown as GibSyncApi,()=>f.config,async()=>{},()=>{},undefined,undefined,async()=>{},true).sync();expect(f.streaming.supportsStreamUpload()).toBe(false);expect(put).toHaveBeenCalledTimes(1);expect(f.adapter.readCalls).toContain("large.bin");expect(f.api.commits).toBe(1);}finally{vi.unstubAllGlobals();}});
  it("does not silently buffer a large file when an advertised server has an unsupported native adapter",async()=>{const f=await outgoingStreamFixture();Object.defineProperty(f.native,"getResourcePath",{value:undefined});try{await expect(new SyncEngine(f.native as unknown as DataAdapter,f.streaming as unknown as GibSyncApi,()=>f.config,async()=>{},()=>{},undefined,undefined,async()=>{},true).sync()).rejects.toThrow("cannot safely stream this large file");expect(f.completions).toBe(0);expect(f.api.commits).toBe(0);expect(f.adapter.readCalls).toEqual([]);}finally{vi.unstubAllGlobals();}});
});

async function largeConflictFixture(path:string){
  const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),baseBytes=new Uint8Array(LOW_MEMORY_DOWNLOAD_BYTES+123),localBytes=baseBytes.slice(),remoteBytes=baseBytes.slice();baseBytes.fill(97);localBytes.fill(98);remoteBytes.fill(99);const baseHash=await hashBytes(baseBytes),localHash=await hashBytes(localBytes),remoteHash=await hashBytes(remoteBytes);adapter.files.set(path,localBytes);api.contents.set(baseHash,baseBytes);api.contents.set(remoteHash,remoteBytes);
  const base:Snapshot={id:"00000000-0000-4000-8000-000000009801",vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Desktop",createdAt:new Date(Date.now()-2000).toISOString(),message:"Base",entries:[{path,hash:baseHash,size:baseBytes.length,mtime:1,fileId:"stable-file"}]},target:Snapshot={...base,id:"00000000-0000-4000-8000-000000009802",parentId:base.id,deviceId:"phone",deviceName:"Phone",createdAt:new Date(Date.now()-1000).toISOString(),entries:[{path,hash:remoteHash,size:remoteBytes.length,mtime:1,fileId:"stable-file",revision:{id:"remote-rev",parentId:null,deviceId:"phone",deviceName:"Phone",modifiedAt:Date.now()-1000}}]};api.head=target;api.snapshots.set(base.id,base);api.snapshots.set(target.id,target);config.initialized=true;config.lastSnapshotId=base.id;config.pendingPaths=[path];config.pendingPathTimes={[path]:Date.now()};
  const native=adapter as MemoryAdapter&{appendBinary:(path:string,bytes:ArrayBuffer)=>Promise<void>;getResourcePath:(path:string)=>string};let maxAppend=0,maxUpload=0;native.appendBinary=async(name,data)=>{maxAppend=Math.max(maxAppend,data.byteLength);const prior=adapter.files.get(name)??new Uint8Array(),bytes=new Uint8Array(prior.length+data.byteLength);bytes.set(prior);bytes.set(new Uint8Array(data),prior.length);adapter.files.set(name,bytes);};native.getResourcePath=name=>`https://resource.test/${encodeURIComponent(name)}`;
  const sessions=new Map<string,{hash:string;size:number;offset:number;chunks:Uint8Array[]}>(),streaming=api as MemoryApi&{supportsStreamUpload:()=>boolean;disableStreamUpload:()=>void;beginContentUpload:(hash:string,size:number)=>Promise<any>;putContentUploadChunk:(id:string,index:number,bytes:Uint8Array,hash:string)=>Promise<any>;completeContentUpload:(id:string)=>Promise<any>;streamContent:(hash:string,size:number,onChunk:(bytes:Uint8Array)=>Promise<void>,checkpoint:()=>void)=>Promise<void>};streaming.supportsStreamUpload=()=>true;streaming.disableStreamUpload=()=>{};streaming.beginContentUpload=async(hash,size)=>{const session=sessions.get(hash)??{hash,size,offset:0,chunks:[]};sessions.set(hash,session);return {id:hash,...session,chunkBytes:262144,complete:api.contents.has(hash)};};streaming.putContentUploadChunk=async(id,index,bytes,hash)=>{expect(await hashBytes(bytes)).toBe(hash);const session=sessions.get(id)!;expect(index*262144).toBe(session.offset);maxUpload=Math.max(maxUpload,bytes.length);session.chunks.push(bytes.slice());session.offset+=bytes.length;return {id,offset:session.offset};};streaming.completeContentUpload=async(id)=>{const session=sessions.get(id)!,body=new Uint8Array(session.size);let offset=0;for(const bytes of session.chunks){body.set(bytes,offset);offset+=bytes.length;}expect(await hashBytes(body)).toBe(session.hash);api.contents.set(session.hash,body);return {id,...session,chunkBytes:262144,complete:true};};streaming.streamContent=async(hash,_size,onChunk,checkpoint)=>{const body=api.contents.get(hash)!;for(let offset=0;offset<body.length;offset+=64*1024){checkpoint();await onChunk(body.subarray(offset,offset+64*1024));}};api.mirrorPlan=async()=>({uploadPaths:[],deletePaths:[],alreadyCurrent:true});
  vi.stubGlobal("fetch",async(resource:string)=>{const name=decodeURIComponent(resource.slice(resource.lastIndexOf("/")+1)),bytes=adapter.files.get(name)!;let offset=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){if(offset>=bytes.length){controller.close();return;}controller.enqueue(bytes.subarray(offset,offset+64*1024));offset+=64*1024;}}));});
  return {adapter,native,api,streaming,config,path,base,target,localBytes,remoteBytes,localHash,remoteHash,get maxAppend(){return maxAppend;},get maxUpload(){return maxUpload;}};
}

describe("bounded large conflict preservation",()=>{
  for(const extension of ["bin","md"])it(`preserves both complete large ${extension} versions without full reads`,async()=>{const f=await largeConflictFixture(`note.${extension}`),get=vi.spyOn(f.api,"getContent"),blob=vi.spyOn(f.api,"getBlob"),put=vi.spyOn(f.api,"putBlob");try{const result=await new SyncEngine(f.native as unknown as DataAdapter,f.streaming as unknown as GibSyncApi,()=>f.config,async()=>{},()=>{},undefined,undefined,async()=>{},true).sync();expect(result.conflicts).toBe(1);expect(f.api.head!.entries).toHaveLength(2);const contents=f.api.head!.entries.map(entry=>f.adapter.files.get(entry.path)!);const hashes:string[]=[];for(const body of contents){let offset=0;if(extension==="md"){const prefix=new TextDecoder().decode(body.subarray(0,1024));expect(prefix).toContain("> [!warning] Gib Sync conflict");expect(prefix).toContain("Phone");offset=prefix.indexOf("\n\n")+2;expect(offset).toBeGreaterThan(2);}hashes.push(await hashBytes(body.subarray(offset)));}expect(hashes.sort()).toEqual([f.localHash,f.remoteHash].sort());expect(f.maxUpload).toBeLessThanOrEqual(262144);expect(f.maxAppend).toBeLessThanOrEqual(64*1024);expect(f.adapter.readCalls).toEqual([]);expect(get).not.toHaveBeenCalled();expect(blob).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}});
  it("preserves a large Markdown deletion survivor with the existing warning callout",async()=>{const f=await largeConflictFixture("note.md");f.target.entries=[];try{const result=await new SyncEngine(f.native as unknown as DataAdapter,f.streaming as unknown as GibSyncApi,()=>f.config,async()=>{},()=>{},undefined,undefined,async()=>{},true).sync();expect(result.conflicts).toBe(1);expect(f.api.head!.entries).toHaveLength(1);const body=f.adapter.files.get("note.md")!,prefix=new TextDecoder().decode(body.subarray(0,1024));expect(prefix).toContain("> [!warning] Gib Sync deletion conflict");expect(await hashBytes(body.subarray(prefix.indexOf("\n\n")+2))).toBe(f.localHash);expect(f.adapter.readCalls).toEqual([]);}finally{vi.unstubAllGlobals();}});
  it("selects a complete newer large settings file without parsing or buffering its JSON",async()=>{const f=await largeConflictFixture(".obsidian/plugins/sample/data.json");f.config.syncPlugins=true;f.config.pluginSyncBootstrapPending=false;f.config.pendingPathTimes[f.path]=Date.now()-5000;try{const result=await new SyncEngine(f.native as unknown as DataAdapter,f.streaming as unknown as GibSyncApi,()=>f.config,async()=>{},()=>{},undefined,undefined,async()=>{},true).sync();expect(result.conflicts).toBe(0);expect(result.resolved).toBeGreaterThan(0);expect(await hashBytes(f.adapter.files.get(f.path)!)).toBe(f.remoteHash);expect([...f.adapter.files].some(([name,body])=>name.startsWith(".gib-sync/local-recovery/")&&body.length===f.localBytes.length)).toBe(true);expect(f.adapter.readCalls).toEqual([]);}finally{vi.unstubAllGlobals();}});
});

describe("durable apply ownership and recovery",()=>{
  it("downloads the server copy without publishing existing local differences when explicitly selected",async()=>{
    const {adapter,api,config,before,after,target}=await incomingFixture();config.initialized=false;config.lastSnapshotId=null;config.onboardingMode="server-first";const scratch=new TextEncoder().encode("local-only draft\n");adapter.files.set("scratch.md",scratch);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(result).toMatchObject({uploaded:0,conflicts:0,deleted:1,downloaded:1});expect(api.commits).toBe(0);expect(config.lastSnapshotId).toBe(target.id);expect(adapter.files.get("note.md")).toEqual(after);expect(adapter.files.has("scratch.md")).toBe(false);
    const recoveries=[...adapter.files].filter(([path])=>path.startsWith(".gib-sync/local-recovery/"));expect(recoveries.some(([,bytes])=>new TextDecoder().decode(bytes)===new TextDecoder().decode(before))).toBe(true);expect(recoveries.some(([,bytes])=>new TextDecoder().decode(bytes)===new TextDecoder().decode(scratch))).toBe(true);expect(api.readyHeads).toEqual([target.id]);
  });
  for(const interrupted of [false,true])it(`streams an incoming large file in bounded chunks ${interrupted?"after an interrupted-stage restart":"without any full binary read"}`,async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new Uint8Array(LOW_MEMORY_DOWNLOAD_BYTES+123);clear.fill(7);const hash=await hashBytes(clear);api.contents.set(hash,clear);let largestAppend=0,appends=0;
    const native=adapter as MemoryAdapter&{appendBinary:(path:string,bytes:ArrayBuffer)=>Promise<void>;getResourcePath:(path:string)=>string};native.appendBinary=async(path,data)=>{appends++;largestAppend=Math.max(largestAppend,data.byteLength);const previous=adapter.files.get(path)??new Uint8Array(),combined=new Uint8Array(previous.byteLength+data.byteLength);combined.set(previous);combined.set(new Uint8Array(data),previous.byteLength);adapter.files.set(path,combined);};native.getResourcePath=path=>`https://resource.test/${encodeURIComponent(path)}`;
    let failOnce=interrupted;const streaming=api as MemoryApi&{streamContent:(hash:string,size:number,onChunk:(chunk:Uint8Array)=>Promise<void>,checkpoint:()=>void)=>Promise<void>};streaming.streamContent=async(_hash,_size,onChunk,checkpoint)=>{for(let offset=0;offset<clear.byteLength;offset+=128*1024){checkpoint();await onChunk(clear.subarray(offset,offset+128*1024));if(failOnce&&offset>=128*1024){failOnce=false;throw new Error("stream interrupted");}}};
    api.head={id:"00000000-0000-4000-8000-000000009080",vaultId:"vault",parentId:null,deviceId:"other",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Large incoming",entries:[{path:"large.bin",hash,size:clear.byteLength,mtime:1}]};api.snapshots.set(api.head.id,api.head);api.mirrorPlan=async()=>({uploadPaths:[],deletePaths:[],alreadyCurrent:true});
    vi.stubGlobal("fetch",async(resource:string)=>{const path=decodeURIComponent(resource.slice(resource.lastIndexOf("/")+1)),bytes=adapter.files.get(path)!;let offset=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){if(offset>=bytes.byteLength){controller.close();return;}controller.enqueue(bytes.subarray(offset,offset+64*1024));offset+=64*1024;}}));});
    const engine=()=>new SyncEngine(native as unknown as DataAdapter,streaming as unknown as GibSyncApi,()=>config,async()=>{},()=>{},undefined,undefined,async()=>{},true);
    try{if(interrupted){await expect(engine().sync()).rejects.toThrow("stream interrupted");expect(adapter.files.has("large.bin")).toBe(false);config.pendingApplyOperations={};}const result=await engine().sync();expect(result.downloaded).toBe(interrupted?0:1);expect(config.pendingApplySnapshotId).toBeNull();expect(adapter.files.get("large.bin")?.byteLength).toBe(clear.byteLength);expect(await hashBytes(adapter.files.get("large.bin")!)).toBe(hash);expect(appends).toBeGreaterThan(64);expect(largestAppend).toBeLessThanOrEqual(128*1024);expect(adapter.readCalls.every(path=>path.endsWith(".journal"))).toBe(true);expect(api.contentCalls).toEqual([]);}finally{vi.unstubAllGlobals();}
  });
  for(const boundary of ["backup","replace"] as const)it(`replays its per-operation journal after process loss at the ${boundary} transfer without saving full settings`,async()=>{
    const {adapter,api,config,before,after}=await incomingFixture();let persisted=structuredClone(config),crashedFiles:Map<string,Uint8Array>|undefined;const rename=adapter.rename.bind(adapter),copy=adapter.copy.bind(adapter);
    const capture=()=>{crashedFiles=new Map([...adapter.files].map(([name,bytes])=>[name,bytes.slice()]));throw new Error("process lost");};
    const save=async()=>{persisted=structuredClone(config);};adapter.rename=async(path,to)=>{await rename(path,to);if(!crashedFiles&&boundary==="backup"&&to.endsWith(".backup"))capture();};adapter.copy=async(path,to)=>{await copy(path,to);if(!crashedFiles&&boundary==="replace"&&path.endsWith(".stage")&&to==="note.md")capture();};
    await expect(new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,save,()=>{}).sync()).rejects.toThrow("process lost");expect(persisted.pendingApplyOperations).toEqual({});
    const restartedAdapter=new MemoryAdapter();restartedAdapter.files=crashedFiles!;const restarted=structuredClone(persisted);
    await new SyncEngine(restartedAdapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>restarted,async()=>{},()=>{}).sync();expect(restartedAdapter.files.get("note.md")).toEqual(after);expect(api.commits).toBe(0);expect([...restartedAdapter.files].some(([path,bytes])=>path.startsWith(".gib-sync/local-recovery/")&&new TextDecoder().decode(bytes)===new TextDecoder().decode(before))).toBe(true);
  });
  it("does not rewrite the complete settings journal for every received file",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),entries:Snapshot["entries"]=[];let saves=0;
    for(let index=0;index<40;index++){const clear=new TextEncoder().encode(`note ${index}\n`),hash=await hashBytes(clear);entries.push({path:`note-${index}.md`,hash,size:clear.length,mtime:1});api.blobs.set(hash,await encryptBlob(clear,config.vaultKey,hash));}
    api.head={id:"00000000-0000-4000-8000-000000009050",vaultId:"vault",parentId:null,deviceId:"other",deviceName:"Phone",createdAt:new Date().toISOString(),message:"First download",entries};api.snapshots.set(api.head.id,api.head);
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{saves++;},()=>{}).sync();expect(saves).toBeLessThan(10);expect([...adapter.files.keys()].filter(path=>!path.startsWith(".gib-sync/"))).toHaveLength(40);
  });
  for(const phase of ["planned","staged","backed-up","promoting","applied"] as const)it(`resumes an accepted replacement after interruption in ${phase}`,async()=>{
    const {adapter,api,config,before,after,oldHash,hash,base,target}=await incomingFixture();
    const identity=await hashBytes(new TextEncoder().encode(`${target.id}\nnote.md\n${hash}\n${oldHash}`)),operation={targetHash:hash,priorHash:oldHash,stagePath:`.gib-sync/apply/${identity}.stage`,backupPath:`.gib-sync/apply/${identity}.backup`,phase};
    config.pendingApplySnapshotId=target.id;config.pendingApplyBaseSnapshotId=base.id;config.pendingApplyPaths=["note.md"];config.pendingApplyPriorHashes={"note.md":oldHash};config.pendingApplyPriorEntries={"note.md":base.entries[0]};config.pendingApplyOperations={"note.md":operation};
    if(phase!=="planned")adapter.files.set(operation.stagePath,after);
    if(phase==="backed-up"||phase==="promoting"||phase==="applied"){adapter.files.set(operation.backupPath,before);adapter.files.delete("note.md");}
    if(phase==="applied")adapter.files.set("note.md",after);
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(adapter.files.get("note.md")).toEqual(after);expect(api.commits).toBe(0);expect(config.lastSnapshotId).toBe(target.id);expect(config.pendingApplyOperations).toEqual({});expect(config.pendingApplyPaths).toEqual([]);
    expect([...adapter.files].some(([path,bytes])=>path.startsWith(".gib-sync/local-recovery/")&&new TextDecoder().decode(bytes)==="original\n")).toBe(true);
  });
  it("rejects corrupt staged bytes before replacing the original note",async()=>{
    const {adapter,api,config,before}=await incomingFixture(),write=adapter.writeBinary.bind(adapter);
    adapter.writeBinary=async(path,data)=>write(path,path.endsWith(".stage")?new Uint8Array([99]).buffer:data);
    await expect(new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync()).rejects.toThrow("Staged download integrity");
    expect(adapter.files.get("note.md")).toEqual(before);expect(adapter.writeCalls).toEqual([]);expect(config.pendingApplyOperations["note.md"].phase).toBe("planned");
  });
  it("restores the original when suspension is requested after backing it up",async()=>{
    const {adapter,api,config,before,after}=await incomingFixture();let proceed=true,pausedOnce=false;const rename=adapter.rename.bind(adapter);
    adapter.rename=async(path,to)=>{await rename(path,to);if(path==="note.md"&&to.endsWith(".backup")&&!pausedOnce){pausedOnce=true;proceed=false;}};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{},undefined,undefined,undefined,false,undefined,()=>proceed);
    await expect(engine.sync()).rejects.toBeInstanceOf(SyncCancelledError);expect(adapter.files.get("note.md")).toEqual(before);expect(config.pendingApplySnapshotId).not.toBeNull();
    proceed=true;await engine.sync();expect(adapter.files.get("note.md")).toEqual(after);
  });
  it("preserves a last-moment editor change captured during the backup rename",async()=>{
    const {adapter,api,config,after}=await incomingFixture(),edited=new TextEncoder().encode("edited at rename\n"),rename=adapter.rename.bind(adapter);let raced=false;
    adapter.rename=async(path,to)=>{if(path==="note.md"&&to.endsWith(".backup")&&!raced){raced=true;adapter.files.set(path,edited);}await rename(path,to);};
    await expect(new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync()).rejects.toBeInstanceOf(FileChangedDuringReadError);
    expect(adapter.files.get("note.md")).toEqual(edited);expect(adapter.files.get("note.md")).not.toEqual(after);
  });
  it("never overwrites a destination created inside the native promotion call",async()=>{
    const {adapter,api,config,before}=await incomingFixture(),racer=new TextEncoder().encode("new local note during promotion\n"),copy=adapter.copy.bind(adapter);let raced=false;
    adapter.copy=async(source,destination)=>{if(!raced&&source.endsWith(".stage")&&destination==="note.md"){raced=true;adapter.files.set(destination,racer);}await copy(source,destination);};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});await expect(engine.sync()).rejects.toThrow("destination already exists");expect(adapter.files.get("note.md")).toEqual(racer);expect([...adapter.files].some(([path,bytes])=>path.endsWith(".backup")&&new TextDecoder().decode(bytes)===new TextDecoder().decode(before))).toBe(true);await expect(engine.sync()).rejects.toThrow("unverified version");expect(api.commits).toBe(0);
  });
  it("never overwrites a destination created inside a native rollback call",async()=>{
    const {adapter,api,config,before}=await incomingFixture(),racer=new TextEncoder().encode("new note during rollback\n"),rename=adapter.rename.bind(adapter),copy=adapter.copy.bind(adapter);let proceed=true;
    adapter.rename=async(source,destination)=>{await rename(source,destination);if(source==="note.md"&&destination.endsWith(".backup"))proceed=false;};adapter.copy=async(source,destination)=>{if(source.endsWith(".backup")&&destination==="note.md")adapter.files.set(destination,racer);await copy(source,destination);};
    await expect(new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{},undefined,undefined,undefined,false,undefined,()=>proceed).sync()).rejects.toBeInstanceOf(SyncCancelledError);expect(adapter.files.get("note.md")).toEqual(racer);expect([...adapter.files].some(([path,bytes])=>path.endsWith(".backup")&&new TextDecoder().decode(bytes)===new TextDecoder().decode(before))).toBe(true);
  });
  it("holds a partial rollback copy after pause and process loss without publishing its prefix",async()=>{
    const {adapter,api,config,before,base}=await incomingFixture(),rename=adapter.rename.bind(adapter);let proceed=true,persisted=structuredClone(config),crashedFiles:Map<string,Uint8Array>|undefined;
    adapter.rename=async(source,destination)=>{await rename(source,destination);if(source==="note.md"&&destination.endsWith(".backup"))proceed=false;};adapter.copy=async(source,destination)=>{if(source.endsWith(".backup")&&destination==="note.md"){adapter.files.set(destination,before.slice(0,3));crashedFiles=new Map([...adapter.files].map(([path,bytes])=>[path,bytes.slice()]));throw new Error("process lost during rollback");}throw new Error("unexpected copy");};
    await expect(new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{persisted=structuredClone(config);},()=>{},undefined,undefined,undefined,false,undefined,()=>proceed).sync()).rejects.toBeInstanceOf(SyncCancelledError);
    const resumed=new MemoryAdapter();resumed.files=crashedFiles!;const saved=structuredClone(persisted);await expect(new SyncEngine(resumed as unknown as DataAdapter,api as unknown as GibSyncApi,()=>saved,async()=>{},()=>{}).sync()).rejects.toThrow("unverified version");expect(api.commits).toBe(0);expect(saved.lastSnapshotId).toBe(base.id);expect(resumed.files.get("note.md")).toEqual(before.slice(0,3));expect([...resumed.files].some(([path,bytes])=>path.endsWith(".backup")&&new TextDecoder().decode(bytes)===new TextDecoder().decode(before))).toBe(true);
  });
  it("holds a truncated native copy after process loss and repairs it only with explicit accepted restore",async()=>{
    const {adapter,api,config,before,after,base}=await incomingFixture();let persisted=structuredClone(config),crashedFiles:Map<string,Uint8Array>|undefined;
    adapter.copy=async(source,destination)=>{if(source.endsWith(".stage")&&destination==="note.md"){adapter.files.set(destination,after.slice(0,3));crashedFiles=new Map([...adapter.files].map(([path,bytes])=>[path,bytes.slice()]));throw new Error("process lost during copy");}throw new Error("unexpected copy");};
    await expect(new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{persisted=structuredClone(config);},()=>{}).sync()).rejects.toThrow("process lost during copy");
    const resumed=new MemoryAdapter();resumed.files=crashedFiles!;const saved=structuredClone(persisted),engine=new SyncEngine(resumed as unknown as DataAdapter,api as unknown as GibSyncApi,()=>saved,async()=>{},()=>{});await expect(engine.sync()).rejects.toThrow("unverified version");expect(api.commits).toBe(0);expect(saved.lastSnapshotId).toBe(base.id);expect(resumed.files.get("note.md")).toEqual(after.slice(0,3));expect([...resumed.files.keys()].some(path=>path.endsWith(".stage"))).toBe(true);expect([...resumed.files.keys()].some(path=>path.endsWith(".backup"))).toBe(true);
    await engine.restoreAcceptedSnapshot();expect(resumed.files.get("note.md")).toEqual(after);expect(saved.pendingApplySnapshotId).toBeNull();const recovered=[...resumed.files].filter(([path])=>path.startsWith(".gib-sync/local-recovery/"));expect(recovered.some(([,bytes])=>new TextDecoder().decode(bytes)===new TextDecoder().decode(before))).toBe(true);expect(recovered.some(([,bytes])=>new TextDecoder().decode(bytes)===new TextDecoder().decode(after.slice(0,3)))).toBe(true);expect(api.commits).toBe(0);
  });
  it("stops an incoming application after pause while awaiting the download",async()=>{
    const {adapter,api,config,before}=await incomingFixture();let proceed=true;const get=api.getBlob.bind(api);api.getBlob=async(hash)=>{const bytes=await get(hash);proceed=false;return bytes;};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{},undefined,undefined,undefined,false,undefined,()=>proceed);
    await expect(engine.sync()).rejects.toBeInstanceOf(SyncCancelledError);expect(adapter.files.get("note.md")).toEqual(before);expect(adapter.writeCalls).toEqual([]);
  });
  it("does not commit after cancellation during an upload",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();adapter.files.set("new.md",new TextEncoder().encode("new\n"));const put=api.putBlob.bind(api);
    let engine:SyncEngine;api.putBlob=async(hash,body)=>{await put(hash,body);engine.cancel();};engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});
    await expect(engine.sync()).rejects.toBeInstanceOf(SyncCancelledError);expect(api.commits).toBe(0);expect(adapter.files.has("new.md")).toBe(true);
  });
  it("serializes restore behind a running upload using the same owner",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();adapter.files.set("new.md",new TextEncoder().encode("new\n"));let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;}),put=api.putBlob.bind(api);let stateCalls=0;
    const state=api.state.bind(api);api.state=async()=>{stateCalls++;return state();};api.putBlob=async(hash,body)=>{started();await gate;await put(hash,body);};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}),sync=engine.sync();await began;const calls=stateCalls,restore=engine.restoreAcceptedSnapshot();await Promise.resolve();expect(stateCalls).toBe(calls);release();await sync;await expect(restore).resolves.toMatchObject({downloaded:0,deleted:0});expect(adapter.files.has("new.md")).toBe(true);
  });
  it("preserves a file arriving after the final empty check but before removal",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();adapter.dirs.add("Race");const head:Snapshot={id:"00000000-0000-4000-8000-000000009101",vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Empty",entries:[]};api.head=head;api.snapshots.set(head.id,head);config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.retiredPaths={"Race/old.md":{hash:"a".repeat(64),snapshotId:head.id,retiredAt:Date.now()-1000}};
    const rmdir=adapter.rmdir.bind(adapter);let raced=false;adapter.rmdir=async(path,recursive)=>{if(path==="Race"&&!raced){raced=true;adapter.files.set("Race/new.md",new TextEncoder().encode("new\n"));}await rmdir(path,recursive);};
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(adapter.files.has("Race/new.md")).toBe(true);expect(adapter.dirs.has("Race")).toBe(true);expect(adapter.rmdirCalls.every(call=>!call.recursive)).toBe(true);
  });
  it("performs a head-only check once accepted folders were observed",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();adapter.files.set("note.md",new TextEncoder().encode("note\n"));const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});await engine.sync();const lists=adapter.listCalls,reads=adapter.readCalls.length;let snapshots=0;const snapshot=api.snapshot.bind(api);api.snapshot=async(id)=>{snapshots++;return snapshot(id);};await engine.sync();expect(adapter.listCalls).toBe(lists);expect(adapter.readCalls.length).toBe(reads);expect(snapshots).toBe(0);
  });
  it("uses an explicit rename event for a completely edited moved note",async()=>{
    const {adapter,api,config,base}=await incomingFixture();api.head=base;adapter.files.delete("note.md");adapter.files.set("Moved/new-name.md",new TextEncoder().encode("completely rewritten after move\n"));config.pendingMoves=[{from:"note.md",to:"Moved/new-name.md",at:Date.now()}];
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(result.conflicts).toBe(0);expect(api.head!.entries).toHaveLength(1);expect(api.head!.entries[0].path).toBe("Moved/new-name.md");expect(config.pendingMoves).toEqual([]);
  });
  it("carries the exact baseline through a folder move followed by an edited file rename",async()=>{
    const {adapter,api,config,base}=await incomingFixture();api.head=base;const entry=base.entries[0];base.entries=[{...entry,path:"Old/note.md",fileId:"stable-file"}];adapter.files.delete("note.md");adapter.files.set("Final/new-name.md",new TextEncoder().encode("completely rewritten after two moves\n"));const at=Date.now();config.pendingMoves=[{from:"Old",to:"Final",at},{from:"Final/note.md",to:"Final/new-name.md",at:at+1}];
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(result.conflicts).toBe(0);expect(api.head!.entries).toHaveLength(1);expect(api.head!.entries[0]).toMatchObject({path:"Final/new-name.md",fileId:"stable-file"});expect(config.pendingMoves).toEqual([]);
  });
  it("retains a rename intent that is extended in place while its upload is awaiting the network",async()=>{
    const {adapter,api,config,base}=await incomingFixture();api.head=base;adapter.files.delete("note.md");adapter.files.set("First/note.md",new TextEncoder().encode("edited moved note\n"));const move={from:"note.md",to:"First/note.md",at:Date.now()};config.pendingMoves=[move];const put=api.putBlob.bind(api);let observed=false;
    api.putBlob=async(hash,body)=>{await put(hash,body);if(!observed){observed=true;move.to="Final/note.md";move.at++;adapter.files.set("Final/note.md",adapter.files.get("First/note.md")!);adapter.files.delete("First/note.md");config.pendingPaths=["First/note.md","Final/note.md"];config.pendingPathTimes={"First/note.md":move.at,"Final/note.md":move.at};}};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});await engine.sync();expect(config.pendingMoves).toEqual([{...move,from:"First/note.md"}]);await engine.sync();expect(api.head!.entries.map(entry=>entry.path)).toEqual(["Final/note.md"]);expect(config.pendingMoves).toEqual([]);
  });
  it("rebases a later edited rename leg before merging a concurrent edit at its accepted intermediate path",async()=>{
    const {adapter,api,config,base}=await incomingFixture();api.head=base;adapter.files.delete("note.md");const first=new TextEncoder().encode("heading\nmiddle\ntail\n"),second=new TextEncoder().encode("heading\nlocal middle\ntail\n"),remote=new TextEncoder().encode("heading\nmiddle\nremote tail\n");adapter.files.set("First/note.md",first);const move={from:"note.md",to:"First/note.md",at:Date.now()};config.pendingMoves=[move];const put=api.putBlob.bind(api);let observed=false;
    api.putBlob=async(hash,body)=>{await put(hash,body);if(!observed){observed=true;move.to="Final/note.md";move.at++;adapter.files.set("Final/note.md",second);adapter.files.delete("First/note.md");config.pendingPaths=["First/note.md","Final/note.md"];config.pendingPathTimes={"First/note.md":move.at,"Final/note.md":move.at};}};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});await engine.sync();const firstHead=api.head!,hash=await hashBytes(remote);api.blobs.set(hash,await encryptBlob(remote,config.vaultKey,hash));api.head={...firstHead,id:"00000000-0000-4000-8000-000000009311",parentId:firstHead.id,deviceId:"phone",deviceName:"Phone",entries:[{path:"First/note.md",hash,size:remote.length,mtime:1}]};api.snapshots.set(api.head.id,api.head);
    const result=await engine.sync();expect(result.conflicts).toBe(0);expect(api.head!.entries.map(entry=>entry.path)).toEqual(["Final/note.md"]);expect(new TextDecoder().decode(adapter.files.get("Final/note.md"))).toBe("heading\nlocal middle\nremote tail\n");
  });
  it("keeps a same-byte intentional recreation instead of suppressing it as stale",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("recreated\n"),hash=await hashBytes(clear),head:Snapshot={id:"00000000-0000-4000-8000-000000009201",vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Deleted",entries:[]};api.head=head;api.snapshots.set(head.id,head);config.initialized=true;config.lastSnapshotId=head.id;config.retiredPaths={"note.md":{hash,snapshotId:head.id,retiredAt:Date.now()-1000}};config.pendingPaths=["note.md"];config.pendingPathTimes={"note.md":Date.now()};adapter.files.set("note.md",clear);
    const createdAt=Date.now();config.fileCreationTimes={"note.md":createdAt};const stat=adapter.stat.bind(adapter);adapter.stat=async(path)=>{const value=await stat(path);return path==="note.md"&&value?{...value,ctime:createdAt,mtime:createdAt}:value;};
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(api.head!.entries.map(entry=>entry.path)).toEqual(["note.md"]);expect(config.retiredPaths["note.md"]).toBeUndefined();
  });
});

describe("SyncEngine", () => {
  it("recovers an established device's lost commit response and unjournaled newer edits after restart",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),encode=(prefix:string)=>new TextEncoder().encode(Array.from({length:32},(_,i)=>`${prefix}${i}`).join(" ")+"\n");
    adapter.files.set("note.md",encode("base"));let persisted=structuredClone(config);
    const save=async()=>{persisted=structuredClone(config);};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,save,()=>{});
    await engine.sync();const baseId=config.lastSnapshotId;
    adapter.files.set("note.md",encode("first"));config.pendingPaths=["note.md"];config.fullScanRequired=true;
    const commit=api.commit.bind(api);api.commit=async body=>{await commit(body);throw new ApiTransportError(new Error("Accepted response was lost"));};
    await expect(engine.sync()).rejects.toBeInstanceOf(ApiTransportError);
    expect(persisted.lastSnapshotId).toBe(baseId);expect(persisted.pendingCommit?.parentId).toBe(baseId);
    const restarted=structuredClone(persisted);restarted.pendingPaths=[];restarted.pendingPathTimes={};restarted.fullScanRequired=false;
    adapter.files.set("note.md",encode("latest"));api.commit=commit;
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>restarted,async()=>{},()=>{}).sync();
    expect(result.conflicts).toBe(0);expect(api.commits).toBe(3);expect(api.head!.entries).toHaveLength(1);
    expect(adapter.files.get("note.md")).toEqual(encode("latest"));expect(restarted.pendingCommit).toBeNull();expect(restarted.lastSnapshotId).toBe(api.head!.id);
  });
  it("does not send a commit before its durable receipt can be saved",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();adapter.files.set("note.md",new TextEncoder().encode("draft"));
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{if(config.pendingCommit)throw new Error("Storage unavailable");},()=>{});
    await expect(engine.sync()).rejects.toThrow("Storage unavailable");expect(api.commits).toBe(0);expect(adapter.writeCalls).toEqual([]);
  });
  it("recovers after accepting an upload when the following settings save fails",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();adapter.files.set("note.md",new TextEncoder().encode("accepted\n"));let persisted=structuredClone(config),fail=true;
    const save=async()=>{if(fail&&config.pendingApplySnapshotId)throw new Error("Interrupted journal save");persisted=structuredClone(config);};
    await expect(new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,save,()=>{}).sync()).rejects.toThrow("Interrupted journal save");
    expect(api.commits).toBe(1);expect(persisted.lastSnapshotId).toBeNull();expect(persisted.pendingCommit).not.toBeNull();fail=false;
    const restarted=structuredClone(persisted);const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>restarted,async()=>{},()=>{}).sync();
    expect(result.conflicts).toBe(0);expect(api.commits).toBe(1);expect(restarted.lastSnapshotId).toBe(api.head!.id);expect(restarted.pendingCommit).toBeNull();
  });
  it("blocks unresolved receipt history without touching files or discarding its journal",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();adapter.files.set("note.md",new TextEncoder().encode("local\n"));
    config.pendingCommit={parentId:"missing-parent",fingerprint:"a".repeat(64),priorHashes:{}};
    api.head={id:"new-head",vaultId:"vault",parentId:"missing-ancestor",deviceId:"other",deviceName:"Other",createdAt:new Date().toISOString(),message:"Sync",entries:[]};
    await expect(new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync()).rejects.toThrow("history could not be verified");expect(api.commits).toBe(0);expect(adapter.writeCalls).toEqual([]);expect(config.pendingCommit).not.toBeNull();
  });
  it("verifies an exact interrupted receipt through another device's later snapshot",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),encode=(s:string)=>new TextEncoder().encode(s);
    adapter.files.set("note.md",encode("base\n"));const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});await engine.sync();
    adapter.files.set("note.md",encode("accepted local\n"));config.fullScanRequired=true;
    const commit=api.commit.bind(api);api.commit=async body=>{await commit(body);throw new ApiTransportError(new Error("Lost reply"));};await expect(engine.sync()).rejects.toBeInstanceOf(ApiTransportError);
    const accepted=api.head!,remoteBytes=encode("other device note\n"),hash=await hashBytes(remoteBytes);api.blobs.set(hash,await encryptBlob(remoteBytes,config.vaultKey,hash));
    api.head={...accepted,id:"00000000-0000-4000-8000-000000000999",parentId:accepted.id,deviceId:"other",deviceName:"Other",entries:[...accepted.entries,{path:"other.md",hash,size:remoteBytes.length,mtime:1}]};api.snapshots.set(api.head.id,api.head);api.commit=commit;
    const result=await engine.sync();expect(result.conflicts).toBe(0);expect(api.commits).toBe(2);expect(adapter.files.get("other.md")).toEqual(remoteBytes);expect(config.pendingCommit).toBeNull();
  });
  it("does not mistake identical content from a different registered device for its receipt",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("same content\n"),hash=await hashBytes(clear);
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000989",vaultId:"vault",parentId:null,deviceId:"another-device",deviceName:config.deviceName,createdAt:new Date().toISOString(),message:"Sync",entries:[{path:"note.md",hash,size:clear.length,mtime:1}]};
    api.head=head;api.snapshots.set(head.id,head);api.blobs.set(hash,await encryptBlob(clear,config.vaultKey,hash));adapter.files.set("note.md",clear);
    config.pendingCommit={parentId:null,fingerprint:await commitFingerprint(head.entries,[]),priorHashes:{}};
    const progress:string[]=[];await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},p=>progress.push(p.message)).sync();
    expect(progress.some(message=>message.includes("Verified this device's accepted upload"))).toBe(false);expect(api.commits).toBe(0);
  });
  it("canonicalizes implicit folders and ignores metadata times when verifying receipts",async()=>{
    const entries=[{path:"Folder/note.md",hash:"a".repeat(64),size:12,mtime:1}];
    expect(await commitFingerprint(entries,["Folder","Empty"])).toBe(await commitFingerprint([{...entries[0],mtime:999}],["Empty"]));
    expect(await commitFingerprint(entries,["Empty"])).not.toBe(await commitFingerprint(entries,[]));
  });
  it("keeps an edit made during an incoming download and resumes without overwriting it",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),encode=(s:string)=>new TextEncoder().encode(s),before=encode("base\n"),remote=encode("remote\n"),latest=encode("typed during download\n");
    adapter.files.set("note.md",before);const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});await engine.sync();const base=api.head!,hash=await hashBytes(remote);
    api.head={...base,id:"00000000-0000-4000-8000-000000000988",parentId:base.id,deviceId:"other",entries:[{path:"note.md",hash,size:remote.length,mtime:2}]};api.snapshots.set(api.head.id,api.head);api.blobs.set(hash,await encryptBlob(remote,config.vaultKey,hash));
    const get=api.getBlob.bind(api);let edited=false;api.getBlob=async h=>{const blob=await get(h);if(h===hash&&!edited){edited=true;adapter.files.set("note.md",latest);}return blob;};
    config.fullScanRequired=true;await expect(engine.sync()).rejects.toBeInstanceOf(FileChangedDuringReadError);
    expect(adapter.files.get("note.md")).toEqual(latest);expect(config.pendingApplySnapshotId).toBe(api.head!.id);
    const result=await engine.sync();expect(result.conflicts).toBe(0);expect(adapter.files.get("note.md")).toEqual(latest);expect(config.pendingApplyPaths).toEqual([]);
  });
  it("defers a download after an editor event even before the edited buffer reaches disk",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),before=new TextEncoder().encode("base\n"),remote=new TextEncoder().encode("remote\n");
    adapter.files.set("note.md",before);let unchanged=true;const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{},undefined,undefined,undefined,false,()=>unchanged);await engine.sync();const base=api.head!,hash=await hashBytes(remote);
    api.head={...base,id:"00000000-0000-4000-8000-000000000984",parentId:base.id,deviceId:"other",entries:[{path:"note.md",hash,size:remote.length,mtime:2}]};api.snapshots.set(api.head.id,api.head);api.blobs.set(hash,await encryptBlob(remote,config.vaultKey,hash));
    const get=api.getBlob.bind(api);api.getBlob=async h=>{unchanged=false;return get(h);};config.fullScanRequired=true;
    await expect(engine.sync()).rejects.toBeInstanceOf(FileChangedDuringReadError);expect(adapter.files.get("note.md")).toEqual(before);expect(adapter.writeCalls).toEqual([]);
  });
  it("does not erase events observed while the commit is in flight",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();adapter.files.set("note.md",new TextEncoder().encode("first\n"));
    const commit=api.commit.bind(api);api.commit=async body=>{const snapshot=await commit(body);config.pendingPaths=["new.md"];config.pendingPathTimes={"new.md":12345};adapter.files.set("new.md",new TextEncoder().encode("new event\n"));return snapshot;};
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(config.pendingPaths).toContain("new.md");expect(config.pendingPathTimes["new.md"]).toBe(12345);expect(adapter.files.has("new.md")).toBe(true);
  });
  it("merges non-overlapping edits made during a download instead of losing the incoming addition",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),encode=(s:string)=>new TextEncoder().encode(s),before=encode("First: base\nSecond: base\n"),remote=encode("First: base\nSecond: remote\n"),local=encode("First: local\nSecond: base\n");
    adapter.files.set("note.md",before);const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});await engine.sync();const base=api.head!,hash=await hashBytes(remote);
    api.head={...base,id:"00000000-0000-4000-8000-000000000987",parentId:base.id,deviceId:"other",entries:[{path:"note.md",hash,size:remote.length,mtime:2}]};api.snapshots.set(api.head.id,api.head);api.blobs.set(hash,await encryptBlob(remote,config.vaultKey,hash));
    const get=api.getBlob.bind(api);let edited=false;api.getBlob=async h=>{const blob=await get(h);if(h===hash&&!edited){edited=true;adapter.files.set("note.md",local);}return blob;};
    config.fullScanRequired=true;await expect(engine.sync()).rejects.toBeInstanceOf(FileChangedDuringReadError);
    const result=await engine.sync();expect(result.conflicts).toBe(0);expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe("First: local\nSecond: remote\n");expect(config.localReconcileBases).toEqual({});
  });
  it("replays an outgoing merged upload against the editor's prior file after suspension",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),encode=(s:string)=>new TextEncoder().encode(s),before=encode("First: base\nSecond: base\n"),remote=encode("First: base\nSecond: remote\n"),local=encode("First: local\nSecond: base\n"),later=encode("First: latest\nSecond: base\n");
    adapter.files.set("note.md",before);let persisted=structuredClone(config);const save=async()=>{persisted=structuredClone(config);};const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,save,()=>{});await engine.sync();const base=api.head!,hash=await hashBytes(remote);
    api.head={...base,id:"00000000-0000-4000-8000-000000000986",parentId:base.id,deviceId:"other",entries:[{path:"note.md",hash,size:remote.length,mtime:2}]};api.snapshots.set(api.head.id,api.head);api.blobs.set(hash,await encryptBlob(remote,config.vaultKey,hash));adapter.files.set("note.md",local);config.pendingPaths=["note.md"];config.fullScanRequired=true;
    const commit=api.commit.bind(api);api.commit=async body=>{await commit(body);throw new ApiTransportError(new Error("Suspended after accept"));};await expect(engine.sync()).rejects.toBeInstanceOf(ApiTransportError);
    expect(api.blobs.has(await hashBytes(local))).toBe(true);adapter.files.set("note.md",later);api.commit=commit;
    const restarted=structuredClone(persisted),result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>restarted,async()=>{},()=>{}).sync();
    expect(result.conflicts).toBe(0);expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe("First: latest\nSecond: remote\n");expect(restarted.pendingCommit).toBeNull();expect(restarted.localReconcileBases).toEqual({});
  });
  it("preserves two independently created same-path notes during interrupted onboarding",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),remote=new TextEncoder().encode("Remote independent draft\n"),local=new TextEncoder().encode("Local independent draft\n"),hash=await hashBytes(remote);
    const target:Snapshot={id:"00000000-0000-4000-8000-000000000985",vaultId:"vault",parentId:null,deviceId:"other",deviceName:"Other",createdAt:new Date().toISOString(),message:"Created",entries:[{path:"note.md",hash,size:remote.length,mtime:1}]};
    api.head=target;api.snapshots.set(target.id,target);api.blobs.set(hash,await encryptBlob(remote,config.vaultKey,hash));adapter.files.set("note.md",local);config.pendingApplySnapshotId=target.id;config.pendingApplyPaths=["note.md"];config.pendingApplyPriorHashes={"note.md":null};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(result.conflicts).toBe(1);expect(api.head!.entries).toHaveLength(2);expect([...adapter.files.values()].map(b=>new TextDecoder().decode(b)).join("\n")).toContain("Remote independent draft");
  });
  it("replays an accepted deletion against its actual prior hash rather than an older checkpoint",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),oldBytes=new TextEncoder().encode("old checkpoint\n"),priorBytes=new TextEncoder().encode("last physical file\n"),oldHash=await hashBytes(oldBytes),priorHash=await hashBytes(priorBytes);
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000982",vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Test",createdAt:new Date().toISOString(),message:"Base",entries:[{path:"note.md",hash:oldHash,size:oldBytes.length,mtime:1}]},target:Snapshot={...base,id:"00000000-0000-4000-8000-000000000983",parentId:base.id,entries:[]};
    api.head=target;api.snapshots.set(base.id,base);api.snapshots.set(target.id,target);config.initialized=true;config.lastSnapshotId=base.id;config.pendingApplySnapshotId=target.id;config.pendingApplyBaseSnapshotId=base.id;config.pendingApplyPaths=["note.md"];config.pendingApplyPriorHashes={"note.md":priorHash};config.pendingApplyPriorEntries={"note.md":{path:"note.md",hash:priorHash,size:priorBytes.length,mtime:1}};adapter.files.set("note.md",priorBytes);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(result.conflicts).toBe(0);expect(adapter.files.has("note.md")).toBe(false);expect(api.commits).toBe(0);expect(config.lastSnapshotId).toBe(target.id);
  });
  it("propagates a temporary baseline fetch failure before file mutations",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();adapter.files.set("note.md",new TextEncoder().encode("unchanged\n"));
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});
    await engine.sync();const commits=api.commits,writes=adapter.writeCalls.length;config.fullScanRequired=true;
    api.snapshot=async()=>{throw new ApiError("Temporary server interruption",503,null);};
    await expect(engine.sync()).rejects.toMatchObject({status:503});expect(api.commits).toBe(commits);expect(adapter.writeCalls.length).toBe(writes);
  });
  it("does not report transfer phases for a full verification with no changes",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();adapter.files.set("note.md",new TextEncoder().encode("stable\n"));
    const phases:string[]=[],engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},p=>phases.push(p.phase));
    await engine.sync();config.fullScanRequired=true;phases.length=0;
    api.mirrorPlan=async()=>({uploadPaths:[],deletePaths:[],alreadyCurrent:true});await engine.sync();
    expect(phases).not.toContain("applying");expect(phases).not.toContain("mirroring");expect(phases).not.toContain("uploading");expect(phases).not.toContain("committing");
  });
  it("recovers a lost commit response without duplicate commits or conflict copies",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();adapter.files.set("note.md",new TextEncoder().encode("saved content\n"));
    const commit=api.commit.bind(api);let interrupted=true;
    api.commit=async body=>{const accepted=await commit(body);if(interrupted){interrupted=false;throw new ApiTransportError(new Error("Response connection lost"));}return accepted;};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});
    const result=await recoverSync(()=>engine.sync(),{shouldContinue:()=>true,onRetry:()=>{},wait:async()=>{}});
    expect(api.commits).toBe(1);expect(result.conflicts).toBe(0);expect(config.lastSnapshotId).toBe(api.head?.id);expect([...adapter.files.keys()].filter(path=>!path.startsWith(".gib-sync/"))).toEqual(["note.md"]);
  });
  it("uses a background-safe cooperative yield primitive",async()=>{await expect(cooperativeYield()).resolves.toBeUndefined();});
  it("ignores a newly created file that disappears from a full scan before it is read",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();adapter.files.set("quick draft.md",new TextEncoder().encode("temporary\n"));
    const list=adapter.list.bind(adapter);adapter.list=async(path:string)=>{const result=await list(path);if(path==="")adapter.files.delete("quick draft.md");return result;};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:0,downloaded:0,deleted:0,conflicts:0});expect(api.commits).toBe(0);expect(api.head).toBeNull();
  });
  it("treats a pending file deleted between stat and read as a clean deletion",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),base:Snapshot={id:"00000000-0000-4000-8000-000000000005",vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Empty",entries:[]};
    api.head=base;api.snapshots.set(base.id,base);config.initialized=true;config.lastSnapshotId=base.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.pendingPaths=["quick draft.md"];adapter.files.set("quick draft.md",new TextEncoder().encode("temporary\n"));
    const stat=adapter.stat.bind(adapter);let first=true;adapter.stat=async(path:string)=>{const result=await stat(path);if(path==="quick draft.md"&&first){first=false;adapter.files.delete(path);}return result;};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:0,downloaded:0,deleted:0,conflicts:0,fullScan:false});expect(api.commits).toBe(0);expect(api.head).toBe(base);
  });
  it("quietly retries when a new file disappears after scanning but before upload",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();adapter.files.set("quick draft.md",new TextEncoder().encode("temporary\n"));
    const read=adapter.readBinary.bind(adapter);let reads=0;adapter.readBinary=async(path:string)=>{if(path==="quick draft.md"&&++reads===2)adapter.files.delete(path);return read(path);};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});
    await expect(engine.sync()).rejects.toBeInstanceOf(FileChangedDuringReadError);expect(api.commits).toBe(0);
    await expect(engine.sync()).resolves.toMatchObject({uploaded:0,downloaded:0,conflicts:0});expect(api.commits).toBe(0);
  });
  it("cooperatively yields and throttles UI progress during large sync work",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),progress:string[]=[];let yields=0;
    for(let index=0;index<40;index++)adapter.files.set(`Journal/${index}.md`,new TextEncoder().encode(`entry ${index}\n`));
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},(item)=>progress.push(`${item.phase}:${item.current??0}`),async()=>{},()=>{},async()=>{yields++;});
    const result=await engine.sync();
    expect(result.uploaded).toBe(40);expect(yields).toBeGreaterThan(5);
    expect(progress.filter((item)=>item.startsWith("mirroring:")).length).toBeLessThan(10);
  });
  it("uses a lightweight folder-topology check when neither side changed",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("stable\n"),hash=await hashBytes(clear);
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000010",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"stable.md",hash,size:clear.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();adapter.files.set("stable.md",clear);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:0,downloaded:0,fullScan:false,pendingRetiredFolders:0});expect(adapter.listCalls).toBe(1);expect(adapter.readCalls).toEqual([]);
  });
  it("preserves a newly created empty folder at the vault root",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),stable=new TextEncoder().encode("stable\n"),hash=await hashBytes(stable);
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000027",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"stable.md",hash,size:stable.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.folderCreateTimes={Projects:Date.now()};adapter.files.set("stable.md",stable);adapter.dirs.add("Projects");
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:0,downloaded:0,prunedFolders:0,pendingRetiredFolders:0,fullScan:false});expect(adapter.dirs.has("Projects")).toBe(true);expect(config.folderCreateTimes.Projects).toBeGreaterThan(0);expect(adapter.rmdirCalls).toEqual([]);
  });
  it("preserves a newly created empty subfolder without masking its accepted parent",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),note=new TextEncoder().encode("accepted\n"),hash=await hashBytes(note);
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000028",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"Projects/note.md",hash,size:note.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.folderCreateTimes={"Projects/New section":Date.now()};adapter.files.set("Projects/note.md",note);adapter.dirs.add("Projects");adapter.dirs.add("Projects/New section");
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({prunedFolders:0,pendingRetiredFolders:0});expect(adapter.dirs.has("Projects/New section")).toBe(true);expect(config.folderCreateTimes["Projects/New section"]).toBeGreaterThan(0);expect(adapter.rmdirCalls).toEqual([]);
  });
  it("retires only folders named by a server provenance repair when the legacy base had no folder manifest",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),observedAt="2026-08-25T04:59:42.000Z";
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000060",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:"2026-08-24T00:00:00.000Z",message:"Legacy",entries:[]};
    const repair:Snapshot={...base,id:"00000000-0000-4000-8000-000000000061",parentId:base.id,deviceId:"server:folder-provenance-repair",deviceName:"Gib Sync server",createdAt:"2026-08-26T00:00:00.000Z",message:"Repair unsafe legacy folder provenance",folders:[],folderRepair:{retiredFolders:["Stale","Device local"],observedAt,issuedAt:"2026-08-26T00:00:00.000Z",originSnapshotIds:["00000000-0000-4000-8000-000000000062"]}};
    api.head=repair;api.snapshots.set(base.id,base);api.snapshots.set(repair.id,repair);config.initialized=true;config.lastSnapshotId=base.id;config.fullScanRequired=true;config.folderCreateTimes={Stale:Date.parse(repair.createdAt)+1000,"Device local":Date.parse(repair.createdAt)+1000};adapter.dirs.add("Stale");adapter.dirs.add("Device local");adapter.dirMtimes.set("Stale",Date.parse(observedAt)+360_000);adapter.dirMtimes.set("Device local",Date.parse(observedAt)+360_000);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:0,prunedFolders:2});expect(api.commits).toBe(0);expect(adapter.dirs.size).toBe(0);expect(config.folderCreateTimes).toEqual({});
  });
  it("preserves a retired folder explicitly recreated after the unsafe observation",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),observedAt="2026-08-25T04:59:42.000Z";
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000063",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:"2026-08-24T00:00:00.000Z",message:"Legacy",entries:[]};
    const repair:Snapshot={...base,id:"00000000-0000-4000-8000-000000000064",parentId:base.id,deviceId:"server:folder-provenance-repair",deviceName:"Gib Sync server",createdAt:"2026-08-26T00:00:00.000Z",message:"Repair unsafe legacy folder provenance",folders:[],folderRepair:{retiredFolders:["Recreated"],observedAt,issuedAt:"2026-08-26T00:00:00.000Z",originSnapshotIds:["00000000-0000-4000-8000-000000000065"]}};
    api.head=repair;api.snapshots.set(base.id,base);api.snapshots.set(repair.id,repair);config.initialized=true;config.lastSnapshotId=base.id;config.fullScanRequired=true;config.folderCreateTimes={Recreated:Date.parse(repair.createdAt)+1000};adapter.dirs.add("Recreated");adapter.dirMtimes.set("Recreated",Date.parse(repair.createdAt)+1000);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.prunedFolders).toBe(0);expect(api.commits).toBe(1);expect(api.head?.folders).toEqual(["Recreated"]);expect(adapter.dirs.has("Recreated")).toBe(true);
  });
  it("publishes a new empty root folder and creates it on another device",async()=>{
    const desktop=new MemoryAdapter(),api=new MemoryApi(),desktopConfig=settings();desktopConfig.fullScanRequired=true;desktop.dirs.add("Projects");desktopConfig.folderCreateTimes={Projects:Date.now()};
    const desktopResult=await new SyncEngine(desktop as unknown as DataAdapter,api as unknown as GibSyncApi,()=>desktopConfig,async()=>{},()=>{}).sync();
    expect(desktopResult).toMatchObject({uploaded:0,conflicts:0});expect(api.commits).toBe(1);expect(api.head?.folders).toEqual(["Projects"]);expect(desktop.dirs.has("Projects")).toBe(true);

    const mobile=new MemoryAdapter(),mobileConfig={...settings(),deviceId:"mobile",deviceName:"Mobile"};
    const mobileResult=await new SyncEngine(mobile as unknown as DataAdapter,api as unknown as GibSyncApi,()=>mobileConfig,async()=>{},()=>{}).sync();
    expect(mobileResult).toMatchObject({uploaded:0,conflicts:0});expect(mobile.dirs.has("Projects")).toBe(true);expect(mobileConfig.lastSnapshotId).toBe(api.head?.id);expect(api.commits).toBe(1);

    mobile.dirs.delete("Projects");mobileConfig.fullScanRequired=true;
    await new SyncEngine(mobile as unknown as DataAdapter,api as unknown as GibSyncApi,()=>mobileConfig,async()=>{},()=>{}).sync();expect(api.head?.folders).toEqual([]);expect(api.commits).toBe(2);
    await new SyncEngine(desktop as unknown as DataAdapter,api as unknown as GibSyncApi,()=>desktopConfig,async()=>{},()=>{}).sync();expect(desktop.dirs.has("Projects")).toBe(false);expect(api.commits).toBe(2);
  });
  it("retires folder-create journal entries after the folder becomes accepted",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),note=new TextEncoder().encode("accepted\n"),hash=await hashBytes(note);
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000029",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"Projects/note.md",hash,size:note.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.folderCreateTimes={Projects:Date.now(),Deleted:Date.now()};adapter.files.set("Projects/note.md",note);adapter.dirs.add("Projects");
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({prunedFolders:0,pendingRetiredFolders:0});expect(config.folderCreateTimes).toEqual({});expect(adapter.dirs.has("Projects")).toBe(true);
  });
  it("removes legacy extra folder topology without requiring a retired-path record",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),stable=new TextEncoder().encode("stable\n"),ignored=new TextEncoder().encode("device only\n"),hash=await hashBytes(stable);
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000024",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"stable.md",hash,size:stable.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.exclusions=[...config.exclusions,"Legacy/device-local.tmp"];
    adapter.files.set("stable.md",stable);adapter.files.set("Legacy/device-local.tmp",ignored);adapter.dirs.add("Legacy");adapter.dirs.add("Legacy/Empty shell");
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:0,downloaded:0,prunedFolders:2,pendingRetiredFolders:0,fullScan:false});expect(config.retiredPaths).toEqual({});expect(adapter.files.has("Legacy/device-local.tmp")).toBe(false);expect(adapter.trashed.get("Legacy/device-local.tmp")).toEqual(ignored);expect(adapter.dirs.has("Legacy")).toBe(false);
  });
  it("leaves an explicitly excluded top-level device-local tree outside authoritative topology",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),stable=new TextEncoder().encode("stable\n"),local=new TextEncoder().encode("private\n"),hash=await hashBytes(stable);
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000025",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"stable.md",hash,size:stable.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.exclusions=[...config.exclusions,"Local only/"];
    adapter.files.set("stable.md",stable);adapter.files.set("Local only/private.md",local);adapter.dirs.add("Local only");
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:0,downloaded:0,prunedFolders:0,pendingRetiredFolders:0,fullScan:false});expect(adapter.files.get("Local only/private.md")).toEqual(local);expect(adapter.dirs.has("Local only")).toBe(true);expect(adapter.trashed.size).toBe(0);
  });
  it("recreates an accepted folder that is missing locally",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),note=new TextEncoder().encode("accepted\n"),hash=await hashBytes(note);
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000026",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"Accepted/note.md",hash,size:note.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:0,downloaded:0,pendingRetiredFolders:0,fullScan:false});expect(adapter.dirs.has("Accepted")).toBe(true);expect(config.retiredFolderNote).toBe("");
  });
  it("prunes persisted empty retired folders during an otherwise lightweight sync",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("stable\n"),hash=await hashBytes(clear),retiredAt=Date.now()-120_000;
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000012",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"stable.md",hash,size:clear.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.retiredPaths={"Legacy/Nested/old.md":{hash,snapshotId:head.id,retiredAt}};
    adapter.files.set("stable.md",clear);for(const path of ["Legacy","Legacy/Nested"]){adapter.dirs.add(path);adapter.dirMtimes.set(path,retiredAt-1000);}
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:0,downloaded:0,prunedFolders:2,fullScan:false});expect(adapter.dirs.has("Legacy")).toBe(false);expect(adapter.dirs.has("Legacy/Nested")).toBe(false);expect(adapter.rmdirCalls.every((call)=>!call.recursive)).toBe(true);expect(config.lastFolderCleanupAt).toBeGreaterThan(retiredAt);expect(config.lastFolderCleanupError).toBe("");expect(adapter.readCalls).toEqual([]);
  });
  it("preserves an explicitly recreated empty retired folder",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("stable\n"),hash=await hashBytes(clear),retiredAt=Date.now()-120_000;
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000013",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"stable.md",hash,size:clear.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.retiredPaths={"Recreated/old.md":{hash,snapshotId:head.id,retiredAt}};
    adapter.files.set("stable.md",clear);adapter.dirs.add("Recreated");adapter.dirMtimes.set("Recreated",retiredAt+60_000);config.folderCreateTimes={Recreated:retiredAt+60_000};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({prunedFolders:0,pendingRetiredFolders:0});expect(adapter.dirs.has("Recreated")).toBe(true);expect(config.folderCreateTimes.Recreated).toBeGreaterThan(retiredAt);expect(config.lastFolderCleanupAt).toBeGreaterThan(retiredAt);expect(adapter.rmdirCalls).toEqual([]);
  });
  it("prunes a stale empty folder even when filesystem metadata changed after retirement",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("stable\n"),hash=await hashBytes(clear),retiredAt=Date.now()-120_000;
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000016",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"stable.md",hash,size:clear.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.retiredPaths={"Stale/old.md":{hash,snapshotId:head.id,retiredAt}};config.folderCreateTimes={Stale:retiredAt-60_000};
    adapter.files.set("stable.md",clear);adapter.dirs.add("Stale");adapter.dirMtimes.set("Stale",retiredAt+60_000);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.prunedFolders).toBe(1);expect(adapter.dirs.has("Stale")).toBe(false);expect(config.lastFolderCleanupAt).toBeGreaterThan(retiredAt);
  });
  it("preserves a file created between the two empty-folder checks",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("stable\n"),hash=await hashBytes(clear),retiredAt=Date.now()-120_000;
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000017",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"stable.md",hash,size:clear.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.retiredPaths={"Race/old.md":{hash,snapshotId:head.id,retiredAt}};adapter.files.set("stable.md",clear);adapter.dirs.add("Race");
    const list=adapter.list.bind(adapter);let raceLists=0;adapter.list=async(path:string)=>{const result=await list(path);if(path==="Race"&&++raceLists===1)adapter.files.set("Race/new.md",new TextEncoder().encode("new\n"));return result;};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.prunedFolders).toBe(0);expect(adapter.files.has("Race/new.md")).toBe(true);expect(adapter.dirs.has("Race")).toBe(true);expect(adapter.rmdirCalls).toEqual([]);
  });
  it("persists the exact platform error when empty-folder removal fails",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("stable\n"),hash=await hashBytes(clear),retiredAt=Date.now()-120_000;
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000018",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"stable.md",hash,size:clear.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.retiredPaths={"Blocked/old.md":{hash,snapshotId:head.id,retiredAt}};adapter.files.set("stable.md",clear);adapter.dirs.add("Blocked");adapter.rmdir=async()=>{throw new Error("Access denied by test adapter");};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.prunedFolders).toBe(0);expect(config.lastFolderCleanupAt).toBe(0);expect(config.lastFolderCleanupError).toContain("Blocked: Access denied by test adapter");
  });
  it("applies an accepted folder deletion even when it contains an excluded device-local file",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("stable\n"),ignored=new TextEncoder().encode("temporary\n"),hash=await hashBytes(clear),retiredAt=Date.now()-120_000;
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000019",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"stable.md",hash,size:clear.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.retiredPaths={"Legacy/old.md":{hash,snapshotId:head.id,retiredAt}};config.exclusions=[...config.exclusions,"Legacy/device-local.tmp"];
    adapter.files.set("stable.md",clear);adapter.files.set("Legacy/device-local.tmp",ignored);adapter.dirs.add("Legacy");
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.prunedFolders).toBe(1);expect(result.pendingRetiredFolders).toBe(0);expect(config.retiredFolderCount).toBe(0);expect(adapter.files.has("Legacy/device-local.tmp")).toBe(false);expect(adapter.trashed.get("Legacy/device-local.tmp")).toEqual(ignored);expect(adapter.dirs.has("Legacy")).toBe(false);
  });
  it("recursively removes empty untracked subfolders beneath a retired branch",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("stable\n"),hash=await hashBytes(clear),retiredAt=Date.now()-120_000;
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000020",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"stable.md",hash,size:clear.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.retiredPaths={"Legacy/old.md":{hash,snapshotId:head.id,retiredAt}};adapter.files.set("stable.md",clear);adapter.dirs.add("Legacy");adapter.dirs.add("Legacy/Empty shell");
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.prunedFolders).toBe(2);expect(result.pendingRetiredFolders).toBe(0);expect(adapter.dirs.has("Legacy/Empty shell")).toBe(false);expect(adapter.dirs.has("Legacy")).toBe(false);
  });
  it("automatically removes harmless excluded platform metadata from a retired branch",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("stable\n"),hash=await hashBytes(clear),retiredAt=Date.now()-120_000;
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000021",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"stable.md",hash,size:clear.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.retiredPaths={"Legacy/old.md":{hash,snapshotId:head.id,retiredAt}};config.exclusions=[...config.exclusions,"Legacy/.nomedia"];adapter.files.set("stable.md",clear);adapter.files.set("Legacy/.nomedia",new Uint8Array());adapter.dirs.add("Legacy");
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.prunedFolders).toBe(1);expect(result.pendingRetiredFolders).toBe(0);expect(adapter.files.has("Legacy/.nomedia")).toBe(false);expect(adapter.dirs.has("Legacy")).toBe(false);
  });
  it("preserves a newly changed synced file instead of treating it as an old folder remnant",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),stable=new TextEncoder().encode("stable\n"),old=new TextEncoder().encode("old\n"),changed=new TextEncoder().encode("changed\n"),stableHash=await hashBytes(stable),oldHash=await hashBytes(old),retiredAt=Date.now()-120_000;
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000022",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"stable.md",hash:stableHash,size:stable.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.retiredPaths={"Legacy/old.md":{hash:oldHash,snapshotId:head.id,retiredAt}};adapter.files.set("stable.md",stable);adapter.files.set("Legacy/old.md",changed);adapter.dirs.add("Legacy");
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.prunedFolders).toBe(0);expect(result.pendingRetiredFolders).toBe(1);expect(config.fullScanRequired).toBe(true);expect(adapter.files.get("Legacy/old.md")).toEqual(changed);expect(adapter.trashed.size).toBe(0);expect(adapter.dirs.has("Legacy")).toBe(true);
  });
  it("falls back to hidden local recovery when Obsidian trash is unavailable",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("stable\n"),local=new TextEncoder().encode("local\n"),hash=await hashBytes(clear),retiredAt=Date.now()-120_000;
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000023",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Stable",entries:[{path:"stable.md",hash,size:clear.length,mtime:1}]};
    api.head=head;config.initialized=true;config.lastSnapshotId=head.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.retiredPaths={"Legacy/old.md":{hash,snapshotId:head.id,retiredAt}};config.exclusions=[...config.exclusions,"Legacy/local.tmp"];adapter.files.set("stable.md",clear);adapter.files.set("Legacy/local.tmp",local);adapter.dirs.add("Legacy");(adapter as {trashLocal?:unknown}).trashLocal=undefined;
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.prunedFolders).toBe(1);expect(adapter.files.has("Legacy/local.tmp")).toBe(false);expect([...adapter.files].some(([path,bytes])=>path.startsWith(".gib-sync/local-recovery/")&&path.endsWith("/Legacy/local.tmp")&&bytes===local)).toBe(true);expect(adapter.dirs.has("Legacy")).toBe(false);
  });
  it("removes only the empty source branch after an accepted folder move",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),note=new TextEncoder().encode("moved\n"),keep=new TextEncoder().encode("keep\n"),noteHash=await hashBytes(note),keepHash=await hashBytes(keep),createdAt=new Date().toISOString();
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000014",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt,message:"Base",entries:[{path:"Legacy/Nested/note.md",hash:noteHash,size:note.length,mtime:1},{path:"Legacy/keep.md",hash:keepHash,size:keep.length,mtime:1}]};
    const remote:Snapshot={id:"00000000-0000-4000-8000-000000000015",vaultId:"vault",parentId:base.id,deviceId:"mobile",deviceName:"Mobile",createdAt:new Date(Date.now()+1000).toISOString(),message:"Move",entries:[{path:"Current/note.md",hash:noteHash,size:note.length,mtime:2},{path:"Legacy/keep.md",hash:keepHash,size:keep.length,mtime:1}]};
    api.head=remote;api.snapshots.set(base.id,base);api.blobs.set(noteHash,await encryptBlob(note,config.vaultKey,noteHash));api.blobs.set(keepHash,await encryptBlob(keep,config.vaultKey,keepHash));config.initialized=true;config.lastSnapshotId=base.id;config.exclusions=[...config.exclusions,"Legacy/device-local.tmp"];
    adapter.files.set("Legacy/Nested/note.md",note);adapter.files.set("Legacy/keep.md",keep);adapter.files.set("Legacy/device-local.tmp",keep);for(const path of ["Legacy","Legacy/Nested"]){adapter.dirs.add(path);adapter.dirMtimes.set(path,1);}
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.prunedFolders).toBe(1);expect(result.pendingRetiredFolders).toBe(0);expect(adapter.files.get("Current/note.md")).toEqual(note);expect(adapter.files.has("Legacy/Nested/note.md")).toBe(false);expect(adapter.dirs.has("Legacy/Nested")).toBe(false);expect(adapter.dirs.has("Legacy")).toBe(true);expect(adapter.files.get("Legacy/keep.md")).toEqual(keep);expect(adapter.files.get("Legacy/device-local.tmp")).toEqual(keep);expect(adapter.trashed.size).toBe(0);
  });
  it("hashes only journaled paths and preserves the rest of the baseline",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),oldChanged=new TextEncoder().encode("old\n"),changed=new TextEncoder().encode("new\n"),stable=new TextEncoder().encode("stable\n");
    const oldHash=await hashBytes(oldChanged),stableHash=await hashBytes(stable),base:Snapshot={id:"00000000-0000-4000-8000-000000000011",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:[{path:"changed.md",hash:oldHash,size:oldChanged.length,mtime:1},{path:"stable.md",hash:stableHash,size:stable.length,mtime:1}]};
    api.head=base;api.snapshots.set(base.id,base);api.blobs.set(oldHash,await encryptBlob(oldChanged,config.vaultKey,oldHash));api.blobs.set(stableHash,await encryptBlob(stable,config.vaultKey,stableHash));config.initialized=true;config.lastSnapshotId=base.id;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();config.pendingPaths=["changed.md"];
    adapter.files.set("changed.md",changed);adapter.files.set("stable.md",stable);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:1,fullScan:false,processedPaths:["changed.md"]});expect(adapter.listCalls).toBe(1);expect(adapter.readCalls.every((path)=>path==="changed.md")).toBe(true);expect(api.head?.entries.map((entry)=>entry.path).sort()).toEqual(["changed.md","stable.md"]);
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
  it("preserves both independently populated vaults during explicit keep-both onboarding",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),local=new TextEncoder().encode("wrong vault\n"),remote=new TextEncoder().encode("shared vault\n"),hash=await hashBytes(remote);
    adapter.files.set("note.md",local);api.blobs.set(hash,await encryptBlob(remote,config.vaultKey,hash));
    api.head={id:"00000000-0000-4000-8000-000000000201",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Shared",entries:[{path:"note.md",hash,size:remote.length,mtime:1}]};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});
    const result=await engine.sync();expect(result.conflicts).toBe(1);expect(api.commits).toBe(1);const notes=[...adapter.files].filter(([path])=>!path.startsWith(".gib-sync/")).map(([,bytes])=>new TextDecoder().decode(bytes)).join("\n");expect(notes).toContain("wrong vault");expect(notes).toContain("shared vault");
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
    await expect(engine.restoreAcceptedSnapshot()).resolves.toEqual({downloaded:1,deleted:1,prunedFolders:0});expect(adapter.files.get("note.md")).toEqual(accepted);expect(adapter.files.has("extra.md")).toBe(false);expect(config.lastSnapshotId).toBe(api.head.id);
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
    const manifestBytes=new TextEncoder().encode('{"id":"calendar","version":"1.0.0"}'),manifestHash=await hashBytes(manifestBytes);api.blobs.set(manifestHash,await encryptBlob(manifestBytes,config.vaultKey,manifestHash));
    api.head={id:"00000000-0000-4000-8000-000000000204",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Plugins",entries:[
      {path:".obsidian/plugins/calendar/main.js",hash:pluginHash,size:pluginBytes.length,mtime:1},{path:".obsidian/plugins/calendar/manifest.json",hash:manifestHash,size:manifestBytes.length,mtime:1},{path:".obsidian/workspace.json",hash:workspaceHash,size:workspaceBytes.length,mtime:1},{path:".obsidian/plugins/gib-search/embeddings/model/index.meta.json",hash:generatedHash,size:generatedBytes.length,mtime:1}
    ]};
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(adapter.files.get(".obsidian/plugins/calendar/main.js")).toEqual(pluginBytes);expect(adapter.files.has(".obsidian/workspace.json")).toBe(false);expect(adapter.files.has(".obsidian/plugins/gib-search/embeddings/model/index.meta.json")).toBe(false);
    expect(api.readyHeads).toEqual(["00000000-0000-4000-8000-000000000204"]);expect(api.head?.entries.map((entry)=>entry.path)).toEqual([".obsidian/plugins/calendar/main.js",".obsidian/plugins/calendar/manifest.json"]);
  });
  it("carries concurrent edits to the destination of a folder move",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;
    const encode=(value:string)=>new TextEncoder().encode(value),baseValues=[encode("a\nb\nc\n"),encode("two\n"),encode("three\n")],localValues=[encode("A\nb\nc\n"),baseValues[1],baseValues[2]],remoteValues=[encode("a\nb\nC\n"),baseValues[1],baseValues[2]];
    const baseEntries:Snapshot["entries"]=[],remoteEntries:Snapshot["entries"]=[];
    for(let index=0;index<3;index++){const baseHash=await hashBytes(baseValues[index]),remoteHash=await hashBytes(remoteValues[index]);baseEntries.push({path:`Old/note-${index}.md`,hash:baseHash,size:baseValues[index].length,mtime:1});remoteEntries.push({path:`Old/note-${index}.md`,hash:remoteHash,size:remoteValues[index].length,mtime:index===0?3:1});api.blobs.set(baseHash,await encryptBlob(baseValues[index],config.vaultKey,baseHash));api.blobs.set(remoteHash,await encryptBlob(remoteValues[index],config.vaultKey,remoteHash));adapter.files.set(`New/note-${index}.md`,localValues[index]);}
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000710",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:baseEntries};
    api.snapshots.set(base.id,base);api.head={...base,id:"00000000-0000-4000-8000-000000000711",parentId:base.id,deviceId:"mobile",deviceName:"Mobile",entries:remoteEntries};config.lastSnapshotId=base.id;config.pendingMoves=[{from:"Old",to:"New",at:Date.now()}];
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.conflicts).toBe(0);expect(api.head?.entries.every((entry)=>entry.path.startsWith("New/"))).toBe(true);expect([...adapter.files.keys()].some((path)=>path.startsWith("Old/"))).toBe(false);
    expect(new TextDecoder().decode(adapter.files.get("New/note-0.md"))).toBe("A\nb\nC\n");
  });
  it("keeps a fully edited batch at its new folder without creating duplicates",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;const baseEntries:Snapshot["entries"]=[];
    for(let index=0;index<10;index++){const baseBytes=new TextEncoder().encode(`journal ${index}\n`),localBytes=new TextEncoder().encode(`journal ${index}\nmetadata: moved\n`),hash=await hashBytes(baseBytes);baseEntries.push({path:`Journal/day-${index}.md`,hash,size:baseBytes.length,mtime:1});api.blobs.set(hash,await encryptBlob(baseBytes,config.vaultKey,hash));adapter.files.set(`Archive/Journal/day-${index}.md`,localBytes);}
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000730",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:baseEntries};api.snapshots.set(base.id,base);api.head=base;config.lastSnapshotId=base.id;config.pendingMoves=[{from:"Journal",to:"Archive/Journal",at:Date.now()}];
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync(),paths=api.head!.entries.map((entry)=>entry.path);
    expect(result.conflicts).toBe(0);expect(paths).toHaveLength(10);expect(paths.every((path)=>path.startsWith("Archive/Journal/"))).toBe(true);expect([...adapter.files.keys()].some((path)=>path.startsWith("Journal/"))).toBe(false);
  });
  it("converges simultaneous moves to one destination instead of duplicating files",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;const entries:Snapshot["entries"]=[];
    for(let index=0;index<3;index++){const clear=new TextEncoder().encode(`note ${index}\n`),hash=await hashBytes(clear);entries.push({path:`Old/note-${index}.md`,hash,size:clear.length,mtime:1});api.blobs.set(hash,await encryptBlob(clear,config.vaultKey,hash));adapter.files.set(`Local destination/note-${index}.md`,clear);}
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000720",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries};api.snapshots.set(base.id,base);config.lastSnapshotId=base.id;
    api.head={...base,id:"00000000-0000-4000-8000-000000000721",parentId:base.id,deviceId:"mobile",deviceName:"Mobile",entries:entries.map((entry)=>({...entry,path:entry.path.replace("Old/","Remote destination/")}))};
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync(),paths=api.head!.entries.map((entry)=>entry.path);
    expect(result.conflicts).toBe(0);expect(paths).toHaveLength(3);expect(paths.every((path)=>path.startsWith("Remote destination/"))).toBe(true);expect([...adapter.files.keys()].filter(path=>!path.startsWith(".gib-sync/")).every((path)=>path.startsWith("Remote destination/"))).toBe(true);
  });
  it("semantically combines Obsidian settings without creating deep conflict files",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.syncObsidianConfig=true;
    const baseBytes=new TextEncoder().encode('{"theme":"old","editor":{"line":true}}'),localBytes=new TextEncoder().encode('{"theme":"dark","editor":{"line":true}}'),remoteBytes=new TextEncoder().encode('{"theme":"old","editor":{"line":false}}');
    const baseHash=await hashBytes(baseBytes),remoteHash=await hashBytes(remoteBytes),base:Snapshot={id:"00000000-0000-4000-8000-000000000205",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base settings",entries:[{path:".obsidian/app.json",hash:baseHash,size:baseBytes.length,mtime:1}]};
    config.lastSnapshotId=base.id;api.snapshots.set(base.id,base);api.blobs.set(baseHash,await encryptBlob(baseBytes,config.vaultKey,baseHash));api.blobs.set(remoteHash,await encryptBlob(remoteBytes,config.vaultKey,remoteHash));api.head={...base,id:"00000000-0000-4000-8000-000000000206",parentId:base.id,deviceId:"mobile",deviceName:"Mobile",entries:[{path:".obsidian/app.json",hash:remoteHash,size:remoteBytes.length,mtime:3}]};adapter.files.set(".obsidian/app.json",localBytes);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.conflicts).toBe(0);expect(result.resolved).toBe(1);expect(api.head?.entries).toHaveLength(1);expect([...adapter.files.keys()].filter((path)=>path.includes("conflict"))).toHaveLength(0);expect(JSON.parse(new TextDecoder().decode(adapter.files.get(".obsidian/app.json")))).toEqual({theme:"dark",editor:{line:false}});
  });
  it("adopts shared plugin settings on first activation without retiring unrelated local installations",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.syncPlugins=true;config.pluginSyncBootstrapPending=true;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();
    const accepted=new Map<string,Uint8Array>([[".obsidian/plugins/demo/manifest.json",new TextEncoder().encode('{"id":"demo","version":"1.0.0"}')],[".obsidian/plugins/demo/main.js",new TextEncoder().encode("accepted code")],[".obsidian/plugins/demo/data.json",new TextEncoder().encode('{"configured":true,"template":"desktop"}')],[".obsidian/community-plugins.json",new TextEncoder().encode('["demo","gib-sync"]')]]),entries:Snapshot["entries"]=[];
    for(const [path,clear] of accepted){const hash=await hashBytes(clear);entries.push({path,hash,size:clear.length,mtime:1});api.blobs.set(hash,await encryptBlob(clear,config.vaultKey,hash));}
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000214",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Accepted desktop plugins",entries};api.head=head;api.snapshots.set(head.id,head);config.lastSnapshotId=head.id;
    adapter.files.set(".obsidian/plugins/demo/manifest.json",accepted.get(".obsidian/plugins/demo/manifest.json")!);adapter.files.set(".obsidian/plugins/demo/main.js",accepted.get(".obsidian/plugins/demo/main.js")!);adapter.files.set(".obsidian/plugins/demo/data.json",new TextEncoder().encode('{"configured":false}'));
    adapter.files.set(".obsidian/plugins/mobile-only/manifest.json",new TextEncoder().encode('{"id":"mobile-only","version":"1.0.0"}'));adapter.files.set(".obsidian/plugins/mobile-only/main.js",new TextEncoder().encode("mobile code"));adapter.files.set(".obsidian/plugins/mobile-only/data.json",new TextEncoder().encode("{}"));adapter.files.set(".obsidian/community-plugins.json",new TextEncoder().encode('["demo","mobile-only","gib-sync"]'));
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:6,conflicts:0,fullScan:true});expect(api.commits).toBe(1);expect(config.pluginSyncBootstrapPending).toBe(false);expect(adapter.files.get(".obsidian/plugins/demo/data.json")).toEqual(accepted.get(".obsidian/plugins/demo/data.json"));expect(adapter.files.has(".obsidian/plugins/mobile-only/main.js")).toBe(true);expect(new Set(JSON.parse(new TextDecoder().decode(adapter.files.get(".obsidian/community-plugins.json"))))).toEqual(new Set(["demo","gib-sync","mobile-only"]));expect(api.head!.entries.some(entry=>entry.path===".obsidian/plugins/mobile-only/data.json")).toBe(true);
  });
  for(const mobile of [false,true])it(`keeps BRAT and excluded plugins installed and enabled on ${mobile?"mobile":"desktop"} bootstrap and repeated sync`,async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),encoder=new TextEncoder(),decode=(path:string)=>new TextDecoder().decode(adapter.files.get(path));
    config.initialized=true;config.syncPlugins=true;config.pluginSyncBootstrapPending=true;config.exclusions.push(".obsidian/plugins/private-tool");
    const remote=new Map([[".obsidian/plugins/demo/manifest.json",'{"id":"demo","version":"1.0.0"}'],[".obsidian/plugins/demo/main.js","server code"],[".obsidian/plugins/demo/data.json",'{"custom":"server"}'],[".obsidian/community-plugins.json",'["demo","gib-sync"]']]),entries:Snapshot["entries"]=[];
    for(const [path,text]of remote){const clear=encoder.encode(text),hash=await hashBytes(clear);entries.push({path,hash,size:clear.length,mtime:1});api.blobs.set(hash,await encryptBlob(clear,config.vaultKey,hash));}
    for(const id of ["obsidian42-brat","private-tool"]){adapter.files.set(`.obsidian/plugins/${id}/manifest.json`,encoder.encode(JSON.stringify({id,version:"1.0.0"})));adapter.files.set(`.obsidian/plugins/${id}/main.js`,encoder.encode(`${id} original code`));adapter.files.set(`.obsidian/plugins/${id}/data.json`,encoder.encode('{"custom":"device"}'));}
    adapter.files.set(".obsidian/community-plugins.json",encoder.encode('["obsidian42-brat","private-tool","gib-sync"]'));
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000299",vaultId:"vault",parentId:null,deviceId:"server",deviceName:"Server",createdAt:new Date().toISOString(),message:"Seed",entries};api.head=head;api.snapshots.set(head.id,head);config.lastSnapshotId=head.id;
    const quiesce=vi.fn(async()=>{}),activate=vi.fn(async()=>{}),runtime={quiesce,activate,finish:async()=>{},dispose:()=>{}},messages:string[]=[];
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},progress=>messages.push(progress.message),undefined,undefined,async()=>{},mobile,undefined,undefined,runtime);
    await engine.sync();config.fullScanRequired=true;await engine.sync();
    for(const id of ["obsidian42-brat","private-tool"]){expect(decode(`.obsidian/plugins/${id}/main.js`)).toBe(`${id} original code`);expect(decode(`.obsidian/plugins/${id}/data.json`)).toBe('{"custom":"device"}');expect(quiesce.mock.calls.flat()).not.toContain(id);expect(activate.mock.calls.flat()).not.toContain(id);}
    expect(new Set(JSON.parse(decode(".obsidian/community-plugins.json")))).toEqual(new Set(["demo","gib-sync","obsidian42-brat","private-tool"]));expect(config.packageHolds).toEqual({});expect(messages.some(message=>message.includes("non-standard JSON")||message.includes("incomplete package"))).toBe(false);expect(api.head!.entries.some(entry=>entry.path.includes("obsidian42-brat/")||entry.path.includes("private-tool/"))).toBe(false);
  });
  it("does not remotely enable a disabled local installer",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),encoder=new TextEncoder();config.initialized=true;config.syncPlugins=true;
    const clear=encoder.encode('["obsidian42-brat","gib-sync"]'),hash=await hashBytes(clear),head:Snapshot={id:"00000000-0000-4000-8000-000000000298",vaultId:"vault",parentId:null,deviceId:"server",deviceName:"Server",createdAt:new Date().toISOString(),message:"Enabled elsewhere",entries:[{path:".obsidian/community-plugins.json",hash,size:clear.length,mtime:1}]};api.head=head;api.snapshots.set(head.id,head);api.blobs.set(hash,await encryptBlob(clear,config.vaultKey,hash));config.lastSnapshotId=head.id;adapter.files.set(".obsidian/community-plugins.json",encoder.encode('["gib-sync"]'));
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(JSON.parse(new TextDecoder().decode(adapter.files.get(".obsidian/community-plugins.json")))).toEqual(["gib-sync"]);expect(config.packageHolds).toEqual({});
  });
  it("retains a local installation and its enabled state during server-first onboarding",async()=>{
    const f=await incomingFixture(),encoder=new TextEncoder();f.config.initialized=false;f.config.lastSnapshotId=null;f.config.onboardingMode="server-first";f.config.syncPlugins=true;f.adapter.files.set(".obsidian/plugins/other/manifest.json",encoder.encode('{"id":"other","version":"1.0.0"}'));f.adapter.files.set(".obsidian/plugins/other/main.js",encoder.encode("local other code"));f.adapter.files.set(".obsidian/plugins/other/data.json",encoder.encode('{"custom":"kept"}'));f.adapter.files.set(".obsidian/community-plugins.json",encoder.encode('["other","obsidian42-brat","gib-sync"]'));
    const enabled=encoder.encode('["gib-sync"]'),hash=await hashBytes(enabled);f.target.entries.push({path:".obsidian/community-plugins.json",hash,size:enabled.length,mtime:1});f.api.blobs.set(hash,await encryptBlob(enabled,f.config.vaultKey,hash));
    await new SyncEngine(f.adapter as unknown as DataAdapter,f.api as unknown as GibSyncApi,()=>f.config,async()=>{},()=>{}).sync();expect(new TextDecoder().decode(f.adapter.files.get(".obsidian/plugins/other/data.json"))).toBe('{"custom":"kept"}');expect(new Set(JSON.parse(new TextDecoder().decode(f.adapter.files.get(".obsidian/community-plugins.json"))))).toEqual(new Set(["other","obsidian42-brat","gib-sync"]));expect(f.api.commits).toBe(0);expect(f.config.pendingApplyPaths).toEqual([]);
  });
  it("reports an adopted remote enablement read failure as a transport failure, not invalid JSON",async()=>{
    const f=await incomingFixture(),encoder=new TextEncoder(),enabled=encoder.encode('["gib-sync"]'),hash=await hashBytes(enabled),messages:string[]=[];f.config.syncPlugins=true;f.config.pluginSyncBootstrapPending=true;f.target.entries.push({path:".obsidian/community-plugins.json",hash,size:enabled.length,mtime:1});f.adapter.files.set(".obsidian/community-plugins.json",encoder.encode('["obsidian42-brat","gib-sync"]'));const get=f.api.getBlob.bind(f.api);f.api.getBlob=async wanted=>{if(wanted===hash)throw new ApiError("Unavailable",503,null);return get(wanted);};
    await expect(new SyncEngine(f.adapter as unknown as DataAdapter,f.api as unknown as GibSyncApi,()=>f.config,async()=>{},progress=>messages.push(progress.message)).sync()).rejects.toMatchObject({status:503});expect(messages.some(message=>message.includes("non-standard JSON"))).toBe(false);expect(new TextDecoder().decode(f.adapter.files.get(".obsidian/community-plugins.json"))).toBe('["obsidian42-brat","gib-sync"]');expect(f.api.commits).toBe(0);
  });
  it("activates updated code against preserved device-local settings when data.json is excluded",async()=>{
    const f=await incomingFixture(),encoder=new TextEncoder(),root=".obsidian/plugins/demo",localData=encoder.encode('{"private":"kept"}');f.config.syncPlugins=true;f.config.pluginSyncBootstrapPending=false;f.config.exclusions.push(`${root}/data.json`);
    f.adapter.files.set(`${root}/manifest.json`,encoder.encode('{"id":"demo","version":"1.0.0"}'));f.adapter.files.set(`${root}/main.js`,encoder.encode("old code"));f.adapter.files.set(`${root}/data.json`,localData);
    for(const [relative,text]of [["manifest.json",'{"id":"demo","version":"2.0.0"}'],["main.js","new code"],["data.json",'{"remote":"not mine"}']]){const clear=encoder.encode(text),hash=await hashBytes(clear);f.target.entries.push({path:`${root}/${relative}`,hash,size:clear.length,mtime:2});f.api.blobs.set(hash,await encryptBlob(clear,f.config.vaultKey,hash));}
    const activate=vi.fn(async()=>{}),runtime={quiesce:async()=>{},activate,finish:async()=>{},dispose:()=>{}};
    await new SyncEngine(f.adapter as unknown as DataAdapter,f.api as unknown as GibSyncApi,()=>f.config,async()=>{},()=>{},undefined,undefined,async()=>{},false,undefined,undefined,runtime).sync();expect(f.adapter.files.get(`${root}/data.json`)).toEqual(localData);expect(new TextDecoder().decode(f.adapter.files.get(`${root}/main.js`))).toBe("new code");expect(activate).toHaveBeenCalledWith("demo",await hashBytes(localData));expect(f.config.packageHolds).toEqual({});
  });
  it("lets the first plugin-sync device seed an empty accepted plugin scope",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.syncPlugins=true;config.pluginSyncBootstrapPending=true;config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();
    const note=new TextEncoder().encode("stable\n"),noteHash=await hashBytes(note),head:Snapshot={id:"00000000-0000-4000-8000-000000000215",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"No plugins yet",entries:[{path:"note.md",hash:noteHash,size:note.length,mtime:1}]};api.head=head;api.snapshots.set(head.id,head);api.blobs.set(noteHash,await encryptBlob(note,config.vaultKey,noteHash));config.lastSnapshotId=head.id;adapter.files.set("note.md",note);
    adapter.files.set(".obsidian/plugins/demo/manifest.json",new TextEncoder().encode('{"id":"demo","version":"1.0.0"}'));adapter.files.set(".obsidian/plugins/demo/main.js",new TextEncoder().encode("code"));adapter.files.set(".obsidian/plugins/demo/data.json",new TextEncoder().encode('{"configured":true}'));adapter.files.set(".obsidian/community-plugins.json",new TextEncoder().encode('["demo","gib-sync"]'));
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result.uploaded).toBe(4);expect(api.commits).toBe(1);expect(config.pluginSyncBootstrapPending).toBe(false);expect(api.head?.entries.filter((entry)=>entry.path.startsWith(".obsidian/")).map((entry)=>entry.path).sort()).toEqual([".obsidian/community-plugins.json",".obsidian/plugins/demo/data.json",".obsidian/plugins/demo/main.js",".obsidian/plugins/demo/manifest.json"]);
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
  it("preserves a local-only note whose filename resembles a generated conflict copy",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;
    const path="Notes/Orphan (conflict - Seafile - 2026-07-26 16-46-02 UTC - 2).md",clear=new TextEncoder().encode("obsolete copy\n");adapter.files.set(path,clear);
    api.head={id:"00000000-0000-4000-8000-000000000702",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Clean",entries:[]};config.lastSnapshotId=api.head.id;
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();
    expect(result).toMatchObject({uploaded:1,deleted:0,conflicts:0});expect(adapter.files.get(path)).toEqual(clear);expect(api.head?.entries.some(entry=>entry.path===path)).toBe(true);expect(api.commits).toBe(1);
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
  it("recovers an observed note independently while keeping conflict protection for unjournaled differences",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings();config.initialized=true;config.fullScanRequired=true;config.pendingPaths=["observed.md"];
    const text=(prefix:string)=>new TextEncoder().encode(Array.from({length:24},(_,index)=>`${prefix}${index}`).join(" ")+"\n"),baseBytes=text("base"),remoteBytes=text("remote"),localBytes=text("local");
    const baseHash=await hashBytes(baseBytes),remoteHash=await hashBytes(remoteBytes),base:Snapshot={id:"00000000-0000-4000-8000-000000000370",vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:["observed.md","unjournaled.md"].map((path)=>({path,hash:baseHash,size:baseBytes.length,mtime:1}))};
    const ownHead:Snapshot={...base,id:"00000000-0000-4000-8000-000000000371",parentId:base.id,entries:["observed.md","unjournaled.md"].map((path)=>({path,hash:remoteHash,size:remoteBytes.length,mtime:2}))};
    api.snapshots.set(base.id,base);api.snapshots.set(ownHead.id,ownHead);api.head=ownHead;api.blobs.set(baseHash,await encryptBlob(baseBytes,config.vaultKey,baseHash));api.blobs.set(remoteHash,await encryptBlob(remoteBytes,config.vaultKey,remoteHash));config.lastSnapshotId=base.id;adapter.files.set("observed.md",localBytes);adapter.files.set("unjournaled.md",localBytes);
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(result.conflicts).toBe(1);expect(api.head?.entries.filter((entry)=>entry.path.includes("conflict"))).toHaveLength(1);expect(adapter.files.get("observed.md")).toEqual(localBytes);
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
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),old=new TextEncoder().encode("old\n"),accepted=new TextEncoder().encode("accepted\n"),oldHash=await hashBytes(old),hash=await hashBytes(accepted);
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000419",vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:[{path:"note.md",hash:oldHash,size:old.length,mtime:1}]},head:Snapshot={...base,id:"00000000-0000-4000-8000-000000000420",parentId:base.id,message:"Accepted",entries:[{path:"note.md",hash,size:accepted.length,mtime:2}]};api.head=head;api.snapshots.set(base.id,base);api.snapshots.set(head.id,head);api.blobs.set(hash,await encryptBlob(accepted,config.vaultKey,hash));adapter.files.set("note.md",old);config.initialized=true;config.lastSnapshotId=head.id;config.pendingApplyPaths=["note.md"];config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();
    const result=await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(result.uploaded).toBe(0);expect(api.commits).toBe(0);expect(adapter.files.get("note.md")).toEqual(accepted);expect(config.pendingApplyPaths).toEqual([]);
  });
  it("finishes an interrupted first download from exact pre-apply hashes",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),old=new TextEncoder().encode("old local copy\n"),accepted=new TextEncoder().encode("accepted server copy\n"),oldHash=await hashBytes(old),hash=await hashBytes(accepted);
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000427",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Accepted",entries:[{path:"note.md",hash,size:accepted.length,mtime:2}]};
    api.head=head;api.snapshots.set(head.id,head);api.blobs.set(hash,await encryptBlob(accepted,config.vaultKey,hash));adapter.files.set("note.md",old);config.initialized=false;config.lastSnapshotId=null;config.pendingApplySnapshotId=head.id;config.pendingApplyBaseSnapshotId=null;config.pendingApplyPaths=["note.md"];config.pendingApplyPriorHashes={"note.md":oldHash};config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(adapter.files.get("note.md")).toEqual(accepted);expect(config.lastSnapshotId).toBe(head.id);expect(config.pendingApplyPaths).toEqual([]);expect(config.pendingApplyPriorHashes).toEqual({});expect(api.commits).toBe(0);
  });
  it("keeps the prior checkpoint until every accepted move operation is applied",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("moved\n"),hash=await hashBytes(clear);
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000421",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:[{path:"Old/note.md",hash,size:clear.length,mtime:1}]},target:Snapshot={...base,id:"00000000-0000-4000-8000-000000000422",parentId:base.id,deviceId:"mobile",deviceName:"Mobile",message:"Move",entries:[{path:"New/note.md",hash,size:clear.length,mtime:2}]};
    api.head=target;api.snapshots.set(base.id,base);api.snapshots.set(target.id,target);api.blobs.set(hash,await encryptBlob(clear,config.vaultKey,hash));adapter.files.set("Old/note.md",clear);config.initialized=true;config.lastSnapshotId=base.id;
    const rename=adapter.rename.bind(adapter);let interrupted=true;adapter.rename=async(path,destination)=>{if(interrupted&&path==="Old/note.md"){interrupted=false;throw new Error("mobile suspended");}await rename(path,destination);};
    const engine=new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{});await expect(engine.sync()).rejects.toThrow("mobile suspended");
    expect(config.lastSnapshotId).toBe(base.id);expect(config.pendingApplySnapshotId).toBe(target.id);expect(config.pendingApplyBaseSnapshotId).toBe(base.id);expect(adapter.files.get("New/note.md")).toEqual(clear);
    await expect(engine.sync()).resolves.toMatchObject({uploaded:0,conflicts:0});expect(config.lastSnapshotId).toBe(target.id);expect(config.pendingApplyPaths).toEqual([]);expect(adapter.files.has("Old/note.md")).toBe(false);expect(api.commits).toBe(0);
  });
  it("does not mistake a late mobile event for a user edit when resuming an accepted deletion",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("retire me\n"),hash=await hashBytes(clear);
    const base:Snapshot={id:"00000000-0000-4000-8000-000000000423",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Base",entries:[{path:"Old/note.md",hash,size:clear.length,mtime:1}]},target:Snapshot={...base,id:"00000000-0000-4000-8000-000000000424",parentId:base.id,message:"Deleted",entries:[]};
    api.head=target;api.snapshots.set(base.id,base);api.snapshots.set(target.id,target);adapter.files.set("Old/note.md",clear);config.initialized=true;config.lastSnapshotId=base.id;config.pendingApplySnapshotId=target.id;config.pendingApplyBaseSnapshotId=base.id;config.pendingApplyPaths=["Old/note.md"];config.pendingPaths=["Old/note.md"];config.pendingPathTimes={"Old/note.md":Date.now()};config.fullScanRequired=false;config.lastFullScanAt=new Date().toISOString();
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(adapter.files.has("Old/note.md")).toBe(false);expect(api.commits).toBe(0);expect(config.lastSnapshotId).toBe(target.id);
  });
  it("removes an exact retired path that Android later resurrects",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("same bytes\n"),hash=await hashBytes(clear);
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000425",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Moved",entries:[{path:"New/note.md",hash,size:clear.length,mtime:2}]};
    api.head=head;api.snapshots.set(head.id,head);api.blobs.set(hash,await encryptBlob(clear,config.vaultKey,hash));adapter.files.set("New/note.md",clear);adapter.files.set("Old/note.md",clear);config.initialized=true;config.lastSnapshotId=head.id;config.retiredPaths={"Old/note.md":{hash,snapshotId:head.id,retiredAt:Date.now()}};
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(adapter.files.has("Old/note.md")).toBe(false);expect(api.commits).toBe(0);expect(api.head?.entries.map((entry)=>entry.path)).toEqual(["New/note.md"]);
  });
  it("keeps genuinely changed content at a previously retired path",async()=>{
    const adapter=new MemoryAdapter(),api=new MemoryApi(),config=settings(),clear=new TextEncoder().encode("same bytes\n"),changed=new TextEncoder().encode("intentional restoration\n"),hash=await hashBytes(clear);
    const head:Snapshot={id:"00000000-0000-4000-8000-000000000426",vaultId:"vault",parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:new Date().toISOString(),message:"Moved",entries:[{path:"New/note.md",hash,size:clear.length,mtime:2}]};
    api.head=head;api.snapshots.set(head.id,head);api.blobs.set(hash,await encryptBlob(clear,config.vaultKey,hash));adapter.files.set("New/note.md",clear);adapter.files.set("Old/note.md",changed);config.initialized=true;config.lastSnapshotId=head.id;config.retiredPaths={"Old/note.md":{hash,snapshotId:head.id,retiredAt:Date.now()}};
    await new SyncEngine(adapter as unknown as DataAdapter,api as unknown as GibSyncApi,()=>config,async()=>{},()=>{}).sync();expect(adapter.files.get("Old/note.md")).toEqual(changed);expect(api.commits).toBe(1);expect(config.retiredPaths["Old/note.md"]).toBeUndefined();
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
