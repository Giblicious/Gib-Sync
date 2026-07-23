import { requestUrl } from "obsidian";
import type { CommitRequest, HistoryItem, ManifestEntry, MirrorCompleteResponse, MirrorPlanResponse, ServerStatus, SetupResponse, Snapshot, StorageDiscovery, StorageSetupRequest, SyncState } from "@gib-sync/protocol";
import type { GibSyncSettings } from "./settings";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly responseBody: unknown) { super(message); }
}

export class GibSyncApi {
  constructor(private readonly settings: () => GibSyncSettings) {}
  private url(path: string, override?: string) { return `${(override ?? this.settings().serverUrl).replace(/\/$/, "")}${path}`; }
  private async json<T>(method: string, path: string, body?: unknown, token?: string, server?: string): Promise<T> {
    const response = await requestUrl({
      url: this.url(path, server), method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), throw: false
    });
    if (response.status < 200 || response.status >= 300) throw new ApiError(response.json?.error ?? `Gib Sync request failed (${response.status})`, response.status, response.json);
    return response.json as T;
  }
  discover(server:string,seafileUrl:string,seafileUsername:string,seafilePassword:string) { return this.json<StorageDiscovery>("POST","/v1/storage/discover",{seafileUrl,seafileUsername,seafilePassword},undefined,server); }
  setup(server: string, body: StorageSetupRequest) { return this.json<SetupResponse>("POST", "/v1/setup", body, undefined, server); }
  state() { return this.json<SyncState>("GET", "/v1/state", undefined, this.settings().deviceToken); }
  status() { return this.json<ServerStatus>("GET", "/v1/status", undefined, this.settings().deviceToken); }
  snapshot(id: string) { return this.json<Snapshot>("GET", `/v1/snapshots/${id}`, undefined, this.settings().deviceToken); }
  history() { return this.json<HistoryItem[]>("GET", "/v1/history?limit=100", undefined, this.settings().deviceToken); }
  commit(body: CommitRequest) { return this.json<Snapshot>("POST", "/v1/commit", body, this.settings().deviceToken); }
  restore(id: string) { return this.json<Snapshot>("POST", `/v1/restore/${id}`, {}, this.settings().deviceToken); }
  mirrorPlan(snapshotId:string,entries:ManifestEntry[]){return this.json<MirrorPlanResponse>("POST","/v1/mirror/plan",{snapshotId,entries},this.settings().deviceToken);}
  mirrorComplete(snapshotId:string){return this.json<MirrorCompleteResponse>("POST","/v1/mirror/complete",{snapshotId},this.settings().deviceToken);}
  createPairing() { return this.json<{uri:string;expiresAt:string}>("POST", "/v1/pairings", {}, this.settings().deviceToken); }
  claimPairing(server: string, id: string, secret: string, deviceName: string) { return this.json<{envelope:string}>("POST", `/v1/pairings/${id}/claim`, { secret, deviceName }, undefined, server); }
  async getBlob(hash: string): Promise<Uint8Array> {
    const response = await requestUrl({ url: this.url(`/v1/blobs/${hash}`), method: "GET", headers: { Authorization: `Bearer ${this.settings().deviceToken}` }, throw: false });
    if (response.status !== 200) throw new ApiError(`Blob download failed (${response.status})`, response.status, null);
    return new Uint8Array(response.arrayBuffer);
  }
  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    const body = bytes.slice().buffer;
    const response = await requestUrl({ url: this.url(`/v1/blobs/${hash}`), method: "PUT", headers: { Authorization: `Bearer ${this.settings().deviceToken}`, "Content-Type": "application/octet-stream" }, body, throw: false });
    if (response.status < 200 || response.status >= 300) throw new ApiError(`Blob upload failed (${response.status})`, response.status, response.text);
  }
  async putMirrorFile(snapshotId:string,path:string,hash:string,bytes:Uint8Array):Promise<void>{
    const response=await requestUrl({url:this.url(`/v1/mirror/file?path=${encodeURIComponent(path)}`),method:"PUT",headers:{Authorization:`Bearer ${this.settings().deviceToken}`,"Content-Type":"application/octet-stream","X-Gib-Sync-Snapshot":snapshotId,"X-Gib-Sync-Hash":hash},body:bytes.slice().buffer,throw:false});
    if(response.status<200||response.status>=300)throw new ApiError(`Readable mirror upload failed for ${path} (${response.status})`,response.status,response.json??response.text);
  }
}
