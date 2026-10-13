import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Store} from './db.js';

const schema=z.object({schema:z.literal(1),id:z.string().uuid(),headId:z.string().uuid().nullable(),startedAt:z.string().datetime(),priorLockAt:z.string().nullable(),priorLockBy:z.string().nullable()}).strict();
export type CheckpointRepair=z.infer<typeof schema>;
const lockLabel='Gib Sync checkpoint repair';
type Row={head_id:string|null;mirror_head_id:string|null;mirror_generation_id:string|null;checkpoint_repair_json:string|null;write_locked_at:string|null;write_locked_by:string|null};
/** The approved repair target is durable authority, not a process-local flag.
 * Legacy repair:* rows are an internal intent marker written only by the old
 * accepted-checkpoint repair route, never by device or Seafile manifests. */
export class CheckpointRepairs{
  constructor(private readonly store:Store){}
  private row(id:string):Row{const row=this.store.one<Row>('SELECT head_id,mirror_head_id,mirror_generation_id,checkpoint_repair_json,write_locked_at,write_locked_by FROM vaults WHERE id=?',id);if(!row)throw new Error('Checkpoint repair vault is unavailable');return row;}
  get(id:string):CheckpointRepair|null{const row=this.row(id);if(!row.checkpoint_repair_json)return null;const record=schema.parse(JSON.parse(row.checkpoint_repair_json));if(record.headId!==row.head_id)throw new Error('The accepted head differs from its durable repair target; writes remain held');return record;}
  recover(id:string):CheckpointRepair|null{
    const row=this.row(id);if(row.checkpoint_repair_json)return this.get(id);
    if(row.mirror_generation_id!==null)return null;
    const marker=this.store.one<{hash:string}>("SELECT hash FROM mirror_entries WHERE vault_id=? AND hash LIKE 'repair:%' ORDER BY path LIMIT 1",id)?.hash;
    if(!marker)return null;const started=marker.slice('repair:'.length);if(!z.string().datetime().safeParse(started).success)throw new Error('Interrupted checkpoint repair marker is invalid; writes remain held');
    return this.begin(id,started);
  }
  begin(id:string,startedAt=new Date().toISOString()):CheckpointRepair{
    const row=this.row(id);if(row.checkpoint_repair_json)return this.get(id)!;
    if(row.head_id&&this.store.getSnapshot(row.head_id)?.vaultId!==id)throw new Error('Checkpoint repair target is not this vault’s accepted snapshot');
    const record=schema.parse({schema:1,id:randomUUID(),headId:row.head_id,startedAt,priorLockAt:row.write_locked_at,priorLockBy:row.write_locked_by});
    const changed=this.store.run('UPDATE vaults SET checkpoint_repair_json=?,write_locked_at=?,write_locked_by=? WHERE id=? AND head_id IS ? AND checkpoint_repair_json IS NULL',JSON.stringify(record),record.startedAt,lockLabel,id,record.headId);
    if(!changed.changes)throw new Error('Checkpoint repair changed before its intent was saved');return record;
  }
  setTarget(id:string,headId:string):void{
    // Called inside the accepted repair snapshot transaction, after its head CAS.
    const row=this.row(id);if(!row.checkpoint_repair_json)throw new Error('Repair target lost its durable intent');const record=schema.parse(JSON.parse(row.checkpoint_repair_json));
    if(row.head_id!==headId)throw new Error('Repair target is not accepted authority');this.store.run('UPDATE vaults SET checkpoint_repair_json=? WHERE id=?',JSON.stringify({...record,headId}),id);
  }
  finish(id:string,headId:string|null):boolean{
    const record=this.get(id);if(!record)return true;const row=this.row(id);
    if(record.headId!==headId||row.mirror_head_id!==headId||row.mirror_generation_id!==headId)return false;
    const ours=row.write_locked_at===record.startedAt&&row.write_locked_by===lockLabel;
    const changed=this.store.run('UPDATE vaults SET checkpoint_repair_json=NULL,write_locked_at=?,write_locked_by=? WHERE id=? AND checkpoint_repair_json=?',ours?record.priorLockAt:row.write_locked_at,ours?record.priorLockBy:row.write_locked_by,id,JSON.stringify(record));
    return Boolean(changed.changes);
  }
  interruptedVaults():string[]{return this.store.all<{id:string}>("SELECT id FROM vaults WHERE checkpoint_repair_json IS NOT NULL OR mirror_generation_id IS NULL AND EXISTS(SELECT 1 FROM mirror_entries m WHERE m.vault_id=vaults.id AND m.hash LIKE 'repair:%')").map(row=>row.id);}
}
