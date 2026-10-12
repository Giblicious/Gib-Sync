import type { Plugin } from "obsidian";
import type { ManifestEntry,StorageLocation } from "@gib-sync/protocol";

export type SyncPhase = "not-configured"|"blocked"|"idle"|"scheduled"|"checking"|"retrying"|"offline"|"scanning"|"reading-remote"|"merging"|"applying"|"uploading"|"committing"|"mirroring"|"complete"|"up-to-date"|"error";
export type ActivityLevel = "info"|"success"|"warning"|"error";
export interface SyncActivity { at:string; phase:SyncPhase; level:ActivityLevel; message:string; current?:number; total?:number; repeats?:number; }
export interface LiveSyncStatus {
  phase:SyncPhase; message:string; running:boolean; current?:number; total?:number;
  startedAt:string|null; completedAt:string|null; lastSuccessAt:string|null; lastErrorAt:string|null; lastError:string;
  lastResult:string; nextSyncAt:string|null; activities:SyncActivity[];
  verified?:boolean; pendingChanges?:number;
}

export interface RetiredPathState {
  hash:string;
  snapshotId:string;
  retiredAt:number;
}
export interface PendingCommit {
  intentSequence?:number;
  parentId:string|null;
  fingerprint:string;
  priorHashes:Record<string,string|null>;
  priorEntries?:Record<string,ManifestEntry>;
}
export interface ApplyOperation {
  namespacePath?:string;
  targetHash:string|null;
  priorHash:string|null;
  stagePath:string;
  backupPath:string;
  phase:"planned"|"staged"|"backed-up"|"promoting"|"applied";
}
export interface GibSyncSettings {
  packageHolds:Record<string,{reason:string;at:number;kind?:"incomplete"|"activation";attempts?:number;retryAt?:number;fingerprint?:string;priorEntries?:Record<string,ManifestEntry&{sourcePath?:string}>}>;
  configDir:string;
  onboardingMode:"preserve-local"|"server-first";
  pendingMoves:Array<{from:string;to:string;at:number}>;
  fileCreationTimes:Record<string,number>;
  observedFolderSnapshotId:string|null;
  serverUrl: string; vaultId: string; vaultName: string; vaultKey: string;
  deviceId: string; deviceName: string; deviceToken: string;
  lastSnapshotId: string | null; initialized: boolean; autoSync: boolean; instantReceive: boolean; syncOnFileChange: boolean; paused:boolean;
  syncIntervalSeconds: number; syncBookmarks: boolean; syncObsidianConfig: boolean; syncPlugins: boolean; pluginSyncBootstrapPending:boolean; exclusions: string[];
  desktopStatusIcon: boolean; desktopStatusText: boolean;
  mobileSidebarIndicator: boolean; mobileTopIndicator: boolean; animateStatusIndicator: boolean; showAttentionBadge: boolean;
  vaultIdentity: string;
  pendingPaths: string[]; pendingPathTimes:Record<string,number>; pendingApplyPaths:string[];
  pendingApplySnapshotId:string|null; pendingApplyBaseSnapshotId:string|null; pendingApplyPriorHashes:Record<string,string|null>; retiredPaths:Record<string,RetiredPathState>;
  pendingCommit:PendingCommit|null;
  pendingApplyOperations:Record<string,ApplyOperation>;
  pendingApplyPriorEntries:Record<string,ManifestEntry>; localReconcileBases:Record<string,ManifestEntry|null>;
  folderCreateTimes:Record<string,number>; folderCleanupVersion:number; lastFolderCleanupAt:number; lastFolderCleanupError:string; retiredFolderCount:number; retiredFolderNote:string; fullScanRequired: boolean; lastFullScanAt: string | null;
  storage: StorageLocation | null; lastSuccessAt: string | null; lastErrorAt: string | null; lastError: string; lastResult: string;
}

export const DEFAULT_SETTINGS: GibSyncSettings = {
  packageHolds:{},
  configDir:".obsidian",
  onboardingMode:"preserve-local",
  pendingMoves:[],fileCreationTimes:{},observedFolderSnapshotId:null,
  serverUrl: "", vaultId: "", vaultName: "", vaultKey: "", deviceId: "", deviceName: "", deviceToken: "",
  lastSnapshotId: null, initialized: false, autoSync: true, instantReceive: true, syncOnFileChange: true, paused:false, syncIntervalSeconds: 60, syncBookmarks:true, syncObsidianConfig: false, syncPlugins: false,pluginSyncBootstrapPending:false,
  desktopStatusIcon:true,desktopStatusText:true,mobileSidebarIndicator:true,mobileTopIndicator:false,animateStatusIndicator:true,showAttentionBadge:true,
  exclusions: [".trash/", ".git/", ".obsidian/plugins/gib-sync/"], vaultIdentity:"", pendingPaths:[],pendingPathTimes:{},pendingApplyPaths:[],pendingApplySnapshotId:null,pendingApplyBaseSnapshotId:null,pendingApplyPriorHashes:{},retiredPaths:{},folderCreateTimes:{},folderCleanupVersion:5,lastFolderCleanupAt:0,lastFolderCleanupError:"",retiredFolderCount:0,retiredFolderNote:"",fullScanRequired:true,lastFullScanAt:null,
  pendingCommit:null,pendingApplyOperations:{},pendingApplyPriorEntries:{},localReconcileBases:{}, storage:null, lastSuccessAt:null, lastErrorAt:null, lastError:"", lastResult:""
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
  settings.packageHolds=stored?.packageHolds&&typeof stored.packageHolds==="object"&&!Array.isArray(stored.packageHolds)?Object.fromEntries(Object.entries(stored.packageHolds).filter(([id,hold])=>/^[a-z0-9._-]+$/i.test(id)&&hold&&typeof hold.reason==="string"&&typeof hold.at==="number"&&Number.isFinite(hold.at)).map(([id,hold])=>[id,{reason:hold.reason.slice(0,500),at:hold.at}])):{};
  settings.configDir=normalizedConfigDir(typeof stored?.configDir==="string"?stored.configDir:".obsidian");
  settings.onboardingMode=stored?.onboardingMode==="server-first"?"server-first":"preserve-local";
  settings.pendingMoves=Array.isArray(stored?.pendingMoves)?stored.pendingMoves.filter(move=>move&&typeof move.from==="string"&&isSafeVaultPath(move.from)&&typeof move.to==="string"&&isSafeVaultPath(move.to)&&typeof move.at==="number"&&Number.isFinite(move.at)&&move.at>0):[];
  settings.fileCreationTimes=stored?.fileCreationTimes&&typeof stored.fileCreationTimes==="object"&&!Array.isArray(stored.fileCreationTimes)?Object.fromEntries(Object.entries(stored.fileCreationTimes).filter(([path,time])=>Boolean(path)&&typeof time==="number"&&Number.isFinite(time)&&time>0)):{};
  settings.observedFolderSnapshotId=typeof stored?.observedFolderSnapshotId==="string"?stored.observedFolderSnapshotId:null;
  // Before this setting existed, enabling Obsidian configuration also included
  // plugins. Preserve that behavior for existing users so an upgrade cannot
  // silently remove their remotely synchronized plugin directories.
  if(stored?.syncPlugins===undefined&&stored?.syncObsidianConfig===true)settings.syncPlugins=true;
  // Enabling plugin sync on an established device must first adopt the
  // accepted server inventory. Older clients treated a phone's missing
  // packages and freshly created default data.json files as intentional edits.
  settings.pluginSyncBootstrapPending=settings.syncPlugins&&(stored?.pluginSyncBootstrapPending===true||stored?.pluginSyncBootstrapPending===undefined);
  settings.pendingPaths=Array.isArray(stored?.pendingPaths)?[...new Set(stored.pendingPaths.filter((path):path is string=>typeof path==="string"&&isSafeVaultPath(path)))]:[];
  settings.pendingPathTimes=stored?.pendingPathTimes&&typeof stored.pendingPathTimes==="object"&&!Array.isArray(stored.pendingPathTimes)
    ?Object.fromEntries(Object.entries(stored.pendingPathTimes).filter(([path,time])=>Boolean(path)&&typeof time==="number"&&Number.isFinite(time)&&time>0)):{};
  settings.pendingApplyPaths=Array.isArray(stored?.pendingApplyPaths)?[...new Set(stored.pendingApplyPaths.filter((path):path is string=>typeof path==="string"&&isSafeVaultPath(path)))]:[];
  settings.pendingApplySnapshotId=typeof stored?.pendingApplySnapshotId==="string"&&stored.pendingApplySnapshotId?stored.pendingApplySnapshotId:null;
  settings.pendingApplyBaseSnapshotId=typeof stored?.pendingApplyBaseSnapshotId==="string"&&stored.pendingApplyBaseSnapshotId?stored.pendingApplyBaseSnapshotId:null;
  settings.pendingApplyPriorHashes=stored?.pendingApplyPriorHashes&&typeof stored.pendingApplyPriorHashes==="object"&&!Array.isArray(stored.pendingApplyPriorHashes)
    ?Object.fromEntries(Object.entries(stored.pendingApplyPriorHashes).filter(([path,hash])=>isSafeVaultPath(path)&&(hash===null||(typeof hash==="string"&&/^[a-f0-9]{64}$/i.test(hash))))):{};
  const commit=stored?.pendingCommit;
  const validEntries=(value:unknown):Record<string,ManifestEntry>=>value&&typeof value==="object"&&!Array.isArray(value)
    ?Object.fromEntries(Object.entries(value).filter(([path,entry])=>isSafeVaultPath(path)&&entry&&typeof entry==="object"&&entry.path===path&&typeof entry.hash==="string"&&/^[a-f0-9]{64}$/i.test(entry.hash)&&typeof entry.size==="number"&&Number.isSafeInteger(entry.size)&&entry.size>=0&&typeof entry.mtime==="number"&&Number.isFinite(entry.mtime)).map(([path,entry])=>{
      const revision=entry.revision,validRevision=revision&&typeof revision==="object"&&typeof revision.id==="string"&&(revision.parentId===null||typeof revision.parentId==="string")&&typeof revision.deviceId==="string"&&typeof revision.deviceName==="string"&&typeof revision.modifiedAt==="number"&&Number.isFinite(revision.modifiedAt);
      return [path,{path,hash:entry.hash,size:entry.size,mtime:entry.mtime,...(typeof entry.fileId==="string"?{fileId:entry.fileId}:{}),...(validRevision?{revision:{id:revision.id,parentId:revision.parentId,deviceId:revision.deviceId,deviceName:revision.deviceName,modifiedAt:revision.modifiedAt}}:{})}];
    })):{};
  settings.pendingApplyPriorEntries=validEntries(stored?.pendingApplyPriorEntries);
  for(const [id,hold]of Object.entries(settings.packageHolds)){const saved=stored?.packageHolds?.[id];if(!saved)continue;if(saved.kind==="incomplete"||saved.kind==="activation")hold.kind=saved.kind;if(Number.isSafeInteger(saved.attempts)&&saved.attempts!>=0)hold.attempts=saved.attempts;if(typeof saved.retryAt==="number"&&Number.isFinite(saved.retryAt)&&saved.retryAt>=0)hold.retryAt=saved.retryAt;if(typeof saved.fingerprint==="string"&&/^[a-f0-9]{64}$/.test(saved.fingerprint))hold.fingerprint=saved.fingerprint;const entries=validEntries(saved.priorEntries);for(const [path,entry]of Object.entries(entries)){const source=saved.priorEntries?.[path]?.sourcePath;if(typeof source==="string"&&/^\.gib-sync\/package-hold-originals\/[0-9a-f-]{36}\.bin$/.test(source))(entry as ManifestEntry&{sourcePath?:string}).sourcePath=source;}if(Object.keys(entries).length)hold.priorEntries=entries;}
  const operations=stored?.pendingApplyOperations;
  settings.pendingApplyOperations=operations&&typeof operations==="object"&&!Array.isArray(operations)
    ?Object.fromEntries(Object.entries(operations).filter(([path,operation])=>isSafeVaultPath(path)&&operation&&typeof operation==="object"&&(!operation.namespacePath||isSafeVaultPath(operation.namespacePath))
      &&(operation.targetHash===null||typeof operation.targetHash==="string"&&/^[a-f0-9]{64}$/i.test(operation.targetHash))
      &&(operation.priorHash===null||typeof operation.priorHash==="string"&&/^[a-f0-9]{64}$/i.test(operation.priorHash))
      &&typeof operation.stagePath==="string"&&/^\.gib-sync\/apply\/[a-f0-9]{64}\.stage$/.test(operation.stagePath)
      &&typeof operation.backupPath==="string"&&/^\.gib-sync\/apply\/[a-f0-9]{64}\.backup$/.test(operation.backupPath)
      &&["planned","staged","backed-up","promoting","applied"].includes(operation.phase))):{};
  const replay=stored?.localReconcileBases;
  settings.localReconcileBases={...validEntries(replay),...Object.fromEntries(Object.entries(replay&&typeof replay==="object"&&!Array.isArray(replay)?replay:{}).filter(([path,entry])=>isSafeVaultPath(path)&&entry===null))};
  settings.pendingCommit=commit&&(commit.parentId===null||typeof commit.parentId==="string"&&Boolean(commit.parentId))&&typeof commit.fingerprint==="string"&&/^[a-f0-9]{64}$/i.test(commit.fingerprint)&&commit.priorHashes&&typeof commit.priorHashes==="object"&&!Array.isArray(commit.priorHashes)
    ?{parentId:commit.parentId,fingerprint:commit.fingerprint,priorHashes:Object.fromEntries(Object.entries(commit.priorHashes).filter(([path,hash])=>isSafeVaultPath(path)&&(hash===null||typeof hash==="string"&&/^[a-f0-9]{64}$/i.test(hash)))),...(commit.priorEntries?{priorEntries:validEntries(commit.priorEntries)}:{}),...(Number.isSafeInteger(commit.intentSequence)&&commit.intentSequence!>=0?{intentSequence:commit.intentSequence}:{})}:null;
  settings.retiredPaths=stored?.retiredPaths&&typeof stored.retiredPaths==="object"&&!Array.isArray(stored.retiredPaths)
    ?Object.fromEntries(Object.entries(stored.retiredPaths).filter(([path,value])=>Boolean(path)&&Boolean(value)&&typeof value==="object"&&typeof value.hash==="string"&&/^[a-f0-9]{64}$/i.test(value.hash)&&typeof value.snapshotId==="string"&&Boolean(value.snapshotId)&&typeof value.retiredAt==="number"&&Number.isFinite(value.retiredAt)&&value.retiredAt>0)):{};
  settings.folderCreateTimes=stored?.folderCreateTimes&&typeof stored.folderCreateTimes==="object"&&!Array.isArray(stored.folderCreateTimes)
    ?Object.fromEntries(Object.entries(stored.folderCreateTimes).filter(([path,value])=>Boolean(path)&&typeof value==="number"&&Number.isFinite(value)&&value>0)):{};
  const currentFolderCleanup=stored?.folderCleanupVersion===5;settings.folderCleanupVersion=5;
  settings.lastFolderCleanupAt=currentFolderCleanup&&typeof stored?.lastFolderCleanupAt==="number"&&Number.isFinite(stored.lastFolderCleanupAt)&&stored.lastFolderCleanupAt>0?stored.lastFolderCleanupAt:0;
  settings.lastFolderCleanupError=typeof stored?.lastFolderCleanupError==="string"?stored.lastFolderCleanupError.slice(0,2000):"";
  settings.retiredFolderCount=currentFolderCleanup&&typeof stored?.retiredFolderCount==="number"&&Number.isInteger(stored.retiredFolderCount)&&stored.retiredFolderCount>0?stored.retiredFolderCount:0;
  settings.retiredFolderNote=currentFolderCleanup&&typeof stored?.retiredFolderNote==="string"?stored.retiredFolderNote.slice(0,2000):"";
  return settings;
}

export function normalizedConfigDir(configDir=".obsidian"):string {
  const normalized=configDir.replace(/\\/g,"/").replace(/^\/+|\/+$/g,"");
  return isSafeVaultPath(normalized)?normalized:".obsidian";
}

export function canonicalConfigPath(path:string,configDir=".obsidian"):string {
  const normalized=path.replace(/\\/g,"/").replace(/^\/+/,"");
  const root=normalizedConfigDir(configDir);
  return normalized.toLowerCase()===root.toLowerCase()?".obsidian":normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)?`.obsidian/${normalized.slice(root.length+1)}`:normalized;
}

export function isDeviceLocalWorkspacePath(path:string,configDir=".obsidian"):boolean {
  return /^\.obsidian\/workspace(?:-[^/]+)?\.json$/i.test(canonicalConfigPath(path,configDir));
}

export function obsidianPluginPath(path:string,configDir=".obsidian"):{id:string;relative:string}|null {
  const normalized=canonicalConfigPath(path,configDir);
  const match=/^\.obsidian\/plugins\/([^/]+)(?:\/(.*))?$/i.exec(normalized);
  return match?{id:match[1],relative:match[2]??""}:null;
}

export function isPluginDataPath(path:string,configDir=".obsidian"):boolean {
  return obsidianPluginPath(path,configDir)?.relative.toLowerCase()==="data.json";
}

// The transport and its installer are operational dependencies, not vault
// content. Another device's inventory must never update or disable them.
const DEVICE_LOCAL_PLUGIN_IDS=new Set(["gib-sync","obsidian42-brat"]);
export function isDeviceLocalPlugin(id:string):boolean {
  return DEVICE_LOCAL_PLUGIN_IDS.has(id.toLowerCase());
}

export function isGeneratedPluginPath(path:string,configDir=".obsidian"):boolean {
  const plugin=obsidianPluginPath(path,configDir);if(!plugin)return false;
  const generatedFolders=new Set([".cache","cache","caches","embeddings","index-data","indexes","logs","node_modules","search-index","temp","tmp"]);
  return plugin.relative.split("/").some((segment)=>generatedFolders.has(segment.toLowerCase()))||/\.(?:log|tmp)$/i.test(plugin.relative);
}

export function isLegacyObsidianConflictPath(path:string,configDir=".obsidian"):boolean {
  const normalized=canonicalConfigPath(path,configDir);
  return normalized.toLowerCase().startsWith(".obsidian/")&&isGibSyncConflictPath(normalized);
}

export function isGibSyncConflictPath(path:string):boolean {
  const normalized=path.replace(/\\/g,"/").replace(/^\/+/g,"");
  return / \(conflict - .+ - \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} UTC(?: - \d+)?\)(?:\.[^/]+)?$/i.test(normalized);
}

export function isDeviceLocalObsidianPath(path:string,configDir=".obsidian"):boolean {
  return isDeviceLocalWorkspacePath(path,configDir)||isGeneratedPluginPath(path,configDir)||isLegacyObsidianConflictPath(path,configDir);
}

export function isObsidianSystemPath(path:string,configDir=".obsidian"):boolean {
  return canonicalConfigPath(path,configDir).toLowerCase().startsWith(".obsidian/");
}

export function shouldSyncChangedPath(path: string, settings: GibSyncSettings): boolean {
  if(!isSafeVaultPath(path))return false;
  const actual=path.replace(/\\/g,"/").replace(/^\/+/,""),normalized=canonicalConfigPath(actual,settings.configDir).toLowerCase();
  if(!normalized||normalized===".gib-sync"||normalized.startsWith(".gib-sync/")||normalized===".trash"||normalized.startsWith(".trash/"))return false;
  const plugin=obsidianPluginPath(normalized);
  if(plugin&&isDeviceLocalPlugin(plugin.id))return false;
  if(plugin&&settings.exclusions.some(prefix=>{
    const excluded=canonicalConfigPath(prefix.replace(/\\/g,"/").replace(/^\/+|\/+$/g,""),settings.configDir).toLowerCase();
    return excluded&&["manifest.json","main.js"].some(file=>{const path=`.obsidian/plugins/${plugin.id.toLowerCase()}/${file}`;return path===excluded||path.startsWith(`${excluded}/`);});
  }))return false; // Never synchronize an intentionally incomplete executable package.
  if(/^\.obsidian\/plugins\/\.gib-sync-package-[0-9a-f-]+\.(?:stage|original|probe)(?:\/|$)/i.test(normalized))return false;
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
    const canonicalExcluded=canonicalConfigPath(excluded,settings.configDir).toLowerCase();
    return Boolean(excluded)&&(actual.toLowerCase()===excluded.toLowerCase()||actual.toLowerCase().startsWith(`${excluded.toLowerCase()}/`)||normalized===canonicalExcluded||normalized.startsWith(`${canonicalExcluded}/`));
  });
}

export function isSafeVaultPath(path:string):boolean{
  const normalized=path.replace(/\\/g,"/").replace(/\/+$/,"");
  return Boolean(normalized)&&!normalized.startsWith("/")&&!/^[a-z]:/i.test(normalized)&&!normalized.includes("\0")&&!normalized.split("/").some(part=>!part||part==="."||part==="..");
}
