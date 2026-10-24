import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sql } from 'kysely';
import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import example from '../config/mailstack.example.json';
import { parseConfig } from '../src/core/config/schema';
import { parseKeyring } from '../src/core/keyring';
import { blindIndex, blindIndexes, canonicalJson, createMac, open, refIndex, verifyMac } from '../src/core/crypto';
import { recordIntent, LogUnavailableError } from '../src/core/logging/writer';
import { projectArchive } from '../src/core/logging/projection';
import { resolvePolicy } from '../src/core/logging/policy';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import { TEMPLATES } from '../src/templates/index';

const encode = (raw: ArrayBuffer) => Buffer.from(raw).toString('base64url');
const oldKey = { kid: 'i1', key: encode(new Uint8Array(32).fill(11).buffer) };
const newKey = { kid: 'i2', key: encode(new Uint8Array(32).fill(12).buffer) };
let publicKey: JsonWebKey & { kid: string };
let privateKey: JsonWebKey & { kid: string };
let env: { CONTENT_PUBLIC_KEYS: string; INDEX_KEYS: string };
beforeAll(async () => {
  const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
  const pair = await suite.kem.generateKeyPair();
  publicKey = { kid: 'c1', kty: 'OKP', crv: 'X25519', x: encode(await suite.kem.serializePublicKey(pair.publicKey)) };
  privateKey = { ...publicKey, d: encode(await suite.kem.serializePrivateKey(pair.privateKey)) };
  env = { CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [publicKey] }), INDEX_KEYS: JSON.stringify([oldKey]) };
});

it('parses ordered public and index keys with fixed validation errors', () => {
  expect(parseKeyring(env)).toEqual({ contentKeys: [publicKey], indexKeys: [oldKey] });
  const bad = [undefined, '', 'sentinel-value', '{}', 'null', '[]'];
  for (const value of bad) {
    expect(() => parseKeyring({ ...env, INDEX_KEYS: value })).toThrow(/^Invalid key configuration$/);
    expect(() => parseKeyring({ ...env, CONTENT_PUBLIC_KEYS: value })).toThrow(/^Invalid key configuration$/);
  }
  for (const keys of [[privateKey], [{ ...publicKey, x: 'bad' }], [publicKey, publicKey], [{ ...publicKey, extra: true }], [{ ...publicKey, kid: '' }]]) {
    expect(() => parseKeyring({ ...env, CONTENT_PUBLIC_KEYS: JSON.stringify({ keys }) })).toThrow(/^Invalid key configuration$/);
  }
  for (const keys of [[oldKey, oldKey], [{ ...oldKey, key: 'AA' }], [{ ...oldKey, key: oldKey.key + '=' }], [{ ...oldKey, extra: true }]]) {
    expect(() => parseKeyring({ ...env, INDEX_KEYS: JSON.stringify(keys) })).toThrow(/^Invalid key configuration$/);
  }
});

it('uses a distinct reference context with an independent HMAC expectation', async () => {
  const value = 'jane@example.com';
  const key = await crypto.subtle.importKey('raw', Buffer.from(oldKey.key, 'base64url'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = encode(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('mailstack/v1/ref\n' + value))).slice(0, 22);
  expect(await refIndex(value, oldKey)).toEqual({ kid: 'i1', index: expected });
  expect(expected).not.toBe((await blindIndex(value, oldKey)).index);
  expect(expected).not.toBe((await createMac(value, [oldKey])).mac.slice(0, 22));
  expect((await refIndex('ORDER-123', oldKey)).index).toHaveLength(22);
});

for (const driver of ['sqlite', 'd1'] as const) describe(`log writer: ${driver}`, () => {
  let store: KyselyStore;
  let mf: Miniflare | undefined;
  const now = new Date('2026-10-24T12:00:00Z');
  const config = parseConfig(example);
  const input = {
    clientId: 'acme-app', brand: config.brands.acme, template: TEMPLATES.contact,
    recipients: [{ role: 'to' as const, address: 'jane@example.com' }],
    replyTo: 'reply@example.com', subject: 'Subject sentinel', ref: 'ORDER-sentinel',
    data: { name: 'Jane', email: 'submitter@example.com', message: 'Body sentinel' },
  };
  const deps = () => ({ store, logging: config.logging, env, now: () => now });
  beforeAll(async () => {
    if (driver === 'sqlite') store = createSqliteStore(':memory:');
    else {
      mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
      store = createD1Store(await mf.getD1Database('DB'));
    }
    await store.migrate();
  });
  afterAll(async () => { await store?.db.destroy(); await mf?.dispose(); });
  const rows = (table: 'messages' | 'recipients' | 'subjects' | 'contents' | 'replays') => store.db.selectFrom(table).selectAll().execute();

  it('writes metadata, sealed values, subject roles, expiry and canonical request MAC', async () => {
    const result = await recordIntent(deps(), { ...input, idempotencyKey: 'request-1' });
    expect(result.id).toMatch(/^msg_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const message = await store.db.selectFrom('messages').selectAll().where('id', '=', result.id!).executeTakeFirstOrThrow();
    const policy = await resolvePolicy(config.logging, 'acme', 'contact');
    expect(message).toMatchObject({ client_id: 'acme-app', brand: 'acme', template: 'contact', level: 'meta', status: 'sending', created_at: now.getTime(), policy_hash: policy.policy_hash,
      meta_expires_at: now.getTime() + 90 * 86400000, content_expires_at: null });
    const context = { brand: 'acme', messageId: result.id! };
    expect(await open(message.subject_sealed!, { ...context, purpose: 'subject' }, [privateKey])).toBe(input.subject);
    expect(await open(message.ref_sealed!, { ...context, purpose: 'ref' }, [privateKey])).toBe(input.ref);
    expect(message.ref_idx).toBe((await refIndex(input.ref, oldKey)).index);
    const recipient = await store.db.selectFrom('recipients').selectAll().where('message_id', '=', result.id!).executeTakeFirstOrThrow();
    expect(recipient).toMatchObject({ pos: 0, role: 'to', idx_kid: 'i1', addr_hint: 'j***@e***.com', status: 'sending' });
    expect(await open(recipient.addr_sealed, { ...context, purpose: 'rcpt' }, [privateKey])).toBe('jane@example.com');
    const subjects = await store.db.selectFrom('subjects').selectAll().where('message_id', '=', result.id!).execute();
    for (const [role, address] of [['recipient', 'jane@example.com'], ['reply_to', input.replyTo], ['submitter', input.data.email]]) {
      expect(subjects).toContainEqual({ message_id: result.id, role, idx_kid: 'i1', addr_idx: (await blindIndex(address, oldKey)).index });
    }
    expect(await verifyMac({ brand: 'acme', template: 'contact', recipients: input.recipients, data: input.data, subject: input.subject }, JSON.parse(message.request_mac!), [oldKey])).toBe(true);
    expect(message.idem_key_hash).toBe(encode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(['acme-app', 'request-1'])))));
    expect(await store.findByIdempotency('acme-app', message.idem_key_hash!)).toEqual(message);
    expect(await store.findByIdempotency('other', message.idem_key_hash!)).toBeUndefined();
    expect(await rows('contents')).toHaveLength(0);
    expect(await rows('replays')).toHaveLength(0);
    const dump = JSON.stringify(await Promise.all(['messages', 'recipients', 'subjects', 'contents', 'replays', 'events', 'guards', 'audit'].map(async table => (await sql`select * from ${sql.table(table)}`.execute(store.db)).rows)));
    for (const value of ['jane@example.com', input.replyTo, input.data.email, input.subject, input.ref, input.data.message]) expect(dump).not.toContain(value);
  });

  it('does no work for none and reports unavailable keys for other levels', async () => {
    const before = await rows('messages');
    const logging = structuredClone(config.logging); logging.defaults.level = 'none';
    expect(await recordIntent({ ...deps(), logging, env: {} }, input)).toEqual({ id: undefined });
    expect(await rows('messages')).toEqual(before);
    await expect(recordIntent({ ...deps(), env: {} }, input)).rejects.toBeInstanceOf(LogUnavailableError);
    await expect(recordIntent({ ...deps(), store: undefined }, input)).rejects.toMatchObject({ code: 'log_unavailable' });
    await expect(recordIntent({ ...deps(), env: { ...env, INDEX_KEYS: 'sentinel-value' } }, input)).rejects.toMatchObject({ code: 'log_unavailable', message: 'log unavailable' });
  });

  it.each(['masked', 'full'] as const)('stores the %s projection and original resend payload', async level => {
    const logging = structuredClone(config.logging);
    logging.brands.acme = { templates: { contact: { level, show: ['name'], contentDays: 2, metaDays: 4, resend: 'replay' } } };
    const result = await recordIntent({ ...deps(), logging }, input);
    const message = await store.db.selectFrom('messages').selectAll().where('id', '=', result.id!).executeTakeFirstOrThrow();
    expect(message.content_expires_at).toBe(now.getTime() + 2 * 86400000);
    expect(message.meta_expires_at).toBe(now.getTime() + 4 * 86400000);
    const context = { brand: 'acme', messageId: result.id! };
    const content = await store.db.selectFrom('contents').selectAll().where('message_id', '=', result.id!).executeTakeFirstOrThrow();
    const projection = await open(content.sealed, { ...context, purpose: 'content' }, [privateKey]);
    const { policy } = await resolvePolicy(logging, 'acme', 'contact');
    expect(projection).toEqual(projectArchive({ ...input, policy, patterns: logging.patterns, metadata: { clientId: input.clientId, status: 'sending', createdAt: now.toISOString() } }));
    expect(JSON.stringify(projection).includes(input.data.message)).toBe(level === 'full');
    const replay = await store.db.selectFrom('replays').selectAll().where('message_id', '=', result.id!).executeTakeFirstOrThrow();
    const payload = await open(replay.sealed, { ...context, purpose: 'replay' }, [privateKey]);
    expect(payload).toEqual({ to: ['jane@example.com'], replyTo: input.replyTo, subjectOverride: input.subject, template: 'contact', data: input.data });
    expect(await verifyMac(payload, JSON.parse(message.replay_mac!), [oldKey])).toBe(true);
    expect(replay.expires_at).toBe(content.expires_at);
  });

  it('finds recipients and subjects across both index generations', async () => {
    const first = await recordIntent(deps(), input);
    const second = await recordIntent({ ...deps(), env: { ...env, INDEX_KEYS: JSON.stringify([newKey, oldKey]) } }, input);
    const indexes = await blindIndexes('jane@EXAMPLE.COM', [newKey, oldKey]);
    for (const table of ['recipients', 'subjects'] as const) {
      const matches = await store.db.selectFrom(table).selectAll().where('addr_idx', 'in', indexes.map(i => i.index)).execute();
      expect(matches.map(r => r.message_id)).toEqual(expect.arrayContaining([first.id, second.id]));
      expect(matches.find(r => r.message_id === second.id)?.idx_kid).toBe('i2');
    }
  });

  it('keeps the original rows when an idempotency key is reused', async () => {
    const first = await recordIntent(deps(), { ...input, idempotencyKey: 'same-key' });
    const before = await rows('messages');
    await expect(recordIntent(deps(), { ...input, idempotencyKey: 'same-key' })).rejects.toMatchObject({ code: 'log_unavailable' });
    expect(await rows('messages')).toEqual(before);
    const other = await recordIntent(deps(), { ...input, clientId: 'other-app', idempotencyKey: 'same-key' });
    expect(other.id).not.toBe(first.id);
  });

  it('stores cc and bcc roles and keeps all roles in the sealed resend data', async () => {
    const logging = structuredClone(config.logging); logging.defaults.level = 'full'; logging.defaults.resend = 'replay';
    const recipients = [...input.recipients, { role: 'cc' as const, address: 'cc@example.com' }, { role: 'bcc' as const, address: 'bcc@example.com' }];
    const { id } = await recordIntent({ ...deps(), logging }, { ...input, recipients, markup: [] });
    const saved = await store.db.selectFrom('recipients').selectAll().where('message_id', '=', id!).orderBy('pos').execute();
    expect(saved.map(r => [r.pos, r.role])).toEqual([[0, 'to'], [1, 'cc'], [2, 'bcc']]);
    const row = await store.db.selectFrom('replays').selectAll().where('message_id', '=', id!).executeTakeFirstOrThrow();
    expect(await open(row.sealed, { brand: 'acme', messageId: id!, purpose: 'replay' }, [privateKey])).toMatchObject({ to: ['jane@example.com'], cc: ['cc@example.com'], bcc: ['bcc@example.com'], markup: [] });
  });

  it('updates provider fields and message status', async () => {
    const { id } = await recordIntent(deps(), input);
    await store.markSent(id!, { providerMessageId: 'provider-1', providerResponseSealed: 'ms1.fixture', sentAt: now.getTime() + 1 });
    expect(await store.db.selectFrom('messages').selectAll().where('id', '=', id!).executeTakeFirstOrThrow()).toMatchObject({ status: 'sent', provider_message_id: 'provider-1', provider_response_sealed: 'ms1.fixture', sent_at: now.getTime() + 1 });
    await store.setStatus(id!, 'unknown');
    expect((await store.db.selectFrom('messages').select('status').where('id', '=', id!).executeTakeFirstOrThrow()).status).toBe('unknown');
  });

  it('keeps sealed data in every text column after all archive levels', async () => {
    const dump = JSON.stringify(await Promise.all(['messages', 'recipients', 'subjects', 'contents', 'replays', 'events', 'guards', 'audit'].map(async table => (await sql`select * from ${sql.table(table)}`.execute(store.db)).rows)));
    for (const value of ['jane@example.com', 'cc@example.com', 'bcc@example.com', input.replyTo, input.data.email, input.subject, input.ref, input.data.message]) expect(dump).not.toContain(value);
  });

  it.each(['recipients', 'subjects', 'contents', 'replays'] as const)('rolls back the complete write when %s fails', async table => {
    const before = await Promise.all(['messages', 'recipients', 'subjects', 'contents', 'replays'].map(t => sql`select * from ${sql.table(t)}`.execute(store.db)));
    await sql.raw(`CREATE TRIGGER fail_child BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'child failure'); END`).execute(store.db);
    const logging = structuredClone(config.logging); logging.defaults.level = 'full'; logging.defaults.resend = 'replay';
    try { await expect(recordIntent({ ...deps(), logging }, input)).rejects.toMatchObject({ code: 'log_unavailable' }); }
    finally { await sql.raw('DROP TRIGGER fail_child').execute(store.db); }
    const after = await Promise.all(['messages', 'recipients', 'subjects', 'contents', 'replays'].map(t => sql`select * from ${sql.table(t)}`.execute(store.db)));
    expect(after.map(r => r.rows)).toEqual(before.map(r => r.rows));
  });
});
