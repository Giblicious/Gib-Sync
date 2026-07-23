import { describe,expect,it } from "vitest";
import { DEFAULT_SETTINGS,shouldSyncChangedPath } from "./settings";

describe("file-change sync filtering",()=>{
  it("syncs ordinary vault files and normalizes Windows separators",()=>{
    expect(shouldSyncChangedPath("Notes/today.md",DEFAULT_SETTINGS)).toBe(true);
    expect(shouldSyncChangedPath("Notes\\today.md",DEFAULT_SETTINGS)).toBe(true);
  });

  it("ignores Gib Sync data, Obsidian config, and excluded paths",()=>{
    expect(shouldSyncChangedPath(".gib-sync/state.json",DEFAULT_SETTINGS)).toBe(false);
    expect(shouldSyncChangedPath(".obsidian/workspace.json",DEFAULT_SETTINGS)).toBe(false);
    expect(shouldSyncChangedPath(".trash/deleted.md",DEFAULT_SETTINGS)).toBe(false);
    expect(shouldSyncChangedPath(".githubish/note.md",DEFAULT_SETTINGS)).toBe(true);
  });

  it("allows Obsidian config except the plugin's own excluded directory when enabled",()=>{
    const settings={...DEFAULT_SETTINGS,syncObsidianConfig:true};
    expect(shouldSyncChangedPath(".obsidian/themes/theme.css",settings)).toBe(true);
    expect(shouldSyncChangedPath(".obsidian/plugins/gib-sync/data.json",settings)).toBe(false);
  });
});
