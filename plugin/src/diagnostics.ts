import type { ServerStatus } from "@gib-sync/protocol";
import type { LiveSyncStatus } from "./settings";

export function privacySafeDiagnostics(live:LiveSyncStatus,server:ServerStatus|null,connection:{configured:boolean;storageConfigured:boolean}){
  return {
    generatedAt:new Date().toISOString(),
    live:{phase:live.phase,running:live.running,current:live.current,total:live.total,startedAt:live.startedAt,completedAt:live.completedAt,lastSuccessAt:live.lastSuccessAt,lastErrorAt:live.lastErrorAt,nextSyncAt:live.nextSyncAt,
      activities:live.activities.map(({at,phase,level,current,total})=>({at,phase,level,current,total}))},
    server:server?{protocolVersion:server.protocolVersion,deviceCount:server.deviceCount,snapshotCount:server.snapshotCount,blobCount:server.blobCount,blobBytes:server.blobBytes,
      mirrorFileCount:server.mirrorFileCount,mirrorCurrent:server.mirrorCurrent,externalScanAt:server.externalScanAt,externalImportAt:server.externalImportAt,externalError:Boolean(server.externalError),
      safeguards:{mode:server.safeguards.policy.mode,writeLocked:server.safeguards.writeLocked,pendingQuarantines:server.safeguards.pendingQuarantines},
      healthAlerts:server.healthAlerts.map(({code,level,at})=>({code:code.includes(":")?code.slice(0,code.indexOf(":")):code,level,at})),
      devices:server.devices.map(({ready,revokedAt,clockSkewMs,current})=>({ready,revoked:Boolean(revokedAt),clockSkewMs,current}))}:null,
    connection
  };
}
