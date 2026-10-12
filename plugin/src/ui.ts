import { App, Modal, Notice, Platform, PluginSettingTab, Setting, setIcon } from "obsidian";
import type { ChangeAssessment, DeviceInfo, ExistingVaultLocation, HistoryItem, QuarantineItem, SafeguardPolicy, SeafileLibrary, SelectiveRestoreChange, SetupResponse } from "@gib-sync/protocol";
import type GibSyncPlugin from "./main";
import { normalizeQuickCode,openPairingEnvelope } from "./crypto";
import { isSafeVaultPath,shouldSyncChangedPath } from "./settings";
import { detailedDiagnostics,privacySafeDiagnostics } from "./diagnostics";
import { buildQuickStatusModel,buildSyncFacts, type QuickStatusAction } from "./status-overview";
import type {PendingDeviceClaim,TrustedDeviceRequest} from "./api";
import {conflictLineComparison,type ConflictChoice,type ConflictInboxItem} from "./conflict-inbox";
import {DeviceLifecycleProbe,DeviceSyncActivityProbe,runDeviceProbe,type DeviceProbeReport} from "./device-diagnostics";
import {normalizeSetupServer,parseSetupInvite,parseSetupInviteUrl,renderSetupQr,setupInviteUrl,setupQrInviteUrl,type SetupInvite} from "./setup-qr";

export type QuickCodeInvite=SetupInvite;
const alreadyConnected=(plugin:GibSyncPlugin)=>Boolean(plugin.settings.deviceToken||plugin.settings.vaultId);

function defaultDeviceName(): string {
  if (Platform.isIosApp) return "iPhone / iPad";
  if (Platform.isAndroidApp) return "Android";
  return navigator.platform || "Desktop";
}

function when(value:string|null|undefined):string { return value?new Date(value).toLocaleString():"Never"; }
function bytes(value:number):string { if(value<1024)return `${value} B`;if(value<1024**2)return `${(value/1024).toFixed(1)} KB`;if(value<1024**3)return `${(value/1024**2).toFixed(1)} MB`;return `${(value/1024**3).toFixed(2)} GB`; }
function assessmentText(value:ChangeAssessment):string{return `${value.created} created · ${value.modified} modified · ${value.deleted} deleted · ${value.moved} moved · ${value.affectedPercent}% affected`;}
function mobileContent(element:HTMLElement):void{element.addClass("gib-sync-modal-content");}
function onboardingChoice(element:HTMLElement,selected:(mode:"preserve-local"|"server-first")=>void,initial:"preserve-local"|"server-first"="preserve-local"){new Setting(element).setName("First download").setDesc("Compare and preserve is safest if this device already has notes. Use the server copy when this device should adopt the existing vault; replaced or device-only files remain in local recovery.").addDropdown(dropdown=>dropdown.addOption("preserve-local","Compare and preserve local files").addOption("server-first","Use server copy; keep local backups").setValue(initial).onChange(value=>selected(value as "preserve-local"|"server-first")));}

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
    let username=this.plugin.settings.storage?.username||"";let password="";let vaultName=this.app.vault.getName();let deviceName=defaultDeviceName();let onboardingMode:"preserve-local"|"server-first"="preserve-local";
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
      try { await this.plugin.verifyServerBeforeSetup(server);const result=await this.plugin.api.discover(server,seafileUrl,username,password);libraries=result.libraries;existingVaults=result.existingVaults;select.empty();for(const library of libraries)select.createEl("option",{text:library.name,value:library.id});select.disabled=false;
        const preferred=this.plugin.settings.storage?.libraryId;libraryId=libraries.find((item)=>item.id===preferred)?.id||libraries[0]?.id||"";select.value=libraryId;libraryName=libraries.find((item)=>item.id===libraryId)?.name||"";button.setButtonText("Reload");
        existingSelect.empty();existingSelect.createEl("option",{text:existingVaults.length?"Create or use the location below":"No existing vaults found",value:"-1"});for(const [index,vault] of existingVaults.entries())existingSelect.createEl("option",{text:`${vault.vaultName} — ${vault.libraryName}:${vault.basePath}`,value:String(index)});existingSelect.disabled=!existingVaults.length;if(existingVaults.length===1){existingSelect.value="0";useExisting(0);}
        if(!libraries.length)new Notice("This Seafile account has no accessible libraries.");
      } catch(error){new Notice(`Unable to load libraries: ${error instanceof Error?error.message:String(error)}`,10000);button.setButtonText("Try again");}
      finally{button.setDisabled(false);}
    }));
    new Setting(this.contentEl).setName("Folder in library").setDesc("Your readable 1:1 Obsidian vault is stored here. Gib Sync keeps synchronization metadata in a hidden .gib-sync subfolder.").addText((text)=>{pathInput=text.inputEl;text.setValue(basePath).onChange((value)=>{basePath=value.trim();existingVaultId=undefined;existingSelect.value="-1";});});
    new Setting(this.contentEl).setName("Vault name").addText((text)=>{vaultInput=text.inputEl;text.setValue(vaultName).onChange((value)=>vaultName=value.trim());});
    new Setting(this.contentEl).setName("Device name").addText((text)=>text.setValue(deviceName).onChange((value)=>deviceName=value.trim()));
    onboardingChoice(this.contentEl,mode=>onboardingMode=mode);
    new Setting(this.contentEl).addButton((button)=>button.setCta().setButtonText("Connect").onClick(async()=>{
      if(!libraryId){new Notice("Load and select a Seafile library first.");return;}button.setDisabled(true).setButtonText("Connecting…");
      try { await this.plugin.verifyServerBeforeSetup(server);const setup=await this.plugin.api.setup(server,{vaultName,deviceName,seafileUrl,seafileUsername:username,seafilePassword:password,libraryId,libraryName,basePath,existingVaultId});await this.plugin.acceptSetup(setup,deviceName,onboardingMode);this.close();new Notice(this.plugin.settings.paused?"Gib Sync connected. Resume this device when ready.":"Gib Sync connected. Starting first sync…");if(!this.plugin.settings.paused)void this.plugin.runSync(); }
      catch(error){new Notice(`Setup failed: ${error instanceof Error?error.message:String(error)}`,10000);button.setDisabled(false).setButtonText("Connect");}
    }));
  }
  onClose(){this.contentEl.empty();}
}

export class QuickCodeDisplayModal extends Modal {
  private timer:number|null=null;private expiresAt=0;private refreshing=false;private closed=false;private generation=0;private retryAt=0;private refreshError="";private codeEl!:HTMLElement;private statusEl!:HTMLElement;
  private expiryTimer:number|null=null;private qrExpiryTimer:number|null=null;private qrEl!:HTMLElement;private qrMessage!:HTMLElement;private copyLink!:HTMLButtonElement;private invite:{url:string;expiresAt:number;generation:number}|null=null;
  private approvals!:HTMLElement;private approvalsLoading=false;private nextApprovalCheck=0;private approvalRows=new Map<string,HTMLElement>();
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  async onOpen(){mobileContent(this.contentEl);this.closed=false;const generation=++this.generation;this.refreshing=false;this.expiresAt=0;this.retryAt=0;this.refreshError="";this.setTitle("Connect another device");this.contentEl.createEl("p",{text:"On your phone, scan the QR with the Camera app, then choose “Open Gib Sync” and review the vault in Obsidian. Camera access inside Obsidian is not needed."});this.qrEl=this.contentEl.createDiv({cls:"gib-sync-setup-qr",attr:{"aria-label":"Temporary setup QR"}});this.qrMessage=this.contentEl.createEl("p",{cls:"gib-sync-setup-qr-caption",text:"Getting a fresh invitation…"});this.copyLink=this.contentEl.createEl("button",{text:"Copy setup link",attr:{type:"button"}});this.copyLink.disabled=true;this.copyLink.onclick=()=>{const invite=this.invite;if(!invite||Date.now()>=invite.expiresAt){this.retireInvite();return;}void copyText(invite.url).then(copied=>{if(!this.closed&&this.invite===invite)new Notice(copied?"Temporary setup link copied. It contains no vault keys or account credentials.":"Clipboard unavailable.");});};this.contentEl.createEl("p",{text:"Or enter this five-digit code manually in Gib Sync on the other device."});this.codeEl=this.contentEl.createDiv({cls:"gib-sync-quick-code",text:"-----"});this.statusEl=this.contentEl.createEl("p",{cls:"gib-sync-muted",attr:{role:"status","aria-live":"polite"}});
    const retry=this.contentEl.createEl("button",{text:"New code",attr:{type:"button"}});retry.onclick=()=>void this.refresh(true);this.approvals=this.contentEl.createDiv({cls:"gib-sync-device-requests"});
    await this.refresh();if(!this.closed&&generation===this.generation)this.timer=window.setInterval(()=>this.tick(),1000);}
  private retireQr(){if(this.qrExpiryTimer!==null)window.clearTimeout(this.qrExpiryTimer);this.qrExpiryTimer=null;this.invite=null;if(this.qrEl)this.qrEl.empty();if(this.copyLink)this.copyLink.disabled=true;}
  private retireCode(){if(this.expiryTimer!==null)window.clearTimeout(this.expiryTimer);this.expiryTimer=null;this.expiresAt=0;if(this.codeEl){this.codeEl.setText("-----");this.codeEl.setAttr("aria-label","No valid quick code");}}
  private retireInvite(){this.retireQr();this.retireCode();}
  private async refresh(forceQr=false){if(this.refreshing||this.closed)return;const generation=this.generation;this.refreshing=true;this.retireCode();if(forceQr||this.invite&&Date.now()>=this.invite.expiresAt)this.retireQr();if(this.invite)try{if(parseSetupInviteUrl(this.invite.url).server!==normalizeSetupServer(this.plugin.settings.serverUrl))this.retireQr();}catch{this.retireQr();}if(!this.invite)this.qrMessage.setText("Getting a fresh invitation…");this.statusEl.setText("Getting a fresh code…");try{const pairing=await this.plugin.api.createPairing();if(this.closed||generation!==this.generation)return;if(pairing.requiresConfirmation!==true)throw new Error("Update the server before connecting devices securely. Existing sync is unaffected.");const code=normalizeQuickCode(pairing.code),expiresAt=Date.parse(pairing.expiresAt);if(!Number.isFinite(expiresAt)||expiresAt<=Date.now())throw new Error("The server returned an expired code. Try again.");
      let url:string|null=null,qrText="QR setup needs a server update. The five-digit code still works.";const staging=this.qrEl.createDiv({cls:"gib-sync-setup-qr-image"});staging.hidden=true;
      let qrExpires=expiresAt;const advertised=pairing.qrSetupUrl??pairing.setupUrl;
      if(advertised)try{const invite=parseSetupInviteUrl(advertised);qrExpires=invite.expiresAt;if(pairing.qrSetupUrl?(!invite.token||qrExpires!==Date.parse(pairing.qrExpiresAt??"")):(invite.code!==code||qrExpires!==expiresAt))throw new Error("QR invitation does not match its advertised expiry");if(normalizeSetupServer(invite.server)!==normalizeSetupServer(this.plugin.settings.serverUrl)){this.retireQr();qrText="The advertised QR address does not match this connection. Use the manual code; no redirect was followed.";}else if(!this.invite){url=invite.token?setupQrInviteUrl(invite.server,invite.token,qrExpires):setupInviteUrl(invite.server,code,qrExpires);await renderSetupQr(staging,url);qrText=`Connects to ${invite.server} · QR valid for ${Math.ceil((qrExpires-Date.now())/60_000)} minutes. The typed code below changes separately.`;}}catch{url=null;staging.empty();qrText="QR invitation unavailable. Use the five-digit code, or request a new code.";}
      if(this.closed||generation!==this.generation)return;if(Date.now()>=expiresAt||url&&Date.now()>=qrExpires)throw new Error("The setup invitation expired before it was ready. Try again.");if(url){this.qrEl.empty();staging.hidden=false;this.qrEl.appendChild(staging);this.invite={url,expiresAt:qrExpires,generation};this.copyLink.disabled=false;this.qrExpiryTimer=window.setTimeout(()=>{if(!this.closed&&generation===this.generation){this.retireQr();this.qrMessage.setText("QR expired; getting a fresh invitation…");void this.refresh();}},Math.max(1,qrExpires-Date.now()));}else staging.remove();if(!this.invite||url)this.qrMessage.setText(qrText);this.codeEl.setText(code);this.codeEl.setAttr("aria-label",`Quick code ${code}`);this.expiresAt=expiresAt;this.refreshError="";this.retryAt=0;this.expiryTimer=window.setTimeout(()=>{if(!this.closed&&generation===this.generation){this.retireCode();if(this.invite&&Date.now()>=this.invite.expiresAt)this.retireQr();this.tick();}},Math.max(1,expiresAt-Date.now()));}
    catch(error){if(!this.closed&&generation===this.generation){this.retireCode();if(!this.invite||Date.now()>=this.invite.expiresAt)this.retireQr();if(!this.invite)this.qrMessage.setText("No active setup invitation.");this.refreshError=`Code unavailable: ${error instanceof Error?error.message:String(error)}. Retrying automatically.`;this.retryAt=Date.now()+15_000;this.statusEl.setText(this.refreshError);}}
    finally{if(generation===this.generation){this.refreshing=false;this.tick();}}}
  private tick(){if(this.closed||this.refreshing)return;if(this.invite&&Date.now()>=this.invite.expiresAt){this.retireQr();this.qrMessage.setText("QR expired; getting a fresh invitation…");void this.refresh();return;}if(Date.now()>=this.nextApprovalCheck)void this.loadApprovals();const seconds=Math.max(0,Math.ceil((this.expiresAt-Date.now())/1000));if(!seconds){this.codeEl.setText("-----");this.codeEl.setAttr("aria-label","No valid quick code");if(this.refreshError)this.statusEl.setText(this.refreshError);else this.statusEl.setText("Code expired; getting a new one…");if(Date.now()>=this.retryAt)void this.refresh();return;}if(this.refreshError)this.statusEl.setText(this.refreshError);else this.statusEl.setText(`Typed code changes in ${seconds} second${seconds===1?"":"s"} · approve the matching device below.`);}
  private async loadApprovals(){if(this.approvalsLoading||this.closed||typeof this.plugin.api.pendingDeviceClaims!=="function")return;const generation=this.generation;this.approvalsLoading=true;this.nextApprovalCheck=Date.now()+2000;try{const requests=await this.plugin.api.pendingDeviceClaims();if(this.closed||generation!==this.generation)return;const active=new Set(requests.map(request=>request.id));for(const [id,row]of this.approvalRows)if(!active.has(id)){row.remove();this.approvalRows.delete(id);}for(const request of requests)if(!this.approvalRows.has(request.id)){const row=this.approvals.createDiv({cls:"gib-sync-device-request"});this.approvalRows.set(request.id,row);renderDeviceRequest(row,request,this.plugin,()=>this.closed);}}catch{/* Old servers have no confirmation endpoint. Never spam a rolling code modal. */}finally{this.approvalsLoading=false;}}
  onClose(){this.closed=true;this.generation++;this.retireInvite();if(this.timer!==null)window.clearInterval(this.timer);this.timer=null;this.contentEl.empty();}
}

function renderDeviceRequest(row:HTMLElement,request:TrustedDeviceRequest,plugin:GibSyncPlugin,closed:()=>boolean){
  row.createEl("strong",{text:request.deviceName});row.createEl("p",{text:`Confirm ${request.confirmationCode} matches the new device.`});const state=row.createEl("p",{cls:"gib-sync-muted",attr:{role:"status"}}),actions=row.createDiv({cls:"gib-sync-row-actions"});
  const decide=async(approved:boolean)=>{for(const control of Array.from(actions.querySelectorAll("button")))control.disabled=true;try{await plugin.api.decideDeviceClaim(request.id,approved);if(!closed()){state.setText(approved?"Approved. The new device can now connect.":"Request declined.");actions.hidden=true;}}catch(error){if(!closed()){state.setText(error instanceof Error?error.message:String(error));for(const control of Array.from(actions.querySelectorAll("button")))control.disabled=false;}}};
  actions.createEl("button",{text:"Decline",attr:{type:"button"}}).onclick=()=>void decide(false);actions.createEl("button",{text:"Approve device",cls:"mod-cta",attr:{type:"button"}}).onclick=()=>void decide(true);
}

export class DeviceRequestsModal extends Modal{
  private closed=false;private timer:number|null=null;private loading=false;private list!:HTMLElement;private status!:HTMLElement;private rows=new Map<string,HTMLElement>();
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  onOpen(){mobileContent(this.contentEl);this.setTitle("Approve a new device");this.status=this.contentEl.createEl("p",{text:"Checking device requests…",attr:{role:"status"}});this.list=this.contentEl.createDiv();void this.refresh();this.timer=window.setInterval(()=>void this.refresh(),2000);}
  private async refresh(){if(this.closed||this.loading)return;this.loading=true;try{const requests=await this.plugin.api.pendingDeviceClaims();if(this.closed)return;this.status.setText(requests.length?"Only approve a device whose confirmation number you can verify.":"No device is waiting for approval.");const ids=new Set(requests.map(item=>item.id));for(const [id,row]of this.rows)if(!ids.has(id)){row.remove();this.rows.delete(id);}for(const item of requests)if(!this.rows.has(item.id)){const row=this.list.createDiv({cls:"gib-sync-device-request"});this.rows.set(item.id,row);renderDeviceRequest(row,item,this.plugin,()=>this.closed);}}catch(error){if(!this.closed)this.status.setText(error instanceof Error?error.message:String(error));}finally{this.loading=false;}}
  onClose(){this.closed=true;if(this.timer!==null)window.clearInterval(this.timer);this.contentEl.empty();}
}

class DeviceApprovalWaitModal extends Modal{
  private closed=false;private settled=false;private timer:number|null=null;private status!:HTMLElement;
  private readonly abort=()=>this.close();
  constructor(app:App,private readonly plugin:GibSyncPlugin,private readonly server:string,private readonly claim:PendingDeviceClaim,private readonly done:(result:{pairingId:string;envelope:string}|Error)=>void,private readonly signal?:AbortSignal){super(app);}
  onOpen(){if(this.signal?.aborted){this.close();return;}this.signal?.addEventListener("abort",this.abort,{once:true});mobileContent(this.contentEl);this.setTitle("Approve on your connected device");this.contentEl.createEl("p",{text:`Compare this number with the request on the connected device:`});this.contentEl.createDiv({cls:"gib-sync-quick-code",text:this.claim.confirmationCode});this.status=this.contentEl.createEl("p",{text:"Waiting for approval…",attr:{role:"status","aria-live":"polite"}});this.contentEl.createEl("button",{text:"Cancel",attr:{type:"button"}}).onclick=()=>this.close();void this.poll();}
  private async poll(){if(this.closed)return;if(Date.parse(this.claim.expiresAt)<=Date.now()){this.finish(new Error("Device approval expired. Request a new quick code."));return;}try{const response=await this.plugin.api.pollDeviceClaim(this.server,this.claim.ticket);if(this.closed){if(response.status==="approved")void this.plugin.api.cancelDeviceClaim(this.server,this.claim.ticket).catch(()=>{});return;}if(response.status==="approved"){this.finish(response);return;}}catch(error){if(this.closed)return;if((error as {status?:number}).status===410){this.finish(error as Error);return;}this.status.setText("Connection interrupted. Still waiting safely for approval…");}if(!this.closed)this.timer=window.setTimeout(()=>void this.poll(),1500);}
  private finish(result:{pairingId:string;envelope:string}|Error){if(this.settled)return;this.settled=true;this.done(result);this.close();}
  onClose(){this.closed=true;this.signal?.removeEventListener("abort",this.abort);if(this.timer!==null)window.clearTimeout(this.timer);if(!this.settled){this.settled=true;void this.plugin.api.cancelDeviceClaim(this.server,this.claim.ticket).catch(()=>{});this.done(new Error("Device connection cancelled."));}this.contentEl.empty();}
}

export class QuickCodeEntryModal extends Modal {
  private closed=false;private generation=0;private controller=new AbortController();
  constructor(app:App,private readonly plugin:GibSyncPlugin,private readonly prefill?:QuickCodeInvite,private readonly closedCallback?:()=>void){super(app);}
  onOpen(){this.closed=false;const generation=++this.generation;if(this.controller.signal.aborted)this.controller=new AbortController();if(alreadyConnected(this.plugin)){new Notice("This vault is already connected. Open an unconnected vault to use a setup invitation.");this.close();return;}let invite:QuickCodeInvite|undefined;try{if(this.prefill)invite=parseSetupInvite({action:"gib-sync-setup",server:this.prefill.server,...(this.prefill.token?{token:this.prefill.token}:{code:this.prefill.code}),expires:String(this.prefill.expiresAt)});}catch{new Notice("This setup invitation is invalid or expired. Scan a fresh QR or enter a new code manually.");this.close();return;}mobileContent(this.contentEl);this.setTitle(invite?"Review Gib Sync setup":"Enter quick code");let server=invite?.server||this.plugin.settings.serverUrl||"";let code=invite?.code||"";let deviceName=defaultDeviceName();let onboardingMode:"preserve-local"|"server-first"=invite?"server-first":"preserve-local";
    if(invite){const review=this.contentEl.createDiv({cls:"gib-sync-setup-review"});review.createEl("strong",{text:`Current vault: ${this.app.vault.getName()}`});review.createEl("p",{text:`Server: ${invite.server}`});review.createEl("p",{text:"Confirm this is the vault and server you intended. Nothing connects until you choose Connect. The connected device must still approve the matching verification number."});}
    this.contentEl.createEl("p",{text:invite?"Setup was filled from the QR. Review the server and current vault, then choose Connect.":"On an already connected device, choose “Show quick code,” then type that temporary code here."});
    new Setting(this.contentEl).setName("Gib Sync server").addText((text)=>{text.setPlaceholder("https://sync.example.com").setValue(server).onChange((value)=>server=value.trim());if(invite)text.inputEl.readOnly=true;});
    if(!invite?.token)new Setting(this.contentEl).setName("Quick code").setDesc("Five numbers. The code changes every 60 seconds.").addText((text)=>{text.setPlaceholder("12345").setValue(code).onChange((value)=>code=value);text.inputEl.inputMode="numeric";text.inputEl.pattern="[0-9]*";text.inputEl.autocomplete="one-time-code";text.inputEl.maxLength=5;if(invite)text.inputEl.readOnly=true;});
    else this.contentEl.createEl("p",{text:`Scanned QR invitation · ${Math.max(1,Math.ceil((invite.expiresAt-Date.now())/60_000))} minutes remaining. No code needs typing.`});
    new Setting(this.contentEl).setName("Device name").addText((text)=>text.setValue(deviceName).onChange((value)=>deviceName=value.trim()));
    onboardingChoice(this.contentEl,mode=>onboardingMode=mode,onboardingMode);
    new Setting(this.contentEl).addButton((button)=>button.setCta().setButtonText("Connect").onClick(async()=>{button.setDisabled(true).setButtonText("Connecting…");
      try{if(this.closed||generation!==this.generation)return;if(alreadyConnected(this.plugin))throw new Error("This vault is already connected; its connection was not changed.");if(invite&&Date.now()>=invite.expiresAt)throw new Error("This QR invitation expired. Scan a fresh QR or enter a new code manually.");if(invite?.token)await this.plugin.claimQuickCode(server,code,deviceName,onboardingMode,this.controller.signal,invite.token);else await this.plugin.claimQuickCode(server,code,deviceName,onboardingMode,this.controller.signal);if(this.closed||generation!==this.generation||this.controller.signal.aborted)return;this.close();new Notice(this.plugin.settings.paused?"Device connected. Resume this device when ready.":"Device connected. Starting first sync…");if(!this.plugin.settings.paused)void this.plugin.runSync();}
      catch(error){if(this.closed||generation!==this.generation)return;new Notice(`Quick-code setup failed: ${error instanceof Error?error.message:String(error)}`,10000);button.setDisabled(false).setButtonText("Connect");}
    }));
  }
  onClose(){this.closed=true;this.generation++;this.controller.abort();this.contentEl.empty();this.closedCallback?.();}
}

class SelectiveRestoreModal extends Modal{
  constructor(app:App,private readonly plugin:GibSyncPlugin,private readonly snapshot:HistoryItem,private readonly restored:()=>void){super(app);}
  async onOpen(){mobileContent(this.contentEl);this.setTitle("Restore selected files");this.contentEl.empty();const status=this.contentEl.createEl("p",{text:"Loading changed files…"});
    try{const plan=await this.plugin.api.selectiveRestorePlan(this.snapshot.id);status.remove();if(!plan.changes.length){this.contentEl.createEl("p",{text:"This snapshot already matches the current vault."});return;}
      const selected=new Set<string>(),controls=this.contentEl.createDiv({cls:"gib-sync-row-actions"}),search=this.contentEl.createEl("input",{cls:"gib-sync-selective-restore-search"}),list=this.contentEl.createDiv({cls:"gib-sync-selective-restore-list"});search.type="search";search.placeholder="Filter changed paths";
      const rows=new Map<string,HTMLInputElement>(),render=()=>{const query=search.value.trim().toLowerCase(),matches=plan.changes.filter((change)=>!query||change.path.toLowerCase().includes(query)||(change.previousPath??"").toLowerCase().includes(query));list.empty();rows.clear();for(const change of matches.slice(0,400))this.changeRow(list,change,selected,rows);if(matches.length>400)list.createDiv({cls:"gib-sync-muted",text:`Showing 400 of ${matches.length} matches. Refine the filter to see a specific path.`});};
      const setAll=(value:boolean)=>{selected.clear();if(value)for(const change of plan.changes.slice(0,5000))selected.add(change.id);render();};
      controls.createEl("button",{text:plan.changes.length>5000?"Select first 5,000":"Select all"}).onclick=()=>setAll(true);controls.createEl("button",{text:"Clear"}).onclick=()=>setAll(false);search.oninput=render;render();
      const review=controls.createEl("button",{text:"Review restore",cls:"mod-cta"});review.onclick=async()=>{if(!selected.size){new Notice("Select at least one file change to restore.");return;}review.disabled=true;try{const ids=[...selected],preview=await this.plugin.api.selectiveRestorePreview(this.snapshot.id,ids),reasons=preview.assessment.reasons.length?`\n\nWarnings:\n- ${preview.assessment.reasons.join("\n- ")}`:"";
        if(!await confirmAction(this.app,"Restore selected files",`${assessmentText(preview.assessment)}${reasons}\n\nOnly the ${preview.selectedChanges} selected historical change${preview.selectedChanges===1?"":"s"} will be applied. Current history remains available.`,"Restore selected",preview.assessment.deleted>0)){review.disabled=false;return;}
        await this.plugin.api.selectiveRestore(this.snapshot.id,ids,preview.confirmToken);this.close();this.restored();await this.plugin.runSync();new Notice(`${ids.length} selected historical change${ids.length===1?"":"s"} restored`);
      }catch(error){new Notice(`Selective restore failed: ${error instanceof Error?error.message:String(error)}`,10000);review.disabled=false;}};
    }catch(error){status.setText(error instanceof Error?error.message:String(error));}}
  private changeRow(container:HTMLElement,change:SelectiveRestoreChange,selected:Set<string>,rows:Map<string,HTMLInputElement>){const label=container.createEl("label",{cls:"gib-sync-selective-restore-row"}),input=label.createEl("input");input.type="checkbox";input.checked=selected.has(change.id);rows.set(change.id,input);input.onchange=()=>{if(input.checked)selected.add(change.id);else selected.delete(change.id);};
    label.createSpan({text:`${change.kind}: ${change.previousPath?`${change.previousPath} → `:""}${change.path}`});}
  onClose(){this.contentEl.empty();}
}

export class HistoryModal extends Modal {
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  async onOpen(){mobileContent(this.contentEl);this.setTitle("Gib Sync history");this.contentEl.empty();const container=this.contentEl.createDiv({cls:"gib-sync-history"});container.setText("Loading…");try{const history=await this.plugin.api.history();container.empty();for(const item of history)this.row(container,item);if(!history.length)container.setText("No snapshots yet.");}catch(error){container.setText(error instanceof Error?error.message:String(error));}}
  private row(container:HTMLElement,item:HistoryItem){const row=container.createDiv({cls:"gib-sync-history-row"});const details=row.createDiv();details.createEl("strong",{text:`${item.bookmarked?"★ ":""}${item.message}`});details.createEl("div",{cls:"gib-sync-muted",text:`${new Date(item.createdAt).toLocaleString()} · ${item.deviceName} · ${item.fileCount} files`});
    const actions=row.createDiv({cls:"gib-sync-row-actions"}),bookmark=actions.createEl("button",{text:item.bookmarked?"Unbookmark":"Bookmark"});
    bookmark.onclick=async()=>{bookmark.disabled=true;try{if(item.bookmarked)await this.plugin.api.unbookmark(item.id);else{const label=await promptText(this.app,"Bookmark snapshot","Bookmark label","Known good");if(label===null){bookmark.disabled=false;return;}await this.plugin.api.bookmark(item.id,label||"Known good");}this.onOpen();}catch(error){new Notice(error instanceof Error?error.message:String(error));bookmark.disabled=false;}};
    const selected=actions.createEl("button",{text:"Restore files"});selected.onclick=()=>new SelectiveRestoreModal(this.app,this.plugin,item,()=>this.close()).open();
    const button=actions.createEl("button",{text:"Restore all"});button.onclick=async()=>{button.disabled=true;try{const preview=await this.plugin.api.restorePreview(item.id);
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
    const deleted=item.changes.filter((change)=>change.kind==="deleted");
    if(item.source==="seafile"&&deleted.length){const folders=[...new Set(deleted.map((change)=>change.path.split("/")[0]||"Vault root"))],warning=card.createDiv({cls:"gib-sync-attention-card is-warning"});warning.createEl("strong",{text:"External deletion requires one-time approval"});warning.createEl("p",{text:`Seafile reports ${deleted.length} missing file${deleted.length===1?"":"s"} (${bytes(item.assessment.bytesRemoved)}) across ${folders.slice(0,4).join(", ")}${folders.length>4?` and ${folders.length-4} more`:""}. Maintenance and prior trust never approve this batch automatically.`});}
    const disclosure=card.createEl("details");disclosure.createEl("summary",{text:`Review ${item.changes.length} changed paths`});const list=disclosure.createEl("ul",{cls:"gib-sync-change-list"});
    for(const change of item.changes)list.createEl("li",{text:`${change.kind}: ${change.previousPath?`${change.previousPath} → `:""}${change.path}`});
    const actions=card.createDiv({cls:"gib-sync-row-actions"});
    const trustEligible=item.source==="device"&&!item.assessment.deleted&&!item.assessment.reasons.some((reason)=>/out-of-date device|completely empty|protected path|grew unexpectedly|mostly emptied|high-entropy/i.test(reason));
    const approve=actions.createEl("button",{text:"Approve once"}),trustMinutes=15,trust=trustEligible?actions.createEl("button",{text:"Approve + trust 15 min"}):null,reject=actions.createEl("button",{text:"Reject and restore"});
    const disable=()=>{approve.disabled=true;if(trust)trust.disabled=true;reject.disabled=true;};
    approve.onclick=async()=>{disable();try{await this.plugin.api.approveQuarantine(item.id);this.close();await this.plugin.runSync();new Notice("Quarantined changes approved");}catch(error){new Notice(error instanceof Error?error.message:String(error),10000);void this.onOpen();}};
    if(trust)trust.onclick=async()=>{disable();try{await this.plugin.api.approveQuarantine(item.id,trustMinutes);this.close();await this.plugin.runSync();new Notice(`Changes approved; this device is in maintenance for ${trustMinutes} minutes`);}catch(error){new Notice(error instanceof Error?error.message:String(error),10000);void this.onOpen();}};
    reject.onclick=async()=>{if(!await confirmAction(this.app,"Reject quarantined changes","Reject this entire change batch and restore this device to the last accepted snapshot?","Reject and restore",true))return;disable();try{const restored=await this.plugin.rejectAndRestore(item.id);this.close();new Notice(`Changes rejected · restored ${restored.downloaded}, removed ${restored.deleted} local files, and cleaned ${restored.prunedFolders} empty folders`,10000);void this.plugin.refreshServerStatus();}catch(error){new Notice(error instanceof Error?error.message:String(error),10000);void this.onOpen();}};
  }
  onClose(){this.contentEl.empty();this.closed();}
}

export class DeviceManagementModal extends Modal{
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  async onOpen(){mobileContent(this.contentEl);this.setTitle("Gib Sync devices");this.contentEl.setText("Loading…");await this.plugin.refreshServerStatus();this.contentEl.empty();const devices=this.plugin.serverStatus?.devices??[];
    for(const device of devices)this.row(device);if(!devices.length)this.contentEl.setText("No device information available.");}
  private row(device:DeviceInfo){const row=this.contentEl.createDiv({cls:"gib-sync-history-row"}),details=row.createDiv();details.createEl("strong",{text:`${device.name}${device.current?" (this device)":""}`});
    const version=device.clientVersion?`v${device.clientVersion}`:"version unknown",compatibility=device.compatibility==="incompatible"?"update required":device.compatibility==="update-available"?"update available":device.compatibility==="compatible"?"compatible":"compatibility unknown";
    const head=this.plugin.serverStatus?.head?.id,confirmed=Boolean(head&&device.acknowledgedSnapshotId===head);
    details.createEl("div",{text:confirmed?"Latest accepted version confirmed":device.acknowledgedSnapshotId?"Waiting for the latest version":"Latest version not confirmed yet"});
    details.createEl("div",{cls:"gib-sync-muted",text:`Last seen ${when(device.lastSeenAt)} · ${version} · ${compatibility} · ${device.ready?"Connected":"Restricted until first download"}${device.clockSkewMs?` · clock skew ${Math.round(device.clockSkewMs/60000)} min`:""}${device.revokedAt?" · revoked":""}`});
    if(!device.revokedAt){const button=row.createEl("button",{text:"Revoke"});button.onclick=async()=>{if(!await confirmAction(this.app,"Revoke device",`Revoke ${device.name}? It will immediately lose access to this vault.`,"Revoke",true))return;button.disabled=true;try{await this.plugin.api.revokeDevice(device.id);new Notice(`${device.name} revoked`);if(device.current)this.close();else void this.onOpen();}catch(error){new Notice(error instanceof Error?error.message:String(error),10000);button.disabled=false;}};}}
  onClose(){this.contentEl.empty();}
}

/** Recovery browsing is read-only; opening it never modifies accepted or local files. */
export class LocalRecoveryModal extends Modal{
  private closed=false;
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  async onOpen(){this.closed=false;mobileContent(this.contentEl);this.setTitle("Recovery copies on this device");this.contentEl.createEl("p",{text:"Originals replaced or deleted during sync are kept here. These copies stay on this device, outside normal synchronization. Preview a copy before restoring anything; accepted server versions are available separately in Version history."});const list=this.contentEl.createDiv({cls:"gib-sync-history"}),status=list.createEl("p",{text:"Looking for recovery copies…"});
    try{const adapter=this.app.vault.adapter,root=".gib-sync/local-recovery",configDir=this.app.vault.configDir??".obsidian",physical=(path:string)=>path.startsWith(".obsidian/")?`${configDir}${path.slice(".obsidian".length)}`:path,packages=typeof this.plugin.listPackageRecoveryOriginals==="function"?await this.plugin.listPackageRecoveryOriginals():[],roots=[root,...packages.map(item=>item.path).filter(isSafeVaultPath)],pending:Array<{logical:string;root:string}>=[],files:string[]=[];let visited=0;
      for(const directory of roots)if(await adapter.exists(physical(directory)))pending.push({logical:directory,root:directory});
      while(pending.length&&files.length<500&&visited<1000&&!this.closed){const directory=pending.shift()!,native=physical(directory.logical),listing=await adapter.list(native),logical=(path:string)=>`${directory.logical}${path.slice(native.length)}`;visited++;for(const folder of listing.folders){if(pending.length+visited>=1000)break;if(folder.startsWith(`${native}/`)&&isSafeVaultPath(folder))pending.push({logical:logical(folder),root:directory.root});}for(const file of listing.files){if(files.length>=500)break;if(file.startsWith(`${native}/`)&&isSafeVaultPath(file))files.push(logical(file));}if(visited%20===0)await new Promise<void>(resolve=>window.setTimeout(resolve,0));}
      if(this.closed)return;status.setText(files.length?`${files.length>=500?"Showing the first 500":`${files.length}${pending.length?"+":""}`} recovery copies. Originals are kept until you choose to remove them.`:"No local recovery copies yet.");
      for(const path of [...new Set(files)].sort().slice(0,500)){const packageOriginal=packages.find(item=>path.startsWith(`${item.path}/`)),label=packageOriginal?`Plugin original · ${packageOriginal.packageRoot.split("/").pop()}/${path.slice(packageOriginal.path.length+1)}`:path.slice(root.length+1),row=list.createEl("details",{cls:"gib-sync-recovery-row"});row.createEl("summary",{text:label});const preview=row.createDiv({cls:"gib-sync-recovery-preview"});let loaded=false;row.addEventListener("toggle",()=>{if(!row.open||loaded||this.closed)return;loaded=true;void (async()=>{try{const stat=await adapter.stat(physical(path));if(this.closed)return;if(!stat||stat.type!=="file"){preview.setText("This recovery copy is no longer available.");return;}if(stat.size<=128*1024&&/\.(?:md|txt|json|canvas|ya?ml|css)$/i.test(path)){const content=await adapter.read(physical(path));if(!this.closed)preview.createEl("pre",{text:content});}else preview.createEl("p",{text:`${bytes(stat.size)} · preview is limited to small text files.`});if(this.closed)return;const restore=preview.createEl("button",{text:"Restore a protected copy",attr:{type:"button"}});restore.onclick=async()=>{if(!await confirmAction(this.app,"Restore recovery copy","Restore this original through the sync engine? Current contents will also be retained, and the recovery original will not be deleted.","Restore copy"))return;restore.disabled=true;try{await this.plugin.restoreLocalRecovery(path);if(!this.closed)preview.createEl("p",{text:"Restored. The recovery original is still kept."});}catch(error){if(!this.closed)preview.createEl("p",{text:error instanceof Error?error.message:String(error)});}finally{restore.disabled=false;}};}catch(error){if(!this.closed)preview.setText(error instanceof Error?error.message:String(error));}})();});}
    }catch(error){if(!this.closed)status.setText(error instanceof Error?error.message:String(error));}
  }
  onClose(){this.closed=true;this.contentEl.empty();}
}

export class ConflictInboxModal extends Modal{
  private closed=false;private generation=0;private list!:HTMLElement;private detail!:HTMLElement;private status!:HTMLElement;private records:ConflictInboxItem[]=[];
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  async onOpen(){mobileContent(this.contentEl);this.modalEl.addClass("gib-sync-conflict-modal");this.setTitle("Conflicts & recovery");this.contentEl.createEl("p",{text:"Both originals are safe. Compare the actual versions, choose the result, or keep both. Decisions can be undone while those files have no newer edits."});this.status=this.contentEl.createEl("p",{text:"Loading preserved versions…",attr:{role:"status","aria-live":"polite"}});const search=this.contentEl.createEl("input",{attr:{type:"search",placeholder:"Find a file","aria-label":"Find conflict"}});this.list=this.contentEl.createDiv({cls:"gib-sync-conflict-list"});this.detail=this.contentEl.createDiv({cls:"gib-sync-conflict-detail"});search.oninput=()=>this.renderList(search.value);await this.refresh();}
  private async refresh(){const generation=++this.generation;try{const records=await this.plugin.listConflictInbox();if(this.closed||generation!==this.generation)return;this.records=records;this.status.setText(records.length?`${records.filter(item=>item.state==="open"&&item.actionRequired!==false).length} need a decision · originals preserved`:"No recorded conflicts. Local recovery copies and version history are available in settings.");this.renderList("");}catch(error){if(!this.closed)this.status.setText(error instanceof Error?error.message:String(error));}}
  private renderList(query:string){this.list.empty();const matches=this.records.filter(item=>!query||item.path.toLowerCase().includes(query.toLowerCase()));for(const item of matches.slice(0,100)){const button=this.list.createEl("button",{text:`${item.path} · ${item.state==="resolved"?"Resolved":item.actionRequired===false?"Auto-merged · originals kept":"Review"}`,attr:{type:"button"}});button.onclick=()=>void this.preview(item);}if(matches.length>100)this.list.createEl("p",{text:`Showing 100 of ${matches.length}. Refine the search to find another record.`});}
  private async preview(item:ConflictInboxItem){const generation=++this.generation;this.detail.empty();this.detail.createEl("h3",{text:item.path});const state=this.detail.createEl("p",{text:"Verifying preserved versions…",attr:{role:"status"}});try{const preview=await this.plugin.previewConflict(item.id);if(this.closed||generation!==this.generation)return;state.setText(`${preview.item.reason} · ${when(preview.item.createdAt)}`);const versions=preview.item.versions;const panes=this.detail.createDiv({cls:"gib-sync-conflict-panes"});for(const side of versions){const pane=panes.createDiv();pane.createEl("strong",{text:side.label});pane.createEl("p",{cls:"gib-sync-muted",text:`${side.deviceName??"Unknown device"} · ${side.deleted?"Deleted":bytes(side.size)}${side.revisionId?` · revision ${side.revisionId.slice(0,8)}`:""}`});const text=preview.texts.find(value=>value.id===side.id);pane.createEl("pre",{text:side.deleted?"This version deleted the file. It is not an empty note.":text?.text??"Binary or large file. The complete original is preserved."});if(text?.truncated)pane.createEl("small",{text:"Preview shortened; the complete file is still safe."});}
      const texts=versions.slice(0,2).map(side=>preview.texts.find(value=>value.id===side.id)),canCombine=texts.length===2&&texts.every(value=>value&&typeof value.text==="string"&&!value.truncated);if(canCombine){const rows=conflictLineComparison(texts[0]!.text!,texts[1]!.text!),comparison=this.detail.createDiv({cls:"gib-sync-conflict-diff",attr:{"aria-label":"Side by side differences"}});for(const row of rows){const line=comparison.createDiv({cls:row.changed?"is-changed":""});line.createEl("pre",{text:row.left});line.createEl("pre",{text:row.right});}this.detail.createEl("p",{cls:"gib-sync-muted",text:`${rows.filter(row=>row.changed).length} changed displayed lines · diff is limited to 400 lines.`});}
      if(item.state==="resolved"){const undo=this.detail.createEl("button",{text:"Undo this decision",attr:{type:"button"}});undo.disabled=!item.resolution?.undoable;undo.onclick=async()=>{undo.disabled=true;try{await this.plugin.undoConflict(item.id);await this.refresh();this.detail.empty();}catch(error){state.setText(error instanceof Error?error.message:String(error));undo.disabled=false;}};if(!item.resolution?.undoable)this.detail.createEl("p",{text:"A newer edit prevents automatic undo. Older originals remain in version history."});return;}
      const actions=this.detail.createDiv({cls:"gib-sync-row-actions"});let combined:HTMLTextAreaElement|null=null;const resolve=async(choice:ConflictChoice)=>{if(choice==="combine"&&!combined){combined=this.detail.createEl("textarea",{cls:"gib-sync-conflict-combine",attr:{"aria-label":"Combined result"}});combined.value=texts[0]!.text!;this.detail.createEl("p",{text:"Edit the combined result above, then choose Save combined. Both originals remain in recovery."});const save=actions.createEl("button",{text:"Save combined",cls:"mod-cta"});save.onclick=()=>void apply("combine");return;}await apply(choice);};const apply=async(choice:ConflictChoice)=>{for(const button of Array.from(actions.querySelectorAll("button")))button.disabled=true;try{await this.plugin.resolveConflict(item.id,choice,combined?.value);if(!this.closed){state.setText("Decision saved. Both originals remain recoverable.");await this.refresh();this.detail.empty();}}catch(error){if(!this.closed){state.setText(error instanceof Error?error.message:String(error));for(const button of Array.from(actions.querySelectorAll("button")))button.disabled=false;}}};for(const [choice,label]of [["this","Keep this version"],["other","Keep the other version"],["combine","Combine…"],["both","Keep both"]]as const){const button=actions.createEl("button",{text:label,attr:{type:"button"}});button.disabled=choice==="combine"&&!canCombine;button.onclick=()=>void resolve(choice);}
    }catch(error){if(!this.closed&&generation===this.generation)state.setText(error instanceof Error?error.message:String(error));}}
  onClose(){this.closed=true;this.generation++;this.contentEl.empty();}
}

export class DeviceDiagnosticsModal extends Modal{
  private readonly probe=new DeviceLifecycleProbe();private readonly activity=new DeviceSyncActivityProbe();private readonly controller=new AbortController();private report:DeviceProbeReport|null=null;private unsubscribe:(()=>void)|null=null;private testing=false;
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  onOpen(){mobileContent(this.contentEl);this.setTitle("Device readiness test");this.probe.start();this.activity.start(this.probe);this.activity.observe(this.plugin.liveStatus);this.unsubscribe=this.plugin.subscribeStatus(()=>this.activity.observe(this.plugin.liveStatus));this.contentEl.createEl("p",{text:"This separately measures idle frames, frames during generated 1 MB native file work, and frames during a real sync while this window stays open. Background and return during an observed sync to check resume. A small synthetic test does not certify a large vault. Reports contain timing and phase counts only, never content, paths, identity, or credentials."});const status=this.contentEl.createEl("p",{text:"Ready",attr:{role:"status"}}),run=this.contentEl.createEl("button",{text:"Run generated device test",attr:{type:"button"}}),sync=this.contentEl.createEl("button",{text:"Run observed sync",attr:{type:"button"}}),copy=this.contentEl.createEl("button",{text:"Copy safe test report",attr:{type:"button"}});copy.disabled=true;run.onclick=async()=>{if(this.plugin.liveStatus.running||this.testing){status.setText("Wait for this sync to finish before generated testing.");return;}this.testing=true;run.disabled=true;sync.disabled=true;status.setText("Testing native streaming and interface responsiveness…");try{this.report=await runDeviceProbe(this.app.vault.adapter,this.plugin.manifest.version,Platform.isIosApp?"ios":Platform.isAndroidApp?"android":"desktop",this.probe,this.controller.signal,this.activity);if(!this.controller.signal.aborted){status.setText("Generated test complete. Observe a real sync for representative measurements, then copy the report.");copy.disabled=false;}}catch(error){if(!this.controller.signal.aborted)status.setText(error instanceof Error?error.message:String(error));}finally{this.testing=false;run.disabled=false;sync.disabled=false;}};sync.onclick=async()=>{if(this.testing||this.plugin.liveStatus.running){status.setText("Already observing the current work.");return;}sync.disabled=true;status.setText("Observing real sync. You can background Obsidian and return.");try{const complete=await this.plugin.runSync();if(!this.controller.signal.aborted)status.setText(complete?"Observed sync completed. Its responsiveness and lifecycle counts are included in the report.":"Sync did not finish; observed timing is still retained. Check the normal sync status.");}finally{sync.disabled=false;}};copy.onclick=async()=>{if(!this.report)return;const actualSync=this.activity.snapshot(),report={...this.report,lifecycle:{...this.probe.counts},responsiveness:{...this.report.responsiveness,actualSync},evidence:{...this.report.evidence,syntheticOnly:actualSync.startedRuns===0,realRunObserved:actualSync.startedRuns>0}},copied=await copyText(JSON.stringify(report,null,2));if(!this.controller.signal.aborted)status.setText(copied?"Safe device test report copied.":"Clipboard unavailable.");};}
  onClose(){this.controller.abort();this.unsubscribe?.();this.unsubscribe=null;this.activity.stop();this.probe.stop();this.contentEl.empty();}
}

export class SafeguardSettingsModal extends Modal{
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  async onOpen(){mobileContent(this.contentEl);this.setTitle("Mass-change safeguards");this.contentEl.setText("Loading…");try{const state=await this.plugin.api.safeguards(),policy={...state.policy,protectedPaths:[...state.policy.protectedPaths]};this.contentEl.empty();
    this.contentEl.createEl("p",{text:"Balanced and strict modes use server-maintained thresholds. Custom mode uses every value below. Protected paths are enforced in every mode."});
    const maintenance=new Setting(this.contentEl).setName("Vault maintenance session").setDesc(state.trustedUntil?`Mass changes from this device are allowed until ${when(state.trustedUntil)}. Snapshot history and conflict handling remain active.`:"Temporarily allow intentional bulk edits, conflict-copy cleanup, and reorganizing from this device. Protection resumes automatically after 60 minutes.");
    maintenance.addButton((button)=>button.setButtonText(state.trustedUntil?"End maintenance":"Start 60-minute maintenance").setWarning().onClick(async()=>{const starting=!state.trustedUntil;if(starting&&!await confirmAction(this.app,"Start vault maintenance","Allow mass changes from this device for 60 minutes? Use this only while intentionally cleaning up or reorganizing the vault. Other devices remain protected and version history continues.","Start maintenance",true))return;button.setDisabled(true);try{await this.plugin.api.setMaintenance(starting?60:0);this.close();await this.plugin.refreshServerStatus();new Notice(starting?"Vault maintenance started for 60 minutes":"Vault maintenance ended");}catch(error){new Notice(error instanceof Error?error.message:String(error),10000);button.setDisabled(false);}}));
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
  private hero!:HTMLElement;private icon!:HTMLElement;private overviewTitleEl!:HTMLElement;private descriptionEl!:HTMLElement;private metaEl!:HTMLElement;private progress!:HTMLElement;private progressValue!:HTMLElement;private primary!:HTMLButtonElement;private pause!:HTMLButtonElement;
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app);}
  onOpen(){
    mobileContent(this.contentEl);this.modalEl.addClass("gib-sync-status-modal");this.setTitle("Sync status");
    this.hero=this.contentEl.createDiv({cls:"gib-sync-status-overview"});this.icon=this.hero.createSpan({cls:"gib-sync-status-overview-icon"});this.icon.setAttr("aria-hidden","true");
    const copy=this.hero.createDiv({cls:"gib-sync-status-overview-copy"});this.overviewTitleEl=copy.createEl("strong");this.descriptionEl=copy.createDiv({cls:"gib-sync-status-overview-description"});this.metaEl=copy.createEl("small",{cls:"gib-sync-status-overview-meta"});
    this.progress=this.contentEl.createDiv({cls:"gib-sync-progress",attr:{role:"progressbar","aria-label":"Sync progress","aria-valuemin":"0","aria-valuemax":"100"}});this.progressValue=this.progress.createDiv({cls:"gib-sync-progress-value"});
    const actions=this.contentEl.createDiv({cls:"gib-sync-status-overview-actions"});this.primary=actions.createEl("button",{cls:"mod-cta"});this.pause=actions.createEl("button");this.pause.onclick=()=>void this.plugin.setPaused(!this.plugin.settings.paused);
    const details=actions.createEl("button",{text:"Settings"});details.onclick=()=>this.openSettings();
    this.render();this.unsubscribe=this.plugin.subscribeStatus(()=>this.render());
    if(this.plugin.settings.deviceToken)void this.plugin.refreshServerStatus();
  }
  private openSettings(){this.close();const control=(this.app as unknown as {setting?:{open?:()=>void;openTabById?:(id:string)=>void}}).setting;control?.open?.();window.setTimeout(()=>control?.openTabById?.("gib-sync"),50);}
  private runPrimary(action:QuickStatusAction){
    if(action==="setup"){this.close();new SetupModal(this.app,this.plugin).open();return;}
    if(action==="resolve"){new NativeSyncConflictModal(this.app,this.plugin).open();return;}
    if(action==="review"){this.close();this.plugin.openSafeguards();return;}
    if(action==="resume"){void this.plugin.setPaused(false);return;}
    if(action==="settings"){this.openSettings();return;}
    this.close();void this.plugin.runSync();
  }
  private render(){
    const live=this.plugin.liveStatus,state=this.plugin.indicatorState();
    const model=buildQuickStatusModel({state,live,configured:Boolean(this.plugin.settings.deviceToken),nativeSyncBlocked:this.plugin.isNativeSyncBlocking(),paused:this.plugin.settings.paused});
    this.hero.className=`gib-sync-status-overview is-${state.tone}`;if(this.icon.dataset.icon!==state.icon){setIcon(this.icon,state.icon);this.icon.dataset.icon=state.icon;}
    this.overviewTitleEl.setText(state.label);this.descriptionEl.setText(model.description);this.metaEl.setText(model.meta);
    const percent=live.total?Math.min(100,((live.current||0)/live.total)*100):0;this.progress.hidden=state.key!=="syncing"||!live.total;this.progressValue.style.width=`${percent}%`;this.progress.setAttr("aria-valuenow",String(Math.round(percent)));
    this.primary.setText(model.primaryLabel);this.primary.disabled=model.primaryDisabled;this.primary.onclick=()=>this.runPrimary(model.primaryAction);
    this.pause.hidden=!this.plugin.settings.deviceToken;this.pause.setText(this.plugin.settings.paused?"Resume":"Pause");
  }
  onClose(){this.unsubscribe?.();this.unsubscribe=null;this.contentEl.empty();}
}

export class GibSyncSettingTab extends PluginSettingTab {
  private unsubscribe:(()=>void)|null=null;private liveRoot:HTMLElement|null=null;private liveRenderTimer:number|null=null;
  private liveFields=new Map<string,HTMLElement>();private liveValues=new Map<string,HTMLElement>();private consoleRows=new Map<string,HTMLElement>();
  private page:"status"|"sync"|"content"|"safety"|"console"="status";private pageEl!:HTMLElement;
  constructor(app:App,private readonly plugin:GibSyncPlugin){super(app,plugin);}
  display(){this.unsubscribe?.();this.unsubscribe=null;if(this.liveRenderTimer!==null)window.clearTimeout(this.liveRenderTimer);this.liveRenderTimer=null;this.liveRoot=null;this.liveFields.clear();this.liveValues.clear();this.consoleRows.clear();this.containerEl.empty();this.containerEl.addClass("gib-sync-settings");
    const header=this.containerEl.createDiv({cls:"gib-sync-settings-header"});header.createEl("h2",{text:"Gib Sync"});header.createSpan({text:"Vault sync with readable Seafile storage"});
    const tabs:[typeof this.page,string,string][]=[["status","Connection","activity"],["content","What syncs","files"],["sync","Automation","refresh-cw"],["safety","Devices & recovery","shield-check"],["console","Diagnostics","terminal"]];
    const tablist=this.containerEl.createDiv({cls:"gib-sync-settings-tabs",attr:{role:"tablist","aria-label":"Gib Sync settings"}});
    for(const [id,label,iconName] of tabs){const button=tablist.createEl("button",{attr:{type:"button",role:"tab","aria-selected":String(this.page===id)}});const icon=button.createSpan();setIcon(icon,iconName);button.createSpan({text:label});button.toggleClass("is-active",this.page===id);button.addEventListener("click",()=>{if(this.page===id)return;this.page=id;this.display();});}
    this.pageEl=this.containerEl.createDiv({cls:"gib-sync-settings-page",attr:{role:"tabpanel"}});
    if(this.page==="sync")this.renderSyncPage();else if(this.page==="content")this.renderContentPage();else if(this.page==="safety")this.renderSafetyPage();else if(this.page==="console")this.renderConsolePage();else this.renderStatusPage();
    if(this.page==="status"||this.page==="console")this.unsubscribe=this.plugin.subscribeStatus(()=>this.scheduleLiveRender());
  }
  private renderStatusPage(){const configured=Boolean(this.plugin.settings.deviceToken);
    this.liveRoot=this.pageEl.createDiv({cls:"gib-sync-status-panel"});this.renderLive();
    new Setting(this.pageEl).setName("Connection").setHeading();
    const actions=new Setting(this.pageEl).setName("Actions").setDesc(configured?"Sync now, or refresh server-side counters and connection details.":"Connect manually with Seafile details, or enter a temporary quick code from an existing device.");
    actions.addButton((button)=>button.setButtonText(configured?"Sync now":"Manual setup").setCta().onClick(()=>configured?void this.plugin.runSync():new SetupModal(this.app,this.plugin).open()));
    if(configured)actions.addButton((button)=>button.setButtonText("Refresh status").onClick(()=>void this.plugin.refreshServerStatus()));
    if(configured)actions.addButton((button)=>button.setButtonText(this.plugin.settings.paused?"Resume":"Pause").onClick(async()=>{await this.plugin.setPaused(!this.plugin.settings.paused);button.setButtonText(this.plugin.settings.paused?"Resume":"Pause");}));
    if(!configured){actions.addButton((button)=>button.setButtonText("Enter quick code").onClick(()=>new QuickCodeEntryModal(this.app,this.plugin).open()));this.pageEl.createEl("p",{cls:"gib-sync-settings-note",text:"For easy phone setup, show a setup QR on the connected device, scan it with your phone’s Camera app, then choose Open Gib Sync. Or enter the optional five-digit code manually."});}
    if(configured)new Setting(this.pageEl).setName("Add another device").setDesc("Show a five-digit code that changes every 60 seconds and works once.").addButton((button)=>button.setButtonText("Show quick code").onClick(()=>new QuickCodeDisplayModal(this.app,this.plugin).open())).addButton((button)=>button.setButtonText("Change connection").onClick(()=>new SetupModal(this.app,this.plugin).open()));
    if(configured)void this.plugin.refreshServerStatus();
  }
  private renderSyncPage(){
    new Setting(this.pageEl).setName("Status indicators").setHeading();
    new Setting(this.pageEl).setName("Desktop status icon").setDesc("Show the current state as an icon in the desktop status bar.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.desktopStatusIcon).onChange(async(value)=>{this.plugin.settings.desktopStatusIcon=value;await this.plugin.saveSettings();this.plugin.configureStatusSurfaces();}));
    new Setting(this.pageEl).setName("Desktop short state").setDesc("Show only the short state word, such as Synced, Syncing, Attention, Paused, or Error.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.desktopStatusText).onChange(async(value)=>{this.plugin.settings.desktopStatusText=value;await this.plugin.saveSettings();this.plugin.configureStatusSurfaces();}));
    new Setting(this.pageEl).setName("Mobile right-sidebar indicator").setDesc("Place a tappable indicator in the bottom-right status area of the mobile right sidebar.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.mobileSidebarIndicator).onChange(async(value)=>{this.plugin.settings.mobileSidebarIndicator=value;await this.plugin.saveSettings();this.plugin.configureStatusSurfaces();}));
    new Setting(this.pageEl).setName("Mobile top-navigation dot").setDesc("Place a compact status dot immediately left of the mobile view-mode control.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.mobileTopIndicator).onChange(async(value)=>{this.plugin.settings.mobileTopIndicator=value;await this.plugin.saveSettings();this.plugin.configureStatusSurfaces();}));
    new Setting(this.pageEl).setName("Animate active synchronization").setDesc("Actual transfers use a loading ring. A verified checkmark changes hue subtly while checking, without changing size.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.animateStatusIndicator).onChange(async(value)=>{this.plugin.settings.animateStatusIndicator=value;await this.plugin.saveSettings();this.plugin.configureStatusSurfaces();}));
    new Setting(this.pageEl).setName("Attention badge count").setDesc("Show the number of quarantined change batches that need review.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.showAttentionBadge).onChange(async(value)=>{this.plugin.settings.showAttentionBadge=value;await this.plugin.saveSettings();this.plugin.configureStatusSurfaces();}));
    new Setting(this.pageEl).setName("Automation").setHeading();
    const nativeProtection=new Setting(this.pageEl).setName("Obsidian Sync protection").setDesc(this.plugin.isNativeSyncBlocking()?"Obsidian Sync is enabled. Gib Sync is paused to prevent two sync engines from changing this vault.":"Gib Sync checks continuously and refuses to run while Obsidian Sync is enabled.");
    nativeProtection.addButton((button)=>button.setButtonText("Open Core plugins").onClick(()=>this.plugin.openCorePluginSettings())).addButton((button)=>button.setButtonText("Check now").onClick(async()=>{button.setDisabled(true);const blocked=await this.plugin.checkObsidianSyncProtection(true);button.setDisabled(false);new Notice(blocked?"Obsidian Sync is still enabled.":"Protection check passed.");this.display();}));
    new Setting(this.pageEl).setName("Periodic sync").setDesc("Checks for remote changes on a timer.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.autoSync).onChange(async(value)=>{this.plugin.settings.autoSync=value;await this.plugin.saveSettings();this.plugin.configureTimer();}));
    new Setting(this.pageEl).setName("Instant incoming sync").setDesc("The server notifies this device when another device changes the vault. The periodic interval remains a safety check.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.instantReceive).onChange(async(value)=>{this.plugin.settings.instantReceive=value;await this.plugin.saveSettings();this.plugin.configureWatch();}));
    new Setting(this.pageEl).setName("Sync interval").setDesc("Seconds between periodic checks (minimum 15).").addText((text)=>text.setValue(String(this.plugin.settings.syncIntervalSeconds)).onChange(async(value)=>{const parsed=Number(value);if(Number.isFinite(parsed)){this.plugin.settings.syncIntervalSeconds=Math.max(15,Math.round(parsed));await this.plugin.saveSettings();this.plugin.configureTimer();}}));
    new Setting(this.pageEl).setName("Sync when files change").setDesc("Detects editor changes plus created, saved, renamed, and deleted files. After editing stops, waits two seconds for Obsidian to save and then syncs. Excluded paths do not trigger it.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.syncOnFileChange).onChange(async(value)=>{this.plugin.settings.syncOnFileChange=value;this.plugin.configureFileChangeSync();await this.plugin.saveSettings();}));
  }
  private renderContentPage(){const configured=Boolean(this.plugin.settings.deviceToken);
    new Setting(this.pageEl).setName("Vault content").setHeading();
    new Setting(this.pageEl).setName("Sync bookmarks").setDesc("Synchronizes Obsidian bookmarks across devices. Enabled by default and independent of other Obsidian configuration files.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.syncBookmarks).onChange(async(value)=>{
      if(!value&&this.plugin.settings.syncBookmarks&&!await this.confirmFilterChange(this.plugin.settings.exclusions,value,this.plugin.settings.syncObsidianConfig,this.plugin.settings.syncPlugins)){toggle.setValue(true);return;}
      this.plugin.settings.syncBookmarks=value;this.plugin.requireFullScan();await this.plugin.saveSettings();if(configured)void this.plugin.runSync();
    }));
    new Setting(this.pageEl).setName("Sync Obsidian configuration").setDesc("Includes portable themes, snippets, hotkeys, and other .obsidian settings. JSON settings merge by key; overlapping values use the newer version without creating conflict files. Workspace state remains device-local.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.syncObsidianConfig).onChange(async(value)=>{
      if(!value&&this.plugin.settings.syncObsidianConfig&&!await this.confirmFilterChange(this.plugin.settings.exclusions,this.plugin.settings.syncBookmarks,value,this.plugin.settings.syncPlugins)){toggle.setValue(true);return;}
      this.plugin.settings.syncObsidianConfig=value;this.plugin.requireFullScan();await this.plugin.saveSettings();if(configured)void this.plugin.runSync();
    }));
    new Setting(this.pageEl).setName("Sync installed plugins").setDesc("Synchronizes complete community plugin packages and settings, and activates compatible updates automatically. First setup adopts shared server settings while retaining other local installations. Gib Sync, BRAT, excluded plugins, caches, indexes, and temporary data stay device-local. Plugin data.json may contain API keys visible in readable Seafile.").addToggle((toggle)=>toggle.setValue(this.plugin.settings.syncPlugins).onChange(async(value)=>{
      if(!value&&this.plugin.settings.syncPlugins&&!await this.confirmFilterChange(this.plugin.settings.exclusions,this.plugin.settings.syncBookmarks,this.plugin.settings.syncObsidianConfig,value)){toggle.setValue(true);return;}
      if(value&&!this.plugin.settings.syncPlugins)this.plugin.settings.pluginSyncBootstrapPending=true;
      if(!value)this.plugin.settings.pluginSyncBootstrapPending=false;
      this.plugin.settings.syncPlugins=value;this.plugin.requireFullScan();await this.plugin.saveSettings();if(configured)void this.plugin.runSync();
    }));
    new Setting(this.pageEl).setName("Filters").setHeading();
    let proposedExclusions=this.plugin.settings.exclusions.join("\n");
    new Setting(this.pageEl).setName("Excluded path prefixes").setDesc("The device-local ignore list. Ignored remote files remain safe for other devices. Changes are previewed; use one prefix per line.")
      .addTextArea((area)=>area.setValue(proposedExclusions).onChange((value)=>proposedExclusions=value))
      .addButton((button)=>button.setButtonText("Preview and apply").onClick(async()=>{const next=proposedExclusions.split("\n").map((line)=>line.trim()).filter(Boolean);button.setDisabled(true);
        try{if(await this.confirmFilterChange(next,this.plugin.settings.syncBookmarks,this.plugin.settings.syncObsidianConfig,this.plugin.settings.syncPlugins)){this.plugin.settings.exclusions=next;this.plugin.requireFullScan();await this.plugin.saveSettings();new Notice("Ignore list updated; ignored remote files remain safe for other devices");if(configured)void this.plugin.runSync();}}finally{button.setDisabled(false);}}));
    this.pageEl.createDiv({cls:"gib-sync-settings-note",text:"Filters apply only to this device. Accepted remote files remain available to other connected devices."});
  }
  private renderSafetyPage(){const configured=Boolean(this.plugin.settings.deviceToken);
    new Setting(this.pageEl).setName("Protection").setHeading();
    if(!configured){this.pageEl.createDiv({cls:"gib-sync-settings-note",text:"Connect this device before managing safeguards, devices, recovery, or version history."});return;}
    new Setting(this.pageEl).setName("Safety center").setDesc("Review held changes, tune mass-change protection, manage devices, or freeze all remote writes.")
      .addButton((button)=>button.setButtonText("Review held changes").onClick(()=>this.plugin.openSafeguards()))
      .addButton((button)=>button.setButtonText("Safeguard settings").onClick(()=>new SafeguardSettingsModal(this.app,this.plugin).open()))
      .addButton((button)=>button.setButtonText("Devices").onClick(()=>new DeviceManagementModal(this.app,this.plugin).open()));
    new Setting(this.pageEl).setName("Remote write lock").setDesc("Freezes commits and external Seafile imports while downloads remain available.")
      .addButton((button)=>button.setButtonText(this.plugin.serverStatus?.safeguards.writeLocked?"Resume writes":"Freeze writes").onClick(async()=>{button.setDisabled(true);try{const current=await this.plugin.api.safeguards();await this.plugin.api.setWriteLock(!current.writeLocked);await this.plugin.refreshServerStatus();this.display();new Notice(current.writeLocked?"Remote writes resumed":"Remote writes frozen");}catch(error){new Notice(error instanceof Error?error.message:String(error),10000);button.setDisabled(false);}}));
    if(this.plugin.settings.vaultIdentity&&this.plugin.currentVaultIdentity()!==this.plugin.settings.vaultIdentity)new Setting(this.pageEl).setName("Vault location changed").setDesc("Sync is paused until you verify that this is the intended local vault.")
      .addButton((button)=>button.setWarning().setButtonText("Trust this vault location").onClick(async()=>{if(!await confirmAction(this.app,"Trust vault location","Trust this vault name and location for Gib Sync? Only continue if you intentionally moved or renamed the vault.","Trust location",true))return;await this.plugin.acceptCurrentVaultIdentity();this.display();}));
    new Setting(this.pageEl).setName("Recovery").setHeading();
    new Setting(this.pageEl).setName("Repair vault health").setDesc("Uses the accepted server snapshot as the safe checkpoint, dismisses stuck held proposals, rebuilds the readable Seafile vault, removes obsolete internal conflict artifacts, and then runs normal reconciliation. Version history is preserved.")
      .addButton((button)=>button.setWarning().setButtonText("Diagnose and repair").onClick(async()=>{if(!await confirmAction(this.app,"Repair vault health","Restore the currently accepted server snapshot as the readable Seafile checkpoint and dismiss pending quarantined proposals? Normal notes and version history are preserved. Use this when sync cannot escape a blocked or dirty state.","Repair health",true))return;button.setDisabled(true);try{await this.plugin.repairVaultHealth();}finally{button.setDisabled(false);}}));
    new Setting(this.pageEl).setName("Version history").setDesc("Browse accepted snapshots and restore a known version.").addButton((button)=>button.setButtonText("Open history").onClick(()=>new HistoryModal(this.app,this.plugin).open()));
    new Setting(this.pageEl).setName("Local recovery copies").setDesc("Sync preserves replaced or deleted originals in .gib-sync/local-recovery on this device. These are separate from server history and are never uploaded as notes.").addButton((button)=>button.setButtonText("Browse copies").onClick(()=>new LocalRecoveryModal(this.app,this.plugin).open()));
    new Setting(this.pageEl).setName("Conflicts & recovery inbox").setDesc("Compare preserved versions and make a reversible decision. Newer edits are never overwritten by undo.").addButton(button=>button.setButtonText("Review conflicts").onClick(()=>new ConflictInboxModal(this.app,this.plugin).open()));
    new Setting(this.pageEl).setName("New device approvals").setDesc("Only this inviting device can approve its pending quick-code requests.").addButton(button=>button.setButtonText("Review requests").onClick(()=>new DeviceRequestsModal(this.app,this.plugin).open()));
    void this.plugin.refreshServerStatus();
  }
  private renderConsolePage(){
    new Setting(this.pageEl).setName("Mobile & device readiness").setDesc("Test native streaming, foreground/background behavior, and responsiveness without exporting note content or secrets.").addButton(button=>button.setButtonText("Open device test").onClick(()=>new DeviceDiagnosticsModal(this.app,this.plugin).open()));
    const toolbar=this.pageEl.createDiv({cls:"gib-sync-console-toolbar"});
    const detailed=toolbar.createEl("button",{text:"Copy detailed",attr:{type:"button",title:"Includes vault-relative file names, plugin repair reasons, merge decisions, and errors; excludes credentials and server addresses"}});detailed.onclick=async()=>{const storage=this.plugin.serverStatus?.storage||this.plugin.settings.storage,copied=await copyText(JSON.stringify(detailedDiagnostics(this.plugin.liveStatus,this.plugin.serverStatus,{configured:Boolean(this.plugin.settings.deviceToken),storageConfigured:Boolean(storage)},this.plugin.settings.packageHolds),null,2));new Notice(copied?"Detailed Gib Sync log copied; review vault-relative file names before sharing":"Clipboard access is unavailable on this device.",copied?6000:8000);};
    const safe=toolbar.createEl("button",{text:"Copy safe",attr:{type:"button",title:"Removes activity text and file names for public sharing"}});safe.onclick=async()=>{const storage=this.plugin.serverStatus?.storage||this.plugin.settings.storage,copied=await copyText(JSON.stringify(privacySafeDiagnostics(this.plugin.liveStatus,this.plugin.serverStatus,{configured:Boolean(this.plugin.settings.deviceToken),storageConfigured:Boolean(storage)}),null,2));new Notice(copied?"Privacy-safe Gib Sync log copied":"Clipboard access is unavailable on this device.",copied?4000:8000);};
    const clear=toolbar.createEl("button",{text:"Clear",attr:{type:"button"}});clear.onclick=()=>this.plugin.clearActivity();toolbar.createSpan({text:"Live session activity"});
    this.liveRoot=this.pageEl.createDiv({cls:"gib-sync-console",attr:{role:"log","aria-live":"off","aria-label":"Detailed sync activity"}});this.renderConsole();
  }
  hide(){this.unsubscribe?.();this.unsubscribe=null;if(this.liveRenderTimer!==null)window.clearTimeout(this.liveRenderTimer);this.liveRenderTimer=null;}
  private included(path:string,exclusions:string[],syncBookmarks:boolean,syncConfig:boolean,syncPlugins:boolean):boolean{
    return shouldSyncChangedPath(path,{...this.plugin.settings,exclusions,syncBookmarks,syncObsidianConfig:syncConfig,syncPlugins});
  }
  private async confirmFilterChange(exclusions:string[],syncBookmarks:boolean,syncConfig:boolean,syncPlugins:boolean):Promise<boolean>{
    if(!this.plugin.settings.deviceToken)return true;const head=(await this.plugin.api.state()).head;if(!head)return true;
    const affected=head.entries.filter((entry)=>this.included(entry.path,this.plugin.settings.exclusions,this.plugin.settings.syncBookmarks,this.plugin.settings.syncObsidianConfig,this.plugin.settings.syncPlugins)&&!this.included(entry.path,exclusions,syncBookmarks,syncConfig,syncPlugins));
    if(!affected.length)return true;const examples=affected.slice(0,10).map((entry)=>`- ${entry.path}`).join("\n");
    return confirmAction(this.app,"Apply sync filter",`This device will stop syncing ${affected.length} file${affected.length===1?"":"s"}:\n\n${examples}${affected.length>10?`\n- …and ${affected.length-10} more`:""}\n\nTheir accepted remote versions remain safe and available to other devices.`,"Apply filter");
  }
  private scheduleLiveRender(){if(this.liveRenderTimer!==null)return;this.liveRenderTimer=window.setTimeout(()=>{this.liveRenderTimer=null;if(this.page==="console")this.renderConsole();else if(this.page==="status")this.renderLive();},250);}
  private renderLive(){if(!this.liveRoot)return;const root=this.liveRoot,live=this.plugin.liveStatus,server=this.plugin.serverStatus,state=this.plugin.indicatorState();
    if(!this.liveFields.size){const header=root.createDiv({cls:"gib-sync-status-head"});header.createDiv({cls:"gib-sync-status-dot"});const copy=header.createDiv();this.liveFields.set("header",header);this.liveFields.set("label",copy.createEl("strong"));this.liveFields.set("description",copy.createDiv({cls:"gib-sync-muted"}));this.liveFields.set("freshness",header.createDiv({cls:"gib-sync-status-freshness"}));
      const track=root.createDiv({cls:"gib-sync-progress",attr:{role:"progressbar","aria-label":"Sync progress","aria-valuemin":"0","aria-valuemax":"100"}});this.liveFields.set("track",track);this.liveFields.set("progress",track.createDiv({cls:"gib-sync-progress-value"}));
      const attention=root.createDiv({cls:"gib-sync-attention-card"});this.liveFields.set("attention",attention);this.liveFields.set("attentionTitle",attention.createEl("strong"));this.liveFields.set("attentionMessage",attention.createEl("p"));this.liveFields.set("grid",root.createDiv({cls:"gib-sync-status-grid gib-sync-status-summary"}));this.liveFields.set("versions",root.createDiv({cls:"gib-sync-version-line gib-sync-muted"}));
      const details=root.createEl("details",{cls:"gib-sync-status-details"});details.createEl("summary",{text:"Technical details"});this.liveFields.set("technical",details.createDiv({cls:"gib-sync-status-grid"}));}
    this.liveFields.get("header")!.className=`gib-sync-status-head is-${state.tone}`;this.liveFields.get("label")!.setText(state.label);this.liveFields.get("description")!.setText(state.description);this.liveFields.get("freshness")!.setText(live.lastSuccessAt?`Last verified ${when(live.lastSuccessAt)}`:"Not verified yet");
    const percent=live.total?Math.min(100,((live.current||0)/live.total)*100):0,track=this.liveFields.get("track")!;track.hidden=!live.running||!live.total;track.setAttr("aria-valuenow",String(Math.round(percent)));this.liveFields.get("progress")!.style.width=`${percent}%`;
    const issues=server?.healthAlerts.filter((alert)=>alert.level==="warning"||alert.level==="error")??[],incompatible=this.plugin.compatibility&&!this.plugin.compatibility.compatible,attention=this.liveFields.get("attention")!;attention.hidden=!incompatible&&live.phase!=="error"&&!issues.length;attention.className=`gib-sync-attention-card is-${live.phase==="error"||issues.some((issue)=>issue.level==="error")?"error":"warning"}`;this.liveFields.get("attentionTitle")!.setText(incompatible?"Update required":live.phase==="error"?"Sync needs help":"Server needs attention");this.liveFields.get("attentionMessage")!.setText(incompatible?this.plugin.compatibility!.reason??"A compatibility update is required":live.phase==="error"?(live.lastError||live.message):issues[0]?.message??"");
    const item=(host:HTMLElement,label:string,value:string,tone="neutral",detail="")=>{let row=this.liveValues.get(label);if(!row){row=host.createDiv();row.createEl("span",{text:label});row.createEl("strong");this.liveValues.set(label,row);}row.className=`is-${tone}`;row.querySelector("strong")!.textContent=value;row.setAttr("title",detail||value);};
    for(const fact of buildSyncFacts(live,server,this.plugin.settings.lastSnapshotId))item(this.liveFields.get("grid")!,fact.label,fact.value,fact.tone,fact.detail);
    const compatibility=server?.compatibility??this.plugin.compatibility;this.liveFields.get("versions")!.setText(`Plugin ${this.plugin.manifest.version} · Server ${compatibility?.serverVersion??"checking…"}`);
    const technical=this.liveFields.get("technical")!,storage=server?.storage??this.plugin.settings.storage;
    item(technical,"Current operation",live.running?live.message:"Idle");item(technical,"Last result",live.lastResult||"No completed sync yet");item(technical,"Next automatic check",when(live.nextSyncAt));item(technical,"Current error",live.phase==="error"?live.lastError||live.message:"None",live.phase==="error"?"error":"neutral");item(technical,"Server pause",server?.containment?.active&&!server.containment.thisVaultAllowed?"This vault is safely paused":"Off");item(technical,"Held changes",server?String(server.safeguards.pendingQuarantines):"Checking");
    item(technical,"Vault / device",this.plugin.settings.vaultName?`${this.plugin.settings.vaultName} / ${this.plugin.settings.deviceName}`:"Not configured");item(technical,"Gib Sync server",this.plugin.settings.serverUrl||"Not connected");item(technical,"Folder topology",this.plugin.settings.lastFolderCleanupError||this.plugin.settings.retiredFolderNote||"No outstanding folder warnings");
    if(storage){item(technical,"Seafile account",`${storage.username} @ ${storage.seafileUrl}`);item(technical,"Readable vault",`${storage.libraryName}:${storage.readablePath}`);}
    if(server){item(technical,"Stored history",`${server.snapshotCount} snapshots · ${server.blobCount} blobs · ${bytes(server.blobBytes)}`);item(technical,"External edits",server.externalError||"Watching for Seafile edits");item(technical,"Client compatibility",server.compatibility?`Minimum ${server.compatibility.minimumVersion} · recommended ${server.compatibility.recommendedVersion}`:"Not advertised");item(technical,"Server notices",server.healthAlerts.map((alert)=>alert.message).join(" · ")||"None");}
  }
  private renderConsole(){if(!this.liveRoot)return;const root=this.liveRoot,nearBottom=root.scrollHeight-root.scrollTop-root.clientHeight<48,activities=this.plugin.liveStatus.activities.slice(-100),keys=new Set<string>();let index=0;
    for(const entry of activities){const key=`${entry.phase}\u0000${entry.message}`;keys.add(key);let row=this.consoleRows.get(key);if(!row){row=root.createDiv({cls:"gib-sync-console-row"});row.createEl("time");row.createSpan({cls:"gib-sync-console-phase"});row.createSpan({cls:"gib-sync-console-message"});this.consoleRows.set(key,row);}row.setAttr("data-level",entry.level);row.querySelector("time")!.textContent=new Date(entry.at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});row.querySelector(".gib-sync-console-phase")!.textContent=entry.phase;row.querySelector(".gib-sync-console-message")!.textContent=`${entry.message}${(entry.repeats??1)>1?` · repeated ${entry.repeats} times`:""}`;if(root.children[index]!==row)root.insertBefore(row,root.children[index]??null);index++;}
    for(const [key,row] of this.consoleRows)if(!keys.has(key)){row.remove();this.consoleRows.delete(key);}let empty=root.querySelector<HTMLElement>(".gib-sync-console-empty");if(activities.length)empty?.remove();else if(!empty)empty=root.createDiv({cls:"gib-sync-console-empty",text:"No activity recorded in this session."});
    if(nearBottom)root.scrollTop=root.scrollHeight;
  }
}

export async function claimQuickCodeSetup(plugin:GibSyncPlugin,server:string,value:string,deviceName:string,signal?:AbortSignal,qrToken?:string):Promise<SetupResponse>{
  const current=()=>{if(signal?.aborted)throw new Error("Device connection cancelled.");};current();if(qrToken&&!/^[-_A-Za-z0-9]{43}$/.test(qrToken))throw new Error("QR invitation is invalid or expired.");await plugin.verifyServerBeforeSetup(server);current();const code=qrToken?"":normalizeQuickCode(value);const response=qrToken?await plugin.api.claimQrInvite(server,qrToken,deviceName):await plugin.api.claimQuickCode(server,code,deviceName);
  if("status" in response&&response.status==="pending"){if(signal?.aborted){void plugin.api.cancelDeviceClaim(server,response.ticket).catch(()=>{});current();}const approved=await new Promise<{pairingId:string;envelope:string}>((resolve,reject)=>new DeviceApprovalWaitModal(plugin.app,plugin,server,response,result=>result instanceof Error?reject(result):resolve(result),signal).open());current();return openPairingEnvelope<SetupResponse>(approved.envelope,response.ticket,approved.pairingId);}
  current();
  if(qrToken)throw new Error("QR setup requires trusted-device approval; connection was not accepted.");
  const legacy=response as {pairingId:string;envelope:string};return openPairingEnvelope<SetupResponse>(legacy.envelope,code,legacy.pairingId);
}
