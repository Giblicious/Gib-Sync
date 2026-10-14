export const DIAGNOSTIC_PHASES=["not-configured","blocked","idle","scheduled","checking","retrying","offline","scanning","reading-remote","merging","applying","uploading","committing","mirroring","complete","up-to-date","error"] as const;
export const DIAGNOSTIC_REASONS=["none","incomplete-package","runtime-timeout","runtime-busy","runtime-retired","settings-write-failed","settings-changed","activation-unverified","unsupported-runtime","invalid-manifest","package-changed","file-not-regular","settings-budget","protected-old-save","connection","other"] as const;
export type DiagnosticReason=typeof DIAGNOSTIC_REASONS[number];
export interface DiagnosticFrames{samples:number;p95WindowSamples:number;p95Ms:number;maxGapMs:number;over50Ms:number;over100Ms:number;backgroundGaps:number;}
export interface DiagnosticSync{observedMs:number;runningMs:number;startedRuns:number;completedRuns:number;interruptedRuns:number;stageMs:Record<string,number>;frames:DiagnosticFrames;}
export interface NativeDeviceTestReport{schemaVersion:2;pluginVersion:string;platform:string;sampledAt:string;frames:DiagnosticFrames;responsiveness:{idle:DiagnosticFrames;generatedIo:DiagnosticFrames;actualSync:DiagnosticSync};lifecycle:{hidden:number;shown:number;pagehide:number;pageshow:number};fileIo:{appendSupported:boolean;resourceSupported:boolean;testedBytes:number;verified:boolean};evidence:{syntheticOnly:boolean;realRunObserved:boolean;fullScaleNotCertified:true};}
export interface DeviceDiagnosticReport{
  schemaVersion:1;reportId:string;pluginVersion:string;platform:"ios"|"android"|"desktop";sampledAt:string;
  live:{phase:typeof DIAGNOSTIC_PHASES[number];running:boolean;verified:boolean;pendingPaths:number;pendingApply:number;current:number;total:number;hasError:boolean;};
  packages:Array<{id:string;kind:"activation"|"incomplete"|"other";reasonCode:DiagnosticReason;at:number;attempts:number;retryAt:number;}>;
  activities:Array<{at:string;phase:typeof DIAGNOSTIC_PHASES[number];level:"info"|"success"|"warning"|"error";reasonCode:DiagnosticReason;}>;
  deviceTest?:NativeDeviceTestReport;
}
