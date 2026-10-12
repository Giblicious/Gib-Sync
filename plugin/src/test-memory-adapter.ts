import type {DataAdapter} from "obsidian";

/** Disposable, faithful no-clobber native adapter simulation for fault tests. */
export class TestMemoryAdapter{
  files=new Map<string,Uint8Array>();dirs=new Set<string>();stamps=new Map<string,{mtime:number;ctime:number}>();reads:string[]=[];calls:Array<{method:string;path:string;destination?:string}>=[];
  before:((method:string,path:string,destination?:string)=>Promise<void>|void)|null=null;
  after:((method:string,path:string,destination?:string)=>Promise<void>|void)|null=null;
  private async enter(method:string,path:string,destination?:string){this.calls.push({method,path,...destination?{destination}:{}});await this.before?.(method,path,destination);}
  private async leave(method:string,path:string,destination?:string){await this.after?.(method,path,destination);}
  put(path:string,value:string|Uint8Array,stamp={mtime:1,ctime:1}){this.files.set(path,typeof value==="string"?new TextEncoder().encode(value):value.slice());this.stamps.set(path,stamp);this.parents(path);}
  private parents(path:string){const parts=path.split("/");for(let index=1;index<parts.length;index++)this.dirs.add(parts.slice(0,index).join("/"));}
  getResourcePath(path:string){return `app://gib-sync-disposable/${encodeURIComponent(path)}`;}
  async exists(path:string){return this.files.has(path)||this.dirs.has(path);}
  async stat(path:string){const file=this.files.get(path);return file?{type:"file" as const,size:file.length,...this.stamps.get(path)??{mtime:1,ctime:1}}:this.dirs.has(path)?{type:"folder" as const,size:0,mtime:1,ctime:1}:null;}
  async list(path:string){const prefix=path?`${path}/`:"",files:string[]=[],folders=new Set<string>();for(const name of this.files.keys())if(name.startsWith(prefix)){const remainder=name.slice(prefix.length),slash=remainder.indexOf("/");if(slash<0)files.push(name);else folders.add(`${prefix}${remainder.slice(0,slash)}`);}for(const name of this.dirs)if(name.startsWith(prefix)&&name!==path){const rest=name.slice(prefix.length),slash=rest.indexOf("/");folders.add(slash<0?name:`${prefix}${rest.slice(0,slash)}`);}return {files,folders:[...folders]};}
  async mkdir(path:string){await this.enter("mkdir",path);this.parents(path);this.dirs.add(path);await this.leave("mkdir",path);}
  async readBinary(path:string){this.reads.push(path);const file=this.files.get(path);if(!file)throw Object.assign(new Error("missing file"),{code:"ENOENT"});return file.slice().buffer;}
  async writeBinary(path:string,body:ArrayBuffer){await this.enter("write",path);this.put(path,new Uint8Array(body));await this.leave("write",path);}
  async appendBinary(path:string,body:ArrayBuffer){await this.enter("append",path);const prior=this.files.get(path)??new Uint8Array(),next=new Uint8Array(prior.length+body.byteLength);next.set(prior);next.set(new Uint8Array(body),prior.length);this.put(path,next);await this.leave("append",path);}
  async remove(path:string){await this.enter("remove",path);this.files.delete(path);this.stamps.delete(path);await this.leave("remove",path);}
  async copy(path:string,destination:string){await this.enter("copy",path,destination);if(await this.exists(destination))throw Object.assign(new Error("destination exists"),{code:"EEXIST"});const file=this.files.get(path);if(!file)throw new Error("missing source");this.put(destination,file);await this.leave("copy",path,destination);}
  async rename(path:string,destination:string){await this.enter("rename",path,destination);if(this.dirs.has(path)){if(await this.exists(destination))throw Object.assign(new Error("directory destination exists"),{code:"EEXIST"});const files=[...this.files],dirs=[...this.dirs];for(const [name,body]of files)if(name.startsWith(`${path}/`)){this.put(`${destination}${name.slice(path.length)}`,body,this.stamps.get(name));this.files.delete(name);this.stamps.delete(name);}for(const name of dirs)if(name===path||name.startsWith(`${path}/`)){this.dirs.add(`${destination}${name.slice(path.length)}`);this.dirs.delete(name);}}else{const file=this.files.get(path);if(!file)throw new Error("missing source");this.put(destination,file,this.stamps.get(path));this.files.delete(path);this.stamps.delete(path);}await this.leave("rename",path,destination);}
  async rmdir(path:string,recursive:boolean){await this.enter("rmdir",path);if(recursive)throw new Error("Recursive test deletion is forbidden");if((await this.list(path)).files.length||(await this.list(path)).folders.length)throw new Error("not empty");this.dirs.delete(path);await this.leave("rmdir",path);}
  asAdapter(){return this as unknown as DataAdapter;}
  restart(){const copy=new TestMemoryAdapter();for(const [path,body]of this.files)copy.files.set(path,body.slice());copy.dirs=new Set(this.dirs);copy.stamps=new Map([...this.stamps].map(([path,value])=>[path,{...value}]));return copy;}
}
