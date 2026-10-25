import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from '../src/runtime/node-api';
import { generateKeyPairSync } from 'node:crypto';
import { loadExtensions } from '../src/runtime/extensions';
import type { DomainEvent, Extension } from '../src/core/extensions';
import { parseConfig } from '../src/core/config/schema';
import { config } from '../src/core/config';
import example from '../config/mailstack.example.json';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createApp } from '../src/index';
import { handleSend } from '../src/send';
import { handleSesEvent } from '../src/events/ses';
import { tokenSha256 } from '../src/clients';
import { blindIndex } from '../src/core/crypto';
import { options, notification, request } from './sns-fixture';
import type { Env, SendDeps } from '../src/types';

let store: ReturnType<typeof createSqliteStore>;
const tasks: Promise<unknown>[] = [];
const waitUntil = (task: Promise<unknown>) => { tasks.push(task); };
const pair = generateKeyPairSync('x25519');
const keys = [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'c1', kty: 'OKP', crv: 'X25519' }];
const indices = [{ kid: 'i1', key: Buffer.alloc(32, 7).toString('base64url') }];
const env = { API_KEY: 'test-key', CONTENT_PUBLIC_KEYS: JSON.stringify({ keys }), INDEX_KEYS: JSON.stringify(indices) } as Env;
const configured = () => parseConfig({ ...example, extensions: [{ module: 'demo-extension', options: { mode: 'test' } }] });
const load = (extension: Extension) => loadExtensions(configured(), store, async () => ({ default: () => extension }));
beforeEach(async () => { store = createSqliteStore(':memory:'); await store.migrate(); tasks.length = 0; });
afterEach(async () => { await Promise.all(tasks); vi.useRealTimers(); vi.restoreAllMocks(); await store.db.destroy(); });

it('defaults to no extensions and validates complete entries', () => {
  expect(parseConfig(example).extensions).toEqual([]);
  for (const entry of [{ module: './local.mjs' }, { module: '../local' }, { module: 'file:///tmp/demo.mjs' }, { module: 'https://example.com/a' }, { module: '' }, { module: 'demo', extra: true }, { module: 'demo', options: [] }]) {
    expect(() => parseConfig({ ...example, extensions: [entry] })).toThrow('$.extensions.0');
  }
  expect(parseConfig({ ...example, extensions: [{ module: '/opt/mailstack/demo.mjs' }] }).extensions).toHaveLength(1);
});
it('reports module and initialization failures using configuration paths', async () => {
  for (const importer of [async () => { throw new Error('private value'); }, async () => ({ default: {} }), async () => ({ default: () => ({ name: '../demo' }) })]) {
    await expect(loadExtensions(configured(), store, importer)).rejects.toThrow('$.extensions.0');
    try { await loadExtensions(configured(), store, importer); } catch (error) { expect(String(error)).not.toContain('private value'); }
  }
  await expect(loadExtensions(parseConfig({ ...example, extensions: [{ module: '/no-such-extension.mjs' }] }), store)).rejects.toThrow('$.extensions.0');
});
it('passes options and a limited context to the module', async () => {
  const factory = vi.fn(() => ({ name: 'demo' }));
  const runtime = await loadExtensions(configured(), store, async () => ({ default: factory }));
  expect(factory).toHaveBeenCalledWith({ mode: 'test' });
  expect(await runtime.fetch(new Request('http://localhost/internal/ext/demo/'), env)).toHaveProperty('status', 401);
  const onEvent = vi.fn(); const loaded = await load({ name: 'demo', onEvent });
  loaded.emitEvent({ type: 'message.sent', at: 1, brand: 'acme', template: 'notice', status: 'sent' }, waitUntil);
  await Promise.all(tasks);
  const context = onEvent.mock.calls[0][1];
  expect(Object.keys(context).sort()).toEqual(['appendAudit', 'config', 'db', 'now']);
  expect(Object.keys(context.config).sort()).toEqual(['brands', 'logging']);
  await context.appendAudit({ at: 1, actor: 'system', action: 'extension.test' });
  expect((await sql`select * from audit`.execute(store.db)).rows).toHaveLength(1);
});
it('permits migrations within the extension table prefix', async () => {
  await load({ name: 'demo', migrate: async db => { await db.schema.createTable('ext_demo_items').addColumn('id', 'text', c => c.primaryKey()).execute(); } });
  expect((await sql`select * from ext_demo_items`.execute(store.db)).rows).toEqual([]);
});
it.each(['messages', 'ext_other_items'])('rejects migration tables outside the assigned prefix: %s', async table => {
  await expect(load({ name: 'demo', migrate: async db => { await db.schema.dropTable(table).ifExists().execute(); } })).rejects.toThrow('$.extensions.0');
  await store.health();
  expect((await store.db.selectFrom('messages').selectAll().execute())).toEqual([]);
});
it('rejects raw migration statements and cross-table references', async () => {
  for (const migrate of [async (db: Parameters<NonNullable<Extension['migrate']>>[0]) => { await sql`delete from messages`.execute(db); },
    async (db: Parameters<NonNullable<Extension['migrate']>>[0]) => { await db.schema.createTable('ext_demo_items').addColumn('id', 'text', c => c.references('messages.id')).execute(); }]) {
    await expect(load({ name: 'demo', migrate })).rejects.toThrow('$.extensions.0');
  }
});
it('mounts routes on the internal handler with panel credentials and actor', async () => {
  const token = 'msk_panel_' + 'a'.repeat(43);
  const cfg = configured(); cfg.clients = [{ id: 'panel', tokenSha256: await tokenSha256(token), scopes: ['panel'], brands: [], templates: [], attachments: false, recipientOverride: false }];
  const runtime = await loadExtensions(cfg, store, async () => ({ default: { name: 'demo', routes(app: Parameters<NonNullable<Extension['routes']>>[0]) { app.route('GET', '/ping', () => Response.json({ ok: true })); } } }));
  const url = 'http://localhost/internal/ext/demo/ping';
  for (const headers of [{}, { authorization: 'Bearer test-key', 'x-panel-actor': 'user-1' }, { authorization: `Bearer ${token}` }] as Record<string, string>[]) {
    expect((await runtime.fetch(new Request(url, { headers }), env)).status).toBeGreaterThanOrEqual(400);
  }
  const req = new Request(url, { headers: { authorization: `Bearer ${token}`, 'x-panel-actor': 'user-1' } });
  expect(await (await runtime.fetch(req, env)).json()).toEqual({ ok: true });
  expect((await createApp().fetch(req, env, { waitUntil } as ExecutionContext)).status).toBe(404);
});
async function sendWith(extension: Extension, outcome: 'sent' | 'send_failed' | 'unknown' = 'sent', publicForm = false) {
  const runtime = await load(extension);
  const sendEmail = vi.fn(async () => { if (outcome === 'unknown') throw new Error('private provider detail'); return { ok: outcome === 'sent', status: 200 }; });
  const deps: SendDeps = { store, logging: structuredClone(config.logging), sendEmail, now: () => new Date(), verifyAltcha: async () => true, verifyTurnstile: async () => true, emitEvent: runtime.emitEvent, waitUntil };
  deps.logging!.defaults.level = 'meta';
  const req = new Request('https://mail.example/v1/send', { method: 'POST', headers: publicForm ? { origin: 'https://acme.example' } : { authorization: 'Bearer test-key', 'Idempotency-Key': 'one' }, body: JSON.stringify({ brand: 'acme', email: 'one@example.com', subject: 'Subject sentinel', message: 'Body sentinel', autoreply: false, 'cf-turnstile-response': 'token' }) });
  const retry = req.clone();
  const response = await handleSend(req, env, deps);
  if (!publicForm) await handleSend(retry, env, deps);
  return response;
}
it.each(['sent', 'send_failed', 'unknown'] as const)('emits one event after recording the result: %s', async outcome => {
  const received: DomainEvent[] = [], statuses: string[] = [];
  const response = await sendWith({ name: 'demo', onEvent: async event => {
    received.push(event);
    statuses.push((await store.db.selectFrom('messages').select('status').executeTakeFirstOrThrow()).status);
  } }, outcome);
  await Promise.all(tasks);
  expect(response.status).toBe(outcome === 'sent' ? 200 : 502);
  expect(received).toHaveLength(outcome === 'send_failed' ? 2 : 1);
  expect(statuses).toEqual(received.map(() => outcome));
  expect(received[0]).toMatchObject({ type: `message.${outcome}`, brand: 'acme', template: 'contact', status: outcome });
  for (const event of received) {
    expect(Object.keys(event).sort()).toEqual(['at', 'brand', 'id', 'messageId', 'status', 'template', 'type']);
    for (const value of Object.values(event)) for (const text of ['one@example.com', 'Subject sentinel', 'Body sentinel']) expect(String(value)).not.toContain(text);
  }
});
it('emits form.submitted only for a successful public contact', async () => {
  const onEvent = vi.fn(); expect((await sendWith({ name: 'demo', onEvent }, 'sent', true)).status).toBe(200);
  await Promise.all(tasks);
  expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(['message.sent', 'form.submitted']);
});
it.each(['throw', 'slow'])('keeps responses independent of extension execution: %s', async mode => {
  vi.useFakeTimers(); const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const onEvent = vi.fn(async () => { if (mode === 'throw') throw new Error('one@example.com'); await new Promise(resolve => setTimeout(resolve, 10000)); });
  expect((await sendWith({ name: 'demo', onEvent })).status).toBe(200);
  let finished = false; void Promise.all(tasks).then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(5000);
  expect(finished).toBe(true); expect(log).toHaveBeenCalledWith('mailstack: extension event failed');
  expect(JSON.stringify(log.mock.calls)).not.toContain('one@example.com');
  await vi.advanceTimersByTimeAsync(5000);
});
it('emits one SES event after projection and no event for its duplicate', async () => {
  const onEvent = vi.fn(); const runtime = await load({ name: 'demo', onEvent });
  await sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at) values('msg_1','demo','acme','notice','meta','hash','sent',0,9999999999999)`.execute(store.db);
  const idx = await blindIndex('one@example.com', indices[0]);
  await sql`insert into recipients values('msg_1',0,'to',${idx.index},'i1','sealed','hint','sent',null)`.execute(store.db);
  const body = { Type: 'Notification', MessageId: 'sns-1', Message: JSON.stringify(notification()), TopicArn: options.topicArns[0], Timestamp: new Date().toISOString(), SignatureVersion: '2', Signature: 'test', SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/cert.pem' };
  const deps = { options, store, verify: async () => true, contentKeys: keys, indexKeys: indices, now: Date.now, emitEvent: runtime.emitEvent, waitUntil };
  expect((await handleSesEvent(request(body), deps)).status).toBe(200);
  expect((await handleSesEvent(request(body), deps)).status).toBe(200);
  await Promise.all(tasks);
  expect(onEvent).toHaveBeenCalledTimes(1);
  expect(onEvent.mock.calls[0][0]).toMatchObject({ type: 'message.delivered', status: 'delivered', template: 'notice', messageId: 'msg_1' });
});

it('keeps SES processing successful when extension context lookup fails', async () => {
  const runtime = await load({ name: 'demo', onEvent: vi.fn() });
  await sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at) values('msg_1','demo','acme','notice','meta','hash','sent',0,9999999999999)`.execute(store.db);
  const idx = await blindIndex('one@example.com', indices[0]);
  await sql`insert into recipients values('msg_1',0,'to',${idx.index},'i1','sealed','hint','sent',null)`.execute(store.db);
  vi.spyOn(store.db, 'selectFrom').mockImplementation(() => { throw new Error('private lookup detail'); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const body = { Type: 'Notification', MessageId: 'sns-1', Message: JSON.stringify(notification()), TopicArn: options.topicArns[0], Timestamp: new Date().toISOString(), SignatureVersion: '2', Signature: 'test', SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/cert.pem' };
  expect((await handleSesEvent(request(body), { options, store, verify: async () => true, contentKeys: keys, indexKeys: indices, now: Date.now, emitEvent: runtime.emitEvent, waitUntil })).status).toBe(200);
});

it('loads an absolute module file and serves it only on the internal listener', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'dist/extension-'));
  const file = join(directory, 'demo.mjs');
  const token = 'msk_panel_' + 'a'.repeat(43);
  await writeFile(file, `export default options => ({ name: 'demo', routes(app) { app.route('GET', '/ping', () => Response.json(options)); } });`);
  const cfg = parseConfig({ ...example, extensions: [{ module: file, options: { active: true } }], clients: [{ id: 'panel', tokenSha256: await tokenSha256(token), scopes: ['panel'] }] });
  const runtime = await loadExtensions(cfg, store);
  const app = createApp({ store });
  const publicServer = await startServer((req, env, ctx) => app.fetch(req, env, ctx as ExecutionContext), env, 0);
  const internalServer = await startServer((req, env) => runtime.fetch(req, env), env, 0);
  try {
    const init = { headers: { authorization: `Bearer ${token}`, 'x-panel-actor': 'user-1' } };
    expect((await fetch(`http://127.0.0.1:${publicServer.port}/internal/ext/demo/ping`, init)).status).toBe(404);
    expect(await (await fetch(`http://127.0.0.1:${internalServer.port}/internal/ext/demo/ping`, init)).json()).toEqual({ active: true });
  } finally { await Promise.all([publicServer.close(), internalServer.close()]); await rm(directory, { recursive: true }); }
});
it('emits no form submission event after an unsuccessful public send', async () => {
  const onEvent = vi.fn(); expect((await sendWith({ name: 'demo', onEvent }, 'send_failed', true)).status).toBe(502);
  await Promise.all(tasks);
  expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(['message.send_failed']);
});

it('waits for route registration before completing initialization', async () => {
  await expect(load({ name: 'demo', routes: async () => { await Promise.resolve(); throw new Error('private initialization detail'); } })).rejects.toThrow('$.extensions.0.module');
});
