import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import { internalFetch } from '../src/core/internal';
import { runJobs } from '../src/core/jobs';
import { blindIndex } from '../src/core/crypto';
import { parseConfig } from '../src/core/config/schema';
import { loadExtensions } from '../src/runtime/extensions';
import { keysOnly } from './fixtures/keys';
import { panelClaims, panelEnv, signPanel } from './fixtures/panel';
import { tokenSha256 } from '../src/clients';
import type { PanelPrincipal } from '../src/core/panel';
import { sealed, transitEnv } from './fixtures/transit';
import example from '../config/mailstack.example.json';

vi.setConfig({ testTimeout: 120000 });
const indexKey = { kid: 'k1', key: Buffer.alloc(32, 7).toString('base64url') };
const env = { ...panelEnv, ...transitEnv, INDEX_KEYS: JSON.stringify([indexKey]) };
const token = 'msk_panel_' + 'b'.repeat(43), far = Date.now() + 86400000;
const cfg = parseConfig(example);
interface JobRow { id: string; state: string; cursor: string | null; result: string | null; run_after: number }

/** A D1 binding that, like a Free Worker invocation, refuses more than `limit` queries; a batch is one query (D1 limits). */
function limitedD1(binding: D1Database) {
  let calls = 0, limit = Infinity;
  const tick = () => { if (++calls > limit) throw new Error('Too many API requests by single Worker invocation'); };
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = { bind: (...values: unknown[]) => wrap(statement.bind(...values)), all: async () => { tick(); return statement.all(); } } as unknown as D1PreparedStatement;
    real.set(wrapped, statement); return wrapped;
  };
  const db = { prepare: (query: string) => wrap(binding.prepare(query)),
    batch: async (statements: D1PreparedStatement[]) => { tick(); return binding.batch(statements.map(s => real.get(s)!)); } } as unknown as D1Database;
  return { db, invocation(max: number) { calls = 0; limit = max; } };
}

for (const driver of ['sqlite', 'd1'] as const) describe(`erase job: ${driver}`, () => {
  let store: KyselyStore, mf: Miniflare | undefined, binding: D1Database;
  const principal = (over: Partial<PanelPrincipal> = {}): PanelPrincipal => ({ ...panelClaims(), scopes: ['panel'], brands: '*', templates: '*', ...over });
  const api = (path: string, body?: unknown, p = principal(), on = store) => internalFetch(new Request('http://localhost/internal/v2' + path,
    body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), env, on, cfg, p, { platform: 'node', extensions: async () => ({ features: () => [], resendSource: undefined }) });
  const erasure = async (email = 'one@example.com', reason = 'Requested by subject') => ({ reason, ...await sealed({ email }, 'subjects.erase') });
  const count = async (query: ReturnType<typeof sql<{ n: number }>>) => Number((await query.execute(store.db)).rows[0].n);
  const jobs = async () => (await sql<JobRow>`select * from jobs order by created_at`.execute(store.db)).rows;
  const start = async (body?: unknown, p = principal(), path = '/subjects/erase') => {
    const response = await api(path, body ?? await erasure(), p);
    expect(response.status).toBe(202);
    return (await response.json() as { jobId: string }).jobId;
  };
  async function seed(n: number, prefix = 'm', brand = 'acme', createdAt = Date.now() - 1000) {
    const idx = await blindIndex('one@example.com', indexKey);
    const ids = sql`with recursive n(i) as (select 0 union all select i+1 from n where i < ${n - 1}) select ${prefix} || substr('00000' || i, -5) id from n`;
    await store.batch([
      sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at,content_expires_at)
        select id,'demo',${brand},'notice','full','hash','sent',${createdAt},${far},${far} from (${ids})`,
      sql`insert into subjects select id,'recipient',${idx.index},${idx.kid} from (${ids})`,
      sql`insert into recipients select id,0,'to',${idx.index},${idx.kid},'sealed-address','hint','sent',null from (${ids})`,
      sql`insert into contents select id,'sealed',${far} from (${ids})`,
      sql`insert into replays select id,'sealed',${far} from (${ids})`,
      sql`insert into events(id,message_id,source,source_event_id,type,occurred_at,received_at,auth) select 'e' || id,id,'local','e' || id,'sent',${createdAt},${createdAt},'local' from (${ids})`,
    ].map(q => q.compile(store.db)));
  }
  const remaining = (prefix = 'm') => count(sql<{ n: number }>`select
    (select count(*) from messages where id like ${prefix + '%'}) + (select count(*) from subjects where message_id like ${prefix + '%'}) +
    (select count(*) from recipients where message_id like ${prefix + '%'}) + (select count(*) from contents where message_id like ${prefix + '%'}) +
    (select count(*) from replays where message_id like ${prefix + '%'}) + (select count(*) from events where message_id like ${prefix + '%'}) n`);

  beforeAll(async () => {
    if (driver === 'sqlite') store = createSqliteStore(':memory:');
    else {
      mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
      binding = await mf.getD1Database('DB'); store = createD1Store(binding);
    }
    await store.migrate();
  });
  beforeEach(async () => {
    for (const table of ['audit', 'events', 'recipients', 'subjects', 'contents', 'replays', 'messages', 'jobs', 'guards']) await sql`delete from ${sql.table(table)}`.execute(store.db);
  });
  afterAll(async () => { await store.db.destroy(); await mf?.dispose(); });

  if (driver === 'd1') it.each([2600, 6000])('erases %i messages over successive invocations of at most 50 D1 queries', async n => {
    await seed(n);
    const job = await start();
    const limited = limitedD1(binding), worker = createD1Store(limited.db);
    let t = Date.now(), invocations = 0;
    while ((await jobs())[0].state !== 'done') {
      expect(++invocations).toBeLessThan(40);
      limited.invocation(50);
      await runJobs(worker, 'cron', { now: () => t }).catch(() => {});
      limited.invocation(Infinity);
      t += 31000; // past the lease of an executor stopped by the limit
    }
    if (n === 6000) expect(invocations).toBeGreaterThan(1);
    expect(await remaining()).toBe(0);
    expect(JSON.parse((await jobs())[0].result!)).toMatchObject({ count: n });
    const done = (await sql<{ details: string }>`select details from audit where action='privacy.erase.done'`.execute(store.db)).rows;
    expect(done.map(r => JSON.parse(r.details))).toEqual([{ job, count: n }]);
  });

  it('resumes after an interrupted invocation without losing or repeating the first portion', async () => {
    await seed(1200);
    await start();
    let t = Date.now(), calls = 0, inBatch = false;
    // The invocation stops after three store calls: the claim, the first portion's select and its batch.
    const tick = () => { if (++calls > 3) throw new Error('interrupted'); };
    const executor = store.db.getExecutor(), execute = executor.executeQuery.bind(executor), batch = store.batch.bind(store);
    vi.spyOn(executor, 'executeQuery').mockImplementation(async (...args) => { if (!inBatch) tick(); return execute(...args); });
    vi.spyOn(store, 'batch').mockImplementation(async queries => { tick(); inBatch = true; try { return await batch(queries); } finally { inBatch = false; } });
    await runJobs(store, 'request', { now: () => t }).catch(() => {});
    vi.restoreAllMocks();
    expect(await count(sql<{ n: number }>`select count(*) n from messages where meta_expires_at = 0`)).toBe(500);
    expect(await count(sql<{ n: number }>`select count(*) n from contents`)).toBe(700);
    const [job] = await jobs();
    expect(job).toMatchObject({ state: 'running', cursor: JSON.stringify({ phase: 1, after: 'm00499', count: 500 }) });
    // Hidden at once: the panel list no longer shows the first portion while its rows still exist.
    expect(await count(sql<{ n: number }>`select count(*) n from messages`)).toBe(1200);
    const listed = await (await api('/messages?limit=100')).json() as { messages: { id: string }[] };
    expect(listed.messages).toHaveLength(100); expect(listed.messages.every(m => m.id >= 'm00500')).toBe(true);
    t += 31000;
    await runJobs(store, 'request', { now: () => t });
    expect((await jobs())[0].state).toBe('done');
    expect(JSON.parse((await jobs())[0].result!)).toMatchObject({ count: 1200 });
    expect(await remaining()).toBe(0);
  });

  it('keeps messages inserted after the start, other brands and other subjects out of the fixed scope', async () => {
    await seed(3, 'm'); await seed(2, 'd', 'demo');
    const job = await start(undefined, principal({ brands: ['acme'] }));
    await seed(2, 'late', 'acme', Date.now() + 5000);
    await runJobs(store, 'request', { now: () => Date.now() + 10000 });
    expect(await remaining('m')).toBe(0);
    expect(await count(sql<{ n: number }>`select count(*) n from messages where id like 'd%'`)).toBe(2);
    expect(await count(sql<{ n: number }>`select count(*) n from messages where id like 'late%' and meta_expires_at > 0`)).toBe(2);
    const status = await (await api('/jobs/' + job)).json() as Record<string, unknown>;
    const at = (JSON.parse((await jobs())[0].result!) as { tombstones: { at: number }[] }).tombstones[0].at;
    expect(status).toMatchObject({ id: job, kind: 'erase', state: 'done', progress: { phase: 3, count: 3 },
      result: { count: 3, tombstones: [{ kid: 'k1', index: (await blindIndex('one@example.com', indexKey)).index, at, brands: ['acme'], templates: '*' }] } });
  });

  it('requires an admin with a recent step-up to start an erasure', async () => {
    await seed(1);
    for (const p of [principal({ stepUpAt: null }), principal({ stepUpAt: Date.now() - 300001 }), principal({ role: 'operator' })])
      expect((await api('/subjects/erase', await erasure(), p)).status).toBe(403);
    expect(await jobs()).toEqual([]);
  });

  it('shows job status only to admins whose scope covers the job', async () => {
    const job = await start(undefined, principal({ brands: ['acme', 'demo'] }));
    expect((await api('/jobs/' + job, undefined, principal({ brands: ['acme'] }))).status).toBe(404);
    expect((await api('/jobs/' + job, undefined, principal({ role: 'operator' }))).status).toBe(403);
    expect((await api('/jobs/' + job, undefined, principal({ brands: ['demo', 'acme', 'x'] }))).status).toBe(200);
    expect((await api('/jobs/job_' + '0'.repeat(32))).status).toBe(404);
    await sql`update jobs set kind='other'`.execute(store.db);
    expect((await api('/jobs/' + job)).status).toBe(404);
  });

  it('replays a tombstone within its time bound and never past the caller scope', async () => {
    const idx = await blindIndex('one@example.com', indexKey);
    await seed(2, 'old', 'acme', Date.now() - 5000); await seed(2, 'other', 'demo', Date.now() - 5000); await seed(2, 'new', 'acme', Date.now());
    const tombstone = { kid: idx.kid, index: idx.index, at: Date.now() - 2000, brands: '*', templates: '*' };
    for (const p of [principal({ role: 'operator' }), principal({ stepUpAt: null })]) expect((await api('/subjects/erase-index', { tombstone }, p)).status).toBe(403);
    for (const bad of [{ ...tombstone, at: Date.now() + 60000 }, { ...tombstone, index: 'short' }, { ...tombstone, brands: 'acme' }, { ...tombstone, extra: 1 }])
      expect((await api('/subjects/erase-index', { tombstone: bad })).status).toBe(400);
    expect((await api('/subjects/erase-index', { tombstone, reason: 'x' })).status).toBe(400);
    await start({ tombstone }, principal({ brands: ['acme'] }), '/subjects/erase-index');
    await runJobs(store, 'request');
    expect(await remaining('old')).toBe(0);
    expect(await count(sql<{ n: number }>`select count(*) n from messages where id like 'other%' or id like 'new%'`)).toBe(4);
    expect(JSON.parse((await sql<{ details: string }>`select details from audit where action='privacy.erase'`.execute(store.db)).rows[0].details)).toMatchObject({ source: 'tombstone' });
  });

  it('writes the job only together with its audit entry, also after a lost append race', async () => {
    await seed(1);
    const original = store.batch.bind(store);
    let raced = false;
    vi.spyOn(store, 'batch').mockImplementation(async queries => {
      if (!raced && queries[0].sql.includes('insert into audit')) {
        raced = true; // another writer takes the expected seq first
        await original([sql`insert into audit(seq,at,actor,action,target,details,prev_hash,hash) values(1,0,'other','panel.login',null,null,${'0'.repeat(64)},${'f'.repeat(64)})`.compile(store.db)]);
      }
      return original(queries);
    });
    await start();
    vi.restoreAllMocks();
    expect(raced).toBe(true);
    expect(await jobs()).toHaveLength(1);
  });

  it('keeps the outcome step pending when its audit entry cannot be written', async () => {
    await seed(1);
    await start();
    const original = store.batch.bind(store);
    // Every outcome append loses its race: a competing entry always takes the expected seq first.
    vi.spyOn(store, 'batch').mockImplementation(async queries => {
      if (queries[0].sql.includes('insert into audit') && queries.length > 1 && queries[1].sql.includes('update jobs set cursor')) {
        const [{ seq }] = (await sql<{ seq: number }>`select coalesce(max(seq),0)+1 seq from audit`.execute(store.db)).rows;
        await original([sql`insert into audit(seq,at,actor,action,target,details,prev_hash,hash) values(${seq},0,'other','panel.login',null,null,'x','y')`.compile(store.db)]);
      }
      return original(queries);
    });
    await runJobs(store, 'request');
    vi.restoreAllMocks();
    const [job] = await jobs();
    expect(job.state).toBe('pending');
    expect(JSON.parse(job.cursor!)).toMatchObject({ phase: 2 });
    expect(await count(sql<{ n: number }>`select count(*) n from audit where action='privacy.erase.done'`)).toBe(0);
  });

  it('refuses a repeated erase request with the same nonce', async () => {
    const config = parseConfig({ ...example, clients: [{ id: 'panel', tokenSha256: await tokenSha256(token), scopes: ['panel'], brands: '*', templates: '*' }] });
    const [keyed, importer] = keysOnly(config);
    const runtime = await loadExtensions(keyed, store, importer);
    const req = await signPanel(new Request('http://localhost/internal/v2/subjects/erase', { method: 'POST',
      body: JSON.stringify(await erasure()) }), token);
    const again = req.clone();
    expect((await runtime.fetch(req, env)).status).toBe(202);
    const repeated = await runtime.fetch(again, env);
    expect(repeated.status).toBe(409); expect(await repeated.json()).toEqual({ success: false, code: 'replayed' });
    expect(await jobs()).toHaveLength(1);
  });
});
