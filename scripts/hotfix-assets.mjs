import assert from 'node:assert/strict';import {readFileSync,writeFileSync,readdirSync,lstatSync} from 'node:fs';import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
export const names=['main.js','manifest.json','styles.css','versions.json','gib-sync-v0.8.83.zip'];
export function assetManifest(commit,read){
 assert.match(commit,/^[a-f0-9]{40}$/);const manifest=JSON.parse(read('manifest.json')),versions=JSON.parse(read('versions.json'));assert.equal(manifest.id,'gib-sync');assert.equal(manifest.version,'0.8.83');assert.equal(manifest.isDesktopOnly,false);assert.equal(versions['0.8.83'],manifest.minAppVersion);
 return {format:1,kind:'stable-client-hotfix',tag:'v0.8.83',commit,baseTag:'v0.8.62',baseCommit:'b8c25eed92be8d984102564426657a97422fcb48',serverImagePublished:false,assets:names.map(name=>{const bytes=read(name);assert.ok(bytes.length>0&&bytes.length<=16*1024*1024);return {name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};})};
}
export function verify(value,commit,read){assert.deepEqual(value,assetManifest(commit,read));}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [mode,directory,tag]=process.argv.slice(2),commit=process.env.RELEASE_COMMIT??process.env.GITHUB_SHA;assert.equal(tag,'v0.8.83');
 if(mode==='guard'){const r=await fetch('https://api.github.com/repos/Giblicious/Gib-Sync/releases/tags/'+tag,{headers:{Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});assert.equal(r.status,404,'Published hotfix exists or absence cannot be established');}
 else{assert.ok(['create','verify'].includes(mode));const read=name=>{const path=join(directory,name);assert.ok(lstatSync(path).isFile()&&!lstatSync(path).isSymbolicLink());return readFileSync(path);};if(mode==='create')writeFileSync(join(directory,'release-artifacts.json'),JSON.stringify(assetManifest(commit,read),null,2)+'\n',{flag:'wx'});else verify(JSON.parse(read('release-artifacts.json')),commit,read);assert.deepEqual(readdirSync(directory).sort(),[...names,'release-artifacts.json'].sort());}console.log('Verified stable client-only hotfix assets '+tag);
}
