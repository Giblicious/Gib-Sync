import type { ServerStatus } from "@gib-sync/protocol";
import type { LiveSyncStatus } from "./settings";

export function privacySafeDiagnostics(live:LiveSyncStatus,server:ServerStatus|null,connection:{configured:boolean;storageConfigured:boolean}){
  return {
    generatedAt:new Date().toISOString(),
    live:{phase:live.phase,running:live.running,current:live.current,total:live.total,startedAt:live.startedAt,completedAt:live.completedAt,lastSuccessAt:live.lastSuccessAt,lastErrorAt:live.lastErrorAt,nextSyncAt:live.nextSyncAt,
      activities:live.activities.map(({at,phase,level,current,total,repeats})=>({at,phase,level,current,total,repeats}))},
    server:server?{protocolVersion:server.protocolVersion,deviceCount:server.deviceCount,snapshotCount:server.snapshotCount,blobCount:server.blobCount,blobBytes:server.blobBytes,
      mirrorFileCount:server.mirrorFileCount,mirrorCurrent:server.mirrorCurrent,externalScanAt:server.externalScanAt,externalImportAt:server.externalImportAt,externalError:Boolean(server.externalError),
      compatibility:server.compatibility?{clientVersion:server.compatibility.clientVersion,clientProtocol:server.compatibility.clientProtocol,minimumVersion:server.compatibility.minimumVersion,recommendedVersion:server.compatibility.recommendedVersion,serverProtocol:server.compatibility.serverProtocol,compatible:server.compatibility.compatible,updateAvailable:server.compatibility.updateAvailable}:null,
      safeguards:{mode:server.safeguards.policy.mode,writeLocked:server.safeguards.writeLocked,pendingQuarantines:server.safeguards.pendingQuarantines},
      healthAlerts:server.healthAlerts.map(({code,level,at})=>({code:code.includes(":")?code.slice(0,code.indexOf(":")):code,level,at})),
      devices:server.devices.map(({ready,revokedAt,clockSkewMs,current,clientVersion,clientProtocol,compatibility})=>({ready,revoked:Boolean(revokedAt),clockSkewMs,current,clientVersion,clientProtocol,compatibility}))}:null,
    connection
  };
}

export function detailedDiagnostics(live:LiveSyncStatus,server:ServerStatus|null,connection:{configured:boolean;storageConfigured:boolean}){
  const safe=privacySafeDiagnostics(live,server,connection);
  const redact=(value:string)=>value.replace(/\bhttps?:\/\/[^\s)]+/gi,"<server-url>").replace(/\bBearer\s+[^\s]+/gi,"Bearer <redacted>");
  return {...safe,warning:"Detailed diagnostics may contain vault-relative file names. Saved credentials, keys, tokens, and connection settings are excluded; URLs in error and activity text are redacted.",
    live:{...safe.live,message:redact(live.message),lastError:redact(live.lastError),lastResult:redact(live.lastResult),activities:live.activities.map(({at,phase,level,message,current,total,repeats})=>({at,phase,level,message:redact(message),current,total,repeats}))}};
}
