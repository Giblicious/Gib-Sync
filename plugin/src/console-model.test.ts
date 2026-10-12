import {describe,it,expect,vi} from "vitest";
import {ConsoleModel} from "./console-model";
import type {SyncActivity} from "./settings";
const entry=(message:string,at="2026-10-12T00:00:00Z",repeats=1):SyncActivity=>({message,at,repeats,phase:"checking",level:"info"});
describe("incremental live console",()=>{
 it("does no formatting or row replacement on unchanged status ticks",()=>{
  const format=vi.fn(at=>at),model=new ConsoleModel(format),log=[entry("Checking")];
  const first=model.update(log);expect(first.changed).toBe(true);
  for(let i=0;i<100;i++){const next=model.update(log);expect(next.changed).toBe(false);expect(next.rows[0]).toBe(first.rows[0]);}
  expect(format).toHaveBeenCalledTimes(1);
 });
 it("updates only a coalesced row whose timestamp or count changed",()=>{
  const format=vi.fn(at=>at),model=new ConsoleModel(format),log=[entry("First"),entry("Second")];
  const before=model.update(log);log[1]!.repeats=2;
  const after=model.update(log);expect(after.rows[0]).toBe(before.rows[0]);expect(after.rows[1]).not.toBe(before.rows[1]);expect(format).toHaveBeenCalledTimes(2);
  log[1]!.at="2026-10-12T00:01:00Z";model.update(log);expect(format).toHaveBeenCalledTimes(3);
 });
 it("groups nonconsecutive repetitions in latest occurrence order without changing the exported log",()=>{
  const log=[entry("Checking",undefined,2),entry("Scanning"),entry("Checking","2026-10-12T00:02:00Z",3)],model=new ConsoleModel(at=>at);
  const original=JSON.stringify(log),rows=model.update(log).rows;
  expect(rows.map(r=>r.message)).toEqual(["Scanning","Checking · repeated 5 times"]);expect(rows[1]!.at).toBe(log[2]!.at);expect(JSON.stringify(log)).toBe(original);
 });
 it("preserves warning/error records rather than hiding them under matching info messages",()=>{
  const rows=new ConsoleModel(at=>at).update([entry("Retry"),{...entry("Retry"),level:"error"}]).rows;
  expect(rows.map(r=>r.level)).toEqual(["info","error"]);
 });
 it("bounds retention and evicts rows after clearing",()=>{
  const model=new ConsoleModel(at=>at),log=Array.from({length:200},(_,i)=>entry(String(i)));
  expect(model.update(log).rows).toHaveLength(100);expect(model.update([])).toEqual({rows:[],changed:true});expect(model.update([]).changed).toBe(false);
 });
 it("distinguishes embedded delimiters and tolerates invalid timing/count values",()=>{
  const rows=new ConsoleModel().update([entry("a\u0000b","invalid",NaN),entry("a","invalid",-1)]).rows;
  expect(rows).toHaveLength(2);expect(rows.every(r=>r.time===""&&r.repeats===1)).toBe(true);
 });
});
