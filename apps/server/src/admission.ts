/** Bound aggregate authenticated binary work before request parsers allocate. */
export class BinaryAdmission {
  private count=0;
  private reserved=0;
  private large=0;
  constructor(private readonly maximumBytes:number,private readonly maximumConcurrent=2,private readonly largeThreshold=16*1024*1024){}
  acquire(expectedBytes:number):(()=>void)|null{
    const weight=Math.max(1024*1024,Math.min(this.maximumBytes,Number.isSafeInteger(expectedBytes)&&expectedBytes>=0?expectedBytes:this.maximumBytes)),isLarge=weight>=this.largeThreshold;
    if(this.count>=this.maximumConcurrent||this.large||isLarge&&this.count||this.reserved+weight>this.maximumBytes)return null;
    this.count++;this.reserved+=weight;if(isLarge)this.large++;
    let released=false;return ()=>{if(released)return;released=true;this.count--;this.reserved-=weight;if(isLarge)this.large--;};
  }
}
