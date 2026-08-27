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
import { planLegacyFolderDescendantRepair,planMissingLegacyFolderRetirementDirective,planRetiredLegacyFolderRepair,repairUnsafeLegacyFolderHeads } from "./folder-migration.js";
import { canonicalManifest } from "./manifest.js";
import { auditHeadIntegrity } from "./integrity.js";
import { SnapshotCommitter } from "./snapshot-commit.js";

type AuthDevice = { id: string; vault_id: string; name: string };

function snapshotFolders(snapshot:Snapshot|null):Set<string>{
  const folders=new Set<string>(),add=(raw:string)=>{let safe:string;try{safe=safeRelativePath(raw);}catch{return;}const parts=safe.split("/");let current="";for(const part of parts){current=current?`${current}/${part}`:part;folders.add(current);}};
  for(const folder of snapshot?.folders??[])add(folder);
  for(const entry of snapshot?.entries??[]){const parent=entry.path.split("/").slice(0,-1).join("/");if(parent)add(parent);}
  return folders;
}
const folderManifestInitialized=(snapshot:Snapshot|null):boolean=>Array.isArray(snapshot?.folders);

export async function buildApp(config: Config, store = new Store(config.DATA_DIR), storage = new SeafileStorage(config)) {
  const unmigrated = store.all<{id:string}>("SELECT id FROM vaults WHERE storage_url IS NULL OR storage_token IS NULL");
  if (unmigrated.length) {
    const legacy = await storage.legacySelection();
    for (const vault of unmigrated) store.run(
      "UPDATE vaults SET storage_url=?,storage_username=?,storage_repo_id=?,storage_repo_name=?,storage_base_path=?,storage_token=?,storage_layout='legacy' WHERE id=?",
      legacy.url, legacy.username, legacy.libraryId, legacy.libraryName, "/", storage.sealToken(vault.id, legacy.token), vault.id
    );
  }
  const mirrorUnconfigured=store.all<{id:string;name:string;storage_layout:string;storage_base_path:string}>("SELECT id,name,storage_layout,storage_base_path FROM vaults WHERE mirror_base_path IS NULL");
  for(const vault of mirrorUnconfigured){
    const safeName=vault.name.replace(/[\\/:*?\"<>|\x00-\x1f]/g,"-").replace(/^\.+/,"").trim()||`Vault-${vault.id.slice(0,8)}`;
    const path=vault.storage_layout==="legacy"?`/Obsidian/${safeName}`:vault.storage_base_path;
    store.run("UPDATE vaults SET mirror_base_path=? WHERE id=?",path,vault.id);
  }
  repairUnsafeLegacyFolderHeads(store);
  const integrityBlockedVaults=new Set<string>();
  for(const vault of store.all<{id:string;head_id:string}>("SELECT id,head_id FROM vaults WHERE head_id IS NOT NULL")){
    const audit=auditHeadIntegrity(store,vault.id,vault.head_id);if(audit.valid)continue;integrityBlockedVaults.add(vault.id);const now=new Date().toISOString();
    store.run("UPDATE vaults SET write_locked_at=COALESCE(write_locked_at,?),write_locked_by=COALESCE(write_locked_by,'Server integrity audit') WHERE id=?",now,vault.id);
    if(!store.one("SELECT 1 FROM health_events WHERE vault_id=? AND code='head_integrity_blocked' AND cleared_at IS NULL",vault.id))store.run("INSERT INTO health_events(id,vault_id,code,level,message,created_at) VALUES(?,?,?,?,?,?)",randomUUID(),vault.id,"head_integrity_blocked","error",`Sync was stopped before mirror mutation because the accepted snapshot failed integrity checks: ${audit.issues.join("; ")}`,now);
  }
  const app = Fastify({ trustProxy:true,logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: config.MAX_BLOB_BYTES + 1024 });
  const safeguards=new SafeguardService(store),containment=new ContainmentService(store),externalImporter=new ExternalImporter(config,store,storage,safeguards,(vaultId)=>containment.allows(vaultId));let externalTimer:NodeJS.Timeout|null=null,externalStartupTimer:NodeJS.Timeout|null=null,closing=false;
  const skipExternalOnce=new Set<string>(),healthRepairLocks=new Set<string>(),mirrorWriteSettles=new Map<string,{snapshotId:string;until:number}>();
  const watchWaiters=new Map<string,Set<(headId:string|null,attention:boolean)=>void>>();
  function notifyVault(vaultId:string,headId:string|null,attention=false){
    const waiters=watchWaiters.get(vaultId);if(!waiters)return;
    watchWaiters.delete(vaultId);for(const resolve of waiters)resolve(headId,attention);
  }
  app.addHook("onClose", async () => {
    closing=true;
    for(const [vaultId] of watchWaiters)notifyVault(vaultId,null);
    if(externalTimer)clearInterval(externalTimer);if(externalStartupTimer)clearTimeout(externalStartupTimer);
    for(const {timer} of mirrorTimers.values())clearTimeout(timer);mirrorTimers.clear();await Promise.allSettled([...mirrorJobs.values()]);await externalImporter.settle();store.db.close();
  });
  await app.register(cors, { origin: true, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],exposedHeaders:["X-Content-SHA256"] });
  await app.register(multipart, { limits: { fileSize: config.MAX_BLOB_BYTES, files: 1 } });
  await app.register(sensible);
  app.setErrorHandler((error,_request,reply)=>{
    const typed=error as Error & {statusCode?:number;compatibility?:unknown;containment?:unknown},compatibility=typed.compatibility;
    if(typed.statusCode===426&&compatibility)return reply.code(426).send({error:typed.message,message:typed.message,compatibility});
    if(typed.statusCode===423&&typed.containment)return reply.code(423).send({error:typed.message,message:typed.message,containment:typed.containment});
    return reply.send(error);
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: config.MAX_BLOB_BYTES }, (_request, body, done) => done(null, body));

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
    const compatibility=compatibilityFor(request);
    store.run("UPDATE devices SET last_seen_at=?,client_version=?,client_protocol=? WHERE id=?", new Date().toISOString(),compatibility.clientVersion,compatibility.clientProtocol,device.id);
    if(config.GIBSYNC_MIN_CLIENT_VERSION!=="0.0.0"&&!options.allowIncompatible&&!compatibility.compatible)throw Object.assign(new Error(`${compatibility.reason} Update Gib Sync through BRAT before syncing.`),{statusCode:426,compatibility});
    const control=containment.state();
    if(control.active&&!options.allowContainment&&control.allowedVaultId!==device.vault_id)throw Object.assign(new Error("This server is in emergency containment. Sync is safely paused for this vault; no files are being changed."),{statusCode:423,containment:{active:true,thisVaultAllowed:false,enabledAt:control.enabledAt,reason:control.reason}});
    return device;
  }

  function storageRow(vaultId: string): VaultStorageRow {
    const row = store.one<VaultStorageRow>("SELECT id,storage_url,storage_username,storage_repo_id,storage_repo_name,storage_base_path,storage_token,storage_layout,mirror_base_path,mirror_head_id FROM vaults WHERE id=?", vaultId);
    if (!row?.storage_url || !row.storage_token) throw new Error("Vault storage is not configured");
    return row;
  }
  const snapshotCommitter=new SnapshotCommitter(store,storage,storageRow);

  async function reconcileReadableFolders(vaultId:string,snapshot:Snapshot):Promise<{created:number;deleted:number;remaining:string[]}>{
    const row=storageRow(vaultId),tree=await storage.listReadableTree(row),visible=new Set(tree.folders),desired=snapshotFolders(snapshot);let created=0,deleted=0;
    for(const path of [...desired].sort((left,right)=>left.split("/").length-right.split("/").length||left.localeCompare(right))){if(visible.has(path))continue;await storage.ensureReadableFolder(row,path);visible.add(path);created++;}
    if(folderManifestInitialized(snapshot))for(const path of [...visible].filter((folder)=>!desired.has(folder)).sort((left,right)=>right.split("/").length-left.split("/").length||right.localeCompare(left))){if(await storage.deleteReadableFolder(row,path)){visible.delete(path);deleted++;}}
    return {created,deleted,remaining:folderManifestInitialized(snapshot)?[...visible].filter((folder)=>!desired.has(folder)).sort():[]};
  }

  async function verifyReadableGeneration(vaultId:string,snapshot:Snapshot,removedPaths:string[]):Promise<{missing:string[];lingering:string[];missingFolders:string[];lingeringFolders:string[]}>{
    const tree=await storage.listReadableTree(storageRow(vaultId)),visible=new Map(tree.files.map((entry)=>[entry.path,entry])),visibleFolders=new Set(tree.folders),desiredFolders=snapshotFolders(snapshot);
    const missing=snapshot.entries.filter((entry)=>visible.get(entry.path)?.size!==entry.size).map((entry)=>entry.path),lingering=removedPaths.filter((path)=>visible.has(path));
    return {missing,lingering,missingFolders:[...desiredFolders].filter((path)=>!visibleFolders.has(path)),lingeringFolders:folderManifestInitialized(snapshot)?[...visibleFolders].filter((path)=>!desiredFolders.has(path)):[]};
  }

  const mirrorJobs=new Map<string,Promise<void>>(),externalScanRequests=new Set<string>(),interruptedExternalResults=new Map<string,ExternalImportResult>();const mirrorTimers=new Map<string,{timer:NodeJS.Timeout;due:number}>(),mirrorFailureCounts=new Map<string,number>(),mirrorRetryNotBefore=new Map<string,number>();
  async function ingestExternalChanges(vaultId:string,fresh=false):Promise<ExternalImportResult>{
    if(!containment.allows(vaultId))return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,contained:true};
    if(integrityBlockedVaults.has(vaultId))return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0,locked:true};
    if(healthRepairLocks.has(vaultId))return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0};
    const activeMirror=fresh?mirrorJobs.get(vaultId):undefined;
    if(activeMirror){
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
    else if(result.mirrorGenerationMismatch)scheduleMirror(vaultId,50);
    return result;
  }
  function reconcileReadableMirror(vaultId:string):Promise<void>{
    if(!containment.allows(vaultId)||integrityBlockedVaults.has(vaultId))return Promise.resolve();
    const active=mirrorJobs.get(vaultId);if(active)return active;
    const job=(async()=>{for(let attempt=0;attempt<3;attempt++){
      let external:ExternalImportResult|null=null;
      if(skipExternalOnce.has(vaultId))skipExternalOnce.delete(vaultId);else external=await ingestExternalChanges(vaultId);
      if(externalScanRequests.has(vaultId)){
        if(external&&(external.snapshotId!==null||Boolean(external.quarantineId)||Boolean(external.deferredDeletions)||external.changedFiles>0||external.deletedFiles>0||external.conflicts>0))interruptedExternalResults.set(vaultId,external);
        scheduleMirror(vaultId,50);
        return;
      }
      // A missing readable file is held for confirmation rather than being
      // recreated by the mirror. Likewise, quarantined external changes stay
      // untouched until the user accepts or rejects them.
      if(external?.deferredDeletions||external?.quarantineId||external?.locked)return;
      const vault=store.one<{head_id:string|null;mirror_head_id:string|null;mirror_generation_id:string|null;wrapped_key:string}>("SELECT head_id,mirror_head_id,mirror_generation_id,wrapped_key FROM vaults WHERE id=?",vaultId);if(!vault?.head_id)return;
      const snapshot=store.getSnapshot(vault.head_id);if(!snapshot)return;const row=storageRow(vaultId),generation=await readGeneration(config,storage,row);
      if(vault.mirror_head_id===vault.head_id&&vault.mirror_generation_id===vault.head_id&&validGeneration(generation,snapshot))return;
      const key=openJson<string>(vault.wrapped_key,config.GIBSYNC_SERVER_SECRET,vaultId),target=new Set(snapshot.entries.map((entry)=>entry.path));
      const visible=new Map((await storage.listReadable(row)).map((entry)=>[entry.path,entry]));
      const headStillCurrent=()=>store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",vaultId)?.head_id===snapshot.id,mayContinue=()=>headStillCurrent()&&!externalScanRequests.has(vaultId)&&containment.allows(vaultId);let superseded=false;
      for(const entry of snapshot.entries){if(!mayContinue()){superseded=true;break;}const current=store.one<{hash:string}>("SELECT hash FROM mirror_entries WHERE vault_id=? AND path=?",vaultId,entry.path);if(current?.hash===entry.hash&&visible.get(entry.path)?.size===entry.size)continue;
        const encrypted=await loadEncryptedBlob(vaultId,entry.hash);if(!encrypted)throw new Error(`Encrypted blob is unavailable for ${entry.path}`);const clear=decryptVaultBlob(encrypted,key,entry.hash);mirrorWriteSettles.set(vaultId,{snapshotId:snapshot.id,until:Date.now()+5000});await storage.putReadable(row,entry.path,clear);
        if(!mayContinue()){superseded=true;break;}
        store.run("INSERT INTO mirror_entries(vault_id,path,hash,size,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(vault_id,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,updated_at=excluded.updated_at",vaultId,entry.path,entry.hash,clear.length,new Date().toISOString());}
      if(superseded){const externalRequested=externalScanRequests.delete(vaultId);mirrorWriteSettles.delete(vaultId);if(!containment.allows(vaultId))return;if(externalRequested){scheduleMirror(vaultId,50);return;}skipExternalOnce.add(vaultId);continue;}
      const removedPaths:string[]=[];for(const {path} of store.all<{path:string}>("SELECT path FROM mirror_entries WHERE vault_id=?",vaultId)){if(target.has(path))continue;if(!mayContinue()){superseded=true;break;}mirrorWriteSettles.set(vaultId,{snapshotId:snapshot.id,until:Date.now()+5000});await storage.deleteReadable(row,path);if(!mayContinue()){superseded=true;break;}store.run("DELETE FROM mirror_entries WHERE vault_id=? AND path=?",vaultId,path);removedPaths.push(path);}
      if(superseded){const externalRequested=externalScanRequests.delete(vaultId);mirrorWriteSettles.delete(vaultId);if(!containment.allows(vaultId))return;if(externalRequested){scheduleMirror(vaultId,50);return;}skipExternalOnce.add(vaultId);continue;}
      if(!mayContinue()){mirrorWriteSettles.delete(vaultId);return;}
      const folderResult=await reconcileReadableFolders(vaultId,snapshot),verified=await verifyReadableGeneration(vaultId,snapshot,removedPaths);if(verified.missing.length||verified.lingering.length||verified.missingFolders.length||verified.lingeringFolders.length)throw new Error(`Readable mirror generation is not yet visible (${verified.missing.length} files missing, ${verified.lingering.length} files lingering, ${verified.missingFolders.length} folders missing, ${verified.lingeringFolders.length} folders lingering${folderResult.remaining.length?`, ${folderResult.remaining.length} non-empty folder removals deferred`:""})`);
      if(!mayContinue()){const externalRequested=externalScanRequests.delete(vaultId);mirrorWriteSettles.delete(vaultId);if(!containment.allows(vaultId))return;if(externalRequested){scheduleMirror(vaultId,50);return;}skipExternalOnce.add(vaultId);continue;}
      await writeGeneration(config,storage,row,snapshot);const completed=store.run("UPDATE vaults SET mirror_head_id=?,mirror_generation_id=? WHERE id=? AND head_id=?",snapshot.id,snapshot.id,vaultId,snapshot.id);
      if(completed.changes){store.run("DELETE FROM external_absences WHERE vault_id=?",vaultId);mirrorWriteSettles.delete(vaultId);return;}
      skipExternalOnce.add(vaultId);mirrorWriteSettles.delete(vaultId);
    }throw new Error(`Readable mirror could not catch up for vault ${vaultId}`);})().then(()=>{mirrorFailureCounts.delete(vaultId);mirrorRetryNotBefore.delete(vaultId);}).catch((error)=>{
      const failures=(mirrorFailureCounts.get(vaultId)??0)+1,retryMs=Math.min(60_000,5000*(2**Math.min(failures-1,4)));mirrorFailureCounts.set(vaultId,failures);mirrorRetryNotBefore.set(vaultId,Date.now()+retryMs);
      app.log.error({err:error,vaultId,retryMs},"Readable mirror reconciliation failed");scheduleMirror(vaultId,retryMs);
    }).finally(()=>mirrorJobs.delete(vaultId));
    mirrorJobs.set(vaultId,job);return job;
  }
  function scheduleMirror(vaultId:string,delay=2000){
    if(closing||!containment.allows(vaultId))return;const effectiveDelay=Math.max(delay,(mirrorRetryNotBefore.get(vaultId)??0)-Date.now(),0),due=Date.now()+effectiveDelay,scheduled=mirrorTimers.get(vaultId);if(scheduled&&scheduled.due<=due)return;if(scheduled)clearTimeout(scheduled.timer);
    const timer=setTimeout(()=>{mirrorTimers.delete(vaultId);if(!closing)void reconcileReadableMirror(vaultId);},effectiveDelay);timer.unref();mirrorTimers.set(vaultId,{timer,due});
  }

  function setupResponse(vaultId: string, vaultName: string, deviceId: string, deviceToken: string): SetupResponse {
    const vault = store.one<{wrapped_key: string; head_id: string | null}>("SELECT wrapped_key,head_id FROM vaults WHERE id=?", vaultId)!;
    return {
      protocolVersion: PROTOCOL_VERSION, serverVersion:SERVER_VERSION,serverCapabilities:[...SERVER_CAPABILITIES],serverUrl: config.PUBLIC_URL, vaultId, vaultName, deviceId, deviceToken,
      vaultKey: openJson<string>(vault.wrapped_key, config.GIBSYNC_SERVER_SECRET, vaultId),
      head: vault.head_id ? store.getSnapshot(vault.head_id) : null, storage: storage.location(storageRow(vaultId))
    };
  }

  app.get("/healthz", async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION,serverVersion:SERVER_VERSION,serverCapabilities:[...SERVER_CAPABILITIES],minimumClientVersion:config.GIBSYNC_MIN_CLIENT_VERSION,recommendedClientVersion:config.GIBSYNC_RECOMMENDED_CLIENT_VERSION, containmentActive:containment.state().active,storage: "seafile", readableMirrors:true,externalEdits:true,externalScanSeconds:3,quickCodes:true,quickCodeSeconds:60,instantReceive:true,conflictPolicy:"word-aware-v1",safeguards:"quarantine-v1",vaults: store.one<{count:number}>("SELECT COUNT(*) AS count FROM vaults")?.count ?? 0 }));

  app.post("/v1/health/repair",async(request,reply)=>{
    const device=await authenticate(request);z.object({restoreAcceptedHead:z.literal(true)}).parse(request.body);
    if(integrityBlockedVaults.has(device.vault_id))return reply.code(423).send({error:"The accepted snapshot failed structural integrity checks. Automated mirror repair is blocked to prevent propagation; restore the database from a verified backup or use an audited server repair."});
    if(healthRepairLocks.has(device.vault_id))return reply.conflict("A health repair is already running for this vault");healthRepairLocks.add(device.vault_id);
    try{
    const vault=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)!;
    let snapshot=vault.head_id?store.getSnapshot(vault.head_id):null,removedConflictCopies=0;
    if(snapshot){
      const generatedSuffix=/ \(conflict - .+ - \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} UTC(?: - \d+)?\)(?=\.[^/]+$|$)/i;
      const groups=new Map<string,ManifestEntry[]>();
      for(const entry of snapshot.entries){const original=entry.path.replace(generatedSuffix,"");if(original===entry.path)continue;const copies=groups.get(original)??[];copies.push(entry);groups.set(original,copies);}
      const byPath=new Map(snapshot.entries.map((entry)=>[entry.path,entry])),redundant=new Set<string>();for(const [original,copies] of groups){const intact=byPath.get(original);if(!intact)continue;for(const copy of copies)if(copy.hash===intact.hash)redundant.add(copy.path);}
      if(redundant.size){
        const cleaned=await acceptSnapshot(device.vault_id,snapshot.id,device.id,device.name,`Health repair: removed ${redundant.size} redundant generated conflict copies`,snapshot.entries.filter((entry)=>!redundant.has(entry.path)),snapshot.folders);
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
    store.run("UPDATE mirror_entries SET hash=? WHERE vault_id=?",`repair:${now}`,device.vault_id);store.run("UPDATE vaults SET mirror_head_id=NULL,mirror_generation_id=NULL,external_error=NULL WHERE id=?",device.vault_id);
    skipExternalOnce.add(device.vault_id);await reconcileReadableMirror(device.vault_id);
    let repaired=store.one<{head_id:string|null;mirror_head_id:string|null;mirror_generation_id:string|null}>("SELECT head_id,mirror_head_id,mirror_generation_id FROM vaults WHERE id=?",device.vault_id)!;
    if(repaired.head_id!==repaired.mirror_head_id||repaired.head_id!==repaired.mirror_generation_id){skipExternalOnce.add(device.vault_id);await reconcileReadableMirror(device.vault_id);repaired=store.one<{head_id:string|null;mirror_head_id:string|null;mirror_generation_id:string|null}>("SELECT head_id,mirror_head_id,mirror_generation_id FROM vaults WHERE id=?",device.vault_id)!;}
    const mirrorCurrent=repaired.head_id===repaired.mirror_head_id&&repaired.head_id===repaired.mirror_generation_id;
    safeguards.event(device.vault_id,"health_repair",mirrorCurrent?"info":"error",mirrorCurrent?`${device.name} restored the accepted snapshot and rebuilt the readable mirror`:`${device.name} requested health repair but the readable mirror did not converge`);
    notifyVault(device.vault_id,repaired.head_id,!mirrorCurrent);const result={headId:repaired.head_id,mirrorCurrent,restoredFiles:snapshot?.entries.length??0,removedFiles,removedConflictCopies,dismissedQuarantines,clearedAlerts};
    return mirrorCurrent?result:reply.code(503).send({error:"Health repair could not make the readable mirror current",...result});
    }finally{healthRepairLocks.delete(device.vault_id);}
  });

  const credentialsSchema = z.object({ seafileUrl:z.string().url(), seafileUsername:z.string().min(1).max(320), seafilePassword:z.string().min(1).max(1000) });

  app.post("/v1/storage/discover", async (request) => {
    const body = credentialsSchema.parse(request.body); const credentials = await storage.authenticate(body.seafileUrl, body.seafileUsername, body.seafilePassword);
    const libraries=await storage.libraries(credentials);const libraryIds=new Set(libraries.map((item)=>item.id));
    const existingVaults=store.all<{vaultId:string;vaultName:string;libraryId:string;libraryName:string;basePath:string;storageUrl:string}>(
      "SELECT id vaultId,name vaultName,storage_repo_id libraryId,storage_repo_name libraryName,storage_base_path basePath,storage_url storageUrl FROM vaults WHERE storage_username=? ORDER BY created_at",credentials.username)
      .filter((vault)=>storage.equivalentServer(vault.storageUrl,credentials.url)&&libraryIds.has(vault.libraryId)).map(({storageUrl:_storageUrl,...vault})=>vault);
    return { username:credentials.username,libraries,existingVaults };
  });

  app.post("/v1/setup", async (request, reply) => {
    const body = credentialsSchema.extend({ vaultName:z.string().min(1).max(100), deviceName:z.string().min(1).max(100), libraryId:z.string().min(1).max(100), libraryName:z.string().min(1).max(255), basePath:z.string().max(1000).default("/"), existingVaultId:z.string().uuid().optional() }).parse(request.body) as StorageSetupRequest;
    const credentials = await storage.authenticate(body.seafileUrl, body.seafileUsername, body.seafilePassword);
    const libraries = await storage.libraries(credentials); const library = libraries.find((item) => item.id === body.libraryId);
    if (!library) return reply.badRequest("The selected Seafile library is not accessible to this account");
    const basePath = normalizeBasePath(body.basePath); let vault = body.existingVaultId ? store.one<{id:string;name:string;storage_username:string;storage_url:string;head_id:string|null}>(
      "SELECT id,name,storage_username,storage_url,head_id FROM vaults WHERE id=? AND storage_repo_id=?",body.existingVaultId,library.id) : store.one<{id:string;name:string;storage_username:string;storage_url:string;head_id:string|null}>(
      "SELECT id,name,storage_username,storage_url,head_id FROM vaults WHERE storage_url=? AND storage_repo_id=? AND storage_base_path=? AND storage_layout='standard'",credentials.url,library.id,basePath);
    if (body.existingVaultId && (!vault || !storage.equivalentServer(vault.storage_url,credentials.url))) return reply.forbidden("The selected existing vault is not available to this Seafile account");
    const now = new Date().toISOString();
    if (vault && vault.storage_username !== credentials.username) return reply.forbidden("This storage location belongs to another Gib Sync user");
    if (!vault) {
      const id = randomUUID(); const vaultKey = randomToken(32);
      store.run("INSERT INTO vaults(id,name,wrapped_key,created_at,storage_url,storage_username,storage_repo_id,storage_repo_name,storage_base_path,storage_token,storage_layout,mirror_base_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        id,body.vaultName,sealJson(vaultKey,config.GIBSYNC_SERVER_SECRET,id),now,credentials.url,credentials.username,library.id,library.name,basePath,storage.sealToken(id,credentials.token),"standard",basePath);
      vault = { id, name:body.vaultName, storage_username:credentials.username, storage_url:credentials.url,head_id:null }; await storage.initVault(storageRow(id));
    } else {
      store.run("UPDATE vaults SET storage_token=?,storage_repo_name=? WHERE id=?", storage.sealToken(vault.id,credentials.token),library.name,vault.id);
    }
    const deviceId = randomUUID(); const deviceToken = randomToken();
    store.run("INSERT INTO devices(id,vault_id,name,token_hash,created_at,last_seen_at,initial_sync_complete) VALUES(?,?,?,?,?,?,?)",deviceId,vault.id,body.deviceName,sha256(deviceToken),now,now,vault.head_id?0:1);
    return setupResponse(vault.id,vault.name,deviceId,deviceToken);
  });

  type PairingRow={id:string;vault_id:string;expires_at:string;consumed_at:string|null};
  const quickCodeAttempts=new Map<string,{failures:number;resetAt:number}>();
  function failedQuickCodeAttempt(ip:string):boolean{
    const now=Date.now();if(quickCodeAttempts.size>1000){for(const [key,value] of quickCodeAttempts)if(value.resetAt<=now)quickCodeAttempts.delete(key);if(quickCodeAttempts.size>5000)quickCodeAttempts.clear();}
    const current=quickCodeAttempts.get(ip);const attempt=!current||current.resetAt<=now?{failures:1,resetAt:now+60_000}:{failures:current.failures+1,resetAt:current.resetAt};
    quickCodeAttempts.set(ip,attempt);return attempt.failures>5;
  }
  function consumePairing(row:PairingRow,deviceName:string,secret:string,context:string){
    const vault=store.one<{name:string}>("SELECT name FROM vaults WHERE id=?",row.vault_id)!;
    const deviceId=randomUUID();const deviceToken=randomToken();const now=new Date().toISOString();
    store.db.exec("BEGIN IMMEDIATE");
    try{
      const consumed=store.run("UPDATE pairings SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>=?",now,row.id,now);
      if(consumed.changes!==1){store.db.exec("ROLLBACK");return null;}
      store.run("INSERT INTO devices(id,vault_id,name,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?,?)",deviceId,row.vault_id,deviceName,sha256(deviceToken),now,now);
      store.db.exec("COMMIT");
    }catch(error){store.db.exec("ROLLBACK");throw error;}
    return {pairingId:row.id,envelope:sealJson(setupResponse(row.vault_id,vault.name,deviceId,deviceToken),secret,context)};
  }

  app.post("/v1/pairings",async(request)=>{
    const device=await authenticate(request);const pairingId=randomUUID();
    const expiresAt=new Date(Date.now()+60_000).toISOString();
    store.run("UPDATE pairings SET quick_code_hash=NULL WHERE consumed_at IS NOT NULL OR expires_at<?",new Date().toISOString());
    let code="";let normalized="";
    for(let attempt=0;attempt<8;attempt++){code=quickCode();normalized=normalizeQuickCode(code);if(!store.one("SELECT id FROM pairings WHERE quick_code_hash=?",sha256(normalized)))break;}
    if(!code||store.one("SELECT id FROM pairings WHERE quick_code_hash=?",sha256(normalized)))throw new Error("Unable to allocate a quick code");
    store.run("INSERT INTO pairings(id,vault_id,secret_hash,quick_code_hash,created_by_device,expires_at) VALUES(?,?,?,?,?,?)",pairingId,device.vault_id,sha256(normalized),sha256(normalized),device.id,expiresAt);
    return {code,expiresAt};
  });

  app.post("/v1/pairings/claim-code",async(request,reply)=>{
    const body=z.object({code:z.string().min(5).max(12),deviceName:z.string().min(1).max(100)}).parse(request.body);let code:string;
    try{code=normalizeQuickCode(body.code);}catch{return reply.code(410).send({error:"Quick code expired or invalid"});}
    const row=store.one<PairingRow>("SELECT id,vault_id,expires_at,consumed_at FROM pairings WHERE quick_code_hash=?",sha256(code));
    if(!row||row.consumed_at||Date.parse(row.expires_at)<Date.now()){const limited=failedQuickCodeAttempt(request.ip);return reply.code(limited?429:410).send({error:limited?"Too many quick-code attempts; try again later":"Quick code expired or invalid"});}
    quickCodeAttempts.delete(request.ip);
    return consumePairing(row,body.deviceName,code,`pairing:${row.id}`)??reply.code(410).send({error:"Quick code expired or invalid"});
  });

  app.get("/v1/state", async (request) => {
    const device = await authenticate(request);
    const vault = store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?", device.vault_id)!;
    return { head: vault.head_id ? store.getSnapshot(vault.head_id) : null };
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
    safeguards.clearResolvedQuarantineAlerts(device.vault_id);
    const aggregate = store.one<{snapshot_count:number;blob_count:number;blob_bytes:number}>("SELECT (SELECT COUNT(*) FROM snapshots WHERE vault_id=?) snapshot_count,(SELECT COUNT(*) FROM blobs WHERE vault_id=?) blob_count,(SELECT COALESCE(SUM(size),0) FROM blobs WHERE vault_id=?) blob_bytes",device.vault_id,device.vault_id,device.vault_id)!;
    const devices=store.all<{id:string;name:string;created_at:string;last_seen_at:string;revoked_at:string|null;initial_sync_complete:number;clock_skew_ms:number;client_version:string|null;client_protocol:number|null}>("SELECT id,name,created_at,last_seen_at,revoked_at,initial_sync_complete,clock_skew_ms,client_version,client_protocol FROM devices WHERE vault_id=? ORDER BY created_at",device.vault_id)
      .map((item)=>{const state=clientCompatibility({clientVersion:item.client_version,clientProtocol:item.client_protocol,minimumVersion:config.GIBSYNC_MIN_CLIENT_VERSION,recommendedVersion:config.GIBSYNC_RECOMMENDED_CLIENT_VERSION,serverProtocol:PROTOCOL_VERSION,serverVersion:SERVER_VERSION,serverCapabilities:[...SERVER_CAPABILITIES]});return {id:item.id,name:item.name,createdAt:item.created_at,lastSeenAt:item.last_seen_at,revokedAt:item.revoked_at,ready:Boolean(item.initial_sync_complete),clockSkewMs:item.clock_skew_ms,current:item.id===device.id,clientVersion:item.client_version,clientProtocol:item.client_protocol,compatibility:state.compatible?(state.updateAvailable?"update-available":"compatible"):"incompatible"};});
    const healthAlerts=store.all<{code:string;level:"info"|"warning"|"error";message:string;created_at:string}>("SELECT code,level,message,created_at FROM health_events WHERE vault_id=? AND cleared_at IS NULL ORDER BY created_at DESC LIMIT 20",device.vault_id)
      .map((item)=>({code:item.code,level:item.level,message:item.message,at:item.created_at}));
    if(vault.external_error)healthAlerts.unshift({code:"external_error",level:"error",message:`External Seafile scan: ${vault.external_error}`,at:vault.external_scan_at??new Date().toISOString()});
    if(vault.head_id&&!mirrorCurrent)healthAlerts.unshift({code:"mirror_diverged",level:"warning",message:"Readable Seafile mirror is catching up or verifying its completed generation",at:new Date().toISOString()});
    for(const item of devices)if(!item.revokedAt&&Math.abs(item.clockSkewMs)>safeguards.policy(device.vault_id).clockSkewMinutes*60_000)healthAlerts.unshift({code:`clock_skew:${item.id}`,level:"warning",message:`${item.name}'s clock differs from the server by ${Math.round(Math.abs(item.clockSkewMs)/60_000)} minutes`,at:item.lastSeenAt});
    for(const item of devices)if(!item.revokedAt&&Date.now()-Date.parse(item.lastSeenAt)>30*24*60*60*1000)healthAlerts.push({code:`stale_device:${item.id}`,level:"info",message:`${item.name} has not synced in over 30 days`,at:item.lastSeenAt});
    const control=containment.state();
    return { protocolVersion:PROTOCOL_VERSION,serverVersion:SERVER_VERSION,serverCapabilities:[...SERVER_CAPABILITIES],vaultId:device.vault_id,vaultName:vault.name,deviceId:device.id,deviceName:device.name,
      deviceCount:store.one<{count:number}>("SELECT COUNT(*) count FROM devices WHERE vault_id=? AND revoked_at IS NULL",device.vault_id)?.count ?? 0,
      snapshotCount:aggregate.snapshot_count,blobCount:aggregate.blob_count,blobBytes:aggregate.blob_bytes,head:vault.head_id?store.getSnapshot(vault.head_id):null,
      storage:storage.location(storageRow(device.vault_id)),serverTime:new Date().toISOString(),mirrorHeadId:vault.mirror_head_id,
      mirrorFileCount:store.one<{count:number}>("SELECT COUNT(*) count FROM mirror_entries WHERE vault_id=?",device.vault_id)?.count??0,
      mirrorCurrent,externalScanAt:vault.external_scan_at,externalImportAt:vault.external_import_at,externalError:vault.external_error,
      containment:{active:control.active,thisVaultAllowed:!control.active||control.allowedVaultId===device.vault_id,enabledAt:control.enabledAt,reason:control.reason},safeguards:safeguards.state(device.vault_id,device.id),healthAlerts,devices,compatibility };
  });

  app.get("/v1/compatibility",async(request)=>{await authenticate(request,{allowIncompatible:true,allowContainment:true});return compatibilityFor(request);});

  app.post("/v1/external/scan",async(request)=>{
    const device=await authenticate(request);return ingestExternalChanges(device.vault_id,true);
  });

  const entrySchema=z.object({path:z.string().min(1).max(4000).refine((value)=>{try{return safeRelativePath(value)===value;}catch{return false;}},"Invalid vault-relative file path"),hash:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().nonnegative(),mtime:z.number().nonnegative()});
  const folderSchema=z.string().min(1).max(4000).refine((value)=>{try{return safeRelativePath(value)===value;}catch{return false;}},"Invalid vault-relative folder path");
  const policySchema=z.object({mode:z.enum(["strict","balanced","custom"]),deletionCount:z.number().int().min(1).max(100000),smallVaultDeletionCount:z.number().int().min(1).max(100000),
    smallVaultDeletionPercent:z.number().min(1).max(100),changedCount:z.number().int().min(1).max(200000),changedPercent:z.number().min(1).max(100),
    folderImpactCount:z.number().int().min(1).max(200000),fileGrowthBytes:z.number().int().min(1024).max(Number.MAX_SAFE_INTEGER),
    fileGrowthPercent:z.number().min(100).max(100000),clockSkewMinutes:z.number().min(1).max(1440),protectedPaths:z.array(z.string().min(1).max(4000)).max(1000)});

  async function acceptSnapshot(vaultId:string,parentId:string|null,deviceId:string,deviceName:string,message:string,entries:ManifestEntry[],folders?:string[],folderRepair?:Snapshot["folderRepair"]):Promise<Snapshot|null>{
    const parent=parentId?store.getSnapshot(parentId):null,inheritedRepair=parent?.folderRepair,sourceRepair=folderRepair??inheritedRepair;
    const effectiveRepair=sourceRepair?{...sourceRepair,issuedAt:sourceRepair.issuedAt??(folderRepair?new Date().toISOString():parent?.createdAt??new Date().toISOString())}:undefined;
    const snapshot=await snapshotCommitter.accept({vaultId,parentId,deviceId,deviceName,message,entries,folders,folderRepair:effectiveRepair,afterInsert:(accepted)=>store.run("UPDATE quarantines SET status='stale',resolved_at=? WHERE vault_id=? AND status='pending' AND parent_id IS ?",accepted.createdAt,vaultId,parentId)});if(!snapshot)return null;
    safeguards.clearResolvedQuarantineAlerts(vaultId);mirrorWriteSettles.delete(vaultId);notifyVault(vaultId,snapshot.id);scheduleMirror(vaultId);return snapshot;
  }

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
    const row=store.one<{source:string;status:string}>("SELECT source,status FROM quarantines WHERE id=? AND vault_id=?",id,device.vault_id);if(!row)return reply.notFound();if(row.status!=="pending")return reply.conflict("Quarantine is no longer pending");
    const resolvedAt=new Date().toISOString();store.run("UPDATE quarantines SET status='rejected',resolved_at=?,resolved_by=?,resolution_kind='manual_reject',resolution_context_json=? WHERE id=?",resolvedAt,device.id,JSON.stringify({resolvedAt,resolvedByDeviceId:device.id,resolvedByDeviceName:device.name}),id);
    safeguards.clearResolvedQuarantineAlerts(device.vault_id);
    if(row.source==="seafile"){store.run("UPDATE vaults SET mirror_head_id=NULL,mirror_generation_id=NULL WHERE id=?",device.vault_id);skipExternalOnce.add(device.vault_id);scheduleMirror(device.vault_id,50);}
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
    const snapshot=await acceptSnapshot(device.vault_id,row.parent_id,row.device_id,row.device_name,`${row.message} (${approvalLabel})`,entries,folders);if(!snapshot){store.run("UPDATE quarantines SET status='stale' WHERE id=?",id);return reply.conflict("Vault changed after this proposal; review a new proposal");}
    if(body.trustMinutes)store.run("UPDATE vaults SET trusted_until=?,trusted_device_id=? WHERE id=?",new Date(Date.now()+body.trustMinutes*60_000).toISOString(),row.device_id,device.vault_id);
    store.run("UPDATE quarantines SET status='approved',resolved_at=?,resolved_by=?,resolution_kind=?,resolution_context_json=? WHERE id=?",resolvedAt,device.id,approvalKind,JSON.stringify({approvedAt:resolvedAt,approvedByDeviceId:device.id,approvedByDeviceName:device.name,trustMinutes:body.trustMinutes,source:row.source,assessment:heldAssessment}),id);
    safeguards.clearResolvedQuarantineAlerts(device.vault_id);
    safeguards.event(device.vault_id,"quarantine_approved","info",`Suspicious changes received ${approvalLabel}`);return reply.code(201).send(snapshot);
  });
  app.post("/v1/devices/current/ready",async(request,reply)=>{
    const device=await authenticate(request),headId=z.object({headId:z.string().uuid().nullable().optional()}).parse(request.body).headId;
    const current=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)!.head_id;
    if(headId!==undefined&&current!==headId)return reply.conflict("Vault changed before this device finished verifying its first download");
    store.run("UPDATE devices SET initial_sync_complete=1,initial_sync_head_id=? WHERE id=?",headId??current,device.id);return {ok:true};
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
    const row=storageRow(device.vault_id),current=new Map(store.all<{path:string;hash:string;size:number}>("SELECT path,hash,size FROM mirror_entries WHERE vault_id=?",device.vault_id).map((entry)=>[entry.path,entry])),visible=new Map((await storage.listReadable(row)).map((entry)=>[entry.path,entry]));
    const target=new Map(body.entries.map((entry)=>[entry.path,entry.hash]));
    const uploadPaths=body.entries.filter((entry)=>current.get(entry.path)?.hash!==entry.hash||visible.get(entry.path)?.size!==entry.size).map((entry)=>entry.path);
    const deletePaths=[...current.keys()].filter((path)=>!target.has(path));
    return {uploadPaths,deletePaths,alreadyCurrent:vault.mirror_head_id===body.snapshotId&&vault.mirror_generation_id===body.snapshotId&&!uploadPaths.length&&!deletePaths.length};
  });

  app.put("/v1/mirror/file",async(request,reply)=>{
    const device=await authenticate(request);const path=z.string().min(1).max(4000).parse((request.query as Record<string,unknown>).path);
    const snapshotId=z.string().uuid().parse(request.headers["x-gib-sync-snapshot"]);const expectedHash=z.string().regex(/^[a-f0-9]{64}$/).parse(request.headers["x-gib-sync-hash"]);
    const vault=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)!;if(vault.head_id!==snapshotId)return reply.conflict("Mirror snapshot is no longer the vault head");
    const snapshot=store.getSnapshot(snapshotId);const entry=snapshot?.entries.find((item)=>item.path===path&&item.hash===expectedHash);if(!entry)return reply.badRequest("File is not part of this snapshot");
    const bytes=Buffer.from(request.body as Buffer);if(bytes.length!==entry.size||sha256(bytes)!==expectedHash)return reply.badRequest("Readable file integrity check failed");
    mirrorWriteSettles.set(device.vault_id,{snapshotId,until:Date.now()+5000});await storage.putReadable(storageRow(device.vault_id),path,new Uint8Array(bytes));
    store.run("INSERT INTO mirror_entries(vault_id,path,hash,size,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(vault_id,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,updated_at=excluded.updated_at",device.vault_id,path,expectedHash,bytes.length,new Date().toISOString());
    return reply.code(204).send();
  });

  app.post("/v1/mirror/complete",async(request,reply)=>{
    const device=await authenticate(request);const snapshotId=z.object({snapshotId:z.string().uuid()}).parse(request.body).snapshotId;
    const vault=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)!;if(vault.head_id!==snapshotId)return reply.conflict("Mirror snapshot is no longer the vault head");
    const snapshot=store.getSnapshot(snapshotId);if(!snapshot)return reply.notFound();const target=new Set(snapshot.entries.map((entry)=>entry.path)),removedPaths:string[]=[];let deletedFiles=0;
    for(const {path} of store.all<{path:string}>("SELECT path FROM mirror_entries WHERE vault_id=?",device.vault_id)){if(target.has(path))continue;mirrorWriteSettles.set(device.vault_id,{snapshotId,until:Date.now()+5000});await storage.deleteReadable(storageRow(device.vault_id),path);store.run("DELETE FROM mirror_entries WHERE vault_id=? AND path=?",device.vault_id,path);removedPaths.push(path);deletedFiles++;}
    const missing=snapshot.entries.filter((entry)=>!store.one("SELECT 1 FROM mirror_entries WHERE vault_id=? AND path=? AND hash=?",device.vault_id,entry.path,entry.hash));
    if(missing.length)return reply.code(422).send({error:"Readable mirror is incomplete",paths:missing.slice(0,100).map((entry)=>entry.path)});
    const folderResult=await reconcileReadableFolders(device.vault_id,snapshot),verified=await verifyReadableGeneration(device.vault_id,snapshot,removedPaths);if(verified.missing.length||verified.lingering.length||verified.missingFolders.length||verified.lingeringFolders.length)return reply.code(422).send({error:"Readable mirror generation is not fully visible",missing:verified.missing.slice(0,100),lingering:verified.lingering.slice(0,100),missingFolders:verified.missingFolders.slice(0,100),lingeringFolders:verified.lingeringFolders.slice(0,100),deferredFolderRemovals:folderResult.remaining.slice(0,100)});
    await writeGeneration(config,storage,storageRow(device.vault_id),snapshot);const completed=store.run("UPDATE vaults SET mirror_head_id=?,mirror_generation_id=? WHERE id=? AND head_id=?",snapshotId,snapshotId,device.vault_id,snapshotId);
    if(!completed.changes){scheduleMirror(device.vault_id,50);return reply.conflict("Vault changed before readable mirror completion; the newer generation will resume automatically");}
    store.run("DELETE FROM external_absences WHERE vault_id=?",device.vault_id);mirrorWriteSettles.delete(device.vault_id);
    return {mirroredFiles:snapshot.entries.length,deletedFiles,snapshotId};
  });

  app.get("/v1/snapshots/:id", async (request, reply) => {
    const device = await authenticate(request); const id = z.object({id:z.string().uuid()}).parse(request.params).id;
    const snapshot = store.getSnapshot(id);
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

  async function loadEncryptedBlob(vaultId:string,hash:string):Promise<Uint8Array|null>{
    const exists=store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?",vaultId,hash);if(!exists)return null;
    const row=storageRow(vaultId),vault=store.one<{head_id:string|null;wrapped_key:string}>("SELECT head_id,wrapped_key FROM vaults WHERE id=?",vaultId)!;
    const key=openJson<string>(vault.wrapped_key,config.GIBSYNC_SERVER_SECRET,vaultId);let bytes:Uint8Array;
    try{bytes=await storage.get(row,`blobs/${hash.slice(0,2)}/${hash}.gbs`);decryptVaultBlob(bytes,key,hash);}
    catch(error){
      const entry=vault.head_id?store.getSnapshot(vault.head_id)?.entries.find((item)=>item.hash===hash):undefined;
      if(!entry)throw error;
      const clear=await storage.getReadable(row,entry.path);if(sha256(clear)!==hash)throw error;
      bytes=encryptVaultBlob(clear,key,hash);await storage.put(row,`blobs/${hash.slice(0,2)}/${hash}.gbs`,bytes);
      app.log.warn({vaultId,hash,path:entry.path},"Recovered missing or corrupt encrypted blob from readable mirror");
    }
    return bytes;
  }

  app.get("/v1/content/:hash",async(request,reply)=>{
    const device=await authenticate(request),hash=z.object({hash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.params).hash;
    const encrypted=await loadEncryptedBlob(device.vault_id,hash);if(!encrypted)return reply.notFound();
    const vault=store.one<{wrapped_key:string}>("SELECT wrapped_key FROM vaults WHERE id=?",device.vault_id)!;
    const key=openJson<string>(vault.wrapped_key,config.GIBSYNC_SERVER_SECRET,device.vault_id),clear=decryptVaultBlob(encrypted,key,hash);
    app.log.info({vaultId:device.vault_id,deviceId:device.id,hash,bytes:clear.byteLength},"Serving verified low-memory content");
    return reply.header("Cache-Control","no-store").header("X-Content-SHA256",hash).type("application/octet-stream").send(Buffer.from(clear.buffer,clear.byteOffset,clear.byteLength));
  });

  app.get("/v1/blobs/:hash", async (request, reply) => {
    const device = await authenticate(request); const hash = z.object({hash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.params).hash;
    const bytes=await loadEncryptedBlob(device.vault_id,hash);if(!bytes)return reply.notFound();
    return reply.type("application/octet-stream").send(Buffer.from(bytes));
  });

  app.put("/v1/blobs/:hash", async (request, reply) => {
    const device = await authenticate(request); const hash = z.object({hash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.params).hash;
    if (store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?", device.vault_id, hash)){
      try{if(await loadEncryptedBlob(device.vault_id,hash))return reply.code(204).send();}catch{app.log.warn({vaultId:device.vault_id,hash},"Replacing a registered blob that failed storage integrity verification");}
    }
    const bytes = new Uint8Array(request.body ? Buffer.from(request.body as Buffer) : Buffer.alloc(0));
    if (!bytes.length) return reply.badRequest("Empty blob");
    const vault=store.one<{wrapped_key:string}>("SELECT wrapped_key FROM vaults WHERE id=?",device.vault_id)!;
    try{decryptVaultBlob(bytes,openJson<string>(vault.wrapped_key,config.GIBSYNC_SERVER_SECRET,device.vault_id),hash);}catch{return reply.code(422).send({error:"Encrypted blob authentication or content hash is invalid"});}
    await storage.put(storageRow(device.vault_id), `blobs/${hash.slice(0,2)}/${hash}.gbs`, bytes);
    store.run("INSERT INTO blobs(vault_id,hash,size,created_at) VALUES(?,?,?,?) ON CONFLICT(vault_id,hash) DO UPDATE SET size=excluded.size,created_at=excluded.created_at", device.vault_id, hash, bytes.length, new Date().toISOString());
    return reply.code(201).send();
  });

  app.post("/v1/commit", async (request, reply) => {
    const device = await authenticate(request);
    if(integrityBlockedVaults.has(device.vault_id))return reply.code(423).send({error:"Sync is blocked because the accepted snapshot failed server integrity checks"});
    await ingestExternalChanges(device.vault_id);
    const body = z.object({ parentId: z.string().uuid().nullable(), message: z.string().max(500).default("Sync"), entries: z.array(entrySchema).max(200000),folders:z.array(folderSchema).max(200000).default([]),
      clientTime:z.string().datetime().optional(),signals:z.object({highEntropyPaths:z.array(z.string()).max(1000).optional(),deviceLocalCleanupPaths:z.array(z.string().max(1000)).max(5000).optional(),vaultIdentity:z.string().max(500).optional(),staleBaseline:z.boolean().optional()}).optional() }).parse(request.body) as CommitRequest;
    if(body.clientTime){const skew=Date.parse(body.clientTime)-Date.now();store.run("UPDATE devices SET clock_skew_ms=? WHERE id=?",Number.isFinite(skew)?Math.round(skew):0,device.id);}
    let manifest;try{manifest=canonicalManifest(body.entries,body.folders);}catch(error){return reply.code(422).send({error:error instanceof Error?error.message:String(error)});}
    body.entries=manifest.entries;body.folders=manifest.folders??[];
    const missing = body.entries.filter((entry) => !store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?", device.vault_id, entry.hash));
    if (missing.length) return reply.code(422).send({ error: "Missing blobs", hashes: missing.slice(0,100).map((e) => e.hash) });
    const current = store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?", device.vault_id)!.head_id;
    if(current!==body.parentId)return reply.code(409).send({error:"Head moved",head:current?store.getSnapshot(current):null});
    const ready=store.one<{initial_sync_complete:number}>("SELECT initial_sync_complete FROM devices WHERE id=?",device.id)?.initial_sync_complete;
    if(current&&!ready)return reply.code(428).send({error:"This newly paired device must complete its first download before it can upload changes"});
    const decision=safeguards.propose({vaultId:device.vault_id,deviceId:device.id,deviceName:device.name,parentId:body.parentId,message:body.message,entries:body.entries,folders:body.folders,source:"device",signals:body.signals});
    if(!decision.allowed){
      if(decision.quarantine&&decision.created)safeguards.event(device.vault_id,"mass_change_quarantine","warning",`${device.name}'s changes were quarantined: ${decision.assessment.reasons.join("; ")}`);
      return reply.code(423).send({error:decision.locked?"Remote writes are frozen for this vault":"Suspicious vault changes require approval",locked:decision.locked,quarantine:decision.quarantine,assessment:decision.assessment});
    }
    const message=decision.authorization==="trusted_window"?`${body.message} (device maintenance approval: ${device.name})`:body.message;
    const snapshot=await acceptSnapshot(device.vault_id,body.parentId,device.id,device.name,message,body.entries,body.folders??[]);
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
    for(const vault of store.all<{id:string;head_id:string}>("SELECT id,head_id FROM vaults WHERE head_id IS NOT NULL")){
      if(!containment.allows(vault.id)||integrityBlockedVaults.has(vault.id))continue;const plan=planLegacyFolderDescendantRepair(store,vault.id,vault.head_id)??planRetiredLegacyFolderRepair(store,vault.id,vault.head_id)??planMissingLegacyFolderRetirementDirective(store,vault.id,vault.head_id);if(!plan)continue;
      const head=store.getSnapshot(vault.head_id);if(!head)continue;
      const repaired=await acceptSnapshot(vault.id,head.id,"server:folder-provenance-repair","Gib Sync server","Repair unsafe legacy folder provenance",head.entries,plan.desiredFolders,{retiredFolders:plan.contaminatedFolders,observedAt:plan.observedAt,originSnapshotIds:plan.originIds,...(plan.issuedAt?{issuedAt:plan.issuedAt}:{})});
      if(repaired){
        safeguards.event(vault.id,"legacy_folder_descendants_repaired","info",`Repaired ${plan.contaminatedFolders.length} inherited empty folder records while preserving file content and later device folder intent.`);
        store.run("UPDATE health_events SET cleared_at=? WHERE vault_id=? AND cleared_at IS NULL AND code='legacy_folder_migration_reverted'",new Date().toISOString(),vault.id);
      }
    }
    for(const {id} of store.all<{id:string}>("SELECT id FROM vaults WHERE head_id IS NOT NULL"))if(!integrityBlockedVaults.has(id))scheduleMirror(id,50);
    const scanAll=()=>{for(const {id} of store.all<{id:string}>("SELECT id FROM vaults WHERE storage_url IS NOT NULL"))if(containment.allows(id))void ingestExternalChanges(id).catch((error)=>app.log.error({err:error,vaultId:id},"External Seafile scan failed"));};
    externalTimer=setInterval(scanAll,3000);externalTimer.unref();externalStartupTimer=setTimeout(scanAll,250);externalStartupTimer.unref();
  });

  return app;
}
