import { describe,expect,it } from "vitest";
import { canonicalManifest } from "./manifest.js";

const entry=(path:string)=>({path,hash:"a".repeat(64),size:1,mtime:1});
describe("snapshot manifest invariants",()=>{
  it("canonicalizes paths, ordering, duplicate empty folders, and redundant file parents",()=>{
    expect(canonicalManifest([entry("B/note.md"),entry("a.md")],["Empty","Empty","B"]).folders).toEqual(["Empty"]);
  });
  it.each([
    [[entry("../escape.md")],[]],
    [[entry("A"),entry("A/note.md")],[]],
    [[entry("Note.md"),entry("note.md")],[]],
    [[entry("file")],["file/child"]],
    [[entry("note.md")],["Folder","folder"]]
  ])("rejects non-portable or contradictory topology",(entries,folders)=>expect(()=>canonicalManifest(entries,folders)).toThrow());
});
