import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { expressionBuilder, sql } from 'kysely';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import { createExtensionHost } from '../src/core/extension-host';
import { compileMigrations, migrationFile, migrationQueries, reconcilers, reconcileStep, startReconcile, type ExtensionMigration } from '../src/core/ext-migrations';
import { runJobs } from '../src/core/jobs';
import type { Extension } from '../src/core/extensions';
import type { PanelPrincipal } from '../src/core/panel';
import { parseConfig } from '../src/core/config/schema';
import example from '../config/mailstack.example.json';

vi.setConfig({ testTimeout: 30000 });
const v1: ExtensionMigration = { version: 1, name: 'items', up: db => db.schema.createTable('ext_demo_items')
  .addColumn('id', 'text', c => c.primaryKey()).addColumn('state', 'text', c => c.notNull().defaultTo("new';x")).execute() };
const v2: ExtensionMigration = { version: 2, name: 'items_owner', async up(db) {
  await db.schema.alterTable('ext_demo_items').addColumn('owner', 'text').execute();
  await db.schema.createIndex('ext_demo_items_owner').on('ext_demo_items').column('owner').execute();
} };
/** Valid first statement, failing second one: the table already exists (fails in SQLite and D1 alike). */
const broken: ExtensionMigration = { version: 2, name: 'broken', async up(db) {
  await db.schema.createTable('ext_demo_partial').addColumn('id', 'text').execute();
  await db.schema.createTable('ext_demo_items').addColumn('id', 'text').execute();
} };
const panel = { actor: 'tester', scopes: ['panel'], brands: '*', templates: '*' } as unknown as PanelPrincipal;
const extension = (migrations: ExtensionMigration[], more: Partial<Extension> = {}): Extension => ({ name: 'demo', migrations,
  routes(app) { app.route('GET', '/items', async (_req, c) => Response.json(await c.db.selectFrom('ext_demo_items').selectAll().execute())); }, ...more });
const cfg = (marker = 'a') => parseConfig({ ...example, extensions: [{ module: 'demo-extension', options: { marker } }] });
const get = (host: Awaited<ReturnType<typeof createExtensionHost>>) =>
  host.route(new Request('https://internal.example/internal/ext/demo/items'), {}, panel);
const tables = async (store: KyselyStore) => (await sql<{ name: string; type: string }>`select name, type from sqlite_master
  where type in ('table','index') and name like 'ext_demo_%' order by name`.execute(store.db)).rows;
const ledger = async (store: KyselyStore) => (await sql<{ version: number }>`select version from ext_migrations order by version`.execute(store.db)).rows.map(r => Number(r.version));

describe('extension migrations: compile', () => {
  const refused = async (up: ExtensionMigration['up']) => expect(compileMigrations('demo', [{ version: 1, name: 'm', up }])).rejects.toThrow();
  it('compiles the schema builder to SQL with a stable checksum and an immutable file name', async () => {
    const [a] = await compileMigrations('demo', [v1]), [b] = await compileMigrations('demo', [v1]);
    expect(a.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(a.checksum).toBe(b.checksum);
    expect(a.file).toBe('1001_ext_demo_1.sql');
    expect(migrationFile(a)).toBe(`create table "ext_demo_items" ("id" text primary key, "state" text default 'new'';x' not null);\n`
      + `insert into ext_migrations(extension, version, name, checksum)\n    values ('demo', 1, 'items', '${a.checksum}');\n`);
  });
  it('N: refuses raw SQL, foreign tables, core references, unprefixed indexes, two statements in one node and data statements', async () => {
    await refused(db => db.schema.createTable('ext_demo_x').addColumn('id', 'text').modifyEnd(sql`; drop table messages`).execute());
    await refused(db => db.schema.createTable('items').addColumn('id', 'text').execute());
    await refused(db => db.schema.createTable('ext_demo_x').addColumn('m', 'text', c => c.references('messages.id')).execute());
    await refused(db => db.schema.createIndex('items_owner').on('ext_demo_items').column('owner').execute());
    await refused(db => db.schema.alterTable('ext_demo_items').addColumn('a', 'text').addColumn('b', 'text').execute());
    await refused(async db => { await db.insertInto('ext_demo_items').values({ id: 'x' }).execute(); });
    await refused(async db => { await db.deleteFrom('ext_demo_items').execute(); });
    // A bound value cannot be written to a migration file (CHECK with a parameter).
    await refused(db => db.schema.createTable('ext_demo_x').addColumn('id', 'text').addCheckConstraint('ext_demo_c', expressionBuilder<any, any>()('id', '>', 'a')).execute());
    await refused(() => undefined);
  });
  it('N: refuses unordered or invalid versions and names', async () => {
    await expect(compileMigrations('demo', [v2, v1])).rejects.toThrow();
    await expect(compileMigrations('demo', [{ ...v1, version: 0 }])).rejects.toThrow();
    await expect(compileMigrations('demo', [{ ...v1, name: 'Bad-Name' }])).rejects.toThrow();
  });
});

for (const driver of ['sqlite', 'd1'] as const) describe(`extension migrations: ${driver}`, () => {
  let store: KyselyStore, mf: Miniflare | undefined;
  // Node applies at start; on the Worker `wrangler d1 migrations apply` runs the same compiled file before the host.
  const host = async (ext: Extension, config = cfg()) => {
    if (driver === 'd1') for (const m of await compileMigrations(ext.name, ext.migrations)) {
      if (!(await ledger(store)).includes(m.version)) await store.batch(migrationQueries(m)).catch(() => {});
    }
    return createExtensionHost(config, store, async () => ({ default: ext }), { applyMigrations: driver === 'sqlite' });
  };
  beforeAll(async () => {
    if (driver === 'sqlite') store = createSqliteStore(':memory:');
    else { mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-06-01', d1Databases: ['DB'] })); store = createD1Store(await mf.getD1Database('DB')); }
    await store.migrate();
  });
  afterEach(async () => {
    for (const { name, type } of await tables(store)) await sql.raw(`drop ${type} if exists "${name}"`).execute(store.db).catch(() => {});
    for (const table of ['ext_migrations', 'ext_reconcile', 'jobs']) await sql.raw(`delete from ${table}`).execute(store.db);
    reconcilers.clear();
  });
  afterAll(async () => { await store.db.destroy(); await mf?.dispose(); });

  it('applies each migration with its ledger row once and serves the extension', async () => {
    const first = await host(extension([v1, v2]));
    expect(first.features()).toEqual([{ module: 'demo-extension', state: 'ready', name: 'demo', capabilities: [] }]);
    expect(await ledger(store)).toEqual([1, 2]);
    await host(extension([v1, v2]));
    expect(await ledger(store)).toEqual([1, 2]);
    expect((await get(first)).status).toBe(200);
  });

  it('N: a failing second statement applies nothing and leaves the extension unavailable: schema', async () => {
    await host(extension([v1]));
    const failed = await host(extension([v1, broken]));
    expect((await tables(store)).map(t => t.name)).toEqual(['ext_demo_items']);
    expect(await ledger(store)).toEqual([1]);
    expect(failed.features()).toEqual([{ module: 'demo-extension', state: 'unavailable', reason: 'schema' }]);
    const res = await get(failed);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'extension_unavailable', reason: 'schema' });
  });

  it('N: a changed checksum makes the extension unavailable: schema with 503 on its routes', async () => {
    await host(extension([v1]));
    await sql`update ext_migrations set checksum = 'f' || substr(checksum, 2) where version = 1`.execute(store.db);
    const changed = await host(extension([v1]));
    expect(changed.features()[0]).toMatchObject({ state: 'unavailable', reason: 'schema' });
    expect((await get(changed)).status).toBe(503);
  });

  it('old code on the newer expanded schema stays ready; a manifest version missing from the ledger does not', async () => {
    await host(extension([v1, v2]));
    const old = await host(extension([v1]));
    expect(old.features()[0].state).toBe('ready');
    await sql`insert into ext_demo_items(id, owner) values ('n', 'new code')`.execute(store.db);
    expect(await (await get(old)).json()).toEqual([{ id: 'n', state: "new';x", owner: 'new code' }]);
    // A ledger row inside the manifest range but outside the manifest comes from another release.
    const [v3] = await compileMigrations('demo', [v1, { ...v2, version: 3 }]).then(m => m.slice(1));
    await sql`insert into ext_migrations(extension, version, name, checksum) values ('demo', 3, ${v3.name}, ${v3.checksum})`.execute(store.db);
    const diverged = await createExtensionHost(cfg(), store, async () => ({ default: extension([v1, { ...v2, version: 3 }]) }));
    expect(diverged.features()[0]).toMatchObject({ state: 'unavailable', reason: 'schema' });
    await sql`delete from ext_migrations where version in (2, 3)`.execute(store.db);
    const gap = await createExtensionHost(cfg(), store, async () => ({ default: extension([v1, { ...v2, version: 3 }]) }));
    expect(gap.features()[0]).toMatchObject({ state: 'unavailable', reason: 'schema' });
  });

  it('is ready only after reconcile finishes for the current configuration, resuming from the cursor', async () => {
    const seen: (string | null)[] = [];
    const reconcile = vi.fn(async (_db: unknown, { cursor }: { cursor: string | null }) => {
      seen.push(cursor); return cursor ? { done: true as const } : { cursor: 'half' };
    });
    const pending = await host(extension([v1], { reconcile }));
    expect(pending.features()[0]).toMatchObject({ state: 'unavailable', reason: 'reconcile' });
    expect(await (await get(pending)).json()).toMatchObject({ code: 'extension_unavailable', reason: 'reconcile' });
    await runJobs(store, 'cron');
    expect(seen).toEqual([null, 'half']);
    // Capabilities refresh before any route call: the finished job is reported without waiting for a request.
    expect(pending.features()[0].state).toBe('unavailable');
    await pending.refresh();
    expect(pending.features()[0].state).toBe('ready');
    expect((await get(pending)).status).toBe(200);
    expect(pending.features()[0].state).toBe('ready');
    expect((await host(extension([v1], { reconcile }))).features()[0].state).toBe('ready');
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('N: with two configurations in parallel the older generation never writes progress or completion', async () => {
    const reconcile = vi.fn(async () => ({ done: true as const }));
    await host(extension([v1], { reconcile }), cfg('a'));
    const [oldJob] = (await sql<{ id: string; payload: string }>`select id, payload from jobs`.execute(store.db)).rows;
    await host(extension([v1], { reconcile }), cfg('b'));
    const state = () => sql<{ config_sha: string; generation: number; done_at: number | null }>`select config_sha, generation, done_at
      from ext_reconcile`.execute(store.db).then(r => r.rows[0]);
    const newer = await state();
    expect(Number(newer.generation)).toBe(2);
    expect(await reconcileStep({ id: oldJob.id, kind: 'ext.reconcile', cursor: null, attempt: 1, payload: JSON.parse(oldJob.payload) }, { store, now: 1 }))
      .toEqual({ result: { superseded: true } });
    // An isolate still holding the old configuration refuses the newer generation's job instead of completing it.
    reconcilers.set('demo', { configSha: 'old', run: async () => ({ done: true }) });
    await expect(reconcileStep({ id: 'j', kind: 'ext.reconcile', cursor: null, attempt: 1, payload: { extension: 'demo', generation: 2 } }, { store, now: 1 })).rejects.toThrow();
    // A new configuration arrives while generation 2 is running: its completion no longer applies (WHERE generation).
    reconcilers.set('demo', { configSha: newer.config_sha, run: async () => { await startReconcile(store, 'demo', 'c', 5); return { done: true }; } });
    const step = await reconcileStep({ id: 'j', kind: 'ext.reconcile', cursor: null, attempt: 1, payload: { extension: 'demo', generation: 2 } }, { store, now: 1 });
    expect(await store.batch(step.writes!)).toEqual([0]);
    expect(await state()).toMatchObject({ config_sha: 'c', done_at: null });
    expect(Number((await state()).generation)).toBe(3);
  });
});
