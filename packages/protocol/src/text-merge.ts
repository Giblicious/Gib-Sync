import { diffArrays } from "diff";

type Side = "local" | "remote";
type Hunk = { start: number; remove: number; add: string[]; side: Side };
export type MergeKind = "merged" | "small-overlap" | "large-conflict";
export type MergeResult = { text: string; conflicted: boolean; kind: MergeKind|"merge-fallback"; overlapWords: number; overlapLines: number; reason?:string };

// `diff` is synchronous in the Obsidian renderer. Keep its worst-case input
// bounded so a pathological generated file cannot monopolize the UI thread.
const MAX_AUTO_MERGE_CHARACTERS=750_000;
const MAX_AUTO_MERGE_TOKENS=75_000;
const DIFF_BUDGET_MS=20;

const word = /[\p{L}\p{N}_]/u;
const tokenize = (value: string): string[] => value.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];

function hunks(base: string[], changed: string[], side: Side): Hunk[] {
  const parts = diffArrays(base, changed,{timeout:DIFF_BUDGET_MS,maxEditLength:2048});
  if(!parts)throw new Error("comparison exceeded the interactive work budget");
  const output: Hunk[] = []; let baseIndex = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part.added && !part.removed) { baseIndex += part.value.length; continue; }
    const hunk: Hunk = { start: baseIndex, remove: 0, add: [], side };
    while (index < parts.length && (parts[index].added || parts[index].removed)) {
      const current = parts[index];
      if (current.removed) { hunk.remove += current.value.length; baseIndex += current.value.length; }
      if (current.added) for(const value of current.value)hunk.add.push(value);
      index++;
    }
    index--; output.push(hunk);
  }
  return output;
}

function overlaps(first: Hunk, second: Hunk): boolean {
  const firstEnd = first.start + first.remove, secondEnd = second.start + second.remove;
  if (first.remove === 0 && second.remove === 0) return first.start === second.start;
  return (first.start < secondEnd && second.start < firstEnd)
    || (first.remove === 0 && first.start >= second.start && first.start <= secondEnd)
    || (second.remove === 0 && second.start >= first.start && second.start <= firstEnd);
}

function components(hunks: Hunk[]): Hunk[][] {
  const output:Hunk[][]=[];
  let current:Hunk[]=[];let end=-1;let insertionAtEnd=false;
  for(const hunk of [...hunks].sort((a,b)=>a.start-b.start||a.remove-b.remove)){
    const connects=current.length&&(hunk.start<end||(hunk.start===end&&(hunk.remove===0||insertionAtEnd)));
    if(!connects){current=[];output.push(current);end=hunk.start;insertionAtEnd=false;}
    current.push(hunk);
    const nextEnd=hunk.start+hunk.remove;
    if(nextEnd>end){end=nextEnd;insertionAtEnd=false;}
    if(hunk.remove===0&&hunk.start===end)insertionAtEnd=true;
  }
  return output;
}

function scale(base: string[], component: Hunk[]): { words: number; lines: number } {
  const start = Math.min(...component.map((hunk) => hunk.start));
  const end = Math.max(...component.map((hunk) => hunk.start + hunk.remove));
  const samples = [base.slice(start, end), ...component.map((hunk) => hunk.add)];
  return {
    words: Math.max(...samples.map((tokens) => tokens.filter((token) => word.test(token)).length)),
    lines: Math.max(...samples.map((tokens) => tokens.join("").split("\n").length))
  };
}

function affectedLines(base:string[],component:Hunk[]):Set<number>{
  const start=Math.min(...component.map((hunk)=>hunk.start));
  const startLine=(base.slice(0,start).join("").match(/\n/g)?.length??0)+1;
  const size=scale(base,component),lines=new Set<number>();
  for(let offset=0;offset<size.lines;offset++)lines.add(startLine+offset);
  return lines;
}

export function mergeText(baseText: string, localText: string, remoteText: string, preferred: Side): MergeResult {
  const done = (text: string): MergeResult => ({ text, conflicted: false, kind: "merged", overlapWords: 0, overlapLines: 0 });
  const fallback = (reason:string):MergeResult => ({text:preferred==="local"?localText:remoteText,conflicted:true,kind:"merge-fallback",overlapWords:0,overlapLines:0,reason});
  if (localText === remoteText) return done(localText);
  if (localText === baseText) return done(remoteText);
  if (remoteText === baseText) return done(localText);

  if(baseText.length+localText.length+remoteText.length>MAX_AUTO_MERGE_CHARACTERS)return fallback("combined text is too large for a reliable automatic merge");
  let base:string[],local:string[],remote:string[],all:Hunk[];
  try{
    base=tokenize(baseText);local=tokenize(localText);remote=tokenize(remoteText);
    if(base.length+local.length+remote.length>MAX_AUTO_MERGE_TOKENS)return fallback("combined token count is too large for a reliable automatic merge");
    all=[...hunks(base,local,"local"),...hunks(base,remote,"remote")];
  }catch(error){
    const reason=error instanceof Error?`${error.name}: ${error.message}`:String(error);
    return fallback(`merge engine could not compare the versions (${reason})`);
  }
  try{
    const groups=components(all),mixedGroups=groups.filter((component)=>component.some((hunk)=>hunk.side==="local")&&component.some((hunk)=>hunk.side==="remote"));
    const overlapWords=mixedGroups.reduce((total,component)=>total+scale(base,component).words,0),lines=new Set<number>();
    for(const component of mixedGroups)for(const line of affectedLines(base,component))lines.add(line);
    const overlapLines=lines.size;
    if(overlapWords>20||overlapLines>2)return {text:preferred==="local"?localText:remoteText,conflicted:true,kind:"large-conflict",overlapWords,overlapLines};
    const selected: Hunk[] = []; let smallOverlap = false;
    for (const component of groups) {
      const mixed = component.some((hunk) => hunk.side === "local") && component.some((hunk) => hunk.side === "remote");
      if (!mixed) { selected.push(...component); continue; }
      smallOverlap = true; selected.push(...component.filter((hunk) => hunk.side === preferred));
    }
    const result:string[]=[];let cursor=0;
    for(const hunk of selected.sort((left,right)=>left.start-right.start)){
      if(hunk.start<cursor)throw new Error("selected changes unexpectedly overlap");
      result.push(base.slice(cursor,hunk.start).join(""),hunk.add.join(""));cursor=hunk.start+hunk.remove;
    }
    result.push(base.slice(cursor).join(""));
    return { text: result.join(""), conflicted: false, kind: smallOverlap ? "small-overlap" : "merged", overlapWords, overlapLines };
  }catch(error){
    const reason=error instanceof Error?`${error.name}: ${error.message}`:String(error);
    return fallback(`merge engine could not safely assemble the result (${reason})`);
  }
}
