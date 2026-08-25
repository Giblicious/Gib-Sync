import { describe,expect,it } from "vitest";
import { initialLiveStatus } from "./settings";
import type { IndicatorState } from "./status";
import { buildQuickStatusModel } from "./status-overview";

const state=(overrides:Partial<IndicatorState>={}):IndicatorState=>({
  key:"synced",label:"Synced",icon:"check",tone:"success",animated:false,attentionCount:0,description:"Up to date",...overrides
});

describe("quick status popup model",()=>{
  it("keeps the healthy summary concise and useful",()=>{
    const live=initialLiveStatus(true);live.phase="up-to-date";live.lastSuccessAt="2026-08-15T12:00:00.000Z";live.lastResult="a very long technical result";
    expect(buildQuickStatusModel({state:state(),live,configured:true,nativeSyncBlocked:false,paused:false,now:Date.parse("2026-08-15T12:02:00.000Z")})).toEqual({
      description:"Your vault is up to date.",meta:"Last synced 2 min ago",primaryAction:"sync",primaryLabel:"Sync now",primaryDisabled:false
    });
  });

  it("shows practical progress while syncing",()=>{
    const live=initialLiveStatus(true);live.running=true;live.phase="uploading";live.message="Uploading changes";live.current=12;live.total=40;
    expect(buildQuickStatusModel({state:state({key:"syncing",label:"Syncing",tone:"active"}),live,configured:true,nativeSyncBlocked:false,paused:false})).toMatchObject({
      description:"Uploading changes",meta:"12 of 40 items",primaryLabel:"Syncing…",primaryDisabled:true
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
