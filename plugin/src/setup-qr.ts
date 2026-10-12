/*!
 * Bundled QR dependencies: qrcode (Copyright (c) 2012 Ryan Day), and
 * dijkstrajs (Copyright (C) 2008 Wyatt Baldwin). MIT License.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import QRCode from "qrcode";

export const SETUP_PROTOCOL_ACTION="gib-sync-setup";
export interface SetupInvite {server:string;code:string;expiresAt:number;}
const failure=():never=>{throw new Error("This setup QR is invalid or expired. Ask the connected device for a fresh QR.");};

/** Only public HTTPS or explicit loopback development endpoints are eligible.
 * Never accept URL credentials, hidden query parameters or a transport downgrade. */
export function normalizeSetupServer(value:string):string{
  if(typeof value!=="string"||!value||value.length>2048||/[\u0000-\u0020\u007f\\]/.test(value))return failure();
  let url:URL;try{url=new URL(value);}catch{return failure();}
  const loopback=["localhost","127.0.0.1","[::1]"].includes(url.hostname);
  if(url.protocol!=="https:"&&!(url.protocol==="http:"&&loopback)||url.username||url.password||url.search||url.hash||!url.hostname)return failure();
  return `${url.origin}${url.pathname.replace(/\/+$/,"")}`;
}

function invite(server:unknown,code:unknown,expires:unknown,now:number):SetupInvite{
  if(typeof server!=="string"||typeof code!=="string"||!/^\d{5}$/.test(code)||typeof expires!=="string"||!/^\d{13}$/.test(expires)||!Number.isFinite(now))return failure();
  const expiresAt=Number(expires);if(!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt>now+120_000)return failure();
  return {server:normalizeSetupServer(server),code,expiresAt};
}

/** Obsidian decodes protocol parameters once. No network or settings mutation
 * occurs here; the receiver must review its vault/server and press Connect. */
export function parseSetupInvite(params:Record<string,unknown>,now=Date.now()):SetupInvite{
  if(!params||typeof params!=="object"||Array.isArray(params)||["server","code","expires"].some(key=>!Object.hasOwn(params,key))||Object.keys(params).some(key=>!["action","server","code","expires","vault"].includes(key)))return failure();
  if(params.action!==undefined&&params.action!==SETUP_PROTOCOL_ACTION||params.vault!==undefined&&typeof params.vault!=="string")return failure();
  return invite(params.server,params.code,params.expires,now);
}

export function setupInviteUrl(server:string,code:string,expiresAt:number,now=Date.now()):string{
  const parsed=invite(server,code,String(expiresAt),now);
  const url=new URL(`${parsed.server}/setup`);url.searchParams.set("code",parsed.code);url.searchParams.set("expires",String(parsed.expiresAt));return url.toString();
}

/** The HTTPS QR contains no vault key, password, device token or approval ticket. */
export function parseSetupInviteUrl(value:string,now=Date.now()):SetupInvite{
  if(typeof value!=="string"||value.length>4096||/[\u0000-\u0020\u007f\\]/.test(value))return failure();
  let url:URL;try{url=new URL(value);}catch{return failure();}
  if(url.username||url.password||url.hash||!url.pathname.endsWith("/setup")||[...url.searchParams.keys()].some(key=>!["code","expires"].includes(key))||url.searchParams.getAll("code").length!==1||url.searchParams.getAll("expires").length!==1)return failure();
  return invite(`${url.origin}${url.pathname.slice(0,-"/setup".length)}`,url.searchParams.get("code"),url.searchParams.get("expires"),now);
}

export function setupQrMatrix(value:string,now=Date.now()):{size:number;data:Uint8Array}{
  const parsed=parseSetupInviteUrl(value,now),canonical=setupInviteUrl(parsed.server,parsed.code,parsed.expiresAt,now);
  const modules=QRCode.create(canonical,{errorCorrectionLevel:"M"}).modules;
  if(modules.size<21||modules.size>177||modules.data.length!==modules.size**2)return failure();
  return {size:modules.size,data:modules.data};
}

/** Native SVG: no remote encoder, HTML interpolation, canvas or camera access. */
export function renderSetupQr(container:HTMLElement,value:string):SVGSVGElement{
  const {size,data}=setupQrMatrix(value),quiet=4,extent=size+quiet*2,document=container.ownerDocument;
  const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.setAttribute("viewBox",`0 0 ${extent} ${extent}`);svg.setAttribute("width","320");svg.setAttribute("height","320");
  svg.setAttribute("role","img");svg.setAttribute("aria-label","Temporary Gib Sync setup QR");svg.setAttribute("shape-rendering","crispEdges");
  const background=document.createElementNS("http://www.w3.org/2000/svg","rect");background.setAttribute("width",String(extent));background.setAttribute("height",String(extent));background.setAttribute("fill","#fff");svg.appendChild(background);
  const parts:string[]=[];for(let row=0;row<size;row++)for(let column=0;column<size;column++)if(data[row*size+column])parts.push(`M${column+quiet} ${row+quiet}h1v1h-1z`);
  const path=document.createElementNS("http://www.w3.org/2000/svg","path");path.setAttribute("d",parts.join(""));path.setAttribute("fill","#000");svg.appendChild(path);
  container.replaceChildren(svg);return svg;
}
