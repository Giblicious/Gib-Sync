import {describe,expect,it} from "vitest";
import jsQR from "jsqr";
import {normalizeSetupServer,parseSetupInvite,parseSetupInviteUrl,renderSetupQr,setupInviteUrl,setupQrMatrix} from "./setup-qr";

const now=1_800_000_000_000,expires=now+60_000,server="https://sync.example.test/disposable-prefix";
const params={action:"gib-sync-setup",server,code:"01234",expires:String(expires)};
describe("temporary QR setup invitations",()=>{
  it("preserves leading zeroes and proxy prefixes without encoding credentials",()=>{
    expect(parseSetupInvite(params,now)).toEqual({server,code:"01234",expiresAt:expires});
    const url=setupInviteUrl(server+"/","01234",expires,now);expect(url).toBe(`${server}/setup?code=01234&expires=${expires}`);
    expect(parseSetupInviteUrl(url,now)).toEqual({server,code:"01234",expiresAt:expires});expect(url).not.toMatch(/token|password|key|ticket|vault/i);
  });
  it("permits explicit loopback development without permitting remote plaintext",()=>{for(const host of ["localhost","127.0.0.1","[::1]"])expect(normalizeSetupServer(`http://${host}:8787`)).toBe(`http://${host}:8787`);});
  it.each(["http://sync.example.test","file:///vault","javascript:alert(1)","data:text/html,hello","https://user:password@sync.example.test","https://sync.example.test?token=secret","https://sync.example.test#fragment","/relative","https://sync.example.test\\@evil.test","https://sync.example.test\n"])("rejects an unsafe server without exposing its input: %s",value=>{expect(()=>normalizeSetupServer(value)).toThrow("invalid or expired");});
  it.each(["1234","123456","12a45","１２３４５"," 12345",12345,null])("requires exactly five ASCII digits: %j",code=>{expect(()=>parseSetupInvite({...params,code},now)).toThrow();});
  it.each([String(now),String(now-1),String(now+120_001),"NaN","Infinity",`${expires}junk`,expires,null])("rejects expired, fabricated future or malformed expiry: %j",value=>{expect(()=>parseSetupInvite({...params,expires:value},now)).toThrow();});
  it.each([{action:"open"},{password:"hidden"},{ticket:"hidden"},{vault:123}])("rejects action smuggling/unknown fields: %j",extra=>{expect(()=>parseSetupInvite({...params,...extra},now)).toThrow();});
  it("accepts Obsidian's optional vault selector but does not treat it as connection authority",()=>{expect(parseSetupInvite({...params,vault:"Disposable test"},now)).toEqual({server,code:"01234",expiresAt:expires});});
  it("does not accept inherited invitation fields as protocol parameters",()=>{expect(()=>parseSetupInvite(Object.create(params),now)).toThrow();});
  it.each([`?code=01234&code=54321&expires=${expires}`,`?code=01234&expires=${expires}&server=https%3A%2F%2Fevil.test`,`?code=01234&expires=${expires}&expires=${expires}`])("rejects duplicate or foreign URL parameters: %s",query=>{expect(()=>parseSetupInviteUrl(`${server}/setup${query}`,now)).toThrow();});
  it("does not accept unrelated paths or fragments as invitations",()=>{expect(()=>parseSetupInviteUrl(`${server}/setup/no?code=01234&expires=${expires}`,now)).toThrow();expect(()=>parseSetupInviteUrl(`${server}/setup?code=01234&expires=${expires}#key`,now)).toThrow();});
  it("independently decodes the generated QR to the exact credential-free HTTPS invitation",()=>{
    const url=setupInviteUrl(server,"01234",expires,now),matrix=setupQrMatrix(url,now),quiet=4,scale=6,width=(matrix.size+quiet*2)*scale,data=new Uint8ClampedArray(width*width*4);
    for(let y=0;y<width;y++)for(let x=0;x<width;x++){const row=Math.floor(y/scale)-quiet,column=Math.floor(x/scale)-quiet,black=row>=0&&column>=0&&row<matrix.size&&column<matrix.size&&matrix.data[row*matrix.size+column];const offset=(y*width+x)*4;data[offset]=data[offset+1]=data[offset+2]=black?0:255;data[offset+3]=255;}
    expect(jsQR(data,width,width)?.data).toBe(url);
  });
  it("renders only local static SVG geometry with a white quiet zone, no HTML/URLs",()=>{
    class Element{attributes=new Map<string,string>();children:Element[]=[];setAttribute(key:string,value:string){this.attributes.set(key,value);}appendChild(child:Element){this.children.push(child);return child;}}
    const document={createElementNS:()=>new Element()},container={ownerDocument:document,replaceChildren:(...nodes:Element[])=>{output=nodes;}};let output:Element[]=[];
    // Real rendering follows current expiry; deterministic matrix correctness is independently tested above.
    const realUrl=setupInviteUrl(server,"01234",Date.now()+60_000);
    renderSetupQr(container as unknown as HTMLElement,realUrl);expect(output).toHaveLength(1);expect(output[0]!.attributes.get("role")).toBe("img");expect(output[0]!.children[0]!.attributes.get("fill")).toBe("#fff");expect(output[0]!.children[1]!.attributes.get("fill")).toBe("#000");expect(output[0]!.children[1]!.attributes.get("d")).toMatch(/^M\d+ \d+h1v1h-1z/);expect(JSON.stringify([...output[0]!.attributes])).not.toContain(server);
  });
});
