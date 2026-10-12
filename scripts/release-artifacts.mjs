import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

const names=["main.js","manifest.json","styles.css","versions.json"];
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
export function artifactManifest({tag,commit,imageDigest},read){
  assert.match(tag,/^v\d+\.\d+\.\d+$/,"Invalid release tag");
  assert.match(commit,/^[0-9a-f]{40}$/,"Invalid release commit");
  assert.match(imageDigest,/^sha256:[0-9a-f]{64}$/,"Invalid image digest");
  const version=tag.slice(1),manifest=JSON.parse(read("manifest.json").toString());
  assert.equal(manifest.version,version,"Plugin version does not match immutable tag");
  const assets=[...names,`gib-sync-${tag}.zip`].map(name=>{const bytes=read(name);assert.ok(bytes.length>0,`Empty asset ${name}`);return {name,size:bytes.length,sha256:sha(bytes)};});
  return {format:1,tag,version,commit,image:{repository:"ghcr.io/giblicious/gib-sync",digest:imageDigest},assets};
}
export function verifyArtifactManifest(value,{tag,commit,imageDigest},read){
  assert.deepEqual(Object.keys(value).sort(),["assets","commit","format","image","tag","version"]);
  assert.equal(value.format,1);assert.equal(value.tag,tag);assert.equal(value.version,tag.slice(1));assert.equal(value.commit,commit);
  assert.deepEqual(value.image,{repository:"ghcr.io/giblicious/gib-sync",digest:imageDigest});
  const actual=artifactManifest({tag,commit,imageDigest},read);
  assert.deepEqual(value.assets,actual.assets,"Public candidate bytes do not match workflow attestation");
  return actual;
}
/** Refuse a retry which would overwrite a versioned release or image. Missing
 * resources are the only acceptable error, never a network/authentication error.
 */
export async function guardReleasePublication({tag,repository,token},request=fetch){
  assert.match(tag,/^v\d+\.\d+\.\d+$/);assert.equal(repository,"Giblicious/Gib-Sync");assert.ok(token,"Authenticated publication is required");
  const release=await request(`https://api.github.com/repos/${repository}/releases/tags/${tag}`,{headers:{Authorization:`Bearer ${token}`,Accept:"application/vnd.github+json"}});
  assert.equal(release.status,404,release.ok?"Release already exists; its assets are immutable":"Cannot establish that release tag is unpublished");
}
export async function guardImmutablePublication({tag,repository,actor,token},request=fetch){
  await guardReleasePublication({tag,repository,token},request);assert.ok(actor,"Authenticated registry actor is required");
  const auth=await request("https://ghcr.io/token?service=ghcr.io&scope=repository:giblicious/gib-sync:pull",{headers:{Authorization:`Basic ${Buffer.from(`${actor}:${token}`).toString("base64")}`}});
  assert.ok(auth.ok,"Cannot authenticate registry immutability check");const credentials=await auth.json();assert.ok(typeof credentials.token==="string"&&credentials.token.length>0,"Registry token missing");
  const image=await request(`https://ghcr.io/v2/giblicious/gib-sync/manifests/${tag}`,{headers:{Authorization:`Bearer ${credentials.token}`,Accept:"application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json"}});
  assert.equal(image.status,404,image.ok?"Versioned image already exists; do not rebuild tested bytes":"Cannot establish that image tag is unpublished");
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const mode=process.argv[2],tag=process.env.RELEASE_TAG??process.env.GITHUB_REF_NAME;
  if(mode==="guard")await guardImmutablePublication({tag,repository:process.env.GITHUB_REPOSITORY,actor:process.env.GITHUB_ACTOR,token:process.env.GH_TOKEN});
  else if(mode==="guard-promotion")await guardReleasePublication({tag,repository:process.env.GITHUB_REPOSITORY,token:process.env.GH_TOKEN});
  else{
    const commit=process.env.RELEASE_COMMIT??process.env.GITHUB_SHA,imageDigest=process.env.RELEASE_IMAGE_DIGEST;
    if(mode==="create"){
      const read=name=>readFileSync(names.includes(name)?`plugin/${name}`:name);
      writeFileSync("release-artifacts.json",JSON.stringify(artifactManifest({tag,commit,imageDigest},read),null,2)+"\n",{flag:"wx"});
    }else if(mode==="verify"){
      const root=resolve(process.argv[3]??"candidate-assets"),read=name=>readFileSync(resolve(root,name));
      verifyArtifactManifest(JSON.parse(read("release-artifacts.json")),{tag,commit,imageDigest},read);
    }else throw new Error("Expected guard, create or verify");
    console.log(`Verified immutable release artifacts ${tag}`);
  }
}
