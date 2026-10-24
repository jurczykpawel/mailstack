import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import { appendAudit, verifyChain, type AuditRow } from '../src/core/audit';
import { runRetention, isContentReadable } from '../src/core/retention';
import { config } from '../src/core/config';
import worker from '../src/index';
import type { Env } from '../src/types';

const now = Date.UTC(2026, 9, 24);
const day = 86400000;
for (const driver of ['sqlite', 'd1'] as const) describe(`maintenance: ${driver}`, () => {
  let store: KyselyStore;
  let mf: Miniflare | undefined;
  let binding: D1Database;
  const rows = async () => (await sql<AuditRow>`select * from audit order by seq`.execute(store.db)).rows;
  const count = async (table: string) => (await sql<{ n: number }>`select count(*) n from ${sql.table(table)}`.execute(store.db)).rows[0].n;
  const message = async (id: string, created = now, expires = now + day) => {
    await sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at)
      values (${id},'test','acme','notice','meta','hash','sending',${created},${expires})`.execute(store.db);
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
  beforeEach(async () => {
    for (const table of ['audit', 'events', 'recipients', 'subjects', 'contents', 'replays', 'messages', 'guards'])
      await sql`delete from ${sql.table(table)}`.execute(store.db);
  });
  afterAll(async () => { await store?.db.destroy(); await mf?.dispose(); });
  it('appends canonical entries and checks the complete sequence against its head', async () => {
    for (let i = 0; i < 3; i++) await appendAudit(store, { at: now, actor: 'system', action: 'test', details: { z: 1, a: 2 } });
    const chain = await rows();
    expect(chain.map(r => r.seq)).toEqual([1, 2, 3]);
    expect(chain[0].prev_hash).toBe('0'.repeat(64));
    expect(chain[0].details).toBe('{"a":2,"z":1}');
    expect(chain[0].hash).toBe(createHash('sha256').update([chain[0].prev_hash, 1, now, 'system', 'test', '', chain[0].details].join('\n')).digest('hex'));
    const head = chain[2];
    expect(verifyChain(chain, head)).toBe(true);
    expect(verifyChain([{ ...chain[0], action: 'other' }, ...chain.slice(1)], head)).toBe(false);
    expect(verifyChain([chain[0], chain[2]], head)).toBe(false);
    expect(verifyChain(chain.slice(0, -1), head)).toBe(false);
    expect(verifyChain([], head)).toBe(false);
  });
  it('assigns consecutive sequences to twenty concurrent appends', async () => {
    await Promise.all(Array.from({ length: 20 }, () => appendAudit(store, { at: now, actor: 'system', action: 'test' })));
    const chain = await rows();
    expect(chain.map(r => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(verifyChain(chain)).toBe(true);
  });
  it('retries primary key conflicts three times and propagates other failures', async () => {
    const original = store.batch.bind(store);
    let attempts = 0;
    const batch = vi.spyOn(store, 'batch').mockImplementation(async queries => {
      if (++attempts <= 3) throw new Error('UNIQUE constraint failed: audit.seq');
      return original(queries);
    });
    try {
      await appendAudit(store, { at: now, actor: 'system', action: 'test' });
      expect(attempts).toBe(4);
      batch.mockRejectedValue(new Error('storage unavailable'));
      await expect(appendAudit(store, { at: now, actor: 'system', action: 'test' })).rejects.toThrow('storage unavailable');
      batch.mockRejectedValue(new Error('UNIQUE constraint failed: audit.seq'));
      const before = batch.mock.calls.length;
      await expect(appendAudit(store, { at: now, actor: 'system', action: 'test' })).rejects.toThrow('Audit append unavailable');
      expect(batch.mock.calls.length - before).toBe(4);
    } finally { batch.mockRestore(); }
    expect(await count('audit')).toBe(1);
  });
  it('keeps each writer when independent stores append identical entries', async () => {
    if (driver !== 'd1') return;
    const other = createD1Store(binding);
    try {
      const entry = { at: now, actor: 'system', action: 'test' };
      await Promise.all([appendAudit(store, entry), appendAudit(other, entry)]);
      expect((await rows()).map(row => row.seq)).toEqual([1, 2]);
    } finally { await other.db.destroy(); }
  });
  it('keeps audit rows when the prune marker cannot be written', async () => {
    await appendAudit(store, { at: 1, actor: 'system', action: 'test' });
    const original = store.batch.bind(store);
    const batch = vi.spyOn(store, 'batch').mockImplementation(async queries => {
      if (queries.some(query => query.compile(store.db).sql.includes('insert into audit'))) throw new Error('storage unavailable');
      return original(queries);
    });
    try { await expect(runRetention(store, now, config)).rejects.toThrow('storage unavailable'); }
    finally { batch.mockRestore(); }
    expect(await count('audit')).toBe(1);
  });
  it('keeps a verifiable suffix across repeated pruning', async () => {
    const old = now - (config.logging.ceilings.auditDays + 1) * day;
    await appendAudit(store, { at: old, actor: 'system', action: 'old' });
    await appendAudit(store, { at: now, actor: 'system', action: 'current' });
    const first = (await rows())[0];
    await runRetention(store, now, config);
    let chain = await rows();
    expect(chain.map(r => r.seq)).toEqual([2, 3]);
    expect(JSON.parse(chain[1].details!)).toEqual({ upTo: 1, hashAtUpTo: first.hash });
    expect(verifyChain(chain)).toBe(true);
    expect(verifyChain(chain, first)).toBe(true);
    expect(verifyChain(chain.slice(0, 1))).toBe(false);
    await runRetention(store, now + (config.logging.ceilings.auditDays + 1) * day, config);
    chain = await rows();
    expect(chain).toHaveLength(1);
    expect(verifyChain(chain)).toBe(true);
  });
  it('refuses expired content before maintenance and purges only expired rows', async () => {
    for (const table of ['contents', 'replays']) {
      await sql`insert into ${sql.table(table)} values ('old','sealed',${now}),('fresh','sealed',${now + 1})`.execute(store.db);
    }
    expect(isContentReadable({ expires_at: now }, now)).toBe(false);
    expect(isContentReadable({ expires_at: now + 1 }, now)).toBe(true);
    expect(isContentReadable(undefined, now)).toBe(false);
    await store.consume('old', now);
    await store.consume('fresh', now + 1);
    await runRetention(store, now, config);
    for (const table of ['contents', 'replays', 'guards']) expect(await count(table)).toBe(1);
  });
  it('removes 501 expired messages and all their children while keeping the boundary', async () => {
    for (let i = 0; i < 501; i++) {
      const id = `m_${i}`;
      await message(id, now, now - 1);
      await sql`insert into recipients values (${id},0,'to','idx','kid','sealed','hint','sent',null)`.execute(store.db);
      await sql`insert into subjects values (${id},'recipient','idx','kid')`.execute(store.db);
      for (const table of ['contents', 'replays']) await sql`insert into ${sql.table(table)} values (${id},'sealed',${now + day})`.execute(store.db);
      await sql`insert into events(id,message_id,source,source_event_id,type,occurred_at,received_at,auth)
        values (${id},${id},'local',${id},'sent',${now},${now},'local')`.execute(store.db);
    }
    await message('boundary', now, now);
    const original = store.batch.bind(store);
    const sizes: number[] = [];
    const batch = vi.spyOn(store, 'batch').mockImplementation(async queries => {
      const changes = await original(queries);
      if (queries.at(-1)?.compile(store.db).sql.startsWith('delete from messages')) sizes.push(changes.at(-1)!);
      return changes;
    });
    try { await runRetention(store, now, config); } finally { batch.mockRestore(); }
    expect(sizes).toEqual([500, 1]);
    expect(await count('messages')).toBe(1);
    for (const table of ['recipients', 'subjects', 'contents', 'replays', 'events']) expect(await count(table)).toBe(0);
  }, 30000);
  it('applies configured content and metadata ceilings to existing rows', async () => {
    const cfg = structuredClone(config);
    cfg.logging.ceilings.contentDays = 1;
    cfg.logging.ceilings.metaDays = 2;
    await message('content', now - day);
    await message('metadata', now - 2 * day - 1);
    for (const table of ['contents', 'replays']) await sql`insert into ${sql.table(table)} values ('content','sealed',${now + day})`.execute(store.db);
    await runRetention(store, now, cfg);
    expect(await count('messages')).toBe(1);
    expect(await count('contents')).toBe(0);
    expect(await count('replays')).toBe(0);
  });
  it('records unknown once for older sending rows and keeps fresh rows', async () => {
    await message('old', now - 900001);
    await message('boundary', now - 900000);
    await message('fresh');
    await runRetention(store, now, config);
    await runRetention(store, now, config);
    const messages = (await sql<{ id: string; status: string }>`select id,status from messages order by id`.execute(store.db)).rows;
    expect(messages).toEqual([{ id: 'boundary', status: 'sending' }, { id: 'fresh', status: 'sending' }, { id: 'old', status: 'unknown' }]);
    const events = (await sql<{ source: string; type: string; auth: string }>`select source,type,auth from events`.execute(store.db)).rows;
    expect(events).toEqual([{ source: 'local', type: 'unknown', auth: 'local' }]);
    const event = (await sql<{ id: string }>`select id from events`.execute(store.db)).rows[0];
    expect(event.id).toMatch(/^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });
  it('rolls back a failed atomic batch', async () => {
    await expect(store.batch([sql`insert into guards values ('batch',1,1)`, sql`insert into absent_table values (1)`])).rejects.toThrow();
    expect(await count('guards')).toBe(0);
  });
  if (driver === 'd1') it('runs scheduled maintenance through waitUntil', async () => {
    await store.consume('old', now);
    const pending: Promise<unknown>[] = [];
    worker.scheduled({ scheduledTime: now } as ScheduledController, { DB: binding } as Env,
      { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException() {} } as ExecutionContext);
    await Promise.all(pending);
    expect(await count('guards')).toBe(0);
  });
});
