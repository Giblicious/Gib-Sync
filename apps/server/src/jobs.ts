import { randomUUID } from "node:crypto";
import type { Store } from "./db.js";

export interface WorkLease {vaultId:string;owner:string;revision:number;}
/** SQLite is the source of truth; timers are only an efficient wake-up mechanism. */
export class DurableMirrorJobs {
  constructor(private readonly store:Store){}
  enqueue(vaultId:string,delay=0):void{
    const due=Date.now()+Math.max(0,delay);
    this.store.run(`INSERT INTO mirror_jobs(vault_id,due_at,revision) VALUES(?,?,1)
      ON CONFLICT(vault_id) DO UPDATE SET due_at=MIN(mirror_jobs.due_at,excluded.due_at),revision=mirror_jobs.revision+1`,vaultId,due);
  }
  claim(vaultId:string,leaseMs=120_000):WorkLease|null{
    const now=Date.now(),owner=randomUUID();
    const row=this.store.one<{revision:number}>(`UPDATE mirror_jobs SET lease_owner=?,lease_until=?
      WHERE vault_id=? AND due_at<=? AND (lease_owner IS NULL OR lease_until<=?) RETURNING revision`,owner,now+leaseMs,vaultId,now,now);
    return row?{vaultId,owner,revision:row.revision}:null;
  }
  renew(lease:WorkLease,leaseMs=120_000):boolean{return Boolean(this.store.run("UPDATE mirror_jobs SET lease_until=? WHERE vault_id=? AND lease_owner=?",Date.now()+leaseMs,lease.vaultId,lease.owner).changes);}
  owns(lease:WorkLease):boolean{return Boolean(this.store.one("SELECT 1 FROM mirror_jobs WHERE vault_id=? AND lease_owner=? AND lease_until>?",lease.vaultId,lease.owner,Date.now()));}
  finish(lease:WorkLease):void{
    this.store.run("DELETE FROM mirror_jobs WHERE vault_id=? AND lease_owner=? AND revision=?",lease.vaultId,lease.owner,lease.revision);
    this.store.run("UPDATE mirror_jobs SET lease_owner=NULL,lease_until=NULL WHERE vault_id=? AND lease_owner=?",lease.vaultId,lease.owner);
  }
  retry(lease:WorkLease,error:unknown,delay:number):void{
    this.store.run("UPDATE mirror_jobs SET lease_owner=NULL,lease_until=NULL,due_at=?,attempts=attempts+1,last_error=? WHERE vault_id=? AND lease_owner=?",Date.now()+delay,error instanceof Error?error.name:"Error",lease.vaultId,lease.owner);
  }
  pending():Array<{vault_id:string;due_at:number}>{return this.store.all("SELECT vault_id,due_at FROM mirror_jobs WHERE lease_owner IS NULL OR lease_until<=?",Date.now());}
}
