import { resolve } from "node:path";
import { ContainmentService } from "./containment.js";
import { Store } from "./db.js";
import { auditHeadIntegrity } from "./integrity.js";
import { planLegacyFolderDescendantRepair,planMissingLegacyFolderRetirementDirective,planRetiredLegacyFolderRepair } from "./folder-migration.js";
import { VaultRetirementService } from "./vault-retirement.js";

function value(args:string[],name:string):string|null{const index=args.indexOf(name);return index>=0?args[index+1]??null:null;}
function required(args:string[],name:string):string{const result=value(args,name);if(!result)throw new Error(`${name} is required`);return result;}

const args=process.argv.slice(2),dataDir=resolve(process.env.DATA_DIR??"./data"),store=new Store(dataDir),containment=new ContainmentService(store),retirements=new VaultRetirementService(store);
function vault(){const id=value(args,"--vault-id"),name=value(args,"--vault-name"),matches=id?store.all<{id:string;name:string;head_id:string|null}>("SELECT id,name,head_id FROM vaults WHERE id=?",id):name?store.all<{id:string;name:string;head_id:string|null}>("SELECT id,name,head_id FROM vaults WHERE name=?",name):[];if(matches.length!==1)throw new Error(`Expected exactly one vault; found ${matches.length}`);return matches[0];}
try{
  if(args[0]==="audit"){
    const selected=vault(),audit=selected.head_id?auditHeadIntegrity(store,selected.id,selected.head_id):{valid:true,issues:[]};console.log(JSON.stringify({vault:selected.name,hasHead:Boolean(selected.head_id),...audit},null,2));
  }else if(args[0]==="folder-repair"&&args[1]==="preview"){
    const selected=vault(),plan=selected.head_id?(planLegacyFolderDescendantRepair(store,selected.id,selected.head_id)??planRetiredLegacyFolderRepair(store,selected.id,selected.head_id)??planMissingLegacyFolderRetirementDirective(store,selected.id,selected.head_id)):null;console.log(JSON.stringify({vault:selected.name,repairNeeded:Boolean(plan),currentFolders:plan?.currentFolders.length??0,contaminatedFolders:plan?.contaminatedFolders.length??0,desiredFolders:plan?.desiredFolders.length??0},null,2));
  }else if(args[0]==="vault-retirement"){
    if(args[1]==="status"){
      const selected=value(args,"--vault-id")||value(args,"--vault-name");console.log(JSON.stringify(selected?retirements.state(vault().id):retirements.all(),null,2));
    }else if(args[1]==="retire")console.log(JSON.stringify(retirements.retire(vault().id,required(args,"--reason")),null,2));
    else if(args[1]==="restore")console.log(JSON.stringify(retirements.restore(vault().id,value(args,"--reason")??"Vault registration restored by operator"),null,2));
    else throw new Error("Usage: vault-retirement status|retire|restore [--vault-id ID|--vault-name NAME] [--reason REASON]");
  }else if(args[0]!=="containment")throw new Error("Usage: containment status|enable|disable | audit --vault-name NAME | folder-repair preview --vault-name NAME | vault-retirement status|retire|restore");
  else if(args[1]==="status")console.log(JSON.stringify(containment.state(),null,2));
  else if(args[1]==="enable"){
    const id=value(args,"--allow-vault-id"),name=value(args,"--allow-vault-name");
    let vaultId=id;
    if(!vaultId&&name){const matches=store.all<{id:string}>("SELECT id FROM vaults WHERE name=?",name);if(matches.length!==1)throw new Error(`Expected exactly one vault named ${name}; found ${matches.length}`);vaultId=matches[0].id;}
    if(!vaultId)throw new Error("--allow-vault-id or --allow-vault-name is required");
    console.log(JSON.stringify(containment.enable(vaultId,required(args,"--reason")),null,2));
  }else if(args[1]==="disable")console.log(JSON.stringify(containment.disable(value(args,"--reason")??"Containment cleared by operator"),null,2));
  else throw new Error("Usage: containment status|enable|disable");
}finally{store.db.close();}
