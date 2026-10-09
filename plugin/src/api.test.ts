import { afterEach,describe,expect,it,vi } from "vitest";
vi.mock("obsidian",()=>({requestUrl:vi.fn()}));
import { requestUrl } from "obsidian";
import { ApiError,ApiTransportError,GibSyncApi } from "./api";
import { DEFAULT_SETTINGS } from "./settings";

afterEach(()=>vi.unstubAllGlobals());

describe("large-file transport",()=>{
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
    const hash="a".repeat(64),body=new Uint8Array([1,2,3]),fetchMock=vi.fn(async()=>new Response(body,{status:200,headers:{"X-Content-SHA256":hash}}));
    vi.stubGlobal("fetch",fetchMock);const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"device-token"};
    await expect(new GibSyncApi(()=>settings).getContent(hash,body.byteLength)).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(`https://sync.test/v1/content/${hash}`,expect.objectContaining({cache:"no-store",headers:expect.objectContaining({Authorization:"Bearer device-token"})}));
  });
  it("rejects a response without the matching verified-content header",async()=>{
    const hash="b".repeat(64);vi.stubGlobal("fetch",vi.fn(async()=>new Response(new Uint8Array([1]),{status:200})));
    const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"device-token"};
    await expect(new GibSyncApi(()=>settings).getContent(hash)).rejects.toThrow("integrity header");
  });
  it("rejects a streamed response that ends before the manifest size",async()=>{
    const hash="c".repeat(64);vi.stubGlobal("fetch",vi.fn(async()=>new Response(new Uint8Array([1,2]),{status:200,headers:{"X-Content-SHA256":hash}})));
    const settings={...DEFAULT_SETTINGS,serverUrl:"https://sync.test",deviceToken:"device-token"};
    await expect(new GibSyncApi(()=>settings).getContent(hash,3)).rejects.toThrow("ended early");
  });
});
