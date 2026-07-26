import { Menu, Notice, Platform, Plugin, normalizePath, setIcon } from "obsidian";
import type { ServerStatus, SetupResponse } from "@gib-sync/protocol";
import { ApiError,GibSyncApi } from "./api";
import { FileChangedDuringReadError, SyncEngine, SyncSafetyError } from "./engine";
import { NotificationGate } from "./notifications";
import { DEFAULT_SETTINGS, initialLiveStatus, type ActivityLevel, type GibSyncSettings, type LiveSyncStatus, type SyncPhase, loadSettings, shouldSyncChangedPath } from "./settings";
import { deriveIndicatorState } from "./status";
import { GibSyncSettingTab, HistoryModal, NativeSyncConflictModal, QuickCodeDisplayModal, QuickCodeEntryModal, SafeguardReviewModal, SetupModal, StatusOverviewModal, claimQuickCodeSetup } from "./ui";

export default class GibSyncPlugin extends Plugin {
  settings: GibSyncSettings = { ...DEFAULT_SETTINGS }; api!: GibSyncApi; engine!: SyncEngine;
  private statusEl!: HTMLElement; private timer: number | null = null; private debounce: number | null = null;
  private debounceKind: "automatic"|"file-change"|null = null;
  private fileChangePending = false;
  private watchGeneration = 0;
  liveStatus: LiveSyncStatus = initialLiveStatus(false); serverStatus: ServerStatus | null = null;
  private statusListeners = new Set<() => void>();
  private safeguardModalOpen=false;
  private safetyHold=false;
  private readonly notificationGate=new NotificationGate();
  private nativeSyncBlocked=false;
  private nativeSyncNoticeShown=false;
  private readonly changedDuringReadFailures=new Map<string,{count:number;firstAt:number}>();
  private mobileSidebarEl:HTMLElement|null=null;
  private mobileTopEl:HTMLButtonElement|null=null;
  private mobileObserver:MutationObserver|null=null;
  private mobileMountScheduled=false;
  private mobileLayoutReady=!Platform.isMobile;

  async onload() {
    this.settings = await loadSettings(this); this.api = new GibSyncApi(() => this.settings);
    this.liveStatus = {...initialLiveStatus(Boolean(this.settings.deviceToken)),lastSuccessAt:this.settings.lastSuccessAt,lastErrorAt:this.settings.lastErrorAt,lastError:this.settings.lastError,lastResult:this.settings.lastResult};
    this.statusEl = this.addStatusBarItem();
    this.engine = new SyncEngine(this.app.vault.adapter, this.api, () => this.settings, () => this.saveSettings(), (progress) => this.report(progress.phase,progress.message,progress.level??"info",progress.current,progress.total));
    const ribbon=this.addRibbonIcon("refresh-cw","Gib Sync status",()=>this.openStatusOverview());
    ribbon.oncontextmenu=(event)=>{event.preventDefault();void this.runSync();};
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.runSync() });
    this.addCommand({id:"open-status",name:"Open sync status",callback:()=>this.openStatusOverview()});
    this.addCommand({ id: "desktop-setup", name: "Set up first device", callback: () => new SetupModal(this.app, this).open() });
    this.addCommand({ id: "show-quick-code", name: "Show temporary mobile setup code", checkCallback: (checking) => { if (!this.settings.deviceToken) return false; if (!checking) new QuickCodeDisplayModal(this.app, this).open(); return true; } });
    this.addCommand({ id: "enter-quick-code", name: "Enter temporary setup code", callback: () => new QuickCodeEntryModal(this.app, this).open() });
    this.addCommand({ id: "open-history", name: "Open version history", checkCallback: (checking) => { if (!this.settings.deviceToken) return false; if (!checking) new HistoryModal(this.app, this).open(); return true; } });
    this.addCommand({id:"review-safeguards",name:"Review quarantined changes",checkCallback:(checking)=>{if(!this.settings.deviceToken)return false;if(!checking)this.openSafeguards();return true;}});
    this.addCommand({id:"repair-vault-health",name:"Repair vault health",checkCallback:(checking)=>{if(!this.settings.deviceToken)return false;if(!checking)void this.repairVaultHealth();return true;}});
    this.addSettingTab(new GibSyncSettingTab(this.app, this));
    this.registerEvent(this.app.vault.on("create", (file) => this.scheduleFileChangeSync(file.path)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.scheduleFileChangeSync(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.scheduleFileChangeSync(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file,oldPath) => this.scheduleFileChangeSync(file.path,oldPath)));
    this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
      if (info.file) this.scheduleFileChangeSync(info.file.path);
    }));
    this.registerDomEvent(document,"visibilitychange",()=>{
      if(document.visibilityState!=="visible"||!this.settings.deviceToken)return;
      // Mobile operating systems suspend timers and long polls while Obsidian is
      // backgrounded. Recreate the incoming watch and reconcile immediately.
      this.configureWatch();
      if(this.liveStatus.running)this.fileChangePending=true;
      else if(this.settings.autoSync||this.settings.instantReceive)this.queueSync(750,"App returned to foreground","automatic");
    });
    this.configureStatusSurfaces();
    this.registerInterval(window.setInterval(()=>void this.checkObsidianSyncProtection(),5000));
    void this.checkObsidianSyncProtection();
    this.configureTimer();
    this.configureWatch();
    this.app.workspace.onLayoutReady(()=>{
      this.mobileLayoutReady=true;
      this.configureStatusSurfaces();
      void this.checkObsidianSyncProtection();
      if(this.settings.deviceToken&&this.settings.autoSync)this.scheduleSync(2500);
    });
  }

  onunload() {
    this.watchGeneration++;
    if(this.timer!==null)window.clearInterval(this.timer);
    if(this.debounce!==null)window.clearTimeout(this.debounce);
    this.mobileObserver?.disconnect();this.mobileSidebarEl?.remove();this.mobileTopEl?.remove();
    this.removeStaleMobileSidebarIndicators();
  }
  private attentionCount():number{return this.serverStatus?.safeguards.pendingQuarantines??0;}
  private indicatorHealth(){const alerts=this.serverStatus?.healthAlerts??[],error=alerts.find((item)=>item.level==="error"),warning=alerts.find((item)=>item.level==="warning");return {errors:alerts.filter((item)=>item.level==="error").length,warnings:alerts.filter((item)=>item.level==="warning").length,description:error?.message??warning?.message};}
  indicatorState(){return deriveIndicatorState(this.liveStatus,Boolean(this.settings.deviceToken),this.nativeSyncBlocked||this.settings.paused,this.attentionCount(),this.indicatorHealth());}
  isNativeSyncBlocking():boolean{return this.nativeSyncBlocked;}
  private renderIndicator(element:HTMLElement,dotOnly=false) {
    const state=this.indicatorState(),animate=this.settings.animateStatusIndicator&&state.animated;
    const kind=element.dataset.gibSyncIndicatorKind;
    const placement=kind?` gib-sync-mobile-${kind}-indicator`:"";
    const nativeSidebar=kind==="sidebar";
    const nativeClasses=nativeSidebar
      ?` clickable-icon workspace-drawer-header-icon mod-raised sync-status-icon${state.tone==="success"?" mod-success":state.tone==="active"?" mod-working":state.tone==="error"?" mod-error":""}${animate?" mod-spin":""}`
      :"";
    element.className=`gib-sync-indicator${placement}${nativeClasses} is-${state.tone} is-${state.key}${animate?" is-animated":""}${dotOnly?" is-dot-only":""}`;
    element.empty();
    if(dotOnly)element.createSpan({cls:"gib-sync-indicator-dot"});
    else if(nativeSidebar){
      setIcon(element,state.icon);
      if(this.settings.showAttentionBadge&&state.attentionCount>0)element.createSpan({cls:"gib-sync-indicator-badge",text:String(Math.min(99,state.attentionCount))});
    }
    else{
      const icon=element.createSpan({cls:"gib-sync-indicator-icon"});setIcon(icon,state.icon);
      if(this.settings.showAttentionBadge&&state.attentionCount>0)element.createSpan({cls:"gib-sync-indicator-badge",text:String(Math.min(99,state.attentionCount))});
    }
    element.setAttr("aria-label",`${state.label}. ${state.description}`);
    element.setAttr("data-tooltip-position","top");
  }
  private updateStatusBar() {
    if(!this.statusEl)return;
    const state=this.indicatorState(),show=!Platform.isMobile&&(this.settings.desktopStatusIcon||this.settings.desktopStatusText);
    this.statusEl.toggleClass("is-hidden",!show);this.statusEl.className=`status-bar-item gib-sync-desktop-status is-${state.tone} is-${state.key}${this.settings.animateStatusIndicator&&state.animated?" is-animated":""}${show?"":" is-hidden"}`;
    this.statusEl.empty();
    if(this.settings.desktopStatusIcon){const icon=this.statusEl.createSpan({cls:"gib-sync-indicator-icon"});setIcon(icon,state.icon);if(this.settings.showAttentionBadge&&state.attentionCount>0)this.statusEl.createSpan({cls:"gib-sync-indicator-badge",text:String(Math.min(99,state.attentionCount))});}
    if(this.settings.desktopStatusText)this.statusEl.createSpan({cls:"gib-sync-status-short-text",text:state.label});
    this.statusEl.setAttr("aria-label",`${state.label}. ${state.description}`);
    this.statusEl.onclick=()=>this.openStatusOverview();
    this.statusEl.oncontextmenu=(event)=>{
      event.preventDefault();const menu=new Menu();
      menu.addItem((item)=>item.setTitle("Sync now").setIcon("refresh-cw").onClick(()=>void this.runSync()));
      menu.addItem((item)=>item.setTitle(this.settings.paused?"Resume":"Pause").setIcon(this.settings.paused?"play":"pause").onClick(()=>void this.setPaused(!this.settings.paused)));
      menu.addItem((item)=>item.setTitle("Open status").setIcon("activity").onClick(()=>this.openStatusOverview()));
      menu.showAtMouseEvent(event);
    };
    if(this.mobileSidebarEl?.isConnected)this.renderIndicator(this.mobileSidebarEl);
    if(this.mobileTopEl?.isConnected)this.renderIndicator(this.mobileTopEl,true);
    this.scheduleMobileMount();
  }
  openStatusOverview(){new StatusOverviewModal(this.app,this).open();}
  configureStatusSurfaces(){
    this.updateStatusBar();
    if(!Platform.isMobile){this.mobileObserver?.disconnect();this.mobileObserver=null;this.mobileSidebarEl?.remove();this.mobileTopEl?.remove();return;}
    if(!this.mobileLayoutReady){this.removeStaleMobileSidebarIndicators();return;}
    if(!this.mobileObserver){
      this.mobileObserver=new MutationObserver(()=>this.scheduleMobileMount());
      this.mobileObserver.observe(document.body,{childList:true,subtree:true});
    }
    this.scheduleMobileMount();
  }
  private mobileButton():HTMLButtonElement{
    let element=this.mobileTopEl;
    if(!element){
      element=document.createElement("button");element.type="button";element.dataset.gibSyncIndicatorKind="top";
      let timer:number|null=null,longPressed=false;
      const cancel=()=>{if(timer!==null)window.clearTimeout(timer);timer=null;};
      element.addEventListener("pointerdown",()=>{longPressed=false;timer=window.setTimeout(()=>{longPressed=true;void this.runSync();new Notice("Sync requested");},650);});
      element.addEventListener("pointerup",cancel);element.addEventListener("pointercancel",cancel);element.addEventListener("pointerleave",cancel);
      element.addEventListener("click",(event)=>{if(longPressed){event.preventDefault();longPressed=false;return;}this.openStatusOverview();});
      this.mobileTopEl=element;
    }
    this.renderIndicator(element,true);return element;
  }
  private mountNativeMobileSidebarIndicator():HTMLElement|null{
    if(this.mobileSidebarEl?.isConnected){
      this.removeStaleMobileSidebarIndicators(this.mobileSidebarEl);
      return this.mobileSidebarEl;
    }
    this.mobileSidebarEl?.remove();this.mobileSidebarEl=null;
    this.removeStaleMobileSidebarIndicators();
    const rightSplit=(this.app.workspace as unknown as {rightSplit?:{addHeaderButton?:(icon:string,onClick:(event:MouseEvent)=>void)=>HTMLElement}}).rightSplit;
    if(!rightSplit?.addHeaderButton)return null;
    const element=rightSplit.addHeaderButton("sync-small",()=>this.openStatusOverview());
    element.dataset.gibSyncIndicatorKind="sidebar";
    element.addEventListener("contextmenu",(event)=>{event.preventDefault();void this.runSync();});
    this.mobileSidebarEl=element;
    this.renderIndicator(element);
    this.removeStaleMobileSidebarIndicators(element);
    return element;
  }
  private removeStaleMobileSidebarIndicators(keep?:HTMLElement){
    document.querySelectorAll<HTMLElement>(".gib-sync-mobile-sidebar-indicator, [data-gib-sync-indicator-kind='sidebar']")
      .forEach((element)=>{if(element!==keep)element.remove();});
  }
  private scheduleMobileMount(){
    if(!Platform.isMobile||!this.mobileLayoutReady||this.mobileMountScheduled)return;
    this.mobileMountScheduled=true;window.requestAnimationFrame(()=>{this.mobileMountScheduled=false;this.mountMobileIndicators();});
  }
  private mountMobileIndicators(){
    if(!Platform.isMobile)return;
    if(this.settings.mobileSidebarIndicator){
      this.mountNativeMobileSidebarIndicator();
    }else{this.mobileSidebarEl?.remove();this.mobileSidebarEl=null;this.removeStaleMobileSidebarIndicators();}
    if(this.settings.mobileTopIndicator){
      const element=this.mobileTopEl??this.mobileButton();
      const actions=Array.from(document.querySelectorAll<HTMLElement>(".mobile-navbar-action, .view-action, .view-header-icon"));
      const mode=actions.find((item)=>/reading view|editing mode|live preview|source mode|view mode|preview/i.test(`${item.getAttribute("aria-label")??""} ${item.getAttribute("data-tooltip")??""}`));
      const host=mode?.parentElement??document.querySelector<HTMLElement>(".mobile-navbar-actions, .workspace-leaf.mod-active .view-actions, .view-header .view-actions");
      if(host&&(element.parentElement!==host||mode&&element.nextElementSibling!==mode))host.insertBefore(element,mode??host.firstChild);
    }else this.mobileTopEl?.remove();
  }
  private emitStatus() { this.updateStatusBar(); for (const listener of this.statusListeners) listener(); }
  subscribeStatus(listener:()=>void):()=>void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }
  report(phase:SyncPhase,message:string,level:ActivityLevel="info",current?:number,total?:number) {
    this.liveStatus.phase=phase; this.liveStatus.message=message; this.liveStatus.current=current; this.liveStatus.total=total;
    const now=new Date().toISOString(),previous=this.liveStatus.activities.at(-1); if(previous&&previous.phase===phase&&previous.message===message&&current!==undefined){
      Object.assign(previous,{at:now,level,current,total});
    }else{
      let repeated=-1;for(let index=this.liveStatus.activities.length-1;index>=0;index--){const entry=this.liveStatus.activities[index];if(entry.phase===phase&&entry.message===message&&Date.now()-Date.parse(entry.at)<10*60_000){repeated=index;break;}}
      if(repeated>=0){const [entry]=this.liveStatus.activities.splice(repeated,1);this.liveStatus.activities.push({...entry,at:now,level,current,total,repeats:(entry.repeats??1)+1});}
      else this.liveStatus.activities.push({at:now,phase,level,message,current,total,repeats:1});
      if (this.liveStatus.activities.length>100) this.liveStatus.activities.splice(0,this.liveStatus.activities.length-100);
    }
    this.emitStatus();
  }
  private notify(key:string,message:string,duration=8000,cooldownMs=60_000){
    const visible=this.notificationGate.next(key,message,cooldownMs);
    if(visible)new Notice(visible,duration);
  }
  clearActivity() { this.liveStatus.activities=[]; this.emitStatus(); }
  async refreshServerStatus() { if (!this.settings.deviceToken) return; try { const wasHeld=this.safetyHold;this.serverStatus=await this.api.status(); this.settings.storage=this.serverStatus.storage; if(!this.serverStatus.safeguards.pendingQuarantines&&!this.serverStatus.safeguards.writeLocked)this.safetyHold=false; await this.saveSettings(); if(wasHeld&&!this.safetyHold)this.scheduleNextSyncLabel();else this.emitStatus(); } catch (error) { this.report("error",`Status check failed: ${error instanceof Error?error.message:String(error)}`,"error"); } }
  async saveSettings() { await this.saveData(this.settings); }
  currentVaultIdentity():string {
    const adapter=this.app.vault.adapter as unknown as {getBasePath?:()=>string};
    return `${this.app.vault.getName()}|${adapter.getBasePath?.()??"mobile-adapter"}`.replace(/\\/g,"/").toLowerCase();
  }
  async acceptCurrentVaultIdentity(){this.settings.vaultIdentity=this.currentVaultIdentity();await this.saveSettings();this.report("idle","Current vault location trusted","success");}
  openSafeguards(){if(this.safeguardModalOpen)return;this.safeguardModalOpen=true;new SafeguardReviewModal(this.app,this,()=>{this.safeguardModalOpen=false;}).open();}
  async repairVaultHealth(){
    if(this.liveStatus.running)return false;this.report("mirroring","Repairing from the accepted server snapshot","info");
    try{const result=await this.api.repairHealth();this.safetyHold=false;await this.refreshServerStatus();this.report("complete",`Health repaired · ${result.restoredFiles} readable files verified · ${result.removedConflictCopies} redundant conflict copies cleaned · ${result.removedFiles} obsolete files removed · ${result.dismissedQuarantines} held changes dismissed`,"success");new Notice("Gib Sync repaired the accepted vault and readable recovery copy.",6000);return await this.runSync();}
    catch(error){const message=error instanceof Error?error.message:String(error);this.report("error",`Health repair failed: ${message}`,"error");this.notify("health-repair",`Gib Sync health repair failed: ${message}`,10000,60_000);return false;}
  }
  async acceptSetup(setup: SetupResponse, deviceName: string) {
    Object.assign(this.settings, { serverUrl: setup.serverUrl, vaultId: setup.vaultId, vaultName: setup.vaultName, vaultKey: setup.vaultKey, deviceId: setup.deviceId, deviceToken: setup.deviceToken, deviceName, storage:setup.storage, lastSnapshotId: null, initialized: false,vaultIdentity:this.currentVaultIdentity() });
    this.liveStatus=initialLiveStatus(true); this.report("idle","Connected; ready for first sync","success"); await this.saveSettings(); this.configureTimer(); this.configureWatch(); void this.refreshServerStatus();
  }
  async claimQuickCode(server:string,value:string,deviceName:string){await this.acceptSetup(await claimQuickCodeSetup(this,server,value,deviceName),deviceName);}
  private runtimeObsidianSyncState():boolean|null{
    type Entry={enabled?:boolean;instance?:unknown};
    type Manager={getPluginById?:(id:string)=>Entry|undefined;getEnabledPluginById?:(id:string)=>unknown;plugins?:Record<string,Entry>};
    const manager=(this.app as unknown as {internalPlugins?:Manager}).internalPlugins;if(!manager)return null;
    const enabled=manager.getEnabledPluginById?.("sync");if(enabled)return true;
    const entry=manager.getPluginById?.("sync")??manager.plugins?.sync;
    return entry?Boolean(entry.enabled??entry.instance):null;
  }
  private async obsidianSyncEnabled():Promise<boolean>{
    const runtime=this.runtimeObsidianSyncState();if(runtime!==null)return runtime;
    try{
      const path=normalizePath(`${this.app.vault.configDir}/core-plugins.json`),adapter=this.app.vault.adapter;
      if(!await adapter.exists(path))return false;
      const stored=JSON.parse(await adapter.read(path)) as unknown;
      if(Array.isArray(stored))return stored.includes("sync");
      if(stored&&typeof stored==="object")return Boolean((stored as Record<string,unknown>).sync);
    }catch{}
    return false;
  }
  async checkObsidianSyncProtection(showDialog=false):Promise<boolean>{
    const enabled=await this.obsidianSyncEnabled();
    if(enabled){
      if(!this.nativeSyncBlocked){
        this.nativeSyncBlocked=true;this.watchGeneration++;
        if(this.timer!==null)window.clearInterval(this.timer);this.timer=null;
        if(this.debounce!==null)window.clearTimeout(this.debounce);this.debounce=null;this.debounceKind=null;
        this.report("blocked","Obsidian Sync is enabled; Gib Sync is paused","warning");
      }else this.emitStatus();
      if(!this.nativeSyncNoticeShown){this.nativeSyncNoticeShown=true;new Notice("Gib Sync is paused until the Obsidian Sync core plugin is disabled.",12000);}
      if(showDialog)new NativeSyncConflictModal(this.app,this).open();
      return true;
    }
    if(this.nativeSyncBlocked){
      this.nativeSyncBlocked=false;this.nativeSyncNoticeShown=false;this.report("idle","Obsidian Sync disabled; Gib Sync resumed","success");
      this.configureTimer();this.configureWatch();if(this.settings.deviceToken&&!this.settings.paused)this.queueSync(750,"Safety check passed","automatic");
    }
    return false;
  }
  openCorePluginSettings(){
    const setting=(this.app as unknown as {setting?:{open?:()=>void;openTabById?:(id:string)=>void}}).setting;
    setting?.open?.();window.setTimeout(()=>setting?.openTabById?.("core-plugins"),50);
  }
  async setPaused(paused:boolean){
    this.settings.paused=paused;await this.saveSettings();
    if(paused){
      this.watchGeneration++;if(this.timer!==null)window.clearInterval(this.timer);this.timer=null;
      if(this.debounce!==null)window.clearTimeout(this.debounce);this.debounce=null;this.debounceKind=null;
      this.report("blocked","Synchronization paused","warning");
    }else{
      this.report("idle","Synchronization resumed","success");this.configureTimer();this.configureWatch();
      if(this.settings.deviceToken&&!await this.checkObsidianSyncProtection())this.queueSync(500,"Manual resume","automatic");
    }
  }
  async runSync() {
    if (!this.settings.deviceToken) { new SetupModal(this.app, this).open(); return false; }
    if(this.settings.paused){this.openStatusOverview();return false;}
    if(await this.checkObsidianSyncProtection(true))return false;
    if (this.liveStatus.running) return false;
    const identity=this.currentVaultIdentity();
    if(this.settings.initialized&&this.settings.vaultIdentity&&identity!==this.settings.vaultIdentity){
      const message="Vault-location protection paused sync because this device now points to a different vault path or name. Verify it in Gib Sync settings before trusting the new location.";
      this.report("error",message,"error");this.notify("vault-location",message,10000,300_000);return false;
    }
    if(!this.settings.vaultIdentity){this.settings.vaultIdentity=identity;await this.saveSettings();}
    if(this.debounce!==null){window.clearTimeout(this.debounce);this.debounce=null;this.debounceKind=null;}
    this.liveStatus.running=true; this.liveStatus.startedAt=new Date().toISOString(); this.liveStatus.completedAt=null; this.liveStatus.nextSyncAt=null; this.report("scanning","Starting sync");
    let changedDuringRead:FileChangedDuringReadError|null=null,genericFailure=false,runSucceeded=false;
    try {
      const result = await this.engine.sync(); const now=new Date().toISOString(); const summary=`${result.uploaded} encrypted uploads · ${result.mirrored} readable files written · ${result.downloaded} downloaded · ${result.deleted} deleted · ${result.resolved} system changes auto-resolved · ${result.conflicts} note conflicts`;
      this.liveStatus.running=false;this.liveStatus.completedAt=now;this.liveStatus.lastSuccessAt=now;this.liveStatus.lastResult=summary;this.liveStatus.lastError="";
      this.changedDuringReadFailures.clear();
      this.safetyHold=false;
      this.settings.lastSuccessAt=now;this.settings.lastResult=summary;this.settings.lastError="";await this.saveSettings();
      this.report(result.uploaded||result.mirrored||result.downloaded||result.deleted?"complete":"up-to-date",`${result.uploaded||result.mirrored||result.downloaded||result.deleted?"Sync complete":"Up to date"} · ${summary}`,result.conflicts?"warning":"success");
      await this.api.markDeviceReady(result.snapshotId).catch(()=>{});
      if (result.conflicts) this.notify("conflicts",`Gib Sync preserved ${result.conflicts} conflict${result.conflicts === 1 ? "" : "s"}.`,8000,30_000); void this.refreshServerStatus();
      runSucceeded=true;
    } catch (error) {
      const now=new Date().toISOString();this.liveStatus.running=false;this.liveStatus.completedAt=now;
      if(error instanceof FileChangedDuringReadError){
        changedDuringRead=error;
        const nowMs=Date.now(),previous=this.changedDuringReadFailures.get(error.path);
        const failure=previous?{count:previous.count+1,firstAt:previous.firstAt}:{count:1,firstAt:nowMs};
        this.changedDuringReadFailures.set(error.path,failure);
        this.report("scheduled",`${error.path} changed during sync; quietly retrying the saved version`,"info");
        if(failure.count>=3&&nowMs-failure.firstAt>=120_000)this.notify(`changing-file:${error.path}`,`Gib Sync has been unable to read ${error.path} consistently for over two minutes. Close anything continuously rewriting it, then sync again.`,8000,300_000);
      }else{
        genericFailure=true;
        console.error("Gib Sync failed", error);const message=error instanceof Error?error.message:String(error);
        this.liveStatus.lastErrorAt=now;this.liveStatus.lastError=message;
        this.settings.lastErrorAt=now;this.settings.lastError=message;await this.saveSettings();
        if(error instanceof ApiError&&error.status===423){this.safetyHold=true;this.report("blocked",message,"warning");this.notify("safeguard",message,10000,60_000);if((error.responseBody as any)?.quarantine)this.openSafeguards();void this.refreshServerStatus();}
        else if(error instanceof SyncSafetyError){this.safetyHold=true;this.report("blocked",message,"warning");this.notify("safeguard",message,10000,60_000);}
        else{this.report("error",`Sync failed: ${message}`,"error");this.notify("sync-error",`Gib Sync failed: ${message}`,8000,60_000);}
      }
    } finally {
      if(changedDuringRead){this.fileChangePending=false;this.queueSync(2000,"File changed during sync; retrying");}
      else if(this.fileChangePending&&this.settings.syncOnFileChange){this.fileChangePending=false;this.queueSync(genericFailure?15_000:2000,genericFailure?"Files changed; retrying with error backoff":"Files changed during sync");}
      else this.scheduleNextSyncLabel();
    }
    return runSucceeded;
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
    if(this.nativeSyncBlocked||this.settings.paused||this.safetyHold)return;
    if (this.debounce !== null) window.clearTimeout(this.debounce);
    this.debounceKind=kind;
    this.liveStatus.nextSyncAt=new Date(Date.now()+delay).toISOString();this.report("scheduled",`${reason}; sync in ${Math.max(1,Math.round(delay/1000))}s`);
    this.debounce = window.setTimeout(() => { this.debounce = null;this.debounceKind=null;void this.runSync(); }, delay);
  }
  private scheduleNextSyncLabel() { if (!this.nativeSyncBlocked&&!this.settings.paused&&!this.safetyHold&&this.settings.autoSync&&this.settings.deviceToken) { this.liveStatus.nextSyncAt=new Date(Date.now()+Math.max(15,this.settings.syncIntervalSeconds)*1000).toISOString(); this.emitStatus(); } else {this.liveStatus.nextSyncAt=null;this.emitStatus();} }
  configureTimer() {
    if (this.timer !== null) window.clearInterval(this.timer); this.timer = null;
    if (!this.nativeSyncBlocked&&!this.settings.paused&&this.settings.autoSync && this.settings.deviceToken) { this.timer = window.setInterval(() => {if(!this.safetyHold)void this.runSync();}, Math.max(15, this.settings.syncIntervalSeconds) * 1000); this.scheduleNextSyncLabel(); }
    else { this.liveStatus.nextSyncAt=null;this.emitStatus(); }
  }
  configureWatch() {
    const generation=++this.watchGeneration;
    if(!this.nativeSyncBlocked&&!this.settings.paused&&this.settings.instantReceive&&this.settings.deviceToken)void this.watchLoop(generation);
  }
  private async watchLoop(generation:number) {
    let failures=0,syncFailures=0;
    while(generation===this.watchGeneration&&this.settings.instantReceive&&this.settings.deviceToken){
      try{
        const result=await this.api.watch(this.settings.lastSnapshotId);
        if(generation!==this.watchGeneration)return;
        failures=0;
        if(result.attention){
          this.safetyHold=true;
          await this.refreshServerStatus();
          this.report("blocked","Suspicious remote changes need review","warning");
          this.notify("safeguard","Gib Sync quarantined suspicious remote changes. Review them in settings.",10000,60_000);
          this.openSafeguards();
        }else if(result.changed&&result.headId!==this.settings.lastSnapshotId){
          if(this.safetyHold){await new Promise<void>((resolve)=>window.setTimeout(resolve,5000));continue;}
          this.report("scheduled","Remote change detected; syncing now","info");
          const succeeded=await this.runSync();
          if(succeeded)syncFailures=0;
          else{syncFailures++;this.report("scheduled",`Incoming sync retry backed off after failure · attempt ${syncFailures}`,"warning");await new Promise<void>((resolve)=>window.setTimeout(resolve,Math.min(60_000,5000*2**Math.min(syncFailures-1,4))));}
        }
      }catch(error){
        if(generation!==this.watchGeneration)return;
        failures++;
        if(failures===1)this.report("scheduled","Instant incoming sync reconnecting; periodic sync remains active","warning");
        await new Promise<void>((resolve)=>window.setTimeout(resolve,Math.min(10_000,1000*2**Math.min(failures-1,3))));
      }
    }
  }
}
