import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {verifyArtifactManifest} from "./release-artifacts.mjs";

const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const repository="Giblicious/Gib-Sync";
const maxAssetBytes=64*1024*1024;

/** A draft is resumable, but existing assets are never overwritten. Only the
 * exact owned, fully verified draft becomes discoverable by BRAT. Registry
 * promotion is deliberately separate and happens after successful publication.
 */
export async function publishVerifiedRelease(input,read,client,{publish=false}={}){
  assert.equal(input.repository,repository);
  const recordBytes=read("release-artifacts.json"),record=JSON.parse(recordBytes);
  verifyArtifactManifest(record,input,read);
  const expected=new Map([...record.assets.map(asset=>[asset.name,read(asset.name)]),["release-artifacts.json",recordBytes]]);
  for(const bytes of expected.values())assert.ok(bytes.length>0&&bytes.length<=maxAssetBytes,"Asset exceeds publication budget");
  const body=`Verified immutable Gib Sync candidate\nSource: ${input.commit}\nImage: ${input.imageDigest}\nArtifact record SHA256: ${hash(recordBytes)}`;
  const validateRelease=release=>{
    assert.ok(Number.isSafeInteger(release.id)&&release.id>0,"Invalid release identity");
    assert.equal(release.tag_name,input.tag);assert.equal(release.target_commitish,input.commit);
    assert.equal(release.body,body,"Existing release is not this workflow-owned candidate");
    assert.equal(typeof release.draft,"boolean");assert.equal(release.prerelease,false);
  };
  let release=await client.find(input.tag);
  if(!release)release=await client.create({tag_name:input.tag,target_commitish:input.commit,name:`Gib Sync ${input.tag}`,body,draft:true,prerelease:false,make_latest:"false"});
  validateRelease(release);
  const inspect=async()=>{
    const assets=await client.list(release.id),seen=new Set();assert.ok(assets.length<=expected.size,"Unexpected release assets");
    for(const asset of assets){assert.ok(Number.isSafeInteger(asset.id)&&asset.id>0);assert.ok(!seen.has(asset.name),"Duplicate release asset");seen.add(asset.name);
      const bytes=expected.get(asset.name);assert.ok(bytes,"Unknown release asset");assert.equal(asset.state,"uploaded");assert.equal(asset.size,bytes.length);
      const actual=await client.download(asset);assert.equal(actual.length,bytes.length);assert.equal(hash(actual),hash(bytes),`Existing asset differs: ${asset.name}`);
    }
    return {assets,seen};
  };
  let checked=await inspect();
  for(const [name,bytes]of expected)if(!checked.seen.has(name)){
    assert.equal(release.draft,true,"A live release may not be repaired or modified");
    await client.upload(release.id,name,bytes);
  }
  checked=await inspect();assert.equal(checked.seen.size,expected.size,"Incomplete draft may not be published");
  const current=await client.find(input.tag);validateRelease(current);assert.equal(current.id,release.id,"Release changed during staging");assert.equal(current.draft,release.draft,"Concurrent publication interrupted staging");
  const before=checked.assets.map(({id,name,size})=>({id,name,size})).sort((a,b)=>a.name.localeCompare(b.name));
  const now=(await client.list(release.id)).map(({id,name,size})=>({id,name,size})).sort((a,b)=>a.name.localeCompare(b.name));
  assert.deepEqual(now,before,"Assets changed immediately before publication");
  if(publish&&release.draft){release=await client.publish(release.id);validateRelease(release);assert.equal(release.draft,false);await inspect();}
  return {tag:input.tag,releaseId:release.id,assets:expected.size,published:!release.draft,recordSha256:hash(recordBytes)};
}

async function boundedBytes(response,limit){
  assert.ok(response.body,"Missing asset body");const reader=response.body.getReader(),parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;assert.ok(size<=limit,"Downloaded asset exceeded expected size");parts.push(value);}return Buffer.concat(parts,size);}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function githubClient(token,request=fetch){
  assert.ok(token,"Workflow token is required");
  const headers={Authorization:`Bearer ${token}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};
  const endpoint=`https://api.github.com/repos/${repository}`;
  const json=async(method,path,body,{missing=false}={})=>{
    const response=await request(`${endpoint}${path}`,{method,headers:{...headers,...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined,redirect:"error",signal:AbortSignal.timeout(30000)});
    if(missing&&response.status===404)return null;assert.ok(response.ok,`GitHub publication request failed (${response.status})`);return response.json();
  };
  return {
    async find(tag){
      // The tag endpoint exposes published releases only. Authenticated list
      // lookup is required to resume the same owned draft, never POST a duplicate.
      const published=await json("GET",`/releases/tags/${encodeURIComponent(tag)}`,undefined,{missing:true});if(published)return published;
      const matches=[];for(let page=1;page<=10;page++){
        const rows=await json("GET",`/releases?per_page=100&page=${page}`);assert.ok(Array.isArray(rows));matches.push(...rows.filter(row=>row.tag_name===tag));assert.ok(matches.length<=1,"Ambiguous draft release tag");
        if(rows.length<100)return matches[0]??null;
      }
      throw new Error("Release listing exceeded its bounded discovery budget");
    },
    create:body=>json("POST","/releases",body),
    list:id=>json("GET",`/releases/${id}/assets?per_page=100`),
    publish:id=>json("PATCH",`/releases/${id}`,{draft:false,make_latest:"true"}),
    async upload(id,name,bytes){
      const response=await request(`https://uploads.github.com/repos/${repository}/releases/${id}/assets?name=${encodeURIComponent(name)}`,{method:"POST",headers:{...headers,"Content-Type":"application/octet-stream"},body:bytes,redirect:"error",signal:AbortSignal.timeout(180000)});assert.ok(response.ok,`Draft asset upload failed (${response.status})`);return response.json();
    },
    async download(asset){
      assert.ok(asset.size>0&&asset.size<=maxAssetBytes);let response=await request(`${endpoint}/releases/assets/${asset.id}`,{headers:{...headers,Accept:"application/octet-stream"},redirect:"manual",signal:AbortSignal.timeout(180000)});
      if([301,302,303,307,308].includes(response.status)){
        const target=new URL(response.headers.get("location"));assert.ok(target.protocol==="https:"&&!target.username&&!target.password&&(target.hostname.endsWith(".githubusercontent.com")||target.hostname.endsWith(".blob.core.windows.net")),"Untrusted asset redirect");
        // Never forward the workflow bearer token to the signed download host.
        response=await request(target,{redirect:"error",signal:AbortSignal.timeout(180000)});
      }
      assert.ok(response.ok,`Draft asset readback failed (${response.status})`);return boundedBytes(response,asset.size);
    }
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  assert.ok(["stage","publish"].includes(process.argv[2]));assert.equal(process.env.CONFIRMATION,"VERIFIED-PHYSICAL-IPHONE-AND-CANARY");assert.match(process.env.EVIDENCE_SHA256??"",/^[a-f0-9]{64}$/);
  const directory=resolve(process.argv[3]??"candidate-assets"),input={repository:process.env.GITHUB_REPOSITORY,tag:process.env.RELEASE_TAG,commit:process.env.RELEASE_COMMIT,imageDigest:process.env.RELEASE_IMAGE_DIGEST};
  console.log(JSON.stringify(await publishVerifiedRelease(input,name=>readFileSync(resolve(directory,name)),githubClient(process.env.GH_TOKEN),{publish:process.argv[2]==="publish"})));
}
