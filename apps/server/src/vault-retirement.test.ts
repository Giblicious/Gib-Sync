import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach,describe,expect,it } from "vitest";
import { Store } from "./db.js";
import { VaultRetirementService } from "./vault-retirement.js";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

describe("VaultRetirementService",()=>{
  it("retires and restores a registration without deleting snapshots or devices",()=>{
    const root=mkdtempSync(join(tmpdir(),"gib-sync-retirement-"));roots.push(root);const store=new Store(root),id=randomUUID(),device=randomUUID(),snapshot=randomUUID(),now=new Date().toISOString();
    store.run("INSERT INTO vaults(id,name,wrapped_key,head_id,created_at) VALUES(?,?,?,?,?)",id,"Legacy","wrapped",snapshot,now);
    store.run("INSERT INTO snapshots(id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?,?)",snapshot,id,null,device,"Phone",now,"Initial",JSON.stringify({id,vaultId:id,parentId:null,deviceId:device,deviceName:"Phone",createdAt:now,message:"Initial",entries:[]}));
    store.run("INSERT INTO devices(id,vault_id,name,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?,?)",device,id,"Phone","token",now,now);
    const service=new VaultRetirementService(store),retired=service.retire(id,"Abandoned duplicate setup");
    expect(retired).toMatchObject({retired:true,reason:"Abandoned duplicate setup"});expect(service.isRetired(id)).toBe(true);
    expect(store.one<{count:number}>("SELECT COUNT(*) count FROM snapshots WHERE vault_id=?",id)?.count).toBe(1);expect(store.one<{count:number}>("SELECT COUNT(*) count FROM devices WHERE vault_id=?",id)?.count).toBe(1);
    expect(service.restore(id,"Reviewed by operator")).toMatchObject({retired:false,retiredAt:null,reason:null});expect(service.isRetired(id)).toBe(false);store.db.close();
  });
});
