import { afterEach, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { Decrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import { createSqliteStore } from '../src/core/store/sqlite';
import { enqueueJob, runJobs } from '../src/core/jobs';
import { blindIndex } from '../src/core/crypto';
import { initTombstoneRegistry, readTombstones, seal, tombstoneRegistry } from '../src/core/offsite';
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
  expect(() => tombstoneRegistry({ B2_BUCKET: '' })).toThrow();
  expect(() => tombstoneRegistry({ ...b2Env })).toThrow('BACKUP_AGE_RECIPIENT');
  expect(() => tombstoneRegistry({ BACKUP_AGE_RECIPIENT: recipient, B2_BUCKET: 'b' })).toThrow('B2_ENDPOINT, B2_KEY_ID, B2_APP_KEY');
});

it('ends an erasure with a readable error when the register table is missing', async () => {
  const b2 = fakeB2(), f = await erasure();
  await initTombstoneRegistry(env);
  await sql`drop table erasure_registry`.execute(f.store.db);
  await runJobs(f.store, 'cron', { registry: () => tombstoneRegistry(env) });
  const [row] = (await sql<{ state: string; cursor: string | null; result: string }>`select state,cursor,result from jobs where id=${f.id}`.execute(f.store.db)).rows;
  console.log(JSON.stringify({ missingRegistry: row }));
  expect(row.state).toBe('dead');
  expect(JSON.parse(row.result)).toEqual({ error: 'erasure_registry_unavailable' });
  expect(await f.visible()).toBe(1); expect(b2.objects.size).toBe(2);
  await f.store.db.destroy();
});

it.each([{}, { ...b2Env }])('ends an accepted erasure when its register configuration becomes unavailable', async vars => {
  const f = await erasure();
  await runJobs(f.store, 'cron', { registry: () => tombstoneRegistry(vars) });
  expect((await sql`select state,result from jobs where id=${f.id}`.execute(f.store.db)).rows)
    .toEqual([{ state: 'dead', result: JSON.stringify({ error: 'erasure_registry_unavailable' }) }]);
  expect(await f.visible()).toBe(1); await f.store.db.destroy();
});

it('writes the encrypted register before the erasure deletes anything and retries it until B2 accepts', async () => {
  const b2 = fakeB2(), { store, id, scope, visible } = await erasure(), registry = () => tombstoneRegistry(env);
  await initTombstoneRegistry(env); b2.down = true;
  let t = Date.now();
  await runJobs(store, 'request', { registry, now: () => t });
  // B2 refused: the message is untouched and the job waits for its retry.
  expect(await visible()).toBe(1); expect(b2.objects.size).toBe(2);
  expect((await sql<{ state: string; cursor: string | null }>`select state,cursor from jobs`.execute(store.db)).rows).toEqual([{ state: 'pending', cursor: null }]);
  b2.down = false; t += 61000;
  await runJobs(store, 'request', { registry, now: () => t });
  expect((await sql`select * from messages`.execute(store.db)).rows).toHaveLength(0);
  expect([...b2.objects.keys()]).toEqual(['staging-tombstones/genesis', 'staging-tombstones/head', 'staging-tombstones/1.age']);
  const d = new Decrypter(); d.addIdentity(identity);
  expect(JSON.parse(await d.decrypt(b2.objects.get('staging-tombstones/1.age')!, 'text'))).toMatchObject({ job: id, tombstones: [{ ...scope.indices[0], at: scope.at, brands: ['acme'], templates: '*' }] });
  await store.db.destroy();
});

it('erases with an explicit development mode, and a partial configuration holds the erasure', async () => {
  const off = await erasure();
  await runJobs(off.store, 'request', { registry: () => tombstoneRegistry({ MAILSTACK_DEV_ERASE_WITHOUT_REGISTRY: 'true' }) });
  expect(await off.visible()).toBe(0);
  const partial = await erasure();
  await runJobs(partial.store, 'request', { registry: () => tombstoneRegistry({ ...b2Env }) });
  expect(await partial.visible()).toBe(1);
  await off.store.db.destroy(); await partial.store.db.destroy();
});

it('reads every page of the register and refuses what it cannot account for', async () => {
  const b2 = fakeB2({ page: 2 }), write = tombstoneRegistry(env)!, entry = (at: number) => [{ kid: 'i1', index: 'a'.repeat(22), at, brands: '*' as const, templates: '*' as const }];
  await initTombstoneRegistry(env);
  const store = createSqliteStore(':memory:'); await store.migrate();
  for (const n of [1, 2, 3]) for (let i = 0; i < 2; i++) { const r = await write(job(n), entry(n * 1000), store); if (r.writes) await store.batch(r.writes); }
  await store.db.destroy();
  expect((await readTombstones(env, identity)).map(e => e.job)).toEqual([job(1), job(2), job(3)]);
  await expect(readTombstones(env, await generateIdentity())).rejects.toThrow('no identity matched');
  const original = b2.objects.get('staging-tombstones/3.age')!;
  b2.objects.set('staging-tombstones/3.age', await seal(recipient, JSON.stringify({ job: job(5), tombstones: entry(4000) })));
  await expect(readTombstones(env, identity)).rejects.toThrow('Invalid erasure register entry staging-tombstones/3.age');
  b2.objects.set('staging-tombstones/3.age', new Uint8Array([1, 2, 3]));
  await expect(readTombstones(env, identity)).rejects.toThrow();
  b2.objects.set('staging-tombstones/3.age', original); b2.objects.set('staging-tombstones/notes.txt', new Uint8Array());
  await expect(readTombstones(env, identity)).rejects.toThrow('Incomplete erasure register');
  b2.down = true;
  await expect(readTombstones(env, identity)).rejects.toThrow('HTTP 503');
});

it('refuses a truncated listing without a continuation token', async () => {
  fakeB2(); await initTombstoneRegistry(env); const get = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => new URL(input instanceof Request ? input.url : String(input)).search ? new Response('<ListBucketResult><Contents><Key>tombstones/x</Key></Contents><IsTruncated>true</IsTruncated></ListBucketResult>') : get(input, init));
  await expect(readTombstones(env, identity)).rejects.toThrow('truncated');
});

it.each(['entry', 'head'] as const)('retries identical bytes after the %s acknowledgement is lost', async lost => {
  const b2 = fakeB2(), f = await erasure(); await initTombstoneRegistry(env);
  const get = globalThis.fetch; let failed = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init), response = await get(req);
    if (!failed && req.method === 'PUT' && req.url.endsWith(lost === 'entry' ? '/1.age' : '/head')) { failed = true; throw new Error('ACK lost'); }
    return response;
  });
  let t = Date.now(); const registry = () => tombstoneRegistry(env);
  await runJobs(f.store, 'request', { registry, now: () => t });
  const ciphertext = b2.objects.get('staging-tombstones/1.age')!.slice();
  expect(await f.visible()).toBe(1); expect(failed).toBe(true);
  if (lost === 'head') await expect(tombstoneRegistry(env)(job(99), (await readTombstones(env, identity))[0].tombstones, f.store)).rejects.toThrow('awaiting confirmation');
  t += 61000; await runJobs(f.store, 'request', { registry, now: () => t });
  expect(await f.visible()).toBe(0); expect(b2.objects.get('staging-tombstones/1.age')).toEqual(ciphertext);
  expect((await readTombstones(env, identity)).map(e => e.job)).toEqual([f.id]);
  await f.store.db.destroy();
});

it.each(['genesis', 'head', '1.age', 'identity', 'gap', 'hash', 'tail', 'prev', 'seq', 'entryIdentity'] as const)('requires the complete register: %s', async missing => {
  const b2 = fakeB2(), f = await erasure(); await initTombstoneRegistry(env);
  await runJobs(f.store, 'request', { registry: () => tombstoneRegistry(env) });
  if (missing === 'identity') await expect(readTombstones({ ...env, TOMBSTONE_REGISTRY_ID: 'another-register-001' }, identity)).rejects.toThrow();
  else {
    if (['prev', 'seq', 'entryIdentity'].includes(missing)) {
      const d = new Decrypter(); d.addIdentity(identity); const entry = JSON.parse(await d.decrypt(b2.objects.get('staging-tombstones/1.age')!, 'text'));
      Object.assign(entry, missing === 'prev' ? { prev: '0'.repeat(64) } : missing === 'seq' ? { seq: 2 } : { registry: 'another-register-001' });
      const sealed = await seal(recipient, JSON.stringify(entry)); b2.objects.set('staging-tombstones/1.age', sealed);
      const h = JSON.parse(new TextDecoder().decode(b2.objects.get('staging-tombstones/head'))); h.hash = Buffer.from(await crypto.subtle.digest('SHA-256', sealed)).toString('hex');
      b2.objects.set('staging-tombstones/head', new TextEncoder().encode(JSON.stringify(h)));
    } else if (missing === 'gap') { b2.objects.set('staging-tombstones/2.age', b2.objects.get('staging-tombstones/1.age')!); b2.objects.delete('staging-tombstones/1.age'); }
    else if (missing === 'hash' || missing === 'tail') {
      const h = JSON.parse(new TextDecoder().decode(b2.objects.get('staging-tombstones/head')));
      b2.objects.set('staging-tombstones/head', new TextEncoder().encode(JSON.stringify({ ...h, ...missing === 'hash' ? { hash: '0'.repeat(64) } : { seq: 0 } })));
    } else b2.objects.delete('staging-tombstones/' + missing);
    await expect(readTombstones(env, identity)).rejects.toThrow();
  }
  await f.store.db.destroy();
});

it('requires installation before writing, and does not replace an existing genesis', async () => {
  const b2 = fakeB2(), f = await erasure();
  await runJobs(f.store, 'request', { registry: () => tombstoneRegistry(env) });
  expect(await f.visible()).toBe(1); expect(b2.objects.size).toBe(0);
  await initTombstoneRegistry(env); expect(await readTombstones(env, identity)).toEqual([]);
  await expect(initTombstoneRegistry({ ...env, TOMBSTONE_REGISTRY_ID: 'another-register-01' })).rejects.toThrow('not empty');
  b2.objects.delete('staging-tombstones/head'); await expect(readTombstones(env, identity)).rejects.toThrow(); await f.store.db.destroy();
});

it('keeps an erasure pending without a register hook', async () => {
  const f = await erasure(); await runJobs(f.store, 'request'); expect(await f.visible()).toBe(1); await f.store.db.destroy();
});

it('initialization completes after a lost response and refuses any other content in the prefix', async () => {
  const b2 = fakeB2();
  await initTombstoneRegistry(env);
  const puts = b2.puts;
  await initTombstoneRegistry(env);
  expect(b2.puts).toBe(puts);
  b2.objects.delete('staging-tombstones/head');
  await initTombstoneRegistry(env);
  expect(b2.objects.has('staging-tombstones/head')).toBe(true);
  await expect(initTombstoneRegistry({ ...env, TOMBSTONE_REGISTRY_ID: 'another-register-01' })).rejects.toThrow('not empty');
  b2.objects.set('staging-tombstones/head', new TextEncoder().encode(JSON.stringify({ registry: env.TOMBSTONE_REGISTRY_ID, seq: 1, hash: 'a'.repeat(64) })));
  await expect(initTombstoneRegistry(env)).rejects.toThrow('not empty');
  b2.objects.delete('staging-tombstones/head');
  b2.objects.set('staging-tombstones/1.age', new Uint8Array([1]));
  await expect(initTombstoneRegistry(env)).rejects.toThrow('not empty');
});
