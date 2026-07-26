import { randomUUID } from "node:crypto";
import type { ChangeAssessment,ChangeItem,ClientSafetySignals,ManifestEntry,QuarantineItem,SafeguardPolicy,Snapshot } from "@gib-sync/protocol";
import { Store } from "./db.js";
import { sha256 } from "./security.js";

export const BALANCED_POLICY:SafeguardPolicy={
  mode:"balanced",deletionCount:10,smallVaultDeletionCount:5,smallVaultDeletionPercent:20,changedCount:100,changedPercent:30,
  folderImpactCount:20,fileGrowthBytes:50*1024*1024,fileGrowthPercent:500,clockSkewMinutes:10,protectedPaths:[]
};
export const STRICT_POLICY:SafeguardPolicy={
  mode:"strict",deletionCount:5,smallVaultDeletionCount:3,smallVaultDeletionPercent:10,changedCount:50,changedPercent:20,
  folderImpactCount:10,fileGrowthBytes:20*1024*1024,fileGrowthPercent:300,clockSkewMinutes:5,protectedPaths:[]
};

const normalize=(path:string)=>path.replace(/\\/g,"/").replace(/^\/+|\/+$/g,"");
const extension=(path:string)=>{const name=path.slice(path.lastIndexOf("/")+1),index=name.lastIndexOf(".");return index<0?"":name.slice(index+1).toLowerCase();};
const isDeviceLocalObsidianPath=(path:string)=>{
  const value=normalize(path);
  if(/^\.obsidian\/workspace(?:-[^/]+)?\.json$/i.test(value))return true;
  if(value.toLowerCase().startsWith(".obsidian/")&&/ \(conflict - .+ - \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} UTC(?: - \d+)?\)(?:\.[^/]+)?$/i.test(value))return true;
  const match=/^\.obsidian\/plugins\/[^/]+\/(.+)$/i.exec(value);if(!match)return false;
  const generated=new Set([".cache","cache","caches","embeddings","index-data","indexes","logs","node_modules","search-index","temp","tmp"]);
  return match[1].split("/").some((segment)=>generated.has(segment.toLowerCase()))||/\.(?:log|tmp)$/i.test(match[1]);
};

export function policyFor(mode:SafeguardPolicy["mode"],custom?:Partial<SafeguardPolicy>):SafeguardPolicy{
  const base=mode==="strict"?STRICT_POLICY:BALANCED_POLICY;
  const thresholds=mode==="custom"?custom:{};
  return {...base,...thresholds,mode,protectedPaths:(custom?.protectedPaths??base.protectedPaths).map(normalize).filter(Boolean)};
}

export function assessChanges(previous:ManifestEntry[],next:ManifestEntry[],policy:SafeguardPolicy,signals?:ClientSafetySignals):{assessment:ChangeAssessment;changes:ChangeItem[]}{
  const before=new Map(previous.map((entry)=>[entry.path,entry])),after=new Map(next.map((entry)=>[entry.path,entry]));
  const requestedCleanup=new Set((signals?.deviceLocalCleanupPaths??[]).map(normalize));
  const trustedCleanup=(path:string)=>requestedCleanup.has(normalize(path))&&isDeviceLocalObsidianPath(path);
  const allRawDeleted=[...before.values()].filter((entry)=>!after.has(entry.path));
  const rawDeleted=allRawDeleted.filter((entry)=>!trustedCleanup(entry.path)),rawCreated=[...after.values()].filter((entry)=>!before.has(entry.path));
  const createdByHash=new Map<string,ManifestEntry[]>();for(const entry of rawCreated){const values=createdByHash.get(entry.hash)??[];values.push(entry);createdByHash.set(entry.hash,values);}
  const moved:ChangeItem[]=[],deleted:ChangeItem[]=[],usedCreated=new Set<string>();
  for(const entry of rawDeleted){const match=createdByHash.get(entry.hash)?.find((candidate)=>!usedCreated.has(candidate.path));if(match){usedCreated.add(match.path);moved.push({path:match.path,previousPath:entry.path,kind:"moved",previousSize:entry.size,size:match.size});}else deleted.push({path:entry.path,kind:"deleted",previousSize:entry.size});}
  const created=rawCreated.filter((entry)=>!usedCreated.has(entry.path)).map<ChangeItem>((entry)=>({path:entry.path,kind:"created",size:entry.size}));
  const modified=[...after.values()].filter((entry)=>before.has(entry.path)&&before.get(entry.path)!.hash!==entry.hash)
    .map<ChangeItem>((entry)=>({path:entry.path,kind:"modified",previousSize:before.get(entry.path)!.size,size:entry.size}));
  const changes=[...deleted,...created,...modified,...moved].sort((left,right)=>left.path.localeCompare(right.path));
  const relevantPrevious=previous.length-(allRawDeleted.length-rawDeleted.length),baseline=Math.max(1,relevantPrevious),totalChanged=changes.length,affectedPercent=Math.round(totalChanged/baseline*1000)/10;
  const bytesRemoved=deleted.reduce((sum,item)=>sum+(item.previousSize??0),0)+modified.reduce((sum,item)=>sum+Math.max(0,(item.previousSize??0)-(item.size??0)),0);
  const bytesAdded=created.reduce((sum,item)=>sum+(item.size??0),0)+modified.reduce((sum,item)=>sum+Math.max(0,(item.size??0)-(item.previousSize??0)),0);
  const reasons:string[]=[];
  if(deleted.length>=policy.deletionCount)reasons.push(`${deleted.length} files would be deleted`);
  if(deleted.length>=policy.smallVaultDeletionCount&&deleted.length/baseline*100>=policy.smallVaultDeletionPercent)reasons.push(`${Math.round(deleted.length/baseline*100)}% of the vault would be deleted`);
  if(totalChanged>=policy.changedCount)reasons.push(`${totalChanged} files would change`);
  if(totalChanged/baseline*100>=policy.changedPercent&&totalChanged>=5)reasons.push(`${affectedPercent}% of the vault would change`);
  const folderCounts=new Map<string,number>();for(const item of [...deleted,...moved]){const folder=(item.previousPath??item.path).split("/")[0];folderCounts.set(folder,(folderCounts.get(folder)??0)+1);}
  for(const [folder,count] of folderCounts)if(count>=policy.folderImpactCount)reasons.push(`${count} files would leave ${folder||"the vault root"}`);
  const growth=modified.filter((item)=>(item.size??0)-(item.previousSize??0)>=policy.fileGrowthBytes||((item.previousSize??0)>=1024*1024&&(item.size??0)/(item.previousSize??1)*100>=policy.fileGrowthPercent));
  if(growth.length)reasons.push(`${growth.length} files grew unexpectedly`);
  const extensionChanges=moved.filter((item)=>extension(item.path)!==extension(item.previousPath??""));
  if(extensionChanges.length>=5)reasons.push(`${extensionChanges.length} files changed extension`);
  if(signals?.highEntropyPaths?.length)reasons.push(`${signals.highEntropyPaths.length} files resemble encrypted or high-entropy content`);
  if(signals?.staleBaseline&&deleted.length)reasons.push(`A stale device would delete ${deleted.length} file${deleted.length===1?"":"s"}`);
  for(const protectedPath of policy.protectedPaths)if(allRawDeleted.some((item)=>item.path===protectedPath||item.path.startsWith(`${protectedPath}/`)))reasons.push(`Protected path ${protectedPath} would be deleted`);
  if(relevantPrevious>0&&next.length===0)reasons.push("A nonempty vault would become completely empty");
  return {assessment:{created:created.length,modified:modified.length,deleted:deleted.length,moved:moved.length,totalChanged,affectedPercent,bytesAdded,bytesRemoved,reasons:[...new Set(reasons)],examples:changes.slice(0,25)},changes};
}

type VaultSafetyRow={safeguard_policy:string|null;write_locked_at:string|null;write_locked_by:string|null;trusted_until:string|null;trusted_device_id:string|null};
type Proposal={vaultId:string;deviceId:string;deviceName:string;parentId:string|null;message:string;entries:ManifestEntry[];source:"device"|"seafile";signals?:ClientSafetySignals};

export class SafeguardService{
  constructor(private readonly store:Store){}
  policy(vaultId:string):SafeguardPolicy{
    const value=this.store.one<{safeguard_policy:string|null}>("SELECT safeguard_policy FROM vaults WHERE id=?",vaultId)?.safeguard_policy;
    if(!value)return BALANCED_POLICY;try{return policyFor((JSON.parse(value) as SafeguardPolicy).mode,JSON.parse(value));}catch{return BALANCED_POLICY;}
  }
  state(vaultId:string,deviceId:string){
    const row=this.store.one<VaultSafetyRow>("SELECT safeguard_policy,write_locked_at,write_locked_by,trusted_until,trusted_device_id FROM vaults WHERE id=?",vaultId)!;
    return {policy:this.policy(vaultId),writeLocked:Boolean(row.write_locked_at),writeLockedAt:row.write_locked_at,writeLockedBy:row.write_locked_by,
      trustedUntil:row.trusted_device_id===deviceId&&row.trusted_until&&Date.parse(row.trusted_until)>Date.now()?row.trusted_until:null,
      pendingQuarantines:this.store.one<{count:number}>("SELECT COUNT(*) count FROM quarantines WHERE vault_id=? AND status='pending'",vaultId)?.count??0};
  }
  propose(proposal:Proposal):{allowed:boolean;locked:boolean;assessment:ChangeAssessment;quarantine:QuarantineItem|null;created:boolean}{
    const vault=this.store.one<VaultSafetyRow&{head_id:string|null}>("SELECT head_id,safeguard_policy,write_locked_at,write_locked_by,trusted_until,trusted_device_id FROM vaults WHERE id=?",proposal.vaultId)!;
    const previous=vault.head_id?this.store.getSnapshot(vault.head_id)?.entries??[]:[];
    const {assessment,changes}=assessChanges(previous,proposal.entries,this.policy(proposal.vaultId),proposal.signals);
    if(vault.write_locked_at)return {allowed:false,locked:true,assessment,quarantine:null,created:false};
    const trusted=vault.trusted_device_id===proposal.deviceId&&vault.trusted_until&&Date.parse(vault.trusted_until)>Date.now();
    if(!assessment.reasons.length||!previous.length||trusted)return {allowed:true,locked:false,assessment,quarantine:null,created:false};
    const manifest=JSON.stringify([...proposal.entries].sort((a,b)=>a.path.localeCompare(b.path)));
    const proposalHash=sha256(Buffer.from(JSON.stringify({parentId:proposal.parentId,message:proposal.message,manifest})));
    const existing=this.store.one<{id:string}>("SELECT id FROM quarantines WHERE vault_id=? AND proposal_hash=? AND status='pending'",proposal.vaultId,proposalHash);
    const id=existing?.id??randomUUID(),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+7*24*60*60*1000).toISOString();
    if(!existing)this.store.run("INSERT INTO quarantines(id,vault_id,proposal_hash,source,device_id,device_name,parent_id,created_at,expires_at,status,message,manifest_json,assessment_json,changes_json) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)",
      id,proposal.vaultId,proposalHash,proposal.source,proposal.deviceId,proposal.deviceName,proposal.parentId,createdAt,expiresAt,proposal.message,manifest,JSON.stringify(assessment),JSON.stringify(changes));
    return {allowed:false,locked:false,assessment,created:!existing,quarantine:{id,proposalHash,source:proposal.source,deviceId:proposal.deviceId,deviceName:proposal.deviceName,parentId:proposal.parentId,
      createdAt,expiresAt,status:"pending",message:proposal.message,assessment,changes}};
  }
  list(vaultId:string):QuarantineItem[]{
    this.store.run("UPDATE quarantines SET status='stale' WHERE vault_id=? AND status='pending' AND expires_at<?",vaultId,new Date().toISOString());
    return this.store.all<any>("SELECT * FROM quarantines WHERE vault_id=? AND status='pending' ORDER BY created_at DESC",vaultId).map((row)=>({
      id:row.id,proposalHash:row.proposal_hash,source:row.source,deviceId:row.device_id,deviceName:row.device_name,parentId:row.parent_id,createdAt:row.created_at,
      expiresAt:row.expires_at,status:row.status,message:row.message,assessment:JSON.parse(row.assessment_json),changes:JSON.parse(row.changes_json)
    }));
  }
  event(vaultId:string,code:string,level:"info"|"warning"|"error",message:string){this.store.run("INSERT INTO health_events(id,vault_id,code,level,message,created_at) VALUES(?,?,?,?,?,?)",randomUUID(),vaultId,code,level,message,new Date().toISOString());}
}
