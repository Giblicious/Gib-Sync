import { randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import sensible from "@fastify/sensible";
import { PROTOCOL_VERSION, type CommitRequest, type SetupResponse, type Snapshot } from "@gib-sync/protocol";
import { z } from "zod";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { SeafileStorage } from "./seafile.js";
import { openJson, randomToken, safeEqual, sealJson, sha256 } from "./security.js";

type AuthDevice = { id: string; vault_id: string; name: string };

export async function buildApp(config: Config, store = new Store(config.DATA_DIR), storage = new SeafileStorage(config)) {
  await storage.init();
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: config.MAX_BLOB_BYTES + 1024 });
  app.addHook("onClose", async () => { store.db.close(); });
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

  function setupResponse(vaultId: string, vaultName: string, deviceId: string, deviceToken: string): SetupResponse {
    const vault = store.one<{wrapped_key: string; head_id: string | null}>("SELECT wrapped_key,head_id FROM vaults WHERE id=?", vaultId)!;
    return {
      protocolVersion: PROTOCOL_VERSION, serverUrl: config.PUBLIC_URL, vaultId, vaultName, deviceId, deviceToken,
      vaultKey: openJson<string>(vault.wrapped_key, config.GIBSYNC_SERVER_SECRET, vaultId),
      head: vault.head_id ? store.getSnapshot(vault.head_id) : null
    };
  }

  app.get("/healthz", async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION, storage: "seafile" }));

  app.post("/v1/setup", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!safeEqual(token, config.GIBSYNC_SETUP_TOKEN)) return reply.unauthorized();
    const body = z.object({ vaultName: z.string().min(1).max(100), deviceName: z.string().min(1).max(100) }).parse(request.body);
    let vault = store.one<{id:string;name:string}>("SELECT id,name FROM vaults ORDER BY created_at LIMIT 1");
    if (vault) return reply.conflict("Initial setup is already complete; enroll additional devices with a pairing QR code");
    const now = new Date().toISOString();
    const id = randomUUID(); const vaultKey = randomToken(32);
    store.run("INSERT INTO vaults(id,name,wrapped_key,created_at) VALUES(?,?,?,?)", id, body.vaultName, sealJson(vaultKey, config.GIBSYNC_SERVER_SECRET, id), now);
    vault = { id, name: body.vaultName };
    const deviceId = randomUUID(); const deviceToken = randomToken();
    store.run("INSERT INTO devices(id,vault_id,name,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?,?)", deviceId, vault.id, body.deviceName, sha256(deviceToken), now, now);
    return setupResponse(vault.id, vault.name, deviceId, deviceToken);
  });

  app.post("/v1/pairings", async (request) => {
    const device = await authenticate(request); const pairingId = randomUUID(); const secret = randomToken();
    const expiresAt = new Date(Date.now() + config.PAIRING_TTL_SECONDS * 1000).toISOString();
    store.run("INSERT INTO pairings(id,vault_id,secret_hash,created_by_device,expires_at) VALUES(?,?,?,?,?)", pairingId, device.vault_id, sha256(secret), device.id, expiresAt);
    const payload = { v: 1 as const, server: config.PUBLIC_URL, pairingId, secret };
    return { payload, uri: `obsidian://gib-sync?data=${encodeURIComponent(Buffer.from(JSON.stringify(payload)).toString("base64url"))}`, expiresAt };
  });

  app.post("/v1/pairings/:id/claim", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ secret: z.string().min(20), deviceName: z.string().min(1).max(100) }).parse(request.body);
    const row = store.one<{vault_id:string;secret_hash:string;expires_at:string;consumed_at:string|null}>("SELECT vault_id,secret_hash,expires_at,consumed_at FROM pairings WHERE id=?", params.id);
    if (!row || row.consumed_at || Date.parse(row.expires_at) < Date.now() || !safeEqual(row.secret_hash, sha256(body.secret))) return reply.code(410).send({ error: "Pairing expired or invalid" });
    const vault = store.one<{name:string}>("SELECT name FROM vaults WHERE id=?", row.vault_id)!;
    const deviceId = randomUUID(); const deviceToken = randomToken(); const now = new Date().toISOString();
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const consumed = store.run("UPDATE pairings SET consumed_at=? WHERE id=? AND consumed_at IS NULL", now, params.id);
      if (consumed.changes !== 1) throw new Error("Pairing was already consumed");
      store.run("INSERT INTO devices(id,vault_id,name,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?,?)", deviceId, row.vault_id, body.deviceName, sha256(deviceToken), now, now);
      store.db.exec("COMMIT");
    } catch (error) { store.db.exec("ROLLBACK"); throw error; }
    return { envelope: sealJson(setupResponse(row.vault_id, vault.name, deviceId, deviceToken), body.secret, `pairing:${params.id}`) };
  });

  app.get("/v1/state", async (request) => {
    const device = await authenticate(request);
    const vault = store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?", device.vault_id)!;
    return { head: vault.head_id ? store.getSnapshot(vault.head_id) : null };
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
    const bytes = await storage.get(`/vaults/${device.vault_id}/blobs/${hash.slice(0,2)}/${hash}.gbs`);
    return reply.type("application/octet-stream").send(Buffer.from(bytes));
  });

  app.put("/v1/blobs/:hash", async (request, reply) => {
    const device = await authenticate(request); const hash = z.object({hash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.params).hash;
    if (store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?", device.vault_id, hash)) return reply.code(204).send();
    const bytes = new Uint8Array(request.body ? Buffer.from(request.body as Buffer) : Buffer.alloc(0));
    if (!bytes.length) return reply.badRequest("Empty blob");
    await storage.put(`/vaults/${device.vault_id}/blobs/${hash.slice(0,2)}/${hash}.gbs`, bytes);
    store.run("INSERT OR IGNORE INTO blobs(vault_id,hash,size,created_at) VALUES(?,?,?,?)", device.vault_id, hash, bytes.length, new Date().toISOString());
    return reply.code(201).send();
  });

  app.post("/v1/commit", async (request, reply) => {
    const device = await authenticate(request);
    const body = z.object({ parentId: z.string().uuid().nullable(), message: z.string().max(500).default("Sync"), entries: z.array(z.object({path:z.string().min(1),hash:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().nonnegative(),mtime:z.number().nonnegative()})).max(200000) }).parse(request.body) as CommitRequest;
    const missing = body.entries.filter((entry) => !store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?", device.vault_id, entry.hash));
    if (missing.length) return reply.code(422).send({ error: "Missing blobs", hashes: missing.slice(0,100).map((e) => e.hash) });
    const snapshot: Snapshot = { id: randomUUID(), vaultId: device.vault_id, parentId: body.parentId, deviceId: device.id, deviceName: device.name, createdAt: new Date().toISOString(), message: body.message, entries: [...body.entries].sort((a,b)=>a.path.localeCompare(b.path)) };
    await storage.put(`/vaults/${device.vault_id}/snapshots/${snapshot.id}.json`, Buffer.from(JSON.stringify(snapshot)), "application/json");
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const current = store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?", device.vault_id)!.head_id;
      if (current !== body.parentId) { store.db.exec("ROLLBACK"); return reply.code(409).send({ error: "Head moved", head: current ? store.getSnapshot(current) : null }); }
      store.run("INSERT INTO snapshots(id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?,?)", snapshot.id, snapshot.vaultId, snapshot.parentId, snapshot.deviceId, snapshot.deviceName, snapshot.createdAt, snapshot.message, JSON.stringify(snapshot));
      store.run("UPDATE vaults SET head_id=? WHERE id=?", snapshot.id, device.vault_id); store.db.exec("COMMIT");
    } catch (error) { try { store.db.exec("ROLLBACK"); } catch {} throw error; }
    return reply.code(201).send(snapshot);
  });

  app.post("/v1/restore/:id", async (request, reply) => {
    const device = await authenticate(request); const id = z.object({id:z.string().uuid()}).parse(request.params).id;
    const source = store.getSnapshot(id); if (!source || source.vaultId !== device.vault_id) return reply.notFound();
    const vault = store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?", device.vault_id)!;
    const restored: Snapshot = { ...source, id: randomUUID(), parentId: vault.head_id, deviceId: device.id, deviceName: device.name, createdAt: new Date().toISOString(), message: `Restore ${id}` };
    await storage.put(`/vaults/${device.vault_id}/snapshots/${restored.id}.json`, Buffer.from(JSON.stringify(restored)), "application/json");
    store.db.exec("BEGIN IMMEDIATE");
    try { store.run("INSERT INTO snapshots(id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?,?)", restored.id,restored.vaultId,restored.parentId,restored.deviceId,restored.deviceName,restored.createdAt,restored.message,JSON.stringify(restored)); store.run("UPDATE vaults SET head_id=? WHERE id=?",restored.id,device.vault_id); store.db.exec("COMMIT"); }
    catch(error){ store.db.exec("ROLLBACK"); throw error; }
    return reply.code(201).send(restored);
  });

  return app;
}
