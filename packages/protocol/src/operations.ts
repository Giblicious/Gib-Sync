import type { FileRevision, ManifestEntry, Snapshot } from "./index.js";

export interface FolderEntry { folderId:string; path:string; revision:FileRevision; }
export interface SyncTombstone {targetId:string;entityKind:"file"|"folder";path:string;revision:FileRevision;deletedSequence:number;deletedOrdinal?:number;content?:OperationContent;}
export interface SyncTree {snapshotId:string|null;sequence:number;files:ManifestEntry[];folders:FolderEntry[];tombstones:SyncTombstone[];}
export interface OperationBase {operationId:string;targetId:string;baseRevisionId:string|null;}
export interface OperationContent {hash:string;size:number;mtime:number;}
export type SyncOperation =
  | (OperationBase & {kind:"create";path:string;content:OperationContent})
  | (OperationBase & {kind:"edit";content:OperationContent})
  | (OperationBase & {kind:"move";newPath:string})
  | (OperationBase & {kind:"delete"})
  | (OperationBase & {kind:"recreate";newTargetId:string;path:string;content:OperationContent;deletedByOperationId?:string})
  | (OperationBase & {kind:"mkdir";path:string;newTargetId?:string;deletedByOperationId?:string})
  | (OperationBase & {kind:"rmdir"})
  | (OperationBase & {kind:"move-folder";newPath:string;descendants:Array<{targetId:string;baseRevisionId:string}>});
export interface OperationBatch {batchId:string;baseSnapshotId:string|null;message:string;operations:SyncOperation[];}
export interface OperationReceipt {batchId:string;snapshot:Snapshot;sequence:number;replayed:boolean;}
export interface RolloutStatus {mode:"shadow"|"canary"|"active"|"hold";canaryDeviceId:string|null;comparisons:number;mismatches:number;canaryBatches:number;reason:string|null;}

export type ReconcileKind="unchanged"|"equal"|"local-only"|"remote-only"|"concurrent-edit"|"edit-delete"|"independent-create";
export type ReconcileStrategy="text"|"json-settings"|"whole-file";
export const MAX_SETTINGS_JSON_BYTES=2*1024*1024;
export function reconciliationStrategy(path:string):ReconcileStrategy{const normalized=path.replace(/\\/g,"/").toLowerCase();return normalized.startsWith(".obsidian/")?normalized.endsWith(".json")?"json-settings":"whole-file":"text";}
export interface ReconcileDecision {path:string;kind:ReconcileKind;strategy:ReconcileStrategy;base?:ManifestEntry;local?:ManifestEntry;remote?:ManifestEntry;}
export interface ReconciliationInput {base:ManifestEntry[];local:ManifestEntry[];remote:ManifestEntry[];localCreationIntents?:Array<{operationId:string;targetId:string;path:string;baseTargetId:string|null}>;}
export interface ReconciliationPlan {decisions:ReconcileDecision[];}
export interface FolderReconciliation {folders:FolderEntry[];conflicts:Array<{folderId:string;localPath:string|null;remotePath:string|null;chosenPath:string}>;}
/** Identified folders share one policy across local adapters and backend history. */
export function reconcileFolders(input:{base:FolderEntry[];local:FolderEntry[];remote:FolderEntry[];acceptedSide?:'local'|'remote'}):FolderReconciliation{
  const byId=(folders:FolderEntry[])=>{const map=new Map<string,FolderEntry>();for(const folder of folders){if(map.has(folder.folderId))throw new Error("Duplicate folder identity");map.set(folder.folderId,folder);}return map;},base=byId(input.base),local=byId(input.local),remote=byId(input.remote),chosen:FolderEntry[]=[],conflicts:FolderReconciliation["conflicts"]=[];
  for(const id of new Set([...base.keys(),...local.keys(),...remote.keys()])){const b=base.get(id),l=local.get(id),r=remote.get(id);let selected:FolderEntry|undefined;
    if(l?.path===r?.path)selected=r??l;
    else if(!b)selected=r??l;
    else if(l?.path===b.path)selected=r;
    else if(r?.path===b.path)selected=l;
    else {selected=l&&r?(l.revision.modifiedAt>r.revision.modifiedAt?l:r.revision.modifiedAt>l.revision.modifiedAt?r:l.path<r.path?l:r):l??r;if(selected)conflicts.push({folderId:id,localPath:l?.path??null,remotePath:r?.path??null,chosenPath:selected.path});}
    if(selected)chosen.push(selected);
  }
  const accepted=input.acceptedSide==='local'?local:remote,byPath=new Map<string,FolderEntry>();for(const folder of chosen){const key=folder.path.normalize('NFC').toLowerCase(),prior=byPath.get(key),acceptedHere=(entry:FolderEntry)=>accepted.get(entry.folderId)?.path.normalize('NFC').toLowerCase()===key;if(!prior||acceptedHere(folder)&&!acceptedHere(prior)||acceptedHere(folder)===Boolean(prior&&acceptedHere(prior))&&folder.folderId<prior.folderId)byPath.set(key,folder);}
  return {folders:[...byPath.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),conflicts:conflicts.sort((a,b)=>a.folderId<b.folderId?-1:a.folderId>b.folderId?1:0)};
}

const same=(a:ManifestEntry|undefined,b:ManifestEntry|undefined):boolean=>{
  if(!a||!b)return a===b;
  return a.hash===b.hash&&a.size===b.size&&(!a.fileId||!b.fileId||a.fileId===b.fileId);
};

/** The common decision policy. Byte merging/application remain adapter-specific. */
export function decideReconciliation(path:string,base:ManifestEntry|undefined,local:ManifestEntry|undefined,remote:ManifestEntry|undefined):ReconcileDecision{
  let kind:ReconcileKind;
  const localRecreated=Boolean(base?.fileId&&local?.fileId&&local.fileId!==base.fileId),remoteRecreated=Boolean(base?.fileId&&remote?.fileId&&remote.fileId!==base.fileId);
  if(localRecreated||remoteRecreated){if(same(local,remote))kind="equal";else if(localRecreated&&!remoteRecreated&&(!remote||same(base,remote)))kind="local-only";else if(remoteRecreated&&!localRecreated&&(!local||same(base,local)))kind="remote-only";else kind="independent-create";}
  else if(same(local,remote))kind=same(base,local)?"unchanged":"equal";
  else if(same(base,local))kind="remote-only";
  else if(same(base,remote))kind="local-only";
  else if(!base)kind=local&&remote?"independent-create":local?"local-only":"remote-only";
  else if(!local||!remote)kind="edit-delete";
  else if((base.fileId&&local.fileId&&base.fileId!==local.fileId)||(base.fileId&&remote.fileId&&base.fileId!==remote.fileId))kind="independent-create";
  else kind="concurrent-edit";
  return {path,kind,strategy:reconciliationStrategy(path),...base?{base}:{},...local?{local}:{},...remote?{remote}:{}};
}

/** Order-independent, deterministic decisions; observed moves are aligned by callers before planning. */
export function planReconciliation(input:ReconciliationInput):ReconciliationPlan{
  const byPath=(entries:ManifestEntry[])=>{const result=new Map<string,ManifestEntry>();for(const entry of entries){if(result.has(entry.path))throw new Error("Duplicate reconciliation path");result.set(entry.path,entry);}return result;};
  const base=byPath(input.base),local=byPath(input.local),remote=byPath(input.remote);
  return {decisions:[...new Set([...base.keys(),...local.keys(),...remote.keys()])].sort().map(path=>decideReconciliation(path,base.get(path),local.get(path),remote.get(path)))};
}

/** Bounded cooperative work, including sorting: no full-vault synchronous sort. */
export async function planReconciliationCooperative(input:ReconciliationInput,cooperate:()=>Promise<void>):Promise<ReconciliationPlan>{
  let work=0;const step=async()=>{if(++work>=512){work=0;await cooperate();}},paths=new Set<string>();
  const byPath=async(entries:ManifestEntry[])=>{const result=new Map<string,ManifestEntry>();for(const entry of entries){if(result.has(entry.path))throw new Error("Duplicate reconciliation path");result.set(entry.path,entry);paths.add(entry.path);await step();}return result;};
  const base=await byPath(input.base),local=await byPath(input.local),remote=await byPath(input.remote);let ordered:string[]=[];for(const path of paths){ordered.push(path);await step();}
  let scratch=new Array<string>(ordered.length);for(let width=1;width<ordered.length;width*=2){for(let start=0;start<ordered.length;start+=2*width){let a=start,b=Math.min(start+width,ordered.length),endA=b,endB=Math.min(start+2*width,ordered.length);for(let i=start;i<endB;i++){scratch[i]=a<endA&&(b>=endB||ordered[a]!<=ordered[b]!)?ordered[a++]!:ordered[b++]!;await step();}}[ordered,scratch]=[scratch,ordered];}
  const decisions:ReconcileDecision[]=[];for(const path of ordered){decisions.push(decideReconciliation(path,base.get(path),local.get(path),remote.get(path)));await step();}return {decisions};
}

export interface PluginPackageEvidence {entries:ManifestEntry[];version:string|null;complete:boolean;}
export interface PluginPackageChoice {side:"local"|"remote"|"equal"|"base"|"held";entries:ManifestEntry[];reason:string;resolved:boolean;}
const pathOrder=(a:ManifestEntry,b:ManifestEntry)=>a.path<b.path?-1:a.path>b.path?1:0;
const packageEqual=(left:PluginPackageEvidence,right:PluginPackageEvidence)=>{if(left.entries.length!==right.entries.length)return false;const values=new Map(right.entries.map(entry=>[entry.path,entry.hash]));return left.entries.every(entry=>values.get(entry.path)===entry.hash);};
function versionOrder(left:string|null,right:string|null):number{if(left===right)return 0;const parse=(value:string|null)=>typeof value==="string"?value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/):null;const a=parse(left),b=parse(right);if(!a||!b)return a?1:b?-1:0;for(let i=1;i<=3;i++){const x=Number(a[i]),y=Number(b[i]);if(x!==y)return x>y?1:-1;}if(!a[4]||!b[4])return a[4]?-1:b[4]?1:0;const x=a[4].split('.'),y=b[4].split('.');for(let i=0;i<Math.max(x.length,y.length);i++){if(x[i]===undefined)return -1;if(y[i]===undefined)return 1;if(x[i]===y[i])continue;const xn=/^\d+$/.test(x[i]!),yn=/^\d+$/.test(y[i]!);if(xn&&yn)return Number(x[i])>Number(y[i])?1:-1;if(xn!==yn)return xn?-1:1;return x[i]!>y[i]!?1:-1;}return 0;}
/** One package-selection policy, with manifests parsed by bounded adapter I/O. */
export function selectPluginPackage(base:PluginPackageEvidence,local:PluginPackageEvidence,remote:PluginPackageEvidence):PluginPackageChoice{
  const localChanged=!packageEqual(local,base),remoteChanged=!packageEqual(remote,base),choose=(side:"local"|"remote",reason:string,resolved=false):PluginPackageChoice=>({side,entries:[...(side==="local"?local.entries:remote.entries)].sort(pathOrder),reason,resolved});
  if(!local.complete&&!remote.complete&&(local.entries.length||remote.entries.length)){return {side:base.complete?"base":"held",entries:[...base.entries].sort(pathOrder),reason:base.complete?"both incoming packages are incomplete; retained the verified baseline":"no complete package is available; package changes are held while notes continue",resolved:true};}
  if(packageEqual(local,remote))return {side:"equal",entries:[...remote.entries].sort(pathOrder),reason:"identical package",resolved:false};
  if(localChanged&&!remoteChanged&&!local.entries.length)return choose("local","this device removed the package");
  if(!localChanged&&remoteChanged&&!remote.entries.length)return choose("remote","remote package was removed");
  if(local.entries.length&&remote.entries.length&&local.complete!==remote.complete)return choose(local.complete?"local":"remote","complete package repairs an incomplete copy",true);
  const order=versionOrder(local.version,remote.version);if(local.complete&&remote.complete&&order)return choose(order>0?"local":"remote","higher manifest version",true);
  if(local.complete&&remote.complete&&!order){const byPath=new Map(remote.entries.map(entry=>[entry.path,entry]));const overlaps=local.entries.some(entry=>byPath.has(entry.path)&&byPath.get(entry.path)!.hash!==entry.hash);if(!overlaps){for(const entry of local.entries)byPath.set(entry.path,entry);return {side:"equal",entries:[...byPath.values()].sort(pathOrder),reason:"same-version non-overlapping ancillary assets",resolved:true};}}
  if(localChanged&&!remoteChanged)return choose("local",local.entries.length?"only this device changed the package":"this device removed the package");
  if(!localChanged&&remoteChanged)return choose("remote",remote.entries.length?"only the remote package changed":"remote package was removed");
  if(local.complete!==remote.complete)return choose(local.complete?"local":"remote","complete package repairs an incomplete copy",true);
  if(order)return choose(order>0?"local":"remote","higher manifest version",true);
  const modified=(evidence:PluginPackageEvidence)=>evidence.entries.reduce((latest,entry)=>Math.max(latest,entry.revision?.modifiedAt??entry.mtime),0);return choose(modified(local)>modified(remote)?"local":"remote","same version; later observed package content",true);
}
