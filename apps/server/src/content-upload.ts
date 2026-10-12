import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, mkdir, open, opendir, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Store } from "./db.js";
import type { VaultStorageRow } from "./seafile.js";
import { openJson, sha256 } from "./security.js";

export const CONTENT_UPLOAD_CHUNK_BYTES = 256 * 1024;
const IO_BYTES = 64 * 1024;
const LEASE_MS = 30_000;
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
type UploadDevice = { id: string; vault_id: string; name: string };
type SessionRow = { id: string; vault_id: string; device_id: string; hash: string; size: number; offset: number; state: string; created_at: number; updated_at: number; lease_owner: string | null; lease_until: number | null };
type ReceiptRow = { chunk_index: number; offset: number; size: number; hash: string };
export type ContentUploadState = { id: string; hash: string; size: number; offset: number; chunkBytes: number; complete: boolean; processing?: boolean; processingId?: string; stage?: "waiting" | "verifying" | "uploading" | "checking"; processedBytes?: number };
export interface ContentUploadStorage { putFile(row: VaultStorageRow, relativePath: string, localPath: string, signal?: AbortSignal, progress?: (stage: "uploading" | "checking", processedBytes: number) => void): Promise<void> }
type UploadOptions = { config: Config; store: Store; storage: ContentUploadStorage; storageRow: (vaultId: string) => VaultStorageRow };
function fail(statusCode: number, message: string): never { throw Object.assign(new Error(message), { statusCode }); }
const checkSignal = (signal?: AbortSignal) => { if (signal?.aborted) throw signal.reason ?? new Error("Content upload was cancelled"); };

/**
 * Incoming cleartext is private, disposable staging, not accepted vault state.
 * The SQLite receipt advances only after its bytes are fsynced. On restart every
 * acknowledged chunk is rehashed before a resumable offset is returned.
 */
export class ContentUploads {
  private readonly directory: string;
  private readonly verified = new Set<string>();
  private readonly owner = randomUUID();
  private readonly finalizers = new Map<string, { id: string; controller: AbortController; promise: Promise<unknown>; stage: "verifying" | "uploading" | "checking"; processedBytes: number; cancelled: boolean }>();
  private readonly failures = new Map<string, { id: string; error: unknown }>();
  private closing = false;
  constructor(private readonly options: UploadOptions) {
    this.directory = join(options.config.DATA_DIR, "incoming-uploads");
  }
  private path(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail(400, "Invalid upload session");
    return join(this.directory, `${id}.clear`);
  }
  private encryptedPath(id: string, attempt: string): string {
    this.path(id);
    if (!/^[a-f0-9-]{36}$/.test(attempt)) fail(400, "Invalid upload attempt");
    return join(this.directory, `${id}.${attempt}.encrypted`);
  }
  private async privateDirectory(): Promise<void> { await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700); }
  private row(device: UploadDevice, id: string): SessionRow {
    const row = this.options.store.one<SessionRow>("SELECT * FROM content_uploads WHERE id=? AND vault_id=? AND device_id=?", id, device.vault_id, device.id);
    if (!row) fail(404, "Upload session not found");
    return row;
  }
  private result(row: SessionRow): ContentUploadState { return { id: row.id, hash: row.hash, size: row.size, offset: row.offset, chunkBytes: CONTENT_UPLOAD_CHUNK_BYTES, complete: row.state === "complete" }; }
  async close(): Promise<void> {
    this.closing = true;
    const jobs = [...this.finalizers.values()];
    for (const job of jobs) { job.cancelled = true; job.controller.abort(new Error("Server is stopping; upload completion will resume safely")); }
    await Promise.allSettled(jobs.map((job) => job.promise));
  }
  cancel(device: UploadDevice, id: string, processingId: string): { id: string; cancelled: boolean } {
    this.row(device, id); const job = this.finalizers.get(id);
    if (!job || job.id !== processingId) return { id, cancelled: false };
    job.cancelled = true; job.controller.abort(new Error("Content upload completion was paused"));
    if (this.failures.get(id)?.id === processingId) this.failures.delete(id); return { id, cancelled: true };
  }
  async startOrPoll(device: UploadDevice, id: string): Promise<ContentUploadState> {
    if (this.closing) fail(503, "The server is restarting; retry safely");
    const row = this.row(device, id), state = this.result(row);
    if (state.complete) return state;
    const active = this.finalizers.get(id);
    if (active) return { ...state, processing: true, processingId: active.id, stage: active.stage, processedBytes: active.processedBytes };
    if (this.failures.has(id)) { const failure = this.failures.get(id)!; this.failures.delete(id); throw failure.error; }
    if (row.offset !== row.size) fail(409, "Content upload is not complete");
    // One globally bounded streaming finalizer; other sessions poll without
    // creating background promises or buffers. Leases from a stopped process
    // expire within thirty seconds and the next poll resumes receipt checks.
    if (this.finalizers.size || (row.lease_until ?? 0) > Date.now()) return { ...state, processing: true, stage: "waiting", processedBytes: 0 };
    const job = { id: randomUUID(), controller: new AbortController(), promise: Promise.resolve() as Promise<unknown>, stage: "verifying" as "verifying" | "uploading" | "checking", processedBytes: 0, cancelled: false };
    this.finalizers.set(id, job);
    job.promise = Promise.resolve().then(() => this.complete(device, id, job.controller.signal, (stage, bytes) => { job.stage = stage; job.processedBytes = bytes; }))
      .catch((error) => { if (!job.cancelled) this.failures.set(id, { id: job.id, error }); })
      .finally(() => { if (this.finalizers.get(id) === job) this.finalizers.delete(id); });
    return { ...state, processing: true, processingId: job.id, stage: "verifying", processedBytes: 0 };
  }
  private assertLease(id: string): void {
    const lease = this.options.store.one<{ lease_owner: string | null; lease_until: number | null }>("SELECT lease_owner,lease_until FROM content_uploads WHERE id=?", id);
    if (lease?.lease_owner !== this.owner || (lease.lease_until ?? 0) <= Date.now()) fail(409, "Upload ownership changed; retry the session");
  }
  private async exclusive<T>(device: UploadDevice, id: string, operation: (row: SessionRow) => Promise<T>): Promise<T> {
    const row = this.row(device, id), now = Date.now();
    // A lease is deliberately not reentrant: duplicate requests from this same
    // process must not write or finalize the same staging file concurrently.
    const acquired = this.options.store.run("UPDATE content_uploads SET lease_owner=?,lease_until=? WHERE id=? AND (lease_until IS NULL OR lease_until<=?)", this.owner, now + LEASE_MS, row.id, now);
    if (Number(acquired.changes) !== 1) fail(409, "This upload is being processed; retry shortly");
    const renew = setInterval(() => {
      try { this.options.store.run("UPDATE content_uploads SET lease_until=? WHERE id=? AND lease_owner=? AND lease_until>?", Date.now() + LEASE_MS, row.id, this.owner, Date.now()); } catch { /* assertLease prevents later acceptance. */ }
    }, LEASE_MS / 3);
    renew.unref();
    try { return await operation(this.row(device, id)); }
    finally { clearInterval(renew); this.options.store.run("UPDATE content_uploads SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?", row.id, this.owner); }
  }
  private async recover(row: SessionRow): Promise<SessionRow> {
    if (row.state === "complete") return row;
    await this.privateDirectory();
    const handle = await open(this.path(row.id), constants.O_RDWR | constants.O_CREAT | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) fail(409, "Upload staging is not a regular file");
      if (!this.verified.has(row.id) || stats.size < row.offset) {
        const receipts = this.options.store.db.prepare("SELECT chunk_index,offset,size,hash FROM content_upload_chunks WHERE session_id=? ORDER BY chunk_index").iterate(row.id);
        let verifiedOffset = 0, verifiedIndex = 0;
        for (const item of receipts) {
          const receipt = item as ReceiptRow;
          const expectedSize = Math.min(CONTENT_UPLOAD_CHUNK_BYTES, row.size - verifiedOffset);
          if (receipt.chunk_index !== verifiedIndex || receipt.offset !== verifiedOffset || receipt.size !== expectedSize || stats.size < verifiedOffset + receipt.size) break;
          const bytes = Buffer.allocUnsafe(receipt.size), read = await handle.read(bytes, 0, bytes.length, verifiedOffset);
          if (read.bytesRead !== bytes.length || sha256(bytes) !== receipt.hash) break;
          verifiedOffset += bytes.length; verifiedIndex++;
        }
        this.assertLease(row.id);
        this.options.store.db.exec("BEGIN IMMEDIATE");
        try {
          this.options.store.run("DELETE FROM content_upload_chunks WHERE session_id=? AND chunk_index>=?", row.id, verifiedIndex);
          this.options.store.run("UPDATE content_uploads SET offset=?,state='receiving',updated_at=? WHERE id=? AND lease_owner=?", verifiedOffset, Date.now(), row.id, this.owner);
          this.options.store.db.exec("COMMIT");
        } catch (error) { this.options.store.db.exec("ROLLBACK"); throw error; }
        row = { ...row, offset: verifiedOffset, state: "receiving" }; this.verified.add(row.id);
      }
      // Unacknowledged tail bytes can only come from interrupted writes to this
      // UUID-owned staging file. They are not part of accepted content.
      if (stats.size !== row.offset) { await handle.truncate(row.offset); await handle.sync(); }
      return row;
    } finally { await handle.close(); }
  }
  async cleanupExpired(): Promise<void> {
    const rows = this.options.store.all<SessionRow>("SELECT * FROM content_uploads WHERE updated_at<? AND (lease_until IS NULL OR lease_until<=?) LIMIT 64", Date.now() - SESSION_MAX_AGE_MS, Date.now());
    for (const row of rows) {
      const claimed = this.options.store.run("UPDATE content_uploads SET lease_owner=?,lease_until=? WHERE id=? AND updated_at<? AND (lease_until IS NULL OR lease_until<=?)", this.owner, Date.now() + LEASE_MS, row.id, Date.now() - SESSION_MAX_AGE_MS, Date.now());
      if (Number(claimed.changes) !== 1) continue;
      try {
        // UUID-only paths are contained by path(), and each deletion targets a
        // single private session file. Accepted snapshots/blobs are untouched.
        await unlink(this.path(row.id)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        // Each completion uses its own nonce; a fenced worker can never unlink
        // another worker's output. Sweep only recognizable attempts belonging
        // to this expired, leased session, with bounded directory iteration.
        const directory = await opendir(this.directory);
        for await (const entry of directory) if (entry.name.startsWith(`${row.id}.`) && /^[a-f0-9-]{36}\.[a-f0-9-]{36}\.encrypted$/.test(entry.name)) {
          const attempt = entry.name.slice(row.id.length + 1, -".encrypted".length);
          await unlink(this.encryptedPath(row.id, attempt)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        }
        this.assertLease(row.id);
        this.options.store.db.exec("BEGIN IMMEDIATE");
        try {
          this.options.store.run("DELETE FROM content_upload_chunks WHERE session_id=?", row.id);
          this.options.store.run("DELETE FROM content_uploads WHERE id=? AND lease_owner=?", row.id, this.owner);
          this.options.store.db.exec("COMMIT"); this.verified.delete(row.id); this.failures.delete(row.id);
        } catch (error) { this.options.store.db.exec("ROLLBACK"); throw error; }
      } finally { this.options.store.run("UPDATE content_uploads SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?", row.id, this.owner); }
    }
  }
  async begin(device: UploadDevice, hash: string, size: number): Promise<ContentUploadState> {
    if (this.closing) fail(503, "The server is restarting; retry safely");
    if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(size) || size < 0 || size > this.options.config.MAX_BLOB_BYTES) fail(422, "Invalid content hash or byte size");
    await this.privateDirectory(); await this.cleanupExpired();
    const store = this.options.store, now = Date.now();
    let row = store.one<SessionRow>("SELECT * FROM content_uploads WHERE vault_id=? AND device_id=? AND hash=? AND size=?", device.vault_id, device.id, hash, size);
    if (!row) {
      const active = store.one<{ count: number }>("SELECT COUNT(*) count FROM content_uploads WHERE state!='complete' AND updated_at>?", now - SESSION_MAX_AGE_MS)?.count ?? 0;
      const owned = store.one<{ count: number }>("SELECT COUNT(*) count FROM content_uploads WHERE vault_id=? AND device_id=? AND state!='complete' AND updated_at>?", device.vault_id, device.id, now - SESSION_MAX_AGE_MS)?.count ?? 0;
      if (active >= 64 || owned >= 8) fail(429, "Too many active content uploads; finish existing uploads first");
      const disk = await statfs(this.directory), available = disk.bavail * disk.bsize;
      const id = randomUUID();
      store.db.exec("BEGIN IMMEDIATE");
      try {
        // Recompute reservations only after the asynchronous statfs boundary,
        // inside the same transaction as insertion. Already staged cleartext
        // consumes actual free space; each pending file still needs its full
        // encrypted copy, even when the cleartext upload is nearly complete.
        const reserved = store.one<{ bytes: number | null }>("SELECT SUM(size+(size-offset)+29) bytes FROM content_uploads WHERE state!='complete'")?.bytes ?? 0;
        const currentActive = store.one<{ count: number }>("SELECT COUNT(*) count FROM content_uploads WHERE state!='complete' AND updated_at>?", now - SESSION_MAX_AGE_MS)?.count ?? 0;
        const currentOwned = store.one<{ count: number }>("SELECT COUNT(*) count FROM content_uploads WHERE vault_id=? AND device_id=? AND state!='complete' AND updated_at>?", device.vault_id, device.id, now - SESSION_MAX_AGE_MS)?.count ?? 0;
        if (currentActive >= 64 || currentOwned >= 8) fail(429, "Too many active content uploads; finish existing uploads first");
        if (available - reserved < size * 2 + 29 + 64 * 1024 * 1024) fail(507, "Not enough private staging space to safely receive this file");
        store.run("INSERT INTO content_uploads(id,vault_id,device_id,hash,size,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(vault_id,device_id,hash,size) DO NOTHING", id, device.vault_id, device.id, hash, size, now, now);
        store.db.exec("COMMIT");
      } catch (error) { store.db.exec("ROLLBACK"); throw error; }
      row = store.one<SessionRow>("SELECT * FROM content_uploads WHERE vault_id=? AND device_id=? AND hash=? AND size=?", device.vault_id, device.id, hash, size)!;
    }
    const active = this.finalizers.get(row.id);
    if (active) return { ...this.result(row), processing: true, processingId: active.id, stage: active.stage, processedBytes: active.processedBytes };
    return this.exclusive(device, row.id, async (current) => this.result(await this.recover(current)));
  }
  async chunk(device: UploadDevice, id: string, index: number, bytes: Uint8Array, expectedHash: string): Promise<{ id: string; offset: number }> {
    if (this.closing) fail(503, "The server is restarting; retry safely");
    if (!Number.isSafeInteger(index) || index < 0 || !/^[a-f0-9]{64}$/.test(expectedHash) || bytes.byteLength > CONTENT_UPLOAD_CHUNK_BYTES || !bytes.byteLength) fail(422, "Invalid content upload chunk");
    if (sha256(bytes) !== expectedHash) fail(422, "Content upload chunk failed its integrity check");
    return this.exclusive(device, id, async (initial) => {
      const row = await this.recover(initial), offset = index * CONTENT_UPLOAD_CHUNK_BYTES;
      if (!Number.isSafeInteger(offset) || offset >= row.size) fail(409, "Content upload chunk is outside the declared file");
      if (bytes.byteLength !== Math.min(CONTENT_UPLOAD_CHUNK_BYTES, row.size - offset)) fail(422, "Content upload chunk has an invalid byte size");
      if (offset < row.offset) {
        const receipt = this.options.store.one<ReceiptRow>("SELECT chunk_index,offset,size,hash FROM content_upload_chunks WHERE session_id=? AND chunk_index=?", id, index);
        if (!receipt || receipt.hash !== expectedHash || receipt.size !== bytes.byteLength) fail(409, "A different chunk was already acknowledged");
        return { id, offset: row.offset };
      }
      if (row.state === "complete" || offset !== row.offset) fail(409, "Content upload chunks must arrive in order");
      const handle = await open(this.path(id), "r+");
      try {
        let written = 0;
        while (written < bytes.byteLength) { const result = await handle.write(bytes, written, bytes.byteLength - written, offset + written); if (!result.bytesWritten) throw new Error("Content upload chunk write made no progress"); written += result.bytesWritten; }
        await handle.sync(); this.assertLease(id);
        this.options.store.db.exec("BEGIN IMMEDIATE");
        try {
          this.options.store.run("INSERT INTO content_upload_chunks(session_id,chunk_index,offset,size,hash) VALUES(?,?,?,?,?)", id, index, offset, bytes.byteLength, expectedHash);
          this.options.store.run("UPDATE content_uploads SET offset=?,updated_at=? WHERE id=? AND lease_owner=?", offset + bytes.byteLength, Date.now(), id, this.owner);
          this.options.store.db.exec("COMMIT");
        } catch (error) { this.options.store.db.exec("ROLLBACK"); throw error; }
      } finally { await handle.close(); }
      return { id, offset: offset + bytes.byteLength };
    });
  }
  async complete(device: UploadDevice, id: string, signal?: AbortSignal, progress?: (stage: "verifying" | "uploading" | "checking", processedBytes: number) => void): Promise<ContentUploadState> {
    return this.exclusive(device, id, async (initial) => {
      const row = await this.recover(initial);
      if (row.state === "complete") return this.result(row);
      if (row.offset !== row.size) fail(409, "Content upload is not complete");
      checkSignal(signal); this.assertLease(id);
      const vault = this.options.store.one<{ wrapped_key: string }>("SELECT wrapped_key FROM vaults WHERE id=?", device.vault_id);
      if (!vault) fail(404, "Vault not found");
      const key = Buffer.from(openJson<string>(vault.wrapped_key, this.options.config.GIBSYNC_SERVER_SECRET, device.vault_id), "base64url");
      if (key.byteLength !== 32) throw new Error("Vault encryption key is invalid");
      const encryptedPath = this.encryptedPath(id, randomUUID());
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv), digest = createHash("sha256"), output = await open(encryptedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
      cipher.setAAD(Buffer.from(row.hash));
      let received = 0;
      const write = async (bytes: Uint8Array) => { let offset = 0; while (offset < bytes.byteLength) { const written = await output.write(bytes, offset, bytes.byteLength - offset); if (!written.bytesWritten) throw new Error("Encrypted staging write made no progress"); offset += written.bytesWritten; } };
      try {
        await write(Buffer.concat([Buffer.from([1]), iv]));
        for await (const chunk of createReadStream(this.path(id), { highWaterMark: IO_BYTES })) {
          checkSignal(signal); this.assertLease(id); digest.update(chunk); received += chunk.length;
          if (received > row.size) fail(422, "Content upload exceeded its acknowledged size");
          await write(cipher.update(chunk)); progress?.("verifying", received);
        }
        if (received !== row.size || digest.digest("hex") !== row.hash) fail(422, "Complete content upload failed its integrity check");
        await write(cipher.final()); await write(cipher.getAuthTag()); await output.sync();
      } catch (error) { this.verified.delete(id); await output.close(); await unlink(encryptedPath).catch(() => {}); throw error; }
      await output.close();
      try {
        checkSignal(signal); this.assertLease(id);
        // openAsBlob streams immutable encrypted staging in SeafileStorage.
        // A lost response may repeat this content-addressed put safely.
        progress?.("uploading", 0);
        await this.options.storage.putFile(this.options.storageRow(device.vault_id), `blobs/${row.hash.slice(0, 2)}/${row.hash}.gbs`, encryptedPath, signal, progress);
        checkSignal(signal); this.assertLease(id);
        this.options.store.db.exec("BEGIN IMMEDIATE");
        try {
          this.options.store.run("INSERT OR IGNORE INTO blobs(vault_id,hash,size,created_at) VALUES(?,?,?,?)", device.vault_id, row.hash, row.size + 29, new Date().toISOString());
          const integrity=this.options.store.one<{clear_size:number}>("SELECT clear_size FROM blob_integrity WHERE vault_id=? AND hash=?",device.vault_id,row.hash);if(integrity&&integrity.clear_size!==row.size)fail(409,"Verified content size contradicts its immutable hash");
          this.options.store.run("INSERT INTO blob_integrity(vault_id,hash,clear_size,cipher_size,verified_at) VALUES(?,?,?,?,?) ON CONFLICT(vault_id,hash) DO UPDATE SET cipher_size=excluded.cipher_size,verified_at=excluded.verified_at",device.vault_id,row.hash,row.size,row.size+29,new Date().toISOString());
          this.options.store.run("UPDATE content_uploads SET state='complete',updated_at=? WHERE id=? AND lease_owner=?", Date.now(), id, this.owner);
          this.options.store.db.exec("COMMIT");
        } catch (error) { this.options.store.db.exec("ROLLBACK"); throw error; }
        // Clear bytes are disposable only after the durable encrypted blob has
        // been registered. Never recursively remove the staging directory.
        await unlink(this.path(id)).catch(() => {}); this.verified.delete(id);
      } finally { await unlink(encryptedPath).catch(() => {}); }
      return this.result({ ...row, state: "complete" });
    });
  }
}

export async function registerContentUploads(app: FastifyInstance, options: UploadOptions & { authenticate(request: FastifyRequest): Promise<UploadDevice> }): Promise<ContentUploads> {
  const uploads = new ContentUploads(options);
  await app.register(async (routes) => {
    // Encapsulated parser limit applies even to chunked requests without a
    // Content-Length. Existing large-blob endpoints retain their old parser.
    routes.removeContentTypeParser("application/octet-stream");
    routes.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: CONTENT_UPLOAD_CHUNK_BYTES }, (_request, body, done) => done(null, body));
    const params = z.object({ id: z.string().uuid() });
    routes.post("/v1/content-uploads", { bodyLimit: 4096 }, async (request) => {
      const device = await options.authenticate(request), body = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() }).parse(request.body);
      return uploads.begin(device, body.hash, body.size);
    });
    routes.put("/v1/content-uploads/:id/chunks/:index", { bodyLimit: CONTENT_UPLOAD_CHUNK_BYTES }, async (request) => {
      const device = await options.authenticate(request), parsed = params.extend({ index: z.string().regex(/^\d+$/) }).parse(request.params);
      const hash = request.headers["x-chunk-sha256"], bytes = request.body;
      if (typeof hash !== "string" || !(bytes instanceof Uint8Array)) fail(422, "A content chunk and its SHA256 header are required");
      return uploads.chunk(device, parsed.id, Number(parsed.index), bytes, hash);
    });
    routes.post("/v1/content-uploads/:id/complete", { bodyLimit: 4096 }, async (request, reply) => {
      const device = await options.authenticate(request), { id } = params.parse(request.params), state = await uploads.startOrPoll(device, id);
      return reply.code(state.complete ? 200 : 202).send(state);
    });
    routes.post("/v1/content-uploads/:id/cancel", { bodyLimit: 4096 }, async (request) => { const device = await options.authenticate(request), { id } = params.parse(request.params), { processingId } = z.object({ processingId: z.string().uuid() }).parse(request.body); return uploads.cancel(device, id, processingId); });
  });
  return uploads;
}
