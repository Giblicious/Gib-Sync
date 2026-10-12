import type {FastifyInstance,FastifyRequest} from "fastify";
import {z} from "zod";
import type {ManifestEntry,OperationBatch,OperationReceipt} from "@gib-sync/protocol";
import type {Store} from "./db.js";
import type {SnapshotCommitter} from "./snapshot-commit.js";
import {batchHash,bootstrapSyncState,getSyncTree,OperationConflict} from "./operation-state.js";
import {safeRelativePath} from "./seafile.js";
import type {SafeguardService} from "./safeguards.js";
import {ReconciliationRollout} from "./reconciliation-rollout.js";
import type {Config} from "./config.js";
import {getSnapshotView} from './snapshot-evidence.js';

type Device={id:string;vault_id:string;name:string};
const uuid=z.string().uuid(),path=z.string().min(1).max(4000).refine(value=>{try{return safeRelativePath(value)===value;}catch{return false;}}),content=z.object({hash:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().nonnegative(),mtime:z.number().finite().nonnegative()}).strict(),base={operationId:uuid,targetId:uuid,baseRevisionId:uuid.nullable()};
export const operationBatchSchema=z.object({batchId:uuid,baseSnapshotId:uuid.nullable(),message:z.string().max(500).default("Sync"),operations:z.array(z.discriminatedUnion("kind",[
  z.object({...base,kind:z.literal("create"),path,content}).strict(),z.object({...base,kind:z.literal("edit"),content}).strict(),z.object({...base,kind:z.literal("move"),newPath:path}).strict(),z.object({...base,kind:z.literal("delete")}).strict(),
  z.object({...base,kind:z.literal("recreate"),newTargetId:uuid,path,content,deletedByOperationId:uuid.optional()}).strict(),z.object({...base,kind:z.literal("mkdir"),path,newTargetId:uuid.optional(),deletedByOperationId:uuid.optional()}).strict(),z.object({...base,kind:z.literal("rmdir")}).strict(),z.object({...base,kind:z.literal("move-folder"),newPath:path,descendants:z.array(z.object({targetId:uuid,baseRevisionId:uuid}).strict()).max(200000)}).strict()
])).max(200000)}).strict();
export async function registerOperationRoutes(app:FastifyInstance,options:{store:Store;committer:SnapshotCommitter;safeguards:SafeguardService;deploymentDigest?:string;canaryConfig?:Config;authenticate(request:FastifyRequest):Promise<Device>;beforeCommit(vaultId:string):Promise<unknown>;accepted(vaultId:string,snapshotId:string):void}){
  const {store,committer,safeguards}=options,rollout=new ReconciliationRollout(store,20,3,options.deploymentDigest,options.canaryConfig);
  const ensure=()=>{store.db.exec("BEGIN IMMEDIATE");try{bootstrapSyncState(store);store.db.exec("COMMIT");}catch(error){store.db.exec("ROLLBACK");throw error;}};
  app.get("/v2/tree",async request=>{const device=await options.authenticate(request);ensure();return getSyncTree(store,device.vault_id);});
  app.get("/v2/rollout",async request=>{const device=await options.authenticate(request);return rollout.status(device.vault_id,device.id);});
  app.get("/v2/batches/:id",async(request,reply)=>{const device=await options.authenticate(request),id=z.object({id:uuid}).parse(request.params).id;const receipt=committer.getBatch(device.vault_id,id,device.id);return receipt??reply.notFound("No accepted receipt exists for this batch");});
  const entry=z.object({path,hash:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().nonnegative(),mtime:z.number().finite().nonnegative(),fileId:uuid.optional()}).passthrough();
  app.post("/v2/shadow",{bodyLimit:64*1024*1024},async request=>{
    const device=await options.authenticate(request),input=z.object({baseSnapshotId:uuid.nullable(),base:z.array(entry).max(200000),local:z.array(entry).max(200000),remote:z.array(entry).max(200000),localCreationIntents:z.array(z.object({operationId:uuid,targetId:uuid,path,baseTargetId:uuid.nullable()}).strict()).max(200000).optional()}).parse(request.body);
    const head=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)?.head_id,snapshot=head?getSnapshotView(store,head):null,baseline=input.baseSnapshotId?getSnapshotView(store,input.baseSnapshotId):null,shape=(files:ReadonlyArray<Pick<ManifestEntry,"path"|"hash"|"size"|"fileId">>)=>JSON.stringify([...files].sort((a,b)=>a.path.localeCompare(b.path)).map(({path,hash,size,fileId})=>({path,hash,size,fileId})));
    if(input.baseSnapshotId&&baseline?.vaultId!==device.vault_id||shape(input.base)!==shape(baseline?.entries??[]))throw new OperationConflict("Shadow comparison must use an immutable accepted baseline in this vault");if(shape(input.remote)!==shape(snapshot?.entries??[]))throw new OperationConflict("Shadow comparison must use the current accepted remote tree");const result=rollout.observe(device.vault_id,input,"device",{validatedIdentities:true});return {...result,rollout:result.status};
  });
  app.post("/v2/batches",{bodyLimit:64*1024*1024},async(request,reply)=>{
    const device=await options.authenticate(request),batch=operationBatchSchema.parse(request.body) as OperationBatch;
    const prior=store.one<{device_id:string;payload_hash:string}>("SELECT device_id,payload_hash FROM sync_batches WHERE vault_id=? AND batch_id=?",device.vault_id,batch.batchId);
    if(prior){if(prior.device_id!==device.id||prior.payload_hash!==batchHash(batch))throw new OperationConflict("Batch identity was reused with different content");return committer.getBatch(device.vault_id,batch.batchId,device.id);}
    if(!rollout.allows(device.vault_id,device.id))return reply.code(425).send({error:"Operation transport is still in a verified rollout stage; use the compatible snapshot bridge",rollout:rollout.status(device.vault_id)});
    await options.beforeCommit(device.vault_id);
    const ready=store.one<{initial_sync_complete:number}>("SELECT initial_sync_complete FROM devices WHERE id=?",device.id)?.initial_sync_complete,current=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)?.head_id;
    if(current&&!ready)return reply.code(428).send({error:"Finish this device's verified first download before publishing operations"});
    const preview=committer.previewBatch(device.vault_id,batch,device.id,device.name);
    const acceptedHead=preview.parentId?store.getSnapshot(preview.parentId):null,acceptedSizes=new Map((acceptedHead?.entries??[]).map(file=>[file.hash,file.size]));
    const missing=preview.tree.files.filter(file=>!store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?",device.vault_id,file.hash)||(store.one<{clear_size:number}>("SELECT clear_size FROM blob_integrity WHERE vault_id=? AND hash=?",device.vault_id,file.hash)?.clear_size??acceptedSizes.get(file.hash))!==file.size);if(missing.length)return reply.code(422).send({error:"Verified content is unavailable",hashes:missing.slice(0,100).map(file=>file.hash)});
    const folders=preview.tree.folders.map(folder=>folder.path),decision=safeguards.propose({vaultId:device.vault_id,deviceId:device.id,deviceName:device.name,parentId:preview.parentId,message:batch.message,entries:preview.tree.files,folders,folderEntries:preview.tree.folders,source:"device"});
    if(!decision.allowed){if(decision.quarantine)store.run("INSERT INTO sync_pending_batches(vault_id,batch_id,device_id,batch_json,quarantine_id) VALUES(?,?,?,?,?) ON CONFLICT(vault_id,batch_id) DO NOTHING",device.vault_id,batch.batchId,device.id,JSON.stringify(batch),decision.quarantine.id);return reply.code(423).send({error:decision.locked?"Remote writes are frozen":"Changes require a safeguard decision",locked:decision.locked,quarantine:decision.quarantine,assessment:decision.assessment});}
    const controller=new AbortController(),onClose=()=>{if(!reply.raw.writableFinished)controller.abort(new Error("Operation request was canceled before acceptance"));};reply.raw.once("close",onClose);
    let snapshot;try{snapshot=await committer.accept({vaultId:device.vault_id,parentId:preview.parentId,deviceId:device.id,deviceName:device.name,message:batch.message,entries:preview.tree.files,folders,folderEntries:preview.tree.folders,createdAt:preview.createdAt,operationBatch:batch,signal:controller.signal,afterInsert:accepted=>{store.run("UPDATE quarantines SET status='stale',resolved_at=? WHERE vault_id=? AND status='pending' AND parent_id IS ?",accepted.createdAt,device.vault_id,preview.parentId);rollout.accepted(device.vault_id,device.id);}});}finally{reply.raw.off("close",onClose);}
    if(!snapshot)throw new OperationConflict("Accepted authority moved before the operation transaction");options.accepted(device.vault_id,snapshot.id);const receipt=committer.getBatch(device.vault_id,batch.batchId,device.id)!;return reply.code(201).send({...receipt,replayed:false} satisfies OperationReceipt);
  });
  return rollout;
}
