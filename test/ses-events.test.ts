import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { generateKeyPairSync } from 'node:crypto';
import { buildSync } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createVerifier } from '../src/events/sns';
import { handleSesEvent } from '../src/events/ses';
import worker from '../src/index';
import type { Env } from '../src/types';
import { createSqliteStore } from '../src/core/store/sqlite';
import { blindIndex, open } from '../src/core/crypto';
import { parseConfig } from '../src/core/config/schema';
import example from '../config/mailstack.example.json';
import { certificates, notification, options, request, signed, topic } from './sns-fixture';

const pair = generateKeyPairSync('x25519');
const publicKeys = [{ ...pair.publicKey.export({ format: 'jwk' }), kty: 'OKP', crv: 'X25519', kid: 'c1' }];
const privateKeys = [{ ...pair.privateKey.export({ format: 'jwk' }), kty: 'OKP', crv: 'X25519', kid: 'c1' }];
const indexKeys = [{ kid: 'i1', key: Buffer.alloc(32, 7).toString('base64url') }];
let cert: string, key: string;
beforeAll(() => { ({ cert, key } = certificates()); });

it('validates the SES configuration at startup', () => {
  expect(parseConfig({ ...example, events: { ses: { topicArns: [topic], accountIds: options.accountIds } } }).events?.ses?.allowSignatureV1).toBe(false);
  for (const ses of [{ ...options, accountIds: ['wrong'] }, { ...options, topicArns: ['wrong'] }, { ...options, allowSignatureV1: 'false' }, { ...options, extra: true }])
    expect(() => parseConfig({ ...example, events: { ses } })).toThrow('$.events.ses');
});

it('routes SES requests through the worker', async () => {
  const result = await worker.fetch(request({ Type: 'Notification' }), { CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: publicKeys }), INDEX_KEYS: JSON.stringify(indexKeys) } as Env, {} as ExecutionContext);
  expect(result.status).toBe(400);
});

describe('SNS verification', () => {
  it('verifies local signatures with optional subject and a final newline', async () => {
    const fetcher = vi.fn(async () => new Response(cert));
    const verify = createVerifier(fetcher);
    const body = signed(key, notification(), { Subject: 'A\nB' });
    expect(await verify(body, body.Type, options)).toBe(true);
    expect(await verify(body, body.Type, options)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([body.SigningCertURL, expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) })]);
    expect(await verify({ ...body, Message: '{}' }, body.Type, options)).toBe(false);
  });
  it('expires the certificate cache after 24 hours', async () => {
    let now = Date.now();
    const fetcher = vi.fn(async () => new Response(cert));
    const verify = createVerifier(fetcher, () => now);
    const body = signed(key);
    expect(await verify(body, body.Type, options)).toBe(true);
    now += 86400000;
    expect(await verify(body, body.Type, options)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('aborts the certificate request after five seconds', async () => {
    vi.useFakeTimers();
    try {
      const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timeout')));
      });
      const body = signed(key);
      const result = createVerifier(fetcher)(body, body.Type, options);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await result).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('supports version one only when explicitly configured', async () => {
    const body = signed(key, notification(), { SignatureVersion: '1' });
    const verify = createVerifier(async () => new Response(cert));
    expect(await verify(body, body.Type, options)).toBe(false);
    expect(await verify(body, body.Type, { ...options, allowSignatureV1: true })).toBe(true);
  });
  it.each<Record<string, string>>([
    { TopicArn: topic + '-other' }, { TopicArn: topic.replace('123456789012', '999999999999') },
    { SigningCertURL: 'https://example.com/cert.pem' }, { SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem' },
    { SigningCertURL: 'http://sns.eu-west-1.amazonaws.com/cert.pem' }, { SigningCertURL: 'https://user@sns.eu-west-1.amazonaws.com/cert.pem' },
    { SigningCertURL: 'https://sns.eu-west-1.amazonaws.com:444/cert.pem' }, { SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/cert.txt' },
    { SignatureVersion: '3' },
  ])('rejects inconsistent envelope options %j', async (overrides) => {
    const fetcher = vi.fn(async () => new Response(cert));
    const body = signed(key, notification(), overrides);
    expect(await createVerifier(fetcher)(body, body.Type, options)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires an independently allowed account', async () => {
    const body = signed(key);
    expect(await createVerifier(async () => new Response(cert))(body, body.Type, { ...options, accountIds: [] })).toBe(false);
  });
  it('rejects redirect, oversized certificate and fetch errors', async () => {
    for (const fetcher of [async () => new Response(null, { status: 302, headers: { location: 'https://example.com' } }),
      async () => new Response('x'.repeat(65537)), async () => { throw new Error('offline'); }]) {
      const body = signed(key);
      expect(await createVerifier(fetcher)(body, body.Type, options)).toBe(false);
    }
  });
});

for (const runtime of ['node', 'workerd'] as const) describe(`SES ingestion: ${runtime}`, () => {
  const store = createSqliteStore(':memory:');
  let mf: Miniflare | undefined;
  const fetcher = vi.fn(async () => new Response(cert));
  const verify = createVerifier(fetcher);
  beforeAll(async () => {
    const indices = await Promise.all(['one@example.com', 'two@example.com'].map(a => blindIndex(a, indexKeys[0])));
    if (runtime === 'workerd') {
      const script = buildSync({ entryPoints: ['test/fixtures/ses-worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' }).outputFiles[0].text;
      mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-06-01', d1Databases: ['DB'],
        bindings: { CERT: cert, KEYS: JSON.stringify(publicKeys), INDICES: JSON.stringify(indices), INDEX_KEYS: JSON.stringify(indexKeys) } }));
    } else {
      await store.migrate();
      await sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at,provider_account,provider_message_id)
        values('msg_1','demo','acme','notice','meta','hash','sending',0,9999999999999,'123456789012','provider-1')`.execute(store.db);
      for (const [pos, idx] of indices.entries()) await sql`insert into recipients values('msg_1',${pos},'to',${idx.index},'i1','sealed','hint','sending',null)`.execute(store.db);
    }
  });
  afterAll(async () => { await store.db.destroy(); await mf?.dispose(); });
  async function send(body: Record<string, string>, extra: { keys?: boolean; header?: string; raw?: string } = {}) {
    const req = extra.raw === undefined ? request(body, extra.header ?? body.Type) : new Request('https://mail.example/v1/events/ses', { method: 'POST', body: extra.raw });
    if (mf) {
      if (extra.keys === false) req.headers.set('test-no-keys', '1');
      return mf.dispatchFetch(req.url, { method: req.method, headers: Object.fromEntries(req.headers), body: await req.text() });
    }
    return handleSesEvent(req, { options, store, verify, contentKeys: extra.keys === false ? [] : publicKeys, indexKeys, now: () => Date.now(), fetcher });
  }
  async function rows(table: string) {
    if (mf) return (await (await mf.dispatchFetch(`https://mail.example/rows/${table}`)).json()) as Record<string, unknown>[];
    return (await sql<Record<string, unknown>>`select * from ${sql.table(table)}`.execute(store.db)).rows;
  }
  it('returns the contract status codes before persistence', async () => {
    expect((await send(signed(key), { raw: 'x'.repeat(256 * 1024 + 1) })).status).toBe(413);
    expect((await send(signed(key), { raw: '{' })).status).toBe(400);
    expect((await send(signed(key), { header: 'SubscriptionConfirmation' })).status).toBe(400);
    expect((await send({ ...signed(key), Message: '{}' })).status).toBe(403);
    expect((await send(signed(key, notification(), { SignatureVersion: '1' }))).status).toBe(403);
    for (const overrides of [{ TopicArn: topic + '-other' }, { SigningCertURL: 'https://example.com/cert.pem' }] as Record<string, string>[])
      expect((await send(signed(key, notification(), overrides))).status).toBe(403);
    expect((await send(signed(key), { keys: false })).status).toBe(503);
    expect(await rows('events')).toHaveLength(0);
  });
  it('stores a recipient event, sealed evidence and a sanitized summary', async () => {
    const body = signed(key);
    expect(await (await send(body)).json()).toEqual({ ok: true, result: 'processed' });
    expect(await (await send(body)).json()).toEqual({ ok: true, result: 'duplicate' });
    const events = await rows('events');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source_event_id: body.MessageId + ':0', recipient_pos: 0, type: 'delivered', auth: 'sns-sig-v2', summary: '250  OK' });
    expect(await open(String(events[0].evidence_sealed), { brand: 'acme', messageId: 'msg_1', purpose: 'evidence' }, privateKeys)).toEqual(body);
  });
  it('keeps recipient and message projections monotonic', async () => {
    expect((await send(signed(key, notification('Send')))).status).toBe(200);
    expect((await rows('recipients')).map(r => r.status)).toEqual(['delivered', 'accepted']);
    expect((await rows('messages'))[0].status).toBe('delivered');
    await send(signed(key, notification('Bounce', { bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'two@example.com', diagnosticCode: '5.1.1 two@example.com' }] } })));
    await send(signed(key, notification('Complaint', { complaint: { complainedRecipients: [{ emailAddress: 'one@example.com' }] } })));
    expect((await rows('messages'))[0]).toMatchObject({ status: 'bounce_permanent', complained: 1 });
    expect((await rows('recipients')).map(r => r.status)).toEqual(['delivered', 'bounce_permanent']);
  });
  it('ignores deleted messages and resolves provider ids when the tag is absent', async () => {
    const event = notification('Delivery', { mail: { messageId: 'absent' } });
    expect(await (await send(signed(key, event))).json()).toEqual({ ok: true, result: 'ignored' });
    expect(await (await send(signed(key, notification('Delivery', { mail: { messageId: 'provider-1' } })))).json()).toEqual({ ok: true, result: 'processed' });
  });
  it('retains unassigned complaints without changing recipient status', async () => {
    await send(signed(key, notification('Complaint', { complaint: { complainedRecipients: [{ emailAddress: 'unknown@example.com' }] } })));
    expect((await rows('events')).at(-1)).toMatchObject({ recipient_pos: null, type: 'complaint' });
  });
  it.each([
    ['Bounce', { bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'one@example.com' }] } }, 'bounce_transient'],
    ['Bounce', { bounce: { bounceType: 'Undetermined', bouncedRecipients: [{ emailAddress: 'one@example.com' }] } }, 'bounce_undetermined'],
    ['DeliveryDelay', { deliveryDelay: { delayedRecipients: [{ emailAddress: 'two@example.com' }] } }, 'delay'],
    ['Reject', { reject: { reason: 'reason' } }, 'reject'],
    ['Rendering Failure', { failure: { errorMessage: 'detail' } }, 'render_failure'],
  ] as const)('normalizes %s into %s', async (type, details, normalized) => {
    const body = signed(key, notification(type, details));
    expect(await (await send(body)).json()).toEqual({ ok: true, result: 'processed' });
    const events = (await rows('events')).filter(r => String(r.source_event_id).startsWith(body.MessageId));
    expect(events.length).toBe(['reject', 'render_failure'].includes(normalized) ? 2 : 1);
    expect(events.every(e => e.type === normalized)).toBe(true);
  });
  it('ignores unregistered event types and requires recipient fields', async () => {
    expect(await (await send(signed(key, notification('constructor')))).json()).toEqual({ ok: true, result: 'ignored' });
    expect((await send(signed(key, notification('Delivery', { delivery: {} })))).status).toBe(400);
  });
  it('accepts an old notification and bounds the public summary', async () => {
    const body = signed(key, notification('Delivery', { delivery: { recipients: ['one@example.com'], smtpResponse: 'ą'.repeat(250) } }), { Timestamp: '2020-01-01T00:00:00Z' });
    expect((await send(body)).status).toBe(200);
    const event = (await rows('events')).find(r => r.source_event_id === body.MessageId + ':0');
    expect(String(event?.summary)).toHaveLength(200);
  });
  it('records a single set of rows for concurrent deliveries', async () => {
    const body = signed(key, notification('Send'));
    const results = await Promise.all(Array.from({ length: 4 }, async () => (await (await send(body)).json()) as { result: string }));
    expect(results.filter(r => r.result === 'processed')).toHaveLength(1);
    expect(results.filter(r => r.result === 'duplicate')).toHaveLength(3);
  });
  it('confirms only a current, signed subscription and records its audit', async () => {
    const overrides = { Type: 'SubscriptionConfirmation', Token: 'token', SubscribeURL: `https://sns.eu-west-1.amazonaws.com/?TopicArn=${encodeURIComponent(topic)}&Token=token` };
    expect(await (await send(signed(key, notification(), overrides))).json()).toEqual({ ok: true, result: 'confirmed' });
    expect((await rows('audit'))[0].action).toBe('events.subscription_confirmed');
    expect((await send(signed(key, notification(), { ...overrides, Timestamp: new Date(Date.now() - 3600001).toISOString() }))).status).toBe(403);
    expect((await send(signed(key, notification(), { ...overrides, SubscribeURL: 'https://example.com/?TopicArn=' + encodeURIComponent(topic) }))).status).toBe(403);
  });
});

it('resolves tags before provider identifiers are available', async () => {
  const store = createSqliteStore(':memory:');
  try {
    await store.migrate();
    await sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at)
      values('msg_1','demo','acme','notice','meta','hash','delivered',0,9999999999999)`.execute(store.db);
    await sql`insert into recipients values('msg_1',0,'to','index','i1','sealed','hint','delivered',200)`.execute(store.db);
    expect(await (await handleSesEvent(request(signed(key, notification('Send'))), { options, store, contentKeys: publicKeys, indexKeys,
      verify: createVerifier(async () => new Response(cert)), now: Date.now })).json()).toEqual({ ok: true, result: 'processed' });
  } finally { await store.db.destroy(); }
});
