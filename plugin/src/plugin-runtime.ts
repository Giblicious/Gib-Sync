import type {DataAdapter} from "obsidian";
import {hashAdapterFile} from "./file-io";
import {isSafeVaultPath,isDeviceLocalPlugin} from "./settings";
import {AdapterFileChangedError} from "./file-io";

type Instance={app:unknown;manifest:{id:string;dir?:string};loadData():Promise<unknown>;saveData(value:unknown):Promise<void>};
export class PackageRuntimeHoldError extends Error{constructor(readonly pluginId:string,message:string){super(message);this.name="PackageRuntimeHoldError";}}
export interface PackageRuntime{
  quiesce(id:string):Promise<void>;
  activate(id:string,expectedDataHash:string|null):Promise<void>;
  confirmRetirement?(id:string):Promise<void>;
  finish():Promise<void>;
  dispose():void;
}
export interface RuntimeManager{
  plugins:Record<string,Instance>;
  manifests:Record<string,{id:string;version?:string;isDesktopOnly?:boolean}>;
  enabledPlugins:Set<string>;
  disablePlugin(id:string):Promise<unknown>;
  enablePlugin(id:string):Promise<unknown>;
  loadManifest(directory:string):Promise<unknown>;
}
type Proof={manifest:string|null;main:string|null;data:string|null};
type Guard={id:string;previous?:Instance;wanted:boolean;phase:"unloading"|"quiesced"|"loading"|"active";expected:string|null;approved:WeakSet<Instance>;writes:Set<Promise<unknown>>;writeFailure?:string;verifiedData?:string|null;prior?:Proof;incoming?:{proof:Proof;dataCopy?:string;recovery?:{path:string;expected:string|null;vacated:boolean}};activated:boolean;activationFailed?:boolean;cleanup?:boolean;loadToken?:symbol;};
type LifecycleKind="disable"|"manifest"|"enable"|"settings recovery";
type LifecycleAttempt={token:symbol;kind:LifecycleKind;settled:boolean;failed:boolean;promise:Promise<unknown>};
type Component={owner:PluginRuntimeCoordinator;guard:Guard;manager:RuntimeManager;busy:boolean;needsRecovery:boolean;pending?:LifecycleAttempt};
type SharedHooks={originalLoad:Instance["loadData"];originalSave:Instance["saveData"];load:Instance["loadData"];save:Instance["saveData"];owners:Set<PluginRuntimeCoordinator>};
const sharedHooks=new WeakMap<object,SharedHooks>();
// A timeout is not cancellation of a third-party Promise. Keep per-app/plugin
// ownership, including across coordinator disposal, until real settlement and
// verified recovery; no later attempt may race its manager or filesystem work.
const sharedComponents=new WeakMap<object,Map<string,Component>>();

/** Scoped runtime suspension complements the recoverable filesystem switch.
 * No AndSave API is used: the synchronized enablement file remains authoritative.
 * Unsupported plugin managers are held before package files are changed.
 * This fences public settings APIs and detects startup bypass writes; it is
 * not a sandbox for arbitrary third-party filesystem code or retained FDs.
 */
export class PluginRuntimeCoordinator implements PackageRuntime{
  private readonly guards=new Map<string,Guard>();
  private readonly originalLoad:Instance["loadData"];
  private readonly originalSave:Instance["saveData"];
  private readonly wrappedLoad:Instance["loadData"];
  private readonly wrappedSave:Instance["saveData"];
  private readonly hooks:SharedHooks;
  private readonly originalInstanceSaves=new WeakMap<Instance,Instance["saveData"]>();
  private readonly activeFences=new Map<Instance,{descriptor:PropertyDescriptor|undefined;wrapper:Instance["saveData"]}>();
  private closed=false;
  constructor(private readonly app:unknown,private readonly prototype:Pick<Instance,"loadData"|"saveData">,private readonly manager:()=>RuntimeManager|undefined,private readonly adapter:DataAdapter,private readonly pluginRoot:(id:string)=>string,private readonly isMobile:boolean,private readonly checkpoint:()=>void,private readonly cooperate:()=>Promise<void>,private readonly hold:(id:string,message:string,attention?:boolean)=>void,private readonly settingsWriteTimeoutMs=15000){
    const existing=sharedHooks.get(prototype);this.originalLoad=existing?.originalLoad??prototype.loadData;this.originalSave=existing?.originalSave??prototype.saveData;const owner=this;
    this.wrappedLoad=async function(this:Instance){const guard=owner.guard(this),token=guard?.loadToken;if(!guard||guard.phase!=="loading"||!token)return owner.originalLoad.call(this);
      if(!guard.cleanup)owner.checkpoint();const path=`${owner.pluginRoot(guard.id)}/data.json`;if(await owner.hash(path,guard.cleanup)!==guard.expected)throw new Error("Plugin settings changed before their fresh runtime load");
      const value=await owner.originalLoad.call(this);if(owner.guards.get(guard.id)!==guard||guard.phase!=="loading"||guard.loadToken!==token)throw new Error("Plugin settings load belongs to a retired runtime attempt");if(await owner.hash(path,guard.cleanup)!==guard.expected)throw new Error("Plugin settings changed during their fresh runtime load");if(owner.guards.get(guard.id)!==guard||guard.phase!=="loading"||guard.loadToken!==token)throw new Error("Plugin settings load belongs to a retired runtime attempt");guard.approved.add(this);return value;
    };
    this.wrappedSave=async function(this:Instance,value){const guard=owner.guard(this);if(!guard)return owner.originalSave.call(this,value);
      if(guard.phase==="unloading"&&this===guard.previous||guard.approved.has(this))return owner.trackWrite(guard,()=>owner.originalSave.call(this,value),this!==guard.previous);
      await owner.preserveSave(guard.id,value,this);
    };
    if(existing){this.hooks=existing;existing.owners.add(this);}else{
      const owners=new Set([this]),originalLoad=this.originalLoad,originalSave=this.originalSave;
      const load=async function(this:Instance){for(const instance of owners)if(instance.guard(this))return instance.wrappedLoad.call(this);return originalLoad.call(this);};
      const save=async function(this:Instance,value:unknown){for(const instance of owners)if(instance.guard(this))return instance.wrappedSave.call(this,value);return originalSave.call(this,value);};
      this.hooks={owners,originalLoad,originalSave,load,save};sharedHooks.set(prototype,this.hooks);prototype.loadData=load;prototype.saveData=save;
    }
  }
  private guard(instance:Instance):Guard|undefined{return instance.app===this.app&&!isDeviceLocalPlugin(instance.manifest?.id??"")?this.guards.get(instance.manifest?.id):undefined;}
  private components():Map<string,Component>{let map=sharedComponents.get(this.app as object);if(!map){map=new Map();sharedComponents.set(this.app as object,map);}return map;}
  private newGuard(id:string,manager:RuntimeManager):Guard{return {id,previous:manager.plugins[id],wanted:manager.enabledPlugins.has(id),phase:"unloading",expected:null,approved:new WeakSet(),writes:new Set(),activated:false};}
  private retire(component:Component):void{const guard=component.guard;guard.loadToken=undefined;guard.approved=new WeakSet();guard.phase="quiesced";guard.activated=false;component.needsRecovery=true;}
  private owned(component:Component):boolean{return this.components().get(component.guard.id)===component&&component.owner===this&&this.guards.get(component.guard.id)===component.guard;}
  private async lifecycle<T>(component:Component,kind:LifecycleKind,operation:()=>Promise<T>):Promise<T>{
    const guard=component.guard;if(!this.owned(component)||component.pending)throw new PackageRuntimeHoldError(guard.id,"An earlier plugin runtime operation still owns this component");if(!guard.cleanup){if(this.closed)throw new PackageRuntimeHoldError(guard.id,"The runtime coordinator was disposed before activation");this.checkpoint();}
    const attempt:LifecycleAttempt={token:Symbol(kind),kind,settled:false,failed:false,promise:Promise.resolve()};component.pending=attempt;
    attempt.promise=Promise.resolve().then(operation).then(value=>{attempt.settled=true;return value;},error=>{attempt.settled=true;throw error;});void attempt.promise.catch(()=>{});
    let timer:ReturnType<typeof setTimeout>|undefined;const deadline=Date.now()+this.settingsWriteTimeoutMs;
    const watchdog=new Promise<never>((_,reject)=>{const inspect=()=>{try{if(!this.owned(component)||component.pending!==attempt)throw new Error("Plugin runtime attempt ownership changed");if(!guard.cleanup){if(this.closed)throw new Error("The runtime coordinator was disposed during activation");this.checkpoint();}if(Date.now()>=deadline)throw new Error(`Plugin runtime ${kind} timed out; this component is held until the original operation finishes`);timer=setTimeout(inspect,Math.min(25,Math.max(1,deadline-Date.now())));}catch(error){reject(error);}};inspect();});
    try{const result=await Promise.race([attempt.promise,watchdog]);if(!this.owned(component)||component.pending!==attempt)throw new Error("Plugin runtime attempt ownership changed");component.pending=undefined;return result as T;}
    catch(error){attempt.failed=true;this.retire(component);if(kind==="enable")guard.activationFailed=true;const message=error instanceof Error?error.message:String(error);throw new PackageRuntimeHoldError(guard.id,kind==="settings recovery"?`Runtime settings recovery remains held; ${message}`:message);}
    finally{if(timer!==undefined)clearTimeout(timer);}
  }
  private async begin(id:string,manager:RuntimeManager):Promise<Component>{
    const map=this.components();let component=map.get(id);
    if(component?.busy)throw new PackageRuntimeHoldError(id,"Another managed runtime attempt is still working on this plugin");
    if(component&&component.owner!==this){if(!component.owner.closed)throw new PackageRuntimeHoldError(id,"Another coordinator owns this plugin runtime");await component.owner.recoverExternal(component);component=map.get(id);if(component)throw new PackageRuntimeHoldError(id,"The previous runtime still protects unfinished work for this plugin");}
    if(component&&component.manager!==manager)throw new PackageRuntimeHoldError(id,"The plugin manager changed while protected runtime work is unfinished");
    if(!component){const guard=this.guards.get(id)??this.newGuard(id,manager);this.guards.set(id,guard);component={owner:this,guard,manager,busy:false,needsRecovery:false};map.set(id,component);}
    component.busy=true;
    try{if(component.needsRecovery||component.pending)await this.recover(component);return component;}catch(error){this.end(component);throw error;}
  }
  private end(component:Component):void{component.busy=false;if(this.closed&&!component.pending&&!component.needsRecovery&&this.owned(component)){this.components().delete(component.guard.id);this.guards.delete(component.guard.id);this.detachHooksIfSafe();}}
  private async recoverExternal(component:Component):Promise<void>{if(component.busy)throw new PackageRuntimeHoldError(component.guard.id,"Plugin recovery is already owned by an earlier attempt");component.busy=true;try{await this.recover(component);}finally{this.end(component);}}
  private async recover(component:Component):Promise<void>{
    const {guard,manager}=component;if(!this.owned(component))throw new PackageRuntimeHoldError(guard.id,"The protected runtime recovery owner changed");
    if(component.pending&&!component.pending.settled)throw new PackageRuntimeHoldError(guard.id,"The previous plugin runtime operation has not finished; only this component remains held");
    component.pending=undefined;this.retire(component);const cleanup=guard.cleanup;guard.cleanup=true;
    try{const instance=manager.plugins[guard.id];if(instance){try{this.fence(guard,instance);}catch{this.hold(guard.id,"The plugin has an unsupported settings override; all verified checkpoints remain protected");}guard.approved.delete(instance);await this.lifecycle(component,"disable",()=>manager.disablePlugin(guard.id));if(manager.plugins[guard.id])throw new Error("The failed plugin remained active after managed suspension");this.activeFences.delete(instance);}
      await this.drain(guard,guard.incoming!==undefined);if(guard.incoming)await this.lifecycle(component,"settings recovery",()=>this.restoreIncoming(guard));component.needsRecovery=false;
    }catch(error){component.needsRecovery=true;throw error instanceof PackageRuntimeHoldError?error:new PackageRuntimeHoldError(guard.id,"Runtime settings recovery remains held; all verified checkpoints were retained");}
    finally{guard.cleanup=cleanup;}
  }
  private require(id:string):RuntimeManager{
    if(this.closed||isDeviceLocalPlugin(id)||!isSafeVaultPath(id)||/[\\/:*?"<>|\x00-\x1f]/.test(id)||id.endsWith(".")||id.trim()!==id||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id))throw new Error("Invalid managed plugin runtime scope");const manager=this.manager();
    if(!manager||!manager.plugins||!manager.manifests||!(manager.enabledPlugins instanceof Set)||typeof manager.disablePlugin!=="function"||typeof manager.enablePlugin!=="function"||typeof manager.loadManifest!=="function")throw new PackageRuntimeHoldError(id,"This Obsidian version cannot safely refresh a complete plugin package; existing settings and files were retained");return manager;
  }
  private async hash(path:string,cleanup=false):Promise<string|null>{const stat=await this.adapter.stat(path);if(!stat)return null;if(stat.type!=="file")throw new Error("A managed plugin file is not a regular file; runtime activation remains held");return hashAdapterFile(this.adapter,path,cleanup?()=>{}:this.checkpoint,cleanup?()=>new Promise(resolve=>setTimeout(resolve,0)):this.cooperate,stat.size<8*1024*1024);}
  private async proof(id:string,cleanup=false):Promise<Proof>{const root=this.pluginRoot(id);return {manifest:await this.hash(`${root}/manifest.json`,cleanup),main:await this.hash(`${root}/main.js`,cleanup),data:await this.hash(`${root}/data.json`,cleanup)};}
  private complete(proof:Proof):boolean{return proof.manifest!==null&&proof.main!==null;}
  private async mkdir(path:string):Promise<void>{for(const prefix of path.split("/").map((_,index,parts)=>parts.slice(0,index+1).join("/")))if(!await this.adapter.exists(prefix))await this.adapter.mkdir(prefix);}
  private recoveryRoot(id:string):string{return `.gib-sync/local-recovery/runtime-${crypto.randomUUID()}/.obsidian/plugins/${id}`;}
  private trackWrite(guard:Guard,save:()=>Promise<void>,verify:boolean):Promise<void>{
    const writing=Promise.resolve().then(save).then(async()=>{if(verify&&guard.phase==="loading")guard.verifiedData=await this.hash(`${this.pluginRoot(guard.id)}/data.json`,true);}).catch(error=>{guard.writeFailure=error instanceof Error?error.message:String(error);throw error;});
    guard.writes.add(writing);void writing.then(()=>guard.writes.delete(writing),()=>guard.writes.delete(writing));return writing;
  }
  private async drain(guard:Guard,ignoreFailure=false):Promise<void>{
    const deadline=Date.now()+this.settingsWriteTimeoutMs;
    for(let rounds=0;guard.writes.size&&rounds<16;rounds++){
      const remaining=deadline-Date.now();if(remaining<=0)throw new Error("Plugin settings writes timed out; no incoming files were activated");let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([Promise.allSettled([...guard.writes]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Plugin settings writes timed out; no incoming files were activated")),remaining);})]);}finally{if(timer!==undefined)clearTimeout(timer);}
    }
    if(guard.writes.size)throw new Error("Plugin settings writes did not finish their managed suspension");if(guard.writeFailure&&!ignoreFailure)throw new Error(`Plugin settings could not be persisted: ${guard.writeFailure}`);
  }
  private fence(guard:Guard,instance:Instance):void{
    const saved=this.originalInstanceSaves.get(instance)??(Object.hasOwn(instance,"saveData")?instance.saveData:this.originalSave);this.originalInstanceSaves.set(instance,saved);
    const descriptor=Object.getOwnPropertyDescriptor(instance,"saveData"),owner=this;
    const wrapper=async function(value:unknown){if(guard.phase==="unloading"&&instance===guard.previous||guard.approved.has(instance))return owner.trackWrite(guard,()=>saved.call(instance,value),instance!==guard.previous);await owner.preserveSave(guard.id,value,instance);};
    Object.defineProperty(instance,"saveData",{configurable:true,writable:true,value:wrapper});this.activeFences.set(instance,{descriptor,wrapper});
  }
  private restoreFence(instance:Instance):void{const fence=this.activeFences.get(instance);if(!fence||instance.saveData!==fence.wrapper)return;if(fence.descriptor)Object.defineProperty(instance,"saveData",fence.descriptor);else delete (instance as Partial<Instance>).saveData;this.activeFences.delete(instance);}
  private async protectIncoming(guard:Guard,proof:Proof):Promise<void>{
    if(typeof this.adapter.copy!=="function"||typeof this.adapter.rename!=="function")throw new Error("This adapter cannot protect incoming plugin settings during runtime activation");
    const incoming:{proof:Proof;dataCopy?:string}={proof};
    if(proof.data!==null){const root=this.recoveryRoot(guard.id);await this.mkdir(root);const destination=`${root}/data.json`;await this.adapter.copy(`${this.pluginRoot(guard.id)}/data.json`,destination);if(await this.hash(destination,true)!==proof.data||await this.hash(`${this.pluginRoot(guard.id)}/data.json`,guard.cleanup)!==proof.data)throw new Error("Incoming settings changed while their runtime checkpoint was being protected");incoming.dataCopy=destination;}
    guard.incoming=incoming;
  }
  private async restoreIncoming(guard:Guard):Promise<void>{
    const incoming=guard.incoming;if(!incoming)return;const path=`${this.pluginRoot(guard.id)}/data.json`,current=await this.hash(path,true);if(current===incoming.proof.data)return;
    if(incoming.proof.data!==null&&(!incoming.dataCopy||await this.hash(incoming.dataCopy,true)!==incoming.proof.data))throw new Error("Protected incoming settings failed verification; runtime activation remains held");
    let recovery=incoming.recovery;if(!recovery){const root=this.recoveryRoot(guard.id);await this.mkdir(root);recovery={path:`${root}/data.json`,expected:current,vacated:current===null};incoming.recovery=recovery;}
    else{const moved=await this.hash(recovery.path,true);if(!recovery.vacated&&moved===recovery.expected&&moved!==null&&current===null)recovery.vacated=true;
      if(recovery.vacated&&recovery.expected!==null&&moved!==recovery.expected)throw new Error("Moved runtime settings changed after protection; their bytes and incoming checkpoints were retained");
      if(recovery.vacated&&current!==null||!recovery.vacated&&current!==recovery.expected)throw new Error("Competing settings appeared after an interrupted recovery; their public file and both checkpoints were retained");}
    // Native copy is no-overwrite. Move and verify the changed generation first,
    // then restore only into a vacant public path; a racing creator is retained.
    // Both protected versions survive errors without whole-settings buffers.
    if(!recovery.vacated&&current!==null){if(await this.hash(path,true)!==current)throw new Error("Runtime settings changed before their recovery move; all checkpoints were retained");await this.adapter.rename(path,recovery.path);recovery.vacated=true;if(await this.hash(recovery.path,true)!==current)throw new Error("Runtime settings changed during their recovery move; all moved bytes and incoming checkpoints were retained");}
    if(await this.adapter.exists(path))throw new Error("Competing settings appeared during recovery; their public file and both protected copies were retained");
    if(incoming.proof.data!==null)await this.adapter.copy(incoming.dataCopy!,path);
    if(await this.hash(path,true)!==incoming.proof.data)throw new Error("Incoming settings restoration did not verify; both protected copies were retained");
    this.hold(guard.id,"A plugin wrote settings outside its fresh-load fence; incoming and runtime-written versions were protected",false);
  }
  private async preserveSave(id:string,value:unknown,instance:Instance):Promise<void>{
    // Delegate serialization to Obsidian's ordinary saveData implementation,
    // but redirect its manifest directory to a UUID-owned recovery location.
    // No extra whole-settings stringify/buffer or lossy size cutoff is added.
    try{const root=this.recoveryRoot(id);await this.mkdir(root);
      const shadow=Object.create(instance) as Instance;shadow.manifest={...instance.manifest,dir:root};await this.originalSave.call(shadow,value);
      if(await this.hash(`${root}/data.json`,true)===null)throw new Error("The protected late plugin settings save was not persisted");this.hold(id,"A stale plugin runtime save was protected in local recovery instead of replacing incoming settings",false);
    }catch(error){this.hold(id,"A late plugin save could not be protected; incoming settings were not overwritten");throw error;}
  }
  async quiesce(id:string):Promise<void>{
    this.checkpoint();const manager=this.require(id),component=await this.begin(id,manager);try{await this.quiesceOwned(component);}finally{this.end(component);}
  }
  private async quiesceOwned(component:Component):Promise<void>{
    const {manager}=component,id=component.guard.id;let guard=component.guard;
    if(guard?.phase==="quiesced"){
      try{await this.drain(guard);if(manager.plugins[id])throw new Error("The plugin is still running while its package is held");if(!guard.prior)guard.prior=await this.proof(id);this.checkpoint();return;}
      catch(error){const message=error instanceof Error?error.message:String(error);this.hold(id,message);throw new PackageRuntimeHoldError(id,message);}
    }
    if(guard.phase==="active"){guard.loadToken=undefined;guard=this.newGuard(id,manager);component.guard=guard;this.guards.set(id,guard);}
    try{if(guard.previous){this.fence(guard,guard.previous);await this.lifecycle(component,"disable",()=>manager.disablePlugin(id));await this.drain(guard);if(manager.plugins[id])throw new Error("The plugin did not finish its managed suspension");}
      guard.phase="quiesced";if(guard.previous)this.activeFences.delete(guard.previous);guard.prior=await this.proof(id);this.checkpoint();
    }catch(error){guard.phase="quiesced";guard.loadToken=undefined;guard.approved=new WeakSet();if(guard.previous){if(manager.plugins[id]===guard.previous&&(!component.pending||component.pending.settled)){this.restoreFence(guard.previous);this.guards.delete(id);if(this.owned(component))this.components().delete(id);else if(this.components().get(id)===component)this.components().delete(id);}else if(manager.plugins[id]!==guard.previous)this.activeFences.delete(guard.previous);}const message=error instanceof Error?error.message:String(error);this.hold(id,message);throw new PackageRuntimeHoldError(id,message);}
  }
  private async wanted(id:string,fallback:boolean):Promise<boolean>{const root=this.pluginRoot(id),directory=root.slice(0,root.lastIndexOf("/plugins/")),path=`${directory}/community-plugins.json`,stat=await this.adapter.stat(path);if(stat?.type!=="file")return fallback;if(stat.size>512*1024)throw new Error("Plugin enablement exceeds its safe runtime budget");const enabled=JSON.parse(new TextDecoder().decode(new Uint8Array(await this.adapter.readBinary(path)))) as unknown;if(!Array.isArray(enabled)||enabled.some(value=>typeof value!=="string"))throw new Error("Plugin enablement is not a valid list");return enabled.includes(id);}
  async confirmRetirement(id:string):Promise<void>{
    this.checkpoint();const manager=this.require(id),component=await this.begin(id,manager);
    try{const guard=component.guard;if(guard.phase!=="quiesced"||manager.plugins[id])throw new Error("A running plugin cannot be retired");await this.drain(guard);if(await this.adapter.exists(this.pluginRoot(id)))throw new AdapterFileChangedError(this.pluginRoot(id));guard.wanted=false;guard.activated=true;component.needsRecovery=false;manager.enabledPlugins.delete(id);delete manager.manifests[id];}
    finally{this.end(component);}
  }
  private async refreshManifest(component:Component,id:string,proof:Proof,cleanup=false):Promise<{id:string;version?:string;isDesktopOnly?:boolean}>{
    const {manager}=component;
    const path=`${this.pluginRoot(id)}/manifest.json`,stat=await this.adapter.stat(path);if(stat?.type!=="file"||stat.size>128*1024)throw new Error("The plugin manifest exceeds its safe runtime budget");
    const raw=JSON.parse(new TextDecoder().decode(new Uint8Array(await this.adapter.readBinary(path)))) as {id?:unknown;version?:unknown;isDesktopOnly?:unknown};
    if(raw.id!==id||typeof raw.version!=="string"||raw.isDesktopOnly!==undefined&&typeof raw.isDesktopOnly!=="boolean")throw new Error("The complete plugin manifest is invalid for managed runtime activation");
    await this.lifecycle(component,"manifest",()=>manager.loadManifest(this.pluginRoot(id)));const manifest=manager.manifests[id];
    if(!manifest||manifest.id!==id||manifest.version!==raw.version||Boolean(manifest.isDesktopOnly)!==Boolean(raw.isDesktopOnly)||await this.hash(path,cleanup)!==proof.manifest)throw new Error("The updated plugin manifest cache did not refresh safely");return manifest;
  }
  async activate(id:string,expectedDataHash:string|null):Promise<void>{
    let loading:Guard|undefined,manager:RuntimeManager|undefined,component:Component|undefined;
    try{
    let guard=this.guards.get(id);if(!guard?.cleanup)this.checkpoint();manager=this.require(id);component=await this.begin(id,manager);guard=component.guard;if(guard.phase!=="quiesced"){await this.quiesceOwned(component);guard=component.guard;}
    const proof=await this.proof(id,guard.cleanup);if(!this.complete(proof)||proof.data!==expectedDataHash)throw new PackageRuntimeHoldError(id,"The complete plugin and incoming settings must verify before runtime activation");
    const manifest=await this.refreshManifest(component,id,proof,guard.cleanup);
    const desired=await this.wanted(id,guard.wanted);guard.expected=expectedDataHash;guard.phase="loading";
    if(!desired||this.isMobile&&manifest.isDesktopOnly){guard.activated=true;guard.phase="quiesced";manager.enabledPlugins.delete(id);return;}
    await this.protectIncoming(guard,proof);loading=guard;guard.verifiedData=undefined;guard.writeFailure=undefined;
    const before=await this.proof(id,guard.cleanup);if(before.main!==proof.main||before.manifest!==proof.manifest||before.data!==proof.data)throw new Error("The complete plugin changed before its verified runtime activation");
    guard.loadToken=Symbol("fresh settings activation");guard.activationFailed=false;const result=await this.lifecycle(component,"enable",()=>manager!.enablePlugin(id)),instance=manager.plugins[id];
    await this.drain(guard);const after=await this.proof(id,guard.cleanup);
    if(after.main!==proof.main||after.manifest!==proof.manifest||after.data!==(guard.verifiedData===undefined?expectedDataHash:guard.verifiedData))throw new Error("The plugin changed its package or settings outside the verified runtime fence");
    if(result===false||!instance||expectedDataHash!==null&&!guard.approved.has(instance))throw new Error("Fresh plugin settings were not acknowledged by the updated runtime");
    guard.approved.add(instance);this.fence(guard,instance);if(!guard.cleanup)this.checkpoint();guard.loadToken=undefined;guard.phase="active";guard.activated=true;manager.enabledPlugins.add(id);
    }catch(error){
      if(component&&(loading||component.needsRecovery)){this.retire(component);if(loading)loading.activationFailed=true;
        if(!component.pending||component.pending.settled)try{await this.recover(component);}catch(recovery){this.hold(id,recovery instanceof Error?recovery.message:String(recovery));throw recovery instanceof PackageRuntimeHoldError?recovery:new PackageRuntimeHoldError(id,"Runtime settings recovery remains held; all verified checkpoints were retained");}}
      if(error instanceof PackageRuntimeHoldError)throw error;const message=error instanceof Error?error.message:String(error);this.hold(id,message);throw new PackageRuntimeHoldError(id,message);
    }finally{if(component)this.end(component);}
  }
  async finish():Promise<void>{
    const manager=this.manager();if(!manager)return;
    for(const guard of this.guards.values()){const component=this.components().get(guard.id);if(component?.busy||component?.pending&&!component.pending.settled){this.hold(guard.id,"Unfinished plugin runtime work remains protected; other vault content can finish syncing");continue;}if(guard.activated||guard.phase==="active"||guard.activationFailed||!guard.wanted)continue;
      try{guard.cleanup=true;const current=await this.proof(guard.id,true);if(!guard.prior||!this.complete(current)||current.main!==guard.prior.main||current.manifest!==guard.prior.manifest||current.data!==guard.prior.data){this.hold(guard.id,"The interrupted package is protected until its complete recovery can resume");continue;}
        await this.activate(guard.id,current.data);
      }catch(error){this.hold(guard.id,error instanceof Error?error.message:String(error));}
    }
  }
  private detachHooksIfSafe():void{if(!this.closed||[...this.components().values()].some(component=>component.owner===this&&(component.pending||component.needsRecovery||component.busy)))return;this.hooks.owners.delete(this);if(!this.hooks.owners.size){if(this.prototype.loadData===this.hooks.load)this.prototype.loadData=this.originalLoad;if(this.prototype.saveData===this.hooks.save)this.prototype.saveData=this.originalSave;sharedHooks.delete(this.prototype);}}
  dispose():void{this.closed=true;for(const [instance]of this.activeFences)if(this.guards.get(instance.manifest.id)?.phase==="active"&&this.guards.get(instance.manifest.id)?.approved.has(instance))this.restoreFence(instance);for(const [id,component]of this.components())if(component.owner===this){if(!component.pending&&!component.needsRecovery&&!component.busy)this.components().delete(id);else this.retire(component);}this.detachHooksIfSafe();}
}
