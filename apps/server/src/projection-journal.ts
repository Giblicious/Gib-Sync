import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Store } from "./db.js";
import { RevisionMissingError,type SeafileStorage,type VaultStorageRow } from "./seafile.js";
import { decryptVaultBlob,encryptVaultBlob,openJson,sha256 } from "./security.js";
import {VerifiedBlobStore,recoverableBlobFailure} from "./blob-store.js";
import type {StagedFile} from "./security-stream.js";
import {readFile} from 'node:fs/promises';
import {StorageMissingError} from './seafile.js';

export class ReadableChangedError extends Error {constructor(){super("Readable content changed during projection; importing the preserved revision before retry");this.name="ReadableChangedError";}}
/** An external backend without CAS requires durable revision capture, not a fake lock. */
export class ProjectionJournal {
  private readonly blobs:VerifiedBlobStore;
  constructor(private readonly config:Config,private readonly store:Store,private readonly storage:SeafileStorage){this.blobs=new VerifiedBlobStore(config,store,storage);}
  private async preserve(row:VaultStorageRow,path:string,revisionId:string,file:StagedFile,mtime:number,expected:string|null,target:string|null,causalOrder?:string,verified=new Set<string>()):Promise<void>{
    const hash=file.hash,now=new Date().toISOString();
    if(!verified.has(hash)){let available=false;try{const existing=await this.blobs.encrypted(row,hash);if(existing){await existing.dispose();available=true;}}catch(error){if(!recoverableBlobFailure(error))throw error;}if(!available)await this.blobs.persist(row,file);verified.add(hash);}
    this.store.run("INSERT OR IGNORE INTO external_revisions(vault_id,path,revision_id,hash,size,observed_at,source,mtime,causal_order,imported_at) VALUES(?,?,?,?,?,?,?,?,?,?)",row.id,path,revisionId,hash,file.size,now,"projection-history",mtime,causalOrder??`${now}:000000`,hash===expected||hash===target?now:null);
  }
  async prepare(row:VaultStorageRow,path:string,snapshotId:string,expected:string|null,target:string|null,restoreApproved=false):Promise<string>{
    await this.storage.assertHistoryAvailable(row);
    const history=await this.storage.repoHistory(row);
    if(!history.length)throw new Error("Seafile immutable repository history is empty; readable mutation deferred");
    const visible=await this.storage.statReadable(row,path);
    let visibleHash:string|null=null;
    if(visible){
      const file=await this.blobs.readable(row,path);
      try{const hash=file.hash;visibleHash=hash;if(restoreApproved)expected=hash;
        await this.preserve(row,path,`observed:${hash}`,file,visible.mtime*1000,expected,target);
        if(hash!==expected&&hash!==target)throw new ReadableChangedError();
      }finally{await file.dispose();}
    }
    const id=randomUUID();
    this.store.run("INSERT INTO mirror_mutations(id,vault_id,path,snapshot_id,expected_hash,target_hash,history_baseline,state,created_at,visible_hash) VALUES(?,?,?,?,?,?,?,'prepared',?,?)",id,row.id,path,snapshotId,expected,target,history[0]?.commitId??null,new Date().toISOString(),visibleHash);
    return id;
  }
  /** Persist the actual backend acknowledgement, not merely an intended write.
   * Recovery can preserve uncertain writes without claiming their authorship. */
  acknowledgeWrite(row:VaultStorageRow,id:string):void{
    const changed=this.store.run("UPDATE mirror_mutations SET write_acknowledged=1 WHERE id=? AND vault_id=? AND state='prepared'",id,row.id);
    if(!changed.changes)throw new Error('Projection acknowledgement lost its durable mutation');
  }
  async prepareFolder(row:VaultStorageRow,path:string,snapshotId:string):Promise<string>{
    await this.storage.assertHistoryAvailable(row);
    const history=await this.storage.repoHistory(row);if(!history.length)throw new Error("Seafile immutable repository history is empty; folder mutation deferred");
    // Enumeration is not a backend lock: capture the baseline subtree itself,
    // not merely later commits, before a recursive backend deletion can run.
    const tree=await this.storage.readableRevisionTree(row,path,history[0].commitId),vault=this.store.one<{mirror_generation_id:string|null;mirror_repo_commit:string|null}>("SELECT mirror_generation_id,mirror_repo_commit FROM vaults WHERE id=?",row.id),generation=vault?.mirror_generation_id?this.store.getSnapshot(vault.mirror_generation_id):null,knownFolders=new Set<string>();
    const addFolder=(folder:string)=>{const parts=folder.split("/");for(let index=1;index<=parts.length;index++)knownFolders.add(parts.slice(0,index).join("/"));};
    for(const folder of generation?.folders??[])addFolder(folder);
    for(const entry of generation?.entries??[]){const parts=entry.path.split("/").slice(0,-1);for(let index=1;index<=parts.length;index++)knownFolders.add(parts.slice(0,index).join("/"));}
    // Legacy manifests did not describe empty folders. Only the immutable
    // commit of the last verified projection can establish a legacy shell;
    // the current pre-delete baseline cannot authorize deleting a new folder.
    if(generation&&!Array.isArray(generation.folders)&&vault?.mirror_repo_commit){const prior=await this.storage.readableRevisionTree(row,path,vault.mirror_repo_commit);for(const folder of prior.folders)addFolder(folder);for(const entry of prior.files){const parent=entry.path.split("/").slice(0,-1).join("/");if(parent)addFolder(parent);}}
    let changed=false;const now=new Date().toISOString(),causalOrder=`${now}:000000`,verified=new Set<string>();
    for(const entry of tree.files){const expected=this.store.one<{hash:string}>("SELECT hash FROM mirror_entries WHERE vault_id=? AND path=?",row.id,entry.path)?.hash??null;if(entry.size>this.config.MAX_BLOB_BYTES)throw new Error("Historical folder file exceeds the configured size limit");const file=await this.blobs.readable(row,entry.path,history[0].commitId,undefined,entry);try{await this.preserve(row,entry.path,history[0].commitId,file,history[0].mtime,expected,null,causalOrder,verified);if(file.hash!==expected)changed=true;}finally{await file.dispose();}}
    for(const folder of tree.folders)if(!knownFolders.has(folder)){this.store.run("INSERT OR IGNORE INTO external_folder_revisions(vault_id,path,revision_id,causal_order) VALUES(?,?,?,?)",row.id,folder,history[0].commitId,causalOrder);changed=true;}
    if(changed)throw new ReadableChangedError();
    const id=randomUUID();this.store.run("INSERT INTO mirror_mutations(id,vault_id,path,snapshot_id,history_baseline,state,created_at,kind) VALUES(?,?,?,?,?,'prepared',?,'folder')",id,row.id,path,snapshotId,history[0].commitId,new Date().toISOString());return id;
  }
  async finish(row:VaultStorageRow,id:string):Promise<boolean>{
    const operation=this.store.one<{path:string;expected_hash:string|null;target_hash:string|null;history_baseline:string|null;kind:string;created_at:string}>("SELECT path,expected_hash,target_hash,history_baseline,kind,created_at FROM mirror_mutations WHERE id=? AND vault_id=?",id,row.id);if(!operation)return false;
    // Current readable bytes may become visible before history catches up. A
    // unique, encrypted post-operation fence proves an immutable commit is
    // causally after this mutation before its intervening revisions are closed.
    // Recovery may fence an operation that never executed: it only captures
    // history, and any later projection creates its own new operation UUID.
    const fence=Buffer.from(`gib-sync-mutation-fence-v1:${id}`),fenceHash=sha256(fence),fencePath=`mutation-fences/${id}.gbs`,wrapped=this.store.one<{wrapped_key:string}>("SELECT wrapped_key FROM vaults WHERE id=?",row.id)!;
    const key=openJson<string>(wrapped.wrapped_key,this.config.GIBSYNC_SERVER_SECRET,row.id);
    let currentFence:Uint8Array|null=null;
    try{
      if(typeof this.storage.getToFile==='function'){const file=await this.storage.getToFile(row,fencePath,this.blobs.staging,undefined,4096);try{if(file.size>4096)throw new Error('Projection fence exceeds its permitted size');currentFence=await readFile(file.path);}finally{await file.dispose();}}
      else {currentFence=await this.storage.get(row,fencePath);if(currentFence.byteLength>4096)throw new Error('Projection fence exceeds its permitted size');}
    }catch(error){if(!(error instanceof StorageMissingError))throw error;}
    if(currentFence){if(!Buffer.from(decryptVaultBlob(currentFence,key,fenceHash)).equals(fence))throw new Error('Existing projection fence failed authentication');}
    else await this.storage.put(row,fencePath,encryptVaultBlob(fence,key,fenceHash));
    const fenceCommit=(await this.storage.repoHistory(row))[0];if(!fenceCommit)throw new Error("Seafile immutable projection fence is not visible yet; mutation remains prepared");
    let archivedFence:Uint8Array;try{archivedFence=await this.storage.getSidecarRevision(row,fencePath,fenceCommit.commitId);}catch(error){if(error instanceof RevisionMissingError)throw new Error("Seafile immutable projection fence is not visible yet; mutation remains prepared");throw error;}
    if(!Buffer.from(decryptVaultBlob(archivedFence,key,fenceHash)).equals(fence))throw new Error("Seafile immutable projection fence failed integrity verification");
    const history=await this.storage.repoHistory(row,operation.history_baseline);
    if(!history.some((revision)=>revision.commitId===fenceCommit.commitId))throw new Error("Seafile immutable projection fence is missing from the recovery history; mutation remains prepared");
    let changed=false;const verified=new Set<string>();
    for(const [index,revision] of history.entries()){
      const causalOrder=`${operation.created_at}:${String(history.length-index).padStart(6,"0")}`;
      if(operation.kind==="folder"){
        const tree=await this.storage.readableRevisionTree(row,operation.path,revision.commitId);
        for(const path of tree.folders){this.store.run("INSERT OR IGNORE INTO external_folder_revisions(vault_id,path,revision_id,causal_order) VALUES(?,?,?,?)",row.id,path,revision.commitId,causalOrder);changed=true;}
        for(const entry of tree.files){if(entry.size>this.config.MAX_BLOB_BYTES)throw new Error("Historical folder file exceeds the configured size limit");const file=await this.blobs.readable(row,entry.path,revision.commitId,undefined,entry);try{await this.preserve(row,entry.path,revision.commitId,file,revision.mtime,null,null,causalOrder,verified);changed=true;}finally{await file.dispose();}}
        continue;
      }
      if(revision.size>this.config.MAX_BLOB_BYTES)throw new Error("Seafile revision exceeds the configured content limit");
      let file:StagedFile;try{file=await this.blobs.readable(row,operation.path,revision.commitId);}catch(error){if(error instanceof RevisionMissingError)continue;throw error;}
      try{await this.preserve(row,operation.path,revision.commitId,file,revision.mtime,operation.expected_hash,operation.target_hash,causalOrder,verified);if(file.hash!==operation.expected_hash&&file.hash!==operation.target_hash)changed=true;}finally{await file.dispose();}
    }
    this.store.run("UPDATE mirror_mutations SET state='captured',fence_commit=? WHERE id=?",fenceCommit.commitId,id);
    return changed;
  }
  async recover(row:VaultStorageRow):Promise<void>{for(const operation of this.store.all<{id:string}>("SELECT id FROM mirror_mutations WHERE vault_id=? AND state='prepared' ORDER BY created_at",row.id))await this.finish(row,operation.id);}
}
