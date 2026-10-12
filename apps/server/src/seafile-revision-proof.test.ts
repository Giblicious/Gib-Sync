import {mkdtempSync,rmSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Config} from './config.js';
import {PrivateStaging} from './security-stream.js';
import {RevisionMissingError,SeafileStorage,type VaultStorageRow} from './seafile.js';
import {VerifiedBlobStore} from './blob-store.js';
import type {Store} from './db.js';

const roots:string[]=[];
afterEach(()=>{vi.unstubAllGlobals();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const commit='b'.repeat(40),objectId='a'.repeat(40),bytes=Buffer.from('immutable original');
type Mode='legacy'|'stream'|'sidecar';
const config={SEAFILE_URL:'https://seafile.example.test',SEAFILE_ALLOWED_HOSTS:'seafile.example.test',GIBSYNC_SERVER_SECRET:'fixture-secret-at-least-thirty-two-characters',MAX_BLOB_BYTES:1024} as Config;
function fixture(mode:Mode='legacy'){
  const root=mkdtempSync(join(tmpdir(),'gib-sync-revision-'));roots.push(root);
  const storage=new SeafileStorage(config),staging=new PrivateStaging(root),id='11111111-1111-4111-8111-111111111111';
  const row={id,storage_url:config.SEAFILE_URL,storage_username:'fixture@example.test',storage_repo_id:'fixture',storage_repo_name:'Notes',storage_base_path:'/Notes',storage_token:storage.sealToken(id,'fixture-token'),storage_layout:'standard',mirror_base_path:'/Notes',mirror_head_id:null} as VaultStorageRow;
  const target=mode==='sidecar'?'/Notes/.gib-sync/mutation-fences/test.gbs':'/Notes/note.md',listings=new Map<string,unknown>();
  const parts=target.split('/').filter(Boolean);let parent='/';
  for(let index=0;index<parts.length;index++){
    listings.set(parent,{dirent_list:[{name:parts[index],type:index===parts.length-1?'file':'dir',parent_dir:parent,obj_id:objectId,...(index===parts.length-1?{size:bytes.length}:{})}]});parent=`${parent==='/'?'':parent}/${parts[index]}`;
  }
  const state={commitStatus:200,commitBody:{commit_info:{},commit_diffs:[]} as unknown,linkStatus:200,downloadStatus:200,downloadBytes:bytes,oid:objectId};
  const calls:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request)=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);calls.push(url.pathname+url.search);
    if(/\/commits\/[a-f0-9]{40}\/$/i.test(url.pathname))return state.commitStatus===200?Response.json(state.commitBody):new Response('unavailable',{status:state.commitStatus});
    if(url.pathname.endsWith('/dir/')){const value=listings.get(url.searchParams.get('path')!);return typeof value==='number'?new Response('unavailable',{status:value}):value===undefined?new Response('unsupported',{status:404}):Response.json(value);}
    if(url.pathname.endsWith('/file/revision/'))return state.linkStatus===200?Response.json('https://download.example.test/immutable',{headers:{oid:state.oid}}):new Response('backend revision error',{status:state.linkStatus});
    if(url.hostname==='download.example.test')return new Response(state.downloadBytes,{status:state.downloadStatus});
    throw new Error('Unexpected endpoint: no current-file fallback is permitted');
  }));
  async function read(revision=commit):Promise<Uint8Array>{
    if(mode==='sidecar')return storage.getSidecarRevision(row,'mutation-fences/test.gbs',revision);
    if(mode==='legacy')return storage.getReadableRevision(row,'note.md',revision);
    const file=await storage.getReadableRevisionToFile(row,'note.md',revision,staging);try{return await readFile(file.path);}finally{await file.dispose();}
  }
  return {storage,row,listings,state,calls,read,staging,root};
}
const revisionCalls=(calls:string[])=>calls.filter(path=>path.includes('/file/revision/'));
async function unavailable(operation:Promise<unknown>){const error=await operation.catch(error=>error);expect(error).toBeInstanceOf(Error);expect(error).not.toBeInstanceOf(RevisionMissingError);return error;}

describe.each(['legacy','stream','sidecar'] as Mode[])('%s exact-commit presence proof',mode=>{
  it('proves absence from a complete typed directory without invoking the backend absent-file 500',async()=>{
    const {listings,state,calls,read}=fixture(mode);listings.set(mode==='sidecar'?'/Notes/.gib-sync/mutation-fences':'/Notes',{dirent_list:[]});state.linkStatus=500;
    await expect(read()).rejects.toBeInstanceOf(RevisionMissingError);expect(revisionCalls(calls)).toEqual([]);
  });
  it('proves an absent ancestor from root evidence, not an ambiguous parent-directory 404',async()=>{
    const {listings,calls,read}=fixture(mode);listings.set('/',{dirent_list:[]});
    await expect(read()).rejects.toBeInstanceOf(RevisionMissingError);expect(calls.filter(path=>path.includes('/dir/'))).toHaveLength(1);expect(revisionCalls(calls)).toEqual([]);
  });
  it.each([404,500])('fails closed for a proven-present file whose revision endpoint returns %i',async status=>{
    const {state,calls,read}=fixture(mode);state.linkStatus=status;await unavailable(read());expect(revisionCalls(calls)).toHaveLength(1);expect(calls.some(path=>/\/file\/\?/.test(path))).toBe(false);
  });
  it('fails closed if a proven-present revision download is missing',async()=>{const {state,read}=fixture(mode);state.downloadStatus=404;await unavailable(read());});
  it('does not mistake missing or malformed commit proof for file absence',async()=>{
    const {state,calls,read}=fixture(mode);state.commitStatus=404;await unavailable(read());expect(calls).toHaveLength(1);state.commitStatus=200;state.commitBody={commit_diffs:[]};await unavailable(read());expect(revisionCalls(calls)).toEqual([]);
  });
  it('rejects an invalid commit without issuing a request',async()=>{const {calls,read}=fixture(mode);await unavailable(read('invalid'));expect(calls).toEqual([]);});
  it('does not classify an unsupported historical root endpoint as absence',async()=>{const {listings,read}=fixture(mode);listings.set('/',404);await unavailable(read());});
  it('does not classify a claimed-present but unavailable child directory as absence',async()=>{const {listings,read}=fixture(mode);listings.set('/Notes',404);await unavailable(read());});
  it.each([
    {dirent_list:[],more:true},
    {dirent_list:[{type:'unknown',name:'Notes',parent_dir:'/',obj_id:objectId}]},
    {dirent_list:[{type:'dir',name:'Notes',parent_dir:'/wrong',obj_id:objectId}]},
    {dirent_list:[{type:'dir',name:'Notes',parent_dir:'/',obj_id:'invalid'}]},
    {dirent_list:[{type:'dir',name:'Notes',parent_dir:'/',obj_id:objectId},{type:'dir',name:'Notes',parent_dir:'/',obj_id:objectId}]}
  ])('fails closed when typed listing completeness or identity is ambiguous: %j',async listing=>{const {listings,read}=fixture(mode);listings.set('/',listing);await unavailable(read());});
  it('returns only the proven exact-revision bytes and reuses bounded immutable directory evidence',async()=>{
    const {calls,read}=fixture(mode);expect(Buffer.from(await read())).toEqual(bytes);const directoryCount=calls.filter(path=>path.includes('/dir/')).length;expect(Buffer.from(await read())).toEqual(bytes);expect(calls.filter(path=>path.includes('/dir/'))).toHaveLength(directoryCount);expect(calls.filter(path=>/\/commits\/[a-f0-9]{40}\/$/.test(path))).toHaveLength(2);
  });
  it('rejects a different returned object identity or byte size',async()=>{const {state,read}=fixture(mode);state.oid='c'.repeat(40);await unavailable(read());state.oid=objectId;state.downloadBytes=Buffer.from('short');await unavailable(read());});
});

describe('immutable subtree proof',()=>{
  it('returns empty only when a complete parent listing proves the retired subtree absent',async()=>{const {storage,row,listings}=fixture();expect(await storage.readableRevisionTree(row,'Retired',commit)).toEqual({files:[],folders:[]});listings.set('/',404);await unavailable(storage.readableRevisionTree(row,'Retired','c'.repeat(40)));});
  it('fails closed when a listed descendant directory is unavailable',async()=>{const {storage,row,listings}=fixture();listings.set('/Notes',{dirent_list:[{type:'dir',name:'Retired',parent_dir:'/Notes',obj_id:objectId}]});listings.set('/Notes/Retired',{dirent_list:[{type:'dir',name:'Child',parent_dir:'/Notes/Retired',obj_id:objectId}]});listings.set('/Notes/Retired/Child',404);await unavailable(storage.readableRevisionTree(row,'Retired',commit));});
  it('walks and validates every historical subtree entry',async()=>{const {storage,row,listings}=fixture();listings.set('/Notes',{dirent_list:[{type:'dir',name:'Retired',parent_dir:'/Notes',obj_id:objectId}]});listings.set('/Notes/Retired',{dirent_list:[{type:'file',name:'note.md',parent_dir:'/Notes/Retired',obj_id:objectId,size:bytes.length},{type:'dir',name:'Empty',parent_dir:'/Notes/Retired',obj_id:objectId}]});listings.set('/Notes/Retired/Empty',{dirent_list:[]});expect(await storage.readableRevisionTree(row,'Retired',commit)).toEqual({files:[{path:'Retired/note.md',id:objectId,size:bytes.length,mtime:0}],folders:['Retired','Retired/Empty']});});
  it('does not reuse absence evidence across immutable commits',async()=>{const {read,listings}=fixture();listings.set('/Notes',{dirent_list:[]});await expect(read()).rejects.toBeInstanceOf(RevisionMissingError);listings.set('/Notes',{dirent_list:[{type:'file',name:'note.md',parent_dir:'/Notes',obj_id:objectId,size:bytes.length}]});expect(Buffer.from(await read('c'.repeat(40)))).toEqual(bytes);});
  it('bounds retained immutable directory listings by evicting old commit evidence',async()=>{const {calls,read}=fixture();await read();const first=calls.filter(path=>path.includes(`/commits/${commit}/dir/`)).length;for(let index=1;index<=65;index++)await read(index.toString(16).padStart(40,'0'));await read();expect(calls.filter(path=>path.includes(`/commits/${commit}/dir/`))).toHaveLength(first*2);});
});

async function capturedEntry(){
  const f=fixture();f.listings.set('/Notes',{dirent_list:[{type:'dir',name:'Retired',parent_dir:'/Notes',obj_id:objectId}]});
  f.listings.set('/Notes/Retired',{dirent_list:[{type:'file',name:'note.md',parent_dir:'/Notes/Retired',obj_id:objectId,size:bytes.length}]});
  const tree=await f.storage.readableRevisionTree(f.row,'Retired',commit);return {...f,entry:tree.files[0]!};
}
describe('storage-minted bounded historical-tree capabilities',()=>{
  it('passes the original validated entry through VerifiedBlobStore without re-enumerating its historical parents',async()=>{
    const {storage,row,entry,root,calls,state}=await capturedEntry(),blobs=new VerifiedBlobStore({...config,DATA_DIR:root},{} as Store,storage),metadataCount=calls.length;
    state.commitStatus=500;const file=await blobs.readable(row,entry.path,commit,undefined,entry);try{expect(Buffer.from(await readFile(file.path))).toEqual(bytes);}finally{await file.dispose();}
    expect(calls.slice(metadataCount)).toHaveLength(2);expect(calls.slice(metadataCount).some(path=>path.includes('/commits/'))).toBe(false);
  });
  it.each(['clone','prototype','forged'] as const)('rejects a %s entry rather than treating its public fields as authority',async kind=>{
    const {storage,row,entry,staging,calls}=await capturedEntry(),untrusted=kind==='clone'?{...entry}:kind==='prototype'?Object.create(entry):{path:entry.path,id:entry.id,size:entry.size,mtime:entry.mtime},before=calls.length;
    await expect(storage.getReadableRevisionToFile(row,entry.path,commit,staging,undefined,untrusted)).rejects.toThrow('capability');expect(calls).toHaveLength(before);
  });
  it.each(['path','id','size','mtime'] as const)('rejects an original capability whose %s metadata was mutated',async field=>{
    const {storage,row,entry,staging,calls}=await capturedEntry(),path=entry.path,before=calls.length;
    if(field==='path')entry.path='Retired/other.md';else if(field==='id')entry.id='c'.repeat(40);else entry[field]++;
    await expect(storage.getReadableRevisionToFile(row,path,commit,staging,undefined,entry)).rejects.toThrow('capability');expect(calls).toHaveLength(before);
  });
  it.each(['vault','server','repo','mirror','commit','path','instance'] as const)('rejects an original entry used with a different %s scope',async scope=>{
    const {storage,row,entry,staging,calls}=await capturedEntry(),altered={...row},before=calls.length;
    if(scope==='vault'){altered.id='22222222-2222-4222-8222-222222222222';altered.storage_token=storage.sealToken(altered.id,'fixture-token');}
    if(scope==='server')altered.storage_url='https://different.example.test';if(scope==='repo')altered.storage_repo_id='different';if(scope==='mirror')altered.mirror_base_path='/Different';
    const target=scope==='instance'?new SeafileStorage(config):storage;
    await expect(target.getReadableRevisionToFile(altered,scope==='path'?'Retired/other.md':entry.path,scope==='commit'?'c'.repeat(40):commit,staging,undefined,entry)).rejects.toThrow('capability');expect(calls).toHaveLength(before);
  });
  it('retains immutable OID and streamed byte-size checks when using a minted proof',async()=>{
    const {storage,row,entry,staging,state}=await capturedEntry();state.oid='c'.repeat(40);await expect(storage.getReadableRevisionToFile(row,entry.path,commit,staging,undefined,entry)).rejects.toThrow('identity');
    state.oid=objectId;state.downloadBytes=Buffer.from('short');await expect(storage.getReadableRevisionToFile(row,entry.path,commit,staging,undefined,entry)).rejects.toThrow('size');
  });
  it('keeps ordinary historical reads on exact traversal when no capability is supplied',async()=>{
    const {storage,row,entry,staging,state,calls}=await capturedEntry(),before=calls.length;state.commitStatus=404;
    await unavailable(storage.getReadableRevisionToFile(row,entry.path,commit,staging));expect(calls.slice(before)).toHaveLength(1);expect(revisionCalls(calls)).toHaveLength(0);
  });
  it('downloads an uncached >20k historical folder in linear requests using only original tree entries',async()=>{
    const {storage,row,root,listings,calls}=fixture(),count=20_001;
    listings.set('/Notes',{dirent_list:[{type:'dir',name:'Retired',parent_dir:'/Notes',obj_id:objectId}]});
    listings.set('/Notes/Retired',{dirent_list:Array.from({length:count},(_,index)=>({type:'file',name:`note-${index}.md`,parent_dir:'/Notes/Retired',obj_id:objectId,size:bytes.length}))});
    const tree=await storage.readableRevisionTree(row,'Retired',commit),blobs=new VerifiedBlobStore({...config,DATA_DIR:root},{} as Store,storage);
    // Exercise the real HTTP streamed reader and integrity checks without
    // making 20k fsyncs; private-disk durability has its own real-I/O tests.
    vi.spyOn(blobs.staging,'fromChunks').mockImplementation(async(chunks,maximum,signal)=>{let size=0;for await(const chunk of chunks){signal?.throwIfAborted();size+=chunk.length;if(size>maximum)throw new Error('test staging size exceeded');}return {path:'disposable-test-stage',size,hash:'verified-test-hash',dispose:async()=>{}};});
    let verified=0;for(const entry of tree.files){const file=await blobs.readable(row,entry.path,commit,undefined,entry);try{expect(file.size).toBe(bytes.length);verified++;}finally{await file.dispose();}}
    expect(verified).toBe(count);expect(calls.filter(path=>path.includes('/dir/'))).toHaveLength(3);expect(calls.filter(path=>/\/commits\/[a-f0-9]{40}\/$/.test(path))).toHaveLength(1);expect(revisionCalls(calls)).toHaveLength(count);expect(calls).toHaveLength(4+count*2);
  },30_000);
});
