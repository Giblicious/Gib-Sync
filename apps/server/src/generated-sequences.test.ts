import {randomUUID,createHash} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {afterEach,describe,expect,it} from "vitest";
import type {OperationBatch,SyncOperation,SyncTree} from "@gib-sync/protocol";
import {Store} from "./db.js";
import {SnapshotCommitter} from "./snapshot-commit.js";
import {getSyncTree} from "./operation-state.js";

type Expected={fileId:string;path:string;hash:string;size:number};
const owned:Array<{root:string;store:Store}>=[];
afterEach(()=>{for(const item of owned.splice(0)){try{item.store.db.close();}catch{}rmSync(item.root,{recursive:true,force:true});}});
function generator(seed:number){let state=seed>>>0;return ()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state;};}
const content=(text:string)=>({hash:createHash("sha256").update(text).digest("hex"),size:Buffer.byteLength(text),mtime:Date.now()});
function canonical(files:Expected[]){return files.map(({fileId,path,hash,size})=>({fileId,path,hash,size})).sort((a,b)=>a.path.localeCompare(b.path));}

describe("generated multi-device persistence sequences",()=>{
  for(let seed=1;seed<=16;seed++)it(`seed ${seed}: operations converge, retries are exact, stale writes cannot erase accepted content`,async()=>{
    const root=mkdtempSync(join(tmpdir(),"gib-generated-v2-")),fixture={root,store:new Store(root)};owned.push(fixture);const vaultId=randomUUID(),devices=[randomUUID(),randomUUID(),randomUUID()],random=generator(seed),reference=new Map<string,Expected>(),history:Array<string|null>=[null],folderId=randomUUID();let folder="Root",failStorage=false;
    fixture.store.run("INSERT INTO vaults(id,name,wrapped_key,created_at) VALUES(?,?,?,?)",vaultId,"Disposable","opaque",new Date().toISOString());
    const storage={async put(){if(failStorage)throw new Error("injected backend boundary");}},committer=()=>new SnapshotCommitter(fixture.store,storage as never,()=>({} as never));
    const make=(tree:SyncTree,operations:SyncOperation[],base=tree.snapshotId):OperationBatch=>({batchId:randomUUID(),baseSnapshotId:base,message:"Generated",operations});
    const accept=async(input:OperationBatch,deviceId:string,failAfterInsert=false)=>{const authority=committer(),preview=authority.previewBatch(vaultId,input,deviceId,"Test device");return authority.accept({vaultId,parentId:preview.parentId,deviceId,deviceName:"Test device",createdAt:preview.createdAt,message:input.message,entries:preview.tree.files,folders:preview.tree.folders.map(e=>e.path),folderEntries:preview.tree.folders,operationBatch:input,...(failAfterInsert?{afterInsert:()=>{throw new Error("injected metadata boundary");}}:{})});};
    await accept(make(getSyncTree(fixture.store,vaultId),[{operationId:randomUUID(),kind:"mkdir",targetId:folderId,path:folder,baseRevisionId:null}]),devices[0]);history.push(getSyncTree(fixture.store,vaultId).snapshotId);
    for(let step=0;step<48;step++){
      let tree=getSyncTree(fixture.store,vaultId);const device=devices[random()%devices.length],choice=random()%7,selected=tree.files.length?tree.files[random()%tree.files.length]:undefined,operationId=randomUUID();let operation:SyncOperation,update:()=>void;
      if(!selected||choice===0){const fileId=randomUUID(),path=`${folder}/new-${seed}-${step}.md`,bytes=content(`created ${seed} ${step}`);operation={operationId,targetId:fileId,baseRevisionId:null,kind:"create",path,content:bytes};update=()=>reference.set(fileId,{fileId,path,...bytes});}
      else if(choice===1||choice===6){const bytes=content(`edited ${seed} ${step}`);operation={operationId,targetId:selected.fileId!,baseRevisionId:selected.revision!.id,kind:"edit",content:bytes};update=()=>reference.set(selected.fileId!,{...reference.get(selected.fileId!)!,...bytes});}
      else if(choice===2){const path=`${folder}/moved-${seed}-${step}.md`;operation={operationId,targetId:selected.fileId!,baseRevisionId:selected.revision!.id,kind:"move",newPath:path};update=()=>reference.set(selected.fileId!,{...reference.get(selected.fileId!)!,path});}
      else if(choice===3){operation={operationId,targetId:selected.fileId!,baseRevisionId:selected.revision!.id,kind:"delete"};update=()=>{reference.delete(selected.fileId!);};}
      else if(choice===4){const next=`Folder-${seed}-${step}`,parent=tree.folders.find(e=>e.folderId===folderId)!;operation={operationId,targetId:folderId,baseRevisionId:parent.revision.id,kind:"move-folder",newPath:next,descendants:[...tree.files.map(e=>({targetId:e.fileId!,baseRevisionId:e.revision!.id})),...tree.folders.filter(e=>e.folderId!==folderId).map(e=>({targetId:e.folderId,baseRevisionId:e.revision.id}))]};update=()=>{for(const [id,file] of reference)reference.set(id,{...file,path:`${next}${file.path.slice(folder.length)}`});folder=next;};}
      else{const fileId=randomUUID(),path=`${folder}/offline-${seed}-${step}.md`,bytes=content(`offline device ${step}`);operation={operationId,targetId:fileId,baseRevisionId:null,kind:"create",path,content:bytes};update=()=>reference.set(fileId,{fileId,path,...bytes});}
      const input=make(tree,[operation],choice===5?history[Math.max(1,history.length-4)]:tree.snapshotId),before=structuredClone(tree);
      if(step%11===2){failStorage=true;await expect(accept(input,device)).rejects.toThrow("backend boundary");failStorage=false;expect(getSyncTree(fixture.store,vaultId)).toEqual(before);expect(committer().getBatch(vaultId,input.batchId)).toBeNull();}
      if(step%13===3){await expect(accept(input,device,true)).rejects.toThrow("metadata boundary");expect(getSyncTree(fixture.store,vaultId)).toEqual(before);expect(committer().getBatch(vaultId,input.batchId)).toBeNull();}
      const accepted=await accept(input,device);expect(accepted).not.toBeNull();update();history.push(accepted!.id);tree=getSyncTree(fixture.store,vaultId);expect(canonical(tree.files as Expected[])).toEqual(canonical([...reference.values()]));expect(tree.folders.map(e=>e.path)).toEqual([folder]);
      // Lost replies and process restarts replay the same immutable receipt,
      // never reinterpret a now-stale operation as a fresh mutation.
      if(step%7===0){fixture.store.db.close();fixture.store=new Store(root);const receipt=committer().getBatch(vaultId,input.batchId,device)!;expect(receipt.snapshot.id).toBe(accepted!.id);expect(receipt.replayed).toBe(true);const duplicate=await committer().accept({vaultId,parentId:input.baseSnapshotId,deviceId:device,deviceName:"Test device",message:input.message,entries:[],operationBatch:input});expect(duplicate?.id).toBe(accepted!.id);expect(getSyncTree(fixture.store,vaultId)).toEqual(tree);}
      if(selected&&(operation.kind==="edit"||operation.kind==="move"||operation.kind==="delete"||operation.kind==="move-folder")){
        const stale=make(tree,[{operationId:randomUUID(),targetId:selected.fileId!,baseRevisionId:selected.revision!.id,kind:"delete"}]);expect(()=>committer().previewBatch(vaultId,stale,devices[(devices.indexOf(device)+1)%3],"Offline device")).toThrow();expect(getSyncTree(fixture.store,vaultId)).toEqual(tree);
      }
    }
    expect(fixture.store.all("SELECT operation_id FROM sync_operations WHERE vault_id=?",vaultId)).toHaveLength(49);expect(fixture.store.all("SELECT batch_id FROM sync_batches WHERE vault_id=?",vaultId)).toHaveLength(49);expect(getSyncTree(fixture.store,vaultId).sequence).toBe(49);
  },20_000);
});
