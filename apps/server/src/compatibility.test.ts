import {describe,expect,it} from "vitest";
import {clientCompatibility,compareVersions,parseVersion} from "./compatibility.js";

describe("client compatibility",()=>{
  it("orders stable semantic versions and prereleases",()=>{
    expect(compareVersions("0.8.19","0.8.18")).toBe(1);expect(compareVersions("v1.0.0","1.0.0")).toBe(0);expect(compareVersions("1.0.0-beta.2","1.0.0-beta.10")).toBe(-1);expect(compareVersions("1.0.0","1.0.0-rc.1")).toBe(1);expect(parseVersion("latest")).toBeNull();
  });
  it("blocks missing, old, and protocol-incompatible clients",()=>{
    const base={minimumVersion:"0.8.19",recommendedVersion:"0.8.20",serverProtocol:6,serverVersion:"0.8.35",serverCapabilities:["readable-generation-v1"]};
    expect(clientCompatibility({...base,clientVersion:null,clientProtocol:null})).toMatchObject({compatible:false,updateAvailable:false});
    expect(clientCompatibility({...base,clientVersion:"0.8.18",clientProtocol:5})).toMatchObject({compatible:false,updateAvailable:true});
    expect(clientCompatibility({...base,clientVersion:"0.8.20",clientProtocol:4})).toMatchObject({compatible:false,updateAvailable:false});
  });
  it("warns without blocking a compatible client behind the recommendation",()=>{
    expect(clientCompatibility({clientVersion:"0.8.19",clientProtocol:6,minimumVersion:"0.8.18",recommendedVersion:"0.8.20",serverProtocol:6,serverVersion:"0.8.35",serverCapabilities:["readable-generation-v1"]})).toMatchObject({compatible:true,updateAvailable:true,reason:null});
  });
});
