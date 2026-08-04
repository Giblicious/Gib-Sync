type Side="local"|"remote";
type JsonValue=null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue};
const missing=Symbol("missing");
type MaybeValue=JsonValue|typeof missing;
const get=(value:{[key:string]:JsonValue},key:string):MaybeValue=>Object.prototype.hasOwnProperty.call(value,key)?value[key]:missing;

const object=(value:MaybeValue):value is {[key:string]:JsonValue}=>Boolean(value)&&value!==missing&&!Array.isArray(value)&&typeof value==="object";
const equal=(left:MaybeValue,right:MaybeValue):boolean=>{
  if(left===missing||right===missing)return left===right;
  if(Object.is(left,right))return true;
  if(Array.isArray(left)&&Array.isArray(right))return left.length===right.length&&left.every((value,index)=>equal(value,right[index]));
  if(object(left)&&object(right)){const keys=new Set([...Object.keys(left),...Object.keys(right)]);return [...keys].every((key)=>equal(get(left,key),get(right,key)));}
  return false;
};

function mergeValue(base:MaybeValue,local:MaybeValue,remote:MaybeValue,preferred:Side,state:{overlaps:number}):MaybeValue{
  if(equal(local,remote))return local;
  if(equal(local,base))return remote;
  if(equal(remote,base))return local;
  if(object(local)&&object(remote)){
    const baseObject=object(base)?base:{};const output:{[key:string]:JsonValue}={};
    for(const key of new Set([...Object.keys(baseObject),...Object.keys(local),...Object.keys(remote)])){
      const value=mergeValue(get(baseObject,key),get(local,key),get(remote,key),preferred,state);
      if(value!==missing)output[key]=value;
    }
    return output;
  }
  state.overlaps++;return preferred==="local"?local:remote;
}

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

export function mergeSystemJson(baseText:string,localText:string,remoteText:string,preferred:Side):SystemJsonMerge{
  try{
    const base=JSON.parse(baseText) as JsonValue,local=JSON.parse(localText) as JsonValue,remote=JSON.parse(remoteText) as JsonValue,state={overlaps:0};
    const merged=mergeValue(base,local,remote,preferred,state);
    if(merged===missing)return {text:"",semantic:true,overlaps:state.overlaps,reason:"both versions deleted the same setting"};
    return {text:`${JSON.stringify(merged,null,2)}\n`,semantic:true,overlaps:state.overlaps,reason:state.overlaps?`${state.overlaps} overlapping setting value${state.overlaps===1?"":"s"} used the newer ${preferred} version`:"non-overlapping setting keys combined"};
  }catch{
    return {text:preferred==="local"?localText:remoteText,semantic:false,overlaps:1,reason:`invalid or non-standard JSON used the newer ${preferred} whole file`};
  }
}
