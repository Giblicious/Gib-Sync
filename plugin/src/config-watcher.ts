import type { DataAdapter } from "obsidian";
import { shouldSyncChangedPath,type GibSyncSettings } from "./settings";

type FileStamp={size:number;mtime:number;ctime:number};
type Inventory={version:1;scope:string;files:Record<string,FileStamp>};
const INDEX_PATH=".gib-sync/config-index-v1.json";
const MAX_FILES=20_000;
const MAX_DIRECTORIES=2_000;

/** Hidden settings do not reliably emit Vault events. Stat only the enabled config scope. */
export class ConfigWatcher{
  private prior:Inventory|null=null;private loaded=false;private stopped=false;private running:Promise<void>|null=null;
  constructor(private readonly adapter:DataAdapter,private readonly settings:()=>GibSyncSettings,private readonly changed:(paths:string[],createdPaths:string[])=>void,private readonly yieldControl:()=>Promise<void>=()=>new Promise(resolve=>window.setTimeout(resolve,0))){}
  stop(){this.stopped=true;}
  poll():Promise<void>{if(this.stopped)return Promise.resolve();if(this.running)return this.running;this.running=this.inspect().finally(()=>{this.running=null;});return this.running;}
  private async inspect(){
    const currentSettings=this.settings(),settings={...currentSettings,exclusions:[...currentSettings.exclusions]},root=settings.configDir.replace(/\\/g,"/").replace(/\/+$/,"");
    if(!settings.deviceToken||!root||root.startsWith("/")||root.split("/").some(part=>!part||part===".."||part==="."))return;
    const scope=JSON.stringify([root,settings.syncBookmarks,settings.syncObsidianConfig,settings.syncPlugins,[...settings.exclusions].sort()]);
    if(!this.loaded){this.loaded=true;try{if(await this.adapter.exists(INDEX_PATH)){const parsed=JSON.parse(await this.adapter.read(INDEX_PATH)) as Inventory;if(parsed.version===1&&parsed.scope===scope&&parsed.files&&typeof parsed.files==="object"&&!Array.isArray(parsed.files)&&Object.keys(parsed.files).length<=MAX_FILES)this.prior={...parsed,files:Object.fromEntries(Object.entries(parsed.files).filter(([path,stamp])=>path.startsWith(`${root}/`)&&!path.split("/").some(part=>part===".."||part===".")&&shouldSyncChangedPath(path,settings)&&stamp&&[stamp.size,stamp.mtime,stamp.ctime].every(value=>typeof value==="number"&&Number.isFinite(value)&&value>=0)))};}}catch{/* A cache never establishes file truth; a restart still performs full reconciliation. */}}
    const current:Inventory={version:1,scope,files:{}},pending=[root];let visited=0,count=0,directories=0;
    while(pending.length&&!this.stopped){const directory=pending.shift()!;if(!shouldSyncChangedPath(directory,settings))continue;
      if(++directories>MAX_DIRECTORIES)throw new Error("The enabled configuration scope has too many folders for lightweight tracking; full sync checks remain active.");
      let listing;try{listing=await this.adapter.list(directory);}catch(error){if(!await this.adapter.exists(directory))continue;throw error;}
      for(const folder of listing.folders){if(folder.startsWith(`${root}/`)&&!folder.split("/").some(part=>part===".."||part===".")&&shouldSyncChangedPath(folder,settings)){if(pending.length+directories>=MAX_DIRECTORIES)throw new Error("The enabled configuration scope has too many folders for lightweight tracking; full sync checks remain active.");pending.push(folder);}}
      for(const path of listing.files){if(this.stopped)return;if(!path.startsWith(`${root}/`)||path.split("/").some(part=>part===".."||part===".")||!shouldSyncChangedPath(path,settings))continue;if(++count>MAX_FILES)throw new Error("The enabled configuration scope is too large for lightweight tracking; full sync checks remain active.");const stat=await this.adapter.stat(path);if(stat?.type==="file")current.files[path]={size:stat.size,mtime:stat.mtime,ctime:stat.ctime};if(++visited%16===0)await this.yieldControl();}
      if(++visited%16===0)await this.yieldControl();
    }
    if(this.stopped)return;const changed:string[]=[],created:string[]=[];
    if(this.prior?.scope===scope){for(const path of new Set([...Object.keys(this.prior.files),...Object.keys(current.files)])){const before=this.prior.files[path],after=current.files[path];if(!before||!after||before.size!==after.size||before.mtime!==after.mtime||before.ctime!==after.ctime)changed.push(path);if(after&&!before)created.push(path);}}
    const differs=!this.prior||this.prior.scope!==scope||changed.length;this.prior=current;
    if(changed.length)this.changed(changed.sort(),created.sort());
    if(differs&&!this.stopped){if(!await this.adapter.exists(".gib-sync")){if(this.stopped)return;await this.adapter.mkdir(".gib-sync");}if(!this.stopped)await this.adapter.write(INDEX_PATH,JSON.stringify(current));}
  }
}
