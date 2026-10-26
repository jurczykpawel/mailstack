import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'kysely';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import { loadExtensions } from '../src/runtime/extensions';
import { signPanelAssertion, type PanelClaims } from '../src/core/panel';
import { tokenSha256 } from '../src/clients';
import { blindIndex, refIndex } from '../src/core/crypto';
import { parseConfig } from '../src/core/config/schema';
import { recordEvents } from '../src/core/store/events';
import { handleSesEvent } from '../src/events/ses';
import { notification, options as snsOptions, request as snsRequest } from './sns-fixture';
import { createApp } from '../src/index';
import type { Env } from '../src/types';
import example from '../config/mailstack.example.json';

interface Payload { messages: { id: string; [key: string]: unknown }[]; cursor: string | null; recipients: { addr_sealed: string }[]; events: Record<string, unknown>[]; replay: unknown; rows: { seq: number }[]; count: number }
const token = 'msk_panel_' + 'a'.repeat(43), now = Date.now();
const key = Buffer.alloc(32, 7).toString('base64url');
const indices = [{ kid: 'new', key }, { kid: 'old', key: Buffer.alloc(32, 8).toString('base64url') }];
const env = { PANEL_ASSERTION_KEY: key, INDEX_KEYS: JSON.stringify(indices) };
const contentKeys = [{ ...generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }), kid: 'c1', kty: 'OKP', crv: 'X25519' }];
const claims: PanelClaims = { actor: 'user-1', role: 'admin', issuedAt: now, expiresAt: now + 60000, stepUpAt: now };
for (const driver of ['sqlite', 'd1'] as const) describe(`internal: ${driver}`, () => {
  let store: KyselyStore, mf: Miniflare | undefined;
  let runtime: Awaited<ReturnType<typeof loadExtensions>>;
  let cfg: ReturnType<typeof parseConfig>;
  const rows = async (table: string) => (await sql<Record<string, unknown>>`select * from ${sql.table(table)}`.execute(store.db)).rows;
  const call = async (path = '/messages', options: { body?: unknown; claims?: Partial<PanelClaims>; headers?: Record<string, string | undefined>; method?: string } = {}) => {
    const req = new Request('http://localhost/internal/v1' + path, { method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: { authorization: `Bearer ${token}`, 'x-panel-actor': 'user-1' }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    req.headers.set('x-panel-assertion', await signPanelAssertion(req, { ...claims, ...options.claims }, key));
    for (const [k, v] of Object.entries(options.headers ?? {})) if (v !== undefined) req.headers.set(k, v);
    return await runtime.fetch(req, env) as Omit<Response, 'json'> & { json(): Promise<Payload> };
  };
  async function seed(id = 'msg_1', brand = 'acme', template = 'notice', role = 'recipient', idxKey = indices[0], expiry = now + 1000000) {
    const idx = await blindIndex('one@example.com', idxKey), ref = await refIndex('order-1', idxKey);
    await sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,sent_at,meta_expires_at,content_expires_at,provider_response_sealed,subject_sealed,ref_idx,ref_sealed,replay_mac,request_mac)
      values(${id},'demo',${brand},${template},'full','hash','sent',${now},${now},${expiry},${expiry},'sealed-provider','sealed-subject',${ref.index},'sealed-ref','private-mac','private-request')`.execute(store.db);
    await sql`insert into recipients values(${id},0,'to',${idx.index},${idx.kid},'sealed-address','hint','sent',null)`.execute(store.db);
    await sql`insert into subjects values(${id},${role},${idx.index},${idx.kid})`.execute(store.db);
    for (const table of ['contents', 'replays']) await sql`insert into ${sql.table(table)} values(${id},${'sealed-' + table},${expiry})`.execute(store.db);
    await sql`insert into events(id,message_id,source,source_event_id,type,occurred_at,received_at,auth,summary,evidence_sealed)
      values(${id},${id},'local',${id},'sent',${now},${now},'local','summary','sealed-evidence')`.execute(store.db);
  }
  beforeAll(async () => {
    if (driver === 'sqlite') store = createSqliteStore(':memory:');
    else { mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-06-01', d1Databases: ['DB'] })); store = createD1Store(await mf.getD1Database('DB')); }
    await store.migrate();
  });
  beforeEach(async () => {
    for (const table of ['audit', 'events', 'recipients', 'subjects', 'contents', 'replays', 'messages']) await sql`delete from ${sql.table(table)}`.execute(store.db);
    cfg = parseConfig({ ...example, clients: [{ id: 'panel', tokenSha256: await tokenSha256(token), scopes: ['panel'], brands: '*', templates: '*' }] });
    runtime = await loadExtensions(cfg, store);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await store.db.destroy(); await mf?.dispose(); });
  it('requires credentials, panel scope and a current operation assertion', async () => {
    expect((await call('/messages', { headers: { authorization: '' } })).status).toBe(401);
    expect((await call('/messages', { headers: { authorization: 'Bearer invalid' } })).status).toBe(401);
    cfg.clients![0].scopes = ['webhooks:write'];
    expect((await call()).status).toBe(403); cfg.clients![0].scopes = ['panel'];
    for (const options of [{ headers: { 'x-panel-assertion': '' } }, { headers: { 'x-panel-actor': 'user-2' } },
      { claims: { expiresAt: now - 1 } }, { claims: { issuedAt: now + 100000 } }, { claims: { expiresAt: now + 60001 } },
      { claims: { role: 'other' as PanelClaims['role'] } }]) expect((await call('/messages', options)).status).toBe(403);
    const req = new Request('http://localhost/internal/v1/messages', { headers: { authorization: `Bearer ${token}`, 'x-panel-actor': 'user-1' } });
    req.headers.set('x-panel-assertion', await signPanelAssertion(req, claims, key));
    expect((await runtime.fetch(new Request('http://localhost/internal/v1/audit', req), env)).status).toBe(403);
    expect((await runtime.fetch(req, {})).status).toBe(403);
    expect((await createApp().fetch(req, {} as Env, {} as ExecutionContext)).status).toBe(404);
  });
  it('lists stable pages, filters and returns only the list projection', async () => {
    for (let i = 0; i < 5; i++) await seed(`msg_${i}`);
    let cursor: string | null = '', ids: string[] = [];
    do {
      const response = await call('/messages?limit=2' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      expect(response.status).toBe(200);
      const page = await response.json();
      ids.push(...page.messages.map((m: { id: string }) => m.id)); cursor = page.cursor;
      expect(Object.keys(page.messages[0]).sort()).toEqual(['addr_hints', 'brand', 'created_at', 'id', 'level', 'sent_at', 'status', 'subject_sealed', 'template']);
    } while (cursor);
    expect(ids).toEqual(['msg_4', 'msg_3', 'msg_2', 'msg_1', 'msg_0']);
    for (const query of ['brand=demo', 'template=payment', 'status=unknown', `from=${now + 1}`, `to=${now - 1}`]) expect((await (await call('/messages?' + query)).json()).messages).toEqual([]);
    expect((await (await call(`/messages?brand=acme&template=notice&status=sent&from=${now}&to=${now}`)).json()).messages).toHaveLength(5);
    for (const query of ['limit=101', 'limit=0', 'limit=1.5', 'cursor=bad', 'from=bad', 'from=2&to=1']) expect((await call('/messages?' + query)).status).toBe(400);
  });
  it.each(['/audit', '/subjects/export', '/subjects/erase'])('rejects oversized streamed bodies promptly without writes: %s', async path => {
    await seed();
    const url = 'http://localhost/internal/v1' + path;
    const headers = { authorization: `Bearer ${token}`, 'x-panel-actor': 'user-1' };
    const assertion = await signPanelAssertion(new Request(url, { method: 'POST', headers, body: '{}' }), claims, key);
    const req = new Request(url, { method: 'POST', headers: { ...headers, 'x-panel-assertion': assertion }, body: 'x'.repeat(65537) });
    expect(req.headers.has('content-length')).toBe(false);
    const batch = vi.spyOn(store, 'batch');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([runtime.fetch(req, env), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Internal response deadline exceeded')), 1000);
      })]);
      expect(response.status).toBe(403);
      expect(batch).not.toHaveBeenCalled();
      expect(await rows('audit')).toEqual([]);
      for (const table of ['messages', 'recipients', 'subjects', 'contents', 'replays', 'events']) expect(await rows(table)).toHaveLength(1);
    } finally {
      clearTimeout(timer);
      await req.body?.cancel();
    }
  });
  it('searches every active index key and keeps search inputs out of audit', async () => {
    await seed('msg_new'); await seed('msg_old', 'acme', 'notice', 'recipient', indices[1]);
    for (const query of ['rcpt=one%40example.com', 'ref=order-1']) {
      const response = await call('/messages?' + query);
      expect((await response.json()).messages).toHaveLength(2);
    }
    expect(JSON.stringify(await rows('audit'))).not.toContain('one@example.com');
    expect(JSON.stringify(await rows('audit'))).not.toContain('order-1');
  });
  it('returns detail, timeline, content, evidence and resend source as sealed values', async () => {
    await seed();
    const detail = await (await call('/messages/msg_1')).json();
    expect(detail.recipients[0].addr_sealed).toBe('sealed-address');
    expect(detail.events[0]).toMatchObject({ type: 'sent', source: 'local', auth: 'local', summary: 'summary' });
    expect(JSON.stringify(detail)).not.toContain('private-mac'); expect(JSON.stringify(detail)).not.toContain('sealed-evidence');
    expect(await (await call('/messages/msg_1/content')).json()).toMatchObject({ level: 'full', sealed: 'sealed-contents' });
    expect(await (await call('/messages/msg_1/evidence')).json()).toMatchObject({ events: [{ evidence_sealed: 'sealed-evidence' }] });
    const source = await (await call('/messages/msg_1/resend-source')).json();
    expect(source).toMatchObject({ ref_sealed: 'sealed-ref', replay: { sealed: 'sealed-replays' } });
    expect(JSON.stringify(source)).not.toContain('private-');
    expect((await rows('audit')).map(r => r.action)).toEqual(['log.read', 'content.read', 'evidence.export', 'resend.source']);
    const exported = await (await call('/subjects/export', { body: { email: 'one@example.com' } })).json();
    expect(exported.messages[0].evidence).toMatchObject({ provider_response_sealed: 'sealed-provider', events: [{ evidence_sealed: 'sealed-evidence' }] });
  });
  it('enforces the role matrix and recent step-up', async () => {
    await seed();
    for (const role of ['viewer', 'operator', 'admin'] as const) {
      expect((await call('/messages', { claims: { role, stepUpAt: null } })).status).toBe(200);
      expect((await call('/messages/msg_1', { claims: { role, stepUpAt: null } })).status).toBe(200);
      for (const route of ['content', 'evidence', 'resend-source']) {
        expect((await call('/messages/msg_1/' + route, { claims: { role } })).status).toBe(role === 'viewer' ? 403 : 200);
        expect((await call('/messages/msg_1/' + route, { claims: { role, stepUpAt: now - 300001 } })).status).toBe(403);
      }
      expect((await call('/subjects/export', { body: { email: 'one@example.com' }, claims: { role } })).status).toBe(role === 'admin' ? 200 : 403);
    }
  });
  it('scopes every message path and subject operation by brand and template', async () => {
    await seed('allowed'); await seed('other-brand', 'demo'); await seed('other-template', 'acme', 'payment');
    cfg.clients![0].brands = ['acme']; cfg.clients![0].templates = ['notice'];
    expect((await (await call()).json()).messages.map((m: { id: string }) => m.id)).toEqual(['allowed']);
    for (const id of ['other-brand', 'other-template']) for (const suffix of ['', '/content', '/evidence', '/resend-source']) expect((await call('/messages/' + id + suffix)).status).toBe(404);
    expect((await (await call('/subjects/export', { body: { email: 'one@example.com' } })).json()).messages.map((m: { id: string }) => m.id)).toEqual(['allowed']);
    expect((await call('/audit')).status).toBe(403); expect((await call('/audit/head')).status).toBe(403);
    expect((await call('/audit', { body: { action: 'panel.login' } })).status).toBe(403);
    expect((await (await call('/subjects/erase', { body: { email: 'one@example.com', reason: 'Requested by subject' } })).json()).count).toBe(1);
    expect((await rows('messages')).map(r => r.id).sort()).toEqual(['other-brand', 'other-template']);
  });
  it('refuses missing records and expired metadata and blobs before purge', async () => {
    for (const suffix of ['', '/content', '/evidence', '/resend-source']) expect((await call('/messages/missing' + suffix)).status).toBe(404);
    await seed('expired', 'acme', 'notice', 'recipient', indices[0], now - 1);
    expect((await (await call()).json()).messages).toEqual([]);
    for (const suffix of ['', '/content', '/evidence', '/resend-source']) expect((await call('/messages/expired' + suffix)).status).toBe(404);
    await seed();
    for (const table of ['contents', 'replays']) await sql`update ${sql.table(table)} set expires_at=${now - 1}`.execute(store.db);
    await sql`update messages set content_expires_at=${now - 1}`.execute(store.db);
    for (const suffix of ['/content', '/evidence']) expect((await call('/messages/msg_1' + suffix)).status).toBe(404);
    expect((await (await call('/messages/msg_1/resend-source')).json()).replay).toBeNull();
    const exported = JSON.stringify(await (await call('/subjects/export', { body: { email: 'one@example.com' } })).json());
    for (const value of ['sealed-contents', 'sealed-replays', 'sealed-provider', 'sealed-evidence']) expect(exported).not.toContain(value);
  });
  it.each(['/messages', '/messages?rcpt=one%40example.com', '/messages?ref=order-1', '/messages/msg_1', '/messages/msg_1/content', '/messages/msg_1/evidence', '/messages/msg_1/resend-source', '/subjects/export', '/subjects/erase', '/audit'])('requires audit completion before returning data or changing rows: %s', async path => {
    await seed();
    const original = store.batch.bind(store);
    vi.spyOn(store, 'batch').mockImplementation(queries => { if (queries.some(q => q.sql.includes('insert into audit'))) throw new Error('unavailable'); return original(queries); });
    const body = path.startsWith('/subjects') ? { email: 'one@example.com', reason: 'Requested by subject' } : path === '/audit' ? { action: 'panel.login' } : undefined;
    const response = await call(path, { body });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('sealed-');
    expect(await rows('messages')).toHaveLength(1);
  });
  it('exports all subject roles and erases children in bounded atomic batches', async () => {
    for (const [i, role] of ['recipient', 'reply_to', 'submitter'].entries()) await seed('msg_' + i, 'acme', 'notice', role, indices[i % 2]);
    expect((await (await call('/subjects/export', { body: { email: 'one@example.com' } })).json()).messages).toHaveLength(3);
    const response = await call('/subjects/erase', { body: { email: 'one@example.com', reason: 'Requested by subject' } });
    expect(await response.json()).toEqual({ count: 3 });
    for (const table of ['messages', 'recipients', 'subjects', 'contents', 'replays', 'events']) expect(await rows(table)).toEqual([]);
    expect(await recordEvents(store, [{ id: 'late', message_id: 'msg_0', recipient_pos: 0, source: 'ses-sns', source_event_id: 'late', type: 'delivered', occurred_at: now, received_at: now, auth: 'sns-sig-v2', summary: 'ok', evidence_sealed: 'sealed' }])).toBe(false);
    expect(await rows('events')).toEqual([]);
    const sns = { Type: 'Notification', MessageId: 'late-sns', Message: JSON.stringify(notification()), TopicArn: snsOptions.topicArns[0], Timestamp: new Date().toISOString(), SignatureVersion: '2', Signature: 'test', SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/cert.pem' };
    expect((await handleSesEvent(snsRequest(sns), { options: snsOptions, store, verify: async () => true, contentKeys, indexKeys: indices, now: Date.now })).status).toBe(200);
    expect(await rows('events')).toEqual([]);
    const audit = JSON.stringify(await rows('audit')); expect(audit).not.toContain('one@example.com'); expect(audit).not.toContain('Requested by subject');
  });
  it.each(['accepted', 'rejected'] as const)('completes %s SMTP results after subject erasure', async outcome => {
    await seed();
    await sql`update messages set status='sending' where id='msg_1'`.execute(store.db);
    expect(await (await call('/subjects/erase', { body: { email: 'one@example.com', reason: 'Requested by subject' } })).json()).toEqual({ count: 1 });
    await store.markSent('msg_1', { providerMessageId: 'smtp-1', providerResponseSealed: 'sealed-response', sentAt: now,
      smtp: { accepted: outcome === 'accepted' ? [0] : [], rejected: outcome === 'rejected' ? [0] : [], evidence: 'sealed-smtp' } });
    for (const table of ['messages', 'recipients', 'subjects', 'contents', 'replays', 'events']) expect(await rows(table)).toEqual([]);
  });
  it('records the matched count and processes more than one erase batch', async () => {
    const idx = await blindIndex('one@example.com', indices[0]);
    for (let offset = 0; offset < 105; offset += 15) {
      const statements = [];
      for (let i = offset; i < Math.min(offset + 15, 105); i++) {
        const id = 'bulk_' + i;
        statements.push(sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at) values(${id},'demo','acme','notice','meta','hash','sent',${now},${now + 1000000})`);
        statements.push(sql`insert into subjects values(${id},'submitter',${idx.index},${idx.kid})`);
        for (const table of ['contents', 'replays']) statements.push(sql`insert into ${sql.table(table)} values(${id},'sealed',${now + 1000000})`);
      }
      await store.batch(statements.map(q => q.compile(store.db)));
    }
    const page = await (await call('/messages?limit=100')).json(); expect(page.messages).toHaveLength(100); expect(page.cursor).toBeTypeOf('string');
    const executor = store.db.getExecutor(), execute = executor.executeQuery.bind(executor);
    let active = 0, peak = 0;
    const messageReads: string[] = [];
    vi.spyOn(executor, 'executeQuery').mockImplementation(async (...args) => {
      active++; peak = Math.max(peak, active);
      if (args[0].sql.startsWith('select m.* from messages')) messageReads.push(args[0].sql);
      try { return await execute(...args); } finally { active--; }
    });
    let cursor: string | null = null;
    const exported: string[] = [];
    do {
      const page = await (await call('/subjects/export', { body: { email: 'one@example.com', limit: 20, cursor } })).json();
      expect(page.messages.length).toBeLessThanOrEqual(20);
      exported.push(...page.messages.map(m => m.id)); cursor = page.cursor;
    } while (cursor);
    expect(exported).toEqual(Array.from({ length: 105 }, (_, i) => 'bulk_' + i).sort());
    expect(new Set(exported).size).toBe(105);
    expect(peak).toBe(1);
    expect(messageReads).toHaveLength(6);
    expect(messageReads.every(query => /limit/.test(query))).toBe(true);
    for (const body of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { cursor: 1 }, { cursor: 'invalid!' }]) {
      expect((await call('/subjects/export', { body: { email: 'one@example.com', ...body } })).status).toBe(400);
    }
    const response = await call('/subjects/erase', { body: { email: 'one@example.com', reason: 'Requested by subject' } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ count: 105 });
    for (const table of ['messages', 'subjects', 'contents', 'replays']) expect(await rows(table)).toEqual([]);
    expect(JSON.parse(String((await rows('audit')).find(row => row.action === 'privacy.erase')!.details))).toEqual({ count: 105 });
  });
  it('binds signed assertions to body and query and checks the signature', async () => {
    const req = new Request('http://localhost/internal/v1/subjects/erase', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-panel-actor': 'user-1' }, body: JSON.stringify({ email: 'one@example.com', reason: 'Requested by subject' }) });
    const assertion = await signPanelAssertion(req, claims, key); req.headers.set('x-panel-assertion', assertion);
    const changed = new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify({ email: 'two@example.com', reason: 'Requested by subject' }) });
    expect((await runtime.fetch(changed, env)).status).toBe(403);
    const parsed = JSON.parse(atob(assertion)); parsed.payload.actor = 'user-2'; req.headers.set('x-panel-actor', 'user-2');
    req.headers.set('x-panel-assertion', btoa(JSON.stringify(parsed)));
    expect((await runtime.fetch(req, env)).status).toBe(403);
    const get = new Request('http://localhost/internal/v1/messages?brand=acme', { headers: { authorization: `Bearer ${token}`, 'x-panel-actor': 'user-1' } });
    get.headers.set('x-panel-assertion', await signPanelAssertion(get, claims, key));
    expect((await runtime.fetch(new Request('http://localhost/internal/v1/messages?brand=demo', get), env)).status).toBe(403);
  });
  it('accepts bounded audit context and applies roles to panel changes', async () => {
    expect((await call('/audit', { body: { action: 'panel.integrity.alarm', details: { seq: 1, hash: 'a'.repeat(64) } } })).status).toBe(200);
    expect((await call('/audit', { body: { action: 'panel.role.changed', target: 'user:demo', details: { role: 'viewer' } } })).status).toBe(200);
    expect((await call('/audit', { body: { action: 'panel.role.changed' }, claims: { role: 'viewer' } })).status).toBe(403);
    expect((await call('/audit', { body: { action: 'panel.role.changed' }, claims: { stepUpAt: null } })).status).toBe(403);
    for (const details of [{ count: -1 }, { seq: 'value' }, { hash: 'value' }, { role: 'unknown' }, { role: ['viewer'] }, { ref: 'order-1' }]) expect((await call('/audit', { body: { action: 'panel.login', details } })).status).toBe(400);
  });
  it('treats empty client selections as no access', async () => {
    await seed('empty', '', '');
    cfg.clients![0].brands = []; cfg.clients![0].templates = [];
    expect((await (await call()).json()).messages).toEqual([]);
    expect((await call('/messages/empty')).status).toBe(404);
    expect((await (await call('/subjects/erase', { body: { email: 'one@example.com', reason: 'Requested by subject' } })).json()).count).toBe(0);
    expect(await rows('messages')).toHaveLength(1);
  });
  it('returns an ordered audit suffix, head and bounded panel-originated entries', async () => {
    expect(await (await call('/audit/head')).json()).toEqual({ seq: 0, hash: '0'.repeat(64) });
    for (const action of ['panel.login', 'panel.logout']) expect((await call('/audit', { body: { action } })).status).toBe(200);
    const audit = await (await call('/audit?after_seq=1&limit=1')).json(); expect(audit.rows.map((r: { seq: number }) => r.seq)).toEqual([2]);
    expect(await (await call('/audit/head')).json()).toMatchObject({ seq: 2 });
    for (const path of ['/audit?after_seq=-1', '/audit?limit=501']) expect((await call(path)).status).toBe(400);
    for (const body of [{ action: ['panel.login'] }, { action: 'privacy.erase' }, { action: 'panel.login', details: { email: 'one@example.com' } }, { action: 'panel.login', target: 'one@example.com' }]) expect((await call('/audit', { body })).status).toBe(400);
  });
});
