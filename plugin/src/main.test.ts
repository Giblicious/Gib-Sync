import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
const {setupEntries,claimSetup}=vi.hoisted(()=>({setupEntries:[] as Array<{app:unknown;plugin:unknown;invite:unknown;open:ReturnType<typeof vi.fn>;close:ReturnType<typeof vi.fn>}>,claimSetup:vi.fn()}));
vi.mock("obsidian",()=>({Plugin:class {},Notice:vi.fn(),Menu:class {},TFolder:class {},Platform:{isMobile:false},normalizePath:(s:string)=>s,setIcon:vi.fn(),requestUrl:vi.fn()}));
vi.mock("./ui",()=>({claimQuickCodeSetup:claimSetup,QuickCodeEntryModal:class{open=vi.fn();close:ReturnType<typeof vi.fn>;constructor(public app:unknown,public plugin:unknown,public invite:unknown,closed?:()=>void){this.close=vi.fn(()=>closed?.());setupEntries.push(this);}}}));
import GibSyncPlugin from "./main";
import { ApiError,ApiTransportError } from "./api";
import { SyncSafetyError,type SyncResult } from "./engine";
import { DEFAULT_SETTINGS,initialLiveStatus } from "./settings";
import { Notice } from "obsidian";

const result:SyncResult={uploaded:0,mirrored:0,downloaded:0,deleted:0,prunedFolders:0,pendingRetiredFolders:0,resolved:0,conflicts:0,snapshotId:"accepted",processedPaths:[],fullScan:false};
function fixture(){
  const plugin=new GibSyncPlugin({} as never,{} as never);
  plugin.settings={...structuredClone(DEFAULT_SETTINGS),deviceToken:"test",vaultIdentity:"vault",autoSync:false,syncOnFileChange:false,instantReceive:false,fullScanRequired:false};
  plugin.liveStatus=initialLiveStatus(true);
  plugin.saveSettings=vi.fn(async()=>{});plugin.currentVaultIdentity=()=>"vault";
  plugin.checkObsidianSyncProtection=vi.fn(async()=>false);plugin.refreshServerStatus=vi.fn(async()=>{});
  (plugin as any).checkCompatibility=vi.fn(async()=>true);
  plugin.api={markDeviceReady:vi.fn(async()=>{}),headState:vi.fn(async()=>({headId:"accepted"}))} as any;
  const sync=vi.fn().mockResolvedValue(result);plugin.engine={sync,recordIntent:vi.fn(async()=>{}),verificationPending:0,stop:vi.fn()} as any;
  return {plugin,sync};
}
beforeEach(()=>{vi.useFakeTimers();vi.stubGlobal("window",globalThis);setupEntries.splice(0);claimSetup.mockReset();vi.mocked(Notice).mockClear();vi.spyOn(console,"error").mockImplementation(()=>{});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe("review-only setup URI routing",()=>{
  const params=()=>({action:"gib-sync-setup",server:"https://sync.example.test/canary",code:"12345",expires:String(Date.now()+60_000),vault:"Must not silently select this vault"});
  function unpaired(){const {plugin}=fixture();plugin.settings.deviceToken="";plugin.settings.vaultId="";plugin.acceptSetup=vi.fn(async()=>{});return plugin;}
  it("registers the exact protocol action and opens only a parsed prefilled review modal",()=>{const plugin=unpaired(),register=vi.fn();(plugin as any).registerObsidianProtocolHandler=register;const before=structuredClone(plugin.settings);(plugin as any).registerSetupInviteHandler();expect(register).toHaveBeenCalledWith("gib-sync-setup",expect.any(Function));register.mock.calls[0][1](params());expect(setupEntries).toHaveLength(1);expect(setupEntries[0].invite).toEqual({server:"https://sync.example.test/canary",code:"12345",expiresAt:Date.now()+60_000});expect(setupEntries[0].open).toHaveBeenCalledOnce();expect(claimSetup).not.toHaveBeenCalled();expect(plugin.acceptSetup).not.toHaveBeenCalled();expect(plugin.saveSettings).not.toHaveBeenCalled();expect(plugin.settings).toEqual(before);});
  it.each(["token","vault"])("refuses a vault already paired by %s without even opening the modal",kind=>{const plugin=unpaired();if(kind==="token")plugin.settings.deviceToken="existing-token";else plugin.settings.vaultId="existing-vault";const before=structuredClone(plugin.settings);plugin.openSetupInvite(params());expect(setupEntries).toHaveLength(0);expect(claimSetup).not.toHaveBeenCalled();expect(plugin.saveSettings).not.toHaveBeenCalled();expect(plugin.settings).toEqual(before);expect(Notice).toHaveBeenCalledWith(expect.stringContaining("already connected"));});
  it.each(["expired","malformed","unknown"])("refuses a %s invitation without requests or settings writes",kind=>{const plugin=unpaired(),invite=params() as Record<string,string>;if(kind==="expired")invite.expires=String(Date.now()-1);if(kind==="malformed")invite.server="javascript:alert(1)";if(kind==="unknown")invite.token="not-allowed";plugin.openSetupInvite(invite);expect(setupEntries).toHaveLength(0);expect(claimSetup).not.toHaveBeenCalled();expect(plugin.saveSettings).not.toHaveBeenCalled();});
  it("closes the previous invite before opening another and closes it on unload",()=>{const plugin=unpaired();plugin.openSetupInvite(params());plugin.openSetupInvite({...params(),code:"98765"});expect(setupEntries[0].close).toHaveBeenCalledOnce();expect(setupEntries[1].open).toHaveBeenCalledOnce();vi.stubGlobal("document",{querySelectorAll:()=>[]});plugin.onunload();expect(setupEntries[1].close).toHaveBeenCalledOnce();plugin.openSetupInvite(params());expect(setupEntries).toHaveLength(2);});
  it("refuses claim before network when the vault is paired or the caller already canceled",async()=>{const plugin=unpaired();plugin.settings.deviceToken="existing-token";await expect(plugin.claimQuickCode("https://sync.example.test","12345","Phone")).rejects.toThrow("already connected");plugin.settings.deviceToken="";const controller=new AbortController();controller.abort();await expect(plugin.claimQuickCode("https://sync.example.test","12345","Phone","server-first",controller.signal)).rejects.toThrow("cancelled");expect(claimSetup).not.toHaveBeenCalled();expect(plugin.acceptSetup).not.toHaveBeenCalled();});
  it.each(["cancel","paired","unloaded"])("does not accept a late claim when its context was %s while awaiting approval",async kind=>{const plugin=unpaired(),controller=new AbortController();let finish!:(value:unknown)=>void;claimSetup.mockImplementation(()=>new Promise(resolve=>finish=resolve));const pending=plugin.claimQuickCode("https://sync.example.test","12345","Phone","server-first",controller.signal),rejected=expect(pending).rejects.toThrow(kind==="paired"?"already connected":"cancelled");if(kind==="cancel")controller.abort();if(kind==="paired")plugin.settings.vaultId="another-accepted-vault";if(kind==="unloaded"){vi.stubGlobal("document",{querySelectorAll:()=>[]});plugin.onunload();}finish({vaultId:"not-accepted"});await rejected;expect(plugin.acceptSetup).not.toHaveBeenCalled();});
  it("passes the user's chosen safe onboarding mode and cancellation signal only after explicit claim",async()=>{const plugin=unpaired(),controller=new AbortController(),setup={vaultId:"verified-new-vault"};claimSetup.mockResolvedValue(setup);await plugin.claimQuickCode("https://sync.example.test","12345","Phone","server-first",controller.signal);expect(claimSetup).toHaveBeenCalledWith(plugin,"https://sync.example.test","12345","Phone",controller.signal);expect(plugin.acceptSetup).toHaveBeenCalledWith(setup,"Phone","server-first");});
});

describe("plugin synchronization lifecycle",()=>{
  it("does not discard a held package's baseline and retry witness when runtime reports the same hold",()=>{const {plugin}=fixture(),prior={path:".obsidian/plugins/sample/data.json",hash:"a".repeat(64),size:1,mtime:1,sourcePath:'.gib-sync/package-hold-originals/00000000-0000-4000-8000-000000000001.bin'};plugin.settings.packageHolds.sample={reason:"Temporary",at:1,kind:"activation",attempts:3,retryAt:100000,fingerprint:"b".repeat(64),priorEntries:{[prior.path]:prior}};(plugin as any).recordRuntimeOutcome("sample","Still temporary",true);expect(plugin.settings.packageHolds.sample).toMatchObject({reason:"Still temporary",attempts:3,retryAt:100000,fingerprint:"b".repeat(64),priorEntries:{[prior.path]:prior}});});
  it("keeps truthful green status for protected stale runtime saves but warns on actual component holds",()=>{const {plugin}=fixture();plugin.liveStatus.phase="up-to-date";plugin.liveStatus.message="Up to date";plugin.liveStatus.verified=true;(plugin as any).recordRuntimeOutcome("sample","Old save protected",false);(plugin as any).recordRuntimeOutcome("sample","Old save protected",false);expect(plugin.liveStatus).toMatchObject({phase:"up-to-date",message:"Up to date",verified:true});expect(plugin.settings.packageHolds).toEqual({});expect(plugin.liveStatus.activities.at(-1)).toMatchObject({level:"info",repeats:2});(plugin as any).recordRuntimeOutcome("sample","Package activation held",true);expect(plugin.liveStatus.verified).toBe(false);expect(plugin.settings.packageHolds.sample.reason).toBe("Package activation held");});
  it("retains a newer observed path revision and timestamp after a full sync",async()=>{
    const {plugin,sync}=fixture();(plugin as any).pathVersions.set("note.md",1);(plugin as any).pathRevision=1;plugin.settings.pendingPaths=["note.md"];plugin.settings.pendingPathTimes={"note.md":100};
    sync.mockImplementation(async()=>{plugin.scheduleFileChangeSync("note.md");return {...result,processedPaths:["note.md"],fullScan:true};});
    await expect(plugin.runSync()).resolves.toBe(true);expect(plugin.settings.pendingPaths).toEqual(["note.md"]);expect(plugin.settings.pendingPathTimes["note.md"]).toBeGreaterThan(100);expect(plugin.liveStatus.verified).toBe(false);
  });
  it("retains a newer folder reconciliation request made during an older full sync",async()=>{
    const {plugin,sync}=fixture();plugin.settings.fullScanRequired=false;sync.mockImplementation(async()=>{plugin.requireFullScan();plugin.settings.fullScanRequired=false;return {...result,fullScan:true};});await expect(plugin.runSync()).resolves.toBe(true);expect(plugin.settings.fullScanRequired).toBe(true);expect(plugin.liveStatus.verified).toBe(false);
  });
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
  it("does not begin reconciliation if paused while preflight is awaiting",async()=>{
    const {plugin,sync}=fixture();let ready!:()=>void;(plugin as any).checkCompatibility=vi.fn(()=>new Promise<boolean>(resolve=>{ready=()=>resolve(true);}));plugin.engine.cancel=vi.fn();
    const run=plugin.runSync();await Promise.resolve();await plugin.setPaused(true);ready();await expect(run).resolves.toBe(false);
    expect(plugin.engine.cancel).toHaveBeenCalledTimes(1);expect(sync).not.toHaveBeenCalled();expect(plugin.api.headState).not.toHaveBeenCalled();expect(Notice).not.toHaveBeenCalled();
  });
  it("does not mark an interrupted engine result verified after pause then resume",async()=>{
    const {plugin,sync}=fixture();let finished!:(value:SyncResult)=>void;sync.mockImplementation(()=>new Promise<SyncResult>(resolve=>{finished=resolve;}));plugin.engine.cancel=vi.fn();
    const run=plugin.runSync();await vi.advanceTimersByTimeAsync(0);await plugin.setPaused(true);await plugin.setPaused(false);finished(result);await expect(run).resolves.toBe(false);
    expect(plugin.api.headState).not.toHaveBeenCalled();expect(plugin.api.markDeviceReady).not.toHaveBeenCalled();expect(plugin.liveStatus.lastSuccessAt).toBeNull();expect(Notice).not.toHaveBeenCalled();
  });
  it("stops after unload during the final server verification",async()=>{
    const {plugin}=fixture();let finish!:(value:{headId:string|null})=>void;plugin.api.headState=vi.fn(()=>new Promise<{headId:string|null}>(resolve=>{finish=resolve;}));plugin.engine.cancel=vi.fn();
    vi.stubGlobal("document",{querySelectorAll:()=>[]});const run=plugin.runSync();await vi.advanceTimersByTimeAsync(0);plugin.onunload();finish({headId:"accepted"});await expect(run).resolves.toBe(false);
    expect(plugin.api.markDeviceReady).not.toHaveBeenCalled();expect(plugin.liveStatus.lastSuccessAt).toBeNull();expect(plugin.engine.cancel).toHaveBeenCalledTimes(1);expect(Notice).not.toHaveBeenCalled();
  });
  it("does not reject held changes or start restore while sync owns the device",async()=>{
    const {plugin}=fixture();let ready!:()=>void;(plugin as any).checkCompatibility=vi.fn(()=>new Promise<boolean>(resolve=>{ready=()=>resolve(true);}));plugin.api.rejectQuarantine=vi.fn();plugin.engine.restoreAcceptedSnapshot=vi.fn();
    const run=plugin.runSync();await Promise.resolve();await expect(plugin.rejectAndRestore("held")).rejects.toThrow("current sync finish");expect(plugin.api.rejectQuarantine).not.toHaveBeenCalled();expect(plugin.engine.restoreAcceptedSnapshot).not.toHaveBeenCalled();ready();await run;
  });
  it("reserves recovery before its first await so a timer cannot start sync beside it",async()=>{
    const {plugin,sync}=fixture();let restored!:(value:{downloaded:number;deleted:number;prunedFolders:number})=>void;plugin.api.rejectQuarantine=vi.fn(async()=>({ok:true}));plugin.engine.restoreAcceptedSnapshot=vi.fn(()=>new Promise<{downloaded:number;deleted:number;prunedFolders:number}>(resolve=>{restored=resolve;}));
    const repair=plugin.rejectAndRestore("held"),joined=plugin.runSync();await vi.advanceTimersByTimeAsync(0);expect(sync).not.toHaveBeenCalled();expect(plugin.liveStatus.running).toBe(true);restored({downloaded:1,deleted:0,prunedFolders:0});await repair;await joined;expect(plugin.liveStatus.running).toBe(false);expect(plugin.liveStatus.verified).toBe(false);
  });
  it("keeps explicit chained file moves as one identity-preserving intent",()=>{
    const {plugin}=fixture();(plugin as any).recordRename("A.md","B.md");(plugin as any).recordRename("B.md","Folder/C.md");expect(plugin.settings.pendingMoves).toEqual([{from:"A.md",to:"Folder/C.md",at:Date.now()}]);
  });
  it("journals folder moves without inferring them from changed note content",()=>{
    const {plugin}=fixture();(plugin as any).recordRename("Old folder","New folder");expect(plugin.settings.pendingMoves).toEqual([{from:"Old folder",to:"New folder",at:Date.now()}]);
  });
  it("does not treat sync-owned writes or ignored files as intentional recreation",()=>{
    const {plugin}=fixture();(plugin as any).expectedLocalMutations.set("Remote.md","hash");(plugin as any).recordFileCreation("Remote.md");(plugin as any).recordFileCreation(".obsidian/plugins/gib-sync/data.json");(plugin as any).recordFileCreation("New.md");expect(plugin.settings.fileCreationTimes).toEqual({"New.md":Date.now()});
  });
  it("cannot restart timers after unload",()=>{
    const {plugin}=fixture();vi.stubGlobal("document",{querySelectorAll:()=>[]});plugin.onunload();plugin.settings.autoSync=true;plugin.configureTimer();plugin.configureWatch();(plugin as any).queueSync(1000,"Late background callback");expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the ribbon fallback when an optional native drawer API throws",()=>{
    const {plugin}=fixture();(plugin as any).app={workspace:{rightSplit:{addHeaderButton:()=>{throw new Error("Unsupported native drawer");}}}};vi.stubGlobal("document",{querySelectorAll:()=>[]});expect(()=>(plugin as any).mountNativeMobileSidebarIndicator()).not.toThrow();expect((plugin as any).mobileSidebarEl).toBeNull();
  });
  it("cancels an indicator long-press callback on unload",async()=>{
    const {plugin}=fixture();vi.stubGlobal("document",{querySelectorAll:()=>[]});const late=vi.fn(),timer=window.setTimeout(late,650);(plugin as any).mobileLongPressCancel=()=>window.clearTimeout(timer);plugin.onunload();await vi.advanceTimersByTimeAsync(650);expect(late).not.toHaveBeenCalled();expect(Notice).not.toHaveBeenCalled();
  });
  it("does not journal a late expected-mutation verification after unload",async()=>{
    const {plugin}=fixture();let finish!:(value:null)=>void;(plugin as any).app={vault:{adapter:{stat:vi.fn(()=>new Promise<null>(resolve=>{finish=resolve;}))}}};(plugin as any).expectedLocalMutations.set("Note.md","expected-hash");vi.stubGlobal("document",{querySelectorAll:()=>[]});const verifying=(plugin as any).verifyExpectedMutation("Note.md","expected-hash");plugin.onunload();finish(null);await verifying;expect(plugin.settings.pendingPaths).toEqual([]);expect(plugin.settings.pendingPathTimes).toEqual({});plugin.scheduleFileChangeSync("Late.md");plugin.requireFullScan();expect(plugin.settings.pendingPaths).toEqual([]);expect(vi.getTimerCount()).toBe(0);
  });
});
