import { resolve } from "node:path";
import { ContainmentService } from "./containment.js";
import { Store } from "./db.js";

function value(args:string[],name:string):string|null{const index=args.indexOf(name);return index>=0?args[index+1]??null:null;}
function required(args:string[],name:string):string{const result=value(args,name);if(!result)throw new Error(`${name} is required`);return result;}

const args=process.argv.slice(2),dataDir=resolve(process.env.DATA_DIR??"./data"),store=new Store(dataDir),containment=new ContainmentService(store);
try{
  if(args[0]!=="containment")throw new Error("Usage: containment status|enable|disable");
  if(args[1]==="status")console.log(JSON.stringify(containment.state(),null,2));
  else if(args[1]==="enable"){
    const id=value(args,"--allow-vault-id"),name=value(args,"--allow-vault-name");
    let vaultId=id;
    if(!vaultId&&name){const matches=store.all<{id:string}>("SELECT id FROM vaults WHERE name=?",name);if(matches.length!==1)throw new Error(`Expected exactly one vault named ${name}; found ${matches.length}`);vaultId=matches[0].id;}
    if(!vaultId)throw new Error("--allow-vault-id or --allow-vault-name is required");
    console.log(JSON.stringify(containment.enable(vaultId,required(args,"--reason")),null,2));
  }else if(args[1]==="disable")console.log(JSON.stringify(containment.disable(value(args,"--reason")??"Containment cleared by operator"),null,2));
  else throw new Error("Usage: containment status|enable|disable");
}finally{store.db.close();}
