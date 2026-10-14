import {afterEach,describe,expect,it,vi} from 'vitest';
import {cooperativeYield} from './engine';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
function foreground(time:number){
  let frame:()=>void=()=>{},visibility:()=>void=()=>{};
  const cancel=vi.fn(),remove=vi.fn();
  vi.stubGlobal('navigator',{userAgent:'Android test'});vi.stubGlobal('performance',{now:()=>time});
  vi.stubGlobal('document',{hidden:false,addEventListener:(_event:string,fn:()=>void)=>{visibility=fn;},removeEventListener:remove});
  vi.stubGlobal('requestAnimationFrame',(fn:()=>void)=>{frame=fn;return 17;});vi.stubGlobal('cancelAnimationFrame',cancel);
  return {frame:()=>frame(),hide:()=>visibility(),cancel,remove};
}
describe('foreground mobile rendering during bounded file work',()=>{
  it('waits for a real frame and removes its fallback and visibility listener',async()=>{vi.useFakeTimers();const f=foreground(10000);let finished=false;const task=cooperativeYield().then(()=>{finished=true;});await Promise.resolve();expect(finished).toBe(false);f.frame();await task;expect(finished).toBe(true);expect(f.cancel).toHaveBeenCalledWith(17);expect(f.remove).toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);});
  it('settles when the app backgrounds before its frame arrives',async()=>{vi.useFakeTimers();const f=foreground(20000),task=cooperativeYield();f.hide();await task;expect(f.cancel).toHaveBeenCalledWith(17);expect(vi.getTimerCount()).toBe(0);});
  it('bounds the wait when a foreground renderer does not deliver a frame',async()=>{vi.useFakeTimers();const f=foreground(30000),task=cooperativeYield();await vi.advanceTimersByTimeAsync(50);await task;expect(f.cancel).toHaveBeenCalledWith(17);expect(vi.getTimerCount()).toBe(0);});
  it('uses the background-safe scheduler without requesting a hidden frame',async()=>{const frame=vi.fn(),yieldTask=vi.fn(async()=>{});vi.stubGlobal('navigator',{userAgent:'iPhone test'});vi.stubGlobal('document',{hidden:true});vi.stubGlobal('requestAnimationFrame',frame);vi.stubGlobal('scheduler',{yield:yieldTask});await cooperativeYield();expect(frame).not.toHaveBeenCalled();expect(yieldTask).toHaveBeenCalledOnce();});
});
