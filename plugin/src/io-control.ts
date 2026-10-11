import {ApiTransportError} from "./api";

/** Abort stalled readers and paused network work without cancelling native writes. */
export async function controlledIo<T>(checkpoint:()=>void,operation:(signal:AbortSignal,touch:()=>void)=>Promise<T>):Promise<T>{
  const controller=new AbortController();let deadline=Date.now()+120_000,cancelled:unknown;
  checkpoint();
  const timer=setInterval(()=>{
    try{checkpoint();if(Date.now()>deadline)throw new ApiTransportError(new Error("File transfer stalled; retrying safely"));}
    catch(error){cancelled=error;controller.abort();}
  },250);
  try{return await operation(controller.signal,()=>{deadline=Date.now()+120_000;});}
  catch(error){throw cancelled??error;}
  finally{clearInterval(timer);controller.abort();}
}
