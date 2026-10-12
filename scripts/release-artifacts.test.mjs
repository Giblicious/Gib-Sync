import test from "node:test";
import assert from "node:assert/strict";
import {artifactManifest,verifyArtifactManifest,guardImmutablePublication} from "./release-artifacts.mjs";
const input={tag:"v0.8.63",commit:"a".repeat(40),imageDigest:`sha256:${"b".repeat(64)}`};
const assets=new Map([ ["main.js",Buffer.from("fixture")],["manifest.json",Buffer.from('{"version":"0.8.63"}')],["styles.css",Buffer.from("fixture")],["versions.json",Buffer.from("fixture")],["gib-sync-v0.8.63.zip",Buffer.from("fixture")] ]);
const read=name=>assets.get(name);
test("binds exact candidate bytes to tag, commit and immutable image",()=>{const value=artifactManifest(input,read);assert.deepEqual(verifyArtifactManifest(value,input,read),value);});
test("rejects mutated plugin bytes, version, digest and unknown asset names",()=>{
  const value=artifactManifest(input,read);
  assert.throws(()=>verifyArtifactManifest(value,input,name=>name==="main.js"?Buffer.from("changed"):read(name)));
  assert.throws(()=>verifyArtifactManifest(value,{...input,commit:"c".repeat(40)},read));
  assert.throws(()=>verifyArtifactManifest(value,{...input,imageDigest:`sha256:${"c".repeat(64)}`},read));
  assert.throws(()=>verifyArtifactManifest({...value,assets:[...value.assets,{name:"../../private",size:1,sha256:"a".repeat(64)}]},input,read));
  assert.throws(()=>artifactManifest({...input,tag:"v0.8.64"},read));
});
test("publication guard accepts only independently confirmed missing release and image",async()=>{
  const responses=[{status:404,ok:false},{status:200,ok:true,json:async()=>({token:"registry-test-token"})},{status:404,ok:false}],calls=[];
  await guardImmutablePublication({tag:input.tag,repository:"Giblicious/Gib-Sync",actor:"fixture",token:"fixture-token"},async(url,options)=>{calls.push([url,options]);return responses.shift();});assert.equal(calls.length,3);
});
for(const status of [200,401,403,429,500])test(`publication guard fails closed on release HTTP ${status}`,async()=>{await assert.rejects(guardImmutablePublication({tag:input.tag,repository:"Giblicious/Gib-Sync",actor:"fixture",token:"fixture-token"},async()=>({status,ok:status===200})));});
test("publication guard refuses existing image and network failure",async()=>{
  const responses=[{status:404,ok:false},{status:200,ok:true,json:async()=>({token:"fixture"})},{status:200,ok:true}];await assert.rejects(guardImmutablePublication({tag:input.tag,repository:"Giblicious/Gib-Sync",actor:"fixture",token:"fixture"},async()=>responses.shift()));
  await assert.rejects(guardImmutablePublication({tag:input.tag,repository:"Giblicious/Gib-Sync",actor:"fixture",token:"fixture"},async()=>{throw new Error("network unavailable");}));
});
