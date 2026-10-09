import { describe,expect,it } from "vitest";
import { initialLiveStatus } from "./settings";
import { deriveIndicatorState } from "./status";

describe("status indicator state",()=>{
  it("prioritizes setup, native Sync blocking, and held changes",()=>{
    const live=initialLiveStatus(false);
    expect(deriveIndicatorState(live,false,false).key).toBe("setup");
    expect(deriveIndicatorState(initialLiveStatus(true),true,true).key).toBe("blocked");
    expect(deriveIndicatorState(initialLiveStatus(true),true,false,2)).toMatchObject({key:"attention",attentionCount:2});
  });
  it("distinguishes active, queued, failed, and synchronized states",()=>{
    const live=initialLiveStatus(true);live.running=true;live.phase="uploading";expect(deriveIndicatorState(live,true,false).key).toBe("syncing");
    live.running=false;live.phase="scheduled";live.pendingChanges=1;expect(deriveIndicatorState(live,true,false).key).toBe("queued");live.pendingChanges=0;
    live.phase="error";live.lastError="Offline";expect(deriveIndicatorState(live,true,false)).toMatchObject({key:"error",description:"Offline"});
    live.phase="up-to-date";live.verified=true;live.lastSuccessAt=new Date().toISOString();expect(deriveIndicatorState(live,true,false).key).toBe("synced");
  });
  it("always pulses a check while checking, using green only for verified devices without pending changes",()=>{
    const live=initialLiveStatus(true);live.running=true;live.phase="scanning";
    expect(deriveIndicatorState(live,true,false)).toMatchObject({key:"checking",icon:"check",tone:"neutral",animated:true});
    live.lastSuccessAt=new Date().toISOString();live.verified=true;
    expect(deriveIndicatorState(live,true,false)).toMatchObject({key:"checking",icon:"check",tone:"success",animated:true});
    live.pendingChanges=1;
    expect(deriveIndicatorState(live,true,false)).toMatchObject({key:"checking",icon:"check",tone:"neutral",animated:true});
    live.running=false;live.phase="up-to-date";
    expect(deriveIndicatorState(live,true,false).key).toBe("queued");
  });
  it("keeps the checking checkmark across every non-transfer engine phase",()=>{
    const live=initialLiveStatus(true);live.running=true;
    for(const phase of ["checking","scanning","reading-remote","merging"] as const){
      live.phase=phase;
      expect(deriveIndicatorState(live,true,false)).toMatchObject({key:"checking",icon:"check",tone:"neutral",animated:true});
    }
  });
  it("does not infer verification from a persisted successful sync or an idle phase",()=>{
    const live=initialLiveStatus(true);live.lastSuccessAt=new Date().toISOString();
    expect(deriveIndicatorState(live,true,false)).toMatchObject({key:"checking",tone:"neutral",animated:false});
  });
  it("shows retries and offline distinctly without masking server health errors",()=>{
    const live=initialLiveStatus(true);live.phase="retrying";live.running=true;
    expect(deriveIndicatorState(live,true,false)).toMatchObject({key:"retrying",tone:"active",animated:false});
    expect(deriveIndicatorState(live,true,false,0,{errors:1,warnings:0}).key).toBe("error");
    live.phase="offline";live.running=false;
    expect(deriveIndicatorState(live,true,false)).toMatchObject({key:"offline",tone:"neutral"});
    expect(deriveIndicatorState(live,true,false,0,{errors:1,warnings:0}).key).toBe("error");
    live.phase="uploading";live.running=true;
    expect(deriveIndicatorState(live,true,false,0,{errors:1,warnings:0}).key).toBe("error");
  });
  it("does not show green when the server reports a health problem",()=>{
    const live=initialLiveStatus(true);live.phase="up-to-date";
    expect(deriveIndicatorState(live,true,false,0,{errors:1,warnings:0,description:"Readable mirror failed"})).toMatchObject({key:"error",label:"Needs repair",description:"Readable mirror failed"});
    expect(deriveIndicatorState(live,true,false,0,{errors:0,warnings:1})).toMatchObject({key:"attention",tone:"warning"});
  });
});
