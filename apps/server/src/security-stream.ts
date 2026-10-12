import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from "node:crypto";
import {createReadStream,constants} from "node:fs";
import {open,mkdir,chmod,unlink,statfs,opendir,lstat} from "node:fs/promises";
import {join,resolve} from "node:path";

export const SERVER_IO_CHUNK_BYTES=64*1024;
export const SERVER_INLINE_BYTES=2*1024*1024;
export interface StagedFile{path:string;size:number;hash:string;dispose():Promise<void>;}
export class BlobIntegrityError extends Error{constructor(message:string,options?:ErrorOptions){super(message,options);this.name="BlobIntegrityError";}}
export class PrivateStaging{
  readonly directory:string;
  constructor(dataDir:string){this.directory=join(resolve(dataDir),"verified-content-staging");}
  /** Only our expired UUID files are eligible; no accepted content lives here. */
  async cleanupExpired(now=Date.now(),budget=512):Promise<number>{
    await mkdir(this.directory,{recursive:true,mode:0o700});let visited=0,removed=0;
    for await(const entry of await opendir(this.directory)){if(++visited>budget)break;if(!entry.isFile()||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.stage$/.test(entry.name))continue;
      const path=join(this.directory,entry.name),metadata=await lstat(path).catch(()=>null);if(!metadata?.isFile()||metadata.mtimeMs>now-7*24*60*60*1000)continue;
      try{await unlink(path);removed++;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT"&&(error as NodeJS.ErrnoException).code!=="EBUSY"&&(error as NodeJS.ErrnoException).code!=="EPERM")throw error;}
    }return removed;
  }
  async allocate(maximumBytes:number):Promise<{path:string;dispose():Promise<void>}>{
    if(!Number.isSafeInteger(maximumBytes)||maximumBytes<0)throw new Error("Invalid private staging byte budget");
    await mkdir(this.directory,{recursive:true,mode:0o700});await chmod(this.directory,0o700);
    const disk=await statfs(this.directory);if(disk.bavail*disk.bsize<maximumBytes+64*1024*1024)throw Object.assign(new Error("Not enough private staging space; accepted data was not changed"),{statusCode:507});
    const path=join(this.directory,`${randomUUID()}.stage`);let removed=false;
    return {path,dispose:async()=>{if(removed)return;await unlink(path).catch((e:NodeJS.ErrnoException)=>{if(e.code!=="ENOENT")throw e;});removed=true;}};
  }
  async fromChunks(chunks:AsyncIterable<Uint8Array>,maximumBytes:number,signal?:AbortSignal):Promise<StagedFile>{
    const stage=await this.allocate(maximumBytes),file=await open(stage.path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600),digest=createHash("sha256");let size=0;
    try{
      for await(const value of chunks){signal?.throwIfAborted();for(let offset=0;offset<value.length;offset+=SERVER_IO_CHUNK_BYTES){
        const chunk=value.subarray(offset,offset+SERVER_IO_CHUNK_BYTES);if(size+chunk.length>maximumBytes)throw Object.assign(new Error("Content exceeds its permitted byte limit"),{statusCode:413});
        digest.update(chunk);let written=0;while(written<chunk.length){const result=await file.write(chunk,written,chunk.length-written,size+written);if(!result.bytesWritten)throw new Error("Private staging write made no progress");written+=result.bytesWritten;}size+=chunk.length;
      }}
      await file.sync();return {...stage,size,hash:digest.digest("hex")};
    }catch(error){await file.close();await stage.dispose();throw error;}finally{await file.close().catch(()=>{});}
  }
}

export async function hashFile(path:string,signal?:AbortSignal):Promise<{hash:string;size:number}>{
  const hash=createHash("sha256");let size=0;for await(const chunk of createReadStream(path,{highWaterMark:SERVER_IO_CHUNK_BYTES})){signal?.throwIfAborted();size+=chunk.length;hash.update(chunk);}return {hash:hash.digest("hex"),size};
}

/** Authentication and clear hash are verified before any plaintext is exposed. */
export async function decryptBlobFile(source:string,vaultKey:string,expectedHash:string,staging:PrivateStaging,maximumBytes:number,signal?:AbortSignal):Promise<StagedFile>{
  if(!/^[a-f0-9]{64}$/.test(expectedHash))throw new Error("Invalid accepted content hash");
  const input=await open(source,"r");let stage:Awaited<ReturnType<PrivateStaging["allocate"]>>|undefined;
  try{
    signal?.throwIfAborted();const metadata=await input.stat();if(!metadata.isFile()||metadata.size<29)throw new BlobIntegrityError("Invalid encrypted content envelope size");if(metadata.size-29>maximumBytes)throw Object.assign(new Error("Accepted content exceeds this server's configured byte budget"),{statusCode:413});
    const prefix=Buffer.alloc(13),tag=Buffer.alloc(16);if((await input.read(prefix,0,13,0)).bytesRead!==13||prefix[0]!==1||(await input.read(tag,0,16,metadata.size-16)).bytesRead!==16)throw new BlobIntegrityError("Invalid encrypted content envelope");
    const key=Buffer.from(vaultKey,"base64url");if(key.length!==32)throw new Error("Invalid vault key");
    const cipher=createDecipheriv("aes-256-gcm",key,prefix.subarray(1));cipher.setAAD(Buffer.from(expectedHash));cipher.setAuthTag(tag);
    stage=await staging.allocate(metadata.size-29);const output=await open(stage.path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600),digest=createHash("sha256");let size=0;
    try{
      if(metadata.size>29)for await(const chunk of createReadStream(source,{start:13,end:metadata.size-17,highWaterMark:SERVER_IO_CHUNK_BYTES})){signal?.throwIfAborted();const clear=cipher.update(chunk);digest.update(clear);await output.writeFile(clear);size+=clear.length;}
      signal?.throwIfAborted();let tail:Buffer;try{tail=cipher.final();}catch(error){throw new BlobIntegrityError("Encrypted content authentication failed",{cause:error});}if(tail.length){digest.update(tail);await output.writeFile(tail);size+=tail.length;}
      if(size!==metadata.size-29||digest.digest("hex")!==expectedHash)throw new BlobIntegrityError("Encrypted content authentication or hash failed");
      await output.sync();return {...stage,size,hash:expectedHash};
    }finally{await output.close();}
  }catch(error){await stage?.dispose();throw error;}finally{await input.close();}
}

export async function encryptBlobFile(source:string,vaultKey:string,expectedHash:string,staging:PrivateStaging,maximumBytes:number,signal?:AbortSignal):Promise<StagedFile>{
  const before=await hashFile(source,signal);if(before.hash!==expectedHash||before.size>maximumBytes)throw new Error("Source content failed verification before encryption");
  const stage=await staging.allocate(before.size+29),output=await open(stage.path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600),key=Buffer.from(vaultKey,"base64url");
  if(key.length!==32){await output.close();await stage.dispose();throw new Error("Invalid vault key");}
  const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,iv),digest=createHash("sha256");cipher.setAAD(Buffer.from(expectedHash));let size=0;
  try{
    await output.writeFile(Buffer.concat([Buffer.from([1]),iv]));
    for await(const chunk of createReadStream(source,{highWaterMark:SERVER_IO_CHUNK_BYTES})){signal?.throwIfAborted();digest.update(chunk);size+=chunk.length;if(size>maximumBytes)throw new Error("Source content grew while encrypting");await output.writeFile(cipher.update(chunk));}
    if(size!==before.size||digest.digest("hex")!==expectedHash)throw new Error("Source content changed while encrypting");
    await output.writeFile(cipher.final());await output.writeFile(cipher.getAuthTag());await output.sync();return {...stage,size:size+29,hash:(await hashFile(stage.path,signal)).hash};
  }catch(error){await output.close();await stage.dispose();throw error;}finally{await output.close().catch(()=>{});}
}
