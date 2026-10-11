import type { LiveSyncStatus } from "./settings";
import type { IndicatorState } from "./status";
import type { ServerStatus } from "@gib-sync/protocol";

export interface SyncFact { label:string;value:string;detail:string;tone:"neutral"|"success"|"active"|"warning"; }

/** Accepted history, readable storage and device acknowledgements are separate facts. */
export function buildSyncFacts(live:LiveSyncStatus,server:ServerStatus|null,localSnapshotId:string|null):SyncFact[]{
  const pending=live.pendingChanges??0,headId=server?.head?.id??null,current=Boolean(headId&&headId===localSnapshotId&&live.verified&&!pending);
  const other=server?.devices.filter((device)=>!device.current&&!device.revokedAt)??[];
  const caughtUp=headId?other.filter((device)=>device.acknowledgedSnapshotId===headId).length:0;
  return [
    {label:"This device",value:pending?`${pending} change${pending===1?"":"s"} waiting`:current?"Up to date":live.verified?"Last check passed":"Checking",detail:pending?"Local changes have not finished syncing yet.":current?"This device confirmed the latest accepted server version.":"A successful sync verifies what this device has received.",tone:pending?"active":current?"success":"neutral"},
    {label:"Accepted server copy",value:pending?"Waiting for this device":headId?headId===localSnapshotId?"Received":"Updates available":"Not verified",detail:"Accepted versions are stored in server history before other devices download them.",tone:pending||headId&&headId!==localSnapshotId?"active":headId?"success":"neutral"},
    {label:"Other devices",value:!server?"Checking":!other.length?"No other active devices":!headId?"Not verified":caughtUp===other.length?`${caughtUp} caught up`:`${caughtUp} of ${other.length} confirmed`,detail:!other.length?"Add another device with manual setup or a temporary code.":"A device is confirmed only after it acknowledges this accepted version; offline devices catch up when opened.",tone:caughtUp===other.length&&other.length>0?"success":"neutral"},
    {label:"Readable Seafile copy",value:!server?"Checking":server.externalError||server.projection?.lastError?"Retrying safely":server.mirrorCurrent?"Current":"Catching up",detail:"This readable copy is separate from accepted sync history. Other devices can sync while Seafile catches up.",tone:server?.externalError||server?.projection?.lastError?"warning":server?.mirrorCurrent?"success":server?"active":"neutral"}
  ];
}

export type QuickStatusAction="setup"|"resolve"|"review"|"resume"|"settings"|"sync";

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
  else if(state.key==="blocked")description=state.description||"Synchronization is safely paused.";
  else if(state.key==="attention"&&state.attentionCount>0)description=`${state.attentionCount} held change${state.attentionCount===1?"":"s"} need review.`;
  else if(state.key==="syncing"||state.key==="checking"||state.key==="retrying"||state.key==="offline")description=state.description;
  else if(state.key==="queued")description=state.description;
  else if(state.key==="error")description=live.lastError||state.description||"Sync could not finish.";
  else if(state.key==="attention")description=state.description||"Gib Sync needs your attention.";
  else description="Your vault is up to date.";

  let meta:string;
  if(!configured)meta="Not connected";
  else if(state.key==="syncing"&&live.total)meta=`${Math.min(live.current??0,live.total)} of ${live.total} files`;
  else if(state.key==="syncing")meta="Working now";
  else if(state.key==="retrying")meta=live.nextSyncAt?`Retrying in ${Math.max(1,Math.ceil((Date.parse(live.nextSyncAt)-now)/1000))} sec`:"Retrying automatically";
  else if(state.key==="queued")meta=live.pendingChanges?`${live.pendingChanges} pending change${live.pendingChanges===1?"":"s"}`:"Waiting to check";
  else meta=live.lastSuccessAt?`Last verified ${relativeTime(live.lastSuccessAt,now)}`:"Not verified yet";

  if(!configured)return {description,meta,primaryAction:"setup",primaryLabel:"Set up",primaryDisabled:false};
  if(nativeSyncBlocked)return {description,meta,primaryAction:"resolve",primaryLabel:"Resolve",primaryDisabled:false};
  if(state.attentionCount>0)return {description,meta,primaryAction:"review",primaryLabel:"Review",primaryDisabled:false};
  if(paused)return {description,meta,primaryAction:"resume",primaryLabel:"Resume",primaryDisabled:false};
  if(state.key==="blocked")return state.label==="Server paused"||/emergency containment/i.test(state.description)
    ?{description,meta,primaryAction:"sync",primaryLabel:"Server paused",primaryDisabled:true}
    :{description,meta,primaryAction:"settings",primaryLabel:"Open settings",primaryDisabled:false};
  return {description,meta,primaryAction:"sync",primaryLabel:live.running?(state.key==="checking"?"Checking…":state.key==="retrying"?"Retrying…":"Syncing…"):state.key==="error"||state.key==="offline"?"Try again":"Sync now",primaryDisabled:live.running};
}
