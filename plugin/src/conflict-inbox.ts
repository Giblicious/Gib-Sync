import {diffLines} from "diff";
export type ConflictChoice = "this" | "other" | "combine" | "both";
export interface ConflictInboxSide {
  id:string;label:string;path:string;hash:string|null;size:number;deleted?:boolean;deviceId?:string;deviceName?:string;revisionId?:string;
  sourcePath?:string;annotatedHash?:string;annotatedPath?:string;
}
export interface ConflictInboxItem {
  id:string;originSnapshotId:string|null;path:string;createdAt:string;reason:string;state:"open"|"resolved";actionRequired?:boolean;
  versions:ConflictInboxSide[];resolution?:{id:string;choice:ConflictChoice;at:string;undoable:boolean;batchId?:string;before?:Array<{path:string;hash:string|null}>;after?:Array<{path:string;hash:string|null}>;afterIdentity?:Array<{path:string;targetId:string;revisionId:string;deleted:boolean}>};
}
export interface ConflictInboxPreview {item:ConflictInboxItem;texts:Array<{id:string;text:string|null;truncated:boolean}>;}
export function boundedConflictText(text:string,maximum=128*1024):{text:string;truncated:boolean}{
  return {text:text.slice(0,maximum),truncated:text.length>maximum};
}
export function conflictLineComparison(left:string,right:string,maximumLines=400):Array<{left:string;right:string;changed:boolean}>{
  const a=left.split("\n",maximumLines),b=right.split("\n",maximumLines),rows:Array<{left:string;right:string;changed:boolean}>=[];
  const changes=diffLines(a.join("\n"),b.join("\n"),{timeout:20,maxEditLength:1000});
  if(!changes){for(let index=0;index<Math.min(maximumLines,Math.max(a.length,b.length));index++)rows.push({left:a[index]??"",right:b[index]??"",changed:a[index]!==b[index]});return rows;}
  let removed:string[]=[],added:string[]=[];
  const flush=()=>{for(let index=0;index<Math.max(removed.length,added.length)&&rows.length<maximumLines;index++)rows.push({left:removed[index]??"",right:added[index]??"",changed:true});removed=[];added=[];};
  for(const change of changes){const lines=change.value.split("\n");if(change.value.endsWith("\n"))lines.pop();if(change.removed)removed.push(...lines);else if(change.added)added.push(...lines);else{flush();for(const line of lines){if(rows.length>=maximumLines)break;rows.push({left:line,right:line,changed:false});}}}flush();return rows;
}
