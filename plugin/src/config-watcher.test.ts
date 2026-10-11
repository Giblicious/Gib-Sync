import { describe,expect,it,vi } from "vitest";
import { ConfigWatcher } from "./config-watcher";
import { DEFAULT_SETTINGS } from "./settings";

function fixture(configDir=".obsidian"){
  const settings={...structuredClone(DEFAULT_SETTINGS),deviceToken:"test",configDir,syncPlugins:true,syncObsidianConfig:true},files=new Map<string,{size:number;mtime:number;ctime:number}>(),metadata=new Map<string,string>(),folders=new Set([configDir]),changed=vi.fn(),yieldControl=vi.fn(async()=>{});
  const adapter={exists:vi.fn(async(path:string)=>metadata.has(path)||files.has(path)||folders.has(path)),read:vi.fn(async(path:string)=>metadata.get(path)??""),write:vi.fn(async(path:string,value:string)=>{metadata.set(path,value);}),mkdir:vi.fn(async(path:string)=>{folders.add(path);}),stat:vi.fn(async(path:string)=>{const stamp=files.get(path);return stamp?{type:"file",...stamp}:null;}),list:vi.fn(async(path:string)=>{const nestedFiles=[...files.keys()].filter(file=>file.startsWith(`${path}/`)),childFolders=new Set(nestedFiles.map(file=>file.slice(path.length+1)).filter(file=>file.includes("/")).map(file=>`${path}/${file.split("/")[0]}`));return {files:nestedFiles.filter(file=>!file.slice(path.length+1).includes("/")),folders:[...childFolders]};})};
  const watcher=new ConfigWatcher(adapter as never,()=>settings,changed,yieldControl);return {watcher,adapter,settings,files,metadata,changed,yieldControl};
}

describe("lightweight hidden configuration tracking",()=>{
  it("stats enabled configuration without reading its content or storing credentials",async()=>{
    const {watcher,files,adapter,metadata,settings,changed}=fixture();settings.vaultKey="must-not-be-stored";files.set(".obsidian/bookmarks.json",{size:30,mtime:1,ctime:1});files.set(".obsidian/plugins/sample/data.json",{size:20,mtime:1,ctime:1});await watcher.poll();expect(adapter.read).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();expect([...metadata.values()].join("")).not.toContain("must-not-be-stored");
    files.set(".obsidian/plugins/sample/data.json",{size:21,mtime:2,ctime:1});await watcher.poll();expect(changed).toHaveBeenCalledWith([".obsidian/plugins/sample/data.json"],[]);expect(adapter.read).not.toHaveBeenCalled();
  });
  it("skips volatile workspace files, generated plugin caches and Gib Sync credentials",async()=>{
    const {watcher,files,adapter}=fixture();for(const path of [".obsidian/workspace.json",".obsidian/plugins/gib-sync/data.json",".obsidian/plugins/sample/cache/index.json",".obsidian/core-plugins.json",".obsidian/plugins/sample/data.json"])files.set(path,{size:10,mtime:1,ctime:1});await watcher.poll();
    expect(adapter.stat.mock.calls.map(call=>call[0])).toEqual([".obsidian/plugins/sample/data.json"]);expect(adapter.list.mock.calls.map(call=>call[0])).not.toContain(".obsidian/plugins/gib-sync");expect(adapter.list.mock.calls.map(call=>call[0])).not.toContain(".obsidian/plugins/sample/cache");
  });
  it("handles custom configuration folders and detects creations and deletions",async()=>{
    const {watcher,files,changed}=fixture("settings-local");files.set("settings-local/bookmarks.json",{size:10,mtime:1,ctime:1});await watcher.poll();files.delete("settings-local/bookmarks.json");files.set("settings-local/hotkeys.json",{size:10,mtime:2,ctime:2});await watcher.poll();expect(changed).toHaveBeenCalledWith(["settings-local/bookmarks.json","settings-local/hotkeys.json"],["settings-local/hotkeys.json"]);
  });
  it("compares a persisted index after restart without treating it as content truth",async()=>{
    const {watcher,files,adapter,settings,changed,yieldControl}=fixture();files.set(".obsidian/bookmarks.json",{size:10,mtime:1,ctime:1});await watcher.poll();files.set(".obsidian/bookmarks.json",{size:10,mtime:2,ctime:1});const restarted=new ConfigWatcher(adapter as never,()=>settings,changed,yieldControl);await restarted.poll();expect(adapter.read).toHaveBeenCalledWith(".gib-sync/config-index-v1.json");expect(changed).toHaveBeenCalledWith([".obsidian/bookmarks.json"],[]);
  });
  it("does not interpret a changed filter or disabled plugin sync as deleted remote files",async()=>{
    const {watcher,files,settings,changed}=fixture();files.set(".obsidian/plugins/sample/data.json",{size:10,mtime:1,ctime:1});await watcher.poll();settings.syncPlugins=false;await watcher.poll();expect(changed).not.toHaveBeenCalled();
  });
  it("yields through large plugin inventories and does not write the index again when unchanged",async()=>{
    const {watcher,files,yieldControl,adapter}=fixture();for(let i=0;i<64;i++)files.set(`.obsidian/plugins/plugin-${i}/data.json`,{size:10,mtime:1,ctime:1});await watcher.poll();expect(yieldControl.mock.calls.length).toBeGreaterThan(4);expect(adapter.write).toHaveBeenCalledTimes(1);await watcher.poll();expect(adapter.write).toHaveBeenCalledTimes(1);
  });
  it("stops without publishing a late inventory or persisting new metadata",async()=>{
    const {watcher,files,adapter,changed}=fixture();files.set(".obsidian/bookmarks.json",{size:10,mtime:1,ctime:1});adapter.stat.mockImplementation(async()=>{watcher.stop();return {type:"file",size:10,mtime:1,ctime:1};});await watcher.poll();expect(changed).not.toHaveBeenCalled();expect(adapter.write).not.toHaveBeenCalled();
  });
  it("bounds empty-folder inventories without publishing an incomplete index as deletions",async()=>{
    const {watcher,files,adapter,changed,metadata}=fixture();files.set(".obsidian/bookmarks.json",{size:10,mtime:1,ctime:1});await watcher.poll();const previous=metadata.get(".gib-sync/config-index-v1.json");adapter.list.mockResolvedValue({files:[],folders:Array.from({length:3000},(_,index)=>`.obsidian/folder-${index}`)});await expect(watcher.poll()).rejects.toThrow("too many folders");expect(changed).not.toHaveBeenCalled();expect(adapter.write).toHaveBeenCalledTimes(1);expect(metadata.get(".gib-sync/config-index-v1.json")).toBe(previous);
  });
});
