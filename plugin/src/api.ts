import { requestUrl } from "obsidian";
import { PROTOCOL_VERSION, type ClientCompatibility, type CommitRequest, type HealthRepairResult, type HistoryItem, type ManifestEntry, type MirrorCompleteResponse, type MirrorPlanResponse, type QuarantineItem, type QuickCodeClaim, type QuickCodePairing, type RestorePreview, type SafeguardPolicy, type SafeguardState, type ServerStatus, type SetupResponse, type Snapshot, type StorageDiscovery, type StorageSetupRequest, type SyncState, type WatchResponse } from "@gib-sync/protocol";
import type { GibSyncSettings } from "./settings";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly responseBody: unknown) { super(message); }
}

export const CLIENT_VERSION="0.8.24";

export class GibSyncApi {
  constructor(private readonly settings: () => GibSyncSettings) {}
  private url(path: string, override?: string) { return `${(override ?? this.settings().serverUrl).replace(/\/$/, "")}${path}`; }
  private clientHeaders(){return {"X-Gib-Sync-Client-Version":CLIENT_VERSION,"X-Gib-Sync-Protocol":String(PROTOCOL_VERSION)};}
  private async json<T>(method: string, path: string, body?: unknown, token?: string, server?: string): Promise<T> {
    const response = await requestUrl({
      url: this.url(path, server), method,
      headers: { ...this.clientHeaders(),...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), throw: false
    });
    if (response.status < 200 || response.status >= 300) throw new ApiError(response.json?.message??response.json?.error ?? `Gib Sync request failed (${response.status})`, response.status, response.json);
    return response.json as T;
  }
  discover(server:string,seafileUrl:string,seafileUsername:string,seafilePassword:string) { return this.json<StorageDiscovery>("POST","/v1/storage/discover",{seafileUrl,seafileUsername,seafilePassword},undefined,server); }
  setup(server: string, body: StorageSetupRequest) { return this.json<SetupResponse>("POST", "/v1/setup", body, undefined, server); }
  state() { return this.json<SyncState>("GET", "/v1/state", undefined, this.settings().deviceToken); }
  headState() { return this.json<{headId:string|null}>("GET", "/v1/head", undefined, this.settings().deviceToken); }
  watch(headId:string|null) { return this.json<WatchResponse>("GET", `/v1/watch?head=${encodeURIComponent(headId??"")}`, undefined, this.settings().deviceToken); }
  status() { return this.json<ServerStatus>("GET", "/v1/status", undefined, this.settings().deviceToken); }
  compatibility(){return this.json<ClientCompatibility>("GET","/v1/compatibility",undefined,this.settings().deviceToken);}
  snapshot(id: string) { return this.json<Snapshot>("GET", `/v1/snapshots/${id}`, undefined, this.settings().deviceToken); }
  history() { return this.json<HistoryItem[]>("GET", "/v1/history?limit=100", undefined, this.settings().deviceToken); }
  commit(body: CommitRequest) { return this.json<Snapshot>("POST", "/v1/commit", body, this.settings().deviceToken); }
  restorePreview(id:string){return this.json<RestorePreview>("GET",`/v1/restore/${id}/preview`,undefined,this.settings().deviceToken);}
  restore(id: string,confirmToken:string) { return this.json<Snapshot>("POST", `/v1/restore/${id}`, {confirmToken}, this.settings().deviceToken); }
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
    const response = await requestUrl({ url: this.url(`/v1/blobs/${hash}`), method: "GET", headers: { ...this.clientHeaders(),Authorization:`Bearer ${this.settings().deviceToken}` }, throw: false });
    if (response.status !== 200) throw new ApiError(`Blob download failed (${response.status})`, response.status, null);
    return new Uint8Array(response.arrayBuffer);
  }
  async getContent(hash:string,expectedSize?:number):Promise<Uint8Array>{
    // requestUrl eagerly exposes text/json alongside the ArrayBuffer. That is
    // convenient for API responses but can exhaust a mobile WebView when the
    // vault contains large audio, PDF, or model files. Fetch keeps one binary
    // response body alive through the write instead.
    const response=await fetch(this.url(`/v1/content/${hash}`),{method:"GET",headers:{...this.clientHeaders(),Authorization:`Bearer ${this.settings().deviceToken}`},cache:"no-store"});
    if(!response.ok)throw new ApiError(`Large-file download failed (${response.status})`,response.status,null);
    if(response.headers.get("x-content-sha256")!==hash)throw new Error("Large-file integrity header is missing or invalid");
    if(!response.body||expectedSize===undefined)return new Uint8Array(await response.arrayBuffer());
    const bytes=new Uint8Array(expectedSize),reader=response.body.getReader();let offset=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;if(offset+value.byteLength>bytes.byteLength)throw new Error("Large-file response exceeded its declared size");bytes.set(value,offset);offset+=value.byteLength;}}
    finally{reader.releaseLock();}
    if(offset!==bytes.byteLength)throw new Error(`Large-file response ended early (${offset} of ${bytes.byteLength} bytes)`);
    return bytes;
  }
  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    const body = bytes.slice().buffer;
    const response = await requestUrl({ url: this.url(`/v1/blobs/${hash}`), method: "PUT", headers: { ...this.clientHeaders(),Authorization:`Bearer ${this.settings().deviceToken}`,"Content-Type":"application/octet-stream" }, body, throw: false });
    if (response.status < 200 || response.status >= 300) throw new ApiError(`Blob upload failed (${response.status})`, response.status, response.text);
  }
  async putMirrorFile(snapshotId:string,path:string,hash:string,bytes:Uint8Array):Promise<void>{
    const response=await requestUrl({url:this.url(`/v1/mirror/file?path=${encodeURIComponent(path)}`),method:"PUT",headers:{...this.clientHeaders(),Authorization:`Bearer ${this.settings().deviceToken}`,"Content-Type":"application/octet-stream","X-Gib-Sync-Snapshot":snapshotId,"X-Gib-Sync-Hash":hash},body:bytes.slice().buffer,throw:false});
    if(response.status<200||response.status>=300)throw new ApiError(`Readable mirror upload failed for ${path} (${response.status})`,response.status,response.json??response.text);
  }
}
