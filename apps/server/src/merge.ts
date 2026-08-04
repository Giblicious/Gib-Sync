import { diffArrays } from "diff";

type Side="current"|"external";
type Hunk={start:number;remove:number;add:string[];side:Side};
export type MergeKind="merged"|"small-overlap"|"large-conflict"|"merge-fallback";
export type MergeResult={text:string;conflicted:boolean;kind:MergeKind;overlapWords:number;overlapLines:number;reason?:string};

const MAX_AUTO_MERGE_CHARACTERS=750_000;
const MAX_AUTO_MERGE_TOKENS=75_000;

const word=/[\p{L}\p{N}_]/u;
const tokenize=(value:string):string[]=>value.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)??[];

function hunks(base:string[],changed:string[],side:Side):Hunk[]{
  const parts=diffArrays(base,changed),output:Hunk[]=[];let baseIndex=0;
  for(let index=0;index<parts.length;index++){
    const part=parts[index];if(!part.added&&!part.removed){baseIndex+=part.value.length;continue;}
    const hunk:Hunk={start:baseIndex,remove:0,add:[],side};
    while(index<parts.length&&(parts[index].added||parts[index].removed)){
      const current=parts[index];if(current.removed){hunk.remove+=current.value.length;baseIndex+=current.value.length;}
      if(current.added)hunk.add.push(...current.value);index++;
    }
    index--;output.push(hunk);
  }
  return output;
}

function overlaps(first:Hunk,second:Hunk):boolean{
  const firstEnd=first.start+first.remove,secondEnd=second.start+second.remove;
  if(first.remove===0&&second.remove===0)return first.start===second.start;
  return (first.start<secondEnd&&second.start<firstEnd)
    ||(first.remove===0&&first.start>=second.start&&first.start<=secondEnd)
    ||(second.remove===0&&second.start>=first.start&&second.start<=firstEnd);
}

function components(hunks:Hunk[]):Hunk[][]{
  const remaining=new Set(hunks),output:Hunk[][]=[];
  while(remaining.size){
    const first=remaining.values().next().value as Hunk;remaining.delete(first);const component=[first];
    for(let index=0;index<component.length;index++)for(const candidate of [...remaining])if(overlaps(component[index],candidate)){remaining.delete(candidate);component.push(candidate);}
    output.push(component);
  }
  return output;
}

function scale(base:string[],component:Hunk[]):{words:number;lines:number}{
  const start=Math.min(...component.map((hunk)=>hunk.start)),end=Math.max(...component.map((hunk)=>hunk.start+hunk.remove));
  const samples=[base.slice(start,end),...component.map((hunk)=>hunk.add)];
  return {words:Math.max(...samples.map((tokens)=>tokens.filter((token)=>word.test(token)).length)),lines:Math.max(...samples.map((tokens)=>tokens.join("").split("\n").length))};
}

function affectedLines(base:string[],component:Hunk[]):Set<number>{
  const start=Math.min(...component.map((hunk)=>hunk.start)),startLine=(base.slice(0,start).join("").match(/\n/g)?.length??0)+1,size=scale(base,component),lines=new Set<number>();
  for(let offset=0;offset<size.lines;offset++)lines.add(startLine+offset);
  return lines;
}

export function mergeText(baseText:string,currentText:string,externalText:string,preferred:Side):MergeResult{
  const done=(text:string):MergeResult=>({text,conflicted:false,kind:"merged",overlapWords:0,overlapLines:0});
  const fallback=(reason:string):MergeResult=>({text:preferred==="current"?currentText:externalText,conflicted:true,kind:"merge-fallback",overlapWords:0,overlapLines:0,reason});
  if(currentText===externalText)return done(currentText);
  if(currentText===baseText)return done(externalText);
  if(externalText===baseText)return done(currentText);
  if(baseText.length+currentText.length+externalText.length>MAX_AUTO_MERGE_CHARACTERS)return fallback("combined text is too large for reliable automatic merge");
  let base:string[],all:Hunk[];
  try{base=tokenize(baseText);const current=tokenize(currentText),external=tokenize(externalText);if(base.length+current.length+external.length>MAX_AUTO_MERGE_TOKENS)return fallback("combined token count is too large for reliable automatic merge");all=[...hunks(base,current,"current"),...hunks(base,external,"external")];}
  catch(error){return fallback(`merge comparison failed (${error instanceof Error?`${error.name}: ${error.message}`:String(error)})`);}
  try{
    const groups=components(all),mixedGroups=groups.filter((component)=>component.some((hunk)=>hunk.side==="current")&&component.some((hunk)=>hunk.side==="external"));
    const overlapWords=mixedGroups.reduce((total,component)=>total+scale(base,component).words,0),lines=new Set<number>();
    for(const component of mixedGroups)for(const line of affectedLines(base,component))lines.add(line);
    const overlapLines=lines.size;
    if(overlapWords>20||overlapLines>2)return {text:preferred==="current"?currentText:externalText,conflicted:true,kind:"large-conflict",overlapWords,overlapLines};
    const selected:Hunk[]=[];let smallOverlap=false;
    for(const component of groups){const mixed=component.some((hunk)=>hunk.side==="current")&&component.some((hunk)=>hunk.side==="external");if(!mixed){selected.push(...component);continue;}smallOverlap=true;selected.push(...component.filter((hunk)=>hunk.side===preferred));}
    const result=[...base];for(const hunk of selected.sort((left,right)=>right.start-left.start))result.splice(hunk.start,hunk.remove,...hunk.add);
    return {text:result.join(""),conflicted:false,kind:smallOverlap?"small-overlap":"merged",overlapWords,overlapLines};
  }catch(error){return fallback(`merge assembly failed (${error instanceof Error?`${error.name}: ${error.message}`:String(error)})`);}
}
