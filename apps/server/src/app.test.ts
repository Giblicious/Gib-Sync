import { mkdtempSync,readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv,randomBytes,randomUUID } from "node:crypto";
import { afterEach, describe, expect, it,vi } from "vitest";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { buildApp as constructApp } from "./app.js";
import { StorageMissingError,RevisionMissingError,type SeafileStorage } from "./seafile.js";
import { decryptVaultBlob,encryptVaultBlob,openJson,sealJson,sha256 } from "./security.js";
import { ContainmentService } from "./containment.js";
import { VaultRetirementService } from "./vault-retirement.js";
import { SERVER_VERSION } from "./version.js";
import {CheckpointRepairs} from './checkpoint-repair.js';

class MemoryStorage {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  blockReadableWrites = false;
  explicitRenames:Array<{previousPath:string;path:string}>=[];
  private readableWriteWaiters: Array<() => void> = [];
  private histories=new Map<string,Array<{commitId:string;bytes:Uint8Array;mtime:number}>>();
  private repositoryHistory=new Map<string,Array<{commitId:string;files:Map<string,Uint8Array>;sidecars:Map<string,Uint8Array>;folders:string[];mtime:number;signature:string}>>();
  private recordRepo(row:any){const prefix=`read:${row.id}:`,sidecarPrefix=`${row.id}:mutation-fences/`,files=new Map([...this.files].filter(([path])=>path.startsWith(prefix)).map(([path,bytes])=>[path.slice(prefix.length),bytes.slice()])),sidecars=new Map([...this.files].filter(([path])=>path.startsWith(sidecarPrefix)).map(([path,bytes])=>[path.slice(`${row.id}:`.length),bytes.slice()])),folders=[...this.dirs].filter((path)=>path.startsWith(prefix)).map((path)=>path.slice(prefix.length)),signature=sha256(Buffer.from(JSON.stringify({files:[...files].map(([path,bytes])=>[path,sha256(bytes)]),sidecars:[...sidecars].map(([path,bytes])=>[path,sha256(bytes)]),folders})));const records=this.repositoryHistory.get(row.id)??[];if(records[0]?.signature!==signature){records.unshift({commitId:sha256(`${row.id}:${records.length}:${signature}`).slice(0,40),files,sidecars,folders,signature,mtime:Date.now()});this.repositoryHistory.set(row.id,records);}}
  async repoHistory(row:any,until?:string|null){this.recordRepo(row);const records=this.repositoryHistory.get(row.id)!;if(until&&!records.some((item)=>item.commitId===until))throw new Error("history gap");return records.slice(0,until?records.findIndex((item)=>item.commitId===until):1).map((item)=>({commitId:item.commitId,size:0,mtime:item.mtime}));}
  async readableRenames(row:any,baseline:string){await this.repoHistory(row,baseline);return this.explicitRenames;}
  async readableEvents(row:any,baseline:string){
    await this.repoHistory(row,baseline);const records=this.repositoryHistory.get(row.id)!,end=records.findIndex(r=>r.commitId===baseline),events:Array<{commitId:string;mtime:number;operation:'created'|'deleted'|'modified';path:string;directory:boolean}>=[];
    for(let i=end-1;i>=0;i--){const current=records[i],prior=records[i+1];for(const path of new Set([...current.files.keys(),...prior.files.keys()])){const a=prior.files.get(path),b=current.files.get(path);if(a&&b&&sha256(a)===sha256(b))continue;events.push({commitId:current.commitId,mtime:current.mtime,operation:!a?'created':!b?'deleted':'modified',path,directory:false});}for(const path of new Set([...current.folders,...prior.folders])){const a=prior.folders.includes(path),b=current.folders.includes(path);if(a!==b)events.push({commitId:current.commitId,mtime:current.mtime,operation:b?'created':'deleted',path,directory:true});}}
    return events;
  }
  async assertHistoryAvailable(){}
  async authenticate(url:string,username:string) { return {url:url.replace(/\/$/,""),username:username.toLowerCase(),token:`token:${username}`}; }
  async libraries() { return [{id:"library-1",name:"Notes"}]; }
  sealToken(_vaultId:string,token:string){return token;}
  location(row:any){return {seafileUrl:row.storage_url,username:row.storage_username,libraryId:row.storage_repo_id,libraryName:row.storage_repo_name,basePath:row.storage_base_path,readablePath:row.mirror_base_path};}
  equivalentServer(first:string,second:string){return first.replace(/\/$/,"")===second.replace(/\/$/,"");}
  async initVault() {}
  async legacySelection(){return {url:"https://seafile.example.test",username:"legacy@example.test",token:"legacy",libraryId:"library-1",libraryName:"Notes",basePath:"/"};}
  async put(row:any,path:string,bytes:Uint8Array) { this.files.set(`${row.id}:${path}`, bytes.slice());if(path.startsWith("mutation-fences/"))this.recordRepo(row); }
  async putFile(row:any,path:string,localPath:string){await this.put(row,path,readFileSync(localPath));}
  async get(row:any,path:string) { const bytes = this.files.get(`${row.id}:${path}`); if (!bytes) throw new StorageMissingError(); return bytes.slice(); }
  async getReadable(row:any,path:string){const bytes=this.files.get(`read:${row.id}:${path}`);if(!bytes)throw new Error("missing readable");return bytes.slice();}
  async statReadable(row:any,path:string){const bytes=this.files.get(`read:${row.id}:${path}`);return bytes?{path,id:sha256(bytes),mtime:1,size:bytes.length}:null;}
  private remember(row:any,path:string,bytes:Uint8Array){const key=`read:${row.id}:${path}`,items=this.histories.get(key)??[],commitId=sha256(Buffer.concat([Buffer.from(String(items.length)),Buffer.from(bytes)])).slice(0,40);items.unshift({commitId,bytes:bytes.slice(),mtime:Date.now()});this.histories.set(key,items);}
  async readableHistory(row:any,path:string){return (this.histories.get(`read:${row.id}:${path}`)??[]).map((item)=>({commitId:item.commitId,size:item.bytes.length,mtime:item.mtime}));}
  async getReadableRevision(row:any,path:string,commitId:string){const bytes=(this.repositoryHistory.get(row.id)??[]).find((entry)=>entry.commitId===commitId)?.files.get(path);if(!bytes)throw new RevisionMissingError();return bytes.slice();}
  async getSidecarRevision(row:any,path:string,commitId:string){const bytes=(this.repositoryHistory.get(row.id)??[]).find((entry)=>entry.commitId===commitId)?.sidecars.get(path);if(!bytes)throw new RevisionMissingError();return bytes.slice();}
  async readableRevisionTree(row:any,path:string,commitId:string){const revision=(this.repositoryHistory.get(row.id)??[]).find((item)=>item.commitId===commitId);if(!revision)throw new Error("missing repository history");return {files:[...revision.files].filter(([key])=>key.startsWith(`${path}/`)).map(([key,bytes])=>({path:key,id:sha256(bytes),size:bytes.length,mtime:1})),folders:revision.folders.filter((key)=>key===path||key.startsWith(`${path}/`))};}
  async putReadable(row:any,path:string,bytes:Uint8Array){if(this.blockReadableWrites)await new Promise<void>((resolve)=>this.readableWriteWaiters.push(resolve));this.recordRepo(row);const previous=this.files.get(`read:${row.id}:${path}`);if(previous)this.remember(row,path,previous);const parts=path.split("/").slice(0,-1);let current="";for(const part of parts){current=current?`${current}/${part}`:part;this.dirs.add(`read:${row.id}:${current}`);}this.files.set(`read:${row.id}:${path}`,bytes.slice());this.remember(row,path,bytes);this.recordRepo(row);}
  async ensureReadableFolder(row:any,path:string){const parts=path.split("/");let current="";for(const part of parts){current=current?`${current}/${part}`:part;this.dirs.add(`read:${row.id}:${current}`);}}
  unblockReadableWrites(){this.blockReadableWrites=false;for(const resolve of this.readableWriteWaiters.splice(0))resolve();}
  async deleteReadable(row:any,path:string){this.recordRepo(row);const previous=this.files.get(`read:${row.id}:${path}`);if(previous)this.remember(row,path,previous);this.files.delete(`read:${row.id}:${path}`);this.recordRepo(row);}
  async deleteReadableFolder(row:any,path:string){const key=`read:${row.id}:${path}`,prefix=`${key}/`;if([...this.files.keys()].some((item)=>item.startsWith(prefix))||[...this.dirs].some((item)=>item.startsWith(prefix)))return false;this.recordRepo(row);this.dirs.delete(key);this.recordRepo(row);return true;}
  async listReadableTree(row:any){const prefix=`read:${row.id}:`;return {files:[...this.files.entries()].filter(([key])=>key.startsWith(prefix)).map(([key,bytes])=>({path:key.slice(prefix.length),id:sha256(bytes),mtime:1,size:bytes.length})),folders:[...this.dirs].filter((key)=>key.startsWith(prefix)).map((key)=>key.slice(prefix.length)).sort()};}
  async listReadable(row:any){return (await this.listReadableTree(row)).files;}
}

const roots: string[] = [];
const fixtureStores:Store[]=[],fixtureStorage:MemoryStorage[]=[],fixtureApps:Array<{close:()=>Promise<void>}>=[];
async function buildApp(...args:Parameters<typeof constructApp>){const app=await constructApp(...args);fixtureApps.push(app);return app;}
afterEach(async()=>{for(const storage of fixtureStorage.splice(0))storage.unblockReadableWrites();for(const app of fixtureApps.splice(0))await app.close();for(const store of fixtureStores.splice(0))try{store.db.close();}catch{}for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});vi.useRealTimers();});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gib-sync-")); roots.push(root);
  const config: Config = {
    HOST:"127.0.0.1", PORT:8787, PUBLIC_URL:"https://sync.example.test", DATA_DIR:root,
    GIBSYNC_SETUP_TOKEN:"setup-token-that-is-at-least-24-characters", GIBSYNC_SERVER_SECRET:"server-secret-that-is-at-least-thirty-two-characters",
    SEAFILE_URL:"https://seafile.example.test", SEAFILE_PUBLIC_URL:"https://seafile.example.test", SEAFILE_USERNAME:"test@example.test", SEAFILE_PASSWORD:"password", SEAFILE_LIBRARY:"Gib Sync", SEAFILE_ALLOWED_HOSTS:"seafile.example.test", MAX_BLOB_BYTES:1024*1024,
    GIBSYNC_MIN_CLIENT_VERSION:"0.0.0",GIBSYNC_RECOMMENDED_CLIENT_VERSION:"0.8.19"
  };
  const store=new Store(root),storage=new MemoryStorage();fixtureStores.push(store);fixtureStorage.push(storage);return {config,store,storage};
}

function encryptedFixture(clear:Buffer,key:Buffer,hash:string):Buffer{const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",key,iv);cipher.setAAD(Buffer.from(hash));return Buffer.concat([Buffer.from([1]),iv,cipher.update(clear),cipher.final(),cipher.getAuthTag()]);}

describe("Gib Sync API", () => {
  const setupPayload = (deviceName:string,basePath="/Obsidian/Test",username="test@example.test") => ({vaultName:"Test",deviceName,seafileUrl:"https://seafile.example.test",seafileUsername:username,seafilePassword:"password",libraryId:"library-1",libraryName:"Notes",basePath});
  it('keeps QR valid after numeric expiry, hashes the invitation, requires approval and consumes both alternatives once',async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:'POST',url:'/v1/setup',payload:setupPayload('Trusted desktop')})).json(),headers={authorization:`Bearer ${setup.deviceToken}`};
    const before=Date.now(),pairing=(await app.inject({method:'POST',url:'/v1/pairings',headers,payload:{requireConfirmation:true}})).json(),token=new URL(pairing.qrSetupUrl).searchParams.get('token')!;
    expect(token).toMatch(/^[-_A-Za-z0-9]{43}$/);expect(Date.parse(pairing.qrExpiresAt)-before).toBeGreaterThanOrEqual(600_000);expect(Date.parse(pairing.expiresAt)-before).toBeLessThan(61_000);expect(JSON.stringify(store.all('SELECT * FROM pairings'))).not.toContain(token);expect(store.one('SELECT expires_at,qr_expires_at FROM pairings')).toEqual({expires_at:pairing.expiresAt,qr_expires_at:pairing.qrExpiresAt});
    const clock=vi.spyOn(Date,'now').mockReturnValue(before+9*60_000);try{
      expect((await app.inject({method:'POST',url:'/v1/pairings/claim-code',payload:{code:pairing.code,deviceName:'Phone'}})).statusCode).toBe(410);
      expect((await app.inject({method:'POST',url:'/v1/pairings',headers,payload:{requireConfirmation:true}})).statusCode).toBe(200);
      expect(store.one('SELECT quick_code_hash FROM pairings WHERE secret_hash=?',sha256(token))).toEqual({quick_code_hash:null});
      const response=await app.inject({method:'POST',url:'/v1/pairings/claim-qr',payload:{token,deviceName:'Phone'}});expect(response.statusCode).toBe(202);const claim=response.json();expect(claim.confirmationCode).toMatch(/^\d{6}$/);expect(claim.envelope).toBeUndefined();expect(store.one<{count:number}>('SELECT COUNT(*) count FROM devices')?.count).toBe(1);
      expect((await app.inject({method:'POST',url:'/v1/pairings/claim-qr',payload:{token,deviceName:'Duplicate'}})).statusCode).toBe(410);expect((await app.inject({method:'POST',url:'/v1/pairings/poll',payload:{ticket:claim.ticket}})).json().status).toBe('pending');
      expect((await app.inject({method:'POST',url:`/v1/pairings/requests/${claim.claimId}/decision`,headers,payload:{approved:true}})).statusCode).toBe(200);const approved=(await app.inject({method:'POST',url:'/v1/pairings/poll',payload:{ticket:claim.ticket}})).json();expect(openJson<any>(approved.envelope,claim.ticket,`pairing:${approved.pairingId}`)).toMatchObject({vaultId:setup.vaultId});
    }finally{clock.mockRestore();}
  });
  it('expires QR at ten minutes and rejects malformed, foreign and revoked-origin invitations',async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:'POST',url:'/v1/setup',payload:setupPayload('Trusted desktop')})).json(),headers={authorization:`Bearer ${setup.deviceToken}`};
    const pairing=(await app.inject({method:'POST',url:'/v1/pairings',headers,payload:{requireConfirmation:true}})).json(),token=new URL(pairing.qrSetupUrl).searchParams.get('token')!;
    expect((await app.inject({method:'POST',url:'/v1/pairings/claim-qr',payload:{token:'12345',deviceName:'Phone'}})).statusCode).toBe(400);expect((await app.inject({method:'POST',url:'/v1/pairings/claim-qr',payload:{token:'z'.repeat(43),deviceName:'Phone'}})).statusCode).toBe(410);
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse(pairing.qrExpiresAt));try{expect((await app.inject({method:'POST',url:'/v1/pairings/claim-qr',payload:{token,deviceName:'Phone'}})).statusCode).toBe(410);}finally{clock.mockRestore();}
    store.run('UPDATE devices SET revoked_at=? WHERE id=?',new Date().toISOString(),setup.deviceId);expect((await app.inject({method:'POST',url:'/v1/pairings/claim-qr',payload:{token,deviceName:'Phone'}})).statusCode).toBe(410);expect(store.one<{count:number}>('SELECT COUNT(*) count FROM trusted_pairing_claims')?.count).toBe(0);
  });
  it('serves a public prefix-preserving invitation without consuming it or bypassing trusted-device approval',async()=>{
    const {config,store,storage}=fixture();config.PUBLIC_URL='https://sync.example.test/candidate/prefix///';
    const app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:'POST',url:'/v1/setup',payload:setupPayload('Trusted desktop')})).json(),headers={authorization:`Bearer ${setup.deviceToken}`};
    const pairing=(await app.inject({method:'POST',url:'/v1/pairings',headers,payload:{requireConfirmation:true}})).json(),url=new URL(pairing.setupUrl);
    expect(url.origin).toBe('https://sync.example.test');expect(url.pathname).toBe('/candidate/prefix/setup');expect(url.searchParams.get('code')).toBe(pairing.code);expect(Number(url.searchParams.get('expires'))).toBe(Date.parse(pairing.expiresAt));expect(pairing.requiresConfirmation).toBe(true);expect(Date.parse(pairing.expiresAt)-Date.now()).toBeLessThanOrEqual(60_000);
    const before=JSON.stringify({pairings:store.all('SELECT * FROM pairings'),devices:store.all('SELECT * FROM devices'),vaults:store.all('SELECT * FROM vaults'),claims:store.all('SELECT * FROM trusted_pairing_claims')});
    const page=await app.inject({method:'GET',url:'/setup'+url.search,headers:{host:'attacker.example.test'}});expect(page.statusCode).toBe(200);expect(page.body).toContain('Open Gib Sync in Obsidian');expect(page.body).not.toContain(setup.deviceToken);expect(page.body).not.toContain(setup.vaultKey);
    expect(JSON.stringify({pairings:store.all('SELECT * FROM pairings'),devices:store.all('SELECT * FROM devices'),vaults:store.all('SELECT * FROM vaults'),claims:store.all('SELECT * FROM trusted_pairing_claims')})).toBe(before);
    const claim=await app.inject({method:'POST',url:'/v1/pairings/claim-code',payload:{code:pairing.code,deviceName:'Phone'}});expect(claim.statusCode).toBe(202);const pending=claim.json();expect(pending.confirmationCode).toMatch(/^\d{6}$/);expect(pending.envelope).toBeUndefined();
    expect((await app.inject({method:'POST',url:'/v1/pairings/poll',payload:{ticket:pending.ticket}})).json()).toMatchObject({status:'pending'});expect(store.one<{count:number}>('SELECT COUNT(*) count FROM devices')?.count).toBe(1);
    expect((await app.inject({method:'POST',url:`/v1/pairings/requests/${pending.claimId}/decision`,headers,payload:{approved:true}})).statusCode).toBe(200);
    const approved=(await app.inject({method:'POST',url:'/v1/pairings/poll',payload:{ticket:pending.ticket}})).json();expect(openJson<any>(approved.envelope,pending.ticket,`pairing:${approved.pairingId}`)).toMatchObject({vaultId:setup.vaultId,deviceToken:expect.any(String)});
    await app.close();
  });
  it('applies the normal public 120/min budget and safe headers to setup bridge requests',async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),url=`/setup?code=12345&expires=${Date.now()+60_000}`;
    for(let index=0;index<120;index++)expect((await app.inject({method:'GET',url})).statusCode).toBe(200);
    const blocked=await app.inject({method:'GET',url});expect(blocked.statusCode).toBe(429);expect(blocked.headers['cache-control']).toBe('no-store');expect(blocked.headers['referrer-policy']).toBe('no-referrer');expect(store.one('SELECT 1 FROM pairings')).toBeUndefined();expect(store.one('SELECT 1 FROM trusted_pairing_claims')).toBeUndefined();await app.close();
  });
  it('does not consume the five-attempt claim budget while displaying invitations',async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),url=`/setup?code=12345&expires=${Date.now()+60_000}`;
    for(let index=0;index<8;index++)expect((await app.inject({method:'GET',url})).statusCode).toBe(200);
    for(let attempt=1;attempt<=6;attempt++)expect((await app.inject({method:'POST',url:'/v1/pairings/claim-code',payload:{code:'12345',deviceName:'Phone'}})).statusCode).toBe(attempt<=5?410:429);
    await app.close();
  });
  it("integrates authenticated resumable content upload with chunk limits and legacy decryption",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`},clear=Buffer.from("resumable content"),hash=sha256(clear);
    expect((await app.inject({method:"POST",url:"/v1/content-uploads",headers:{"content-type":"application/json"},payload:"invalid JSON"})).statusCode).toBe(401);expect((await app.inject({method:"GET",url:"/v1/compatibility",headers:auth})).json().serverCapabilities).toContain("resumable-content-upload-v1");const begun=await app.inject({method:"POST",url:"/v1/content-uploads",headers:auth,payload:{hash,size:clear.length}});expect(begun.statusCode).toBe(200);const session=begun.json();expect(session).toMatchObject({hash,size:clear.length,offset:0,chunkBytes:256*1024,complete:false});
    expect((await app.inject({method:"PUT",url:`/v1/content-uploads/${session.id}/chunks/0`,headers:{...auth,"content-type":"application/octet-stream","x-chunk-sha256":hash},payload:Buffer.alloc(256*1024+1)})).statusCode).toBe(413);expect((await app.inject({method:"PUT",url:`/v1/content-uploads/${session.id}/chunks/0`,headers:{...auth,"content-type":"application/octet-stream","x-chunk-sha256":hash},payload:clear})).json()).toMatchObject({id:session.id,offset:clear.length});const processing=await app.inject({method:"POST",url:`/v1/content-uploads/${session.id}/complete`,headers:auth,payload:{}});expect(processing.statusCode).toBe(202);expect(processing.json()).toMatchObject({complete:false,offset:clear.length,processing:true});await vi.waitFor(async()=>{const completed=await app.inject({method:"POST",url:`/v1/content-uploads/${session.id}/complete`,headers:auth,payload:{}});expect(completed.statusCode).toBe(200);expect(completed.json()).toMatchObject({complete:true,offset:clear.length});});
    const encrypted=await app.inject({method:"GET",url:`/v1/blobs/${hash}`,headers:auth});expect(encrypted.statusCode).toBe(200);expect(Buffer.from(decryptVaultBlob(encrypted.rawPayload,setup.vaultKey,hash))).toEqual(clear);await app.close();
  });
  it("aborts and drains an active resumable finalizer before closing the database",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`},clear=Buffer.from("safe shutdown upload"),hash=sha256(clear),session=(await app.inject({method:"POST",url:"/v1/content-uploads",headers:auth,payload:{hash,size:clear.length}})).json();await app.inject({method:"PUT",url:`/v1/content-uploads/${session.id}/chunks/0`,headers:{...auth,"content-type":"application/octet-stream","x-chunk-sha256":hash},payload:clear});let begin!:()=>void,settled=false;const started=new Promise<void>(resolve=>begin=resolve);storage.putFile=async(_row:any,_path:string,_file:string,signal?:AbortSignal)=>{begin();try{await new Promise<void>((_resolve,reject)=>{if(signal?.aborted)reject(signal.reason);else signal!.addEventListener("abort",()=>reject(signal!.reason),{once:true});});}finally{settled=true;}};
    expect((await app.inject({method:"POST",url:`/v1/content-uploads/${session.id}/complete`,headers:auth,payload:{}})).statusCode).toBe(202);await started;expect(store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?",setup.vaultId,hash)).toBeUndefined();await app.close();expect(settled).toBe(true);expect(storage.files.has(`${setup.vaultId}:blobs/${hash.slice(0,2)}/${hash}.gbs`)).toBe(false);expect(()=>store.one("SELECT 1")).toThrow();
  });
  it("durably stores each external candidate before reading the next file in a batch",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`};for(let index=0;index<20;index++)storage.files.set(`read:${setup.vaultId}:new-${index}.bin`,Buffer.from(`external binary ${index}`));
    const originalGet=storage.getReadable.bind(storage),originalPut=storage.put.bind(storage);let read=0,preserved=0;storage.getReadable=async(row:any,path:string)=>{expect(preserved).toBeGreaterThanOrEqual(read);read++;return originalGet(row,path);};storage.put=async(row:any,path:string,bytes:Uint8Array)=>{await originalPut(row,path,bytes);if(path.startsWith("blobs/"))preserved++;};
    expect((await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).statusCode).toBe(200);expect(read).toBe(20);expect(preserved).toBe(20);const head=store.getSnapshot(store.one<{head_id:string}>("SELECT head_id FROM vaults WHERE id=?",setup.vaultId)!.head_id)!;expect(head.entries).toHaveLength(20);expect(store.one<{count:number}>("SELECT COUNT(*) count FROM external_revisions WHERE vault_id=? AND source='external-observation'",setup.vaultId)?.count).toBe(20);await app.close();
  });
  it("recovers a preserved external candidate after failed acceptance even if the visible file disappears",async()=>{
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval"]});const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`},clear=Buffer.from("external edit must survive"),hash=sha256(clear);storage.files.set(`read:${setup.vaultId}:new.md`,clear);const original=storage.put.bind(storage);let fail=true;storage.put=async(row:any,path:string,bytes:Uint8Array)=>{if(fail&&path.startsWith("snapshots/"))throw new Error("simulated lost acceptance");await original(row,path,bytes);};
    expect((await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).statusCode).toBe(500);expect(store.one<{hash:string;imported_at:null}>("SELECT hash,imported_at FROM external_revisions WHERE vault_id=? AND source='external-observation'",setup.vaultId)).toMatchObject({hash,imported_at:null});storage.files.delete(`read:${setup.vaultId}:new.md`);fail=false;
    expect((await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).statusCode).toBe(200);const head=store.getSnapshot(store.one<{head_id:string}>("SELECT head_id FROM vaults WHERE id=?",setup.vaultId)!.head_id)!;expect(head.entries).toMatchObject([{path:"new.md",hash}]);expect(store.one<{imported_at:string}>("SELECT imported_at FROM external_revisions WHERE vault_id=? AND source='external-observation'",setup.vaultId)?.imported_at).toEqual(expect.any(String));await app.close();
  });
  it("keeps rejected external observations in history without replaying them after restoration",async()=>{
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval"]});const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`},clear=Buffer.from("accepted content\n".repeat(100)),hash=sha256(clear);await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:Buffer.from(encryptVaultBlob(clear,setup.vaultKey,hash))});const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,entries:[{path:"note.md",hash,size:clear.length,mtime:1}]}})).json();await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:first.id}});const policy=(await app.inject({method:"GET",url:"/v1/safeguards",headers:auth})).json().policy;await app.inject({method:"PUT",url:"/v1/safeguards/policy",headers:auth,payload:{...policy,mode:"custom",changedCount:1,changedPercent:1}});storage.files.set(`read:${setup.vaultId}:note.md`,Buffer.from("unwanted external content"));const scan=(await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).json();expect(scan.quarantineId).toEqual(expect.any(String));
    expect((await app.inject({method:"POST",url:`/v1/quarantines/${scan.quarantineId}/reject`,headers:auth,payload:{}})).statusCode).toBe(200);expect((await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:first.id}})).statusCode).toBe(200);expect((await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).json()).toMatchObject({snapshotId:null,changedFiles:0});expect(storage.files.get(`read:${setup.vaultId}:note.md`)).toEqual(clear);expect(store.one<{imported_at:string}>("SELECT imported_at FROM external_revisions WHERE vault_id=? AND source='external-observation'",setup.vaultId)?.imported_at).toEqual(expect.any(String));await app.close();
  });
  it("bounds concurrent authenticated content responses and returns retryable backpressure",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`},clear=Buffer.from("small content"),hash=sha256(clear);expect((await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:Buffer.from(encryptVaultBlob(clear,setup.vaultKey,hash))})).statusCode).toBe(201);
    const original=storage.get.bind(storage);let reads=0,release!:()=>void,ready!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>ready=resolve);storage.get=async(row:any,path:string)=>{if(path.includes("blobs/")){reads++;if(reads===2)ready();await gate;}return original(row,path);};
    const first=Promise.resolve(app.inject({method:"GET",url:`/v1/content/${hash}`,headers:auth})),second=Promise.resolve(app.inject({method:"GET",url:`/v1/content/${hash}`,headers:auth}));await started;const busy=await app.inject({method:"GET",url:`/v1/content/${hash}`,headers:auth});expect(busy.statusCode).toBe(503);expect(busy.headers["retry-after"]).toBe("2");release();expect((await first).statusCode).toBe(200);expect((await second).statusCode).toBe(200);expect((await app.inject({method:"GET",url:`/v1/content/${hash}`,headers:auth})).statusCode).toBe(200);await app.close();
  });
  it("keeps protocol-7 version-0.8.55 clients working without retransmitting readable files",async()=>{
    const {config,store,storage}=fixture();config.GIBSYNC_MIN_CLIENT_VERSION="0.8.55";const app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Existing desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`,"x-gib-sync-client-version":"0.8.55","x-gib-sync-protocol":"7"},clear=Buffer.from("legacy client note"),hash=sha256(clear),entry={path:"note.md",hash,size:clear.length,mtime:Date.now()};
    expect((await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:Buffer.from(encryptVaultBlob(clear,setup.vaultKey,hash))})).statusCode).toBe(201);
    const accepted=await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,entries:[entry]}});expect(accepted.statusCode).toBe(201);
    expect((await app.inject({method:"POST",url:"/v1/mirror/plan",headers:auth,payload:{snapshotId:accepted.json().id,entries:[entry]}})).json()).toMatchObject({uploadPaths:[],deletePaths:[],serverManaged:true});
    const completed=await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:accepted.json().id}});expect(completed.statusCode).toBe(200);expect(storage.files.get(`read:${setup.vaultId}:note.md`)).toEqual(clear);expect((await app.inject({method:"GET",url:"/v1/status",headers:auth})).json()).toMatchObject({mirrorCurrent:true,compatibility:{compatible:true}});
    store.run("UPDATE vaults SET mirror_repo_commit=NULL WHERE id=?",setup.vaultId);const writes=vi.spyOn(storage,"putReadable");expect((await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:accepted.json().id}})).statusCode).toBe(200);expect(writes).not.toHaveBeenCalled();expect(store.one<{mirror_repo_commit:string}>("SELECT mirror_repo_commit FROM vaults WHERE id=?",setup.vaultId)?.mirror_repo_commit).toMatch(/^[a-f0-9]{40}$/);await app.close();
  });
  it("authenticates before parsing request bodies and blocks a valid quick code after failed guesses",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage);
    expect((await app.inject({method:"POST",url:"/v1/commit",headers:{"content-type":"application/json"},payload:"not json"})).statusCode).toBe(401);
    const setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`},pair=(await app.inject({method:"POST",url:"/v1/pairings",headers:auth,payload:{requireConfirmation:true}})).json(),wrong=((Number(pair.code)+1)%100000).toString().padStart(5,"0");
    for(let index=0;index<5;index++)expect((await app.inject({method:"POST",url:"/v1/pairings/claim-code",payload:{code:wrong,deviceName:"Attempt"}})).statusCode).toBe(410);
    expect((await app.inject({method:"POST",url:"/v1/pairings/claim-code",payload:{code:pair.code,deviceName:"Phone"}})).statusCode).toBe(429);await app.close();
  });
  it("rejects overlapping registrations while reusing a portable same-location registration",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json();
    expect((await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Phone","/obsidian/test")})).json().vaultId).toBe(setup.vaultId);
    expect((await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Child","/Obsidian/Test/Child")})).statusCode).toBe(409);
    expect((await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Parent","/Obsidian")})).statusCode).toBe(409);
    expect(store.one<{count:number}>("SELECT COUNT(*) count FROM vaults")?.count).toBe(1);await app.close();
  });
  it("returns owned snapshot deltas and preserves per-file identity and authorship",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`},key=Buffer.from(setup.vaultKey,"base64url"),clear=Buffer.from("old note"),hash=sha256(clear);
    await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(clear,key,hash)});
    const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,entries:[{path:"old.md",hash,size:clear.length,mtime:Date.now()}]}})).json(),phone=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Phone")})).json(),phoneAuth={authorization:`Bearer ${phone.deviceToken}`};await app.inject({method:"POST",url:"/v1/devices/current/ready",headers:phoneAuth,payload:{headId:first.id}});
    const second=(await app.inject({method:"POST",url:"/v1/commit",headers:phoneAuth,payload:{parentId:first.id,entries:[{...first.entries[0],path:"new.md"}],folders:["Empty"]}})).json();expect(second.entries[0].fileId).toBe(first.entries[0].fileId);expect(second.entries[0].revision).toMatchObject({parentId:first.entries[0].revision.id,deviceId:first.entries[0].revision.deviceId,deviceName:first.entries[0].revision.deviceName,modifiedAt:first.entries[0].revision.modifiedAt});expect(second.entries[0].revision.id).not.toBe(first.entries[0].revision.id);
    const delta=await app.inject({method:"GET",url:`/v1/delta?since=${first.id}`,headers:auth});expect(delta.json()).toMatchObject({baseId:first.id,snapshot:{id:second.id,folders:["Empty"]},changed:[{path:"new.md",fileId:first.entries[0].fileId}],removed:["old.md"]});expect(delta.json().snapshot.entries).toBeUndefined();
    expect((await app.inject({method:"GET",url:`/v1/delta?since=${randomUUID()}`,headers:auth})).statusCode).toBe(409);
    const stranger=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Other","/Other")})).json();expect((await app.inject({method:"GET",url:`/v1/delta?since=${first.id}`,headers:{authorization:`Bearer ${stranger.deviceToken}`}})).statusCode).toBe(409);
    const status=(await app.inject({method:"GET",url:"/v1/status",headers:auth})).json();expect(status.devices.find((item:any)=>item.id===phone.deviceId)).toMatchObject({acknowledgedSnapshotId:first.id,acknowledgedAt:expect.any(String)});expect(status.healthAlerts.some((item:any)=>item.code==="mirror_diverged"&&item.level==="warning")).toBe(false);await app.close();
  });
  it("blocks incompatible clients while preserving update guidance and status access",async()=>{
    const {config,store,storage}=fixture();config.GIBSYNC_MIN_CLIENT_VERSION="0.8.19";config.GIBSYNC_RECOMMENDED_CLIENT_VERSION="0.8.20";const app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Old desktop")})).json(),legacy={authorization:`Bearer ${setup.deviceToken}`},current={...legacy,"x-gib-sync-client-version":"0.8.19","x-gib-sync-protocol":"7"};
    expect((await app.inject({method:"GET",url:"/healthz"})).json()).toMatchObject({serverVersion:SERVER_VERSION,protocolVersion:7,serverCapabilities:expect.arrayContaining(["readable-generation-v1","external-delete-proof-v1","folder-manifest-v1","folder-manifest-migration-v2","folder-provenance-repair-v1","folder-retirement-directive-v1","snapshot-integrity-v1","atomic-head-commit-v1","server-containment-v1","vault-retirement-v1"])});
    const blocked=await app.inject({method:"GET",url:"/v1/head",headers:legacy});expect(blocked.statusCode).toBe(426);expect(blocked.json().message).toContain("Update Gib Sync through BRAT");
    const visible=await app.inject({method:"GET",url:"/v1/status",headers:legacy});expect(visible.statusCode).toBe(200);expect(visible.json().compatibility).toMatchObject({compatible:false,minimumVersion:"0.8.19"});
    expect((await app.inject({method:"GET",url:"/v1/compatibility",headers:current})).json()).toMatchObject({compatible:true,updateAvailable:true,serverVersion:SERVER_VERSION,serverProtocol:7,serverCapabilities:expect.arrayContaining(["readable-generation-v1","external-delete-proof-v1","folder-manifest-v1","folder-manifest-migration-v2","folder-provenance-repair-v1","folder-retirement-directive-v1","snapshot-integrity-v1","atomic-head-commit-v1","server-containment-v1","vault-retirement-v1"])});
    expect((await app.inject({method:"GET",url:"/v1/head",headers:current})).statusCode).toBe(200);
    const status=(await app.inject({method:"GET",url:"/v1/status",headers:current})).json();expect(status.devices.find((device:any)=>device.current)).toMatchObject({clientVersion:"0.8.19",clientProtocol:7,compatibility:"update-available"});await app.close();
  });
  it("pauses every non-allowed vault without revoking devices and resumes cleanly",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const allowed=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Allowed desktop","/Obsidian/Allowed")})).json();
    const blocked=(await app.inject({method:"POST",url:"/v1/setup",payload:{...setupPayload("Blocked phone","/Obsidian/Blocked"),vaultName:"Blocked"}})).json();
    const allowedAuth={authorization:`Bearer ${allowed.deviceToken}`},blockedAuth={authorization:`Bearer ${blocked.deviceToken}`};
    const controls=new ContainmentService(store);controls.enable(allowed.vaultId,"Incident containment test");
    expect((await app.inject({method:"GET",url:"/healthz"})).json()).toMatchObject({containmentActive:true});
    expect((await app.inject({method:"GET",url:"/v1/head",headers:allowedAuth})).statusCode).toBe(200);
    const status=await app.inject({method:"GET",url:"/v1/status",headers:blockedAuth});expect(status.statusCode).toBe(200);expect(status.json().containment).toMatchObject({active:true,thisVaultAllowed:false,reason:"Incident containment test"});
    const paused=await app.inject({method:"GET",url:"/v1/head",headers:blockedAuth});expect(paused.statusCode).toBe(423);expect(paused.json()).toMatchObject({containment:{active:true,thisVaultAllowed:false}});
    expect((await app.inject({method:"GET",url:"/v1/watch?head=",headers:blockedAuth})).statusCode).toBe(423);
    expect((await app.inject({method:"POST",url:"/v1/external/scan",headers:blockedAuth,payload:{}})).statusCode).toBe(423);
    storage.files.set(`read:${blocked.vaultId}:must-not-import.md`,Buffer.from("paused\n"));await new Promise((resolve)=>setTimeout(resolve,350));
    expect(store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",blocked.vaultId)?.head_id).toBeNull();
    controls.disable("Incident resolved");expect((await app.inject({method:"GET",url:"/v1/head",headers:blockedAuth})).statusCode).toBe(200);await app.close();
  });
  it("durably retires one obsolete registration without deleting its history or affecting another vault",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const obsolete=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Old phone","/Obsidian/Old")})).json();
    const active=(await app.inject({method:"POST",url:"/v1/setup",payload:{...setupPayload("Current phone","/Obsidian/Current"),vaultName:"Current"}})).json();
    const obsoleteAuth={authorization:`Bearer ${obsolete.deviceToken}`},activeAuth={authorization:`Bearer ${active.deviceToken}`},retirements=new VaultRetirementService(store);
    const snapshotsBefore=store.one<{count:number}>("SELECT COUNT(*) count FROM snapshots WHERE vault_id=?",obsolete.vaultId)?.count??0;
    retirements.retire(obsolete.vaultId,"Abandoned duplicate setup");
    const blocked=await app.inject({method:"GET",url:"/v1/head",headers:obsoleteAuth});expect(blocked.statusCode).toBe(410);expect(blocked.json().message).toContain("retired");
    expect((await app.inject({method:"GET",url:"/v1/head",headers:activeAuth})).statusCode).toBe(200);
    expect(store.one<{count:number}>("SELECT COUNT(*) count FROM snapshots WHERE vault_id=?",obsolete.vaultId)?.count).toBe(snapshotsBefore);
    expect((await app.inject({method:"GET",url:"/healthz"})).json()).toMatchObject({vaults:2,activeVaults:1,retiredVaults:1});
    retirements.restore(obsolete.vaultId,"Recovery approved");expect((await app.inject({method:"GET",url:"/v1/head",headers:obsoleteAuth})).statusCode).toBe(200);await app.close();
  });
  it("serves authenticated integrity-checked clear content for low-memory mobile downloads",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`};
    const clear=Buffer.from("large mobile attachment"),hash=sha256(clear),encrypted=encryptVaultBlob(clear,setup.vaultKey,hash);
    await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:Buffer.from(encrypted)});
    const response=await app.inject({method:"GET",url:`/v1/content/${hash}`,headers:{...auth,origin:"app://obsidian.md"}});expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");expect(response.headers["x-content-sha256"]).toBe(hash);expect(response.headers["access-control-expose-headers"]).toContain("X-Content-SHA256");expect(response.rawPayload).toEqual(clear);
    expect((await app.inject({method:"GET",url:`/v1/content/${hash}`})).statusCode).toBe(401);await app.close();
  });
  it("enrolls, stores an encrypted blob, commits, pairs, and restores", async () => {
    const {config,store,storage} = fixture(); const app = await buildApp(config, store, storage as unknown as SeafileStorage);
    const discovery=await app.inject({method:"POST",url:"/v1/storage/discover",payload:{seafileUrl:"https://seafile.example.test",seafileUsername:"test@example.test",seafilePassword:"password"}});
    expect(discovery.statusCode).toBe(200);expect(discovery.json().libraries[0].name).toBe("Notes");
    const setup = await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")});
    expect(setup.statusCode).toBe(200); const credentials = setup.json(); const auth = {authorization:`Bearer ${credentials.deviceToken}`};
    const manualDevice=await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Manual mobile")});expect(manualDevice.statusCode).toBe(200);expect(manualDevice.json().vaultId).toBe(credentials.vaultId);
    const readable=Buffer.from("readable note\n");const hash=sha256(readable),blob=encryptedFixture(readable,Buffer.from(credentials.vaultKey,"base64url"),hash);
    expect((await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:blob})).statusCode).toBe(201);
    expect((await app.inject({method:"PUT",url:`/v1/blobs/${"b".repeat(64)}`,headers:{...auth,"content-type":"application/octet-stream"},payload:Buffer.from("corrupt")})).statusCode).toBe(422);
    const commit = await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Initial",entries:[{path:"note.md",hash,size:readable.length,mtime:1}],folders:["Empty","Projects/Empty"]}});
    expect(commit.statusCode).toBe(201); const committedState=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head;expect(committedState.entries[0].path).toBe("note.md");expect(committedState.folders).toEqual(["Empty","Projects/Empty"]);
    expect((await app.inject({method:"GET",url:"/v1/head",headers:auth})).json()).toEqual({headId:commit.json().id});
    const plan=await app.inject({method:"POST",url:"/v1/mirror/plan",headers:auth,payload:{snapshotId:commit.json().id,entries:commit.json().entries}});expect(plan.json()).toMatchObject({uploadPaths:[],deletePaths:[],serverManaged:true});
    expect((await app.inject({method:"POST",url:"/v1/mirror/plan",headers:auth,payload:{snapshotId:commit.json().id,entries:[]}})).statusCode).toBe(422);
    const mirrorPut=await app.inject({method:"PUT",url:"/v1/mirror/file?path=note.md",headers:{...auth,"content-type":"application/octet-stream","x-gib-sync-snapshot":commit.json().id,"x-gib-sync-hash":hash},payload:readable});expect(mirrorPut.statusCode).toBe(204);
    const resumedPlan=await app.inject({method:"POST",url:"/v1/mirror/plan",headers:auth,payload:{snapshotId:commit.json().id,entries:commit.json().entries}});expect(resumedPlan.json()).toMatchObject({uploadPaths:[],alreadyCurrent:true});
    expect((await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:commit.json().id}})).statusCode).toBe(200);expect(storage.dirs.has(`read:${credentials.vaultId}:Empty`)).toBe(true);expect(storage.dirs.has(`read:${credentials.vaultId}:Projects/Empty`)).toBe(true);
    const emptyProposal=await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:commit.json().id,message:"Delete",entries:[]}});expect(emptyProposal.statusCode).toBe(423);
    const emptyCommit=await app.inject({method:"POST",url:`/v1/quarantines/${emptyProposal.json().quarantine.id}/approve`,headers:auth,payload:{}});expect(emptyCommit.statusCode).toBe(201);
    const deletePlan=await app.inject({method:"POST",url:"/v1/mirror/plan",headers:auth,payload:{snapshotId:emptyCommit.json().id,entries:[]}});expect([[],["note.md"]]).toContainEqual(deletePlan.json().deletePaths);
    expect((await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:emptyCommit.json().id}})).statusCode).toBe(200);expect(storage.files.has(`read:${credentials.vaultId}:note.md`)).toBe(false);expect(storage.dirs.has(`read:${credentials.vaultId}:Empty`)).toBe(false);expect(storage.dirs.has(`read:${credentials.vaultId}:Projects/Empty`)).toBe(false);
    const pairing=(await app.inject({method:"POST",url:"/v1/pairings",headers:auth,payload:{requireConfirmation:true}})).json();expect(pairing.code).toMatch(/^\d{5}$/);expect(Date.parse(pairing.expiresAt)-Date.now()).toBeLessThanOrEqual(60_000);
    const wrongCode=((Number(pairing.code)+1)%100_000).toString().padStart(5,"0");expect((await app.inject({method:"POST",url:"/v1/pairings/claim-code",payload:{code:wrongCode,deviceName:"Intruder"}})).statusCode).toBe(410);
    const claim=await app.inject({method:"POST",url:"/v1/pairings/claim-code",payload:{code:pairing.code,deviceName:"Mobile"}});
    expect(claim.statusCode).toBe(202);const pendingClaim=claim.json();expect(pendingClaim.envelope).toBeUndefined();
    expect((await app.inject({method:"POST",url:`/v1/pairings/requests/${pendingClaim.claimId}/decision`,headers:auth,payload:{approved:true}})).statusCode).toBe(200);
    const claimed=(await app.inject({method:"POST",url:"/v1/pairings/poll",payload:{ticket:pendingClaim.ticket}})).json();expect(claimed.envelope).toBeTypeOf("string");
    expect(openJson<any>(claimed.envelope,pendingClaim.ticket,`pairing:${claimed.pairingId}`)).toMatchObject({vaultId:credentials.vaultId,deviceToken:expect.any(String)});
    expect((await app.inject({method:"POST",url:"/v1/pairings/claim-code",payload:{code:pairing.code,deviceName:"Other"}})).statusCode).toBe(410);
    const preview=(await app.inject({method:"GET",url:`/v1/restore/${commit.json().id}/preview`,headers:auth})).json();
    expect((await app.inject({method:"POST",url:`/v1/restore/${commit.json().id}`,headers:auth,payload:{confirmToken:preview.confirmToken}})).statusCode).toBe(201);
    const status=await app.inject({method:"GET",url:"/v1/status",headers:auth});expect(status.statusCode).toBe(200);expect(status.json().deviceCount).toBe(3);expect(status.json().storage.basePath).toBe("/Obsidian/Test");expect(status.json().mirrorCurrent).toBe(false);
    await app.close();
  });
  it("restores selected historical files without rolling back unrelated current work",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`},key=Buffer.from(setup.vaultKey,"base64url");
    const content=[Buffer.from("A old\n"),Buffer.from("B old\n"),Buffer.from("B current\n"),Buffer.from("C current\n")],hashes=content.map((bytes)=>sha256(bytes));
    for(let index=0;index<content.length;index++)await app.inject({method:"PUT",url:`/v1/blobs/${hashes[index]}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(content[index],key,hashes[index])});
    const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Known good",entries:[{path:"A.md",hash:hashes[0],size:content[0].length,mtime:1},{path:"B.md",hash:hashes[1],size:content[1].length,mtime:1}]}})).json();
    const second=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Current work",entries:[{path:"B.md",hash:hashes[2],size:content[2].length,mtime:2},{path:"C.md",hash:hashes[3],size:content[3].length,mtime:2}]}})).json();expect(second.id).toEqual(expect.any(String));
    const plan=(await app.inject({method:"GET",url:`/v1/restore/${first.id}/changes`,headers:auth})).json(),selected=plan.changes.filter((change:any)=>change.path==="A.md"||change.path==="B.md").map((change:any)=>change.id);expect(selected).toHaveLength(2);
    const preview=(await app.inject({method:"POST",url:`/v1/restore/${first.id}/paths/preview`,headers:auth,payload:{changeIds:selected}})).json();expect(preview).toMatchObject({selectedChanges:2,assessment:{created:1,modified:1,deleted:0}});
    const restored=await app.inject({method:"POST",url:`/v1/restore/${first.id}/paths`,headers:auth,payload:{changeIds:selected,confirmToken:preview.confirmToken}});expect(restored.statusCode).toBe(201);
    expect(restored.json().entries).toMatchObject([{path:"A.md",hash:hashes[0],size:content[0].length,mtime:1},{path:"B.md",hash:hashes[1],size:content[1].length,mtime:1},{path:"C.md",hash:hashes[3],size:content[3].length,mtime:2}]);await app.close();
  });
  it("preserves the authoritative folder baseline when restoring a legacy file snapshot",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`};
    const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Legacy files",entries:[],folders:[]}})).json(),legacy={...first};delete legacy.folders;store.run("UPDATE snapshots SET manifest_json=? WHERE id=?",JSON.stringify(legacy),first.id);
    const current=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Folder baseline",entries:[],folders:["Keep empty"]}})).json();expect(current.folders).toEqual(["Keep empty"]);
    const preview=(await app.inject({method:"GET",url:`/v1/restore/${first.id}/preview`,headers:auth})).json(),restored=await app.inject({method:"POST",url:`/v1/restore/${first.id}`,headers:auth,payload:{confirmToken:preview.confirmToken}});
    expect(restored.statusCode).toBe(201);expect(restored.json().folders).toEqual(["Keep empty"]);await app.close();
  });
  it("carries a verified folder retirement directive through later device commits",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`};
    const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Initial",entries:[],folders:[]}})).json(),manifest=store.getSnapshot(first.id)!;
    manifest.folderRepair={retiredFolders:["Stale"],observedAt:new Date().toISOString(),originSnapshotIds:[randomUUID()]};store.run("UPDATE snapshots SET manifest_json=? WHERE id=?",JSON.stringify(manifest),first.id);
    const second=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Later sync",entries:[],folders:["New"]}})).json();
    expect(second.folderRepair).toEqual({...manifest.folderRepair,issuedAt:first.createdAt});await app.close();
  });
  it("rejects a stale compare-and-swap commit", async () => {
    const {config,store,storage} = fixture(); const app = await buildApp(config, store, storage as unknown as SeafileStorage);
    const credentials = (await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("A")})).json();
    const auth = {authorization:`Bearer ${credentials.deviceToken}`};
    const first = await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"One",entries:[]}}); expect(first.statusCode).toBe(201);
    const stale = await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Stale",entries:[]}}); expect(stale.statusCode).toBe(409);
    await app.close();
  });
  it("repairs a dirty readable mirror from the accepted snapshot and dismisses held proposals",async()=>{
    // Deliberately damaged tracked state is the fixture, not a new external
    // user edit. Keep periodic import timers out of this explicit repair test.
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval"]});
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const credentials=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${credentials.deviceToken}`};
    const clear=Buffer.from("accepted note\n"),hash=sha256(clear),encrypted=encryptVaultBlob(clear,credentials.vaultKey,hash);
    await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:Buffer.from(encrypted)});
    const commit=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Accepted",entries:[{path:"note.md",hash,size:clear.length,mtime:1}]}})).json();
    const held=await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:commit.id,message:"Bad empty proposal",entries:[]}});expect(held.statusCode).toBe(423);
    storage.files.set(`read:${credentials.vaultId}:obsolete.tmp`,Buffer.from("obsolete"));store.run("INSERT INTO mirror_entries(vault_id,path,hash,size,updated_at) VALUES(?,?,?,?,?)",credentials.vaultId,"obsolete.tmp",sha256(Buffer.from("obsolete")),8,new Date().toISOString());
    const repaired=await app.inject({method:"POST",url:"/v1/health/repair",headers:auth,payload:{restoreAcceptedHead:true}});expect(repaired.statusCode).toBe(200);expect(repaired.json()).toMatchObject({headId:commit.id,mirrorCurrent:true,restoredFiles:1,removedFiles:1,removedConflictCopies:0,dismissedQuarantines:1});
    expect(Array.from(storage.files.get(`read:${credentials.vaultId}:note.md`)??[])).toEqual(Array.from(clear));expect(storage.files.has(`read:${credentials.vaultId}:obsolete.tmp`)).toBe(false);expect((await app.inject({method:"GET",url:"/v1/quarantines",headers:auth})).json()).toEqual([]);
    await app.close();
  });
  it("cleans only redundant generated conflict storms when the intact original is present",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const credentials=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${credentials.deviceToken}`};
    const clear=Buffer.from("intact note\n"),hash=sha256(clear),encrypted=encryptVaultBlob(clear,credentials.vaultKey,hash),unique=Buffer.from("unique conflict content\n"),uniqueHash=sha256(unique),uniqueEncrypted=encryptVaultBlob(unique,credentials.vaultKey,uniqueHash);
    await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:Buffer.from(encrypted)});
    await app.inject({method:"PUT",url:`/v1/blobs/${uniqueHash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:Buffer.from(uniqueEncrypted)});
    const paths=["note.md","note (conflict - Phone - 2026-07-26 16-46-00 UTC).md","note (conflict - Seafile - 2026-07-26 16-46-01 UTC - 2).md","note (conflict - Desktop - 2026-07-26 16-46-02 UTC - 3).md"];
    const uniquePath="note (conflict - Laptop - 2026-07-26 16-46-03 UTC - 4).md",commit=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"False conflict storm",entries:[...paths.map((path)=>({path,hash,size:clear.length,mtime:1})),{path:uniquePath,hash:uniqueHash,size:unique.length,mtime:2}]}})).json();
    const repaired=await app.inject({method:"POST",url:"/v1/health/repair",headers:auth,payload:{restoreAcceptedHead:true}});expect(repaired.statusCode).toBe(200);
    expect(repaired.json()).toMatchObject({headId:expect.any(String),mirrorCurrent:true,restoredFiles:2,removedConflictCopies:3});expect(repaired.json().headId).not.toBe(commit.id);
    const state=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json();expect(state.head.entries.map((entry:{path:string})=>entry.path)).toEqual([uniquePath,"note.md"]);
    expect(store.getSnapshot(commit.id)?.entries).toHaveLength(5);
    await app.close();
  });
  it("returns stale watches immediately and wakes current watches when the vault head changes",async()=>{
    const {config,store,storage}=fixture();const app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const credentials=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json();const auth={authorization:`Bearer ${credentials.deviceToken}`};
    const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"One",entries:[]}})).json();
    const stale=await app.inject({method:"GET",url:"/v1/watch?head=",headers:auth});expect(stale.json()).toEqual({changed:true,headId:first.id});
    const waiting=app.inject({method:"GET",url:`/v1/watch?head=${first.id}`,headers:auth});
    await new Promise((resolve)=>setTimeout(resolve,10));
    const second=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Two",entries:[]}})).json();
    const notified=await waiting;expect(notified.statusCode).toBe(200);expect(notified.json()).toEqual({changed:true,headId:second.id});
    await app.close();
  });
  it("imports externally created and deleted readable Seafile files as snapshots",async()=>{
    const {config,store,storage}=fixture();const app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const credentials=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json();const auth={authorization:`Bearer ${credentials.deviceToken}`};
    const external=Buffer.from("# Edited in Seafile\n");storage.files.set(`read:${credentials.vaultId}:external.md`,external);
    const imported=await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}});
    expect(imported.statusCode).toBe(200);expect(imported.json()).toMatchObject({snapshotId:expect.any(String),changedFiles:1,deletedFiles:0});
    let state=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json();expect(state.head.deviceName).toBe("Seafile");expect(state.head.entries).toMatchObject([{path:"external.md",hash:sha256(external)}]);
    expect((await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:state.head.id}})).statusCode).toBe(200);
    storage.files.delete(`read:${credentials.vaultId}:external.md`);
    const deferred=await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}});expect(deferred.json()).toMatchObject({snapshotId:null,deletedFiles:0,deferredDeletions:1});
    store.run("UPDATE external_absences SET first_seen_at=? WHERE vault_id=?",new Date(Date.now()-60_000).toISOString(),credentials.vaultId);
    const deleted=await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}});
    expect(deleted.json()).toMatchObject({snapshotId:null,changedFiles:0,deletedFiles:1,quarantineId:expect.any(String)});
    state=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json();expect(state.head.entries).toHaveLength(1);
    expect((await app.inject({method:"POST",url:`/v1/quarantines/${deleted.json().quarantineId}/approve`,headers:auth,payload:{}})).statusCode).toBe(201);
    state=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json();expect(state.head.entries).toEqual([]);
    await app.close();
  });
  it("imports empty folder additions and removals from the readable Seafile vault",async()=>{
    const {config,store,storage}=fixture();const app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const credentials=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${credentials.deviceToken}`};
    const initial=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Empty baseline",entries:[],folders:[]}})).json();expect((await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:initial.id}})).statusCode).toBe(200);
    storage.dirs.add(`read:${credentials.vaultId}:New empty folder`);
    const added=(await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).json();if(added.snapshotId)expect(added).toMatchObject({snapshotId:expect.any(String),changedFolders:1});
    let state=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json();expect(state.head.folders).toEqual(["New empty folder"]);expect((await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:state.head.id}})).statusCode).toBe(200);
    storage.dirs.delete(`read:${credentials.vaultId}:New empty folder`);
    const removed=(await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).json();if(removed.snapshotId)expect(removed).toMatchObject({snapshotId:expect.any(String),changedFolders:1});
    state=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json();expect(state.head.folders).toEqual([]);await app.close();
  });
  it("does not promote stale readable folders while a legacy vault awaits a trusted folder manifest",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`};
    const initial=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Legacy baseline",entries:[],folders:[]}})).json();
    expect((await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:initial.id}})).statusCode).toBe(200);
    const legacy={...initial};delete legacy.folders;store.run("UPDATE snapshots SET manifest_json=? WHERE id=?",JSON.stringify(legacy),initial.id);
    storage.dirs.add(`read:${setup.vaultId}:Stale legacy shell`);
    const folderOnly=(await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).json();expect(folderOnly).toMatchObject({snapshotId:null,changedFiles:0});expect(folderOnly.changedFolders).toBeUndefined();
    const external=Buffer.from("external edit\n");storage.files.set(`read:${setup.vaultId}:external.md`,external);
    const imported=(await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).json();expect(imported).toMatchObject({snapshotId:expect.any(String),changedFiles:1,changedFolders:0});
    const legacyDerived=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head;expect(legacyDerived.folders).toBeUndefined();expect((await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:legacyDerived.id}})).statusCode).toBe(200);
    const trusted=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:legacyDerived.id,message:"Trusted folder baseline",entries:legacyDerived.entries,folders:["Trusted empty"]}})).json();
    expect((await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:trusted.id}})).statusCode).toBe(200);expect(storage.dirs.has(`read:${setup.vaultId}:Stale legacy shell`)).toBe(false);expect(storage.dirs.has(`read:${setup.vaultId}:Trusted empty`)).toBe(true);
    storage.dirs.add(`read:${setup.vaultId}:Remote empty`);
    try{
      // The background scanner may accept the change before the explicit scan
      // returns. Verify the committed result, not which request won the race.
      let importedHead:any;
      for(let attempt=0;attempt<10;attempt++){
        await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}});
        importedHead=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head;
        if(importedHead.folders?.includes("Remote empty"))break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      expect(importedHead).toMatchObject({parentId:trusted.id,deviceId:`seafile:${setup.vaultId}`,folders:["Remote empty","Trusted empty"]});
      expect(importedHead.message).toContain("1 folders");
    }finally{await app.close();}
  });
  it.each(["explicit", "automatic"] as const)("three-way merges simultaneous Obsidian and Seafile text edits (%s scan wins)",async(winner)=>{
    // The real startup scanner fires at 250ms. Control its schedule rather
    // than assume the explicit HTTP request finishes first on every platform.
    // Durable SQLite due_at uses Date.now. Faking timers alone lets a wake-up
    // run before that real-clock deadline, so the guarded lease cannot start.
    vi.useFakeTimers({toFake:["Date","setTimeout","clearTimeout","setInterval","clearInterval"]});
    const {config,store,storage}=fixture();const app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const credentials=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json();const auth={authorization:`Bearer ${credentials.deviceToken}`},key=Buffer.from(credentials.vaultKey,"base64url");
    const base=Buffer.from("a\nb\nc\n"),baseHash=sha256(base);
    await app.inject({method:"PUT",url:`/v1/blobs/${baseHash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(base,key,baseHash)});
    const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Base",entries:[{path:"note.md",hash:baseHash,size:base.length,mtime:1}]}})).json();
    await app.inject({method:"PUT",url:"/v1/mirror/file?path=note.md",headers:{...auth,"content-type":"application/octet-stream","x-gib-sync-snapshot":first.id,"x-gib-sync-hash":baseHash},payload:base});
    await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:first.id}});
    const obsidian=Buffer.from("A\nb\nc\n"),obsidianHash=sha256(obsidian);
    await app.inject({method:"PUT",url:`/v1/blobs/${obsidianHash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(obsidian,key,obsidianHash)});
    const second=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Obsidian",entries:[{path:"note.md",hash:obsidianHash,size:obsidian.length,mtime:2}]}})).json();
    const seafile=Buffer.from("a\nb\nC\n");storage.files.set(`read:${credentials.vaultId}:note.md`,seafile);
    const merged=Buffer.from("A\nb\nC\n"),mergedHash=sha256(merged);
    let automaticHead:any;
    if(winner==="automatic"){
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(async()=>{automaticHead=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head;expect(automaticHead).toMatchObject({parentId:second.id,deviceId:`seafile:${credentials.vaultId}`,entries:[{path:"note.md",hash:mergedHash,size:merged.length}]});expect(store.one<{mirror_head_id:string}>("SELECT mirror_head_id FROM vaults WHERE id=?",credentials.vaultId)?.mirror_head_id).toBe(automaticHead.id);},{timeout:5000,interval:25});
    }
    const response=await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}});expect(response.statusCode).toBe(200);const imported=response.json();
    expect(imported).toMatchObject(winner==="explicit"?{snapshotId:expect.any(String),changedFiles:1,deletedFiles:0,conflicts:0}:{snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0});
    const head=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head;
    expect(head).toMatchObject({id:winner==="explicit"?imported.snapshotId:automaticHead.id,parentId:second.id,deviceId:`seafile:${credentials.vaultId}`,entries:[{path:"note.md",hash:mergedHash,size:merged.length,fileId:first.entries[0].fileId}]});
    expect(head.entries).toHaveLength(1);expect(store.one<{count:number}>("SELECT COUNT(*) count FROM snapshots WHERE vault_id=?",credentials.vaultId)?.count).toBe(3);
    const entry=head.entries[0],encrypted=storage.files.get(`${credentials.vaultId}:blobs/${entry.hash.slice(0,2)}/${entry.hash}.gbs`)!;
    expect(Buffer.from(decryptVaultBlob(encrypted,credentials.vaultKey,entry.hash))).toEqual(merged);
    expect((await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:head.id}})).statusCode).toBe(200);
    expect(storage.files.get(`read:${credentials.vaultId}:note.md`)).toEqual(merged);
    expect(store.one("SELECT head_id,mirror_head_id,mirror_generation_id FROM vaults WHERE id=?",credentials.vaultId)).toMatchObject({head_id:head.id,mirror_head_id:head.id,mirror_generation_id:head.id});
    expect((await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).json()).toMatchObject({snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0});
    expect(store.one<{count:number}>("SELECT COUNT(*) count FROM snapshots WHERE vault_id=?",credentials.vaultId)?.count).toBe(3);
    await app.close();
  },30_000);
  it("bifurcates large Obsidian and Seafile rewrites with reciprocal warning links",async()=>{
    const {config,store,storage}=fixture();const app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const credentials=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json();const auth={authorization:`Bearer ${credentials.deviceToken}`},key=Buffer.from(credentials.vaultKey,"base64url");
    const base=Buffer.from("one\ntwo\nthree\n"),baseHash=sha256(base);
    await app.inject({method:"PUT",url:`/v1/blobs/${baseHash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(base,key,baseHash)});
    const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Base",entries:[{path:"Rewrite.md",hash:baseHash,size:base.length,mtime:1}]}})).json();
    await app.inject({method:"PUT",url:"/v1/mirror/file?path=Rewrite.md",headers:{...auth,"content-type":"application/octet-stream","x-gib-sync-snapshot":first.id,"x-gib-sync-hash":baseHash},payload:base});
    await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:first.id}});
    const desktop=Buffer.from("desktop one\ndesktop two\ndesktop three\n"),desktopHash=sha256(desktop);
    await app.inject({method:"PUT",url:`/v1/blobs/${desktopHash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(desktop,key,desktopHash)});
    await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Desktop rewrite",entries:[{path:"Rewrite.md",hash:desktopHash,size:desktop.length,mtime:2}]}});
    storage.files.set(`read:${credentials.vaultId}:Rewrite.md`,Buffer.from("seafile one\nseafile two\nseafile three\n"));
    const imported=(await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).json();expect(imported.conflicts).toBe(1);
    const entries=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head.entries;expect(entries).toHaveLength(2);
    const original=entries.find((entry:any)=>entry.path==="Rewrite.md"),copy=entries.find((entry:any)=>entry.path!=="Rewrite.md");expect(copy.path).toContain("conflict - Desktop");
    const clear=async(entry:any)=>Buffer.from(decryptVaultBlob(storage.files.get(`${credentials.vaultId}:blobs/${entry.hash.slice(0,2)}/${entry.hash}.gbs`)!,credentials.vaultKey,entry.hash)).toString();
    expect(await clear(original)).toContain(`[[${copy.path.slice(0,-3)}`);expect(await clear(copy)).toContain("[[Rewrite|Rewrite.md]]");
    await app.close();
  });
  it("preserves an Obsidian edit with a warning when Seafile deletes the same note",async()=>{
    const {config,store,storage}=fixture();const app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const credentials=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${credentials.deviceToken}`},key=Buffer.from(credentials.vaultKey,"base64url");
    const base=Buffer.from("base\n"),baseHash=sha256(base);await app.inject({method:"PUT",url:`/v1/blobs/${baseHash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(base,key,baseHash)});
    const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Base",entries:[{path:"Delete.md",hash:baseHash,size:base.length,mtime:1}]}})).json();
    await app.inject({method:"PUT",url:"/v1/mirror/file?path=Delete.md",headers:{...auth,"content-type":"application/octet-stream","x-gib-sync-snapshot":first.id,"x-gib-sync-hash":baseHash},payload:base});
    await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:first.id}});
    const edited=Buffer.from("desktop edit\n"),editedHash=sha256(edited);await app.inject({method:"PUT",url:`/v1/blobs/${editedHash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(edited,key,editedHash)});
    await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Edit",entries:[{path:"Delete.md",hash:editedHash,size:edited.length,mtime:2}]}});
    storage.files.delete(`read:${credentials.vaultId}:Delete.md`);
    expect((await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).json()).toMatchObject({deferredDeletions:1,conflicts:0});
    store.run("UPDATE external_absences SET first_seen_at=? WHERE vault_id=?",new Date(Date.now()-60_000).toISOString(),credentials.vaultId);
    await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}});
    const entry=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head.entries[0],clear=Buffer.from(decryptVaultBlob(storage.files.get(`${credentials.vaultId}:blobs/${entry.hash.slice(0,2)}/${entry.hash}.gbs`)!,credentials.vaultKey,entry.hash)).toString();
    expect(clear).toContain("[!warning] Gib Sync deletion conflict");expect(clear).toContain("desktop edit");
    await app.close();
  });
  it("expires rolling codes after 60 seconds and throttles five-digit guesses",async()=>{
    const {config,store,storage}=fixture();const app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const credentials=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json();const auth={authorization:`Bearer ${credentials.deviceToken}`};
    const pairing=(await app.inject({method:"POST",url:"/v1/pairings",headers:auth,payload:{requireConfirmation:true}})).json();expect(pairing.code).toMatch(/^\d{5}$/);
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
    await vi.waitFor(()=>{expect(Buffer.from(storage.files.get(`read:${id}:folder/note.md`)??[])).toEqual(clear);expect(store.one<any>("SELECT mirror_head_id,mirror_base_path FROM vaults WHERE id=?",id)).toMatchObject({mirror_head_id:snapshotId,mirror_base_path:"/Obsidian/Recovery"});},{timeout:5000});await app.close();
  });
  it("repairs unsafe legacy folder provenance through an immutable descendant snapshot",async()=>{
    const {config,store,storage}=fixture(),vaultId=randomUUID(),parentId=randomUUID(),seedId=randomUUID(),headId=randomUUID(),now=new Date().toISOString();
    const parent={id:parentId,vaultId,parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:now,message:"Legacy",entries:[]};
    const seed={...parent,id:seedId,parentId:parentId,deviceId:`seafile:${vaultId}`,deviceName:"Seafile",message:"Folder seed",folders:["A","B","C"]};
    const head={...seed,id:headId,parentId:seedId,deviceId:"desktop",deviceName:"Desktop",message:"Sync",folders:["A","Keep"]};
    store.run("INSERT INTO vaults(id,name,wrapped_key,head_id,created_at,storage_url,storage_username,storage_repo_id,storage_repo_name,storage_base_path,storage_token,storage_layout,mirror_base_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",vaultId,"Migration repair",sealJson(Buffer.alloc(32,7).toString("base64url"),config.GIBSYNC_SERVER_SECRET,vaultId),headId,now,"https://seafile.example.test","test@example.test","library-1","Notes","/","token","legacy","/Obsidian/Migration repair");
    for(const snapshot of [parent,seed,head])store.run("INSERT INTO snapshots(id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?,?)",snapshot.id,vaultId,snapshot.parentId,snapshot.deviceId,snapshot.deviceName,snapshot.createdAt,snapshot.message,JSON.stringify(snapshot));
    const app=await buildApp(config,store,storage as unknown as SeafileStorage);await app.ready();const repairedId=store.one<{head_id:string}>("SELECT head_id FROM vaults WHERE id=?",vaultId)!.head_id,repaired=store.getSnapshot(repairedId)!;
    expect(repaired.id).not.toBe(headId);expect(repaired.parentId).toBe(headId);expect(repaired.entries).toEqual([]);expect(repaired.folders).toEqual(["Keep"]);expect(repaired.deviceId).toBe("server:folder-provenance-repair");expect(store.getSnapshot(seedId)?.folders).toEqual(["A","B","C"]);await app.close();
  });
  it("materializes a retirement directive as an operation-backed descendant of an unsafe direct head",async()=>{
    const {config,store,storage}=fixture(),vaultId=randomUUID(),parentId=randomUUID(),seedId=randomUUID(),now=new Date().toISOString();
    const parent={id:parentId,vaultId,parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:now,message:"Legacy",entries:[]};
    const seed={...parent,id:seedId,parentId,deviceId:`seafile:${vaultId}`,deviceName:"Seafile",message:"Folder seed",folders:["Stale A","Stale B"]};
    store.run("INSERT INTO vaults(id,name,wrapped_key,head_id,created_at,storage_url,storage_username,storage_repo_id,storage_repo_name,storage_base_path,storage_token,storage_layout,mirror_base_path,mirror_head_id,mirror_generation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",vaultId,"Retired seed",sealJson(Buffer.alloc(32,7).toString("base64url"),config.GIBSYNC_SERVER_SECRET,vaultId),seedId,now,"https://seafile.example.test","test@example.test","library-1","Notes","/","token","legacy","/Obsidian/Retired seed",seedId,seedId);
    for(const snapshot of [parent,seed])store.run("INSERT INTO snapshots(id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?,?)",snapshot.id,vaultId,snapshot.parentId,snapshot.deviceId,snapshot.deviceName,snapshot.createdAt,snapshot.message,JSON.stringify(snapshot));
    storage.dirs.add(`read:${vaultId}:Stale A`);storage.dirs.add(`read:${vaultId}:Stale B`);
    const app=await buildApp(config,store,storage as unknown as SeafileStorage);await app.ready();const repairedId=store.one<{head_id:string}>("SELECT head_id FROM vaults WHERE id=?",vaultId)!.head_id,repaired=store.getSnapshot(repairedId)!;
    await vi.waitFor(()=>expect(store.one<{mirror_head_id:string}>("SELECT mirror_head_id FROM vaults WHERE id=?",vaultId)?.mirror_head_id).toBe(repairedId),{timeout:1000});
    expect(repaired.parentId).toBe(seedId);expect(repaired.folders).toEqual([]);expect(repaired.folderRepair).toMatchObject({retiredFolders:["Stale A","Stale B"],originSnapshotIds:[seedId]});expect(storage.dirs.has(`read:${vaultId}:Stale A`)).toBe(false);expect(store.getSnapshot(seedId)?.folders).toEqual(["Stale A","Stale B"]);expect(store.one("SELECT snapshot_id FROM sync_vault_state WHERE vault_id=?",vaultId)).toMatchObject({snapshot_id:repaired.id});await app.close();
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
  it("records approval provenance without trusting a later destructive change",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`};
    const clear=Buffer.from("shared\n"),hash=sha256(clear),key=Buffer.from(setup.vaultKey,"base64url");await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(clear,key,hash)});
    const entries=Array.from({length:20},(_,index)=>({path:`Folder/note-${index}.md`,hash,size:clear.length,mtime:1}));
    const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Initial",entries}})).json();
    const proposal=await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Bulk delete",entries:entries.slice(0,10),clientTime:new Date().toISOString()}});
    expect(proposal.statusCode).toBe(423);expect(proposal.json().quarantine.assessment).toMatchObject({deleted:10});
    expect((await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head.id).toBe(first.id);
    const held=(await app.inject({method:"GET",url:"/v1/quarantines",headers:auth})).json();expect(held).toHaveLength(1);
    expect((await app.inject({method:"POST",url:`/v1/quarantines/${held[0].id}/approve`,headers:auth,payload:{trustMinutes:15}})).statusCode).toBe(400);
    const approved=await app.inject({method:"POST",url:`/v1/quarantines/${held[0].id}/approve`,headers:auth,payload:{}});
    expect(approved.statusCode).toBe(201);expect(approved.json().entries).toHaveLength(10);
    const audit=store.one<any>("SELECT resolution_kind,resolution_context_json FROM quarantines WHERE id=?",held[0].id);expect(audit).toMatchObject({resolution_kind:"manual_once"});expect(JSON.parse(audit.resolution_context_json)).toMatchObject({approvedByDeviceName:"Desktop",trustMinutes:0,source:"device"});expect(approved.json().message).toContain("manual one-time approval by Desktop");
    const trusted=await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:approved.json().id,message:"Trusted delete",entries:[]}});
    expect(trusted.statusCode).toBe(423);await app.close();
  });
  it("retires obsolete warning proposals when a newer safe sync is accepted",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Phone")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`};
    const clear=Buffer.from("shared\n"),hash=sha256(clear),key=Buffer.from(setup.vaultKey,"base64url");await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(clear,key,hash)});
    const entries=Array.from({length:20},(_,index)=>({path:`Folder/note-${index}.md`,hash,size:clear.length,mtime:1}));
    const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Initial",entries}})).json();
    const held=await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Bulk delete",entries:entries.slice(10)}});expect(held.statusCode).toBe(423);
    const accepted=await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Ordinary addition",entries:[...entries,{path:"Folder/new.md",hash,size:clear.length,mtime:2}]}});expect(accepted.statusCode).toBe(201);
    expect((await app.inject({method:"GET",url:"/v1/quarantines",headers:auth})).json()).toEqual([]);await app.close();
  });
  it("allows an explicit device-scoped maintenance session and lets it end early",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`};
    const started=await app.inject({method:"POST",url:"/v1/safeguards/maintenance",headers:auth,payload:{minutes:60}});expect(started.statusCode).toBe(200);expect(started.json().trustedUntil).toEqual(expect.any(String));
    const ended=await app.inject({method:"POST",url:"/v1/safeguards/maintenance",headers:auth,payload:{minutes:0}});expect(ended.statusCode).toBe(200);expect(ended.json().trustedUntil).toBeNull();
    await app.close();
  });
  it("quarantines mass deletion from Seafile and wakes watchers for immediate review",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`};
    const clear=Buffer.from("shared\n"),hash=sha256(clear),key=Buffer.from(setup.vaultKey,"base64url");await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(clear,key,hash)});
    const entries=Array.from({length:20},(_,index)=>({path:`Folder/note-${index}.md`,hash,size:clear.length,mtime:1}));
    const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Initial",entries}})).json();
    for(const entry of entries)await app.inject({method:"PUT",url:`/v1/mirror/file?path=${encodeURIComponent(entry.path)}`,headers:{...auth,"content-type":"application/octet-stream","x-gib-sync-snapshot":first.id,"x-gib-sync-hash":hash},payload:clear});
    expect((await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:first.id}})).statusCode).toBe(200);for(const entry of entries.slice(0,10))storage.files.delete(`read:${setup.vaultId}:${entry.path}`);
    expect((await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).json()).toMatchObject({snapshotId:null,deletedFiles:0,deferredDeletions:10});
    store.run("UPDATE external_absences SET first_seen_at=? WHERE vault_id=?",new Date(Date.now()-60_000).toISOString(),setup.vaultId);
    const waiting=app.inject({method:"GET",url:`/v1/watch?head=${first.id}`,headers:auth});await new Promise((resolve)=>setTimeout(resolve,10));
    const scan=await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}});expect(scan.json()).toMatchObject({snapshotId:null,deletedFiles:10,quarantineId:expect.any(String)});
    expect((await waiting).json()).toEqual({changed:true,headId:first.id,attention:true});expect((await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head.id).toBe(first.id);
    const held=(await app.inject({method:"GET",url:"/v1/quarantines",headers:auth})).json();expect(held).toHaveLength(1);expect(held[0]).toMatchObject({source:"seafile",assessment:{deleted:10}});
    expect((await app.inject({method:"POST",url:`/v1/quarantines/${held[0].id}/approve`,headers:auth,payload:{trustMinutes:15}})).statusCode).toBe(400);
    await app.close();
  });
  it("carries an Obsidian edit through a concurrent Seafile move without duplication",async()=>{
    const {config,store,storage}=fixture();const app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const credentials=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${credentials.deviceToken}`},key=Buffer.from(credentials.vaultKey,"base64url");
    const base=Buffer.from("base note\n"),baseHash=sha256(base);await app.inject({method:"PUT",url:`/v1/blobs/${baseHash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(base,key,baseHash)});
    const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Base",entries:[{path:"Old/note.md",hash:baseHash,size:base.length,mtime:1}]}})).json();
    await app.inject({method:"PUT",url:"/v1/mirror/file?path=Old%2Fnote.md",headers:{...auth,"content-type":"application/octet-stream","x-gib-sync-snapshot":first.id,"x-gib-sync-hash":baseHash},payload:base});await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:first.id}});
    const edited=Buffer.from("edited in Obsidian\n"),editedHash=sha256(edited);await app.inject({method:"PUT",url:`/v1/blobs/${editedHash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(edited,key,editedHash)});
    const second=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Edit",entries:[{path:"Old/note.md",hash:editedHash,size:edited.length,mtime:2}]}})).json();
    storage.files.delete(`read:${credentials.vaultId}:Old/note.md`);storage.files.set(`read:${credentials.vaultId}:New/note.md`,base);
    expect((await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).statusCode).toBe(200);
    const head=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head;expect(head.parentId).toBe(second.id);expect(head.entries).toMatchObject([{path:"New/note.md",hash:editedHash,size:edited.length,mtime:expect.any(Number)}]);expect(head.entries).toHaveLength(1);
    await app.close();
  });
  it("merges edits made on both sides while Seafile moves a folder",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),credentials=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${credentials.deviceToken}`},key=Buffer.from(credentials.vaultKey,"base64url");
    const base=Buffer.from("a\nb\nc\n"),local=Buffer.from("A\nb\nc\n"),external=Buffer.from("a\nb\nC\n"),baseHash=sha256(base),localHash=sha256(local);
    for(const [hash,clear] of [[baseHash,base],[localHash,local]] as const)await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(clear,key,hash)});
    const entries=Array.from({length:3},(_,index)=>({path:`Old/note-${index}.md`,hash:baseHash,size:base.length,mtime:1})),first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Base",entries}})).json();
    for(const entry of entries)await app.inject({method:"PUT",url:`/v1/mirror/file?path=${encodeURIComponent(entry.path)}`,headers:{...auth,"content-type":"application/octet-stream","x-gib-sync-snapshot":first.id,"x-gib-sync-hash":baseHash},payload:base});await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:first.id}});
    const secondEntries=entries.map((entry,index)=>index===0?{...entry,hash:localHash,size:local.length,mtime:2}:entry),second=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Obsidian edit",entries:secondEntries}})).json();
    for(let index=0;index<3;index++){storage.files.delete(`read:${credentials.vaultId}:Old/note-${index}.md`);storage.files.set(`read:${credentials.vaultId}:New/note-${index}.md`,index===0?external:base);}
    storage.explicitRenames=[{previousPath:"Old",path:"New"}];
    expect((await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).statusCode).toBe(200);
    const head=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head,target=head.entries.find((entry:any)=>entry.path==="New/note-0.md"),encrypted=storage.files.get(`${credentials.vaultId}:blobs/${target.hash.slice(0,2)}/${target.hash}.gbs`)!;expect(head.parentId).toBe(second.id);expect(Buffer.from(decryptVaultBlob(encrypted,credentials.vaultKey,target.hash)).toString()).toBe("A\nb\nC\n");expect(head.entries.some((entry:any)=>entry.path.startsWith("Old/"))).toBe(false);await app.close();
  });
  it("imports a genuine external edit after the server-owned projection completes",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`},key=Buffer.from(setup.vaultKey,"base64url");
    const original=Buffer.from("original\n"),created=Buffer.from("created in Obsidian\n"),external=Buffer.from("transient readable copy\n"),originalHash=sha256(original),createdHash=sha256(created);
    for(const [hash,clear] of [[originalHash,original],[createdHash,created]] as const)await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(clear,key,hash)});
    const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Initial",entries:[{path:"original.md",hash:originalHash,size:original.length,mtime:1}]}})).json();
    await app.inject({method:"PUT",url:"/v1/mirror/file?path=original.md",headers:{...auth,"content-type":"application/octet-stream","x-gib-sync-snapshot":first.id,"x-gib-sync-hash":originalHash},payload:original});await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:first.id}});
    const second=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Add note",entries:[...first.entries,{path:"new.md",hash:createdHash,size:created.length,mtime:2}]}})).json();await app.inject({method:"PUT",url:"/v1/mirror/file?path=new.md",headers:{...auth,"content-type":"application/octet-stream","x-gib-sync-snapshot":second.id,"x-gib-sync-hash":createdHash},payload:created});storage.files.set(`read:${setup.vaultId}:new.md`,external);
    expect((await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).statusCode).toBe(200);
    await vi.waitFor(async()=>{const head=(await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head;expect(head.id).not.toBe(second.id);expect(head.entries.find((entry:any)=>entry.path==="new.md")?.hash).toBe(sha256(external));expect(head.entries.filter((entry:any)=>entry.path.includes("conflict -"))).toHaveLength(0);},{timeout:7000,interval:50});await app.close();
  });
  it('keeps one file identity when a forced scan and a newer accepted head interrupt projection',async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const setup=(await app.inject({method:'POST',url:'/v1/setup',payload:setupPayload('Desktop')})).json(),auth={authorization:`Bearer ${setup.deviceToken}`},key=Buffer.from(setup.vaultKey,'base64url'),clear=Buffer.alloc(8192,19),hash=sha256(clear);
    expect((await app.inject({method:'PUT',url:`/v1/blobs/${hash}`,headers:{...auth,'content-type':'application/octet-stream'},payload:encryptedFixture(clear,key,hash)})).statusCode).toBe(201);
    const first=(await app.inject({method:'POST',url:'/v1/commit',headers:auth,payload:{parentId:null,message:'Initial',entries:[{path:'old.bin',hash,size:clear.length,mtime:1}],folders:[]}})).json();
    expect((await app.inject({method:'POST',url:'/v1/mirror/complete',headers:auth,payload:{snapshotId:first.id}})).statusCode).toBe(200);
    storage.blockReadableWrites=true;
    const second=(await app.inject({method:'POST',url:'/v1/commit',headers:auth,payload:{parentId:first.id,message:'New upload',entries:[...first.entries,{path:'upload.bin',hash,size:clear.length,mtime:2}],folders:[]}})).json();
    const writer=app.inject({method:'PUT',url:'/v1/mirror/file?path=upload.bin',headers:{...auth,'content-type':'application/octet-stream','x-gib-sync-snapshot':second.id,'x-gib-sync-hash':hash},payload:clear});
    const writing=Promise.resolve(writer);
    await vi.waitFor(()=>expect(store.one("SELECT 1 FROM mirror_mutations WHERE vault_id=? AND path='upload.bin' AND state='prepared'",setup.vaultId)).toBeDefined());
    const thirdResponse=await app.inject({method:'POST',url:'/v1/commit',headers:auth,payload:{parentId:second.id,message:'Another change on the same device',entries:second.entries,folders:['Empty']}});expect(thirdResponse.statusCode).toBe(201);const third=thirdResponse.json();
    const scan=Promise.resolve(app.inject({method:'POST',url:'/v1/external/scan',headers:auth,payload:{}}));
    await new Promise(resolve=>setTimeout(resolve,10));storage.unblockReadableWrites();
    expect((await writing).statusCode).toBe(409);expect((await scan).statusCode).toBe(200);
    await vi.waitFor(async()=>expect((await app.inject({method:'GET',url:'/v1/status',headers:auth})).json().mirrorCurrent).toBe(true),{timeout:7000,interval:50});
    for(let i=0;i<3;i++){const result=(await app.inject({method:'POST',url:'/v1/external/scan',headers:auth,payload:{}})).json();expect(result.conflicts).toBe(0);const head=(await app.inject({method:'GET',url:'/v1/state',headers:auth})).json().head;expect(head.id).toBe(third.id);expect(head.entries).toHaveLength(2);expect(head.entries.find((e:any)=>e.path==='upload.bin').fileId).toBe(second.entries.find((e:any)=>e.path==='upload.bin').fileId);}
    expect(store.one("SELECT 1 FROM mirror_mutations WHERE vault_id=? AND path='upload.bin' AND write_acknowledged=1 AND fence_commit IS NOT NULL AND state='captured'",setup.vaultId)).toBeDefined();
    await app.close();
  });
  it('repairs verified unchanged readable files without rewriting them or changing accepted identities',async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:'POST',url:'/v1/setup',payload:setupPayload('Desktop')})).json(),auth={authorization:`Bearer ${setup.deviceToken}`},clear=Buffer.from('unchanged complete content'),hash=sha256(clear);
    await app.inject({method:'PUT',url:`/v1/blobs/${hash}`,headers:{...auth,'content-type':'application/octet-stream'},payload:encryptedFixture(clear,Buffer.from(setup.vaultKey,'base64url'),hash)});
    const first=(await app.inject({method:'POST',url:'/v1/commit',headers:auth,payload:{parentId:null,message:'Initial',entries:[{path:'note.md',hash,size:clear.length,mtime:1}],folders:[]}})).json();
    expect((await app.inject({method:'POST',url:'/v1/mirror/complete',headers:auth,payload:{snapshotId:first.id}})).statusCode).toBe(200);
    const write=vi.spyOn(storage,'putReadable'),before=store.getSnapshot(first.id)!,result=await app.inject({method:'POST',url:'/v1/health/repair',headers:auth,payload:{restoreAcceptedHead:true}});
    expect(result.statusCode).toBe(200);expect(result.json().mirrorCurrent).toBe(true);expect(write).not.toHaveBeenCalled();expect(store.getSnapshot(first.id)).toEqual(before);expect(storage.files.get(`read:${setup.vaultId}:note.md`)).toEqual(clear);await app.close();
  });
  it('holds normal accepted writes during a checkpoint repair, then accepts the unchanged saved proposal afterward',async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await app.inject({method:'POST',url:'/v1/setup',payload:setupPayload('Desktop')})).json(),auth={authorization:`Bearer ${setup.deviceToken}`},clear=Buffer.from('protected content'),hash=sha256(clear);
    await app.inject({method:'PUT',url:`/v1/blobs/${hash}`,headers:{...auth,'content-type':'application/octet-stream'},payload:encryptedFixture(clear,Buffer.from(setup.vaultKey,'base64url'),hash)});
    const first=(await app.inject({method:'POST',url:'/v1/commit',headers:auth,payload:{parentId:null,message:'Initial',entries:[{path:'note.md',hash,size:clear.length,mtime:1}],folders:[]}})).json();await app.inject({method:'POST',url:'/v1/mirror/complete',headers:auth,payload:{snapshotId:first.id}});
    const read=storage.getReadable.bind(storage);let release!:()=>void,entered=false;const held=new Promise<void>(resolve=>release=resolve);vi.spyOn(storage,'getReadable').mockImplementation(async(...args)=>{if(!entered){entered=true;await held;}return read(...args);});
    const repair=Promise.resolve(app.inject({method:'POST',url:'/v1/health/repair',headers:auth,payload:{restoreAcceptedHead:true}}));
    await vi.waitFor(()=>expect(entered).toBe(true));const proposal={parentId:first.id,message:'Saved edit during repair',entries:first.entries,folders:['New empty']};
    const deferred=await app.inject({method:'POST',url:'/v1/commit',headers:auth,payload:proposal});expect(deferred.statusCode).toBe(503);expect(deferred.json().healthRepairActive).toBe(true);expect(deferred.headers['retry-after']).toBe('5');expect(store.one('SELECT head_id FROM vaults WHERE id=?',setup.vaultId)).toEqual({head_id:first.id});expect(store.all('SELECT id FROM quarantines WHERE vault_id=?',setup.vaultId)).toHaveLength(0);
    release();expect((await repair).statusCode).toBe(200);const accepted=await app.inject({method:'POST',url:'/v1/commit',headers:auth,payload:proposal});expect(accepted.statusCode).toBe(201);expect(accepted.json().entries[0].fileId).toBe(first.entries[0].fileId);expect(accepted.json().folders).toEqual(['New empty']);await app.close();
  });
  it('automatically resumes an interrupted checkpoint repair after server restart without self-conflict or manual unlocking',async()=>{
    const f=fixture(),{config,storage}=f;let store=f.store;const old=await buildApp(config,store,storage as unknown as SeafileStorage),setup=(await old.inject({method:'POST',url:'/v1/setup',payload:setupPayload('Desktop')})).json(),auth={authorization:`Bearer ${setup.deviceToken}`},clear=Buffer.from('preserve this accepted note'),hash=sha256(clear);
    await old.inject({method:'PUT',url:`/v1/blobs/${hash}`,headers:{...auth,'content-type':'application/octet-stream'},payload:encryptedFixture(clear,Buffer.from(setup.vaultKey,'base64url'),hash)});
    const first=(await old.inject({method:'POST',url:'/v1/commit',headers:auth,payload:{parentId:null,message:'Initial',entries:[{path:'note.md',hash,size:clear.length,mtime:1}],folders:[]}})).json();await old.inject({method:'POST',url:'/v1/mirror/complete',headers:auth,payload:{snapshotId:first.id}});await old.close();
    store=new Store(config.DATA_DIR);fixtureStores.push(store);const history=store.all('SELECT * FROM snapshots'),repairs=new CheckpointRepairs(store);repairs.begin(setup.vaultId);store.run('UPDATE mirror_entries SET hash=? WHERE vault_id=?','repair:'+new Date().toISOString(),setup.vaultId);store.run('UPDATE vaults SET mirror_head_id=NULL,mirror_generation_id=NULL WHERE id=?',setup.vaultId);
    await storage.deleteReadable({id:setup.vaultId},'note.md');storage.blockReadableWrites=true;
    const app=await buildApp(config,store,storage as unknown as SeafileStorage);await app.ready();
    const scan=(await app.inject({method:'POST',url:'/v1/external/scan',headers:auth,payload:{}})).json();expect(scan.snapshotId).toBeNull();expect(scan.conflicts).toBe(0);
    const unlock=await app.inject({method:'POST',url:'/v1/safeguards/lock',headers:auth,payload:{locked:false}});expect(unlock.statusCode).toBe(503);expect(unlock.json().healthRepairActive).toBe(true);
    const proposal={parentId:first.id,message:'Saved edit after restart',entries:first.entries,folders:['Saved empty folder']};expect((await app.inject({method:'POST',url:'/v1/commit',headers:auth,payload:proposal})).statusCode).toBe(503);
    storage.unblockReadableWrites();await vi.waitFor(async()=>{expect((await app.inject({method:'GET',url:'/v1/status',headers:auth})).json().mirrorCurrent).toBe(true);expect(repairs.get(setup.vaultId)).toBeNull();},{timeout:7000,interval:50});
    expect(store.all('SELECT * FROM snapshots')).toEqual(history);expect(storage.files.get(`read:${setup.vaultId}:note.md`)).toEqual(clear);expect((await app.inject({method:'POST',url:'/v1/commit',headers:auth,payload:proposal})).statusCode).toBe(201);await app.close();
  });
  it('isolates an unverifiable saved repair instead of preventing other vaults from starting or syncing',async()=>{
    const f=fixture(),{config,storage}=f;let store=f.store;const old=await buildApp(config,store,storage as unknown as SeafileStorage),a=(await old.inject({method:'POST',url:'/v1/setup',payload:setupPayload('A','/A')})).json(),b=(await old.inject({method:'POST',url:'/v1/setup',payload:setupPayload('B','/B')})).json();await old.close();store=new Store(config.DATA_DIR);fixtureStores.push(store);
    store.run('UPDATE vaults SET checkpoint_repair_json=? WHERE id=?','{"schema":1}',a.vaultId);
    const app=await buildApp(config,store,storage as unknown as SeafileStorage);await app.ready();
    expect((await app.inject({method:'POST',url:'/v1/health/repair',headers:{authorization:`Bearer ${a.deviceToken}`},payload:{restoreAcceptedHead:true}})).statusCode).toBe(423);
    const accepted=await app.inject({method:'POST',url:'/v1/commit',headers:{authorization:`Bearer ${b.deviceToken}`},payload:{parentId:null,message:'Unrelated vault stays usable',entries:[],folders:['New folder']}});expect(accepted.statusCode).toBe(201);expect(accepted.json().folders).toEqual(['New folder']);expect(store.one('SELECT 1 FROM health_events WHERE vault_id=? AND code=?',a.vaultId,'checkpoint_repair_recovery_blocked')).toBeDefined();await app.close();
  });
  it("resumes a partial mirror into a newer large generation without inventing deletions",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const setup=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Desktop")})).json(),auth={authorization:`Bearer ${setup.deviceToken}`},key=Buffer.from(setup.vaultKey,"base64url");
    const clear=Buffer.from("same content\n"),hash=sha256(clear);await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(clear,key,hash)});
    const original=Array.from({length:6},(_,index)=>({path:`Existing/note-${index}.md`,hash,size:clear.length,mtime:1}));
    const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Initial",entries:original}})).json();
    for(const entry of original)await app.inject({method:"PUT",url:`/v1/mirror/file?path=${encodeURIComponent(entry.path)}`,headers:{...auth,"content-type":"application/octet-stream","x-gib-sync-snapshot":first.id,"x-gib-sync-hash":hash},payload:clear});
    await app.inject({method:"POST",url:"/v1/mirror/complete",headers:auth,payload:{snapshotId:first.id}});
    const added=Array.from({length:4},(_,index)=>({path:`Incoming/new-${index}.md`,hash,size:clear.length,mtime:2}));
    storage.blockReadableWrites=true;
    const second=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Large incoming batch",entries:[...original,...added]}})).json();
    for(const entry of added.slice(0,2))store.run("INSERT INTO mirror_entries(vault_id,path,hash,size,updated_at) VALUES(?,?,?,?,?)",setup.vaultId,entry.path,hash,clear.length,new Date().toISOString());
    const firstScan=(await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).json();expect(firstScan).toMatchObject({snapshotId:null,deletedFiles:0,mirrorGenerationMismatch:true});
    store.run("UPDATE external_absences SET first_seen_at=? WHERE vault_id=?",new Date(Date.now()-60_000).toISOString(),setup.vaultId);
    const repeated=(await app.inject({method:"POST",url:"/v1/external/scan",headers:auth,payload:{}})).json();expect(repeated).toMatchObject({snapshotId:null,deletedFiles:0});
    expect((await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head.id).toBe(second.id);
    storage.unblockReadableWrites();
    await vi.waitFor(async()=>{for(const entry of added)expect(storage.files.get(`read:${setup.vaultId}:${entry.path}`)).toEqual(clear);expect((await app.inject({method:"GET",url:"/v1/status",headers:auth})).json().mirrorCurrent).toBe(true);},{timeout:3000});
    const plan=(await app.inject({method:"POST",url:"/v1/mirror/plan",headers:auth,payload:{snapshotId:second.id,entries:second.entries}})).json();expect(plan).toMatchObject({uploadPaths:[],deletePaths:[],alreadyCurrent:true});await app.close();
  });
  it("supports write locks, protected paths, bookmarks, device restrictions, and revocation",async()=>{
    const {config,store,storage}=fixture(),app=await buildApp(config,store,storage as unknown as SeafileStorage);
    const owner=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("Owner")})).json(),auth={authorization:`Bearer ${owner.deviceToken}`};
    const clear=Buffer.from("safe\n"),hash=sha256(clear),key=Buffer.from(owner.vaultKey,"base64url");await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:encryptedFixture(clear,key,hash)});
    const first=(await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Initial",entries:[{path:"Critical/note.md",hash,size:clear.length,mtime:1}]}})).json();
    expect((await app.inject({method:"PUT",url:"/v1/bookmarks/"+first.id,headers:auth,payload:{label:"Known good"}})).statusCode).toBe(200);
    expect((await app.inject({method:"GET",url:"/v1/history?limit=10",headers:auth})).json()[0].bookmarked).toBe(true);
    const currentPolicy=(await app.inject({method:"GET",url:"/v1/safeguards",headers:auth})).json().policy;currentPolicy.protectedPaths=["Critical"];
    await app.inject({method:"PUT",url:"/v1/safeguards/policy",headers:auth,payload:currentPolicy});
    const protectedDelete=await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Delete protected",entries:[]}});expect(protectedDelete.statusCode).toBe(423);
    await app.inject({method:"POST",url:"/v1/quarantines/"+protectedDelete.json().quarantine.id+"/reject",headers:auth,payload:{}});
    expect(store.one<{count:number}>("SELECT COUNT(*) count FROM health_events WHERE vault_id=? AND code='mass_change_quarantine' AND cleared_at IS NULL",owner.vaultId)?.count).toBe(0);
    await app.inject({method:"POST",url:"/v1/safeguards/lock",headers:auth,payload:{locked:true}});
    expect((await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:first.id,message:"Locked",entries:first.entries}})).statusCode).toBe(423);
    await app.inject({method:"POST",url:"/v1/safeguards/lock",headers:auth,payload:{locked:false}});
    const newcomer=(await app.inject({method:"POST",url:"/v1/setup",payload:setupPayload("New phone")})).json(),newAuth={authorization:`Bearer ${newcomer.deviceToken}`};
    expect((await app.inject({method:"POST",url:"/v1/commit",headers:newAuth,payload:{parentId:first.id,message:"Too early",entries:first.entries}})).statusCode).toBe(428);
    expect((await app.inject({method:"POST",url:"/v1/devices/current/ready",headers:newAuth,payload:{headId:null}})).statusCode).toBe(409);
    expect((await app.inject({method:"POST",url:"/v1/devices/current/ready",headers:newAuth,payload:{headId:first.id}})).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:`/v1/devices/${newcomer.deviceId}/revoke`,headers:auth,payload:{}})).statusCode).toBe(200);
    expect((await app.inject({method:"GET",url:"/v1/status",headers:newAuth})).statusCode).toBe(401);
    await app.close();
  });
});
