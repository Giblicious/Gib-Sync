import { randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import sensible from "@fastify/sensible";
import { PROTOCOL_VERSION, type CommitRequest, type ManifestEntry, type MirrorPlanRequest, type RestorePreview, type SafeguardPolicy, type SelectiveRestoreChange, type SelectiveRestorePlan, type SelectiveRestorePreview, type SetupResponse, type Snapshot, type StorageSetupRequest } from "@gib-sync/protocol";
import { z } from "zod";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { ExternalImporter,type ExternalImportResult } from "./external.js";
import { normalizeBasePath, safeRelativePath, SeafileStorage, type VaultStorageRow } from "./seafile.js";
import { decryptVaultBlob, encryptVaultBlob, normalizeQuickCode, openJson, quickCode, randomToken, sealJson, sha256 } from "./security.js";
import { assessChanges,policyFor,SafeguardService } from "./safeguards.js";
import { clientCompatibility } from "./compatibility.js";
import { readGeneration,validGeneration,writeGeneration } from "./mirror-generation.js";
import { SERVER_CAPABILITIES,SERVER_VERSION } from "./version.js";
import { ContainmentService } from "./containment.js";
import { planLegacyFolderDescendantRepair,planMissingLegacyFolderRetirementDirective,planRetiredLegacyFolderRepair } from "./folder-migration.js";
import { canonicalManifest } from "./manifest.js";
import { auditHeadIntegrity } from "./integrity.js";
import { SnapshotCommitter } from "./snapshot-commit.js";
import { VaultRetirementService } from "./vault-retirement.js";
import { DurableMirrorJobs } from "./jobs.js";
import {VerifiedBlobStore,recoverableBlobFailure} from "./blob-store.js";
import {parseBinaryBody,isStagedBinary} from "./binary-body.js";
import {createReadStream} from "node:fs";
import {readFile} from "node:fs/promises";
import {decryptBlobFile,type StagedFile} from "./security-stream.js";
import { takeRequestBudget } from "./request-budget.js";
import { ProjectionJournal,ReadableChangedError } from "./projection-journal.js";
import { BinaryAdmission } from "./admission.js";
import { TrustedPairing } from "./trusted-pairing.js";
import { CONTENT_UPLOAD_CHUNK_BYTES,registerContentUploads } from "./content-upload.js";
import {registerOperationRoutes} from "./operation-routes.js";
import {ConflictInbox,registerConflictInbox,type ConflictRecord} from "./conflict-inbox.js";
import type {OperationBatch,FolderEntry} from "@gib-sync/protocol";
import {registerConfigRoots,normalizeAliasEntries,normalizeAliasFolders,aliasCollisionRecords} from "./config-roots.js";
import {CanaryScope} from "./canary-scope.js";
import {getSnapshotView} from './snapshot-evidence.js';
import {invitationHeaders,invitationSetupUrl,qrInvitationSetupUrl,registerSetupInvitation} from './setup-invitation.js';

type AuthDevice = { id: string; vault_id: string; name: string };

function snapshotFolders(snapshot:Snapshot|null):Set<string>{
  const folders=new Set<string>(),add=(raw:string)=>{let safe:string;try{safe=safeRelativePath(raw);}catch{return;}const parts=safe.split("/");let current="";for(const part of parts){current=current?`${current}/${part}`:part;folders.add(current);}};
  for(const folder of snapshot?.folders??[])add(folder);
  for(const entry of snapshot?.entries??[]){const parent=entry.path.split("/").slice(0,-1).join("/");if(parent)add(parent);}
  return folders;
}
const folderManifestInitialized=(snapshot:Snapshot|null):boolean=>Array.isArray(snapshot?.folders);

export async function buildApp(config: Config, store = new Store(config.DATA_DIR), storage = new SeafileStorage(config)) {
  const canaryScope=new CanaryScope(config);canaryScope.assertStore(store);
  const unmigrated = store.all<{id:string}>("SELECT id FROM vaults WHERE retired_at IS NULL AND (storage_url IS NULL OR storage_token IS NULL)");
  if (unmigrated.length) {
    const legacy = await storage.legacySelection();
    for (const vault of unmigrated) store.run(
      "UPDATE vaults SET storage_url=?,storage_username=?,storage_repo_id=?,storage_repo_name=?,storage_base_path=?,storage_token=?,storage_layout='legacy' WHERE id=?",
      legacy.url, legacy.username, legacy.libraryId, legacy.libraryName, "/", storage.sealToken(vault.id, legacy.token), vault.id
    );
  }
  const mirrorUnconfigured=store.all<{id:string;name:string;storage_layout:string;storage_base_path:string}>("SELECT id,name,storage_layout,storage_base_path FROM vaults WHERE retired_at IS NULL AND mirror_base_path IS NULL");
  for(const vault of mirrorUnconfigured){
    const safeName=vault.name.replace(/[\\/:*?\"<>|\x00-\x1f]/g,"-").replace(/^\.+/,"").trim()||`Vault-${vault.id.slice(0,8)}`;
    const path=vault.storage_layout==="legacy"?`/Obsidian/${safeName}`:vault.storage_base_path;
    store.run("UPDATE vaults SET mirror_base_path=? WHERE id=?",path,vault.id);
  }
  // Folder provenance is repaired onReady through the same operation authority,
  // never by rewinding the accepted head behind its materialized causal tree.
  const integrityBlockedVaults=new Set<string>();
  for(const vault of store.all<{id:string;head_id:string}>("SELECT id,head_id FROM vaults WHERE head_id IS NOT NULL AND retired_at IS NULL")){
    const audit=auditHeadIntegrity(store,vault.id,vault.head_id);if(audit.valid)continue;integrityBlockedVaults.add(vault.id);const now=new Date().toISOString();
    store.run("UPDATE vaults SET write_locked_at=COALESCE(write_locked_at,?),write_locked_by=COALESCE(write_locked_by,'Server integrity audit') WHERE id=?",now,vault.id);
    if(!store.one("SELECT 1 FROM health_events WHERE vault_id=? AND code='head_integrity_blocked' AND cleared_at IS NULL",vault.id))store.run("INSERT INTO health_events(id,vault_id,code,level,message,created_at) VALUES(?,?,?,?,?,?)",randomUUID(),vault.id,"head_integrity_blocked","error",`Sync was stopped before mirror mutation because the accepted snapshot failed integrity checks: ${audit.issues.join("; ")}`,now);
  }
  // Trust only the directly connected proxy. Client-supplied forwarding chains
  // must never provide unlimited independent pairing identities.
  const app = Fastify({ trustProxy:(address:string,hop:number)=>hop===0&&/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$)/.test(address.replace(/^::ffff:/,"")),logger: { level: process.env.LOG_LEVEL ?? "info",serializers:{req:(request:{method?:string;url?:string})=>({method:request.method,url:request.url?.split("?")[0]})} }, bodyLimit: 64*1024*1024 });
  const durableJobs=new DurableMirrorJobs(store);
  const verifiedBlobs=new VerifiedBlobStore(config,store,storage),requestStages=new WeakMap<FastifyRequest,StagedFile>(),requestControllers=new Set<AbortController>();
  const requestSignal=(request:FastifyRequest,reply:import("fastify").FastifyReply)=>{const controller=new AbortController();requestControllers.add(controller);request.raw.once("aborted",()=>controller.abort());reply.raw.once("close",()=>{if(!reply.raw.writableFinished)controller.abort();requestControllers.delete(controller);});return controller.signal;};
  const discardBody=async(request:FastifyRequest)=>{const file=requestStages.get(request);requestStages.delete(request);await file?.dispose();};
  app.addHook("onResponse",async(request)=>discardBody(request));app.addHook("onError",async(request)=>discardBody(request));
  app.addHook("preClose",async()=>{for(const controller of requestControllers)controller.abort();requestControllers.clear();if(typeof storage.close==="function")storage.close();});
  app.addHook("onReady",async()=>{await verifiedBlobs.staging.cleanupExpired();});
  const binaryAdmission=new BinaryAdmission(Math.max(64*1024*1024,config.MAX_BLOB_BYTES+1024)),binaryReleases=new WeakMap<FastifyRequest,()=>void>(),binaryActive=new WeakSet<FastifyRequest>();
  const releaseBinary=(request:FastifyRequest)=>{binaryReleases.get(request)?.();binaryReleases.delete(request);};
  const binaryRoute=(route:string)=>route==="/v1/blobs/:hash"||route==="/v1/content/:hash"||route==="/v1/mirror/file"||route==="/v1/content-uploads/:id/chunks/:index"||route==="/v1/content-uploads/:id/complete";
  app.addHook("onResponse",async(request)=>releaseBinary(request));
  app.addHook("onError",async(request)=>releaseBinary(request));
  app.addHook("onRequestAbort",async(request)=>{if(!binaryActive.has(request))releaseBinary(request);});
  app.addHook("onRoute",(options)=>{
    if(!binaryRoute(options.url))return;
    const original=options.handler;options.handler=async function(request,reply){binaryActive.add(request);try{return await original.call(this,request,reply);}finally{binaryActive.delete(request);if(request.raw.destroyed||reply.raw.destroyed)releaseBinary(request);}};
  });
  const projectionJournal=new ProjectionJournal(config,store,storage);
  const safeguards=new SafeguardService(store),containment=new ContainmentService(store),retirements=new VaultRetirementService(store);
  const canOperateVault=(vaultId:string)=>containment.allows(vaultId)&&!retirements.isRetired(vaultId);
  const externalImporter=new ExternalImporter(config,store,storage,safeguards,(vaultId)=>canOperateVault(vaultId)&&!healthRepairLocks.has(vaultId));let externalTimer:NodeJS.Timeout|null=null,externalStartupTimer:NodeJS.Timeout|null=null,closing=false;
  const skipExternalOnce=new Set<string>(),restoreApprovedVaults=new Set<string>(),healthRepairLocks=new Set<string>(),mirrorWriteSettles=new Map<string,{snapshotId:string;until:number}>();
  const healthRepairPermit=Symbol('accepted-checkpoint-repair');
  const assertWritable=(vaultId:string,permit?:symbol)=>{if(healthRepairLocks.has(vaultId)&&permit!==healthRepairPermit)throw Object.assign(new Error('The server is repairing its accepted checkpoint. Saved edits will sync automatically when it finishes.'),{statusCode:503,healthRepairActive:true});};
  const watchWaiters=new Map<string,Set<(headId:string|null,attention:boolean)=>void>>();
  function notifyVault(vaultId:string,headId:string|null,attention=false){
    const waiters=watchWaiters.get(vaultId);if(!waiters)return;
    watchWaiters.delete(vaultId);for(const resolve of waiters)resolve(headId,attention);
  }
  app.addHook("onClose", async () => {
    closing=true;
    await contentUploads.close();
    for(const [vaultId] of watchWaiters)notifyVault(vaultId,null);
    if(externalTimer)clearInterval(externalTimer);if(externalStartupTimer)clearTimeout(externalStartupTimer);
    for(const {timer} of mirrorTimers.values())clearTimeout(timer);mirrorTimers.clear();await Promise.allSettled([...mirrorJobs.values()]);await externalImporter.settle();store.db.close();
  });
  await app.register(cors, { origin: true, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],exposedHeaders:["X-Content-SHA256"] });
  await app.register(multipart, { limits: { fileSize: config.MAX_BLOB_BYTES, files: 1 } });
  await app.register(sensible);
  app.setErrorHandler((error,_request,reply)=>{
    const typed=error as Error & {statusCode?:number;compatibility?:unknown;containment?:unknown;healthRepairActive?:boolean},compatibility=typed.compatibility;
    if(typed.statusCode===503&&typed.healthRepairActive===true)return reply.code(503).header('Retry-After','5').send({error:typed.message,healthRepairActive:true});
    if(typed.statusCode===426&&compatibility)return reply.code(426).send({error:typed.message,message:typed.message,compatibility});
    if(typed.statusCode===423&&typed.containment)return reply.code(423).send({error:typed.message,message:typed.message,containment:typed.containment});
    return reply.send(error);
  });
  app.addContentTypeParser("application/octet-stream", {bodyLimit:config.MAX_BLOB_BYTES+29},async(request:FastifyRequest,payload:import("node:stream").Readable)=>{
    const body=await parseBinaryBody(payload as AsyncIterable<Uint8Array>,verifiedBlobs.staging,Math.min(request.routeOptions.bodyLimit,config.MAX_BLOB_BYTES+29));
    if(isStagedBinary(body))requestStages.set(request,body.file);return body;
  });

  const header=(request:FastifyRequest,name:string):string|null=>{const value=request.headers[name];return Array.isArray(value)?value[0]??null:value??null;};
  const compatibilityFor=(request:FastifyRequest)=>{
    const rawProtocol=header(request,"x-gib-sync-protocol"),parsedProtocol=rawProtocol===null?null:Number(rawProtocol);
    return clientCompatibility({clientVersion:header(request,"x-gib-sync-client-version"),clientProtocol:Number.isInteger(parsedProtocol)?parsedProtocol:null,
      minimumVersion:config.GIBSYNC_MIN_CLIENT_VERSION,recommendedVersion:config.GIBSYNC_RECOMMENDED_CLIENT_VERSION,serverProtocol:PROTOCOL_VERSION,serverVersion:SERVER_VERSION,serverCapabilities:[...SERVER_CAPABILITIES]});
  };
  async function authenticate(request: FastifyRequest,options:{allowIncompatible?:boolean;allowContainment?:boolean}={}): Promise<AuthDevice> {
    const raw = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!raw) throw app.httpErrors.unauthorized();
    const device = store.one<AuthDevice & { revoked_at: string | null }>("SELECT id,vault_id,name,revoked_at FROM devices WHERE token_hash=?", sha256(raw));
    if (!device || device.revoked_at) throw app.httpErrors.unauthorized();
    if(retirements.isRetired(device.vault_id))throw app.httpErrors.gone("This obsolete vault registration was retired by the server. Its snapshots were preserved, but it can no longer synchronize.");
    const compatibility=compatibilityFor(request);
    store.run("UPDATE devices SET last_seen_at=?,client_version=?,client_protocol=? WHERE id=?", new Date().toISOString(),compatibility.clientVersion,compatibility.clientProtocol,device.id);
    if(config.GIBSYNC_MIN_CLIENT_VERSION!=="0.0.0"&&!options.allowIncompatible&&!compatibility.compatible)throw Object.assign(new Error(`${compatibility.reason} Update Gib Sync through BRAT before syncing.`),{statusCode:426,compatibility});
    const control=containment.state();
    if(control.active&&!options.allowContainment&&control.allowedVaultId!==device.vault_id)throw Object.assign(new Error("This server is in emergency containment. Sync is safely paused for this vault; no files are being changed."),{statusCode:423,containment:{active:true,thisVaultAllowed:false,enabledAt:control.enabledAt,reason:control.reason}});
    return device;
  }
  app.addHook("onRequest",async(request,reply)=>{
    const route=request.routeOptions.url??request.url.split("?")[0];
    const publicRoute=route==="/healthz"||route==="/setup"||route==="/v1/setup"||route==="/v1/storage/discover"||route==="/v1/pairings/claim-code"||route==="/v1/pairings/claim-qr"||route==="/v1/pairings/poll"||route==="/v1/pairings/cancel-claim";
    if(route==='/setup')invitationHeaders(reply);
    if(request.method==="OPTIONS")return;
    if(publicRoute&&Number(request.headers["content-length"]??0)>64*1024)return reply.code(413).send({error:"Setup request exceeds its permitted size"});
    if(!publicRoute)await authenticate(request,{allowIncompatible:route==="/v1/status"||route==="/v1/compatibility",allowContainment:route==="/v1/status"||route==="/v1/compatibility"});
    else if(route!=="/healthz"&&!takeRequestBudget(store,route==="/v1/pairings/poll"?"public-pairing-poll":"public-api",request.ip,route==="/v1/pairings/poll"?480:120,60_000))return reply.code(429).send({error:"Too many requests; try again shortly"});
    if(binaryRoute(route)){
      const hash=(request.params as {hash?:string})?.hash,device=store.one<AuthDevice>("SELECT id,vault_id,name FROM devices WHERE token_hash=?",sha256(request.headers.authorization?.replace(/^Bearer\s+/i,"")??""));
      const storedSize=device&&hash?store.one<{size:number}>("SELECT size FROM blobs WHERE vault_id=? AND hash=?",device.vault_id,hash)?.size:undefined;
      const expected=route==="/v1/content-uploads/:id/chunks/:index"||route==="/v1/content-uploads/:id/complete"?CONTENT_UPLOAD_CHUNK_BYTES:request.method==="PUT"?Number(request.headers["content-length"]??Number.NaN):storedSize??config.MAX_BLOB_BYTES+1024,release=binaryAdmission.acquire(expected);
      if(!release)return reply.code(503).header("Retry-After","2").send({error:"The server is safely processing another file; retry shortly"});binaryReleases.set(request,release);
    }
  });

  function storageRow(vaultId: string): VaultStorageRow {
    const row = store.one<VaultStorageRow>("SELECT id,storage_url,storage_username,storage_repo_id,storage_repo_name,storage_base_path,storage_token,storage_layout,mirror_base_path,mirror_head_id FROM vaults WHERE id=?", vaultId);
    if (!row?.storage_url || !row.storage_token) throw new Error("Vault storage is not configured");
    return row;
  }
  const snapshotCommitter=new SnapshotCommitter(store,storage,storageRow,assertWritable);
  const contentUploads=await registerContentUploads(app,{config,store,storage,authenticate,storageRow});

  async function reconcileReadableFolders(vaultId:string,snapshot:Snapshot,mayContinue:()=>boolean=()=>true):Promise<{created:number;deleted:number;remaining:string[]}>{
    const row=storageRow(vaultId),tree=await storage.listReadableTree(row),visible=new Set(tree.folders),desired=snapshotFolders(snapshot);let created=0,deleted=0;
    for(const path of [...desired].sort((left,right)=>left.split("/").length-right.split("/").length||left.localeCompare(right))){if(visible.has(path))continue;if(!mayContinue())throw new Error("Projection ownership changed before folder creation");await storage.ensureReadableFolder(row,path);visible.add(path);created++;}
    if(folderManifestInitialized(snapshot))for(const path of [...visible].filter((folder)=>!desired.has(folder)).sort((left,right)=>right.split("/").length-left.split("/").length||right.localeCompare(left))){
      if(store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",vaultId)?.head_id!==snapshot.id)throw new Error("Vault changed before folder projection");
      const operation=await projectionJournal.prepareFolder(row,path,snapshot.id);
      if(!mayContinue())throw new Error("Projection ownership changed before folder removal");
      if(await storage.deleteReadableFolder(row,path)){visible.delete(path);deleted++;}
      if(await projectionJournal.finish(row,operation))throw new ReadableChangedError();
    }
    return {created,deleted,remaining:folderManifestInitialized(snapshot)?[...visible].filter((folder)=>!desired.has(folder)).sort():[]};
  }

  async function verifyReadableGeneration(vaultId:string,snapshot:Snapshot,removedPaths:string[]):Promise<{missing:string[];lingering:string[];missingFolders:string[];lingeringFolders:string[]}>{
    const row=storageRow(vaultId),tree=await storage.listReadableTree(row),visible=new Map(tree.files.map((entry)=>[entry.path,entry])),visibleFolders=new Set(tree.folders),desiredFolders=snapshotFolders(snapshot),missing:string[]=[];
    for(const entry of snapshot.entries){
      const observed=visible.get(entry.path);if(!observed||observed.size!==entry.size){missing.push(entry.path);continue;}
      const verified=store.one<{hash:string;storage_id:string|null}>("SELECT hash,storage_id FROM mirror_entries WHERE vault_id=? AND path=?",vaultId,entry.path);
      if(verified?.hash===entry.hash&&verified.storage_id===observed.id)continue;
      const file=await verifiedBlobs.readable(row,entry.path);try{if(file.hash!==entry.hash){missing.push(entry.path);continue;}}finally{await file.dispose();}
      store.run("UPDATE mirror_entries SET storage_id=?,storage_mtime=? WHERE vault_id=? AND path=? AND hash=?",observed.id,observed.mtime,vaultId,entry.path,entry.hash);
    }
    const lingering=removedPaths.filter((path)=>visible.has(path));
    return {missing,lingering,missingFolders:[...desiredFolders].filter((path)=>!visibleFolders.has(path)),lingeringFolders:folderManifestInitialized(snapshot)?[...visibleFolders].filter((path)=>!desiredFolders.has(path)):[]};
  }

  const mirrorJobs=new Map<string,Promise<void>>(),externalScanRequests=new Set<string>(),interruptedExternalResults=new Map<string,ExternalImportResult>();let projectionTail:Promise<void>=Promise.resolve();const mirrorTimers=new Map<string,{timer:NodeJS.Timeout;due:number}>(),mirrorFailureCounts=new Map<string,number>(),mirrorRetryNotBefore=new Map<string,number>();
  async function ingestExternalChanges(vaultId:string,fresh=false,fromProjection=false):Promise<ExternalImportResult>{
    if(!canOperateVault(vaultId))return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,contained:true};
    if(integrityBlockedVaults.has(vaultId))return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,locked:true};
    if(healthRepairLocks.has(vaultId))return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0};
    // Background scans must respect the same projection ownership as forced
    // scans, including when a newer accepted head supersedes the writer.
    const activeMirror=!fromProjection?mirrorJobs.get(vaultId):undefined;
    if(activeMirror){
      if(!fresh)return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,mirrorGenerationMismatch:true};
      externalScanRequests.add(vaultId);
      const completed=await Promise.race([activeMirror.then(()=>true),new Promise<boolean>((resolve)=>setTimeout(()=>resolve(false),500))]);
      if(completed){
        const interrupted=interruptedExternalResults.get(vaultId);interruptedExternalResults.delete(vaultId);externalScanRequests.delete(vaultId);
        return interrupted??ingestExternalChanges(vaultId,true);
      }
      return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,mirrorGenerationMismatch:true};
    }
    if(fresh){
      const interrupted=interruptedExternalResults.get(vaultId);interruptedExternalResults.delete(vaultId);externalScanRequests.delete(vaultId);
      if(interrupted)return interrupted;
    }else if(externalScanRequests.has(vaultId))return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,mirrorGenerationMismatch:true};
    const settling=mirrorWriteSettles.get(vaultId),vault=store.one<{head_id:string|null;mirror_head_id:string|null;mirror_generation_id:string|null}>("SELECT head_id,mirror_head_id,mirror_generation_id FROM vaults WHERE id=?",vaultId);
    if(settling&&settling.snapshotId===vault?.head_id&&settling.until>Date.now()){
      const mirrorCurrent=Boolean(vault?.head_id&&vault.head_id===vault.mirror_head_id&&vault.head_id===vault.mirror_generation_id);
      // A forced scan must not reinterpret this server's own in-flight
      // readable writes as Seafile edits. Once the generation is complete,
      // explicit scans may bypass the short metadata-settle delay.
      if(!fresh||!mirrorCurrent){
        if(fresh&&!mirrorCurrent)scheduleMirror(vaultId,50);
        return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,mirrorGenerationMismatch:!mirrorCurrent};
      }
    }
    if(settling)mirrorWriteSettles.delete(vaultId);
    const result=await externalImporter.scan(vaultId,fresh);
    if(result.snapshotId){notifyVault(vaultId,result.snapshotId);scheduleMirror(vaultId,50);app.log.info({vaultId,...result},"Imported external Seafile changes");}
    else if(result.quarantineId){const headId=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",vaultId)?.head_id??null;notifyVault(vaultId,headId,true);}
    else if(result.mirrorGenerationMismatch&&!fromProjection)scheduleMirror(vaultId,50);
    return result;
  }
  function reconcileReadableMirror(vaultId:string):Promise<void>{
    if(!canOperateVault(vaultId)||integrityBlockedVaults.has(vaultId))return Promise.resolve();
    const active=mirrorJobs.get(vaultId);if(active)return active;
    if(!store.one("SELECT 1 FROM mirror_jobs WHERE vault_id=?",vaultId))durableJobs.enqueue(vaultId);
    const lease=durableJobs.claim(vaultId);if(!lease)return Promise.resolve();
    let leaseLost=false;const leaseTimer=setInterval(()=>{if(!durableJobs.renew(lease))leaseLost=true;},30_000);leaseTimer.unref();
    const job=projectionTail.then(async()=>{for(let attempt=0;attempt<3;attempt++){
      if(closing||leaseLost||!durableJobs.owns(lease))return;
      await projectionJournal.recover(storageRow(vaultId));
      let external:ExternalImportResult|null=null;
      if(skipExternalOnce.has(vaultId))skipExternalOnce.delete(vaultId);else external=await ingestExternalChanges(vaultId,false,true);
      if(externalScanRequests.has(vaultId)){
        if(external&&(external.snapshotId!==null||Boolean(external.quarantineId)||Boolean(external.deferredDeletions)||external.changedFiles>0||external.deletedFiles>0||external.conflicts>0))interruptedExternalResults.set(vaultId,external);
        scheduleMirror(vaultId,50);
        return;
      }
      // A missing readable file is held for confirmation rather than being
      // recreated by the mirror. Likewise, quarantined external changes stay
      // untouched until the user accepts or rejects them.
      if(external?.deferredDeletions||external?.quarantineId||external?.locked)return;
      const vault=store.one<{head_id:string|null;mirror_head_id:string|null;mirror_generation_id:string|null;mirror_repo_commit:string|null;wrapped_key:string}>("SELECT head_id,mirror_head_id,mirror_generation_id,mirror_repo_commit,wrapped_key FROM vaults WHERE id=?",vaultId);if(!vault?.head_id)return;
      const snapshot=store.getSnapshot(vault.head_id);if(!snapshot)return;const row=storageRow(vaultId),generation=await readGeneration(config,storage,row);
      await projectionJournal.recover(row);
      if(vault.mirror_head_id===vault.head_id&&vault.mirror_generation_id===vault.head_id&&vault.mirror_repo_commit&&validGeneration(generation,snapshot))return;
      const key=openJson<string>(vault.wrapped_key,config.GIBSYNC_SERVER_SECRET,vaultId),target=new Set(snapshot.entries.map((entry)=>entry.path));
      const visible=new Map((await storage.listReadable(row)).map((entry)=>[entry.path,entry]));
      const headStillCurrent=()=>store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",vaultId)?.head_id===snapshot.id,mayContinue=()=>!closing&&!leaseLost&&durableJobs.owns(lease)&&headStillCurrent()&&!externalScanRequests.has(vaultId)&&canOperateVault(vaultId);let superseded=false;
      for(const entry of snapshot.entries){if(!mayContinue()){superseded=true;break;}const current=store.one<{hash:string}>("SELECT hash FROM mirror_entries WHERE vault_id=? AND path=?",vaultId,entry.path);if(current?.hash===entry.hash&&visible.get(entry.path)?.size===entry.size)continue;
        // Explicit repair verifies unchanged readable bytes instead of rewriting
        // every note/plugin. This is a read-back proof, never a size/hash guess;
        // final generation verification still checks the current backend IDs.
        const observed=visible.get(entry.path);
        if(restoreApprovedVaults.has(vaultId)&&observed?.size===entry.size){
          const existing=await verifiedBlobs.readable(row,entry.path);
          try{if(existing.hash===entry.hash){if(!mayContinue()){superseded=true;break;}store.run("INSERT INTO mirror_entries(vault_id,path,hash,size,updated_at,storage_id,storage_mtime) VALUES(?,?,?,?,?,?,?) ON CONFLICT(vault_id,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,updated_at=excluded.updated_at,storage_id=excluded.storage_id,storage_mtime=excluded.storage_mtime",vaultId,entry.path,entry.hash,existing.size,new Date().toISOString(),observed.id,observed.mtime);continue;}}
          finally{await existing.dispose();}
        }
        const clear=await verifiedBlobs.clear(row,entry.hash);
        try{
          const operation=await projectionJournal.prepare(row,entry.path,snapshot.id,current?.hash??null,entry.hash,restoreApprovedVaults.has(vaultId));
          if(!mayContinue()){superseded=true;break;}
          mirrorWriteSettles.set(vaultId,{snapshotId:snapshot.id,until:Date.now()+5000});
          if(typeof storage.putReadableFile==="function")await storage.putReadableFile(row,entry.path,clear.path);
          else{if(clear.size>2*1024*1024)throw new Error("Storage adapter cannot safely project this large file");await storage.putReadable(row,entry.path,await readFile(clear.path));}
          projectionJournal.acknowledgeWrite(row,operation);
          const raced=await projectionJournal.finish(row,operation);
          if(!mayContinue()){superseded=true;break;}
          store.run("INSERT INTO mirror_entries(vault_id,path,hash,size,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(vault_id,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,updated_at=excluded.updated_at,storage_id=NULL,storage_mtime=NULL",vaultId,entry.path,entry.hash,clear.size,new Date().toISOString());if(raced)throw new ReadableChangedError();
        }finally{await clear.dispose();}}
      if(superseded){const externalRequested=externalScanRequests.delete(vaultId);mirrorWriteSettles.delete(vaultId);if(!canOperateVault(vaultId))return;if(externalRequested){scheduleMirror(vaultId,50);return;}skipExternalOnce.add(vaultId);continue;}
      const removedPaths:string[]=[];for(const {path,hash} of store.all<{path:string;hash:string}>("SELECT path,hash FROM mirror_entries WHERE vault_id=?",vaultId)){if(target.has(path))continue;if(!mayContinue()){superseded=true;break;}const operation=await projectionJournal.prepare(row,path,snapshot.id,hash,null,restoreApprovedVaults.has(vaultId));if(!mayContinue()){superseded=true;break;}mirrorWriteSettles.set(vaultId,{snapshotId:snapshot.id,until:Date.now()+5000});await storage.deleteReadable(row,path);const raced=await projectionJournal.finish(row,operation);if(!mayContinue()){superseded=true;break;}store.run("DELETE FROM mirror_entries WHERE vault_id=? AND path=?",vaultId,path);removedPaths.push(path);if(raced)throw new ReadableChangedError();}
      if(superseded){const externalRequested=externalScanRequests.delete(vaultId);mirrorWriteSettles.delete(vaultId);if(!canOperateVault(vaultId))return;if(externalRequested){scheduleMirror(vaultId,50);return;}skipExternalOnce.add(vaultId);continue;}
      if(!mayContinue()){mirrorWriteSettles.delete(vaultId);return;}
      const folderResult=await reconcileReadableFolders(vaultId,snapshot,mayContinue),repoCommit=(await storage.repoHistory(row))[0]?.commitId??null,verified=await verifyReadableGeneration(vaultId,snapshot,removedPaths);if(verified.missing.length||verified.lingering.length||verified.missingFolders.length||verified.lingeringFolders.length)throw new Error(`Readable mirror generation is not yet visible (${verified.missing.length} files missing, ${verified.lingering.length} files lingering, ${verified.missingFolders.length} folders missing, ${verified.lingeringFolders.length} folders lingering${folderResult.remaining.length?`, ${folderResult.remaining.length} non-empty folder removals deferred`:""})`);
      if(!mayContinue()){const externalRequested=externalScanRequests.delete(vaultId);mirrorWriteSettles.delete(vaultId);if(!canOperateVault(vaultId))return;if(externalRequested){scheduleMirror(vaultId,50);return;}skipExternalOnce.add(vaultId);continue;}
      await writeGeneration(config,storage,row,snapshot);const completed=store.run("UPDATE vaults SET mirror_head_id=?,mirror_generation_id=?,mirror_repo_commit=? WHERE id=? AND head_id=?",snapshot.id,snapshot.id,repoCommit,vaultId,snapshot.id);
      if(completed.changes){store.run("DELETE FROM external_absences WHERE vault_id=?",vaultId);mirrorWriteSettles.delete(vaultId);return;}
      skipExternalOnce.add(vaultId);mirrorWriteSettles.delete(vaultId);
    }throw new Error(`Readable mirror could not catch up for vault ${vaultId}`);}).then(()=>{mirrorFailureCounts.delete(vaultId);mirrorRetryNotBefore.delete(vaultId);}).catch((error)=>{
      const failures=(mirrorFailureCounts.get(vaultId)??0)+1,retryMs=Math.min(60_000,5000*(2**Math.min(failures-1,4)));mirrorFailureCounts.set(vaultId,failures);mirrorRetryNotBefore.set(vaultId,Date.now()+retryMs);
      durableJobs.retry(lease,error,retryMs);
      app.log.error({err:error,vaultId,retryMs},"Readable mirror reconciliation failed");scheduleMirror(vaultId,retryMs);
    }).finally(()=>{clearInterval(leaseTimer);if(closing)durableJobs.retry(lease,new Error("Shutdown"),0);else durableJobs.finish(lease);restoreApprovedVaults.delete(vaultId);mirrorJobs.delete(vaultId);});
    mirrorJobs.set(vaultId,job);projectionTail=job.then(()=>{},()=>{});return job;
  }
  function scheduleMirror(vaultId:string,delay=2000,persist=true){
    if(closing||!canOperateVault(vaultId))return;const effectiveDelay=Math.max(delay,(mirrorRetryNotBefore.get(vaultId)??0)-Date.now(),0),due=Date.now()+effectiveDelay;if(persist)durableJobs.enqueue(vaultId,effectiveDelay);const scheduled=mirrorTimers.get(vaultId);if(scheduled&&scheduled.due<=due)return;if(scheduled)clearTimeout(scheduled.timer);
    const timer=setTimeout(()=>{mirrorTimers.delete(vaultId);if(!closing)void reconcileReadableMirror(vaultId);},effectiveDelay);timer.unref();mirrorTimers.set(vaultId,{timer,due});
  }

  function setupResponse(vaultId: string, vaultName: string, deviceId: string, deviceToken: string): SetupResponse {
    const vault = store.one<{wrapped_key: string; head_id: string | null}>("SELECT wrapped_key,head_id FROM vaults WHERE id=?", vaultId)!;
    return {
      protocolVersion: PROTOCOL_VERSION, serverVersion:SERVER_VERSION,serverCapabilities:[...SERVER_CAPABILITIES],serverUrl: config.PUBLIC_URL, vaultId, vaultName, deviceId, deviceToken,
      vaultKey: openJson<string>(vault.wrapped_key, config.GIBSYNC_SERVER_SECRET, vaultId),
      head: vault.head_id ? getSnapshotView(store,vault.head_id) : null, storage: storage.location(storageRow(vaultId))
    };
  }

  app.get("/healthz", async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION,serverVersion:SERVER_VERSION,serverCapabilities:[...SERVER_CAPABILITIES],minimumClientVersion:config.GIBSYNC_MIN_CLIENT_VERSION,recommendedClientVersion:config.GIBSYNC_RECOMMENDED_CLIENT_VERSION, containmentActive:containment.state().active,storage: "seafile", readableMirrors:true,externalEdits:true,externalScanSeconds:3,quickCodes:true,quickCodeSeconds:60,instantReceive:true,conflictPolicy:"word-aware-v1",safeguards:"quarantine-v1",vaults: store.one<{count:number}>("SELECT COUNT(*) AS count FROM vaults")?.count ?? 0,activeVaults:store.one<{count:number}>("SELECT COUNT(*) AS count FROM vaults WHERE retired_at IS NULL")?.count??0,retiredVaults:store.one<{count:number}>("SELECT COUNT(*) AS count FROM vaults WHERE retired_at IS NOT NULL")?.count??0 }));
  registerSetupInvitation(app,config.PUBLIC_URL);

  app.post("/v1/health/repair",async(request,reply)=>{
    const device=await authenticate(request);z.object({restoreAcceptedHead:z.literal(true)}).parse(request.body);
    if(integrityBlockedVaults.has(device.vault_id))return reply.code(423).send({error:"The accepted snapshot failed structural integrity checks. Automated mirror repair is blocked to prevent propagation; restore the database from a verified backup or use an audited server repair."});
    if(healthRepairLocks.has(device.vault_id))return reply.conflict("A health repair is already running for this vault");healthRepairLocks.add(device.vault_id);
    try{
    // Stop and drain the prior projection/import boundary before selecting the
    // accepted repair head; an already running external scan cannot race it.
    externalScanRequests.add(device.vault_id);await Promise.allSettled([externalImporter.settleVault(device.vault_id),mirrorJobs.get(device.vault_id)??Promise.resolve()]);externalScanRequests.delete(device.vault_id);interruptedExternalResults.delete(device.vault_id);
    mirrorFailureCounts.delete(device.vault_id);mirrorRetryNotBefore.delete(device.vault_id);
    const vault=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)!;
    let snapshot=vault.head_id?store.getSnapshot(vault.head_id):null,removedConflictCopies=0;
    if(snapshot){
      const generatedSuffix=/ \(conflict - .+ - \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} UTC(?: - \d+)?\)(?=\.[^/]+$|$)/i;
      const groups=new Map<string,ManifestEntry[]>();
      for(const entry of snapshot.entries){const original=entry.path.replace(generatedSuffix,"");if(original===entry.path)continue;const copies=groups.get(original)??[];copies.push(entry);groups.set(original,copies);}
      const byPath=new Map(snapshot.entries.map((entry)=>[entry.path,entry])),redundant=new Set<string>();for(const [original,copies] of groups){const intact=byPath.get(original);if(!intact)continue;for(const copy of copies)if(copy.hash===intact.hash)redundant.add(copy.path);}
      if(redundant.size){
        const cleaned=await acceptSnapshot(device.vault_id,snapshot.id,device.id,device.name,`Health repair: removed ${redundant.size} redundant generated conflict copies`,snapshot.entries.filter((entry)=>!redundant.has(entry.path)),snapshot.folders,snapshot.folderRepair,undefined,undefined,snapshot.folderEntries,healthRepairPermit);
        if(!cleaned)return reply.conflict("Vault changed while health repair was preparing the cleaned snapshot");
        snapshot=cleaned;removedConflictCopies=redundant.size;
      }
    }
    const current=store.all<{path:string;hash:string}>("SELECT path,hash FROM mirror_entries WHERE vault_id=?",device.vault_id);
    const target=new Set((snapshot?.entries??[]).map((entry)=>entry.path));const removedFiles=current.filter((entry)=>!target.has(entry.path)).length;
    const dismissedQuarantines=store.one<{count:number}>("SELECT COUNT(*) count FROM quarantines WHERE vault_id=? AND status='pending'",device.vault_id)?.count??0;
    const clearedAlerts=store.one<{count:number}>("SELECT COUNT(*) count FROM health_events WHERE vault_id=? AND cleared_at IS NULL",device.vault_id)?.count??0,now=new Date().toISOString();
    store.run("UPDATE quarantines SET status='rejected',resolved_at=?,resolved_by=?,resolution_kind='health_repair',resolution_context_json=? WHERE vault_id=? AND status='pending'",now,device.id,JSON.stringify({resolvedAt:now,resolvedByDeviceId:device.id,resolvedByDeviceName:device.name}),device.vault_id);
    store.run("UPDATE health_events SET cleared_at=? WHERE vault_id=? AND cleared_at IS NULL",now,device.vault_id);
    // Explicit accepted-head restoration rejects only already observed pending
    // imports; their encrypted history remains available for recovery.
    store.run("UPDATE external_revisions SET imported_at=? WHERE vault_id=? AND imported_at IS NULL AND observed_at<=?",now,device.vault_id,now);store.run("UPDATE external_folder_revisions SET imported_at=? WHERE vault_id=? AND imported_at IS NULL",now,device.vault_id);
    store.run("UPDATE mirror_entries SET hash=? WHERE vault_id=?",`repair:${now}`,device.vault_id);store.run("UPDATE vaults SET mirror_head_id=NULL,mirror_generation_id=NULL,external_error=NULL WHERE id=?",device.vault_id);
    skipExternalOnce.add(device.vault_id);restoreApprovedVaults.add(device.vault_id);scheduleMirror(device.vault_id,0);await reconcileReadableMirror(device.vault_id);
    let repaired=store.one<{head_id:string|null;mirror_head_id:string|null;mirror_generation_id:string|null}>("SELECT head_id,mirror_head_id,mirror_generation_id FROM vaults WHERE id=?",device.vault_id)!;
    if(repaired.head_id!==repaired.mirror_head_id||repaired.head_id!==repaired.mirror_generation_id){skipExternalOnce.add(device.vault_id);await reconcileReadableMirror(device.vault_id);repaired=store.one<{head_id:string|null;mirror_head_id:string|null;mirror_generation_id:string|null}>("SELECT head_id,mirror_head_id,mirror_generation_id FROM vaults WHERE id=?",device.vault_id)!;}
    const mirrorCurrent=repaired.head_id===repaired.mirror_head_id&&repaired.head_id===repaired.mirror_generation_id;
    safeguards.event(device.vault_id,"health_repair",mirrorCurrent?"info":"error",mirrorCurrent?`${device.name} restored the accepted snapshot and rebuilt the readable mirror`:`${device.name} requested health repair but the readable mirror did not converge`);
    notifyVault(device.vault_id,repaired.head_id,!mirrorCurrent);const result={headId:repaired.head_id,mirrorCurrent,restoredFiles:snapshot?.entries.length??0,removedFiles,removedConflictCopies,dismissedQuarantines,clearedAlerts};
    return mirrorCurrent?result:reply.code(503).send({error:"Health repair could not make the readable mirror current",...result});
    }finally{healthRepairLocks.delete(device.vault_id);}
  });

  const credentialsSchema = z.object({ seafileUrl:z.string().url(), seafileUsername:z.string().min(1).max(320), seafilePassword:z.string().min(1).max(1000) });

  app.post("/v1/storage/discover",{bodyLimit:64*1024}, async (request) => {
    const body = credentialsSchema.parse(request.body);canaryScope.assertCredentials(body.seafileUrl,body.seafileUsername);const credentials = await storage.authenticate(body.seafileUrl, body.seafileUsername, body.seafilePassword);canaryScope.assertCredentials(credentials.url,credentials.username);
    const libraries=canaryScope.libraries(await storage.libraries(credentials));const libraryIds=new Set(libraries.map((item)=>item.id));
    const existingVaults=store.all<{vaultId:string;vaultName:string;libraryId:string;libraryName:string;basePath:string;storageUrl:string}>(
      "SELECT id vaultId,name vaultName,storage_repo_id libraryId,storage_repo_name libraryName,storage_base_path basePath,storage_url storageUrl FROM vaults WHERE storage_username=? AND retired_at IS NULL ORDER BY created_at",credentials.username)
      .filter((vault)=>storage.equivalentServer(vault.storageUrl,credentials.url)&&libraryIds.has(vault.libraryId)).map(({storageUrl:_storageUrl,...vault})=>vault);
    return { username:credentials.username,libraries,existingVaults };
  });

  app.post("/v1/setup",{bodyLimit:64*1024}, async (request, reply) => {
    const body = credentialsSchema.extend({ vaultName:z.string().min(1).max(100), deviceName:z.string().min(1).max(100), libraryId:z.string().min(1).max(100), libraryName:z.string().min(1).max(255), basePath:z.string().max(1000).default("/"), existingVaultId:z.string().uuid().optional() }).parse(request.body) as StorageSetupRequest;
    canaryScope.assertCredentials(body.seafileUrl,body.seafileUsername);canaryScope.assertLibrary(body.libraryId);
    const credentials = await storage.authenticate(body.seafileUrl, body.seafileUsername, body.seafilePassword);canaryScope.assertCredentials(credentials.url,credentials.username);
    const libraries = canaryScope.libraries(await storage.libraries(credentials)); const library = libraries.find((item) => item.id === body.libraryId);
    if (!library) return reply.badRequest("The selected Seafile library is not accessible to this account");
    const basePath = normalizeBasePath(body.basePath);let vault:{id:string;name:string;storage_username:string;storage_url:string;head_id:string|null}|undefined,newRegistration=false;const now = new Date().toISOString();
    // Claim the physical folder under SQLite's cross-process write lock. No
    // network await may separate ownership validation from its durable insert.
    store.db.exec("BEGIN IMMEDIATE");try{vault = body.existingVaultId ? store.one<{id:string;name:string;storage_username:string;storage_url:string;head_id:string|null}>(
      "SELECT id,name,storage_username,storage_url,head_id FROM vaults WHERE id=? AND storage_repo_id=? AND retired_at IS NULL",body.existingVaultId,library.id) : store.one<{id:string;name:string;storage_username:string;storage_url:string;head_id:string|null}>(
      "SELECT id,name,storage_username,storage_url,head_id FROM vaults WHERE storage_url=? AND storage_repo_id=? AND storage_base_path=? AND storage_layout='standard' AND retired_at IS NULL",credentials.url,library.id,basePath);
    const locations=store.all<{id:string;name:string;storage_username:string;storage_url:string;head_id:string|null;mirror_base_path:string;storage_layout:string}>("SELECT id,name,storage_username,storage_url,head_id,mirror_base_path,storage_layout FROM vaults WHERE storage_repo_id=? AND retired_at IS NULL",library.id).filter((item)=>storage.equivalentServer(item.storage_url,credentials.url));
    const portableRoot=(path:string)=>normalizeBasePath(path).normalize("NFC").toLowerCase(),requestedRoot=portableRoot(basePath);
    if(!body.existingVaultId&&!vault)vault=locations.find((item)=>item.storage_layout==="standard"&&portableRoot(item.mirror_base_path)===requestedRoot);
    const overlaps=(first:string,second:string)=>first===second||first==="/"||second==="/"||first.startsWith(`${second}/`)||second.startsWith(`${first}/`);
    if(!vault&&locations.some((item)=>overlaps(portableRoot(item.mirror_base_path),requestedRoot)))throw app.httpErrors.conflict("This folder overlaps another Gib Sync vault; select its existing vault or a separate folder");
    if (body.existingVaultId && (!vault || !storage.equivalentServer(vault.storage_url,credentials.url)))throw app.httpErrors.forbidden("The selected existing vault is not available to this Seafile account");
    if (vault && vault.storage_username !== credentials.username)throw app.httpErrors.forbidden("This storage location belongs to another Gib Sync user");
    if (!vault) {
      const id = randomUUID(); const vaultKey = randomToken(32);
      store.run("INSERT INTO vaults(id,name,wrapped_key,created_at,storage_url,storage_username,storage_repo_id,storage_repo_name,storage_base_path,storage_token,storage_layout,mirror_base_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        id,body.vaultName,sealJson(vaultKey,config.GIBSYNC_SERVER_SECRET,id),now,credentials.url,credentials.username,library.id,library.name,basePath,storage.sealToken(id,credentials.token),"standard",basePath);
      vault = { id, name:body.vaultName, storage_username:credentials.username, storage_url:credentials.url,head_id:null };newRegistration=true;
    } else {
      store.run("UPDATE vaults SET storage_token=?,storage_repo_name=? WHERE id=?", storage.sealToken(vault.id,credentials.token),library.name,vault.id);
    }
    store.db.exec("COMMIT");}catch(error){try{store.db.exec("ROLLBACK");}catch{}throw error;}
    if(newRegistration)await storage.initVault(storageRow(vault!.id));
    const deviceId = randomUUID(); const deviceToken = randomToken();
    store.run("INSERT INTO devices(id,vault_id,name,token_hash,created_at,last_seen_at,initial_sync_complete) VALUES(?,?,?,?,?,?,?)",deviceId,vault.id,body.deviceName,sha256(deviceToken),now,now,vault.head_id?0:1);
    return setupResponse(vault.id,vault.name,deviceId,deviceToken);
  });

  type PairingRow={id:string;vault_id:string;expires_at:string;consumed_at:string|null};
  const trustedPairing=new TrustedPairing(store,config.GIBSYNC_SERVER_SECRET,setupResponse);
  app.post("/v1/pairings",{bodyLimit:4096},async(request)=>{
    const device=await authenticate(request);const pairingId=randomUUID();
    const requestOptions=z.object({requireConfirmation:z.boolean().optional()}).parse(request.body??{});
    if(requestOptions.requireConfirmation!==true)throw app.httpErrors.upgradeRequired("Update Gib Sync on the inviting device through BRAT to approve new devices securely. Existing synchronization is unaffected.");
    const requiresConfirmation=true;
    const now=Date.now(),expiresAt=new Date(now+60_000).toISOString(),qrExpiresAt=new Date(now+600_000).toISOString(),qrToken=randomToken();
    store.run("UPDATE pairings SET quick_code_hash=NULL WHERE consumed_at IS NOT NULL OR expires_at<?",new Date(now).toISOString());
    let code="";let normalized="";
    for(let attempt=0;attempt<8;attempt++){code=quickCode();normalized=normalizeQuickCode(code);if(!store.one("SELECT id FROM pairings WHERE quick_code_hash=?",sha256(normalized)))break;}
    if(!code||store.one("SELECT id FROM pairings WHERE quick_code_hash=?",sha256(normalized)))throw new Error("Unable to allocate a quick code");
    store.run("INSERT INTO pairings(id,vault_id,secret_hash,quick_code_hash,created_by_device,expires_at,qr_expires_at,requires_confirmation) VALUES(?,?,?,?,?,?,?,?)",pairingId,device.vault_id,sha256(qrToken),sha256(normalized),device.id,expiresAt,qrExpiresAt,1);
    return {code,expiresAt,requiresConfirmation,setupUrl:invitationSetupUrl(config.PUBLIC_URL,code,expiresAt),qrSetupUrl:qrInvitationSetupUrl(config.PUBLIC_URL,qrToken,qrExpiresAt),qrExpiresAt};
  });

  app.post("/v1/pairings/claim-code",{bodyLimit:64*1024},async(request,reply)=>{
    if(!takeRequestBudget(store,"quick-code",request.ip,5,60_000)||!takeRequestBudget(store,"quick-code-global","all",100,60_000))return reply.code(429).header("Retry-After","60").send({error:"Too many quick-code attempts; try again later"});
    const body=z.object({code:z.string().min(5).max(12),deviceName:z.string().min(1).max(100)}).parse(request.body);let code:string;
    try{code=normalizeQuickCode(body.code);}catch{return reply.code(410).send({error:"Quick code expired or invalid"});}
    const row=store.one<PairingRow&{requires_confirmation:number}>("SELECT id,vault_id,expires_at,consumed_at,requires_confirmation FROM pairings WHERE quick_code_hash=?",sha256(code));
    if(!row||row.consumed_at||Date.parse(row.expires_at)<=Date.now())return reply.code(410).send({error:"Quick code expired or invalid"});
    if(!row.requires_confirmation)return reply.code(426).send({error:"This older quick code cannot connect devices securely. Update Gib Sync on the inviting device through BRAT and create a new code. Existing synchronization is unaffected."});
    return reply.code(202).send(trustedPairing.claim(row.id,body.deviceName));
  });
  app.post("/v1/pairings/claim-qr",{bodyLimit:4096},async(request,reply)=>{
    if(!takeRequestBudget(store,"qr-invite",request.ip,10,60_000)||!takeRequestBudget(store,"qr-invite-global","all",100,60_000))return reply.code(429).header("Retry-After","60").send({error:"Too many invitation attempts; try again later"});
    const parsed=z.object({token:z.string().regex(/^[-_A-Za-z0-9]{43}$/),deviceName:z.string().min(1).max(100)}).strict().safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"QR invitation is invalid"});const body=parsed.data;
    const row=store.one<PairingRow&{requires_confirmation:number;qr_expires_at:string|null}>("SELECT id,vault_id,expires_at,qr_expires_at,consumed_at,requires_confirmation FROM pairings WHERE secret_hash=?",sha256(body.token));
    if(!row||row.consumed_at||!row.requires_confirmation||!row.qr_expires_at||Date.parse(row.qr_expires_at)<=Date.now())return reply.code(410).send({error:"QR invitation expired or invalid"});
    return reply.code(202).send(trustedPairing.claim(row.id,body.deviceName,"qr"));
  });
  app.get("/v1/pairings/pending",async(request)=>trustedPairing.list(await authenticate(request)));
  app.post("/v1/pairings/requests/:id/decision",{bodyLimit:4096},async(request)=>{const device=await authenticate(request),{id}=z.object({id:z.string().uuid()}).parse(request.params),{approved}=z.object({approved:z.boolean()}).parse(request.body);return trustedPairing.decide(device,id,approved);});
  app.post("/v1/pairings/poll",{bodyLimit:4096},async(request)=>{const {ticket}=z.object({ticket:z.string().min(40).max(50)}).parse(request.body);if(!takeRequestBudget(store,"pairing-poll",sha256(ticket),60,60_000))throw app.httpErrors.tooManyRequests("Device request polling is too frequent");return trustedPairing.poll(ticket);});
  app.post("/v1/pairings/cancel-claim",{bodyLimit:4096},async(request)=>{const {ticket}=z.object({ticket:z.string().min(40).max(50)}).parse(request.body);return trustedPairing.cancel(ticket);});

  app.get("/v1/state", async (request) => {
    const device = await authenticate(request);
    const vault = store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?", device.vault_id)!;
    return { head: vault.head_id ? getSnapshotView(store,vault.head_id) : null };
  });
  app.get("/v1/delta",async(request,reply)=>{
    const device=await authenticate(request),since=z.object({since:z.string().uuid()}).parse(request.query).since;
    const base=getSnapshotView(store,since),headId=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)?.head_id;
    const head=headId?getSnapshotView(store,headId):null;
    if(!base||base.vaultId!==device.vault_id||!head)return reply.conflict("The delta baseline is unavailable; fetch the current snapshot");
    const before=new Map(base.entries.map((entry)=>[entry.path,entry])),after=new Map(head.entries.map((entry)=>[entry.path,entry]));
    const {entries:unusedEntries,...snapshot}=head;
    return {baseId:since,snapshot,changed:head.entries.filter((entry)=>JSON.stringify(before.get(entry.path))!==JSON.stringify(entry)),removed:base.entries.filter((entry)=>!after.has(entry.path)).map((entry)=>entry.path)};
  });

  app.get("/v1/watch", async (request) => {
    const device=await authenticate(request);
    const supplied=z.object({head:z.union([z.literal(""),z.string().uuid()]).default("")}).parse(request.query).head||null;
    const current=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)!.head_id;
    if(current!==supplied)return {changed:true,headId:current};
    return await new Promise<{changed:boolean;headId:string|null;attention?:boolean}>((resolve)=>{
      let settled=false;
      const finish=(headId:string|null,changed:boolean,attention=false)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        const waiters=watchWaiters.get(device.vault_id);waiters?.delete(onChange);if(waiters?.size===0)watchWaiters.delete(device.vault_id);
        resolve(attention?{changed:true,headId,attention:true}:{changed,headId});
      };
      const onChange=(headId:string|null,attention:boolean)=>finish(headId,headId!==supplied,attention);
      const timer=setTimeout(()=>finish(supplied,false),25_000);timer.unref();
      let waiters=watchWaiters.get(device.vault_id);if(!waiters){waiters=new Set();watchWaiters.set(device.vault_id,waiters);}
      waiters.add(onChange);
    });
  });

  app.get("/v1/status", async (request) => {
    const device = await authenticate(request,{allowIncompatible:true,allowContainment:true}); const compatibility=compatibilityFor(request),vault = store.one<{name:string;head_id:string|null;mirror_head_id:string|null;mirror_generation_id:string|null;external_scan_at:string|null;external_import_at:string|null;external_error:string|null}>("SELECT name,head_id,mirror_head_id,mirror_generation_id,external_scan_at,external_import_at,external_error FROM vaults WHERE id=?",device.vault_id)!;
    const mirrorCurrent=Boolean(vault.head_id&&vault.mirror_head_id===vault.head_id&&vault.mirror_generation_id===vault.head_id);
    const pending=store.one<{lease_owner:string|null;lease_until:number|null;attempts:number;last_error:string|null}>("SELECT lease_owner,lease_until,attempts,last_error FROM mirror_jobs WHERE vault_id=?",device.vault_id),projectionState=pending?(pending.lease_owner&&(pending.lease_until??0)>Date.now()?"running":pending.attempts?"retrying":"queued"):"idle";
    safeguards.clearResolvedQuarantineAlerts(device.vault_id);
    const aggregate = store.one<{snapshot_count:number;blob_count:number;blob_bytes:number}>("SELECT (SELECT COUNT(*) FROM snapshots WHERE vault_id=?) snapshot_count,(SELECT COUNT(*) FROM blobs WHERE vault_id=?) blob_count,(SELECT COALESCE(SUM(size),0) FROM blobs WHERE vault_id=?) blob_bytes",device.vault_id,device.vault_id,device.vault_id)!;
    const devices=store.all<{id:string;name:string;created_at:string;last_seen_at:string;revoked_at:string|null;initial_sync_complete:number;initial_sync_head_id:string|null;acknowledged_at:string|null;clock_skew_ms:number;client_version:string|null;client_protocol:number|null}>("SELECT id,name,created_at,last_seen_at,revoked_at,initial_sync_complete,initial_sync_head_id,acknowledged_at,clock_skew_ms,client_version,client_protocol FROM devices WHERE vault_id=? ORDER BY created_at",device.vault_id)
      .map((item)=>{const state=clientCompatibility({clientVersion:item.client_version,clientProtocol:item.client_protocol,minimumVersion:config.GIBSYNC_MIN_CLIENT_VERSION,recommendedVersion:config.GIBSYNC_RECOMMENDED_CLIENT_VERSION,serverProtocol:PROTOCOL_VERSION,serverVersion:SERVER_VERSION,serverCapabilities:[...SERVER_CAPABILITIES]});return {id:item.id,name:item.name,createdAt:item.created_at,lastSeenAt:item.last_seen_at,revokedAt:item.revoked_at,ready:Boolean(item.initial_sync_complete),acknowledgedSnapshotId:item.initial_sync_head_id,acknowledgedAt:item.acknowledged_at,clockSkewMs:item.clock_skew_ms,current:item.id===device.id,clientVersion:item.client_version,clientProtocol:item.client_protocol,compatibility:state.compatible?(state.updateAvailable?"update-available":"compatible"):"incompatible"};});
    const healthAlerts=store.all<{code:string;level:"info"|"warning"|"error";message:string;created_at:string}>("SELECT code,level,message,created_at FROM health_events WHERE vault_id=? AND cleared_at IS NULL ORDER BY created_at DESC LIMIT 20",device.vault_id)
      .map((item)=>({code:item.code,level:item.level,message:item.message,at:item.created_at}));
    if(vault.external_error)healthAlerts.unshift({code:"external_error",level:"error",message:`External Seafile scan: ${vault.external_error}`,at:vault.external_scan_at??new Date().toISOString()});
    if(vault.head_id&&!mirrorCurrent)healthAlerts.unshift(projectionState==="queued"||projectionState==="running"?{code:"mirror_catching_up",level:"info",message:"Your changes are safely saved; Seafile is catching up",at:new Date().toISOString()}:{code:"mirror_diverged",level:"warning",message:projectionState==="retrying"?"Seafile could not finish updating yet; Gib Sync is retrying safely":"Seafile needs verification before it can be reported current",at:new Date().toISOString()});
    for(const item of devices)if(!item.revokedAt&&Math.abs(item.clockSkewMs)>safeguards.policy(device.vault_id).clockSkewMinutes*60_000)healthAlerts.unshift({code:`clock_skew:${item.id}`,level:"warning",message:`${item.name}'s clock differs from the server by ${Math.round(Math.abs(item.clockSkewMs)/60_000)} minutes`,at:item.lastSeenAt});
    for(const item of devices)if(!item.revokedAt&&Date.now()-Date.parse(item.lastSeenAt)>30*24*60*60*1000)healthAlerts.push({code:`stale_device:${item.id}`,level:"info",message:`${item.name} has not synced in over 30 days`,at:item.lastSeenAt});
    const control=containment.state();
    return { protocolVersion:PROTOCOL_VERSION,serverVersion:SERVER_VERSION,serverCapabilities:[...SERVER_CAPABILITIES],vaultId:device.vault_id,vaultName:vault.name,deviceId:device.id,deviceName:device.name,
      deviceCount:store.one<{count:number}>("SELECT COUNT(*) count FROM devices WHERE vault_id=? AND revoked_at IS NULL",device.vault_id)?.count ?? 0,
      snapshotCount:aggregate.snapshot_count,blobCount:aggregate.blob_count,blobBytes:aggregate.blob_bytes,head:vault.head_id?getSnapshotView(store,vault.head_id):null,
      storage:storage.location(storageRow(device.vault_id)),serverTime:new Date().toISOString(),mirrorHeadId:vault.mirror_head_id,
      mirrorFileCount:store.one<{count:number}>("SELECT COUNT(*) count FROM mirror_entries WHERE vault_id=?",device.vault_id)?.count??0,
      mirrorCurrent,projection:{state:projectionState,attempts:pending?.attempts??0,lastError:pending?.last_error??null},externalScanAt:vault.external_scan_at,externalImportAt:vault.external_import_at,externalError:vault.external_error,
      containment:{active:control.active,thisVaultAllowed:!control.active||control.allowedVaultId===device.vault_id,enabledAt:control.enabledAt,reason:control.reason},safeguards:safeguards.state(device.vault_id,device.id),healthAlerts,devices,compatibility };
  });

  app.get("/v1/compatibility",async(request)=>{await authenticate(request,{allowIncompatible:true,allowContainment:true});return compatibilityFor(request);});

  app.post("/v1/external/scan",async(request)=>{
    const device=await authenticate(request);return ingestExternalChanges(device.vault_id,true);
  });

  const entrySchema=z.object({path:z.string().min(1).max(4000).refine((value)=>{try{return safeRelativePath(value)===value;}catch{return false;}},"Invalid vault-relative file path"),hash:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().nonnegative(),mtime:z.number().finite().nonnegative(),fileId:z.string().uuid().optional(),revision:z.object({id:z.string().uuid(),parentId:z.string().uuid().nullable(),deviceId:z.string().min(1).max(255),deviceName:z.string().min(1).max(100),modifiedAt:z.number().finite().nonnegative()}).optional()});
  const folderSchema=z.string().min(1).max(4000).refine((value)=>{try{return safeRelativePath(value)===value;}catch{return false;}},"Invalid vault-relative folder path");
  const folderEntrySchema=z.object({folderId:z.string().uuid(),path:folderSchema,revision:z.object({id:z.string().uuid(),parentId:z.string().uuid().nullable(),deviceId:z.string().min(1).max(255),deviceName:z.string().min(1).max(100),modifiedAt:z.number().finite().nonnegative()})});
  const policySchema=z.object({mode:z.enum(["strict","balanced","custom"]),deletionCount:z.number().int().min(1).max(100000),smallVaultDeletionCount:z.number().int().min(1).max(100000),
    smallVaultDeletionPercent:z.number().min(1).max(100),changedCount:z.number().int().min(1).max(200000),changedPercent:z.number().min(1).max(100),
    folderImpactCount:z.number().int().min(1).max(200000),fileGrowthBytes:z.number().int().min(1024).max(Number.MAX_SAFE_INTEGER),
    fileGrowthPercent:z.number().min(100).max(100000),clockSkewMinutes:z.number().min(1).max(1440),protectedPaths:z.array(z.string().min(1).max(4000)).max(1000)});

  async function acceptSnapshot(vaultId:string,parentId:string|null,deviceId:string,deviceName:string,message:string,entries:ManifestEntry[],folders?:string[],folderRepair?:Snapshot["folderRepair"],operationBatch?:OperationBatch,onAccepted?:(snapshot:Snapshot)=>void,folderEntries?:FolderEntry[],maintenancePermit?:symbol):Promise<Snapshot|null>{
    assertWritable(vaultId,maintenancePermit);
    const parent=parentId?store.getSnapshot(parentId):null,inheritedRepair=parent?.folderRepair,sourceRepair=folderRepair??inheritedRepair;
    const effectiveRepair=sourceRepair?{...sourceRepair,issuedAt:sourceRepair.issuedAt??(folderRepair?new Date().toISOString():parent?.createdAt??new Date().toISOString())}:undefined;
    const snapshot=await snapshotCommitter.accept({vaultId,parentId,deviceId,deviceName,message,entries,folders,folderEntries,folderRepair:effectiveRepair,operationBatch,maintenancePermit,afterInsert:accepted=>{store.run("UPDATE quarantines SET status='stale',resolved_at=? WHERE vault_id=? AND status='pending' AND parent_id IS ?",accepted.createdAt,vaultId,parentId);onAccepted?.(accepted);}});if(!snapshot)return null;
    safeguards.clearResolvedQuarantineAlerts(vaultId);mirrorWriteSettles.delete(vaultId);notifyVault(vaultId,snapshot.id);scheduleMirror(vaultId);return snapshot;
  }

  await registerOperationRoutes(app,{store,committer:snapshotCommitter,safeguards,deploymentDigest:config.GIBSYNC_RELEASE_DIGEST,canaryConfig:config,authenticate,beforeCommit:async(vaultId)=>{assertWritable(vaultId);await ingestExternalChanges(vaultId);assertWritable(vaultId);},accepted:(vaultId,snapshotId)=>{safeguards.clearResolvedQuarantineAlerts(vaultId);mirrorWriteSettles.delete(vaultId);notifyVault(vaultId,snapshotId);scheduleMirror(vaultId);}});
  await registerConflictInbox(app,{store,authenticate});
  await registerConfigRoots(app,{store,committer:snapshotCommitter,blobs:verifiedBlobs,storageRow,authenticate,beforeCommit:ingestExternalChanges,accepted:(vaultId,snapshotId)=>{mirrorWriteSettles.delete(vaultId);notifyVault(vaultId,snapshotId);scheduleMirror(vaultId);}});

  app.get("/v1/safeguards",async(request)=>{const device=await authenticate(request);return safeguards.state(device.vault_id,device.id);});
  app.put("/v1/safeguards/policy",async(request)=>{
    const device=await authenticate(request),body=policySchema.parse(request.body) as SafeguardPolicy;
    const policy=policyFor(body.mode,body);store.run("UPDATE vaults SET safeguard_policy=? WHERE id=?",JSON.stringify(policy),device.vault_id);return safeguards.state(device.vault_id,device.id);
  });
  app.post("/v1/safeguards/lock",async(request)=>{
    const device=await authenticate(request),locked=z.object({locked:z.boolean()}).parse(request.body).locked,now=new Date().toISOString();
    if(!locked&&integrityBlockedVaults.has(device.vault_id))throw Object.assign(new Error("The server integrity lock cannot be cleared until the accepted snapshot is repaired and the server is restarted."),{statusCode:423});
    store.run("UPDATE vaults SET write_locked_at=?,write_locked_by=? WHERE id=?",locked?now:null,locked?device.name:null,device.vault_id);
    safeguards.event(device.vault_id,locked?"write_lock_enabled":"write_lock_disabled","info",locked?`Remote writes frozen by ${device.name}`:`Remote writes resumed by ${device.name}`);
    return safeguards.state(device.vault_id,device.id);
  });

  app.get("/v1/head",async(request)=>{
    const device=await authenticate(request);
    return {headId:store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)?.head_id??null};
  });
  app.post("/v1/safeguards/maintenance",async(request)=>{
    const device=await authenticate(request),minutes=z.object({minutes:z.number().int().min(0).max(60)}).parse(request.body).minutes;
    const until=minutes?new Date(Date.now()+minutes*60_000).toISOString():null;
    if(minutes)store.run("UPDATE vaults SET trusted_until=?,trusted_device_id=? WHERE id=?",until,device.id,device.vault_id);
    else store.run("UPDATE vaults SET trusted_until=NULL,trusted_device_id=NULL WHERE id=? AND trusted_device_id=?",device.vault_id,device.id);
    safeguards.event(device.vault_id,minutes?"maintenance_started":"maintenance_ended","info",minutes?`${device.name} started a ${minutes}-minute maintenance session`:`${device.name} ended its maintenance session`);
    return safeguards.state(device.vault_id,device.id);
  });
  app.get("/v1/quarantines",async(request)=>{const device=await authenticate(request);return safeguards.list(device.vault_id);});
  app.post("/v1/quarantines/:id/reject",async(request,reply)=>{
    const device=await authenticate(request),id=z.object({id:z.string().uuid()}).parse(request.params).id;
    const row=store.one<{source:string;status:string;created_at:string;changes_json:string}>("SELECT source,status,created_at,changes_json FROM quarantines WHERE id=? AND vault_id=?",id,device.vault_id);if(!row)return reply.notFound();if(row.status!=="pending")return reply.conflict("Quarantine is no longer pending");
    const resolvedAt=new Date().toISOString();store.run("UPDATE quarantines SET status='rejected',resolved_at=?,resolved_by=?,resolution_kind='manual_reject',resolution_context_json=? WHERE id=?",resolvedAt,device.id,JSON.stringify({resolvedAt,resolvedByDeviceId:device.id,resolvedByDeviceName:device.name}),id);
    safeguards.clearResolvedQuarantineAlerts(device.vault_id);
    if(row.source==="seafile"){
      // Rejection consumes only the proposal's known observations, retaining
      // encrypted history and any later, as-yet-unreviewed external edits.
      const changes=JSON.parse(row.changes_json) as Array<{path:string;previousPath?:string}>;for(const path of new Set(changes.flatMap(change=>[change.path,...change.previousPath?[change.previousPath]:[]])))store.run("UPDATE external_revisions SET imported_at=? WHERE vault_id=? AND path=? AND imported_at IS NULL AND observed_at<=?",resolvedAt,device.vault_id,path,row.created_at);
      store.run("UPDATE external_folder_revisions SET imported_at=? WHERE vault_id=? AND imported_at IS NULL AND causal_order<=?",resolvedAt,device.vault_id,`${row.created_at}:999999`);
      store.run("UPDATE vaults SET mirror_head_id=NULL,mirror_generation_id=NULL WHERE id=?",device.vault_id);skipExternalOnce.add(device.vault_id);restoreApprovedVaults.add(device.vault_id);scheduleMirror(device.vault_id,50);
    }
    safeguards.event(device.vault_id,"quarantine_rejected","info",`Suspicious changes were rejected by ${device.name}`);return {ok:true};
  });
  app.post("/v1/quarantines/:id/approve",async(request,reply)=>{
    const device=await authenticate(request),id=z.object({id:z.string().uuid()}).parse(request.params).id,body=z.object({trustMinutes:z.number().int().min(0).max(60).default(0)}).parse(request.body);
    const row=store.one<{source:string;status:string;parent_id:string|null;device_id:string;device_name:string;message:string;manifest_json:string;assessment_json:string;expires_at:string}>("SELECT source,status,parent_id,device_id,device_name,message,manifest_json,assessment_json,expires_at FROM quarantines WHERE id=? AND vault_id=?",id,device.vault_id);
    if(!row)return reply.notFound();if(row.status!=="pending")return reply.conflict("Quarantine is no longer pending");if(Date.parse(row.expires_at)<Date.now()){store.run("UPDATE quarantines SET status='stale' WHERE id=?",id);return reply.gone("Quarantine expired");}
    const heldAssessment=JSON.parse(row.assessment_json) as {deleted?:number;reasons?:string[]},hardRisk=(heldAssessment.reasons??[]).some((reason)=>/out-of-date device|completely empty|Protected path|grew unexpectedly|mostly emptied|high-entropy/i.test(reason));
    if(body.trustMinutes&&(row.source==="seafile"||(heldAssessment.deleted??0)>0||hardRisk))return reply.badRequest("Destructive and external changes can only receive one-time approval");
    const heldManifest=JSON.parse(row.manifest_json) as unknown,parsedManifest=Array.isArray(heldManifest)?{entries:z.array(entrySchema).max(200000).parse(heldManifest) as ManifestEntry[],folders:[]}:z.object({entries:z.array(entrySchema).max(200000),folders:z.array(folderSchema).max(200000).default([])}).parse(heldManifest);
    const entries=parsedManifest.entries,folders=parsedManifest.folders;
    const approvalKind=body.trustMinutes?"manual_with_trust":"manual_once",resolvedAt=new Date().toISOString(),approvalLabel=body.trustMinutes?`manual approval + ${body.trustMinutes}-minute trust by ${device.name}`:`manual one-time approval by ${device.name}`;
    const pendingBatch=store.one<{batch_json:string}>("SELECT batch_json FROM sync_pending_batches WHERE vault_id=? AND quarantine_id=?",device.vault_id,id),pendingConflicts=store.one<{records_json:string}>("SELECT records_json FROM conflict_proposals WHERE vault_id=? AND quarantine_id=?",device.vault_id,id),pendingFolders=store.one<{folder_entries_json:string}>("SELECT folder_entries_json FROM sync_pending_folders WHERE vault_id=? AND quarantine_id=?",device.vault_id,id);
    const snapshot=await acceptSnapshot(device.vault_id,row.parent_id,row.device_id,row.device_name,`${row.message} (${approvalLabel})`,entries,folders,undefined,pendingBatch?JSON.parse(pendingBatch.batch_json) as OperationBatch:undefined,accepted=>{if(pendingConflicts){const records=JSON.parse(pendingConflicts.records_json) as ConflictRecord[];new ConflictInbox(store).publishInTransaction({id:row.device_id,vault_id:device.vault_id,name:row.device_name},records.map(record=>({...record,originSnapshotId:accepted.id})));store.run("DELETE FROM conflict_proposals WHERE quarantine_id=?",id);}store.run("DELETE FROM sync_pending_folders WHERE quarantine_id=?",id);},pendingFolders?z.array(folderEntrySchema).parse(JSON.parse(pendingFolders.folder_entries_json)):undefined);if(!snapshot){store.run("UPDATE quarantines SET status='stale' WHERE id=?",id);return reply.conflict("Vault changed after this proposal; review a new proposal");}
    if(body.trustMinutes)store.run("UPDATE vaults SET trusted_until=?,trusted_device_id=? WHERE id=?",new Date(Date.now()+body.trustMinutes*60_000).toISOString(),row.device_id,device.vault_id);
    store.run("UPDATE quarantines SET status='approved',resolved_at=?,resolved_by=?,resolution_kind=?,resolution_context_json=? WHERE id=?",resolvedAt,device.id,approvalKind,JSON.stringify({approvedAt:resolvedAt,approvedByDeviceId:device.id,approvedByDeviceName:device.name,trustMinutes:body.trustMinutes,source:row.source,assessment:heldAssessment}),id);
    safeguards.clearResolvedQuarantineAlerts(device.vault_id);
    safeguards.event(device.vault_id,"quarantine_approved","info",`Suspicious changes received ${approvalLabel}`);return reply.code(201).send(snapshot);
  });
  app.post("/v1/devices/current/ready",async(request,reply)=>{
    const device=await authenticate(request),headId=z.object({headId:z.string().uuid().nullable().optional()}).parse(request.body).headId;
    const current=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)!.head_id;
    if(headId!==undefined&&current!==headId)return reply.conflict("Vault changed before this device finished verifying its first download");
    store.run("UPDATE devices SET initial_sync_complete=1,initial_sync_head_id=?,acknowledged_at=? WHERE id=?",headId??current,new Date().toISOString(),device.id);return {ok:true};
  });
  app.post("/v1/devices/:id/revoke",async(request,reply)=>{
    const device=await authenticate(request),id=z.object({id:z.string().uuid()}).parse(request.params).id;
    const target=store.one<{id:string;name:string}>("SELECT id,name FROM devices WHERE id=? AND vault_id=? AND revoked_at IS NULL",id,device.vault_id);if(!target)return reply.notFound();
    store.run("UPDATE devices SET revoked_at=? WHERE id=?",new Date().toISOString(),id);safeguards.event(device.vault_id,"device_revoked","warning",`${target.name} was revoked by ${device.name}`);return {ok:true};
  });
  app.post("/v1/mirror/plan",async(request,reply)=>{
    const device=await authenticate(request);const body=z.object({snapshotId:z.string().uuid(),entries:z.array(entrySchema).max(200000)}).parse(request.body) as MirrorPlanRequest;
    await ingestExternalChanges(device.vault_id);
    const vault=store.one<{head_id:string|null;mirror_head_id:string|null;mirror_generation_id:string|null}>("SELECT head_id,mirror_head_id,mirror_generation_id FROM vaults WHERE id=?",device.vault_id)!;
    if(vault.head_id!==body.snapshotId)return reply.conflict("Mirror snapshot is no longer the vault head");
    const snapshot=store.getSnapshot(body.snapshotId),requested=canonicalManifest(body.entries).entries,accepted=snapshot?canonicalManifest(snapshot.entries).entries:[];
    if(!snapshot||JSON.stringify(requested.map(({path,hash,size})=>({path,hash,size})))!==JSON.stringify(accepted.map(({path,hash,size})=>({path,hash,size}))))return reply.code(422).send({error:"Mirror plan does not exactly match the accepted snapshot"});
    // Every supported client can let the durable, single-owner server project
    // its already verified encrypted blobs. No mobile clear-body roundtrip.
    scheduleMirror(device.vault_id,0);
    return {uploadPaths:[],deletePaths:[],serverManaged:true,alreadyCurrent:vault.mirror_head_id===body.snapshotId&&vault.mirror_generation_id===body.snapshotId};
  });

  app.put("/v1/mirror/file",{bodyLimit:config.MAX_BLOB_BYTES},async(request,reply)=>{
    const device=await authenticate(request);const path=z.string().min(1).max(4000).parse((request.query as Record<string,unknown>).path);
    const snapshotId=z.string().uuid().parse(request.headers["x-gib-sync-snapshot"]);const expectedHash=z.string().regex(/^[a-f0-9]{64}$/).parse(request.headers["x-gib-sync-hash"]);
    const vault=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)!;if(vault.head_id!==snapshotId)return reply.conflict("Mirror snapshot is no longer the vault head");
    const snapshot=store.getSnapshot(snapshotId);const entry=snapshot?.entries.find((item)=>item.path===path&&item.hash===expectedHash);if(!entry)return reply.badRequest("File is not part of this snapshot");
    const body=request.body,valid=isStagedBinary(body)?body.file.size===entry.size&&body.file.hash===expectedHash:Buffer.isBuffer(body)&&body.length===entry.size&&sha256(body)===expectedHash;if(!valid)return reply.badRequest("Readable file integrity check failed");
    // Protocol-7 clients retain this endpoint, but no longer own an independent
    // projection writer. The immutable accepted blob is the verified authority.
    scheduleMirror(device.vault_id,0);await reconcileReadableMirror(device.vault_id);
    if(store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)?.head_id!==snapshotId)return reply.conflict("Vault changed while the server was projecting the accepted generation");
    return reply.code(204).send();
  });

  app.post("/v1/mirror/complete",async(request,reply)=>{
    const device=await authenticate(request);const snapshotId=z.object({snapshotId:z.string().uuid()}).parse(request.body).snapshotId;
    const vault=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)!;if(vault.head_id!==snapshotId)return reply.conflict("Mirror snapshot is no longer the vault head");
    const snapshot=store.getSnapshot(snapshotId);if(!snapshot)return reply.notFound();
    scheduleMirror(device.vault_id,0);await reconcileReadableMirror(device.vault_id);
    const completed=store.one<{head_id:string|null;mirror_head_id:string|null;mirror_generation_id:string|null}>("SELECT head_id,mirror_head_id,mirror_generation_id FROM vaults WHERE id=?",device.vault_id)!;
    if(completed.head_id!==snapshotId)return reply.conflict("Vault changed before readable mirror completion; the newer generation will resume automatically");
    if(completed.mirror_head_id!==snapshotId||completed.mirror_generation_id!==snapshotId)return reply.code(422).send({error:"Readable mirror remains queued for safe verification"});
    return {mirroredFiles:snapshot.entries.length,deletedFiles:0,snapshotId};
  });

  app.get("/v1/snapshots/:id", async (request, reply) => {
    const device = await authenticate(request); const id = z.object({id:z.string().uuid()}).parse(request.params).id;
    const snapshot = getSnapshotView(store,id);
    if (!snapshot || snapshot.vaultId !== device.vault_id) return reply.notFound();
    return snapshot;
  });

  app.get("/v1/history", async (request) => {
    const device = await authenticate(request);
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse((request.query as Record<string,unknown>).limit);
    return store.all<{manifest_json:string}>("SELECT manifest_json FROM snapshots WHERE vault_id=? ORDER BY created_at DESC LIMIT ?", device.vault_id, limit)
      .map(({manifest_json}) => { const s = JSON.parse(manifest_json) as Snapshot; return { id:s.id,parentId:s.parentId,deviceName:s.deviceName,createdAt:s.createdAt,message:s.message,fileCount:s.entries.length,
        bookmarked:Boolean(store.one("SELECT 1 FROM snapshot_bookmarks WHERE vault_id=? AND snapshot_id=?",device.vault_id,s.id)) }; });
  });
  app.put("/v1/bookmarks/:id",async(request,reply)=>{
    const device=await authenticate(request),id=z.object({id:z.string().uuid()}).parse(request.params).id,label=z.object({label:z.string().min(1).max(100).default("Known good")}).parse(request.body).label;
    const snapshot=store.getSnapshot(id);if(!snapshot||snapshot.vaultId!==device.vault_id)return reply.notFound();
    store.run("INSERT INTO snapshot_bookmarks(vault_id,snapshot_id,label,created_at,created_by) VALUES(?,?,?,?,?) ON CONFLICT(vault_id,snapshot_id) DO UPDATE SET label=excluded.label",device.vault_id,id,label,new Date().toISOString(),device.id);
    return {ok:true,label};
  });
  app.delete("/v1/bookmarks/:id",async(request,reply)=>{
    const device=await authenticate(request),id=z.object({id:z.string().uuid()}).parse(request.params).id;const result=store.run("DELETE FROM snapshot_bookmarks WHERE vault_id=? AND snapshot_id=?",device.vault_id,id);if(!result.changes)return reply.notFound();return {ok:true};
  });

  function sendFile(reply:import("fastify").FastifyReply,file:StagedFile){const stream=createReadStream(file.path,{highWaterMark:64*1024});reply.raw.once("close",()=>stream.destroy());stream.once("close",()=>{void file.dispose();});return reply.header("Content-Length",String(file.size)).type("application/octet-stream").send(stream);}

  app.get("/v1/content/:hash",async(request,reply)=>{
    const device=await authenticate(request),hash=z.object({hash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.params).hash;
    if(!store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?",device.vault_id,hash))return reply.notFound();
    const clear=await verifiedBlobs.clear(storageRow(device.vault_id),hash,requestSignal(request,reply));
    return sendFile(reply.header("Cache-Control","no-store").header("X-Content-SHA256",hash),clear);
  });

  app.get("/v1/blobs/:hash", async (request, reply) => {
    const device = await authenticate(request); const hash = z.object({hash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.params).hash;
    const bytes=await verifiedBlobs.encrypted(storageRow(device.vault_id),hash,requestSignal(request,reply));if(!bytes)return reply.notFound();
    return sendFile(reply,bytes);
  });

  app.put("/v1/blobs/:hash", {bodyLimit:config.MAX_BLOB_BYTES+29},async (request, reply) => {
    const device = await authenticate(request); const hash = z.object({hash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.params).hash;
    const signal=requestSignal(request,reply);signal.throwIfAborted();
    if (store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?", device.vault_id, hash)){
      try{const existing=await verifiedBlobs.encrypted(storageRow(device.vault_id),hash,signal);if(existing){await existing.dispose();return reply.code(204).send();}}catch(error){signal.throwIfAborted();if(!recoverableBlobFailure(error))throw error;app.log.warn({vaultId:device.vault_id,hash},"Replacing a registered blob that failed storage integrity verification");}
    }
    const body=request.body,bytes=Buffer.isBuffer(body)?body:null;
    if(!isStagedBinary(body)&&!bytes?.length)return reply.badRequest("Empty blob");
    const vault=store.one<{wrapped_key:string}>("SELECT wrapped_key FROM vaults WHERE id=?",device.vault_id)!;
    const key=openJson<string>(vault.wrapped_key,config.GIBSYNC_SERVER_SECRET,device.vault_id);
    let clearSize:number;
    if(isStagedBinary(body)){
      try{const clear=await decryptBlobFile(body.file.path,key,hash,verifiedBlobs.staging,config.MAX_BLOB_BYTES,signal);clearSize=clear.size;await clear.dispose();}catch(error){signal.throwIfAborted();if(!recoverableBlobFailure(error))throw error;return reply.code(422).send({error:"Encrypted blob authentication or content hash is invalid"});}
      await storage.putFile(storageRow(device.vault_id),`blobs/${hash.slice(0,2)}/${hash}.gbs`,body.file.path,signal);
    }else{try{clearSize=decryptVaultBlob(bytes!,key,hash).byteLength;}catch{return reply.code(422).send({error:"Encrypted blob authentication or content hash is invalid"});}await storage.put(storageRow(device.vault_id),`blobs/${hash.slice(0,2)}/${hash}.gbs`,bytes!,"application/octet-stream",signal);}
    signal.throwIfAborted();store.run("INSERT OR IGNORE INTO blobs(vault_id,hash,size,created_at) VALUES(?,?,?,?)",device.vault_id,hash,isStagedBinary(body)?body.file.size:bytes!.length,new Date().toISOString());
    verifiedBlobs.recordVerified(device.vault_id,hash,clearSize,isStagedBinary(body)?body.file.size:bytes!.length);
    return reply.code(201).send();
  });

  app.post("/v1/commit", async (request, reply) => {
    const device = await authenticate(request);
    if(integrityBlockedVaults.has(device.vault_id))return reply.code(423).send({error:"Sync is blocked because the accepted snapshot failed server integrity checks"});
    assertWritable(device.vault_id);
    await ingestExternalChanges(device.vault_id);
    assertWritable(device.vault_id);
    const body = z.object({ parentId: z.string().uuid().nullable(), message: z.string().max(500).default("Sync"), entries: z.array(entrySchema).max(200000),folders:z.array(folderSchema).max(200000).default([]),folderEntries:z.array(folderEntrySchema).max(200000).optional(),
      clientTime:z.string().datetime().optional(),signals:z.object({highEntropyPaths:z.array(z.string()).max(1000).optional(),deviceLocalCleanupPaths:z.array(z.string().max(1000)).max(5000).optional(),vaultIdentity:z.string().max(500).optional(),staleBaseline:z.boolean().optional()}).optional() }).parse(request.body) as CommitRequest;
    if(body.clientTime){const skew=Date.parse(body.clientTime)-Date.now();store.run("UPDATE devices SET clock_skew_ms=? WHERE id=?",Number.isFinite(skew)?Math.round(skew):0,device.id);}
    let manifest;try{manifest=canonicalManifest(body.entries,body.folders);}catch(error){return reply.code(422).send({error:error instanceof Error?error.message:String(error)});}
    body.entries=manifest.entries;body.folders=manifest.folders??[];
    const missing = body.entries.filter((entry) => !store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?", device.vault_id, entry.hash));
    if (missing.length) return reply.code(422).send({ error: "Missing blobs", hashes: missing.slice(0,100).map((e) => e.hash) });
    const current = store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?", device.vault_id)!.head_id;
    if(current!==body.parentId)return reply.code(409).send({error:"Head moved",head:current?getSnapshotView(store,current):null});
    // Historical blobs.size has mixed clear/cipher meanings. A verified clear
    // proof or immutable accepted entry is required; ambiguous legacy objects
    // are authenticated once on disk before they can introduce new metadata.
    const acceptedSizes=new Map((current?store.getSnapshot(current)?.entries??[]:[]).map(entry=>[entry.hash,entry.size])),verifiedSizes=new Map<string,number>(),signal=requestSignal(request,reply);
    for(const entry of body.entries){signal.throwIfAborted();let size=verifiedSizes.get(entry.hash)??store.one<{clear_size:number}>("SELECT clear_size FROM blob_integrity WHERE vault_id=? AND hash=?",device.vault_id,entry.hash)?.clear_size??acceptedSizes.get(entry.hash);
      if(size===undefined){const file=await verifiedBlobs.clear(storageRow(device.vault_id),entry.hash,signal);try{size=file.size;}finally{await file.dispose();}}
      if(size!==entry.size)return reply.code(422).send({error:"Manifest byte size does not match its verified content",hash:entry.hash});verifiedSizes.set(entry.hash,size);
    }
    const ready=store.one<{initial_sync_complete:number}>("SELECT initial_sync_complete FROM devices WHERE id=?",device.id)?.initial_sync_complete;
    if(current&&!ready)return reply.code(428).send({error:"This newly paired device must complete its first download before it can upload changes"});
    const aliases=store.all<{config_root:string}>("SELECT config_root FROM vault_config_aliases WHERE vault_id=?",device.vault_id).map(row=>row.config_root),aliasConflicts=aliasCollisionRecords(body.entries,aliases,device.name);
    body.entries=normalizeAliasEntries(body.entries,aliases);body.folders=normalizeAliasFolders(body.folders??[],aliases);
    const decision=safeguards.propose({vaultId:device.vault_id,deviceId:device.id,deviceName:device.name,parentId:body.parentId,message:body.message,entries:body.entries,folders:body.folders,folderEntries:body.folderEntries,source:"device",signals:body.signals});
    if(!decision.allowed){
      if(decision.quarantine&&decision.created)safeguards.event(device.vault_id,"mass_change_quarantine","warning",`${device.name}'s changes were quarantined: ${decision.assessment.reasons.join("; ")}`);
      if(decision.quarantine&&aliasConflicts.length)store.run("INSERT INTO conflict_proposals(quarantine_id,vault_id,records_json) VALUES(?,?,?) ON CONFLICT(quarantine_id) DO NOTHING",decision.quarantine.id,device.vault_id,JSON.stringify(aliasConflicts));
      if(decision.quarantine&&body.folderEntries)store.run("INSERT INTO sync_pending_folders VALUES(?,?,?) ON CONFLICT(quarantine_id) DO NOTHING",decision.quarantine.id,device.vault_id,JSON.stringify(body.folderEntries));
      return reply.code(423).send({error:decision.locked?"Remote writes are frozen for this vault":"Suspicious vault changes require approval",locked:decision.locked,quarantine:decision.quarantine,assessment:decision.assessment});
    }
    const message=decision.authorization==="trusted_window"?`${body.message} (device maintenance approval: ${device.name})`:body.message;
    const snapshot=await acceptSnapshot(device.vault_id,body.parentId,device.id,device.name,message,body.entries,body.folders??[],undefined,undefined,accepted=>{if(aliasConflicts.length)new ConflictInbox(store).publishInTransaction(device,aliasConflicts.map(record=>({...record,originSnapshotId:accepted.id})));},body.folderEntries);
    if(!snapshot)return reply.code(409).send({error:"Head moved",head:store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)?.head_id});
    return reply.code(201).send(snapshot);
  });

  app.get("/v1/restore/:id/preview",async(request,reply)=>{
    const device=await authenticate(request),id=z.object({id:z.string().uuid()}).parse(request.params).id,source=store.getSnapshot(id);if(!source||source.vaultId!==device.vault_id)return reply.notFound();
    const headId=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)!.head_id,current=headId?store.getSnapshot(headId)?.entries??[]:[];
    const assessment=assessChanges(current,source.entries,safeguards.policy(device.vault_id)).assessment,expiresAt=new Date(Date.now()+5*60_000).toISOString();
    const confirmToken=sealJson({vaultId:device.vault_id,deviceId:device.id,snapshotId:id,headId,expiresAt},config.GIBSYNC_SERVER_SECRET,`restore:${device.vault_id}:${id}`);
    const preview:RestorePreview={snapshotId:id,snapshotCreatedAt:source.createdAt,snapshotDeviceName:source.deviceName,assessment,confirmToken,expiresAt};return preview;
  });
  app.post("/v1/restore/:id", async (request, reply) => {
    const device = await authenticate(request);await ingestExternalChanges(device.vault_id); const id = z.object({id:z.string().uuid()}).parse(request.params).id;
    const source = store.getSnapshot(id); if (!source || source.vaultId !== device.vault_id) return reply.notFound();
    const token=z.object({confirmToken:z.string().min(1)}).parse(request.body).confirmToken;let intent:{vaultId:string;deviceId:string;snapshotId:string;headId:string|null;expiresAt:string};
    try{intent=openJson(token,config.GIBSYNC_SERVER_SECRET,`restore:${device.vault_id}:${id}`);}catch{return reply.badRequest("Restore confirmation is invalid or expired");}
    const vault=store.one<{head_id:string|null;write_locked_at:string|null}>("SELECT head_id,write_locked_at FROM vaults WHERE id=?",device.vault_id)!;
    if(intent.vaultId!==device.vault_id||intent.deviceId!==device.id||intent.snapshotId!==id||intent.headId!==vault.head_id||Date.parse(intent.expiresAt)<Date.now())return reply.conflict("Vault changed after the restore preview; preview it again");
    if(vault.write_locked_at)return reply.code(423).send({error:"Remote writes are frozen for this vault"});
    const currentSnapshot=vault.head_id?store.getSnapshot(vault.head_id):null;
    // Restoring a protocol-6 snapshot is a file restore, not permission to
    // erase a newer authoritative empty-folder baseline.
    const restored=await acceptSnapshot(device.vault_id,vault.head_id,device.id,device.name,`Restore ${id}`,source.entries,source.folders??currentSnapshot?.folders??[]);if(!restored)return reply.conflict("Vault changed during restore");
    return reply.code(201).send(restored);
  });

  const selectiveChanges=(current:ManifestEntry[],source:Snapshot):SelectiveRestoreChange[]=>assessChanges(current,source.entries,safeguards.policy(source.vaultId)).changes.map((change)=>({
    ...change,id:sha256(Buffer.from(JSON.stringify(change))).slice(0,24)
  }));
  const selectedRestoreEntries=(current:ManifestEntry[],source:Snapshot,changeIds:string[]):ManifestEntry[]=>{
    const changes=selectiveChanges(current,source),byId=new Map(changes.map((change)=>[change.id,change])),sourceEntries=new Map(source.entries.map((entry)=>[entry.path,entry])),desired=new Map(current.map((entry)=>[entry.path,entry]));
    for(const id of changeIds){const change=byId.get(id);if(!change)throw app.httpErrors.badRequest("Selected restore paths no longer match this snapshot");if(change.kind==="deleted")desired.delete(change.path);else if(change.kind==="moved"){if(change.previousPath)desired.delete(change.previousPath);const entry=sourceEntries.get(change.path);if(entry)desired.set(change.path,entry);}else{const entry=sourceEntries.get(change.path);if(entry)desired.set(change.path,entry);}}
    return [...desired.values()].sort((left,right)=>left.path.localeCompare(right.path));
  };
  const selectionHash=(changeIds:string[])=>sha256(Buffer.from([...changeIds].sort().join("\n")));
  const selectedBody=z.object({changeIds:z.array(z.string().regex(/^[a-f0-9]{24}$/)).min(1).max(5000)});

  app.get("/v1/restore/:id/changes",async(request,reply)=>{
    const device=await authenticate(request),id=z.object({id:z.string().uuid()}).parse(request.params).id,source=store.getSnapshot(id);if(!source||source.vaultId!==device.vault_id)return reply.notFound();
    const headId=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)!.head_id,current=headId?store.getSnapshot(headId)?.entries??[]:[];
    const plan:SelectiveRestorePlan={snapshotId:id,changes:selectiveChanges(current,source)};return plan;
  });
  app.post("/v1/restore/:id/paths/preview",async(request,reply)=>{
    const device=await authenticate(request),id=z.object({id:z.string().uuid()}).parse(request.params).id,source=store.getSnapshot(id);if(!source||source.vaultId!==device.vault_id)return reply.notFound();
    const {changeIds}=selectedBody.parse(request.body),unique=[...new Set(changeIds)],headId=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)!.head_id,current=headId?store.getSnapshot(headId)?.entries??[]:[];
    const desired=selectedRestoreEntries(current,source,unique),assessment=assessChanges(current,desired,safeguards.policy(device.vault_id)).assessment,expiresAt=new Date(Date.now()+5*60_000).toISOString();
    const confirmToken=sealJson({vaultId:device.vault_id,deviceId:device.id,snapshotId:id,headId,selectionHash:selectionHash(unique),expiresAt},config.GIBSYNC_SERVER_SECRET,`restore-paths:${device.vault_id}:${id}`);
    const preview:SelectiveRestorePreview={snapshotId:id,snapshotCreatedAt:source.createdAt,snapshotDeviceName:source.deviceName,assessment,confirmToken,expiresAt,selectedChanges:unique.length};return preview;
  });
  app.post("/v1/restore/:id/paths",async(request,reply)=>{
    const device=await authenticate(request);await ingestExternalChanges(device.vault_id);const id=z.object({id:z.string().uuid()}).parse(request.params).id,source=store.getSnapshot(id);if(!source||source.vaultId!==device.vault_id)return reply.notFound();
    const body=selectedBody.extend({confirmToken:z.string().min(1)}).parse(request.body),unique=[...new Set(body.changeIds)];let intent:{vaultId:string;deviceId:string;snapshotId:string;headId:string|null;selectionHash:string;expiresAt:string};
    try{intent=openJson(body.confirmToken,config.GIBSYNC_SERVER_SECRET,`restore-paths:${device.vault_id}:${id}`);}catch{return reply.badRequest("Selective restore confirmation is invalid or expired");}
    const vault=store.one<{head_id:string|null;write_locked_at:string|null}>("SELECT head_id,write_locked_at FROM vaults WHERE id=?",device.vault_id)!;
    if(intent.vaultId!==device.vault_id||intent.deviceId!==device.id||intent.snapshotId!==id||intent.headId!==vault.head_id||intent.selectionHash!==selectionHash(unique)||Date.parse(intent.expiresAt)<Date.now())return reply.conflict("Vault or selected files changed after the restore preview; preview them again");
    if(vault.write_locked_at)return reply.code(423).send({error:"Remote writes are frozen for this vault"});
    const currentSnapshot=vault.head_id?store.getSnapshot(vault.head_id):null,current=currentSnapshot?.entries??[],desired=selectedRestoreEntries(current,source,unique),restored=await acceptSnapshot(device.vault_id,vault.head_id,device.id,device.name,`Restore ${unique.length} selected change${unique.length===1?"":"s"} from ${id}`,desired,currentSnapshot?.folders);
    if(!restored)return reply.conflict("Vault changed during selective restore");return reply.code(201).send(restored);
  });

  app.addHook("onReady",async()=>{
    for(const vault of store.all<{id:string;head_id:string}>("SELECT id,head_id FROM vaults WHERE head_id IS NOT NULL AND retired_at IS NULL")){
      if(!canOperateVault(vault.id)||integrityBlockedVaults.has(vault.id))continue;const plan=planLegacyFolderDescendantRepair(store,vault.id,vault.head_id)??planRetiredLegacyFolderRepair(store,vault.id,vault.head_id)??planMissingLegacyFolderRetirementDirective(store,vault.id,vault.head_id);if(!plan)continue;
      const head=store.getSnapshot(vault.head_id);if(!head)continue;
      const repaired=await acceptSnapshot(vault.id,head.id,"server:folder-provenance-repair","Gib Sync server","Repair unsafe legacy folder provenance",head.entries,plan.desiredFolders,{retiredFolders:plan.contaminatedFolders,observedAt:plan.observedAt,originSnapshotIds:plan.originIds,...(plan.issuedAt?{issuedAt:plan.issuedAt}:{})});
      if(repaired){
        safeguards.event(vault.id,"legacy_folder_descendants_repaired","info",`Repaired ${plan.contaminatedFolders.length} inherited empty folder records while preserving file content and later device folder intent.`);
        store.run("UPDATE health_events SET cleared_at=? WHERE vault_id=? AND cleared_at IS NULL AND code='legacy_folder_migration_reverted'",new Date().toISOString(),vault.id);
      }
    }
    for(const {id} of store.all<{id:string}>("SELECT id FROM vaults WHERE head_id IS NOT NULL AND retired_at IS NULL"))if(!integrityBlockedVaults.has(id))scheduleMirror(id,50);
    const scanAll=()=>{for(const pending of durableJobs.pending())scheduleMirror(pending.vault_id,Math.max(0,pending.due_at-Date.now()),false);for(const {id} of store.all<{id:string}>("SELECT id FROM vaults WHERE storage_url IS NOT NULL AND retired_at IS NULL"))if(containment.allows(id))void ingestExternalChanges(id).catch((error)=>app.log.error({err:error,vaultId:id},"External Seafile scan failed"));};
    externalTimer=setInterval(scanAll,3000);externalTimer.unref();externalStartupTimer=setTimeout(scanAll,250);externalStartupTimer.unref();
  });

  return app;
}
