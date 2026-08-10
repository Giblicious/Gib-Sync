import {describe,expect,it} from "vitest";
import type {ClientCompatibility} from "@gib-sync/protocol";
import {assertSetupServerCompatible,enforceServerCompatibility,staleServerReason} from "./server-compatibility";

const compatible:ClientCompatibility={clientVersion:"0.8.38",clientProtocol:6,minimumVersion:"0.8.36",recommendedVersion:"0.8.38",serverProtocol:6,serverVersion:"0.8.38",serverCapabilities:["readable-generation-v1","external-delete-proof-v1"],compatible:true,updateAvailable:false,reason:null};

describe("server compatibility gate",()=>{
  it("blocks an old server even when it claims the client is compatible",()=>{
    expect(enforceServerCompatibility({...compatible,serverVersion:"0.8.27"})).toMatchObject({compatible:false});
    expect(enforceServerCompatibility({...compatible,serverVersion:"0.8.35"})).toMatchObject({compatible:false});
    expect(enforceServerCompatibility({...compatible,serverVersion:undefined})).toMatchObject({compatible:false});
    expect(enforceServerCompatibility({...compatible,serverVersion:"0.8.36-beta.1"})).toMatchObject({compatible:false});
  });
  it("blocks matching versions that omit required safety capabilities",()=>{
    expect(staleServerReason({protocolVersion:6,serverVersion:"0.8.36",serverCapabilities:["readable-generation-v1"]})).toContain("external-delete-proof-v1");
  });
  it("blocks setup before storing credentials for a stale server",()=>{
    const setup={protocolVersion:5,serverVersion:"0.8.27",serverCapabilities:[]};
    expect(()=>assertSetupServerCompatible(setup)).toThrow("requires protocol 6");
  });
  it("accepts a current server with every required capability",()=>{
    expect(enforceServerCompatibility(compatible)).toMatchObject({compatible:true,reason:null});
  });
});
