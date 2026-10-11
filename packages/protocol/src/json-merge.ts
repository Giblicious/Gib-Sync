type JsonValue = null | boolean | number | string | JsonValue[] | {[key:string]:JsonValue};
const missing=Symbol("missing");
type Value=JsonValue|typeof missing;
const object=(value:Value):value is {[key:string]:JsonValue}=>Boolean(value)&&value!==missing&&!Array.isArray(value)&&typeof value==="object";
const get=(value:{[key:string]:JsonValue},key:string):Value=>Object.prototype.hasOwnProperty.call(value,key)?value[key]:missing;
const equal=(left:Value,right:Value):boolean=>{
  if(left===missing||right===missing)return left===right;
  if(Object.is(left,right))return true;
  if(Array.isArray(left)&&Array.isArray(right))return left.length===right.length&&left.every((item,index)=>equal(item,right[index]));
  if(object(left)&&object(right))return [...new Set([...Object.keys(left),...Object.keys(right)])].every((key)=>equal(get(left,key),get(right,key)));
  return false;
};

/** A collection is mergeable only when every record has a unique, stable id.
 * Unknown arrays (ordered values, rules, plugin-specific schemas) remain atomic.
 * This avoids inventing identity from display names or positional indexes. */
function records(value:Value,bookmarks:boolean):Map<string,JsonValue>|null{
  if(value===missing)return new Map();
  if(!Array.isArray(value))return null;
  const result=new Map<string,JsonValue>();
  for(const item of value){
    if(!object(item))return null;
    let key:string;
    if(typeof item.id==="string"||typeof item.id==="number")key=`id:${typeof item.id}:${item.id}`;
    else if(bookmarks&&typeof item.ctime==="number"&&Number.isSafeInteger(item.ctime)&&item.ctime>0&&typeof item.type==="string")key=`bookmark:${item.type}:${item.ctime}`;
    else return null;
    if(result.has(key))return null;
    result.set(key,item);
  }
  return result;
}

export function mergeJsonValues(base:unknown,local:unknown,remote:unknown,preferLocal:boolean,schema?:"bookmarks"):{value:unknown;overlaps:number}{
  let overlaps=0;
  const merge=(b:Value,l:Value,r:Value,depth:number):Value=>{
    if(depth>100)throw new Error("Settings nesting exceeds safe merge depth");
    if(equal(l,r))return l;
    if(equal(l,b))return r;
    if(equal(r,b))return l;
    if(object(l)&&object(r)){
      const baseline=object(b)?b:{},output:{[key:string]:JsonValue}=Object.create(null);
      for(const key of new Set([...Object.keys(baseline),...Object.keys(l),...Object.keys(r)])){
        const value=merge(get(baseline,key),get(l,key),get(r,key),depth+1);
        if(value!==missing)output[key]=value;
      }
      return output;
    }
    if(Array.isArray(l)&&Array.isArray(r)){
      const bm=records(b,schema==="bookmarks"),lm=records(l,schema==="bookmarks"),rm=records(r,schema==="bookmarks");
      if(bm&&lm&&rm){
        const order=preferLocal?[...lm.keys(),...rm.keys(),...bm.keys()]:[...rm.keys(),...lm.keys(),...bm.keys()],output:JsonValue[]=[];
        for(const id of new Set(order)){
          const value=merge(bm.get(id)??missing,lm.get(id)??missing,rm.get(id)??missing,depth+1);
          if(value!==missing)output.push(value);
        }
        return output;
      }
    }
    overlaps++;
    return preferLocal?l:r;
  };
  const value=merge(base as Value,local as Value,remote as Value,0);
  return {value:value===missing?undefined:value,overlaps};
}
