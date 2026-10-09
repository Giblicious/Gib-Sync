import { describe,expect,it,vi } from "vitest";
import { ApiError,ApiTransportError } from "./api";
import { recoverSync,SyncCancelledError } from "./sync-recovery";

describe("sync recovery",()=>{
  it("reconciles again after a transient error and reports no terminal failure",async()=>{
    const operation=vi.fn().mockRejectedValueOnce(new ApiError("Server busy",503,null)).mockResolvedValue("verified");
    const onRetry=vi.fn(),wait=vi.fn(async()=>{});
    await expect(recoverSync(operation,{shouldContinue:()=>true,onRetry,wait})).resolves.toBe("verified");
    expect(operation).toHaveBeenCalledTimes(2);expect(onRetry).toHaveBeenCalledWith(expect.any(ApiError),1,2000);
  });
  it("bounds retries and returns the terminal error",async()=>{
    const error=new ApiTransportError(new Error("Offline")),operation=vi.fn().mockRejectedValue(error),onRetry=vi.fn(),wait=vi.fn(async()=>{});
    await expect(recoverSync(operation,{shouldContinue:()=>true,onRetry,wait})).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(4);expect(wait.mock.calls).toEqual([[2000],[5000],[10000]]);
  });
  it.each([401,403,410,422,423,426])("does not retry an HTTP %s requiring user action",async status=>{
    const error=new ApiError("Blocked",status,null),operation=vi.fn().mockRejectedValue(error),onRetry=vi.fn();
    await expect(recoverSync(operation,{shouldContinue:()=>true,onRetry,wait:async()=>{}})).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);expect(onRetry).not.toHaveBeenCalled();
  });
  it("does not retry integrity errors",async()=>{
    const error=new Error("Large-file integrity header is missing or invalid"),onRetry=vi.fn();
    await expect(recoverSync(async()=>{throw error;},{shouldContinue:()=>true,onRetry,wait:async()=>{}})).rejects.toBe(error);
    expect(onRetry).not.toHaveBeenCalled();
  });
  it("stops before another attempt if the device is paused during backoff",async()=>{
    let active=true;const operation=vi.fn().mockRejectedValue(new ApiError("Busy",503,null));
    await expect(recoverSync(operation,{shouldContinue:()=>active,onRetry:()=>{},wait:async()=>{active=false;}})).rejects.toBeInstanceOf(SyncCancelledError);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
