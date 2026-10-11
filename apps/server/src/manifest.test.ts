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
    [[entry("Foo"),entry("foo/bar.md")],[]],
    [[entry("Folder/a.md"),entry("folder/b.md")],[]],
    [[entry("Caf\u00e9"),entry("Cafe\u0301/bar.md")],[]],
    [[entry("file")],["file/child"]],
    [[entry("File")],["file/child"]],
    [[entry("note.md")],["Folder","folder"]]
  ])("rejects non-portable or contradictory topology",(entries,folders)=>expect(()=>canonicalManifest(entries,folders)).toThrow());
});
