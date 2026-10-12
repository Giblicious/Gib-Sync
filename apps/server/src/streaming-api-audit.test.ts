import {createHash,randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {copyFile,mkdtemp,open,readdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
import {buildApp} from "./app.js";
import type {Config} from "./config.js";
import {Store} from "./db.js";
import {VerifiedBlobStore} from "./blob-store.js";
import {ProjectionJournal,ReadableChangedError} from "./projection-journal.js";
import {SeafileStorage,StorageMissingError,type VaultStorageRow} from "./seafile.js";
import {PrivateStaging,SERVER_IO_CHUNK_BYTES,encryptBlobFile,hashFile} from "./security-stream.js";
import {parseBinaryBody} from "./binary-body.js";
import {openJson,sealJson,sha256} from "./security.js";

const disposables:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const dispose of disposables.splice(0).reverse())await dispose();vi.unstubAllGlobals();});
async function* synthetic(size:number,value=71){const chunk=Buffer.alloc(SERVER_IO_CHUNK_BYTES,value);for(let offset=0;offset<size;offset+=chunk.length)yield chunk.subarray(0,Math.min(chunk.length,size-offset));}

/** The fake backend deliberately cannot materialize blob or readable file bodies. */
class FileStorage{
  readonly files=new Map<string,string>();readonly readableFiles=new Map<string,string>();
  readonly get=vi.fn(async()=>{throw new Error("Whole-body blob get is forbidden");});
  readonly getReadable=vi.fn(async()=>{throw new Error("Whole-body readable get is forbidden");});
  readonly put=vi.fn(async(_row:VaultStorageRow,path:string,_bytes:Uint8Array)=>{if(path.startsWith("blobs/"))throw new Error("Whole-body blob put is forbidden");});
  readonly readReadable=vi.fn();readonly putStream=vi.fn();
  failure:Error|null=null;holdPut=false;putEntered=false;putAborted=false;
  constructor(readonly root:string,readonly maximum:number){}
  location(row:VaultStorageRow){return {seafileUrl:row.storage_url,username:row.storage_username,libraryId:row.storage_repo_id,libraryName:row.storage_repo_name,basePath:row.storage_base_path,readablePath:row.mirror_base_path};}
  async putFile(row:VaultStorageRow,path:string,source:string,signal?:AbortSignal){
    this.putEntered=true;this.putStream(path);
    if(this.holdPut)await new Promise<void>((_resolve,reject)=>{const abort=()=>{this.putAborted=true;reject(signal?.reason??new Error("aborted"));};if(signal?.aborted)abort();else signal?.addEventListener("abort",abort,{once:true});});
    signal?.throwIfAborted();const target=join(this.root,randomUUID());await copyFile(source,target);signal?.throwIfAborted();this.files.set(`${row.id}:${path}`,target);
  }
  async getToFile(row:VaultStorageRow,path:string,staging:PrivateStaging,signal?:AbortSignal){
    if(this.failure)throw this.failure;const source=this.files.get(`${row.id}:${path}`);if(!source)throw new StorageMissingError();
    return staging.fromChunks(createReadStream(source,{highWaterMark:SERVER_IO_CHUNK_BYTES}),this.maximum+29,signal);
  }
  async getReadableToFile(row:VaultStorageRow,path:string,staging:PrivateStaging,signal?:AbortSignal){
    this.readReadable(path);const source=this.readableFiles.get(`${row.id}:${path}`);if(!source)throw new StorageMissingError();return staging.fromChunks(createReadStream(source,{highWaterMark:SERVER_IO_CHUNK_BYTES}),this.maximum,signal);
  }
  async getReadableRevisionToFile(row:VaultStorageRow,path:string,_revision:string,staging:PrivateStaging,signal?:AbortSignal){return this.getReadableToFile(row,path,staging,signal);}
  async statReadable(row:VaultStorageRow,path:string){const source=this.readableFiles.get(`${row.id}:${path}`);if(!source)return null;const result=await hashFile(source);return {path,id:result.hash,size:result.size,mtime:1};}
  async assertHistoryAvailable(){}
  async repoHistory(){return [{commitId:"a".repeat(40),mtime:1,size:0}];}
  async listReadableTree(){return {files:[],folders:[]};}
  async listReadable(){return [];}
}

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"gib-api-stream-audit-"));disposables.push(()=>rm(root,{recursive:true,force:true}));
  const config:Config={HOST:"127.0.0.1",PORT:8787,PUBLIC_URL:"https://sync.example.test",DATA_DIR:root,GIBSYNC_SERVER_SECRET:"disposable-test-secret-at-least-thirty-two-bytes",SEAFILE_URL:"https://seafile.example.test",SEAFILE_USERNAME:"test@example.test",SEAFILE_PASSWORD:"test",SEAFILE_LIBRARY:"Notes",MAX_BLOB_BYTES:8*1024*1024,GIBSYNC_MIN_CLIENT_VERSION:"0.0.0",GIBSYNC_RECOMMENDED_CLIENT_VERSION:"0.8.62"};
  const store=new Store(root);disposables.push(async()=>{try{store.db.close();}catch{}});const id=randomUUID(),deviceId=randomUUID(),token="disposable-device-token",now=new Date().toISOString(),key=Buffer.alloc(32,37).toString("base64url");
  store.run("INSERT INTO vaults(id,name,wrapped_key,created_at,storage_url,storage_username,storage_repo_id,storage_repo_name,storage_base_path,storage_token,storage_layout,mirror_base_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",id,"Disposable",sealJson(key,config.GIBSYNC_SERVER_SECRET,id),now,config.SEAFILE_URL,"test@example.test","repo","Notes","/Disposable","not-used-by-fake","standard","/Disposable");
  store.run("INSERT INTO devices(id,vault_id,name,token_hash,created_at,last_seen_at,initial_sync_complete) VALUES(?,?,?,?,?,?,1)",deviceId,id,"Disposable desktop",sha256(token),now,now);
  const row=store.one<VaultStorageRow>("SELECT * FROM vaults WHERE id=?",id)!,storage=new FileStorage(root,config.MAX_BLOB_BYTES),sources=new PrivateStaging(join(root,"test-sources")),blobs=new VerifiedBlobStore(config,store,storage as unknown as SeafileStorage);
  const listen=async()=>{const app=await buildApp(config,store,storage as unknown as SeafileStorage);disposables.push(()=>app.close());const base=await app.listen({host:"127.0.0.1",port:0});return {app,base};};
  return {root,config,store,row,id,deviceId,key,storage,sources,blobs,listen,auth:{authorization:`Bearer ${token}`}};
}
async function consume(response:Response){const reader=response.body!.getReader(),hash=createHash("sha256");let size=0;for(;;){const next=await reader.read();if(next.done)break;hash.update(next.value);size+=next.value.length;}return {hash:hash.digest("hex"),size};}
async function requestBody(path:string):Promise<RequestInit>{return {body:createReadStream(path,{highWaterMark:SERVER_IO_CHUNK_BYTES}),duplex:"half"} as unknown as RequestInit;}
async function stagesEmpty(directory:string){await vi.waitFor(async()=>{expect(await readdir(directory).catch(()=>[])).toEqual([]);},{timeout:5000});}

describe("real HTTP streaming boundaries",()=>{
  it("legacy PUT/GET and authenticated clear GET stream a 3 MiB file without whole-body adapters",async()=>{
    const f=await fixture(),clear=await f.sources.fromChunks(synthetic(3*1024*1024),f.config.MAX_BLOB_BYTES),cipher=await encryptBlobFile(clear.path,f.key,clear.hash,f.sources,f.config.MAX_BLOB_BYTES),{base}=await f.listen();
    const put=await fetch(`${base}/v1/blobs/${clear.hash}`,{method:"PUT",headers:{...f.auth,"content-type":"application/octet-stream"},...await requestBody(cipher.path)});expect(put.status).toBe(201);await put.text();
    const encrypted=await fetch(`${base}/v1/blobs/${clear.hash}`,{headers:f.auth});expect(encrypted.status).toBe(200);expect(await consume(encrypted)).toEqual({hash:cipher.hash,size:cipher.size});
    const content=await fetch(`${base}/v1/content/${clear.hash}`,{headers:f.auth});expect(content.headers.get("x-content-sha256")).toBe(clear.hash);expect(await consume(content)).toEqual({hash:clear.hash,size:clear.size});
    expect(f.storage.get).not.toHaveBeenCalled();expect(f.storage.getReadable).not.toHaveBeenCalled();expect(f.storage.put).not.toHaveBeenCalled();
    expect(f.store.one("SELECT clear_size,cipher_size FROM blob_integrity WHERE vault_id=? AND hash=?",f.id,clear.hash)).toMatchObject({clear_size:clear.size,cipher_size:cipher.size});await stagesEmpty(f.blobs.staging.directory);
  },20_000);
  it("does not publish corrupted or oversized streamed requests and removes all request stages",async()=>{
    const f=await fixture(),clear=await f.sources.fromChunks(synthetic(3*1024*1024),f.config.MAX_BLOB_BYTES),cipher=await encryptBlobFile(clear.path,f.key,clear.hash,f.sources,f.config.MAX_BLOB_BYTES),file=await open(cipher.path,"r+");await file.write(Buffer.from([0]),0,1,cipher.size-1);await file.close();const {base}=await f.listen();
    const corrupt=await fetch(`${base}/v1/blobs/${clear.hash}`,{method:"PUT",headers:{...f.auth,"content-type":"application/octet-stream"},...await requestBody(cipher.path)});expect(corrupt.status).toBe(422);await corrupt.text();
    const oversize=await f.sources.fromChunks(synthetic(f.config.MAX_BLOB_BYTES+30),f.config.MAX_BLOB_BYTES+30),large=await fetch(`${base}/v1/blobs/${"a".repeat(64)}`,{method:"PUT",headers:{...f.auth,"content-type":"application/octet-stream"},...await requestBody(oversize.path)});expect(large.status).toBe(413);await large.text();
    expect(f.store.one<{n:number}>("SELECT COUNT(*) n FROM blobs")?.n).toBe(0);expect(f.storage.putStream).not.toHaveBeenCalled();await stagesEmpty(f.blobs.staging.directory);
  },20_000);
  it("aborts backend work when the uploader disconnects after its request body was received",async()=>{
    const f=await fixture(),clear=await f.sources.fromChunks(synthetic(3*1024*1024,19),f.config.MAX_BLOB_BYTES),cipher=await encryptBlobFile(clear.path,f.key,clear.hash,f.sources,f.config.MAX_BLOB_BYTES),{base}=await f.listen(),controller=new AbortController();f.storage.holdPut=true;
    const pending=fetch(`${base}/v1/blobs/${clear.hash}`,{method:"PUT",headers:{...f.auth,"content-type":"application/octet-stream"},...await requestBody(cipher.path),signal:controller.signal}).catch(error=>error);
    await vi.waitFor(()=>expect(f.storage.putEntered).toBe(true));controller.abort();await pending;await vi.waitFor(()=>expect(f.storage.putAborted).toBe(true));expect(f.store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?",f.id,clear.hash)).toBeUndefined();await stagesEmpty(f.blobs.staging.directory);
  },20_000);
  it("rejects a legacy commit whose declared clear size contradicts the verified hash",async()=>{
    const f=await fixture(),clear=await f.sources.fromChunks(synthetic(3*1024*1024,39),f.config.MAX_BLOB_BYTES);await f.blobs.persist(f.row,clear);const {app}=await f.listen();
    const response=await app.inject({method:"POST",url:"/v1/commit",headers:f.auth,payload:{parentId:null,entries:[{path:"attachment.bin",hash:clear.hash,size:1,mtime:1}]}});expect(response.statusCode).toBe(422);expect(f.store.one<{head_id:null}>("SELECT head_id FROM vaults WHERE id=?",f.id)?.head_id).toBeNull();
  });
  it("removes the authenticated download stage when a real HTTP consumer cancels",async()=>{
    const f=await fixture(),clear=await f.sources.fromChunks(synthetic(f.config.MAX_BLOB_BYTES,17),f.config.MAX_BLOB_BYTES);await f.blobs.persist(f.row,clear);const {base}=await f.listen(),response=await fetch(`${base}/v1/content/${clear.hash}`,{headers:f.auth}),reader=response.body!.getReader();expect(response.status).toBe(200);expect((await reader.read()).value?.length).toBeGreaterThan(0);await reader.cancel();await stagesEmpty(f.blobs.staging.directory);expect(f.store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?",f.id,clear.hash)).toBeDefined();
  },20_000);
  it("cancels the binary source exactly once and preserves the original size-limit failure",async()=>{
    const f=await fixture();let returned=0,offset=0;const source:AsyncIterable<Uint8Array>={[Symbol.asyncIterator](){return {next:async()=>({done:false as const,value:Buffer.alloc(SERVER_IO_CHUNK_BYTES,offset++%255)}),return:async()=>{if(++returned>1)throw new Error("Source returned twice");return {done:true as const,value:undefined};}};}};
    await expect(parseBinaryBody(source,f.blobs.staging,3*1024*1024)).rejects.toMatchObject({statusCode:413});expect(returned).toBe(1);await stagesEmpty(f.blobs.staging.directory);
  });
});

describe("short-code setup cannot bypass originating device approval",()=>{
  it("rejects downgrade requests while keeping the already-paired device operational",async()=>{
    const f=await fixture(),{app}=await f.listen();for(const payload of [{},{requireConfirmation:false}]){const denied=await app.inject({method:"POST",url:"/v1/pairings",headers:f.auth,payload});expect(denied.statusCode).toBe(426);expect(denied.json().message).toContain("Existing synchronization is unaffected");}
    expect(f.store.one<{n:number}>("SELECT COUNT(*) n FROM pairings")?.n).toBe(0);expect((await app.inject({method:"GET",url:"/v1/head",headers:f.auth})).statusCode).toBe(200);
  });
  it("does not issue credentials before exact-origin approval, and delivers one idempotent ticket-bound result",async()=>{
    const f=await fixture(),{app}=await f.listen(),created=await app.inject({method:"POST",url:"/v1/pairings",headers:f.auth,payload:{requireConfirmation:true}});expect(created.statusCode).toBe(200);expect(created.json().requiresConfirmation).toBe(true);
    const response=await app.inject({method:"POST",url:"/v1/pairings/claim-code",payload:{code:created.json().code,deviceName:"New phone"}}),claim=response.json();expect(response.statusCode).toBe(202);expect(claim).not.toHaveProperty("envelope");expect(claim).not.toHaveProperty("vaultKey");expect(f.store.one<{n:number}>("SELECT COUNT(*) n FROM devices")?.n).toBe(1);
    const pending=await app.inject({method:"POST",url:"/v1/pairings/poll",payload:{ticket:claim.ticket}});expect(pending.json()).toMatchObject({status:"pending"});expect(pending.json()).not.toHaveProperty("envelope");
    const peer=randomUUID(),now=new Date().toISOString();f.store.run("INSERT INTO devices(id,vault_id,name,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?,?)",peer,f.id,"Other existing device",sha256("other-token"),now,now);expect((await app.inject({method:"POST",url:`/v1/pairings/requests/${claim.claimId}/decision`,headers:{authorization:"Bearer other-token"},payload:{approved:true}})).statusCode).toBe(409);
    expect((await app.inject({method:"POST",url:`/v1/pairings/requests/${claim.claimId}/decision`,headers:f.auth,payload:{approved:true}})).statusCode).toBe(200);const approved=(await app.inject({method:"POST",url:"/v1/pairings/poll",payload:{ticket:claim.ticket}})).json();expect(approved.status).toBe("approved");expect(openJson(approved.envelope,claim.ticket,`pairing:${approved.pairingId}`)).toMatchObject({vaultId:f.id,vaultKey:f.key,deviceToken:expect.any(String)});
    expect((await app.inject({method:"POST",url:"/v1/pairings/poll",payload:{ticket:claim.ticket}})).json()).toEqual(approved);expect(f.store.one<{n:number}>("SELECT COUNT(*) n FROM devices")?.n).toBe(3);
    await app.inject({method:"POST",url:"/v1/pairings/cancel-claim",payload:{ticket:claim.ticket}});expect((await app.inject({method:"POST",url:"/v1/pairings/poll",payload:{ticket:claim.ticket}})).statusCode).toBe(410);expect((await app.inject({method:"GET",url:"/v1/head",headers:f.auth})).statusCode).toBe(200);
  });
  it("refuses unconfirmed codes left over from an older server instead of releasing keys",async()=>{
    const f=await fixture(),{app}=await f.listen();f.store.run("INSERT INTO pairings(id,vault_id,secret_hash,quick_code_hash,created_by_device,expires_at,requires_confirmation) VALUES(?,?,?,?,?,?,0)",randomUUID(),f.id,sha256("12345"),sha256("12345"),f.deviceId,new Date(Date.now()+60000).toISOString());
    const response=await app.inject({method:"POST",url:"/v1/pairings/claim-code",payload:{code:"12345",deviceName:"Claimant"}});expect(response.statusCode).toBe(426);expect(response.json()).not.toHaveProperty("envelope");expect(f.store.one<{n:number}>("SELECT COUNT(*) n FROM devices")?.n).toBe(1);
  });
});

describe("streamed history and repair failure classification",()=>{
  it("propagates finalizer cancellation into parent-directory metadata before beginning upload",async()=>{
    const f=await fixture(),source=await f.sources.fromChunks(synthetic(100),100),storage=new SeafileStorage(f.config),row={...f.row,storage_token:storage.sealToken(f.id,"disposable-token")},controller=new AbortController();let started=false,aborted=false;
    const fetchMock=vi.fn((_url:unknown,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{started=true;const abort=()=>{aborted=true;reject(init?.signal?.reason??new Error("aborted"));};if(init?.signal?.aborted)abort();else init?.signal?.addEventListener("abort",abort,{once:true});}));vi.stubGlobal("fetch",fetchMock);
    const pending=storage.putFile(row,"blobs/aa/test.gbs",source.path,controller.signal).catch(error=>error);await vi.waitFor(()=>expect(started).toBe(true));controller.abort(new Error("paused by user"));expect(await pending).toMatchObject({message:"paused by user"});expect(aborted).toBe(true);expect(fetchMock).toHaveBeenCalledOnce();storage.close();
  });
  async function acceptedFixture(){const f=await fixture(),clear=await f.sources.fromChunks(synthetic(3*1024*1024,51),f.config.MAX_BLOB_BYTES);await f.blobs.persist(f.row,clear);f.storage.readableFiles.set(`${f.id}:note.md`,clear.path);const snapshot={id:randomUUID(),vaultId:f.id,parentId:null,deviceId:f.deviceId,deviceName:"Disposable",createdAt:new Date().toISOString(),message:"Accepted",entries:[{path:"note.md",hash:clear.hash,size:clear.size,mtime:1}],folders:[]};f.store.run("INSERT INTO snapshots(id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?,?)",snapshot.id,f.id,null,f.deviceId,snapshot.deviceName,snapshot.createdAt,snapshot.message,JSON.stringify(snapshot));f.store.run("UPDATE vaults SET head_id=? WHERE id=?",snapshot.id,f.id);return {...f,clear};}
  it.each([503,507,"aborted"])("does not invoke readable repair or upload after %s failure",async kind=>{
    const f=await acceptedFixture(),failure=kind==="aborted"?new DOMException("aborted","AbortError"):Object.assign(new Error(`backend failure ${kind}`),{statusCode:kind});f.storage.failure=failure;f.storage.putStream.mockClear();await expect(f.blobs.clear(f.row,f.clear.hash)).rejects.toBe(failure);expect(f.storage.readReadable).not.toHaveBeenCalled();expect(f.storage.putStream).not.toHaveBeenCalled();await stagesEmpty(f.blobs.staging.directory);
  });
  it.each(["missing","corrupt"])("repairs only confirmed %s sidecars from a hash-verified readable original",async kind=>{
    const f=await acceptedFixture(),relative=`blobs/${f.clear.hash.slice(0,2)}/${f.clear.hash}.gbs`,existing=f.storage.files.get(`${f.id}:${relative}`)!;
    if(kind==="missing")f.storage.files.delete(`${f.id}:${relative}`);else{const file=await open(existing,"r+");await file.write(Buffer.from([0]),0,1,0);await file.close();}
    f.storage.putStream.mockClear();const recovered=await f.blobs.clear(f.row,f.clear.hash);expect(await hashFile(recovered.path)).toEqual({hash:f.clear.hash,size:f.clear.size});expect(f.storage.readReadable).toHaveBeenCalledOnce();expect(f.storage.putStream).toHaveBeenCalledOnce();await recovered.dispose();await stagesEmpty(f.blobs.staging.directory);
  });
  it("never replaces an accepted sidecar using an unverified readable copy",async()=>{
    const f=await acceptedFixture(),relative=`blobs/${f.clear.hash.slice(0,2)}/${f.clear.hash}.gbs`,wrong=await f.sources.fromChunks(synthetic(f.clear.size,19),f.config.MAX_BLOB_BYTES);f.storage.files.delete(`${f.id}:${relative}`);f.storage.readableFiles.set(`${f.id}:note.md`,wrong.path);f.storage.putStream.mockClear();await expect(f.blobs.clear(f.row,f.clear.hash)).rejects.toBeInstanceOf(StorageMissingError);expect(f.storage.putStream).not.toHaveBeenCalled();expect(f.storage.files.has(`${f.id}:${relative}`)).toBe(false);expect(f.store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?",f.id,f.clear.hash)).toBeDefined();await stagesEmpty(f.blobs.staging.directory);
  });
  it.each(["external.bin","external.md"])("captures a complete large %s revision before refusing a destructive projection",async path=>{
    const f=await fixture(),clear=await f.sources.fromChunks(synthetic(3*1024*1024,83),f.config.MAX_BLOB_BYTES);f.storage.readableFiles.set(`${f.id}:${path}`,clear.path);const journal=new ProjectionJournal(f.config,f.store,f.storage as unknown as SeafileStorage);
    await expect(journal.prepare(f.row,path,randomUUID(),"e".repeat(64),null)).rejects.toBeInstanceOf(ReadableChangedError);
    expect(f.store.one("SELECT hash,size,imported_at FROM external_revisions WHERE vault_id=? AND path=?",f.id,path)).toMatchObject({hash:clear.hash,size:clear.size,imported_at:null});const captured=await f.blobs.clear(f.row,clear.hash);expect(await hashFile(captured.path)).toEqual({hash:clear.hash,size:clear.size});await captured.dispose();expect(f.storage.get).not.toHaveBeenCalled();expect(f.storage.getReadable).not.toHaveBeenCalled();expect(f.storage.put).not.toHaveBeenCalled();await stagesEmpty(f.blobs.staging.directory);
  });
});
