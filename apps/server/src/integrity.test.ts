import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it } from "vitest";
import type { Snapshot } from "@gib-sync/protocol";
import { Store } from "./db.js";
import { auditHeadIntegrity } from "./integrity.js";

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"gib-sync-integrity-"));roots.push(root);const store=new Store(root),vaultId=randomUUID(),id=randomUUID(),hash="a".repeat(64),now=new Date().toISOString(),snapshot:Snapshot={id,vaultId,parentId:null,deviceId:"device",deviceName:"Device",createdAt:now,message:"Sync",entries:[{path:"note.md",hash,size:1,mtime:1}],folders:[]};store.run("INSERT INTO vaults(id,name,wrapped_key,head_id,created_at) VALUES(?,?,?,?,?)",vaultId,"Vault","wrapped",id,now);store.run("INSERT INTO snapshots(id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?,?)",id,vaultId,null,"device","Device",now,"Sync",JSON.stringify(snapshot));return {store,vaultId,id,hash,snapshot};}
describe("head integrity audit",()=>{
  it("accepts a valid registered current manifest",()=>{const {store,vaultId,id,hash}=fixture();store.run("INSERT INTO blobs(vault_id,hash,size,created_at) VALUES(?,?,?,?)",vaultId,hash,1,new Date().toISOString());expect(auditHeadIntegrity(store,vaultId,id)).toEqual({valid:true,issues:[]});store.db.close();});
  it("fails closed for missing blobs and invalid topology",()=>{const {store,vaultId,id,snapshot}=fixture();snapshot.entries.push({...snapshot.entries[0],path:"Note.md"});store.run("UPDATE snapshots SET manifest_json=? WHERE id=?",JSON.stringify(snapshot),id);const audit=auditHeadIntegrity(store,vaultId,id);expect(audit.valid).toBe(false);expect(audit.issues.join(" ")).toMatch(/case|absent/);store.db.close();});
});
