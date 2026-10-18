import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
export const BASE='b8c25eed92be8d984102564426657a97422fcb48',VERSION='0.8.83';
const versionOnly=['.env.example','apps/server/package.json','apps/server/src/config.ts','apps/server/src/version.ts','docker-compose.yml','package-lock.json','package.json','packages/protocol/package.json','plugin/manifest.json','plugin/package.json','plugin/src/api.ts'];
const focused=['CHANGELOG.md','plugin/versions.json','plugin/src/main.ts','plugin/src/main.test.ts','plugin/src/settings.ts','plugin/src/ui.ts','plugin/src/vault-location.ts','plugin/src/vault-location.test.ts','plugin/src/vault-location-native.test.ts','docs/portable-vault-location.md','.github/workflows/release.yml','.github/workflows/ci.yml','.github/workflows/stable-portable-hotfix.yml','.github/release-notes/portable-hotfix.md','scripts/verify-stable-hotfix.mjs','scripts/verify-stable-hotfix.test.mjs','scripts/hotfix-assets.mjs','scripts/hotfix-assets.test.mjs'];
const normalized=text=>text.replace(/\r\n/g,'\n');
export function verifyScope(paths,base,current){
 const allowed=new Set([...versionOnly,...focused]);for(const path of paths)assert.ok(allowed.has(path),'Unrelated hotfix change: '+path);
 for(const path of versionOnly)assert.equal(normalized(current(path)),normalized(base(path)).replaceAll('0.8.62',VERSION),'Non-version stable runtime/dependency change: '+path);
 const versions=JSON.parse(base('plugin/versions.json'));versions[VERSION]=JSON.parse(current('plugin/manifest.json')).minAppVersion;assert.deepEqual(JSON.parse(current('plugin/versions.json')),versions);
 const workflow=current('.github/workflows/stable-portable-hotfix.yml');assert.ok(!/docker\/build-push-action|ghcr\.io|imagetools/.test(workflow),'Client hotfix must not publish server images');assert.ok(workflow.includes('node scripts/verify-stable-hotfix.mjs'),'Release must enforce stable lineage and scope');
 assert.equal(normalized(current('.github/workflows/release.yml')),normalized(base('.github/workflows/release.yml')).replace('tags: ["v*"]','tags: ["v*", "!v0.8.83"]'),'Legacy server release must exclude this client-only tag');return true;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const git=args=>execFileSync('git',args,{encoding:'utf8'});execFileSync('git',['merge-base','--is-ancestor',BASE,'HEAD']);const paths=[...git(['diff','--name-only',BASE,'--']).trim().split('\n'),...git(['ls-files','--others','--exclude-standard']).trim().split('\n')].filter(Boolean);
 verifyScope(paths,path=>git(['show',BASE+':'+path]),path=>readFileSync(path,'utf8'));
 assert.equal(normalized(readFileSync('plugin/src/vault-location.ts','utf8')),normalized(git(['show','79d3efb60f4874f44b9442cf4cca0457a3d4361b:plugin/src/vault-location.ts'])),'Portable helper differs from independently tested candidate fix');if(process.argv[2])assert.equal(process.argv[2],'v'+VERSION);console.log('Verified stable 0.8.62 lineage, focused portable fix and client-only publication');
}
