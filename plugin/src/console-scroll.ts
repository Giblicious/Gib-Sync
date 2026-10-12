interface ScrollRoot{isConnected:boolean;scrollTop:number;}
/** Follow after a paint, without reading scrollHeight after DOM mutations.
 * A user scroll between scheduling and follow always wins. */
export class ConsoleScrollFollower{
  private frame:number|null=null;
  private target:{root:ScrollRoot;top:number}|null=null;
  constructor(private readonly request:(callback:()=>void)=>number=callback=>requestAnimationFrame(callback),private readonly cancel:(id:number)=>void=id=>cancelAnimationFrame(id)){}
  schedule(root:ScrollRoot,top:number):void{
    this.target={root,top};if(this.frame!==null)return;
    this.frame=this.request(()=>{this.frame=this.request(()=>{
      this.frame=null;const target=this.target;this.target=null;
      if(target?.root.isConnected&&target.root.scrollTop===target.top)target.root.scrollTop=Number.MAX_SAFE_INTEGER;
    });});
  }
  stop():void{if(this.frame!==null)this.cancel(this.frame);this.frame=null;this.target=null;}
}
