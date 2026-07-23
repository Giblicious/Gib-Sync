import { afterEach,describe,expect,it,vi } from "vitest";
import type { Config } from "./config.js";
import { SeafileStorage,type VaultStorageRow } from "./seafile.js";

const config:Config={HOST:"127.0.0.1",PORT:8787,PUBLIC_URL:"https://sync.example.test",DATA_DIR:"/tmp",GIBSYNC_SERVER_SECRET:"server-secret-that-is-at-least-thirty-two-characters",SEAFILE_URL:"https://seafile.example.test",SEAFILE_PUBLIC_URL:"https://seafile.example.test",SEAFILE_USERNAME:"test@example.test",SEAFILE_PASSWORD:"password",SEAFILE_LIBRARY:"Notes",SEAFILE_ALLOWED_HOSTS:"seafile.example.test",PAIRING_TTL_SECONDS:300,MAX_BLOB_BYTES:1024};

afterEach(()=>vi.unstubAllGlobals());

describe("Seafile directories",()=>{
  it("creates each directory once and reuses it",async()=>{
    const directories=new Set<string>();let creates=0;
    vi.stubGlobal("fetch",vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
      const url=new URL(typeof input==="string"||input instanceof URL?input:input.url);const path=url.searchParams.get("p")||"/";
      if(init?.method==="POST"){directories.add(path);creates++;return new Response("{}",{status:201});}
      return directories.has(path)?new Response("[]",{status:200,headers:{"content-type":"application/json"}}):new Response("missing",{status:404});
    }));
    const storage=new SeafileStorage(config);const id="11111111-1111-4111-8111-111111111111";
    const row:VaultStorageRow={id,storage_url:config.SEAFILE_URL,storage_username:config.SEAFILE_USERNAME,storage_repo_id:"repo",storage_repo_name:"Notes",storage_base_path:"/Team/Obsidian",storage_token:storage.sealToken(id,"token"),storage_layout:"standard"};
    await storage.initVault(row);await storage.initVault(row);
    expect([...directories]).toEqual(["/Team","/Team/Obsidian","/Team/Obsidian/.gib-sync"]);expect(creates).toBe(3);
  });
});
