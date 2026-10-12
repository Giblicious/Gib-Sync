import type {ManifestEntry} from "@gib-sync/protocol";
import type {Store} from "./db.js";
import {OperationConflict,portablePath,type SyncEntity} from "./operation-state.js";
export function configAliases(store:Store,vaultId:string):string[]{return store.all<{config_root:string}>("SELECT config_root FROM vault_config_aliases WHERE vault_id=?",vaultId).map(row=>row.config_root);}
export function isReservedSyncPath(path:string,aliases:readonly string[]=[]):boolean{const value=portablePath(path);if(value==='.gib-sync'||value.startsWith('.gib-sync/'))return true;return ['.obsidian',...aliases].some(root=>{const own=`${portablePath(root)}/plugins/gib-sync`;return value===own||value.startsWith(`${own}/`);});}
/** Historical unchanged private rows may retire, but can never be introduced,
 * edited, moved into, or recreated by any mutation transport. */
export function assertReservedState(previous:SyncEntity[],next:SyncEntity[],aliases:readonly string[]):void{
  const baseline=new Map(previous.filter(entity=>!entity.deleted).map(entity=>[entity.path,entity]));
  for(const entity of next){if(entity.deleted||!isReservedSyncPath(entity.path,aliases))continue;const old=baseline.get(entity.path);if(!old||old.id!==entity.id||old.kind!==entity.kind||old.hash!==entity.hash||old.size!==entity.size)throw new OperationConflict("Gib Sync's private state and own plugin files are not a sync target");}
}
export function excludeReservedFiles(entries:ManifestEntry[],aliases:readonly string[]):ManifestEntry[]{return entries.filter(entry=>!isReservedSyncPath(entry.path,aliases));}
