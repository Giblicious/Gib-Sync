export interface ClientCompatibilityInput{clientVersion:string|null;clientProtocol:number|null;minimumVersion:string;recommendedVersion:string;serverProtocol:number;}
export interface ClientCompatibilityResult{clientVersion:string|null;clientProtocol:number|null;minimumVersion:string;recommendedVersion:string;serverProtocol:number;compatible:boolean;updateAvailable:boolean;reason:string|null;}

type Version={parts:[number,number,number];prerelease:string[]};
export function parseVersion(value:string):Version|null{
  const match=/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());if(!match)return null;
  return {parts:[Number(match[1]),Number(match[2]),Number(match[3])],prerelease:match[4]?.split(".")??[]};
}
export function compareVersions(left:string,right:string):number{
  const a=parseVersion(left),b=parseVersion(right);if(!a||!b)throw new Error(`Invalid semantic version: ${!a?left:right}`);
  for(let index=0;index<3;index++){const difference=a.parts[index]-b.parts[index];if(difference)return Math.sign(difference);}
  if(!a.prerelease.length&&!b.prerelease.length)return 0;if(!a.prerelease.length)return 1;if(!b.prerelease.length)return -1;
  for(let index=0;index<Math.max(a.prerelease.length,b.prerelease.length);index++){
    const x=a.prerelease[index],y=b.prerelease[index];if(x===undefined)return -1;if(y===undefined)return 1;if(x===y)continue;
    const xn=/^\d+$/.test(x),yn=/^\d+$/.test(y);if(xn&&yn)return Math.sign(Number(x)-Number(y));if(xn!==yn)return xn?-1:1;return x<y?-1:1;
  }
  return 0;
}
export function clientCompatibility(input:ClientCompatibilityInput):ClientCompatibilityResult{
  const {clientVersion,clientProtocol,minimumVersion,recommendedVersion,serverProtocol}=input;let reason:string|null=null;
  if(clientProtocol!==serverProtocol)reason=clientProtocol===null?"This Gib Sync client does not report a protocol version and must be updated.":`This client uses protocol ${clientProtocol}; the server requires protocol ${serverProtocol}.`;
  else if(!clientVersion||!parseVersion(clientVersion))reason="This Gib Sync client does not report a valid version and must be updated.";
  else if(compareVersions(clientVersion,minimumVersion)<0)reason=`Gib Sync ${minimumVersion} or later is required; this device has ${clientVersion}.`;
  const updateAvailable=Boolean(clientVersion&&parseVersion(clientVersion)&&compareVersions(clientVersion,recommendedVersion)<0);
  return {...input,compatible:reason===null,updateAvailable,reason};
}
