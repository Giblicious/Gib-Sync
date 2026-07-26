import type { LiveSyncStatus } from "./settings";

export type IndicatorTone="neutral"|"success"|"active"|"warning"|"error";
export interface IndicatorState{
  key:"setup"|"blocked"|"attention"|"syncing"|"queued"|"synced"|"error";
  label:string;
  icon:string;
  tone:IndicatorTone;
  animated:boolean;
  attentionCount:number;
  description:string;
}
export interface IndicatorHealth { errors:number; warnings:number; description?:string; }

const activePhases=new Set(["scanning","reading-remote","merging","applying","uploading","committing","mirroring"]);

export function deriveIndicatorState(live:LiveSyncStatus,configured:boolean,blocked:boolean,attentionCount=0,health:IndicatorHealth={errors:0,warnings:0}):IndicatorState{
  if(!configured)return {key:"setup",label:"Setup",icon:"circle-dashed",tone:"neutral",animated:false,attentionCount:0,description:"Gib Sync is not configured"};
  if(blocked)return {key:"blocked",label:"Paused",icon:"pause-circle",tone:"warning",animated:false,attentionCount:0,description:"Synchronization is paused"};
  if(attentionCount>0)return {key:"attention",label:"Attention",icon:"triangle-alert",tone:"warning",animated:false,attentionCount,description:`${attentionCount} held change${attentionCount===1?"":"s"} need review`};
  if(live.running||activePhases.has(live.phase))return {key:"syncing",label:"Syncing",icon:"refresh-cw",tone:"active",animated:true,attentionCount:0,description:live.message};
  if(live.phase==="scheduled")return {key:"queued",label:"Queued",icon:"clock-3",tone:"active",animated:false,attentionCount:0,description:live.message};
  if(live.phase==="error")return {key:"error",label:"Error",icon:"cloud-off",tone:"error",animated:false,attentionCount:0,description:live.lastError||live.message};
  if(health.errors>0)return {key:"error",label:"Needs repair",icon:"cloud-off",tone:"error",animated:false,attentionCount:0,description:health.description??`${health.errors} server health error${health.errors===1?"":"s"}`};
  if(health.warnings>0)return {key:"attention",label:"Needs attention",icon:"triangle-alert",tone:"warning",animated:false,attentionCount:0,description:health.description??`${health.warnings} health warning${health.warnings===1?"":"s"}`};
  return {key:"synced",label:"Synced",icon:"check",tone:"success",animated:false,attentionCount:0,description:live.message};
}
