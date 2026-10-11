import {afterEach,describe,expect,it,vi} from "vitest";
import type {DataAdapter} from "obsidian";
import {sha256} from "@noble/hashes/sha2.js";
import {bytesToHex} from "@noble/hashes/utils.js";
import {AdapterFileChangedError,hashAdapterFile} from "./file-io";

afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
function readerFixture(size=256*1024){
  const bytes=new Uint8Array(size);bytes.fill(5);let mtime=1,fullReads=0,cancelled=false;
  const adapter={stat:async()=>({type:"file",ctime:1,mtime,size}),getResourcePath:()=>"https://resource.test/file",readBinary:async()=>{fullReads++;return bytes.slice().buffer;}} as unknown as DataAdapter;
  function response(actual=bytes.length){let offset=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){if(offset>=actual){controller.close();return;}controller.enqueue(bytes.subarray(offset,Math.min(actual,offset+64*1024)));offset+=64*1024;},cancel(){cancelled=true;}}));}
  return {bytes,adapter,response,get fullReads(){return fullReads;},get cancelled(){return cancelled;},change(){mtime++;}};
}
describe("native streamed file verification",()=>{
  it("hashes incrementally without full binary reads",async()=>{const f=readerFixture();let yields=0;vi.stubGlobal("fetch",async()=>f.response());const hash=await hashAdapterFile(f.adapter,"file",()=>{},async()=>{yields++;});expect(hash).toBe(bytesToHex(sha256(f.bytes)));expect(f.fullReads).toBe(0);expect(yields).toBe(4);});
  it("rejects a short resource body instead of trusting its hash",async()=>{const f=readerFixture();vi.stubGlobal("fetch",async()=>f.response(f.bytes.length-1));await expect(hashAdapterFile(f.adapter,"file",()=>{},async()=>{})).rejects.toBeInstanceOf(AdapterFileChangedError);expect(f.fullReads).toBe(0);});
  it("rejects metadata changes during streamed verification",async()=>{const f=readerFixture();vi.stubGlobal("fetch",async()=>f.response());await expect(hashAdapterFile(f.adapter,"file",()=>{},async()=>f.change())).rejects.toBeInstanceOf(AdapterFileChangedError);});
  it("cancels the native reader when the operation owner suspends",async()=>{const f=readerFixture();let paused=false;vi.stubGlobal("fetch",async()=>f.response());await expect(hashAdapterFile(f.adapter,"file",()=>{if(paused)throw new Error("paused");},async()=>{paused=true;})).rejects.toThrow("paused");expect(f.cancelled).toBe(true);expect(f.fullReads).toBe(0);});
  it("aborts a pending native read when the owner pauses before a chunk arrives",async()=>{vi.useFakeTimers();const f=readerFixture();let paused=false,cancelled=false,started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});vi.stubGlobal("fetch",async()=>new Response(new ReadableStream<Uint8Array>({pull(){started();},cancel(){cancelled=true;}})));const pending=hashAdapterFile(f.adapter,"file",()=>{if(paused)throw new Error("paused");},async()=>{}),assertion=expect(pending).rejects.toThrow("paused");await began;paused=true;await vi.advanceTimersByTimeAsync(250);await assertion;expect(cancelled).toBe(true);expect(f.fullReads).toBe(0);expect(vi.getTimerCount()).toBe(0);});
  it("supports older adapters when native resource streaming is unavailable",async()=>{const f=readerFixture();vi.stubGlobal("fetch",async()=>{throw new Error("unsupported native URL");});expect(await hashAdapterFile(f.adapter,"file",()=>{},async()=>{})).toBe(bytesToHex(sha256(f.bytes)));expect(f.fullReads).toBe(1);});
});
