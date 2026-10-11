import { describe,expect,it } from "vitest";
import { initialLiveStatus } from "./settings";
import type { IndicatorState } from "./status";
import { buildQuickStatusModel,buildSyncFacts } from "./status-overview";

const state=(overrides:Partial<IndicatorState>={}):IndicatorState=>({
  key:"synced",label:"Synced",icon:"check",tone:"success",animated:false,attentionCount:0,description:"Up to date",...overrides
});

describe("truthful synchronization facts",()=>{
  const server=(overrides:Record<string,unknown>={})=>({head:{id:"current"},devices:[{id:"self",current:true,acknowledgedSnapshotId:"current",revokedAt:null},{id:"peer",current:false,ready:true,lastSeenAt:new Date().toISOString(),acknowledgedSnapshotId:"old",revokedAt:null}],mirrorCurrent:false,externalError:null,...overrides}) as never;
  it("does not mistake recently seen or onboarded peers for confirmed copies",()=>{
    const live={...initialLiveStatus(true),verified:true,lastSuccessAt:new Date().toISOString()};
    expect(buildSyncFacts(live,server(),"current")).toMatchObject([{label:"This device",value:"Up to date"},{label:"Accepted server copy",value:"Received"},{label:"Other devices",value:"0 of 1 confirmed",tone:"neutral"},{label:"Readable Seafile copy",value:"Catching up",tone:"active"}]);
  });
  it("only confirms active peers acknowledging the exact accepted head",()=>{
    const devices=[{current:true,revokedAt:null,acknowledgedSnapshotId:"current"},{current:false,revokedAt:null,acknowledgedSnapshotId:"current"},{current:false,revokedAt:"revoked",acknowledgedSnapshotId:"old"}];
    expect(buildSyncFacts(initialLiveStatus(true),server({devices}),"current")[2]).toMatchObject({value:"1 caught up",tone:"success"});
  });
  it("keeps unacknowledged legacy devices unconfirmed and local changes pending",()=>{
    const live={...initialLiveStatus(true),verified:true,pendingChanges:2};
    expect(buildSyncFacts(live,server({devices:[{current:false,ready:true,revokedAt:null}]}),"current").slice(0,3)).toMatchObject([{value:"2 changes waiting",tone:"active"},{value:"Waiting for this device"},{value:"0 of 1 confirmed"}]);
  });
  it("separates a failed projection from a healthy accepted server version",()=>{
    const facts=buildSyncFacts({...initialLiveStatus(true),verified:true},server({projection:{state:"retrying",lastError:"Storage temporarily unavailable"}}),"current");
    expect(facts[0].value).toBe("Up to date");expect(facts[1].value).toBe("Received");expect(facts[3]).toMatchObject({value:"Retrying safely",tone:"warning"});
  });
  it("does not infer verification from saved history or a missing status response",()=>{
    expect(buildSyncFacts(initialLiveStatus(true),null,"current")).toMatchObject([{value:"Checking",tone:"neutral"},{value:"Not verified"},{value:"Checking"},{value:"Checking"}]);
  });
});

describe("quick status popup model",()=>{
  it("keeps the healthy summary concise and useful",()=>{
    const live=initialLiveStatus(true);live.phase="up-to-date";live.lastSuccessAt="2026-08-15T12:00:00.000Z";live.lastResult="a very long technical result";
    expect(buildQuickStatusModel({state:state(),live,configured:true,nativeSyncBlocked:false,paused:false,now:Date.parse("2026-08-15T12:02:00.000Z")})).toEqual({
      description:"Your vault is up to date.",meta:"Last verified 2 min ago",primaryAction:"sync",primaryLabel:"Sync now",primaryDisabled:false
    });
  });

  it("shows practical progress while syncing",()=>{
    const live=initialLiveStatus(true);live.running=true;live.phase="uploading";live.message="Uploading changes";live.current=12;live.total=40;
    expect(buildQuickStatusModel({state:state({key:"syncing",label:"Syncing",tone:"active",description:"Syncing 12 of 40 files"}),live,configured:true,nativeSyncBlocked:false,paused:false})).toMatchObject({
      description:"Syncing 12 of 40 files",meta:"12 of 40 files",primaryLabel:"Syncing…",primaryDisabled:true
    });
  });

  it("prioritizes the action needed to continue",()=>{
    const live=initialLiveStatus(true);
    expect(buildQuickStatusModel({state:state({key:"attention",attentionCount:2}),live,configured:true,nativeSyncBlocked:false,paused:false})).toMatchObject({description:"2 held changes need review.",primaryAction:"review",primaryLabel:"Review"});
    expect(buildQuickStatusModel({state:state({key:"blocked"}),live,configured:true,nativeSyncBlocked:false,paused:true})).toMatchObject({description:"Automatic syncing is paused.",primaryAction:"resume",primaryLabel:"Resume"});
    expect(buildQuickStatusModel({state:state({key:"blocked"}),live,configured:true,nativeSyncBlocked:true,paused:false})).toMatchObject({description:"Turn off Obsidian Sync to continue safely.",primaryAction:"resolve",primaryLabel:"Resolve"});
    expect(buildQuickStatusModel({state:state({key:"blocked",description:"Emergency containment is protecting this vault"}),live,configured:true,nativeSyncBlocked:false,paused:false})).toMatchObject({description:"Emergency containment is protecting this vault",primaryLabel:"Server paused",primaryDisabled:true});
  });

  it("offers setup before a vault is connected",()=>{
    const live=initialLiveStatus(false);
    expect(buildQuickStatusModel({state:state({key:"setup"}),live,configured:false,nativeSyncBlocked:false,paused:false})).toMatchObject({description:"Connect this vault to start syncing.",meta:"Not connected",primaryAction:"setup",primaryLabel:"Set up"});
  });
});
