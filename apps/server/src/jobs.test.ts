import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it } from "vitest";
import { Store } from "./db.js";
import { DurableMirrorJobs } from "./jobs.js";
import { takeRequestBudget } from "./request-budget.js";

const roots:string[]=[],stores:Store[]=[];afterEach(()=>{for(const store of stores.splice(0))try{store.db.close();}catch{}for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"gib-sync-jobs-"));roots.push(root);const store=new Store(root);stores.push(store);const id=randomUUID();store.run("INSERT INTO vaults(id,name,wrapped_key,created_at) VALUES(?,?,?,?)",id,"Test","wrapped",new Date().toISOString());return {root,store,id,jobs:new DurableMirrorJobs(store)};}
describe("durable background work",()=>{
  it("persists queued work across reopen without altering accepted heads",()=>{const {root,store,id,jobs}=fixture();jobs.enqueue(id);store.db.close();const reopened=new Store(root);stores.push(reopened);expect(new DurableMirrorJobs(reopened).claim(id)).not.toBeNull();expect(reopened.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",id)?.head_id).toBeNull();});
  it("has one owner, recovers expired leases, and does not lose a newer enqueue",()=>{const {store,id,jobs}=fixture();jobs.enqueue(id);const lease=jobs.claim(id)!;expect(jobs.claim(id)).toBeNull();jobs.enqueue(id);jobs.finish(lease);const newer=jobs.claim(id)!;expect(newer).not.toBeNull();store.run("UPDATE mirror_jobs SET lease_until=0 WHERE vault_id=?",id);const recovered=jobs.claim(id)!;expect(recovered.owner).not.toBe(newer.owner);jobs.finish(newer);expect(store.one<{lease_owner:string}>("SELECT lease_owner FROM mirror_jobs WHERE vault_id=?",id)?.lease_owner).toBe(recovered.owner);jobs.finish(recovered);expect(jobs.pending()).toEqual([]);});
  it("retains bounded retry facts instead of user paths or secrets",()=>{const {id,jobs,store}=fixture();jobs.enqueue(id);const lease=jobs.claim(id)!;jobs.retry(lease,new Error("private content must not be logged"),0);expect(store.one<{attempts:number;last_error:string}>("SELECT attempts,last_error FROM mirror_jobs WHERE vault_id=?",id)).toMatchObject({attempts:1,last_error:"Error"});expect(jobs.claim(id)).not.toBeNull();});
  it("blocks valid guesses after the budget is exhausted and keeps counters across restarts",()=>{const {root,store}=fixture();for(let index=0;index<5;index++)expect(takeRequestBudget(store,"quick-code","client",5,60_000,1000)).toBe(true);expect(takeRequestBudget(store,"quick-code","client",5,60_000,1001)).toBe(false);store.db.close();const reopened=new Store(root);stores.push(reopened);expect(takeRequestBudget(reopened,"quick-code","client",5,60_000,1002)).toBe(false);expect(takeRequestBudget(reopened,"quick-code","client",5,60_000,60_001)).toBe(true);});
});
