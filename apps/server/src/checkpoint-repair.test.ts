import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,describe,expect,it} from 'vitest';
import type {Snapshot} from '@gib-sync/protocol';
import {Store} from './db.js';
import {CheckpointRepairs} from './checkpoint-repair.js';

const fixtures:Array<{store:Store;dir:string}>=[];
afterEach(()=>{for(const f of fixtures.splice(0)){f.store.db.close();rmSync(f.dir,{recursive:true,force:true});}});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'gib-checkpoint-repair-')),store=new Store(dir),id=randomUUID(),at=new Date().toISOString();fixtures.push({store,dir});
  store.run('INSERT INTO vaults(id,name,wrapped_key,created_at) VALUES(?,?,?,?)',id,'Disposable','fixture',at);
  const snapshot=(vaultId=id):Snapshot=>{const head:Snapshot={id:randomUUID(),vaultId,parentId:null,deviceId:'fixture',deviceName:'Fixture',createdAt:at,message:'Fixture',entries:[],folders:[]};store.run('INSERT INTO snapshots(id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?,?)',head.id,vaultId,null,head.deviceId,head.deviceName,at,head.message,JSON.stringify(head));return head;};
  const target=snapshot();store.run('UPDATE vaults SET head_id=? WHERE id=?',target.id,id);
  return {dir,store,id,target,snapshot,repairs:new CheckpointRepairs(store)};
}
describe('durable accepted-checkpoint repairs',()=>{
  it('recovers the exact epoch and target after reopening SQLite without changing accepted history',()=>{
    const f=fixture(),before=f.store.getSnapshot(f.target.id),epoch=f.repairs.begin(f.id);f.store.db.close();const reopened=new Store(f.dir);fixtures[fixtures.length-1].store=reopened;
    expect(new CheckpointRepairs(reopened).recover(f.id)).toEqual(epoch);expect(reopened.getSnapshot(f.target.id)).toEqual(before);expect(new CheckpointRepairs(reopened).interruptedVaults()).toEqual([f.id]);
  });
  it('does not release a hold until both readable generation markers match its approved target',()=>{
    const f=fixture(),epoch=f.repairs.begin(f.id);expect(f.repairs.finish(f.id,f.target.id)).toBe(false);
    f.store.run('UPDATE vaults SET mirror_head_id=? WHERE id=?',f.target.id,f.id);expect(f.repairs.finish(f.id,f.target.id)).toBe(false);
    f.store.run('UPDATE vaults SET mirror_generation_id=? WHERE id=?',f.target.id,f.id);expect(f.repairs.finish(f.id,f.target.id)).toBe(true);
    expect(f.repairs.get(f.id)).toBeNull();expect(f.store.one('SELECT write_locked_at,write_locked_by FROM vaults WHERE id=?',f.id)).toEqual({write_locked_at:null,write_locked_by:null});expect(epoch.headId).toBe(f.target.id);
  });
  it('restores the prior manual hold and preserves a later independently changed hold',()=>{
    const f=fixture();f.store.run('UPDATE vaults SET write_locked_at=?,write_locked_by=? WHERE id=?','original-time','Owner',f.id);f.repairs.begin(f.id);
    f.store.run('UPDATE vaults SET mirror_head_id=?,mirror_generation_id=? WHERE id=?',f.target.id,f.target.id,f.id);expect(f.repairs.finish(f.id,f.target.id)).toBe(true);
    expect(f.store.one('SELECT write_locked_at,write_locked_by FROM vaults WHERE id=?',f.id)).toEqual({write_locked_at:'original-time',write_locked_by:'Owner'});
    f.repairs.begin(f.id);f.store.run('UPDATE vaults SET write_locked_at=?,write_locked_by=? WHERE id=?','later-time','Other owner',f.id);expect(f.repairs.finish(f.id,f.target.id)).toBe(true);
    expect(f.store.one('SELECT write_locked_at,write_locked_by FROM vaults WHERE id=?',f.id)).toEqual({write_locked_at:'later-time',write_locked_by:'Other owner'});
  });
  it('fails closed on head drift and rejects a foreign snapshot as a repair target',()=>{
    const f=fixture();f.repairs.begin(f.id);const next=f.snapshot();f.store.run('UPDATE vaults SET head_id=? WHERE id=?',next.id,f.id);expect(()=>f.repairs.recover(f.id)).toThrow('durable repair target');
    const foreign=randomUUID();f.store.run('INSERT INTO vaults(id,name,wrapped_key,created_at) VALUES(?,?,?,?)',foreign,'Other disposable','fixture',new Date().toISOString());
    f.store.run('UPDATE vaults SET checkpoint_repair_json=NULL,head_id=? WHERE id=?',f.snapshot(foreign).id,f.id);expect(()=>f.repairs.begin(f.id)).toThrow('not this vault');
  });
  it('updates a cleaned accepted target atomically and retains the previous target on rollback',()=>{
    const f=fixture(),epoch=f.repairs.begin(f.id),next=f.snapshot();f.store.db.exec('BEGIN IMMEDIATE');f.store.run('UPDATE vaults SET head_id=? WHERE id=?',next.id,f.id);f.repairs.setTarget(f.id,next.id);f.store.db.exec('ROLLBACK');expect(f.repairs.get(f.id)).toEqual(epoch);
    f.store.db.exec('BEGIN IMMEDIATE');f.store.run('UPDATE vaults SET head_id=? WHERE id=?',next.id,f.id);f.repairs.setTarget(f.id,next.id);f.store.db.exec('COMMIT');expect(f.repairs.get(f.id)?.headId).toBe(next.id);
  });
  it('recovers only the reserved legacy repair marker, not an ordinary mismatch or content hash',()=>{
    const f=fixture(),at=new Date().toISOString();f.store.run('INSERT INTO mirror_entries(vault_id,path,hash,size,updated_at) VALUES(?,?,?,?,?)',f.id,'note.md','a'.repeat(64),1,at);expect(f.repairs.recover(f.id)).toBeNull();
    f.store.run('UPDATE mirror_entries SET hash=? WHERE vault_id=?','repair:'+at,f.id);expect(f.repairs.recover(f.id)?.startedAt).toBe(at);expect(f.repairs.recover(f.id)?.headId).toBe(f.target.id);
  });
  it('does not interpret a legacy marker as an active repair after a complete generation',()=>{
    const f=fixture();f.store.run('UPDATE vaults SET mirror_generation_id=? WHERE id=?',f.target.id,f.id);f.store.run('INSERT INTO mirror_entries(vault_id,path,hash,size,updated_at) VALUES(?,?,?,?,?)',f.id,'note.md','repair:'+new Date().toISOString(),1,new Date().toISOString());expect(f.repairs.recover(f.id)).toBeNull();
  });
  it('rejects malformed intent and keeps empty-vault repair restartable',()=>{
    const f=fixture();f.store.run('UPDATE vaults SET checkpoint_repair_json=? WHERE id=?','{"schema":1}',f.id);expect(()=>f.repairs.recover(f.id)).toThrow();
    f.store.run('UPDATE vaults SET checkpoint_repair_json=NULL,head_id=NULL WHERE id=?',f.id);const epoch=f.repairs.begin(f.id);expect(epoch.headId).toBeNull();expect(new CheckpointRepairs(f.store).recover(f.id)).toEqual(epoch);expect(f.repairs.finish(f.id,null)).toBe(true);
  });
});
