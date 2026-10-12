import {afterEach,describe,expect,it,vi} from "vitest";
import type {Config} from "./config.js";
import {SeafileStorage,type VaultStorageRow} from "./seafile.js";

// Primary schema: haiwen/seahub/seahub/api2/endpoints/repo_commit.py
// RepoCommitView.diff_status_dict emits new, removed, renamed, modified, newdir, deldir.
const config={SEAFILE_URL:"https://seafile.example.test",SEAFILE_USERNAME:"test@example.test",SEAFILE_PASSWORD:"test",SEAFILE_LIBRARY:"Notes",MAX_BLOB_BYTES:1024,GIBSYNC_SERVER_SECRET:"disposable-test-secret-at-least-thirty-two-bytes"} as Config;
afterEach(()=>vi.unstubAllGlobals());
function fixture(diffs:Array<Record<string,unknown>>){const storage=new SeafileStorage(config),id="11111111-1111-4111-8111-111111111111",commitId="a".repeat(40),row:VaultStorageRow={id,storage_url:config.SEAFILE_URL,storage_username:"test@example.test",storage_repo_id:"repo",storage_repo_name:"Notes",storage_base_path:"/Notes",storage_token:storage.sealToken(id,"test-token"),storage_layout:"standard",mirror_base_path:"/Notes",mirror_head_id:null};vi.spyOn(storage,"repoHistory").mockResolvedValue([{commitId,mtime:1,size:0}]);vi.stubGlobal("fetch",vi.fn(async()=>Response.json({commit_diffs:diffs})));return {storage,row,commitId};}
describe("official Seafile causal operation proof",()=>{
  it("ignores normal private sidecar commits and unknown operations before public path validation",async()=>{
    const f=fixture([{op_type:"newdir",path:"/Notes/.gib-sync"},{op_type:"new",path:"/Notes/.gib-sync/blobs/hash.bin"},{op_type:"modified",path:"/Notes/.gib-sync/readable-generation.gib"},{op_type:"removed",path:"/Notes/.gib-sync/mutation-fences/fence.bin"},{op_type:"renamed",path:"/Notes/.gib-sync/snapshots/old.json",new_path:"/Notes/.gib-sync/snapshots/new.json"},{op_type:"renamed",path:"/Notes/note.md",new_path:"/Notes/.gib-sync/private"},{op_type:"unknown",path:"/Notes/../invalid"},{op_type:"new",path:"/Notes/real.md"}]);
    expect(await f.storage.readableEvents(f.row,"b".repeat(40))).toEqual([{commitId:f.commitId,mtime:1,operation:"created",path:"real.md"}]);
    expect(await f.storage.readableRenames(f.row,"b".repeat(40))).toEqual([]);
  });
  it("accepts only official operation values and derives directory creation/deletion from op_type",async()=>{
    const f=fixture([{op_type:"new",path:"/Notes/new.md"},{op_type:"removed",path:"/Notes/deleted.md"},{op_type:"modified",path:"/Notes/edit.md"},{op_type:"renamed",path:"/Notes/old.md",new_path:"/Notes/new-name.md"},{op_type:"newdir",path:"/Notes/New folder"},{op_type:"deldir",path:"/Notes/Deleted folder"}]),events=await f.storage.readableEvents(f.row,"b".repeat(40));expect(events).toEqual([{commitId:f.commitId,mtime:1,operation:"created",path:"new.md"},{commitId:f.commitId,mtime:1,operation:"deleted",path:"deleted.md"},{commitId:f.commitId,mtime:1,operation:"modified",path:"edit.md"},{commitId:f.commitId,mtime:1,operation:"renamed",path:"new-name.md",previousPath:"old.md"},{commitId:f.commitId,mtime:1,operation:"created",path:"New folder",directory:true},{commitId:f.commitId,mtime:1,operation:"deleted",path:"Deleted folder",directory:true}]);
  });
  it("cannot turn unknown values or cross-root operations into causal recreation authority",async()=>{
    const f=fixture([...["add","del","added","created","deleted","recreated","unknown",""].map(op_type=>({op_type,path:"/Notes/note.md",is_dir:true})),{op_type:"new",path:"/Other/note.md"},{op_type:"new",path:"/Notes-other/note.md"},{op_type:"renamed",path:"/Notes/note.md",new_path:"/Other/note.md"}]);expect(await f.storage.readableEvents(f.row,"b".repeat(40))).toEqual([]);
  });
});
