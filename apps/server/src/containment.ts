import { randomUUID } from "node:crypto";
import type { Store } from "./db.js";

export interface ContainmentState {
  active:boolean;
  allowedVaultId:string|null;
  allowedVaultName:string|null;
  reason:string|null;
  enabledAt:string|null;
}

type ContainmentRow={allowed_vault_id:string;reason:string;enabled_at:string;disabled_at:string|null;allowed_vault_name:string};

export class ContainmentService {
  constructor(private readonly store:Store){}

  state():ContainmentState{
    const row=this.store.one<ContainmentRow>("SELECT c.allowed_vault_id,c.reason,c.enabled_at,c.disabled_at,v.name allowed_vault_name FROM server_containment c JOIN vaults v ON v.id=c.allowed_vault_id WHERE c.singleton=1");
    return row&&!row.disabled_at
      ?{active:true,allowedVaultId:row.allowed_vault_id,allowedVaultName:row.allowed_vault_name,reason:row.reason,enabledAt:row.enabled_at}
      :{active:false,allowedVaultId:null,allowedVaultName:null,reason:null,enabledAt:null};
  }

  allows(vaultId:string):boolean{const state=this.state();return !state.active||state.allowedVaultId===vaultId;}

  enable(allowedVaultId:string,reason:string):ContainmentState{
    const vault=this.store.one<{id:string}>("SELECT id FROM vaults WHERE id=?",allowedVaultId);if(!vault)throw new Error(`Unknown vault id: ${allowedVaultId}`);
    const now=new Date().toISOString(),cleanReason=reason.trim();if(!cleanReason)throw new Error("A containment reason is required");
    this.store.db.exec("BEGIN IMMEDIATE");
    try{
      this.store.run("INSERT INTO server_containment(singleton,allowed_vault_id,reason,enabled_at,disabled_at) VALUES(1,?,?,?,NULL) ON CONFLICT(singleton) DO UPDATE SET allowed_vault_id=excluded.allowed_vault_id,reason=excluded.reason,enabled_at=excluded.enabled_at,disabled_at=NULL",allowedVaultId,cleanReason,now);
      this.store.run("INSERT INTO server_containment_events(id,action,allowed_vault_id,reason,created_at) VALUES(?,?,?,?,?)",randomUUID(),"enabled",allowedVaultId,cleanReason,now);
      this.store.db.exec("COMMIT");
    }catch(error){try{this.store.db.exec("ROLLBACK");}catch{}throw error;}
    return this.state();
  }

  disable(reason:string):ContainmentState{
    const current=this.state();if(!current.active)return current;
    const now=new Date().toISOString(),cleanReason=reason.trim()||"Containment cleared";
    this.store.db.exec("BEGIN IMMEDIATE");
    try{
      this.store.run("UPDATE server_containment SET disabled_at=? WHERE singleton=1",now);
      this.store.run("INSERT INTO server_containment_events(id,action,allowed_vault_id,reason,created_at) VALUES(?,?,?,?,?)",randomUUID(),"disabled",current.allowedVaultId,cleanReason,now);
      this.store.db.exec("COMMIT");
    }catch(error){try{this.store.db.exec("ROLLBACK");}catch{}throw error;}
    return this.state();
  }
}
