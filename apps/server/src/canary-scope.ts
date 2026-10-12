import type {Config} from "./config.js";
import type {Store} from "./db.js";

const normalizedAccount=(value:string)=>value.trim().toLowerCase();
const normalizedUrl=(value:string)=>{const url=new URL(value);if(url.username||url.password||url.search||url.hash)throw new Error("Canary storage URL cannot contain credentials or query state");return `${url.origin}${url.pathname.replace(/\/+$/,"")}`;};
const forbidden=():never=>{throw Object.assign(new Error("This isolated validation server accepts only its dedicated test account and library"),{statusCode:403});};
/** Optional hard scope: applied before backend authentication and before workers. */
export class CanaryScope{
  readonly enabled:boolean;
  private readonly account:string|null;
  private readonly libraryId:string|null;
  private readonly url:string|null;
  constructor(config:Config){
    this.enabled=Boolean(config.GIBSYNC_CANARY_USERNAME||config.GIBSYNC_CANARY_LIBRARY_ID||config.GIBSYNC_CANARY_URL);
    if(this.enabled&&(!config.GIBSYNC_CANARY_USERNAME||!config.GIBSYNC_CANARY_LIBRARY_ID))throw new Error("Both dedicated canary account and library are required");
    this.account=this.enabled?normalizedAccount(config.GIBSYNC_CANARY_USERNAME!):null;this.libraryId=config.GIBSYNC_CANARY_LIBRARY_ID??null;this.url=this.enabled?normalizedUrl(config.GIBSYNC_CANARY_URL??config.SEAFILE_URL):null;
    if(this.enabled&&(!this.account||!/^\p{ASCII_Hex_Digit}{8}-\p{ASCII_Hex_Digit}{4}-\p{ASCII_Hex_Digit}{4}-\p{ASCII_Hex_Digit}{4}-\p{ASCII_Hex_Digit}{12}$/u.test(this.libraryId!)||new URL(this.url!).host!==new URL(config.SEAFILE_URL).host))throw new Error("Invalid isolated canary storage scope");
  }
  assertCredentials(url:string,username:string):void{if(this.enabled&&(normalizedAccount(username)!==this.account||normalizedUrl(url)!==this.url))forbidden();}
  assertLibrary(libraryId:string):void{if(this.enabled&&libraryId!==this.libraryId)forbidden();}
  libraries<T extends {id:string}>(libraries:T[]):T[]{return this.enabled?libraries.filter(library=>library.id===this.libraryId):libraries;}
  assertStore(store:Store):void{if(!this.enabled)return;for(const row of store.all<{storage_url:string|null;storage_username:string|null;storage_repo_id:string|null}>("SELECT storage_url,storage_username,storage_repo_id FROM vaults")){if(!row.storage_url||!row.storage_username||!row.storage_repo_id)throw new Error("An isolated canary database cannot contain unscoped vaults");this.assertCredentials(row.storage_url,row.storage_username);this.assertLibrary(row.storage_repo_id);}}
}
