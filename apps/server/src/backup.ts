import { backup, DatabaseSync } from "node:sqlite";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {createReadStream} from "node:fs";

async function checksum(path:string):Promise<string>{const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest("hex");}

/** Consistent SQLite online backup; never copies a live database without its WAL. */
export async function verifiedDatabaseBackup(dataDir:string,label:string):Promise<{path:string;sha256:string;snapshots:number}>{
  if(!/^[a-zA-Z0-9.-]+$/.test(label))throw new Error("Invalid backup label");
  const root=resolve(dataDir),directory=join(root,"verified-backups");
  await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
  const path=join(directory,`${label}-${Date.now()}-${randomUUID()}.db`);
  const source=new DatabaseSync(join(root,"gib-sync.db"),{readOnly:true});
  try{
    // Pin a read-only WAL snapshot. Otherwise another connection's routine
    // heartbeat can restart each backup batch forever on a busy service.
    // WAL writers continue normally while this reader holds its snapshot.
    source.exec("BEGIN");source.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
    await backup(source,path,{rate:100});
  }finally{source.close();}
  await chmod(path,0o600);
  const restored=new DatabaseSync(path,{readOnly:true});let snapshots=0;
  try{
    const integrity=restored.prepare("PRAGMA integrity_check").get();
    if(integrity?.integrity_check!=="ok")throw new Error("Backup restore verification failed");
    if(restored.prepare("PRAGMA foreign_key_check").all().length)throw new Error("Backup references failed verification");
    const missing=restored.prepare("SELECT COUNT(*) count FROM vaults v LEFT JOIN snapshots s ON s.id=v.head_id WHERE v.head_id IS NOT NULL AND s.id IS NULL").get();
    if(Number(missing?.count))throw new Error("Backup has unavailable accepted heads");
    snapshots=Number(restored.prepare("SELECT COUNT(*) count FROM snapshots").get()?.count??0);
  }finally{restored.close();}
  const sha256=await checksum(path);
  await writeFile(`${path}.sha256`,`${sha256}\n`,{flag:"wx",mode:0o600});
  return {path,sha256,snapshots};
}

/** Pre-upgrade safeguard: one verified backup per version, no history rewrites. */
export async function backupBeforeUpgrade(dataDir:string,version:string):Promise<boolean>{
  const root=resolve(dataDir);
  try{await stat(join(root,"gib-sync.db"));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}
  const marker=join(root,`backup-verified-${version}.json`);
  try{
    const stored=JSON.parse(await readFile(marker,"utf8")) as {path:string;sha256:string};
    const directory=join(root,"verified-backups");
    if(stored.path.startsWith(`${directory}/`)||stored.path.startsWith(`${directory}\\`)){
      if(await checksum(stored.path)===stored.sha256)return false;
    }
  }catch{}
  const result=await verifiedDatabaseBackup(root,`pre-${version}`);
  await writeFile(marker,JSON.stringify(result),{mode:0o600});return true;
}

/** Persist the schedule so a restart cannot postpone daily backups forever. */
export async function backupIfDue(dataDir:string,now=Date.now()):Promise<boolean>{
  const marker=join(resolve(dataDir),"daily-backup-verified.json");
  try{
    const saved=JSON.parse(await readFile(marker,"utf8")) as {verifiedAt:number;path:string};
    const directory=join(resolve(dataDir),"verified-backups");
    if(Number.isFinite(saved.verifiedAt)&&saved.verifiedAt<=now&&now-saved.verifiedAt<24*60*60*1000&&(saved.path.startsWith(`${directory}/`)||saved.path.startsWith(`${directory}\\`))){await stat(saved.path);return false;}
  }catch{}
  const result=await verifiedDatabaseBackup(dataDir,"daily");
  await writeFile(marker,JSON.stringify({...result,verifiedAt:now}),{mode:0o600});return true;
}
