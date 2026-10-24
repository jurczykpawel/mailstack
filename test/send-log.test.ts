import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { config } from '../src/core/config';
import { open } from '../src/core/crypto';
import { createSqliteStore } from '../src/core/store/sqlite';
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
const hookBody = { event: 'purchase.completed', timestamp: now.toISOString(), data: { customer: { email: 'buyer@example.com' }, order: { sessionId: 'order-1', amount: 100 }, product: { name: 'Plan' } } };
const hook = (raw = JSON.stringify(hookBody), headers: Record<string, string> = {}) => handleSellfHook(new Request('https://mail.example/v1/hooks/sellf?brand=acme', {
  method: 'POST', headers: { authorization: 'Bearer test-key', ...headers }, body: raw,
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

it.each([{ ref: '' }, { ref: 12 }, { ref: 'x'.repeat(129) }, { resendOf: null }, { attachments: [] }])('validates new controls %j', async controls => {
  const res = await send({ ...body, ...controls });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: 'ref' in controls ? 'invalid_ref' : 'not_supported' });
  expect(deps.sendEmail).not.toHaveBeenCalled();
});
it.each(['', 'space key', 'x'.repeat(129)])('validates idempotency key %j', async key => {
  const res = await send(body, key); expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: 'invalid_idempotency_key' });
});

it('deduplicates Sellf deliveries while keeping its response shape', async () => {
  expect(await (await hook()).json()).toEqual({ success: true });
  expect(await (await hook()).json()).toEqual({ success: true });
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
    for (const seconds of [-301, 301]) {
      deps.now = () => new Date(now.getTime() + seconds * 1000);
      expect((await call(`t=${t},v1=${sig}`)).status).toBe(401);
    }
    deps.now = () => new Date(now.getTime() + 300000);
    expect((await call(`t=${t},v1=${sig}`)).status).toBe(200);
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
