import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import { createBudget } from '../src/core/budget';
import { drain, enqueueJob, jobStats, runJobs, type JobKind } from '../src/core/jobs';
import { runRetention } from '../src/core/retention';
import { config } from '../src/core/config';
import worker from '../src/index';
import type { Env } from '../src/types';

const start = Date.UTC(2026, 10, 3);
interface Row { id: string; kind: string; state: string; cursor: string | null; attempts: number; token: string | null;
  lease_until: number | null; run_after: number; done_at: number | null; result: string | null }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

for (const driver of ['sqlite', 'd1'] as const) describe(`jobs: ${driver}`, () => {
  let store: KyselyStore, mf: Miniflare | undefined, binding: D1Database, t = start;
  const clock = () => t;
  const rows = async () => (await sql<Row>`select * from jobs order by created_at, id`.execute(store.db)).rows;
  const add = async (kind: string, payload: unknown = {}, at = t) => {
    const job = enqueueJob(store, kind, payload, at); await store.batch([job.query]); return job.id;
  };
  beforeAll(async () => {
    if (driver === 'sqlite') store = createSqliteStore(':memory:');
    else {
      mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
        script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
      binding = await mf.getD1Database('DB');
      store = createD1Store(binding);
    }
    await store.migrate();
  });
  afterAll(async () => { await store?.db.destroy(); await mf?.dispose(); });
  beforeEach(async () => { t = start; await sql`delete from jobs`.execute(store.db); await sql`delete from guards`.execute(store.db); });

  it('lets two parallel drains claim different jobs', async () => {
    const gate = deferred(), seen: string[] = [];
    const kinds: Record<string, JobKind> = { slow: { async step(job) { seen.push(job.id); if (seen.length === 2) gate.resolve(); await gate.promise; return { result: job.id }; } } };
    const ids = [await add('slow'), await add('slow', {}, t - 1)];
    const one = () => drain(store, createBudget('request', clock), { now: clock, kinds });
    expect(await Promise.all([one(), one()])).toEqual([1, 1]);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(seen).toHaveLength(2);
    expect((await rows()).map(r => [r.state, JSON.parse(r.result!)]).sort()).toEqual(ids.map(id => ['done', id]).sort());
  });

  it('recovers a job whose lease has passed and leaves a live lease alone', async () => {
    const kinds: Record<string, JobKind> = { ok: { async step() { return { result: 'ok' }; } } };
    const id = await add('ok');
    await sql`update jobs set state = 'running', token = 'crashed', attempts = 1, lease_until = ${t + 1000} where id = ${id}`.execute(store.db);
    expect(await drain(store, createBudget('request', clock), { now: clock, kinds })).toBe(0);
    t += 1000;
    expect(await drain(store, createBudget('request', clock), { now: clock, kinds })).toBe(1);
    expect((await rows())[0]).toMatchObject({ state: 'done', attempts: 2, token: null, lease_until: null, done_at: t });
  });

  it('discards the result and writes of a late executor that lost its token', async () => {
    const gate = deferred(), entered = deferred();
    let calls = 0;
    const kinds: Record<string, JobKind> = { race: { async step() {
      if (++calls === 1) { entered.resolve(); await gate.promise;
        return { result: 'late', writes: [sql`insert into guards values ('late', 1, ${t + 1000})`.compile(store.db)] }; }
      return { result: 'fresh' };
    } } };
    await add('race');
    const late = drain(store, createBudget('cron', clock), { now: clock, kinds });
    await entered.promise;
    t += 30000;
    expect(await drain(store, createBudget('request', clock), { now: clock, kinds })).toBe(1);
    gate.resolve(); await late;
    expect((await rows())[0]).toMatchObject({ state: 'done', result: '"fresh"', attempts: 2 });
    expect((await sql`select * from guards`.execute(store.db)).rows).toEqual([]);
  });

  it('rejects progress from a late executor while the new owner is still running', async () => {
    const late = deferred(), fresh = deferred(), entered = [deferred(), deferred()];
    let calls = 0;
    const kinds: Record<string, JobKind> = { race: { async step() {
      const call = calls++; entered[call].resolve();
      if (call === 0) { await late.promise; return { cursor: 'late', writes: [sql`insert into guards values ('late', 1, ${t + 1000})`.compile(store.db)] }; }
      await fresh.promise; return { result: 'fresh' };
    } } };
    await add('race');
    const first = drain(store, createBudget('cron', clock), { now: clock, kinds });
    await entered[0].promise;
    t += 30000;
    const second = drain(store, createBudget('request', clock), { now: clock, kinds });
    await entered[1].promise;
    late.resolve(); await first;
    expect((await rows())[0]).toMatchObject({ state: 'running', cursor: null, attempts: 2 });
    expect((await sql`select * from guards`.execute(store.db)).rows).toEqual([]);
    fresh.resolve(); await second;
    expect((await rows())[0]).toMatchObject({ state: 'done', result: '"fresh"' });
  });

  it('stops before the deadline, keeps the cursor and resumes from it', async () => {
    const cursors: (string | null)[] = [];
    const kinds: Record<string, JobKind> = { scan: { reserveMs: 5000, async step(job) {
      cursors.push(job.cursor); t += 5000; const next = Number(job.cursor ?? 0) + 1;
      return next === 6 ? { result: { count: next } } : { cursor: String(next), writes: [sql`insert into guards values (${'p' + next}, 1, ${t + 1})`.compile(store.db)] };
    } } };
    await add('scan');
    expect(await drain(store, createBudget('request', clock), { now: clock, kinds })).toBe(1);
    expect((await rows())[0]).toMatchObject({ state: 'pending', cursor: '3', token: null, lease_until: null, attempts: 0 });
    expect(t - start).toBeLessThanOrEqual(20000);
    await drain(store, createBudget('request', clock), { now: clock, kinds });
    expect(cursors).toEqual([null, '1', '2', '3', '4', '5']);
    expect((await rows())[0]).toMatchObject({ state: 'done', result: '{"count":6}' });
    expect((await sql`select key from guards order by key`.execute(store.db)).rows).toHaveLength(5);
  });

  it('takes at most 50 jobs in one cron run', async () => {
    const kinds: Record<string, JobKind> = { ok: { async step() { return { result: null }; } } };
    await store.batch(Array.from({ length: 51 }, (_, i) => enqueueJob(store, 'ok', {}, t - i).query));
    expect(await drain(store, createBudget('cron', clock), { now: clock, kinds })).toBe(50);
    expect((await rows()).filter(r => r.state === 'pending')).toHaveLength(1);
  }, 20000);

  it('runs the oldest due jobs first', async () => {
    const order: unknown[] = [];
    const kinds: Record<string, JobKind> = { ok: { async step(job) { order.push(job.payload); return { result: null }; } } };
    await add('ok', 'new', t); await add('ok', 'old', t - 60000); await add('ok', 'later', t + 60000);
    await drain(store, createBudget('request', clock), { now: clock, kinds });
    expect(order).toEqual(['old', 'new']);
  });

  it('marks a job of an unknown kind dead with a reason, including inherited names', async () => {
    await add('missing'); await add('toString');
    await drain(store, createBudget('request', clock), { now: clock, kinds: {} });
    for (const row of await rows()) expect(row).toMatchObject({ state: 'dead', result: '{"error":"unknown_kind"}', done_at: t, token: null });
  });

  it('claims nothing more once a finished job used up the deadline', async () => {
    const kinds: Record<string, JobKind> = { long: { async step() { t += 20000; return { result: null }; } } };
    await add('long'); await add('long', {}, t + 1);
    t += 1;
    expect(await drain(store, createBudget('request', clock), { now: clock, kinds })).toBe(1);
    expect((await rows()).map(r => [r.state, r.attempts]).sort()).toEqual([['done', 1], ['pending', 0]]);
  });

  it('resets the failure count once a job saves progress', async () => {
    let fail = 3;
    const kinds: Record<string, JobKind> = { flaky: { async step(job) {
      if (fail-- > 0) throw new Error('x');
      if (job.cursor) throw new Error('after progress');
      return { cursor: 'half' };
    } } };
    await add('flaky');
    for (const delay of [0, 60000, 600000, 3600000]) { t += delay; await drain(store, createBudget('request', clock), { now: clock, kinds }); }
    expect((await rows())[0]).toMatchObject({ state: 'pending', cursor: 'half', attempts: 1, run_after: t + 60000 });
  });

  it('retries a failing handler with growing delays and then gives up', async () => {
    const step = vi.fn(async () => { throw new Error('secret detail'); });
    await add('fail');
    const run = () => drain(store, createBudget('request', clock), { now: clock, kinds: { fail: { step } } });
    await run();
    expect((await rows())[0]).toMatchObject({ state: 'pending', attempts: 1, run_after: t + 60000, token: null });
    t += 59999; await run(); expect(step).toHaveBeenCalledTimes(1);
    for (const delay of [1, 600000, 3600000, 21600000]) { t += delay; await run(); }
    expect(step).toHaveBeenCalledTimes(5);
    expect((await rows())[0]).toMatchObject({ state: 'dead', attempts: 5, result: '{"error":"handler_failed"}', done_at: t });
  });

  it('gives up on a job that keeps losing its lease', async () => {
    const step = vi.fn();
    const id = await add('crash');
    await sql`update jobs set state = 'running', token = 'gone', attempts = 5, lease_until = ${t} where id = ${id}`.execute(store.db);
    await drain(store, createBudget('request', clock), { now: clock, kinds: { crash: { step } } });
    expect(step).not.toHaveBeenCalled();
    expect((await rows())[0]).toMatchObject({ state: 'dead', result: '{"error":"attempts"}' });
  });

  it('reports backlog stats', async () => {
    for (const [kind, runAfter, state, doneAt] of [['dead-old', t, 'dead', t - 86400001], ['dead-new', t, 'dead', t - 3600000],
      ['due', t - 900000, 'pending', null], ['held', t - 1000, 'running', null], ['future', t + 5000, 'pending', null]] as const) {
      await add(kind);
      await sql`update jobs set state = ${state}, run_after = ${runAfter}, done_at = ${doneAt} where kind = ${kind}`.execute(store.db);
    }
    expect(await jobStats(store, t)).toEqual({ pending: 3, oldest_pending_age_s: 900, dead_24h: 1 });
  });

  it('alerts on a stuck queue from cron at most once per hour', async () => {
    const notify = vi.fn().mockRejectedValueOnce(new Error('ntfy down')).mockResolvedValue(undefined);
    const step = vi.fn(), kinds = { held: { step } }, notifier = { notify };
    await add('held');
    const age = (ms: number) => sql`update jobs set state = 'running', token = 'held', lease_until = ${t + 86400000}, run_after = ${t - ms}`.execute(store.db);
    await age(900000);
    await runJobs(store, 'cron', { now: clock, kinds, notifier });
    expect(notify).not.toHaveBeenCalled();
    await age(901000);
    await runJobs(store, 'request', { now: clock, kinds, notifier });
    expect(notify).not.toHaveBeenCalled();
    await runJobs(store, 'cron', { now: clock, kinds, notifier });
    await runJobs(store, 'cron', { now: clock, kinds, notifier });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toMatchObject({ title: 'mailstack: jobs stalled', priority: 'high' });
    await runJobs(store, 'cron', { now: clock, kinds, notifier });
    expect(notify).toHaveBeenCalledTimes(2);
    t += 3600000;
    await runJobs(store, 'cron', { now: clock, kinds, notifier });
    expect(notify).toHaveBeenCalledTimes(3);
    expect(step).not.toHaveBeenCalled();
  });

  it('removes finished jobs after seven days and keeps open ones', async () => {
    for (const [kind, state, doneAt] of [['old-done', 'done', t - 7 * 86400000], ['old-dead', 'dead', t - 8 * 86400000],
      ['recent', 'done', t - 86400000], ['open', 'pending', null]] as const) {
      await add(kind, {}, t - 30 * 86400000);
      await sql`update jobs set state = ${state}, done_at = ${doneAt} where kind = ${kind}`.execute(store.db);
    }
    await runRetention(store, t, config);
    expect((await rows()).map(r => r.kind).sort()).toEqual(['open', 'recent']);
  });

  if (driver === 'd1') it('splits scheduled work by cron', async () => {
    await add('unregistered');
    await store.consume('expired', t);
    const fire = async (cron: string) => {
      const pending: Promise<unknown>[] = [];
      worker.scheduled({ cron, scheduledTime: t } as ScheduledController, { DB: binding } as Env,
        { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException() {} } as ExecutionContext);
      await Promise.all(pending);
    };
    await fire('17 * * * *');
    expect((await rows())[0].state).toBe('pending');
    expect((await sql`select * from guards`.execute(store.db)).rows).toEqual([]);
    await store.consume('expired', t);
    await fire('* * * * *');
    expect((await rows())[0]).toMatchObject({ state: 'dead', result: '{"error":"unknown_kind"}' });
    expect((await sql`select * from guards`.execute(store.db)).rows).toHaveLength(1);
  });
});
