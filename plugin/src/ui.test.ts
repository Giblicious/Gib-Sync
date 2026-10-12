import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";

const {Element,Modal}=vi.hoisted(()=>{
  class Element{
    children:Element[]=[];parentElement:Element|null=null;className="";textContent="";tagName="div";style:{width?:string}={};dataset:Record<string,string>={};attributes:Record<string,string>={};hidden=false;disabled=false;open=false;emptyCount=0;scrollHeight=0;scrollTop=0;clientHeight=0;onclick:(()=>void)|null=null;listeners:Record<string,()=>void>={};
    createEl(tag:string,options:{cls?:string;text?:string;attr?:Record<string,string>}={}){const child=new Element();child.tagName=tag;child.className=options.cls??"";child.textContent=options.text??"";child.attributes={...options.attr};return this.appendChild(child);}
    createDiv(options={}){return this.createEl("div",options);}createSpan(options={}){return this.createEl("span",options);}
    appendChild(child:Element){child.remove();child.parentElement=this;this.children.push(child);return child;}remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}
    insertBefore(child:Element,before:Element|null){child.remove();child.parentElement=this;const index=before?this.children.indexOf(before):-1;if(index<0)this.children.push(child);else this.children.splice(index,0,child);return child;}
    empty(){this.emptyCount++;for(const child of this.children)child.parentElement=null;this.children=[];}setText(text:string){this.textContent=text;}setAttr(name:string,value:string){this.attributes[name]=value;}addClass(name:string){this.className+=` ${name}`;}
    addEventListener(name:string,listener:()=>void){this.listeners[name]=listener;}
    querySelectorAll(selector:string):Element[]{const rows:Element[]=[];for(const child of this.children){if(selector.startsWith(".")?child.className.split(" ").includes(selector.slice(1)):child.tagName===selector)rows.push(child);rows.push(...child.querySelectorAll(selector));}return rows;}
    querySelector(selector:string):Element|null{for(const child of this.children){if(selector.startsWith(".")?child.className.split(" ").includes(selector.slice(1)):child.tagName===selector)return child;const descendant=child.querySelector(selector);if(descendant)return descendant;}return null;}
  }
  class Modal{contentEl=new Element();modalEl=new Element();constructor(public app:unknown){}setTitle(_title:string){}close(){(this as unknown as {onClose:()=>void}).onClose();}}
  return {Element,Modal};
});
vi.mock("obsidian",()=>({Modal,PluginSettingTab:class {},Setting:class {},Platform:{isMobile:false},Notice:vi.fn(),setIcon:vi.fn(),normalizePath:(s:string)=>s,requestUrl:vi.fn()}));
import { ConflictInboxModal,GibSyncSettingTab,LocalRecoveryModal,QuickCodeDisplayModal,StatusOverviewModal } from "./ui";
import { DEFAULT_SETTINGS,initialLiveStatus } from "./settings";

beforeEach(()=>{vi.useFakeTimers();vi.stubGlobal("window",globalThis);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

function pluginFixture(){const plugin={settings:{...structuredClone(DEFAULT_SETTINGS),deviceToken:"test",lastSnapshotId:"current"},api:{createPairing:vi.fn()},liveStatus:{...initialLiveStatus(true),verified:true,lastSuccessAt:new Date().toISOString()},serverStatus:null,manifest:{version:"test"},compatibility:null,indicatorState:()=>({key:"synced",label:"Up to date",icon:"check",tone:"success",description:"This device has the latest accepted version."}),isNativeSyncBlocking:()=>false,subscribeStatus:vi.fn((_listener:()=>void)=>()=>{}),refreshServerStatus:vi.fn(),setPaused:vi.fn(),runSync:vi.fn()};return plugin;}

describe("actionable conflict inbox",()=>{
  const record={id:"conflict",originSnapshotId:"accepted",path:"Note.md",createdAt:new Date().toISOString(),reason:"Concurrent versions",state:"open",versions:[{id:"left",label:"This version",path:"Note.md",hash:"a".repeat(64),size:4,deviceName:"Desktop"},{id:"right",label:"Other version",path:"Copy.md",hash:"b".repeat(64),size:5,deviceName:"Phone"}]};
  function fixture(binary=false){return {...pluginFixture(),listConflictInbox:vi.fn(async()=>[record]),previewConflict:vi.fn(async()=>({item:record,texts:record.versions.map((side,index)=>({id:side.id,text:binary?null:index?"other":"this",truncated:false}))})),resolveConflict:vi.fn(async()=>{}),undoConflict:vi.fn()};}
  it("invokes the serialized verified resolution helper and never directly writes files",async()=>{const plugin=fixture(),modal=new ConflictInboxModal({}as never,plugin as never);await modal.onOpen();const content=modal.contentEl as unknown as InstanceType<typeof Element>;content.querySelector(".gib-sync-conflict-list")!.children[0].onclick!();await vi.advanceTimersByTimeAsync(0);const controls=content.querySelector(".gib-sync-row-actions")!.children;expect(controls.map(item=>item.textContent)).toEqual(["Keep this version","Keep the other version","Combine…","Keep both"]);controls[0].onclick!();await vi.advanceTimersByTimeAsync(0);expect(plugin.resolveConflict).toHaveBeenCalledExactlyOnceWith("conflict","this",undefined);modal.onClose();});
  it("does not offer lossy text combination for a binary or incomplete preview",async()=>{const plugin=fixture(true),modal=new ConflictInboxModal({}as never,plugin as never);await modal.onOpen();const content=modal.contentEl as unknown as InstanceType<typeof Element>;content.querySelector(".gib-sync-conflict-list")!.children[0].onclick!();await vi.advanceTimersByTimeAsync(0);const controls=content.querySelector(".gib-sync-row-actions")!.children;expect(controls[2].disabled).toBe(true);expect(controls[3].disabled).toBe(false);modal.onClose();});
  it("cannot repopulate a closed inbox after delayed preview verification",async()=>{const plugin=fixture();let finish!:(value:any)=>void;plugin.previewConflict.mockImplementation(()=>new Promise(resolve=>finish=resolve));const modal=new ConflictInboxModal({}as never,plugin as never);await modal.onOpen();const content=modal.contentEl as unknown as InstanceType<typeof Element>;content.querySelector(".gib-sync-conflict-list")!.children[0].onclick!();modal.onClose();finish({item:record,texts:[]});await vi.advanceTimersByTimeAsync(0);expect(content.children).toEqual([]);});
  it("does not demand a decision for automatically merged settings whose originals remain reviewable",async()=>{const plugin=fixture();plugin.listConflictInbox.mockResolvedValue([{...record,actionRequired:false}]as any);const modal=new ConflictInboxModal({}as never,plugin as never);await modal.onOpen();const content=modal.contentEl as unknown as InstanceType<typeof Element>;expect(content.children.find(item=>item.attributes.role==="status")?.textContent).toContain("0 need a decision");expect(content.querySelector(".gib-sync-conflict-list")!.children[0].textContent).toContain("Auto-merged · originals kept");modal.onClose();});
});

describe("rolling setup code lifecycle",()=>{
  it("does not create a timer or touch a closed modal after initial request returns",async()=>{
    const plugin=pluginFixture();let finish!:(value:{code:string;expiresAt:string})=>void;plugin.api.createPairing.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));const modal=new QuickCodeDisplayModal({} as never,plugin as never),opened=modal.onOpen();modal.onClose();finish({code:"12345",expiresAt:new Date(Date.now()+60_000).toISOString()});await opened;
    expect(vi.getTimerCount()).toBe(0);expect((modal.contentEl as unknown as InstanceType<typeof Element>).children).toHaveLength(0);
  });
  it("retains refresh failures instead of replacing them every second or retrying in a loop",async()=>{
    const plugin=pluginFixture();plugin.api.createPairing.mockRejectedValue(new Error("Temporarily unavailable"));const modal=new QuickCodeDisplayModal({} as never,plugin as never);await modal.onOpen();const content=modal.contentEl as unknown as InstanceType<typeof Element>,status=content.children.find(child=>child.attributes.role==="status")!;
    expect(status.textContent).toContain("Temporarily unavailable");await vi.advanceTimersByTimeAsync(14_000);expect(status.textContent).toContain("Temporarily unavailable");expect(plugin.api.createPairing).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1000);expect(plugin.api.createPairing).toHaveBeenCalledTimes(2);modal.onClose();expect(vi.getTimerCount()).toBe(0);
  });
  it("removes an expired code while preserving the refresh error",async()=>{
    const plugin=pluginFixture();plugin.api.createPairing.mockResolvedValueOnce({code:"12345",expiresAt:new Date(Date.now()+60_000).toISOString(),requiresConfirmation:true}).mockRejectedValue(new Error("Offline"));const modal=new QuickCodeDisplayModal({} as never,plugin as never);await modal.onOpen();await vi.advanceTimersByTimeAsync(60_000);const content=modal.contentEl as unknown as InstanceType<typeof Element>;
    expect(content.querySelector(".gib-sync-quick-code")?.textContent).toBe("-----");const status=content.children.find(child=>child.attributes.role==="status")!;expect(status.textContent).toContain("Offline");await vi.advanceTimersByTimeAsync(5000);expect(status.textContent).toContain("Offline");expect(plugin.api.createPairing).toHaveBeenCalledTimes(2);modal.onClose();
  });
});

describe("local recovery browsing",()=>{
  it("finds protected complete-package originals with a custom config root even without normal recovery copies",async()=>{const logical=".obsidian/plugins/.gib-sync-package-123.original",native="custom-config/plugins/.gib-sync-package-123.original",adapter={exists:vi.fn(async(path:string)=>path===native),list:vi.fn(async()=>({files:[`${native}/data.json`],folders:[]})),stat:vi.fn(async()=>({type:"file",size:12})),read:vi.fn(async()=>'{"filters":[1]}')},plugin={...pluginFixture(),listPackageRecoveryOriginals:vi.fn(async()=>[{path:logical,packageRoot:".obsidian/plugins/gib-search",snapshotId:"accepted"}])},modal=new LocalRecoveryModal({vault:{adapter,configDir:"custom-config"}}as never,plugin as never);await modal.onOpen();expect(adapter.list).toHaveBeenCalledWith(native);const row=(modal.contentEl as unknown as InstanceType<typeof Element>).querySelector("details")!;expect(row.querySelector("summary")!.textContent).toBe("Plugin original · gib-search/data.json");row.open=true;row.listeners.toggle();await vi.advanceTimersByTimeAsync(0);expect(adapter.read).toHaveBeenCalledWith(`${native}/data.json`);modal.onClose();});
  it("keeps browsing read-only and only reads a small text copy when expanded",async()=>{
    const path=".gib-sync/local-recovery/accepted-current/Note.md",adapter={exists:vi.fn(async()=>true),list:vi.fn(async()=>({files:[path,".gib-sync/local-recovery/../../outside.md"],folders:[]})),stat:vi.fn(async()=>({type:"file",size:12})),read:vi.fn(async()=>"Original note"),write:vi.fn(),remove:vi.fn(),rename:vi.fn()},app={vault:{adapter}},modal=new LocalRecoveryModal(app as never,pluginFixture() as never);
    await modal.onOpen();expect(adapter.read).not.toHaveBeenCalled();const content=modal.contentEl as unknown as InstanceType<typeof Element>,row=content.querySelector("details")!;row.open=true;row.listeners.toggle();await vi.advanceTimersByTimeAsync(0);expect(adapter.read).toHaveBeenCalledExactlyOnceWith(path);expect(adapter.write).not.toHaveBeenCalled();expect(adapter.remove).not.toHaveBeenCalled();expect(adapter.rename).not.toHaveBeenCalled();expect(row.querySelector("pre")?.textContent).toBe("Original note");
  });
  it("does not repopulate a recovery modal closed while a directory read is pending",async()=>{
    let finish!:(value:{files:string[];folders:string[]})=>void;const app={vault:{adapter:{exists:vi.fn(async()=>true),list:vi.fn(()=>new Promise<{files:string[];folders:string[]}>(resolve=>{finish=resolve;}))}}},modal=new LocalRecoveryModal(app as never,pluginFixture() as never),opened=modal.onOpen();await vi.advanceTimersByTimeAsync(0);modal.onClose();finish({files:[".gib-sync/local-recovery/Note.md"],folders:[]});await opened;expect((modal.contentEl as unknown as InstanceType<typeof Element>).children).toHaveLength(0);
  });
  it("bounds a single-directory recovery inventory before constructing rows",async()=>{
    const files=Array.from({length:600},(_,index)=>`.gib-sync/local-recovery/Note-${index}.md`),adapter={exists:vi.fn(async()=>true),list:vi.fn(async()=>({files,folders:[]})),read:vi.fn()},modal=new LocalRecoveryModal({vault:{adapter}} as never,pluginFixture() as never);await modal.onOpen();const list=(modal.contentEl as unknown as InstanceType<typeof Element>).querySelector(".gib-sync-history")!;expect(list.children.filter(child=>child.tagName==="details")).toHaveLength(500);expect(list.children[0].textContent).toContain("Showing the first 500");expect(adapter.read).not.toHaveBeenCalled();
  });
});

describe("stable live UI",()=>{
  it("keeps popup controls stable through live updates and exposes pause on mobile and desktop",()=>{
    const plugin=pluginFixture();let changed!:()=>void;plugin.subscribeStatus.mockImplementation((listener:()=>void)=>{changed=listener;return ()=>{};});const modal=new StatusOverviewModal({} as never,plugin as never);modal.onOpen();const content=modal.contentEl as unknown as InstanceType<typeof Element>,actions=content.querySelector(".gib-sync-status-overview-actions")!,controls=[...actions.children];
    expect(controls.map(child=>child.textContent)).toEqual(["Sync now","Pause","Settings"]);plugin.liveStatus.message="Checking";changed();expect(actions.children).toEqual(controls);expect(content.emptyCount).toBe(0);controls[1].onclick!();expect(plugin.setPaused).toHaveBeenCalledWith(true);modal.onClose();
  });
  it("does not replace the settings details or status controls during progress refreshes",()=>{
    const plugin=pluginFixture(),tab=new GibSyncSettingTab({} as never,plugin as never),root=new Element();(tab as any).liveRoot=root;(tab as any).renderLive();const details=root.querySelector("details")!;details.open=true;const summary=details.querySelector("summary"),header=root.querySelector(".gib-sync-status-head");plugin.liveStatus.message="A newer progress message";(tab as any).renderLive();
    expect(root.emptyCount).toBe(0);expect(root.querySelector("details")).toBe(details);expect(details.open).toBe(true);expect(details.querySelector("summary")).toBe(summary);expect(root.querySelector(".gib-sync-status-head")).toBe(header);
  });
  it("updates repeated console rows in place without clearing the scrolling surface",()=>{
    const plugin=pluginFixture(),tab=new GibSyncSettingTab({} as never,plugin as never),root=new Element();(tab as any).liveRoot=root;plugin.liveStatus.activities=[{phase:"checking",level:"info",message:"Checking",at:new Date().toISOString()}];(tab as any).renderConsole();const row=root.querySelector(".gib-sync-console-row");plugin.liveStatus.activities[0].repeats=2;(tab as any).renderConsole();
    expect(root.emptyCount).toBe(0);expect(root.querySelector(".gib-sync-console-row")).toBe(row);expect(row?.querySelector(".gib-sync-console-message")?.textContent).toContain("repeated 2 times");
  });
});
