import { describe,expect,it } from "vitest";
import { mergeText } from "./merge.js";

describe("external text merge",()=>{
  it("combines disjoint Obsidian and Seafile edits",()=>{
    expect(mergeText("a\nb\nc\n","A\nb\nc\n","a\nb\nC\n")).toEqual({text:"A\nb\nC\n",conflicted:false});
  });
  it("marks overlapping edits without discarding either version",()=>{
    const merged=mergeText("base\n","obsidian\n","seafile\n");
    expect(merged.conflicted).toBe(true);expect(merged.text).toContain("obsidian");expect(merged.text).toContain("seafile");
  });
});
