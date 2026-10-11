import type {DataAdapter} from "obsidian";
import {sha256} from "@noble/hashes/sha2.js";
import {bytesToHex} from "@noble/hashes/utils.js";
import {hashBytes} from "./crypto";
import {ApiError,type ContentUploadState,type GibSyncApi} from "./api";
import {AdapterFileChangedError} from "./file-io";
import {controlledIo} from "./io-control";

const CHUNK_BYTES=256*1024;
type UploadApi=Pick<GibSyncApi,"beginContentUpload"|"putContentUploadChunk"|"completeContentUpload"|"disableStreamUpload">&Partial<Pick<GibSyncApi,"cancelContentUpload">>;

/** Read native storage once, including resumed prefixes, without full-file buffers. */
export async function uploadAdapterFile(adapter:DataAdapter,path:string,hash:string,size:number,api:UploadApi,checkpoint:()=>void,cooperate:()=>Promise<void>,processing:(stage:"verifying"|"uploading"|"checking"|"waiting")=>void=()=>{}):Promise<boolean>{
  const before=await adapter.stat(path);checkpoint();if(before?.type!=="file"||before.size!==size)throw new AdapterFileChangedError(path);
  const resource=(adapter as DataAdapter&{getResourcePath?:(path:string)=>string}).getResourcePath;if(typeof resource!=="function")throw new Error("This adapter cannot safely stream this large file; it remains local and sync will retry. Update Obsidian or use a native filesystem vault.");
  return controlledIo(checkpoint,async(signal,touch)=>{
    let session:ContentUploadState;
    try{session=await api.beginContentUpload(hash,size,signal);}catch(error){if(error instanceof ApiError&&error.status===404){api.disableStreamUpload();return false;}throw error;}
    checkpoint();touch();
    if(!session||session.hash!==hash||session.size!==size||session.chunkBytes!==CHUNK_BYTES||typeof session.id!=="string"||!session.id||typeof session.complete!=="boolean"||!Number.isSafeInteger(session.offset)||session.offset<0||session.offset>size||session.complete&&session.offset!==size||session.offset!==size&&session.offset%CHUNK_BYTES!==0)throw new Error("The server returned an invalid resumable upload state");
    const response=await fetch(resource.call(adapter,path),{signal,cache:"no-store"});checkpoint();
    if(!response.ok||!response.body)throw new Error("This device could not stream the saved file safely. Its content was not committed.");
    const reader=response.body.getReader(),digest=sha256.create(),chunk=new Uint8Array(CHUNK_BYTES);let read=0,filled=0,uploaded=session.offset,processingId=session.processingId;
    const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener("abort",cancel,{once:true});
    const send=async()=>{const start=read-filled;if(read>session.offset){if(start<session.offset)throw new Error("The upload resume offset does not align with its chunks");checkpoint();const body=chunk.subarray(0,filled),receipt=await api.putContentUploadChunk(session.id,start/CHUNK_BYTES,body,await hashBytes(body),signal);checkpoint();touch();if(receipt.id!==session.id||receipt.offset!==read)throw new Error("The server returned an invalid upload chunk receipt");uploaded=receipt.offset;}filled=0;};
    try{
      for(;;){checkpoint();const {done,value}=await reader.read();checkpoint();if(done)break;touch();if(read+value.byteLength>size)throw new AdapterFileChangedError(path);
        for(let offset=0;offset<value.byteLength;){const length=Math.min(64*1024,CHUNK_BYTES-filled,value.byteLength-offset),part=value.subarray(offset,offset+length);digest.update(part);chunk.set(part,filled);filled+=length;read+=length;offset+=length;if(filled===CHUNK_BYTES)await send();await cooperate();}
      }
      if(filled)await send();
      const after=await adapter.stat(path);checkpoint();if(read!==size||bytesToHex(digest.digest())!==hash||after?.type!=="file"||after.size!==before.size||after.mtime!==before.mtime||after.ctime!==before.ctime)throw new AdapterFileChangedError(path);
      if(uploaded!==size)throw new Error("The resumable upload did not acknowledge the complete file");
      if(!session.complete){let previousStage:ContentUploadState["stage"];
        for(;;){checkpoint();const completed=await api.completeContentUpload(session.id,signal);if(completed.id!==session.id||completed.hash!==hash||completed.size!==size||completed.offset!==size||completed.chunkBytes!==CHUNK_BYTES||typeof completed.complete!=="boolean")throw new Error("The server did not verify the completed large-file upload");if(typeof completed.processingId==="string")processingId=completed.processingId;checkpoint();touch();if(completed.complete)break;if(completed.processing!==true||!completed.stage||!["verifying","uploading","checking","waiting"].includes(completed.stage))throw new Error("The server returned an invalid upload processing state");if(previousStage!==completed.stage){processing(completed.stage);previousStage=completed.stage;}
          await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);signal.removeEventListener("abort",abort);reject(new Error("Upload paused"));},timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},1000);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();});checkpoint();
        }
      }
      const finalStat=await adapter.stat(path);checkpoint();if(finalStat?.type!=="file"||finalStat.size!==before.size||finalStat.mtime!==before.mtime||finalStat.ctime!==before.ctime)throw new AdapterFileChangedError(path);
      return true;
    }catch(error){let ownerStopped=signal.aborted;if(!ownerStopped)try{checkpoint();}catch{ownerStopped=true;}if(ownerStopped&&processingId&&typeof api.cancelContentUpload==="function"){const cancelling=new AbortController(),timer=setTimeout(()=>cancelling.abort(),2000);try{await api.cancelContentUpload(session.id,processingId,cancelling.signal);}catch{/* Only an exact known attempt is cancelled; ambiguous jobs remain safe blob-only work. */}finally{clearTimeout(timer);}}throw error;}
    finally{signal.removeEventListener("abort",cancel);digest.destroy();await reader.cancel().catch(()=>{});reader.releaseLock();}
  });
}
