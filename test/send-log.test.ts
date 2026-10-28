import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { config } from '../src/core/config';
import { open } from '../src/core/crypto';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createSmtpSender } from '../src/adapters/sender/smtp';
import { handleSend } from '../src/send';
import { handleSellfHook } from '../src/sellf';
import { tokenSha256 } from '../src/clients';
import type { Env, SendDeps } from '../src/types';

let env: Env;
let privateKey: JsonWebKey & { kid: string };
let store: ReturnType<typeof createSqliteStore>;
let deps: SendDeps;
const now = new Date('2026-10-24T12:00:00Z');
const body = { brand: 'acme', template: 'notice', to: 'buyer@example.com', heading: 'Subject sentinel', paragraphs: 'Body sentinel', ref: 'ORDER-1' };
const request = (data: object = body, key: string | null = 'request-1') => new Request('https://mail.example/v1/send', {
  method: 'POST', headers: { authorization: 'Bearer test-key', ...(key === null ? {} : { 'Idempotency-Key': key }) }, body: JSON.stringify(data),
});
const send = (data?: object, key?: string | null) => handleSend(request(data, key), env, deps);
const rows = () => store.db.selectFrom('messages').selectAll().execute();
const hookBody = { event: 'purchase.completed', timestamp: now.toISOString(), data: { customer: { email: 'buyer@example.com' }, order: { sessionId: 'order-1', amount: 100, currency: 'PLN' }, product: { name: 'Plan' } } };
const hook = (raw = JSON.stringify(hookBody), headers: Record<string, string> = {}, signal?: AbortSignal) => handleSellfHook(new Request('https://mail.example/v1/hooks/sellf?brand=acme', {
  method: 'POST', headers: { authorization: 'Bearer test-key', ...headers }, body: raw, signal,
}), env, deps);

beforeAll(async () => {
  const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
  const pair = await suite.kem.generateKeyPair();
  const publicKey = { kid: 'c1', kty: 'OKP', crv: 'X25519', x: Buffer.from(await suite.kem.serializePublicKey(pair.publicKey)).toString('base64url') };
  privateKey = { ...publicKey, d: Buffer.from(await suite.kem.serializePrivateKey(pair.privateKey)).toString('base64url') };
  env = { API_KEY: 'test-key', SES_REGION: 'eu-west-1', SES_ACCESS_KEY_ID: '', SES_SECRET_ACCESS_KEY: '', TURNSTILE_SECRET: '', ALTCHA_HMAC_KEY: '',
    CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [publicKey] }), INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 11).toString('base64url') }]) };
});
beforeEach(async () => {
  store = createSqliteStore(':memory:'); await store.migrate();
  deps = { store, logging: structuredClone(config.logging), now: () => now, verifyAltcha: vi.fn().mockResolvedValue(true), verifyTurnstile: vi.fn().mockResolvedValue(true),
    sendEmail: vi.fn().mockResolvedValue({ ok: true, status: 200, messageId: 'ses-1', response: { MessageId: 'ses-1' } }) };
});
afterEach(async () => { vi.restoreAllMocks(); await store.db.destroy(); });

it('records before sending, seals provider evidence and returns the same id on retry', async () => {
  vi.mocked(deps.sendEmail).mockImplementation(async () => {
    expect(await rows()).toMatchObject([{ status: 'sending', client_id: 'legacy' }]);
    return { ok: true, status: 200, messageId: 'ses-1', response: { MessageId: 'ses-1' } };
  });
  const first = await (await send()).json() as { success: boolean; id: string };
  expect(first).toEqual({ success: true, id: expect.stringMatching(/^msg_/) });
  expect(await (await send()).json()).toEqual({ ...first, idempotent: true });
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  const [row] = await rows();
  expect(row).toMatchObject({ status: 'sent', provider_message_id: 'ses-1' });
  expect(await open(row.provider_response_sealed!, { brand: 'acme', messageId: row.id, purpose: 'provider_response' }, [privateKey])).toEqual({ MessageId: 'ses-1' });
  const dump = JSON.stringify(await Promise.all(['messages', 'recipients', 'subjects', 'contents', 'replays'].map(t => store.db.selectFrom(t as 'messages').selectAll().execute())));
  for (const value of [body.to, body.heading, body.paragraphs, body.ref]) expect(dump).not.toContain(value);
});

it('returns a conflict for changed content or controls with the same key', async () => {
  await send();
  for (const change of [{ paragraphs: 'changed' }, { replyTo: 'reply@example.com' }, { ref: 'ORDER-2' }, { markup: [] }]) {
    expect(await (await send({ ...body, ...change })).json()).toMatchObject({ code: 'idempotency_conflict' });
  }
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});

it('sends once for concurrent requests including a conflicting insert', async () => {
  const find = store.findByIdempotency.bind(store);
  let reads = 0;
  let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  vi.spyOn(store, 'findByIdempotency').mockImplementation(async (...args) => {
    if (++reads <= 2) { if (reads === 2) release(); await barrier; return undefined; }
    return find(...args);
  });
  const responses = await Promise.all([send(), send()]);
  expect(responses.map(r => r.status).sort()).toEqual(expect.arrayContaining([200]));
  const outputs = await Promise.all(responses.map(r => r.json())) as { success: boolean; code?: string }[];
  expect(outputs.every(o => o.success || o.code === 'in_progress')).toBe(true);
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  expect(await rows()).toHaveLength(1);
});

it('keeps an ambiguous provider outcome unknown and does not send it again', async () => {
  vi.mocked(deps.sendEmail).mockRejectedValue(new Error('timeout after accept'));
  expect(await (await send()).json()).toMatchObject({ success: false, code: 'send_failed' });
  expect(await rows()).toMatchObject([{ status: 'unknown' }]);
  expect(await (await send()).json()).toMatchObject({ code: 'outcome_unknown', id: (await rows())[0].id });
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});

it('allows a retry after an explicit provider refusal', async () => {
  vi.mocked(deps.sendEmail).mockResolvedValueOnce({ ok: false, status: 400 });
  expect((await send()).status).toBe(502);
  expect(await rows()).toMatchObject([{ status: 'send_failed' }]);
  expect((await send()).status).toBe(200);
  expect(deps.sendEmail).toHaveBeenCalledTimes(2);
  expect((await rows()).filter(r => r.idem_key_hash !== null)).toHaveLength(1);
});

it.each([true, false])('honors requireLog=%s when storage fails', async required => {
  deps.logging!.defaults.requireLog = required;
  vi.spyOn(store, 'insertMessage').mockRejectedValue(new Error('unavailable'));
  const res = await send();
  expect(res.status).toBe(required ? 503 : 200);
  if (required) expect(await res.json()).toEqual({ success: false, message: 'log unavailable', code: 'log_unavailable' });
  expect(deps.sendEmail).toHaveBeenCalledTimes(required ? 0 : 1);
});

it('sends without storage or keys at level none even with requireLog', async () => {
  deps.logging!.defaults.level = 'none'; deps.logging!.defaults.requireLog = true;
  expect(await (await handleSend(request(), { ...env, CONTENT_PUBLIC_KEYS: undefined, INDEX_KEYS: undefined }, { ...deps, store: undefined })).json()).toEqual({ success: true });
});

it.each([{ ref: '' }, { ref: 12 }, { ref: 'x'.repeat(129) }, { resendOf: null }])('validates new controls %j', async controls => {
  const res = await send({ ...body, ...controls });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: 'ref' in controls ? 'invalid_ref' : 'not_supported' });
  expect(deps.sendEmail).not.toHaveBeenCalled();
});
it.each(['', 'space key', 'x'.repeat(129)])('validates idempotency key %j', async key => {
  const res = await send(body, key); expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: 'invalid_idempotency_key' });
});

it('returns the same Sellf message id on duplicate delivery', async () => {
  const first = await (await hook()).json();
  expect(first).toEqual({ success: true, id: expect.stringMatching(/^msg_/) });
  expect(await (await hook()).json()).toEqual({ ...first as object, idempotent: true });
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  expect(await rows()).toMatchObject([{ client_id: 'legacy', status: 'sent' }]);
});

it('requires a configured Sellf signature in addition to the bearer', async () => {
  const token = 'msk_hook-client_' + 'a'.repeat(43);
  const client = { id: 'hook-client', tokenSha256: await tokenSha256(token), scopes: ['hook:sellf' as const], brands: '*' as const, templates: '*' as const, recipientOverride: false, attachments: false, sellfSignatureSecretEnv: 'SELLF_SECRET' };
  const previous = config.clients; config.clients = [client];
  const raw = JSON.stringify(hookBody);
  const t = String(now.getTime() / 1000);
  const secretEnv = { ...env, SELLF_SECRET: 'signature-secret' };
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('signature-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`))).toString('hex');
  const call = (signature?: string, text = raw) => handleSellfHook(new Request('https://mail.example/v1/hooks/sellf?brand=acme', { method: 'POST', body: text, headers: { authorization: `Bearer ${token}`, ...(signature ? { 'X-Sellf-Signature': signature } : {}) } }), secretEnv, deps);
  try {
    for (const signature of [undefined, `t=${t},v1=${'0'.repeat(64)}`, `t=${Number(t) - 301},v1=${sig}`]) expect((await call(signature)).status).toBe(401);
    expect((await call(`t=${t},v1=${sig}`, raw + ' ')).status).toBe(401);
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
    expect(await store.db.selectFrom('guards').selectAll().execute()).toEqual([]);
    for (const seconds of [-301, 301]) {
      deps.now = () => new Date(now.getTime() + seconds * 1000);
      expect((await call(`t=${t},v1=${sig}`)).status).toBe(401);
    }
    for (const seconds of [-300, 0, 300]) {
      deps.now = () => new Date(now.getTime() + seconds * 1000);
      expect((await call(`t=${t},v1=${sig}`)).status).toBe(200);
    }
  } finally { config.clients = previous; }
});

it('reports in progress while the original provider call is pending', async () => {
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  vi.mocked(deps.sendEmail).mockImplementation(() => { entered(); return new Promise(r => { finish = () => r({ ok: true, status: 200 }); }); });
  const first = send(); await started;
  const duplicate = await send();
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ code: 'in_progress' });
  finish(); expect((await first).status).toBe(200);
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});

it('keeps a post-send storage failure from sending again', async () => {
  vi.spyOn(store, 'markSent').mockRejectedValue(new Error('unavailable'));
  expect((await send()).status).toBe(502);
  expect(await rows()).toMatchObject([{ status: 'unknown' }]);
  expect(await (await send()).json()).toMatchObject({ code: 'outcome_unknown', id: (await rows())[0].id });
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});

it('logs public submissions and auto-replies without adding response fields', async () => {
  const tasks: Promise<unknown>[] = [];
  deps.waitUntil = task => { tasks.push(task); };
  const res = await handleSend(new Request('https://mail.example/v1/send', { method: 'POST', headers: { origin: 'https://acme.example', 'Idempotency-Key': 'invalid key' },
    body: JSON.stringify({ brand: 'acme', email: 'submitter@example.com', name: 'Jane', ref: {}, resendOf: true, attachments: [], 'cf-turnstile-response': 'test' }),
  }), env, deps);
  expect(await res.json()).toEqual({ success: true });
  await Promise.all(tasks);
  expect(await rows()).toMatchObject([{ client_id: 'public', template: 'contact', status: 'sent' }, { client_id: 'public', template: 'received', status: 'sent' }]);
  expect(vi.mocked(deps.sendEmail).mock.calls[0][1].html).not.toMatch(/resendOf|attachments/);
});

it('deduplicates trusted contact requests across generated receive times', async () => {
  const data = { brand: 'acme', name: 'Jane', message: 'Hello' };
  const first = await (await send(data)).json() as { id: string };
  deps.now = () => new Date(now.getTime() + 60000);
  expect(await (await send(data)).json()).toEqual({ success: true, id: first.id, idempotent: true });
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});

it('does not deduplicate requests without a key', async () => {
  await send(body, null); await send(body, null);
  expect(deps.sendEmail).toHaveBeenCalledTimes(2);
  expect(await rows()).toHaveLength(2);
});

it('checks Sellf payload identity and logging availability', async () => {
  await hook();
  const changed = structuredClone(hookBody); changed.data.order.amount = 200;
  const res = await hook(JSON.stringify(changed));
  expect(res.status).toBe(409); expect(await res.json()).toMatchObject({ code: 'idempotency_conflict' });
  deps.logging!.defaults.requireLog = true;
  deps.store = undefined;
  expect((await hook()).status).toBe(503);
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});

it('scopes a shared key to each authenticated client', async () => {
  await send();
  const token = 'msk_sender_' + 'b'.repeat(43);
  const previous = config.clients;
  config.clients = [{ id: 'sender', tokenSha256: await tokenSha256(token), scopes: ['send'], brands: ['acme'], templates: ['notice'], recipientOverride: true, attachments: false }];
  const other = () => {
    const req = request(); req.headers.set('authorization', `Bearer ${token}`);
    return handleSend(req, env, deps);
  };
  try {
    const first = await (await other()).json() as { id: string };
    expect(await (await other()).json()).toEqual({ success: true, id: first.id, idempotent: true });
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
    expect((await rows()).map(r => r.client_id)).toEqual(['legacy', 'sender']);
  } finally { config.clients = previous; }
});

it('recognizes the original request after index key rotation', async () => {
  const first = await (await send()).json();
  const previous = env.INDEX_KEYS;
  env.INDEX_KEYS = JSON.stringify([{ kid: 'i2', key: Buffer.alloc(32, 12).toString('base64url') }, ...JSON.parse(previous!)]);
  try {
    expect(await (await send()).json()).toEqual({ ...(first as object), idempotent: true });
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  } finally { env.INDEX_KEYS = previous; }
});

it('records a fresh attempt when a conflicting insert resolves to a failed message', async () => {
  vi.mocked(deps.sendEmail).mockResolvedValueOnce({ ok: false, status: 400 });
  expect((await send()).status).toBe(502);
  vi.spyOn(store, 'findByIdempotency').mockResolvedValueOnce(undefined);
  expect((await send()).status).toBe(200);
  expect(await rows()).toMatchObject([{ status: 'send_failed', idem_key_hash: null }, { status: 'sent' }]);
  expect(deps.sendEmail).toHaveBeenCalledTimes(2);
});


it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])('returns unknown template for %s', async template => {
  const response = await send({ ...body, template });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ success: false, message: 'unknown template' });
  expect(deps.sendEmail).not.toHaveBeenCalled();
  expect(await rows()).toEqual([]);
});

it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])('acknowledges unmapped event %s', async event => {
  const response = await hook(JSON.stringify({ ...hookBody, event }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true, ignored: event });
  expect(deps.sendEmail).not.toHaveBeenCalled();
  expect(await rows()).toEqual([]);
});

it('records SMTP acceptance evidence for each recipient while retaining sent status', async () => {
  deps.provider = 'smtp';
  vi.mocked(deps.sendEmail).mockResolvedValue({ ok: true, status: 250, messageId: 'queue-1', response: { response: '250 queued as queue-1' }, smtp: { accepted: ['buyer@example.com', 'second@example.com'], rejected: [] } });
  expect((await send({ ...body, to: ['buyer@example.com', 'second@example.com'] })).status).toBe(200);
  const [row] = await rows();
  expect(row).toMatchObject({ status: 'sent', provider: 'smtp', provider_message_id: 'queue-1' });
  expect(await open(row.provider_response_sealed!, { brand: 'acme', messageId: row.id, purpose: 'provider_response' }, [privateKey])).toEqual({ response: '250 queued as queue-1' });
  const { sql } = await import('kysely');
  const events = (await sql<{ recipient_pos: number; evidence_sealed: string }>`select * from events where message_id=${row.id} order by recipient_pos`.execute(store.db)).rows;
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.stringMatching(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/) })]));
  expect(events).toMatchObject([0, 1].map(recipient_pos => ({ recipient_pos, source: 'smtp-response', auth: 'smtp-response', type: 'accepted' })));
  expect(await open(events[0].evidence_sealed, { brand: 'acme', messageId: row.id, purpose: 'evidence' }, [privateKey])).toEqual({ response: '250 queued as queue-1' });
});

it.each([450, 550, undefined])('persists the SMTP outcome for reply %s', async responseCode => {
  deps.provider = 'smtp';
  const sendMail = vi.fn().mockRejectedValue(Object.assign(new Error('connection result'), responseCode ? { responseCode, response: `${responseCode} refused` } : {}));
  deps.sendEmail = createSmtpSender({ sendMail });
  expect((await send()).status).toBe(502);
  const [row] = await rows();
  expect(row.status).toBe(responseCode ? 'send_failed' : 'unknown');
  if (responseCode) expect(await open(row.provider_response_sealed!, { brand: 'acme', messageId: row.id, purpose: 'provider_response' }, [privateKey])).toEqual({ response: `${responseCode} refused` });
  expect(sendMail).toHaveBeenCalledTimes(1);
});

it.each(['send_failed', 'unknown'] as const)('alerts on %s without changing delivery results', async type => {
  deps.logging!.defaults.alertOn = [type];
  deps.notifier = { notify: vi.fn().mockRejectedValue(new Error('notification detail')) };
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  if (type === 'unknown') vi.mocked(deps.sendEmail).mockRejectedValue(new Error('provider detail'));
  else vi.mocked(deps.sendEmail).mockResolvedValue({ ok: false, status: 400 });
  expect((await send()).status).toBe(502);
  expect(deps.notifier.notify).toHaveBeenCalledTimes(1);
  const alert = vi.mocked(deps.notifier.notify).mock.calls[0][0];
  for (const value of [body.to, body.heading, body.paragraphs]) expect(JSON.stringify(alert)).not.toContain(value);
  expect(alert.title).toBe('mailstack: ' + type + ' acme/notice');
  expect(log).toHaveBeenCalledWith('mailstack: alert failed');
});

it('keeps notifications disabled without a URL and skips types outside alertOn', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  try {
    deps.logging!.defaults.alertOn = ['send_failed'];
    vi.mocked(deps.sendEmail).mockResolvedValue({ ok: false, status: 400 });
    expect((await send()).status).toBe(502);
    expect(fetcher).not.toHaveBeenCalled();
    deps.notifier = { notify: vi.fn() };
    deps.logging!.defaults.alertOn = [];
    expect((await send(body, null)).status).toBe(502);
    expect(deps.notifier.notify).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it('alerts when recording an accepted send becomes unknown', async () => {
  deps.logging!.defaults.alertOn = ['unknown'];
  deps.notifier = { notify: vi.fn().mockResolvedValue(undefined) };
  vi.spyOn(store, 'markSent').mockRejectedValue(new Error('unavailable'));
  expect((await send()).status).toBe(502);
  expect(deps.notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'mailstack: unknown acme/notice', priority: 'default' }));
});

it.each([true, false])('handles a slow alert with waitUntil=%s', async background => {
  vi.useFakeTimers();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const tasks: Promise<unknown>[] = [];
  let alertFinished = false;
  let responded = false;
  deps.logging!.defaults.alertOn = ['send_failed'];
  deps.notifier = { notify: vi.fn(() => {
    entered();
    return new Promise<void>(resolve => setTimeout(() => { alertFinished = true; resolve(); }, 6000));
  }) };
  if (background) deps.waitUntil = task => { tasks.push(task); };
  vi.mocked(deps.sendEmail).mockResolvedValue({ ok: false, status: 400 });
  const response = send().then(result => { responded = true; return result; });
  try {
    await started;
    await vi.advanceTimersByTimeAsync(3999);
    expect(responded).toBe(background);
    expect(alertFinished).toBe(false);
    expect(tasks).toHaveLength(background ? 1 : 0);
    if (background) {
      expect(tasks[0]).toBeInstanceOf(Promise);
      let taskFinished = false;
      void tasks[0].then(() => { taskFinished = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(taskFinished).toBe(false);
    }
  } finally {
    await vi.advanceTimersByTimeAsync(6000);
    await Promise.all(tasks);
    expect((await response).status).toBe(502);
    vi.useRealTimers();
  }
});

it('records attachment summaries and identity without archiving files', async () => {
  const previous = config.legacyApiKey;
  config.legacyApiKey = { enabled: true, env: 'API_KEY', scopes: ['send'], brands: '*', templates: '*', recipientOverride: true, attachments: true };
  deps.logging!.defaults.level = 'full'; deps.logging!.defaults.resend = 'replay';
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const file = { filename: 'attachment-sentinel.txt', contentType: 'text/plain', contentBase64: Buffer.from('attachment content sentinel').toString('base64') };
  const data = { ...body, attachments: [file] };
  try {
    expect((await send(data)).status).toBe(200);
    expect(await (await send(data)).json()).toMatchObject({ idempotent: true });
    for (const change of [{ contentBase64: Buffer.from('changed bytes').toString('base64') }, { filename: 'other.txt' }]) {
      const res = await send({ ...data, attachments: [{ ...file, ...change }] });
      expect(res.status).toBe(409); expect(await res.json()).toMatchObject({ code: 'idempotency_conflict' });
    }
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    const [row] = await rows();
    expect(JSON.parse(row.attachments_meta!)).toEqual({ count: 1, totalBytes: 27, types: ['text/plain'] });
    const dump = JSON.stringify(await Promise.all(['messages', 'recipients', 'subjects', 'contents', 'replays'].map(t => store.db.selectFrom(t as 'messages').selectAll().execute())));
    const decoded = [];
    for (const [table, purpose] of [['contents', 'content'], ['replays', 'replay']] as const) {
      const item = await store.db.selectFrom(table).selectAll().executeTakeFirstOrThrow();
      decoded.push(await open(item.sealed, { brand: 'acme', messageId: row.id, purpose }, [privateKey]));
    }
    for (const value of [file.filename, file.contentBase64, 'attachment content sentinel']) {
      expect(dump).not.toContain(value); expect(JSON.stringify(decoded)).not.toContain(value); expect(JSON.stringify(log.mock.calls)).not.toContain(value);
    }
  } finally { config.legacyApiKey = previous; }
});


const refundBody = () => ({
  event: 'refund.issued', timestamp: now.toISOString(),
  data: {
    customer: { email: 'buyer@example.com', userId: null },
    product: { id: 'product-1', name: 'Plan' },
    payment: { id: 'payment-1', sessionId: 'cs-refund', paymentIntentId: null, amount: 10000, currency: 'PLN' },
    refund: { stripeRefundId: 're-1', amount: 3000, currency: 'pln', status: 'succeeded', isFullRefund: false, totalRefunded: 3000, refundedAt: now.toISOString() },
  },
});

function replacePath(input: Record<string, unknown>, path: string, value: unknown) {
  const result = structuredClone(input);
  const keys = path.split('.');
  let target = result as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  if (value === undefined) delete target[keys.at(-1)!];
  else target[keys.at(-1)!] = value;
  return result;
}

const absent = [undefined, null, '', '   '];
const invalidEvents: [string, Record<string, unknown>][] = [];
for (const path of ['data.customer.email', 'data.product.name', 'data.order.currency']) {
  for (const value of [...absent, 42]) invalidEvents.push([path, replacePath(hookBody, path, value)]);
}
for (const value of [...absent, '100', 'NaN', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'Infinity']) {
  invalidEvents.push(['data.order.amount', replacePath(hookBody, 'data.order.amount', value)]);
}
for (const value of [...absent, 42]) invalidEvents.push(['data.order.sessionId', replacePath(hookBody, 'data.order.sessionId', value)]);
for (const path of ['data.customer', 'data.product', 'data.order']) {
  for (const value of [undefined, null, [], '']) invalidEvents.push([path, replacePath(hookBody, path, value)]);
}
for (const path of ['data.payment.id', 'data.refund.stripeRefundId', 'data.refund.status', 'data.refund.refundedAt', 'data.payment.currency', 'data.refund.currency']) {
  for (const value of [...absent, 42]) invalidEvents.push([path, replacePath(refundBody(), path, value)]);
}
for (const path of ['data.refund.amount', 'data.payment.amount', 'data.refund.totalRefunded']) {
  for (const value of [...absent, '3000', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) invalidEvents.push([path, replacePath(refundBody(), path, value)]);
}
for (const value of ['pending', 'failed']) invalidEvents.push(['data.refund.status', replacePath(refundBody(), 'data.refund.status', value)]);
for (const value of [undefined, null, 'false', 0]) invalidEvents.push(['data.refund.isFullRefund', replacePath(refundBody(), 'data.refund.isFullRefund', value)]);
for (const [path, value] of [
  ['data.refund.amount', 0], ['data.refund.totalRefunded', 2000], ['data.refund.totalRefunded', 10001],
  ['data.refund.isFullRefund', true], ['data.refund.totalRefunded', 10000],
  ['data.refund.currency', 'USD'], ['data.refund.currency', 'PL'], ['data.refund.refundedAt', '2026-02-30T12:00:00Z'],
  ['data.payment.sessionId', null], ['data.order.currency', 'PLNN'], ['data.customer.email', 'invalid-address'],
] as [string, unknown][]) invalidEvents.push([path, replacePath(path.startsWith('data.order') || path === 'data.customer.email' ? hookBody : refundBody(), path, value)]);
for (const event of ['waitlist.signup', 'lead.captured', 'access.expired']) {
  for (const path of ['data.customer.email', 'data.product.name']) {
    for (const value of [...absent, 42]) invalidEvents.push([path, replacePath({ ...hookBody, event }, path, value)]);
  }
}
invalidEvents.push(['data.customer.email', { ...hookBody, data: {} }]);

it.each(invalidEvents)('rejects incomplete event at %s before recording or sending (%#)', async (_path, payload) => {
  const response = await hook(JSON.stringify(payload));
  expect(response.status).toBe(422);
  const output = await response.json() as { fields: string[] };
  expect(output).toMatchObject({ success: false, code: 'invalid_event_data', fields: expect.any(Array) });
  expect(output.fields.length).toBeGreaterThan(0);
  expect(output.fields.every(path => /^data\.[A-Za-z.]+$/.test(path))).toBe(true);
  expect(JSON.stringify(output)).not.toContain('buyer@example.com');
  expect(deps.sendEmail).not.toHaveBeenCalled();
  expect(await rows()).toEqual([]);
  expect(await store.db.selectFrom('guards').selectAll().execute()).toEqual([]);
  const corrected = payload.event === 'refund.issued' ? refundBody() : { ...hookBody, event: payload.event };
  expect((await hook(JSON.stringify(corrected))).status).toBe(200);
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});

const invalidEnvelopes = [null, [], 12, {}, ...['event', 'timestamp', 'data'].flatMap(path =>
  [undefined, null, '', '   ', 42, []].map(value => replacePath(hookBody, path, value))),
  ...['not-a-date', '2026-02-30T12:00:00Z', '2026-06-10', '2026-06-10T25:00:00Z'].map(value => ({ ...hookBody, timestamp: value })),
];
it.each(invalidEnvelopes)('rejects an invalid envelope before delivery (%#)', async payload => {
  const response = await hook(JSON.stringify(payload));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ success: false, code: 'invalid_envelope' });
  expect(deps.sendEmail).not.toHaveBeenCalled();
  expect(await rows()).toEqual([]);
  expect(await store.db.selectFrom('guards').selectAll().execute()).toEqual([]);
});

const unsupportedEvents = ['subscription.created', 'subscription.updated', 'subscription.canceled', 'subscription.trial_ending', 'subscription.renewal_upcoming', 'invoice.paid', 'invoice.payment_failed', 'license.revoked'];
it.each(unsupportedEvents)('explicitly declines %s regardless of data completeness', async event => {
  // Shapes reflect the sender contract: invoice amounts are major, revocation uses license.email.
  const complete = { customer: hookBody.data.customer, product: { id: 'product-1', name: 'Plan' },
    subscription: { stripeSubscriptionId: 'sub-1', status: 'active', currentPeriodEnd: now.toISOString() },
    invoice: { stripeInvoiceId: 'in-1', amountPaid: 100, currency: 'PLN' },
    license: { id: 'license-1', email: 'buyer@example.com', order: 'order-1', revokedAt: now.toISOString() } };
  if (event === 'invoice.paid') {
    Reflect.deleteProperty(complete.subscription, 'status');
    Reflect.deleteProperty(complete.subscription, 'currentPeriodEnd');
  }
  if (event === 'license.revoked') Reflect.deleteProperty(complete, 'customer');
  for (const data of [complete, {}]) {
    const response = await hook(JSON.stringify({ event, timestamp: now.toISOString(), data }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ success: false, code: 'unsupported_event', message: expect.stringContaining(event) });
  }
  expect(deps.sendEmail).not.toHaveBeenCalled();
  expect(await rows()).toEqual([]);
  expect(await store.db.selectFrom('guards').selectAll().execute()).toEqual([]);
});

it.each([
  { ...hookBody, data: { ...hookBody.data, order: { amount: 0, currency: 'pln', sessionId: 'cs-only', paymentIntentId: null } } },
  { ...hookBody, data: { ...hookBody.data, order: { amount: 100, currency: 'pln', paymentIntentId: 'pi-only' } } },
  { ...refundBody(), data: { ...refundBody().data, refund: { ...refundBody().data.refund, totalRefunded: 10000, isFullRefund: true } } },
  { ...hookBody, extra: { custom: true } },
])('accepts complete data and optional fields (%#)', async payload => {
  expect((await hook(JSON.stringify(payload))).status).toBe(200);
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});

it('keeps a Sellf response available after a discarded acknowledgement', async () => {
  await hook();
  const [row] = await rows();
  expect(await (await hook()).json()).toEqual({ success: true, id: row.id, idempotent: true });
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});

it('reports Sellf in progress with its id during concurrent delivery', async () => {
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  vi.mocked(deps.sendEmail).mockImplementation(() => { entered(); return new Promise(r => { finish = () => r({ ok: true, status: 200 }); }); });
  const first = hook(); await started;
  const [row] = await rows();
  const duplicate = await hook();
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ code: 'in_progress', id: row.id });
  finish(); expect(await (await first).json()).toEqual({ success: true, id: row.id });
  expect(await (await hook()).json()).toEqual({ success: true, id: row.id, idempotent: true });
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});

it('reports Sellf uncertainty without another provider call', async () => {
  vi.mocked(deps.sendEmail).mockRejectedValue(new Error('timeout'));
  const first = await hook();
  expect(first.status).toBe(502);
  const [row] = await rows();
  expect(await first.json()).toMatchObject({ code: 'send_failed', id: row.id });
  const duplicate = await hook();
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ code: 'outcome_unknown', id: row.id });
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});

it('allows Sellf retry after provider refusal with a new recorded attempt', async () => {
  vi.mocked(deps.sendEmail).mockResolvedValueOnce({ ok: false, status: 550 });
  const failed = await hook();
  expect(failed.status).toBe(502);
  expect(await failed.json()).toMatchObject({ code: 'send_failed', id: expect.stringMatching(/^msg_/) });
  const retried = await (await hook()).json();
  expect(retried).toMatchObject({ success: true, id: expect.stringMatching(/^msg_/) });
  expect(await (await hook()).json()).toEqual({ ...retried as object, idempotent: true });
  expect(deps.sendEmail).toHaveBeenCalledTimes(2);
});

it('allows Sellf retry after logging is restored', async () => {
  deps.logging!.defaults.requireLog = true;
  const insert = vi.spyOn(store, 'insertMessage').mockRejectedValue(new Error('unavailable'));
  const response = await hook();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ success: false, code: 'log_unavailable', message: 'log unavailable' });
  expect(deps.sendEmail).not.toHaveBeenCalled();
  expect(await rows()).toEqual([]);
  expect(await store.db.selectFrom('guards').selectAll().execute()).toEqual([]);
  insert.mockRestore();
  expect((await hook()).status).toBe(200);
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});


it('finishes an accepted Sellf attempt after the request is aborted', async () => {
  const controller = new AbortController();
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.mocked(deps.sendEmail).mockImplementation(() => {
    entered();
    return new Promise(resolve => { finish = () => resolve({ ok: true, status: 200 }); });
  });
  const pending = hook(undefined, {}, controller.signal);
  await started;
  controller.abort();
  finish();
  await pending;
  const [row] = await rows();
  expect(await (await hook()).json()).toEqual({ success: true, id: row.id, idempotent: true });
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});

it('rejects a numeric overflow before recording an intent', async () => {
  const raw = JSON.stringify(hookBody).replace('"amount":100', '"amount":1e309');
  const response = await hook(raw);
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: 'invalid_event_data', fields: ['data.order.amount'] });
  expect(deps.sendEmail).not.toHaveBeenCalled();
  expect(await rows()).toEqual([]);
  expect(await store.db.selectFrom('guards').selectAll().execute()).toEqual([]);
});
