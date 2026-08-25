import { Menu, Notice, Platform, Plugin, TFolder, normalizePath, setIcon } from "obsidian";
import type { ClientCompatibility, ServerStatus, SetupResponse } from "@gib-sync/protocol";
import { ApiError,GibSyncApi } from "./api";
import { FileChangedDuringReadError, SyncEngine, SyncSafetyError } from "./engine";
import { NotificationGate } from "./notifications";
import { hashBytes } from "./crypto";
import { createSerializedSettingsWriter, DEFAULT_SETTINGS, initialLiveStatus, type ActivityLevel, type GibSyncSettings, type LiveSyncStatus, type SyncPhase, loadSettings, shouldSyncChangedPath } from "./settings";
import { deriveIndicatorState } from "./status";
import { assertSetupServerCompatible,enforceServerCompatibility,unavailableServerCompatibility } from "./server-compatibility";
import { GibSyncSettingTab, HistoryModal, NativeSyncConflictModal, QuickCodeDisplayModal, QuickCodeEntryModal, SafeguardReviewModal, SetupModal, StatusOverviewModal, claimQuickCodeSetup } from "./ui";

export default class GibSyncPlugin extends Plugin {
  settings: GibSyncSettings = { ...DEFAULT_SETTINGS }; api!: GibSyncApi; engine!: SyncEngine;
  private statusEl!: HTMLElement; private timer: number | null = null; private debounce: number | null = null;
  private debounceKind: "automatic"|"file-change"|null = null;
  private fileChangePending = false;
  private lastRelevantVaultChangeAt = 0;
  private lastVaultRenameAt = 0;
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
  private readonly pathVersions=new Map<string,number>();
  private pathRevision=0;
  private journalSaveTimer:number|null=null;
  private readonly expectedLocalMutations=new Map<string,string|null>();
  private readonly expectedVerificationQueue=new Map<string,string|null>();
  private expectedVerificationTimer:number|null=null;
  private expectedVerificationRunning=false;
  compatibility:ClientCompatibility|null=null;
  private compatibilityBlocked=false;
  private readonly persistSettings=createSerializedSettingsWriter(()=>this.settings,(snapshot)=>this.saveData(snapshot));

  async onload() {
    this.settings = await loadSettings(this);this.settings.fullScanRequired=true;
    for(const path of this.settings.pendingPaths)this.pathVersions.set(path,++this.pathRevision);
    this.api = new GibSyncApi(() => this.settings);
    this.liveStatus = {...initialLiveStatus(Boolean(this.settings.deviceToken)),lastSuccessAt:this.settings.lastSuccessAt,lastErrorAt:this.settings.lastErrorAt,lastError:this.settings.lastError,lastResult:this.settings.lastResult};
    this.statusEl = this.addStatusBarItem();
    this.engine = new SyncEngine(this.app.vault.adapter, this.api, () => this.settings, () => this.saveSettings(), (progress) => this.report(progress.phase,progress.message,progress.level??"info",progress.current,progress.total),undefined,(path,hash)=>this.expectedLocalMutations.set(normalizePath(path),hash),undefined,Platform.isMobile);
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
    this.registerEvent(this.app.vault.on("create", (file) => {if(file instanceof TFolder){const path=normalizePath(file.path),expected=this.expectedLocalMutations.get(path);if(this.expectedLocalMutations.has(path)){this.queueExpectedMutationVerification(path,expected??null);return;}this.settings.folderCreateTimes[path]=Date.now();this.requireFullScan();}else this.scheduleFileChangeSync(file.path);}));
    this.registerEvent(this.app.vault.on("modify", (file) => {if(!(file instanceof TFolder))this.scheduleFileChangeSync(file.path);}));
    this.registerEvent(this.app.vault.on("delete", (file) => {if(file instanceof TFolder){const path=normalizePath(file.path),expected=this.expectedLocalMutations.get(path);if(this.expectedLocalMutations.has(path)){this.queueExpectedMutationVerification(path,expected??null);return;}this.recordPathTime(path,true);this.requireFullScan();}else this.scheduleFileChangeSync(file.path);}));
    this.registerEvent(this.app.vault.on("rename", (file,oldPath) => {this.lastVaultRenameAt=Date.now();if(file instanceof TFolder){this.settings.folderCreateTimes[normalizePath(file.path)]=Date.now();this.persistJournalSoon();this.recordPathTime(file.path,true);this.recordPathTime(oldPath,true);this.requireFullScan();}else this.scheduleFileChangeSync(file.path,oldPath);}));
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
    this.registerInterval(window.setInterval(()=>{if(this.settings.deviceToken&&this.safetyHold)void this.refreshServerStatus();},30_000));
    void this.checkObsidianSyncProtection();
    if(this.settings.deviceToken)await this.checkCompatibility(false);
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
    if(this.journalSaveTimer!==null)window.clearTimeout(this.journalSaveTimer);
    if(this.expectedVerificationTimer!==null)window.clearTimeout(this.expectedVerificationTimer);
    this.expectedVerificationQueue.clear();
    if(this.settings.pendingPaths.length||Object.keys(this.settings.pendingPathTimes).length||this.settings.pendingApplyPaths.length||this.settings.fullScanRequired)void this.saveSettings();
    this.mobileObserver?.disconnect();this.mobileSidebarEl?.remove();this.mobileTopEl?.remove();
    this.removeStaleMobileSidebarIndicators();
  }
  private attentionCount():number{return this.serverStatus?.safeguards.pendingQuarantines??0;}
  private indicatorHealth(){const alerts=this.serverStatus?.healthAlerts??[],error=alerts.find((item)=>item.level==="error"),warning=alerts.find((item)=>item.level==="warning");return {errors:alerts.filter((item)=>item.level==="error").length,warnings:alerts.filter((item)=>item.level==="warning").length,description:error?.message??warning?.message};}
  indicatorState(){
    if(this.compatibilityBlocked)return {key:"blocked" as const,label:"Update required",icon:"download",tone:"warning" as const,animated:false,attentionCount:0,description:this.compatibility?.reason??"This Gib Sync version is not compatible with the server"};
    if(this.serverStatus?.containment?.active&&!this.serverStatus.containment.thisVaultAllowed)return {key:"blocked" as const,label:"Server paused",icon:"shield-alert",tone:"warning" as const,animated:false,attentionCount:0,description:"Emergency containment is protecting this vault; no files are being changed"};
    const health=this.indicatorHealth();
    if(this.settings.retiredFolderCount){health.warnings++;health.description=this.settings.retiredFolderNote||`${this.settings.retiredFolderCount} local folder mismatch${this.settings.retiredFolderCount===1?"":"es"} remain`;}
    return deriveIndicatorState(this.liveStatus,Boolean(this.settings.deviceToken),this.nativeSyncBlocked||this.settings.paused,this.attentionCount(),health);
  }
  isNativeSyncBlocking():boolean{return this.nativeSyncBlocked;}
  private appendIndicatorVisual(host:HTMLElement,state= this.indicatorState(),dotOnly=false){
    if(state.key==="syncing"){
      const ring=host.createSpan({cls:`gib-sync-progress-ring${this.liveStatus.total?" is-determinate":this.settings.animateStatusIndicator?" is-indeterminate":""}`});
      const percent=this.liveStatus.total?Math.max(0,Math.min(100,((this.liveStatus.current??0)/this.liveStatus.total)*100)):25;
      ring.style.setProperty("--gib-sync-progress",`${percent}%`);ring.setAttr("aria-hidden","true");return;
    }
    if(dotOnly)host.createSpan({cls:"gib-sync-indicator-dot"});
    else{const icon=host.createSpan({cls:"gib-sync-indicator-icon"});setIcon(icon,state.icon);}
  }
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
    if(dotOnly)this.appendIndicatorVisual(element,state,true);
    else if(nativeSidebar){
      this.appendIndicatorVisual(element,state);
      if(this.settings.showAttentionBadge&&state.attentionCount>0)element.createSpan({cls:"gib-sync-indicator-badge",text:String(Math.min(99,state.attentionCount))});
    }
    else{
      this.appendIndicatorVisual(element,state);
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
    if(this.settings.desktopStatusIcon){this.appendIndicatorVisual(this.statusEl,state);if(this.settings.showAttentionBadge&&state.attentionCount>0)this.statusEl.createSpan({cls:"gib-sync-indicator-badge",text:String(Math.min(99,state.attentionCount))});}
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
  async refreshServerStatus() { if (!this.settings.deviceToken) return; try { const wasHeld=this.safetyHold,wasContained=Boolean(this.serverStatus?.containment?.active&&!this.serverStatus.containment.thisVaultAllowed);this.serverStatus=await this.api.status();if(this.serverStatus.compatibility)this.applyCompatibility(this.serverStatus.compatibility); this.settings.storage=this.serverStatus.storage;const contained=Boolean(this.serverStatus.containment?.active&&!this.serverStatus.containment.thisVaultAllowed);if(contained){this.safetyHold=true;this.report("blocked","Server emergency pause is active; this vault is protected and no files are being changed","warning");}else if(!this.serverStatus.safeguards.pendingQuarantines&&!this.serverStatus.safeguards.writeLocked)this.safetyHold=false; await this.saveSettings(); if(wasContained&&!contained&&!this.safetyHold){this.report("idle","Server emergency pause cleared; synchronization can resume","success");this.configureTimer();this.configureWatch();this.queueSync(1000,"Server pause cleared","automatic");}else if(wasHeld&&!this.safetyHold)this.scheduleNextSyncLabel();else this.emitStatus(); } catch (error) { this.report("error",`Status check failed: ${error instanceof Error?error.message:String(error)}`,"error"); } }
  private applyCompatibility(result:ClientCompatibility){
    result=enforceServerCompatibility(result);this.compatibility=result;const wasBlocked=this.compatibilityBlocked;this.compatibilityBlocked=!result.compatible;
    if(this.compatibilityBlocked){this.watchGeneration++;if(this.timer!==null)window.clearInterval(this.timer);this.timer=null;if(this.debounce!==null)window.clearTimeout(this.debounce);this.debounce=null;this.debounceKind=null;this.liveStatus.nextSyncAt=null;this.report("blocked",`${result.reason} Synchronization is disabled until compatibility is restored.`,"warning");}
    else if(wasBlocked){this.report("idle","Client update accepted; synchronization can resume","success");this.configureTimer();this.configureWatch();}
    if(result.compatible&&result.updateAvailable)this.notify("client-update",`Gib Sync ${result.recommendedVersion} is available through BRAT.`,7000,6*60*60*1000);
  }
  private async checkCompatibility(showNotice=true):Promise<boolean>{
    try{this.applyCompatibility(await this.api.compatibility());const result=this.compatibility!;if(!result.compatible&&showNotice)this.notify("compatibility",`${result.reason} Synchronization remains disabled.`,12000,60_000);return result.compatible;}
    catch(error){if(error instanceof ApiError&&error.status===404){const result=unavailableServerCompatibility();this.applyCompatibility(result);if(showNotice)this.notify("compatibility",`${result.reason} Update the self-hosted server before syncing.`,12000,60_000);return false;}const message=error instanceof Error?error.message:String(error);this.report("error",`Compatibility check failed: ${message}`,"error");if(showNotice)this.notify("compatibility-check",`Gib Sync could not verify server compatibility: ${message}`,8000,60_000);return false;}
  }
  async saveSettings() { await this.persistSettings(); }
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
    assertSetupServerCompatible(setup);
    Object.assign(this.settings, { serverUrl: setup.serverUrl, vaultId: setup.vaultId, vaultName: setup.vaultName, vaultKey: setup.vaultKey, deviceId: setup.deviceId, deviceToken: setup.deviceToken,deviceName,storage:setup.storage,lastSnapshotId:null,initialized:false,vaultIdentity:this.currentVaultIdentity(),pendingPaths:[],pendingPathTimes:{},pendingApplyPaths:[],pendingApplySnapshotId:null,pendingApplyBaseSnapshotId:null,pendingApplyPriorHashes:{},retiredPaths:{},folderCreateTimes:{},folderCleanupVersion:5,lastFolderCleanupAt:0,lastFolderCleanupError:"",retiredFolderCount:0,retiredFolderNote:"",fullScanRequired:true,lastFullScanAt:null });
    this.pathVersions.clear();
    this.liveStatus=initialLiveStatus(true); this.report("idle","Connected; ready for first sync","success"); await this.saveSettings(); this.configureTimer(); this.configureWatch(); void this.refreshServerStatus();
  }
  async verifyServerBeforeSetup(server:string){assertSetupServerCompatible(await this.api.serverInfo(server));}
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
    if(!await this.checkCompatibility())return false;
    if(await this.checkObsidianSyncProtection(true))return false;
    if (this.liveStatus.running) return false;
    const settleWindow=Date.now()-this.lastVaultRenameAt<30_000?5000:2000,quietFor=Date.now()-this.lastRelevantVaultChangeAt;
    if(this.lastRelevantVaultChangeAt&&quietFor<settleWindow){this.queueSync(settleWindow+250-quietFor,"Waiting for file moves and automatic link updates to settle","file-change");return false;}
    const identity=this.currentVaultIdentity();
    if(this.settings.initialized&&this.settings.vaultIdentity&&identity!==this.settings.vaultIdentity){
      const message="Vault-location protection paused sync because this device now points to a different vault path or name. Verify it in Gib Sync settings before trusting the new location.";
      this.report("error",message,"error");this.notify("vault-location",message,10000,300_000);return false;
    }
    if(!this.settings.vaultIdentity){this.settings.vaultIdentity=identity;await this.saveSettings();}
    if(this.debounce!==null){window.clearTimeout(this.debounce);this.debounce=null;this.debounceKind=null;}
    this.liveStatus.running=true; this.liveStatus.startedAt=new Date().toISOString(); this.liveStatus.completedAt=null; this.liveStatus.nextSyncAt=null; this.report("scanning","Starting sync");
    let changedDuringRead:FileChangedDuringReadError|null=null,genericFailure=false,runSucceeded=false;
    const startingVersions=new Map(this.pathVersions),startingPathTimes={...this.settings.pendingPathTimes};
    try {
      const result = await this.engine.sync(); const now=new Date().toISOString(); const summary=`${result.uploaded} encrypted uploads · ${result.mirrored} readable files written · ${result.downloaded} downloaded · ${result.deleted} deleted · ${result.prunedFolders} folders reconciled · ${result.pendingRetiredFolders} folder mismatches · ${result.resolved} system changes auto-resolved · ${result.conflicts} note conflicts`;
      for(const path of result.processedPaths)if(this.pathVersions.get(path)===startingVersions.get(path))this.pathVersions.delete(path);
      for(const [path,time] of Object.entries(startingPathTimes))if(this.settings.pendingPathTimes[path]===time&&(result.fullScan||result.processedPaths.includes(path)))delete this.settings.pendingPathTimes[path];
      this.settings.pendingPaths=[...this.pathVersions.keys()].sort();
      this.liveStatus.running=false;this.liveStatus.completedAt=now;this.liveStatus.lastSuccessAt=now;this.liveStatus.lastResult=summary;this.liveStatus.lastError="";
      this.changedDuringReadFailures.clear();
      this.safetyHold=false;
      this.settings.lastSuccessAt=now;this.settings.lastResult=summary;this.settings.lastError="";await this.saveSettings();
      const changed=Boolean(result.uploaded||result.mirrored||result.downloaded||result.deleted||result.prunedFolders),folderWarning=result.pendingRetiredFolders>0;
      this.report(folderWarning?"blocked":changed?"complete":"up-to-date",`${folderWarning?"Files synchronized, but folder topology does not match":changed?"Sync complete":"Up to date"} · ${summary}`,result.conflicts||folderWarning?"warning":"success");
      if(!folderWarning)await this.api.markDeviceReady(result.snapshotId).catch(()=>{});
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
      this.scheduleExpectedVerification();
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
    if(!this.settings.deviceToken)return;
    const normalized=paths.map((path)=>normalizePath(path));
    const expected=normalized.filter((path)=>this.expectedLocalMutations.has(path));
    if(expected.length){for(const path of expected)this.queueExpectedMutationVerification(path,this.expectedLocalMutations.get(path)!);paths=normalized.filter((path)=>!expected.includes(path));}
    const relevant=paths.map((path)=>normalizePath(path)).filter((path)=>shouldSyncChangedPath(path,this.settings));if(!relevant.length)return;
    const changedAt=Date.now();for(const path of relevant){this.pathVersions.set(path,++this.pathRevision);this.recordPathTime(path,false,changedAt);}
    this.settings.pendingPaths=[...this.pathVersions.keys()].sort();this.persistJournalSoon();
    this.lastRelevantVaultChangeAt=Date.now();
    if(!this.settings.syncOnFileChange)return;
    if(this.liveStatus.running){this.fileChangePending=true;return;}
    const delay=Date.now()-this.lastVaultRenameAt<30_000?5000:2000;
    this.queueSync(delay,"Vault file changed","file-change");
  }
  private recordPathTime(path:string,folder=false,at=Date.now()){
    let normalized=normalizePath(path);if(!normalized)return;if(folder&&!normalized.endsWith("/"))normalized+="/";
    this.settings.pendingPathTimes[normalized]=Math.max(this.settings.pendingPathTimes[normalized]??0,at);
  }
  private async verifyExpectedMutation(path:string,expectedHash:string|null){
    try{
      const stat=await this.app.vault.adapter.stat(path);
      if(!stat&&expectedHash===null){if(this.expectedLocalMutations.get(path)===expectedHash)this.expectedLocalMutations.delete(path);return;}
      if(stat?.type==="folder"&&expectedHash==="folder"){if(this.expectedLocalMutations.get(path)===expectedHash)this.expectedLocalMutations.delete(path);return;}
      if(stat?.type==="file"&&expectedHash&&await hashBytes(new Uint8Array(await this.app.vault.adapter.readBinary(path)))===expectedHash){if(this.expectedLocalMutations.get(path)===expectedHash)this.expectedLocalMutations.delete(path);return;}
    }catch{}
    if(this.expectedLocalMutations.get(path)!==expectedHash)return;this.expectedLocalMutations.delete(path);
    this.scheduleFileChangeSync(path);
  }
  private queueExpectedMutationVerification(path:string,expectedHash:string|null){
    this.expectedVerificationQueue.set(path,expectedHash);this.scheduleExpectedVerification();
  }
  private scheduleExpectedVerification(){
    if(this.liveStatus.running||this.expectedVerificationRunning||this.expectedVerificationTimer!==null||!this.expectedVerificationQueue.size)return;
    this.expectedVerificationTimer=window.setTimeout(()=>{this.expectedVerificationTimer=null;void this.drainExpectedVerifications();},100);
  }
  private async drainExpectedVerifications(){
    if(this.expectedVerificationRunning||this.liveStatus.running)return;
    this.expectedVerificationRunning=true;
    try{
      while(this.expectedVerificationQueue.size&&!this.liveStatus.running){
        const next=this.expectedVerificationQueue.entries().next().value as [string,string|null]|undefined;if(!next)break;
        this.expectedVerificationQueue.delete(next[0]);await this.verifyExpectedMutation(next[0],next[1]);
        await new Promise<void>((resolve)=>window.setTimeout(resolve,0));
      }
    }finally{this.expectedVerificationRunning=false;if(this.expectedVerificationQueue.size)this.scheduleExpectedVerification();}
  }
  requireFullScan(){
    this.settings.fullScanRequired=true;this.persistJournalSoon();
    if(!this.settings.deviceToken||!this.settings.syncOnFileChange)return;
    this.lastRelevantVaultChangeAt=Date.now();if(this.liveStatus.running){this.fileChangePending=true;return;}
    this.queueSync(5000,"Folder structure changed; reconciling safely","file-change");
  }
  private persistJournalSoon(){
    if(this.journalSaveTimer!==null)window.clearTimeout(this.journalSaveTimer);
    this.journalSaveTimer=window.setTimeout(()=>{this.journalSaveTimer=null;void this.saveSettings();},250);
  }
  configureFileChangeSync() {
    if(this.settings.syncOnFileChange||this.debounceKind!=="file-change"||this.debounce===null)return;
    window.clearTimeout(this.debounce);this.debounce=null;this.debounceKind=null;this.liveStatus.nextSyncAt=null;this.report("idle","File-change sync disabled");
    this.scheduleNextSyncLabel();
  }
  private queueSync(delay:number,reason:string,kind:"automatic"|"file-change"="file-change") {
    if(this.nativeSyncBlocked||this.settings.paused||this.safetyHold||this.compatibilityBlocked)return;
    if (this.debounce !== null) window.clearTimeout(this.debounce);
    this.debounceKind=kind;
    this.liveStatus.nextSyncAt=new Date(Date.now()+delay).toISOString();this.report("scheduled",`${reason}; sync in ${Math.max(1,Math.round(delay/1000))}s`);
    this.debounce = window.setTimeout(() => { this.debounce = null;this.debounceKind=null;void this.runSync(); }, delay);
  }
  private scheduleNextSyncLabel() { if (!this.nativeSyncBlocked&&!this.settings.paused&&!this.safetyHold&&!this.compatibilityBlocked&&this.settings.autoSync&&this.settings.deviceToken) { this.liveStatus.nextSyncAt=new Date(Date.now()+Math.max(15,this.settings.syncIntervalSeconds)*1000).toISOString(); this.emitStatus(); } else {this.liveStatus.nextSyncAt=null;this.emitStatus();} }
  configureTimer() {
    if (this.timer !== null) window.clearInterval(this.timer); this.timer = null;
    if (!this.nativeSyncBlocked&&!this.settings.paused&&!this.compatibilityBlocked&&this.settings.autoSync && this.settings.deviceToken) { this.timer = window.setInterval(() => {if(!this.safetyHold)void this.runSync();}, Math.max(15, this.settings.syncIntervalSeconds) * 1000); this.scheduleNextSyncLabel(); }
    else { this.liveStatus.nextSyncAt=null;this.emitStatus(); }
  }
  configureWatch() {
    const generation=++this.watchGeneration;
    if(!this.nativeSyncBlocked&&!this.settings.paused&&!this.compatibilityBlocked&&this.settings.instantReceive&&this.settings.deviceToken)void this.watchLoop(generation);
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
          else{syncFailures++;const delay=Math.min(60_000,5000*2**Math.min(syncFailures-1,4));this.liveStatus.running=false;this.liveStatus.nextSyncAt=new Date(Date.now()+delay).toISOString();this.report("scheduled",`Incoming sync failed · retry ${syncFailures} in ${Math.round(delay/1000)}s · ${this.liveStatus.lastError||"see recent activity"}`,"warning");await new Promise<void>((resolve)=>window.setTimeout(resolve,delay));}
        }
      }catch(error){
        if(generation!==this.watchGeneration)return;
        if(error instanceof ApiError&&error.status===426){await this.checkCompatibility();return;}
        if(error instanceof ApiError&&error.status===423&&(error.responseBody as {containment?:unknown}|null)?.containment){this.safetyHold=true;await this.refreshServerStatus();await new Promise<void>((resolve)=>window.setTimeout(resolve,30_000));continue;}
        failures++;
        if(failures===1)this.report("scheduled","Instant incoming sync reconnecting; periodic sync remains active","warning");
        await new Promise<void>((resolve)=>window.setTimeout(resolve,Math.min(10_000,1000*2**Math.min(failures-1,3))));
      }
    }
  }
}
