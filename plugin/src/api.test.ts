import { afterEach,describe,expect,it,vi } from "vitest";
vi.mock("obsidian",()=>({requestUrl:vi.fn()}));
import { requestUrl } from "obsidian";
import { ApiError,ApiTransportError,GibSyncApi } from "./api";
import { DEFAULT_SETTINGS } from "./settings";
import { hashBytes } from "./crypto";
import type {SnapshotCache} from "./snapshot-cache";

afterEach(()=>vi.unstubAllGlobals());

describe("incremental snapshot transport",()=>{
  it("refuses an older server's unconfirmed short code without affecting existing sync",async()=>{const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"token"},api=new GibSyncApi(()=>settings);for(const requiresConfirmation of [undefined,false]){vi.mocked(requestUrl).mockResolvedValueOnce({status:200,json:{code:"12345",expiresAt:new Date(Date.now()+60000).toISOString(),requiresConfirmation}}as any);await expect(api.createPairing()).rejects.toThrow("server must be updated");}vi.mocked(requestUrl).mockResolvedValueOnce({status:200,json:{code:"12345",requiresConfirmation:true}}as any);await expect(api.createPairing()).resolves.toMatchObject({requiresConfirmation:true});expect(settings.deviceToken).toBe("token");});
  it("reconstructs the authenticated head without advancing the device checkpoint",async()=>{
    const entry=(path:string)=>({path,hash:"a".repeat(64),size:1,mtime:1});
    const base={id:"base",vaultId:"vault",entries:[entry("keep.md"),entry("old.md")]};
    const cache={get:vi.fn(async()=>base),put:vi.fn(async()=>{})} as unknown as SnapshotCache;
    const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",vaultId:"vault",deviceToken:"token",lastSnapshotId:"base"};
    vi.mocked(requestUrl).mockResolvedValueOnce({status:200,json:{baseId:"base",snapshot:{id:"next",vaultId:"vault",parentId:"base"},changed:[entry("new.md")],removed:["old.md"]}} as any);
    const result=await new GibSyncApi(()=>settings,cache).state();
    expect(result.head?.entries.map(entry=>entry.path)).toEqual(["keep.md","new.md"]);expect(settings.lastSnapshotId).toBe("base");expect(cache.put).toHaveBeenCalledWith(result.head);
  });
  it("falls back to the old server state endpoint only for unsupported delta or missing base",async()=>{
    const base={id:"base",vaultId:"vault",entries:[]},cache={get:vi.fn(async()=>base),put:vi.fn(async()=>{})} as unknown as SnapshotCache;
    const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",vaultId:"vault",deviceToken:"token",lastSnapshotId:"base"};
    vi.mocked(requestUrl).mockResolvedValueOnce({status:404,json:{error:"Not found"}} as any).mockResolvedValueOnce({status:200,json:{head:null}} as any);
    await expect(new GibSyncApi(()=>settings,cache).state()).resolves.toEqual({head:null});
    vi.mocked(requestUrl).mockResolvedValueOnce({status:401,json:{error:"Unauthorized"}} as any);
    await expect(new GibSyncApi(()=>settings,cache).state()).rejects.toMatchObject({status:401});
  });
});

describe("large-file transport",()=>{
  it("uses only current HTTPS server capability evidence for resumable uploads",async()=>{const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"test"},api=new GibSyncApi(()=>settings);expect(api.supportsStreamUpload()).toBe(false);vi.mocked(requestUrl).mockResolvedValueOnce({status:200,json:{serverCapabilities:["resumable-content-upload-v1"]}} as any);await api.compatibility();expect(api.supportsStreamUpload()).toBe(true);api.disableStreamUpload();expect(api.supportsStreamUpload()).toBe(false);vi.mocked(requestUrl).mockResolvedValueOnce({status:200,json:{serverCapabilities:["resumable-content-upload-v1"]}} as any);await api.compatibility();expect(api.supportsStreamUpload()).toBe(true);settings.serverUrl="https://other.test";expect(api.supportsStreamUpload()).toBe(false);settings.serverUrl="http://sync.test";expect(api.supportsStreamUpload()).toBe(false);});
  it("sends bounded upload chunks with authentication, integrity hash and cancellation signal",async()=>{const body=new Uint8Array([1,2,3]),hash=await hashBytes(body),signal=new AbortController().signal,fetchMock=vi.fn(async()=>new Response(JSON.stringify({id:"session",offset:3}),{status:200,headers:{"Content-Type":"application/json"}}));vi.stubGlobal("fetch",fetchMock);const api=new GibSyncApi(()=>({...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"test-token"}));await expect(api.putContentUploadChunk("session",0,body,hash,signal)).resolves.toEqual({id:"session",offset:3});expect(fetchMock).toHaveBeenCalledWith("https://sync.test/v1/content-uploads/session/chunks/0",expect.objectContaining({method:"PUT",signal,headers:expect.objectContaining({Authorization:"Bearer test-token","X-Chunk-SHA256":hash,"Content-Type":"application/octet-stream"})}));});
  it("preserves an HTML proxy error's HTTP status for automatic recovery",async()=>{
    const response={status:502,get json(){throw new SyntaxError("Unexpected HTML");}};
    vi.mocked(requestUrl).mockResolvedValueOnce(response as any);
    const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"device-token"};
    await expect(new GibSyncApi(()=>settings).compatibility()).rejects.toMatchObject({status:502,message:"Gib Sync request failed (502)"});
  });
  it("preserves safeguard messages and status from JSON errors",async()=>{
    vi.mocked(requestUrl).mockResolvedValueOnce({status:423,json:{message:"Changes need review"}} as any);
    const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"device-token"};
    await expect(new GibSyncApi(()=>settings).state()).rejects.toEqual(new ApiError("Changes need review",423,{message:"Changes need review"}));
  });
  it("classifies a rejected fetch as transport failure without changing integrity failures",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>{throw new TypeError("Failed to fetch");}));
    const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"device-token"};
    await expect(new GibSyncApi(()=>settings).getContent("a".repeat(64))).rejects.toBeInstanceOf(ApiTransportError);
  });
  it("uses a single binary fetch and validates the server integrity header",async()=>{
    const body=new Uint8Array([1,2,3]),hash=await hashBytes(body),fetchMock=vi.fn(async()=>new Response(body,{status:200,headers:{"X-Content-SHA256":hash}}));
    vi.stubGlobal("fetch",fetchMock);const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"device-token"};
    await expect(new GibSyncApi(()=>settings).getContent(hash,body.byteLength)).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(`https://sync.test/v1/content/${hash}`,expect.objectContaining({cache:"no-store",headers:expect.objectContaining({Authorization:"Bearer device-token"})}));
  });
  it("rejects a response without the matching verified-content header",async()=>{
    const hash="b".repeat(64);vi.stubGlobal("fetch",vi.fn(async()=>new Response(new Uint8Array([1]),{status:200})));
    const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"device-token"};
    await expect(new GibSyncApi(()=>settings).getContent(hash)).rejects.toThrow("integrity header");
  });
  it("rejects corrupted bytes even when the server supplied the expected hash header",async()=>{
    const expected=new Uint8Array([1,2,3]),hash=await hashBytes(expected);
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(new Uint8Array([1,2,4]),{status:200,headers:{"X-Content-SHA256":hash}})));
    const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"device-token"};
    await expect(new GibSyncApi(()=>settings).getContent(hash,3)).rejects.toThrow("content integrity");
    await expect(new GibSyncApi(()=>settings).getContent(hash)).rejects.toThrow("content integrity");
  });
  it("rejects a streamed response that ends before the manifest size",async()=>{
    const hash="c".repeat(64);vi.stubGlobal("fetch",vi.fn(async()=>new Response(new Uint8Array([1,2]),{status:200,headers:{"X-Content-SHA256":hash}})));
    const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"device-token"};
    await expect(new GibSyncApi(()=>settings).getContent(hash,3)).rejects.toThrow("ended early");
  });
  it("streams into bounded append chunks without reading a full response buffer",async()=>{
    const bytes=new Uint8Array(3*1024*1024+7).fill(31),hash=await hashBytes(bytes);
    const response=new Response(bytes,{headers:{"X-Content-SHA256":hash}}),arrayBuffer=vi.spyOn(response,"arrayBuffer");
    vi.stubGlobal("fetch",vi.fn(async()=>response));let received=0,maximum=0;
    const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"device-token"};
    await new GibSyncApi(()=>settings).streamContent(hash,bytes.byteLength,async chunk=>{received+=chunk.byteLength;maximum=Math.max(maximum,chunk.byteLength);},()=>{});
    expect(received).toBe(bytes.byteLength);expect(maximum).toBeLessThanOrEqual(64*1024);expect(arrayBuffer).not.toHaveBeenCalled();
  });
  it("never marks a corrupted streamed stage verified",async()=>{
    const bytes=new Uint8Array([1,2,3]),hash=await hashBytes(bytes);
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(new Uint8Array([3,2,1]),{headers:{"X-Content-SHA256":hash}})));
    const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"device-token"};
    await expect(new GibSyncApi(()=>settings).streamContent(hash,3,async()=>{},()=>{})).rejects.toThrow("content integrity");
  });
  it("cancels a response and releases its reader on pause",async()=>{
    let calls=0,cancelled=false;
    const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(65536));},cancel(){cancelled=true;}});
    const response=new Response(stream,{headers:{"X-Content-SHA256":"a".repeat(64)}});
    vi.stubGlobal("fetch",vi.fn(async()=>response));const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"device-token"};
    await expect(new GibSyncApi(()=>settings).streamContent("a".repeat(64),1024*1024,async()=>{calls++;},()=>{if(calls)throw new Error("paused");})).rejects.toThrow("paused");
    expect(cancelled).toBe(true);expect(response.body?.locked).toBe(false);
  });
});
