import {describe,expect,it} from "vitest";
import type {ClientCompatibility} from "@gib-sync/protocol";
import {assertSetupServerCompatible,enforceServerCompatibility,staleServerReason} from "./server-compatibility";

const compatible:ClientCompatibility={clientVersion:"0.8.49",clientProtocol:7,minimumVersion:"0.8.48",recommendedVersion:"0.8.49",serverProtocol:7,serverVersion:"0.8.49",serverCapabilities:["readable-generation-v1","external-delete-proof-v1","folder-manifest-v1","folder-manifest-migration-v2","server-containment-v1"],compatible:true,updateAvailable:false,reason:null};

describe("server compatibility gate",()=>{
  it("blocks an old server even when it claims the client is compatible",()=>{
    expect(enforceServerCompatibility({...compatible,serverVersion:"0.8.27"})).toMatchObject({compatible:false});
    expect(enforceServerCompatibility({...compatible,serverVersion:"0.8.47"})).toMatchObject({compatible:false});
    expect(enforceServerCompatibility({...compatible,serverVersion:undefined})).toMatchObject({compatible:false});
    expect(enforceServerCompatibility({...compatible,serverVersion:"0.8.49-beta.1"})).toMatchObject({compatible:false});
  });
  it("blocks matching versions that omit required safety capabilities",()=>{
    expect(staleServerReason({protocolVersion:7,serverVersion:"0.8.49",serverCapabilities:["readable-generation-v1","external-delete-proof-v1","folder-manifest-v1"]})).toContain("folder-manifest-migration-v2");
  });
  it("blocks setup before storing credentials for a stale server",()=>{
    const setup={protocolVersion:6,serverVersion:"0.8.47",serverCapabilities:[]};
    expect(()=>assertSetupServerCompatible(setup)).toThrow("requires protocol 7");
  });
  it("accepts a current server with every required capability",()=>{
    expect(enforceServerCompatibility(compatible)).toMatchObject({compatible:true,reason:null});
  });
});
