import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { generateIdentity, identityToRecipient } from 'age-encryption';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import { initTombstoneRegistry, readTombstones, tombstoneRegistry } from '../src/core/offsite';
import { b2Env, fakeB2 } from './fixtures/fake-b2';
it.each(['sqlite', 'd1'] as const)('serializes independent %s writers and keeps pending allocation after restart', async driver => {
  const dir = await mkdtemp('/private/tmp/mailstack-register-'), identity = await generateIdentity();
  const env = { ...b2Env, BACKUP_AGE_RECIPIENT: await identityToRecipient(identity) };
  const mf = driver === 'd1' ? new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response() } }', compatibilityDate: '2026-06-01', d1Databases: ['DB'] })) : undefined;
  const db = await mf?.getD1Database('DB');
  const stores = [0, 1].map(() => db ? createD1Store(db) : createSqliteStore(join(dir, 'api.sqlite')));
  try {
    await stores[0].migrate(); fakeB2(); await initTombstoneRegistry(env);
    const writers = [tombstoneRegistry(env), tombstoneRegistry(env)], jobs = ['job_' + 'a'.repeat(32), 'job_' + 'b'.repeat(32)];
    const t = [{ kid: 'i1', index: 'demo-index', at: 1, brands: '*' as const, templates: '*' as const }];
    const steps = await Promise.all(writers.map((write, i) => write(jobs[i], t, stores[i])));
    const commits = await Promise.allSettled(steps.map((step, i) => stores[i].batch(step.writes!)));
    expect(commits.filter(c => c.status === 'fulfilled')).toHaveLength(1);
    const first = commits.findIndex(c => c.status === 'fulfilled'), next = 1 - first;
    await expect(writers[next](jobs[next], t, stores[next])).rejects.toThrow('awaiting confirmation');
    const restart = tombstoneRegistry(env), confirmation = await restart(jobs[first], t, stores[first]);
    await stores[first].batch(confirmation.writes!);
    for (let n = 0; n < 2; n++) { const r = await writers[next](jobs[next], t, stores[next]); await stores[next].batch(r.writes!); }
    expect((await readTombstones(env, identity)).map(e => e.job)).toEqual([jobs[first], jobs[next]]);
  } finally { vi.unstubAllGlobals(); for (const store of stores) await store.db.destroy(); await mf?.dispose(); await rm(dir, { recursive: true, force: true }); }
}, 30000);
