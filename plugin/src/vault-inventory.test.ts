import {afterEach,describe,expect,it,vi} from 'vitest';
import type {DataAdapter} from 'obsidian';
import {VaultInventory} from './vault-inventory';
import {AdapterFileChangedError} from './file-io';
import {SyncCancelledError} from './sync-recovery';
afterEach(()=>vi.unstubAllGlobals());
function fixture(){
  const source=new TextEncoder().encode('Saved text with stale native metadata'),files=new Map<string,Uint8Array>([['note.md',source]]),dirs=new Set<string>();let reads=0,mtime=1;
  const adapter={stat:async(path:string)=>files.has(path)?{type:'file',size:path==='note.md'?0:files.get(path)!.length,mtime,ctime:1}:null,exists:async(path:string)=>files.has(path)||dirs.has(path),mkdir:async(path:string)=>{dirs.add(path);},readBinary:async(path:string)=>{if(path==='note.md')reads++;return files.get(path)!.slice().buffer;},writeBinary:async(path:string,bytes:ArrayBuffer)=>{files.set(path,new Uint8Array(bytes));},list:async()=>({files:[...files.keys()].filter(p=>p.startsWith('.gib-sync/inventory-v2/')),folders:[]}),getResourcePath:(path:string)=>'https://resource.test/'+encodeURIComponent(path)} as unknown as DataAdapter;
  vi.stubGlobal('fetch',async(url:string)=>new Response(files.get(decodeURIComponent(url.slice('https://resource.test/'.length)))!.slice()));
  const inventory=()=>new VaultInventory(adapter,()=> 'owned-fixture',async()=>{});
  return {adapter,source,files,inventory,get reads(){return reads;},change(){mtime++;}};
}
describe('byte-authoritative inventory with weak native size hints',()=>{
  it('keeps the actual saved length separate from its stale metadata hint without re-reading unchanged content',async()=>{const f=fixture(),i=f.inventory(),first=await i.inspect('note.md');expect(first?.size).toBe(f.source.length);expect(first?.metadataSize).toBe(0);expect(f.reads).toBe(1);expect(await i.inspect('note.md')).toEqual(first);expect(f.reads).toBe(1);});
  it('preserves both sizes on reload and requires fresh verification in the new process',async()=>{const f=fixture(),i=f.inventory();await i.inspect('note.md');await i.flush();const next=f.inventory();await next.ready();expect(next.known('note.md')?.size).toBe(f.source.length);expect(next.known('note.md')?.metadataSize).toBe(0);expect(next.pendingVerification).toBe(1);await next.verifyStep();expect(next.pendingVerification).toBe(0);expect(f.reads).toBe(2);});
  it('still revalidates dirty content even when the native stamp did not change',async()=>{const f=fixture(),i=f.inventory(),first=await i.inspect('note.md');f.files.set('note.md',new TextEncoder().encode('New saved text'));i.markDirty('note.md');const after=await i.inspect('note.md');expect(after?.hash).not.toBe(first?.hash);expect(after?.size).toBe(14);expect(f.reads).toBe(2);});
  it('does not confuse a cached metadata hint with a read generation race',async()=>{const f=fixture();let i:VaultInventory;vi.stubGlobal('fetch',async()=>{i.markDirty('note.md');return new Response(f.source.slice());});i=f.inventory();await expect(i.inspect('note.md')).rejects.toBeInstanceOf(AdapterFileChangedError);expect(i.known('note.md')).toBeUndefined();});
  it('retries an interrupted cache load and still verifies dirty saved content',async()=>{
    const f=fixture(),prior=f.inventory();await prior.inspect('note.md');await prior.flush();
    let cancelled=true;const next=new VaultInventory(f.adapter,()=> 'owned-fixture',async()=>{},()=>true,()=>{if(cancelled)throw new SyncCancelledError('Test pause');});
    next.markDirty('note.md');await expect(next.ready()).rejects.toBeInstanceOf(SyncCancelledError);
    cancelled=false;f.files.set('note.md',new TextEncoder().encode('Saved while paused'));
    await next.ready();expect(next.pendingVerification).toBe(1);
    const actual=await next.inspect('note.md');expect(actual?.size).toBe(18);expect(actual?.hash).not.toBe(prior.known('note.md')?.hash);expect(next.pendingVerification).toBe(0);
  });
});
