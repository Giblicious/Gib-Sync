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
    expect(result.assessment.deleted).toBe(20);expect(result.assessment.reasons.join(" ")).toContain("unexpectedly empty");
  });
  it("always flags deletion of a protected path",()=>{
    const policy=policyFor("balanced",{protectedPaths:["Critical"]});
    expect(assessChanges([entry("Critical/note.md","a")],[],policy).assessment.reasons).toContain("Protected path Critical would be deleted");
  });
  it("flags high-entropy client signals and ignores percentage growth on tiny notes",()=>{
    const result=assessChanges([entry("note.md","a",10)],[entry("note.md","b",1000)],BALANCED_POLICY,{highEntropyPaths:["note.md"]});
    expect(result.assessment.reasons).toEqual(["1 files resemble encrypted or high-entropy content"]);
  });
});
