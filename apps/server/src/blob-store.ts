import {readFile} from "node:fs/promises";
import {createReadStream} from "node:fs";
import type {Config} from "./config.js";
import type {Store} from "./db.js";
import {StorageMissingError,type SeafileStorage,type VaultStorageRow} from "./seafile.js";
import {openJson} from "./security.js";
import {BlobIntegrityError,PrivateStaging,SERVER_INLINE_BYTES,decryptBlobFile,encryptBlobFile,type StagedFile} from "./security-stream.js";
export const recoverableBlobFailure=(error:unknown)=>error instanceof BlobIntegrityError||error instanceof StorageMissingError;

/** All accepted content is authenticated on private disk before it is exposed. */
export class VerifiedBlobStore{
  readonly staging:PrivateStaging;
  constructor(private readonly config:Config,private readonly store:Store,private readonly storage:SeafileStorage){this.staging=new PrivateStaging(config.DATA_DIR);}
  recordVerified(vaultId:string,hash:string,clearSize:number,cipherSize:number):void{
    if(!Number.isSafeInteger(clearSize)||clearSize<0||cipherSize!==clearSize+29)throw new Error("Invalid verified content byte sizes");
    const previous=this.store.one<{clear_size:number}>("SELECT clear_size FROM blob_integrity WHERE vault_id=? AND hash=?",vaultId,hash);if(previous&&previous.clear_size!==clearSize)throw new Error("Verified content size contradicts its immutable hash");
    this.store.run("INSERT INTO blob_integrity(vault_id,hash,clear_size,cipher_size,verified_at) VALUES(?,?,?,?,?) ON CONFLICT(vault_id,hash) DO UPDATE SET cipher_size=excluded.cipher_size,verified_at=excluded.verified_at",vaultId,hash,clearSize,cipherSize,new Date().toISOString());
  }
  private key(vaultId:string):string{const row=this.store.one<{wrapped_key:string}>("SELECT wrapped_key FROM vaults WHERE id=?",vaultId);if(!row)throw new Error("Unknown vault");return openJson<string>(row.wrapped_key,this.config.GIBSYNC_SERVER_SECRET,vaultId);}
  private async smallFallback(bytes:Uint8Array,maximum:number):Promise<StagedFile>{if(bytes.length>SERVER_INLINE_BYTES+29||bytes.length>maximum)throw new Error("Storage adapter must provide bounded file streaming for this content");return this.staging.fromChunks((async function*(){yield bytes;})(),maximum);}
  async readable(row:VaultStorageRow,path:string,revisionId?:string,signal?:AbortSignal):Promise<StagedFile>{
    if(revisionId&&typeof this.storage.getReadableRevisionToFile==="function")return this.storage.getReadableRevisionToFile(row,path,revisionId,this.staging,signal);
    if(!revisionId&&typeof this.storage.getReadableToFile==="function")return this.storage.getReadableToFile(row,path,this.staging,signal);
    const metadata=!revisionId&&typeof this.storage.statReadable==="function"?await this.storage.statReadable(row,path):null;if(metadata&&metadata.size>SERVER_INLINE_BYTES)throw new Error("Storage adapter cannot safely stream this file");
    return this.smallFallback(revisionId?await this.storage.getReadableRevision(row,path,revisionId):await this.storage.getReadable(row,path),this.config.MAX_BLOB_BYTES);
  }
  private async pair(row:VaultStorageRow,hash:string,signal?:AbortSignal):Promise<{encrypted:StagedFile;clear:StagedFile}|null>{
    const registry=this.store.one<{size:number}>("SELECT size FROM blobs WHERE vault_id=? AND hash=?",row.id,hash);if(!registry)return null;
    const relative=`blobs/${hash.slice(0,2)}/${hash}.gbs`;
    const download=async()=>typeof this.storage.getToFile==="function"?this.storage.getToFile(row,relative,this.staging,signal):registry.size<=SERVER_INLINE_BYTES+29?this.smallFallback(await this.storage.get(row,relative),this.config.MAX_BLOB_BYTES+1024):Promise.reject(new Error("Storage adapter cannot safely stream this blob"));
    const checked=async()=>{const encrypted=await download();try{const clear=await decryptBlobFile(encrypted.path,this.key(row.id),hash,this.staging,this.config.MAX_BLOB_BYTES,signal);try{this.recordVerified(row.id,hash,clear.size,encrypted.size);return {encrypted,clear};}catch(error){await clear.dispose();throw error;}}catch(error){await encrypted.dispose();throw error;}};
    try{return await checked();}
    catch(error){
      signal?.throwIfAborted();if(!recoverableBlobFailure(error))throw error;
      const vault=this.store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",row.id),entry=vault?.head_id?this.store.getSnapshot(vault.head_id)?.entries.find(e=>e.hash===hash):undefined;
      if(!entry)throw error;
      const clear=await this.readable(row,entry.path,undefined,signal);
      try{if(clear.hash!==hash||clear.size!==entry.size)throw error;await this.persist(row,clear,signal);return await checked();}finally{await clear.dispose();}
    }
  }
  async encrypted(row:VaultStorageRow,hash:string,signal?:AbortSignal):Promise<StagedFile|null>{const pair=await this.pair(row,hash,signal);if(!pair)return null;await pair.clear.dispose();return pair.encrypted;}
  async clear(row:VaultStorageRow,hash:string,signal?:AbortSignal):Promise<StagedFile>{
    const pair=await this.pair(row,hash,signal);if(!pair)throw new Error("Accepted content is unavailable");await pair.encrypted.dispose();return pair.clear;
  }
  async readSmall(row:VaultStorageRow,hash:string,maximum=SERVER_INLINE_BYTES):Promise<Uint8Array>{
    const clear=await this.clear(row,hash);try{if(clear.size>maximum)throw new Error("Content requires streamed reconciliation");return new Uint8Array(await readFile(clear.path));}finally{await clear.dispose();}
  }
  async persist(row:VaultStorageRow,clear:StagedFile,signal?:AbortSignal):Promise<void>{
    const encrypted=await encryptBlobFile(clear.path,this.key(row.id),clear.hash,this.staging,this.config.MAX_BLOB_BYTES,signal);
    try{
      const relative=`blobs/${clear.hash.slice(0,2)}/${clear.hash}.gbs`;
      if(typeof this.storage.putFile==="function")await this.storage.putFile(row,relative,encrypted.path,signal);
      else{if(encrypted.size>SERVER_INLINE_BYTES+29)throw new Error("Storage adapter cannot safely persist streamed content");await this.storage.put(row,relative,new Uint8Array(await readFile(encrypted.path)));}
      this.store.run("INSERT OR IGNORE INTO blobs(vault_id,hash,size,created_at) VALUES(?,?,?,?)",row.id,clear.hash,encrypted.size,new Date().toISOString());
      this.recordVerified(row.id,clear.hash,encrypted.size-29,encrypted.size);
    }finally{await encrypted.dispose();}
  }
  async prepend(row:VaultStorageRow,hash:string,prefix:string,signal?:AbortSignal):Promise<{hash:string;size:number}>{
    const source=await this.clear(row,hash,signal),bytes=Buffer.from(prefix);
    try{
      const combined=await this.staging.fromChunks((async function*(){yield bytes;for await(const chunk of createReadStream(source.path,{highWaterMark:64*1024}))yield chunk;})(),this.config.MAX_BLOB_BYTES,signal);
      try{await this.persist(row,combined,signal);return {hash:combined.hash,size:combined.size};}finally{await combined.dispose();}
    }finally{await source.dispose();}
  }
}
