import { describe,expect,it } from "vitest";
import type { Plugin } from "obsidian";
import { DEFAULT_SETTINGS,isGibSyncConflictPath,loadSettings,shouldSyncChangedPath } from "./settings";

describe("file-change sync filtering",()=>{
  it("recognizes only timestamped Gib Sync conflict-copy names",()=>{
    expect(isGibSyncConflictPath("Notes/Entry (conflict - Seafile - 2026-07-26 16-46-02 UTC - 2).md")).toBe(true);
    expect(isGibSyncConflictPath("Notes/my conflict notes.md")).toBe(false);
  });
  it("syncs ordinary vault files and normalizes Windows separators",()=>{
    expect(shouldSyncChangedPath("Notes/today.md",DEFAULT_SETTINGS)).toBe(true);
    expect(shouldSyncChangedPath("Notes\\today.md",DEFAULT_SETTINGS)).toBe(true);
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
      mobileSidebarIndicator:true,mobileTopIndicator:false,paused:false
    });
  });
});
