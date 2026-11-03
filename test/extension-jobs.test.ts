import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createSqliteStore } from '../src/core/store/sqlite';
import type { KyselyStore } from '../src/core/store';
import { createExtensionHost } from '../src/core/extension-host';
import { runJobs } from '../src/core/jobs';
import type { Extension, ExtensionDatabase, ExtensionJob } from '../src/core/extensions';
import { parseConfig } from '../src/core/config/schema';
import example from '../config/mailstack.example.json';

let store: KyselyStore;
beforeEach(async () => { store = createSqliteStore(':memory:'); await store.migrate(); });
afterEach(async () => { await store.db.destroy(); });
async function host(job: ExtensionJob, extra: Partial<Extension> = {}) {
  let db!: ExtensionDatabase;
  const h = await createExtensionHost(parseConfig({ ...example, extensions: [{ module: 'demo' }] }), store, async () => ({ default: {
    name: 'demo', jobs: { send: job }, ...extra,
    async migrate(d: ExtensionDatabase) { db = d; await d.schema.createTable('ext_demo_items').ifNotExists().addColumn('id', 'text', c => c.primaryKey()).execute(); },
  } }));
  return { h, db, jobs: async () => (await sql<{ id: string; kind: string; state: string; attempts: number }>`select * from jobs where kind like 'ext:%'`.execute(store.db)).rows };
}

it('runs an extension job with sandboxed writes and revives it only once finished', async () => {
  const run = vi.fn<ExtensionJob['run']>(async ({ payload }, ctx) => ({ writes: [ctx.db.insertInto('ext_demo_items').values({ id: (payload as { id: string }).id }).onConflict(c => c.doNothing())] }));
  const s = await host({ run });
  await s.db.batch([s.db.enqueue('send', 'a', { id: 'a' })]);
  await s.db.batch([s.db.enqueue('send', 'a', { id: 'a' })]);
  expect(await s.jobs()).toEqual([expect.objectContaining({ id: 'ext:demo:send:a', kind: 'ext:demo:send', state: 'pending' })]);
  await runJobs(store, 'request', s.h.jobs);
  expect(run).toHaveBeenCalledTimes(1); expect(run.mock.calls[0][0]).toEqual({ payload: { id: 'a' }, attempt: 1 });
  expect((await sql`select id from ext_demo_items`.execute(store.db)).rows).toEqual([{ id: 'a' }]);
  await s.db.batch([s.db.enqueue('send', 'a', { id: 'a' })]);
  expect(await s.jobs()).toEqual([expect.objectContaining({ state: 'pending', attempts: 0 })]);
});
it('refuses undeclared kinds, invalid keys and writes outside the extension tables', async () => {
  const s = await host({ run: async (_job, ctx) => ({ writes: [ctx.db.deleteFrom('messages')] }) });
  expect(() => s.db.enqueue('other', 'a', {})).toThrow(); expect(() => s.db.enqueue('send', 'a b', {})).toThrow();
  await s.db.batch([s.db.enqueue('send', 'a', {})]);
  await expect(s.db.batch([s.db.deleteFrom('jobs')])).rejects.toThrow(); expect(await s.jobs()).toHaveLength(1);
  await runJobs(store, 'request', s.h.jobs);
  expect(await s.jobs()).toEqual([expect.objectContaining({ state: 'pending', attempts: 1 })]);
});
it('joins reconcileKey to the configuration digest', async () => {
  const generation = async () => Number((await sql<{ generation: number }>`select generation from ext_reconcile where extension = 'demo'`.execute(store.db)).rows[0]?.generation);
  const reconcile = async () => ({ done: true as const });
  await host({ run: async () => ({}) }, { reconcile, reconcileKey: 'k1' }); expect(await generation()).toBe(1);
  await host({ run: async () => ({}) }, { reconcile, reconcileKey: 'k1' }); expect(await generation()).toBe(1);
  await host({ run: async () => ({}) }, { reconcile, reconcileKey: 'k2' }); expect(await generation()).toBe(2);
});
it('leaves a running job alone when the same key is queued during its attempt', async () => {
  let s!: Awaited<ReturnType<typeof host>>;
  const run = vi.fn<ExtensionJob['run']>(async () => { await s.db.batch([s.db.enqueue('send', 'a', {})]); return {}; });
  s = await host({ run });
  await s.db.batch([s.db.enqueue('send', 'a', {})]);
  await runJobs(store, 'request', s.h.jobs); await runJobs(store, 'request', s.h.jobs);
  expect(run).toHaveBeenCalledTimes(1); expect(await s.jobs()).toEqual([expect.objectContaining({ state: 'done' })]);
});
