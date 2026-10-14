import {DIAGNOSTIC_PHASES,type DeviceDiagnosticReport,type DiagnosticReason,type NativeDeviceTestReport} from '@gib-sync/protocol';
import type {GibSyncSettings,LiveSyncStatus} from './settings';
import type {DeviceProbeReport} from './device-diagnostics';
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,Math.round(v))):0;
const metric=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,v)):0;
const phase=(v:string)=>DIAGNOSTIC_PHASES.includes(v as typeof DIAGNOSTIC_PHASES[number])?v as typeof DIAGNOSTIC_PHASES[number]:'error';
const date=(v:string)=>Number.isFinite(Date.parse(v))?new Date(v).toISOString():new Date().toISOString();
export function diagnosticReason(text:string):DiagnosticReason{
  if(!text)return 'none';const v=text.toLowerCase();
  if(v.includes('timed out')||v.includes('timeout'))return 'runtime-timeout';
  if(v.includes('earlier')||v.includes('unfinished')||v.includes('still working')||v.includes('not finished')||v.includes('owns this'))return 'runtime-busy';
  if(v.includes('disposed')||v.includes('retired runtime')||v.includes('ownership changed')||v.includes('owner changed'))return 'runtime-retired';
  if(v.includes('incomplete')||v.includes('complete plugin'))return 'incomplete-package';
  if(v.includes('write failed')||v.includes('write failure'))return 'settings-write-failed';
  if(v.includes('settings changed')||v.includes('settings recovery'))return 'settings-changed';
  if(v.includes('old')&&v.includes('save')&&v.includes('protect'))return 'protected-old-save';
  if(v.includes('manifest')&&v.includes('invalid'))return 'invalid-manifest';
  if(v.includes('unsupported')||v.includes('manager is unavailable')||v.includes('cannot safely refresh'))return 'unsupported-runtime';
  if(v.includes('not a regular file'))return 'file-not-regular';
  if(v.includes('budget'))return 'settings-budget';
  if(v.includes('activation')||v.includes('fresh plugin settings'))return 'activation-unverified';
  if(v.includes('plugin changed')||v.includes('outside the verified runtime fence'))return 'package-changed';
  if(v.includes('connection')||v.includes('reconnect')||v.includes('offline'))return 'connection';
  return 'other';
}
function nativeReport(r:DeviceProbeReport):NativeDeviceTestReport{
  const frames=(v:DeviceProbeReport['frames'])=>({samples:number(v.samples),p95WindowSamples:Math.min(1024,number(v.p95WindowSamples)),p95Ms:metric(v.p95Ms),maxGapMs:metric(v.maxGapMs),over50Ms:number(v.over50Ms),over100Ms:number(v.over100Ms),backgroundGaps:number(v.backgroundGaps)}),s=r.responsiveness.actualSync,stages=['checking','scanning','reading-remote','merging','applying','uploading','committing','mirroring','retrying','other'];
  return {schemaVersion:2,pluginVersion:r.pluginVersion,platform:r.platform,sampledAt:date(r.sampledAt),frames:frames(r.frames),responsiveness:{idle:frames(r.responsiveness.idle),generatedIo:frames(r.responsiveness.generatedIo),actualSync:{observedMs:number(s.observedMs),runningMs:number(s.runningMs),startedRuns:number(s.startedRuns),completedRuns:number(s.completedRuns),interruptedRuns:number(s.interruptedRuns),stageMs:Object.fromEntries(stages.filter(k=>s.stageMs[k]!==undefined).map(k=>[k,number(s.stageMs[k])])),frames:frames(s.frames)}},lifecycle:{hidden:number(r.lifecycle.hidden),shown:number(r.lifecycle.shown),pagehide:number(r.lifecycle.pagehide),pageshow:number(r.lifecycle.pageshow)},fileIo:{appendSupported:r.fileIo.appendSupported===true,resourceSupported:r.fileIo.resourceSupported===true,testedBytes:Math.min(1048576,number(r.fileIo.testedBytes)),verified:r.fileIo.verified===true},evidence:{syntheticOnly:r.evidence.syntheticOnly===true,realRunObserved:r.evidence.realRunObserved===true,fullScaleNotCertified:true}};
}
export function serverDiagnosticReport(settings:GibSyncSettings,live:LiveSyncStatus,pluginVersion:string,platform:DeviceDiagnosticReport['platform'],test?:DeviceProbeReport):DeviceDiagnosticReport{
  return {schemaVersion:1,reportId:crypto.randomUUID(),pluginVersion,platform,sampledAt:new Date().toISOString(),live:{phase:phase(live.phase),running:live.running===true,verified:live.verified===true,pendingPaths:settings.pendingPaths.length,pendingApply:settings.pendingApplyPaths.length,current:number(live.current),total:number(live.total),hasError:Boolean(live.lastError)},packages:Object.entries(settings.packageHolds).filter(([id])=>/^[a-z0-9][a-z0-9_-]{0,99}$/.test(id)).slice(0,32).map(([id,h])=>({id,kind:h.kind==='activation'||h.kind==='incomplete'?h.kind:'other',reasonCode:diagnosticReason(h.reason),at:number(h.at),attempts:number(h.attempts),retryAt:number(h.retryAt)})),activities:live.activities.slice(-32).map(a=>({at:date(a.at),phase:phase(a.phase),level:a.level,reasonCode:diagnosticReason(a.message)})),...(test&&test.pluginVersion===pluginVersion&&test.platform===platform?{deviceTest:nativeReport(test)}:{})};
}
export interface DiagnosticConnection{serverUrl:string;vaultId:string;deviceId:string;token:string;enabled:boolean;supported:boolean;}
/** Bounded, separate transport: diagnostics never hold up reconciliation. */
export class ServerDiagnosticReporter{
  private queue:Array<{report:DeviceDiagnosticReport;important:boolean}>=[];private timer:ReturnType<typeof setTimeout>|undefined;private sending=false;private stopped=false;private identity='';private lastFingerprint='';private nextAttempt=0;private failures=0;
  constructor(private readonly connection:()=>DiagnosticConnection,private readonly capture:()=>DeviceDiagnosticReport,private readonly send:(connection:DiagnosticConnection,report:DeviceDiagnosticReport)=>Promise<unknown>){}
  private scope(c:DiagnosticConnection){return JSON.stringify([c.serverUrl,c.vaultId,c.deviceId,c.token]);}
  notify(){if(this.stopped)return;const c=this.connection(),identity=this.scope(c);if(identity!==this.identity||!c.enabled){this.identity=identity;this.queue=[];this.lastFingerprint='';this.failures=0;this.nextAttempt=0;if(this.timer)clearTimeout(this.timer);this.timer=undefined;}if(!c.enabled||!c.supported||!c.token||!c.vaultId||!c.deviceId)return;
    const report=this.capture(),{reportId:_,sampledAt:__,...content}=report,fingerprint=JSON.stringify(content);if(fingerprint===this.lastFingerprint)return;this.lastFingerprint=fingerprint;
    const important=report.packages.length>0||report.live.phase==='error'||report.live.phase==='offline';
    if(!important)this.queue=this.queue.filter(item=>item.important);this.queue.push({report,important});if(this.queue.length>8){const healthy=this.queue.findIndex(item=>!item.important);this.queue.splice(healthy>=0&&healthy<this.queue.length-1?healthy:0,1);}this.schedule();
  }
  private schedule(){if(this.stopped||this.sending||this.timer||!this.queue.length)return;this.timer=setTimeout(()=>{this.timer=undefined;void this.flush();},Math.max(1000,this.nextAttempt-Date.now()));}
  async flush(){if(this.stopped||this.sending)return;const c=this.connection(),identity=this.scope(c);if(!c.enabled||!c.supported||identity!==this.identity){this.queue=[];this.lastFingerprint='';return;}const item=this.queue[0];if(!item)return;this.sending=true;
    try{await this.send({...c},item.report);if(this.identity===identity){this.queue=this.queue.filter(v=>v!==item);this.failures=0;this.nextAttempt=Date.now()+5000;}}
    catch{if(this.identity===identity){this.failures++;this.nextAttempt=Date.now()+Math.min(60000,15000*this.failures);}}
    finally{this.sending=false;this.schedule();}
  }
  stop(){this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.queue=[];}
}
