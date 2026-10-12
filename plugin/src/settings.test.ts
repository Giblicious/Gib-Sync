import { describe,expect,it } from "vitest";
import type { Plugin } from "obsidian";
import { createSerializedSettingsWriter,DEFAULT_SETTINGS,isGibSyncConflictPath,loadSettings,shouldSyncChangedPath } from "./settings";

describe("file-change sync filtering",()=>{
  it("honors physical custom-root exclusions after logical namespace mapping",()=>{const settings={...DEFAULT_SETTINGS,configDir:".obsidian-phone",syncPlugins:true,syncObsidianConfig:true,exclusions:[".obsidian-phone/snippets/private"]};expect(shouldSyncChangedPath(".obsidian/snippets/private/local.css",settings)).toBe(false);expect(shouldSyncChangedPath(".obsidian-phone/snippets/private/local.css",settings)).toBe(false);expect(shouldSyncChangedPath(".obsidian/snippets/shared.css",settings)).toBe(true);});
  it("never treats rooted paths or traversal as vault files",()=>{for(const path of ["../note.md","folder/../../note.md","/outside.md","C:/outside.md","folder//note.md","folder/./note.md","bad\0name"])expect(shouldSyncChangedPath(path,DEFAULT_SETTINGS)).toBe(false);expect(shouldSyncChangedPath("folder/note.md",DEFAULT_SETTINGS)).toBe(true);});
  it("recognizes only timestamped Gib Sync conflict-copy names",()=>{
    expect(isGibSyncConflictPath("Notes/Entry (conflict - Seafile - 2026-07-26 16-46-02 UTC - 2).md")).toBe(true);
    expect(isGibSyncConflictPath("Notes/my conflict notes.md")).toBe(false);
  });
  it("honors custom config folders without ever syncing its own credentials",()=>{
    const settings={...DEFAULT_SETTINGS,configDir:"App Config",syncPlugins:true,syncObsidianConfig:true,exclusions:[]};
    expect(shouldSyncChangedPath("App Config/plugins/gib-sync/data.json",settings)).toBe(false);
    expect(shouldSyncChangedPath("App Config/plugins/gib-sync/main.js",settings)).toBe(false);
    expect(shouldSyncChangedPath("App Config/workspace-mobile.json",settings)).toBe(false);
    expect(shouldSyncChangedPath("App Config/plugins/other/data.json",settings)).toBe(true);
    expect(shouldSyncChangedPath("App Config/bookmarks.json",settings)).toBe(true);
    expect(shouldSyncChangedPath(".obsidian/plugins/gib-sync/data.json",settings)).toBe(false);
    expect(shouldSyncChangedPath("App Config/plugins/other/cache/index.json",settings)).toBe(false);
  });
  it("preserves exclusions and all user preferences during automatic journal migration",async()=>{
    const stored={serverUrl:"https://example.test",syncPlugins:true,paused:true,desktopStatusText:false,exclusions:["Private"],vaultKey:"test-key",deviceToken:"test-token",configDir:"Custom"};
    await expect(loadSettings({loadData:async()=>stored} as unknown as Plugin)).resolves.toMatchObject({...stored,pendingApplyOperations:{},pendingMoves:[],observedFolderSnapshotId:null});
  });
  it("syncs ordinary vault files and normalizes Windows separators",()=>{
    expect(shouldSyncChangedPath("Notes/today.md",DEFAULT_SETTINGS)).toBe(true);
    expect(shouldSyncChangedPath("Notes\\today.md",DEFAULT_SETTINGS)).toBe(true);
  });

  it("syncs Obsidian bookmarks by default without enabling other configuration",()=>{
    expect(DEFAULT_SETTINGS.syncBookmarks).toBe(true);
    expect(shouldSyncChangedPath(".obsidian",DEFAULT_SETTINGS)).toBe(true);
    expect(shouldSyncChangedPath(".obsidian/bookmarks.json",DEFAULT_SETTINGS)).toBe(true);
    expect(shouldSyncChangedPath(".obsidian/app.json",DEFAULT_SETTINGS)).toBe(false);
  });

  it("can disable bookmarks independently even when configuration sync is enabled",()=>{
    const settings={...DEFAULT_SETTINGS,syncBookmarks:false,syncObsidianConfig:true};
    expect(shouldSyncChangedPath(".obsidian/bookmarks.json",settings)).toBe(false);
    expect(shouldSyncChangedPath(".obsidian/app.json",settings)).toBe(true);
  });

  it("ignores Gib Sync data, Obsidian config, and excluded paths",()=>{
    expect(shouldSyncChangedPath(".gib-sync/state.json",DEFAULT_SETTINGS)).toBe(false);
    expect(shouldSyncChangedPath(".obsidian/workspace.json",DEFAULT_SETTINGS)).toBe(false);
    expect(shouldSyncChangedPath(".obsidian/plugins/calendar/main.js",DEFAULT_SETTINGS)).toBe(false);
    expect(shouldSyncChangedPath(".obsidian/community-plugins.json",DEFAULT_SETTINGS)).toBe(false);
    expect(shouldSyncChangedPath(".trash/deleted.md",DEFAULT_SETTINGS)).toBe(false);
    expect(shouldSyncChangedPath(".trash/recovered.md",{...DEFAULT_SETTINGS,exclusions:[]})).toBe(false);
    expect(shouldSyncChangedPath(".githubish/note.md",DEFAULT_SETTINGS)).toBe(true);
  });

  it("separates Obsidian configuration from installed plugins",()=>{
    const settings={...DEFAULT_SETTINGS,syncObsidianConfig:true};
    expect(shouldSyncChangedPath(".obsidian/themes/theme.css",settings)).toBe(true);
    expect(shouldSyncChangedPath(".obsidian/workspace.json",settings)).toBe(false);
    expect(shouldSyncChangedPath(".obsidian/workspace-mobile.json",settings)).toBe(false);
    expect(shouldSyncChangedPath(".obsidian/workspace-tablet.json",settings)).toBe(false);
    expect(shouldSyncChangedPath(".obsidian/core-plugins.json",settings)).toBe(false);
    expect(shouldSyncChangedPath(".obsidian/plugins/calendar/main.js",settings)).toBe(false);
    expect(shouldSyncChangedPath(".obsidian/community-plugins.json",settings)).toBe(false);
  });

  it("syncs plugin code, settings, and enablement without other workspace state",()=>{
    const settings={...DEFAULT_SETTINGS,syncPlugins:true};
    expect(shouldSyncChangedPath(".obsidian",settings)).toBe(true);
    expect(shouldSyncChangedPath(".obsidian/plugins",settings)).toBe(true);
    expect(shouldSyncChangedPath(".obsidian/plugins/calendar/main.js",settings)).toBe(true);
    expect(shouldSyncChangedPath(".obsidian/plugins/calendar/data.json",settings)).toBe(true);
    expect(shouldSyncChangedPath(".obsidian/community-plugins.json",settings)).toBe(true);
    expect(shouldSyncChangedPath(".obsidian/workspace.json",settings)).toBe(false);
    expect(shouldSyncChangedPath(".obsidian/plugins/gib-search/embeddings/model/index.meta.json",settings)).toBe(false);
    expect(shouldSyncChangedPath(".obsidian/plugins/gib-search/models/Xenova/model.onnx",settings)).toBe(true);
    expect(shouldSyncChangedPath(".obsidian/plugins/search-tool/cache/index.json",settings)).toBe(false);
    expect(shouldSyncChangedPath(".obsidian/app (conflict - Phone - 2026-07-25 12-10-00 UTC).json",settings)).toBe(false);
    expect(shouldSyncChangedPath(".obsidian/plugins/search-tool/data.json",settings)).toBe(true);
    expect(shouldSyncChangedPath(".obsidian/plugins/gib-sync/data.json",settings)).toBe(false);
  });

  it("preserves legacy plugin inclusion when upgrading an existing config-sync user",async()=>{
    const plugin={loadData:async()=>({syncObsidianConfig:true})} as unknown as Plugin;
    await expect(loadSettings(plugin)).resolves.toMatchObject({syncObsidianConfig:true,syncPlugins:true,pluginSyncBootstrapPending:true});
  });

  it("pulls accepted plugin state once when upgrading an existing plugin-sync device",async()=>{
    const legacy={loadData:async()=>({syncPlugins:true})} as unknown as Plugin;
    await expect(loadSettings(legacy)).resolves.toMatchObject({syncPlugins:true,pluginSyncBootstrapPending:true});
    const completed={loadData:async()=>({syncPlugins:true,pluginSyncBootstrapPending:false})} as unknown as Plugin;
    await expect(loadSettings(completed)).resolves.toMatchObject({syncPlugins:true,pluginSyncBootstrapPending:false});
  });

  it("adds non-destructive indicator defaults to existing settings",async()=>{
    const plugin={loadData:async()=>({deviceName:"Existing device"})} as unknown as Plugin;
    await expect(loadSettings(plugin)).resolves.toMatchObject({
      deviceName:"Existing device",desktopStatusIcon:true,desktopStatusText:true,
      mobileSidebarIndicator:true,mobileTopIndicator:false,paused:false,syncBookmarks:true
    });
  });

  it("keeps only valid observed folder creation timestamps",async()=>{
    const plugin={loadData:async()=>({folderCreateTimes:{"Intentional empty folder":12345,"Bad folder":"yesterday"}})} as unknown as Plugin;
    await expect(loadSettings(plugin)).resolves.toMatchObject({folderCreateTimes:{"Intentional empty folder":12345}});
  });

  it("retries folder cleanup once when upgrading to topology-aware health",async()=>{
    const oldPlugin={loadData:async()=>({folderCleanupVersion:4,lastFolderCleanupAt:12345,retiredFolderCount:2})} as unknown as Plugin;
    await expect(loadSettings(oldPlugin)).resolves.toMatchObject({folderCleanupVersion:5,lastFolderCleanupAt:0,retiredFolderCount:0});
    const currentPlugin={loadData:async()=>({folderCleanupVersion:5,lastFolderCleanupAt:12345,lastFolderCleanupError:"Blocked: access denied",retiredFolderCount:2,retiredFolderNote:"2 remain"})} as unknown as Plugin;
    await expect(loadSettings(currentPlugin)).resolves.toMatchObject({folderCleanupVersion:5,lastFolderCleanupAt:12345,lastFolderCleanupError:"Blocked: access denied",retiredFolderCount:2,retiredFolderNote:"2 remain"});
  });
});

describe("settings persistence",()=>{
  it("rejects traversal in replay and rename intents",async()=>{const stored={pendingPaths:["../outside.md","good.md"],pendingApplyPaths:["../outside.md","good.md"],pendingMoves:[{from:"good.md",to:"../outside.md",at:1}],pendingApplyPriorHashes:{"../outside.md":"a".repeat(64)},localReconcileBases:{"../outside.md":null}};await expect(loadSettings({loadData:async()=>stored} as unknown as Plugin)).resolves.toMatchObject({pendingPaths:["good.md"],pendingApplyPaths:["good.md"],pendingMoves:[],pendingApplyPriorHashes:{},localReconcileBases:{}});});
  it("rejects apply journal paths outside the internal staging directory",async()=>{
    const operation={targetHash:"a".repeat(64),priorHash:null,stagePath:".gib-sync/apply/"+"a".repeat(64)+".stage",backupPath:".gib-sync/apply/"+"a".repeat(64)+".backup",phase:"staged"};
    const stored={pendingApplyOperations:{"good.md":operation,"unsafe.md":{...operation,backupPath:"Notes/user.md"}}};
    await expect(loadSettings({loadData:async()=>stored} as unknown as Plugin)).resolves.toMatchObject({pendingApplyOperations:{"good.md":operation}});
    const loaded=await loadSettings({loadData:async()=>stored} as unknown as Plugin);expect(loaded.pendingApplyOperations["unsafe.md"]).toBeUndefined();
  });
  it("preserves causal metadata in interrupted replay bases",async()=>{
    const entry={path:"note.md",hash:"a".repeat(64),size:4,mtime:1,fileId:"file-id",revision:{id:"revision-id",parentId:null,deviceId:"device",deviceName:"Phone",modifiedAt:123}};
    await expect(loadSettings({loadData:async()=>({pendingApplyPriorEntries:{"note.md":entry},localReconcileBases:{"note.md":entry}})} as unknown as Plugin)).resolves.toMatchObject({pendingApplyPriorEntries:{"note.md":entry},localReconcileBases:{"note.md":entry}});
  });
  it("loads valid interrupted commit receipts without inventing one for older clients",async()=>{
    const intent={parentId:null,fingerprint:"a".repeat(64),priorHashes:{"note.md":"b".repeat(64),"new.md":null,"invalid":"oops"}};
    await expect(loadSettings({loadData:async()=>({pendingCommit:intent})} as unknown as Plugin)).resolves.toMatchObject({pendingCommit:{...intent,priorHashes:{"note.md":"b".repeat(64),"new.md":null}}});
    await expect(loadSettings({loadData:async()=>({})} as unknown as Plugin)).resolves.toMatchObject({pendingCommit:null});
    await expect(loadSettings({loadData:async()=>({pendingCommit:{...intent,fingerprint:"invalid"}})} as unknown as Plugin)).resolves.toMatchObject({pendingCommit:null});
  });
  it("serializes mobile writes so an older checkpoint cannot finish last",async()=>{
    let state={lastSnapshotId:"old"},releaseFirst!:()=>void,markStarted!:()=>void;const writes:string[]=[];
    const firstGate=new Promise<void>((resolve)=>{releaseFirst=resolve;}),firstStarted=new Promise<void>((resolve)=>{markStarted=resolve;});let calls=0;
    const save=createSerializedSettingsWriter(()=>state,async(snapshot)=>{calls++;if(calls===1){markStarted();await firstGate;}writes.push(snapshot.lastSnapshotId);});
    const older=save();await firstStarted;state={lastSnapshotId:"new"};const newer=save();
    expect(calls).toBe(1);releaseFirst();await Promise.all([older,newer]);
    expect(writes).toEqual(["old","new"]);expect(writes.at(-1)).toBe("new");
  });

  it("continues saving after an earlier storage failure",async()=>{
    let state={value:1},calls=0;const writes:number[]=[];
    const save=createSerializedSettingsWriter(()=>state,async(snapshot)=>{calls++;if(calls===1)throw new Error("temporary failure");writes.push(snapshot.value);});
    await expect(save()).rejects.toThrow("temporary failure");state={value:2};await expect(save()).resolves.toBeUndefined();expect(writes).toEqual([2]);
  });
});
