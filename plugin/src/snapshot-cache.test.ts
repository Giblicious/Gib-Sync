import {describe,expect,it} from "vitest";
import type {DataAdapter} from "obsidian";
import type {Snapshot} from "@gib-sync/protocol";
import {SnapshotCache} from "./snapshot-cache";

function fixture(){
  const files=new Map<string,{text:string;time:number}>();let tick=0;
  const adapter={read:async(path:string)=>{if(!files.has(path))throw new Error("missing");return files.get(path)!.text;},
    write:async(path:string,text:string)=>{files.set(path,{text,time:++tick});},exists:async()=>true,mkdir:async()=>{},
    list:async()=>({files:[...files.keys()],folders:[]}),stat:async(path:string)=>({mtime:files.get(path)?.time??0}),remove:async(path:string)=>{files.delete(path);}} as unknown as DataAdapter;
  const snapshot=(id:string)=>({id,vaultId:"vault",parentId:null,deviceId:"device",deviceName:"Device",message:"test",createdAt:"2026-01-01T00:00:00Z",entries:[]} as Snapshot);
  return {files,adapter,snapshot};
}
describe("snapshot transport cache",()=>{
  it("survives restart without accepting other vault identities",async()=>{
    const {adapter,snapshot}=fixture();await new SnapshotCache(adapter).put(snapshot("one"));
    const restored=new SnapshotCache(adapter);expect(await restored.get("one","vault")).toEqual(snapshot("one"));expect(await restored.get("one","other")).toBeNull();
  });
  it("rejects disk corruption and traversal IDs",async()=>{
    const {files,adapter,snapshot}=fixture();await new SnapshotCache(adapter).put(snapshot("one"));
    const file=files.get(".gib-sync/snapshot-cache/one.json")!;file.text=file.text.replace("Device","Changed");
    const restored=new SnapshotCache(adapter);expect(await restored.get("one","vault")).toBeNull();expect(await restored.get("../one","vault")).toBeNull();
  });
  it("bounds transport cache retention without deleting unrelated files",async()=>{
    const {files,adapter,snapshot}=fixture();files.set(".gib-sync/snapshot-cache/unrelated.txt",{text:"keep",time:0});
    const cache=new SnapshotCache(adapter);for(const id of ["one","two","three","four","five"])await cache.put(snapshot(id));
    expect([...files.keys()].filter(path=>path.endsWith(".json"))).toHaveLength(3);expect(files.has(".gib-sync/snapshot-cache/unrelated.txt")).toBe(true);
  });
});
