import { randomUUID } from "node:crypto";
import type { Store } from "./db.js";

export interface VaultRetirementState {
  vaultId:string;
  vaultName:string;
  retired:boolean;
  retiredAt:string|null;
  reason:string|null;
}

type VaultRow={id:string;name:string;retired_at:string|null;retired_reason:string|null};

/** Durable, reversible isolation for obsolete or unrecoverable vault registrations. */
export class VaultRetirementService {
  constructor(private readonly store:Store){}

  state(vaultId:string):VaultRetirementState{
    const row=this.store.one<VaultRow>("SELECT id,name,retired_at,retired_reason FROM vaults WHERE id=?",vaultId);
    if(!row)throw new Error(`Unknown vault id: ${vaultId}`);
    return {vaultId:row.id,vaultName:row.name,retired:Boolean(row.retired_at),retiredAt:row.retired_at,reason:row.retired_reason};
  }

  all():VaultRetirementState[]{
    return this.store.all<VaultRow>("SELECT id,name,retired_at,retired_reason FROM vaults ORDER BY name,id").map((row)=>({vaultId:row.id,vaultName:row.name,retired:Boolean(row.retired_at),retiredAt:row.retired_at,reason:row.retired_reason}));
  }

  isRetired(vaultId:string):boolean{
    return Boolean(this.store.one<{retired_at:string|null}>("SELECT retired_at FROM vaults WHERE id=?",vaultId)?.retired_at);
  }

  retire(vaultId:string,reason:string):VaultRetirementState{
    const current=this.state(vaultId),cleanReason=reason.trim();if(!cleanReason)throw new Error("A retirement reason is required");
    if(current.retired)return current;
    const now=new Date().toISOString();this.store.db.exec("BEGIN IMMEDIATE");
    try{
      this.store.run("UPDATE vaults SET retired_at=?,retired_reason=?,trusted_until=NULL,trusted_device_id=NULL WHERE id=?",now,cleanReason,vaultId);
      this.store.run("INSERT INTO health_events(id,vault_id,code,level,message,created_at) VALUES(?,?,?,?,?,?)",randomUUID(),vaultId,"vault_retired","info",`Vault registration retired: ${cleanReason}`,now);
      this.store.db.exec("COMMIT");
    }catch(error){try{this.store.db.exec("ROLLBACK");}catch{}throw error;}
    return this.state(vaultId);
  }

  restore(vaultId:string,reason:string):VaultRetirementState{
    const current=this.state(vaultId);if(!current.retired)return current;
    const now=new Date().toISOString(),cleanReason=reason.trim()||"Vault registration restored by operator";this.store.db.exec("BEGIN IMMEDIATE");
    try{
      this.store.run("UPDATE vaults SET retired_at=NULL,retired_reason=NULL WHERE id=?",vaultId);
      this.store.run("UPDATE health_events SET cleared_at=? WHERE vault_id=? AND code='vault_retired' AND cleared_at IS NULL",now,vaultId);
      this.store.run("INSERT INTO health_events(id,vault_id,code,level,message,created_at) VALUES(?,?,?,?,?,?)",randomUUID(),vaultId,"vault_restored","info",cleanReason,now);
      this.store.db.exec("COMMIT");
    }catch(error){try{this.store.db.exec("ROLLBACK");}catch{}throw error;}
    return this.state(vaultId);
  }
}
