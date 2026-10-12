import type {DataAdapter} from "obsidian";
import {canonicalConfigPath,normalizedConfigDir} from "./settings";

/** Wire paths are stable; filesystem paths always use this device's declared root. */
export function canonicalAdapter(adapter:DataAdapter,root:()=>string,aliases:()=>readonly string[]=()=>[]):DataAdapter{
  const physical=(path:string)=>{const configured=normalizedConfigDir(root());return path===".obsidian"?configured:path.startsWith(".obsidian/")?`${configured}${path.slice(9)}`:path;};
  const logical=(path:string)=>canonicalConfigPath(path,root());
  const mapped=new Set(["read","readBinary","write","writeBinary","append","appendBinary","stat","exists","mkdir","rmdir","remove","trashSystem","trashLocal","getResourcePath"]);
  return new Proxy(adapter,{get(target,key){
    const value=Reflect.get(target,key,target);if(typeof value!=="function")return value;
    if(key==="list")return async(path:string)=>{const listing=await target.list(physical(path)),configured=normalizedConfigDir(root()),retired=new Set(aliases().filter(alias=>alias!==configured&&alias!==".obsidian"));const convert=(paths:string[])=>[...new Set(paths.filter(candidate=>!retired.has(candidate)&&!(configured!==".obsidian"&&candidate===".obsidian")).map(logical))];return {files:convert(listing.files),folders:convert(listing.folders)};};
    if(key==="rename"||key==="copy")return (from:string,to:string,...rest:unknown[])=>value.call(target,physical(from),physical(to),...rest);
    if(mapped.has(String(key)))return (path:string,...rest:unknown[])=>value.call(target,physical(path),...rest);
    return value.bind(target);
  }});
}
