import { randomInt,randomUUID } from "node:crypto";
import type { Store } from "./db.js";
import { openJson,randomToken,sealJson,sha256 } from "./security.js";
import type { SetupResponse } from "@gib-sync/protocol";
type Device={id:string;vault_id:string;name:string};
type Claim={id:string;pairing_id:string;vault_id:string;origin_device_id:string;device_name:string;confirmation_code:string;ticket_hash:string;created_at:string;expires_at:string;state:string;result_payload:string|null;device_id:string|null};
function failure(statusCode:number,message:string):never{throw Object.assign(new Error(message),{statusCode});}
export class TrustedPairing {
  constructor(private readonly store:Store,private readonly secret:string,private readonly setup:(vaultId:string,name:string,deviceId:string,token:string)=>SetupResponse){}
  claim(pairingId:string,deviceName:string,kind:"code"|"qr"="code"){
    const now=new Date().toISOString(),ticket=randomToken(),id=randomUUID(),expiresAt=new Date(Date.now()+5*60_000).toISOString(),confirmationCode=randomInt(100000,1000000).toString();
    this.store.db.exec("BEGIN IMMEDIATE");try{
      const row=this.store.one<{vault_id:string;created_by_device:string}>("SELECT vault_id,created_by_device FROM pairings WHERE id=? AND requires_confirmation=1 AND consumed_at IS NULL AND CASE WHEN ?='qr' THEN qr_expires_at ELSE expires_at END>?",pairingId,kind,now);
      if(!row)failure(410,"Quick code expired or invalid");
      const device=this.store.one<{revoked_at:string|null}>("SELECT revoked_at FROM devices WHERE id=? AND vault_id=?",row.created_by_device,row.vault_id);if(!device||device.revoked_at)failure(410,"The inviting device is no longer trusted");
      if(this.store.run("UPDATE pairings SET consumed_at=? WHERE id=? AND consumed_at IS NULL",now,pairingId).changes!==1)failure(410,"Quick code was already used");
      this.store.run("INSERT INTO trusted_pairing_claims(id,pairing_id,vault_id,origin_device_id,device_name,confirmation_code,ticket_hash,created_at,expires_at,state) VALUES(?,?,?,?,?,?,?,?,?,'pending')",id,pairingId,row.vault_id,row.created_by_device,deviceName,confirmationCode,sha256(ticket),now,expiresAt);
      this.store.db.exec("COMMIT");return {status:"pending" as const,claimId:id,ticket,expiresAt,confirmationCode};
    }catch(error){this.store.db.exec("ROLLBACK");throw error;}
  }
  list(device:Device){return this.store.all<Claim>("SELECT * FROM trusted_pairing_claims WHERE origin_device_id=? AND vault_id=? AND state='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 50",device.id,device.vault_id,new Date().toISOString()).map(row=>({id:row.id,deviceName:row.device_name,confirmationCode:row.confirmation_code,expiresAt:row.expires_at}));}
  decide(device:Device,id:string,approved:boolean){
    const now=new Date().toISOString(),changed=this.store.run("UPDATE trusted_pairing_claims SET state=? WHERE id=? AND origin_device_id=? AND vault_id=? AND state='pending' AND expires_at>?",approved?"approved":"rejected",id,device.id,device.vault_id,now);
    if(changed.changes!==1)failure(409,"This device request expired or was already decided");return {ok:true};
  }
  poll(ticket:string){
    if(!/^[A-Za-z0-9_-]{43}$/.test(ticket))failure(410,"Device request expired or invalid");
    const now=new Date().toISOString();this.store.db.exec("BEGIN IMMEDIATE");try{
      const row=this.store.one<Claim>("SELECT * FROM trusted_pairing_claims WHERE ticket_hash=?",sha256(ticket));if(!row||row.expires_at<=now)failure(410,"Device request expired or invalid");
      const origin=this.store.one<{revoked_at:string|null}>("SELECT revoked_at FROM devices WHERE id=? AND vault_id=?",row.origin_device_id,row.vault_id);if(!origin||origin.revoked_at)failure(410,"The inviting device is no longer trusted");
      if(row.state==="pending"){this.store.db.exec("COMMIT");return {status:"pending" as const,claimId:row.id,expiresAt:row.expires_at};}
      if(row.state==="rejected"||row.state==="cancelled")failure(410,"The connected device declined this request");
      if(row.state==="consumed"){const device=row.device_id?this.store.one<{revoked_at:string|null}>("SELECT revoked_at FROM devices WHERE id=? AND vault_id=?",row.device_id,row.vault_id):null;if(!device||device.revoked_at)failure(410,"This device request was revoked");const payload=openJson<{pairingId:string;envelope:string}>(row.result_payload!,this.secret,`trusted-claim:${row.id}`);this.store.db.exec("COMMIT");return {status:"approved" as const,...payload};}
      const deviceId=randomUUID(),token=randomToken(),vault=this.store.one<{name:string;retired_at:string|null}>("SELECT name,retired_at FROM vaults WHERE id=?",row.vault_id);if(!vault||vault.retired_at)failure(410,"This vault is no longer available");
      this.store.run("INSERT INTO devices(id,vault_id,name,token_hash,created_at,last_seen_at,initial_sync_complete) VALUES(?,?,?,?,?,?,0)",deviceId,row.vault_id,row.device_name,sha256(token),now,now);
      const response={pairingId:row.pairing_id,envelope:sealJson(this.setup(row.vault_id,vault.name,deviceId,token),ticket,`pairing:${row.pairing_id}`)};
      this.store.run("UPDATE trusted_pairing_claims SET state='consumed',result_payload=?,device_id=? WHERE id=? AND state='approved'",sealJson(response,this.secret,`trusted-claim:${row.id}`),deviceId,row.id);
      this.store.db.exec("COMMIT");return {status:"approved" as const,...response};
    }catch(error){this.store.db.exec("ROLLBACK");throw error;}
  }
  cancel(ticket:string){this.store.db.exec("BEGIN IMMEDIATE");try{const row=this.store.one<Claim>("SELECT * FROM trusted_pairing_claims WHERE ticket_hash=?",sha256(ticket));if(row&&row.expires_at>new Date().toISOString()){this.store.run("UPDATE trusted_pairing_claims SET state='cancelled',result_payload=NULL WHERE id=?",row.id);if(row.device_id)this.store.run("UPDATE devices SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND vault_id=?",new Date().toISOString(),row.device_id,row.vault_id);}this.store.db.exec("COMMIT");}catch(error){this.store.db.exec("ROLLBACK");throw error;}return {ok:true};}
}
