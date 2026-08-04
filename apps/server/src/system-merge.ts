type Side="current"|"external";
type JsonValue=null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue};
const missing=Symbol("missing");type MaybeValue=JsonValue|typeof missing;
const object=(value:MaybeValue):value is {[key:string]:JsonValue}=>Boolean(value)&&value!==missing&&!Array.isArray(value)&&typeof value==="object";
const get=(value:{[key:string]:JsonValue},key:string):MaybeValue=>Object.prototype.hasOwnProperty.call(value,key)?value[key]:missing;
const equal=(left:MaybeValue,right:MaybeValue):boolean=>{if(left===missing||right===missing)return left===right;if(Object.is(left,right))return true;if(Array.isArray(left)&&Array.isArray(right))return left.length===right.length&&left.every((value,index)=>equal(value,right[index]));if(object(left)&&object(right)){const keys=new Set([...Object.keys(left),...Object.keys(right)]);return [...keys].every((key)=>equal(get(left,key),get(right,key)));}return false;};

function mergeValue(base:MaybeValue,current:MaybeValue,external:MaybeValue,preferred:Side):MaybeValue{
  if(equal(current,external))return current;if(equal(current,base))return external;if(equal(external,base))return current;
  if(object(current)&&object(external)){const baseline=object(base)?base:{},output:{[key:string]:JsonValue}={};for(const key of new Set([...Object.keys(baseline),...Object.keys(current),...Object.keys(external)])){const value=mergeValue(get(baseline,key),get(current,key),get(external,key),preferred);if(value!==missing)output[key]=value;}return output;}
  return preferred==="current"?current:external;
}

export function mergeSystemJson(baseText:string,currentText:string,externalText:string,preferred:Side):string{
  try{const merged=mergeValue(JSON.parse(baseText) as JsonValue,JSON.parse(currentText) as JsonValue,JSON.parse(externalText) as JsonValue,preferred);return merged===missing?"":`${JSON.stringify(merged,null,2)}\n`;}
  catch{return preferred==="current"?currentText:externalText;}
}
