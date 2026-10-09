import { ApiError,ApiTransportError } from "./api";

export function isTransientSyncError(error:unknown):boolean{
  return error instanceof ApiTransportError||error instanceof ApiError&&[408,409,429,500,502,503,504].includes(error.status);
}

export class SyncCancelledError extends Error {}

/** Retry the journal-aware reconciliation, never blindly replay a commit request. */
export async function recoverSync<T>(operation:()=>Promise<T>,options:{
  shouldContinue:()=>boolean;
  onRetry:(error:unknown,attempt:number,delay:number)=>void;
  wait:(delay:number)=>Promise<void>;
}):Promise<T>{
  const delays=[2000,5000,10000];
  for(let attempt=0;;attempt++){
    if(!options.shouldContinue())throw new SyncCancelledError("Sync paused");
    try{return await operation();}catch(error){
      if(!isTransientSyncError(error)||attempt>=delays.length)throw error;
      options.onRetry(error,attempt+1,delays[attempt]);
      await options.wait(delays[attempt]);
    }
  }
}
