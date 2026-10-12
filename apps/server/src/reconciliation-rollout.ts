import {createHash} from "node:crypto";
import {planReconciliation,type ManifestEntry,type ReconcileKind,type ReconciliationInput,type RolloutStatus} from "@gib-sync/protocol";
import type {Store} from "./db.js";
import {SERVER_VERSION} from "./version.js";
import {CanaryScope} from "./canary-scope.js";
import type {Config} from "./config.js";

/** Independent legacy generic decisions, retained exclusively as a shadow witness. */
export function legacyDecisionKinds(input:ReconciliationInput):Array<{path:string;kind:ReconcileKind}>{
  const b=new Map(input.base.map(e=>[e.path,e])),l=new Map(input.local.map(e=>[e.path,e])),r=new Map(input.remote.map(e=>[e.path,e]));
  const equal=(a:ManifestEntry|undefined,c:ManifestEntry|undefined)=>a?.hash===c?.hash&&a?.size===c?.size;
  return [...new Set([...b.keys(),...l.keys(),...r.keys()])].sort().map(path=>{const base=b.get(path),local=l.get(path),remote=r.get(path);let kind:ReconcileKind;if(equal(local,remote))kind=equal(base,local)?"unchanged":"equal";else if(equal(base,local))kind="remote-only";else if(equal(base,remote))kind="local-only";else if(!base)kind=local&&remote?"independent-create":local?"local-only":"remote-only";else if(!local||!remote)kind="edit-delete";else kind="concurrent-edit";return {path,kind};});
}
/** Independently implemented state matrix; never invokes the candidate policy. */
export function causalDecisionKinds(input:ReconciliationInput):Array<{path:string;kind:ReconcileKind}>{
  const base=new Map(input.base.map(entry=>[entry.path,entry])),local=new Map(input.local.map(entry=>[entry.path,entry])),remote=new Map(input.remote.map(entry=>[entry.path,entry]));
  const equal=(left:ManifestEntry|undefined,right:ManifestEntry|undefined)=>left&&right?left.hash===right.hash&&left.size===right.size&&(!left.fileId||!right.fileId||left.fileId===right.fileId):left===right;
  return [...new Set([...base.keys(),...local.keys(),...remote.keys()])].sort().map(path=>{const b=base.get(path),l=local.get(path),r=remote.get(path),state=(entry:ManifestEntry|undefined)=>!entry?"absent":equal(entry,b)?"unchanged":b?.fileId&&entry.fileId&&entry.fileId!==b.fileId?"replacement":"edited",ls=state(l),rs=state(r);let kind:ReconcileKind;
    if(equal(l,r))kind=equal(b,l)?"unchanged":"equal";
    else if(!b)kind=l&&r?"independent-create":l?"local-only":"remote-only";
    else if(ls==="unchanged")kind="remote-only";
    else if(rs==="unchanged")kind="local-only";
    else if(ls==="replacement"||rs==="replacement")kind=ls==="absent"?"remote-only":rs==="absent"?"local-only":"independent-create";
    else kind=ls==="absent"||rs==="absent"?"edit-delete":"concurrent-edit";
    return {path,kind};});
}
export class ReconciliationRollout {
  constructor(private readonly store:Store,private readonly requiredComparisons=20,private readonly requiredCanaryBatches=3,private readonly deploymentDigest=process.env.GIBSYNC_RELEASE_DIGEST,private readonly canaryConfig?:Config){}
  status(vaultId:string,requestingDeviceId?:string):RolloutStatus{
    this.store.run("INSERT OR IGNORE INTO sync_rollouts(vault_id,mode,updated_at) VALUES(?,'shadow',?)",vaultId,new Date().toISOString());
    // Only an operator-reviewed release can automatically promote real vaults;
    // no production user is enrolled as an unreviewed canary.
    const reviewed=Boolean(this.deploymentDigest&&this.store.one("SELECT 1 FROM sync_release_validation WHERE singleton=1 AND release_id=? AND image_digest=?",SERVER_VERSION,this.deploymentDigest));
    if(!reviewed)this.store.run("UPDATE sync_rollouts SET mode='shadow',updated_at=? WHERE vault_id=? AND mode='active'",new Date().toISOString(),vaultId);
    if(reviewed)this.store.run("UPDATE sync_rollouts SET mode='active',updated_at=? WHERE vault_id=? AND mode='shadow' AND comparisons>=? AND NOT EXISTS(SELECT 1 FROM sync_shadow_observations o WHERE o.vault_id=sync_rollouts.vault_id AND o.matched=0 AND o.reviewed_at IS NULL) AND EXISTS(SELECT 1 FROM vaults v JOIN sync_vault_state s ON s.vault_id=v.id WHERE v.id=sync_rollouts.vault_id AND s.snapshot_id IS v.head_id AND v.head_id IS v.mirror_head_id AND v.head_id IS v.mirror_generation_id AND v.retired_at IS NULL AND v.write_locked_at IS NULL) AND NOT EXISTS(SELECT 1 FROM mirror_jobs j WHERE j.vault_id=sync_rollouts.vault_id) AND NOT EXISTS(SELECT 1 FROM quarantines q WHERE q.vault_id=sync_rollouts.vault_id AND q.status='pending') AND NOT EXISTS(SELECT 1 FROM health_events h WHERE h.vault_id=sync_rollouts.vault_id AND h.cleared_at IS NULL AND h.level IN ('warning','error')) AND NOT EXISTS(SELECT 1 FROM external_revisions e WHERE e.vault_id=sync_rollouts.vault_id AND e.imported_at IS NULL)",new Date().toISOString(),vaultId,this.requiredComparisons);
    const row=this.store.one<{mode:RolloutStatus["mode"];canary_device_id:string|null;comparisons:number;mismatches:number;canary_batches:number;last_error:string|null}>("SELECT * FROM sync_rollouts WHERE vault_id=?",vaultId)!,unresolved=this.store.one<{count:number}>("SELECT COUNT(*) count FROM sync_shadow_observations WHERE vault_id=? AND matched=0 AND reviewed_at IS NULL",vaultId)!.count;return {mode:row.mode,canaryDeviceId:row.canary_device_id,comparisons:row.comparisons,mismatches:unresolved,canaryBatches:row.canary_batches,reason:row.last_error};
  }
  observe(vaultId:string,input:ReconciliationInput,source:string,evidence:{validatedIdentities:boolean;provenRemoteCreations?:Array<{path:string;targetId:string}>}={validatedIdentities:false}):{matched:boolean;status:RolloutStatus}{
    const comparable=(entries:ManifestEntry[])=>[...entries].sort((a,b)=>a.path.localeCompare(b.path)).map(({path,hash,size,fileId,revision})=>({path,hash,size,fileId,revisionId:revision?.id}));
    this.status(vaultId);const witness=legacyDecisionKinds(input),causal=causalDecisionKinds(input),candidate=planReconciliation(input).decisions.map(({path,kind})=>({path,kind})),legacyMatched=JSON.stringify(witness)===JSON.stringify(candidate),base=new Map(input.base.map(entry=>[entry.path,entry])),local=new Map(input.local.map(entry=>[entry.path,entry])),remote=new Map(input.remote.map(entry=>[entry.path,entry])),differences=candidate.filter((decision,index)=>decision.kind!==witness[index]?.kind);
    const witnessKinds=new Map(witness.map(item=>[item.path,item.kind]));
    const justified=differences.every(decision=>{
      const b=base.get(decision.path),l=local.get(decision.path),r=remote.get(decision.path);
      if(!evidence.validatedIdentities)return false;
      if(!b){
        // The old hash-only witness calls equal bytes "equal" even when a
        // verified external creation has a distinct identity. Do not invent a
        // base: require the exact accepted local entity and remote create proof.
        return source==="seafile"&&decision.kind==="independent-create"&&witnessKinds.get(decision.path)==="equal"&&
          Boolean(l?.fileId&&r?.fileId&&l.fileId!==r.fileId&&l.hash===r.hash&&l.size===r.size&&
            evidence.provenRemoteCreations?.some(proof=>proof.path===decision.path&&proof.targetId===r.fileId)&&
            this.store.one("SELECT 1 FROM sync_entities WHERE vault_id=? AND entity_id=? AND entity_kind='file' AND path=? AND hash=? AND size=? AND deleted=0",vaultId,l.fileId,decision.path,l.hash,l.size));
      }
      if(!b.fileId)return false;
      if(l?.fileId&&l.fileId!==b.fileId&&!input.localCreationIntents?.some(intent=>intent.path===decision.path&&intent.targetId===l.fileId&&intent.baseTargetId===b.fileId)&&!(source==="seafile"&&this.store.one("SELECT 1 FROM sync_operations WHERE vault_id=? AND kind='recreate' AND target_id=? AND json_extract(payload_json,'$.newTargetId')=? AND json_extract(payload_json,'$.path')=?",vaultId,b.fileId,l.fileId,decision.path)))return false;
      if(r?.fileId&&r.fileId!==b.fileId&&source==="seafile"&&!evidence.provenRemoteCreations?.some(proof=>proof.path===decision.path&&proof.targetId===r.fileId))return false;
      return Boolean(l?.fileId&&l.fileId!==b.fileId||r?.fileId&&r.fileId!==b.fileId);
    });
    const matched=JSON.stringify(causal)===JSON.stringify(candidate)&&(legacyMatched||justified),fingerprint=createHash("sha256").update(JSON.stringify({input:{base:comparable(input.base),local:comparable(input.local),remote:comparable(input.remote)},witness,causal,candidate})).digest("hex"),now=new Date().toISOString(),candidateHash=createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
    const identityDifferences=differences.map(({path})=>({path,base:base.get(path)??null,local:local.get(path)??null,remote:remote.get(path)??null}));
    const added=this.store.run("INSERT OR IGNORE INTO sync_shadow_observations(vault_id,fingerprint,source,matched,created_at,legacy_difference,reason,evidence_json,candidate_hash) VALUES(?,?,?,?,?,?,?,?,?)",vaultId,fingerprint,source,matched?1:0,now,legacyMatched?0:1,legacyMatched?null:matched?"Validated causal identity differs from the earlier hash-only witness":"Unexplained reconciliation divergence",JSON.stringify({witness,causal,candidate,evidence,identityDifferences,localCreationIntents:input.localCreationIntents??[]}),candidateHash);
    if(added.changes)this.store.run("UPDATE sync_rollouts SET comparisons=comparisons+1,mismatches=mismatches+?,mode=CASE WHEN ?=0 THEN 'hold' ELSE mode END,last_error=CASE WHEN ?=0 THEN 'New reconciliation differs from its shadow witness; automatic rollout was held' ELSE last_error END,updated_at=? WHERE vault_id=?",matched?0:1,matched?1:0,matched?1:0,now,vaultId);
    return {matched,status:this.status(vaultId)};
  }
  /** Private operator review, preserving the original mismatch and evidence. */
  reviewDiscrepancy(vaultId:string,fingerprint:string,evidence:{reportHash:string;candidateHash:string}):void{
    const observation=this.store.one<{candidate_hash:string}>("SELECT candidate_hash FROM sync_shadow_observations WHERE vault_id=? AND fingerprint=? AND matched=0 AND reviewed_at IS NULL",vaultId,fingerprint);if(!observation||observation.candidate_hash!==evidence.candidateHash||!/^[a-f0-9]{64}$/.test(evidence.reportHash))throw new Error("An exact independently reviewed discrepancy report is required");
    const now=new Date().toISOString();this.store.db.exec('BEGIN IMMEDIATE');try{this.store.run("INSERT INTO sync_rollout_reviews(vault_id,kind,evidence_json,created_at) VALUES(?,'discrepancy',?,?)",vaultId,JSON.stringify({fingerprint,...evidence}),now);this.store.run("UPDATE sync_shadow_observations SET reviewed_at=? WHERE vault_id=? AND fingerprint=?",now,vaultId,fingerprint);this.store.run("UPDATE sync_rollouts SET mode='shadow',last_error=NULL,updated_at=? WHERE vault_id=? AND mode='hold' AND NOT EXISTS(SELECT 1 FROM sync_shadow_observations o WHERE o.vault_id=sync_rollouts.vault_id AND o.matched=0 AND o.reviewed_at IS NULL)",now,vaultId);this.store.db.exec('COMMIT');}catch(error){this.store.db.exec('ROLLBACK');throw error;}
  }
  allows(vaultId:string,deviceId:string):boolean{const state=this.status(vaultId,deviceId);return state.mode==="active"||state.mode==="canary"&&state.canaryDeviceId===deviceId;}
  /** Private operator API only: never called by a user pairing or sync request. */
  authorizeCanary(vaultId:string,deviceId:string,evidence:{disposableVaultVerified:boolean;reportHash:string}):void{
    const scope=this.canaryConfig?new CanaryScope(this.canaryConfig):null;if(!scope?.enabled)throw new Error("Canary enrollment requires a hard-scoped disposable-only server");scope.assertStore(this.store);
    const state=this.status(vaultId);if(!evidence.disposableVaultVerified||!/^[a-f0-9]{64}$/.test(evidence.reportHash)||state.mode!=="shadow"||state.mismatches||state.comparisons<this.requiredComparisons||!this.store.one("SELECT 1 FROM devices WHERE id=? AND vault_id=? AND initial_sync_complete=1 AND revoked_at IS NULL",deviceId,vaultId))throw new Error("Canary evidence or disposable device eligibility is incomplete");
    this.store.run("INSERT INTO sync_rollout_reviews(vault_id,kind,evidence_json,created_at) VALUES(?,'canary',?,?)",vaultId,JSON.stringify(evidence),new Date().toISOString());this.store.run("UPDATE sync_rollouts SET mode='canary',canary_device_id=?,canary_start_sequence=COALESCE((SELECT sequence FROM sync_vault_state WHERE vault_id=?),0),updated_at=? WHERE vault_id=?",deviceId,vaultId,new Date().toISOString(),vaultId);
  }
  activate(vaultId:string,evidence:{generatedReportHash:string;canaryReportHash:string;physicalIphoneReportHash:string}):void{
    const state=this.status(vaultId);if(state.mode!=="canary"||state.mismatches||state.comparisons<this.requiredComparisons||state.canaryBatches<this.requiredCanaryBatches||Object.values(evidence).some(value=>!/^[a-f0-9]{64}$/.test(value)))throw new Error("Reviewed generated, canary and physical iPhone evidence is required before activation");
    if(!this.deploymentDigest||!this.store.one("SELECT 1 FROM sync_release_validation WHERE singleton=1 AND release_id=? AND image_digest=?",SERVER_VERSION,this.deploymentDigest))throw new Error("The running release must be globally reviewed before activation");
    this.store.run("INSERT INTO sync_rollout_reviews(vault_id,kind,evidence_json,created_at) VALUES(?,'activation',?,?)",vaultId,JSON.stringify(evidence),new Date().toISOString());this.store.run("UPDATE sync_rollouts SET mode='active',updated_at=? WHERE vault_id=?",new Date().toISOString(),vaultId);
  }
  reviewRelease(evidence:{releaseId:string;imageDigest:string;canaryVaultId:string;generatedReportHash:string;canaryReportHash:string;physicalIphoneReportHash:string;migrationReportHash:string}):void{
    const canary=this.status(evidence.canaryVaultId),review=this.store.one("SELECT 1 FROM sync_rollout_reviews WHERE vault_id=? AND kind='canary'",evidence.canaryVaultId);
    if(evidence.releaseId!==SERVER_VERSION||!this.deploymentDigest||evidence.imageDigest!==this.deploymentDigest||!/^sha256:[a-f0-9]{64}$/.test(evidence.imageDigest)||!review||!['canary','active'].includes(canary.mode)||canary.comparisons<this.requiredComparisons||canary.mismatches||canary.canaryBatches<this.requiredCanaryBatches||[evidence.generatedReportHash,evidence.canaryReportHash,evidence.physicalIphoneReportHash,evidence.migrationReportHash].some(value=>!/^[a-f0-9]{64}$/.test(value)))throw new Error("A pinned release, real disposable canary, migration and physical iPhone reports must be reviewed before production promotion");
    this.store.run("INSERT INTO sync_release_validation(singleton,release_id,image_digest,evidence_json,reviewed_at) VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET release_id=excluded.release_id,image_digest=excluded.image_digest,evidence_json=excluded.evidence_json,reviewed_at=excluded.reviewed_at",evidence.releaseId,evidence.imageDigest,JSON.stringify(evidence),new Date().toISOString());
  }
  accepted(vaultId:string,deviceId:string):void{this.store.run("UPDATE sync_rollouts SET canary_batches=(SELECT COUNT(*) FROM sync_batches b WHERE b.vault_id=? AND b.device_id=? AND b.source='operations' AND b.sequence>sync_rollouts.canary_start_sequence AND EXISTS(SELECT 1 FROM sync_operations o WHERE o.vault_id=b.vault_id AND o.batch_id=b.batch_id)),updated_at=? WHERE vault_id=? AND mode='canary' AND canary_device_id=? AND NOT EXISTS(SELECT 1 FROM sync_shadow_observations o WHERE o.vault_id=sync_rollouts.vault_id AND o.matched=0 AND o.reviewed_at IS NULL)",vaultId,deviceId,new Date().toISOString(),vaultId,deviceId);}
}
