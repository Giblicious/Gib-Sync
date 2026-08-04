import {describe,expect,it} from "vitest";
import {mergeCommunityPluginEnablement,mergeSystemJson} from "./system-merge";

describe("Obsidian system JSON merge",()=>{
  it("deep-merges independent setting changes without conflict files",()=>{
    const result=mergeSystemJson('{"theme":"old","nested":{"a":1,"b":1}}','{"theme":"dark","nested":{"a":1,"b":1}}','{"theme":"old","nested":{"a":2,"b":1}}',"remote");
    expect(JSON.parse(result.text)).toEqual({theme:"dark",nested:{a:2,b:1}});expect(result.semantic).toBe(true);expect(result.overlaps).toBe(0);
  });
  it("uses the preferred complete value for an overlapping key",()=>{
    const result=mergeSystemJson('{"size":1,"items":[1]}','{"size":2,"items":[1,2]}','{"size":3,"items":[3]}',"remote");
    expect(JSON.parse(result.text)).toEqual({size:3,items:[3]});expect(result.overlaps).toBe(2);
  });
  it("uses last-writer whole-file behavior for invalid JSON",()=>{
    expect(mergeSystemJson("{}","local","remote","local")).toMatchObject({text:"local",semantic:false});
  });
});

describe("community plugin enablement merge",()=>{
  it("does not let mobile disable a desktop-only plugin",()=>{
    const result=mergeCommunityPluginEnablement('["desktop-tool","mobile-tool"]','["mobile-tool"]','["desktop-tool","mobile-tool"]',"local",new Set(["desktop-tool"]),true);
    expect(JSON.parse(result.text)).toEqual(["mobile-tool","desktop-tool"]);expect(result.reason).toContain("desktop-only");
  });
  it("still syncs ordinary plugin toggles from mobile",()=>{
    const result=mergeCommunityPluginEnablement('["desktop-tool","mobile-tool"]','[]','["desktop-tool","mobile-tool"]',"local",new Set(["desktop-tool"]),true);
    expect(JSON.parse(result.text)).toEqual(["desktop-tool"]);
  });
  it("allows desktop to toggle desktop-only plugins normally",()=>{
    const result=mergeCommunityPluginEnablement('["desktop-tool"]','[]','["desktop-tool"]',"local",new Set(["desktop-tool"]),false);
    expect(JSON.parse(result.text)).toEqual([]);
  });
});
