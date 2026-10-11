import {afterEach,describe,expect,it,vi} from "vitest";
vi.mock("obsidian",()=>({requestUrl:vi.fn()}));
import {controlledIo} from "./io-control";
afterEach(()=>vi.useRealTimers());
describe("paused and stalled file I/O",()=>{
  it("aborts an in-flight request when the owner is paused",async()=>{
    vi.useFakeTimers();let paused=false;const checkpoint=()=>{if(paused)throw new Error("paused");};
    const promise=controlledIo(checkpoint,async signal=>new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(new Error("aborted")))));
    const assertion=expect(promise).rejects.toThrow("paused");paused=true;await vi.advanceTimersByTimeAsync(250);await assertion;expect(vi.getTimerCount()).toBe(0);
  });
  it("times out a stalled request but permits a progressing long transfer",async()=>{
    vi.useFakeTimers();const pending=controlledIo(()=>{},async signal=>new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(new Error("aborted")))));
    const assertion=expect(pending).rejects.toThrow("stalled");await vi.advanceTimersByTimeAsync(120250);await assertion;
    const progressing=controlledIo(()=>{},async(_,touch)=>{for(let i=0;i<3;i++){await new Promise(resolve=>setTimeout(resolve,100000));touch();}return "done";});
    await vi.advanceTimersByTimeAsync(300000);await expect(progressing).resolves.toBe("done");expect(vi.getTimerCount()).toBe(0);
  });
});
