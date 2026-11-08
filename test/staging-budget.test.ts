import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { budgetSender } from '../scripts/staging/ses-budget';
const dir = mkdtempSync(join(tmpdir(), 'st5-'));
afterEach(() => vi.restoreAllMocks());
const params = { from: 'no-reply@staging.example.com', to: ['success@simulator.amazonses.com'], subject: 'ST5', html: '', text: '' };
const env = {} as any;
function setup(file = ':memory:', limits = { day: 3, hour: 2 }, clock = () => Date.now()) {
 const db = new Database(file); db.pragma('busy_timeout=5000');
 const provider = vi.fn(async () => ({ ok: true, status: 200, response: '{}' }));
 const query = async (sql: string, values: (string|number)[] = []) => (() => { const s=db.prepare(sql); return s.reader ? s.all(...values) as any[] : (s.run(...values), []); })();
 return { db, provider, send: budgetSender(query, provider, params.from, limits, clock) };
}
it('reserves atomically before AWS and records explicit refusals', async () => {
 const s = setup();
 const results = await Promise.all(Array.from({length: 20}, () => s.send(env, params)));
 expect(results.filter(r=>r.ok)).toHaveLength(2); expect(s.provider).toHaveBeenCalledTimes(2);
 expect(s.db.prepare('select count(*) n from st5_rejections').get()).toEqual({n:18});
 expect(results.find(r=>!r.ok)).toMatchObject({status:429,response:'staging_ses_limit'}); s.db.close();
});
it('uses rolling hour and day windows and allows rejected requests after expiry', async () => {
 let now = 100000000; const s = setup(':memory:', {day:3,hour:2},()=>now);
 expect((await s.send(env,params)).ok).toBe(true); expect((await s.send(env,params)).ok).toBe(true);
 expect((await s.send(env,params)).ok).toBe(false); now += 3600000;
 expect((await s.send(env,params)).ok).toBe(true); expect((await s.send(env,params)).ok).toBe(false);
 now += 86400000; expect((await s.send(env,params)).ok).toBe(true); s.db.close();
});
it('survives closed connections and competing independent instances', async () => {
 const file=join(dir,'persist.db'); const a=setup(file); await a.send(env,params); a.db.close();
 const b=setup(file),c=setup(file);
 const results=await Promise.all(Array.from({length:12},(_,i)=>(i%2?b:c).send(env,params)));
 expect(results.filter(r=>r.ok)).toHaveLength(1); b.db.close(); c.db.close(); rmSync(dir,{recursive:true,force:true});
});
it('counts recipients and fails closed on storage failure or invalid limits', async () => {
 const s=setup(); expect((await s.send(env,{...params,to:[...params.to,...params.to,...params.to]})).ok).toBe(false);
 expect(s.provider).not.toHaveBeenCalled(); s.db.close(); expect((await s.send(env,params)).response).toBe('staging_ses_store_unavailable');
 expect(()=>setup(':memory:',{day:0,hour:2})).toThrow();
});
it('never releases an admitted slot on provider refusal or uncertain outcome', async()=>{
 const s=setup(':memory:',{day:1,hour:1}); s.provider.mockResolvedValueOnce({ok:false,status:500,response:'no'});
 await s.send(env,params); expect((await s.send(env,params)).ok).toBe(false); expect(s.provider).toHaveBeenCalledTimes(1); s.db.close();
});

it('does not poison shared delivery idempotency when the budget denies a send', async () => {
 const { renderAndSend } = await import('../src/send');
 const { createSqliteStore } = await import('../src/core/store/sqlite');
 const { getTemplate } = await import('../src/templates');
 const { loadConfig } = await import('../src/core/config/load');
 const { default: example } = await import('../config/mailstack.example.json');
 const input=structuredClone(example); input.logging.defaults.level='none'; input.logging.brands={};
 const cfg=loadConfig(JSON.stringify(input)); const store=createSqliteStore(':memory:'); await store.migrate();
 let now=100000000; const s=setup(':memory:',{day:1,hour:1},()=>now);
 const deps={store,logging:cfg.logging,provider:'ses' as const,sendEmail:s.send,verifyAltcha:vi.fn(),verifyTurnstile:vi.fn(),now:()=>new Date(now)};
 const call=(key:string)=>renderAndSend(deps,env,{...cfg.brands.acme,from:params.from},getTemplate('notice')!,{heading:'ST5'},{clientId:'staging',idempotencyKey:key,to:params.to});
 expect((await call('first')).ok).toBe(true); expect((await call('retry')).ok).toBe(false);
 now+=86400000; expect((await call('retry')).ok).toBe(true); expect((await call('retry')).idempotent).toBe(true);
 expect(s.provider).toHaveBeenCalledTimes(2); s.db.close(); await store.db.destroy();
});
it('serializes concurrent reservations in the D1 runtime', async()=>{
 const {Miniflare,convertV4MiniflareOptions}=await import('miniflare');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-06-01',d1Databases:['DB']}));
 try {
  const db=await mf.getD1Database('DB'); const provider=vi.fn(async()=>({ok:true,status:200,response:'{}'}));
  const send=budgetSender(async(sql,values=[])=>{const r=await db.prepare(sql).bind(...values).all();return r.results;},provider,params.from,{day:3,hour:3});
  const results=await Promise.all(Array.from({length:12},()=>send(env,params)));
  expect(results.filter(r=>r.ok)).toHaveLength(3); expect(provider).toHaveBeenCalledTimes(3);
  expect(await db.prepare('select count(*) n from st5_rejections').first('n')).toBe(9);
 }finally{await mf.dispose();}
});

it('requires a configured sender and refuses other senders or non-simulator recipients', async () => {
 const s=setup();
 for (const invalid of [{...params,from:'other@staging.example.com'}, {...params,to:['buyer@example.com']}]) {
  expect(await s.send(env,invalid)).toMatchObject({ok:false,status:403,response:'staging_recipient_not_allowed'});
 }
 expect(s.provider).not.toHaveBeenCalled();
 expect(s.db.prepare('select count(*) n from st5_ses_budget').get()).toEqual({n:0});
 expect(()=>budgetSender(async()=>[],s.provider,'')).toThrow('Configure the staging sender');
 s.db.close();
});
