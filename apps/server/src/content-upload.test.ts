import { createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { appendFile, open, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { CONTENT_UPLOAD_CHUNK_BYTES, ContentUploads, registerContentUploads, type ContentUploadStorage } from "./content-upload.js";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import type { VaultStorageRow } from "./seafile.js";
import { decryptVaultBlob, sealJson, sha256 } from "./security.js";

type Device = { id: string; vault_id: string; name: string };
const roots: string[] = [], stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) try { store.db.close(); } catch {} for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(maximum = 64 * 1024 * 1024) {
  const root = mkdtempSync(join(tmpdir(), "gib-content-upload-")); roots.push(root);
  const config: Config = { HOST: "127.0.0.1", PORT: 8787, PUBLIC_URL: "https://sync.example.test", DATA_DIR: root, GIBSYNC_SERVER_SECRET: "secret-that-is-at-least-thirty-two-characters", SEAFILE_URL: "https://seafile.example.test", SEAFILE_USERNAME: "test@example.test", SEAFILE_PASSWORD: "password", SEAFILE_LIBRARY: "Notes", MAX_BLOB_BYTES: maximum, GIBSYNC_MIN_CLIENT_VERSION: "0.0.0", GIBSYNC_RECOMMENDED_CLIENT_VERSION: "0.8.61" };
  let store = new Store(root); stores.push(store);
  const key = randomBytes(32).toString("base64url"), vaultId = randomUUID(), device: Device = { id: randomUUID(), vault_id: vaultId, name: "Test device" };
  store.run("INSERT INTO vaults(id,name,wrapped_key,created_at) VALUES(?,?,?,?)", vaultId, "Test vault", sealJson(key, config.GIBSYNC_SERVER_SECRET, vaultId), new Date().toISOString());
  store.run("INSERT INTO devices(id,vault_id,name,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?,?)", device.id, vaultId, device.name, sha256(randomUUID()), new Date().toISOString(), new Date().toISOString());
  const row: VaultStorageRow = { id: vaultId, storage_url: "https://seafile.example.test", storage_username: "test@example.test", storage_repo_id: "repo", storage_repo_name: "Notes", storage_base_path: "/Notes", storage_token: "unused", storage_layout: "readable", mirror_base_path: "/Notes", mirror_head_id: null };
  const files = new Map<string, Buffer>(), storage: ContentUploadStorage & { writes: number; beforePut?: (signal?: AbortSignal) => Promise<void> } = { writes: 0, async putFile(_row, path, localPath, signal) { await this.beforePut?.(signal); if (signal?.aborted) throw signal.reason; this.writes++; files.set(path, await readFile(localPath)); } };
  const options = () => ({ config, store, storage, storageRow: () => row });
  let uploads = new ContentUploads(options());
  const restart = () => { store.db.close(); store = new Store(root); stores.push(store); uploads = new ContentUploads(options()); return { store, uploads }; };
  return { root, config, store, uploads, device, key, files, storage, row, restart, options };
}
async function sendAll(uploads: ContentUploads, device: Device, bytes: Uint8Array) {
  const session = await uploads.begin(device, sha256(bytes), bytes.length);
  for (let offset = session.offset; offset < bytes.length; offset += CONTENT_UPLOAD_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + CONTENT_UPLOAD_CHUNK_BYTES);
    await uploads.chunk(device, session.id, offset / CONTENT_UPLOAD_CHUNK_BYTES, chunk, sha256(chunk));
  }
  return session;
}
const clearPath = (root: string, id: string) => join(root, "incoming-uploads", `${id}.clear`);
const waitTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function waitForComplete(uploads: ContentUploads, device: Device, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) { const state = await uploads.startOrPoll(device, id); if (state.complete) return state; await waitTurn(); }
  throw new Error("Finalizer did not complete within its test budget");
}

describe("durable bounded content uploads", () => {
  it("stores compatible AES-GCM-v1 blobs only after verified completion and retries idempotently", async () => {
    const f = fixture(), clear = randomBytes(CONTENT_UPLOAD_CHUNK_BYTES + 29), hash = sha256(clear), session = await sendAll(f.uploads, f.device, clear);
    expect(f.store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?", f.device.vault_id, hash)).toBeUndefined();
    expect(await f.uploads.complete(f.device, session.id)).toMatchObject({ id: session.id, hash, size: clear.length, offset: clear.length, complete: true });
    const bytes = f.files.get(`blobs/${hash.slice(0, 2)}/${hash}.gbs`)!;
    expect(decryptVaultBlob(bytes, f.key, hash)).toEqual(clear);
    expect(f.store.one<{ size: number }>("SELECT size FROM blobs WHERE vault_id=? AND hash=?", f.device.vault_id, hash)?.size).toBe(clear.length + 29);
    await expect(stat(clearPath(f.root, session.id))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.uploads.complete(f.device, session.id)).toMatchObject({ complete: true });
    expect(await f.uploads.begin(f.device, hash, clear.length)).toMatchObject({ id: session.id, complete: true }); expect(f.storage.writes).toBe(1);
  });
  it("supports empty files without inventing a zero-byte chunk", async () => {
    const f = fixture(), hash = sha256(Buffer.alloc(0)), session = await f.uploads.begin(f.device, hash, 0);
    expect(await f.uploads.complete(f.device, session.id)).toMatchObject({ complete: true, offset: 0 });
    expect(decryptVaultBlob(f.files.get(`blobs/${hash.slice(0, 2)}/${hash}.gbs`)!, f.key, hash)).toEqual(Buffer.alloc(0));
  });
  it("preserves immutable legacy blob registry metadata when uploading an existing content hash", async () => {
    const f = fixture(), clear = Buffer.from("existing content"), hash = sha256(clear), createdAt = "2026-01-02T03:04:05.000Z";
    f.store.run("INSERT INTO blobs(vault_id,hash,size,created_at) VALUES(?,?,?,?)", f.device.vault_id, hash, clear.length, createdAt);
    const session = await sendAll(f.uploads, f.device, clear); expect(await f.uploads.complete(f.device, session.id)).toMatchObject({ complete: true });
    expect(f.store.one<{ size: number; created_at: string }>("SELECT size,created_at FROM blobs WHERE vault_id=? AND hash=?", f.device.vault_id, hash)).toEqual({ size: clear.length, created_at: createdAt });
  });
  it("acknowledges exact chunk retries but rejects changed content and out-of-order chunks", async () => {
    const f = fixture(), bytes = randomBytes(CONTENT_UPLOAD_CHUNK_BYTES * 2), session = await f.uploads.begin(f.device, sha256(bytes), bytes.length), first = bytes.subarray(0, CONTENT_UPLOAD_CHUNK_BYTES), last = bytes.subarray(CONTENT_UPLOAD_CHUNK_BYTES);
    await expect(f.uploads.chunk(f.device, session.id, 1, last, sha256(last))).rejects.toMatchObject({ statusCode: 409 });
    expect(await f.uploads.chunk(f.device, session.id, 0, first, sha256(first))).toEqual({ id: session.id, offset: CONTENT_UPLOAD_CHUNK_BYTES });
    expect(await f.uploads.chunk(f.device, session.id, 0, first, sha256(first))).toEqual({ id: session.id, offset: CONTENT_UPLOAD_CHUNK_BYTES });
    const different = first.slice(); different[0] ^= 1;
    await expect(f.uploads.chunk(f.device, session.id, 0, different, sha256(different))).rejects.toMatchObject({ statusCode: 409 });
    await expect(f.uploads.chunk(f.device, session.id, 1, last, sha256(first))).rejects.toMatchObject({ statusCode: 422 });
    await expect(f.uploads.chunk(f.device, session.id, 1, last.subarray(0, 10), sha256(last.subarray(0, 10)))).rejects.toMatchObject({ statusCode: 422 });
    await expect(f.uploads.complete(f.device, session.id)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("revalidates persisted receipts after restart and removes only unacknowledged tail bytes", async () => {
    const f = fixture(), bytes = randomBytes(CONTENT_UPLOAD_CHUNK_BYTES * 2), session = await f.uploads.begin(f.device, sha256(bytes), bytes.length), first = bytes.subarray(0, CONTENT_UPLOAD_CHUNK_BYTES);
    await f.uploads.chunk(f.device, session.id, 0, first, sha256(first)); await appendFile(clearPath(f.root, session.id), Buffer.from("interrupted unacknowledged write"));
    const { uploads } = f.restart(), resumed = await uploads.begin(f.device, sha256(bytes), bytes.length);
    expect(resumed).toMatchObject({ id: session.id, offset: CONTENT_UPLOAD_CHUNK_BYTES }); expect((await stat(clearPath(f.root, session.id))).size).toBe(CONTENT_UPLOAD_CHUNK_BYTES);
    const last = bytes.subarray(CONTENT_UPLOAD_CHUNK_BYTES); await uploads.chunk(f.device, session.id, 1, last, sha256(last)); expect(await uploads.complete(f.device, session.id)).toMatchObject({ complete: true });
  });
  it("restarts at the first corrupted disk receipt rather than trusting a saved offset", async () => {
    const f = fixture(), clear = randomBytes(CONTENT_UPLOAD_CHUNK_BYTES * 2), session = await sendAll(f.uploads, f.device, clear), handle = await open(clearPath(f.root, session.id), "r+");
    await handle.write(Buffer.from("bad"), 0, 3, CONTENT_UPLOAD_CHUNK_BYTES + 7); await handle.close();
    const { uploads, store } = f.restart();
    expect(await uploads.begin(f.device, sha256(clear), clear.length)).toMatchObject({ offset: CONTENT_UPLOAD_CHUNK_BYTES });
    expect(store.one<{ count: number }>("SELECT COUNT(*) count FROM content_upload_chunks WHERE session_id=?", session.id)?.count).toBe(1);
    expect((await stat(clearPath(f.root, session.id))).size).toBe(CONTENT_UPLOAD_CHUNK_BYTES);
  });
  it("invalidates same-process receipt verification after complete detects changed private bytes", async () => {
    const f = fixture(), clear = randomBytes(CONTENT_UPLOAD_CHUNK_BYTES * 2), session = await sendAll(f.uploads, f.device, clear), handle = await open(clearPath(f.root, session.id), "r+");
    await handle.write(Buffer.from("bad"), 0, 3, CONTENT_UPLOAD_CHUNK_BYTES + 7); await handle.close();
    await expect(f.uploads.complete(f.device, session.id)).rejects.toMatchObject({ statusCode: 422 });
    expect(await f.uploads.begin(f.device, sha256(clear), clear.length)).toMatchObject({ offset: CONTENT_UPLOAD_CHUNK_BYTES });
  });
  it("does not acknowledge fsynced bytes when the receipt transaction fails", async () => {
    const f = fixture(), clear = randomBytes(CONTENT_UPLOAD_CHUNK_BYTES), session = await f.uploads.begin(f.device, sha256(clear), clear.length), original = f.store.run.bind(f.store);
    f.store.run = (sql, ...params) => { if (sql.startsWith("INSERT INTO content_upload_chunks")) throw new Error("receipt interrupted"); return original(sql, ...params); };
    await expect(f.uploads.chunk(f.device, session.id, 0, clear, sha256(clear))).rejects.toThrow("receipt interrupted");
    f.store.run = original;
    expect(await f.uploads.begin(f.device, sha256(clear), clear.length)).toMatchObject({ offset: 0 }); expect((await stat(clearPath(f.root, session.id))).size).toBe(0);
    expect(await f.uploads.chunk(f.device, session.id, 0, clear, sha256(clear))).toMatchObject({ offset: clear.length });
  });
  it("rejects a complete-but-wrong source hash without publishing a blob", async () => {
    const f = fixture(), expected = Buffer.from("expected contents"), wrong = Buffer.from("different content"), session = await f.uploads.begin(f.device, sha256(expected), wrong.length);
    await f.uploads.chunk(f.device, session.id, 0, wrong, sha256(wrong));
    await expect(f.uploads.complete(f.device, session.id)).rejects.toMatchObject({ statusCode: 422 }); expect(f.files.size).toBe(0);
    expect(f.store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?", f.device.vault_id, sha256(expected))).toBeUndefined();
    expect(await readFile(clearPath(f.root, session.id))).toEqual(wrong);
  });
  it("never exposes another device or vault's upload session", async () => {
    const f = fixture(), clear = Buffer.from("private staging"), session = await sendAll(f.uploads, f.device, clear);
    for (const other of [{ ...f.device, id: randomUUID() }, { ...f.device, vault_id: randomUUID() }]) {
      await expect(f.uploads.chunk(other, session.id, 0, clear, sha256(clear))).rejects.toMatchObject({ statusCode: 404 });
      await expect(f.uploads.complete(other, session.id)).rejects.toMatchObject({ statusCode: 404 });
    }
  });
  it("preserves resumable staging after cancellation or lost storage acceptance", async () => {
    const f = fixture(), clear = Buffer.from("must survive interruption"), session = await sendAll(f.uploads, f.device, clear), cancelled = new AbortController(); cancelled.abort(new Error("cancelled"));
    await expect(f.uploads.complete(f.device, session.id, cancelled.signal)).rejects.toThrow("cancelled"); expect(f.files.size).toBe(0);
    f.storage.beforePut = async () => { throw new Error("lost upload response"); };
    await expect(f.uploads.complete(f.device, session.id)).rejects.toThrow("lost upload response");
    expect(f.store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?", f.device.vault_id, sha256(clear))).toBeUndefined(); expect(await readFile(clearPath(f.root, session.id))).toEqual(clear);
    f.storage.beforePut = undefined; expect(await f.uploads.complete(f.device, session.id)).toMatchObject({ complete: true });
  });
  it("does not register bytes after ownership is fenced away during backend transfer", async () => {
    const f = fixture(), clear = Buffer.from("lease ownership"), session = await sendAll(f.uploads, f.device, clear);
    f.storage.beforePut = async () => { f.store.run("UPDATE content_uploads SET lease_owner='different-owner' WHERE id=?", session.id); };
    await expect(f.uploads.complete(f.device, session.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(f.store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?", f.device.vault_id, sha256(clear))).toBeUndefined(); expect(await readFile(clearPath(f.root, session.id))).toEqual(clear);
  });
  it("allows an expired-worker retry while fencing its late acceptance and private cleanup", async () => {
    const f = fixture(), clear = Buffer.from("expired worker data"), session = await sendAll(f.uploads, f.device, clear), second = new ContentUploads(f.options());
    let secondCompleted = false;
    f.storage.beforePut = async () => {
      if (secondCompleted) return;
      secondCompleted = true; f.store.run("UPDATE content_uploads SET lease_until=? WHERE id=?", Date.now() - 1, session.id);
      expect(await second.complete(f.device, session.id)).toMatchObject({ complete: true });
    };
    await expect(f.uploads.complete(f.device, session.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(f.store.one<{ state: string }>("SELECT state FROM content_uploads WHERE id=?", session.id)?.state).toBe("complete");
    const hash = sha256(clear), stored = f.files.get(`blobs/${hash.slice(0, 2)}/${hash}.gbs`)!; expect(decryptVaultBlob(stored, f.key, hash)).toEqual(clear);
    expect(await second.begin(f.device, hash, clear.length)).toMatchObject({ complete: true });
  });
  it("returns processing immediately and bounds background completion to one owned worker", async () => {
    const f = fixture(), clear = Buffer.from("background completion"), first = await sendAll(f.uploads, f.device, clear), second = await sendAll(f.uploads, f.device, Buffer.from("other queued completion"));
    let release!: () => void, started!: () => void; const began = new Promise<void>((resolve) => started = resolve), gate = new Promise<void>((resolve) => release = resolve);
    f.storage.beforePut = async () => { started(); await gate; };
    const state = await f.uploads.startOrPoll(f.device, first.id); expect(state).toMatchObject({ complete: false, processing: true, stage: "verifying" }); expect(state.processingId).toMatch(/^[a-f0-9-]{36}$/);
    await began; expect(await f.uploads.startOrPoll(f.device, first.id)).toMatchObject({ processing: true, processingId: state.processingId, stage: "uploading" });
    expect(await f.uploads.startOrPoll(f.device, second.id)).toMatchObject({ processing: true, stage: "waiting" });
    expect(f.storage.writes).toBe(0); release(); expect(await waitForComplete(f.uploads, f.device, first.id)).toMatchObject({ complete: true });
    expect(await waitForComplete(f.uploads, f.device, second.id)).toMatchObject({ complete: true }); expect(f.storage.writes).toBe(2);
  });
  it("rejects a delayed old cancellation instead of aborting a new processing attempt", async () => {
    const f = fixture(), session = await sendAll(f.uploads, f.device, Buffer.from("attempt-scoped cancellation"));
    const signals: AbortSignal[] = []; let release!: () => void, started!: () => void; let began = new Promise<void>((resolve) => started = resolve);
    f.storage.beforePut = async (signal) => { signals.push(signal!); started(); await new Promise<void>((resolve, reject) => { release = resolve; signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); }); };
    const original = await f.uploads.startOrPoll(f.device, session.id); await began;
    expect(f.uploads.cancel(f.device, session.id, original.processingId!)).toEqual({ id: session.id, cancelled: true });
    began = new Promise<void>((resolve) => started = resolve); let next = original;
    for (let attempt = 0; attempt < 100 && next.processingId === original.processingId; attempt++) { await waitTurn(); next = await f.uploads.startOrPoll(f.device, session.id); }
    expect(next.processingId).not.toBe(original.processingId); await began;
    expect(f.uploads.cancel(f.device, session.id, original.processingId!)).toEqual({ id: session.id, cancelled: false }); expect(signals[1].aborted).toBe(false);
    release(); expect(await waitForComplete(f.uploads, f.device, session.id)).toMatchObject({ complete: true });
  });
  it("aborts and drains a blocked finalizer before its database is closed", async () => {
    const f = fixture(), session = await sendAll(f.uploads, f.device, Buffer.from("shutdown-safe completion")); let started!: () => void; const began = new Promise<void>((resolve) => started = resolve);
    f.storage.beforePut = async (signal) => { started(); await new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })); };
    expect(await f.uploads.startOrPoll(f.device, session.id)).toMatchObject({ processing: true }); await began; await f.uploads.close();
    expect(f.storage.writes).toBe(0); expect(f.store.one<{ state: string }>("SELECT state FROM content_uploads WHERE id=?", session.id)?.state).toBe("receiving"); expect(f.store.one("SELECT 1 FROM blobs WHERE vault_id=?", f.device.vault_id)).toBeUndefined();
    const restarted = new ContentUploads(f.options()); f.storage.beforePut = undefined; expect(await waitForComplete(restarted, f.device, session.id)).toMatchObject({ complete: true }); await restarted.close();
  });
  it("bounds declared sizes and active uploads instead of accepting unlimited private staging", async () => {
    const f = fixture(1024);
    for (const size of [1025, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) await expect(f.uploads.begin(f.device, sha256("note"), size)).rejects.toMatchObject({ statusCode: 422 });
    for (let index = 0; index < 8; index++) await f.uploads.begin(f.device, sha256(`note-${index}`), 100);
    await expect(f.uploads.begin(f.device, sha256("one too many"), 100)).rejects.toMatchObject({ statusCode: 429 });
  });
  it("enforces the per-device quota atomically for concurrent begin requests", async () => {
    const f = fixture(), results = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => f.uploads.begin(f.device, sha256(`concurrent-${index}`), 100)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(8);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ statusCode: 429 });
    expect(f.store.one<{ count: number }>("SELECT COUNT(*) count FROM content_uploads WHERE device_id=?", f.device.id)?.count).toBe(8);
  });
  it("cleans only expired UUID staging and preserves active sessions and unrelated files", async () => {
    const f = fixture(), bytes = Buffer.from("expired session"), old = await sendAll(f.uploads, f.device, bytes), active = await f.uploads.begin(f.device, sha256("active"), 100);
    const unrelated = join(f.root, "incoming-uploads", "unrelated.txt"); await writeFile(unrelated, "do not delete");
    f.store.run("UPDATE content_uploads SET updated_at=? WHERE id=?", Date.now() - 8 * 24 * 60 * 60_000, old.id); await f.uploads.cleanupExpired();
    await expect(stat(clearPath(f.root, old.id))).rejects.toMatchObject({ code: "ENOENT" }); expect(f.store.one("SELECT 1 FROM content_uploads WHERE id=?", old.id)).toBeUndefined();
    expect(f.store.one("SELECT 1 FROM content_uploads WHERE id=?", active.id)).toBeDefined(); expect(await readFile(unrelated, "utf8")).toBe("do not delete");
  });
  it("streams a 32 MiB file through finalization with at most 64 KiB encryption reads", async () => {
    const f = fixture(), chunk = randomBytes(CONTENT_UPLOAD_CHUNK_BYTES), count = 128, digest = createHash("sha256"); for (let index = 0; index < count; index++) digest.update(chunk);
    const hash = digest.digest("hex"), session = await f.uploads.begin(f.device, hash, chunk.length * count);
    for (let index = 0; index < count; index++) await f.uploads.chunk(f.device, session.id, index, chunk, sha256(chunk));
    let largestRead = 0, observedHash = "", clearBytes = 0;
    f.storage.putFile = async (_row, _path, localPath) => {
      const handle = await open(localPath, "r"), size = (await handle.stat()).size, header = Buffer.alloc(13), tag = Buffer.alloc(16); await handle.read(header, 0, 13, 0); await handle.read(tag, 0, 16, size - 16); await handle.close();
      expect(header[0]).toBe(1); const decipher = createDecipheriv("aes-256-gcm", Buffer.from(f.key, "base64url"), header.subarray(1)); decipher.setAAD(Buffer.from(hash)); decipher.setAuthTag(tag); const actual = createHash("sha256");
      for await (const part of createReadStream(localPath, { start: 13, end: size - 17, highWaterMark: 64 * 1024 })) { largestRead = Math.max(largestRead, part.length); const clear = decipher.update(part); clearBytes += clear.length; actual.update(clear); }
      const final = decipher.final(); actual.update(final); clearBytes += final.length; observedHash = actual.digest("hex");
    };
    expect(await f.uploads.complete(f.device, session.id)).toMatchObject({ complete: true }); expect(largestRead).toBeLessThanOrEqual(64 * 1024); expect(clearBytes).toBe(32 * 1024 * 1024); expect(observedHash).toBe(hash);
  });
  it("enforces a chunk parser limit even without a trustworthy Content-Length", async () => {
    const f = fixture(), app = Fastify(); app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    await registerContentUploads(app, { ...f.options(), authenticate: async () => f.device });
    const clear = randomBytes(CONTENT_UPLOAD_CHUNK_BYTES), session = await sendAll(f.uploads, f.device, clear);
    const oversized = await app.inject({ method: "PUT", url: `/v1/content-uploads/${session.id}/chunks/0`, headers: { "content-type": "application/octet-stream", "x-chunk-sha256": sha256(clear) }, payload: Buffer.alloc(CONTENT_UPLOAD_CHUNK_BYTES + 1) });
    expect(oversized.statusCode).toBe(413);
    const resumed = await app.inject({ method: "POST", url: "/v1/content-uploads", payload: { hash: sha256(clear), size: clear.length } }); expect(resumed.statusCode).toBe(200); expect(resumed.json()).toMatchObject({ id: session.id, offset: clear.length }); await app.close();
  });
});
