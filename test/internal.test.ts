import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keysOnly, testKeys } from './fixtures/keys';
import { accessEnv, accessKeyPair, certsFetch, publicJwk, signAccessJwt } from './fixtures/access';
import { createAccessVerifier } from '../src/core/access';

vi.setConfig({ testTimeout: 30000 });
import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'kysely';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import { loadExtensions } from '../src/runtime/extensions';
import { PANEL_PROTOCOL, type PanelClaims } from '../src/core/panel';
import { panelEnv, panelKey, signPanel } from './fixtures/panel';
import { createMac } from '../src/core/crypto';
import { tokenSha256 } from '../src/clients';
import { blindIndex, refIndex } from '../src/core/crypto';
import { parseConfig } from '../src/core/config/schema';
import { recordEvents } from '../src/core/store/events';
import { handleSesEvent } from '../src/events/ses';
import { notification, options as snsOptions, request as snsRequest } from './sns-fixture';
import { createApp } from '../src/index';
import { sealed, transitEnv } from './fixtures/transit';
import { tombstoneRegistry } from '../src/core/offsite';
import { runJobs as run } from '../src/core/jobs';
import type { Env } from '../src/types';
import example from '../config/mailstack.example.json';

interface Payload { messages: { id: string; [key: string]: unknown }[]; cursor: string | null; recipients: { addr_sealed: string }[]; events: Record<string, unknown>[]; replay: unknown; rows: { seq: number }[]; count: number }
const token = 'msk_panel_' + 'a'.repeat(43), now = Date.now();
const key = Buffer.alloc(32, 7).toString('base64url');
const indices = [{ kid: 'new', key }, { kid: 'old', key: Buffer.alloc(32, 8).toString('base64url') }];
const dev = { MAILSTACK_DEV_ERASE_WITHOUT_REGISTRY: 'true' };
const runJobs: typeof run = (store, trigger, options = {}) => run(store, trigger, { registry: () => tombstoneRegistry(dev), ...options });
const env = { ...dev, ...panelEnv, ...transitEnv, INDEX_KEYS: JSON.stringify(indices) };
const exp = async (extra: Record<string, unknown> = {}) => ({ ...extra, ...await sealed({ email: 'one@example.com' }, 'subjects.export') });
const era = async (reason = 'Requested by subject', email = 'one@example.com') => ({ reason, ...await sealed({ email }, 'subjects.erase') });
const contentKeys = [{ ...generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }), kid: 'c1', kty: 'OKP', crv: 'X25519' }];
const claims: PanelClaims = { actor: 'user-1', role: 'admin', issuedAt: now, expiresAt: now + 60000, stepUpAt: now };
for (const driver of ['sqlite', 'd1'] as const) describe(`internal: ${driver}`, () => {
  let store: KyselyStore, mf: Miniflare | undefined;
  let runtime: Awaited<ReturnType<typeof loadExtensions>>;
  let cfg: ReturnType<typeof parseConfig>;
  const rows = async (table: string) => (await sql<Record<string, unknown>>`select * from ${sql.table(table)}`.execute(store.db)).rows;
  const call = async (path = '/messages', options: { body?: unknown; claims?: Partial<PanelClaims>; headers?: Record<string, string | undefined>; method?: string } = {}) => {
    const req = await signPanel(new Request('http://localhost/internal/v2' + path, { method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      body: options.body === undefined ? undefined : JSON.stringify(options.body) }), token, { ...claims, ...options.claims });
    for (const [k, v] of Object.entries(options.headers ?? {})) if (v !== undefined) req.headers.set(k, v);
    return await runtime.fetch(req, env) as Omit<Response, 'json'> & { json(): Promise<Payload> };
  };
  // Erasure is accepted as a job (202); one drain finishes these small sets, so the job result is the outcome.
  const erase = async (claimsOverride: Partial<PanelClaims> = {}) => {
    const response = await call('/subjects/erase', { body: await era(), claims: claimsOverride });
    expect(response.status).toBe(202);
    const { jobId } = await response.json() as unknown as { jobId: string };
    await runJobs(store, 'request', { beforeDelete: runtime.beforeDelete });
    const [job] = (await sql<{ state: string; result: string }>`select state,result from jobs where id=${jobId}`.execute(store.db)).rows;
    expect(job.state).toBe('done');
    return JSON.parse(job.result) as { count: number };
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
    for (const table of ['audit', 'events', 'recipients', 'subjects', 'contents', 'replays', 'messages', 'jobs']) await sql`delete from ${sql.table(table)}`.execute(store.db);
    cfg = parseConfig({ ...example, clients: [{ id: 'panel', tokenSha256: await tokenSha256(token), scopes: ['panel'], brands: '*', templates: '*' }] });
    const [keyed, importer] = keysOnly(cfg);
    runtime = await loadExtensions(keyed, store, importer, undefined, () => tombstoneRegistry(dev));
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
    const req = await signPanel(new Request('http://localhost/internal/v2/messages'), token, claims);
    expect((await runtime.fetch(new Request('http://localhost/internal/v2/audit', req), env)).status).toBe(403);
    expect((await runtime.fetch(req, {})).status).toBe(403);
    expect((await createApp().fetch(req, {} as Env, {} as ExecutionContext)).status).toBe(404);
  });
  it('serves the same gate on the Worker only on the internal host', async () => {
    await seed();
    const pair = await accessKeyPair(), certs = certsFetch(async () => ({ keys: [await publicJwk(pair, 'k1')] }));
    const app = createApp({ store, keys: testKeys(cfg), access: createAccessVerifier(certs.fetcher) });
    const workerEnv = { ...env, ...accessEnv, INTERNAL_HOST: 'internal.example' } as unknown as Env, jwt = await signAccessJwt(pair.privateKey, Date.now());
    const send = async (host: string, e: Env = workerEnv, auth = `Bearer ${token}`, access: string | null = jwt, version = 'v2') => {
      const req = await signPanel(new Request(`https://${host}/internal/${version}/messages`, { headers: access === null ? {} : { 'cf-access-jwt-assertion': access } }), token, claims, { aud: 'internal.example' });
      req.headers.set('authorization', auth);
      return app.fetch(req, e, {} as ExecutionContext);
    };
    for (const response of [await send('internal.example', workerEnv, `Bearer ${token}`, null),
      await send('internal.example', workerEnv, `Bearer ${token}`, await signAccessJwt(pair.privateKey, Date.now(), { aud: ['other'] })),
      await send('internal.example', { ...workerEnv, ACCESS_AUD: undefined } as unknown as Env)]) expect(response.status).toBe(403);
    expect(await rows('audit')).toHaveLength(0);
    const ok = await send('internal.example');
    expect(ok.status).toBe(200);
    expect((await ok.json() as Payload).messages.map(m => m.id)).toEqual(['msg_1']);
    expect((await rows('audit')).map(r => r.action)).toEqual(['log.list']);
    expect((await send('internal.example', workerEnv, 'Bearer invalid')).status).toBe(401);
    cfg.clients![0].scopes = ['send'];
    expect((await send('internal.example')).status).toBe(403); cfg.clients![0].scopes = ['panel'];
    expect((await send('internal.example', workerEnv, `Bearer ${token}`, jwt, 'v1')).status).toBe(404);
    for (const response of [await send('localhost'), await send('internal.example', { ...workerEnv, PANEL_ASSERTION_KEYS: undefined }),
      await send('internal.example', { ...workerEnv, INTERNAL_HOST: undefined })]) expect(response.status).toBe(404);
    expect(await rows('audit')).toHaveLength(1);
  });
  it('binds assertion v2 to the token, audience, keyring and a single-use nonce', async () => {
    const other = 'msk_panel2_' + 'b'.repeat(43), url = 'http://localhost/internal/v2/audit';
    cfg.clients!.push({ id: 'panel2', tokenSha256: await tokenSha256(other), scopes: ['panel'], brands: '*', templates: '*' } as never);
    const login = (signing: Parameters<typeof signPanel>[3] = {}, bearer = token) =>
      signPanel(new Request(url, { method: 'POST', body: JSON.stringify({ action: 'panel.login' }) }), bearer, claims, signing);
    const status = async (req: Request | Promise<Request>, e: object = env) => (await runtime.fetch(await req, e)).status;
    expect(await status(login({ token }, other))).toBe(403);
    expect(await status(login({ aud: 'other.example' }))).toBe(403);
    expect(await status(login({ nonce: null }))).toBe(403);
    expect(await status(login({ key: { kid: 'unknown', key: panelKey.key } }))).toBe(403);
    expect(await status(login(), { ...env, PANEL_AUDIENCE: undefined })).toBe(403);
    const unversioned = await login(); unversioned.headers.delete('x-panel-protocol');
    expect(await status(unversioned)).toBe(403);
    const nonce = Buffer.alloc(32, 1).toString('base64url');
    expect(await status(login({ nonce }))).toBe(200);
    const replay = await runtime.fetch(await login({ nonce }), env);
    expect(replay.status).toBe(409); expect(await replay.json()).toMatchObject({ code: 'replayed' });
    vi.spyOn(store, 'consume').mockRejectedValueOnce(new Error('down'));
    expect(await status(login())).toBe(503);
    expect((await rows('audit')).map(r => r.action)).toEqual(['panel.login']);
    const next = { kid: 'p2', key: Buffer.alloc(32, 3).toString('base64url') }, both = { ...env, PANEL_ASSERTION_KEYS: JSON.stringify([next, panelKey]) };
    for (const key of [next, panelKey]) expect(await status(login({ key }), both)).toBe(200);
    expect(await status(login({ key: panelKey }), { ...env, PANEL_ASSERTION_KEYS: JSON.stringify([next]) })).toBe(403);
    const v1 = new Request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-panel-actor': 'user-1', 'x-panel-protocol': PANEL_PROTOCOL }, body: '{"action":"panel.login"}' });
    const payload = { ...claims, operation: await tokenSha256(`POST\n/internal/v2/audit\n${'{"action":"panel.login"}'}`) };
    v1.headers.set('x-panel-assertion', btoa(JSON.stringify({ payload, tag: await createMac(payload, [{ kid: 'panel-v1', key: panelKey.key }]) })));
    expect(await status(v1, { ...env, PANEL_ASSERTION_KEYS: JSON.stringify([{ kid: 'panel-v1', key: panelKey.key }]) })).toBe(403);
    expect(await status(signPanel(new Request('http://localhost/internal/v1/messages'), token, claims))).toBe(404);
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
    const url = 'http://localhost/internal/v2' + path;
    const req = new Request(url, { method: 'POST', headers: (await signPanel(new Request(url, { method: 'POST', body: '{}' }), token, claims)).headers, body: 'x'.repeat(65537) });
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
    for (const found of [{ rcpt: 'one@example.com' }, { ref: 'order-1' }]) {
      const response = await call('/messages/search', { body: await sealed(found, 'log.search') });
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
    const exported = await (await call('/subjects/export', { body: await exp() })).json();
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
      expect((await call('/subjects/export', { body: await exp(), claims: { role } })).status).toBe(role === 'admin' ? 200 : 403);
    }
  });
  it('scopes every message path and subject operation by brand and template', async () => {
    await seed('allowed'); await seed('other-brand', 'demo'); await seed('other-template', 'acme', 'payment');
    cfg.clients![0].brands = ['acme']; cfg.clients![0].templates = ['notice'];
    expect((await (await call()).json()).messages.map((m: { id: string }) => m.id)).toEqual(['allowed']);
    for (const id of ['other-brand', 'other-template']) for (const suffix of ['', '/content', '/evidence', '/resend-source']) expect((await call('/messages/' + id + suffix)).status).toBe(404);
    expect((await (await call('/subjects/export', { body: await exp() })).json()).messages.map((m: { id: string }) => m.id)).toEqual(['allowed']);
    expect((await call('/audit')).status).toBe(403); expect((await call('/audit/head')).status).toBe(403);
    expect((await call('/audit', { body: { action: 'panel.login' } })).status).toBe(403);
    expect((await erase()).count).toBe(1);
    expect((await rows('messages')).map(r => r.id).sort()).toEqual(['other-brand', 'other-template']);
  });
  it('refuses missing records and expired metadata and blobs before purge', async () => {
    for (const suffix of ['', '/content', '/evidence', '/resend-source']) expect((await call('/messages/missing' + suffix)).status).toBe(404);
    await seed('expired', 'acme', 'notice', 'recipient', indices[0], now - 1);
    expect((await (await call()).json()).messages).toEqual([]);
    for (const suffix of ['', '/content', '/evidence', '/resend-source']) expect((await call('/messages/expired' + suffix)).status).toBe(404);
    expect((await (await call('/subjects/export', { body: await exp() })).json()).messages).toEqual([]);
    await seed();
    for (const table of ['contents', 'replays']) await sql`update ${sql.table(table)} set expires_at=${now - 1}`.execute(store.db);
    await sql`update messages set content_expires_at=${now - 1}`.execute(store.db);
    expect((await call('/messages/msg_1/content')).status).toBe(404);
    expect(await (await call('/messages/msg_1/evidence')).json()).toMatchObject({ provider_response_sealed: 'sealed-provider', events: [{ evidence_sealed: 'sealed-evidence' }] });
    expect((await (await call('/messages/msg_1/resend-source')).json()).replay).toBeNull();
    const exported = JSON.stringify(await (await call('/subjects/export', { body: await exp() })).json());
    for (const value of ['sealed-contents', 'sealed-replays']) expect(exported).not.toContain(value);
    for (const value of ['sealed-provider', 'sealed-evidence']) expect(exported).toContain(value);
  });
  it('exports retained evidence after archive expiry', async () => {
    await seed();
    await sql`update messages set content_expires_at=${now - 1}`.execute(store.db);
    const response = await call('/subjects/export', { body: await exp() });
    expect(response.status).toBe(200);
    expect((await response.json()).messages[0]).toMatchObject({ content: null, replay: null,
      evidence: { provider_response_sealed: 'sealed-provider', events: [{ evidence_sealed: 'sealed-evidence' }] } });
    expect((await rows('audit')).map(r => r.action)).toEqual(['privacy.export']);
  });
  it('applies content and metadata ceilings independently to evidence and export', async () => {
    await seed();
    const day = 86400000;
    cfg.logging.ceilings.contentDays = 1;
    cfg.logging.ceilings.metaDays = 3;
    await sql`update messages set created_at=${now - 2 * day}`.execute(store.db);
    expect((await call('/messages/msg_1/content')).status).toBe(404);
    expect(await (await call('/messages/msg_1/evidence')).json()).toMatchObject({ provider_response_sealed: 'sealed-provider', events: [{ evidence_sealed: 'sealed-evidence' }] });
    const exported = await (await call('/subjects/export', { body: await exp() })).json();
    expect(exported.messages[0]).toMatchObject({ content: null, replay: null, evidence: { provider_response_sealed: 'sealed-provider', events: [{ evidence_sealed: 'sealed-evidence' }] } });
    cfg.logging.ceilings.metaDays = 1;
    expect((await call('/messages/msg_1/evidence')).status).toBe(404);
    expect((await (await call('/subjects/export', { body: await exp() })).json()).messages).toEqual([]);
  });
  it.each(['/messages/msg_1/evidence', '/subjects/export'])('requires audit for retained evidence after archive expiry: %s', async path => {
    await seed();
    await sql`update messages set content_expires_at=${now - 1}`.execute(store.db);
    const original = store.batch.bind(store);
    vi.spyOn(store, 'batch').mockImplementation(queries => { if (queries.some(q => q.sql.includes('insert into audit'))) throw new Error('unavailable'); return original(queries); });
    const response = await call(path, { body: path === '/subjects/export' ? await exp() : undefined });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('sealed-');
  });
  it.each(['/messages', '/messages/search', '/messages/msg_1', '/messages/msg_1/content', '/messages/msg_1/evidence', '/messages/msg_1/resend-source', '/subjects/export', '/subjects/erase', '/audit'])('requires audit completion before returning data or changing rows: %s', async path => {
    await seed();
    const original = store.batch.bind(store);
    vi.spyOn(store, 'batch').mockImplementation(queries => { if (queries.some(q => q.sql.includes('insert into audit'))) throw new Error('unavailable'); return original(queries); });
    const body = path === '/subjects/export' ? await exp() : path === '/subjects/erase' ? await era() : path === '/messages/search' ? await sealed({ rcpt: 'one@example.com' }, 'log.search') : path === '/audit' ? { action: 'panel.login' } : undefined;
    const response = await call(path, { body });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('sealed-');
    expect(await rows('messages')).toHaveLength(1); expect(await rows('jobs')).toEqual([]);
  });
  it('exports all subject roles and erases children in bounded atomic batches', async () => {
    for (const [i, role] of ['recipient', 'reply_to', 'submitter'].entries()) await seed('msg_' + i, 'acme', 'notice', role, indices[i % 2]);
    expect((await (await call('/subjects/export', { body: await exp() })).json()).messages).toHaveLength(3);
    expect(await erase()).toMatchObject({ count: 3 });
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
    expect(await erase()).toMatchObject({ count: 1 });
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
      const page = await (await call('/subjects/export', { body: await exp({ limit: 20, cursor }) })).json();
      expect(page.messages.length).toBeLessThanOrEqual(20);
      exported.push(...page.messages.map(m => m.id)); cursor = page.cursor;
    } while (cursor);
    expect(exported).toEqual(Array.from({ length: 105 }, (_, i) => 'bulk_' + i).sort());
    expect(new Set(exported).size).toBe(105);
    expect(peak).toBe(1);
    expect(messageReads).toHaveLength(6);
    expect(messageReads.every(query => /limit/.test(query))).toBe(true);
    for (const body of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { cursor: 1 }, { cursor: 'invalid!' }]) {
      expect((await call('/subjects/export', { body: await exp({ ...body }) })).status).toBe(400);
    }
    expect(await erase()).toMatchObject({ count: 105 });
    for (const table of ['messages', 'subjects', 'contents', 'replays']) expect(await rows(table)).toEqual([]);
    const [job] = await rows('jobs');
    expect(JSON.parse(String((await rows('audit')).find(row => row.action === 'privacy.erase')!.details))).toEqual({ job: job.id });
    expect(JSON.parse(String((await rows('audit')).find(row => row.action === 'privacy.erase.done')!.details))).toEqual({ job: job.id, count: 105 });
  });
  async function bulk(count: number, evidence = 'sealed-evidence', prefix = 'page_') {
    const idx = await blindIndex('one@example.com', indices[0]);
    for (let offset = 0; offset < count; offset += 10) {
      const statements = [];
      for (let i = offset; i < Math.min(offset + 10, count); i++) {
        const id = prefix + String(i).padStart(4, '0');
        statements.push(sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,sent_at,meta_expires_at,content_expires_at,provider_response_sealed,subject_sealed)
          values(${id},'demo','acme','notice','full','hash','sent',${now - i},${now},${now + 1000000},${now + 1000000},'sealed-provider','sealed-subject')`);
        for (const pos of [0, 1]) statements.push(sql`insert into recipients values(${id},${pos},'to',${idx.index + pos},${idx.kid},'sealed-address',${'hint-' + pos},'sent',null)`);
        statements.push(sql`insert into subjects values(${id},'recipient',${idx.index},${idx.kid})`);
        for (const table of ['contents', 'replays']) statements.push(sql`insert into ${sql.table(table)} values(${id},${'sealed-' + table},${now + 1000000})`);
        statements.push(sql`insert into events(id,message_id,source,source_event_id,type,occurred_at,received_at,auth,summary,evidence_sealed)
          values(${id},${id},'local',${id},'sent',${now},${now},'local','summary',${evidence})`);
      }
      await store.batch(statements.map(q => q.compile(store.db)));
    }
  }
  const countCalls = () => {
    const executor = store.db.getExecutor(), execute = executor.executeQuery.bind(executor);
    const seen = { calls: 0 };
    vi.spyOn(executor, 'executeQuery').mockImplementation(async (...args) => { seen.calls++; return await execute(...args); });
    return seen;
  };
  it('lists a page without per-message queries and keeps recipient hints in order', async () => {
    await bulk(100);
    const seen = countCalls();
    const page = await (await call('/messages?limit=100')).json();
    expect(page.messages).toHaveLength(100);
    expect(page.messages.every(m => JSON.stringify(m.addr_hints) === '["hint-0","hint-1"]')).toBe(true);
    expect(seen.calls).toBeLessThanOrEqual(4);
  });
  it('lists messages without recipients with empty hints', async () => {
    await sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at) values('bare','demo','acme','notice','meta','hash','sent',${now},${now + 1000000})`.execute(store.db);
    expect((await (await call()).json()).messages[0].addr_hints).toEqual([]);
  });
  it('exports a page with a constant number of queries whatever its size', async () => {
    await bulk(50);
    const counts: number[] = [];
    for (const limit of [1, 50]) {
      const seen = countCalls();
      const page = await (await call('/subjects/export', { body: await exp({ limit }) })).json() as Payload & { manifest: Record<string, unknown> };
      expect(page.messages).toHaveLength(limit);
      expect(page.messages[0]).toMatchObject({ content: { sealed: 'sealed-contents' }, replay: { sealed: 'sealed-replays' }, ref_sealed: null,
        recipients: [{ pos: 0 }, { pos: 1 }], events: [{ type: 'sent' }], evidence: { provider_response_sealed: 'sealed-provider', events: [{ evidence_sealed: 'sealed-evidence' }] } });
      expect(page.manifest).toMatchObject({ range: { first: 'page_0000', count: limit }, complete: limit === 50 });
      counts.push(seen.calls); vi.restoreAllMocks();
    }
    expect(Math.max(...counts)).toBeLessThanOrEqual(10);
    expect(counts[1]).toBe(counts[0]);
  });
  it('ends an export page before 1 MiB and resumes from the cursor without gaps', async () => {
    await bulk(12, 'x'.repeat(300000));
    const ids: string[] = [], manifests: { complete: boolean; bytes: number }[] = [];
    let cursor: string | null = null;
    do {
      const response = await call('/subjects/export', { body: await exp({ limit: 50, cursor }) });
      expect(Number((await response.clone().text()).length)).toBeLessThanOrEqual(1048576);
      const page = await response.json() as Payload & { manifest: { complete: boolean; bytes: number; cursor: string | null } };
      expect(page.manifest.cursor).toBe(page.cursor); expect(page.manifest.complete).toBe(page.cursor === null);
      ids.push(...page.messages.map(m => m.id)); manifests.push(page.manifest); cursor = page.cursor;
    } while (cursor);
    expect(manifests.length).toBeGreaterThan(1);
    expect(manifests.slice(0, -1).every(m => !m.complete)).toBe(true);
    expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => 'page_' + String(i).padStart(4, '0')));
  });
  // Review finding 6: a single message whose evidence exceeds the panel read limit (8 MiB) arrives complete in pages of at most 1 MiB.
  const exportAll = async () => {
    const entries: (Payload['messages'][number] & { part: { offset: number; total: number }; continued?: true; events: { id: string }[]; evidence: { events: { id: string; evidence_sealed: string }[] } })[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      const response = await call('/subjects/export', { body: await exp({ cursor }) });
      expect(response.status).toBe(200);
      const text = await response.text(); expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1048576);
      const page = JSON.parse(text) as { messages: typeof entries; cursor: string | null; manifest: { complete: boolean; cursor: string | null } };
      expect(page.manifest).toMatchObject({ cursor: page.cursor, complete: page.cursor === null });
      entries.push(...page.messages); cursor = page.cursor; pages++;
    } while (cursor && pages < 100);
    return { entries, pages };
  };
  it('exports one message with over 8 MiB of evidence completely in pages of at most 1 MiB', async () => {
    await bulk(1, 'e'.repeat(250000));
    for (let i = 1; i < 36; i++) await sql`insert into events(id,message_id,source,source_event_id,type,occurred_at,received_at,auth,summary,evidence_sealed)
      values(${'evt_' + String(i).padStart(3, '0')},'page_0000','ses-sns',${'source_' + i},'delay',${now + i},${now + i},'sns-sig-v2','summary',${String(i % 10).repeat(250000)})`.execute(store.db);
    await bulk(1, 'sealed-evidence', 'tail_');
    const { entries, pages } = await exportAll();
    expect(pages).toBeGreaterThan(8);
    const first = entries.filter(e => e.id === 'page_0000');
    expect(first[0]).toMatchObject({ part: { offset: 0, total: 36 }, content: { sealed: 'sealed-contents' }, replay: { sealed: 'sealed-replays' } });
    expect(first.slice(1).every(e => e.continued && e.content === undefined && e.part.total === 36)).toBe(true);
    let offset = 0;
    for (const e of first) { expect(e.part.offset).toBe(offset); offset += e.events.length; expect(e.evidence.events.map(v => v.id)).toEqual(e.events.map(v => v.id)); }
    expect(offset).toBe(36);
    const evidence = first.flatMap(e => e.evidence.events);
    expect(evidence.map(e => e.id)).toEqual(['page_0000', ...Array.from({ length: 35 }, (_, i) => 'evt_' + String(i + 1).padStart(3, '0'))]);
    expect(evidence.reduce((n, e) => n + e.evidence_sealed.length, 0)).toBe(36 * 250000);
    expect(entries.filter(e => e.id === 'tail_0000')).toMatchObject([{ part: { offset: 0, total: 1 } }]);
  });
  it('refuses an evidence record that alone exceeds the page budget instead of returning an oversized page', async () => {
    await bulk(1, 'x'.repeat(1100000));
    const first = await call('/subjects/export', { body: await exp() });
    const page = await first.json() as unknown as { messages: { events: unknown[]; part: unknown }[]; cursor: string };
    expect(page.messages).toMatchObject([{ events: [], part: { offset: 0, total: 1 } }]); expect(atob(page.cursor)).toBe('page_0000.0');
    const response = await call('/subjects/export', { body: await exp({ cursor: page.cursor }) });
    expect(response.status).toBe(503);
    expect((await response.text()).length).toBeLessThan(1000);
  });
  it.each([btoa('bad id!'), btoa('x'.repeat(129)), 'not base64!', btoa('page_0000.x'), btoa('page_0000.1234567'), btoa('page_0000.')])('rejects a malformed export cursor: %s', async cursor => {
    expect((await call('/subjects/export', { body: await exp({ cursor }) })).status).toBe(400);
  });
  it('binds signed assertions to body and query and checks the signature', async () => {
    const req = await signPanel(new Request('http://localhost/internal/v2/subjects/erase', { method: 'POST', body: JSON.stringify(await era()) }), token, claims);
    const assertion = req.headers.get('x-panel-assertion')!;
    const changed = new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(await era('Requested by subject', 'two@example.com')) });
    expect((await runtime.fetch(changed, env)).status).toBe(403);
    const parsed = JSON.parse(atob(assertion)); parsed.payload.actor = 'user-2'; req.headers.set('x-panel-actor', 'user-2');
    req.headers.set('x-panel-assertion', btoa(JSON.stringify(parsed)));
    expect((await runtime.fetch(req, env)).status).toBe(403);
    const get = await signPanel(new Request('http://localhost/internal/v2/messages?brand=acme'), token, claims);
    expect((await runtime.fetch(new Request('http://localhost/internal/v2/messages?brand=demo', get), env)).status).toBe(403);
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
    expect((await erase()).count).toBe(0);
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
