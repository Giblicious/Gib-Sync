import type {ManifestEntry} from '@gib-sync/protocol';
import type {Store} from './db.js';
import type {ExternalCreationProof} from './external-provenance.js';

/** A partial readable projection is not a second independently created entity.
 * Proof is path/commit scoped, acknowledged, fenced, and pinned to an immutable
 * accepted snapshot. Hash equality alone, wall clocks and live-head membership
 * cannot establish this identity. Explicit delete/recreate always wins. */
export function projectedCreationEntries(store:Store,vaultId:string,creations:Map<string,ExternalCreationProof>):Map<string,ManifestEntry>{
  const result=new Map<string,ManifestEntry>();
  const snapshots=new Map<string,Map<string,ManifestEntry>>();
  for(const [path,creation] of creations){
    if(creation.directory||creation.recreated)continue;
    const rows=store.all<{snapshot_id:string;target_hash:string;size:number}>(`SELECT m.snapshot_id,m.target_hash,r.size FROM mirror_mutations m
      JOIN external_revisions r ON r.vault_id=m.vault_id AND r.path=m.path AND r.revision_id=?
      AND r.source='projection-history' AND r.hash=m.target_hash AND r.causal_order LIKE m.created_at||':%'
      WHERE m.vault_id=? AND m.path=? AND m.kind='file' AND m.expected_hash IS NULL AND m.visible_hash IS NULL
      AND m.write_acknowledged=1 AND m.state='captured' AND m.fence_commit IS NOT NULL`,creation.commitId,vaultId,creation.originPath);
    const entries=rows.flatMap(row=>{let snapshot=snapshots.get(row.snapshot_id);if(!snapshot){const accepted=store.getSnapshot(row.snapshot_id);snapshot=new Map(accepted?.vaultId===vaultId?accepted.entries.map(e=>[e.path,e]):[]);snapshots.set(row.snapshot_id,snapshot);}const entry=snapshot.get(creation.originPath);return entry?.fileId&&entry.hash===row.target_hash&&entry.size===row.size?[entry]:[];});
    if(entries.length&&new Set(entries.map(e=>e.fileId)).size===1)result.set(path,{...entries[0]!,path});
  }
  return result;
}
