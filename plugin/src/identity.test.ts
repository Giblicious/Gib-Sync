import {describe,it,expect} from "vitest";
import {detectMoves,type ManifestEntry} from "@gib-sync/protocol";
const entry=(path:string,hash:string,fileId?:string):ManifestEntry=>({path,hash,size:10,mtime:1,fileId});
describe("causal file identity",()=>{
  it("tracks an edited rename by stable identity, not bytes or title",()=>{
    expect(detectMoves([entry("old.md","a","identity")],[entry("new.md","b","identity")],"identity")).toEqual([{previousPath:"old.md",path:"new.md"}]);
  });
  it("never transports an ancestor based only on similar names and sizes",()=>{
    const before=["a","b","c"].map(name=>entry(`old/${name}.md`,`${name}1`)),after=["a","b","c"].map(name=>entry(`new/${name}.md`,`${name}2`));
    expect(detectMoves(before,after,"identity")).toEqual([]);expect(detectMoves(before,after,"assessment")).toHaveLength(3);
  });
  it("does not infer identity from ambiguous duplicate hashes or duplicate ids",()=>{
    expect(detectMoves([entry("a.md","same"),entry("b.md","same")],[entry("c.md","same")],"identity")).toEqual([]);
    expect(detectMoves([entry("a.md","a","id")],[entry("b.md","b","id"),entry("c.md","c","id")],"identity")).toEqual([]);
  });
});
