import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,stat,rm} from 'node:fs/promises';
import {join,parse,resolve,relative,isAbsolute} from 'node:path';
import {readWindowsVaultLocation,sameVaultLocation} from './vault-location';

it.skipIf(process.platform!=='win32')('recognizes the same native Windows directory through a different drive letter',async()=>{
  const workspace=resolve(process.cwd()),parent=join(workspace,'test-vault');await mkdir(parent,{recursive:true});
  const owned=await mkdtemp(join(parent,'portable-binding-')),vault=join(owned,'Notes');await mkdir(vault);
  const driveRoot=parse(vault).root,used=new Set(execFileSync('powershell.exe',['-NoProfile','-Command','Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Name'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).map(v=>v.toUpperCase()));
  const letter=[...'ZYXWVUTSRQPONMLKJIHGFED'].find(v=>!used.has(v));if(!letter)throw new Error('No unused test drive alias');
  let mapped=false;
  try{
    execFileSync('subst.exe',[letter+':',driveRoot],{windowsHide:true});mapped=true;
    const alias=letter+':\\'+relative(driveRoot,vault),read=(path:string)=>stat(path,{bigint:true});
    const before=await readWindowsVaultLocation('Notes',vault,true,read),after=await readWindowsVaultLocation('Notes',alias,true,read);
    expect(before).not.toBeNull();expect(after).not.toBeNull();expect(before?.relativePath).toBe(after?.relativePath);expect(sameVaultLocation(before!,after)).toBe(true);
  }finally{
    if(mapped){
      const mapping=execFileSync('subst.exe',[],{encoding:'utf8',windowsHide:true}).split(/\r?\n/).find(line=>line.toUpperCase().startsWith(letter+':\\: => '));
      if(!mapping||mapping.split(' => ')[1]?.toLowerCase()!==driveRoot.toLowerCase())throw new Error('Test drive ownership changed; mapping retained');
      execFileSync('subst.exe',[letter+':','/D'],{windowsHide:true});
    }
    const distance=relative(workspace,resolve(owned));if(!distance||isAbsolute(distance)||distance.startsWith('..'))throw new Error('Refuse cleanup outside test workspace');
    await rm(owned,{recursive:true,force:true});
  }
});
