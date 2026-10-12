import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it} from 'vitest';
import {Store} from './db.js';
import {projectedCreationEntries} from './projection-provenance.js';
const fixtures:Array<{store:Store;root:string}>=[];
afterEach(()=>{for(const {store,root} of fixtures.splice(0)){store.db.close();rmSync(root,{recursive:true,force:true});}});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'gib-projection-identity-')),store=new Store(root);fixtures.push({store,root});
  const id=randomUUID(),snapshotId=randomUUID(),mutation=randomUUID(),entry={path:'upload.bin',fileId:randomUUID(),hash:'d'.repeat(64),size:8388608,mtime:1},at='2026-01-01T00:00:00.000Z',commit='b'.repeat(40);
  store.run('INSERT INTO vaults(id,name,wrapped_key,created_at) VALUES(?,?,?,?)',id,'Disposable','unused',at);
  const snapshot={id:snapshotId,vaultId:id,parentId:null,deviceId:'pc',deviceName:'PC',createdAt:at,message:'Upload',entries:[entry]};
  store.run('INSERT INTO snapshots VALUES(?,?,NULL,?,?,?,?,?)',snapshotId,id,'pc','PC',at,'Upload',JSON.stringify(snapshot));
  store.run("INSERT INTO mirror_mutations(id,vault_id,path,snapshot_id,expected_hash,target_hash,history_baseline,state,created_at,write_acknowledged,fence_commit) VALUES(?,?,?,?,NULL,?,?,'captured',?,1,?)",mutation,id,entry.path,snapshotId,entry.hash,'a'.repeat(40),at,'c'.repeat(40));
  store.run("INSERT INTO external_revisions(vault_id,path,revision_id,hash,size,observed_at,source,mtime,causal_order,imported_at) VALUES(?,?,?,?,?,?,'projection-history',?,?,?)",id,entry.path,commit,entry.hash,entry.size,at,1,`${at}:000001`,at);
  const proof={commitId:commit,originPath:entry.path,mtime:1,directory:false,recreated:false};
  const read=(override={})=>projectedCreationEntries(store,id,new Map([[entry.path,{...proof,...override}]]));
  return {store,id,entry,mutation,snapshotId,read,proof};
}
describe('path-scoped durable partial projection identity',()=>{
  it('recovers the original immutable identity without requiring the live head or a completed whole-vault mirror',()=>{const f=fixture();expect(f.read().get(f.entry.path)).toEqual(f.entry);});
  it.each([
    ['missing backend acknowledgement',"UPDATE mirror_mutations SET write_acknowledged=0"],
    ['unfinished capture',"UPDATE mirror_mutations SET state='prepared'"],
    ['missing verified fence',"UPDATE mirror_mutations SET fence_commit=NULL"],
    ['pre-existing same-byte external file',"UPDATE mirror_mutations SET visible_hash=target_hash"],
    ['an edit rather than a creation',"UPDATE mirror_mutations SET expected_hash=target_hash"],
    ['wrong projection target',"UPDATE mirror_mutations SET target_hash='wrong'"],
    ['unrelated mutation capture',"UPDATE external_revisions SET causal_order='unrelated'"],
    ['untrusted live observation',"UPDATE external_revisions SET source='external-observation'"],
    ['wrong immutable byte size',"UPDATE external_revisions SET size=size+1"],
    ['missing accepted snapshot',"UPDATE mirror_mutations SET snapshot_id='missing'"],
    ['different path',"UPDATE mirror_mutations SET path='other.bin'"],
  ])('refuses identity borrowing for %s',(_reason,sql)=>{const f=fixture();f.store.run(sql);expect(f.read().size).toBe(0);});
  it('never suppresses explicit deletion/recreation even when the bytes are identical',()=>{const f=fixture();expect(f.read({recreated:true}).size).toBe(0);});
  it('never applies an earlier proof to a later independent creation commit',()=>{const f=fixture();expect(f.read({commitId:'e'.repeat(40)}).size).toBe(0);});
  it('follows explicit renames while retaining the original creation location',()=>{const f=fixture();const result=projectedCreationEntries(f.store,f.id,new Map([['Moved.bin',f.proof]]));expect(result.get('Moved.bin')).toEqual({...f.entry,path:'Moved.bin'});});
});
