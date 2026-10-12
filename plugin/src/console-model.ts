import type {SyncActivity,ActivityLevel,SyncPhase} from "./settings";

export interface ConsoleRow {
  key:string;at:string;phase:SyncPhase;level:ActivityLevel;repeats:number;
  time:string;message:string;
}

/** The export retains the full log; the live view groups repeated messages.
 * Unchanged rows keep their identity, avoiding repeated Intl/DOM work. */
export class ConsoleModel {
  private cached=new Map<string,ConsoleRow>();
  private previous:ConsoleRow[]=[];
  constructor(private readonly formatTime:(at:string)=>string=(()=>{
    const formatter=new Intl.DateTimeFormat(undefined,{hour:"2-digit",minute:"2-digit",second:"2-digit"});
    return (at:string)=>{const date=new Date(at);return Number.isFinite(date.getTime())?formatter.format(date):"";};
  })()){}
  update(activities:readonly SyncActivity[]):{rows:ConsoleRow[];changed:boolean}{
    const grouped=new Map<string,{entry:SyncActivity;repeats:number}>();
    for(const entry of activities.slice(-100)){
      const key=JSON.stringify([entry.phase,entry.level,entry.message]);
      const repeats=(grouped.get(key)?.repeats??0)+(Number.isSafeInteger(entry.repeats)&&entry.repeats!>0?entry.repeats!:1);
      grouped.delete(key);grouped.set(key,{entry,repeats});
    }
    const rows:ConsoleRow[]=[],next=new Map<string,ConsoleRow>();
    for(const [key,{entry,repeats}]of grouped){
      const prior=this.cached.get(key);
      const row=prior&&prior.at===entry.at&&prior.repeats===repeats?prior:
        {key,at:entry.at,phase:entry.phase,level:entry.level,repeats,
          time:prior?.at===entry.at?prior.time:this.formatTime(entry.at),
          message:`${entry.message}${repeats>1?` · repeated ${repeats} times`:""}`};
      rows.push(row);next.set(key,row);
    }
    const changed=rows.length!==this.previous.length||rows.some((row,i)=>row!==this.previous[i]);
    this.cached=next;this.previous=rows;
    return {rows,changed};
  }
}
