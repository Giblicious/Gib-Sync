// A sync run never retains an entire vault's downloaded or uploaded bodies.
// Generated merge results are spooled separately by the engine before eviction.
export class BodyCache extends Map<string,Uint8Array> {
  private retained=0;
  constructor(readonly budgetBytes:number){super();}
  override get(key:string):Uint8Array|undefined {
    const value=super.get(key);if(value){super.delete(key);super.set(key,value);}return value;
  }
  override set(key:string,value:Uint8Array):this {
    this.delete(key);
    if(value.byteLength>this.budgetBytes)return this;
    while(this.retained+value.byteLength>this.budgetBytes){const oldest=this.keys().next().value;if(oldest===undefined)break;this.delete(oldest);}
    super.set(key,value);this.retained+=value.byteLength;return this;
  }
  override delete(key:string):boolean {const value=super.get(key);if(!value)return false;this.retained-=value.byteLength;return super.delete(key);}
  override clear():void {super.clear();this.retained=0;}
  get retainedBytes():number{return this.retained;}
}
