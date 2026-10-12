import type {DataAdapter} from "obsidian";
import type {ManifestEntry} from "@gib-sync/protocol";
import {hashBytes} from "./crypto";
import {AdapterFileChangedError} from "./file-io";
import {isSafeVaultPath,isDeviceLocalPlugin} from "./settings";
import {PackageRuntimeHoldError} from "./plugin-runtime";

const ROOT=".gib-sync/packages-v2",encoder=new TextEncoder(),decoder=new TextDecoder(),UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
interface PackageJournal{version:2;id:string;scope:string;root:string;stage:string;backup:string;phase:"prepared"|"backed-up"|"promoting"|"installed"|"local-changed";prior:Record<string,string>;target:Record<string,string>;unmanaged:string[];snapshotId:string;}

/** Recoverable whole-directory switch; this is not a no-gap atomic exchange. */
export class AtomicPackageInstaller{
  private readonly qualifiedParents=new Set<string>();
  private readonly journalSequences=new Map<string,number>();
  private readonly readSequences=new WeakMap<PackageJournal,number>();
  constructor(private readonly adapter:DataAdapter,private readonly scope:()=>string,private readonly checkpoint:()=>void,private readonly cooperate:()=>Promise<void>,private readonly hash:(path:string)=>Promise<string|null>,private readonly expected:(path:string,hash:string|null)=>void,private readonly beforeSwitch:(root:string)=>Promise<void>=async()=>{}){}
  private async mkdir(path:string){for(const prefix of path.split("/").map((_,index,parts)=>parts.slice(0,index+1).join("/")))if(!await this.adapter.exists(prefix))await this.adapter.mkdir(prefix);}
  private parent(root:string):string{return root.slice(0,root.lastIndexOf("/"));}
  private privatePath(root:string,id:string,suffix:string):string{return `${this.parent(root)}/.gib-sync-package-${id}.${suffix}`;}
  private async managedHashes(root:string,paths:Iterable<string>):Promise<Record<string,string>>{const result:Record<string,string>={};for(const relative of paths){const hash=await this.hash(`${root}/${relative}`);if(hash)result[relative]=hash;await this.cooperate();}return result;}
  private equal(a:Record<string,string>,b:Record<string,string>):boolean{const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(path=>a[path]===b[path]);}
  private async unmanaged(root:string,managed:Set<string>):Promise<string[]>{const result:string[]=[];if(!await this.adapter.exists(root))return result;const queue=[""];while(queue.length){this.checkpoint();const relative=queue.shift()!,listing=await this.adapter.list(relative?`${root}/${relative}`:root);for(const path of [...listing.files,...listing.folders]){const child=path.slice(root.length+1);if(managed.has(child))continue;if([...managed].some(item=>item.startsWith(`${child}/`))){queue.push(child);continue;}result.push(child);}await this.cooperate();}return result;}
  private async persist(_path:string,journal:PackageJournal):Promise<void>{const payload=JSON.stringify(journal),hash=await hashBytes(encoder.encode(payload)),sequence=(this.journalSequences.get(journal.id)??0)+1,path=`${ROOT}/${journal.id}-${crypto.randomUUID()}.journal.json`;await this.adapter.writeBinary(path,encoder.encode(JSON.stringify({payload,hash,sequence})).buffer);const saved=JSON.parse(decoder.decode(new Uint8Array(await this.adapter.readBinary(path)))) as {payload:string;hash:string};if(saved.payload!==payload||saved.hash!==hash)throw new Error("The complete plugin package journal did not persist exactly");this.journalSequences.set(journal.id,sequence);for(const old of (await this.adapter.list(ROOT)).files)if(old!==path&&old.startsWith(`${ROOT}/${journal.id}-`)&&old.endsWith(".journal.json"))await this.adapter.remove(old);}
  private validHashes(value:Record<string,string>):boolean{return value&&typeof value==="object"&&!Array.isArray(value)&&Object.entries(value).every(([path,hash])=>isSafeVaultPath(path)&&/^[a-f0-9]{64}$/.test(hash));}
  private async read(path:string):Promise<PackageJournal|null>{const saved=JSON.parse(decoder.decode(new Uint8Array(await this.adapter.readBinary(path)))) as {payload:string;hash:string;sequence:number};if(await hashBytes(encoder.encode(saved.payload))!==saved.hash)throw new Error("Incomplete package recovery journal; all versions were retained");const journal=JSON.parse(saved.payload) as PackageJournal;if(journal.scope!==this.scope())return null;if(journal.version!==2||!UUID.test(journal.id)||!isSafeVaultPath(journal.root)||!/^.+\/plugins\/(?!gib-sync$)[^/]+$/.test(journal.root)||journal.stage!==this.privatePath(journal.root,journal.id,"stage")||journal.backup!==this.privatePath(journal.root,journal.id,"original")||!["prepared","backed-up","promoting","installed","local-changed"].includes(journal.phase)||!this.validHashes(journal.prior)||!this.validHashes(journal.target)||!Array.isArray(journal.unmanaged)||journal.unmanaged.some(relative=>!isSafeVaultPath(relative))||!new RegExp(`^${ROOT.replaceAll(".","\\.")}/${journal.id}-[0-9a-f-]+\\.journal\\.json$`).test(path)||!Number.isSafeInteger(saved.sequence))throw new Error("Invalid package recovery ownership");this.journalSequences.set(journal.id,Math.max(this.journalSequences.get(journal.id)??0,saved.sequence));this.readSequences.set(journal,saved.sequence);return journal;}
  private async records():Promise<Array<{path:string;journal:PackageJournal}>>{let paths:string[];try{paths=(await this.adapter.list(ROOT)).files;}catch{return [];}const records=new Map<string,{path:string;journal:PackageJournal;sequence:number}>(),invalid:string[]=[];for(const path of paths){if(!/^\.gib-sync\/packages-v2\/[0-9a-f-]+\.journal\.json$/.test(path))continue;try{const journal=await this.read(path);if(!journal)continue;const sequence=this.readSequences.get(journal)!;if(!records.has(journal.id)||records.get(journal.id)!.sequence<sequence)records.set(journal.id,{path,journal,sequence});}catch{invalid.push(path);}}for(const path of invalid){const id=path.slice(ROOT.length+1,ROOT.length+37);if(!records.has(id))throw new Error("A complete-package recovery record could not be verified; all directories were retained");}return [...records.values()];}
  private async qualify(root:string):Promise<void>{
    const parent=this.parent(root);if(this.qualifiedParents.has(parent))return;
    if(typeof this.adapter.getResourcePath!=="function"||typeof this.adapter.copy!=="function"||typeof this.adapter.rename!=="function")throw new PackageRuntimeHoldError(root.split("/").at(-1)!,"This adapter does not expose native complete-package activation. Existing plugin files and settings are unchanged.");
    await this.mkdir(parent);const id=crypto.randomUUID(),probe=this.privatePath(root,id,"probe"),source=`${probe}/source`,collision=`${probe}/collision`,destination=`${probe}/destination`,marker=encoder.encode("gib-sync-directory-probe-v2");await this.mkdir(source);await this.mkdir(collision);await this.adapter.writeBinary(`${source}/marker`,marker.buffer);await this.adapter.writeBinary(`${collision}/racer`,marker.buffer);
    let collisionRejected=false;try{await this.adapter.rename(source,collision);}catch{collisionRejected=true;}
    const expectedHash=await hashBytes(marker);if(!collisionRejected||await this.hash(`${source}/marker`)!==expectedHash||await this.hash(`${collision}/racer`)!==expectedHash)throw new Error("Directory activation collision semantics are unsupported; the private probe and all plugin originals were retained.");
    let finished=false,failed:unknown;const switching=this.adapter.rename(source,destination).then(()=>{finished=true;},error=>{failed=error;finished=true;});let overlapping=false;
    while(!finished){const observed=await this.adapter.list(probe);if(observed.folders.includes(source)&&observed.folders.includes(destination))overlapping=true;await this.cooperate();}await switching;this.checkpoint();if(failed||overlapping||await this.adapter.exists(source)||await this.hash(`${destination}/marker`)!==expectedHash)throw new Error("The adapter did not demonstrate a native whole-directory switch; plugin activation is safely held.");
    await this.adapter.remove(`${destination}/marker`);await this.adapter.remove(`${collision}/racer`);await this.adapter.rmdir(destination,false);await this.adapter.rmdir(collision,false);await this.adapter.rmdir(probe,false);this.qualifiedParents.add(parent);
  }
  private async moveUnmanaged(journal:PackageJournal,path:string):Promise<void>{
    // Native O(1) subtree moves preserve caches without hashing/copying their
    // potentially enormous contents. Locations themselves are the crash log.
    for(const relative of journal.unmanaged){const source=`${journal.backup}/${relative}`,destination=`${journal.stage}/${relative}`,hasSource=await this.adapter.exists(source),hasDestination=await this.adapter.exists(destination);if(hasSource&&hasDestination)throw new Error("Two device-local cache copies exist during package recovery; both were retained");if(!hasSource&&!hasDestination)throw new Error("Device-local package content is missing from both saved locations; activation is held");if(hasSource){await this.mkdir(destination.slice(0,destination.lastIndexOf("/")));await this.adapter.rename(source,destination);this.checkpoint();}await this.cooperate();}await this.persist(path,journal);
  }
  private async restoreChangedOriginal(journal:PackageJournal,path:string):Promise<void>{
    // A writer may finish into an already-open original after its directory
    // was renamed. Save this authority change before any reverse switch.
    journal.phase="local-changed";await this.persist(path,journal);this.checkpoint();
    if(!await this.adapter.exists(journal.backup)){if(await this.adapter.exists(journal.root))return;throw new Error("The changed original package is unavailable; all saved directories were retained");}
    const managed=new Set([...Object.keys(journal.prior),...Object.keys(journal.target)]);
    if(await this.adapter.exists(journal.root)){
      if(!this.equal(await this.managedHashes(journal.root,managed),journal.target)||await this.adapter.exists(journal.stage))throw new AdapterFileChangedError(journal.root);
      this.expected(journal.root,"folder");await this.adapter.rename(journal.root,journal.stage);this.checkpoint();
      if(!this.equal(await this.managedHashes(journal.stage,managed),journal.target))throw new Error("Incoming package changed during reversal; both complete copies were retained");
    }
    for(const relative of journal.unmanaged){const source=`${journal.stage}/${relative}`,destination=`${journal.backup}/${relative}`;if(!await this.adapter.exists(source))continue;if(await this.adapter.exists(destination))throw new Error("Concurrent device-local package content exists in both originals; activation is held without discarding either copy");await this.mkdir(destination.slice(0,destination.lastIndexOf("/")));await this.adapter.rename(source,destination);this.checkpoint();}
    if(await this.adapter.exists(journal.root))throw new AdapterFileChangedError(journal.root);
    const changed=await this.managedHashes(journal.backup,managed);for(const relative of managed)this.expected(`${journal.root}/${relative}`,changed[relative]??null);this.expected(journal.root,"folder");
    await this.adapter.rename(journal.backup,journal.root);this.checkpoint();await this.persist(path,journal);
  }
  private async guardOriginal(journal:PackageJournal,path:string):Promise<void>{const managed=new Set([...Object.keys(journal.prior),...Object.keys(journal.target)]);if(await this.adapter.exists(journal.backup)&&!this.equal(await this.managedHashes(journal.backup,managed),journal.prior)){await this.beforeSwitch(journal.root);await this.restoreChangedOriginal(journal,path);throw new AdapterFileChangedError(journal.root);}}
  async recover(snapshotId?:string):Promise<Set<string>>{
    const handled=new Set<string>();
    for(const {path,journal}of await this.records()){this.checkpoint();const managed=new Set([...Object.keys(journal.prior),...Object.keys(journal.target)]);
      if(isDeviceLocalPlugin(journal.root.split("/").at(-1)!))continue;
      if(journal.phase==="local-changed"){if(await this.adapter.exists(journal.backup)){await this.beforeSwitch(journal.root);await this.restoreChangedOriginal(journal,path);}continue;}
      if(journal.phase==="installed"){await this.guardOriginal(journal,path);if(Object.keys(journal.target).length&&journal.snapshotId===snapshotId&&this.equal(await this.managedHashes(journal.root,managed),journal.target))handled.add(journal.root);continue;}
      await this.beforeSwitch(journal.root);await this.qualify(journal.root);const current=await this.managedHashes(journal.root,managed);
      if(this.equal(current,journal.target)&&await this.adapter.exists(journal.root)){await this.guardOriginal(journal,path);journal.phase="installed";await this.persist(path,journal);if(journal.snapshotId===snapshotId)handled.add(journal.root);continue;}
      if(journal.phase==="prepared"&&!await this.adapter.exists(journal.backup)&&await this.adapter.exists(journal.root)){await this.adapter.remove(path);continue;}
      if(await this.adapter.exists(journal.root))throw new AdapterFileChangedError(journal.root);
      await this.guardOriginal(journal,path);
      if(!this.equal(await this.managedHashes(journal.backup,managed),journal.prior)||!this.equal(await this.managedHashes(journal.stage,managed),journal.target))throw new Error("A saved complete plugin package failed verification; originals were retained");
      if(!Object.keys(journal.target).length){journal.phase="installed";await this.persist(path,journal);continue;}
      journal.unmanaged=[...new Set([...journal.unmanaged,...await this.unmanaged(journal.backup,managed)])];await this.persist(path,journal);await this.moveUnmanaged(journal,path);await this.guardOriginal(journal,path);journal.phase="promoting";await this.persist(path,journal);this.checkpoint();await this.adapter.rename(journal.stage,journal.root);this.checkpoint();if(!this.equal(await this.managedHashes(journal.root,managed),journal.target))throw new Error("The promoted package did not verify; original settings remain in local recovery");await this.guardOriginal(journal,path);journal.phase="installed";await this.persist(path,journal);if(journal.snapshotId===snapshotId)handled.add(journal.root);
    }return handled;
  }
  async restoreDeviceLocalRetirements():Promise<{restored:string[];held:string[]}>{
    const restored:string[]=[],held:string[]=[],groups=new Map<string,Array<{path:string;journal:PackageJournal}>>();
    for(const record of await this.records())if(isDeviceLocalPlugin(record.journal.root.split("/").at(-1)!)){
      const group=groups.get(record.journal.root)??[];group.push(record);groups.set(record.journal.root,group);
    }
    for(const [root,records]of groups){
      this.checkpoint();if(await this.adapter.exists(root))continue; // A user reinstall always wins.
      const candidates=[];
      for(const record of records)if(await this.adapter.exists(record.journal.backup))candidates.push(record);
      if(candidates.length!==1){if(candidates.length)held.push(root);continue;}
      const {path,journal}=candidates[0];
      if(Object.keys(journal.target).length||!journal.prior["manifest.json"]||!journal.prior["main.js"]||!this.equal(await this.managedHashes(journal.backup,Object.keys(journal.prior)),journal.prior)){held.push(root);continue;}
      const manifestStat=await this.adapter.stat(`${journal.backup}/manifest.json`);
      if(manifestStat?.type!=="file"||manifestStat.size>128*1024){held.push(root);continue;}
      let manifest:{id?:unknown};try{manifest=JSON.parse(decoder.decode(new Uint8Array(await this.adapter.readBinary(`${journal.backup}/manifest.json`)))) as {id?:unknown};}catch(error){if(!(error instanceof SyntaxError))throw error;held.push(root);continue;}
      if(!manifest||manifest.id!==root.split("/").at(-1)){held.push(root);continue;}
      await this.qualify(root);this.checkpoint();
      // Recheck after qualification/yields, then use native no-overwrite rename.
      // The original directory (including settings/caches) is never copied away
      // or replaced by defaults. The owned journal remains the recovery trail.
      if(await this.adapter.exists(root)||!this.equal(await this.managedHashes(journal.backup,Object.keys(journal.prior)),journal.prior)){held.push(root);continue;}
      journal.phase="local-changed";await this.persist(path,journal);this.checkpoint();
      this.expected(root,"folder");await this.adapter.rename(journal.backup,root);this.checkpoint();
      if(!this.equal(await this.managedHashes(root,Object.keys(journal.prior)),journal.prior))throw new AdapterFileChangedError(root);
      restored.push(root);
    }
    return {restored,held};
  }
  async install(root:string,desired:readonly ManifestEntry[],observed:readonly ManifestEntry[],snapshotId:string,stageFile:(entry:ManifestEntry,destination:string)=>Promise<void>):Promise<void>{
    if(isDeviceLocalPlugin(root.split("/").at(-1)!))throw new Error("Operational device-local plugins cannot be installed or retired by sync");
    this.checkpoint();await this.qualify(root);await this.mkdir(ROOT);const id=crypto.randomUUID(),stage=this.privatePath(root,id,"stage"),backup=this.privatePath(root,id,"original"),journalPath=`${ROOT}/${id}.journal.json`;await this.mkdir(stage);
    const managed=new Set([...desired,...observed].map(entry=>entry.path.slice(root.length+1))),prior=await this.managedHashes(root,managed);for(const entry of observed)if(prior[entry.path.slice(root.length+1)]!==entry.hash)throw new AdapterFileChangedError(entry.path);
    const unmanaged=await this.unmanaged(root,managed);
    for(const entry of desired){const destination=`${stage}/${entry.path.slice(root.length+1)}`;await this.mkdir(destination.slice(0,destination.lastIndexOf("/")));await stageFile(entry,destination);if(await this.hash(destination)!==entry.hash)throw new Error(`Staged plugin file did not verify: ${entry.path}`);await this.cooperate();}
    const target=await this.managedHashes(stage,managed);if(!this.equal(prior,await this.managedHashes(root,managed)))throw new AdapterFileChangedError(root);
    const journal:PackageJournal={version:2,id,scope:this.scope(),root,stage,backup,phase:"prepared",prior,target,unmanaged,snapshotId};await this.persist(journalPath,journal);this.checkpoint();for(const relative of managed)this.expected(`${root}/${relative}`,target[relative]??null);
    if(await this.adapter.exists(root)){await this.adapter.rename(root,backup);this.checkpoint();if(!this.equal(prior,await this.managedHashes(backup,managed))){if(!await this.adapter.exists(root))await this.adapter.rename(backup,root);throw new AdapterFileChangedError(root);}}
    // Enumeration before the switch is only a hint. Capture device-local files
    // that appeared before the original directory was actually moved as well.
    if(await this.adapter.exists(backup))journal.unmanaged=[...new Set([...journal.unmanaged,...await this.unmanaged(backup,managed)])];
    journal.phase="backed-up";await this.persist(journalPath,journal);this.checkpoint();if(!desired.length){journal.phase="installed";await this.persist(journalPath,journal);return;}
    await this.moveUnmanaged(journal,journalPath);await this.guardOriginal(journal,journalPath);if(await this.adapter.exists(root))throw new AdapterFileChangedError(root);
    journal.phase="promoting";await this.persist(journalPath,journal);this.checkpoint();await this.adapter.rename(stage,root);this.checkpoint();if(!this.equal(target,await this.managedHashes(root,managed)))throw new Error("Activated complete package did not verify; original settings remain recoverable");await this.guardOriginal(journal,journalPath);journal.phase="installed";await this.persist(journalPath,journal);
  }
  async originals():Promise<Array<{path:string;packageRoot:string;snapshotId:string}>>{const result:Array<{path:string;packageRoot:string;snapshotId:string}>=[];for(const {journal}of await this.records())if(await this.adapter.exists(journal.backup))result.push({path:journal.backup,packageRoot:journal.root,snapshotId:journal.snapshotId});return result;}
}
