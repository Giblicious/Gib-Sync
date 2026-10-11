import type {DataAdapter} from "obsidian";
import type {Snapshot} from "@gib-sync/protocol";
import {hashBytes} from "./crypto";
const root=".gib-sync/snapshot-cache",encoder=new TextEncoder();
const MAX_CACHE_BYTES=4*1024*1024;

/** A bounded transport cache, never a local sync baseline/checkpoint authority. */
export class SnapshotCache {
  private readonly memory=new Map<string,Snapshot>();
  constructor(private readonly adapter:DataAdapter){}
  private path(id:string):string|null{return /^[a-zA-Z0-9-]{1,100}$/.test(id)?`${root}/${id}.json`:null;}
  async get(id:string,vaultId:string):Promise<Snapshot|null>{
    const saved=this.memory.get(id);if(saved?.vaultId===vaultId)return saved;
    const path=this.path(id);if(!path)return null;
    try{
      if(((await this.adapter.stat(path))?.size??0)>MAX_CACHE_BYTES)return null;
      const raw=await this.adapter.read(path);if(raw.length>MAX_CACHE_BYTES)return null;
      const packed=JSON.parse(raw) as {payload:string;hash:string};
      if(typeof packed.payload!=="string"||await hashBytes(encoder.encode(packed.payload))!==packed.hash)return null;
      const value=JSON.parse(packed.payload) as Snapshot;
      if(value.id!==id||value.vaultId!==vaultId||!Array.isArray(value.entries))return null;
      this.remember(value);return value;
    }catch{return null;}
  }
  private remember(snapshot:Snapshot){this.memory.delete(snapshot.id);this.memory.set(snapshot.id,snapshot);while(this.memory.size>3)this.memory.delete(this.memory.keys().next().value!);}
  async put(snapshot:Snapshot):Promise<void>{
    const payload=JSON.stringify(snapshot);if(payload.length>MAX_CACHE_BYTES/2)return;
    this.remember(snapshot);const path=this.path(snapshot.id);if(!path)return;
    try{
      for(const directory of [".gib-sync",root])if(!await this.adapter.exists(directory))await this.adapter.mkdir(directory);
      const hash=await hashBytes(encoder.encode(payload));await this.adapter.write(path,JSON.stringify({payload,hash}));
      const files=(await this.adapter.list(root)).files.filter(file=>file.startsWith(`${root}/`)&&/^[a-zA-Z0-9-]{1,100}\.json$/.test(file.slice(root.length+1)));
      if(files.length>3){
        const ordered=await Promise.all(files.map(async file=>({path:file,time:(await this.adapter.stat(file))?.mtime??0})));
        for(const file of ordered.sort((a,b)=>b.time-a.time).slice(3))await this.adapter.remove(file.path);
      }
    }catch{/* A missing/full cache must not block sync or change user data. */}
  }
}
