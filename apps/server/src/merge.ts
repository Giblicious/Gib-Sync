import { diffArrays } from "diff";

type Hunk={start:number;remove:number;add:string[]};

function hunks(base:string[],changed:string[]):Hunk[]{
  const parts=diffArrays(base,changed);const output:Hunk[]=[];let baseIndex=0;
  for(let index=0;index<parts.length;index++){
    const part=parts[index];if(!part.added&&!part.removed){baseIndex+=part.value.length;continue;}
    const hunk:Hunk={start:baseIndex,remove:0,add:[]};
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

export function mergeText(baseText:string,currentText:string,externalText:string):{text:string;conflicted:boolean}{
  if(currentText===externalText)return {text:currentText,conflicted:false};
  if(currentText===baseText)return {text:externalText,conflicted:false};
  if(externalText===baseText)return {text:currentText,conflicted:false};
  const trailing=baseText.endsWith("\n");const split=(value:string)=>value.replace(/\n$/,"").split("\n");
  const base=split(baseText),current=hunks(base,split(currentText)),external=hunks(base,split(externalText));
  if(current.some((left)=>external.some((right)=>overlaps(left,right))))return {
    text:`<<<<<<< Obsidian\n${currentText}\n=======\n${externalText}\n>>>>>>> Seafile\n`,
    conflicted:true
  };
  const result=[...base];
  for(const hunk of [...current,...external].sort((left,right)=>right.start-left.start))result.splice(hunk.start,hunk.remove,...hunk.add);
  return {text:result.join("\n")+(trailing?"\n":""),conflicted:false};
}
