import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import {backupBeforeUpgrade,backupIfDue} from "./backup.js";
import {SERVER_VERSION} from "./version.js";

const config = loadConfig();
await backupBeforeUpgrade(config.DATA_DIR,SERVER_VERSION);
const app = await buildApp(config);
await app.listen({ host: config.HOST, port: config.PORT });
let backupRunning=false,closing=false;
const checkBackup=()=>{
  if(backupRunning||closing)return;backupRunning=true;
  void backupIfDue(config.DATA_DIR).then(created=>{if(created)app.log.info("Recovery backup verified");},()=>app.log.error("Recovery backup failed; existing backups were retained")).finally(()=>{backupRunning=false;});
};
checkBackup();const backupTimer=setInterval(checkBackup,5*60*1000);backupTimer.unref();
for(const signal of ["SIGTERM","SIGINT"] as const)process.once(signal,()=>{
  if(closing)return;closing=true;clearInterval(backupTimer);
  void app.close().catch(()=>{process.exitCode=1;});
});

