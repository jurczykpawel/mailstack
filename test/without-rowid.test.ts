import { afterEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sql, type RawBuilder } from 'kysely';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import { EVENTS_SCHEMA, EXT_SCHEMA, INITIAL_SCHEMA, JOBS_SCHEMA, PARTIAL_INDEX_SCHEMA, SES_STATUS_SCHEMA, WITHOUT_ROWID_SCHEMA } from '../src/core/store/migration';
import type { KyselyStore } from '../src/core/store';

// D1 suites seed thousands of rows in workerd; 5 s is too tight on a busy CI runner.
vi.setConfig({ testTimeout: 30000 });

// R12: hot tables move to WITHOUT ROWID by copying their rows; the schema before R12 is migrations 0001-0007.
const HOT = ['guards', 'jobs', 'messages', 'recipients', 'subjects'];
const KEPT = ['contents', 'events', 'replays']; // large sealed rows keep a rowid
const BEFORE = INITIAL_SCHEMA + SES_STATUS_SCHEMA + JOBS_SCHEMA + EXT_SCHEMA + EVENTS_SCHEMA + PARTIAL_INDEX_SCHEMA;
const statements = (text: string) => text.split(';').map(s => s.trim()).filter(Boolean);
let mf: Miniflare | undefined;
afterEach(async () => { await mf?.dispose(); mf = undefined; });

/** A store whose D1 statements report rows written (index entries included); SQLite reports none. */
async function open(kind: 'sqlite' | 'd1') {
  const meter = { writes: 0 };
  if (kind === 'sqlite') return { store: createSqliteStore(':memory:'), meter, raw: undefined };
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
  const raw = await mf.getD1Database('DB'), originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => { const w = { bind: (...v: unknown[]) => wrap(s.bind(...v)),
    all: async () => { const r = await s.all(); meter.writes += r.meta.rows_written; return r; } } as D1PreparedStatement; originals.set(w, s); return w; };
  const store = createD1Store({ prepare: (q: string) => wrap(raw.prepare(q)),
    batch: async (ss: D1PreparedStatement[]) => { const r = await raw.batch(ss.map(s => originals.get(s)!)); for (const x of r) meter.writes += x.meta.rows_written; return r; } } as D1Database);
  return { store, meter, raw };
}
const rows = async <T,>(store: KyselyStore, query: RawBuilder<T>) => (await query.execute(store.db)).rows;
const layout = (store: KyselyStore) => rows(store, sql<{ type: string; name: string; wr: number }>`select type, name, tbl_name, sql like '%WITHOUT ROWID' wr from sqlite_master
  where type in ('table','index') and name not like 'sqlite_%' and name not like '_cf_%' order by type, name`);
const snapshot = async (store: KyselyStore) => Object.fromEntries(await Promise.all([...HOT, ...KEPT].map(async t =>
  [t, await rows(store, sql`select * from ${sql.table(t)} order by 1, 2, 3`)] as const)));

/** One row per hot table, guards also at the copy boundaries (rowid 50000/50001) and past the last range. */
async function seed(store: KyselyStore) {
  for (const q of statements(BEFORE)) await sql.raw(q).execute(store.db);
  const message = (id: string) => sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at,ref_idx,provider_account,provider_message_id)
    values(${id},'legacy','acme','notice','meta','h','sent',1,9,${'r' + id},'a',${'p' + id})`;
  for (const q of [message('m1'), message('m2'),
    sql`insert into recipients values('m1',0,'to','i1','k','s','h','sent',null),('m1',1,'cc','i2','k','s','h','sent',2)`,
    sql`insert into subjects values('m1','recipient','i1','k'),('m1','reply_to','i3','k')`,
    sql`insert into contents values('m1',${'x'.repeat(5000)},9)`, sql`insert into replays values('m1','r',9)`,
    sql`insert into events values('e1','m1',0,'ses','s1','delivered',1,1,'sns','ok',null)`,
    sql`insert into guards(rowid,key,count,expires_at) values(1,'g1',1,9),(50000,'g2',2,9),(50001,'g3',1,9),(2000000,'g4',1,9)`,
    sql`insert into jobs(id,kind,state,payload,run_after,created_at,updated_at) values('j1','erase','pending','{}',1,1,1)`]) await q.execute(store.db);
}

describe.each(['sqlite', 'd1'] as const)('%s', kind => {
  it('copies every row and index of the hot tables, then runs as a no-op; inserts write one row less', async () => {
    const { store, meter } = await open(kind);
    await seed(store);
    const before = await snapshot(store), indexes = (await layout(store)).filter(r => r.type === 'index');
    await store.migrate();
    expect(await snapshot(store)).toEqual(before);
    expect((await layout(store)).filter(r => r.type === 'index' && r.name !== 'messages_time')).toEqual(indexes);
    expect((await layout(store)).some(r => r.name === 'messages_time')).toBe(true);
    expect((await layout(store)).filter(r => r.type === 'table' && r.wr).map(r => r.name).sort()).toEqual(HOT);
    await store.migrate(); // converted tables are skipped (a second copy by rowid would fail)
    expect(await snapshot(store)).toEqual(before);
    const converted = await layout(store);
    for (const q of statements(BEFORE)) await sql.raw(q).execute(store.db); // rollback: the previous release's migrate()
    expect(await layout(store)).toEqual(converted); expect(await snapshot(store)).toEqual(before);
    expect(await rows(store, sql`explain query plan select id from messages where provider_account='a' and provider_message_id='pm1'`))
      .toEqual([expect.objectContaining({ detail: expect.stringContaining('messages_provider_set') })]);
    if (kind === 'sqlite') return;
    const cost = async (query: RawBuilder<unknown>) => { meter.writes = 0; await query.execute(store.db); return meter.writes; };
    expect(await cost(sql`insert into guards values('g5',1,9)`)).toBe(2); // row + expiry (was 3: + primary key index)
    expect(await cost(sql`insert into subjects values('m2','recipient','i9','k')`)).toBe(2);
    expect(await cost(sql`insert into recipients values('m2',0,'to','i9','k','s','h','sending',null)`)).toBe(2);
    expect(await cost(sql`insert into contents values('m2','c',9)`)).toBe(3); // unchanged: row + primary key + expiry
  });

  it('N: a row the new key rejects stops the whole conversion; every table keeps its rows and its rowid', async () => {
    const { store } = await open(kind);
    await seed(store);
    await sql`insert into guards(key,count,expires_at) values(null,1,9)`.execute(store.db); // a rowid table accepts a NULL text key
    const before = await snapshot(store), tables = await layout(store);
    await expect(store.migrate()).rejects.toThrow();
    expect(await snapshot(store)).toEqual(before);
    expect(await layout(store)).toEqual(tables);
    expect(tables.filter(r => r.wr)).toEqual([]);
  });
});

it('migration 0008 converts a D1 database with migrations 0001-0007 in one batch', async () => {
  const { store, raw } = await open('d1');
  await seed(store);
  const before = await snapshot(store);
  await raw!.batch(statements(WITHOUT_ROWID_SCHEMA).map(q => raw!.prepare(q)));
  expect(await snapshot(store)).toEqual(before);
  expect((await layout(store)).filter(r => r.type === 'table' && r.wr).map(r => r.name).sort()).toEqual(HOT);
  await store.migrate();
  expect(await snapshot(store)).toEqual(before);
});
