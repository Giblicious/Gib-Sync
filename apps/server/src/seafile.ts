import type { SeafileLibrary, StorageLocation } from "@gib-sync/protocol";
import type { Config } from "./config.js";
import { allowedSeafileHosts } from "./config.js";
import { openJson, sealJson } from "./security.js";

type Repo = { id?: string; repo_id?: string; name: string };
type SeafileDirEntry={type:string;parent_dir:string;id:string;name:string;mtime:number;size?:number};
export interface ReadableStorageEntry{path:string;id:string;mtime:number;size:number;}

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
    return fetch(new URL(path, `${credentials.url}/`), { ...init, headers });
  }

  async authenticate(urlValue: string, usernameValue: string, password: string): Promise<StorageCredentials> {
    return this.authenticateAt(this.validateUrl(urlValue),usernameValue,password);
  }

  private async authenticateAt(url: string, usernameValue: string, password: string): Promise<StorageCredentials> {
    const username = usernameValue.trim().toLowerCase();
    if (!username || !password) throw new Error("Seafile username and password are required");
    const response = await fetch(new URL("/api2/auth-token/", `${url}/`), { method: "POST", body: new URLSearchParams({ username: usernameValue.trim(), password }) });
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

  async putReadable(row:VaultStorageRow,relativePath:string,bytes:Uint8Array):Promise<void>{
    const safe=safeRelativePath(relativePath);await this.putAt(row,`${this.readableRoot(row)}/${safe}`||`/${safe}`,bytes);
  }

  async deleteReadable(row:VaultStorageRow,relativePath:string):Promise<void>{
    const safe=safeRelativePath(relativePath);const path=`${this.readableRoot(row)}/${safe}`||`/${safe}`;
    const response=await this.request(this.credentials(row),`/api2/repos/${row.storage_repo_id}/file/?p=${encodeURIComponent(path)}`,{method:"DELETE"});
    if(!response.ok&&response.status!==404)throw new Error(`Seafile delete ${path} failed (${response.status}: ${await response.text()})`);
  }

  async get(row: VaultStorageRow, relativePath: string): Promise<Uint8Array> {
    const path = `${this.root(row)}/${relativePath.replace(/^\/+/, "")}`; const credentials = this.credentials(row);
    const link = await this.request(credentials, `/api2/repos/${row.storage_repo_id}/file/?p=${encodeURIComponent(path)}`);
    if (!link.ok) throw new Error(`Seafile file link failed (${link.status})`);
    const response = await this.request(credentials, await link.json() as string);
    if (!response.ok) throw new Error(`Seafile download failed (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async getReadable(row:VaultStorageRow,relativePath:string):Promise<Uint8Array>{
    const safe=safeRelativePath(relativePath);const path=`${this.readableRoot(row)}/${safe}`||`/${safe}`;const credentials=this.credentials(row);
    const link=await this.request(credentials,`/api2/repos/${row.storage_repo_id}/file/?p=${encodeURIComponent(path)}`);
    if(!link.ok)throw new Error(`Seafile readable file link failed (${link.status})`);
    const response=await this.request(credentials,await link.json() as string);
    if(!response.ok)throw new Error(`Seafile readable download failed (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async listReadable(row:VaultStorageRow):Promise<ReadableStorageEntry[]>{
    const root=this.readableRoot(row)||"/",credentials=this.credentials(row);
    const response=await this.request(credentials,`/api2/repos/${row.storage_repo_id}/dir/?p=${encodeURIComponent(root)}&recursive=1`);
    if(response.status===404)return [];
    if(!response.ok)throw new Error(`Seafile readable listing failed (${response.status})`);
    const body=await response.json() as SeafileDirEntry[]|"uptodate";
    if(!Array.isArray(body))throw new Error("Seafile returned an unexpected readable listing");
    const normalizedRoot=root==="/"?"/":`${root.replace(/\/+$/,"")}/`;
    const output:ReadableStorageEntry[]=[];
    for(const entry of body){
      if(entry.type!=="file")continue;
      const full=`${entry.parent_dir.replace(/\/+$/,"")}/${entry.name}`.replace(/\/+/g,"/");
      const path=normalizedRoot==="/"?full.replace(/^\/+/,""):full.startsWith(normalizedRoot)?full.slice(normalizedRoot.length):"";
      if(!path)continue;
      try{output.push({path:safeRelativePath(path),id:entry.id,mtime:entry.mtime,size:entry.size??0});}catch{}
    }
    return output.sort((left,right)=>left.path.localeCompare(right.path));
  }
}
