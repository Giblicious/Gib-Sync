const encoder=new TextEncoder();
const bytes=(text:string)=>encoder.encode(text).length;
function fit(text:string,budget:number):string{let result='',used=0;for(const character of text){const size=bytes(character);if(used+size>budget)break;result+=character;used+=size;}return result;}
function discriminator(text:string):string{let hash=2166136261;for(const character of encoder.encode(text))hash=Math.imul(hash^character,16777619);return (hash>>>0).toString(16).padStart(8,'0');}

/** Preserve complete versions with names portable to mobile/desktop filesystems.
 * Original names and immutable contents remain in the conflict record. A long
 * name must not wedge the entire incoming apply journal. */
export function conflictCopyPath(path:string,deviceName:string,mtime:number,occupied:Set<string>):string{
  const slash=path.lastIndexOf('/'),name=path.slice(slash+1),dot=name.lastIndexOf('.'),stem=dot>0?name.slice(0,dot):name,extension=dot>0?fit(name.slice(dot),24):'';
  const device=fit(deviceName.replace(/[\\/:*?"<>|\[\]#]/g,'-').replace(/\s+/g,' ').trim(),48)||'Unknown device';
  const date=new Date(Number.isFinite(mtime)&&mtime>0?mtime:Date.now()),stamp=(Number.isNaN(date.getTime())?new Date():date).toISOString().replace('T',' ').replace(/\.\d{3}Z$/,' UTC').replace(/:/g,'-');
  const originalParent=path.slice(0,slash+1),parent=originalParent.length+240<=4000?originalParent:'Gib Sync Conflicts/';
  let sequence=1;
  for(;;){const suffix=` (conflict - ${device} - ${stamp}${sequence>1?` - ${sequence}`:''})`,budget=240-bytes(suffix)-bytes(extension),shortened=bytes(stem)>budget,marker=shortened?`~${discriminator(path)}`:'',base=fit(stem,budget-bytes(marker))||'Note',candidate=`${parent}${base}${marker}${suffix}${extension}`;
    if(!occupied.has(candidate))return candidate;sequence++;
  }
}
