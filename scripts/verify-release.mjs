import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const json=(path)=>JSON.parse(readFileSync(path,"utf8"));
const manifest=json("plugin/manifest.json"),version=manifest.version;
assert.match(version,/^\d+\.\d+\.\d+$/);
for(const path of ["package.json","plugin/package.json","apps/server/package.json","packages/protocol/package.json"]){
  const value=json(path);assert.equal(value.version,version,path);
  if(value.dependencies?.["@gib-sync/protocol"])assert.equal(value.dependencies["@gib-sync/protocol"],version,path);
}
assert.equal(json("plugin/versions.json")[version],manifest.minAppVersion);
if(process.argv[2])assert.equal(process.argv[2],`v${version}`,"Release tag must match all version surfaces");
assert.ok(readFileSync("plugin/main.js","utf8").includes(version),"Client version must be in built bundle");
assert.ok(readFileSync("apps/server/src/version.ts","utf8").includes(version),"Server version mismatch");
assert.ok(readFileSync("plugin/styles.css").length>0);
console.log(`Verified release contract ${version}`);
