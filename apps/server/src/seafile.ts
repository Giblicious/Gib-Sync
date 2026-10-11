import type { SeafileLibrary, StorageLocation } from "@gib-sync/protocol";
import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import type { Config } from "./config.js";
import { allowedSeafileHosts } from "./config.js";
import { openJson, sealJson } from "./security.js";

type Repo = { id?: string; repo_id?: string; name: string };
type SeafileDirEntry={type:string;parent_dir:string;id:string;name:string;mtime:number;size?:number};
export interface ReadableStorageEntry{path:string;id:string;mtime:number;size:number;}
export interface ReadableStorageTree{files:ReadableStorageEntry[];folders:string[];}
export interface ReadableRevision{commitId:string;size:number;mtime:number;}
export class RevisionMissingError extends Error{constructor(){super("File does not exist in this immutable Seafile revision");this.name="RevisionMissingError";}}

export interface VaultStorageRow {
  id: string;
  storage_url: string;
  storage_username: string;
  storage_repo_id: string;
  storage_repo_name: string;
  storage_base_path: string;
  storage_token: string;
  storage_layout: string;
  mirror_base_path: string;
  mirror_head_id: string | null;
}

export interface StorageCredentials {
  url: string;
  username: string;
  token: string;
}

export interface StorageSelection extends StorageCredentials {
  libraryId: string;
  libraryName: string;
  basePath: string;
}

export function normalizeBasePath(value: string): string {
  const parts = value.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw new Error("Storage folder cannot contain . or .. segments");
  return parts.length ? `/${parts.join("/")}` : "/";
}

export function safeRelativePath(value:string):string {
  if(!value||value.includes("\\")||value.startsWith("/"))throw new Error("Invalid vault-relative path");
  const parts=value.split("/");if(parts.some((part)=>!part||part==="."||part==="..")||parts[0]===".gib-sync")throw new Error("Invalid vault-relative path");
  return parts.join("/");
}

export class SeafileStorage {
  private readonly knownDirectories = new Set<string>();
  constructor(private readonly config: Config) {}

  validateUrl(value: string): string {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && !url.hostname.endsWith(".test")) throw new Error("Seafile must use HTTPS");
    if (url.username || url.password || url.search || url.hash) throw new Error("Invalid Seafile server address");
    if (!allowedSeafileHosts(this.config).has(url.host.toLowerCase())) throw new Error("This Seafile host is not allowed by the Gib Sync server");
    return url.toString().replace(/\/$/, "");
  }

  private async request(credentials: StorageCredentials, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers); headers.set("Authorization", `Token ${credentials.token}`);
    return fetch(new URL(path, `${credentials.url}/`), { ...init, headers,signal:init.signal??AbortSignal.timeout(120_000) });
  }
  private async readBounded(response:Response,maximumBytes:number):Promise<Uint8Array>{
    const header=response.headers.get("content-length"),declared=header===null?null:Number(header);
    if(declared!==null&&(!Number.isSafeInteger(declared)||declared<0||declared>maximumBytes)){await response.body?.cancel();throw new Error("Seafile content exceeds its permitted byte limit");}
    if(!response.body)throw new Error("Seafile returned no content stream");
    const reader=response.body.getReader(),exact=declared===null?null:new Uint8Array(declared),chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;if(size+value.byteLength>maximumBytes||exact&&size+value.byteLength>exact.length)throw new Error("Seafile content exceeded its declared byte limit");if(exact)exact.set(value,size);else chunks.push(value);size+=value.byteLength;}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    if(exact){if(size!==exact.length)throw new Error("Seafile content stream ended before its declared size");return exact;}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
  }

  async authenticate(urlValue: string, usernameValue: string, password: string): Promise<StorageCredentials> {
    return this.authenticateAt(this.validateUrl(urlValue),usernameValue,password);
  }

  private async authenticateAt(url: string, usernameValue: string, password: string): Promise<StorageCredentials> {
    const username = usernameValue.trim().toLowerCase();
    if (!username || !password) throw new Error("Seafile username and password are required");
    const response = await fetch(new URL("/api2/auth-token/", `${url}/`), { method: "POST", body: new URLSearchParams({ username: usernameValue.trim(), password }),signal:AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Seafile authentication failed (${response.status})`);
    const token = (await response.json() as {token?:string}).token;
    if (!token) throw new Error("Seafile did not return an API token");
    return { url, username, token };
  }

  async libraries(credentials: StorageCredentials): Promise<SeafileLibrary[]> {
    const response = await this.request(credentials, "/api2/repos/");
    if (!response.ok) throw new Error(`Unable to list Seafile libraries (${response.status})`);
    return (await response.json() as Repo[]).map((repo) => ({ id: repo.id ?? repo.repo_id ?? "", name: repo.name })).filter((repo) => repo.id).sort((a,b) => a.name.localeCompare(b.name));
  }

  async legacySelection(): Promise<StorageSelection> {
    const credentials = await this.authenticateAt(this.config.SEAFILE_URL.replace(/\/$/,""), this.config.SEAFILE_USERNAME, this.config.SEAFILE_PASSWORD);
    const libraries = await this.libraries(credentials);
    const library = libraries.find((item) => item.name === this.config.SEAFILE_LIBRARY);
    if (!library) throw new Error(`Legacy Seafile library ${this.config.SEAFILE_LIBRARY} was not found`);
    return { ...credentials, libraryId: library.id, libraryName: library.name, basePath: "/" };
  }

  sealToken(vaultId: string, token: string): string { return sealJson(token, this.config.GIBSYNC_SERVER_SECRET, `storage:${vaultId}`); }
  openToken(row: VaultStorageRow): string { return openJson<string>(row.storage_token, this.config.GIBSYNC_SERVER_SECRET, `storage:${row.id}`); }

  location(row: VaultStorageRow): StorageLocation {
    const seafileUrl=this.equivalentServer(row.storage_url,this.config.SEAFILE_URL)&&this.config.SEAFILE_PUBLIC_URL?this.config.SEAFILE_PUBLIC_URL:row.storage_url;
    return { seafileUrl, username: row.storage_username, libraryId: row.storage_repo_id, libraryName: row.storage_repo_name, basePath: row.storage_base_path, readablePath:row.mirror_base_path };
  }

  equivalentServer(first:string,second:string):boolean {
    const normalize=(value:string)=>value.replace(/\/$/,"").toLowerCase();if(normalize(first)===normalize(second))return true;
    const pair=new Set([normalize(this.config.SEAFILE_URL),...(this.config.SEAFILE_PUBLIC_URL?[normalize(this.config.SEAFILE_PUBLIC_URL)]:[])]);
    return pair.has(normalize(first))&&pair.has(normalize(second));
  }

  private credentials(row: VaultStorageRow): StorageCredentials { return { url: row.storage_url, username: row.storage_username, token: this.openToken(row) }; }
  private root(row: VaultStorageRow): string {
    if (row.storage_layout === "legacy") return `/vaults/${row.id}`;
    return `${row.storage_base_path === "/" ? "" : row.storage_base_path}/.gib-sync` || "/.gib-sync";
  }
  private readableRoot(row:VaultStorageRow):string { return row.mirror_base_path==="/"?"":row.mirror_base_path; }

  private async mkdir(row: VaultStorageRow, path: string): Promise<void> {
    const key=`${row.storage_url}|${row.storage_repo_id}|${path}`;if(this.knownDirectories.has(key))return;
    const existing=await this.request(this.credentials(row),`/api2/repos/${row.storage_repo_id}/dir/?p=${encodeURIComponent(path)}`);
    if(existing.ok){this.knownDirectories.add(key);return;}
    if(existing.status!==404)throw new Error(`Seafile directory check ${path} failed (${existing.status})`);
    const response = await this.request(this.credentials(row), `/api2/repos/${row.storage_repo_id}/dir/?p=${encodeURIComponent(path)}`, { method: "POST", body: new URLSearchParams({ operation: "mkdir" }) });
    if(!response.ok){const raced=await this.request(this.credentials(row),`/api2/repos/${row.storage_repo_id}/dir/?p=${encodeURIComponent(path)}`);if(!raced.ok)throw new Error(`Seafile mkdir ${path} failed (${response.status})`);}
    this.knownDirectories.add(key);
  }

  private async ensureDirectory(row:VaultStorageRow,path:string):Promise<void>{
    const parts=path.split("/").filter(Boolean);let current="";
    for (const part of parts) { current += `/${part}`; await this.mkdir(row, current); }
  }

  private async ensureParents(row: VaultStorageRow, path: string): Promise<void> { await this.ensureDirectory(row,path.slice(0,path.lastIndexOf("/"))||"/"); }

  async initVault(row: VaultStorageRow): Promise<void> { await this.ensureDirectory(row,this.root(row)); }

  private async putAt(row:VaultStorageRow,path:string,bytes:Uint8Array,contentType="application/octet-stream"):Promise<void>{
    await this.ensureParents(row, path);
    const parent = path.slice(0, path.lastIndexOf("/")) || "/"; const name = path.slice(path.lastIndexOf("/") + 1); const credentials = this.credentials(row);
    const linkResponse = await this.request(credentials, `/api2/repos/${row.storage_repo_id}/upload-link/?p=${encodeURIComponent(parent)}`);
    if (!linkResponse.ok) throw new Error(`Seafile upload link failed (${linkResponse.status})`);
    const uploadUrl = await linkResponse.json() as string; const form = new FormData();
    const exactBytes=Uint8Array.from(bytes);
    form.set("parent_dir", parent); form.set("replace", "1"); form.set("file", new Blob([exactBytes.buffer], { type: contentType }), name);
    const response = await this.request(credentials, uploadUrl, { method: "POST", body: form });
    if (!response.ok) throw new Error(`Seafile upload ${path} failed (${response.status}: ${await response.text()})`);
  }

  async put(row: VaultStorageRow, relativePath: string, bytes: Uint8Array, contentType = "application/octet-stream"): Promise<void> {
    await this.putAt(row,`${this.root(row)}/${relativePath.replace(/^\/+/, "")}`,bytes,contentType);
  }

  async putFile(row: VaultStorageRow, relativePath: string, localPath: string, signal?: AbortSignal, progress?: (stage: "uploading" | "checking", processedBytes: number) => void): Promise<void> {
    const path = `${this.root(row)}/${safeRelativePath(relativePath)}`;
    const file = await openAsBlob(localPath, { type: "application/octet-stream" });
    await this.ensureParents(row, path);
    const parent = path.slice(0, path.lastIndexOf("/")) || "/", name = path.slice(path.lastIndexOf("/") + 1), credentials = this.credentials(row);
    // Completion is polled asynchronously. Give genuinely large files a finite
    // size-dependent backend budget rather than retrying every two minutes.
    // The bound allows both upload and read-back at ~256 KiB/s, capped at 2h;
    // caller pause/shutdown can still cancel it immediately.
    const budget = Math.max(120_000, Math.min(2 * 60 * 60_000, Math.ceil(file.size / (256 * 1024)) * 2000 + 60_000));
    const transferSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(budget)]) : AbortSignal.timeout(budget);
    const linkResponse = await this.request(credentials, `/api2/repos/${row.storage_repo_id}/upload-link/?p=${encodeURIComponent(parent)}`, { signal: transferSignal });
    if (!linkResponse.ok) throw new Error(`Seafile upload link failed (${linkResponse.status})`);
    const uploadUrl = await linkResponse.json() as string, form = new FormData();
    // File-backed Blob streams immutable encrypted staging, so large files do
    // not allocate a second whole-file Uint8Array/Blob in the server process.
    form.set("parent_dir", parent); form.set("replace", "1"); form.set("file", file, name);
    progress?.("uploading", 0);
    const response = await this.request(credentials, uploadUrl, { method: "POST", body: form, signal: transferSignal });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Seafile staged upload failed (${response.status})`); }
    await response.body?.cancel();
    const expected = createHash("sha256");
    for await (const chunk of createReadStream(localPath, { highWaterMark: 64 * 1024 })) { transferSignal.throwIfAborted(); expected.update(chunk); }
    const link = await this.request(credentials, `/api2/repos/${row.storage_repo_id}/file/?p=${encodeURIComponent(path)}`, { signal: transferSignal });
    if (!link.ok) throw new Error(`Seafile staged verification link failed (${link.status})`);
    const verified = await this.request(credentials, await link.json() as string, { signal: transferSignal });
    if (!verified.ok || !verified.body) { await verified.body?.cancel(); throw new Error(`Seafile staged verification failed (${verified.status})`); }
    const declared = verified.headers.get("content-length");
    if (declared !== null && Number(declared) !== file.size) { await verified.body.cancel(); throw new Error("Seafile staged upload has an unexpected byte size"); }
    const reader = verified.body.getReader(), actual = createHash("sha256"); let bytes = 0;
    progress?.("checking", 0);
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > file.size) throw new Error("Seafile staged upload exceeded its verified byte size"); actual.update(part.value); progress?.("checking", bytes); }
      if (bytes !== file.size || actual.digest("hex") !== expected.digest("hex")) throw new Error("Seafile staged upload failed its durable integrity verification; retry safely");
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }

  async putReadable(row:VaultStorageRow,relativePath:string,bytes:Uint8Array):Promise<void>{
    const safe=safeRelativePath(relativePath);await this.putAt(row,`${this.readableRoot(row)}/${safe}`||`/${safe}`,bytes);
  }

  async ensureReadableFolder(row:VaultStorageRow,relativePath:string):Promise<void>{
    const safe=safeRelativePath(relativePath);await this.ensureDirectory(row,`${this.readableRoot(row)}/${safe}`||`/${safe}`);
  }

  async deleteReadable(row:VaultStorageRow,relativePath:string):Promise<void>{
    const safe=safeRelativePath(relativePath);const path=`${this.readableRoot(row)}/${safe}`||`/${safe}`;
    const response=await this.request(this.credentials(row),`/api2/repos/${row.storage_repo_id}/file/?p=${encodeURIComponent(path)}`,{method:"DELETE"});
    if(!response.ok&&response.status!==404)throw new Error(`Seafile delete ${path} failed (${response.status}: ${await response.text()})`);
  }

  async deleteReadableFolder(row:VaultStorageRow,relativePath:string):Promise<boolean>{
    const safe=safeRelativePath(relativePath),path=`${this.readableRoot(row)}/${safe}`||`/${safe}`,credentials=this.credentials(row);
    for(let check=0;check<2;check++){
      const listing=await this.request(credentials,`/api2/repos/${row.storage_repo_id}/dir/?p=${encodeURIComponent(path)}`);
      if(listing.status===404)return true;if(!listing.ok)throw new Error(`Seafile directory check ${path} failed (${listing.status})`);
      const body=await listing.json() as SeafileDirEntry[]|"uptodate";if(!Array.isArray(body)||body.length)return false;
    }
    const response=await this.request(credentials,`/api2/repos/${row.storage_repo_id}/dir/?p=${encodeURIComponent(path)}`,{method:"DELETE"});
    if(response.status===404)return true;
    if(!response.ok){const stillThere=await this.request(credentials,`/api2/repos/${row.storage_repo_id}/dir/?p=${encodeURIComponent(path)}`);if(stillThere.status===404)return true;if(response.status===400||response.status===409)return false;throw new Error(`Seafile delete folder ${path} failed (${response.status}: ${await response.text()})`);}
    this.knownDirectories.delete(`${row.storage_url}|${row.storage_repo_id}|${path}`);return true;
  }

  async get(row: VaultStorageRow, relativePath: string): Promise<Uint8Array> {
    const path = `${this.root(row)}/${relativePath.replace(/^\/+/, "")}`; const credentials = this.credentials(row);
    const link = await this.request(credentials, `/api2/repos/${row.storage_repo_id}/file/?p=${encodeURIComponent(path)}`);
    if (!link.ok) throw new Error(`Seafile file link failed (${link.status})`);
    const response = await this.request(credentials, await link.json() as string);
    if (!response.ok) throw new Error(`Seafile download failed (${response.status})`);
    return this.readBounded(response,path.endsWith(".gbs")?this.config.MAX_BLOB_BYTES+1024:64*1024*1024);
  }

  async getReadable(row:VaultStorageRow,relativePath:string):Promise<Uint8Array>{
    const safe=safeRelativePath(relativePath);const path=`${this.readableRoot(row)}/${safe}`||`/${safe}`;const credentials=this.credentials(row);
    const link=await this.request(credentials,`/api2/repos/${row.storage_repo_id}/file/?p=${encodeURIComponent(path)}`);
    if(!link.ok)throw new Error(`Seafile readable file link failed (${link.status})`);
    const response=await this.request(credentials,await link.json() as string);
    if(!response.ok)throw new Error(`Seafile readable download failed (${response.status})`);
    return this.readBounded(response,this.config.MAX_BLOB_BYTES);
  }
  async statReadable(row:VaultStorageRow,relativePath:string):Promise<ReadableStorageEntry|null>{
    const safe=safeRelativePath(relativePath),path=`${this.readableRoot(row)}/${safe}`||`/${safe}`;
    const response=await this.request(this.credentials(row),`/api2/repos/${row.storage_repo_id}/file/detail/?p=${encodeURIComponent(path)}`);
    if(response.status===404)return null;if(!response.ok)throw new Error(`Seafile readable metadata failed (${response.status})`);
    const item=await response.json() as {id:string;mtime:number;size:number};
    return {path:safe,id:item.id,mtime:item.mtime,size:item.size};
  }
  async readableHistory(row:VaultStorageRow,relativePath:string):Promise<ReadableRevision[]>{
    const safe=safeRelativePath(relativePath),path=`${this.readableRoot(row)}/${safe}`||`/${safe}`;
    const response=await this.request(this.credentials(row),`/api/v2.1/repos/${row.storage_repo_id}/file/history/?path=${encodeURIComponent(path)}`);
    if(response.status===404)return [];
    if(!response.ok)throw new Error(`Seafile revision history is unavailable (${response.status}); readable mutation deferred`);
    const body=await response.json() as any,items=Array.isArray(body)?body:body.data??body.histories??body.history;
    if(!Array.isArray(items))throw new Error("Seafile returned an invalid revision history; readable mutation deferred");
    return items.map((item:any)=>({commitId:String(item.commit_id??item.id??""),size:Number(item.rev_file_size??item.size??0),mtime:typeof item.ctime==="string"?Date.parse(item.ctime):Number(item.ctime??item.mtime??0)*1000})).filter((item:ReadableRevision)=>/^[a-f0-9]{40}$/i.test(item.commitId));
  }
  async repoHistory(row:VaultStorageRow,until?:string|null):Promise<ReadableRevision[]>{
    const results:ReadableRevision[]=[];
    for(let page=1;page<=100;page++){
      const response=await this.request(this.credentials(row),`/api/v2.1/repos/${row.storage_repo_id}/history/?page=${page}&per_page=100`);
      if(!response.ok)throw new Error(`Seafile immutable history is unavailable (${response.status}); readable mutation deferred`);
      const body=await response.json() as {data?:Array<{commit_id:string;time?:string;ctime?:number|string}>;more?:boolean};
      if(!Array.isArray(body.data))throw new Error("Seafile returned invalid immutable repository history");
      for(const item of body.data){if(!/^[a-f0-9]{40}$/i.test(item.commit_id))throw new Error("Seafile returned an invalid repository revision");if(item.commit_id===until)return results;const timestamp=item.time??item.ctime,mtime=typeof timestamp==="string"?Date.parse(timestamp):Number(timestamp)*1000;if(!Number.isFinite(mtime)||mtime<0)throw new Error("Seafile returned an invalid repository revision timestamp");results.push({commitId:item.commit_id,size:0,mtime:Math.min(mtime,Date.now()+5*60_000)});if(!until)return results;}
      if(!body.more){if(until)throw new Error("Seafile immutable history has a retention gap; projection remains unverified");return results;}
    }
    throw new Error("Seafile immutable history traversal exceeded its safety budget; projection remains unverified");
  }
  private readonly historyChecked=new Map<string,number>();
  async assertHistoryAvailable(row:VaultStorageRow):Promise<void>{
    const cacheKey=`${row.storage_url}:${row.storage_repo_id}`,checked=this.historyChecked.get(cacheKey)??0;if(checked>Date.now()-30_000)return;
    const response=await this.request(this.credentials(row),`/api2/repos/${row.storage_repo_id}/history-limit/`);
    if(!response.ok)throw new Error(`Seafile history retention cannot be verified (${response.status}); readable mutation deferred`);
    const body=await response.json() as {keep_days?:number};if(!Number.isInteger(body.keep_days)||body.keep_days===0||body.keep_days!< -1)throw new Error("Seafile immutable history is disabled or invalid; readable mutation deferred");this.historyChecked.set(cacheKey,Date.now());
  }
  async readableRevisionTree(row:VaultStorageRow,relativePath:string,commitId:string):Promise<ReadableStorageTree>{
    const root=`${this.readableRoot(row)}/${safeRelativePath(relativePath)}`||`/${relativePath}`,pending=[root],files:ReadableStorageEntry[]=[],folders:string[]=[],readablePrefix=`${this.readableRoot(row)}/`;
    while(pending.length){
      const parent=pending.shift()!,response=await this.request(this.credentials(row),`/api/v2.1/repos/${row.storage_repo_id}/commits/${commitId}/dir/?path=${encodeURIComponent(parent)}`);
      if(response.status===404)continue;if(!response.ok)throw new Error(`Seafile historical directory listing failed (${response.status}); folder mutation remains unverified`);
      const body=await response.json() as {dirent_list?:Array<{type:string;name:string;obj_id:string;size:number;mtime?:number}>};
      if(!Array.isArray(body.dirent_list))throw new Error("Seafile returned an invalid historical directory listing");
      if(parent===root)folders.push(safeRelativePath(relativePath));
      for(const entry of body.dirent_list){const full=`${parent.replace(/\/+$/,"")}/${entry.name}`,path=safeRelativePath(full.slice(readablePrefix.length));if(entry.type==="dir"){folders.push(path);pending.push(full);}else if(entry.type==="file")files.push({path,id:entry.obj_id,size:entry.size,mtime:entry.mtime??0});}
      if(files.length+folders.length>200_000)throw new Error("Historical folder traversal exceeded its safety budget");
    }
    return {files,folders};
  }
  async readableRenames(row:VaultStorageRow,baseline:string):Promise<Array<{previousPath:string;path:string}>>{
    const history=await this.repoHistory(row,baseline),prefix=`${this.readableRoot(row)}/`,renames:Array<{previousPath:string;path:string}>=[];
    for(const revision of history.reverse()){
      const response=await this.request(this.credentials(row),`/api/v2.1/repos/${row.storage_repo_id}/commits/${revision.commitId}/`);
      if(!response.ok)throw new Error(`Seafile commit provenance failed (${response.status})`);
      const body=await response.json() as {commit_diffs?:Array<{op_type:string;path:string;new_path:string}>};if(!Array.isArray(body.commit_diffs))throw new Error("Seafile returned invalid commit provenance");
      for(const entry of body.commit_diffs)if(entry.op_type==="renamed"&&entry.path.startsWith(prefix)&&entry.new_path.startsWith(prefix))renames.push({previousPath:safeRelativePath(entry.path.slice(prefix.length)),path:safeRelativePath(entry.new_path.slice(prefix.length))});
    }
    return renames;
  }
  async getReadableRevision(row:VaultStorageRow,relativePath:string,commitId:string):Promise<Uint8Array>{
    if(!/^[a-f0-9]{40}$/i.test(commitId))throw new Error("Invalid Seafile revision identifier");
    const safe=safeRelativePath(relativePath),path=`${this.readableRoot(row)}/${safe}`||`/${safe}`,credentials=this.credentials(row);
    const link=await this.request(credentials,`/api2/repos/${row.storage_repo_id}/file/revision/?p=${encodeURIComponent(path)}&commit_id=${commitId}`);
    if(link.status===404)throw new RevisionMissingError();
    if(!link.ok)throw new Error(`Seafile revision link failed (${link.status})`);
    const response=await this.request(credentials,await link.json() as string);
    if(!response.ok)throw new Error(`Seafile revision download failed (${response.status})`);
    return this.readBounded(response,this.config.MAX_BLOB_BYTES);
  }

  async getSidecarRevision(row:VaultStorageRow,relativePath:string,commitId:string):Promise<Uint8Array>{
    if(!/^[a-f0-9]{40}$/i.test(commitId))throw new Error("Invalid Seafile revision identifier");
    const path=`${this.root(row)}/${safeRelativePath(relativePath)}`,credentials=this.credentials(row);
    const link=await this.request(credentials,`/api2/repos/${row.storage_repo_id}/file/revision/?p=${encodeURIComponent(path)}&commit_id=${commitId}`);
    if(link.status===404)throw new RevisionMissingError();
    if(!link.ok)throw new Error(`Seafile sidecar revision link failed (${link.status})`);
    const response=await this.request(credentials,await link.json() as string);
    if(!response.ok)throw new Error(`Seafile sidecar revision download failed (${response.status})`);
    return this.readBounded(response,4096);
  }

  async listReadableTree(row:VaultStorageRow):Promise<ReadableStorageTree>{
    const root=this.readableRoot(row)||"/",credentials=this.credentials(row);
    const response=await this.request(credentials,`/api2/repos/${row.storage_repo_id}/dir/?p=${encodeURIComponent(root)}&recursive=1`);
    if(response.status===404)return {files:[],folders:[]};
    if(!response.ok)throw new Error(`Seafile readable listing failed (${response.status})`);
    const body=await response.json() as SeafileDirEntry[]|"uptodate";
    if(!Array.isArray(body))throw new Error("Seafile returned an unexpected readable listing");
    const normalizedRoot=root==="/"?"/":`${root.replace(/\/+$/,"")}/`;
    const files:ReadableStorageEntry[]=[],folders:string[]=[];
    for(const entry of body){
      const full=`${entry.parent_dir.replace(/\/+$/,"")}/${entry.name}`.replace(/\/+/g,"/");
      const path=normalizedRoot==="/"?full.replace(/^\/+/,""):full.startsWith(normalizedRoot)?full.slice(normalizedRoot.length):"";
      if(!path)continue;
      try{const safe=safeRelativePath(path);if(entry.type==="file")files.push({path:safe,id:entry.id,mtime:entry.mtime,size:entry.size??0});else if(entry.type==="dir")folders.push(safe);}catch{}
    }
    return {files:files.sort((left,right)=>left.path.localeCompare(right.path)),folders:[...new Set(folders)].sort()};
  }

  async listReadable(row:VaultStorageRow):Promise<ReadableStorageEntry[]>{return (await this.listReadableTree(row)).files;}
}
