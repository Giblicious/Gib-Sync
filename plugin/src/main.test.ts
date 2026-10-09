import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("obsidian",()=>({Plugin:class {},Notice:vi.fn(),Menu:class {},TFolder:class {},Platform:{isMobile:false},normalizePath:(s:string)=>s,setIcon:vi.fn(),requestUrl:vi.fn()}));
vi.mock("./ui",()=>({}));
import GibSyncPlugin from "./main";
import { ApiError,ApiTransportError } from "./api";
import { SyncSafetyError,type SyncResult } from "./engine";
import { DEFAULT_SETTINGS,initialLiveStatus } from "./settings";
import { Notice } from "obsidian";

const result:SyncResult={uploaded:0,mirrored:0,downloaded:0,deleted:0,prunedFolders:0,pendingRetiredFolders:0,resolved:0,conflicts:0,snapshotId:"accepted",processedPaths:[],fullScan:false};
function fixture(){
  const plugin=new GibSyncPlugin({} as never,{} as never);
  plugin.settings={...structuredClone(DEFAULT_SETTINGS),deviceToken:"test",vaultIdentity:"vault",autoSync:false,syncOnFileChange:false,instantReceive:false};
  plugin.liveStatus=initialLiveStatus(true);
  plugin.saveSettings=vi.fn(async()=>{});plugin.currentVaultIdentity=()=>"vault";
  plugin.checkObsidianSyncProtection=vi.fn(async()=>false);plugin.refreshServerStatus=vi.fn(async()=>{});
  (plugin as any).checkCompatibility=vi.fn(async()=>true);
  plugin.api={markDeviceReady:vi.fn(async()=>{}),headState:vi.fn(async()=>({headId:"accepted"}))} as any;
  const sync=vi.fn().mockResolvedValue(result);plugin.engine={sync} as any;
  return {plugin,sync};
}
beforeEach(()=>{vi.useFakeTimers();vi.stubGlobal("window",globalThis);vi.mocked(Notice).mockClear();vi.spyOn(console,"error").mockImplementation(()=>{});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe("plugin synchronization lifecycle",()=>{
  it("joins overlapping requests before async preflight finishes",async()=>{
    const {plugin,sync}=fixture();let ready!:()=>void;
    (plugin as any).checkCompatibility=vi.fn(()=>new Promise<boolean>(resolve=>{ready=()=>resolve(true);}));
    const first=plugin.runSync(),second=plugin.runSync();expect(second).toBe(first);
    await Promise.resolve();ready();await expect(first).resolves.toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);expect(Notice).not.toHaveBeenCalled();
  });
  it("shows retrying without a failed toast then verifies success",async()=>{
    const {plugin,sync}=fixture();sync.mockRejectedValueOnce(new ApiError("Busy",503,null));
    const run=plugin.runSync();await vi.advanceTimersByTimeAsync(0);
    expect(plugin.liveStatus).toMatchObject({phase:"retrying",running:true,verified:false});expect(Notice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);await expect(run).resolves.toBe(true);
    expect(sync).toHaveBeenCalledTimes(2);expect(plugin.liveStatus).toMatchObject({phase:"up-to-date",running:false,verified:true,lastError:""});expect(Notice).not.toHaveBeenCalled();
  });
  it("includes compatibility transport failures in the same recovery cycle",async()=>{
    const {plugin,sync}=fixture();(plugin as any).checkCompatibility=vi.fn().mockRejectedValueOnce(new ApiTransportError(new Error("Disconnected"))).mockResolvedValue(true);
    const run=plugin.runSync();await vi.advanceTimersByTimeAsync(2000);await expect(run).resolves.toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);expect(Notice).not.toHaveBeenCalled();
  });
  it("shows one failure after recovery is exhausted",async()=>{
    const {plugin,sync}=fixture();sync.mockRejectedValue(new ApiError("Busy",503,null));
    const run=plugin.runSync();await vi.advanceTimersByTimeAsync(17000);await expect(run).resolves.toBe(false);
    expect(sync).toHaveBeenCalledTimes(4);expect(plugin.liveStatus.phase).toBe("error");expect(Notice).toHaveBeenCalledTimes(1);
  });
  it("surfaces safety blocks immediately and keeps the blocked state",async()=>{
    const {plugin,sync}=fixture();sync.mockRejectedValue(new SyncSafetyError("Baseline is unavailable"));
    await expect(plugin.runSync()).resolves.toBe(false);
    expect(sync).toHaveBeenCalledTimes(1);expect(plugin.indicatorState()).toMatchObject({key:"blocked",tone:"warning"});expect(Notice).toHaveBeenCalledTimes(1);
  });
  it("does not declare success when the server advances before final verification",async()=>{
    const {plugin,sync}=fixture();vi.mocked(plugin.api.headState).mockResolvedValueOnce({headId:"newer"});
    const run=plugin.runSync();await vi.advanceTimersByTimeAsync(0);
    expect(plugin.liveStatus.phase).toBe("retrying");expect(plugin.liveStatus.lastSuccessAt).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);await expect(run).resolves.toBe(true);expect(sync).toHaveBeenCalledTimes(2);expect(Notice).not.toHaveBeenCalled();
  });
  it("does not turn a successful sync into an error when only its dashboard refresh fails",async()=>{
    const {plugin}=fixture();await plugin.runSync();
    plugin.refreshServerStatus=GibSyncPlugin.prototype.refreshServerStatus;
    plugin.api.status=vi.fn().mockRejectedValue(new ApiTransportError(new Error("Offline")));
    await plugin.refreshServerStatus();expect(plugin.liveStatus.phase).toBe("up-to-date");expect(plugin.liveStatus.activities.at(-1)?.message).toContain("status refresh unavailable");expect(Notice).not.toHaveBeenCalled();
  });
  it("cancels a scheduled recovery when paused",async()=>{
    const {plugin,sync}=fixture();sync.mockRejectedValueOnce(new ApiError("Busy",503,null));
    const run=plugin.runSync();await vi.advanceTimersByTimeAsync(0);plugin.settings.paused=true;
    await vi.advanceTimersByTimeAsync(2000);await expect(run).resolves.toBe(false);
    expect(sync).toHaveBeenCalledTimes(1);expect(plugin.liveStatus.phase).toBe("blocked");expect(Notice).not.toHaveBeenCalled();
  });
});
