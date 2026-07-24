import { App, Modal, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type { ExistingVaultLocation, HistoryItem, SeafileLibrary, SetupResponse } from "@gib-sync/protocol";
import type GibSyncPlugin from "./main";
import { normalizeQuickCode,openPairingEnvelope } from "./crypto";

function defaultDeviceName(): string {
  if (Platform.isIosApp) return "iPhone / iPad";
  if (Platform.isAndroidApp) return "Android";
  return navigator.platform || "Desktop";
}

function when(value:string|null|undefined):string { return value?new Date(value).toLocaleString():"Never"; }
function bytes(value:number):string { if(value<1024)return `${value} B`;if(value<1024**2)return `${(value/1024).toFixed(1)} KB`;if(value<1024**3)return `${(value/1024**2).toFixed(1)} MB`;return `${(value/1024**3).toFixed(2)} GB`; }

export class SetupModal extends Modal {
  constructor(app: App, private readonly plugin: GibSyncPlugin) { super(app); }
  onOpen() {
    this.setTitle("Connect Gib Sync");
    this.contentEl.createEl("p",{text:"Choose the Seafile account, library, and folder for this vault. Using the same location on another device reconnects it manually. Your password is exchanged for a Seafile API token and is never saved in Obsidian."});
    let server=this.plugin.settings.serverUrl||"https://sync.example.com";
    let seafileUrl=this.plugin.settings.storage?.seafileUrl||"https://seafile.example.com";
    let username=this.plugin.settings.storage?.username||"";let password="";let vaultName=this.app.vault.getName();let deviceName=defaultDeviceName();
    let libraryId="";let libraryName="";let basePath=this.plugin.settings.storage?.basePath||`/Obsidian/${vaultName}`;let existingVaultId:string|undefined;let libraries:SeafileLibrary[]=[];let existingVaults:ExistingVaultLocation[]=[];
    let pathInput!:HTMLInputElement;let vaultInput!:HTMLInputElement;
    new Setting(this.contentEl).setName("Gib Sync server").addText((text)=>text.setValue(server).onChange((value)=>server=value.trim()));
    new Setting(this.contentEl).setName("Seafile server").addText((text)=>text.setValue(seafileUrl).onChange((value)=>seafileUrl=value.trim()));
    new Setting(this.contentEl).setName("Seafile account").addText((text)=>text.setPlaceholder("you@example.com").setValue(username).onChange((value)=>username=value.trim()));
    new Setting(this.contentEl).setName("Seafile password").setDesc("Used only during this connection request.").addText((text)=>{text.inputEl.type="password";text.onChange((value)=>password=value);});
    const librarySetting=new Setting(this.contentEl).setName("Seafile library").setDesc("Load the libraries available to this account.");
    const select=librarySetting.controlEl.createEl("select"); select.disabled=true; select.createEl("option",{text:"Load libraries first",value:""});
    select.onchange=()=>{libraryId=select.value;libraryName=libraries.find((item)=>item.id===libraryId)?.name||"";existingVaultId=undefined;existingSelect.value="-1";};
    const existingSetting=new Setting(this.contentEl).setName("Existing Gib Sync vault").setDesc("A discovered vault can fill the library and folder automatically.");
    const existingSelect=existingSetting.controlEl.createEl("select");existingSelect.disabled=true;existingSelect.createEl("option",{text:"Load libraries first",value:""});
    const useExisting=(index:number)=>{const existing=existingVaults[index];if(!existing)return;existingVaultId=existing.vaultId;libraryId=existing.libraryId;libraryName=existing.libraryName;select.value=libraryId;basePath=existing.basePath;pathInput.value=basePath;vaultName=existing.vaultName;vaultInput.value=vaultName;};
    existingSelect.onchange=()=>{const index=Number(existingSelect.value);if(Number.isInteger(index)&&index>=0)useExisting(index);else existingVaultId=undefined;};
    librarySetting.addButton((button)=>button.setButtonText("Load libraries").onClick(async()=>{
      button.setDisabled(true).setButtonText("Loading…");
      try { const result=await this.plugin.api.discover(server,seafileUrl,username,password);libraries=result.libraries;existingVaults=result.existingVaults;select.empty();for(const library of libraries)select.createEl("option",{text:library.name,value:library.id});select.disabled=false;
        const preferred=this.plugin.settings.storage?.libraryId;libraryId=libraries.find((item)=>item.id===preferred)?.id||libraries[0]?.id||"";select.value=libraryId;libraryName=libraries.find((item)=>item.id===libraryId)?.name||"";button.setButtonText("Reload");
        existingSelect.empty();existingSelect.createEl("option",{text:existingVaults.length?"Create or use the location below":"No existing vaults found",value:"-1"});for(const [index,vault] of existingVaults.entries())existingSelect.createEl("option",{text:`${vault.vaultName} — ${vault.libraryName}:${vault.basePath}`,value:String(index)});existingSelect.disabled=!existingVaults.length;if(existingVaults.length===1){existingSelect.value="0";useExisting(0);}
        if(!libraries.length)new Notice("This Seafile account has no accessible libraries.");
      } catch(error){new Notice(`Unable to load libraries: ${error instanceof Error?error.message:String(error)}`,10000);button.setButtonText("Try again");}
      finally{button.setDisabled(false);}
    }));
    new Setting(this.contentEl).setName("Folder in library").setDesc("Your readable 1:1 Obsidian vault is stored here. Gib Sync keeps synchronization metadata in a hidden .gib-sync subfolder.").addText((text)=>{pathInput=text.inputEl;text.setValue(basePath).onChange((value)=>{basePath=value.trim();existingVaultId=undefined;existingSelect.value="-1";});});
    new Setting(this.contentEl).setName("Vault name").addText((text)=>{vaultInput=text.inputEl;text.setValue(vaultName).onChange((value)=>vaultName=value.trim());});
    new Setting(this.contentEl).setName("Device name").addText((text)=>text.setValue(deviceName).onChange((value)=>deviceName=value.trim()));
    new Setting(this.contentEl).addButton((button)=>button.setCta().setButtonText("Connect").onClick(async()=>{
      if(!libraryId){new Notice("Load and select a Seafile library first.");return;}button.setDisabled(true).setButtonText("Connecting…");
      try { const setup=await this.plugin.api.setup(server,{vaultName,deviceName,seafileUrl,seafileUsername:username,seafilePassword:password,libraryId,libraryName,basePath,existingVaultId});await this.plugin.acceptSetup(setup,deviceName);this.close();new Notice("Gib Sync connected. Starting first sync…");void this.plugin.runSync(); }
      catch(error){new Notice(`Setup failed: ${error instanceof Error?error.message:String(error)}`,10000);button.setDisabled(false).setButtonText("Connect");}
    }));
  }
  onClose(){this.contentEl.empty();}
}

export class QuickCodeDisplayModal extends Modal {
  private timer:number|null=null;private expiresAt=0;private refreshing=false;private closed=false;private codeEl!:HTMLElement;private statusEl!:HTMLElement;
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  async onOpen(){this.closed=false;this.setTitle("Connect another device");this.contentEl.createEl("p",{text:"Enter this five-digit code in Gib Sync on the other device."});this.codeEl=this.contentEl.createDiv({cls:"gib-sync-quick-code",text:"-----"});this.statusEl=this.contentEl.createEl("p",{cls:"gib-sync-muted"});
    await this.refresh();this.timer=window.setInterval(()=>void this.tick(),1000);}
  private async refresh(){if(this.refreshing||this.closed)return;this.refreshing=true;try{const pairing=await this.plugin.api.createPairing();if(this.closed)return;this.codeEl.setText(pairing.code);this.codeEl.setAttr("aria-label",`Quick code ${pairing.code}`);this.expiresAt=Date.parse(pairing.expiresAt);this.tick();}
    catch(error){if(!this.closed)this.statusEl.setText(error instanceof Error?error.message:String(error));}finally{this.refreshing=false;}}
  private tick(){const seconds=Math.max(0,Math.ceil((this.expiresAt-Date.now())/1000));this.statusEl.setText(`Changes in ${seconds} second${seconds===1?"":"s"} · works once.`);if(seconds===0)void this.refresh();}
  onClose(){this.closed=true;if(this.timer!==null)window.clearInterval(this.timer);this.timer=null;this.contentEl.empty();}
}

export class QuickCodeEntryModal extends Modal {
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  onOpen(){this.setTitle("Enter quick code");let server=this.plugin.settings.serverUrl||"https://sync.example.com";let code="";let deviceName=defaultDeviceName();
    this.contentEl.createEl("p",{text:"On an already connected device, choose “Show quick code,” then type that temporary code here."});
    new Setting(this.contentEl).setName("Gib Sync server").addText((text)=>text.setValue(server).onChange((value)=>server=value.trim()));
    new Setting(this.contentEl).setName("Quick code").setDesc("Five numbers. The code changes every 60 seconds.").addText((text)=>{text.setPlaceholder("12345").onChange((value)=>code=value);text.inputEl.inputMode="numeric";text.inputEl.pattern="[0-9]*";text.inputEl.autocomplete="one-time-code";text.inputEl.maxLength=5;});
    new Setting(this.contentEl).setName("Device name").addText((text)=>text.setValue(deviceName).onChange((value)=>deviceName=value.trim()));
    new Setting(this.contentEl).addButton((button)=>button.setCta().setButtonText("Connect").onClick(async()=>{button.setDisabled(true).setButtonText("Connecting…");
      try{await this.plugin.claimQuickCode(server,code,deviceName);this.close();new Notice("Device connected. Starting first sync…");void this.plugin.runSync();}
      catch(error){new Notice(`Quick-code setup failed: ${error instanceof Error?error.message:String(error)}`,10000);button.setDisabled(false).setButtonText("Connect");}
    }));
  }
  onClose(){this.contentEl.empty();}
}

export class HistoryModal extends Modal {
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  async onOpen(){this.setTitle("Gib Sync history");const container=this.contentEl.createDiv({cls:"gib-sync-history"});container.setText("Loading…");try{const history=await this.plugin.api.history();container.empty();for(const item of history)this.row(container,item);if(!history.length)container.setText("No snapshots yet.");}catch(error){container.setText(error instanceof Error?error.message:String(error));}}
  private row(container:HTMLElement,item:HistoryItem){const row=container.createDiv({cls:"gib-sync-history-row"});const details=row.createDiv();details.createEl("strong",{text:item.message});details.createEl("div",{cls:"gib-sync-muted",text:`${new Date(item.createdAt).toLocaleString()} · ${item.deviceName} · ${item.fileCount} files`});const button=row.createEl("button",{text:"Restore"});button.onclick=async()=>{if(!confirm(`Restore the vault snapshot from ${new Date(item.createdAt).toLocaleString()}? A new snapshot will preserve the current history.`))return;button.disabled=true;try{await this.plugin.api.restore(item.id);this.close();await this.plugin.runSync();new Notice("Snapshot restored");}catch(error){new Notice(`Restore failed: ${error instanceof Error?error.message:String(error)}`,10000);button.disabled=false;}};}
  onClose(){this.contentEl.empty();}
}

export class GibSyncSettingTab extends PluginSettingTab {
  private unsubscribe:(()=>void)|null=null;private liveRoot:HTMLElement|null=null;
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app,plugin);}
  display(){this.unsubscribe?.();this.containerEl.empty();this.containerEl.createEl("h2",{text:"Gib Sync"});const configured=Boolean(this.plugin.settings.deviceToken);
    this.liveRoot=this.containerEl.createDiv({cls:"gib-sync-status-panel"});this.renderLive();this.unsubscribe=this.plugin.subscribeStatus(()=>this.renderLive());
    const actions=new Setting(this.containerEl).setName("Actions").setDesc(configured?"Sync now, or refresh server-side counters and connection details.":"Connect manually with Seafile details, or enter a temporary quick code from an existing device.");
    actions.addButton((button)=>button.setButtonText(configured?"Sync now":"Manual setup").setCta().onClick(()=>configured?void this.plugin.runSync():new SetupModal(this.app,this.plugin).open()));
    if(configured)actions.addButton((button)=>button.setButtonText("Refresh status").onClick(()=>void this.plugin.refreshServerStatus()));
    if(!configured)actions.addButton((button)=>button.setButtonText("Enter quick code").onClick(()=>new QuickCodeEntryModal(this.app,this.plugin).open()));
    if(configured)new Setting(this.containerEl).setName("Add another device").setDesc("Show a five-digit code that changes every 60 seconds and works once.").addButton((button)=>button.setButtonText("Show quick code").onClick(()=>new QuickCodeDisplayModal(this.app,this.plugin).open())).addButton((button)=>button.setButtonText("Change manual connection").onClick(()=>new SetupModal(this.app,this.plugin).open()));
    new Setting(this.containerEl).setName("Periodic sync").setDesc("Checks for remote changes on a timer.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.autoSync).onChange(async(value)=>{this.plugin.settings.autoSync=value;await this.plugin.saveSettings();this.plugin.configureTimer();}));
    new Setting(this.containerEl).setName("Sync interval").setDesc("Seconds between periodic checks (minimum 15).").addText((text)=>text.setValue(String(this.plugin.settings.syncIntervalSeconds)).onChange(async(value)=>{const parsed=Number(value);if(Number.isFinite(parsed)){this.plugin.settings.syncIntervalSeconds=Math.max(15,Math.round(parsed));await this.plugin.saveSettings();this.plugin.configureTimer();}}));
    new Setting(this.containerEl).setName("Sync when files change").setDesc("After a vault file is created, saved, renamed, or deleted, wait two seconds for edits to settle and then sync. Excluded paths do not trigger it.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.syncOnFileChange).onChange(async(value)=>{this.plugin.settings.syncOnFileChange=value;this.plugin.configureFileChangeSync();await this.plugin.saveSettings();}));
    new Setting(this.containerEl).setName("Sync Obsidian configuration").setDesc("Includes .obsidian except Gib Sync's own directory. Disabled by default to avoid device-specific layout conflicts.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.syncObsidianConfig).onChange(async(value)=>{this.plugin.settings.syncObsidianConfig=value;await this.plugin.saveSettings();}));
    new Setting(this.containerEl).setName("Excluded path prefixes").setDesc("One vault-relative prefix per line.").addTextArea((area)=>area.setValue(this.plugin.settings.exclusions.join("\n")).onChange(async(value)=>{this.plugin.settings.exclusions=value.split("\n").map((line)=>line.trim()).filter(Boolean);await this.plugin.saveSettings();}));
    if(configured)new Setting(this.containerEl).setName("Version history").addButton((button)=>button.setButtonText("Open history").onClick(()=>new HistoryModal(this.app,this.plugin).open()));
    if(configured)void this.plugin.refreshServerStatus();
  }
  hide(){this.unsubscribe?.();this.unsubscribe=null;}
  private renderLive(){if(!this.liveRoot)return;const root=this.liveRoot;root.empty();const live=this.plugin.liveStatus;const server=this.plugin.serverStatus;const storage=server?.storage||this.plugin.settings.storage;
    const header=root.createDiv({cls:`gib-sync-status-head is-${live.phase}`});header.createDiv({cls:"gib-sync-status-dot"});const copy=header.createDiv();copy.createEl("strong",{text:live.message});copy.createEl("div",{cls:"gib-sync-muted",text:live.running?`Running since ${when(live.startedAt)}`:`State: ${live.phase}`});
    if(live.total){const track=root.createDiv({cls:"gib-sync-progress"});track.createDiv({cls:"gib-sync-progress-value",attr:{style:`width:${Math.min(100,((live.current||0)/live.total)*100)}%`}});}
    const grid=root.createDiv({cls:"gib-sync-status-grid"});const item=(label:string,value:string)=>{const el=grid.createDiv();el.createEl("span",{text:label});el.createEl("strong",{text:value});};
    item("Last success",when(live.lastSuccessAt));item("Last result",live.lastResult||"No completed sync yet");item("Next automatic sync",when(live.nextSyncAt));item("Last error",live.lastError||"None");
    item("Server",this.plugin.settings.serverUrl||"Not connected");item("Vault / device",this.plugin.settings.vaultName?`${this.plugin.settings.vaultName} / ${this.plugin.settings.deviceName}`:"Not configured");
    if(storage){item("Seafile",`${storage.username} @ ${storage.seafileUrl}`);item("Readable recovery vault",`${storage.libraryName}:${storage.readablePath}`);item("Sync metadata",`${storage.libraryName}:${storage.basePath}/.gib-sync`);}
    if(server){item("Remote inventory",`${server.snapshotCount} snapshots · ${server.blobCount} encrypted history blobs · ${bytes(server.blobBytes)}`);item("Readable mirror",server.mirrorCurrent?`Current · ${server.mirrorFileCount} files`:`Needs reconciliation · ${server.mirrorFileCount} files`);item("Connected devices",String(server.deviceCount));}
    const activity=root.createDiv({cls:"gib-sync-activity"});const title=activity.createDiv({cls:"gib-sync-activity-title"});title.createEl("strong",{text:"Live activity"});const buttons=title.createDiv();const copyButton=buttons.createEl("button",{text:"Copy diagnostics"});copyButton.onclick=async()=>{await navigator.clipboard.writeText(JSON.stringify({generatedAt:new Date().toISOString(),live,server,connection:{serverUrl:this.plugin.settings.serverUrl,vaultId:this.plugin.settings.vaultId,deviceId:this.plugin.settings.deviceId,storage}},null,2));new Notice("Gib Sync diagnostics copied (no passwords, keys, or tokens)");};const clear=buttons.createEl("button",{text:"Clear"});clear.onclick=()=>this.plugin.clearActivity();
    const log=activity.createDiv({cls:"gib-sync-activity-log"});for(const entry of [...live.activities].reverse().slice(0,30)){const row=log.createDiv({cls:`gib-sync-activity-row is-${entry.level}`});row.createEl("time",{text:new Date(entry.at).toLocaleTimeString()});row.createEl("span",{text:entry.message});}if(!live.activities.length)log.createEl("div",{cls:"gib-sync-muted",text:"Activity will appear here as Gib Sync works."});
  }
}

export async function claimQuickCodeSetup(plugin:GibSyncPlugin,server:string,value:string,deviceName:string):Promise<SetupResponse>{
  const code=normalizeQuickCode(value);const response=await plugin.api.claimQuickCode(server,code,deviceName);
  return openPairingEnvelope<SetupResponse>(response.envelope,code,response.pairingId);
}
