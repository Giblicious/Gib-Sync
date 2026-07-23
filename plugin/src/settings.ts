import type { Plugin } from "obsidian";
import type { StorageLocation } from "@gib-sync/protocol";

export type SyncPhase = "not-configured"|"idle"|"scheduled"|"scanning"|"reading-remote"|"merging"|"applying"|"uploading"|"committing"|"mirroring"|"complete"|"up-to-date"|"error";
export type ActivityLevel = "info"|"success"|"warning"|"error";
export interface SyncActivity { at:string; phase:SyncPhase; level:ActivityLevel; message:string; current?:number; total?:number; }
export interface LiveSyncStatus {
  phase:SyncPhase; message:string; running:boolean; current?:number; total?:number;
  startedAt:string|null; completedAt:string|null; lastSuccessAt:string|null; lastErrorAt:string|null; lastError:string;
  lastResult:string; nextSyncAt:string|null; activities:SyncActivity[];
}

export interface GibSyncSettings {
  serverUrl: string; vaultId: string; vaultName: string; vaultKey: string;
  deviceId: string; deviceName: string; deviceToken: string;
  lastSnapshotId: string | null; initialized: boolean; autoSync: boolean; syncOnFileChange: boolean;
  syncIntervalSeconds: number; syncObsidianConfig: boolean; exclusions: string[];
  storage: StorageLocation | null; lastSuccessAt: string | null; lastErrorAt: string | null; lastError: string; lastResult: string;
}

export const DEFAULT_SETTINGS: GibSyncSettings = {
  serverUrl: "", vaultId: "", vaultName: "", vaultKey: "", deviceId: "", deviceName: "", deviceToken: "",
  lastSnapshotId: null, initialized: false, autoSync: true, syncOnFileChange: true, syncIntervalSeconds: 60, syncObsidianConfig: false,
  exclusions: [".trash/", ".git/", ".obsidian/plugins/gib-sync/"], storage:null, lastSuccessAt:null, lastErrorAt:null, lastError:"", lastResult:""
};

export const initialLiveStatus = (configured:boolean): LiveSyncStatus => ({ phase:configured?"idle":"not-configured",message:configured?"Ready":"Not configured",running:false,
  startedAt:null,completedAt:null,lastSuccessAt:null,lastErrorAt:null,lastError:"",lastResult:"",nextSyncAt:null,activities:[] });

export async function loadSettings(plugin: Plugin): Promise<GibSyncSettings> {
  return Object.assign({}, DEFAULT_SETTINGS, await plugin.loadData());
}

export function shouldSyncChangedPath(path: string, settings: GibSyncSettings): boolean {
  const normalized=path.replace(/\\/g,"/").replace(/^\/+/,"");
  if(!normalized||normalized===".gib-sync"||normalized.startsWith(".gib-sync/"))return false;
  if(!settings.syncObsidianConfig&&(normalized===".obsidian"||normalized.startsWith(".obsidian/")))return false;
  return !settings.exclusions.some((prefix)=>{
    const excluded=prefix.replace(/\\/g,"/").replace(/^\/+/,"").replace(/\/+$/,"");
    return Boolean(excluded)&&(normalized===excluded||normalized.startsWith(`${excluded}/`));
  });
}
