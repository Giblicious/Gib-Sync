import type { Snapshot } from "@gib-sync/protocol";
import type { Store } from "./db.js";
import { validateCurrentSnapshot } from "./manifest.js";

export interface HeadIntegrity{valid:boolean;issues:string[];}

/** Fast, deterministic checks before a head is allowed to mutate its mirror. */
export function auditHeadIntegrity(store:Store,vaultId:string,headId:string):HeadIntegrity{
  const issues:string[]=[],seen=new Set<string>();let id:string|null=headId,head:Snapshot|null=null;
  while(id){
    if(seen.has(id)){issues.push("snapshot ancestry contains a cycle");break;}seen.add(id);
    let snapshot:Snapshot|null=null;try{snapshot=store.getSnapshot(id);}catch{issues.push("snapshot manifest JSON is unreadable");break;}
    if(!snapshot){issues.push("snapshot ancestry is incomplete");break;}
    if(snapshot.id!==id){issues.push("snapshot row and manifest identifiers disagree");break;}
    if(snapshot.vaultId!==vaultId){issues.push("snapshot ancestry crosses a vault boundary");break;}
    if(!head)head=snapshot;id=snapshot.parentId;
  }
  if(head){const invalid=validateCurrentSnapshot(head);if(invalid)issues.push(invalid);
    const missing=new Set<string>();for(const entry of head.entries)if(!store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?",vaultId,entry.hash))missing.add(entry.hash);
    if(missing.size)issues.push(`${missing.size} current file blob${missing.size===1?" is":"s are"} absent from the registry`);
  }
  return {valid:issues.length===0,issues:[...new Set(issues)]};
}
