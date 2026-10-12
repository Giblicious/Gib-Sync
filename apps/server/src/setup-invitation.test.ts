import Fastify from 'fastify';
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {invitationSetupUrl,qrInvitationSetupUrl,registerSetupInvitation,renderSetupInvitation} from './setup-invitation.js';

const now=1_790_000_000_000,expires=now+60_000,server='https://sync.example.test/private-validation/prefix///';
const valid=`/setup?code=00123&expires=${expires}`;
const anchor=(html:string)=>html.match(/<a href="([^"]+)">/)?.[1]?.replaceAll('&amp;','&');
describe('HTTPS Obsidian setup invitation',()=>{
  it('supports a ten-minute token invitation while retaining short-code bounds',()=>{const token='a'.repeat(43),expiry=now+600_000,url=qrInvitationSetupUrl(server,token,new Date(expiry).toISOString())!;expect(url).toContain(`token=${token}&expires=${expiry}`);const action=new URL(anchor(renderSetupInvitation(server,new URL(url).pathname+new URL(url).search,now))!);expect(action.searchParams.get('token')).toBe(token);expect(action.searchParams.has('code')).toBe(false);expect(anchor(renderSetupInvitation(server,`/setup?token=${token}&expires=${expiry}`,expiry))).toBeUndefined();expect(anchor(renderSetupInvitation(server,`/setup?token=${token}&expires=${expiry+1}`,now))).toBeUndefined();expect(anchor(renderSetupInvitation(server,`/setup?token=${token}&code=12345&expires=${expiry}`,now))).toBeUndefined();expect(anchor(renderSetupInvitation(server,`/setup?token=${token}&token=${token}&expires=${expiry}`,now))).toBeUndefined();});
  it('preserves the configured proxy prefix and exact pairing expiry without secrets',()=>{
    expect(invitationSetupUrl(server,'00123',new Date(expires).toISOString())).toBe(`https://sync.example.test/private-validation/prefix/setup?code=00123&expires=${expires}`);
    const target=new URL(anchor(renderSetupInvitation(server,valid,now))!);
    expect(target.protocol).toBe('obsidian:');expect(target.hostname).toBe('gib-sync-setup');expect([...target.searchParams.keys()]).toEqual(['server','code','expires']);
    expect(target.searchParams.get('server')).toBe('https://sync.example.test/private-validation/prefix');expect(target.searchParams.get('code')).toBe('00123');expect(target.searchParams.get('expires')).toBe(String(expires));
  });
  it('requires an explicit tap and keeps a static bounded page without JavaScript, assets, or redirects',()=>{
    const html=renderSetupInvitation(server,valid,now);expect(html).toContain('Open Gib Sync in Obsidian');expect(html).toContain('other device must approve');expect(html).not.toMatch(/<script|<iframe|<img|http-equiv|onload=|onclick=|javascript:/i);expect(Buffer.byteLength(html)).toBeLessThan(4096);
  });
  it.each([
    '/setup','/setup?code=12345','/setup?expires='+expires,
    '/setup?code=1234&expires='+expires,'/setup?code=123456&expires='+expires,
    '/setup?code=１２３４５&expires='+expires,'/setup?code=%2012345&expires='+expires,
    '/setup?code=12345&expires='+(now-1),'/setup?code=12345&expires='+now,
    '/setup?code=12345&expires='+(now+120_001),'/setup?code=12345&expires=Infinity',
    '/setup?code=12345&expires=1e20','/setup?code=12345&expires=-1',
    '/setup?code=12345&expires=01790000060000','/setup?code=12345&expires='+expires+'.0',
    '/setup?code=12345&expires='+expires+'&expires='+expires,
    '/setup?code=12345&%63ode=54321&expires='+expires,
    '/setup?code=12345&code[]=54321&expires='+expires,
    '/setup?code=12345&expires='+expires+'&server=https%3A%2F%2Fattacker.example.test',
    '/setup?code=12345&expires='+expires+'&redirect=javascript%3Aalert(1)',
    '/setup?code=12345;server=attacker&expires='+expires,
    '/setup?code=%3Csvg%20onload%3Dalert(1)%3E&expires='+expires,
    '/setup?code=12345&expires='+expires+'%00',
    '/setup?code=12345&expires='+expires+'#fragment',
    '/setup?code=12345&expires='+expires+'&'+('x'.repeat(1024))
  ])('returns a safe non-interactive page for malformed or stale input: %s',requestUrl=>{
    const html=renderSetupInvitation(server,requestUrl,now);expect(anchor(html)).toBeUndefined();expect(html).toContain('Invitation unavailable');expect(html).not.toContain('attacker');expect(html).not.toMatch(/onload=|javascript:|<svg/i);expect(html).toBe(renderSetupInvitation(server,'/setup',now));
  });
  it('accepts the exact 120-second future boundary but stops at expiration',()=>{expect(anchor(renderSetupInvitation(server,`/setup?code=12345&expires=${now+120_000}`,now))).toBeDefined();expect(anchor(renderSetupInvitation(server,valid,expires))).toBeUndefined();});
  it.each(['javascript:alert(1)','https://user:password@sync.example.test/','https://sync.example.test/?server=attacker','https://sync.example.test/#fragment','http://public.example.test/','https://sync.example.test/'+('x'.repeat(2048))])('does not emit an invitation for an unsafe configured address: %s',url=>{expect(invitationSetupUrl(url,'12345',new Date(expires).toISOString())).toBeUndefined();expect(anchor(renderSetupInvitation(url,valid,now))).toBeUndefined();});
  it('permits localhost HTTP development without broadening public HTTP invitations',()=>{expect(invitationSetupUrl('http://localhost:8787/dev/','12345',new Date(expires).toISOString())).toBe(`http://localhost:8787/dev/setup?code=12345&expires=${expires}`);});
  it('ignores untrusted Host and forwarding headers and sends CSP/cache/referrer protections',async()=>{
    const app=Fastify();registerSetupInvitation(app,server);
    try{
      const response=await app.inject({method:'GET',url:`/setup?code=12345&expires=${Date.now()+60_000}`,headers:{host:'attacker.example.test','x-forwarded-host':'attacker.example.test','x-forwarded-proto':'http'}});
      expect(response.statusCode).toBe(200);expect(response.headers['content-type']).toMatch(/^text\/html/);expect(response.headers['cache-control']).toBe('no-store');expect(response.headers['referrer-policy']).toBe('no-referrer');expect(response.headers['x-content-type-options']).toBe('nosniff');expect(response.headers['x-frame-options']).toBe('DENY');
      const css=response.body.match(/<style>([\s\S]*?)<\/style>/)![1]!,digest=createHash('sha256').update(css).digest('base64');expect(response.headers['content-security-policy']).toContain("default-src 'none'");expect(response.headers['content-security-policy']).toContain(`style-src 'sha256-${digest}'`);expect(response.headers['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(new URL(anchor(response.body)!).searchParams.get('server')).toBe('https://sync.example.test/private-validation/prefix');expect(response.body).not.toContain('attacker.example.test');
    }finally{await app.close();}
  });
});
