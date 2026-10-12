import type {DataAdapter} from "obsidian";
import type {ManifestEntry} from "@gib-sync/protocol";
import {hashBytes} from "./crypto";
import {hashAdapterFile,AdapterFileChangedError} from "./file-io";
import {isSafeVaultPath} from "./settings";
import {SyncCancelledError} from "./sync-recovery";

type Stamp={size:number;mtime:number;ctime:number};
export interface InventoryEntry extends ManifestEntry{ctime:number;verifiedAt:number;}
type Bucket={version:2;scope:string;payload:string;hash:string};
const ROOT=".gib-sync/inventory-v2",MAX_BUCKET_BYTES=4*1024*1024,MAX_FILES=200_000,AUDIT_MS=6*60*60*1000;
const encoder=new TextEncoder(),decoder=new TextDecoder();
const validStamp=(stamp:Stamp)=>[stamp.size,stamp.mtime,stamp.ctime].every(value=>Number.isFinite(value)&&value>=0);

/** Durable content index. Timestamps are hints, never proof of unchanged bytes. */
export class VaultInventory{
  private readonly entries=new Map<string,InventoryEntry>();
  private readonly sessionVerified=new Set<string>();
  private readonly dirty=new Set<string>();
  private dirtyScope="";
  private readonly dirtyGenerations=new Map<string,number>();
  private readonly dirtyBuckets=new Set<string>();
  private readonly buckets=new Map<string,string>();
  private loaded:Promise<void>|null=null;
  private stopped=false;
  private tail:Promise<void>=Promise.resolve();
  private auditCursor=0;
  private auditPaths:string[]=[];
  private keysChanged=true;
  private scope="";
  constructor(private readonly adapter:DataAdapter,private readonly scopeValue:()=>string,private readonly cooperate:()=>Promise<void>,private readonly canBuffer:(size:number)=>boolean=()=>true,private readonly allowed:()=>void=()=>{}){}
  get pendingVerification():number{return Math.max(0,this.entries.size-this.sessionVerified.size);}
  get size():number{return this.entries.size;}
  known(path:string):InventoryEntry|undefined{const entry=this.entries.get(path);return entry?{...entry}:undefined;}
  paths():string[]{return [...this.entries.keys()];}
  ready():Promise<void>{return this.load();}
  stop():void{this.stopped=true;}
  private checkpoint():void{if(this.stopped)throw new SyncCancelledError("Background verification stopped safely.");this.allowed();}
  private async bucket(path:string):Promise<string>{let bucket=this.buckets.get(path);if(!bucket){bucket=(await hashBytes(encoder.encode(path))).slice(0,2);this.buckets.set(path,bucket);}return bucket;}
  private async load():Promise<void>{
    const scope=this.scopeValue();if(this.loaded&&this.scope===scope)return this.loaded;
    if(this.dirtyScope!==scope){this.dirty.clear();this.dirtyGenerations.clear();}this.dirtyScope=scope;this.scope=scope;this.entries.clear();this.sessionVerified.clear();this.dirtyBuckets.clear();this.buckets.clear();this.auditCursor=0;this.auditPaths=[];this.keysChanged=true;
    this.loaded=(async()=>{
      let files:string[]=[];try{files=(await this.adapter.list(ROOT)).files;}catch{return;}
      for(const path of files){this.checkpoint();if(!/^\.gib-sync\/inventory-v2\/[a-f0-9]{2}\.json$/.test(path))continue;
        try{const stat=await this.adapter.stat(path);if(stat?.type!=="file"||stat.size>MAX_BUCKET_BYTES)continue;const packed=JSON.parse(decoder.decode(new Uint8Array(await this.adapter.readBinary(path)))) as Bucket;if(packed.version!==2||packed.scope!==scope||typeof packed.payload!=="string"||await hashBytes(encoder.encode(packed.payload))!==packed.hash)continue;
          const rows=JSON.parse(packed.payload) as InventoryEntry[];if(!Array.isArray(rows))continue;
          let processed=0;for(const row of rows){if(++processed%64===0){this.checkpoint();await this.cooperate();}if(this.entries.size>=MAX_FILES)break;if(!row||!isSafeVaultPath(row.path)||!validStamp({size:row.size,mtime:row.mtime,ctime:row.ctime})||!/^[a-f0-9]{64}$/.test(row.hash)||!Number.isFinite(row.verifiedAt)||row.verifiedAt<0)continue;this.entries.set(row.path,row);this.buckets.set(row.path,path.slice(-7,-5));}
        }catch{/* Torn or corrupt cache cannot establish content truth. */}
        await this.cooperate();
      }
    })();return this.loaded;
  }
  markDirty(path:string):void{if(isSafeVaultPath(path)){const scope=this.scopeValue();if(this.dirtyScope!==scope){this.dirty.clear();this.dirtyGenerations.clear();this.dirtyScope=scope;}this.dirtyGenerations.set(path,(this.dirtyGenerations.get(path)??0)+1);this.dirty.add(path);this.sessionVerified.delete(path);}}
  markMove(from:string,to:string):void{for(const path of this.entries.keys())if(path===from||path.startsWith(`${from}/`)){this.markDirty(path);this.markDirty(path===from?to:`${to}${path.slice(from.length)}`);}}
  async inspect(path:string,force=false):Promise<InventoryEntry|null>{
    await this.load();this.checkpoint();const generation=this.dirtyGenerations.get(path)??0,stat=await this.adapter.stat(path);if(generation!==(this.dirtyGenerations.get(path)??0))throw new AdapterFileChangedError(path);
    if(stat?.type!=="file"){if(this.entries.delete(path)){this.dirtyBuckets.add(await this.bucket(path));this.keysChanged=true;}this.sessionVerified.delete(path);this.dirty.delete(path);return null;}
    const saved=this.entries.get(path),same=saved&&saved.size===stat.size&&saved.mtime===stat.mtime&&saved.ctime===stat.ctime;
    if(!force&&same&&!this.dirty.has(path))return {...saved};
    const hash=await hashAdapterFile(this.adapter,path,()=>this.checkpoint(),this.cooperate,this.canBuffer(stat.size));this.checkpoint();const after=await this.adapter.stat(path);if(generation!==(this.dirtyGenerations.get(path)??0))throw new AdapterFileChangedError(path);if(after?.type!=="file")return null;
    const next:InventoryEntry={...saved,path,hash,size:after.size,mtime:after.mtime,ctime:after.ctime,verifiedAt:Date.now()};this.entries.set(path,next);if(!saved)this.keysChanged=true;this.sessionVerified.add(path);this.dirty.delete(path);this.dirtyBuckets.add(await this.bucket(path));return {...next};
  }
  async finishListing(paths:readonly string[]):Promise<void>{await this.load();const visible=new Set(paths);for(const path of [...this.entries.keys()])if(!visible.has(path)){this.entries.delete(path);this.keysChanged=true;this.sessionVerified.delete(path);this.dirty.delete(path);this.dirtyBuckets.add(await this.bucket(path));}await this.flush();}
  async verifyStep(maxFiles=16,maxBytes=8*1024*1024,maxMilliseconds=16):Promise<{changedPaths:string[];pending:number;checked:number}>{
    await this.load();this.checkpoint();if(this.keysChanged){this.auditPaths=[...this.entries.keys()];this.keysChanged=false;}const paths=this.auditPaths,changedPaths:string[]=[];let checked=0,bytes=0,visited=0;const started=performance.now(),now=Date.now();
    while(paths.length&&visited<Math.min(paths.length,512)&&checked<maxFiles){this.checkpoint();if(visited&&performance.now()-started>=maxMilliseconds)break;const path=paths[this.auditCursor++%paths.length];visited++;if(visited%64===0)await this.cooperate();const before=this.entries.get(path);if(!before)continue;
      const due=!this.sessionVerified.has(path)||now<before.verifiedAt||now-before.verifiedAt>=AUDIT_MS||this.dirty.has(path);if(!due)continue;
      const after=await this.inspect(path,true);checked++;bytes+=before.size;if(!after||after.hash!==before.hash)changedPaths.push(path);await this.cooperate();if(bytes>=maxBytes||performance.now()-started>=maxMilliseconds)break;
    }
    await this.flush();return {changedPaths,pending:this.pendingVerification,checked};
  }
  async flush():Promise<void>{
    const writing=this.tail.catch(()=>{}).then(async()=>{await this.load();const buckets=[...this.dirtyBuckets],remaining=new Set(buckets);this.dirtyBuckets.clear();if(!buckets.length)return;try{
      if(!await this.adapter.exists(".gib-sync"))await this.adapter.mkdir(".gib-sync");if(!await this.adapter.exists(ROOT))await this.adapter.mkdir(ROOT);
      const wanted=new Set(buckets),rowsByBucket=new Map(buckets.map(bucket=>[bucket,[] as InventoryEntry[]]));let visited=0;
      for(const [path,row] of this.entries){const bucket=await this.bucket(path);if(wanted.has(bucket))rowsByBucket.get(bucket)!.push(row);if(++visited%64===0)await this.cooperate();}
      for(const bucket of buckets){this.checkpoint();const payload=JSON.stringify(rowsByBucket.get(bucket)),packed:Bucket={version:2,scope:this.scope,payload,hash:await hashBytes(encoder.encode(payload))};await this.adapter.writeBinary(`${ROOT}/${bucket}.json`,encoder.encode(JSON.stringify(packed)).buffer);remaining.delete(bucket);await this.cooperate();}
      }catch(error){for(const bucket of remaining)this.dirtyBuckets.add(bucket);throw error;}
    });this.tail=writing;return writing;
  }
}
