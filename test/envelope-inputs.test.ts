import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createSqliteStore } from '../src/core/store/sqlite';
import type { KyselyStore } from '../src/core/store';
import { internalFetch } from '../src/core/internal';
import { blindIndex, refIndex } from '../src/core/crypto';
import { parseConfig } from '../src/core/config/schema';
import { panelClaims, panelEnv } from './fixtures/panel';
import { seal, transitEnv } from './fixtures/transit';
import type { PanelPrincipal } from '../src/core/panel';
import type { TransitOp } from '../src/core/transit';
import example from '../config/mailstack.example.json';

vi.setConfig({ testTimeout: 30000 });
const indexKey = { kid: 'k1', key: Buffer.alloc(32, 7).toString('base64url') };
const env = { MAILSTACK_DEV_ERASE_WITHOUT_REGISTRY: 'true', ...panelEnv, ...transitEnv, INDEX_KEYS: JSON.stringify([indexKey]) };
const far = Date.now() + 86400000, cfg = parseConfig(example);
const principal: PanelPrincipal = { ...panelClaims(), scopes: ['panel'], brands: '*', templates: '*' };
const host = { platform: 'node' as const, extensions: async () => ({ features: () => [], resendSource: undefined }) };

describe('envelope inputs', () => {
  let store: KyselyStore;
  const api = (path: string, body?: unknown, e: object = env) => internalFetch(new Request('http://localhost/internal/v2' + path,
    body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), e, store, cfg, principal, host);
  const ids = async (response: Response) => ((await response.json()) as { messages: { id: string }[] }).messages.map(m => m.id).sort();
  const count = async (table: string) => Number((await sql<{ n: number }>`select count(*) n from ${sql.table(table)}`.execute(store.db)).rows[0].n);
  async function seed(id: string, email: string, ref: string) {
    const idx = await blindIndex(email, indexKey), r = await refIndex(ref, indexKey);
    await sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at,content_expires_at,ref_idx)
      values(${id},'demo','acme','notice','full','hash','sent',${Date.now() - 1000},${far},${far},${r.index})`.execute(store.db);
    await sql`insert into subjects values(${id},'recipient',${idx.index},${idx.kid})`.execute(store.db);
    await sql`insert into recipients values(${id},0,'to',${idx.index},${idx.kid},'sealed','hint','sent',null)`.execute(store.db);
  }
  beforeAll(async () => { store = createSqliteStore(':memory:'); await store.migrate(); });
  beforeEach(async () => {
    for (const table of ['audit', 'recipients', 'subjects', 'messages', 'jobs', 'guards']) await sql`delete from ${sql.table(table)}`.execute(store.db);
    await seed('m1', 'one@example.com', 'order-1'); await seed('m2', 'two@example.com', 'order-2');
  });
  afterAll(async () => { await store.db.destroy(); });

  const request = {
    '/messages/search': (envelope: string) => ({ envelope }),
    '/subjects/export': (envelope: string) => ({ envelope }),
    '/subjects/erase': (envelope: string) => ({ envelope, reason: 'Requested by subject' }),
  } as const;
  const operation = { '/messages/search': 'log.search', '/subjects/export': 'subjects.export', '/subjects/erase': 'subjects.erase' } as const;
  const payload = { '/messages/search': { rcpt: 'one@example.com' }, '/subjects/export': { email: 'one@example.com' }, '/subjects/erase': { email: 'one@example.com' } } as const;
  const paths = Object.keys(request) as (keyof typeof request)[];

  it('search by address or ref through the envelope finds the same messages as the stored indices', async () => {
    const byRef = await ids(await api('/messages/search', { envelope: await seal({ ref: 'order-1' }, 'log.search') }));
    const stored = (await sql<{ id: string }>`select id from messages where ref_idx=${(await refIndex('order-1', indexKey)).index}`.execute(store.db)).rows.map(r => r.id);
    expect(byRef).toEqual(stored); expect(byRef).toEqual(['m1']);
    expect(await ids(await api('/messages/search', { envelope: await seal({ rcpt: 'two@example.com' }, 'log.search') }))).toEqual(['m2']);
    expect(JSON.stringify(await sql`select * from audit`.execute(store.db))).not.toMatch(/example\.com|order-/);
  });

  it.each(paths)('N: a plain-text value instead of the envelope is 400 and changes nothing: %s', async path => {
    const plain = path === '/messages/search' ? { rcpt: 'one@example.com' } : { email: 'one@example.com', reason: 'Requested by subject' };
    expect((await api(path, plain)).status).toBe(400);
    expect((await api(path, { ...request[path](await seal(payload[path], operation[path])), ...plain })).status).toBe(400);
    expect(await count('jobs')).toBe(0); expect(await count('audit')).toBe(0);
  });

  it('N: the address and ref can no longer be sent in the GET query', async () => {
    for (const query of ['rcpt=one%40example.com', 'ref=order-1']) expect((await api('/messages?' + query)).status).toBe(400);
  });

  it.each(paths)('N: an envelope for another operation or audience is 403 and creates no job: %s', async path => {
    const other = (['log.search', 'subjects.export', 'subjects.erase', 'resend.source'] as TransitOp[]).find(op => op !== operation[path])!;
    for (const envelope of [await seal(payload[path], other), await seal(payload[path], operation[path], 'another.api')]) {
      expect((await api(path, request[path](envelope))).status).toBe(403);
    }
    expect(await count('jobs')).toBe(0); expect(await count('audit')).toBe(0);
  });

  it.each(paths)('N: a repeated nonce is 409 and the second request does nothing: %s', async path => {
    const body = request[path](await seal(payload[path], operation[path]));
    expect((await api(path, body)).status).toBe(path === '/subjects/erase' ? 202 : 200);
    const audits = await count('audit'), jobs = await count('jobs');
    expect((await api(path, body)).status).toBe(409);
    expect(await count('audit')).toBe(audits); expect(await count('jobs')).toBe(jobs);
  });

  it.each(paths)('N: an expired or malformed envelope is 403 and a missing key set is 503: %s', async path => {
    expect((await api(path, request[path](await seal(payload[path], operation[path], panelEnv.PANEL_AUDIENCE, Date.now() - 6 * 60_000)))).status).toBe(403);
    expect((await api(path, request[path]('mt1.tk1.bad'))).status).toBe(403);
    expect((await api(path, request[path](await seal(payload[path], operation[path])), { ...env, TRANSIT_KEYS: undefined })).status).toBe(503);
    expect(await count('jobs')).toBe(0);
  });

  it('N: an envelope payload with extra or malformed fields is 400', async () => {
    for (const bad of [{ rcpt: 'one@example.com', ref: 'order-1' }, {}, { rcpt: 'one@example.com', email: 'x@example.com' }, { rcpt: 5 }]) {
      expect((await api('/messages/search', { envelope: await seal(bad, 'log.search') })).status).toBe(400);
    }
    expect((await api('/subjects/export', { envelope: await seal({ email: 'not-an-address' }, 'subjects.export') })).status).toBe(400);
  });
});
