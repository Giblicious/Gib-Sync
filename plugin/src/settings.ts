import type { Plugin } from "obsidian";
import type { StorageLocation } from "@gib-sync/protocol";

export type SyncPhase = "not-configured"|"blocked"|"idle"|"scheduled"|"scanning"|"reading-remote"|"merging"|"applying"|"uploading"|"committing"|"mirroring"|"complete"|"up-to-date"|"error";
export type ActivityLevel = "info"|"success"|"warning"|"error";
export interface SyncActivity { at:string; phase:SyncPhase; level:ActivityLevel; message:string; current?:number; total?:number; repeats?:number; }
export interface LiveSyncStatus {
  phase:SyncPhase; message:string; running:boolean; current?:number; total?:number;
  startedAt:string|null; completedAt:string|null; lastSuccessAt:string|null; lastErrorAt:string|null; lastError:string;
  lastResult:string; nextSyncAt:string|null; activities:SyncActivity[];
}

export interface RetiredPathState {
  hash:string;
  snapshotId:string;
  retiredAt:number;
}

export interface GibSyncSettings {
  serverUrl: string; vaultId: string; vaultName: string; vaultKey: string;
  deviceId: string; deviceName: string; deviceToken: string;
  lastSnapshotId: string | null; initialized: boolean; autoSync: boolean; instantReceive: boolean; syncOnFileChange: boolean; paused:boolean;
  syncIntervalSeconds: number; syncBookmarks: boolean; syncObsidianConfig: boolean; syncPlugins: boolean; exclusions: string[];
  desktopStatusIcon: boolean; desktopStatusText: boolean;
  mobileSidebarIndicator: boolean; mobileTopIndicator: boolean; animateStatusIndicator: boolean; showAttentionBadge: boolean;
  vaultIdentity: string;
  pendingPaths: string[]; pendingPathTimes:Record<string,number>; pendingApplyPaths:string[];
  pendingApplySnapshotId:string|null; pendingApplyBaseSnapshotId:string|null; pendingApplyPriorHashes:Record<string,string|null>; retiredPaths:Record<string,RetiredPathState>;
  folderCreateTimes:Record<string,number>; folderCleanupVersion:number; lastFolderCleanupAt:number; lastFolderCleanupError:string; fullScanRequired: boolean; lastFullScanAt: string | null;
  storage: StorageLocation | null; lastSuccessAt: string | null; lastErrorAt: string | null; lastError: string; lastResult: string;
}

export const DEFAULT_SETTINGS: GibSyncSettings = {
  serverUrl: "", vaultId: "", vaultName: "", vaultKey: "", deviceId: "", deviceName: "", deviceToken: "",
  lastSnapshotId: null, initialized: false, autoSync: true, instantReceive: true, syncOnFileChange: true, paused:false, syncIntervalSeconds: 60, syncBookmarks:true, syncObsidianConfig: false, syncPlugins: false,
  desktopStatusIcon:true,desktopStatusText:true,mobileSidebarIndicator:true,mobileTopIndicator:false,animateStatusIndicator:true,showAttentionBadge:true,
  exclusions: [".trash/", ".git/", ".obsidian/plugins/gib-sync/"], vaultIdentity:"", pendingPaths:[],pendingPathTimes:{},pendingApplyPaths:[],pendingApplySnapshotId:null,pendingApplyBaseSnapshotId:null,pendingApplyPriorHashes:{},retiredPaths:{},folderCreateTimes:{},folderCleanupVersion:3,lastFolderCleanupAt:0,lastFolderCleanupError:"",fullScanRequired:true,lastFullScanAt:null,
  storage:null, lastSuccessAt:null, lastErrorAt:null, lastError:"", lastResult:""
};

export const initialLiveStatus = (configured:boolean): LiveSyncStatus => ({ phase:configured?"idle":"not-configured",message:configured?"Ready":"Not configured",running:false,
  startedAt:null,completedAt:null,lastSuccessAt:null,lastErrorAt:null,lastError:"",lastResult:"",nextSyncAt:null,activities:[] });

export function createSerializedSettingsWriter<T>(read:()=>T,write:(snapshot:T)=>Promise<void>):()=>Promise<void>{
  let tail=Promise.resolve();
  return ()=>{
    const queued=tail.catch(()=>undefined).then(async()=>{
      // Obsidian may complete overlapping saveData calls out of order on mobile.
      // Serialize writes and snapshot at execution time so an older journal save
      // can never overwrite a newer accepted server checkpoint.
      const snapshot=JSON.parse(JSON.stringify(read())) as T;
      await write(snapshot);
    });
    tail=queued;return queued;
  };
}

export async function loadSettings(plugin: Plugin): Promise<GibSyncSettings> {
  const stored=(await plugin.loadData()) as Partial<GibSyncSettings>|null;
  const settings=Object.assign({},DEFAULT_SETTINGS,stored??{});
  // Before this setting existed, enabling Obsidian configuration also included
  // plugins. Preserve that behavior for existing users so an upgrade cannot
  // silently remove their remotely synchronized plugin directories.
  if(stored?.syncPlugins===undefined&&stored?.syncObsidianConfig===true)settings.syncPlugins=true;
  settings.pendingPaths=Array.isArray(stored?.pendingPaths)?[...new Set(stored.pendingPaths.filter((path):path is string=>typeof path==="string"))]:[];
  settings.pendingPathTimes=stored?.pendingPathTimes&&typeof stored.pendingPathTimes==="object"&&!Array.isArray(stored.pendingPathTimes)
    ?Object.fromEntries(Object.entries(stored.pendingPathTimes).filter(([path,time])=>Boolean(path)&&typeof time==="number"&&Number.isFinite(time)&&time>0)):{};
  settings.pendingApplyPaths=Array.isArray(stored?.pendingApplyPaths)?[...new Set(stored.pendingApplyPaths.filter((path):path is string=>typeof path==="string"&&Boolean(path)))]:[];
  settings.pendingApplySnapshotId=typeof stored?.pendingApplySnapshotId==="string"&&stored.pendingApplySnapshotId?stored.pendingApplySnapshotId:null;
  settings.pendingApplyBaseSnapshotId=typeof stored?.pendingApplyBaseSnapshotId==="string"&&stored.pendingApplyBaseSnapshotId?stored.pendingApplyBaseSnapshotId:null;
  settings.pendingApplyPriorHashes=stored?.pendingApplyPriorHashes&&typeof stored.pendingApplyPriorHashes==="object"&&!Array.isArray(stored.pendingApplyPriorHashes)
    ?Object.fromEntries(Object.entries(stored.pendingApplyPriorHashes).filter(([path,hash])=>Boolean(path)&&(hash===null||(typeof hash==="string"&&/^[a-f0-9]{64}$/i.test(hash))))):{};
  settings.retiredPaths=stored?.retiredPaths&&typeof stored.retiredPaths==="object"&&!Array.isArray(stored.retiredPaths)
    ?Object.fromEntries(Object.entries(stored.retiredPaths).filter(([path,value])=>Boolean(path)&&Boolean(value)&&typeof value==="object"&&typeof value.hash==="string"&&/^[a-f0-9]{64}$/i.test(value.hash)&&typeof value.snapshotId==="string"&&Boolean(value.snapshotId)&&typeof value.retiredAt==="number"&&Number.isFinite(value.retiredAt)&&value.retiredAt>0)):{};
  settings.folderCreateTimes=stored?.folderCreateTimes&&typeof stored.folderCreateTimes==="object"&&!Array.isArray(stored.folderCreateTimes)
    ?Object.fromEntries(Object.entries(stored.folderCreateTimes).filter(([path,value])=>Boolean(path)&&typeof value==="number"&&Number.isFinite(value)&&value>0)):{};
  const currentFolderCleanup=stored?.folderCleanupVersion===3;settings.folderCleanupVersion=3;
  settings.lastFolderCleanupAt=currentFolderCleanup&&typeof stored?.lastFolderCleanupAt==="number"&&Number.isFinite(stored.lastFolderCleanupAt)&&stored.lastFolderCleanupAt>0?stored.lastFolderCleanupAt:0;
  settings.lastFolderCleanupError=typeof stored?.lastFolderCleanupError==="string"?stored.lastFolderCleanupError.slice(0,2000):"";
  return settings;
}

export function isDeviceLocalWorkspacePath(path:string):boolean {
  const normalized=path.replace(/\\/g,"/").replace(/^\/+/,"");
  return /^\.obsidian\/workspace(?:-[^/]+)?\.json$/i.test(normalized);
}

export function obsidianPluginPath(path:string):{id:string;relative:string}|null {
  const normalized=path.replace(/\\/g,"/").replace(/^\/+/,"");
  const match=/^\.obsidian\/plugins\/([^/]+)(?:\/(.*))?$/i.exec(normalized);
  return match?{id:match[1],relative:match[2]??""}:null;
}

export function isPluginDataPath(path:string):boolean {
  return obsidianPluginPath(path)?.relative.toLowerCase()==="data.json";
}

export function isGeneratedPluginPath(path:string):boolean {
  const plugin=obsidianPluginPath(path);if(!plugin)return false;
  const generatedFolders=new Set([".cache","cache","caches","embeddings","index-data","indexes","logs","node_modules","search-index","temp","tmp"]);
  return plugin.relative.split("/").some((segment)=>generatedFolders.has(segment.toLowerCase()))||/\.(?:log|tmp)$/i.test(plugin.relative);
}

export function isLegacyObsidianConflictPath(path:string):boolean {
  const normalized=path.replace(/\\/g,"/").replace(/^\/+/g,"");
  return normalized.toLowerCase().startsWith(".obsidian/")&&isGibSyncConflictPath(normalized);
}

export function isGibSyncConflictPath(path:string):boolean {
  const normalized=path.replace(/\\/g,"/").replace(/^\/+/g,"");
  return / \(conflict - .+ - \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} UTC(?: - \d+)?\)(?:\.[^/]+)?$/i.test(normalized);
}

export function isDeviceLocalObsidianPath(path:string):boolean {
  return isDeviceLocalWorkspacePath(path)||isGeneratedPluginPath(path)||isLegacyObsidianConflictPath(path);
}

export function isObsidianSystemPath(path:string):boolean {
  return path.replace(/\\/g,"/").replace(/^\/+/,"").toLowerCase().startsWith(".obsidian/");
}

export function shouldSyncChangedPath(path: string, settings: GibSyncSettings): boolean {
  const normalized=path.replace(/\\/g,"/").replace(/^\/+/,"");
  if(!normalized||normalized===".gib-sync"||normalized.startsWith(".gib-sync/"))return false;
  if(normalized===".obsidian/plugins/gib-sync"||normalized.startsWith(".obsidian/plugins/gib-sync/"))return false;
  // Workspace files are rapidly rewritten UI state and differ between desktop
  // and mobile. They are always device-local, even when config sync is enabled.
  if(isDeviceLocalObsidianPath(normalized))return false;
  if(normalized===".obsidian/core-plugins.json")return false;
  const obsidianRoot=normalized===".obsidian";
  const bookmarks=normalized.toLowerCase()===".obsidian/bookmarks.json";
  const pluginPath=normalized===".obsidian/plugins"||normalized.startsWith(".obsidian/plugins/")||normalized===".obsidian/community-plugins.json";
  if(obsidianRoot&&!settings.syncBookmarks&&!settings.syncObsidianConfig&&!settings.syncPlugins)return false;
  if(bookmarks&&!settings.syncBookmarks)return false;
  if(pluginPath&&!settings.syncPlugins)return false;
  if(!bookmarks&&!pluginPath&&!obsidianRoot&&!settings.syncObsidianConfig&&normalized.startsWith(".obsidian/"))return false;
  return !settings.exclusions.some((prefix)=>{
    const excluded=prefix.replace(/\\/g,"/").replace(/^\/+/,"").replace(/\/+$/,"");
    return Boolean(excluded)&&(normalized===excluded||normalized.startsWith(`${excluded}/`));
  });
}
