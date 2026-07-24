import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv,randomBytes } from "node:crypto";
import { afterEach, describe, expect, it,vi } from "vitest";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { buildApp } from "./app.js";
import type { SeafileStorage } from "./seafile.js";
import { normalizeQuickCode,openJson,sealJson,sha256 } from "./security.js";

class MemoryStorage {
  files = new Map<string, Uint8Array>();
  async authenticate(url:string,username:string) { return {url:url.replace(/\/$/,""),username:username.toLowerCase(),token:`token:${username}`}; }
  async libraries() { return [{id:"library-1",name:"Notes"}]; }
  sealToken(_vaultId:string,token:string){return token;}
  location(row:any){return {seafileUrl:row.storage_url,username:row.storage_username,libraryId:row.storage_repo_id,libraryName:row.storage_repo_name,basePath:row.storage_base_path,readablePath:row.mirror_base_path};}
  equivalentServer(first:string,second:string){return first.replace(/\/$/,"")===second.replace(/\/$/,"");}
  async initVault() {}
  async legacySelection(){return {url:"https://seafile.example.test",username:"legacy@example.test",token:"legacy",libraryId:"library-1",libraryName:"Notes",basePath:"/"};}
  async put(row:any,path:string,bytes:Uint8Array) { this.files.set(`${row.id}:${path}`, bytes.slice()); }
  async get(row:any,path:string) { const bytes = this.files.get(`${row.id}:${path}`); if (!bytes) throw new Error("missing"); return bytes.slice(); }
  async getReadable(row:any,path:string){const bytes=this.files.get(`read:${row.id}:${path}`);if(!bytes)throw new Error("missing readable");return bytes.slice();}
  async putReadable(row:any,path:string,bytes:Uint8Array){this.files.set(`read:${row.id}:${path}`,bytes.slice());}
  async deleteReadable(row:any,path:string){this.files.delete(`read:${row.id}:${path}`);}
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gib-sync-")); roots.push(root);
  const config: Config = {
    HOST:"127.0.0.1", PORT:8787, PUBLIC_URL:"https://sync.example.test", DATA_DIR:root,
    GIBSYNC_SETUP_TOKEN:"setup-token-that-is-at-least-24-characters", GIBSYNC_SERVER_SECRET:"server-secret-that-is-at-least-thirty-two-characters",
    SEAFILE_URL:"https://seafile.example.test", SEAFILE_PUBLIC_URL:"https://seafile.example.test", SEAFILE_USERNAME:"test@example.test", SEAFILE_PASSWORD:"password", SEAFILE_LIBRARY:"Gib Sync", SEAFILE_ALLOWED_HOSTS:"seafile.example.test", MAX_BLOB_BYTES:1024*1024
  };
  return { config, store:new Store(root), storage:new MemoryStorage() };
}

function encryptedFixture(clear:Buffer,key:Buffer,hash:string):Buffer{const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",key,iv);cipher.setAAD(Buffer.from(hash));return Buffer.concat([Buffer.from([1]),iv,cipher.update(clear),cipher.final(),cipher.getAuthTag()]);}

describe("Gib Sync API", () => {
  const setupPayload = (deviceName:string,basePath="/Obsidian/Test",username="test@example.test") => ({vaultName:"Test",deviceName,seafileUrl:"https://seafile.example.test",seafileUsername:username,seafilePassword:"password",libraryId:"library-1",libraryName:"Notes",basePath});
  it("enrolls, stores an encrypted blob, commits, pairs, and restores", async () => {
    const {config,store,storage} = fixture(); const app = await buildApp(config, store, storage as unknown as SeafileStorage);
    const discovery=await app.inject({method:"POST",url:"/v1/storage/discover",payload:{seafileUrl:"https://seafile.example.test",seafileUsername:"test@example.test",seafilePassword:"password"}});
    expect(discovery.statusCode).toBe(200);expect(discovery.json().libraries[0].name).toBe("Notes");
    const setup = await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")});
    expect(setup.statusCode).toBe(200); const credentials = setup.json(); const auth = {authorization:`Bearer ${credentials.deviceToken}`};
    const manualDevice=await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Manual mobile")});expect(manualDevice.statusCode).toBe(200);expect(manualDevice.json().vaultId).toBe(credentials.vaultId);
    const readable=Buffer.from("readable note\n");const hash=sha256(readable);const blob = Buffer.from("encrypted-content");
    expect((await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:blob})).statusCode).toBe(201);
    const commit = await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Initial",entries:[{path:"note.md",hash,size:readable.length,mtime:1}]}});
    expect(commit.statusCode).toBe(201); expect((await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head.entries[0].path).toBe("note.md");
    const plan=await app.inject({method:"POST",url:"/v1/mirror/plan",headers:auth,payload:{snapshotId:commit.json().id,entries:commit.json().entries}});expect(plan.json().uploadPaths).toEqual(["note.md"]);
    const mirrorPut=await app.inject({method:"PUT",url:"/v1/mirror/file?path=note.md",headers:{...auth,"content-type":"application/octet-stream","x-gib-sync-snapshot":commit.json().id,"x-gib-sync-hash":hash},payload:readable});expect(mirrorPut.statusCode).toBe(204);
    const resumedPlan=await app.inject({method:"POST",url:"/v1/mirror/plan",headers:auth,payload:{snapshotId:commit.json().id,entries:commit.json().entries}});expect(resumedPlan.json()).toMatchObject({uploadPaths:[],alreadyCurrent:false});
    expect((await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:commit.json().id}})).statusCode).toBe(200);
    const emptyCommit=await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:commit.json().id,message:"Delete",entries:[]}});expect(emptyCommit.statusCode).toBe(201);
    const deletePlan=await app.inject({method:"POST",url:"/v1/mirror/plan",headers:auth,payload:{snapshotId:emptyCommit.json().id,entries:[]}});expect(deletePlan.json().deletePaths).toEqual(["note.md"]);
    expect((await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:emptyCommit.json().id}})).statusCode).toBe(200);expect(storage.files.has(`read:${credentials.vaultId}:note.md`)).toBe(false);
    const pairing=(await app.inject({method:"POST",url:"/v1/pairings",headers:auth,payload:{}})).json();expect(pairing.code).toMatch(/^\d{5}$/);expect(Date.parse(pairing.expiresAt)-Date.now()).toBeLessThanOrEqual(60_000);
    const wrongCode=((Number(pairing.code)+1)%100_000).toString().padStart(5,"0");expect((await app.inject({method:"POST",url:"/v1/pairings/claim-code",payload:{code:wrongCode,deviceName:"Intruder"}})).statusCode).toBe(410);
    const claim=await app.inject({method:"POST",url:"/v1/pairings/claim-code",payload:{code:pairing.code,deviceName:"Mobile"}});
    expect(claim.statusCode).toBe(200);const claimed=claim.json();expect(claimed.envelope).toBeTypeOf("string");
    expect(openJson<any>(claimed.envelope,normalizeQuickCode(pairing.code),`pairing:${claimed.pairingId}`)).toMatchObject({vaultId:credentials.vaultId,deviceToken:expect.any(String)});
    expect((await app.inject({method:"POST",url:"/v1/pairings/claim-code",payload:{code:pairing.code,deviceName:"Other"}})).statusCode).toBe(410);
    expect((await app.inject({method:"POST",url:`/v1/restore/${commit.json().id}`,headers:auth,payload:{}})).statusCode).toBe(201);
    const status=await app.inject({method:"GET",url:"/v1/status",headers:auth});expect(status.statusCode).toBe(200);expect(status.json().deviceCount).toBe(3);expect(status.json().storage.basePath).toBe("/Obsidian/Test");expect(status.json().mirrorCurrent).toBe(false);
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
  it("expires rolling codes after 60 seconds and throttles five-digit guesses",async()=>{
    const {config,store,storage}=fixture();const app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const credentials=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json();const auth={authorization:`Bearer ${credentials.deviceToken}`};
    const pairing=(await app.inject({method:"POST",url:"/v1/pairings",headers:auth,payload:{}})).json();expect(pairing.code).toMatch(/^\d{5}$/);
    store.run("UPDATE pairings SET expires_at=? WHERE quick_code_hash=?",new Date(Date.now()-1000).toISOString(),sha256(pairing.code));
    for(let attempt=1;attempt<=6;attempt++){const response=await app.inject({method:"POST",url:"/v1/pairings/claim-code",payload:{code:pairing.code,deviceName:"Mobile"}});expect(response.statusCode).toBe(attempt<=5?410:429);}
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
    const app=await buildApp(config,store,storage as unknown as SeafileStorage);const row=store.one<any>("SELECT * FROM vaults WHERE id=?",id);expect(row.storage_layout).toBe("legacy");expect(row.mirror_base_path).toBe("/Obsidian/Legacy");
    const discovery=await app.inject({method:"POST",url:"/v1/storage/discover",payload:{seafileUrl:"https://seafile.example.test",seafileUsername:"legacy@example.test",seafilePassword:"password"}});
    expect(discovery.json().existingVaults[0].vaultId).toBe(id);
    const connected=await app.inject({method:"POST",url:"/v1/setup",payload:{...setupPayload("New phone","/","legacy@example.test"),existingVaultId:id}});expect(connected.statusCode).toBe(200);expect(connected.json().vaultId).toBe(id);
    await app.close();
  });
  it("materializes an existing encrypted snapshot into a readable vault on startup",async()=>{
    const {config,store,storage}=fixture();const id="22222222-2222-4222-8222-222222222222";const snapshotId="33333333-3333-4333-8333-333333333333";const now=new Date().toISOString();const clear=Buffer.from("recover me\n");const hash=sha256(clear);const key=randomBytes(32);
    const snapshot={id:snapshotId,vaultId:id,parentId:null,deviceId:"device",deviceName:"Desktop",createdAt:now,message:"Initial",entries:[{path:"folder/note.md",hash,size:clear.length,mtime:1}]};
    store.run("INSERT INTO vaults(id,name,wrapped_key,head_id,created_at,storage_url,storage_username,storage_repo_id,storage_repo_name,storage_base_path,storage_token,storage_layout) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",id,"Recovery",sealJson(key.toString("base64url"),config.GIBSYNC_SERVER_SECRET,id),snapshotId,now,"https://seafile.example.test","legacy@example.test","library-1","Notes","/","legacy-token","legacy");
    store.run("INSERT INTO snapshots(id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?,?)",snapshotId,id,null,"device","Desktop",now,"Initial",JSON.stringify(snapshot));store.run("INSERT INTO blobs(vault_id,hash,size,created_at) VALUES(?,?,?,?)",id,hash,clear.length,now);
    storage.files.set(`${id}:blobs/${hash.slice(0,2)}/${hash}.gbs`,encryptedFixture(clear,key,hash));const app=await buildApp(config,store,storage as unknown as SeafileStorage);await app.ready();
    await vi.waitFor(()=>expect(Buffer.from(storage.files.get(`read:${id}:folder/note.md`)??[])).toEqual(clear),{timeout:1000});expect(store.one<any>("SELECT mirror_head_id,mirror_base_path FROM vaults WHERE id=?",id)).toMatchObject({mirror_head_id:snapshotId,mirror_base_path:"/Obsidian/Recovery"});await app.close();
  });
  it("recovers a missing current blob from the verified readable mirror",async()=>{
    const {config,store,storage}=fixture();const app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json();const auth={authorization:`Bearer ${setup.deviceToken}`};
    const clear=Buffer.from("recover the encrypted object\n");const hash=sha256(clear);const key=Buffer.from(setup.vaultKey,"base64url");const encrypted=encryptedFixture(clear,key,hash);
    expect((await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encrypted})).statusCode).toBe(201);
    const commit=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Initial",entries:[{path:"note.md",hash,size:clear.length,mtime:1}]}})).json();
    storage.files.set(`read:${setup.vaultId}:note.md`,clear);store.run("UPDATE vaults SET mirror_head_id=? WHERE id=?",commit.id,setup.vaultId);storage.files.delete(`${setup.vaultId}:blobs/${hash.slice(0,2)}/${hash}.gbs`);
    const response=await app.inject({method:"GET",url:`/v1/blobs/${hash}`,headers:auth});expect(response.statusCode).toBe(200);
    expect(storage.files.get(`${setup.vaultId}:blobs/${hash.slice(0,2)}/${hash}.gbs`)?.length).toBe(encrypted.length);await app.close();
  });
});
