import {PrivateStaging,SERVER_INLINE_BYTES,type StagedFile} from "./security-stream.js";
export interface StagedBinaryBody{kind:"staged-binary";file:StagedFile;}
export function isStagedBinary(value:unknown):value is StagedBinaryBody{return Boolean(value&&typeof value==="object"&&(value as StagedBinaryBody).kind==="staged-binary");}
export async function parseBinaryBody(source:AsyncIterable<Uint8Array>,staging:PrivateStaging,maximum:number):Promise<Buffer|StagedBinaryBody>{
  const iterator=source[Symbol.asyncIterator](),prefix:Uint8Array[]=[];let size=0,finished=false,cancelled=false;
  const cancel=async()=>{if(finished||cancelled)return;cancelled=true;try{await iterator.return?.();}catch{/* Cleanup must not replace the original size/I/O failure. */}};
  try{
    while(size<=SERVER_INLINE_BYTES){const item=await iterator.next();if(item.done){finished=true;break;}size+=item.value.length;if(size>maximum)throw Object.assign(new Error("Binary request exceeds its permitted byte limit"),{statusCode:413});prefix.push(item.value);}
    if(finished)return Buffer.concat(prefix,size);
    const chunks=(async function*(){try{for(const value of prefix)yield value;for(;;){const item=await iterator.next();if(item.done){finished=true;break;}yield item.value;}}finally{await cancel();}})();
    return {kind:"staged-binary",file:await staging.fromChunks(chunks,maximum)};
  }catch(error){await cancel();throw error;}
}
