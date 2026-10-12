import {createHash} from 'node:crypto';
import type {FastifyInstance,FastifyReply} from 'fastify';

const css='body{font-family:system-ui,sans-serif;background:#171b20;color:#eef2f5;margin:0;padding:2rem 1rem;line-height:1.5}main{max-width:26rem;margin:4rem auto}h1{font-size:1.5rem}p{color:#c8d0d8}a{display:block;background:#357b56;color:white;text-decoration:none;text-align:center;padding:1rem;border-radius:.6rem;font-weight:600}a:focus-visible{outline:3px solid white;outline-offset:4px}';
const styleHash=createHash('sha256').update(css).digest('base64');
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));

/** Invitations never accept an alternate server from a Host header or query. */
function canonicalServer(publicUrl:string):string|null{
  if(publicUrl.length>2048)return null;
  try{
    const url=new URL(publicUrl),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&local))return null;
    return url.toString().replace(/\/+$/,'');
  }catch{return null;}
}
export function invitationSetupUrl(publicUrl:string,code:string,expiresAt:string):string|undefined{
  const server=canonicalServer(publicUrl),expires=Date.parse(expiresAt);
  if(!server||!/^\d{5}$/.test(code)||!Number.isSafeInteger(expires)||expires<=0)return undefined;
  return `${server}/setup?code=${code}&expires=${expires}`;
}
export function invitationHeaders(reply:FastifyReply):void{
  reply.header('Cache-Control','no-store').header('Pragma','no-cache').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff').header('X-Frame-Options','DENY')
    .header('Content-Security-Policy',`default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
}
/** Shape/expiry only: no code lookup, credential delivery, or consumed-code oracle. */
export function renderSetupInvitation(publicUrl:string,requestUrl:string,now=Date.now()):string{
  const server=canonicalServer(publicUrl);let link:string|null=null;
  if(server&&requestUrl.startsWith('/')&&requestUrl.length<=1024){
    const query=new URLSearchParams(requestUrl.includes('?')?requestUrl.slice(requestUrl.indexOf('?')+1):''),code=query.get('code'),rawExpires=query.get('expires');
    if([...query.keys()].every(key=>key==='code'||key==='expires')&&query.getAll('code').length===1&&query.getAll('expires').length===1&&code&&/^\d{5}$/.test(code)&&rawExpires&&/^[1-9]\d{0,15}$/.test(rawExpires)){
      const expires=Number(rawExpires);
      if(Number.isSafeInteger(expires)&&expires>now&&expires<=now+120_000)link=`obsidian://gib-sync-setup?server=${encodeURIComponent(server)}&code=${code}&expires=${expires}`;
    }
  }
  const content=link?`<h1>Connect this device</h1><p>Open the destination vault in Obsidian with Gib Sync installed and enabled. Your other device must approve this connection.</p><a href="${escapeHtml(link)}">Open Gib Sync in Obsidian</a><p>If Obsidian does not open, return to Gib Sync settings and use the short code instead.</p>`:'<h1>Invitation unavailable</h1><p>This setup invitation has expired or is invalid. Generate a fresh invitation in Gib Sync on your connected device.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Gib Sync setup</title><style>${css}</style></head><body><main>${content}</main></body></html>`;
}
export function registerSetupInvitation(app:FastifyInstance,publicUrl:string):void{
  app.get('/setup',async(request,reply)=>{invitationHeaders(reply);return reply.type('text/html; charset=utf-8').send(renderSetupInvitation(publicUrl,request.url));});
}
