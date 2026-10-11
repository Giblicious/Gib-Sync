import { randomBytes } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { SeafileStorage, type VaultStorageRow } from "./seafile.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(options: { corrupt?: boolean; wrongSize?: boolean; abortAfterUpload?: AbortController } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gib-seafile-upload-")); roots.push(root);
  const staged = join(root, "staged.encrypted"), backend = join(root, "backend.encrypted"), chunk = randomBytes(256 * 1024), source = await open(staged, "wx", 0o600);
  for (let index = 0; index < 8; index++) await source.write(chunk); await source.close();
  const config: Config = { HOST: "127.0.0.1", PORT: 8787, PUBLIC_URL: "https://sync.example.test", DATA_DIR: root, GIBSYNC_SERVER_SECRET: "secret-at-least-thirty-two-characters", SEAFILE_URL: "https://seafile.example.test", SEAFILE_USERNAME: "test@example.test", SEAFILE_PASSWORD: "password", SEAFILE_LIBRARY: "Notes", MAX_BLOB_BYTES: 4 * 1024 * 1024, GIBSYNC_MIN_CLIENT_VERSION: "0.0.0", GIBSYNC_RECOMMENDED_CLIENT_VERSION: "0.8.61" };
  const storage = new SeafileStorage(config), id = "11111111-1111-4111-8111-111111111111", row: VaultStorageRow = { id, storage_url: config.SEAFILE_URL, storage_username: config.SEAFILE_USERNAME, storage_repo_id: "repo", storage_repo_name: "Notes", storage_base_path: "/Notes", storage_token: storage.sealToken(id, "token"), storage_layout: "standard", mirror_base_path: "/Notes", mirror_head_id: null };
  let maximumUploadChunk = 0, uploadedBytes = 0, readbackCount = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "upload.example.test") {
      const form = init?.body as FormData, file = form.get("file") as File;
      expect(file.name).toBe("content.gbs"); expect(form.get("replace")).toBe("1"); expect(file.size).toBe(2 * 1024 * 1024);
      const reader = file.stream().getReader(), output = await open(backend, "wx");
      try { for (;;) { const part = await reader.read(); if (part.done) break; maximumUploadChunk = Math.max(maximumUploadChunk, part.value.byteLength); uploadedBytes += part.value.byteLength; let offset = 0; while (offset < part.value.byteLength) { const written = await output.write(part.value, offset, part.value.byteLength - offset); offset += written.bytesWritten; } } }
      finally { reader.releaseLock(); await output.close(); }
      if (options.corrupt) { const handle = await open(backend, "r+"); const changed = Buffer.from([chunk[0] ^ 1]); await handle.write(changed, 0, 1, 0); await handle.close(); }
      options.abortAfterUpload?.abort(new Error("backend transfer cancelled"));
      return new Response("{}", { status: 200 });
    }
    if (url.hostname === "download.example.test") { readbackCount++; return new Response(Readable.toWeb(createReadStream(backend, { highWaterMark: 64 * 1024 })) as ReadableStream<Uint8Array>, { headers: options.wrongSize ? { "content-length": String(2 * 1024 * 1024 + 1) } : {} }); }
    if (url.pathname.endsWith("/upload-link/")) return Response.json("https://upload.example.test/upload");
    if (url.pathname.endsWith("/file/")) return Response.json("https://download.example.test/content");
    return Response.json([]);
  }));
  return { storage, row, staged, facts: () => ({ maximumUploadChunk, uploadedBytes, readbackCount }) };
}

describe("bounded Seafile staged file transport", () => {
  it("uploads a file-backed Blob and verifies the durable backend copy without whole-file buffers", async () => {
    const f = await fixture(); await f.storage.putFile(f.row, "blobs/ab/content.gbs", f.staged);
    expect(f.facts()).toMatchObject({ uploadedBytes: 2 * 1024 * 1024, readbackCount: 1 }); expect(f.facts().maximumUploadChunk).toBeLessThanOrEqual(64 * 1024);
  });
  it("rejects a successful backend upload whose read-back bytes are corrupt", async () => {
    const f = await fixture({ corrupt: true }); await expect(f.storage.putFile(f.row, "blobs/ab/content.gbs", f.staged)).rejects.toThrow("durable integrity verification");
  });
  it("rejects a wrong backend length before accepting the uploaded blob", async () => {
    const f = await fixture({ wrongSize: true }); await expect(f.storage.putFile(f.row, "blobs/ab/content.gbs", f.staged)).rejects.toThrow("unexpected byte size");
  });
  it("keeps abort cancellation active through upload and durable read-back", async () => {
    const controller = new AbortController(), f = await fixture({ abortAfterUpload: controller });
    await expect(f.storage.putFile(f.row, "blobs/ab/content.gbs", f.staged, controller.signal)).rejects.toThrow("backend transfer cancelled"); expect(f.facts().readbackCount).toBe(0);
  });
});
