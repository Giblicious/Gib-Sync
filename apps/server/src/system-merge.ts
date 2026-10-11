import { mergeJsonValues } from "@gib-sync/protocol";
type Side="current"|"external";

export function mergeSystemJson(baseText:string,currentText:string,externalText:string,preferred:Side,schema?:"bookmarks"):string{
  try{const {value}=mergeJsonValues(JSON.parse(baseText),JSON.parse(currentText),JSON.parse(externalText),preferred==="current",schema);return `${JSON.stringify(value,null,2)}\n`;}
  catch{return preferred==="current"?currentText:externalText;}
}
