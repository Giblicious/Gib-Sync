import { requestUrl } from "obsidian";
import { PROTOCOL_VERSION, type ClientCompatibility, type CommitRequest, type HealthRepairResult, type HistoryItem, type ManifestEntry, type MirrorCompleteResponse, type MirrorPlanResponse, type QuarantineItem, type QuickCodeClaim, type QuickCodePairing, type RestorePreview, type SafeguardPolicy, type SafeguardState, type SelectiveRestorePlan, type SelectiveRestorePreview, type ServerStatus, type SetupResponse, type Snapshot, type StorageDiscovery, type StorageSetupRequest, type SyncState, type WatchResponse } from "@gib-sync/protocol";
import type { GibSyncSettings } from "./settings";
import { hashBytes } from "./crypto";
import type {SnapshotDelta} from "@gib-sync/protocol";
import type {SnapshotCache} from "./snapshot-cache";
import {sha256} from "@noble/hashes/sha2.js";
import {bytesToHex} from "@noble/hashes/utils.js";
import {controlledIo} from "./io-control";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly responseBody: unknown) { super(message); }
}

export class ApiTransportError extends Error {
  constructor(cause:unknown){super(cause instanceof Error?cause.message:"Connection interrupted",{cause});}
}

async function transport<T>(request:()=>Promise<T>):Promise<T>{
  try{return await request();}catch(error){throw new ApiTransportError(error);}
}

function errorBody(response:{json:unknown}):any{
  // Proxies often return HTML for 502/503 errors. Obsidian's JSON accessor
  // can throw; preserve the HTTP status so recovery still classifies it.
  try{return response.json;}catch{return null;}
}

export const CLIENT_VERSION="0.8.62";
export interface ContentUploadState{id:string;hash:string;size:number;offset:number;chunkBytes:number;complete:boolean;processing?:boolean;processingId?:string;stage?:"verifying"|"uploading"|"checking"|"waiting";}

function exactArrayBuffer(bytes:Uint8Array):ArrayBuffer{
  if(bytes.buffer instanceof ArrayBuffer&&bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength)return bytes.buffer;
  return bytes.slice().buffer;
}

export class GibSyncApi {
  private readonly capabilities=new Map<string,Set<string>>();
  constructor(private readonly settings: () => GibSyncSettings,private readonly cache?:SnapshotCache) {}
  private url(path: string, override?: string) { return `${(override ?? this.settings().serverUrl).replace(/\/$/, "")}${path}`; }
  private clientHeaders(){return {"X-Gib-Sync-Client-Version":CLIENT_VERSION,"X-Gib-Sync-Protocol":String(PROTOCOL_VERSION)};}
  private async json<T>(method: string, path: string, body?: unknown, token?: string, server?: string): Promise<T> {
    const response = await transport(()=>requestUrl({
      url: this.url(path, server), method,
      headers: { ...this.clientHeaders(),...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), throw: false
    }));
    if(response.status<200||response.status>=300){const body=errorBody(response);throw new ApiError(body?.message??body?.error??`Gib Sync request failed (${response.status})`,response.status,body);}
    const result=response.json as T,caps=(result as {serverCapabilities?:unknown})?.serverCapabilities;if(Array.isArray(caps))this.capabilities.set((server??this.settings().serverUrl).replace(/\/$/,""),new Set(caps.filter((item):item is string=>typeof item==="string")));else if(typeof (result as {serverVersion?:unknown})?.serverVersion==="string")this.capabilities.set((server??this.settings().serverUrl).replace(/\/$/,""),new Set());
    return result;
  }
  supportsStreamUpload():boolean{try{if(new URL(this.settings().serverUrl).protocol!=="https:")return false;}catch{return false;}return this.capabilities.get(this.settings().serverUrl.replace(/\/$/,""))?.has("resumable-content-upload-v1")===true;}
  disableStreamUpload():void{this.capabilities.get(this.settings().serverUrl.replace(/\/$/,""))?.delete("resumable-content-upload-v1");}
  discover(server:string,seafileUrl:string,seafileUsername:string,seafilePassword:string) { return this.json<StorageDiscovery>("POST","/v1/storage/discover",{seafileUrl,seafileUsername,seafilePassword},undefined,server); }
  serverInfo(server:string){return this.json<Pick<SetupResponse,"protocolVersion"|"serverVersion"|"serverCapabilities">>("GET","/healthz",undefined,undefined,server);}
  setup(server: string, body: StorageSetupRequest) { return this.json<SetupResponse>("POST", "/v1/setup", body, undefined, server); }
  async state():Promise<SyncState> {
    const settings=this.settings(),base=settings.lastSnapshotId&&await this.cache?.get(settings.lastSnapshotId,settings.vaultId);
    if(base){
      try{
        const delta=await this.json<SnapshotDelta>("GET",`/v1/delta?since=${encodeURIComponent(base.id)}`,undefined,settings.deviceToken);
        if(delta.baseId!==base.id||delta.snapshot.vaultId!==settings.vaultId)throw new Error("Snapshot delta identity is invalid");
        const entries=new Map(base.entries.map(entry=>[entry.path,entry]));
        for(const path of delta.removed)entries.delete(path);for(const entry of delta.changed)entries.set(entry.path,entry);
        const head:Snapshot={...delta.snapshot,entries:[...entries.values()].sort((a,b)=>a.path.localeCompare(b.path))};
        await this.cache?.put(head);return {head};
      }catch(error){if(!(error instanceof ApiError&&[404,409].includes(error.status)))throw error;}
    }
    const state=await this.json<SyncState>("GET","/v1/state",undefined,settings.deviceToken);if(state.head)await this.cache?.put(state.head);return state;
  }
  headState() { return this.json<{headId:string|null}>("GET", "/v1/head", undefined, this.settings().deviceToken); }
  watch(headId:string|null) { return this.json<WatchResponse>("GET", `/v1/watch?head=${encodeURIComponent(headId??"")}`, undefined, this.settings().deviceToken); }
  status() { return this.json<ServerStatus>("GET", "/v1/status", undefined, this.settings().deviceToken); }
  compatibility(){return this.json<ClientCompatibility>("GET","/v1/compatibility",undefined,this.settings().deviceToken);}
  async snapshot(id: string):Promise<Snapshot> {
    const settings=this.settings(),cached=await this.cache?.get(id,settings.vaultId);if(cached)return cached;
    const snapshot=await this.json<Snapshot>("GET", `/v1/snapshots/${id}`, undefined, settings.deviceToken);await this.cache?.put(snapshot);return snapshot;
  }
  history() { return this.json<HistoryItem[]>("GET", "/v1/history?limit=100", undefined, this.settings().deviceToken); }
  async commit(body: CommitRequest):Promise<Snapshot> {
    const snapshot=await this.json<Snapshot>("POST", "/v1/commit", body, this.settings().deviceToken);await this.cache?.put(snapshot);return snapshot;
  }
  restorePreview(id:string){return this.json<RestorePreview>("GET",`/v1/restore/${id}/preview`,undefined,this.settings().deviceToken);}
  restore(id: string,confirmToken:string) { return this.json<Snapshot>("POST", `/v1/restore/${id}`, {confirmToken}, this.settings().deviceToken); }
  selectiveRestorePlan(id:string){return this.json<SelectiveRestorePlan>("GET",`/v1/restore/${id}/changes`,undefined,this.settings().deviceToken);}
  selectiveRestorePreview(id:string,changeIds:string[]){return this.json<SelectiveRestorePreview>("POST",`/v1/restore/${id}/paths/preview`,{changeIds},this.settings().deviceToken);}
  selectiveRestore(id:string,changeIds:string[],confirmToken:string){return this.json<Snapshot>("POST",`/v1/restore/${id}/paths`,{changeIds,confirmToken},this.settings().deviceToken);}
  safeguards(){return this.json<SafeguardState>("GET","/v1/safeguards",undefined,this.settings().deviceToken);}
  updateSafeguardPolicy(policy:SafeguardPolicy){return this.json<SafeguardState>("PUT","/v1/safeguards/policy",policy,this.settings().deviceToken);}
  setWriteLock(locked:boolean){return this.json<SafeguardState>("POST","/v1/safeguards/lock",{locked},this.settings().deviceToken);}
  setMaintenance(minutes:number){return this.json<SafeguardState>("POST","/v1/safeguards/maintenance",{minutes},this.settings().deviceToken);}
  quarantines(){return this.json<QuarantineItem[]>("GET","/v1/quarantines",undefined,this.settings().deviceToken);}
  approveQuarantine(id:string,trustMinutes=0){return this.json<Snapshot>("POST",`/v1/quarantines/${id}/approve`,{trustMinutes},this.settings().deviceToken);}
  rejectQuarantine(id:string){return this.json<{ok:boolean}>("POST",`/v1/quarantines/${id}/reject`,{},this.settings().deviceToken);}
  repairHealth(){return this.json<HealthRepairResult>("POST","/v1/health/repair",{restoreAcceptedHead:true},this.settings().deviceToken);}
  markDeviceReady(headId:string|null){return this.json<{ok:boolean}>("POST","/v1/devices/current/ready",{headId},this.settings().deviceToken);}
  revokeDevice(id:string){return this.json<{ok:boolean}>("POST",`/v1/devices/${id}/revoke`,{},this.settings().deviceToken);}
  bookmark(id:string,label="Known good"){return this.json<{ok:boolean;label:string}>("PUT",`/v1/bookmarks/${id}`,{label},this.settings().deviceToken);}
  unbookmark(id:string){return this.json<{ok:boolean}>("DELETE",`/v1/bookmarks/${id}`,undefined,this.settings().deviceToken);}
  mirrorPlan(snapshotId:string,entries:ManifestEntry[]){return this.json<MirrorPlanResponse>("POST","/v1/mirror/plan",{snapshotId,entries},this.settings().deviceToken);}
  mirrorComplete(snapshotId:string){return this.json<MirrorCompleteResponse>("POST","/v1/mirror/complete",{snapshotId},this.settings().deviceToken);}
  createPairing() { return this.json<QuickCodePairing>("POST", "/v1/pairings", {}, this.settings().deviceToken); }
  claimQuickCode(server:string,code:string,deviceName:string){return this.json<QuickCodeClaim>("POST","/v1/pairings/claim-code",{code,deviceName},undefined,server);}
  async getBlob(hash: string): Promise<Uint8Array> {
    const response = await transport(()=>requestUrl({ url: this.url(`/v1/blobs/${hash}`), method: "GET", headers: { ...this.clientHeaders(),Authorization:`Bearer ${this.settings().deviceToken}` }, throw: false }));
    if (response.status !== 200) throw new ApiError(`Blob download failed (${response.status})`, response.status, null);
    return new Uint8Array(response.arrayBuffer);
  }
  async getContent(hash:string,expectedSize?:number):Promise<Uint8Array>{
    // requestUrl eagerly exposes text/json alongside the ArrayBuffer. That is
    // convenient for API responses but can exhaust a mobile WebView when the
    // vault contains large audio, PDF, or model files. Fetch keeps one binary
    // response body alive through the write instead.
    const response=await transport(()=>fetch(this.url(`/v1/content/${hash}`),{method:"GET",headers:{...this.clientHeaders(),Authorization:`Bearer ${this.settings().deviceToken}`},cache:"no-store"}));
    if(!response.ok)throw new ApiError(`Large-file download failed (${response.status})`,response.status,null);
    if(response.headers.get("x-content-sha256")!==hash)throw new Error("Large-file integrity header is missing or invalid");
    if(expectedSize!==undefined&&(!Number.isSafeInteger(expectedSize)||expectedSize<0))throw new Error("Large-file manifest size is invalid");
    if(!response.body||expectedSize===undefined){
      const bytes=new Uint8Array(await transport(()=>response.arrayBuffer()));
      if(expectedSize!==undefined&&bytes.byteLength!==expectedSize)throw new Error("Large-file response size does not match the manifest");
      if(await hashBytes(bytes)!==hash)throw new Error("Large-file content integrity check failed");
      return bytes;
    }
    const bytes=new Uint8Array(expectedSize),reader=response.body.getReader();let offset=0;
    try{for(;;){const {done,value}=await transport(()=>reader.read());if(done)break;if(offset+value.byteLength>bytes.byteLength)throw new Error("Large-file response exceeded its declared size");bytes.set(value,offset);offset+=value.byteLength;}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}
    finally{reader.releaseLock();}
    if(offset!==bytes.byteLength)throw new Error(`Large-file response ended early (${offset} of ${bytes.byteLength} bytes)`);
    if(await hashBytes(bytes)!==hash)throw new Error("Large-file content integrity check failed");
    return bytes;
  }
  /** Only a verified private stage may be promoted after this returns. */
  async streamContent(hash:string,expectedSize:number,onChunk:(bytes:Uint8Array)=>Promise<void>,checkpoint:()=>void):Promise<void>{
    if(!/^[a-f0-9]{64}$/.test(hash)||!Number.isSafeInteger(expectedSize)||expectedSize<0)throw new Error("Large-file manifest is invalid");
    return controlledIo(checkpoint,async(signal,touch)=>{
    checkpoint();
    const response=await transport(()=>fetch(this.url(`/v1/content/${hash}`),{method:"GET",headers:{...this.clientHeaders(),Authorization:`Bearer ${this.settings().deviceToken}`},cache:"no-store",signal}));
    try{
      checkpoint();
      if(!response.ok)throw new ApiError(`Large-file download failed (${response.status})`,response.status,null);
      if(response.headers.get("x-content-sha256")!==hash)throw new Error("Large-file integrity header is missing or invalid");
      if(!response.body)throw new Error("This device cannot stream the file response");
      const reader=response.body.getReader(),digest=sha256.create();let size=0;
      try{
        for(;;){
          checkpoint();const {done,value}=await transport(()=>reader.read());touch();checkpoint();if(done)break;
          if(size+value.byteLength>expectedSize)throw new Error("Large-file response exceeded its declared size");
          // Bound both hash CPU slices and native append calls, even if a
          // WebView's fetch reader returns an unusually large network chunk.
          for(let offset=0;offset<value.byteLength;offset+=64*1024){
            checkpoint();const chunk=value.subarray(offset,offset+64*1024);digest.update(chunk);await onChunk(chunk);size+=chunk.byteLength;
          }
        }
        if(size!==expectedSize)throw new Error(`Large-file response ended early (${size} of ${expectedSize} bytes)`);
        if(bytesToHex(digest.digest())!==hash)throw new Error("Large-file content integrity check failed");
        checkpoint();
      }catch(error){await reader.cancel().catch(()=>{});throw error;}
      finally{reader.releaseLock();digest.destroy();}
    }catch(error){if(!response.body?.locked)await response.body?.cancel().catch(()=>{});throw error;}
    });
  }
  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    const body = exactArrayBuffer(bytes);
    const response = await transport(()=>requestUrl({ url: this.url(`/v1/blobs/${hash}`), method: "PUT", headers: { ...this.clientHeaders(),Authorization:`Bearer ${this.settings().deviceToken}`,"Content-Type":"application/octet-stream" }, body, throw: false }));
    if (response.status < 200 || response.status >= 300) throw new ApiError(`Blob upload failed (${response.status})`, response.status, response.text);
  }
  private async uploadRequest<T>(path:string,method:string,body:string|ArrayBuffer,signal:AbortSignal,chunkHash?:string):Promise<T>{
    const response=await transport(()=>fetch(this.url(path),{method,headers:{...this.clientHeaders(),Authorization:`Bearer ${this.settings().deviceToken}`,"Content-Type":chunkHash?"application/octet-stream":"application/json",...(chunkHash?{"X-Chunk-SHA256":chunkHash}:{})},body,signal,cache:"no-store"}));
    let result:unknown;try{result=await response.json();}catch{/* Preserve HTTP errors from HTML proxies. */}
    if(!response.ok)throw new ApiError((result as {error?:string;message?:string})?.message??(result as {error?:string})?.error??`Content upload failed (${response.status})`,response.status,result);
    return result as T;
  }
  beginContentUpload(hash:string,size:number,signal:AbortSignal):Promise<ContentUploadState>{return this.uploadRequest("/v1/content-uploads","POST",JSON.stringify({hash,size}),signal);}
  putContentUploadChunk(id:string,index:number,bytes:Uint8Array,hash:string,signal:AbortSignal):Promise<{id:string;offset:number}>{return this.uploadRequest(`/v1/content-uploads/${encodeURIComponent(id)}/chunks/${index}`,"PUT",exactArrayBuffer(bytes),signal,hash);}
  completeContentUpload(id:string,signal:AbortSignal):Promise<ContentUploadState>{return this.uploadRequest(`/v1/content-uploads/${encodeURIComponent(id)}/complete`,"POST","{}",signal);}
  cancelContentUpload(id:string,processingId:string,signal:AbortSignal):Promise<{id:string;cancelled:boolean}>{return this.uploadRequest(`/v1/content-uploads/${encodeURIComponent(id)}/cancel`,"POST",JSON.stringify({processingId}),signal);}
  async putMirrorFile(snapshotId:string,path:string,hash:string,bytes:Uint8Array):Promise<void>{
    const response=await transport(()=>requestUrl({url:this.url(`/v1/mirror/file?path=${encodeURIComponent(path)}`),method:"PUT",headers:{...this.clientHeaders(),Authorization:`Bearer ${this.settings().deviceToken}`,"Content-Type":"application/octet-stream","X-Gib-Sync-Snapshot":snapshotId,"X-Gib-Sync-Hash":hash},body:exactArrayBuffer(bytes),throw:false}));
    if(response.status<200||response.status>=300)throw new ApiError(`Readable mirror upload failed for ${path} (${response.status})`,response.status,errorBody(response));
  }
}
