import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sql } from 'kysely';
import { config } from '../src/core/config';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import { jobStats, runJobs } from '../src/core/jobs';
import { runRetention } from '../src/core/retention';
import { ACK_TIMEOUT_MS, type EventConsumer } from '../src/core/events';
import { createExtensionHost } from '../src/core/extension-host';
import type { DomainEvent } from '../src/core/extensions';
import { handleSend } from '../src/send';
import type { Env } from '../src/types';
import { metered } from '../src/core/budget';
import { limitedD1 } from './fixtures/limited-d1';

vi.setConfig({ testTimeout: 60000 });
const DAY = 86400000, start = Date.UTC(2026, 10, 3);
const pair = generateKeyPairSync('x25519');
const env = { API_KEY: 'test-key', SES_REGION: 'eu-west-1', SES_ACCESS_KEY_ID: '', SES_SECRET_ACCESS_KEY: '', TURNSTILE_SECRET: 's', ALTCHA_HMAC_KEY: '',
  CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kty: 'OKP', crv: 'X25519', kid: 'c1' }] }),
  INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 3).toString('base64url') }]) } as Env;

for (const driver of ['sqlite', 'd1'] as const) describe(`event fan-out: ${driver}`, () => {
  let store: KyselyStore, mf: Miniflare | undefined, t = start;
  const clock = () => t;
  const cursor = async (extension: string) => (await sql<{ seq: number; partial: string | null }>`select seq, partial from ext_event_cursor
    where extension = ${extension}`.execute(store.db)).rows[0] ?? { seq: 0, partial: null };
  const job = async (extension: string) => (await sql<{ state: string; run_after: number }>`select state, run_after from jobs
    where id = ${'job_fanout_' + extension}`.execute(store.db)).rows[0];
  const seq = async () => (await sql<{ seq: number }>`select seq from domain_events order by seq`.execute(store.db)).rows.map(r => r.seq);
  /** Messages and one stored event each, `at` days old; ids `<prefix>00000`, ... */
  const seed = async (n: number, at = t, prefix = 'm') => {
    const ids = sql`with recursive n(i) as (select 0 union all select i+1 from n where i < ${n - 1}) select ${prefix} || substr('00000' || i, -5) id from n`;
    await store.batch([
      sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at)
        select id,'legacy','acme','notice','meta','h','sent',${at},${at} from (${ids})`,
      sql`insert into domain_events(id,cause,type,message_id,brand,template,status,at) select 'evt_' || id,'msg:' || id || ':sent','message.sent',id,'acme','notice','sent',${at} from (${ids})`,
    ].map(q => q.compile(store.db)));
  };
  const run = (consumers: Record<string, EventConsumer>) => runJobs(store, 'request', { now: clock, consumers: new Map(Object.entries(consumers)) });

  beforeAll(async () => {
    if (driver === 'sqlite') store = createSqliteStore(':memory:');
    else {
      mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }',
        compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
      store = createD1Store(await mf.getD1Database('DB'));
    }
    await store.migrate();
  });
  beforeEach(async () => {
    t = start;
    for (const table of ['jobs', 'domain_events', 'ext_event_cursor', 'ext_event_gaps', 'messages', 'guards', 'audit'])
      await sql`delete from ${sql.table(table)}`.execute(store.db);
    await sql`delete from sqlite_sequence where name = 'domain_events'`.execute(store.db);
  });
  afterEach(() => { vi.useRealTimers(); });
  afterAll(async () => { await store?.db.destroy(); await mf?.dispose(); });

  it('N: an exception at endpoint N keeps the cursor and the retry resumes from endpoint N', async () => {
    await seed(1);
    const endpoints = ['a', 'b', 'c'], calls: [string, string | null][] = [];
    let failing = true;
    const consumer: EventConsumer = async (_event, resume) => {
      const next = endpoints[resume === null ? 0 : endpoints.indexOf(resume) + 1];
      calls.push([next, resume]);
      if (next === 'b' && failing) throw new Error('write failed');
      return next === 'c' ? { ack: true } : { partial: next };
    };
    await run({ x: consumer });
    expect(await cursor('x')).toEqual({ seq: 0, partial: 'a' });
    expect(await job('x')).toEqual({ state: 'pending', run_after: t + 60000 });
    failing = false; t += 60000;
    await run({ x: consumer });
    expect(calls.map(([endpoint]) => endpoint)).toEqual(['a', 'b', 'b', 'c']);
    expect(calls.slice(1).every(([endpoint, resume]) => endpoint !== 'a' && resume !== null)).toBe(true);
    expect(await cursor('x')).toEqual({ seq: 1, partial: null });
  });

  it('N: a missing ack or a thrown error leaves the cursor in place', async () => {
    await seed(2);
    for (const consumer of [async () => undefined, async () => ({ ack: 'yes' }), async () => { throw new Error('x'); }] as EventConsumer[]) {
      await sql`delete from jobs`.execute(store.db);
      await run({ x: consumer });
      expect(await cursor('x')).toEqual({ seq: 0, partial: null });
    }
  });

  if (driver === 'sqlite') it('N: an onEvent that never answers times out and keeps the cursor', async () => {
    await seed(1);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = run({ x: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    await pending;
    expect(await cursor('x')).toEqual({ seq: 0, partial: null });
    expect((await job('x')).state).toBe('pending');
  });

  it('moves two consumers on independent cursors and delivers each event once per consumer', async () => {
    await seed(3);
    const seen: Record<string, string[]> = { x: [], y: [] };
    const acking = (name: string): EventConsumer => async event => { seen[name].push(event.id); return { ack: true }; };
    await run({ x: acking('x'), y: async event => { if (event.id.endsWith('1')) throw new Error('down'); seen.y.push(event.id); return { ack: true }; } });
    expect([await cursor('x'), await cursor('y')]).toEqual([{ seq: 3, partial: null }, { seq: 1, partial: null }]);
    t += 60000;
    await run({ x: acking('x'), y: acking('y') });
    expect(seen).toEqual({ x: ['evt_m00000', 'evt_m00001', 'evt_m00002'], y: ['evt_m00000', 'evt_m00001', 'evt_m00002'] });
    expect((await job('x')).state).toBe('done');
    t += 1000; await run({ x: acking('x') });
    expect(seen.x).toHaveLength(3);
    await seed(1, t, 'late');
    await run({ x: acking('x') });
    expect(seen.x).toEqual(['evt_m00000', 'evt_m00001', 'evt_m00002', 'evt_late00000']);
  });

  it('N: never moves a cursor back over a gap that retention recorded during the fan-out', async () => {
    await seed(1);
    await run({ x: async () => { await sql`insert into ext_event_cursor(extension, seq) values('x', 100)`.execute(store.db); return { ack: true }; } });
    expect(await cursor('x')).toEqual({ seq: 100, partial: null });
  });

  it('N: an event unconfirmed after 7 days becomes a recorded gap and the cursor moves past it', async () => {
    await seed(2, t, 'old');
    await seed(1, t + 6 * DAY, 'new');
    await runRetention(store, t + 7 * DAY + 1, config, undefined, ['x']);
    expect(await seq()).toEqual([3]);
    expect((await sql`select extension, from_seq, to_seq, count from ext_event_gaps`.execute(store.db)).rows).toEqual([{ extension: 'x', from_seq: 1, to_seq: 2, count: 2 }]);
    expect(await cursor('x')).toEqual({ seq: 2, partial: null });
    expect((await jobStats(store, t)).events_dropped).toBe(2);
    const seen: string[] = [];
    await run({ x: async event => { seen.push(event.id); return { ack: true }; } });
    expect(seen).toEqual(['evt_new00000']);
  });

  it('N: removes confirmed events after 24 hours, and never events a consumer has not confirmed', async () => {
    await seed(2);
    await sql`insert into ext_event_cursor(extension, seq) values('x', 2), ('y', 1)`.execute(store.db);
    await runRetention(store, t + DAY - 1, config, undefined, ['x', 'y']);
    expect(await seq()).toEqual([1, 2]);
    await runRetention(store, t + DAY, config, undefined, ['x', 'y']);
    expect(await seq()).toEqual([2]);
    await runRetention(store, t + DAY, config, undefined, ['x', 'y', 'z']);
    expect(await seq()).toEqual([2]);
    expect((await jobStats(store, t)).events_dropped).toBe(0);
  });

  it('N: expires events after 7 days even with no active consumer', async () => {
    await seed(1); await seed(1, t + DAY, 'new');
    await runRetention(store, t + 7 * DAY, config);
    expect(await seq()).toEqual([2]);
  });

  it('runs retention over 500 messages with an active consumer within statement limits', async () => {
    await seed(500, t - 8 * DAY);
    await runRetention(store, t, config, undefined, ['x']);
    expect(Number((await sql<{ n: number }>`select count(*) n from messages`.execute(store.db)).rows[0].n)).toBe(0);
    expect(await seq()).toEqual([]);
    expect((await sql`select from_seq, to_seq, count from ext_event_gaps`.execute(store.db)).rows).toEqual([{ from_seq: 1, to_seq: 500, count: 500 }]);
  });

  // REVIEW-TARGET 3: a Free invocation (50 D1 calls) that spent 15 before the drain still commits every confirmed event.
  it('N: three Free invocations each move the cursor, commit the writes with it and stop inside the limit', async () => {
    if (!mf) return;
    const limited = limitedD1(await mf.getD1Database('DB')), worker = createD1Store(limited.db);
    await seed(20);
    const consumer: EventConsumer = async event => ({ ack: true,
      writes: [sql`insert into guards(key, count, expires_at) values(${'g:' + event.id}, 1, ${t + DAY})`.compile(store.db)] });
    const seen: { seq: number; writes: number; jobs: number; state: string }[] = [];
    for (let i = 0; i < 3; i++) {
      limited.invocation(50);
      await expect(metered(50, async () => {
        for (let k = 0; k < 15; k++) await sql`select 1`.execute(worker.db); // authorization, license, host start
        await runJobs(worker, 'cron', { now: clock, consumers: new Map([['pro', consumer]]) });
      })).resolves.toBeUndefined();
      expect(limited.calls()).toBeLessThanOrEqual(50);
      limited.invocation(Infinity);
      seen.push({ seq: (await cursor('pro')).seq, writes: (await sql<{ n: number }>`select count(*) n from guards`.execute(store.db)).rows[0].n,
        jobs: (await sql<{ n: number }>`select count(*) n from jobs`.execute(store.db)).rows[0].n, state: (await job('pro')).state });
    }
    expect(seen[0].seq).toBeGreaterThan(0);
    expect(seen[1].seq).toBeGreaterThan(seen[0].seq); expect(seen[2].seq).toBeGreaterThan(seen[1].seq);
    for (const s of seen) expect(s).toEqual({ seq: s.seq, writes: s.seq, jobs: 1, state: 'pending' });
  });

  it('N: a stored event reaches onEvent once, from the fan-out job and not from memory', async () => {
    const onEvent = vi.fn(async (_event: DomainEvent) => ({ ack: true as const }));
    const host = await createExtensionHost({ ...config, extensions: [{ module: 'x' }] }, store, async () => ({ default: { name: 'x', onEvent } }), { keys: undefined });
    const send = (level?: 'none') => handleSend(new Request('https://mail.example/v1/send', { method: 'POST', headers: { authorization: 'Bearer test-key' },
      body: JSON.stringify({ brand: 'acme', template: 'notice', heading: 'Hi', paragraphs: 'Body' }) }), env, { store, now: () => new Date(t),
      logging: level ? { ...structuredClone(config.logging), defaults: { ...config.logging.defaults, level, requireLog: false } } : structuredClone(config.logging),
      emitEvent: host.emitEvent, durableEvents: host.durableEvents, verifyAltcha: async () => false, verifyTurnstile: async () => true,
      sendEmail: async () => ({ ok: true, status: 200, messageId: 'ses-1', response: {} }) });
    const { id } = await (await send()).json() as { id: string };
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(onEvent).not.toHaveBeenCalled();
    await runJobs(store, 'request', { now: clock, ...host.jobs });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toMatchObject({ type: 'message.sent', messageId: id, id: expect.stringMatching(/^evt_/) });
    // Level none has no stored row: memory remains its only (best-effort) delivery.
    await send('none');
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2));
    expect(await seq()).toHaveLength(1);
  });
});
