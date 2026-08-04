import {describe,expect,it} from "vitest";
import {mergeSystemJson} from "./system-merge.js";

describe("external Obsidian settings merge",()=>{
  it("combines independent keys without creating a deep conflict file",()=>{
    const merged=mergeSystemJson('{"theme":"old","editor":{"lines":true}}','{"theme":"dark","editor":{"lines":true}}','{"theme":"old","editor":{"lines":false}}',"external");
    expect(JSON.parse(merged)).toEqual({theme:"dark",editor:{lines:false}});
  });
  it("uses the trusted preferred whole value only for the overlapping key",()=>{
    const merged=mergeSystemJson('{"theme":"old","size":1}','{"theme":"local","size":2}','{"theme":"remote","size":3}',"current");
    expect(JSON.parse(merged)).toEqual({theme:"local",size:2});
  });
});
