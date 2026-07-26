import { describe, expect, it } from "vitest";
import { mergeText } from "./merge";

describe("mergeText", () => {
  it("combines disjoint line edits", () => expect(mergeText("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n", "remote")).toMatchObject({ text: "A\nb\nC\n", kind:"merged", conflicted:false }));
  it("combines different word edits on the same line", () => expect(mergeText("the red fox sleeps", "the blue fox sleeps", "the red fox runs", "remote")).toMatchObject({text:"the blue fox runs",kind:"merged"}));
  it("uses the newer whole word for a small overlap", () => expect(mergeText("the red fox", "the blue fox", "the green fox", "remote")).toMatchObject({text:"the green fox",kind:"small-overlap",conflicted:false}));
  it("classifies a substantial overlapping rewrite as a large conflict", () => {
    const base=Array.from({length:25},(_,index)=>`word${index}`).join(" ");
    expect(mergeText(base,base.replaceAll("word","local"),base.replaceAll("word","remote"),"remote")).toMatchObject({text:base.replaceAll("word","remote"),kind:"large-conflict",conflicted:true});
  });
  it("preserves both versions instead of deeply diffing oversized text",()=>{
    const base="a".repeat(1_400_000),local=`L${base}`,remote=`R${base}`;
    expect(mergeText(base,local,remote,"remote")).toMatchObject({text:remote,kind:"merge-fallback",conflicted:true,reason:expect.stringContaining("too large")});
  });
});
