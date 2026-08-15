import type { LiveSyncStatus } from "./settings";
import type { IndicatorState } from "./status";

export type QuickStatusAction="setup"|"resolve"|"review"|"resume"|"sync";

export interface QuickStatusModel {
  description:string;
  meta:string;
  primaryAction:QuickStatusAction;
  primaryLabel:string;
  primaryDisabled:boolean;
}

function relativeTime(value:string|null|undefined,now:number):string{
  if(!value)return "never";
  const timestamp=Date.parse(value);
  if(!Number.isFinite(timestamp))return "never";
  const seconds=Math.max(0,Math.floor((now-timestamp)/1000));
  if(seconds<10)return "just now";
  if(seconds<60)return `${seconds} sec ago`;
  const minutes=Math.floor(seconds/60);
  if(minutes<60)return `${minutes} min ago`;
  const hours=Math.floor(minutes/60);
  if(hours<24)return `${hours} hr ago`;
  const days=Math.floor(hours/24);
  if(days<7)return `${days} day${days===1?"":"s"} ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function buildQuickStatusModel(input:{
  state:IndicatorState;
  live:LiveSyncStatus;
  configured:boolean;
  nativeSyncBlocked:boolean;
  paused:boolean;
  now?:number;
}):QuickStatusModel{
  const {state,live,configured,nativeSyncBlocked,paused}=input;
  const now=input.now??Date.now();
  let description:string;
  if(!configured)description="Connect this vault to start syncing.";
  else if(nativeSyncBlocked)description="Turn off Obsidian Sync to continue safely.";
  else if(paused)description="Automatic syncing is paused.";
  else if(state.key==="attention"&&state.attentionCount>0)description=`${state.attentionCount} held change${state.attentionCount===1?"":"s"} need review.`;
  else if(state.key==="syncing")description=live.message||"Syncing your vault…";
  else if(state.key==="queued")description="Changes are waiting to sync.";
  else if(state.key==="error")description=live.lastError||state.description||"Sync could not finish.";
  else if(state.key==="attention")description=state.description||"Gib Sync needs your attention.";
  else description="Your vault is up to date.";

  let meta:string;
  if(!configured)meta="Not connected";
  else if(state.key==="syncing"&&live.total)meta=`${Math.min(live.current??0,live.total)} of ${live.total} items`;
  else if(state.key==="syncing")meta="Working now";
  else if(state.key==="queued")meta="Waiting to start";
  else meta=live.lastSuccessAt?`Last synced ${relativeTime(live.lastSuccessAt,now)}`:"No successful sync yet";

  if(!configured)return {description,meta,primaryAction:"setup",primaryLabel:"Set up",primaryDisabled:false};
  if(nativeSyncBlocked)return {description,meta,primaryAction:"resolve",primaryLabel:"Resolve",primaryDisabled:false};
  if(state.attentionCount>0)return {description,meta,primaryAction:"review",primaryLabel:"Review",primaryDisabled:false};
  if(paused)return {description,meta,primaryAction:"resume",primaryLabel:"Resume",primaryDisabled:false};
  return {description,meta,primaryAction:"sync",primaryLabel:live.running?"Syncing…":state.key==="error"?"Try again":"Sync now",primaryDisabled:live.running};
}
