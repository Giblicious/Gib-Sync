import { describe,expect,it } from "vitest";
import type { Plugin } from "obsidian";
import { createSerializedSettingsWriter,DEFAULT_SETTINGS,isGibSyncConflictPath,loadSettings,shouldSyncChangedPath } from "./settings";

describe("file-change sync filtering",()=>{
  it("recognizes only timestamped Gib Sync conflict-copy names",()=>{
    expect(isGibSyncConflictPath("Notes/Entry (conflict - Seafile - 2026-07-26 16-46-02 UTC - 2).md")).toBe(true);
    expect(isGibSyncConflictPath("Notes/my conflict notes.md")).toBe(false);
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
    await expect(loadSettings(plugin)).resolves.toMatchObject({syncObsidianConfig:true,syncPlugins:true});
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

  it("retries folder cleanup once when upgrading from the timestamp-based implementation",async()=>{
    const oldPlugin={loadData:async()=>({folderCleanupVersion:2,lastFolderCleanupAt:12345})} as unknown as Plugin;
    await expect(loadSettings(oldPlugin)).resolves.toMatchObject({folderCleanupVersion:3,lastFolderCleanupAt:0});
    const currentPlugin={loadData:async()=>({folderCleanupVersion:3,lastFolderCleanupAt:12345,lastFolderCleanupError:"Blocked: access denied"})} as unknown as Plugin;
    await expect(loadSettings(currentPlugin)).resolves.toMatchObject({folderCleanupVersion:3,lastFolderCleanupAt:12345,lastFolderCleanupError:"Blocked: access denied"});
  });
});

describe("settings persistence",()=>{
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
