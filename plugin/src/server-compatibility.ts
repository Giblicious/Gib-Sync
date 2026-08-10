import { MINIMUM_SAFE_SERVER_VERSION,PROTOCOL_VERSION,REQUIRED_SERVER_CAPABILITIES,type ClientCompatibility,type SetupResponse } from "@gib-sync/protocol";

type ServerMetadata={protocolVersion?:number;serverVersion?:string|null;serverCapabilities?:string[]};

type Version={parts:[number,number,number];prerelease:boolean};
function parseVersion(value:string):Version|null{
  const match=/^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value.trim());
  return match?{parts:[Number(match[1]),Number(match[2]),Number(match[3])],prerelease:value.includes("-")}:null;
}

function olderThan(left:string,right:string):boolean{
  const a=parseVersion(left),b=parseVersion(right);if(!a||!b)return true;
  for(let index=0;index<3;index++){if(a.parts[index]!==b.parts[index])return a.parts[index]<b.parts[index];}
  return a.prerelease&&!b.prerelease;
}

export function staleServerReason(metadata:ServerMetadata):string|null{
  if(metadata.protocolVersion!==PROTOCOL_VERSION)return `This server uses protocol ${metadata.protocolVersion??"unknown"}; Gib Sync requires protocol ${PROTOCOL_VERSION}.`;
  if(!metadata.serverVersion||olderThan(metadata.serverVersion,MINIMUM_SAFE_SERVER_VERSION))return `Gib Sync server ${MINIMUM_SAFE_SERVER_VERSION} or later is required; this server reports ${metadata.serverVersion??"no version"}.`;
  const capabilities=new Set(Array.isArray(metadata.serverCapabilities)?metadata.serverCapabilities:[]),missing=REQUIRED_SERVER_CAPABILITIES.filter((item)=>!capabilities.has(item));
  return missing.length?`This Gib Sync server is missing required safety capabilities: ${missing.join(", ")}.`:null;
}

export function enforceServerCompatibility(result:ClientCompatibility):ClientCompatibility{
  const reason=result.reason??staleServerReason({protocolVersion:result.serverProtocol,serverVersion:result.serverVersion,serverCapabilities:result.serverCapabilities});
  return {...result,compatible:result.compatible&&reason===null,reason};
}

export function assertSetupServerCompatible(setup:Pick<SetupResponse,"protocolVersion"|"serverVersion"|"serverCapabilities">):void{
  const reason=staleServerReason(setup);if(reason)throw new Error(`${reason} Update the self-hosted Gib Sync server before connecting this device.`);
}

export function unavailableServerCompatibility(reason="This server does not expose a compatible version check."):ClientCompatibility{
  return {clientVersion:null,clientProtocol:null,minimumVersion:"unknown",recommendedVersion:"unknown",serverProtocol:-1,serverVersion:null,serverCapabilities:[],compatible:false,updateAvailable:false,reason};
}
