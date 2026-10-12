import {describe,it,expect} from "vitest";
import {ConsoleScrollFollower} from "./console-scroll";
function fixture(){let id=0;const queued=new Map<number,()=>void>(),follow=new ConsoleScrollFollower(callback=>{queued.set(++id,callback);return id;},id=>{queued.delete(id);}),root={isConnected:true,scrollTop:12};const frame=()=>{const callbacks=[...queued];queued.clear();for(const [,callback]of callbacks)callback();};return {queued,follow,root,frame};}
describe("paint-aligned console follow",()=>{
 it("does not read layout or scroll in the same render or first frame",()=>{const f=fixture();f.follow.schedule(f.root,12);expect(f.root.scrollTop).toBe(12);f.frame();expect(f.root.scrollTop).toBe(12);f.frame();expect(f.root.scrollTop).toBe(Number.MAX_SAFE_INTEGER);});
 it("never overrides a user scroll",()=>{const f=fixture();f.follow.schedule(f.root,12);f.frame();f.root.scrollTop=0;f.frame();expect(f.root.scrollTop).toBe(0);});
 it("coalesces bursts without postponing follow indefinitely",()=>{const f=fixture();f.follow.schedule(f.root,12);f.follow.schedule(f.root,12);expect(f.queued.size).toBe(1);f.frame();f.follow.schedule(f.root,12);expect(f.queued.size).toBe(1);f.frame();expect(f.root.scrollTop).toBe(Number.MAX_SAFE_INTEGER);});
 it("cancels work on either frame when settings close",()=>{for(const first of [false,true]){const f=fixture();f.follow.schedule(f.root,12);if(first)f.frame();f.follow.stop();f.frame();expect(f.root.scrollTop).toBe(12);expect(f.queued.size).toBe(0);}});
 it("ignores detached roots and can restart after cancellation",()=>{const f=fixture();f.follow.schedule(f.root,12);f.root.isConnected=false;f.frame();f.frame();expect(f.root.scrollTop).toBe(12);f.follow.stop();f.root.isConnected=true;f.follow.schedule(f.root,12);f.frame();f.frame();expect(f.root.scrollTop).toBe(Number.MAX_SAFE_INTEGER);});
});
