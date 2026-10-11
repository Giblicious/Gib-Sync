import { mergeJsonValues } from "@gib-sync/protocol";
type Side="local"|"remote";

export interface SystemJsonMerge {text:string;semantic:boolean;overlaps:number;reason:string;}

function stringArray(text:string):string[]{
  const value=JSON.parse(text) as unknown;
  if(!Array.isArray(value)||value.some((item)=>typeof item!=="string"))throw new Error("Expected an array of plugin ids");
  return [...new Set(value as string[])];
}

export function mergeCommunityPluginEnablement(baseText:string,localText:string,remoteText:string,preferred:Side,desktopOnlyIds:Set<string>,mobile:boolean):SystemJsonMerge{
  try{
    const base=stringArray(baseText),local=stringArray(localText),remote=stringArray(remoteText),baseSet=new Set(base),localSet=new Set(local),remoteSet=new Set(remote);
    const ids=new Set([...base,...local,...remote]),enabled=new Set<string>();let protectedDesktopOnly=0;
    for(const id of ids){
      const b=baseSet.has(id),l=localSet.has(id),r=remoteSet.has(id);let keep:boolean;
      if(mobile&&desktopOnlyIds.has(id)){keep=r;if(l!==r)protectedDesktopOnly++;}
      else keep=l===r?l:l===b?r:r===b?l:preferred==="local"?l:r;
      if(keep)enabled.add(id);
    }
    const order=preferred==="local"?[...local,...remote,...base]:[...remote,...local,...base],merged=[...new Set(order)].filter((id)=>enabled.has(id));
    return {text:`${JSON.stringify(merged,null,2)}\n`,semantic:true,overlaps:0,reason:protectedDesktopOnly?`preserved ${protectedDesktopOnly} desktop-only plugin state${protectedDesktopOnly===1?"":"s"} from the server; compatible plugin toggles combined normally`:"plugin enablement changes combined by plugin id"};
  }catch{
    return mergeSystemJson(baseText,localText,remoteText,preferred);
  }
}

export function mergeSystemJson(baseText:string,localText:string,remoteText:string,preferred:Side,schema?:"bookmarks"):SystemJsonMerge{
  try{
    const {value,overlaps}=mergeJsonValues(JSON.parse(baseText),JSON.parse(localText),JSON.parse(remoteText),preferred==="local",schema);
    return {text:`${JSON.stringify(value,null,2)}\n`,semantic:true,overlaps,reason:overlaps?`${overlaps} overlapping setting value${overlaps===1?"":"s"} used the newer ${preferred} version`:"independent setting keys and stable-id records combined"};
  }catch{
    return {text:preferred==="local"?localText:remoteText,semantic:false,overlaps:1,reason:`invalid or non-standard JSON used the newer ${preferred} whole file`};
  }
}
