import { Notice, Plugin } from "obsidian";
import type { ServerStatus, SetupResponse } from "@gib-sync/protocol";
import { GibSyncApi } from "./api";
import { SyncEngine } from "./engine";
import { DEFAULT_SETTINGS, initialLiveStatus, type ActivityLevel, type GibSyncSettings, type LiveSyncStatus, type SyncPhase, loadSettings, shouldSyncChangedPath } from "./settings";
import { GibSyncSettingTab, HistoryModal, QuickCodeDisplayModal, QuickCodeEntryModal, SetupModal, claimQuickCodeSetup } from "./ui";

export default class GibSyncPlugin extends Plugin {
  settings: GibSyncSettings = { ...DEFAULT_SETTINGS }; api!: GibSyncApi; engine!: SyncEngine;
  private statusEl!: HTMLElement; private timer: number | null = null; private debounce: number | null = null;
  private debounceKind: "automatic"|"file-change"|null = null;
  private fileChangePending = false;
  liveStatus: LiveSyncStatus = initialLiveStatus(false); serverStatus: ServerStatus | null = null;
  private statusListeners = new Set<() => void>();

  async onload() {
    this.settings = await loadSettings(this); this.api = new GibSyncApi(() => this.settings);
    this.liveStatus = {...initialLiveStatus(Boolean(this.settings.deviceToken)),lastSuccessAt:this.settings.lastSuccessAt,lastErrorAt:this.settings.lastErrorAt,lastError:this.settings.lastError,lastResult:this.settings.lastResult};
    this.statusEl = this.addStatusBarItem(); this.updateStatusBar();
    this.engine = new SyncEngine(this.app.vault.adapter, this.api, () => this.settings, () => this.saveSettings(), (progress) => this.report(progress.phase,progress.message,"info",progress.current,progress.total));
    this.addRibbonIcon("refresh-cw", "Gib Sync now", () => void this.runSync());
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.runSync() });
    this.addCommand({ id: "desktop-setup", name: "Set up first device", callback: () => new SetupModal(this.app, this).open() });
    this.addCommand({ id: "show-quick-code", name: "Show temporary mobile setup code", checkCallback: (checking) => { if (!this.settings.deviceToken) return false; if (!checking) new QuickCodeDisplayModal(this.app, this).open(); return true; } });
    this.addCommand({ id: "enter-quick-code", name: "Enter temporary setup code", callback: () => new QuickCodeEntryModal(this.app, this).open() });
    this.addCommand({ id: "open-history", name: "Open version history", checkCallback: (checking) => { if (!this.settings.deviceToken) return false; if (!checking) new HistoryModal(this.app, this).open(); return true; } });
    this.addSettingTab(new GibSyncSettingTab(this.app, this));
    this.registerEvent(this.app.vault.on("create", (file) => this.scheduleFileChangeSync(file.path)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.scheduleFileChangeSync(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.scheduleFileChangeSync(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file,oldPath) => this.scheduleFileChangeSync(file.path,oldPath)));
    this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
      if (info.file) this.scheduleFileChangeSync(info.file.path);
    }));
    this.configureTimer();
    if (this.settings.deviceToken && this.settings.autoSync) this.app.workspace.onLayoutReady(() => this.scheduleSync(2500));
  }

  onunload() { if (this.timer !== null) window.clearInterval(this.timer); if (this.debounce !== null) window.clearTimeout(this.debounce); }
  private updateStatusBar() { const text = `Gib Sync: ${this.liveStatus.message}`; this.statusEl?.setText(text); this.statusEl?.setAttr("aria-label", text); }
  private emitStatus() { this.updateStatusBar(); for (const listener of this.statusListeners) listener(); }
  subscribeStatus(listener:()=>void):()=>void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }
  report(phase:SyncPhase,message:string,level:ActivityLevel="info",current?:number,total?:number) {
    this.liveStatus.phase=phase; this.liveStatus.message=message; this.liveStatus.current=current; this.liveStatus.total=total;
    const previous=this.liveStatus.activities.at(-1); if (!previous || previous.message!==message) {
      this.liveStatus.activities.push({at:new Date().toISOString(),phase,level,message,current,total});
      if (this.liveStatus.activities.length>100) this.liveStatus.activities.splice(0,this.liveStatus.activities.length-100);
    }
    this.emitStatus();
  }
  clearActivity() { this.liveStatus.activities=[]; this.emitStatus(); }
  async refreshServerStatus() { if (!this.settings.deviceToken) return; try { this.serverStatus=await this.api.status(); this.settings.storage=this.serverStatus.storage; await this.saveSettings(); this.emitStatus(); } catch (error) { this.report("error",`Status check failed: ${error instanceof Error?error.message:String(error)}`,"error"); } }
  async saveSettings() { await this.saveData(this.settings); }
  async acceptSetup(setup: SetupResponse, deviceName: string) {
    Object.assign(this.settings, { serverUrl: setup.serverUrl, vaultId: setup.vaultId, vaultName: setup.vaultName, vaultKey: setup.vaultKey, deviceId: setup.deviceId, deviceToken: setup.deviceToken, deviceName, storage:setup.storage, lastSnapshotId: null, initialized: false });
    this.liveStatus=initialLiveStatus(true); this.report("idle","Connected; ready for first sync","success"); await this.saveSettings(); this.configureTimer(); void this.refreshServerStatus();
  }
  async claimQuickCode(server:string,value:string,deviceName:string){await this.acceptSetup(await claimQuickCodeSetup(this,server,value,deviceName),deviceName);}
  async runSync() {
    if (!this.settings.deviceToken) { new SetupModal(this.app, this).open(); return; }
    if (this.liveStatus.running) return;
    if(this.debounce!==null){window.clearTimeout(this.debounce);this.debounce=null;this.debounceKind=null;}
    this.liveStatus.running=true; this.liveStatus.startedAt=new Date().toISOString(); this.liveStatus.completedAt=null; this.liveStatus.nextSyncAt=null; this.report("scanning","Starting sync");
    try {
      const result = await this.engine.sync(); const now=new Date().toISOString(); const summary=`${result.uploaded} encrypted uploads · ${result.mirrored} readable files written · ${result.downloaded} downloaded · ${result.deleted} deleted · ${result.conflicts} conflicts`;
      this.liveStatus.running=false;this.liveStatus.completedAt=now;this.liveStatus.lastSuccessAt=now;this.liveStatus.lastResult=summary;
      this.settings.lastSuccessAt=now;this.settings.lastResult=summary;this.settings.lastError="";await this.saveSettings();
      this.report(result.uploaded||result.mirrored||result.downloaded||result.deleted?"complete":"up-to-date",`${result.uploaded||result.mirrored||result.downloaded||result.deleted?"Sync complete":"Up to date"} · ${summary}`,result.conflicts?"warning":"success");
      if (result.conflicts) new Notice(`Gib Sync preserved ${result.conflicts} conflict${result.conflicts === 1 ? "" : "s"}.`, 8000); void this.refreshServerStatus();
    } catch (error) {
      console.error("Gib Sync failed", error); const message=error instanceof Error?error.message:String(error); const now=new Date().toISOString();
      this.liveStatus.running=false;this.liveStatus.completedAt=now;this.liveStatus.lastErrorAt=now;this.liveStatus.lastError=message;
      this.settings.lastErrorAt=now;this.settings.lastError=message;await this.saveSettings();this.report("error",`Sync failed: ${message}`,"error");new Notice(`Gib Sync failed: ${message}`,10000);
    } finally {
      if(this.fileChangePending&&this.settings.syncOnFileChange){this.fileChangePending=false;this.queueSync(2000,"Files changed during sync");}
      else this.scheduleNextSyncLabel();
    }
  }
  scheduleSync(delay = 2000) {
    if (!this.settings.autoSync || !this.settings.deviceToken) return;
    this.queueSync(delay,"Automatic sync","automatic");
  }
  scheduleFileChangeSync(...paths:string[]) {
    if(!this.settings.syncOnFileChange||!this.settings.deviceToken||!paths.some((path)=>shouldSyncChangedPath(path,this.settings)))return;
    if(this.liveStatus.running){this.fileChangePending=true;return;}
    this.queueSync(2000,"Vault file changed","file-change");
  }
  configureFileChangeSync() {
    if(this.settings.syncOnFileChange||this.debounceKind!=="file-change"||this.debounce===null)return;
    window.clearTimeout(this.debounce);this.debounce=null;this.debounceKind=null;this.liveStatus.nextSyncAt=null;this.report("idle","File-change sync disabled");
    this.scheduleNextSyncLabel();
  }
  private queueSync(delay:number,reason:string,kind:"automatic"|"file-change"="file-change") {
    if (this.debounce !== null) window.clearTimeout(this.debounce);
    this.debounceKind=kind;
    this.liveStatus.nextSyncAt=new Date(Date.now()+delay).toISOString();this.report("scheduled",`${reason}; sync in ${Math.max(1,Math.round(delay/1000))}s`);
    this.debounce = window.setTimeout(() => { this.debounce = null;this.debounceKind=null;void this.runSync(); }, delay);
  }
  private scheduleNextSyncLabel() { if (this.settings.autoSync&&this.settings.deviceToken) { this.liveStatus.nextSyncAt=new Date(Date.now()+Math.max(15,this.settings.syncIntervalSeconds)*1000).toISOString(); this.emitStatus(); } }
  configureTimer() {
    if (this.timer !== null) window.clearInterval(this.timer); this.timer = null;
    if (this.settings.autoSync && this.settings.deviceToken) { this.timer = window.setInterval(() => void this.runSync(), Math.max(15, this.settings.syncIntervalSeconds) * 1000); this.scheduleNextSyncLabel(); }
    else { this.liveStatus.nextSyncAt=null;this.emitStatus(); }
  }
}
