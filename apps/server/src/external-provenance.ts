import type {ReadableEvent} from './seafile.js';

export interface ExternalCreationProof {commitId:string;originPath:string;mtime:number;directory:boolean;recreated:boolean;}
/** Follow explicit immutable commit events, including collapsed subtree diffs.
 * Renames move the proof's location, never its original creation identity. */
export function externalCreationProofs(events:ReadableEvent[],acceptedPaths:Iterable<string>):Map<string,ExternalCreationProof>{
  const known=new Set(acceptedPaths),retired=new Set<string>(),created=new Map<string,ExternalCreationProof>();
  const within=(path:string,root:string)=>path===root||path.startsWith(`${root}/`);
  for(const event of events){
    if(event.operation==='deleted'){
      retired.add(event.path);for(const path of new Set([...known,...created.keys()]))if(path===event.path||event.directory&&within(path,event.path)){retired.add(path);created.delete(path);}
    }else if(event.operation==='created'){
      const recreated=retired.has(event.path),proof={commitId:event.commitId,originPath:event.path,mtime:event.mtime,directory:Boolean(event.directory),recreated};created.set(event.path,proof);known.add(event.path);retired.delete(event.path);
      if(recreated&&event.directory)for(const path of [...retired])if(within(path,event.path)){created.set(path,{...proof,originPath:path,directory:false});retired.delete(path);}
    }else if(event.operation==='renamed'&&event.previousPath){
      const from=event.previousPath,to=event.path,move=(path:string)=>`${to}${path.slice(from.length)}`;
      const proofs=[...created].filter(([path])=>within(path,from));for(const [path] of proofs)created.delete(path);for(const [path,proof] of proofs)created.set(move(path),proof);
      for(const set of [known,retired]){const paths=[...set].filter(path=>within(path,from));for(const path of paths)set.delete(path);for(const path of paths)set.add(move(path));}
    }
  }
  return created;
}
