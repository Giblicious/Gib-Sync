import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it } from "vitest";
import { Store } from "./db.js";
import { SnapshotCommitter } from "./snapshot-commit.js";

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe("atomic snapshot committer",()=>{
  it("canonicalizes and advances exactly one compare-and-swap parent",async()=>{const root=mkdtempSync(join(tmpdir(),"gib-sync-commit-"));roots.push(root);const store=new Store(root),vaultId=randomUUID(),now=new Date().toISOString();store.run("INSERT INTO vaults(id,name,wrapped_key,created_at) VALUES(?,?,?,?)",vaultId,"Vault","wrapped",now);const puts:string[]=[],storage={put:async(_row:unknown,path:string)=>{puts.push(path);}},committer=new SnapshotCommitter(store,storage as never,()=>({} as never)),input={vaultId,parentId:null,deviceId:"device",deviceName:"Device",message:"Sync",entries:[],folders:["B","A","A"]};const first=await committer.accept(input);expect(first?.folders).toEqual(["A","B"]);expect(await committer.accept(input)).toBeNull();expect(puts).toHaveLength(1);expect(store.one<{head_id:string}>("SELECT head_id FROM vaults WHERE id=?",vaultId)?.head_id).toBe(first?.id);store.db.close();});
});
