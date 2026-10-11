import {describe,expect,it} from "vitest";
import {BodyCache} from "./body-cache";

describe("bounded content cache",()=>{
  it("evicts the least recently used body before exceeding its budget",()=>{
    const cache=new BodyCache(6);cache.set("a",new Uint8Array(3));cache.set("b",new Uint8Array(3));cache.get("a");cache.set("c",new Uint8Array(3));
    expect([...cache.keys()]).toEqual(["a","c"]);expect(cache.retainedBytes).toBe(6);
  });
  it("never caches a single body larger than its budget",()=>{
    const cache=new BodyCache(6);cache.set("large",new Uint8Array(7));expect(cache.size).toBe(0);expect(cache.retainedBytes).toBe(0);
  });
  it("keeps accounting correct when replacing and deleting bodies",()=>{
    const cache=new BodyCache(6);cache.set("a",new Uint8Array(3));cache.set("a",new Uint8Array(5));cache.delete("a");expect(cache.retainedBytes).toBe(0);cache.set("b",new Uint8Array(4));cache.clear();expect(cache.retainedBytes).toBe(0);
  });
});
