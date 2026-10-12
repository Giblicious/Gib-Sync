import {randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {mkdtemp,rm,readdir,readFile,open,utimes,writeFile,copyFile,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
import {PrivateStaging,SERVER_IO_CHUNK_BYTES,SERVER_INLINE_BYTES,decryptBlobFile,encryptBlobFile,hashFile} from "./security-stream.js";
import {parseBinaryBody,isStagedBinary} from "./binary-body.js";
import {decryptVaultBlob,encryptVaultBlob,sha256,sealJson} from "./security.js";
import {VerifiedBlobStore} from "./blob-store.js";
import {Store} from "./db.js";
import type {Config} from "./config.js";
import type {SeafileStorage,VaultStorageRow} from "./seafile.js";

const roots:string[]=[],stores:Store[]=[];
afterEach(async()=>{for(const store of stores.splice(0))try{store.db.close();}catch{}for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const root=await mkdtemp(join(tmpdir(),"gib-verified-stream-"));roots.push(root);return {root,staging:new PrivateStaging(root),key:Buffer.alloc(32,9).toString("base64url")};}
async function* synthetic(size:number){const chunk=Buffer.alloc(SERVER_IO_CHUNK_BYTES,73);for(let offset=0;offset<size;offset+=chunk.length)yield chunk.subarray(0,Math.min(chunk.length,size-offset));}

describe("verified disk-backed content",()=>{
  it.each([0,3,65537])( "round trips %i bytes with the existing envelope and no unauthenticated exposure",async size=>{
    const f=await fixture(),clear=await f.staging.fromChunks(synthetic(size),size),cipher=await encryptBlobFile(clear.path,f.key,clear.hash,f.staging,size);
    expect(cipher.size).toBe(size+29);expect(Buffer.from(decryptVaultBlob(await readFile(cipher.path),f.key,clear.hash))).toEqual(await readFile(clear.path));
    const verified=await decryptBlobFile(cipher.path,f.key,clear.hash,f.staging,size);expect(await hashFile(verified.path)).toEqual({hash:clear.hash,size});await verified.dispose();await cipher.dispose();await clear.dispose();expect(await readdir(f.staging.directory)).toEqual([]);
  });
  it("rejects tag corruption and incorrect clear hash, removes private partial plaintext, and preserves source",async()=>{
    const f=await fixture(),bytes=Buffer.from("private accepted original"),source=await f.staging.fromChunks((async function*(){yield encryptVaultBlob(bytes,f.key,sha256(bytes));})(),bytes.length+29),file=await open(source.path,"r+");await file.write(Buffer.from([255]),0,1,source.size-1);await file.close();
    await expect(decryptBlobFile(source.path,f.key,sha256(bytes),f.staging,bytes.length)).rejects.toThrow();expect(await readdir(f.staging.directory)).toEqual([source.path.split(/[\\/]/).pop()]);expect((await stat(source.path)).size).toBe(source.size);await source.dispose();
  });
  it("enforces actual streamed size caps and cancels upstream with no partial files",async()=>{
    const f=await fixture();let returned=false;const source=(async function*(){try{yield Buffer.alloc(12);yield Buffer.alloc(12);}finally{returned=true;}})();await expect(f.staging.fromChunks(source,20)).rejects.toMatchObject({statusCode:413});expect(returned).toBe(true);expect(await readdir(f.staging.directory)).toEqual([]);
    const controller=new AbortController();controller.abort(new Error("paused"));await expect(f.staging.fromChunks(synthetic(100),100,controller.signal)).rejects.toThrow("paused");expect(await readdir(f.staging.directory)).toEqual([]);
  });
  it("streams a 32 MiB body and authenticated round trip while timers keep running",async()=>{
    const f=await fixture(),size=32*1024*1024;let ticks=0;const timer=setInterval(()=>ticks++,1);
    try{const body=await parseBinaryBody(synthetic(size),f.staging,size);expect(isStagedBinary(body)).toBe(true);if(!isStagedBinary(body))throw new Error("large body was buffered");const cipher=await encryptBlobFile(body.file.path,f.key,body.file.hash,f.staging,size),clear=await decryptBlobFile(cipher.path,f.key,body.file.hash,f.staging,size);expect(clear.size).toBe(size);expect(clear.hash).toBe(body.file.hash);expect(ticks).toBeGreaterThan(20);await clear.dispose();await cipher.dispose();await body.file.dispose();expect(await readdir(f.staging.directory)).toEqual([]);}finally{clearInterval(timer);}
  },30_000);
  it("retains bounded small request compatibility and rejects oversized parsing before acceptance",async()=>{
    const f=await fixture();expect(await parseBinaryBody(synthetic(17),f.staging,17)).toEqual(Buffer.alloc(17,73));let cancelled=false;await expect(parseBinaryBody((async function*(){try{yield Buffer.alloc(SERVER_INLINE_BYTES+1);}finally{cancelled=true;}})(),f.staging,SERVER_INLINE_BYTES)).rejects.toMatchObject({statusCode:413});expect(cancelled).toBe(true);
  });
  it("cleans only expired owned stages, never arbitrary names, current work, or directories",async()=>{
    const f=await fixture(),old=await f.staging.fromChunks(synthetic(2),2),current=await f.staging.fromChunks(synthetic(3),3),other=join(f.staging.directory,"accepted-original.txt"),then=new Date(Date.now()-8*24*60*60*1000);await writeFile(other,"retain");await utimes(old.path,then,then);await utimes(other,then,then);expect(await f.staging.cleanupExpired()).toBe(1);expect(await readdir(f.staging.directory)).toEqual(expect.arrayContaining(["accepted-original.txt",current.path.split(/[\\/]/).pop()]));await current.dispose();
  });
  it("persists and serves a large blob through file-only adapters and records exact integrity sizes",async()=>{
    const f=await fixture(),store=new Store(f.root);stores.push(store);const id=randomUUID(),config={DATA_DIR:f.root,MAX_BLOB_BYTES:16*1024*1024,GIBSYNC_SERVER_SECRET:"disposable-test-secret-at-least-thirty-two-bytes"} as Config,row={id} as VaultStorageRow,objects=new Map<string,string>(),storage={put:vi.fn(()=>{throw new Error("whole body adapter forbidden");}),get:vi.fn(()=>{throw new Error("whole body adapter forbidden");}),async putFile(_row:unknown,path:string,source:string){const target=join(f.root,randomUUID());await copyFile(source,target);objects.set(path,target);},async getToFile(_row:unknown,path:string,staging:PrivateStaging){return staging.fromChunks(createReadStream(objects.get(path)!,{highWaterMark:SERVER_IO_CHUNK_BYTES}),config.MAX_BLOB_BYTES+29);}};
    store.run("INSERT INTO vaults(id,name,wrapped_key,created_at) VALUES(?,?,?,?)",id,"Disposable",sealJson(f.key,config.GIBSYNC_SERVER_SECRET,id),new Date().toISOString());const blobs=new VerifiedBlobStore(config,store,storage as unknown as SeafileStorage),clear=await f.staging.fromChunks(synthetic(8*1024*1024),config.MAX_BLOB_BYTES);await blobs.persist(row,clear);const received=await blobs.clear(row,clear.hash);expect(await hashFile(received.path)).toEqual({hash:clear.hash,size:clear.size});expect(store.one("SELECT clear_size,cipher_size FROM blob_integrity WHERE vault_id=? AND hash=?",id,clear.hash)).toMatchObject({clear_size:clear.size,cipher_size:clear.size+29});expect(storage.get).not.toHaveBeenCalled();expect(storage.put).not.toHaveBeenCalled();await received.dispose();await clear.dispose();
  },20_000);
});
