import { afterEach, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { Decrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import { createSqliteStore } from '../src/core/store/sqlite';
import { enqueueJob, runJobs } from '../src/core/jobs';
import { blindIndex } from '../src/core/crypto';
import { readTombstones, seal, tombstoneRegistry } from '../src/core/offsite';
import { b2Env, fakeB2 } from './fixtures/fake-b2';

const identity = await generateIdentity(), recipient = await identityToRecipient(identity);
const env = { ...b2Env, BACKUP_AGE_RECIPIENT: recipient, TOMBSTONE_PREFIX: 'staging-tombstones/' };
const job = (n: number) => 'job_' + String(n).padStart(32, '0');
afterEach(() => vi.unstubAllGlobals());

async function erasure() {
  const store = createSqliteStore(':memory:'); await store.migrate();
  const idx = await blindIndex('one@example.com', { kid: 'i1', key: Buffer.alloc(32, 7).toString('base64url') }), now = Date.now();
  await sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at,content_expires_at) values('msg_one','demo','acme','notice','meta','h','sent',${now - 1000},${now + 86400000},${now + 86400000})`.execute(store.db);
  await sql`insert into subjects values('msg_one','recipient',${idx.index},${idx.kid})`.execute(store.db);
  const scope = { indices: [{ kid: idx.kid, index: idx.index }], brands: ['acme'], templates: '*' as const, at: now };
  const { id, query } = enqueueJob(store, 'erase', scope, now); await store.batch([query]);
  const visible = async () => (await sql<{ n: number }>`select count(*) n from messages where meta_expires_at > 0`.execute(store.db)).rows[0].n;
  return { store, id, scope, visible };
}

it('is off without register variables and refuses a partial set', () => {
  expect(tombstoneRegistry({ B2_BUCKET: '' })).toBeUndefined();
  expect(() => tombstoneRegistry({ ...b2Env })).toThrow('BACKUP_AGE_RECIPIENT');
  expect(() => tombstoneRegistry({ BACKUP_AGE_RECIPIENT: recipient, B2_BUCKET: 'b' })).toThrow('B2_ENDPOINT, B2_KEY_ID, B2_APP_KEY');
});

it('writes the encrypted register before the erasure deletes anything and retries it until B2 accepts', async () => {
  const b2 = fakeB2(), { store, id, scope, visible } = await erasure(), registry = () => tombstoneRegistry(env);
  b2.down = true;
  let t = Date.now();
  await runJobs(store, 'request', { registry, now: () => t });
  // B2 refused: the message is untouched and the job waits for its retry.
  expect(await visible()).toBe(1); expect(b2.objects.size).toBe(0);
  expect((await sql<{ state: string; cursor: string | null }>`select state,cursor from jobs`.execute(store.db)).rows).toEqual([{ state: 'pending', cursor: null }]);
  b2.down = false; t += 61000;
  await runJobs(store, 'request', { registry, now: () => t });
  expect((await sql`select * from messages`.execute(store.db)).rows).toHaveLength(0);
  expect([...b2.objects.keys()]).toEqual([`staging-tombstones/${id}.age`]);
  const d = new Decrypter(); d.addIdentity(identity);
  expect(JSON.parse(await d.decrypt(b2.objects.get(`staging-tombstones/${id}.age`)!, 'text'))).toEqual({ job: id, tombstones: [{ ...scope.indices[0], at: scope.at, brands: ['acme'], templates: '*' }] });
  await store.db.destroy();
});

it('erases without a register when none is configured, and a partial configuration holds the erasure', async () => {
  const off = await erasure();
  await runJobs(off.store, 'request', { registry: () => tombstoneRegistry({}) });
  expect(await off.visible()).toBe(0);
  const partial = await erasure();
  await runJobs(partial.store, 'request', { registry: () => tombstoneRegistry({ ...b2Env }) });
  expect(await partial.visible()).toBe(1);
  await off.store.db.destroy(); await partial.store.db.destroy();
});

it('reads every page of the register and refuses what it cannot account for', async () => {
  const b2 = fakeB2({ page: 2 }), write = tombstoneRegistry(env)!, entry = (at: number) => [{ kid: 'i1', index: 'a'.repeat(22), at, brands: '*' as const, templates: '*' as const }];
  for (const n of [1, 2, 3]) await write(job(n), entry(n * 1000));
  expect((await readTombstones(env, identity)).map(e => e.job)).toEqual([job(1), job(2), job(3)]);
  await expect(readTombstones(env, await generateIdentity())).rejects.toThrow('no identity matched');
  b2.objects.set(`staging-tombstones/${job(4)}.age`, await seal(recipient, JSON.stringify({ job: job(5), tombstones: entry(4000) })));
  await expect(readTombstones(env, identity)).rejects.toThrow(`Invalid erasure register entry staging-tombstones/${job(4)}.age`);
  b2.objects.set(`staging-tombstones/${job(4)}.age`, new Uint8Array([1, 2, 3]));
  await expect(readTombstones(env, identity)).rejects.toThrow();
  b2.objects.delete(`staging-tombstones/${job(4)}.age`); b2.objects.set('staging-tombstones/notes.txt', new Uint8Array());
  await expect(readTombstones(env, identity)).rejects.toThrow('Unexpected object staging-tombstones/notes.txt');
  b2.down = true;
  await expect(readTombstones(env, identity)).rejects.toThrow('HTTP 503');
});

it('refuses a truncated listing without a continuation token', async () => {
  vi.stubGlobal('fetch', async () => new Response('<ListBucketResult><Contents><Key>tombstones/x</Key></Contents><IsTruncated>true</IsTruncated></ListBucketResult>'));
  await expect(readTombstones({ ...b2Env }, identity)).rejects.toThrow('truncated');
});
