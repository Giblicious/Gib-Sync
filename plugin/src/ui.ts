import { App, Modal, Notice, Platform, PluginSettingTab, Setting, setIcon } from "obsidian";
import type { ChangeAssessment, DeviceInfo, ExistingVaultLocation, HistoryItem, QuarantineItem, SafeguardPolicy, SeafileLibrary, SetupResponse } from "@gib-sync/protocol";
import type GibSyncPlugin from "./main";
import { normalizeQuickCode,openPairingEnvelope } from "./crypto";
import { shouldSyncChangedPath } from "./settings";
import { detailedDiagnostics,privacySafeDiagnostics } from "./diagnostics";

function defaultDeviceName(): string {
  if (Platform.isIosApp) return "iPhone / iPad";
  if (Platform.isAndroidApp) return "Android";
  return navigator.platform || "Desktop";
}

function when(value:string|null|undefined):string { return value?new Date(value).toLocaleString():"Never"; }
function bytes(value:number):string { if(value<1024)return `${value} B`;if(value<1024**2)return `${(value/1024).toFixed(1)} KB`;if(value<1024**3)return `${(value/1024**2).toFixed(1)} MB`;return `${(value/1024**3).toFixed(2)} GB`; }
function assessmentText(value:ChangeAssessment):string{return `${value.created} created · ${value.modified} modified · ${value.deleted} deleted · ${value.moved} moved · ${value.affectedPercent}% affected`;}
function mobileContent(element:HTMLElement):void{element.addClass("gib-sync-modal-content");}

class ConfirmActionModal extends Modal{
  private settled=false;
  constructor(app:App,private readonly heading:string,private readonly message:string,private readonly confirmText:string,private readonly resolve:(value:boolean)=>void,private readonly warning=false){super(app);}
  onOpen(){mobileContent(this.contentEl);this.setTitle(this.heading);this.contentEl.createEl("p",{text:this.message});
    new Setting(this.contentEl).addButton((button)=>button.setButtonText("Cancel").onClick(()=>this.finish(false)))
      .addButton((button)=>{button.setButtonText(this.confirmText);if(this.warning)button.setWarning();else button.setCta();button.onClick(()=>this.finish(true));});}
  private finish(value:boolean){if(this.settled)return;this.settled=true;this.resolve(value);this.close();}
  onClose(){this.contentEl.empty();if(!this.settled){this.settled=true;this.resolve(false);}}
}
function confirmAction(app:App,heading:string,message:string,confirmText="Continue",warning=false):Promise<boolean>{
  return new Promise((resolve)=>new ConfirmActionModal(app,heading,message,confirmText,resolve,warning).open());
}

class TextPromptModal extends Modal{
  private settled=false;private value="";
  constructor(app:App,private readonly heading:string,private readonly label:string,initial:string,private readonly resolve:(value:string|null)=>void){super(app);this.value=initial;}
  onOpen(){mobileContent(this.contentEl);this.setTitle(this.heading);let input!:HTMLInputElement;
    new Setting(this.contentEl).setName(this.label).addText((text)=>{input=text.inputEl;text.setValue(this.value).onChange((value)=>this.value=value);input.onkeydown=(event)=>{if(event.key==="Enter"){event.preventDefault();this.finish(this.value.trim());}};});
    new Setting(this.contentEl).addButton((button)=>button.setButtonText("Cancel").onClick(()=>this.finish(null))).addButton((button)=>button.setCta().setButtonText("Save").onClick(()=>this.finish(this.value.trim())));
    window.setTimeout(()=>{input.focus();input.select();},0);
  }
  private finish(value:string|null){if(this.settled)return;this.settled=true;this.resolve(value);this.close();}
  onClose(){this.contentEl.empty();if(!this.settled){this.settled=true;this.resolve(null);}}
}
function promptText(app:App,heading:string,label:string,initial:string):Promise<string|null>{
  return new Promise((resolve)=>new TextPromptModal(app,heading,label,initial,resolve).open());
}

async function copyText(value:string):Promise<boolean>{
  try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);return true;}}catch{}
  const area=document.body.createEl("textarea");area.value=value;area.setAttr("readonly","");area.style.position="fixed";area.style.opacity="0";area.select();
  try{return document.execCommand("copy");}catch{return false;}finally{area.remove();}
}

export class SetupModal extends Modal {
  constructor(app: App, private readonly plugin: GibSyncPlugin) { super(app); }
  onOpen() {
    mobileContent(this.contentEl);
    this.setTitle("Connect Gib Sync");
    this.contentEl.createEl("p",{text:"Choose the Seafile account, library, and folder for this vault. Using the same location on another device reconnects it manually. Your password is exchanged for a Seafile API token and is never saved in Obsidian."});
    let server=this.plugin.settings.serverUrl||"";
    let seafileUrl=this.plugin.settings.storage?.seafileUrl||"";
    let username=this.plugin.settings.storage?.username||"";let password="";let vaultName=this.app.vault.getName();let deviceName=defaultDeviceName();
    let libraryId="";let libraryName="";let basePath=this.plugin.settings.storage?.basePath||`/Obsidian/${vaultName}`;let existingVaultId:string|undefined;let libraries:SeafileLibrary[]=[];let existingVaults:ExistingVaultLocation[]=[];
    let pathInput!:HTMLInputElement;let vaultInput!:HTMLInputElement;
    new Setting(this.contentEl).setName("Gib Sync server").addText((text)=>text.setPlaceholder("https://sync.example.com").setValue(server).onChange((value)=>server=value.trim()));
    new Setting(this.contentEl).setName("Seafile server").addText((text)=>text.setPlaceholder("https://seafile.example.com").setValue(seafileUrl).onChange((value)=>seafileUrl=value.trim()));
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
  async onOpen(){mobileContent(this.contentEl);this.closed=false;this.setTitle("Connect another device");this.contentEl.createEl("p",{text:"Enter this five-digit code in Gib Sync on the other device."});this.codeEl=this.contentEl.createDiv({cls:"gib-sync-quick-code",text:"-----"});this.statusEl=this.contentEl.createEl("p",{cls:"gib-sync-muted"});
    await this.refresh();this.timer=window.setInterval(()=>void this.tick(),1000);}
  private async refresh(){if(this.refreshing||this.closed)return;this.refreshing=true;try{const pairing=await this.plugin.api.createPairing();if(this.closed)return;this.codeEl.setText(pairing.code);this.codeEl.setAttr("aria-label",`Quick code ${pairing.code}`);this.expiresAt=Date.parse(pairing.expiresAt);this.tick();}
    catch(error){if(!this.closed)this.statusEl.setText(error instanceof Error?error.message:String(error));}finally{this.refreshing=false;}}
  private tick(){const seconds=Math.max(0,Math.ceil((this.expiresAt-Date.now())/1000));this.statusEl.setText(`Changes in ${seconds} second${seconds===1?"":"s"} · works once.`);if(seconds===0)void this.refresh();}
  onClose(){this.closed=true;if(this.timer!==null)window.clearInterval(this.timer);this.timer=null;this.contentEl.empty();}
}

export class QuickCodeEntryModal extends Modal {
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  onOpen(){mobileContent(this.contentEl);this.setTitle("Enter quick code");let server=this.plugin.settings.serverUrl||"";let code="";let deviceName=defaultDeviceName();
    this.contentEl.createEl("p",{text:"On an already connected device, choose “Show quick code,” then type that temporary code here."});
    new Setting(this.contentEl).setName("Gib Sync server").addText((text)=>text.setPlaceholder("https://sync.example.com").setValue(server).onChange((value)=>server=value.trim()));
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
  async onOpen(){mobileContent(this.contentEl);this.setTitle("Gib Sync history");this.contentEl.empty();const container=this.contentEl.createDiv({cls:"gib-sync-history"});container.setText("Loading…");try{const history=await this.plugin.api.history();container.empty();for(const item of history)this.row(container,item);if(!history.length)container.setText("No snapshots yet.");}catch(error){container.setText(error instanceof Error?error.message:String(error));}}
  private row(container:HTMLElement,item:HistoryItem){const row=container.createDiv({cls:"gib-sync-history-row"});const details=row.createDiv();details.createEl("strong",{text:`${item.bookmarked?"★ ":""}${item.message}`});details.createEl("div",{cls:"gib-sync-muted",text:`${new Date(item.createdAt).toLocaleString()} · ${item.deviceName} · ${item.fileCount} files`});
    const actions=row.createDiv({cls:"gib-sync-row-actions"}),bookmark=actions.createEl("button",{text:item.bookmarked?"Unbookmark":"Bookmark"});
    bookmark.onclick=async()=>{bookmark.disabled=true;try{if(item.bookmarked)await this.plugin.api.unbookmark(item.id);else{const label=await promptText(this.app,"Bookmark snapshot","Bookmark label","Known good");if(label===null){bookmark.disabled=false;return;}await this.plugin.api.bookmark(item.id,label||"Known good");}this.onOpen();}catch(error){new Notice(error instanceof Error?error.message:String(error));bookmark.disabled=false;}};
    const button=actions.createEl("button",{text:"Preview restore"});button.onclick=async()=>{button.disabled=true;try{const preview=await this.plugin.api.restorePreview(item.id);
      const reasons=preview.assessment.reasons.length?`\n\nWarnings:\n- ${preview.assessment.reasons.join("\n- ")}`:"";
      if(!await confirmAction(this.app,"Restore snapshot",`${assessmentText(preview.assessment)}${reasons}\n\nThis creates a new snapshot and preserves current history.`,"Restore",true)){button.disabled=false;return;}
      await this.plugin.api.restore(item.id,preview.confirmToken);this.close();await this.plugin.runSync();new Notice("Snapshot restored");
    }catch(error){new Notice(`Restore failed: ${error instanceof Error?error.message:String(error)}`,10000);button.disabled=false;}};}
  onClose(){this.contentEl.empty();}
}

export class SafeguardReviewModal extends Modal{
  constructor(app:App,private readonly plugin:GibSyncPlugin,private readonly closed:()=>void=()=>{}){super(app);}
  async onOpen(){mobileContent(this.contentEl);this.setTitle("Gib Sync quarantined changes");this.contentEl.empty();this.contentEl.setText("Loading…");try{const items=await this.plugin.api.quarantines();this.contentEl.empty();if(!items.length){this.contentEl.createEl("p",{text:"No changes are waiting for approval."});return;}for(const item of items)this.item(item);}catch(error){this.contentEl.setText(error instanceof Error?error.message:String(error));}}
  private item(item:QuarantineItem){
    const card=this.contentEl.createDiv({cls:"gib-sync-safeguard-card"});card.createEl("h3",{text:`${item.deviceName} · ${item.source==="seafile"?"Seafile/WebDAV":"Obsidian device"}`});
    card.createEl("p",{text:assessmentText(item.assessment)});const reasons=card.createEl("ul");for(const reason of item.assessment.reasons)reasons.createEl("li",{text:reason});
    const disclosure=card.createEl("details");disclosure.createEl("summary",{text:`Review ${item.changes.length} changed paths`});const list=disclosure.createEl("ul",{cls:"gib-sync-change-list"});
    for(const change of item.changes)list.createEl("li",{text:`${change.kind}: ${change.previousPath?`${change.previousPath} → `:""}${change.path}`});
    const actions=card.createDiv({cls:"gib-sync-row-actions"});
    const approve=actions.createEl("button",{text:"Approve once"}),trust=actions.createEl("button",{text:"Approve + trust 15 min"}),reject=actions.createEl("button",{text:"Reject and restore"});
    const disable=()=>{approve.disabled=true;trust.disabled=true;reject.disabled=true;};
    approve.onclick=async()=>{disable();try{await this.plugin.api.approveQuarantine(item.id);this.close();await this.plugin.runSync();new Notice("Quarantined changes approved");}catch(error){new Notice(error instanceof Error?error.message:String(error),10000);void this.onOpen();}};
    trust.onclick=async()=>{disable();try{await this.plugin.api.approveQuarantine(item.id,15);this.close();await this.plugin.runSync();new Notice("Changes approved; this source is trusted for 15 minutes");}catch(error){new Notice(error instanceof Error?error.message:String(error),10000);void this.onOpen();}};
    reject.onclick=async()=>{if(!await confirmAction(this.app,"Reject quarantined changes","Reject this entire change batch and restore this device to the last accepted snapshot?","Reject and restore",true))return;disable();try{await this.plugin.api.rejectQuarantine(item.id);const restored=await this.plugin.engine.restoreAcceptedSnapshot();this.close();new Notice(`Changes rejected · restored ${restored.downloaded} and removed ${restored.deleted} local files`,10000);void this.plugin.refreshServerStatus();}catch(error){new Notice(error instanceof Error?error.message:String(error),10000);void this.onOpen();}};
  }
  onClose(){this.contentEl.empty();this.closed();}
}

export class DeviceManagementModal extends Modal{
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  async onOpen(){mobileContent(this.contentEl);this.setTitle("Gib Sync devices");this.contentEl.setText("Loading…");await this.plugin.refreshServerStatus();this.contentEl.empty();const devices=this.plugin.serverStatus?.devices??[];
    for(const device of devices)this.row(device);if(!devices.length)this.contentEl.setText("No device information available.");}
  private row(device:DeviceInfo){const row=this.contentEl.createDiv({cls:"gib-sync-history-row"}),details=row.createDiv();details.createEl("strong",{text:`${device.name}${device.current?" (this device)":""}`});
    details.createEl("div",{cls:"gib-sync-muted",text:`Last seen ${when(device.lastSeenAt)} · ${device.ready?"First sync complete":"Restricted until first download"}${device.clockSkewMs?` · clock skew ${Math.round(device.clockSkewMs/60000)} min`:""}${device.revokedAt?" · revoked":""}`});
    if(!device.revokedAt){const button=row.createEl("button",{text:"Revoke"});button.onclick=async()=>{if(!await confirmAction(this.app,"Revoke device",`Revoke ${device.name}? It will immediately lose access to this vault.`,"Revoke",true))return;button.disabled=true;try{await this.plugin.api.revokeDevice(device.id);new Notice(`${device.name} revoked`);if(device.current)this.close();else void this.onOpen();}catch(error){new Notice(error instanceof Error?error.message:String(error),10000);button.disabled=false;}};}}
  onClose(){this.contentEl.empty();}
}

export class SafeguardSettingsModal extends Modal{
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  async onOpen(){mobileContent(this.contentEl);this.setTitle("Mass-change safeguards");this.contentEl.setText("Loading…");try{const state=await this.plugin.api.safeguards(),policy={...state.policy,protectedPaths:[...state.policy.protectedPaths]};this.contentEl.empty();
    this.contentEl.createEl("p",{text:"Balanced and strict modes use server-maintained thresholds. Custom mode uses every value below. Protected paths are enforced in every mode."});
    new Setting(this.contentEl).setName("Protection mode").addDropdown((dropdown)=>dropdown.addOption("balanced","Balanced").addOption("strict","Strict").addOption("custom","Custom").setValue(policy.mode).onChange((value)=>policy.mode=value as SafeguardPolicy["mode"]));
    const number=(name:string,key:keyof SafeguardPolicy,description:string)=>new Setting(this.contentEl).setName(name).setDesc(description).addText((text)=>text.setValue(String(policy[key])).onChange((value)=>{const parsed=Number(value);if(Number.isFinite(parsed))(policy as any)[key]=parsed;}));
    number("Deletion count","deletionCount","Quarantine at this many deletions.");
    number("Small-vault deletion count","smallVaultDeletionCount","Minimum deletions before the percentage rule applies.");
    number("Small-vault deletion percent","smallVaultDeletionPercent","Percentage of existing files deleted.");
    number("Total changed files","changedCount","Quarantine at this many creates, edits, deletes, or moves.");
    number("Vault changed percent","changedPercent","Percentage of the vault affected.");
    number("Folder impact count","folderImpactCount","Files removed or moved from one top-level folder.");
    number("Single-file growth bytes","fileGrowthBytes","Unexpected absolute growth for one file.");
    number("Single-file growth percent","fileGrowthPercent","Unexpected relative growth for one file.");
    number("Clock-skew warning minutes","clockSkewMinutes","Warn when a device clock differs from the server.");
    new Setting(this.contentEl).setName("Protected paths").setDesc("One vault-relative file or folder per line. Deletion always requires approval.").addTextArea((area)=>area.setValue(policy.protectedPaths.join("\n")).onChange((value)=>policy.protectedPaths=value.split("\n").map((line)=>line.trim()).filter(Boolean)));
    new Setting(this.contentEl).addButton((button)=>button.setCta().setButtonText("Save safeguards").onClick(async()=>{button.setDisabled(true);try{await this.plugin.api.updateSafeguardPolicy(policy);this.close();await this.plugin.refreshServerStatus();new Notice("Safeguards updated");}catch(error){new Notice(error instanceof Error?error.message:String(error),10000);button.setDisabled(false);}}));
  }catch(error){this.contentEl.setText(error instanceof Error?error.message:String(error));}}
  onClose(){this.contentEl.empty();}
}

export class NativeSyncConflictModal extends Modal{
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  onOpen(){
    mobileContent(this.contentEl);this.modalEl.addClass("gib-sync-native-sync-modal");this.setTitle("Obsidian Sync must be disabled");
    this.contentEl.createEl("p",{text:"Gib Sync has paused all scheduled and incoming synchronization because the Obsidian Sync core plugin is enabled. Running two sync engines against the same vault can create duplicate, conflicting, or deleted files."});
    this.contentEl.createEl("p",{text:"Disable Sync under Core plugins, then return here and check again. Gib Sync will also detect the change automatically."});
    new Setting(this.contentEl)
      .addButton((button)=>button.setCta().setButtonText("Open Core plugins").onClick(()=>this.plugin.openCorePluginSettings()))
      .addButton((button)=>button.setButtonText("Check again").onClick(async()=>{button.setDisabled(true);if(!await this.plugin.checkObsidianSyncProtection()){this.close();new Notice("Obsidian Sync is disabled; Gib Sync resumed.");}else button.setDisabled(false);}));
  }
  onClose(){this.contentEl.empty();}
}

export class StatusOverviewModal extends Modal{
  private unsubscribe:(()=>void)|null=null;
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  onOpen(){
    mobileContent(this.contentEl);this.modalEl.addClass("gib-sync-status-modal");this.setTitle("Sync status");
    this.render();this.unsubscribe=this.plugin.subscribeStatus(()=>this.render());
    if(this.plugin.settings.deviceToken)void this.plugin.refreshServerStatus();
  }
  private render(){
    const root=this.contentEl;root.empty();const live=this.plugin.liveStatus,state=this.plugin.indicatorState(),server=this.plugin.serverStatus;
    const hero=root.createDiv({cls:`gib-sync-status-overview is-${state.tone}`});const icon=hero.createSpan({cls:"gib-sync-status-overview-icon"});setIcon(icon,state.icon);
    const copy=hero.createDiv();copy.createEl("strong",{text:state.label});copy.createEl("div",{text:state.description,cls:"gib-sync-muted"});
    if(live.total){const track=root.createDiv({cls:"gib-sync-progress"});track.createDiv({cls:"gib-sync-progress-value",attr:{style:`width:${Math.min(100,((live.current||0)/live.total)*100)}%`}});}
    const facts=root.createDiv({cls:"gib-sync-status-overview-grid"});const fact=(label:string,value:string)=>{const item=facts.createDiv();item.createEl("span",{text:label});item.createEl("strong",{text:value});};
    fact("Current operation",live.message);fact("Last successful sync",when(live.lastSuccessAt));fact("Last result",live.lastResult||"No completed sync yet");fact("Next check",when(live.nextSyncAt));
    if(server){fact("Remote inventory",`${server.snapshotCount} snapshots · ${server.mirrorFileCount} readable files`);fact("Held changes",String(server.safeguards.pendingQuarantines));}
    const actions=root.createDiv({cls:"gib-sync-status-overview-actions"});
    const sync=actions.createEl("button",{text:"Sync now",cls:"mod-cta"});sync.disabled=live.running||this.plugin.settings.paused||this.plugin.isNativeSyncBlocking();sync.onclick=()=>{this.close();void this.plugin.runSync();};
    const pause=actions.createEl("button",{text:this.plugin.settings.paused?"Resume":"Pause"});pause.onclick=async()=>{pause.disabled=true;await this.plugin.setPaused(!this.plugin.settings.paused);this.render();};
    if(state.attentionCount>0){const review=actions.createEl("button",{text:"Review held changes"});review.onclick=()=>{this.close();this.plugin.openSafeguards();};}
    const settings=actions.createEl("button",{text:"Settings"});settings.onclick=()=>{this.close();const control=(this.app as unknown as {setting?:{open?:()=>void;openTabById?:(id:string)=>void}}).setting;control?.open?.();window.setTimeout(()=>control?.openTabById?.("gib-sync"),50);};
    if(this.plugin.isNativeSyncBlocking()){const warning=root.createDiv({cls:"gib-sync-native-sync-warning"});warning.createEl("strong",{text:"Obsidian Sync is enabled"});warning.createEl("p",{text:"Gib Sync is safely paused until the core Sync plugin is disabled."});const button=warning.createEl("button",{text:"Resolve"});button.onclick=()=>new NativeSyncConflictModal(this.app,this.plugin).open();}
    const activity=root.createDiv({cls:"gib-sync-status-overview-activity"});activity.createEl("strong",{text:"Recent activity"});
    for(const entry of [...live.activities].reverse().slice(0,8)){const row=activity.createDiv({cls:`gib-sync-activity-row is-${entry.level}`});row.createEl("time",{text:new Date(entry.at).toLocaleTimeString()});row.createEl("span",{text:entry.message});}
    if(!live.activities.length)activity.createDiv({cls:"gib-sync-muted",text:"No activity yet."});
  }
  onClose(){this.unsubscribe?.();this.unsubscribe=null;this.contentEl.empty();}
}

export class GibSyncSettingTab extends PluginSettingTab {
  private unsubscribe:(()=>void)|null=null;private liveRoot:HTMLElement|null=null;private liveRenderTimer:number|null=null;
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app,plugin);}
  display(){this.unsubscribe?.();if(this.liveRenderTimer!==null)window.clearTimeout(this.liveRenderTimer);this.liveRenderTimer=null;this.containerEl.empty();this.containerEl.addClass("gib-sync-settings");this.containerEl.createEl("h2",{text:"Gib Sync"});const configured=Boolean(this.plugin.settings.deviceToken);
    this.liveRoot=this.containerEl.createDiv({cls:"gib-sync-status-panel"});this.renderLive();this.unsubscribe=this.plugin.subscribeStatus(()=>this.scheduleLiveRender());
    const actions=new Setting(this.containerEl).setName("Actions").setDesc(configured?"Sync now, or refresh server-side counters and connection details.":"Connect manually with Seafile details, or enter a temporary quick code from an existing device.");
    actions.addButton((button)=>button.setButtonText(configured?"Sync now":"Manual setup").setCta().onClick(()=>configured?void this.plugin.runSync():new SetupModal(this.app,this.plugin).open()));
    if(configured)actions.addButton((button)=>button.setButtonText("Refresh status").onClick(()=>void this.plugin.refreshServerStatus()));
    if(!configured)actions.addButton((button)=>button.setButtonText("Enter quick code").onClick(()=>new QuickCodeEntryModal(this.app,this.plugin).open()));
    if(configured)new Setting(this.containerEl).setName("Add another device").setDesc("Show a five-digit code that changes every 60 seconds and works once.").addButton((button)=>button.setButtonText("Show quick code").onClick(()=>new QuickCodeDisplayModal(this.app,this.plugin).open())).addButton((button)=>button.setButtonText("Change manual connection").onClick(()=>new SetupModal(this.app,this.plugin).open()));
    this.containerEl.createEl("h3",{text:"Status indicators"});
    new Setting(this.containerEl).setName("Desktop status icon").setDesc("Show the current state as an icon in the desktop status bar.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.desktopStatusIcon).onChange(async(value)=>{this.plugin.settings.desktopStatusIcon=value;await this.plugin.saveSettings();this.plugin.configureStatusSurfaces();}));
    new Setting(this.containerEl).setName("Desktop short state").setDesc("Show only the short state word, such as Synced, Syncing, Attention, Paused, or Error.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.desktopStatusText).onChange(async(value)=>{this.plugin.settings.desktopStatusText=value;await this.plugin.saveSettings();this.plugin.configureStatusSurfaces();}));
    new Setting(this.containerEl).setName("Mobile right-sidebar indicator").setDesc("Place a tappable indicator in the bottom-right status area of the mobile right sidebar.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.mobileSidebarIndicator).onChange(async(value)=>{this.plugin.settings.mobileSidebarIndicator=value;await this.plugin.saveSettings();this.plugin.configureStatusSurfaces();}));
    new Setting(this.containerEl).setName("Mobile top-navigation dot").setDesc("Place a compact status dot immediately left of the mobile view-mode control.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.mobileTopIndicator).onChange(async(value)=>{this.plugin.settings.mobileTopIndicator=value;await this.plugin.saveSettings();this.plugin.configureStatusSurfaces();}));
    new Setting(this.containerEl).setName("Animate active synchronization").setDesc("Pulse or rotate the indicator only while work is active.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.animateStatusIndicator).onChange(async(value)=>{this.plugin.settings.animateStatusIndicator=value;await this.plugin.saveSettings();this.plugin.configureStatusSurfaces();}));
    new Setting(this.containerEl).setName("Attention badge count").setDesc("Show the number of quarantined change batches that need review.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.showAttentionBadge).onChange(async(value)=>{this.plugin.settings.showAttentionBadge=value;await this.plugin.saveSettings();this.plugin.configureStatusSurfaces();}));
    const nativeProtection=new Setting(this.containerEl).setName("Obsidian Sync protection").setDesc(this.plugin.isNativeSyncBlocking()?"Obsidian Sync is enabled. Gib Sync is paused to prevent two sync engines from changing this vault.":"Gib Sync checks continuously and refuses to run while Obsidian Sync is enabled.");
    nativeProtection.addButton((button)=>button.setButtonText("Open Core plugins").onClick(()=>this.plugin.openCorePluginSettings())).addButton((button)=>button.setButtonText("Check now").onClick(async()=>{button.setDisabled(true);const blocked=await this.plugin.checkObsidianSyncProtection(true);button.setDisabled(false);new Notice(blocked?"Obsidian Sync is still enabled.":"Protection check passed.");this.display();}));
    new Setting(this.containerEl).setName("Periodic sync").setDesc("Checks for remote changes on a timer.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.autoSync).onChange(async(value)=>{this.plugin.settings.autoSync=value;await this.plugin.saveSettings();this.plugin.configureTimer();}));
    new Setting(this.containerEl).setName("Instant incoming sync").setDesc("The server notifies this device when another device changes the vault. The periodic interval remains a safety check.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.instantReceive).onChange(async(value)=>{this.plugin.settings.instantReceive=value;await this.plugin.saveSettings();this.plugin.configureWatch();}));
    new Setting(this.containerEl).setName("Sync interval").setDesc("Seconds between periodic checks (minimum 15).").addText((text)=>text.setValue(String(this.plugin.settings.syncIntervalSeconds)).onChange(async(value)=>{const parsed=Number(value);if(Number.isFinite(parsed)){this.plugin.settings.syncIntervalSeconds=Math.max(15,Math.round(parsed));await this.plugin.saveSettings();this.plugin.configureTimer();}}));
    new Setting(this.containerEl).setName("Sync when files change").setDesc("Detects editor changes plus created, saved, renamed, and deleted files. After editing stops, waits two seconds for Obsidian to save and then syncs. Excluded paths do not trigger it.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.syncOnFileChange).onChange(async(value)=>{this.plugin.settings.syncOnFileChange=value;this.plugin.configureFileChangeSync();await this.plugin.saveSettings();}));
    new Setting(this.containerEl).setName("Sync Obsidian configuration").setDesc("Includes portable themes, snippets, hotkeys, and other .obsidian settings. JSON settings merge by key; overlapping values use the newer version without creating conflict files. Workspace state remains device-local.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.syncObsidianConfig).onChange(async(value)=>{
      if(!value&&this.plugin.settings.syncObsidianConfig&&!await this.confirmFilterChange(this.plugin.settings.exclusions,value,this.plugin.settings.syncPlugins)){toggle.setValue(true);return;}
      this.plugin.settings.syncObsidianConfig=value;await this.plugin.saveSettings();if(configured)void this.plugin.runSync();
    }));
    new Setting(this.containerEl).setName("Sync installed plugins").setDesc("Synchronizes each community plugin as one version-aware package, repairs incomplete enablement, and leaves generated caches, indexes, embeddings, logs, and temporary data on their device. Plugin data.json settings merge by key and may contain API keys visible in readable Seafile. Reload Obsidian after plugin updates.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.syncPlugins).onChange(async(value)=>{
      if(!value&&this.plugin.settings.syncPlugins&&!await this.confirmFilterChange(this.plugin.settings.exclusions,this.plugin.settings.syncObsidianConfig,value)){toggle.setValue(true);return;}
      this.plugin.settings.syncPlugins=value;await this.plugin.saveSettings();if(configured)void this.plugin.runSync();
    }));
    let proposedExclusions=this.plugin.settings.exclusions.join("\n");
    new Setting(this.containerEl).setName("Excluded path prefixes").setDesc("The device-local ignore list. Ignored remote files remain safe for other devices. Changes are previewed; use one prefix per line.")
      .addTextArea((area)=>area.setValue(proposedExclusions).onChange((value)=>proposedExclusions=value))
      .addButton((button)=>button.setButtonText("Preview and apply").onClick(async()=>{const next=proposedExclusions.split("\n").map((line)=>line.trim()).filter(Boolean);button.setDisabled(true);
        try{if(await this.confirmFilterChange(next,this.plugin.settings.syncObsidianConfig,this.plugin.settings.syncPlugins)){this.plugin.settings.exclusions=next;await this.plugin.saveSettings();new Notice("Ignore list updated; ignored remote files remain safe for other devices");if(configured)void this.plugin.runSync();}}finally{button.setDisabled(false);}}));
    if(configured)new Setting(this.containerEl).setName("Safety center").setDesc("Review held changes, tune mass-change protection, manage devices, or freeze all remote writes.")
      .addButton((button)=>button.setButtonText("Review held changes").onClick(()=>this.plugin.openSafeguards()))
      .addButton((button)=>button.setButtonText("Safeguard settings").onClick(()=>new SafeguardSettingsModal(this.app,this.plugin).open()))
      .addButton((button)=>button.setButtonText("Devices").onClick(()=>new DeviceManagementModal(this.app,this.plugin).open()));
    if(configured)new Setting(this.containerEl).setName("Repair vault health").setDesc("Uses the accepted server snapshot as the safe checkpoint, dismisses stuck held proposals, rebuilds the readable Seafile vault, removes obsolete internal conflict artifacts, and then runs normal reconciliation. Version history is preserved.")
      .addButton((button)=>button.setWarning().setButtonText("Diagnose and repair").onClick(async()=>{if(!await confirmAction(this.app,"Repair vault health","Restore the currently accepted server snapshot as the readable Seafile checkpoint and dismiss pending quarantined proposals? Normal notes and version history are preserved. Use this when sync cannot escape a blocked or dirty state.","Repair health",true))return;button.setDisabled(true);try{await this.plugin.repairVaultHealth();}finally{button.setDisabled(false);}}));
    if(configured)new Setting(this.containerEl).setName("Remote write lock").setDesc("Freezes commits and external Seafile imports while downloads remain available.")
      .addButton((button)=>button.setButtonText(this.plugin.serverStatus?.safeguards.writeLocked?"Resume writes":"Freeze writes").onClick(async()=>{button.setDisabled(true);try{const current=await this.plugin.api.safeguards();await this.plugin.api.setWriteLock(!current.writeLocked);await this.plugin.refreshServerStatus();this.display();new Notice(current.writeLocked?"Remote writes resumed":"Remote writes frozen");}catch(error){new Notice(error instanceof Error?error.message:String(error),10000);button.setDisabled(false);}}));
    if(configured&&this.plugin.settings.vaultIdentity&&this.plugin.currentVaultIdentity()!==this.plugin.settings.vaultIdentity)new Setting(this.containerEl).setName("Vault location changed").setDesc("Sync is paused until you verify that this is the intended local vault.")
      .addButton((button)=>button.setWarning().setButtonText("Trust this vault location").onClick(async()=>{if(!await confirmAction(this.app,"Trust vault location","Trust this vault name and location for Gib Sync? Only continue if you intentionally moved or renamed the vault.","Trust location",true))return;await this.plugin.acceptCurrentVaultIdentity();this.display();}));
    if(configured)new Setting(this.containerEl).setName("Version history").addButton((button)=>button.setButtonText("Open history").onClick(()=>new HistoryModal(this.app,this.plugin).open()));
    if(configured)void this.plugin.refreshServerStatus();
  }
  hide(){this.unsubscribe?.();this.unsubscribe=null;if(this.liveRenderTimer!==null)window.clearTimeout(this.liveRenderTimer);this.liveRenderTimer=null;}
  private included(path:string,exclusions:string[],syncConfig:boolean,syncPlugins:boolean):boolean{
    return shouldSyncChangedPath(path,{...this.plugin.settings,exclusions,syncObsidianConfig:syncConfig,syncPlugins});
  }
  private async confirmFilterChange(exclusions:string[],syncConfig:boolean,syncPlugins:boolean):Promise<boolean>{
    if(!this.plugin.settings.deviceToken)return true;const head=(await this.plugin.api.state()).head;if(!head)return true;
    const affected=head.entries.filter((entry)=>this.included(entry.path,this.plugin.settings.exclusions,this.plugin.settings.syncObsidianConfig,this.plugin.settings.syncPlugins)&&!this.included(entry.path,exclusions,syncConfig,syncPlugins));
    if(!affected.length)return true;const examples=affected.slice(0,10).map((entry)=>`- ${entry.path}`).join("\n");
    return confirmAction(this.app,"Apply sync filter",`This device will stop syncing ${affected.length} file${affected.length===1?"":"s"}:\n\n${examples}${affected.length>10?`\n- …and ${affected.length-10} more`:""}\n\nTheir accepted remote versions remain safe and available to other devices.`,"Apply filter");
  }
  private scheduleLiveRender(){if(this.liveRenderTimer!==null)return;this.liveRenderTimer=window.setTimeout(()=>{this.liveRenderTimer=null;this.renderLive();},250);}
  private renderLive(){if(!this.liveRoot)return;const root=this.liveRoot;const previousLog=root.querySelector<HTMLElement>(".gib-sync-activity-log"),previousScroll=previousLog?.scrollTop??0,wasAtTop=!previousLog||previousScroll<4;root.empty();const live=this.plugin.liveStatus;const server=this.plugin.serverStatus;const storage=server?.storage||this.plugin.settings.storage;
    const header=root.createDiv({cls:`gib-sync-status-head is-${live.phase}`});header.createDiv({cls:"gib-sync-status-dot"});const copy=header.createDiv();copy.createEl("strong",{text:live.message});copy.createEl("div",{cls:"gib-sync-muted",text:live.running?`Running since ${when(live.startedAt)}`:`State: ${live.phase}`});
    const track=root.createDiv({cls:"gib-sync-progress"});track.createDiv({cls:"gib-sync-progress-value",attr:{style:`width:${live.total?Math.min(100,((live.current||0)/live.total)*100):0}%`}});
    const grid=root.createDiv({cls:"gib-sync-status-grid"});const item=(label:string,value:string)=>{const el=grid.createDiv();el.createEl("span",{text:label});el.createEl("strong",{text:value,attr:{title:value}});};
    item("Last success",when(live.lastSuccessAt));item("Last result",live.lastResult||"No completed sync yet");item("Next automatic sync",when(live.nextSyncAt));item("Last error",live.lastError||"None");
    item("Server",this.plugin.settings.serverUrl||"Not connected");item("Vault / device",this.plugin.settings.vaultName?`${this.plugin.settings.vaultName} / ${this.plugin.settings.deviceName}`:"Not configured");
    if(storage){item("Seafile",`${storage.username} @ ${storage.seafileUrl}`);item("Readable recovery vault",`${storage.libraryName}:${storage.readablePath}`);item("Sync metadata",`${storage.libraryName}:${storage.basePath}/.gib-sync`);}
    if(server){item("Remote inventory",`${server.snapshotCount} snapshots · ${server.blobCount} encrypted history blobs · ${bytes(server.blobBytes)}`);item("Readable mirror",server.mirrorCurrent?`Current · ${server.mirrorFileCount} files`:`Needs reconciliation · ${server.mirrorFileCount} files`);item("External Seafile edits",server.externalError?`Error: ${server.externalError}`:server.externalImportAt?`Watching · last imported ${when(server.externalImportAt)}`:server.externalScanAt?`Watching · last checked ${when(server.externalScanAt)}`:"Starting watcher");item("Connected devices",String(server.deviceCount));
      item("Mass-change protection",`${server.safeguards.policy.mode} · ${server.safeguards.pendingQuarantines} held`);item("Remote writes",server.safeguards.writeLocked?`Frozen by ${server.safeguards.writeLockedBy??"a device"}`:server.safeguards.trustedUntil?`Trusted until ${when(server.safeguards.trustedUntil)}`:"Protected");
      if(server.healthAlerts.length){const alerts=root.createDiv({cls:"gib-sync-health-alerts"});alerts.createEl("strong",{text:"Health notifications"});for(const alert of server.healthAlerts.slice(0,8))alerts.createDiv({cls:`gib-sync-health-alert is-${alert.level}`,text:alert.message});}
    }
    const activity=root.createDiv({cls:"gib-sync-activity"});const title=activity.createDiv({cls:"gib-sync-activity-title"});title.createEl("strong",{text:"Live activity"});const buttons=title.createDiv();
    const detailed=buttons.createEl("button",{text:"Copy detailed log",attr:{title:"Includes vault-relative file names, merge decisions, and errors; excludes credentials and server addresses"}});detailed.onclick=async()=>{const copied=await copyText(JSON.stringify(detailedDiagnostics(live,server,{configured:Boolean(this.plugin.settings.deviceToken),storageConfigured:Boolean(storage)}),null,2));new Notice(copied?"Detailed Gib Sync log copied; review vault-relative file names before sharing":"Clipboard access is unavailable on this device.",copied?6000:8000);};
    const safe=buttons.createEl("button",{text:"Copy safe log",attr:{title:"Removes activity text and file names for public sharing"}});safe.onclick=async()=>{const copied=await copyText(JSON.stringify(privacySafeDiagnostics(live,server,{configured:Boolean(this.plugin.settings.deviceToken),storageConfigured:Boolean(storage)}),null,2));new Notice(copied?"Privacy-safe Gib Sync log copied":"Clipboard access is unavailable on this device.",copied?4000:8000);};const clear=buttons.createEl("button",{text:"Clear"});clear.onclick=()=>this.plugin.clearActivity();
    const log=activity.createDiv({cls:"gib-sync-activity-log"});for(const entry of [...live.activities].reverse().slice(0,30)){const row=log.createDiv({cls:`gib-sync-activity-row is-${entry.level}`});row.createEl("time",{text:new Date(entry.at).toLocaleTimeString()});row.createEl("span",{text:entry.message});}if(!live.activities.length)log.createEl("div",{cls:"gib-sync-muted",text:"Activity will appear here as Gib Sync works."});log.scrollTop=wasAtTop?0:previousScroll;
  }
}

export async function claimQuickCodeSetup(plugin:GibSyncPlugin,server:string,value:string,deviceName:string):Promise<SetupResponse>{
  const code=normalizeQuickCode(value);const response=await plugin.api.claimQuickCode(server,code,deviceName);
  return openPairingEnvelope<SetupResponse>(response.envelope,code,response.pairingId);
}
