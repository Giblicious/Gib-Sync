import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { buildApp } from "./app.js";
import type { SeafileStorage } from "./seafile.js";
import { sealJson } from "./security.js";

class MemoryStorage {
  files = new Map<string, Uint8Array>();
  async authenticate(url:string,username:string) { return {url:url.replace(/\/$/,""),username:username.toLowerCase(),token:`token:${username}`}; }
  async libraries() { return [{id:"library-1",name:"Notes"}]; }
  sealToken(_vaultId:string,token:string){return token;}
  location(row:any){return {seafileUrl:row.storage_url,username:row.storage_username,libraryId:row.storage_repo_id,libraryName:row.storage_repo_name,basePath:row.storage_base_path};}
  equivalentServer(first:string,second:string){return first.replace(/\/$/,"")===second.replace(/\/$/,"");}
  async initVault() {}
  async legacySelection(){return {url:"https://seafile.example.test",username:"legacy@example.test",token:"legacy",libraryId:"library-1",libraryName:"Notes",basePath:"/"};}
  async put(row:any,path:string,bytes:Uint8Array) { this.files.set(`${row.id}:${path}`, bytes.slice()); }
  async get(row:any,path:string) { const bytes = this.files.get(`${row.id}:${path}`); if (!bytes) throw new Error("missing"); return bytes.slice(); }
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gib-sync-")); roots.push(root);
  const config: Config = {
    HOST:"127.0.0.1", PORT:8787, PUBLIC_URL:"https://sync.example.test", DATA_DIR:root,
    GIBSYNC_SETUP_TOKEN:"setup-token-that-is-at-least-24-characters", GIBSYNC_SERVER_SECRET:"server-secret-that-is-at-least-thirty-two-characters",
    SEAFILE_URL:"https://seafile.example.test", SEAFILE_PUBLIC_URL:"https://seafile.example.test", SEAFILE_USERNAME:"test@example.test", SEAFILE_PASSWORD:"password", SEAFILE_LIBRARY:"Gib Sync", SEAFILE_ALLOWED_HOSTS:"seafile.example.test", PAIRING_TTL_SECONDS:300, MAX_BLOB_BYTES:1024*1024
  };
  return { config, store:new Store(root), storage:new MemoryStorage() };
}

describe("Gib Sync API", () => {
  const setupPayload = (deviceName:string,basePath="/Obsidian/Test",username="test@example.test") => ({vaultName:"Test",deviceName,seafileUrl:"https://seafile.example.test",seafileUsername:username,seafilePassword:"password",libraryId:"library-1",libraryName:"Notes",basePath});
  it("enrolls, stores an encrypted blob, commits, pairs, and restores", async () => {
    const {config,store,storage} = fixture(); const app = await buildApp(config, store, storage as unknown as SeafileStorage);
    const discovery=await app.inject({method:"POST",url:"/v1/storage/discover",payload:{seafileUrl:"https://seafile.example.test",seafileUsername:"test@example.test",seafilePassword:"password"}});
    expect(discovery.statusCode).toBe(200);expect(discovery.json().libraries[0].name).toBe("Notes");
    const setup = await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")});
    expect(setup.statusCode).toBe(200); const credentials = setup.json(); const auth = {authorization:`Bearer ${credentials.deviceToken}`};
    const manualDevice=await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Manual mobile")});expect(manualDevice.statusCode).toBe(200);expect(manualDevice.json().vaultId).toBe(credentials.vaultId);
    const hash = "a".repeat(64); const blob = Buffer.from("encrypted-content");
    expect((await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:blob})).statusCode).toBe(201);
    const commit = await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Initial",entries:[{path:"note.md",hash,size:7,mtime:1}]}});
    expect(commit.statusCode).toBe(201); expect((await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head.entries[0].path).toBe("note.md");
    const pairing = (await app.inject({method:"POST",url:"/v1/pairings",headers:auth,payload:{}})).json();
    const claim = await app.inject({method:"POST",url:`/v1/pairings/${pairing.payload.pairingId}/claim`,payload:{secret:pairing.payload.secret,deviceName:"Mobile"}});
    expect(claim.statusCode).toBe(200); expect(claim.json().envelope).toBeTypeOf("string");
    expect((await app.inject({method:"POST",url:`/v1/pairings/${pairing.payload.pairingId}/claim`,payload:{secret:pairing.payload.secret,deviceName:"Other"}})).statusCode).toBe(410);
    expect((await app.inject({method:"POST",url:`/v1/restore/${commit.json().id}`,headers:auth,payload:{}})).statusCode).toBe(201);
    const status=await app.inject({method:"GET",url:"/v1/status",headers:auth});expect(status.statusCode).toBe(200);expect(status.json().deviceCount).toBe(3);expect(status.json().storage.basePath).toBe("/Obsidian/Test");
    await app.close();
  });
  it("rejects a stale compare-and-swap commit", async () => {
    const {config,store,storage} = fixture(); const app = await buildApp(config, store, storage as unknown as SeafileStorage);
    const credentials = (await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("A")})).json();
    const auth = {authorization:`Bearer ${credentials.deviceToken}`};
    const first = await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"One",entries:[]}}); expect(first.statusCode).toBe(201);
    const stale = await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Stale",entries:[]}}); expect(stale.statusCode).toBe(409);
    await app.close();
  });
  it("isolates different folders and refuses an owner mismatch",async()=>{
    const {config,store,storage}=fixture();const app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const first=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("A")})).json();
    const second=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("B","/Obsidian/Other")})).json();expect(second.vaultId).not.toBe(first.vaultId);
    const forbidden=await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("C","/Obsidian/Test","other@example.test")});expect(forbidden.statusCode).toBe(403);
    await app.close();
  });
  it("migrates a pre-0.2 vault and allows manual enrollment into it",async()=>{
    const {config,store,storage}=fixture();const id="11111111-1111-4111-8111-111111111111";const now=new Date().toISOString();
    store.run("INSERT INTO vaults(id,name,wrapped_key,created_at) VALUES(?,?,?,?)",id,"Legacy",sealJson("legacy-vault-key",config.GIBSYNC_SERVER_SECRET,id),now);
    const app=await buildApp(config,store,storage as unknown as SeafileStorage);const row=store.one<any>("SELECT * FROM vaults WHERE id=?",id);expect(row.storage_layout).toBe("legacy");
    const discovery=await app.inject({method:"POST",url:"/v1/storage/discover",payload:{seafileUrl:"https://seafile.example.test",seafileUsername:"legacy@example.test",seafilePassword:"password"}});
    expect(discovery.json().existingVaults[0].vaultId).toBe(id);
    const connected=await app.inject({method:"POST",url:"/v1/setup",payload:{...setupPayload("New phone","/","legacy@example.test"),existingVaultId:id}});expect(connected.statusCode).toBe(200);expect(connected.json().vaultId).toBe(id);
    await app.close();
  });
});
