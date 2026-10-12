import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {describe,it,expect} from "vitest";
import {Store} from "./db.js";
import {backupBeforeUpgrade,backupIfDue,verifiedDatabaseBackup} from "./backup.js";

describe("verified database backup",()=>{
  it("finishes a pinned consistent WAL backup while another connection keeps writing",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"gib-backup-churn-")),store=new Store(dir);let timer:ReturnType<typeof setInterval>|undefined;
    try{
      store.run("INSERT INTO vaults(id,name,wrapped_key,created_at) VALUES(?,?,?,?)","v","0","protected-key","now");
      store.db.exec("CREATE TABLE padding(id INTEGER PRIMARY KEY,body BLOB)");
      const insert=store.db.prepare("INSERT INTO padding(body) VALUES(zeroblob(131072))");store.db.exec("BEGIN");for(let index=0;index<256;index++)insert.run();store.db.exec("COMMIT");
      let mutations=0;timer=setInterval(()=>{store.run("UPDATE vaults SET name=? WHERE id='v'",String(++mutations));},1);
      const result=await verifiedDatabaseBackup(dir,"concurrent"),restored=new DatabaseSync(result.path,{readOnly:true});
      try{const captured=Number(restored.prepare("SELECT name FROM vaults WHERE id='v'").get()?.name);expect(mutations).toBeGreaterThan(0);expect(captured).toBeLessThan(mutations);expect(restored.prepare("SELECT COUNT(*) count FROM padding").get()?.count).toBe(256);expect(restored.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");}finally{restored.close();}
    }finally{if(timer)clearInterval(timer);store.db.close();await rm(dir,{recursive:true,force:true});}
  // This 32 MiB WAL/IO drill shares disk bandwidth with the full fault suite.
  // Keep every pinning/content assertion; a loaded Windows host needs headroom.
  },30_000);
  it("keeps daily backup timing across restart instead of postponing it",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"gib-backup-test-")),store=new Store(dir),now=Date.now();
    try{expect(await backupIfDue(dir,now)).toBe(true);expect(await backupIfDue(dir,now+1000)).toBe(false);expect(await backupIfDue(dir,now+24*60*60*1000)).toBe(true);}
    finally{store.db.close();await rm(dir,{recursive:true,force:true});}
  });
  it("restores accepted heads and settings from a database with an uncheckpointed WAL",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"gib-backup-test-")),store=new Store(dir);
    try{
      store.run("INSERT INTO vaults(id,name,wrapped_key,head_id,created_at) VALUES(?,?,?,?,?)","v","Test","protected-key","s","now");
      store.run("INSERT INTO snapshots(id,vault_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?)","s","v","d","Test","now","test",'{"entries":[]}');
      const result=await verifiedDatabaseBackup(dir,"test"),restored=new DatabaseSync(result.path,{readOnly:true});
      try{expect(restored.prepare("SELECT wrapped_key,head_id FROM vaults").get()).toMatchObject({wrapped_key:"protected-key",head_id:"s"});}finally{restored.close();}
      expect(result.snapshots).toBe(1);expect((await readFile(`${result.path}.sha256`,"utf8")).trim()).toBe(result.sha256);
      expect(await backupBeforeUpgrade(dir,"0.8.61")).toBe(true);expect(await backupBeforeUpgrade(dir,"0.8.61")).toBe(false);
    }finally{store.db.close();await rm(dir,{recursive:true,force:true});}
  });
  it("does not create or migrate a nonexistent database",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"gib-backup-test-"));
    try{expect(await backupBeforeUpgrade(dir,"0.8.61")).toBe(false);}finally{await rm(dir,{recursive:true,force:true});}
  });
});
