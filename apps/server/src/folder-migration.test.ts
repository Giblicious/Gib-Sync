import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach,describe,expect,it } from "vitest";
import type { Snapshot } from "@gib-sync/protocol";
import { Store } from "./db.js";
import { repairUnsafeLegacyFolderHeads } from "./folder-migration.js";

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"gib-sync-folder-migration-"));roots.push(root);const store=new Store(root),vaultId=randomUUID(),parentId=randomUUID(),headId=randomUUID(),now=new Date().toISOString();store.run("INSERT INTO vaults(id,name,wrapped_key,head_id,created_at) VALUES(?,?,?,?,?)",vaultId,"Vault","wrapped",headId,now);const parent:Snapshot={id:parentId,vaultId,parentId:null,deviceId:"desktop",deviceName:"Desktop",createdAt:now,message:"Legacy",entries:[]};const head:Snapshot={...parent,id:headId,parentId,deviceId:`seafile:${vaultId}`,deviceName:"Seafile",message:"Seafile external change (0 changed, 0 deleted, 4 folders)",folders:["A","B","C","D"]};for(const snapshot of [parent,head])store.run("INSERT INTO snapshots(id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?,?)",snapshot.id,vaultId,snapshot.parentId,snapshot.deviceId,snapshot.deviceName,snapshot.createdAt,snapshot.message,JSON.stringify(snapshot));return {store,vaultId,parentId,headId};}

describe("legacy folder migration repair",()=>{
  it("retires only the unsafe folder-only head and preserves its immutable snapshot",()=>{const {store,vaultId,parentId,headId}=fixture();expect(repairUnsafeLegacyFolderHeads(store)).toBe(1);expect(store.one<{head_id:string}>("SELECT head_id FROM vaults WHERE id=?",vaultId)?.head_id).toBe(parentId);expect(store.getSnapshot(headId)?.folders).toHaveLength(4);expect(store.one<{code:string}>("SELECT code FROM health_events WHERE vault_id=?",vaultId)?.code).toBe("legacy_folder_migration_reverted");store.db.close();});
  it("does not rewind a trusted device head",()=>{const {store,vaultId,headId}=fixture();const snapshot=store.getSnapshot(headId)!;snapshot.deviceId="desktop";snapshot.deviceName="Desktop";store.run("UPDATE snapshots SET device_id=?,device_name=?,manifest_json=? WHERE id=?",snapshot.deviceId,snapshot.deviceName,JSON.stringify(snapshot),headId);expect(repairUnsafeLegacyFolderHeads(store)).toBe(0);expect(store.one<{head_id:string}>("SELECT head_id FROM vaults WHERE id=?",vaultId)?.head_id).toBe(headId);store.db.close();});
});
