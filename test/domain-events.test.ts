import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sql } from 'kysely';
import { config } from '../src/core/config';
import { parseConfig } from '../src/core/config/schema';
import { createExtensionHost } from '../src/core/extension-host';
import type { ExtensionMigration } from '../src/core/ext-migrations';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import { recordEvents } from '../src/core/store/events';
import type { EventIntent } from '../src/core/store/events';
import type { KyselyStore } from '../src/core/store';
import { createVerifier } from '../src/events/sns';
import { handleSesEvent } from '../src/events/ses';
import { blindIndex } from '../src/core/crypto';
import { handleSend } from '../src/send';
import type { Env, SendDeps } from '../src/types';
import example from '../config/mailstack.example.json';
import { certificates, notification, options, request, signed } from './sns-fixture';

const pair = generateKeyPairSync('x25519');
const publicKeys = [{ ...pair.publicKey.export({ format: 'jwk' }), kty: 'OKP', crv: 'X25519', kid: 'c1' }];
const indexKeys = [{ kid: 'i1', key: Buffer.alloc(32, 11).toString('base64url') }];
let cert: string, key: string;
beforeAll(() => { ({ cert, key } = certificates()); });

for (const driver of ['sqlite', 'd1'] as const) describe(`durable domain events: ${driver}`, () => {
  let store: KyselyStore, mf: Miniflare | undefined, env: Env, deps: SendDeps;
  const consumer = vi.fn(async () => ({ ref: false }) as { ref: boolean } | undefined);
  const events = () => store.db.selectFrom('domain_events' as never).selectAll().orderBy('seq' as never).execute() as Promise<Record<string, unknown>[]>;
  const message = () => store.db.selectFrom('messages').selectAll().executeTakeFirstOrThrow();
  const trusted = (body: Record<string, unknown> = {}) => handleSend(new Request('https://mail.example/v1/send', {
    method: 'POST', headers: { authorization: 'Bearer test-key' },
    body: JSON.stringify({ brand: 'acme', template: 'notice', heading: 'Notice', paragraphs: 'Body', ...body }),
  }), env, deps);
  const intent = (...types: EventIntent['types']): EventIntent => ({ at: 1000, refDigest: null, types });
  const seed = (id: string, status = 'sending') => sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at,provider_account,provider_message_id)
    values(${id},'legacy','acme','notice','meta','h',${status},0,9999999999999,'123456789012','provider-1')`.execute(store.db);
  const markSent = (id: string) => store.markSent(id, { providerMessageId: 'ses-1', providerResponseSealed: 'x', sentAt: 2000 }, intent('message.sent'));
  beforeAll(async () => {
    if (driver === 'sqlite') store = createSqliteStore(':memory:');
    else {
      mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }',
        compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
      store = createD1Store(await mf.getD1Database('DB'));
    }
    await store.migrate();
  });
  beforeEach(async () => {
    for (const table of ['guards', 'events', 'recipients', 'subjects', 'contents', 'replays', 'messages', 'domain_events'])
      await sql`delete from ${sql.table(table)}`.execute(store.db);
    consumer.mockClear().mockResolvedValue({ ref: false });
    env = { API_KEY: 'test-key', SES_REGION: 'eu-west-1', SES_ACCESS_KEY_ID: '', SES_SECRET_ACCESS_KEY: '', TURNSTILE_SECRET: 'secret', ALTCHA_HMAC_KEY: '',
      CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: publicKeys }), INDEX_KEYS: JSON.stringify(indexKeys) };
    deps = { store, logging: structuredClone(config.logging), now: () => new Date('2026-11-03T12:00:00Z'), durableEvents: consumer,
      verifyAltcha: async () => false, verifyTurnstile: async () => true, emitEvent: vi.fn(),
      sendEmail: vi.fn().mockResolvedValue({ ok: true, status: 200, messageId: 'ses-1', response: { MessageId: 'ses-1' } }) };
  });
  afterEach(async () => { vi.restoreAllMocks(); await sql`drop trigger if exists wp15_abort`.execute(store.db); });
  afterAll(async () => { await store?.db.destroy(); await mf?.dispose(); });

  it('stores the sent event with the status when the process stops before fan-out', async () => {
    // emitEvent never runs its work (process killed after the response): the durable row is already committed.
    const res = await trusted();
    const sent = await message();
    expect(await res.json()).toEqual({ success: true, id: sent.id });
    expect(sent.status).toBe('sent');
    expect(await events()).toEqual([expect.objectContaining({ seq: 1, cause: `msg:${sent.id}:sent`, type: 'message.sent', message_id: sent.id,
      brand: 'acme', template: 'notice', status: 'sent', at: Date.parse('2026-11-03T12:00:00Z'), ref_digest: null, id: expect.stringMatching(/^evt_/) })]);
  });

  it('writes nothing extra and answers the same without a consumer', async () => {
    const withConsumer: object = await (await trusted()).json();
    const batch = vi.spyOn(store, 'batch');
    deps.durableEvents = async () => undefined;
    const without: object = await (await trusted({ heading: 'Other' })).json();
    deps.durableEvents = undefined;
    const absent: object = await (await trusted({ heading: 'Third' })).json();
    expect(Object.keys(without)).toEqual(Object.keys(withConsumer));
    expect(Object.keys(absent)).toEqual(Object.keys(withConsumer));
    expect(await events()).toHaveLength(1);
    expect(batch.mock.calls.flat(2).some(query => query.sql.includes('domain_events'))).toBe(false);
  });

  it('writes no event at level none even with a consumer', async () => {
    deps.logging = { ...config.logging, defaults: { ...config.logging.defaults, level: 'none' } };
    expect(await (await trusted()).json()).toEqual({ success: true });
    expect(await events()).toEqual([]);
    expect(consumer).not.toHaveBeenCalled();
  });

  it('records form.submitted in the same batch as message.sent for a public contact form', async () => {
    const res = await handleSend(new Request('https://mail.example/v1/send', { method: 'POST', headers: { origin: 'https://acme.example' },
      body: JSON.stringify({ brand: 'acme', name: 'Jane', email: 'jane@example.com', message: 'Hi', autoreply: '0', 'cf-turnstile-response': 'token' }) }), env, deps);
    expect(await res.json()).toEqual({ success: true });
    const sent = await message();
    expect((await events()).map(e => [e.type, e.cause, e.template])).toEqual([
      ['message.sent', `msg:${sent.id}:sent`, 'contact'], ['form.submitted', `msg:${sent.id}:form.submitted`, 'contact']]);
  });

  it('stores the SHA-256 of ref only for a consumer that forwards it', async () => {
    await trusted({ ref: 'order-1' });
    consumer.mockResolvedValue({ ref: true });
    await trusted({ ref: 'order-2', heading: 'Other' });
    expect((await events()).map(e => e.ref_digest)).toEqual([null, createHash('sha256').update('order-2').digest('hex')]);
    expect(JSON.stringify(await events())).not.toContain('order-');
  });

  it('records refusals and uncertain outcomes as their transitions', async () => {
    vi.mocked(deps.sendEmail).mockResolvedValueOnce({ ok: false, status: 403, response: {} });
    expect((await trusted()).status).toBe(502);
    vi.mocked(deps.sendEmail).mockRejectedValueOnce(new Error('timeout'));
    expect((await trusted({ heading: 'Other' })).status).toBe(502);
    expect((await events()).map(e => [e.type, e.status])).toEqual([['message.send_failed', 'send_failed'], ['message.unknown', 'unknown']]);
  });

  it('keeps one event for a repeated markSent and none for a later disallowed transition', async () => {
    await trusted();
    const { id } = await message();
    await markSent(id);
    await store.setStatus(id, 'unknown', intent('message.unknown'));
    expect((await events()).map(e => e.cause)).toEqual([`msg:${id}:sent`]);
  });

  it('writes no event for a late result after the message was deleted', async () => {
    await seed('msg_gone');
    await sql`delete from messages where id='msg_gone'`.execute(store.db);
    await markSent('msg_gone');
    await store.markFailed('msg_gone', 'x', intent('message.send_failed'));
    await recordEvents(store, [{ id: 'evt_1', message_id: 'msg_gone', recipient_pos: 0, source: 'ses-sns', source_event_id: 'sns-1:0', type: 'delivered',
      occurred_at: 1, received_at: 1, auth: 'sns-sig-v2', summary: '', evidence_sealed: 'x' }], { type: 'message.delivered', at: 1 });
    expect(await events()).toEqual([]);
  });

  it('writes the status and its event together or not at all', async () => {
    await seed('msg_a');
    const writes = [() => markSent('msg_a'), () => store.markFailed('msg_a', 'x', intent('message.send_failed')), () => store.setStatus('msg_a', 'unknown', intent('message.unknown'))];
    await sql`create trigger wp15_abort before insert on domain_events begin select raise(abort, 'event unavailable'); end`.execute(store.db);
    for (const write of writes) {
      await expect(write()).rejects.toThrow();
      expect((await message()).status).toBe('sending');
    }
    await sql`drop trigger wp15_abort`.execute(store.db);
    await sql`create trigger wp15_abort before update on messages begin select raise(abort, 'status unavailable'); end`.execute(store.db);
    for (const write of writes) await expect(write()).rejects.toThrow();
    expect(await events()).toEqual([]);
  });

  it('turns a repeated SNS notification into one event and needs a consumer', async () => {
    await seed('msg_1', 'sent');
    for (const [pos, address] of ['one@example.com', 'two@example.com'].entries())
      await sql`insert into recipients values('msg_1',${pos},'to',${(await blindIndex(address, indexKeys[0])).index},'i1','sealed','hint','sent',null)`.execute(store.db);
    const sesDeps = { options, store, contentKeys: publicKeys, indexKeys, verify: createVerifier(async () => new Response(cert)), now: () => 5000 };
    const delivery = signed(key, notification('Delivery', { delivery: { recipients: ['one@example.com', 'two@example.com'] } }));
    for (let i = 0; i < 2; i++) await handleSesEvent(request(delivery), { ...sesDeps, durableEvents: consumer });
    await handleSesEvent(request(signed(key, notification('Send', { send: {} }))), { ...sesDeps, durableEvents: consumer });
    await handleSesEvent(request(signed(key, notification('Bounce', { bounce: { bounceType: 'Permanent', bouncedRecipients: ['one@example.com'] } }))), sesDeps);
    expect(await events()).toEqual([expect.objectContaining({ cause: `sns:${delivery.MessageId}:0`, type: 'message.delivered', message_id: 'msg_1',
      status: 'delivered', template: 'notice', at: 5000 })]);
    // A retry after the event row was pruned is still a duplicate: only a newly inserted provider row creates an event.
    await sql`delete from domain_events`.execute(store.db);
    await handleSesEvent(request(delivery), { ...sesDeps, durableEvents: consumer });
    expect(await events()).toEqual([]);
  });
});

describe('event consumers in the extension host', () => {
  it('reports a consumer for extensions with onEvent, including ones waiting for their schema', async () => {
    const store = createSqliteStore(':memory:');
    await store.migrate();
    const cfg = parseConfig({ ...example, extensions: [{ module: 'a' }] });
    const host = (extension: object) => createExtensionHost(cfg, store, async () => ({ default: { name: 'demo', ...extension } }), { keys: undefined });
    expect(await (await host({})).durableEvents()).toBeUndefined();
    expect(await (await host({ onEvent() {} })).durableEvents()).toEqual({ ref: false });
    const migrations: ExtensionMigration[] = [{ version: 1, name: 'items', up: db => db.schema.createTable('ext_demo_items').addColumn('id', 'text', c => c.primaryKey()).execute() }];
    const waiting = await host({ onEvent() {}, eventRef: true, migrations });
    expect(waiting.features()).toEqual([expect.objectContaining({ state: 'unavailable', reason: 'schema' })]);
    expect(await waiting.durableEvents()).toEqual({ ref: true });
    await store.db.destroy();
  });
});
