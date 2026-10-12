import {describe,expect,it} from "vitest";
import {boundedConflictText,conflictLineComparison} from "./conflict-inbox";
describe("bounded actual conflict previews",()=>{
it("never turns an oversized preview into a pretend complete note",()=>{expect(boundedConflictText("x".repeat(200000))).toMatchObject({truncated:true});expect(boundedConflictText("safe")).toEqual({text:"safe",truncated:false});});
it("aligns inserted lines so unchanged following content stays unchanged",()=>{const rows=conflictLineComparison("one\ntwo\nthree","one\nnew\ntwo\nthree");expect(rows.filter(row=>row.changed)).toHaveLength(1);expect(rows.at(-1)).toEqual({left:"three",right:"three",changed:false});});
it("caps pathological diffs at400displayedrows",()=>{const text=(prefix:string)=>Array.from({length:5000},(_,index)=>`${prefix}${index}`).join("\n");expect(conflictLineComparison(text("a"),text("b"))).toHaveLength(400);});
it("retains real trailing spaces instead of concealing whitespace changes",()=>{expect(conflictLineComparison("a ","a")[0]).toEqual({left:"a ",right:"a",changed:true});});
});
