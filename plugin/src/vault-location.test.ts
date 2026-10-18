import {describe,expect,it,vi} from 'vitest';
import {loadVaultLocationBinding,readWindowsVaultLocation,sameVaultLocation} from './vault-location';
const stat=(dev:bigint=BigInt(123),ino:bigint=BigInt('9007199254740993'))=>vi.fn(async()=>({dev,ino,isDirectory:()=>true}));
describe('portable Windows vault identity',()=>{
  it('keeps the same volume and folder trusted across drive letters without losing 64-bit file IDs',async()=>{
    const reader=stat(),before=await readWindowsVaultLocation('Notes','E:\\Portable\\Notes',true,reader),after=await readWindowsVaultLocation('notes','K:/portable/notes/',true,reader);
    expect(before?.directory).toBe('9007199254740993');expect(sameVaultLocation(before!,after)).toBe(true);expect(loadVaultLocationBinding(JSON.parse(JSON.stringify(before)))).toEqual(before);
  });
  it.each(['volume','directory','relativePath','vaultName']as const)('still rejects a different %s',async key=>{
    const binding=(await readWindowsVaultLocation('Notes','E:/Portable/Notes',true,stat()))!;
    expect(sameVaultLocation(binding,{...binding,[key]:key==='volume'||key==='directory'?'987':'different'})).toBe(false);
  });
  it('supports extended Windows paths and drive-root vaults',async()=>{
    const first=await readWindowsVaultLocation('E:','E:/',true,stat()),second=await readWindowsVaultLocation('K:','K:/',true,stat());expect(sameVaultLocation(first!,second)).toBe(true);
    expect(await readWindowsVaultLocation('Notes','\\\\?\\E:\\Portable\\Notes',true,stat())).toEqual(await readWindowsVaultLocation('Notes','E:/Portable/Notes',true,stat()));
  });
  it.each([['E:/Notes',false],['/storage/Notes',true],['//server/share/Notes',true],['E:Notes',true],['E:/a/../Notes',true],['E:/a//Notes',true]]as const)('does not read native metadata for unsupported path/context %s %s',async(path,desktop)=>{
    const reader=stat();expect(await readWindowsVaultLocation('Notes',path,desktop,reader)).toBeNull();expect(reader).not.toHaveBeenCalled();
  });
  it('does not accept unavailable, zero, imprecise or non-directory metadata',async()=>{
    const reader=vi.fn(async()=>{throw new Error('Disconnected drive');});expect(await readWindowsVaultLocation('Notes','E:/Notes',true,reader)).toBeNull();
    for(const value of [0,-1,Number.MAX_SAFE_INTEGER+1])expect(await readWindowsVaultLocation('Notes','E:/Notes',true,async()=>({dev:value,ino:1,isDirectory:()=>true}))).toBeNull();
    expect(await readWindowsVaultLocation('Notes','E:/Notes',true,async()=>({dev:1,ino:2,isDirectory:()=>false}))).toBeNull();
  });
  it.each([{},false,{version:1,volume:'NaN'},{version:99}, {version:1,volume:'1',directory:'2',relativePath:'/../notes',vaultName:'notes'}])('retains a blocked marker for corrupt saved metadata',value=>{
    expect(loadVaultLocationBinding(value)).toEqual({version:0});expect(sameVaultLocation({version:0},null)).toBe(false);
  });
  it('keeps absent bindings on the legacy path check',()=>{expect(loadVaultLocationBinding(undefined)).toBeNull();expect(loadVaultLocationBinding(null)).toBeNull();});
});
