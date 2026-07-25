import { describe,expect,it } from "vitest";
import type { ServerStatus } from "@gib-sync/protocol";
import { initialLiveStatus } from "./settings";
import { privacySafeDiagnostics } from "./diagnostics";

describe("privacy-safe diagnostics",()=>{
  it("does not copy personal endpoints, identities, paths, or activity text",()=>{
    const secret="personal-marker.example";const live=initialLiveStatus(true);live.message=secret;live.lastError=secret;live.lastResult=secret;live.activities=[{at:new Date(0).toISOString(),phase:"error",level:"error",message:secret}];
    const server={protocolVersion:5,vaultId:secret,vaultName:secret,deviceId:secret,deviceName:secret,deviceCount:1,snapshotCount:2,blobCount:3,blobBytes:4,head:{id:secret,vaultId:secret,parentId:null,deviceId:secret,deviceName:secret,createdAt:new Date(0).toISOString(),message:secret,entries:[{path:secret,hash:"a".repeat(64),size:1,mtime:1}]},
      storage:{seafileUrl:`https://${secret}`,username:`user@${secret}`,libraryId:secret,libraryName:secret,basePath:`/${secret}`,readablePath:`/${secret}`},serverTime:new Date(0).toISOString(),mirrorHeadId:secret,mirrorFileCount:1,mirrorCurrent:true,externalScanAt:null,externalImportAt:null,externalError:secret,
      safeguards:{policy:{mode:"balanced",deletionCount:10,smallVaultDeletionCount:5,smallVaultDeletionPercent:20,changedCount:100,changedPercent:30,folderImpactCount:20,fileGrowthBytes:1,fileGrowthPercent:500,clockSkewMinutes:10,protectedPaths:[secret]},writeLocked:false,writeLockedAt:null,writeLockedBy:secret,trustedUntil:null,pendingQuarantines:0},
      healthAlerts:[{code:`stale_device:${secret}`,level:"warning",message:secret,at:new Date(0).toISOString()}],devices:[{id:secret,name:secret,createdAt:new Date(0).toISOString(),lastSeenAt:new Date(0).toISOString(),revokedAt:null,ready:true,clockSkewMs:0,current:true}]} as ServerStatus;
    const copied=JSON.stringify(privacySafeDiagnostics(live,server,{configured:true,storageConfigured:true}));
    expect(copied).not.toContain(secret);expect(copied).not.toContain("username");expect(copied).not.toContain("vaultId");expect(copied).not.toContain("deviceId");expect(copied).not.toContain("path");
  });
});
