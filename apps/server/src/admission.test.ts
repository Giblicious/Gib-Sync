import {describe,expect,it} from "vitest";
import {BinaryAdmission} from "./admission.js";
describe("aggregate binary admission",()=>{
  it("allows two small requests, rejects the third, and releases idempotently",()=>{const budget=new BinaryAdmission(64*1024*1024),first=budget.acquire(100)!,second=budget.acquire(100)!;expect(budget.acquire(100)).toBeNull();first();first();expect(budget.acquire(100)).not.toBeNull();second();});
  it("gives a large or unknown-size transfer exclusive admission",()=>{const budget=new BinaryAdmission(1024*1024*1024),large=budget.acquire(512*1024*1024)!;expect(budget.acquire(100)).toBeNull();large();const small=budget.acquire(100)!;expect(budget.acquire(Number.NaN)).toBeNull();small();expect(budget.acquire(Number.NaN)).not.toBeNull();});
});
