import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sql } from 'kysely';
import { createD1Store } from '../src/core/store/d1';
import { createSqliteStore } from '../src/core/store/sqlite';
import { claimResend, finishResend, getResend } from '../src/core/store/resend';
import { recordIntent } from '../src/core/logging/writer';
import { config } from '../src/core/config';
import { getTemplate } from '../src/templates';
import { generateKeyPairSync } from 'node:crypto';

describe.each(['sqlite', 'd1'] as const)('resend store: %s', driver => {
let mf: Miniflare | undefined;
beforeAll(async () => {
  if (driver === 'd1') mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response() } }', compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
});
afterAll(async () => { await mf?.dispose(); });
let store: ReturnType<typeof createSqliteStore>;
let source: string;
const now = 1800000000000;
const pair = generateKeyPairSync('x25519');
const env = { CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'c1' }] }), INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 7).toString('base64url') }]) };
beforeEach(async () => {
  store = mf ? createD1Store(await mf.getD1Database('DB')) : createSqliteStore(':memory:'); await store.migrate();
  for (const table of ['messages', 'recipients', 'subjects', 'guards', 'resend_jobs']) await sql`delete from ${sql.table(table)}`.execute(store.db);
  source = (await recordIntent({ store, env, logging: config.logging, now: () => new Date(now) }, { clientId: 'sender', brand: config.brands.acme, template: getTemplate('notice')!, data: {}, recipients: [{ role: 'to', address: 'buyer@example.com' }] })).id!;
  await store.setStatus(source, 'sent');
});
afterEach(async () => { vi.restoreAllMocks(); await store.db.destroy(); });
const claim = async (id: string, root = source, actor = 'actor', at = now) => {
  if (root !== source) {
    const row = await store.db.selectFrom('messages').selectAll().where('id', '=', source).executeTakeFirstOrThrow();
    await store.db.insertInto('messages').values({ ...row, id: root }).onConflict(c => c.column('id').doNothing()).execute();
  }
  return claimResend(store, { id, messageId: root, root, actor, now: at, metaCutoff: at - 90 * 86400000 });
};
it('claims one job and three guards under twenty concurrent requests', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => claim('job-1')));
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await store.db.selectFrom('guards').selectAll().execute()).toHaveLength(3);
  expect(await getResend(store, 'job-1')).toMatchObject({ message_id: source, state: 'pending' });
});
it('enforces cooldown and the rolling root limit without partial guards', async () => {
  expect(await claim('job-1')).toBe(true);
  expect(await claim('job-2', source, 'actor', now + 599999)).toBe(false);
  expect(await claim('job-2', source, 'actor', now + 600000)).toBe(true);
  expect(await claim('job-3', source, 'actor', now + 1200000)).toBe(true);
  expect(await claim('job-4', source, 'actor', now + 1800000)).toBe(false);
  expect(await store.db.selectFrom('guards').selectAll().execute()).toHaveLength(9);
  expect(await claim('job-4', source, 'actor', now + 86400000)).toBe(true);
});
it('enforces actor and instance daily quotas across twenty concurrent roots', async () => {
  const run = (offset: number, actor: string) => Promise.all(Array.from({ length: 20 }, (_, i) => claim(`job-${offset + i}`, `root-${offset + i}`, actor)));
  expect((await run(0, 'actor')).filter(Boolean)).toHaveLength(20);
  expect((await run(20, 'actor')).filter(Boolean)).toHaveLength(0);
  expect((await run(20, 'second')).filter(Boolean)).toHaveLength(20);
  expect((await run(40, 'third')).filter(Boolean)).toHaveLength(10);
});
it('retains reservations for uncertain outcomes and releases explicit refusals', async () => {
  await claim('job-1');
  await finishResend(store, 'job-1', 'failed', undefined, (await getResend(store, 'job-1'))!.token);
  expect(await store.db.selectFrom('guards').selectAll().execute()).toHaveLength(0);
  expect(await claim('job-1')).toBe(true);
  await finishResend(store, 'job-1', 'unknown', undefined, (await getResend(store, 'job-1'))!.token);
  expect(await claim('job-1')).toBe(false);
  expect(await claim('job-2')).toBe(false);
});
it.each(['sending', 'unknown', 'bounce_permanent', 'reject'] as const)('checks current source state %s in the claim', async status => {
  await store.setStatus(source, status);
  expect(await claim('job-1')).toBe(false);
  expect(await store.db.selectFrom('guards').selectAll().execute()).toHaveLength(0);
});

it('rolls back the job and reservations when a batch statement fails', async () => {
  const batch = store.batch.bind(store);
  vi.spyOn(store, 'batch').mockImplementationOnce(queries => batch([...queries, sql`insert into missing_table values (1)`.compile(store.db)]));
  await expect(claim('job-1')).rejects.toThrow();
  expect(await getResend(store, 'job-1')).toBeUndefined();
  expect(await store.db.selectFrom('guards').selectAll().execute()).toHaveLength(0);
});
it('requires the stored root when reserving a job', async () => {
  expect(await claimResend(store, { id: 'job-1', messageId: source, root: 'different', actor: 'actor', now, metaCutoff: 0 })).toBe(false);
});

it('keeps a newer reservation when an older completion arrives', async () => {
  await claim('job-1');
  const old = (await getResend(store, 'job-1'))!;
  await finishResend(store, 'job-1', 'failed', undefined, old.token);
  await claim('job-1');
  await finishResend(store, 'job-1', 'failed', undefined, old.token);
  expect(await getResend(store, 'job-1')).toMatchObject({ state: 'pending' });
  expect(await store.db.selectFrom('guards').selectAll().execute()).toHaveLength(3);
});

});
