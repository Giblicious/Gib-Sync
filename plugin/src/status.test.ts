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
    live.running=false;live.phase="scheduled";expect(deriveIndicatorState(live,true,false).key).toBe("queued");
    live.phase="error";live.lastError="Offline";expect(deriveIndicatorState(live,true,false)).toMatchObject({key:"error",description:"Offline"});
    live.phase="up-to-date";expect(deriveIndicatorState(live,true,false).key).toBe("synced");
  });
});
