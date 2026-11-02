import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testKeys, withKeys } from './fixtures/keys';
import { sql, type RootOperationNode } from 'kysely';
import { appendAudit } from '../src/core/audit';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import type { Extension, ExtensionDatabase } from '../src/core/extensions';
import { loadExtensions } from '../src/runtime/extensions';
import { parseConfig } from '../src/core/config/schema';
import { blindIndex } from '../src/core/crypto';
import { tokenSha256 } from '../src/clients';
import { signPanelAssertion } from '../src/core/panel';
import example from '../config/mailstack.example.json';

const token = 'msk_panel_' + 'a'.repeat(43), key = Buffer.alloc(32, 7).toString('base64url');
const indexKey = { kid: 'demo', key };
const env = { PANEL_ASSERTION_KEY: key, INDEX_KEYS: JSON.stringify([indexKey]) };
for (const driver of ['sqlite', 'd1'] as const) describe(`extension privacy: ${driver}`, () => {
  let store: KyselyStore, mf: Miniflare | undefined;
  let cfg: ReturnType<typeof parseConfig>;
  const rows = async (table: string) => (await sql<Record<string, unknown>>`select * from ${sql.table(table)} order by 1`.execute(store.db)).rows;
  const load = (extension: Extension) => loadExtensions(cfg, store, async () => ({ default: withKeys(extension) }));
  async function seed(count = 1, expired = false) {
    const now = Date.now(), idx = await blindIndex('one@example.com', indexKey);
    for (let start = 0; start < count; start += 10) {
      const queries = [];
      for (let i = start; i < Math.min(count, start + 10); i++) {
        const id = `msg_${String(i).padStart(4, '0')}`;
        queries.push(sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at)
          values(${id},'demo','acme','notice','meta','hash','sent',${now},${now + (expired ? -1 : 100000)})`);
        queries.push(sql`insert into subjects values(${id},${['recipient', 'reply_to', 'submitter'][i % 3]},${idx.index},${idx.kid})`);
        queries.push(sql`insert into contents values(${id},'sealed',${now + 100000})`);
      }
      await store.batch(queries.map(q => q.compile(store.db)));
    }
  }
  async function erase(runtime: Awaited<ReturnType<typeof loadExtensions>>, role = 'admin') {
    const now = Date.now();
    const req = new Request('http://localhost/internal/v1/subjects/erase', { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'x-panel-actor': 'user-1',
    }, body: JSON.stringify({ email: 'one@example.com', reason: 'Requested by subject' }) });
    req.headers.set('x-panel-assertion', await signPanelAssertion(req, {
      actor: 'user-1', role: role as 'admin', issuedAt: now, expiresAt: now + 60000, stepUpAt: now,
    }, key));
    return runtime.fetch(req, env);
  }
  beforeAll(async () => {
    if (driver === 'sqlite') store = createSqliteStore(':memory:');
    else {
      mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
      store = createD1Store(await mf.getD1Database('DB'));
    }
    await store.migrate();
  });
  beforeEach(async () => {
    for (const table of ['audit', 'events', 'recipients', 'subjects', 'contents', 'replays', 'messages', 'guards', 'resend_jobs']) await sql`delete from ${sql.table(table)}`.execute(store.db);
    cfg = parseConfig({ ...example, extensions: [{ module: 'demo-extension' }], clients: [{ id: 'panel', tokenSha256: await tokenSha256(token), scopes: ['panel'], brands: '*', templates: '*' }] });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  afterAll(async () => { await store.db.destroy(); await mf?.dispose(); });

  it('awaits one cleanup per selected message across all subject roles and batches', async () => {
    await seed(51);
    const seen: string[] = [];
    const runtime = await load({ name: 'demo', onBeforeDelete: async (selection, ctx) => {
      expect(selection.reason).toBe('erase');
      expect(Object.keys(ctx).sort()).toEqual(['appendAudit', 'config', 'db', 'now']);
      expect(await rows('messages')).toHaveLength(51);
      for (const message of selection.messages) {
        expect(message).toEqual({ id: expect.any(String), brand: 'acme', template: 'notice' });
        seen.push(message.id);
      }
      await Promise.resolve();
    } });
    const response = await erase(runtime);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 51 });
    expect(seen).toHaveLength(51); expect(new Set(seen).size).toBe(51);
    for (const table of ['messages', 'subjects', 'contents']) expect(await rows(table)).toEqual([]);
  });
  it('keeps all core rows when a later cleanup batch fails', async () => {
    await seed(51);
    const onBeforeDelete = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('unavailable'));
    const runtime = await load({ name: 'demo', onBeforeDelete });
    const response = await erase(runtime);
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ success: false });
    for (const table of ['messages', 'subjects', 'contents']) expect(await rows(table)).toHaveLength(51);
    expect(onBeforeDelete).toHaveBeenCalledTimes(2);
  });
  it.each([200, 400, 403])('returns unavailable for a numeric cleanup result: %s', async result => {
    await seed();
    const runtime = await load({ name: 'demo', onBeforeDelete: () => { throw result; } });
    expect((await erase(runtime)).status).toBe(503);
    expect(await rows('messages')).toHaveLength(1);
  });
  it('limits cleanup selection to the authenticated brand and template', async () => {
    await seed(3);
    await sql`update messages set brand='demo' where id='msg_0001'`.execute(store.db);
    await sql`update messages set template='payment' where id='msg_0002'`.execute(store.db);
    cfg.clients![0].brands = ['acme']; cfg.clients![0].templates = ['notice'];
    const onBeforeDelete = vi.fn();
    const runtime = await load({ name: 'demo', onBeforeDelete });
    expect((await erase(runtime, 'viewer')).status).toBe(403);
    expect(onBeforeDelete).not.toHaveBeenCalled();
    expect((await erase(runtime)).status).toBe(200);
    expect(onBeforeDelete.mock.calls[0][0]).toEqual({ reason: 'erase', messages: [{ id: 'msg_0000', brand: 'acme', template: 'notice' }] });
    expect(await rows('messages')).toHaveLength(2);
  });
  it.each(['messages', 'ext_other_items'])('uses the assigned database context during cleanup: %s', async table => {
    await seed();
    const runtime = await load({ name: 'demo', onBeforeDelete: async (_, ctx) => {
      await ctx.db.deleteFrom(table).execute();
    } });
    expect((await erase(runtime)).status).toBe(503);
    expect(await rows('messages')).toHaveLength(1);
  });
  it.each(['messages', 'ext_other_items'])('keeps derived database operations within the assigned tables: %s', async table => {
    await seed();
    await sql`create table if not exists ext_other_items(id text)`.execute(store.db);
    await sql`delete from ext_other_items`.execute(store.db);
    await sql`insert into ext_other_items values ('other')`.execute(store.db);
    const checked = vi.fn();
    const runtime = await load({ name: 'demo', onBeforeDelete: async (_, { db }) => {
      const handles = [db.withoutPlugins(), db.withoutPlugins().withPlugin({
        transformQuery: ({ node }) => node, transformResult: async ({ result }) => result,
      }), db.withoutPlugins().withSchema('main')];
      for (const handle of handles) {
        await expect(handle.selectFrom(table).selectAll().execute()).rejects.toThrow();
        await expect(handle.deleteFrom(table).execute()).rejects.toThrow();
        await expect(handle.updateTable(table).set({ id: 'changed' }).execute()).rejects.toThrow();
      }
      checked();
    } });
    expect((await erase(runtime)).status).toBe(200);
    expect(checked).toHaveBeenCalledOnce();
    expect(await rows('ext_other_items')).toEqual([{ id: 'other' }]);
  });
  it.each(['function', 'aggregate', 'boxed'] as const)('requires supported %s expressions', async kind => {
    await seed();
    let db!: ExtensionDatabase;
    await load({ name: 'demo', migrate: async handle => { db = handle; } });
    const text = '(select count(*) from messages) + abs';
    const expression = kind === 'boxed' ? new String(text) as unknown as string : text;
    const query = db.selectNoFrom(eb => (kind !== 'aggregate'
      ? eb.fn(expression, [eb.val(0)]) : eb.fn.agg(expression, [eb.val(0)])).as('count'));
    const execute = vi.spyOn(store.db, 'executeQuery');
    await expect(query.execute()).rejects.toThrow('Unsupported extension');
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['select', 'update', 'delete'] as const)('validates expression tokens before %s execution', async operation => {
    await seed();
    let db!: ExtensionDatabase;
    await load({ name: 'demo', migrate: async handle => {
      db = handle;
      await db.schema.createTable('ext_demo_tokens').ifNotExists().addColumn('id', 'text').execute();
    } });
    const queries = {
      select: db.selectFrom('ext_demo_tokens').select(eb => eb.fn('(select count(*) from messages) + abs', [eb.val(0)]).as('count')),
      update: db.updateTable('ext_demo_tokens').set(eb => ({ id: eb.fn('(select count(*) from messages) + abs', [eb.val(0)]) })),
      delete: db.deleteFrom('ext_demo_tokens').where(eb => eb(eb.fn('(select count(*) from messages) + abs', [eb.val(0)]), '=', 0)),
    };
    const execute = vi.spyOn(store.db, 'executeQuery');
    await expect(queries[operation].execute()).rejects.toThrow('Unsupported extension');
    expect(execute).not.toHaveBeenCalled();
  });
  it('requires table identifiers in relation nodes', async () => {
    await seed();
    let db!: ExtensionDatabase;
    await load({ name: 'demo', migrate: async handle => { db = handle; } });
    const handle = db.withPlugin({ transformResult: async ({ result }) => result,
      transformQuery: ({ node }) => ({ ...node, from: { kind: 'FromNode', froms: [{
        kind: 'TableNode', table: { kind: 'ValueNode', value: 'messages', immediate: true,
          identifier: { kind: 'IdentifierNode', name: 'ext_demo_items' } },
      }] } } as unknown as RootOperationNode),
    });
    const execute = vi.spyOn(store.db, 'executeQuery');
    await expect(handle.selectNoFrom(eb => eb.val(1).as('count')).execute()).rejects.toThrow('Unsupported extension');
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['select', 'update', 'delete'] as const)('requires distinct namespaces before %s operations', async operation => {
    await sql`create table if not exists ext_demo_other_items(id text)`.execute(store.db);
    await sql`delete from ext_demo_other_items`.execute(store.db);
    await sql`insert into ext_demo_other_items values ('other')`.execute(store.db);
    for (const names of [['demo', 'demo_other'], ['demo_other', 'demo']]) {
      cfg.extensions = names.map(name => ({ module: name + '-extension' }));
      const migrate = vi.fn(async (db: Parameters<NonNullable<Extension['migrate']>>[0]) => {
        const queries = {
          select: db.selectFrom('ext_demo_other_items').selectAll(),
          update: db.updateTable('ext_demo_other_items').set({ id: 'changed' }),
          delete: db.deleteFrom('ext_demo_other_items'),
        };
        await queries[operation].execute();
      });
      await expect(loadExtensions(cfg, store, async module => ({ default: {
        ...(module === cfg.extensions[0].module ? { keys: testKeys } : {}), name: module.replace('-extension', ''), migrate,
      } }))).rejects.toThrow('extension initialization failed');
      expect(migrate).not.toHaveBeenCalled();
      expect(await rows('ext_demo_other_items')).toEqual([{ id: 'other' }]);
    }
  });
  it('executes supported expressions and distinct extension namespaces', async () => {
    cfg.extensions = [{ module: 'demo_other-extension' }, { module: 'demoother-extension' }];
    let db!: ExtensionDatabase;
    await loadExtensions(cfg, store, async module => ({ default: {
      ...(module === cfg.extensions[0].module ? { keys: testKeys } : {}), name: module.replace('-extension', ''), migrate: async handle => {
        if (module === 'demo_other-extension') db = handle;
      },
    } satisfies Extension }));
    await db.schema.createTable('ext_demo_other_values').ifNotExists()
      .addColumn('id', 'integer', col => col.primaryKey()).addColumn('value', 'text', col => col.defaultTo('demo')).execute();
    await db.deleteFrom('ext_demo_other_values').execute();
    await db.insertInto('ext_demo_other_values').values([{ id: 1, value: 'demo' }, { id: 2, value: 'other' }]).execute();
    await db.updateTable('ext_demo_other_values').set({ value: 'demo' }).where('id', 'in', [1, 2]).execute();
    expect(await db.selectFrom('ext_demo_other_values').select(eb => [
      eb.fn.count('id').as('count'), eb.fn('upper', ['value']).as('value'),
    ]).groupBy('value').execute()).toEqual([{ count: 2, value: 'DEMO' }]);
    expect(await db.selectNoFrom(eb => eb.fn('abs', [eb.val(-2)]).as('value')).execute()).toEqual([{ value: 2 }]);
    await db.deleteFrom('ext_demo_other_values').where('id', '=', 1).execute();
    expect(await db.selectFrom('ext_demo_other_values').selectAll().execute()).toEqual([{ id: 2, value: 'demo' }]);
  });
  it.each([
    { kind: 'DataTypeNode', dataType: 'text other' },
    { kind: 'OperatorNode', operator: 'custom' },
    { kind: 'OrderByItemNode', nulls: 'custom' },
    { kind: 'ReferencesNode', onDelete: 'custom' },
    { kind: 'ForeignKeyConstraintNode', onUpdate: 'custom' },
    { kind: 'CreateTableNode', onCommit: 'custom' },
    { kind: 'SetOperationNode', operator: 'custom' },
    { kind: 'OrActionNode', action: 'custom' },
    { kind: 'SelectModifierNode', modifier: 'custom' },
    { kind: 'TopNode', expression: 'custom' },
    { kind: 'ExplainNode', format: 'custom' },
    { kind: 'FetchNode', modifier: 'custom' },
  ])('requires supported syntax fields: $kind', async selection => {
    let db!: ExtensionDatabase;
    await load({ name: 'demo', migrate: async handle => { db = handle; } });
    const query = db.selectNoFrom(eb => eb.val(1).as('value')).compile();
    const execute = vi.spyOn(store.db, 'executeQuery');
    await expect(db.executeQuery({ ...query, query: {
      kind: 'SelectQueryNode', selections: [{ kind: 'SelectionNode', selection }],
    } as RootOperationNode })).rejects.toThrow('Unsupported extension');
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([false, true])('awaits stored extension cleanup with a database result: %s', async unavailable => {
    await seed();
    const runtime = await load({ name: 'demo', migrate: async db => {
      await db.schema.createTable('ext_demo_records').ifNotExists().addColumn('message_id', 'text', c => c.primaryKey()).execute();
      await db.withoutPlugins().deleteFrom('ext_demo_records').execute();
      await db.insertInto('ext_demo_records').values({ message_id: 'msg_0000' }).execute();
    }, onBeforeDelete: async (selection, ctx) => {
      for (const message of selection.messages) await ctx.db.deleteFrom('ext_demo_records').where('message_id', '=', message.id).execute();
    } });
    if (unavailable) await sql`create trigger demo_cleanup before delete on ext_demo_records begin select raise(abort, 'unavailable'); end`.execute(store.db);
    try {
      expect((await erase(runtime)).status).toBe(unavailable ? 503 : 200);
      expect(await rows('ext_demo_records')).toHaveLength(unavailable ? 1 : 0);
      expect(await rows('messages')).toHaveLength(unavailable ? 1 : 0);
    } finally { await sql`drop trigger if exists demo_cleanup`.execute(store.db); }
  });
  it('requires all configured cleanups to finish before core deletion', async () => {
    await seed();
    cfg.extensions.push({ module: 'second-extension' });
    const first = vi.fn(), second = vi.fn(() => { throw new Error('unavailable'); });
    const runtime = await loadExtensions(cfg, store, async module => ({ default: {
      ...(module === cfg.extensions[0].module ? { keys: testKeys } : {}), name: module === 'demo-extension' ? 'demo' : 'second', onBeforeDelete: module === 'demo-extension' ? first : second,
    } }));
    expect((await erase(runtime)).status).toBe(503);
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
    expect(await rows('messages')).toHaveLength(1);
  });
  it('validates the cleanup hook when loading the extension', async () => {
    await expect(loadExtensions(cfg, store, async () => ({ default: { name: 'demo', onBeforeDelete: true } }))).rejects.toThrow('$.extensions.0');
  });
  it('returns unavailable when cleanup reaches its deadline', async () => {
    await seed();
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const runtime = await load({ name: 'demo', onBeforeDelete: () => { entered(); return new Promise(() => {}); } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = erase(runtime);
    await ready;
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).status).toBe(503);
    expect(await rows('messages')).toHaveLength(1);
  });
  it('retries retained messages after cleanup becomes available', async () => {
    await seed(1, true);
    const onBeforeDelete = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined);
    const runtime = await load({ name: 'demo', onBeforeDelete });
    await expect(runtime.runRetention(Date.now())).rejects.toThrow();
    expect(await rows('messages')).toHaveLength(1);
    expect(await rows('subjects')).toHaveLength(1);
    await runtime.runRetention(Date.now());
    expect(await rows('messages')).toEqual([]);
    expect(onBeforeDelete).toHaveBeenCalledTimes(2);
    expect(onBeforeDelete.mock.calls[0][0]).toEqual({ reason: 'retention', messages: [{ id: 'msg_0000', brand: 'acme', template: 'notice' }] });
  });
  it('finishes independent retention after a cleanup batch is unavailable', async () => {
    await seed(501, true);
    const now = Date.now();
    await sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at)
      values('live','demo','demo','notice','meta','hash','sending',${now - 900001},${now + 100000})`.execute(store.db);
    for (const table of ['contents', 'replays']) await sql`insert into ${sql.table(table)} values('live','sealed',${now - 1})`.execute(store.db);
    await store.consume('expired', now - 1);
    await sql`insert into resend_jobs(id,message_id,root,actor,token,strategy,state,created_at,expires_at)
      values('job','live','live','demo','token','source','pending',${now - 1000},${now - 1})`.execute(store.db);
    await appendAudit(store, { at: 1, actor: 'system', action: 'old' });
    const onBeforeDelete = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined);
    const runtime = await load({ name: 'demo', onBeforeDelete });
    await expect(runtime.runRetention(now)).rejects.toThrow();
    expect(onBeforeDelete).toHaveBeenCalledTimes(2);
    expect(onBeforeDelete.mock.calls[1][0].messages).toEqual([{ id: 'msg_0500', brand: 'acme', template: 'notice' }]);
    expect(await rows('messages')).toHaveLength(501);
    expect(await rows('subjects')).toHaveLength(500);
    expect((await rows('messages')).find(row => row.id === 'live')?.status).toBe('unknown');
    expect(await rows('contents')).toHaveLength(500);
    expect(await rows('replays')).toEqual([]);
    expect(await rows('guards')).toEqual([]);
    expect(await rows('resend_jobs')).toEqual([]);
    expect((await rows('events')).map(row => row.type)).toEqual(['unknown']);
    expect((await rows('audit')).map(row => row.action)).toEqual(['audit.pruned']);
    await runtime.runRetention(now);
    expect((await rows('messages')).map(row => row.id)).toEqual(['live']);
    expect(onBeforeDelete).toHaveBeenCalledTimes(3);
  }, 30000);
  it('cleans each retained message once across a full batch boundary', async () => {
    await seed(501, true);
    const seen: string[] = [];
    const runtime = await load({ name: 'demo', onBeforeDelete: selection => { seen.push(...selection.messages.map(m => m.id)); } });
    await runtime.runRetention(Date.now());
    await runtime.runRetention(Date.now());
    expect(await rows('messages')).toEqual([]);
    expect(seen).toHaveLength(501); expect(new Set(seen).size).toBe(501);
  }, 30000);
});
