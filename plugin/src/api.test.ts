import { afterEach,describe,expect,it,vi } from "vitest";
import { GibSyncApi } from "./api";
import { DEFAULT_SETTINGS } from "./settings";

afterEach(()=>vi.unstubAllGlobals());

describe("large-file transport",()=>{
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
