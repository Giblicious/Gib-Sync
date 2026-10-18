/** Device-local identity: a Windows drive letter is a mount point, not a vault. */
export interface WindowsVaultLocation {
  version:1;volume:string;directory:string;relativePath:string;vaultName:string;
}
export type VaultLocationBinding=WindowsVaultLocation|{version:0};
type NativeStat={dev:number|bigint;ino:number|bigint;isDirectory:()=>boolean};
type ReadStat=(path:string)=>Promise<NativeStat>;
const identifier=(value:unknown):string|null=>{
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)return String(value);
  if(typeof value==='bigint'&&value>BigInt(0)&&value<=BigInt('18446744073709551615'))return String(value);
  return null;
};
function relativeWindowsPath(path:string):string|null{
  let normalized=path.replace(/\\/g,'/');
  if(/^\/\/\?\/[a-z]:\//i.test(normalized))normalized=normalized.slice(4);
  if(!/^[a-z]:\//i.test(normalized))return null;
  const relative=normalized.slice(2).replace(/\/+$/,'')||'/';
  if(relative!=='/'&&relative.slice(1).split('/').some(part=>!part||part==='.'||part==='..'||part.includes(':')||part.includes('\0')))return null;
  return relative.toLowerCase();
}
/** Invalid persisted bindings stay blocked rather than reverting to a weaker check. */
export function loadVaultLocationBinding(value:unknown):VaultLocationBinding|null{
  if(value===undefined||value===null)return null;
  if(!value||typeof value!=='object')return {version:0};
  const v=value as Record<string,unknown>;
  if(v.version!==1||typeof v.volume!=='string'||typeof v.directory!=='string'||!/^\d{1,20}$/.test(v.volume)||!/^\d{1,20}$/.test(v.directory)||identifier(BigInt(v.volume))!==v.volume||identifier(BigInt(v.directory))!==v.directory||typeof v.relativePath!=='string'||v.relativePath.length>32768||relativeWindowsPath('C:'+v.relativePath)!==v.relativePath||typeof v.vaultName!=='string'||!v.vaultName||v.vaultName.length>512)return {version:0};
  return {version:1,volume:v.volume,directory:v.directory,relativePath:v.relativePath,vaultName:v.vaultName.toLowerCase()};
}
export async function readWindowsVaultLocation(vaultName:string,basePath:string|null,desktop:boolean,readStat:ReadStat=async path=>{
  // Keep Node access lazy: mobile never loads a native module.
  if(typeof require!=='function')throw new Error('Native filesystem unavailable');
  return (require('fs') as typeof import('fs')).promises.stat(path,{bigint:true});
}):Promise<WindowsVaultLocation|null>{
  if(!desktop||!basePath||!vaultName)return null;
  const relativePath=relativeWindowsPath(basePath);if(relativePath===null)return null;
  try{
    const stat=await readStat(basePath),volume=identifier(stat.dev),directory=identifier(stat.ino);
    if(!stat.isDirectory()||!volume||!directory)return null;
    const name=relativePath==='/'&&/^[a-z]:?\/?$/i.test(vaultName.replace(/\\/g,'/'))?'@drive-root':vaultName.toLowerCase();
    return {version:1,volume,directory,relativePath,vaultName:name};
  }catch{return null;}
}
export function sameVaultLocation(saved:VaultLocationBinding,current:WindowsVaultLocation|null):boolean{
  return saved.version===1&&current!==null&&saved.volume===current.volume&&saved.directory===current.directory&&saved.relativePath===current.relativePath&&saved.vaultName===current.vaultName;
}
