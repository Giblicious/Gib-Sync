import type {DataAdapter} from "obsidian";
import {hashAdapterFile} from "./file-io";
import {hashBytes} from "./crypto";
export interface FrameEvidence{samples:number;p95WindowSamples:number;p95Ms:number;maxGapMs:number;over50Ms:number;over100Ms:number;backgroundGaps:number;}
export interface SyncEvidence{observedMs:number;runningMs:number;startedRuns:number;completedRuns:number;interruptedRuns:number;stageMs:Record<string,number>;frames:FrameEvidence;}
export interface DeviceProbeReport{schemaVersion:2;pluginVersion:string;platform:string;sampledAt:string;frames:FrameEvidence;responsiveness:{idle:FrameEvidence;generatedIo:FrameEvidence;actualSync:SyncEvidence};lifecycle:{hidden:number;shown:number;pagehide:number;pageshow:number};fileIo:{appendSupported:boolean;resourceSupported:boolean;testedBytes:number;verified:boolean};evidence:{syntheticOnly:boolean;realRunObserved:boolean;fullScaleNotCertified:true};}
class FrameMetrics{
  private gaps:number[]=[];private samples=0;private maximum=0;private over50=0;private over100=0;private background=0;
  add(ms:number,hidden=false){if(hidden){this.background++;return;}this.samples++;this.maximum=Math.max(this.maximum,ms);if(ms>50)this.over50++;if(ms>100)this.over100++;if(this.gaps.length>=1024)this.gaps.shift();this.gaps.push(ms);}
  snapshot():FrameEvidence{const sorted=[...this.gaps].sort((a,b)=>a-b),round=(n:number)=>Math.round(n*100)/100;return {samples:this.samples,p95WindowSamples:sorted.length,p95Ms:round(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]??0),maxGapMs:round(this.maximum),over50Ms:this.over50,over100Ms:this.over100,backgroundGaps:this.background};}
}
class FrameSampler{
  private active=false;private request:number|null=null;private previous=0;private wasHidden=false;readonly metrics=new FrameMetrics();
  start(hidden:()=>boolean,include:()=>boolean=()=>true,backgroundEpoch:()=>number=()=>0){if(this.active)return;this.active=true;this.previous=performance.now();this.wasHidden=hidden();let previousEpoch=backgroundEpoch();const tick=()=>{if(!this.active)return;const now=performance.now(),isHidden=hidden(),epoch=backgroundEpoch();if(include())this.metrics.add(now-this.previous,this.wasHidden||isHidden||epoch!==previousEpoch);this.previous=now;this.wasHidden=isHidden;previousEpoch=epoch;this.request=requestAnimationFrame(tick);};this.request=requestAnimationFrame(tick);}
  stop(){this.active=false;if(this.request!==null&&typeof cancelAnimationFrame==="function")cancelAnimationFrame(this.request);this.request=null;}
}
export class DeviceLifecycleProbe{
  readonly counts={hidden:0,shown:0,pagehide:0,pageshow:0};hidden=false;private removers:Array<()=>void>=[];
  start(doc:Document=document,win:Window=window){this.stop();this.hidden=doc.hidden;const visibility=()=>{this.hidden=doc.hidden;this.counts[doc.hidden?"hidden":"shown"]++;};const hide=()=>{this.hidden=true;this.counts.pagehide++;},show=()=>{this.hidden=doc.hidden;this.counts.pageshow++;};doc.addEventListener("visibilitychange",visibility);win.addEventListener("pagehide",hide);win.addEventListener("pageshow",show);this.removers=[()=>doc.removeEventListener("visibilitychange",visibility),()=>win.removeEventListener("pagehide",hide),()=>win.removeEventListener("pageshow",show)];}
  stop(){for(const remove of this.removers)remove();this.removers=[];}
}
/** Only finite phase labels and timing, never live messages/current paths. */
export class DeviceSyncActivityProbe{
  private sampler=new FrameSampler();private startAt:number|null=null;private stopAt:number|null=null;private lastAt=0;private running=false;private phase="other";private runningMs=0;private starts=0;private completed=0;private interrupted=0;private stages:Record<string,number>={};
  start(lifecycle:DeviceLifecycleProbe){if(this.startAt!==null)return;this.startAt=performance.now();this.lastAt=this.startAt;this.sampler.start(()=>lifecycle.hidden,()=>this.running,()=>lifecycle.counts.hidden+lifecycle.counts.pagehide);}
  private account(now:number){if(this.running){const elapsed=Math.max(0,now-this.lastAt);this.runningMs+=elapsed;this.stages[this.phase]=(this.stages[this.phase]??0)+elapsed;}this.lastAt=now;}
  observe(status:{running:boolean;phase:string}){if(this.startAt===null||this.stopAt!==null)return;this.account(performance.now());if(status.running&&!this.running)this.starts++;if(!status.running&&this.running){if(status.phase==="complete"||status.phase==="up-to-date")this.completed++;else this.interrupted++;}this.running=status.running;this.phase=new Set(["checking","scanning","reading-remote","merging","applying","uploading","committing","mirroring","retrying"]).has(status.phase)?status.phase:"other";}
  snapshot():SyncEvidence{const now=this.stopAt??performance.now();if(this.startAt!==null&&this.stopAt===null)this.account(now);return {observedMs:Math.round(this.startAt===null?0:now-this.startAt),runningMs:Math.round(this.runningMs),startedRuns:this.starts,completedRuns:this.completed,interruptedRuns:this.interrupted,stageMs:Object.fromEntries(Object.entries(this.stages).map(([key,value])=>[key,Math.round(value)])),frames:this.sampler.metrics.snapshot()};}
  stop(){if(this.startAt!==null&&this.stopAt===null){this.stopAt=performance.now();this.account(this.stopAt);}this.sampler.stop();}
}
function nextFrame(signal:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{let id:number|undefined;const cancel=()=>{if(id!==undefined&&typeof cancelAnimationFrame==="function")cancelAnimationFrame(id);reject(new Error("Device test cancelled"));};if(signal.aborted){cancel();return;}signal.addEventListener("abort",cancel,{once:true});id=requestAnimationFrame(()=>{signal.removeEventListener("abort",cancel);resolve();});});}
/** Uses generated bytes only; never reads/exports a note, credential, or path. */
export async function runDeviceProbe(adapter:DataAdapter,pluginVersion:string,platform:string,lifecycle:DeviceLifecycleProbe,signal:AbortSignal,activity?:DeviceSyncActivityProbe):Promise<DeviceProbeReport>{
  const checkpoint=()=>{if(signal.aborted)throw new Error("Device test cancelled");},yieldNow=()=>new Promise<void>(resolve=>setTimeout(resolve,0)),idle=new FrameMetrics(),io=new FrameSampler(),epoch=()=>lifecycle.counts.hidden+lifecycle.counts.pagehide;let previous=performance.now(),wasHidden=lifecycle.hidden,previousEpoch=epoch();
  for(let index=0;index<24;index++){checkpoint();await nextFrame(signal);const now=performance.now();idle.add(now-previous,wasHidden||lifecycle.hidden||previousEpoch!==epoch());previous=now;wasHidden=lifecycle.hidden;previousEpoch=epoch();}
  const fileIo={appendSupported:typeof adapter.appendBinary==="function",resourceSupported:typeof adapter.getResourcePath==="function",testedBytes:0,verified:false};
  if(fileIo.appendSupported&&fileIo.resourceSupported){io.start(()=>lifecycle.hidden,()=>true,epoch);try{const root=".gib-sync/diagnostics",path=`${root}/${crypto.randomUUID()}.tmp`,bytes=new Uint8Array(1024*1024);for(let index=0;index<bytes.length;index++)bytes[index]=index%251;const expected=await hashBytes(bytes);checkpoint();if(!await adapter.exists(".gib-sync"))await adapter.mkdir(".gib-sync");if(!await adapter.exists(root))await adapter.mkdir(root);
    await adapter.writeBinary(path,new ArrayBuffer(0));try{for(let offset=0;offset<bytes.length;offset+=64*1024){checkpoint();await adapter.appendBinary(path,bytes.slice(offset,offset+64*1024).buffer);await yieldNow();}fileIo.testedBytes=bytes.length;fileIo.verified=await hashAdapterFile(adapter,path,checkpoint,yieldNow,false)===expected;if(!fileIo.verified)throw new Error("Generated test bytes failed native stream verification");}finally{try{const stat=await adapter.stat(path);if(stat?.type==="file"&&stat.size<=bytes.length){const prefixHash=stat.size===bytes.length?expected:await hashBytes(bytes.subarray(0,stat.size));if(await hashAdapterFile(adapter,path,()=>{},yieldNow,false)===prefixHash)await adapter.remove(path);}}catch{/* Unverified scratch is retained; deletion never relies on its filename alone. */}}
    }finally{io.stop();}
  }
  const actualSync=activity?.snapshot()??{observedMs:0,runningMs:0,startedRuns:0,completedRuns:0,interruptedRuns:0,stageMs:{},frames:new FrameMetrics().snapshot()};
  return {schemaVersion:2,pluginVersion,platform,sampledAt:new Date().toISOString(),frames:idle.snapshot(),responsiveness:{idle:idle.snapshot(),generatedIo:io.metrics.snapshot(),actualSync},lifecycle:{...lifecycle.counts},fileIo,evidence:{syntheticOnly:actualSync.startedRuns===0,realRunObserved:actualSync.startedRuns>0,fullScaleNotCertified:true}};
}
