import {describe,expect,it} from "vitest";
import {mergeCommunityPluginEnablement,mergeSystemJson} from "./system-merge";

describe("Obsidian system JSON merge",()=>{
  it("merges native bookmarks and nested groups by unique creation identity",()=>{
    const file=(ctime:number,path:string)=>({ctime,type:"file",path});
    const base={items:[{ctime:1,type:"group",title:"Group",items:[file(2,"existing.md")]}]},
      local={items:[{ctime:1,type:"group",title:"Renamed group",items:[file(2,"existing.md"),file(3,"local.md")]}]},
      remote={items:[{ctime:1,type:"group",title:"Group",items:[file(2,"existing.md"),file(4,"remote.md")]}]};
    const result=mergeSystemJson(JSON.stringify(base),JSON.stringify(local),JSON.stringify(remote),"remote","bookmarks"),items=JSON.parse(result.text).items;
    expect(items[0].title).toBe("Renamed group");expect(items[0].items.map((item:{path:string})=>item.path)).toEqual(["existing.md","remote.md","local.md"]);expect(result.overlaps).toBe(0);
  });
  it("does not infer creation identity for unknown plugin arrays or ambiguous bookmark times",()=>{
    const base='{"items":[]}',local='{"items":[{"ctime":1,"type":"file","path":"a"}]}',remote='{"items":[{"ctime":2,"type":"file","path":"b"}]}';
    expect(JSON.parse(mergeSystemJson(base,local,remote,"remote").text)).toEqual(JSON.parse(remote));
    const ambiguous='{"items":[{"ctime":1,"type":"file","path":"a"},{"ctime":1,"type":"file","path":"b"}]}';
    expect(mergeSystemJson(base,ambiguous,remote,"remote","bookmarks").overlaps).toBe(1);
  });
  it("preserves independent bookmark additions and edits by stable id",()=>{
    const base={items:[{id:"existing",title:"Old"}]},local={items:[{id:"existing",title:"New"},{id:"local",title:"Local"}]},remote={items:[{id:"existing",title:"Old"},{id:"remote",title:"Remote"}]};
    const result=mergeSystemJson(JSON.stringify(base),JSON.stringify(local),JSON.stringify(remote),"remote");
    expect(JSON.parse(result.text)).toEqual({items:[{id:"existing",title:"New"},{id:"remote",title:"Remote"},{id:"local",title:"Local"}]});
    expect(result.overlaps).toBe(0);
  });
  it("retains independent deletions and additions in id collections",()=>{
    const result=mergeSystemJson('{"items":[{"id":"a"},{"id":"b"}]}','{"items":[{"id":"b"}]}','{"items":[{"id":"a"},{"id":"b"},{"id":"c"}]}',"remote");
    expect(JSON.parse(result.text)).toEqual({items:[{id:"b"},{id:"c"}]});
  });
  it("does not guess the identity of repeated records or names",()=>{
    const result=mergeSystemJson('{"items":[]}','{"items":[{"name":"a"}]}','{"items":[{"name":"b"}]}',"remote");
    expect(JSON.parse(result.text)).toEqual({items:[{name:"b"}]});
    expect(result.overlaps).toBe(1);
  });
  it("merges prototype-shaped keys as plain data without prototype mutation",()=>{
    const result=mergeSystemJson('{}','{"__proto__":{"safe":true}}','{"other":1}',"remote");
    expect(JSON.parse(result.text)).toEqual(JSON.parse('{"__proto__":{"safe":true},"other":1}'));
    expect(({} as any).safe).toBeUndefined();
  });
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
