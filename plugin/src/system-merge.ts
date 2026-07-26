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
