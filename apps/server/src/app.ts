import { randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import sensible from "@fastify/sensible";
import { PROTOCOL_VERSION, type CommitRequest, type MirrorPlanRequest, type SetupResponse, type Snapshot, type StorageSetupRequest } from "@gib-sync/protocol";
import { z } from "zod";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { normalizeBasePath, SeafileStorage, type VaultStorageRow } from "./seafile.js";
import { decryptVaultBlob, encryptVaultBlob, normalizeQuickCode, openJson, quickCode, randomToken, sealJson, sha256 } from "./security.js";

type AuthDevice = { id: string; vault_id: string; name: string };

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
  const app = Fastify({ trustProxy:true,logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: config.MAX_BLOB_BYTES + 1024 });
  app.addHook("onClose", async () => { for(const timer of mirrorTimers)clearTimeout(timer);await Promise.allSettled([...mirrorJobs.values()]); store.db.close(); });
  await app.register(cors, { origin: true, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] });
  await app.register(multipart, { limits: { fileSize: config.MAX_BLOB_BYTES, files: 1 } });
  await app.register(sensible);
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: config.MAX_BLOB_BYTES }, (_request, body, done) => done(null, body));

  async function authenticate(request: FastifyRequest): Promise<AuthDevice> {
    const raw = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!raw) throw app.httpErrors.unauthorized();
    const device = store.one<AuthDevice & { revoked_at: string | null }>("SELECT id,vault_id,name,revoked_at FROM devices WHERE token_hash=?", sha256(raw));
    if (!device || device.revoked_at) throw app.httpErrors.unauthorized();
    store.run("UPDATE devices SET last_seen_at=? WHERE id=?", new Date().toISOString(), device.id);
    return device;
  }

  function storageRow(vaultId: string): VaultStorageRow {
    const row = store.one<VaultStorageRow>("SELECT id,storage_url,storage_username,storage_repo_id,storage_repo_name,storage_base_path,storage_token,storage_layout,mirror_base_path,mirror_head_id FROM vaults WHERE id=?", vaultId);
    if (!row?.storage_url || !row.storage_token) throw new Error("Vault storage is not configured");
    return row;
  }

  const mirrorJobs=new Map<string,Promise<void>>();const mirrorTimers=new Set<NodeJS.Timeout>();
  function reconcileReadableMirror(vaultId:string):Promise<void>{
    const active=mirrorJobs.get(vaultId);if(active)return active;
    const job=(async()=>{for(let attempt=0;attempt<3;attempt++){
      const vault=store.one<{head_id:string|null;mirror_head_id:string|null;wrapped_key:string}>("SELECT head_id,mirror_head_id,wrapped_key FROM vaults WHERE id=?",vaultId);if(!vault?.head_id||vault.mirror_head_id===vault.head_id)return;
      const snapshot=store.getSnapshot(vault.head_id);if(!snapshot)return;const row=storageRow(vaultId);const key=openJson<string>(vault.wrapped_key,config.GIBSYNC_SERVER_SECRET,vaultId);const target=new Set(snapshot.entries.map((entry)=>entry.path));
      for(const entry of snapshot.entries){const current=store.one<{hash:string}>("SELECT hash FROM mirror_entries WHERE vault_id=? AND path=?",vaultId,entry.path);if(current?.hash===entry.hash)continue;
        const encrypted=await storage.get(row,`blobs/${entry.hash.slice(0,2)}/${entry.hash}.gbs`);const clear=decryptVaultBlob(encrypted,key,entry.hash);await storage.putReadable(row,entry.path,clear);
        store.run("INSERT INTO mirror_entries(vault_id,path,hash,size,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(vault_id,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,updated_at=excluded.updated_at",vaultId,entry.path,entry.hash,clear.length,new Date().toISOString());}
      for(const {path} of store.all<{path:string}>("SELECT path FROM mirror_entries WHERE vault_id=?",vaultId)){if(target.has(path))continue;await storage.deleteReadable(row,path);store.run("DELETE FROM mirror_entries WHERE vault_id=? AND path=?",vaultId,path);}
      const latest=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",vaultId)?.head_id;if(latest===snapshot.id){store.run("UPDATE vaults SET mirror_head_id=? WHERE id=?",snapshot.id,vaultId);return;}
    }throw new Error(`Readable mirror could not catch up for vault ${vaultId}`);})().catch((error)=>{app.log.error({err:error,vaultId},"Readable mirror reconciliation failed");}).finally(()=>mirrorJobs.delete(vaultId));
    mirrorJobs.set(vaultId,job);return job;
  }
  function scheduleMirror(vaultId:string,delay=2000){const timer=setTimeout(()=>{mirrorTimers.delete(timer);void reconcileReadableMirror(vaultId);},delay);timer.unref();mirrorTimers.add(timer);}

  function setupResponse(vaultId: string, vaultName: string, deviceId: string, deviceToken: string): SetupResponse {
    const vault = store.one<{wrapped_key: string; head_id: string | null}>("SELECT wrapped_key,head_id FROM vaults WHERE id=?", vaultId)!;
    return {
      protocolVersion: PROTOCOL_VERSION, serverUrl: config.PUBLIC_URL, vaultId, vaultName, deviceId, deviceToken,
      vaultKey: openJson<string>(vault.wrapped_key, config.GIBSYNC_SERVER_SECRET, vaultId),
      head: vault.head_id ? store.getSnapshot(vault.head_id) : null, storage: storage.location(storageRow(vaultId))
    };
  }

  app.get("/healthz", async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION, storage: "seafile", readableMirrors:true, quickCodes:true,quickCodeSeconds:60,vaults: store.one<{count:number}>("SELECT COUNT(*) AS count FROM vaults")?.count ?? 0 }));

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
    const basePath = normalizeBasePath(body.basePath); let vault = body.existingVaultId ? store.one<{id:string;name:string;storage_username:string;storage_url:string}>(
      "SELECT id,name,storage_username,storage_url FROM vaults WHERE id=? AND storage_repo_id=?",body.existingVaultId,library.id) : store.one<{id:string;name:string;storage_username:string;storage_url:string}>(
      "SELECT id,name,storage_username,storage_url FROM vaults WHERE storage_url=? AND storage_repo_id=? AND storage_base_path=? AND storage_layout='standard'",credentials.url,library.id,basePath);
    if (body.existingVaultId && (!vault || !storage.equivalentServer(vault.storage_url,credentials.url))) return reply.forbidden("The selected existing vault is not available to this Seafile account");
    const now = new Date().toISOString();
    if (vault && vault.storage_username !== credentials.username) return reply.forbidden("This storage location belongs to another Gib Sync user");
    if (!vault) {
      const id = randomUUID(); const vaultKey = randomToken(32);
      store.run("INSERT INTO vaults(id,name,wrapped_key,created_at,storage_url,storage_username,storage_repo_id,storage_repo_name,storage_base_path,storage_token,storage_layout,mirror_base_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        id,body.vaultName,sealJson(vaultKey,config.GIBSYNC_SERVER_SECRET,id),now,credentials.url,credentials.username,library.id,library.name,basePath,storage.sealToken(id,credentials.token),"standard",basePath);
      vault = { id, name:body.vaultName, storage_username:credentials.username, storage_url:credentials.url }; await storage.initVault(storageRow(id));
    } else {
      store.run("UPDATE vaults SET storage_token=?,storage_repo_name=? WHERE id=?", storage.sealToken(vault.id,credentials.token),library.name,vault.id);
    }
    const deviceId = randomUUID(); const deviceToken = randomToken();
    store.run("INSERT INTO devices(id,vault_id,name,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?,?)",deviceId,vault.id,body.deviceName,sha256(deviceToken),now,now);
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

  app.get("/v1/status", async (request) => {
    const device = await authenticate(request); const vault = store.one<{name:string;head_id:string|null;mirror_head_id:string|null}>("SELECT name,head_id,mirror_head_id FROM vaults WHERE id=?",device.vault_id)!;
    const aggregate = store.one<{snapshot_count:number;blob_count:number;blob_bytes:number}>("SELECT (SELECT COUNT(*) FROM snapshots WHERE vault_id=?) snapshot_count,(SELECT COUNT(*) FROM blobs WHERE vault_id=?) blob_count,(SELECT COALESCE(SUM(size),0) FROM blobs WHERE vault_id=?) blob_bytes",device.vault_id,device.vault_id,device.vault_id)!;
    return { protocolVersion:PROTOCOL_VERSION,vaultId:device.vault_id,vaultName:vault.name,deviceId:device.id,deviceName:device.name,
      deviceCount:store.one<{count:number}>("SELECT COUNT(*) count FROM devices WHERE vault_id=? AND revoked_at IS NULL",device.vault_id)?.count ?? 0,
      snapshotCount:aggregate.snapshot_count,blobCount:aggregate.blob_count,blobBytes:aggregate.blob_bytes,head:vault.head_id?store.getSnapshot(vault.head_id):null,
      storage:storage.location(storageRow(device.vault_id)),serverTime:new Date().toISOString(),mirrorHeadId:vault.mirror_head_id,
      mirrorFileCount:store.one<{count:number}>("SELECT COUNT(*) count FROM mirror_entries WHERE vault_id=?",device.vault_id)?.count??0,
      mirrorCurrent:Boolean(vault.head_id&&vault.mirror_head_id===vault.head_id) };
  });

  const entrySchema=z.object({path:z.string().min(1),hash:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().nonnegative(),mtime:z.number().nonnegative()});
  app.post("/v1/mirror/plan",async(request,reply)=>{
    const device=await authenticate(request);const body=z.object({snapshotId:z.string().uuid(),entries:z.array(entrySchema).max(200000)}).parse(request.body) as MirrorPlanRequest;
    const vault=store.one<{head_id:string|null;mirror_head_id:string|null}>("SELECT head_id,mirror_head_id FROM vaults WHERE id=?",device.vault_id)!;
    if(vault.head_id!==body.snapshotId)return reply.conflict("Mirror snapshot is no longer the vault head");
    const current=new Map(store.all<{path:string;hash:string}>("SELECT path,hash FROM mirror_entries WHERE vault_id=?",device.vault_id).map((entry)=>[entry.path,entry.hash]));
    const target=new Map(body.entries.map((entry)=>[entry.path,entry.hash]));
    const uploadPaths=body.entries.filter((entry)=>current.get(entry.path)!==entry.hash).map((entry)=>entry.path);
    const deletePaths=[...current.keys()].filter((path)=>!target.has(path));
    return {uploadPaths,deletePaths,alreadyCurrent:vault.mirror_head_id===body.snapshotId&&!uploadPaths.length&&!deletePaths.length};
  });

  app.put("/v1/mirror/file",async(request,reply)=>{
    const device=await authenticate(request);const path=z.string().min(1).max(4000).parse((request.query as Record<string,unknown>).path);
    const snapshotId=z.string().uuid().parse(request.headers["x-gib-sync-snapshot"]);const expectedHash=z.string().regex(/^[a-f0-9]{64}$/).parse(request.headers["x-gib-sync-hash"]);
    const vault=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)!;if(vault.head_id!==snapshotId)return reply.conflict("Mirror snapshot is no longer the vault head");
    const snapshot=store.getSnapshot(snapshotId);const entry=snapshot?.entries.find((item)=>item.path===path&&item.hash===expectedHash);if(!entry)return reply.badRequest("File is not part of this snapshot");
    const bytes=Buffer.from(request.body as Buffer);if(bytes.length!==entry.size||sha256(bytes)!==expectedHash)return reply.badRequest("Readable file integrity check failed");
    await storage.putReadable(storageRow(device.vault_id),path,new Uint8Array(bytes));
    store.run("INSERT INTO mirror_entries(vault_id,path,hash,size,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(vault_id,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,updated_at=excluded.updated_at",device.vault_id,path,expectedHash,bytes.length,new Date().toISOString());
    return reply.code(204).send();
  });

  app.post("/v1/mirror/complete",async(request,reply)=>{
    const device=await authenticate(request);const snapshotId=z.object({snapshotId:z.string().uuid()}).parse(request.body).snapshotId;
    const vault=store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",device.vault_id)!;if(vault.head_id!==snapshotId)return reply.conflict("Mirror snapshot is no longer the vault head");
    const snapshot=store.getSnapshot(snapshotId);if(!snapshot)return reply.notFound();const target=new Set(snapshot.entries.map((entry)=>entry.path));let deletedFiles=0;
    for(const {path} of store.all<{path:string}>("SELECT path FROM mirror_entries WHERE vault_id=?",device.vault_id)){if(target.has(path))continue;await storage.deleteReadable(storageRow(device.vault_id),path);store.run("DELETE FROM mirror_entries WHERE vault_id=? AND path=?",device.vault_id,path);deletedFiles++;}
    const missing=snapshot.entries.filter((entry)=>!store.one("SELECT 1 FROM mirror_entries WHERE vault_id=? AND path=? AND hash=?",device.vault_id,entry.path,entry.hash));
    if(missing.length)return reply.code(422).send({error:"Readable mirror is incomplete",paths:missing.slice(0,100).map((entry)=>entry.path)});
    store.run("UPDATE vaults SET mirror_head_id=? WHERE id=?",snapshotId,device.vault_id);
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
      .map(({manifest_json}) => { const s = JSON.parse(manifest_json) as Snapshot; return { id:s.id,parentId:s.parentId,deviceName:s.deviceName,createdAt:s.createdAt,message:s.message,fileCount:s.entries.length }; });
  });

  app.get("/v1/blobs/:hash", async (request, reply) => {
    const device = await authenticate(request); const hash = z.object({hash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.params).hash;
    const exists = store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?", device.vault_id, hash);
    if (!exists) return reply.notFound();
    const row=storageRow(device.vault_id);let bytes:Uint8Array;
    try{bytes=await storage.get(row,`blobs/${hash.slice(0,2)}/${hash}.gbs`);}
    catch(error){
      const vault=store.one<{head_id:string|null;wrapped_key:string}>("SELECT head_id,wrapped_key FROM vaults WHERE id=?",device.vault_id);
      const entry=vault?.head_id?store.getSnapshot(vault.head_id)?.entries.find((item)=>item.hash===hash):undefined;
      if(!entry)throw error;
      const clear=await storage.getReadable(row,entry.path);if(sha256(clear)!==hash)throw error;
      const key=openJson<string>(vault!.wrapped_key,config.GIBSYNC_SERVER_SECRET,device.vault_id);
      bytes=encryptVaultBlob(clear,key,hash);await storage.put(row,`blobs/${hash.slice(0,2)}/${hash}.gbs`,bytes);
      app.log.warn({vaultId:device.vault_id,hash,path:entry.path},"Recovered missing encrypted blob from readable mirror");
    }
    return reply.type("application/octet-stream").send(Buffer.from(bytes));
  });

  app.put("/v1/blobs/:hash", async (request, reply) => {
    const device = await authenticate(request); const hash = z.object({hash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.params).hash;
    if (store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?", device.vault_id, hash)) return reply.code(204).send();
    const bytes = new Uint8Array(request.body ? Buffer.from(request.body as Buffer) : Buffer.alloc(0));
    if (!bytes.length) return reply.badRequest("Empty blob");
    await storage.put(storageRow(device.vault_id), `blobs/${hash.slice(0,2)}/${hash}.gbs`, bytes);
    store.run("INSERT OR IGNORE INTO blobs(vault_id,hash,size,created_at) VALUES(?,?,?,?)", device.vault_id, hash, bytes.length, new Date().toISOString());
    return reply.code(201).send();
  });

  app.post("/v1/commit", async (request, reply) => {
    const device = await authenticate(request);
    const body = z.object({ parentId: z.string().uuid().nullable(), message: z.string().max(500).default("Sync"), entries: z.array(z.object({path:z.string().min(1),hash:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().nonnegative(),mtime:z.number().nonnegative()})).max(200000) }).parse(request.body) as CommitRequest;
    const missing = body.entries.filter((entry) => !store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?", device.vault_id, entry.hash));
    if (missing.length) return reply.code(422).send({ error: "Missing blobs", hashes: missing.slice(0,100).map((e) => e.hash) });
    const snapshot: Snapshot = { id: randomUUID(), vaultId: device.vault_id, parentId: body.parentId, deviceId: device.id, deviceName: device.name, createdAt: new Date().toISOString(), message: body.message, entries: [...body.entries].sort((a,b)=>a.path.localeCompare(b.path)) };
    await storage.put(storageRow(device.vault_id), `snapshots/${snapshot.id}.json`, Buffer.from(JSON.stringify(snapshot)), "application/json");
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const current = store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?", device.vault_id)!.head_id;
      if (current !== body.parentId) { store.db.exec("ROLLBACK"); return reply.code(409).send({ error: "Head moved", head: current ? store.getSnapshot(current) : null }); }
      store.run("INSERT INTO snapshots(id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?,?)", snapshot.id, snapshot.vaultId, snapshot.parentId, snapshot.deviceId, snapshot.deviceName, snapshot.createdAt, snapshot.message, JSON.stringify(snapshot));
      store.run("UPDATE vaults SET head_id=? WHERE id=?", snapshot.id, device.vault_id); store.db.exec("COMMIT");
    } catch (error) { try { store.db.exec("ROLLBACK"); } catch {} throw error; }
    scheduleMirror(device.vault_id);return reply.code(201).send(snapshot);
  });

  app.post("/v1/restore/:id", async (request, reply) => {
    const device = await authenticate(request); const id = z.object({id:z.string().uuid()}).parse(request.params).id;
    const source = store.getSnapshot(id); if (!source || source.vaultId !== device.vault_id) return reply.notFound();
    const vault = store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?", device.vault_id)!;
    const restored: Snapshot = { ...source, id: randomUUID(), parentId: vault.head_id, deviceId: device.id, deviceName: device.name, createdAt: new Date().toISOString(), message: `Restore ${id}` };
    await storage.put(storageRow(device.vault_id), `snapshots/${restored.id}.json`, Buffer.from(JSON.stringify(restored)), "application/json");
    store.db.exec("BEGIN IMMEDIATE");
    try { store.run("INSERT INTO snapshots(id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?,?)", restored.id,restored.vaultId,restored.parentId,restored.deviceId,restored.deviceName,restored.createdAt,restored.message,JSON.stringify(restored)); store.run("UPDATE vaults SET head_id=? WHERE id=?",restored.id,device.vault_id); store.db.exec("COMMIT"); }
    catch(error){ store.db.exec("ROLLBACK"); throw error; }
    scheduleMirror(device.vault_id);return reply.code(201).send(restored);
  });

  app.addHook("onReady",async()=>{for(const {id} of store.all<{id:string}>("SELECT id FROM vaults WHERE head_id IS NOT NULL AND (mirror_head_id IS NULL OR mirror_head_id<>head_id)"))scheduleMirror(id,50);});

  return app;
}
