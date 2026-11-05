import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sql, type CompiledQuery, type RawBuilder } from 'kysely';
import { createD1Store } from '../src/core/store/d1';
import { appendAudit, verifyChain, type AuditRow } from '../src/core/audit';
import { runRetention } from '../src/core/retention';
import { config } from '../src/core/config';
import { insertAudit } from '../src/core/store/audit';
import { enqueueJob, runJobs } from '../src/core/jobs';
import { JOB_KINDS } from '../src/core/job-kinds';
import type { EventConsumer } from '../src/core/events';
import { createExtensionHost } from '../src/core/extension-host';
import { metered } from '../src/core/budget';
import { PARTIAL_INDEX_SCHEMA } from '../src/core/store/migration';
import type { DomainEvent } from '../src/core/extensions';
import { internalFetch } from '../src/core/internal';
import { panelClaims } from './fixtures/panel';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { createApp } from '../src/index';
import type { Env } from '../src/types';

// D1 suites seed thousands of rows in workerd; 5 s is too tight on a busy CI runner.
vi.setConfig({ testTimeout: 30000 });

// D1 calls, rows read and rows written (`meta`, index writes included) of everything since `reset`.
let mf: Miniflare, store: ReturnType<typeof createD1Store>, calls = 0, reads = 0, writes = 0;
const t = Date.UTC(2026, 10, 4), now = () => t, reset = () => { calls = reads = writes = 0; };
const rows = async (query: RawBuilder<unknown>) => (await query.execute(store.db)).rows;
const event = (n: number) => sql`insert into domain_events(id,cause,type,message_id,brand,template,status,at)
  values(${'evt_' + n},${'msg:m' + n + ':sent'},'message.sent',${'m' + n},'acme','notice','sent',${t})`.execute(store.db);
const jobRows = () => rows(sql`select id from jobs`);
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
  const db = await mf.getD1Database('DB'), originals = new WeakMap<object, D1PreparedStatement>();
  const record = (r: D1Result[]) => { calls++; for (const x of r) { reads += x.meta.rows_read; writes += x.meta.rows_written; } };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => { const w = { bind: (...v: unknown[]) => wrap(s.bind(...v)),
    all: async () => { const r = await s.all(); record([r]); return r; } } as D1PreparedStatement; originals.set(w, s); return w; };
  store = createD1Store({ prepare: (q: string) => wrap(db.prepare(q)),
    batch: async (ss: D1PreparedStatement[]) => { const r = await db.batch(ss.map(s => originals.get(s)!)); record(r); return r; } } as D1Database);
  await store.migrate();
});
afterAll(async () => { await store.db.destroy(); await mf.dispose(); });
beforeEach(async () => {
  for (const table of ['audit', 'jobs', 'guards', 'domain_events', 'ext_event_cursor', 'recipients', 'messages']) await sql`delete from ${sql.table(table)}`.execute(store.db);
  await sql`delete from sqlite_sequence where name = 'domain_events'`.execute(store.db);
  reset();
});

it('keeps Sellf notifications within the existing source D1 call count', async () => {
  const sendEmail = vi.fn(async () => ({ ok: true, status: 200 }));
  const logging = { ...config.logging, defaults: { ...config.logging.defaults, level: 'none' as const }, brands: {} };
  const app = createApp({ store, sendEmail, logging, now: () => new Date('2026-11-05T12:00:00Z') });
  const costs: Record<string, number> = {};
  for (const event of ['purchase.completed', 'order.placed', 'order.payment_reminder', 'order.cancelled', 'order.participants_needed', 'access.granted', 'license.issued']) {
    const body = JSON.parse(readFileSync(new URL(`./fixtures/sellf/${event}.json`, import.meta.url), 'utf8'));
    if (event === 'license.issued') body.data.license.issuanceSource = 'api';
    reset();
    const response = await app.fetch(new Request('https://mail.example/v1/hooks/sellf?brand=acme', {
      method: 'POST', headers: { authorization: 'Bearer example' }, body: JSON.stringify(body),
    }), { API_KEY: 'example' } as Env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    costs[event] = calls;
  }
  expect(sendEmail).toHaveBeenCalledTimes(7);
  expect(costs['purchase.completed']).toBeGreaterThan(0);
  expect(Object.values(costs)).toEqual(Array(7).fill(costs['purchase.completed']));
  console.log(JSON.stringify({ sellfNotificationD1Calls: costs }));
});

it('lists consecutive pages with bounded D1 reads and stable timestamp ties', async () => {
  const at = Date.now(), ids = sql`with recursive n(i) as (select 1 union all select i+1 from n where i<2683)
    select 'm' || printf('%05d', i) id, ${at} - cast(i/3 as integer) at from n`;
  await store.batch([
    sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at)
      select id,'demo','acme','notice','meta','h','sent',at,${at + 86400000} from (${ids})`,
    sql`insert into recipients select id,0,'to','idx','k1','sealed','hint','sent',null from (${ids})`,
  ].map(q => q.compile(store.db)));
  const ordered = (await sql<{ id: string; created_at: number }>`select id,created_at from messages order by created_at desc,id desc`.execute(store.db)).rows;
  const expected = ordered.slice(0, 200).map(r => r.id).concat(ordered.slice(1900, 2000).map(r => r.id));
  const executor = store.db.getExecutor(), execute = executor.executeQuery.bind(executor), queries: CompiledQuery[] = [];
  vi.spyOn(executor, 'executeQuery').mockImplementation(async (query, ...rest) => {
    if (query.sql.includes('addr_hints from messages')) queries.push(query);
    return execute(query, ...rest);
  });
  const seen: string[] = [], costs: unknown[] = [];
  let cursor: string | null = null;
  for (const page of [1, 2, 20]) {
    if (page === 20) cursor = btoa(JSON.stringify([ordered[1899].created_at, ordered[1899].id]));
    reset();
    const res = await internalFetch(new Request('http://localhost/internal/v2/messages?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')),
      {}, store, config, { ...panelClaims(), scopes: ['panel'], brands: '*', templates: '*' }, { platform: 'worker', extensions: async () => ({ features: () => [], resendSource: undefined }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: { id: string; addr_hints: string[] }[]; cursor: string | null };
    expect(body.messages).toHaveLength(100); expect(body.messages.every(m => m.addr_hints.join() === 'hint')).toBe(true);
    seen.push(...body.messages.map(m => m.id)); cursor = body.cursor;
    costs.push({ page, calls, reads, writes });
  }
  vi.restoreAllMocks();
  const plans = await Promise.all(queries.map(async query => (await store.db.executeQuery({ ...query, sql: 'explain query plan ' + query.sql })).rows));
  console.log(JSON.stringify({ listCosts: costs, plans }));
  expect(seen).toEqual(expected);
  for (const cost of costs as { reads: number }[]) expect(cost.reads).toBeLessThanOrEqual(500);
});

it('appends with bounded reads on a long audit chain and retains its conditional insert', async () => {
  const head = await appendAudit(store, { at: t, actor: 'test', action: 'read' });
  await store.batch([sql`with recursive n(i) as (select 2 union all select i+1 from n where i<6000)
    insert into audit select i,${t},'test','read',null,null,'h','h' from n`.compile(store.db)]);
  reset();
  const last = await appendAudit(store, { at: t, actor: 'test', action: 'read' });
  expect(last.seq).toBe(6001); expect(reads).toBeLessThanOrEqual(5); expect(writes).toBe(1);
  expect(await insertAudit(store, { ...last, seq: head.seq + 1 })).toBe(false);
  expect(await rows(sql`select count(*) n from audit`)).toEqual([{ n: 6001 }]);
  await sql`delete from audit where seq>1`.execute(store.db); await appendAudit(store, { at: t, actor: 'test', action: 'read' });
  expect(verifyChain(await rows(sql`select * from audit order by seq`) as AuditRow[])).toBe(true);
});

it('finishes an idle cron with one read and no writes, with consumers and notifications enabled', async () => {
  const notify = vi.fn(), consumer: EventConsumer = vi.fn(async () => ({ ack: true })), consumers = new Map([['demo', consumer]]);
  await store.batch(Array.from({ length: 2000 }, (_, i) => sql`insert into jobs(id,kind,state,payload,run_after,created_at,updated_at,done_at)
    values(${'old'+i},'demo','done','{}',${t-1},${t-1},${t-1},${t-1})`.compile(store.db)));
  for (let i = 0; i < 3; i++) {
    reset(); await runJobs(store, 'cron', { now, consumers, notifier: { notify } });
    expect(calls).toBe(1); expect(reads).toBeLessThanOrEqual(10); expect(writes).toBe(0);
  }
  expect(consumer).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
});

it('N: finds a job and an event inserted after an idle call, recovers an elapsed lease and moves a cursor only on confirmation', async () => {
  let confirmed = false;
  const step = vi.fn(async () => ({ result: null })), consumer = vi.fn(async () => confirmed ? { ack: true as const } : undefined);
  const run = (at = t) => runJobs(store, 'cron', { now: () => at, kinds: { ...JOB_KINDS, demo: { step } }, consumers: new Map([['demo', consumer]]) });
  await run();
  const job = enqueueJob(store, 'demo', {}, t); await store.batch([job.query]); await event(1);
  await sql`update jobs set state='running',lease_until=${t-1},token='old' where id=${job.id}`.execute(store.db);
  await run();
  expect(step).toHaveBeenCalledOnce(); expect(await rows(sql`select state from jobs where id=${job.id}`)).toEqual([{ state: 'done' }]);
  expect(consumer).toHaveBeenCalledOnce(); expect(await rows(sql`select * from ext_event_cursor`)).toEqual([]);
  confirmed = true; await run(t + 60000);
  expect(await rows(sql`select seq from ext_event_cursor where extension='demo'`)).toEqual([{ seq: 1 }]);
});

it('N: keeps future jobs and live leases untouched and still raises the stalled-work alert', async () => {
  const notify = vi.fn(), step = vi.fn();
  for (const [id, state, run, lease] of [['future','pending',t+60000,null],['leased','running',t-901000,t+60000]] as const)
    await sql`insert into jobs(id,kind,state,payload,run_after,created_at,updated_at,lease_until)
      values(${id},'demo',${state},'{}',${run},${t},${t},${lease})`.execute(store.db);
  await runJobs(store, 'cron', { now, kinds: { demo: { step } }, notifier: { notify } });
  expect(notify).toHaveBeenCalledOnce(); expect(step).not.toHaveBeenCalled();
  expect(await rows(sql`select state,attempts from jobs order by id`)).toEqual([{ state: 'pending', attempts: 0 }, { state: 'running', attempts: 0 }]);
});

it('N: raises the stalled-work alarm for an event or a queued item waiting 15 minutes, with no job row; an idle queue costs no call', async () => {
  const notify = vi.fn(), consumers = new Map([['demo', vi.fn(async () => undefined)]]);
  const queue = { due: sql`select 1 n, ${t - 901000} due`.compile(store.db), run: vi.fn(async () => false) };
  await runJobs(store, 'cron', { now, queues: [queue], notifier: { notify } });
  expect(queue.run).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledOnce();
  await sql`delete from guards`.execute(store.db); reset(); await event(1); expect(writes).toBe(5); // row, sequence, id, cause, time
  await sql`update domain_events set at = ${t - 901000}`.execute(store.db);
  await runJobs(store, 'cron', { now, consumers, notifier: { notify } });
  expect(notify).toHaveBeenCalledTimes(2); expect(await jobRows()).toEqual([]);
  reset(); await runJobs(store, 'cron', { now, queues: [{ ...queue, due: sql`select 0 n, null due`.compile(store.db) }] });
  expect([calls, writes]).toEqual([1, 0]); expect(queue.run).toHaveBeenCalledOnce();
});

it('runs idle retention in at most six D1 calls and retains live data', async () => {
  await sql`insert into guards values('live',1,${t+1}),('expired',1,${t-1})`.execute(store.db); reset(); await runRetention(store, t, config);
  expect(calls).toBeLessThanOrEqual(6); expect(await rows(sql`select key from guards`)).toEqual([{ key: 'live' }]);
});

it('indexes provider, ref and resend columns only when set; lookups search those indexes; the migration replaces full ones', async () => {
  const insert = (id: string, ref: string | null, root: string | null) => sql`insert into messages(id,client_id,brand,template,level,policy_hash,
    status,created_at,meta_expires_at,ref_idx,resend_root) values(${id},'legacy','acme','notice','meta','h','sending',${t},${t},${ref},${root})`.execute(store.db);
  reset(); await insert('m1', null, null); expect(writes).toBe(5); // row, brand/time, status/time, metadata expiry, time/id
  reset(); await insert('m2', 'r', 'm1'); expect(writes).toBe(7);
  reset(); await sql`update messages set provider_account='a', provider_message_id='p' where id='m1'`.execute(store.db); expect(writes).toBe(2);
  const plan = async (query: string) => JSON.stringify(await rows(sql.raw('explain query plan ' + query)));
  expect(await plan(`select id from messages where provider_account='a' and provider_message_id='p'`)).toContain('messages_provider_set');
  expect(await plan(`select id from messages m where m.ref_idx in ('r','s')`)).toContain('messages_ref_set');
  expect(await plan(`select id from messages where resend_root='m1'`)).toContain('messages_resend_root_set');
  for (const index of ['messages_provider ON messages(provider_account, provider_message_id)', 'messages_ref ON messages(ref_idx)', 'messages_resend_root ON messages(resend_root)', 'domain_events_msg ON domain_events(message_id)'])
    await sql.raw('CREATE INDEX ' + index).execute(store.db);
  for (let i = 0; i < 2; i++) { // idempotent
    for (const statement of PARTIAL_INDEX_SCHEMA.split(';').map(q => q.trim()).filter(Boolean)) await sql.raw(statement).execute(store.db);
    expect(await rows(sql`select name from sqlite_master where type='index' and (name like 'messages_pro%' or name like 'messages_re%') order by name`))
      .toEqual(['messages_provider_set', 'messages_ref_set', 'messages_resend_root_set'].map(name => ({ name })));
    expect(await rows(sql`select name from sqlite_master where name = 'domain_events_msg'`)).toEqual([]);
  }
});

it('fans out a single event without a job row and still delivers events waiting behind it', async () => {
  const consumer = vi.fn(async () => ({ ack: true as const })), consumers = new Map([['demo', consumer]]);
  await event(1); reset(); await runJobs(store, 'request', { now, consumers });
  expect(consumer).toHaveBeenCalledOnce(); expect(calls).toBeLessThanOrEqual(4); expect(writes).toBe(2); expect(await jobRows()).toEqual([]);
  await event(2); await event(3); await runJobs(store, 'request', { now, consumers });
  expect(consumer).toHaveBeenCalledTimes(3); expect(await rows(sql`select seq from ext_event_cursor`)).toEqual([{ seq: 3 }]);
});

it('N: a partial acknowledgement keeps the event and resumes after the stored endpoint', async () => {
  const consumer = vi.fn().mockResolvedValueOnce({ partial: 'endpoint-1' }).mockResolvedValue(undefined);
  await event(1); await runJobs(store, 'request', { now, consumers: new Map([['demo', consumer]]) });
  expect(await rows(sql`select seq, partial from ext_event_cursor`)).toEqual([{ seq: 0, partial: 'endpoint-1' }]);
  expect(consumer).toHaveBeenCalledTimes(2); expect(consumer.mock.calls[1][1]).toBe('endpoint-1');
});

it('N: runs one drain per invocation and gives an event committed during it one more pass', async () => {
  const seen: string[] = [], emit = (messageId: string) => host.emitEvent({ type: 'message.sent', at: t, brand: 'acme', template: 'notice', status: 'sent', messageId, durable: true });
  // The auto-reply commits its event after the drain read the queue and kicks again from the same invocation.
  const onEvent = vi.fn(async (e: DomainEvent) => { seen.push(e.id); if (e.id === 'evt_1') { await event(2); void emit('m2'); } return { ack: true as const }; });
  const host = await createExtensionHost({ ...config, extensions: [{ module: 'x' }] }, store, async () => ({ default: { name: 'x', onEvent } }), { keys: undefined, kickJobs: true });
  await event(1); reset(); await metered(50, () => Promise.all([emit('m1'), emit('m1')]));
  expect(seen).toEqual(['evt_1', 'evt_2']); expect(calls).toBeLessThanOrEqual(18);
  expect(await rows(sql`select seq from ext_event_cursor where extension='x'`)).toEqual([{ seq: 2 }]);
});
