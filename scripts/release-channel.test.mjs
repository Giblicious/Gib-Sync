import {test} from "node:test";
import assert from "node:assert/strict";
import {releaseChannel} from "./release-channel.mjs";
test("candidate publishes no production GitHub release and cannot update latest image",()=>{const value=releaseChannel({channel:"candidate"},"v0.8.63");assert.equal(value.prerelease,"true");assert.equal(value.publishRelease,"false");assert.equal(value.tags,"ghcr.io/giblicious/gib-sync:v0.8.63");});
test("stable publication is explicit",()=>{assert.deepEqual(releaseChannel({channel:"stable"},"v0.8.64"),{prerelease:"false",publishRelease:"true",tags:"ghcr.io/giblicious/gib-sync:v0.8.64\nghcr.io/giblicious/gib-sync:latest"});});
test("unknown channels and unsafe tags fail closed",()=>{for(const channel of [undefined,"preview","stable\nlatest"])assert.throws(()=>releaseChannel({channel},"v0.8.63"));assert.throws(()=>releaseChannel({channel:"candidate"},"main"));assert.throws(()=>releaseChannel({channel:"candidate",prerelease:false},"v0.8.63"));});
