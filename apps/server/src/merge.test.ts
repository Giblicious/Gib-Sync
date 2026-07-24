import { describe,expect,it } from "vitest";
import { mergeText } from "./merge.js";

describe("external text merge",()=>{
  it("combines disjoint Obsidian and Seafile edits",()=>{
    expect(mergeText("a\nb\nc\n","A\nb\nc\n","a\nb\nC\n","external")).toMatchObject({text:"A\nb\nC\n",kind:"merged",conflicted:false});
  });
  it("keeps the newer whole word for a small overlap",()=>{
    expect(mergeText("a quick note\n","a local note\n","a remote note\n","external")).toMatchObject({text:"a remote note\n",kind:"small-overlap",conflicted:false});
  });
  it("marks a multi-line overlapping rewrite as a large conflict",()=>{
    const merged=mergeText("one\ntwo\nthree\n","local one\nlocal two\nlocal three\n","remote one\nremote two\nremote three\n","external");
    expect(merged).toMatchObject({kind:"large-conflict",conflicted:true});
  });
});
