import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import { createExtensionHost } from '../src/core/extension-host';
import { loadExtensions } from '../src/runtime/extensions';
import type { Extension, ExtensionDatabase } from '../src/core/extensions';
import { parseConfig } from '../src/core/config/schema';
import { config } from '../src/core/config';
import { createApp } from '../src/index';
import { tokenSha256 } from '../src/clients';
import { testKeys, withKeys } from './fixtures/keys';
import { panelEnv, signPanel } from './fixtures/panel';
import example from '../config/mailstack.example.json';
import type { Env } from '../src/types';

vi.setConfig({ testTimeout: 30000 });
const token = 'msk_panel_' + 'a'.repeat(43), apiKey = 'full-key-secret';
const workerEnv = { ...panelEnv, API_KEY: apiKey, SES_REGION: 'eu-west-1', INTERNAL_HOST: 'internal.example' } as unknown as Env;
const ctx = { waitUntil() {} } as unknown as ExecutionContext;
const demo = (handler = vi.fn()): Extension => ({
  name: 'demo',
  async migrate(db) { await db.schema.createTable('ext_demo_items').ifNotExists().addColumn('id', 'text', c => c.primaryKey()).execute(); },
  routes(app) {
    app.route('POST', '/items', async (req, c) => {
      handler();
      const { ids } = await req.json() as { ids: string[] };
      await c.db.batch(ids.map(id => c.db.insertInto('ext_demo_items').values({ id })));
      return Response.json({ actor: c.panel.actor, rows: await c.db.selectFrom('ext_demo_items').select('id').orderBy('id').execute() });
    });
  },
});
const post = (host: string, ids: string[]) => signPanel(new Request(`https://${host}/internal/ext/demo/items`,
  { method: 'POST', body: JSON.stringify({ ids }) }), token, undefined, { aud: host === 'localhost' ? panelEnv.PANEL_AUDIENCE : host });
const send = (app: ReturnType<typeof createApp>) => app.fetch(new Request('https://mail.example/v1/send', {
  method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ brand: 'acme', template: 'notice', heading: 'Hi', paragraphs: 'Body' }),
}), workerEnv, ctx).then(r => r.status);
const sendEmail = () => vi.fn(async () => ({ ok: true, status: 200, response: '{}' }));
/** The Worker reads the bundled configuration; the static Pro module is enabled for one test. */
async function withProEntry<T>(run: () => Promise<T>): Promise<T> {
  config.extensions.push({ module: 'mailstack-pro' });
  try { return await run(); } finally { config.extensions.pop(); }
}

for (const driver of ['sqlite', 'd1'] as const) describe(`extension host: ${driver}`, () => {
  let store: KyselyStore, mf: Miniflare | undefined, cfg: ReturnType<typeof parseConfig>;
  beforeAll(async () => {
    if (driver === 'sqlite') store = createSqliteStore(':memory:');
    else { mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-06-01', d1Databases: ['DB'] })); store = createD1Store(await mf.getD1Database('DB')); }
    await store.migrate();
    cfg = parseConfig({ ...example, clients: [{ id: 'panel', tokenSha256: await tokenSha256(token), scopes: ['panel'], brands: '*', templates: '*' }],
      extensions: [{ module: 'demo-extension' }] });
  });
  afterEach(async () => { vi.restoreAllMocks(); await sql`drop table if exists ext_demo_items`.execute(store.db); });
  afterAll(async () => { await store.db.destroy(); await mf?.dispose(); });

  it('serves the same extension route in Node and on the Worker internal host', async () => {
    const node = await loadExtensions(cfg, store, async () => ({ default: withKeys(demo()) }));
    const fromNode = await node.fetch(await post('localhost', ['b', 'a']), panelEnv);
    await sql`delete from ext_demo_items`.execute(store.db);
    const worker = createApp({ store, keys: testKeys(cfg), access: async () => true }, undefined, demo());
    const fromWorker = await withProEntry(async () => worker.fetch(await post('internal.example', ['b', 'a']), workerEnv, ctx));
    expect([fromNode.status, fromWorker.status]).toEqual([200, 200]);
    expect(await fromWorker.json()).toEqual(await fromNode.json());
  });

  it('refuses the whole batch when one element leaves the extension prefix', async () => {
    let db!: ExtensionDatabase;
    await createExtensionHost(cfg, store, async () => ({ default: { ...demo(), async migrate(d: ExtensionDatabase) { db = d; await demo().migrate!(d); } } }), { keys: undefined });
    const batch = vi.spyOn(store, 'batch');
    for (const outside of [db.deleteFrom('messages'), db.insertInto('ext_other_items').values({ id: 'x' })]) {
      await expect(db.batch([db.insertInto('ext_demo_items').values({ id: 'c' }), outside])).rejects.toThrow();
    }
    expect(batch).not.toHaveBeenCalled();
    expect((await sql`select * from ext_demo_items`.execute(store.db)).rows).toEqual([]);
    await db.batch([db.insertInto('ext_demo_items').values({ id: 'ok' })]);
    expect((await sql`select id from ext_demo_items`.execute(store.db)).rows).toEqual([{ id: 'ok' }]);
  });

  it('keeps the full key sending when Pro fails to import or initialize (Node and Worker)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failures = [async () => { throw new Error('import failed'); }, async () => ({ default: () => { throw new Error('init failed'); } })];
    for (const importer of failures) {
      // `clients` is configured, yet a failed provider must not stop the Node runtime (N7).
      const node = await loadExtensions(cfg, store, importer);
      expect(node.features()).toEqual([{ module: 'demo-extension', state: 'unavailable', reason: 'initialization' }]);
      const nodeApp = createApp({ store, sendEmail: sendEmail(), keys: node.keys, emitEvent: node.emitEvent, logging: config.logging });
      expect(await send(nodeApp)).toBe(200);
    }
    const worker = createApp({ store, sendEmail: sendEmail(), keys: testKeys(cfg), logging: config.logging, access: async () => true }, undefined, () => { throw new Error('init failed'); });
    await withProEntry(async () => {
      expect(await send(worker)).toBe(200);
      expect((await worker.fetch(await post('internal.example', ['a']), workerEnv, ctx)).status).toBe(404);
    });
  });

  it('answers 404 for extension routes on the public host', async () => {
    const handler = vi.fn();
    const worker = createApp({ store, keys: testKeys(cfg), access: async () => true }, undefined, demo(handler));
    await withProEntry(async () => {
      for (const host of ['mail.example', 'internal.example.evil']) {
        const req = await post('internal.example', ['a']);
        expect((await worker.fetch(new Request(req.url.replace('internal.example', host), req), workerEnv, ctx)).status).toBe(404);
      }
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
