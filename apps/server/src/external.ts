import { randomUUID } from "node:crypto";
import { detectMoves, type ManifestEntry,type Snapshot } from "@gib-sync/protocol";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { mergeText } from "./merge.js";
import { mergeSystemJson } from "./system-merge.js";
import { decryptVaultBlob,encryptVaultBlob,openJson,sha256 } from "./security.js";
import { SeafileStorage,type ReadableStorageEntry,type VaultStorageRow } from "./seafile.js";
import { SafeguardService } from "./safeguards.js";

type MirrorEntry={path:string;hash:string;size:number;storage_id:string|null;storage_mtime:number|null};
export interface ExternalImportResult{snapshotId:string|null;changedFiles:number;deletedFiles:number;conflicts:number;quarantineId?:string;locked?:boolean;}

const textExtensions=new Set(["md","txt","canvas","json","jsonl","css","js","ts","yaml","yml","xml","csv","svg","html"]);
const decoder=new TextDecoder(),encoder=new TextEncoder();

export class ExternalImporter{
  private readonly jobs=new Map<string,Promise<ExternalImportResult>>();
  constructor(private readonly config:Config,private readonly store:Store,private readonly storage:SeafileStorage,private readonly safeguards?:SafeguardService){}
  async settle():Promise<void>{await Promise.allSettled([...this.jobs.values()]);}

  scan(vaultId:string,fresh=false):Promise<ExternalImportResult>{
    const active=this.jobs.get(vaultId);if(active)return fresh?active.then(()=>this.scan(vaultId)):active;
    const job=this.run(vaultId).catch((error)=>{
      this.store.run("UPDATE vaults SET external_scan_at=?,external_error=? WHERE id=?",new Date().toISOString(),error instanceof Error?error.message:String(error),vaultId);
      throw error;
    }).finally(()=>this.jobs.delete(vaultId));
    this.jobs.set(vaultId,job);return job;
  }

  private storageRow(vaultId:string):VaultStorageRow{
    const row=this.store.one<VaultStorageRow>("SELECT id,storage_url,storage_username,storage_repo_id,storage_repo_name,storage_base_path,storage_token,storage_layout,mirror_base_path,mirror_head_id FROM vaults WHERE id=?",vaultId);
    if(!row?.storage_url||!row.storage_token)throw new Error("Vault storage is not configured");
    return row;
  }

  private async clear(row:VaultStorageRow,key:string,entry:ManifestEntry):Promise<Uint8Array>{
    return decryptVaultBlob(await this.storage.get(row,`blobs/${entry.hash.slice(0,2)}/${entry.hash}.gbs`),key,entry.hash);
  }

  private conflictPath(path:string,deviceName:string,mtime:number,occupied:Set<string>):string{
    const index=path.lastIndexOf("."),slash=path.lastIndexOf("/");
    const device=deviceName.replace(/[\\/:*?"<>|\[\]#]/g,"-").replace(/\s+/g," ").trim().slice(0,40)||"Unknown device";
    const date=new Date(Number.isFinite(mtime)&&mtime>0?mtime:Date.now());
    const stamp=(Number.isNaN(date.getTime())?new Date():date).toISOString().replace("T"," ").replace(/\.\d{3}Z$/," UTC").replace(/:/g,"-");
    const stem=index>slash?path.slice(0,index):path,extension=index>slash?path.slice(index):"";
    let candidate=`${stem} (conflict - ${device} - ${stamp})${extension}`,sequence=2;
    while(occupied.has(candidate))candidate=`${stem} (conflict - ${device} - ${stamp} - ${sequence++})${extension}`;
    return candidate;
  }

  private wikiLink(path:string):string{
    const target=path.toLowerCase().endsWith(".md")?path.slice(0,-3):path;
    return `[[${target.replace(/\|/g," ")}|${path.slice(path.lastIndexOf("/")+1)}]]`;
  }

  private warning(text:string,devices:string[],otherPath:string):string{
    return `> [!warning] Gib Sync conflict\n> Gib Sync preserved overlapping versions from **${devices.join("** and **")}**. No content was discarded.\n> Review the other version: ${this.wikiLink(otherPath)}\n\n${text}`;
  }

  private preserveDeletion(path:string,clear:Uint8Array,editor:string,deleter:string,final:Map<string,ManifestEntry>,newBytes:Map<string,Uint8Array>):void{
    const preserved=path.toLowerCase().endsWith(".md")
      ?encoder.encode(`> [!warning] Gib Sync deletion conflict\n> **${deleter}** deleted this note while **${editor}** modified it. Gib Sync kept the modified content here; delete this note if the deletion was intended.\n\n${decoder.decode(clear)}`)
      :clear;
    const hash=sha256(preserved);newBytes.set(hash,preserved);final.set(path,{path,hash,size:preserved.length,mtime:Date.now()});
  }

  private preservePair(path:string,current:ManifestEntry,currentBytes:Uint8Array,external:ManifestEntry,externalBytes:Uint8Array,currentName:string,preferred:"current"|"external",final:Map<string,ManifestEntry>,newBytes:Map<string,Uint8Array>,occupied:Set<string>):void{
    const currentIsNewer=preferred==="current",loser=currentIsNewer?external:current;
    const winnerBytes=currentIsNewer?currentBytes:externalBytes,loserBytes=currentIsNewer?externalBytes:currentBytes;
    const loserName=currentIsNewer?"Seafile":currentName,copyPath=this.conflictPath(path,loserName,loser.mtime,occupied);occupied.add(copyPath);
    let originalClear=winnerBytes,copyClear=loserBytes;
    if(path.toLowerCase().endsWith(".md")){
      const names=[currentName,"Seafile"];
      originalClear=encoder.encode(this.warning(decoder.decode(winnerBytes),names,copyPath));
      copyClear=encoder.encode(this.warning(decoder.decode(loserBytes),names,path));
    }
    const originalHash=sha256(originalClear),copyHash=sha256(copyClear);newBytes.set(originalHash,originalClear);newBytes.set(copyHash,copyClear);
    final.set(path,{path,hash:originalHash,size:originalClear.length,mtime:Date.now()});
    final.set(copyPath,{path:copyPath,hash:copyHash,size:copyClear.length,mtime:Date.now()});
  }

  private text(path:string):boolean{return textExtensions.has(path.split(".").pop()?.toLowerCase()??"");}
  private systemJson(path:string):boolean{return path.replace(/\\/g,"/").toLowerCase().startsWith(".obsidian/")&&path.toLowerCase().endsWith(".json");}

  private async run(vaultId:string):Promise<ExternalImportResult>{
    const row=this.storageRow(vaultId),remote=await this.storage.listReadable(row);
    if(remote.length>200_000)throw new Error("Readable Seafile vault exceeds 200,000 files");
    const remoteByPath=new Map(remote.map((entry)=>[entry.path,entry]));
    const mirrored=new Map(this.store.all<MirrorEntry>("SELECT path,hash,size,storage_id,storage_mtime FROM mirror_entries WHERE vault_id=?",vaultId).map((entry)=>[entry.path,entry]));
    const candidates=remote.filter((entry)=>{const previous=mirrored.get(entry.path);return !previous||previous.storage_id!==entry.id||previous.storage_mtime!==entry.mtime||previous.size!==entry.size;});
    const deleted=[...mirrored.values()].filter((entry)=>!remoteByPath.has(entry.path));
    const scannedAt=new Date().toISOString();
    if(!candidates.length&&!deleted.length){
      this.store.run("UPDATE vaults SET external_scan_at=?,external_error=NULL WHERE id=?",scannedAt,vaultId);
      return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0};
    }

    const vault=this.store.one<{head_id:string|null;wrapped_key:string}>("SELECT head_id,wrapped_key FROM vaults WHERE id=?",vaultId)!;
    const head=vault.head_id?this.store.getSnapshot(vault.head_id):null;
    const externalPreferred=(entry:ManifestEntry):"current"|"external"=>entry.mtime>=(head?Date.parse(head.createdAt):0)?"external":"current";
    const final=new Map((head?.entries??[]).map((entry)=>[entry.path,{...entry}])),occupied=new Set(final.keys());
    const key=openJson<string>(vault.wrapped_key,this.config.GIBSYNC_SERVER_SECRET,vaultId);
    const downloaded=new Map<string,{metadata:ReadableStorageEntry;bytes:Uint8Array;hash:string}>();
    for(const metadata of candidates){
      if(metadata.size>this.config.MAX_BLOB_BYTES)throw new Error(`External file exceeds the Gib Sync size limit: ${metadata.path}`);
      const bytes=await this.storage.getReadable(row,metadata.path),hash=sha256(bytes);
      downloaded.set(metadata.path,{metadata,bytes,hash});
    }

    const nextReadable=new Map<string,ManifestEntry>([...mirrored.values()].map((entry)=>[entry.path,{path:entry.path,hash:entry.hash,size:entry.size,mtime:(entry.storage_mtime??0)*1000}]));
    for(const missing of deleted)nextReadable.delete(missing.path);
    for(const [path,item] of downloaded)nextReadable.set(path,{path,hash:item.hash,size:item.bytes.length,mtime:item.metadata.mtime*1000});
    const deletedPaths=new Set(deleted.map((entry)=>entry.path)),externalMoves=detectMoves([...mirrored.values()].map((entry)=>({path:entry.path,hash:entry.hash,size:entry.size,mtime:(entry.storage_mtime??0)*1000})),[...nextReadable.values()])
      .filter((move)=>deletedPaths.has(move.previousPath)&&downloaded.has(move.path));
    const handledDownloads=new Set<string>(),handledDeletes=new Set<string>(),newBytes=new Map<string,Uint8Array>();let changedFiles=0,deletedFiles=0,conflicts=0;
    for(const move of externalMoves){
      const item=downloaded.get(move.path)!;if(final.has(move.path))continue;
      const current=final.get(move.previousPath),externalEntry:ManifestEntry={path:move.path,hash:item.hash,size:item.bytes.length,mtime:item.metadata.mtime*1000};
      const base=mirrored.get(move.previousPath);final.delete(move.previousPath);newBytes.set(item.hash,item.bytes);
      if(!current||!base||current.hash===base.hash)final.set(move.path,externalEntry);
      else if(externalEntry.hash===base.hash)final.set(move.path,{...current,path:move.path,mtime:Date.now()});
      else if(this.text(move.path)){
        const currentBytes=await this.clear(row,key,current),baseEntry:ManifestEntry={path:move.previousPath,hash:base.hash,size:base.size,mtime:0},preferred=externalPreferred(externalEntry);
        const baseText=decoder.decode(await this.clear(row,key,baseEntry)),currentText=decoder.decode(currentBytes),externalText=decoder.decode(item.bytes),merged=this.systemJson(move.path)?{text:mergeSystemJson(baseText,currentText,externalText,preferred),kind:"merged" as const}:mergeText(baseText,currentText,externalText,preferred);
        if(merged.kind==="large-conflict"||merged.kind==="merge-fallback"){conflicts++;this.preservePair(move.path,{...current,path:move.path},currentBytes,externalEntry,item.bytes,head?.deviceName??"Obsidian",preferred,final,newBytes,occupied);}
        else{const mergedBytes=encoder.encode(merged.text),hash=sha256(mergedBytes);newBytes.set(hash,mergedBytes);final.set(move.path,{path:move.path,hash,size:mergedBytes.length,mtime:Date.now()});}
      }else{
        conflicts++;const currentBytes=await this.clear(row,key,current);this.preservePair(move.path,{...current,path:move.path},currentBytes,externalEntry,item.bytes,head?.deviceName??"Obsidian",externalPreferred(externalEntry),final,newBytes,occupied);
      }
      handledDownloads.add(move.path);handledDeletes.add(move.previousPath);changedFiles++;
    }
    for(const [path,item] of downloaded){
      if(handledDownloads.has(path))continue;
      const base=mirrored.get(path),current=final.get(path);
      if(item.hash===base?.hash||item.hash===current?.hash)continue;
      changedFiles++;
      const externalEntry:ManifestEntry={path,hash:item.hash,size:item.bytes.length,mtime:item.metadata.mtime*1000};
      newBytes.set(item.hash,item.bytes);
      if(!current){
        if(base){conflicts++;this.preserveDeletion(path,item.bytes,"Seafile",head?.deviceName??"Obsidian",final,newBytes);}
        else final.set(path,externalEntry);
        occupied.add(path);continue;
      }
      if(!base){
        conflicts++;const currentBytes=await this.clear(row,key,current);
        this.preservePair(path,current,currentBytes,externalEntry,item.bytes,head?.deviceName??"Obsidian",externalPreferred(externalEntry),final,newBytes,occupied);continue;
      }
      if(current.hash===base.hash){final.set(path,externalEntry);continue;}
      if(this.text(path)){
        const baseEntry:ManifestEntry={path,hash:base.hash,size:base.size,mtime:0};
        const currentBytes=await this.clear(row,key,current);
        const preferred=externalPreferred(externalEntry),baseText=decoder.decode(await this.clear(row,key,baseEntry)),currentText=decoder.decode(currentBytes),externalText=decoder.decode(item.bytes),merged=this.systemJson(path)?{text:mergeSystemJson(baseText,currentText,externalText,preferred),kind:"merged" as const}:mergeText(baseText,currentText,externalText,preferred);
        if(merged.kind==="large-conflict"||merged.kind==="merge-fallback"){
          conflicts++;this.preservePair(path,current,currentBytes,externalEntry,item.bytes,head?.deviceName??"Obsidian",preferred,final,newBytes,occupied);continue;
        }
        const bytes=encoder.encode(merged.text),hash=sha256(bytes);newBytes.set(hash,bytes);
        final.set(path,{path,hash,size:bytes.length,mtime:Date.now()});continue;
      }
      conflicts++;
      const currentBytes=await this.clear(row,key,current);
      this.preservePair(path,current,currentBytes,externalEntry,item.bytes,head?.deviceName??"Obsidian",externalPreferred(externalEntry),final,newBytes,occupied);
    }
    for(const missing of deleted){
      if(handledDeletes.has(missing.path))continue;
      const current=final.get(missing.path);if(!current)continue;
      if(current.hash===missing.hash){final.delete(missing.path);deletedFiles++;}
      else{
        conflicts++;changedFiles++;
        this.preserveDeletion(missing.path,await this.clear(row,key,current),head?.deviceName??"Obsidian","Seafile",final,newBytes);
      }
    }

    if(!changedFiles&&!deletedFiles){
      for(const item of downloaded.values())this.store.run("UPDATE mirror_entries SET storage_id=?,storage_mtime=?,size=? WHERE vault_id=? AND path=?",item.metadata.id,item.metadata.mtime,item.metadata.size,vaultId,item.metadata.path);
      this.store.run("UPDATE vaults SET external_scan_at=?,external_error=NULL WHERE id=?",scannedAt,vaultId);
      return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts};
    }

    for(const [hash,bytes] of newBytes){
      if(this.store.one("SELECT 1 FROM blobs WHERE vault_id=? AND hash=?",vaultId,hash))continue;
      await this.storage.put(row,`blobs/${hash.slice(0,2)}/${hash}.gbs`,encryptVaultBlob(bytes,key,hash));
      this.store.run("INSERT OR IGNORE INTO blobs(vault_id,hash,size,created_at) VALUES(?,?,?,?)",vaultId,hash,bytes.length,scannedAt);
    }
    const entries=[...final.values()].sort((left,right)=>left.path.localeCompare(right.path));
    const decision=this.safeguards?.propose({vaultId,deviceId:`seafile:${vaultId}`,deviceName:"Seafile",parentId:head?.id??null,message:`Seafile external change (${changedFiles} changed, ${deletedFiles} deleted)`,entries,source:"seafile"});
    if(decision&&!decision.allowed){
      this.store.run("UPDATE vaults SET external_scan_at=?,external_error=NULL WHERE id=?",scannedAt,vaultId);
      if(decision.quarantine&&decision.created)this.safeguards?.event(vaultId,"external_quarantine","warning",`Seafile changes were quarantined: ${decision.assessment.reasons.join("; ")}`);
      return {snapshotId:null,changedFiles,deletedFiles,conflicts,quarantineId:decision.quarantine?.id,locked:decision.locked};
    }
    const snapshot:Snapshot={
      id:randomUUID(),vaultId,parentId:head?.id??null,deviceId:`seafile:${vaultId}`,deviceName:"Seafile",
      createdAt:scannedAt,message:`Seafile external change (${changedFiles} changed, ${deletedFiles} deleted${conflicts?`, ${conflicts} conflicts`:""})`,
      entries
    };
    await this.storage.put(row,`snapshots/${snapshot.id}.json`,Buffer.from(JSON.stringify(snapshot)),"application/json");
    this.store.db.exec("BEGIN IMMEDIATE");
    try{
      const currentHead=this.store.one<{head_id:string|null}>("SELECT head_id FROM vaults WHERE id=?",vaultId)!.head_id;
      if(currentHead!==(head?.id??null)){this.store.db.exec("ROLLBACK");return {snapshotId:null,changedFiles:0,deletedFiles:0,conflicts:0};}
      this.store.run("INSERT INTO snapshots(id,vault_id,parent_id,device_id,device_name,created_at,message,manifest_json) VALUES(?,?,?,?,?,?,?,?)",snapshot.id,vaultId,snapshot.parentId,snapshot.deviceId,snapshot.deviceName,snapshot.createdAt,snapshot.message,JSON.stringify(snapshot));
      this.store.run("UPDATE vaults SET head_id=?,external_scan_at=?,external_import_at=?,external_error=NULL WHERE id=?",snapshot.id,scannedAt,scannedAt,vaultId);
      for(const item of downloaded.values())this.store.run("INSERT INTO mirror_entries(vault_id,path,hash,size,updated_at,storage_id,storage_mtime) VALUES(?,?,?,?,?,?,?) ON CONFLICT(vault_id,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,updated_at=excluded.updated_at,storage_id=excluded.storage_id,storage_mtime=excluded.storage_mtime",vaultId,item.metadata.path,item.hash,item.bytes.length,scannedAt,item.metadata.id,item.metadata.mtime);
      for(const missing of deleted)if(!final.has(missing.path))this.store.run("DELETE FROM mirror_entries WHERE vault_id=? AND path=?",vaultId,missing.path);
      this.store.db.exec("COMMIT");
    }catch(error){try{this.store.db.exec("ROLLBACK");}catch{}throw error;}
    return {snapshotId:snapshot.id,changedFiles,deletedFiles,conflicts};
  }
}
