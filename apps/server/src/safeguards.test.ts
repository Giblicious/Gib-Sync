import {describe,expect,it} from "vitest";
import type {ManifestEntry} from "@gib-sync/protocol";
import {assessChanges,BALANCED_POLICY,policyFor} from "./safeguards.js";

const entry=(path:string,hash:string,size=10):ManifestEntry=>({path,hash:hash.padEnd(64,"0"),size,mtime:1});

describe("safeguard assessment",()=>{
  it("recognizes hash-preserving moves instead of destructive delete/create pairs",()=>{
    const result=assessChanges([entry("old/note.md","a")],[entry("new/note.md","a")],BALANCED_POLICY);
    expect(result.assessment).toMatchObject({created:0,deleted:0,moved:1});expect(result.changes[0]).toMatchObject({kind:"moved",previousPath:"old/note.md",path:"new/note.md"});
  });
  it("quarantines mass deletion and unexpectedly empty vaults",()=>{
    const before=Array.from({length:20},(_,index)=>entry(`note-${index}.md`,String(index%10)));
    const result=assessChanges(before,[],BALANCED_POLICY);
    expect(result.assessment.deleted).toBe(20);expect(result.assessment.reasons).toContain("A nonempty vault would become completely empty");
  });
  it("quarantines complete deletion even for a one-file vault",()=>{
    expect(assessChanges([entry("only.md","a")],[],BALANCED_POLICY).assessment.reasons).toContain("A nonempty vault would become completely empty");
  });
  it("allows an ordinary single-file deletion from an older baseline",()=>{
    const result=assessChanges([entry("keep.md","a"),entry("delete.md","b")],[entry("keep.md","a")],BALANCED_POLICY,{staleBaseline:true});
    expect(result.assessment).toMatchObject({deleted:1,reasons:[]});
  });
  it("still guards a meaningful deletion batch from an older baseline",()=>{
    const before=Array.from({length:100},(_,index)=>entry(`note-${index}.md`,String(index%10)));
    const result=assessChanges(before,before.slice(5),BALANCED_POLICY,{staleBaseline:true});
    expect(result.assessment.reasons).toContain("An out-of-date device would delete 5 files");
  });
  it("still guards a concentrated stale deletion in a small vault",()=>{
    const before=Array.from({length:20},(_,index)=>entry(`note-${index}.md`,String(index%10)));
    const result=assessChanges(before,before.slice(3),BALANCED_POLICY,{staleBaseline:true});
    expect(result.assessment.reasons).toContain("An out-of-date device would delete 3 files");
  });
  it("always flags deletion of a protected path",()=>{
    const policy=policyFor("balanced",{protectedPaths:["Critical"]});
    expect(assessChanges([entry("Critical/note.md","a")],[],policy).assessment.reasons).toContain("Protected path Critical would be deleted");
  });
  it("flags high-entropy client signals and ignores percentage growth on tiny notes",()=>{
    const result=assessChanges([entry("note.md","a",10)],[entry("note.md","b",1000)],BALANCED_POLICY,{highEntropyPaths:["note.md"]});
    expect(result.assessment.reasons).toEqual(["1 files resemble encrypted or high-entropy content"]);
  });
  it("allows a large folder move and recognizes edited siblings as moves",()=>{
    const before=Array.from({length:50},(_,index)=>entry(`Old folder/note-${index}.md`,`hash-${index}`,100));
    const after=before.map((item,index)=>({...item,path:item.path.replace("Old folder/","New folder/"),hash:index===0?"edited".padEnd(64,"0"):item.hash,size:index===0?120:item.size}));
    const result=assessChanges(before,after,BALANCED_POLICY);
    expect(result.assessment).toMatchObject({created:0,deleted:0,modified:0,moved:50,totalChanged:50,reasons:[]});
  });
  it("recognizes a routine batch move even when every note changed during relocation",()=>{
    const before=Array.from({length:30},(_,index)=>entry(`Journal/2026-07-${String(index+1).padStart(2,"0")}.md`,`old-${index}`,1000));
    const after=before.map((item,index)=>({...item,path:item.path.replace("Journal/","Archive/Journal/"),hash:`new-${index}`.padEnd(64,"0"),size:item.size+20}));
    const result=assessChanges(before,after,BALANCED_POLICY,{staleBaseline:true});
    expect(result.assessment).toMatchObject({created:0,deleted:0,modified:0,moved:30,totalChanged:30,reasons:[]});
  });
  it("does not disguise unrelated mass deletion and replacement as a move",()=>{
    const before=Array.from({length:30},(_,index)=>entry(`Journal/entry-${index}.md`,`old-${index}`,1000));
    const after=Array.from({length:30},(_,index)=>entry(`Imports/unrelated-${index}.md`,`new-${index}`,1000));
    const result=assessChanges(before,after,BALANCED_POLICY,{staleBaseline:true});
    expect(result.assessment).toMatchObject({created:30,deleted:30,moved:0});expect(result.assessment.reasons.length).toBeGreaterThan(0);
  });
  it("still guards against extreme growth inside a recognized folder move",()=>{
    const before=[entry("Old/large.bin","old",1024*1024),entry("Old/a.md","a"),entry("Old/b.md","b")];
    const after=[entry("New/large.bin","rewritten",60*1024*1024),entry("New/a.md","a"),entry("New/b.md","b")];
    const result=assessChanges(before,after,BALANCED_POLICY);
    expect(result.assessment).toMatchObject({created:0,deleted:0,moved:3});
    expect(result.assessment.reasons).toContain("1 files grew unexpectedly");
    expect(result.assessment.bytesAdded).toBe(59*1024*1024);
  });
  it("allows declared cleanup only for server-recognized device-local plugin data",()=>{
    const caches=Array.from({length:20},(_,index)=>entry(`.obsidian/plugins/gib-search/embeddings/model/chunk-${index}.bin`,String(index%10)));
    const result=assessChanges([entry("note.md","a"),...caches],[entry("note.md","a")],BALANCED_POLICY,{deviceLocalCleanupPaths:caches.map((item)=>item.path),staleBaseline:true});
    expect(result.assessment).toMatchObject({deleted:0,totalChanged:0,reasons:[]});expect(result.changes).toEqual([]);
  });
  it("does not trust cleanup declarations for ordinary user files",()=>{
    const notes=Array.from({length:20},(_,index)=>entry(`Notes/note-${index}.md`,String(index%10)));
    const result=assessChanges(notes,[],BALANCED_POLICY,{deviceLocalCleanupPaths:notes.map((item)=>item.path)});
    expect(result.assessment.deleted).toBe(20);expect(result.assessment.reasons).toContain("20 files would be deleted");
  });
  it("still honors protected paths during recognized device-local cleanup",()=>{
    const path=".obsidian/plugins/demo/cache/index.bin",policy=policyFor("balanced",{protectedPaths:[".obsidian"]});
    const result=assessChanges([entry(path,"a")],[],policy,{deviceLocalCleanupPaths:[path]});
    expect(result.assessment.reasons).toContain("Protected path .obsidian would be deleted");
  });
  it("allows cleanup of legacy Gib Sync conflict artifacts only inside Obsidian system data",()=>{
    const path=".obsidian/app (conflict - Phone - 2026-07-25 12-10-00 UTC).json";
    expect(assessChanges([entry(path,"a")],[],BALANCED_POLICY,{deviceLocalCleanupPaths:[path]}).assessment.reasons).toEqual([]);
    const note="Notes/app (conflict - Phone - 2026-07-25 12-10-00 UTC).md";
    expect(assessChanges([entry(note,"a")],[],BALANCED_POLICY,{deviceLocalCleanupPaths:[note]}).assessment.deleted).toBe(1);
  });
});
