import type {DataAdapter} from "obsidian";
import {sha256} from "@noble/hashes/sha2.js";
import {bytesToHex} from "@noble/hashes/utils.js";
import {hashBytes} from "./crypto";
import {controlledIo} from "./io-control";

export class AdapterFileChangedError extends Error{
  override readonly name="AdapterFileChangedError";
  constructor(readonly path:string){super(`${path} changed while its content was being verified.`);}
}

export async function streamAdapterFile(adapter:DataAdapter,path:string,expectedHash:string,expectedSize:number,onChunk:(chunk:Uint8Array)=>Promise<void>,checkpoint:()=>void,cooperate:()=>Promise<void>):Promise<void>{
  const before=await adapter.stat(path);checkpoint();if(before?.type!=="file"||before.size!==expectedSize)throw new AdapterFileChangedError(path);
  const resource=(adapter as DataAdapter&{getResourcePath?:(path:string)=>string}).getResourcePath;
  if(typeof resource!=="function"){
    if(expectedSize>=8*1024*1024)throw new Error("This adapter cannot safely stream this large file; it remains local and sync will retry.");
    const bytes=new Uint8Array(await adapter.readBinary(path));checkpoint();if(bytes.length!==expectedSize||await hashBytes(bytes)!==expectedHash)throw new AdapterFileChangedError(path);for(let offset=0;offset<bytes.length;offset+=64*1024){await onChunk(bytes.subarray(offset,offset+64*1024));await cooperate();}const after=await adapter.stat(path);checkpoint();if(after?.type!=="file"||after.size!==before.size||after.mtime!==before.mtime||after.ctime!==before.ctime)throw new AdapterFileChangedError(path);return;
  }
  await controlledIo(checkpoint,async(signal,touch)=>{
    const response=await fetch(resource.call(adapter,path),{signal,cache:"no-store"});checkpoint();if(!response.ok||!response.body)throw new Error("This adapter could not stream the saved file safely; it was left unchanged.");
    const reader=response.body.getReader(),digest=sha256.create();let size=0;const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener("abort",cancel,{once:true});
    try{for(;;){checkpoint();const {done,value}=await reader.read();checkpoint();if(done)break;touch();if(size+value.byteLength>expectedSize)throw new AdapterFileChangedError(path);for(let offset=0;offset<value.length;offset+=64*1024){const chunk=value.subarray(offset,offset+64*1024);digest.update(chunk);size+=chunk.length;await onChunk(chunk);await cooperate();}}
      const after=await adapter.stat(path);checkpoint();if(size!==expectedSize||bytesToHex(digest.digest())!==expectedHash||after?.type!=="file"||after.size!==before.size||after.mtime!==before.mtime||after.ctime!==before.ctime)throw new AdapterFileChangedError(path);
    }finally{signal.removeEventListener("abort",cancel);digest.destroy();await reader.cancel().catch(()=>{});reader.releaseLock();}
  });
}

/** Public Obsidian resource URLs permit bounded hash reads on supported adapters. */
export async function hashAdapterFile(adapter:DataAdapter,path:string,checkpoint:()=>void,cooperate:()=>Promise<void>,allowBufferedFallback=true):Promise<string>{
  const before=await adapter.stat(path);checkpoint();if(!before||before.type!=="file")throw new AdapterFileChangedError(path);
  const verify=async(hash:string,size:number)=>{const after=await adapter.stat(path);checkpoint();if(!after||after.type!=="file"||before.size!==size||after.size!==size||before.mtime!==after.mtime||before.ctime!==after.ctime)throw new AdapterFileChangedError(path);return hash;};
  const resource=(adapter as DataAdapter&{getResourcePath?:(path:string)=>string}).getResourcePath;
  if(typeof resource==="function"&&typeof fetch==="function"){
    const result=await controlledIo(checkpoint,async(signal,touch)=>{
    let response:Response|undefined;
    try{response=await fetch(resource.call(adapter,path),{signal,cache:"no-store"});}catch(error){if(signal.aborted)throw error;/* Older native resource readers can require readBinary. */}
    checkpoint();
    if(response?.ok&&response.body){
      const hash=sha256.create(),reader=response.body.getReader();let size=0;
      const cancel=()=>{void reader.cancel().catch(()=>undefined);};signal.addEventListener("abort",cancel,{once:true});
      try{for(;;){checkpoint();const {done,value}=await reader.read();checkpoint();if(done)break;touch();size+=value.byteLength;if(size>before.size)throw new AdapterFileChangedError(path);for(let offset=0;offset<value.byteLength;offset+=64*1024){hash.update(value.subarray(offset,offset+64*1024));await cooperate();}}return await verify(bytesToHex(hash.digest()),size);}
      finally{signal.removeEventListener("abort",cancel);hash.destroy();await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    }
    await response?.body?.cancel().catch(()=>{});return null;
    });if(result!==null)return result;
  }
  if(!allowBufferedFallback)throw new Error("This adapter cannot safely stream this large file; it remains local and sync will retry. Update Obsidian or use a native filesystem vault.");
  checkpoint();const bytes=new Uint8Array(await adapter.readBinary(path));checkpoint();return verify(await hashBytes(bytes),bytes.byteLength);
}
