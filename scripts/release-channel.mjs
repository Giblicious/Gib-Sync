import assert from "node:assert/strict";
import {readFileSync,appendFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
export function releaseChannel(value,tag){
  assert.ok(value&&typeof value==="object"&&!Array.isArray(value),"Release channel must be explicit");
  assert.deepEqual(Object.keys(value),["channel"],"Unexpected release channel fields");
  assert.ok(value.channel==="stable"||value.channel==="candidate","Unknown release channel");
  assert.match(tag,/^v\d+\.\d+\.\d+$/,"Only immutable numeric release tags are supported");
  const candidate=value.channel==="candidate";
  // BRAT includes prereleases in its latest-version selection. A source
  // candidate may publish Actions artifacts and a versioned image, but never
  // a release in this existing production distribution repository.
  return {prerelease:String(candidate),publishRelease:String(!candidate),tags:`ghcr.io/giblicious/gib-sync:${tag}${candidate?"":"\nghcr.io/giblicious/gib-sync:latest"}`};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=releaseChannel(JSON.parse(readFileSync("release-channel.json","utf8")),process.argv[2]);
  if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`prerelease=${result.prerelease}\npublish_release=${result.publishRelease}\ntags<<RELEASE_TAGS\n${result.tags}\nRELEASE_TAGS\n`);
  console.log(`Release channel: ${result.prerelease==="true"?"candidate; stable clients and latest image remain unchanged":"stable"}`);
}
