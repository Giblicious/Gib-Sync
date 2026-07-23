import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { buildApp } from "./app.js";
import type { SeafileStorage } from "./seafile.js";

class MemoryStorage {
  files = new Map<string, Uint8Array>();
  async init() {}
  async put(path: string, bytes: Uint8Array) { this.files.set(path, bytes.slice()); }
  async get(path: string) { const bytes = this.files.get(path); if (!bytes) throw new Error("missing"); return bytes.slice(); }
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gib-sync-")); roots.push(root);
  const config: Config = {
    HOST:"127.0.0.1", PORT:8787, PUBLIC_URL:"https://sync.example.test", DATA_DIR:root,
    GIBSYNC_SETUP_TOKEN:"setup-token-that-is-at-least-24-characters", GIBSYNC_SERVER_SECRET:"server-secret-that-is-at-least-thirty-two-characters",
    SEAFILE_URL:"https://seafile.example.test", SEAFILE_USERNAME:"test@example.test", SEAFILE_PASSWORD:"password", SEAFILE_LIBRARY:"Gib Sync", PAIRING_TTL_SECONDS:300, MAX_BLOB_BYTES:1024*1024
  };
  return { config, store:new Store(root), storage:new MemoryStorage() };
}

describe("Gib Sync API", () => {
  it("enrolls, stores an encrypted blob, commits, pairs, and restores", async () => {
    const {config,store,storage} = fixture(); const app = await buildApp(config, store, storage as unknown as SeafileStorage);
    const setup = await app.inject({method:"POST",url:"/v1/setup",headers:{authorization:`Bearer ${config.GIBSYNC_SETUP_TOKEN}`},payload:{vaultName:"Test",deviceName:"Desktop"}});
    expect(setup.statusCode).toBe(200); const credentials = setup.json(); const auth = {authorization:`Bearer ${credentials.deviceToken}`};
    const hash = "a".repeat(64); const blob = Buffer.from("encrypted-content");
    expect((await app.inject({method:"PUT",url:`/v1/blobs/${hash}`,headers:{...auth,"content-type":"application/octet-stream"},payload:blob})).statusCode).toBe(201);
    const commit = await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Initial",entries:[{path:"note.md",hash,size:7,mtime:1}]}});
    expect(commit.statusCode).toBe(201); expect((await app.inject({method:"GET",url:"/v1/state",headers:auth})).json().head.entries[0].path).toBe("note.md");
    const pairing = (await app.inject({method:"POST",url:"/v1/pairings",headers:auth,payload:{}})).json();
    const claim = await app.inject({method:"POST",url:`/v1/pairings/${pairing.payload.pairingId}/claim`,payload:{secret:pairing.payload.secret,deviceName:"Mobile"}});
    expect(claim.statusCode).toBe(200); expect(claim.json().envelope).toBeTypeOf("string");
    expect((await app.inject({method:"POST",url:`/v1/pairings/${pairing.payload.pairingId}/claim`,payload:{secret:pairing.payload.secret,deviceName:"Other"}})).statusCode).toBe(410);
    expect((await app.inject({method:"POST",url:`/v1/restore/${commit.json().id}`,headers:auth,payload:{}})).statusCode).toBe(201);
    await app.close();
  });
  it("rejects a stale compare-and-swap commit", async () => {
    const {config,store,storage} = fixture(); const app = await buildApp(config, store, storage as unknown as SeafileStorage);
    const credentials = (await app.inject({method:"POST",url:"/v1/setup",headers:{authorization:`Bearer ${config.GIBSYNC_SETUP_TOKEN}`},payload:{vaultName:"Test",deviceName:"A"}})).json();
    const auth = {authorization:`Bearer ${credentials.deviceToken}`};
    const first = await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"One",entries:[]}}); expect(first.statusCode).toBe(201);
    const stale = await app.inject({method:"POST",url:"/v1/commit",headers:auth,payload:{parentId:null,message:"Stale",entries:[]}}); expect(stale.statusCode).toBe(409);
    await app.close();
  });
});
