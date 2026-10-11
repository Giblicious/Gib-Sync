import { mergeText as sharedMerge, type MergeResult } from "@gib-sync/protocol";
export type { MergeKind, MergeResult } from "@gib-sync/protocol";
export function mergeText(base:string,current:string,external:string,preferred:"current"|"external"):MergeResult{
  return sharedMerge(base,current,external,preferred==="current"?"local":"remote");
}
