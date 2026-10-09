import type { LiveSyncStatus } from "./settings";

export type IndicatorTone="neutral"|"success"|"active"|"warning"|"error";
export interface IndicatorState{
  key:"setup"|"blocked"|"attention"|"checking"|"retrying"|"offline"|"syncing"|"queued"|"synced"|"error";
  label:string;
  icon:string;
  tone:IndicatorTone;
  animated:boolean;
  attentionCount:number;
  description:string;
}
export interface IndicatorHealth { errors:number; warnings:number; description?:string; }

const transferPhases=new Set(["applying","uploading","committing","mirroring"]);

export function deriveIndicatorState(live:LiveSyncStatus,configured:boolean,blocked:boolean,attentionCount=0,health:IndicatorHealth={errors:0,warnings:0}):IndicatorState{
  if(!configured)return {key:"setup",label:"Setup",icon:"circle-dashed",tone:"neutral",animated:false,attentionCount:0,description:"Gib Sync is not configured"};
  if(blocked)return {key:"blocked",label:"Paused",icon:"pause-circle",tone:"neutral",animated:false,attentionCount:0,description:"Synchronization is paused"};
  if(attentionCount>0)return {key:"attention",label:"Attention",icon:"triangle-alert",tone:"warning",animated:false,attentionCount,description:`${attentionCount} held change${attentionCount===1?"":"s"} need review`};
  if(health.errors>0)return {key:"error",label:"Needs repair",icon:"cloud-off",tone:"error",animated:false,attentionCount:0,description:health.description??`${health.errors} server health error${health.errors===1?"":"s"}`};
  if(live.phase==="blocked")return {key:"blocked",label:"Needs attention",icon:"shield-alert",tone:"warning",animated:false,attentionCount:0,description:live.message};
  if(live.phase==="retrying")return {key:"retrying",label:"Retrying",icon:"clock-3",tone:"active",animated:false,attentionCount:0,description:live.running?"Sync was interrupted. Retrying automatically…":"Reconnecting to incoming updates. Automatic checks remain active."};
  if(live.phase==="offline")return {key:"offline",label:"Offline",icon:"cloud-off",tone:"neutral",animated:false,attentionCount:0,description:"Could not reach the server. Your changes remain on this device."};
  if(live.phase==="error")return {key:"error",label:"Sync couldn’t finish",icon:"triangle-alert",tone:"error",animated:false,attentionCount:0,description:live.lastError||live.message};
  if(health.warnings>0)return {key:"attention",label:"Needs attention",icon:"triangle-alert",tone:"warning",animated:false,attentionCount:0,description:health.description??`${health.warnings} health warning${health.warnings===1?"":"s"}`};
  if(live.running&&transferPhases.has(live.phase))return {key:"syncing",label:"Syncing",icon:"refresh-cw",tone:"active",animated:true,attentionCount:0,description:live.total?`Syncing ${Math.min(live.current??0,live.total)} of ${live.total} files`:"Syncing your vault…"};
  const verified=Boolean(live.verified&&live.lastSuccessAt&&!live.pendingChanges);
  if(live.running)return {key:"checking",label:"Checking",icon:"check",tone:verified?"success":"neutral",animated:true,attentionCount:0,description:verified?"Checking for changes. Last check confirmed this device was up to date.":"Checking this device against the server."};
  if(live.pendingChanges)return {key:"queued",label:"Changes waiting",icon:"clock-3",tone:"active",animated:false,attentionCount:0,description:`${live.pendingChanges} change${live.pendingChanges===1?"":"s"} waiting to sync`};
  if(live.phase==="scheduled"&&!verified)return {key:"checking",label:"Check scheduled",icon:"clock-3",tone:"neutral",animated:false,attentionCount:0,description:"Waiting to check this device against the server."};
  if(!verified)return {key:"checking",label:"Not verified yet",icon:"circle-dashed",tone:"neutral",animated:false,attentionCount:0,description:"This device has not verified the current server state yet."};
  return {key:"synced",label:"Up to date",icon:"check",tone:"success",animated:false,attentionCount:0,description:"This device has verified the latest server snapshot."};
}
