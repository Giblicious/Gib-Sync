import type { ManifestEntry,Snapshot } from "@gib-sync/protocol";
import { safeRelativePath } from "./seafile.js";

export interface CanonicalManifest{entries:ManifestEntry[];folders:string[]|undefined;}

const identity=(path:string)=>path.normalize("NFC").toLowerCase();
const ancestors=(path:string):string[]=>{const parts=path.split("/"),result:string[]=[];for(let index=1;index<parts.length;index++)result.push(parts.slice(0,index).join("/"));return result;};

/** Validate invariants shared by devices, restores, imports, and repairs. */
export function canonicalManifest(entries:ManifestEntry[],folders?:string[]):CanonicalManifest{
  const ordered=[...entries].map((entry)=>({...entry,path:safeRelativePath(entry.path)})).sort((a,b)=>a.path.localeCompare(b.path));
  const exact=new Set<string>(),portable=new Map<string,string>();
  for(const entry of ordered){
    if(exact.has(entry.path))throw new Error(`Duplicate file path: ${entry.path}`);exact.add(entry.path);
    const key=identity(entry.path),other=portable.get(key);if(other&&other!==entry.path)throw new Error(`File paths differ only by case or Unicode normalization: ${other} and ${entry.path}`);portable.set(key,entry.path);
  }
  for(const entry of ordered)for(const parent of ancestors(entry.path))if(exact.has(parent))throw new Error(`A file path is also used as a parent folder: ${parent}`);
  if(folders===undefined)return {entries:ordered,folders:undefined};
  const implicit=new Set(ordered.flatMap((entry)=>ancestors(entry.path))),folderExact=new Set<string>(),folderPortable=new Map<string,string>();
  for(const raw of folders){
    const path=safeRelativePath(raw);if(implicit.has(path))continue;
    const key=identity(path),other=folderPortable.get(key);if(other&&other!==path)throw new Error(`Folder paths differ only by case or Unicode normalization: ${other} and ${path}`);
    for(const parent of [path,...ancestors(path)])if(exact.has(parent))throw new Error(`A file path conflicts with a folder path: ${parent}`);
    folderPortable.set(key,path);folderExact.add(path);
  }
  return {entries:ordered,folders:[...folderExact].sort()};
}

export function validateCurrentSnapshot(snapshot:Snapshot):string|null{
  try{canonicalManifest(snapshot.entries,snapshot.folders);return null;}catch(error){return error instanceof Error?error.message:String(error);}
}
